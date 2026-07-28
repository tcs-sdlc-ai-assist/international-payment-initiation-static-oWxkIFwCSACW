/**
 * Payment audit event factory (cross-cluster contract).
 *
 * PaymentAuditEventFactory is the single builder both clusters use to construct
 * sanitized, masked {@link AuditEventV1}-shaped payment audit events before they
 * are appended via the {@link auditFacade}. It supports the payment initiation
 * and processing flows (SCRUM-814/815/816/818/819):
 *
 *   - `createQuoteAuditEvent(details)` records an FX quote selection/refresh.
 *   - `createValidationAuditEvent(details)` records a beneficiary/CBPR validation
 *     outcome.
 *   - `createSubmissionAuditEvent(details)` records a payment submission attempt.
 *   - `createApprovalAuditEvent(details)` records an approval/eSign outcome.
 *   - `createStatusAuditEvent(details)` records a lifecycle/processing status
 *     transition.
 *
 * Every builder produces a `{ eventType, ... }` object carrying only sanitized
 * identifiers, safe reason codes, and masked metadata — never PII. Free-form
 * metadata is masked via the shared {@link maskingPolicy} before it is attached,
 * and only safe primitives are retained. All builders are pure with respect to
 * their arguments (they never mutate the caller's object, never touch storage,
 * and never throw for malformed input) — malformed input degrades to a
 * structurally-valid, minimal event so callers can always append safely.
 *
 * This is a demo-only, non-regulatory audit contract: the produced events are
 * sanitized and masked and carry no server guarantee.
 */

import { maskingPolicy } from '@/shared/privacy/maskingPolicy';
import { auditFacade } from '@/features/access/data/auditFacade';

/** Masking context applied to any free-form metadata attached to an event. */
const AUDIT_MASKING_CONTEXT = maskingPolicy.MASKING_CONTEXTS.AUDIT;

/** Maximum number of metadata keys retained after sanitization. */
const MAX_METADATA_KEYS = 12;

/** Maximum retained length of a sanitized string metadata value. */
const MAX_METADATA_VALUE_LENGTH = 64;

/**
 * Audit event types emitted by the payment audit event factory.
 * @type {{
 *   QUOTE: 'payment.quote',
 *   VALIDATION: 'payment.validation',
 *   SUBMISSION: 'payment.submission',
 *   APPROVAL: 'payment.approval',
 *   STATUS: 'payment.status',
 * }}
 */
export const PAYMENT_AUDIT_EVENTS = Object.freeze({
  QUOTE: 'payment.quote',
  VALIDATION: 'payment.validation',
  SUBMISSION: 'payment.submission',
  APPROVAL: 'payment.approval',
  STATUS: 'payment.status',
});

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
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Sanitizes an arbitrary metadata object into a bounded record of safe
 * primitives, masking any known PII fields so nothing sensitive leaks into an
 * audit event.
 * @param {unknown} metadata - The raw metadata.
 * @returns {Record<string, string | number | boolean> | undefined} Safe metadata.
 */
function sanitizeMetadata(metadata) {
  if (!isPlainObject(metadata)) {
    return undefined;
  }
  const masked = maskingPolicy.sanitizeObject(metadata, AUDIT_MASKING_CONTEXT);
  if (!isPlainObject(masked)) {
    return undefined;
  }
  const output = {};
  let count = 0;
  for (const key of Object.keys(masked)) {
    if (count >= MAX_METADATA_KEYS) {
      break;
    }
    const value = masked[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        continue;
      }
      output[key] =
        trimmed.length > MAX_METADATA_VALUE_LENGTH
          ? `${trimmed.slice(0, MAX_METADATA_VALUE_LENGTH)}…`
          : trimmed;
      count += 1;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      output[key] = value;
      count += 1;
    } else if (typeof value === 'boolean') {
      output[key] = value;
      count += 1;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

/**
 * Builds a base audit event object from common event details, attaching only
 * the sanitized fields that are present.
 * @param {string} eventType - The audit event type.
 * @param {{
 *   actorId?: string,
 *   subjectId?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, unknown>,
 * }} details - The common event details.
 * @param {Record<string, unknown>} [extraMetadata] - Additional metadata to merge.
 * @returns {{
 *   eventType: string,
 *   actorId?: string,
 *   subjectId?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, string | number | boolean>,
 * }} A sanitized audit event.
 */
function buildEvent(eventType, details, extraMetadata) {
  const source = isPlainObject(details) ? details : {};
  const event = { eventType };

  const actorId = toText(source.actorId);
  if (actorId.length > 0) {
    event.actorId = actorId;
  }

  const subjectId = toText(source.subjectId);
  if (subjectId.length > 0) {
    event.subjectId = subjectId;
  }

  const safeReasonCode = toText(source.safeReasonCode);
  if (safeReasonCode.length > 0) {
    event.safeReasonCode = safeReasonCode;
  }

  const mergedMetadata = {};
  if (isPlainObject(extraMetadata)) {
    for (const key of Object.keys(extraMetadata)) {
      const value = extraMetadata[key];
      if (value !== undefined && value !== null) {
        mergedMetadata[key] = value;
      }
    }
  }
  if (isPlainObject(source.metadata)) {
    for (const key of Object.keys(source.metadata)) {
      const value = source.metadata[key];
      if (value !== undefined && value !== null && !(key in mergedMetadata)) {
        mergedMetadata[key] = value;
      }
    }
  }

  const sanitizedMetadata = sanitizeMetadata(mergedMetadata);
  if (sanitizedMetadata !== undefined) {
    event.metadata = sanitizedMetadata;
  }

  return event;
}

/**
 * Builds a masked audit event for an FX quote selection or refresh (SCRUM-816).
 *
 * Never mutates its arguments and never throws — malformed input degrades to a
 * minimal, structurally-valid event.
 *
 * @param {{
 *   actorId?: string,
 *   subjectId?: string,
 *   quoteRef?: string,
 *   pairId?: string,
 *   classification?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, unknown>,
 * }} [details] - The quote event details.
 * @returns {{
 *   eventType: string,
 *   actorId?: string,
 *   subjectId?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, string | number | boolean>,
 * }} A sanitized quote audit event.
 */
export function createQuoteAuditEvent(details) {
  const source = isPlainObject(details) ? details : {};
  return buildEvent(PAYMENT_AUDIT_EVENTS.QUOTE, source, {
    quoteRef: toText(source.quoteRef) || undefined,
    pairId: toText(source.pairId) || undefined,
    classification: toText(source.classification) || undefined,
  });
}

/**
 * Builds a masked audit event for a beneficiary/CBPR validation outcome
 * (SCRUM-815).
 *
 * Never mutates its arguments and never throws — malformed input degrades to a
 * minimal, structurally-valid event.
 *
 * @param {{
 *   actorId?: string,
 *   subjectId?: string,
 *   outcome?: string,
 *   verificationStatus?: string,
 *   blocking?: boolean,
 *   requiresConfirmation?: boolean,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, unknown>,
 * }} [details] - The validation event details.
 * @returns {{
 *   eventType: string,
 *   actorId?: string,
 *   subjectId?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, string | number | boolean>,
 * }} A sanitized validation audit event.
 */
export function createValidationAuditEvent(details) {
  const source = isPlainObject(details) ? details : {};
  return buildEvent(PAYMENT_AUDIT_EVENTS.VALIDATION, source, {
    outcome: toText(source.outcome) || undefined,
    verificationStatus: toText(source.verificationStatus) || undefined,
    blocking: typeof source.blocking === 'boolean' ? source.blocking : undefined,
    requiresConfirmation:
      typeof source.requiresConfirmation === 'boolean' ? source.requiresConfirmation : undefined,
  });
}

/**
 * Builds a masked audit event for a payment submission attempt (SCRUM-814).
 *
 * Never mutates its arguments and never throws — malformed input degrades to a
 * minimal, structurally-valid event.
 *
 * @param {{
 *   actorId?: string,
 *   subjectId?: string,
 *   paymentId?: string,
 *   paymentReference?: string,
 *   pairId?: string,
 *   duplicate?: boolean,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, unknown>,
 * }} [details] - The submission event details.
 * @returns {{
 *   eventType: string,
 *   actorId?: string,
 *   subjectId?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, string | number | boolean>,
 * }} A sanitized submission audit event.
 */
export function createSubmissionAuditEvent(details) {
  const source = isPlainObject(details) ? details : {};
  const subjectId = toText(source.subjectId) || toText(source.paymentId);
  return buildEvent(
    PAYMENT_AUDIT_EVENTS.SUBMISSION,
    { ...source, subjectId },
    {
      paymentId: toText(source.paymentId) || undefined,
      paymentReference: toText(source.paymentReference) || undefined,
      pairId: toText(source.pairId) || undefined,
      duplicate: typeof source.duplicate === 'boolean' ? source.duplicate : undefined,
    },
  );
}

/**
 * Builds a masked audit event for an approval/eSign outcome (SCRUM-818).
 *
 * Never mutates its arguments and never throws — malformed input degrades to a
 * minimal, structurally-valid event.
 *
 * @param {{
 *   actorId?: string,
 *   subjectId?: string,
 *   paymentId?: string,
 *   outcome?: string,
 *   approved?: boolean,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, unknown>,
 * }} [details] - The approval event details.
 * @returns {{
 *   eventType: string,
 *   actorId?: string,
 *   subjectId?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, string | number | boolean>,
 * }} A sanitized approval audit event.
 */
export function createApprovalAuditEvent(details) {
  const source = isPlainObject(details) ? details : {};
  const subjectId = toText(source.subjectId) || toText(source.paymentId);
  return buildEvent(
    PAYMENT_AUDIT_EVENTS.APPROVAL,
    { ...source, subjectId },
    {
      paymentId: toText(source.paymentId) || undefined,
      outcome: toText(source.outcome) || undefined,
      approved: typeof source.approved === 'boolean' ? source.approved : undefined,
    },
  );
}

/**
 * Builds a masked audit event for a lifecycle/processing status transition
 * (SCRUM-819).
 *
 * Never mutates its arguments and never throws — malformed input degrades to a
 * minimal, structurally-valid event.
 *
 * @param {{
 *   actorId?: string,
 *   subjectId?: string,
 *   paymentId?: string,
 *   fromState?: string,
 *   toState?: string,
 *   action?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, unknown>,
 * }} [details] - The status event details.
 * @returns {{
 *   eventType: string,
 *   actorId?: string,
 *   subjectId?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, string | number | boolean>,
 * }} A sanitized status audit event.
 */
export function createStatusAuditEvent(details) {
  const source = isPlainObject(details) ? details : {};
  const subjectId = toText(source.subjectId) || toText(source.paymentId);
  return buildEvent(
    PAYMENT_AUDIT_EVENTS.STATUS,
    { ...source, subjectId },
    {
      paymentId: toText(source.paymentId) || undefined,
      fromState: toText(source.fromState) || undefined,
      toState: toText(source.toState) || undefined,
      action: toText(source.action) || undefined,
    },
  );
}

/**
 * Records a pre-built payment audit event via the {@link auditFacade}. The event
 * is appended as-is (the underlying repository re-masks metadata and generates
 * identifiers/timestamps). Never throws for expected failures.
 * @param {{ eventType: string }} event - A sanitized payment audit event.
 * @returns {import('@/shared/schemas/schemas').AuditEventV1 | undefined}
 *   The appended event, or `undefined` when it could not be recorded.
 */
export function recordPaymentAuditEvent(event) {
  if (!isPlainObject(event) || toText(event.eventType).length === 0) {
    return undefined;
  }
  return auditFacade.append(event);
}

/**
 * The payment audit event factory contract, exposed as a single frozen object.
 * @type {{
 *   createQuoteAuditEvent: typeof createQuoteAuditEvent,
 *   createValidationAuditEvent: typeof createValidationAuditEvent,
 *   createSubmissionAuditEvent: typeof createSubmissionAuditEvent,
 *   createApprovalAuditEvent: typeof createApprovalAuditEvent,
 *   createStatusAuditEvent: typeof createStatusAuditEvent,
 *   recordPaymentAuditEvent: typeof recordPaymentAuditEvent,
 *   PAYMENT_AUDIT_EVENTS: typeof PAYMENT_AUDIT_EVENTS,
 * }}
 */
export const paymentAuditEventFactory = Object.freeze({
  createQuoteAuditEvent,
  createValidationAuditEvent,
  createSubmissionAuditEvent,
  createApprovalAuditEvent,
  createStatusAuditEvent,
  recordPaymentAuditEvent,
  PAYMENT_AUDIT_EVENTS,
});

export default paymentAuditEventFactory;