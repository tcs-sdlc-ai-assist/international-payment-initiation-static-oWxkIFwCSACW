/**
 * Payment approval facade.
 *
 * ApprovalFacade is the single entry point the payment approval flow uses to
 * review, approve, and reject submitted payments (SCRUM-819). It layers atop the
 * {@link PaymentRepository} (accepted payment snapshots and draft persistence),
 * the {@link fixtureRegistry} (baseline payment records + role-derived
 * capabilities), the {@link lifecycleMachine} (controlled lifecycle
 * transitions), the {@link authorizationPolicy} (capability gating), the
 * {@link maskingPolicy} (PII masking for the queue and detail views), and the
 * {@link paymentAuditEventFactory} (sanitized, masked approval/status audit
 * events):
 *
 *   - `listApprovalQueue(session, options)` returns the entitlement-scoped,
 *     masked set of payments awaiting approval.
 *   - `approvePayment(session, paymentId, options)` approves a pending payment,
 *     enforcing simulated segregation-of-duties (an approver may not approve a
 *     payment they submitted) where configured, transitioning the lifecycle and
 *     recording the decision.
 *   - `rejectPayment(session, paymentId, options)` rejects a pending payment
 *     with an optional comment, transitioning the lifecycle and recording the
 *     decision.
 *   - `getPaymentDetail(session, paymentId, options)` returns a masked payment
 *     detail snapshot for the acting session.
 *
 * The facade is intentionally conservative and demo-only: it enforces
 * client-side gating (deny-by-default via the {@link authorizationPolicy}),
 * never throws for expected failures — each method returns a discriminated
 * `{ ok, ... }` result carrying a sanitized safe reason code — and carries no
 * server guarantee. Segregation-of-duties is a simulated, client-side control
 * only.
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
  createApprovalAuditEvent,
  createStatusAuditEvent,
  recordPaymentAuditEvent,
} from '@/features/payment/data/paymentAuditEventFactory';
import { maskingPolicy } from '@/shared/privacy/maskingPolicy';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Payment status indicating a payment is awaiting approval. */
const PENDING_APPROVAL_STATUS = LIFECYCLE_STATES.PENDING_APPROVAL;

/** Default masking context applied to approval queue and detail views. */
const DEFAULT_MASKING_CONTEXT = maskingPolicy.MASKING_CONTEXTS.CONFIRMATION;

/**
 * Safe reason codes surfaced by the approval facade for gating and messaging.
 * @type {{
 *   QUEUE_LISTED: 'approval.facade.queue_listed',
 *   APPROVED: 'approval.facade.approved',
 *   REJECTED: 'approval.facade.rejected',
 *   DETAIL_RESOLVED: 'approval.facade.detail_resolved',
 *   UNAUTHORIZED: 'approval.facade.unauthorized',
 *   NOT_FOUND: 'approval.facade.not_found',
 *   NOT_PENDING: 'approval.facade.not_pending',
 *   SEGREGATION_VIOLATION: 'approval.facade.segregation_violation',
 *   INVALID_TRANSITION: 'approval.facade.invalid_transition',
 *   PERSIST_FAILED: 'approval.facade.persist_failed',
 *   UNEXPECTED: 'approval.facade.unexpected',
 * }}
 */
export const APPROVAL_FACADE_REASON_CODES = Object.freeze({
  QUEUE_LISTED: 'approval.facade.queue_listed',
  APPROVED: 'approval.facade.approved',
  REJECTED: 'approval.facade.rejected',
  DETAIL_RESOLVED: 'approval.facade.detail_resolved',
  UNAUTHORIZED: 'approval.facade.unauthorized',
  NOT_FOUND: 'approval.facade.not_found',
  NOT_PENDING: 'approval.facade.not_pending',
  SEGREGATION_VIOLATION: 'approval.facade.segregation_violation',
  INVALID_TRANSITION: 'approval.facade.invalid_transition',
  PERSIST_FAILED: 'approval.facade.persist_failed',
  UNEXPECTED: 'approval.facade.unexpected',
});

/** Maximum retained length of a captured rejection comment. */
const MAX_COMMENT_LENGTH = 280;

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
    safeLogger.error('approvalFacade: failed to provision payment repository', {
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
export function configureApprovalFacade(repository) {
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
 * Determines whether the acting session may approve payments.
 * @param {Record<string, unknown> | null | undefined} session - The session.
 * @returns {boolean} `true` when the session holds the approve capability.
 */
function canApprove(session) {
  return authorizationPolicy.can(session, CAPABILITIES.PAYMENT_APPROVE);
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
 * Normalizes and bounds a captured decision comment.
 * @param {unknown} comment - The raw comment.
 * @returns {string | null} A bounded comment string, or `null`.
 */
function normalizeComment(comment) {
  const text = toText(comment);
  if (text.length === 0) {
    return null;
  }
  return text.length > MAX_COMMENT_LENGTH ? text.slice(0, MAX_COMMENT_LENGTH) : text;
}

/**
 * Records a sanitized approval audit event, never throwing on failure.
 * @param {Record<string, unknown>} details - The approval event details.
 * @returns {void}
 */
function auditApproval(details) {
  try {
    recordPaymentAuditEvent(createApprovalAuditEvent(details));
  } catch (error) {
    safeLogger.warn('approvalFacade: failed to record approval audit event', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
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
    safeLogger.warn('approvalFacade: failed to record status audit event', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * Loads a payment record by its identifier, resolving the locally-recorded
 * snapshot first and falling back to the bundled fixture.
 * @param {import('@/features/payment/data/paymentRepository').PaymentRepository | null} repository
 *   The payment repository.
 * @param {string} paymentId - The payment identifier.
 * @returns {Record<string, unknown> | undefined} The payment record.
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
 * Resolves the identifier of the actor who submitted a payment record.
 * @param {Record<string, unknown>} record - The payment record.
 * @returns {string} The submitter identifier (empty when absent).
 */
function resolveSubmitter(record) {
  return toText(record.submittedBy) || toText(record.submitted_by);
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
 * Builds a sanitized, masked queue/detail view model for a payment record.
 * @param {Record<string, unknown>} record - The payment record.
 * @param {string} context - The resolved masking context.
 * @returns {Record<string, unknown>} A masked payment view model.
 */
function toViewModel(record, context) {
  return {
    paymentId: toText(record.payment_id) || toText(record.paymentId),
    paymentReference: toText(record.payment_reference) || toText(record.paymentReference),
    status: resolveStatus(record),
    accountId: toText(record.account_id) || toText(record.accountId) || null,
    beneficiaryName: maskingPolicy.mask(
      'name',
      toText(record.beneficiary_name_masked) || toText(record.beneficiaryName),
      context,
    ),
    sourceCurrency: toText(record.source_currency) || toText(record.sourceCurrency),
    beneficiaryCurrency:
      toText(record.beneficiary_currency) || toText(record.beneficiaryCurrency),
    pairId: toText(record.pair_id) || toText(record.pairId),
    instructedAmount: toText(record.instructed_amount) || toText(record.instructedAmount) || null,
    settlementAmount: toText(record.settlement_amount) || toText(record.settlementAmount) || null,
    feeAmount: toText(record.fee_amount) || toText(record.feeAmount) || null,
    feeCurrency: toText(record.fee_currency) || toText(record.feeCurrency) || null,
    chargeTreatment: toText(record.charge_treatment) || toText(record.chargeTreatment) || null,
    remittanceInfo: maskingPolicy.mask(
      'reference',
      toText(record.remittance_info_masked) || toText(record.remittanceInfo),
      context,
    ),
    submittedBy: resolveSubmitter(record) || null,
    createdAt: toText(record.created_at) || toText(record.createdAt) || null,
    updatedAt: toText(record.updated_at) || toText(record.updatedAt) || null,
  };
}

/**
 * Returns the entitlement-scoped, masked set of payments awaiting approval.
 *
 * Deny-by-default: the session must hold the `payment:approve` capability. The
 * queue merges the bundled fixture records with any locally-recorded payment
 * snapshots (the local snapshot wins on conflict) and includes only payments in
 * the pending-approval state.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {{ context?: string, text?: string }} [options] - Optional filter.
 * @returns {{
 *   ok: boolean,
 *   payments: Array<Record<string, unknown>>,
 *   safeReasonCode: string,
 * }} A discriminated result with masked payments.
 */
export function listApprovalQueue(session, options) {
  if (!canApprove(session)) {
    safeLogger.warn('approvalFacade: listApprovalQueue denied; missing capability');
    return {
      ok: false,
      payments: [],
      safeReasonCode: APPROVAL_FACADE_REASON_CODES.UNAUTHORIZED,
    };
  }

  const repository = resolveRepository();
  const source = isPlainObject(options) ? options : {};
  const context = resolveContext(source.context);

  let baseline;
  try {
    baseline = fixtureRegistry.getPaymentRecords();
  } catch (error) {
    safeLogger.error('approvalFacade: failed to read payment records fixture', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return {
      ok: false,
      payments: [],
      safeReasonCode: APPROVAL_FACADE_REASON_CODES.UNEXPECTED,
    };
  }

  const merged = new Map();
  for (const record of baseline) {
    if (isPlainObject(record)) {
      const id = toText(record.payment_id) || toText(record.paymentId);
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
      safeLogger.warn('approvalFacade: failed to read local payment records', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
    for (const record of localRecords) {
      if (isPlainObject(record)) {
        const id = toText(record.payment_id) || toText(record.paymentId);
        if (id.length > 0) {
          merged.set(id, record);
        }
      }
    }
  }

  const text = toText(source.text).toLowerCase();

  const payments = Array.from(merged.values())
    .filter((record) => resolveStatus(record) === PENDING_APPROVAL_STATUS)
    .map((record) => toViewModel(record, context))
    .filter((model) => {
      if (text.length === 0) {
        return true;
      }
      const haystack = `${toText(model.paymentId)} ${toText(model.paymentReference)}`.toLowerCase();
      return haystack.includes(text);
    });

  return {
    ok: true,
    payments,
    safeReasonCode: APPROVAL_FACADE_REASON_CODES.QUEUE_LISTED,
  };
}

/**
 * Persists an updated payment snapshot with a new status, recording the change.
 * @param {import('@/features/payment/data/paymentRepository').PaymentRepository} repository
 *   The payment repository.
 * @param {Record<string, unknown>} record - The current payment record.
 * @param {string} status - The new lifecycle status.
 * @param {string | null} comment - An optional decision comment.
 * @param {string | undefined} actorId - The acting subject identifier.
 * @returns {boolean} `true` when the snapshot was persisted.
 */
function persistDecision(repository, record, status, comment, actorId) {
  const paymentId = toText(record.payment_id) || toText(record.paymentId);
  const candidate = { ...record, paymentId, status };
  if (comment !== null) {
    candidate.decisionComment = comment;
  }
  if (actorId !== undefined) {
    candidate.decidedBy = actorId;
  }
  const saved = repository.saveRecord(candidate);
  return saved.ok;
}

/**
 * Approves a pending payment, enforcing simulated segregation-of-duties where
 * configured, transitioning the lifecycle and recording the decision.
 *
 * Deny-by-default: the session must hold the `payment:approve` capability, the
 * payment must exist and be pending approval, and — when segregation-of-duties
 * is enforced — the approver must not be the actor who submitted the payment.
 * Never throws for expected failures. Every outcome is audited.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {string} paymentId - The payment identifier.
 * @param {{ enforceSegregation?: boolean, comment?: string }} [options] - Optional options.
 * @returns {{
 *   ok: boolean,
 *   paymentId?: string,
 *   status?: string,
 *   event?: Record<string, unknown> | null,
 *   safeReasonCode: string,
 * }} A discriminated approval result.
 */
export function approvePayment(session, paymentId, options) {
  const actorId = resolveActorId(session);
  const subjectId = toText(paymentId) || undefined;
  const source = isPlainObject(options) ? options : {};

  if (!canApprove(session)) {
    auditApproval({
      actorId,
      paymentId: subjectId,
      approved: false,
      safeReasonCode: APPROVAL_FACADE_REASON_CODES.UNAUTHORIZED,
    });
    return fail(APPROVAL_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  const repository = resolveRepository();
  if (!repository) {
    return fail(APPROVAL_FACADE_REASON_CODES.UNEXPECTED);
  }

  const record = loadPaymentRecord(repository, paymentId);
  if (!record) {
    auditApproval({
      actorId,
      paymentId: subjectId,
      approved: false,
      safeReasonCode: APPROVAL_FACADE_REASON_CODES.NOT_FOUND,
    });
    return fail(APPROVAL_FACADE_REASON_CODES.NOT_FOUND);
  }

  if (resolveStatus(record) !== PENDING_APPROVAL_STATUS) {
    auditApproval({
      actorId,
      paymentId: subjectId,
      approved: false,
      safeReasonCode: APPROVAL_FACADE_REASON_CODES.NOT_PENDING,
    });
    return fail(APPROVAL_FACADE_REASON_CODES.NOT_PENDING);
  }

  const enforceSegregation = source.enforceSegregation !== false;
  if (enforceSegregation) {
    const submitter = resolveSubmitter(record);
    if (submitter.length > 0 && actorId !== undefined && submitter === actorId) {
      auditApproval({
        actorId,
        paymentId: subjectId,
        approved: false,
        safeReasonCode: APPROVAL_FACADE_REASON_CODES.SEGREGATION_VIOLATION,
      });
      return fail(APPROVAL_FACADE_REASON_CODES.SEGREGATION_VIOLATION);
    }
  }

  const transitioned = lifecycleMachine.transition(
    LIFECYCLE_STATES.PENDING_APPROVAL,
    LIFECYCLE_ACTIONS.APPROVE,
    {
      actorId: actorId ?? undefined,
      safeReasonCode: APPROVAL_FACADE_REASON_CODES.APPROVED,
      metadata: { paymentId: toText(paymentId) },
    },
  );
  if (!transitioned.ok) {
    auditApproval({
      actorId,
      paymentId: subjectId,
      approved: false,
      safeReasonCode: APPROVAL_FACADE_REASON_CODES.INVALID_TRANSITION,
    });
    return fail(APPROVAL_FACADE_REASON_CODES.INVALID_TRANSITION);
  }

  const comment = normalizeComment(source.comment);
  const nextStatus = transitioned.toState;

  if (!persistDecision(repository, record, nextStatus, comment, actorId)) {
    auditApproval({
      actorId,
      paymentId: subjectId,
      approved: false,
      safeReasonCode: APPROVAL_FACADE_REASON_CODES.PERSIST_FAILED,
    });
    return fail(APPROVAL_FACADE_REASON_CODES.PERSIST_FAILED);
  }

  auditApproval({
    actorId,
    paymentId: subjectId,
    outcome: nextStatus,
    approved: true,
    safeReasonCode: APPROVAL_FACADE_REASON_CODES.APPROVED,
  });

  auditStatus({
    actorId,
    paymentId: subjectId,
    fromState: transitioned.fromState,
    toState: nextStatus,
    action: transitioned.action,
    safeReasonCode: APPROVAL_FACADE_REASON_CODES.APPROVED,
  });

  return {
    ok: true,
    paymentId: toText(paymentId),
    status: nextStatus,
    event: transitioned.event,
    safeReasonCode: APPROVAL_FACADE_REASON_CODES.APPROVED,
  };
}

/**
 * Rejects a pending payment with an optional comment, transitioning the
 * lifecycle and recording the decision.
 *
 * Deny-by-default: the session must hold the `payment:approve` capability and
 * the payment must exist and be pending approval. Never throws for expected
 * failures. Every outcome is audited.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {string} paymentId - The payment identifier.
 * @param {{ comment?: string }} [options] - Optional options.
 * @returns {{
 *   ok: boolean,
 *   paymentId?: string,
 *   status?: string,
 *   event?: Record<string, unknown> | null,
 *   safeReasonCode: string,
 * }} A discriminated rejection result.
 */
export function rejectPayment(session, paymentId, options) {
  const actorId = resolveActorId(session);
  const subjectId = toText(paymentId) || undefined;
  const source = isPlainObject(options) ? options : {};

  if (!canApprove(session)) {
    auditApproval({
      actorId,
      paymentId: subjectId,
      approved: false,
      safeReasonCode: APPROVAL_FACADE_REASON_CODES.UNAUTHORIZED,
    });
    return fail(APPROVAL_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  const repository = resolveRepository();
  if (!repository) {
    return fail(APPROVAL_FACADE_REASON_CODES.UNEXPECTED);
  }

  const record = loadPaymentRecord(repository, paymentId);
  if (!record) {
    auditApproval({
      actorId,
      paymentId: subjectId,
      approved: false,
      safeReasonCode: APPROVAL_FACADE_REASON_CODES.NOT_FOUND,
    });
    return fail(APPROVAL_FACADE_REASON_CODES.NOT_FOUND);
  }

  if (resolveStatus(record) !== PENDING_APPROVAL_STATUS) {
    auditApproval({
      actorId,
      paymentId: subjectId,
      approved: false,
      safeReasonCode: APPROVAL_FACADE_REASON_CODES.NOT_PENDING,
    });
    return fail(APPROVAL_FACADE_REASON_CODES.NOT_PENDING);
  }

  const transitioned = lifecycleMachine.transition(
    LIFECYCLE_STATES.PENDING_APPROVAL,
    LIFECYCLE_ACTIONS.REJECT,
    {
      actorId: actorId ?? undefined,
      safeReasonCode: APPROVAL_FACADE_REASON_CODES.REJECTED,
      metadata: { paymentId: toText(paymentId) },
    },
  );
  if (!transitioned.ok) {
    auditApproval({
      actorId,
      paymentId: subjectId,
      approved: false,
      safeReasonCode: APPROVAL_FACADE_REASON_CODES.INVALID_TRANSITION,
    });
    return fail(APPROVAL_FACADE_REASON_CODES.INVALID_TRANSITION);
  }

  const comment = normalizeComment(source.comment);
  const nextStatus = transitioned.toState;

  if (!persistDecision(repository, record, nextStatus, comment, actorId)) {
    auditApproval({
      actorId,
      paymentId: subjectId,
      approved: false,
      safeReasonCode: APPROVAL_FACADE_REASON_CODES.PERSIST_FAILED,
    });
    return fail(APPROVAL_FACADE_REASON_CODES.PERSIST_FAILED);
  }

  auditApproval({
    actorId,
    paymentId: subjectId,
    outcome: nextStatus,
    approved: false,
    safeReasonCode: APPROVAL_FACADE_REASON_CODES.REJECTED,
  });

  auditStatus({
    actorId,
    paymentId: subjectId,
    fromState: transitioned.fromState,
    toState: nextStatus,
    action: transitioned.action,
    safeReasonCode: APPROVAL_FACADE_REASON_CODES.REJECTED,
  });

  return {
    ok: true,
    paymentId: toText(paymentId),
    status: nextStatus,
    event: transitioned.event,
    safeReasonCode: APPROVAL_FACADE_REASON_CODES.REJECTED,
  };
}

/**
 * Returns a masked payment detail snapshot for the acting session, resolving
 * the locally-recorded payment first and falling back to the bundled fixture.
 *
 * Deny-by-default: the session must hold the `payment:approve` capability.
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
  if (!canApprove(session)) {
    return fail(APPROVAL_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  const id = toText(paymentId);
  if (id.length === 0) {
    return fail(APPROVAL_FACADE_REASON_CODES.NOT_FOUND);
  }

  const repository = resolveRepository();
  const record = loadPaymentRecord(repository, id);
  if (!record) {
    return fail(APPROVAL_FACADE_REASON_CODES.NOT_FOUND);
  }

  const source = isPlainObject(options) ? options : {};
  const context = resolveContext(source.context);

  return {
    ok: true,
    payment: toViewModel(record, context),
    safeReasonCode: APPROVAL_FACADE_REASON_CODES.DETAIL_RESOLVED,
  };
}

/**
 * The approval facade contract, exposed as a single frozen object.
 * @type {{
 *   listApprovalQueue: typeof listApprovalQueue,
 *   approvePayment: typeof approvePayment,
 *   rejectPayment: typeof rejectPayment,
 *   getPaymentDetail: typeof getPaymentDetail,
 *   configureApprovalFacade: typeof configureApprovalFacade,
 *   APPROVAL_FACADE_REASON_CODES: typeof APPROVAL_FACADE_REASON_CODES,
 * }}
 */
export const approvalFacade = Object.freeze({
  listApprovalQueue,
  approvePayment,
  rejectPayment,
  getPaymentDetail,
  configureApprovalFacade,
  APPROVAL_FACADE_REASON_CODES,
});

export default approvalFacade;