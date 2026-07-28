/**
 * Typed payment domain error.
 *
 * PaymentDomainError is the single typed error surface for the payment cluster.
 * It maps internal failure conditions to sanitized, stable safe reason codes and
 * demo-safe customer copy so the UI can gate and message consistently without
 * ever leaking raw domain detail, PII, or stack internals. It supports the
 * payment initiation flow (SCRUM-821):
 *
 *   - Each error carries a discriminated `kind` (validation, unavailable
 *     scenario, transient failure, storage degradation, duplicate reference,
 *     unauthorized), a sanitized `safeReasonCode`, whether the condition is
 *     `retryable`, and safe `customerCopy` (title + body).
 *   - Static factory helpers (`validation`, `unavailableScenario`, `transient`,
 *     `storageDegraded`, `duplicateReference`, `unauthorized`, `unexpected`)
 *     build a fully-populated instance for each condition.
 *   - `toSafeObject()` produces a sanitized, serialization-safe snapshot suitable
 *     for logging or returning to callers; it never carries raw metadata beyond
 *     safe primitives.
 *
 * The class is intentionally conservative and demo-only: it degrades unknown
 * input to an "unexpected" error rather than throwing, and every code and copy
 * value is sanitized and safe to display. It carries no server guarantee.
 */

import { safeLogger } from '@/shared/logging/safeLogger';

/**
 * Discriminated payment domain error kinds.
 * @type {{
 *   VALIDATION: 'validation',
 *   UNAVAILABLE_SCENARIO: 'unavailable_scenario',
 *   TRANSIENT: 'transient',
 *   STORAGE_DEGRADED: 'storage_degraded',
 *   DUPLICATE_REFERENCE: 'duplicate_reference',
 *   UNAUTHORIZED: 'unauthorized',
 *   UNEXPECTED: 'unexpected',
 * }}
 */
export const PAYMENT_ERROR_KINDS = Object.freeze({
  VALIDATION: 'validation',
  UNAVAILABLE_SCENARIO: 'unavailable_scenario',
  TRANSIENT: 'transient',
  STORAGE_DEGRADED: 'storage_degraded',
  DUPLICATE_REFERENCE: 'duplicate_reference',
  UNAUTHORIZED: 'unauthorized',
  UNEXPECTED: 'unexpected',
});

/**
 * Default safe reason codes surfaced per error kind.
 * @type {{
 *   VALIDATION: 'payment.error.validation',
 *   UNAVAILABLE_SCENARIO: 'payment.error.unavailable_scenario',
 *   TRANSIENT: 'payment.error.transient',
 *   STORAGE_DEGRADED: 'payment.error.storage_degraded',
 *   DUPLICATE_REFERENCE: 'payment.error.duplicate_reference',
 *   UNAUTHORIZED: 'payment.error.unauthorized',
 *   UNEXPECTED: 'payment.error.unexpected',
 * }}
 */
export const PAYMENT_ERROR_REASON_CODES = Object.freeze({
  VALIDATION: 'payment.error.validation',
  UNAVAILABLE_SCENARIO: 'payment.error.unavailable_scenario',
  TRANSIENT: 'payment.error.transient',
  STORAGE_DEGRADED: 'payment.error.storage_degraded',
  DUPLICATE_REFERENCE: 'payment.error.duplicate_reference',
  UNAUTHORIZED: 'payment.error.unauthorized',
  UNEXPECTED: 'payment.error.unexpected',
});

/** Matches a safe, sanitized reason code identifier. */
const SAFE_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Maximum retained length of a sanitized copy string. */
const MAX_COPY_LENGTH = 280;

/**
 * Default customer copy applied per error kind. Copy is demo-safe and never
 * carries raw domain detail or PII.
 * @type {Record<string, { title: string, body: string }>}
 */
const DEFAULT_COPY = Object.freeze({
  [PAYMENT_ERROR_KINDS.VALIDATION]: {
    title: 'Check the payment details',
    body: 'Some of the payment details could not be validated. Review the highlighted fields and try again.',
  },
  [PAYMENT_ERROR_KINDS.UNAVAILABLE_SCENARIO]: {
    title: 'Not available right now',
    body: 'This action is temporarily unavailable in the demo. Wait a moment and try again.',
  },
  [PAYMENT_ERROR_KINDS.TRANSIENT]: {
    title: 'Something went wrong',
    body: 'A transient error interrupted this action. No changes were saved — please try again.',
  },
  [PAYMENT_ERROR_KINDS.STORAGE_DEGRADED]: {
    title: 'Changes may not be saved',
    body: 'Browser storage is unavailable, so this demo is running from temporary data. Your changes will not persist across reloads.',
  },
  [PAYMENT_ERROR_KINDS.DUPLICATE_REFERENCE]: {
    title: 'This payment was already handled',
    body: 'A payment with this reference has already been recorded. No duplicate was created.',
  },
  [PAYMENT_ERROR_KINDS.UNAUTHORIZED]: {
    title: 'Access denied',
    body: 'Your current role does not hold the capability required for this action. Switch to a role that grants it and try again.',
  },
  [PAYMENT_ERROR_KINDS.UNEXPECTED]: {
    title: 'Something went wrong',
    body: 'An unexpected error interrupted this action. No changes were saved — please try again.',
  },
});

/**
 * Retryability defaults applied per error kind.
 * @type {Record<string, boolean>}
 */
const DEFAULT_RETRYABLE = Object.freeze({
  [PAYMENT_ERROR_KINDS.VALIDATION]: false,
  [PAYMENT_ERROR_KINDS.UNAVAILABLE_SCENARIO]: true,
  [PAYMENT_ERROR_KINDS.TRANSIENT]: true,
  [PAYMENT_ERROR_KINDS.STORAGE_DEGRADED]: true,
  [PAYMENT_ERROR_KINDS.DUPLICATE_REFERENCE]: false,
  [PAYMENT_ERROR_KINDS.UNAUTHORIZED]: false,
  [PAYMENT_ERROR_KINDS.UNEXPECTED]: true,
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
 * Resolves a supported error kind, falling back to `unexpected`.
 * @param {unknown} kind - The candidate error kind.
 * @returns {string} A valid kind from {@link PAYMENT_ERROR_KINDS}.
 */
function resolveKind(kind) {
  const values = Object.values(PAYMENT_ERROR_KINDS);
  return typeof kind === 'string' && values.includes(kind) ? kind : PAYMENT_ERROR_KINDS.UNEXPECTED;
}

/**
 * Resolves the default safe reason code for a given kind.
 * @param {string} kind - A valid error kind.
 * @returns {string} The default safe reason code for the kind.
 */
function defaultReasonCodeForKind(kind) {
  switch (kind) {
    case PAYMENT_ERROR_KINDS.VALIDATION:
      return PAYMENT_ERROR_REASON_CODES.VALIDATION;
    case PAYMENT_ERROR_KINDS.UNAVAILABLE_SCENARIO:
      return PAYMENT_ERROR_REASON_CODES.UNAVAILABLE_SCENARIO;
    case PAYMENT_ERROR_KINDS.TRANSIENT:
      return PAYMENT_ERROR_REASON_CODES.TRANSIENT;
    case PAYMENT_ERROR_KINDS.STORAGE_DEGRADED:
      return PAYMENT_ERROR_REASON_CODES.STORAGE_DEGRADED;
    case PAYMENT_ERROR_KINDS.DUPLICATE_REFERENCE:
      return PAYMENT_ERROR_REASON_CODES.DUPLICATE_REFERENCE;
    case PAYMENT_ERROR_KINDS.UNAUTHORIZED:
      return PAYMENT_ERROR_REASON_CODES.UNAUTHORIZED;
    case PAYMENT_ERROR_KINDS.UNEXPECTED:
    default:
      return PAYMENT_ERROR_REASON_CODES.UNEXPECTED;
  }
}

/**
 * Resolves a sanitized safe reason code, falling back to the kind default.
 * @param {unknown} safeReasonCode - The candidate reason code.
 * @param {string} kind - A valid error kind.
 * @returns {string} A sanitized safe reason code.
 */
function resolveReasonCode(safeReasonCode, kind) {
  if (typeof safeReasonCode === 'string') {
    const trimmed = safeReasonCode.trim();
    if (SAFE_CODE_PATTERN.test(trimmed)) {
      return trimmed;
    }
  }
  return defaultReasonCodeForKind(kind);
}

/**
 * Normalizes an arbitrary value into a trimmed, length-bounded copy string.
 * @param {unknown} value - The raw copy value.
 * @param {string} fallback - The value returned when `value` is unusable.
 * @returns {string} A sanitized copy string.
 */
function resolveCopyText(value, fallback) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed.length > MAX_COPY_LENGTH ? `${trimmed.slice(0, MAX_COPY_LENGTH)}…` : trimmed;
    }
  }
  return fallback;
}

/**
 * Resolves sanitized customer copy for an error, merging overrides over the
 * per-kind defaults.
 * @param {string} kind - A valid error kind.
 * @param {unknown} customerCopy - The candidate copy override.
 * @returns {{ title: string, body: string }} Sanitized customer copy.
 */
function resolveCustomerCopy(kind, customerCopy) {
  const fallback = DEFAULT_COPY[kind] ?? DEFAULT_COPY[PAYMENT_ERROR_KINDS.UNEXPECTED];
  const source = isPlainObject(customerCopy) ? customerCopy : {};
  return {
    title: resolveCopyText(source.title, fallback.title),
    body: resolveCopyText(source.body, fallback.body),
  };
}

/**
 * Resolves an effective retryability flag, falling back to the kind default.
 * @param {unknown} retryable - The candidate retryability flag.
 * @param {string} kind - A valid error kind.
 * @returns {boolean} The resolved retryability flag.
 */
function resolveRetryable(retryable, kind) {
  if (typeof retryable === 'boolean') {
    return retryable;
  }
  return DEFAULT_RETRYABLE[kind] ?? false;
}

/**
 * Sanitizes an arbitrary metadata object into a bounded record of safe
 * primitives so no PII or nested structure leaks into an error.
 * @param {unknown} metadata - The raw metadata.
 * @returns {Record<string, string | number | boolean>} Safe metadata.
 */
function sanitizeMetadata(metadata) {
  if (!isPlainObject(metadata)) {
    return {};
  }
  const output = {};
  let count = 0;
  for (const key of Object.keys(metadata)) {
    if (count >= 12) {
      break;
    }
    const value = metadata[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      output[key] = trimmed.length > 64 ? `${trimmed.slice(0, 64)}…` : trimmed;
      count += 1;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      output[key] = value;
      count += 1;
    } else if (typeof value === 'boolean') {
      output[key] = value;
      count += 1;
    }
  }
  return output;
}

/**
 * A typed payment domain error mapping internal conditions to sanitized safe
 * reason codes and demo-safe customer copy.
 */
export class PaymentDomainError extends Error {
  /**
   * @param {{
   *   kind?: string,
   *   safeReasonCode?: string,
   *   retryable?: boolean,
   *   message?: string,
   *   customerCopy?: { title?: string, body?: string },
   *   metadata?: Record<string, unknown>,
   * }} [details] - The error details.
   */
  constructor(details) {
    const source = isPlainObject(details) ? details : {};
    const kind = resolveKind(source.kind);
    const safeReasonCode = resolveReasonCode(source.safeReasonCode, kind);
    const customerCopy = resolveCustomerCopy(kind, source.customerCopy);
    const message =
      typeof source.message === 'string' && source.message.trim().length > 0
        ? source.message.trim()
        : safeReasonCode;

    super(message);

    /** @type {string} */
    this.name = 'PaymentDomainError';
    /** @type {string} */
    this.kind = kind;
    /** @type {string} */
    this.safeReasonCode = safeReasonCode;
    /** @type {boolean} */
    this.retryable = resolveRetryable(source.retryable, kind);
    /** @type {{ title: string, body: string }} */
    this.customerCopy = customerCopy;
    /** @type {Record<string, string | number | boolean>} */
    this.metadata = sanitizeMetadata(source.metadata);
  }

  /**
   * Produces a sanitized, serialization-safe snapshot of this error suitable
   * for logging or returning to callers. Never carries raw domain detail.
   * @returns {{
   *   name: string,
   *   kind: string,
   *   safeReasonCode: string,
   *   retryable: boolean,
   *   customerCopy: { title: string, body: string },
   *   metadata: Record<string, string | number | boolean>,
   * }} A sanitized error snapshot.
   */
  toSafeObject() {
    return {
      name: this.name,
      kind: this.kind,
      safeReasonCode: this.safeReasonCode,
      retryable: this.retryable,
      customerCopy: { ...this.customerCopy },
      metadata: { ...this.metadata },
    };
  }

  /**
   * Builds a validation error for a rejected payment detail condition.
   * @param {{
   *   safeReasonCode?: string,
   *   message?: string,
   *   customerCopy?: { title?: string, body?: string },
   *   metadata?: Record<string, unknown>,
   * }} [details] - Optional error details.
   * @returns {PaymentDomainError} A validation error.
   */
  static validation(details) {
    const source = isPlainObject(details) ? details : {};
    return new PaymentDomainError({ ...source, kind: PAYMENT_ERROR_KINDS.VALIDATION });
  }

  /**
   * Builds an error for a temporarily unavailable scenario.
   * @param {{
   *   safeReasonCode?: string,
   *   message?: string,
   *   customerCopy?: { title?: string, body?: string },
   *   metadata?: Record<string, unknown>,
   * }} [details] - Optional error details.
   * @returns {PaymentDomainError} An unavailable-scenario error.
   */
  static unavailableScenario(details) {
    const source = isPlainObject(details) ? details : {};
    return new PaymentDomainError({ ...source, kind: PAYMENT_ERROR_KINDS.UNAVAILABLE_SCENARIO });
  }

  /**
   * Builds a transient-failure error that may safely be retried.
   * @param {{
   *   safeReasonCode?: string,
   *   message?: string,
   *   customerCopy?: { title?: string, body?: string },
   *   metadata?: Record<string, unknown>,
   * }} [details] - Optional error details.
   * @returns {PaymentDomainError} A transient error.
   */
  static transient(details) {
    const source = isPlainObject(details) ? details : {};
    return new PaymentDomainError({ ...source, kind: PAYMENT_ERROR_KINDS.TRANSIENT });
  }

  /**
   * Builds a storage-degradation error signalling in-memory-only persistence.
   * @param {{
   *   safeReasonCode?: string,
   *   message?: string,
   *   customerCopy?: { title?: string, body?: string },
   *   metadata?: Record<string, unknown>,
   * }} [details] - Optional error details.
   * @returns {PaymentDomainError} A storage-degradation error.
   */
  static storageDegraded(details) {
    const source = isPlainObject(details) ? details : {};
    return new PaymentDomainError({ ...source, kind: PAYMENT_ERROR_KINDS.STORAGE_DEGRADED });
  }

  /**
   * Builds a duplicate-reference error for an idempotency conflict.
   * @param {{
   *   safeReasonCode?: string,
   *   message?: string,
   *   customerCopy?: { title?: string, body?: string },
   *   metadata?: Record<string, unknown>,
   * }} [details] - Optional error details.
   * @returns {PaymentDomainError} A duplicate-reference error.
   */
  static duplicateReference(details) {
    const source = isPlainObject(details) ? details : {};
    return new PaymentDomainError({ ...source, kind: PAYMENT_ERROR_KINDS.DUPLICATE_REFERENCE });
  }

  /**
   * Builds an unauthorized error for a denied capability check.
   * @param {{
   *   safeReasonCode?: string,
   *   message?: string,
   *   customerCopy?: { title?: string, body?: string },
   *   metadata?: Record<string, unknown>,
   * }} [details] - Optional error details.
   * @returns {PaymentDomainError} An unauthorized error.
   */
  static unauthorized(details) {
    const source = isPlainObject(details) ? details : {};
    return new PaymentDomainError({ ...source, kind: PAYMENT_ERROR_KINDS.UNAUTHORIZED });
  }

  /**
   * Builds an unexpected error for an unclassified failure condition.
   * @param {{
   *   safeReasonCode?: string,
   *   message?: string,
   *   customerCopy?: { title?: string, body?: string },
   *   metadata?: Record<string, unknown>,
   * }} [details] - Optional error details.
   * @returns {PaymentDomainError} An unexpected error.
   */
  static unexpected(details) {
    const source = isPlainObject(details) ? details : {};
    return new PaymentDomainError({ ...source, kind: PAYMENT_ERROR_KINDS.UNEXPECTED });
  }

  /**
   * Normalizes an arbitrary thrown value into a {@link PaymentDomainError}.
   *
   * Existing {@link PaymentDomainError} instances are returned unchanged; every
   * other value degrades to a sanitized `unexpected` error rather than throwing.
   *
   * @param {unknown} error - The thrown value to normalize.
   * @param {{
   *   safeReasonCode?: string,
   *   customerCopy?: { title?: string, body?: string },
   *   metadata?: Record<string, unknown>,
   * }} [fallback] - Optional fallback details for non-domain errors.
   * @returns {PaymentDomainError} A typed payment domain error.
   */
  static from(error, fallback) {
    if (error instanceof PaymentDomainError) {
      return error;
    }
    const source = isPlainObject(fallback) ? fallback : {};
    safeLogger.warn('paymentDomainError: normalized non-domain error', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return new PaymentDomainError({
      ...source,
      kind: PAYMENT_ERROR_KINDS.UNEXPECTED,
    });
  }
}

/**
 * Determines whether a value is a {@link PaymentDomainError} instance.
 * @param {unknown} value - The candidate value.
 * @returns {boolean} `true` when `value` is a payment domain error.
 */
export function isPaymentDomainError(value) {
  return value instanceof PaymentDomainError;
}

/**
 * The payment domain error contract, exposed as a single frozen object.
 * @type {{
 *   PaymentDomainError: typeof PaymentDomainError,
 *   isPaymentDomainError: typeof isPaymentDomainError,
 *   PAYMENT_ERROR_KINDS: typeof PAYMENT_ERROR_KINDS,
 *   PAYMENT_ERROR_REASON_CODES: typeof PAYMENT_ERROR_REASON_CODES,
 * }}
 */
export const paymentDomainError = Object.freeze({
  PaymentDomainError,
  isPaymentDomainError,
  PAYMENT_ERROR_KINDS,
  PAYMENT_ERROR_REASON_CODES,
});

export default paymentDomainError;