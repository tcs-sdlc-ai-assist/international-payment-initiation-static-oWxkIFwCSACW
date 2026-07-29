/**
 * Payment lifecycle read facade (cross-cluster contract).
 *
 * PaymentLifecycleFacade is a read-only projection over the local payment
 * aggregate used for tracking, confirmation, and cross-feature consumption
 * (SCRUM-818). It layers atop the {@link fixtureRegistry} (baseline payment
 * records), the {@link PaymentRepository} (locally-recorded payment snapshots),
 * the {@link lifecycleMachine} (allowed local transitions), and the
 * {@link maskingPolicy} (PII masking for summaries and detail views). It
 * implements the PaymentLifecycleFacade contract:
 *
 *   - `getPaymentDetail(paymentId, options)` returns a sanitized, masked payment
 *     detail snapshot resolving the locally-recorded payment first and falling
 *     back to the bundled fixture.
 *   - `getMaskedPaymentSummary(paymentId, options)` returns a compact, masked
 *     summary suitable for tracking chips and cross-feature consumers.
 *   - `subscribeToLocalPaymentChanges(listener)` registers a change listener,
 *     invoked whenever a local payment change is published, and returns an
 *     unsubscribe function.
 *
 * The facade is intentionally read-only and demo-only: it never mutates the
 * aggregate, never throws for expected failures — each accessor returns a
 * discriminated `{ ok, ... }` result carrying a sanitized safe reason code — and
 * carries no server guarantee.
 */

import { fixtureRegistry } from '@/shared/fixtures/fixtureRegistry';
import { createLocalStorageAdapter } from '@/shared/storage/storageAdapter';
import { createPaymentRepository } from '@/features/payment/data/paymentRepository';
import { lifecycleMachine } from '@/features/payment/domain/lifecycleMachine';
import { maskingPolicy } from '@/shared/privacy/maskingPolicy';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default masking context applied to detail views. */
const DEFAULT_DETAIL_CONTEXT = maskingPolicy.MASKING_CONTEXTS.DETAIL;

/** Default masking context applied to compact summary views. */
const DEFAULT_SUMMARY_CONTEXT = maskingPolicy.MASKING_CONTEXTS.LIST;

/**
 * Safe reason codes surfaced by the payment lifecycle facade.
 * @type {{
 *   DETAIL_RESOLVED: 'payment.lifecycle.detail_resolved',
 *   SUMMARY_RESOLVED: 'payment.lifecycle.summary_resolved',
 *   NOT_FOUND: 'payment.lifecycle.not_found',
 *   UNEXPECTED: 'payment.lifecycle.unexpected',
 * }}
 */
export const PAYMENT_LIFECYCLE_REASON_CODES = Object.freeze({
  DETAIL_RESOLVED: 'payment.lifecycle.detail_resolved',
  SUMMARY_RESOLVED: 'payment.lifecycle.summary_resolved',
  NOT_FOUND: 'payment.lifecycle.not_found',
  UNEXPECTED: 'payment.lifecycle.unexpected',
});

/** Lazily-provisioned payment repository shared across facade calls. */
let sharedRepository = null;

/** Registered local payment change listeners. */
const listeners = new Set();

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
    safeLogger.error('paymentLifecycleFacade: failed to provision payment repository', {
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
export function configurePaymentLifecycleFacade(repository) {
  sharedRepository = repository ?? null;
}

/**
 * Resolves a supported masking context, falling back to the supplied default.
 * @param {string} [context] - The requested context.
 * @param {string} fallback - The default context to apply.
 * @returns {string} A valid masking context.
 */
function resolveContext(context, fallback) {
  const contexts = Object.values(maskingPolicy.MASKING_CONTEXTS);
  return typeof context === 'string' && contexts.includes(context) ? context : fallback;
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
 * Reads the payment reference from a record, honoring both field styles.
 * @param {Record<string, unknown>} record - The payment record.
 * @returns {string} The payment reference (empty when absent).
 */
function resolvePaymentReference(record) {
  return toText(record.payment_reference) || toText(record.paymentReference);
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
    try {
      record = repository.findRecord(id);
    } catch (error) {
      safeLogger.warn('paymentLifecycleFacade: failed to read local payment record', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  if (!isPlainObject(record)) {
    record = fixtureRegistry.getPaymentRecordById(id);
  }
  return isPlainObject(record) ? record : undefined;
}

/**
 * Builds a compact, masked summary view model for a payment record.
 * @param {Record<string, unknown>} record - The payment record.
 * @param {string} context - The resolved masking context.
 * @returns {Record<string, unknown>} A masked payment summary model.
 */
function toSummaryModel(record, context) {
  const status = resolveStatus(record);
  return {
    paymentId: resolvePaymentId(record),
    paymentReference: resolvePaymentReference(record),
    status,
    terminal: lifecycleMachine.isTerminal(status),
    beneficiaryName: maskingPolicy.mask(
      'name',
      toText(record.beneficiary_name_masked) || toText(record.beneficiaryName),
      context,
    ),
    sourceCurrency: toText(record.source_currency) || toText(record.sourceCurrency),
    beneficiaryCurrency:
      toText(record.beneficiary_currency) || toText(record.beneficiaryCurrency),
    pairId: toText(record.pair_id) || toText(record.pairId) || null,
    instructedAmount: toText(record.instructed_amount) || toText(record.instructedAmount) || null,
    settlementAmount: toText(record.settlement_amount) || toText(record.settlementAmount) || null,
    safeReasonCode: toText(record.safe_reason_code) || toText(record.safeReasonCode) || null,
    updatedAt: toText(record.updated_at) || toText(record.updatedAt) || null,
  };
}

/**
 * Builds a sanitized, masked detail view model for a payment record.
 * @param {Record<string, unknown>} record - The payment record.
 * @param {string} context - The resolved masking context.
 * @returns {Record<string, unknown>} A masked payment detail model.
 */
function toDetailModel(record, context) {
  return {
    ...toSummaryModel(record, context),
    accountId: toText(record.account_id) || toText(record.accountId) || null,
    rate: toText(record.rate) || null,
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
    scenarioRef: toText(record.scenario_ref) || toText(record.scenarioRef) || null,
    createdAt: toText(record.created_at) || toText(record.createdAt) || null,
    allowedActions: lifecycleMachine.getAllowedActions(resolveStatus(record)),
  };
}

/**
 * Returns a sanitized, masked payment detail snapshot resolving the
 * locally-recorded payment first and falling back to the bundled fixture.
 *
 * Read-only: never mutates the aggregate and never throws for expected
 * failures.
 *
 * @param {string} paymentId - The payment identifier.
 * @param {{ context?: string }} [options] - Optional options.
 * @returns {{
 *   ok: boolean,
 *   payment?: Record<string, unknown>,
 *   safeReasonCode: string,
 * }} A discriminated detail result.
 */
export function getPaymentDetail(paymentId, options) {
  const id = toText(paymentId);
  if (id.length === 0) {
    return fail(PAYMENT_LIFECYCLE_REASON_CODES.NOT_FOUND);
  }

  const repository = resolveRepository();
  const record = loadPaymentRecord(repository, id);
  if (!record) {
    return fail(PAYMENT_LIFECYCLE_REASON_CODES.NOT_FOUND);
  }

  const source = isPlainObject(options) ? options : {};
  const context = resolveContext(source.context, DEFAULT_DETAIL_CONTEXT);

  return {
    ok: true,
    payment: toDetailModel(record, context),
    safeReasonCode: PAYMENT_LIFECYCLE_REASON_CODES.DETAIL_RESOLVED,
  };
}

/**
 * Returns a compact, masked payment summary suitable for tracking chips and
 * cross-feature consumers, resolving the locally-recorded payment first and
 * falling back to the bundled fixture.
 *
 * Read-only: never mutates the aggregate and never throws for expected
 * failures.
 *
 * @param {string} paymentId - The payment identifier.
 * @param {{ context?: string }} [options] - Optional options.
 * @returns {{
 *   ok: boolean,
 *   summary?: Record<string, unknown>,
 *   safeReasonCode: string,
 * }} A discriminated summary result.
 */
export function getMaskedPaymentSummary(paymentId, options) {
  const id = toText(paymentId);
  if (id.length === 0) {
    return fail(PAYMENT_LIFECYCLE_REASON_CODES.NOT_FOUND);
  }

  const repository = resolveRepository();
  const record = loadPaymentRecord(repository, id);
  if (!record) {
    return fail(PAYMENT_LIFECYCLE_REASON_CODES.NOT_FOUND);
  }

  const source = isPlainObject(options) ? options : {};
  const context = resolveContext(source.context, DEFAULT_SUMMARY_CONTEXT);

  return {
    ok: true,
    summary: toSummaryModel(record, context),
    safeReasonCode: PAYMENT_LIFECYCLE_REASON_CODES.SUMMARY_RESOLVED,
  };
}

/**
 * Publishes a local payment change to all registered listeners, never throwing
 * on a listener fault.
 * @param {{ paymentId?: string, status?: string, safeReasonCode?: string }} [change]
 *   The change snapshot to broadcast.
 * @returns {void}
 */
export function publishLocalPaymentChange(change) {
  const source = isPlainObject(change) ? change : {};
  const snapshot = {
    paymentId: toText(source.paymentId) || null,
    status: toText(source.status) || null,
    safeReasonCode: toText(source.safeReasonCode) || null,
  };
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {
      safeLogger.error('paymentLifecycleFacade: listener threw during publish', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}

/**
 * Registers a local payment change listener and returns an unsubscribe
 * function.
 *
 * The listener is invoked with a `{ paymentId, status, safeReasonCode }`
 * snapshot whenever a local payment change is published. It is not invoked
 * immediately; call {@link getPaymentDetail} or {@link getMaskedPaymentSummary}
 * for the current value.
 *
 * @param {(snapshot: {
 *   paymentId: string | null,
 *   status: string | null,
 *   safeReasonCode: string | null,
 * }) => void} listener - The change listener.
 * @returns {() => void} An unsubscribe function.
 */
export function subscribeToLocalPaymentChanges(listener) {
  if (typeof listener !== 'function') {
    safeLogger.warn(
      'paymentLifecycleFacade: subscribeToLocalPaymentChanges called without a function listener',
    );
    return () => {};
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The payment lifecycle facade contract, exposed as a single frozen object.
 * @type {{
 *   getPaymentDetail: typeof getPaymentDetail,
 *   getMaskedPaymentSummary: typeof getMaskedPaymentSummary,
 *   subscribeToLocalPaymentChanges: typeof subscribeToLocalPaymentChanges,
 *   publishLocalPaymentChange: typeof publishLocalPaymentChange,
 *   configurePaymentLifecycleFacade: typeof configurePaymentLifecycleFacade,
 *   PAYMENT_LIFECYCLE_REASON_CODES: typeof PAYMENT_LIFECYCLE_REASON_CODES,
 * }}
 */
export const paymentLifecycleFacade = Object.freeze({
  getPaymentDetail,
  getMaskedPaymentSummary,
  subscribeToLocalPaymentChanges,
  publishLocalPaymentChange,
  configurePaymentLifecycleFacade,
  PAYMENT_LIFECYCLE_REASON_CODES,
});

export default paymentLifecycleFacade;