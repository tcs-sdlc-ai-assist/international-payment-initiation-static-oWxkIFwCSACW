/**
 * Clear-all-demo-data service.
 *
 * DemoDataService is the single entry point used to reset the demo back to a
 * clean baseline (SCRUM-827). It clears every application-prefixed storage key
 * across both the session and local scopes — sessions, signer overlays, change
 * requests, operation ledgers, audit history, and every payment domain — then
 * resets the in-memory providers that cache repositories/ledgers so subsequent
 * reads re-provision cleanly against the (now empty) overlays and reload the
 * baseline fixtures.
 *
 * The service is intentionally conservative and demo-only:
 *
 *   - It enumerates ONLY namespaced, adapter-managed keys via
 *     {@link StorageAdapter.clearNamespace}; it NEVER calls
 *     `Storage.clear()`, so keys outside the app's namespace are untouched.
 *   - Each removal is isolated so a single storage fault can never abort the
 *     whole reset.
 *   - It records a sanitized audit event for the reset and returns a
 *     discriminated `{ ok, ... }` result carrying a sanitized safe reason code
 *     so callers can gate the UI safely. No method throws for expected
 *     failures.
 *
 * After a clear, the baseline fixtures remain the source of truth: overlays are
 * removed, so the {@link SignerRepository} baseline + overlay merge naturally
 * yields the pristine fixture dataset again.
 */

import { STORAGE_DOMAINS } from '@/shared/config/constants';
import {
  createSessionStorageAdapter,
  createLocalStorageAdapter,
} from '@/shared/storage/storageAdapter';
import { configureSignerService } from '@/features/access/services/signerService';
import { configureSessionFacade } from '@/features/access/services/sessionFacade';
import { auditFacade } from '@/features/access/data/auditFacade';
import { safeLogger } from '@/shared/logging/safeLogger';

/**
 * Safe reason codes surfaced by the demo data service.
 * @type {{
 *   CLEARED: 'demo.data.cleared',
 *   UNEXPECTED: 'demo.data.unexpected',
 * }}
 */
export const DEMO_DATA_REASON_CODES = Object.freeze({
  CLEARED: 'demo.data.cleared',
  UNEXPECTED: 'demo.data.unexpected',
});

/**
 * Audit event types emitted by the demo data service.
 * @type {{
 *   CLEARED: 'demo.data.cleared',
 *   CLEAR_FAILED: 'demo.data.clear_failed',
 * }}
 */
export const DEMO_DATA_AUDIT_EVENTS = Object.freeze({
  CLEARED: 'demo.data.cleared',
  CLEAR_FAILED: 'demo.data.clear_failed',
});

/**
 * The complete set of application-managed storage domains cleared on reset.
 * @type {readonly string[]}
 */
const MANAGED_DOMAINS = Object.freeze([
  STORAGE_DOMAINS.ACCESS.SESSION,
  STORAGE_DOMAINS.ACCESS.SIGNER_OVERRIDES,
  STORAGE_DOMAINS.ACCESS.CHANGE_REQUESTS,
  STORAGE_DOMAINS.ACCESS.OPERATIONS,
  STORAGE_DOMAINS.ACCESS.AUDIT,
  STORAGE_DOMAINS.PAYMENT.DRAFTS,
  STORAGE_DOMAINS.PAYMENT.RECORDS,
  STORAGE_DOMAINS.PAYMENT.RESERVATIONS,
  STORAGE_DOMAINS.PAYMENT.SCENARIO_OVERRIDES,
]);

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
 * Removes a single domain key from an adapter, isolating storage faults.
 * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
 *   The storage adapter owning the domain.
 * @param {string} domain - The domain suffix to remove.
 * @returns {boolean} `true` when the removal succeeded.
 */
function removeDomain(adapter, domain) {
  try {
    return adapter.remove(domain);
  } catch (error) {
    safeLogger.warn('demoDataService: failed to remove domain key', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return false;
  }
}

/**
 * Clears every application-managed key owned by an adapter, first removing each
 * known domain explicitly and then sweeping any remaining namespaced keys.
 * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
 *   The storage adapter to clear.
 * @returns {number} The number of keys removed during the namespace sweep.
 */
function clearAdapter(adapter) {
  for (const domain of MANAGED_DOMAINS) {
    removeDomain(adapter, domain);
  }
  try {
    return adapter.clearNamespace();
  } catch (error) {
    safeLogger.warn('demoDataService: namespace clear failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return 0;
  }
}

/**
 * Resets the cached in-memory providers so subsequent reads re-provision
 * cleanly against the freshly-cleared storage and reload baseline fixtures.
 * @returns {void}
 */
function resetProviders() {
  try {
    configureSignerService({ repository: null, ledger: null });
  } catch (error) {
    safeLogger.warn('demoDataService: failed to reset signer service providers', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
  try {
    configureSessionFacade(null);
  } catch (error) {
    safeLogger.warn('demoDataService: failed to reset session facade provider', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * Records a sanitized audit event for the reset, never throwing on failure.
 * @param {string} eventType - The audit event type.
 * @param {{
 *   actorId?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, unknown>,
 * }} entry - The audit entry fields.
 * @returns {void}
 */
function audit(eventType, entry) {
  const source = isPlainObject(entry) ? entry : {};
  const event = { eventType };
  if (source.actorId !== undefined) {
    event.actorId = source.actorId;
  }
  if (source.safeReasonCode !== undefined) {
    event.safeReasonCode = source.safeReasonCode;
  }
  if (isPlainObject(source.metadata)) {
    event.metadata = source.metadata;
  }
  auditFacade.append(event);
}

/**
 * Clears all demo data back to a clean baseline.
 *
 * Enumerates and removes only application-prefixed keys across the session and
 * local storage scopes (sessions, signer overlays, change requests, operations,
 * audit, and payment domains), resets the in-memory providers so baseline
 * fixtures are reloaded, and records a sanitized audit event for the reset.
 *
 * Never calls `Storage.clear()` — removal is always scoped to the app's own
 * namespaced keys. No expected failure throws; the result is discriminated so
 * callers can gate the UI safely.
 *
 * @param {Record<string, unknown> | null | undefined} [session] - The acting session,
 *   used only to attribute the audit event.
 * @returns {{ ok: boolean, removed: number, safeReasonCode: string }} A discriminated result.
 */
export function clear(session) {
  const actorId = resolveActorId(session);

  let localAdapter;
  let sessionAdapter;
  try {
    localAdapter = createLocalStorageAdapter();
    sessionAdapter = createSessionStorageAdapter();
  } catch (error) {
    safeLogger.error('demoDataService: failed to provision storage adapters', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    resetProviders();
    audit(DEMO_DATA_AUDIT_EVENTS.CLEAR_FAILED, {
      actorId,
      safeReasonCode: DEMO_DATA_REASON_CODES.UNEXPECTED,
    });
    return { ok: false, removed: 0, safeReasonCode: DEMO_DATA_REASON_CODES.UNEXPECTED };
  }

  let removed = 0;
  try {
    removed += clearAdapter(localAdapter);
    removed += clearAdapter(sessionAdapter);
  } catch (error) {
    safeLogger.error('demoDataService: unexpected error clearing demo data', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    resetProviders();
    return { ok: false, removed, safeReasonCode: DEMO_DATA_REASON_CODES.UNEXPECTED };
  }

  resetProviders();

  audit(DEMO_DATA_AUDIT_EVENTS.CLEARED, {
    actorId,
    safeReasonCode: DEMO_DATA_REASON_CODES.CLEARED,
    metadata: { removed },
  });

  return { ok: true, removed, safeReasonCode: DEMO_DATA_REASON_CODES.CLEARED };
}

/**
 * The demo data service contract, exposed as a single frozen object.
 * @type {{
 *   clear: typeof clear,
 *   DEMO_DATA_REASON_CODES: typeof DEMO_DATA_REASON_CODES,
 *   DEMO_DATA_AUDIT_EVENTS: typeof DEMO_DATA_AUDIT_EVENTS,
 * }}
 */
export const demoDataService = Object.freeze({
  clear,
  DEMO_DATA_REASON_CODES,
  DEMO_DATA_AUDIT_EVENTS,
});

export default demoDataService;