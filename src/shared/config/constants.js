/**
 * Central application constants and storage domain keys.
 *
 * These values are shared across the intl-payment-initiation app to keep
 * storage namespacing, session policy, capabilities, and role identifiers
 * consistent in one place.
 */

/** Namespace prefix applied to all persisted storage keys. */
export const STORAGE_NAMESPACE = 'ipi-demo';

/** Global storage schema version. */
export const STORAGE_VERSION = 'v1';

/**
 * Reference date used for deterministic date calculations and fixtures.
 * Falls back to a fixed ISO date when the env var is not provided.
 */
export const REFERENCE_DATE = import.meta.env.VITE_REFERENCE_DATE ?? '2026-07-28';

/** Number of days demo data is retained before being considered stale. */
export const RETENTION_DAYS = 30;

/** Minutes of inactivity before a session is automatically terminated. */
export const SESSION_TIMEOUT_MINUTES = 15;

/** Minutes before timeout when the user is warned about session expiry. */
export const SESSION_WARNING_MINUTES = 2;

/** Maximum number of resend actions allowed within a rolling 24-hour window. */
export const MAX_RESENDS_24H = 3;

/**
 * Capability identifiers used for authorization checks.
 * @type {{
 *   PAYMENT_INITIATE: 'payment:initiate',
 *   PAYMENT_APPROVE: 'payment:approve',
 *   PAYMENT_OPERATE: 'payment:operate',
 *   SIGNER_READ: 'signer.read',
 *   SIGNER_MANAGE: 'signer.manage',
 * }}
 */
export const CAPABILITIES = Object.freeze({
  PAYMENT_INITIATE: 'payment:initiate',
  PAYMENT_APPROVE: 'payment:approve',
  PAYMENT_OPERATE: 'payment:operate',
  SIGNER_READ: 'signer.read',
  SIGNER_MANAGE: 'signer.manage',
});

/**
 * Role identifiers used to associate users with capabilities.
 * @type {{
 *   INITIATOR: 'initiator',
 *   APPROVER: 'approver',
 *   OPERATOR: 'operator',
 *   SIGNER_ADMIN: 'signer-admin',
 *   AUDITOR: 'auditor',
 * }}
 */
export const ROLES = Object.freeze({
  INITIATOR: 'initiator',
  APPROVER: 'approver',
  OPERATOR: 'operator',
  SIGNER_ADMIN: 'signer-admin',
  AUDITOR: 'auditor',
});

/**
 * Storage domain keys grouped by feature area. Each value is a stable,
 * versioned suffix appended to the storage namespace when persisting data.
 * @type {{
 *   ACCESS: {
 *     SESSION: 'access.session.v1',
 *     SIGNER_OVERRIDES: 'access.signerOverrides.v2',
 *     CHANGE_REQUESTS: 'access.changeRequests.v2',
 *     OPERATIONS: 'access.operations.v1',
 *     AUDIT: 'access.audit.v2',
 *   },
 *   PAYMENT: {
 *     DRAFTS: 'payment.drafts.v1',
 *     RECORDS: 'payment.records.v1',
 *     RESERVATIONS: 'payment.reservations.v1',
 *     SCENARIO_OVERRIDES: 'payment.scenarioOverrides.v1',
 *   },
 * }}
 */
export const STORAGE_DOMAINS = Object.freeze({
  ACCESS: Object.freeze({
    SESSION: 'access.session.v1',
    SIGNER_OVERRIDES: 'access.signerOverrides.v2',
    CHANGE_REQUESTS: 'access.changeRequests.v2',
    OPERATIONS: 'access.operations.v1',
    AUDIT: 'access.audit.v2',
  }),
  PAYMENT: Object.freeze({
    DRAFTS: 'payment.drafts.v1',
    RECORDS: 'payment.records.v1',
    RESERVATIONS: 'payment.reservations.v1',
    SCENARIO_OVERRIDES: 'payment.scenarioOverrides.v1',
  }),
});

/**
 * Builds a fully-qualified storage key from a domain suffix.
 * @param {string} domainKey - A value from {@link STORAGE_DOMAINS}.
 * @returns {string} The namespaced storage key.
 */
export function buildStorageKey(domainKey) {
  return `${STORAGE_NAMESPACE}:${domainKey}`;
}