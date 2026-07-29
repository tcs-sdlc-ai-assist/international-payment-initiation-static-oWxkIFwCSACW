/**
 * Operations status facade.
 *
 * OperationsFacade is the single entry point the payment operations flow uses to
 * search, inspect, and progress accepted payments (SCRUM-820/821). It layers
 * atop the {@link fixtureRegistry} (baseline payment records), the
 * {@link PaymentRepository} (locally-recorded payment snapshots + demo reset),
 * the {@link lifecycleMachine} (controlled local transitions), the
 * {@link authorizationPolicy} (capability gating), the {@link maskingPolicy}
 * (PII masking for the queue and detail views), and the
 * {@link paymentAuditEventFactory} (sanitized, masked status audit events):
 *
 *   - `searchPayments(session, filter)` returns the entitlement-scoped, masked
 *     set of payments matching a status / date / currency / reference /
 *     scenario filter, with in-memory pagination.
 *   - `getPaymentDetail(session, paymentId)` returns a sanitized detail snapshot
 *     carrying masked identifiers, safe reason codes, sanitized processing
 *     checkpoints, ledger postings, and SWIFT status — never restricted rule
 *     data.
 *   - `transitionPayment(session, paymentId, action)` applies a permitted local
 *     lifecycle transition, recording the change.
 *   - `resetPayment(session, paymentId)` resets a single payment back to a clean
 *     baseline via a permitted local transition.
 *   - `resetAllPaymentDemoData(session)` clears all locally-recorded payment
 *     demo state so the baseline fixtures become the source of truth again.
 *
 * The facade is intentionally conservative and demo-only: it enforces
 * client-side gating (deny-by-default via the {@link authorizationPolicy}),
 * never throws for expected failures — each method returns a discriminated
 * `{ ok, ... }` result carrying a sanitized safe reason code — never renders
 * restricted rule data, and carries no server guarantee.
 */

import { CAPABILITIES } from '@/shared/config/constants';
import { fixtureRegistry } from '@/shared/fixtures/fixtureRegistry';
import { createLocalStorageAdapter } from '@/shared/storage/storageAdapter';
import { createPaymentRepository } from '@/features/payment/data/paymentRepository';
import {
  lifecycleMachine,
  LIFECYCLE_STATES,
  LIFECYCLE_ACTIONS,
} from '@/features/payment/domain/lifecycleMachine';
import { authorizationPolicy } from '@/features/access/services/authorizationPolicy';
import {
  createStatusAuditEvent,
  recordPaymentAuditEvent,
} from '@/features/payment/data/paymentAuditEventFactory';
import { maskingPolicy } from '@/shared/privacy/maskingPolicy';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default masking context applied to operations queue and detail views. */
const DEFAULT_MASKING_CONTEXT = maskingPolicy.MASKING_CONTEXTS.DETAIL;

/** Default page size applied when none is supplied. */
const DEFAULT_PAGE_SIZE = 25;

/** Maximum page size permitted for in-memory pagination. */
const MAX_PAGE_SIZE = 100;

/** Action used to reset a payment back to a clean baseline. */
const RESET_ACTION = LIFECYCLE_ACTIONS.RESET;

/**
 * Safe reason codes surfaced by the operations facade for gating and messaging.
 * @type {{
 *   SEARCHED: 'operations.facade.searched',
 *   DETAIL_RESOLVED: 'operations.facade.detail_resolved',
 *   TRANSITIONED: 'operations.facade.transitioned',
 *   RESET: 'operations.facade.reset',
 *   RESET_ALL: 'operations.facade.reset_all',
 *   UNAUTHORIZED: 'operations.facade.unauthorized',
 *   NOT_FOUND: 'operations.facade.not_found',
 *   INVALID_TRANSITION: 'operations.facade.invalid_transition',
 *   PERSIST_FAILED: 'operations.facade.persist_failed',
 *   UNEXPECTED: 'operations.facade.unexpected',
 * }}
 */
export const OPERATIONS_FACADE_REASON_CODES = Object.freeze({
  SEARCHED: 'operations.facade.searched',
  DETAIL_RESOLVED: 'operations.facade.detail_resolved',
  TRANSITIONED: 'operations.facade.transitioned',
  RESET: 'operations.facade.reset',
  RESET_ALL: 'operations.facade.reset_all',
  UNAUTHORIZED: 'operations.facade.unauthorized',
  NOT_FOUND: 'operations.facade.not_found',
  INVALID_TRANSITION: 'operations.facade.invalid_transition',
  PERSIST_FAILED: 'operations.facade.persist_failed',
  UNEXPECTED: 'operations.facade.unexpected',
});

/** Lazily-provisioned payment repository shared across facade calls. */
let sharedRepository = null;

/**
 * Determines whether a value is a plain, non-array object.
 * @param {unknown} value - The candidate value.
 * @returns {boolean} `true` when `value` is a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes an arbitrary value into a trimmed string.
 * @param {unknown} value - The raw value.
 * @returns {string} A trimmed string (empty when unusable).
 */
function toText(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

/**
 * Builds a discriminated failure result carrying a sanitized reason code.
 * @param {string} safeReasonCode - The sanitized reason code.
 * @returns {{ ok: false, safeReasonCode: string }} A failure result.
 */
function fail(safeReasonCode) {
  return { ok: false, safeReasonCode };
}

/**
 * Provisions (or returns) the shared payment repository, creating a local
 * storage adapter and repository on first use. Failures degrade to `null` so
 * callers never crash on a storage fault.
 * @returns {import('@/features/payment/data/paymentRepository').PaymentRepository | null}
 *   The shared repository, or `null` when it could not be provisioned.
 */
function resolveRepository() {
  if (sharedRepository) {
    return sharedRepository;
  }
  try {
    const adapter = createLocalStorageAdapter();
    sharedRepository = createPaymentRepository(adapter);
    return sharedRepository;
  } catch (error) {
    safeLogger.error('operationsFacade: failed to provision payment repository', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * Overrides the repository backing the facade. Primarily used by tests to
 * inject a deterministic or in-memory repository.
 * @param {import('@/features/payment/data/paymentRepository').PaymentRepository | null} repository
 *   The repository to use, or `null` to reset to lazy provisioning.
 * @returns {void}
 */
export function configureOperationsFacade(repository) {
  sharedRepository = repository ?? null;
}

/**
 * Resolves the acting subject identifier from a session claim.
 * @param {Record<string, unknown> | null | undefined} session - The session.
 * @returns {string | undefined} The subject identifier, or `undefined`.
 */
function resolveActorId(session) {
  if (!isPlainObject(session)) {
    return undefined;
  }
  const subjectId = toText(session.subjectId);
  return subjectId.length > 0 ? subjectId : undefined;
}

/**
 * Determines whether the acting session may operate payments.
 * @param {Record<string, unknown> | null | undefined} session - The session.
 * @returns {boolean} `true` when the session holds the operate capability.
 */
function canOperate(session) {
  return authorizationPolicy.can(session, CAPABILITIES.PAYMENT_OPERATE);
}

/**
 * Resolves a supported masking context, falling back to the default.
 * @param {string} [context] - The requested context.
 * @returns {string} A valid masking context.
 */
function resolveContext(context) {
  const contexts = Object.values(maskingPolicy.MASKING_CONTEXTS);
  return typeof context === 'string' && contexts.includes(context)
    ? context
    : DEFAULT_MASKING_CONTEXT;
}

/**
 * Resolves a non-negative integer, falling back when unusable.
 * @param {unknown} value - The candidate value.
 * @param {number} fallback - The value returned when `value` is unusable.
 * @returns {number} A finite, non-negative integer.
 */
function toNonNegativeInt(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.trunc(parsed);
    }
  }
  return fallback;
}

/**
 * Records a sanitized status audit event, never throwing on failure.
 * @param {Record<string, unknown>} details - The status event details.
 * @returns {void}
 */
function auditStatus(details) {
  try {
    recordPaymentAuditEvent(createStatusAuditEvent(details));
  } catch (error) {
    safeLogger.warn('operationsFacade: failed to record status audit event', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * Reads the current lifecycle status from a payment record.
 * @param {Record<string, unknown>} record - The payment record.
 * @returns {string} The current status.
 */
function resolveStatus(record) {
  return toText(record.status);
}

/**
 * Reads the payment identifier from a record, honoring both field styles.
 * @param {Record<string, unknown>} record - The payment record.
 * @returns {string} The payment identifier (empty when absent).
 */
function resolvePaymentId(record) {
  return toText(record.payment_id) || toText(record.paymentId);
}

/**
 * Reads the created-at instant from a record, honoring both field styles.
 * @param {Record<string, unknown>} record - The payment record.
 * @returns {string} The created-at instant (empty when absent).
 */
function resolveCreatedAt(record) {
  return toText(record.created_at) || toText(record.createdAt);
}

/**
 * Reads the source currency from a record, honoring both field styles.
 * @param {Record<string, unknown>} record - The payment record.
 * @returns {string} The source currency (empty when absent).
 */
function resolveSourceCurrency(record) {
  return toText(record.source_currency) || toText(record.sourceCurrency);
}

/**
 * Reads the beneficiary currency from a record, honoring both field styles.
 * @param {Record<string, unknown>} record - The payment record.
 * @returns {string} The beneficiary currency (empty when absent).
 */
function resolveBeneficiaryCurrency(record) {
  return toText(record.beneficiary_currency) || toText(record.beneficiaryCurrency);
}

/**
 * Reads the payment reference from a record, honoring both field styles.
 * @param {Record<string, unknown>} record - The payment record.
 * @returns {string} The payment reference (empty when absent).
 */
function resolvePaymentReference(record) {
  return toText(record.payment_reference) || toText(record.paymentReference);
}

/**
 * Reads the scenario reference from a record, honoring both field styles.
 * @param {Record<string, unknown>} record - The payment record.
 * @returns {string} The scenario reference (empty when absent).
 */
function resolveScenarioRef(record) {
  return toText(record.scenario_ref) || toText(record.scenarioRef);
}

/**
 * Merges the baseline fixture records with any locally-recorded payment
 * snapshots, keyed by payment id (the local snapshot wins on conflict).
 * @param {import('@/features/payment/data/paymentRepository').PaymentRepository | null} repository
 *   The payment repository.
 * @returns {Map<string, Record<string, unknown>>} Merged records by payment id.
 */
function mergeRecords(repository) {
  const merged = new Map();

  let baseline = [];
  try {
    baseline = fixtureRegistry.getPaymentRecords();
  } catch (error) {
    safeLogger.error('operationsFacade: failed to read payment records fixture', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }

  for (const record of baseline) {
    if (isPlainObject(record)) {
      const id = resolvePaymentId(record);
      if (id.length > 0) {
        merged.set(id, record);
      }
    }
  }

  if (repository) {
    let localRecords = [];
    try {
      localRecords = repository.readRecords();
    } catch (error) {
      safeLogger.warn('operationsFacade: failed to read local payment records', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
    for (const record of localRecords) {
      if (isPlainObject(record)) {
        const id = resolvePaymentId(record);
        if (id.length > 0) {
          merged.set(id, record);
        }
      }
    }
  }

  return merged;
}

/**
 * Loads a single merged payment record by its identifier.
 * @param {import('@/features/payment/data/paymentRepository').PaymentRepository | null} repository
 *   The payment repository.
 * @param {string} paymentId - The payment identifier.
 * @returns {Record<string, unknown> | undefined} The merged record.
 */
function loadPaymentRecord(repository, paymentId) {
  const id = toText(paymentId);
  if (id.length === 0) {
    return undefined;
  }
  let record;
  if (repository) {
    record = repository.findRecord(id);
  }
  if (!isPlainObject(record)) {
    record = fixtureRegistry.getPaymentRecordById(id);
  }
  return isPlainObject(record) ? record : undefined;
}

/**
 * Builds a sanitized, masked queue view model for a payment record.
 * @param {Record<string, unknown>} record - The payment record.
 * @param {string} context - The resolved masking context.
 * @returns {Record<string, unknown>} A masked payment view model.
 */
function toQueueModel(record, context) {
  return {
    paymentId: resolvePaymentId(record),
    paymentReference: resolvePaymentReference(record),
    status: resolveStatus(record),
    accountId: toText(record.account_id) || toText(record.accountId) || null,
    beneficiaryName: maskingPolicy.mask(
      'name',
      toText(record.beneficiary_name_masked) || toText(record.beneficiaryName),
      context,
    ),
    sourceCurrency: resolveSourceCurrency(record),
    beneficiaryCurrency: resolveBeneficiaryCurrency(record),
    pairId: toText(record.pair_id) || toText(record.pairId) || null,
    instructedAmount: toText(record.instructed_amount) || toText(record.instructedAmount) || null,
    settlementAmount: toText(record.settlement_amount) || toText(record.settlementAmount) || null,
    scenarioRef: resolveScenarioRef(record) || null,
    safeReasonCode: toText(record.safe_reason_code) || toText(record.safeReasonCode) || null,
    createdAt: resolveCreatedAt(record) || null,
    updatedAt: toText(record.updated_at) || toText(record.updatedAt) || null,
  };
}

/**
 * Builds a sanitized processing checkpoint model from a raw checkpoint record.
 * Only safe stage/result/reason-code primitives are retained; no restricted
 * rule data is ever surfaced.
 * @param {unknown} checkpoint - The raw checkpoint record.
 * @returns {{ stage: string, result: string, safeReasonCode: string | null } | null}
 *   A sanitized checkpoint, or `null`.
 */
function toCheckpoint(checkpoint) {
  if (!isPlainObject(checkpoint)) {
    return null;
  }
  const stage = toText(checkpoint.stage);
  const result = toText(checkpoint.result);
  if (stage.length === 0 && result.length === 0) {
    return null;
  }
  return {
    stage,
    result,
    safeReasonCode: toText(checkpoint.safe_reason_code) || toText(checkpoint.safeReasonCode) || null,
  };
}

/**
 * Builds the sanitized processing checkpoints for a payment record.
 * @param {Record<string, unknown>} record - The payment record.
 * @returns {Array<Record<string, unknown>>} Sanitized checkpoints (may be empty).
 */
function toCheckpoints(record) {
  const source = Array.isArray(record.checkpoints)
    ? record.checkpoints
    : Array.isArray(record.checks)
      ? record.checks
      : [];
  return source.map((checkpoint) => toCheckpoint(checkpoint)).filter((entry) => entry !== null);
}

/**
 * Builds a sanitized ledger posting model from a raw posting record. Only safe
 * masked primitives are retained; no restricted rule data is surfaced.
 * @param {unknown} posting - The raw posting record.
 * @param {string} context - The resolved masking context.
 * @returns {{
 *   postingId: string,
 *   ledgerAccount: string,
 *   direction: string,
 *   amount: string | null,
 *   currency: string,
 *   reference: string,
 * } | null} A sanitized posting, or `null`.
 */
function toPosting(posting, context) {
  if (!isPlainObject(posting)) {
    return null;
  }
  const ledgerAccount = toText(posting.ledger_account_id) || toText(posting.ledgerAccount);
  const direction = toText(posting.direction);
  if (ledgerAccount.length === 0 && direction.length === 0) {
    return null;
  }
  return {
    postingId: toText(posting.posting_id) || toText(posting.postingId),
    ledgerAccount,
    direction,
    amount: toText(posting.amount) || null,
    currency: toText(posting.currency),
    reference: maskingPolicy.mask(
      'reference',
      toText(posting.reference_masked) || toText(posting.reference),
      context,
    ),
  };
}

/**
 * Builds the sanitized ledger postings for a payment record.
 * @param {Record<string, unknown>} record - The payment record.
 * @param {string} context - The resolved masking context.
 * @returns {Array<Record<string, unknown>>} Sanitized postings (may be empty).
 */
function toPostings(record, context) {
  const source = Array.isArray(record.postings) ? record.postings : [];
  return source
    .map((posting) => toPosting(posting, context))
    .filter((entry) => entry !== null);
}

/**
 * Builds the sanitized SWIFT status model for a payment record.
 * @param {Record<string, unknown>} record - The payment record.
 * @returns {{ status: string | null, safeReasonCode: string | null } | null}
 *   The sanitized SWIFT status, or `null`.
 */
function toSwiftStatus(record) {
  const swift = record.swift_status ?? record.swiftStatus;
  if (isPlainObject(swift)) {
    return {
      status: toText(swift.status) || null,
      safeReasonCode: toText(swift.safe_reason_code) || toText(swift.safeReasonCode) || null,
    };
  }
  const status = toText(record.swift_status) || toText(record.swiftStatus);
  if (status.length === 0) {
    return null;
  }
  return { status, safeReasonCode: null };
}

/**
 * Builds a sanitized, masked detail view model for a payment record.
 * @param {Record<string, unknown>} record - The payment record.
 * @param {string} context - The resolved masking context.
 * @returns {Record<string, unknown>} A masked payment detail model.
 */
function toDetailModel(record, context) {
  return {
    ...toQueueModel(record, context),
    feeAmount: toText(record.fee_amount) || toText(record.feeAmount) || null,
    feeCurrency: toText(record.fee_currency) || toText(record.feeCurrency) || null,
    chargeTreatment: toText(record.charge_treatment) || toText(record.chargeTreatment) || null,
    remittanceInfo: maskingPolicy.mask(
      'reference',
      toText(record.remittance_info_masked) || toText(record.remittanceInfo),
      context,
    ),
    quoteRef: toText(record.quote_ref) || toText(record.quoteRef) || null,
    uetr: toText(record.uetr) || null,
    decisionComment: toText(record.decision_comment) || toText(record.decisionComment)
      ? maskingPolicy.mask(
          'reference',
          toText(record.decision_comment) || toText(record.decisionComment),
          context,
        )
      : null,
    checkpoints: toCheckpoints(record),
    postings: toPostings(record, context),
    swiftStatus: toSwiftStatus(record),
    allowedActions: lifecycleMachine.getAllowedActions(resolveStatus(record)),
  };
}

/**
 * Searches the entitlement-scoped payment set, returning masked queue models
 * with in-memory pagination.
 *
 * Deny-by-default: the session must hold the `payment:operate` capability. The
 * search merges the bundled fixture records with any locally-recorded snapshots
 * (the local snapshot wins on conflict) and applies the supplied filters.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {{
 *   status?: string,
 *   currency?: string,
 *   reference?: string,
 *   scenarioRef?: string,
 *   since?: string,
 *   until?: string,
 *   page?: number,
 *   pageSize?: number,
 *   context?: string,
 * }} [filter] - Optional search filter.
 * @returns {{
 *   ok: boolean,
 *   payments: Array<Record<string, unknown>>,
 *   total: number,
 *   page: number,
 *   pageSize: number,
 *   safeReasonCode: string,
 * }} A discriminated search result with masked payments.
 */
export function searchPayments(session, filter) {
  if (!canOperate(session)) {
    safeLogger.warn('operationsFacade: searchPayments denied; missing capability');
    return {
      ok: false,
      payments: [],
      total: 0,
      page: 0,
      pageSize: DEFAULT_PAGE_SIZE,
      safeReasonCode: OPERATIONS_FACADE_REASON_CODES.UNAUTHORIZED,
    };
  }

  const repository = resolveRepository();
  const source = isPlainObject(filter) ? filter : {};
  const context = resolveContext(source.context);

  const statusFilter = toText(source.status);
  const currencyFilter = toText(source.currency).toUpperCase();
  const referenceFilter = toText(source.reference).toLowerCase();
  const scenarioFilter = toText(source.scenarioRef);
  const since = toText(source.since);
  const until = toText(source.until);

  const merged = mergeRecords(repository);

  const filtered = Array.from(merged.values()).filter((record) => {
    if (statusFilter.length > 0 && resolveStatus(record) !== statusFilter) {
      return false;
    }
    if (currencyFilter.length > 0) {
      const sourceCurrency = resolveSourceCurrency(record).toUpperCase();
      const beneficiaryCurrency = resolveBeneficiaryCurrency(record).toUpperCase();
      if (sourceCurrency !== currencyFilter && beneficiaryCurrency !== currencyFilter) {
        return false;
      }
    }
    if (referenceFilter.length > 0) {
      const haystack =
        `${resolvePaymentId(record)} ${resolvePaymentReference(record)}`.toLowerCase();
      if (!haystack.includes(referenceFilter)) {
        return false;
      }
    }
    if (scenarioFilter.length > 0 && resolveScenarioRef(record) !== scenarioFilter) {
      return false;
    }
    const createdAt = resolveCreatedAt(record);
    if (since.length > 0 && createdAt.length > 0 && createdAt < since) {
      return false;
    }
    if (until.length > 0 && createdAt.length > 0 && createdAt > until) {
      return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    const left = resolveCreatedAt(a);
    const right = resolveCreatedAt(b);
    return left < right ? 1 : left > right ? -1 : 0;
  });

  const total = filtered.length;
  const pageSize = Math.min(
    Math.max(1, toNonNegativeInt(source.pageSize, DEFAULT_PAGE_SIZE)),
    MAX_PAGE_SIZE,
  );
  const maxPage = total === 0 ? 0 : Math.floor((total - 1) / pageSize);
  const page = Math.min(toNonNegativeInt(source.page, 0), maxPage);
  const start = page * pageSize;
  const pageRecords = filtered.slice(start, start + pageSize);

  const payments = pageRecords.map((record) => toQueueModel(record, context));

  return {
    ok: true,
    payments,
    total,
    page,
    pageSize,
    safeReasonCode: OPERATIONS_FACADE_REASON_CODES.SEARCHED,
  };
}

/**
 * Returns a sanitized payment detail snapshot for the acting session, resolving
 * the locally-recorded payment first and falling back to the bundled fixture.
 *
 * The snapshot carries masked identifiers, safe reason codes, sanitized
 * processing checkpoints, ledger postings, and SWIFT status — never restricted
 * rule data.
 *
 * Deny-by-default: the session must hold the `payment:operate` capability.
 * Never throws for expected failures.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {string} paymentId - The payment identifier.
 * @param {{ context?: string }} [options] - Optional options.
 * @returns {{
 *   ok: boolean,
 *   payment?: Record<string, unknown>,
 *   safeReasonCode: string,
 * }} A discriminated detail result.
 */
export function getPaymentDetail(session, paymentId, options) {
  if (!canOperate(session)) {
    return fail(OPERATIONS_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  const id = toText(paymentId);
  if (id.length === 0) {
    return fail(OPERATIONS_FACADE_REASON_CODES.NOT_FOUND);
  }

  const repository = resolveRepository();
  const record = loadPaymentRecord(repository, id);
  if (!record) {
    return fail(OPERATIONS_FACADE_REASON_CODES.NOT_FOUND);
  }

  const source = isPlainObject(options) ? options : {};
  const context = resolveContext(source.context);

  return {
    ok: true,
    payment: toDetailModel(record, context),
    safeReasonCode: OPERATIONS_FACADE_REASON_CODES.DETAIL_RESOLVED,
  };
}

/**
 * Persists an updated payment snapshot with a new status, recording the change.
 * @param {import('@/features/payment/data/paymentRepository').PaymentRepository} repository
 *   The payment repository.
 * @param {Record<string, unknown>} record - The current payment record.
 * @param {string} status - The new lifecycle status.
 * @param {string | undefined} actorId - The acting subject identifier.
 * @returns {boolean} `true` when the snapshot was persisted.
 */
function persistStatus(repository, record, status, actorId) {
  const paymentId = resolvePaymentId(record);
  const candidate = { ...record, paymentId, status };
  if (actorId !== undefined) {
    candidate.operatedBy = actorId;
  }
  const saved = repository.saveRecord(candidate);
  return saved.ok;
}

/**
 * Applies a permitted local lifecycle transition to a payment, recording the
 * change.
 *
 * Deny-by-default: the session must hold the `payment:operate` capability, the
 * payment must exist, and the attempted transition must be permitted by the
 * lifecycle machine. Never throws for expected failures. Every outcome is
 * audited.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {string} paymentId - The payment identifier.
 * @param {string} action - The lifecycle action to apply.
 * @param {{ safeReasonCode?: string, metadata?: Record<string, unknown> }} [options] - Optional options.
 * @returns {{
 *   ok: boolean,
 *   paymentId?: string,
 *   status?: string,
 *   event?: Record<string, unknown> | null,
 *   safeReasonCode: string,
 * }} A discriminated transition result.
 */
export function transitionPayment(session, paymentId, action, options) {
  const actorId = resolveActorId(session);
  const subjectId = toText(paymentId) || undefined;
  const source = isPlainObject(options) ? options : {};

  if (!canOperate(session)) {
    auditStatus({
      actorId,
      paymentId: subjectId,
      action: toText(action) || undefined,
      safeReasonCode: OPERATIONS_FACADE_REASON_CODES.UNAUTHORIZED,
    });
    return fail(OPERATIONS_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  const repository = resolveRepository();
  if (!repository) {
    return fail(OPERATIONS_FACADE_REASON_CODES.UNEXPECTED);
  }

  const record = loadPaymentRecord(repository, paymentId);
  if (!record) {
    auditStatus({
      actorId,
      paymentId: subjectId,
      action: toText(action) || undefined,
      safeReasonCode: OPERATIONS_FACADE_REASON_CODES.NOT_FOUND,
    });
    return fail(OPERATIONS_FACADE_REASON_CODES.NOT_FOUND);
  }

  const currentStatus = resolveStatus(record);
  const transitioned = lifecycleMachine.transition(currentStatus, toText(action), {
    actorId: actorId ?? undefined,
    safeReasonCode: OPERATIONS_FACADE_REASON_CODES.TRANSITIONED,
    metadata: isPlainObject(source.metadata)
      ? source.metadata
      : { paymentId: toText(paymentId) },
  });
  if (!transitioned.ok) {
    auditStatus({
      actorId,
      paymentId: subjectId,
      fromState: currentStatus,
      action: toText(action) || undefined,
      safeReasonCode: OPERATIONS_FACADE_REASON_CODES.INVALID_TRANSITION,
    });
    return fail(OPERATIONS_FACADE_REASON_CODES.INVALID_TRANSITION);
  }

  const nextStatus = transitioned.toState;

  if (!persistStatus(repository, record, nextStatus, actorId)) {
    auditStatus({
      actorId,
      paymentId: subjectId,
      fromState: transitioned.fromState,
      toState: nextStatus,
      action: transitioned.action,
      safeReasonCode: OPERATIONS_FACADE_REASON_CODES.PERSIST_FAILED,
    });
    return fail(OPERATIONS_FACADE_REASON_CODES.PERSIST_FAILED);
  }

  auditStatus({
    actorId,
    paymentId: subjectId,
    fromState: transitioned.fromState,
    toState: nextStatus,
    action: transitioned.action,
    safeReasonCode: toText(source.safeReasonCode) || OPERATIONS_FACADE_REASON_CODES.TRANSITIONED,
  });

  return {
    ok: true,
    paymentId: toText(paymentId),
    status: nextStatus,
    event: transitioned.event,
    safeReasonCode: OPERATIONS_FACADE_REASON_CODES.TRANSITIONED,
  };
}

/**
 * Resets a single payment back to a clean baseline via a permitted local
 * transition, recording the change.
 *
 * Deny-by-default: the session must hold the `payment:operate` capability, the
 * payment must exist, and the reset transition must be permitted by the
 * lifecycle machine from the payment's current state. Never throws for expected
 * failures.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {string} paymentId - The payment identifier.
 * @returns {{
 *   ok: boolean,
 *   paymentId?: string,
 *   status?: string,
 *   event?: Record<string, unknown> | null,
 *   safeReasonCode: string,
 * }} A discriminated reset result.
 */
export function resetPayment(session, paymentId) {
  const result = transitionPayment(session, paymentId, RESET_ACTION, {
    safeReasonCode: OPERATIONS_FACADE_REASON_CODES.RESET,
  });
  if (!result.ok) {
    return result;
  }
  return { ...result, safeReasonCode: OPERATIONS_FACADE_REASON_CODES.RESET };
}

/**
 * Clears all locally-recorded payment demo state (drafts, accepted records,
 * reservations, and scenario overrides) so the baseline fixtures become the
 * source of truth again.
 *
 * Deny-by-default: the session must hold the `payment:operate` capability. Each
 * removal is isolated so a single storage fault can never abort the whole
 * reset. Never throws for expected failures.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @returns {{ ok: boolean, safeReasonCode: string }} A discriminated result.
 */
export function resetAllPaymentDemoData(session) {
  const actorId = resolveActorId(session);

  if (!canOperate(session)) {
    auditStatus({
      actorId,
      action: 'reset_all',
      safeReasonCode: OPERATIONS_FACADE_REASON_CODES.UNAUTHORIZED,
    });
    return fail(OPERATIONS_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  const repository = resolveRepository();
  if (!repository) {
    return fail(OPERATIONS_FACADE_REASON_CODES.UNEXPECTED);
  }

  try {
    repository.clearDrafts();
    repository.clearRecords();
    repository.clearReservations();
    repository.clearScenarioOverrides();
  } catch (error) {
    safeLogger.error('operationsFacade: unexpected error clearing payment demo data', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return fail(OPERATIONS_FACADE_REASON_CODES.UNEXPECTED);
  }

  auditStatus({
    actorId,
    action: 'reset_all',
    toState: LIFECYCLE_STATES.DRAFT,
    safeReasonCode: OPERATIONS_FACADE_REASON_CODES.RESET_ALL,
  });

  return { ok: true, safeReasonCode: OPERATIONS_FACADE_REASON_CODES.RESET_ALL };
}

/**
 * The operations facade contract, exposed as a single frozen object.
 * @type {{
 *   searchPayments: typeof searchPayments,
 *   getPaymentDetail: typeof getPaymentDetail,
 *   transitionPayment: typeof transitionPayment,
 *   resetPayment: typeof resetPayment,
 *   resetAllPaymentDemoData: typeof resetAllPaymentDemoData,
 *   configureOperationsFacade: typeof configureOperationsFacade,
 *   OPERATIONS_FACADE_REASON_CODES: typeof OPERATIONS_FACADE_REASON_CODES,
 * }}
 */
export const operationsFacade = Object.freeze({
  searchPayments,
  getPaymentDetail,
  transitionPayment,
  resetPayment,
  resetAllPaymentDemoData,
  configureOperationsFacade,
  OPERATIONS_FACADE_REASON_CODES,
});

export default operationsFacade;