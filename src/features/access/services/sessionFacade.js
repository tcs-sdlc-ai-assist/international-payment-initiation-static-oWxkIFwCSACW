/**
 * Session facade (cross-cluster contract).
 *
 * SessionFacade is the single entry point both clusters (access + payment) use
 * to read, refresh, and terminate the acting demo session. It implements the
 * SessionFacade contract:
 *
 *   - `getSession()` returns the current, non-expired session claim (or `null`).
 *   - `touch()` records throttled last-activity and re-evaluates the session
 *     lifecycle (active → warning → expired).
 *   - `logout(reason)` clears the persisted session and notifies subscribers.
 *   - `subscribe(listener)` registers a change listener (for React) and returns
 *     an unsubscribe function.
 *
 * Only the non-secret {@link SessionClaimV1} is persisted, under a namespaced
 * `access.session.v1` sessionStorage domain via a {@link StorageAdapter}. The
 * passcode-like credential is NEVER persisted, logged, or exposed. Valid
 * sessions are restored at bootstrap; expired ones are purged. Warning and
 * timeout transitions are driven by the deterministic {@link demoClock} and the
 * configured session policy.
 *
 * This is a demo-only, non-regulatory session store: entries live in local
 * browser storage and carry no server guarantee.
 */

import {
  STORAGE_DOMAINS,
  SESSION_TIMEOUT_MINUTES,
  SESSION_WARNING_MINUTES,
} from '@/shared/config/constants';
import {
  StoredRecordEnvelopeSchema,
  SessionClaimV1Schema,
  createStoredRecordEnvelope,
  safeParseWith,
} from '@/shared/schemas/schemas';
import { createSessionStorageAdapter } from '@/shared/storage/storageAdapter';
import { demoClock } from '@/shared/time/demoClock';
import { safeLogger } from '@/shared/logging/safeLogger';
import { z } from 'zod';

/** Storage domain suffix backing the persisted session claim. */
const SESSION_DOMAIN = STORAGE_DOMAINS.ACCESS.SESSION;

/** Minimum interval, in milliseconds, between persisted last-activity updates. */
const TOUCH_THROTTLE_MS = 15_000;

/** Schema describing the stored envelope wrapping the session claim. */
const SessionEnvelopeSchema = StoredRecordEnvelopeSchema.extend({
  data: SessionClaimV1Schema,
});

/**
 * Session lifecycle statuses surfaced to subscribers.
 * @type {{
 *   ACTIVE: 'active',
 *   WARNING: 'warning',
 *   EXPIRED: 'expired',
 *   NONE: 'none',
 * }}
 */
export const SESSION_STATUS = Object.freeze({
  ACTIVE: 'active',
  WARNING: 'warning',
  EXPIRED: 'expired',
  NONE: 'none',
});

/**
 * Safe reason codes surfaced by the session facade on logout/expiry.
 * @type {{
 *   SIGN_OUT: 'auth.success.sign_out',
 *   SESSION_EXPIRED: 'auth.error.session_expired',
 * }}
 */
export const SESSION_REASON_CODES = Object.freeze({
  SIGN_OUT: 'auth.success.sign_out',
  SESSION_EXPIRED: 'auth.error.session_expired',
});

/** Lazily-provisioned session storage adapter shared across facade calls. */
let sharedAdapter = null;

/** In-memory cache of the last-known session claim. */
let cachedClaim = null;

/** Epoch milliseconds of the last persisted last-activity update. */
let lastPersistedActivityMs = 0;

/** Registered change listeners. */
const listeners = new Set();

/**
 * Provisions (or returns) the shared session storage adapter, creating a
 * session-scoped adapter on first use. Failures degrade to `null` so callers
 * never crash on a storage fault.
 * @returns {import('@/shared/storage/storageAdapter').StorageAdapter | null}
 *   The shared adapter, or `null` when it could not be provisioned.
 */
function resolveAdapter() {
  if (sharedAdapter) {
    return sharedAdapter;
  }
  try {
    sharedAdapter = createSessionStorageAdapter();
    return sharedAdapter;
  } catch (error) {
    safeLogger.error('sessionFacade: failed to provision session adapter', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * Overrides the storage adapter backing the facade and resets in-memory state.
 * Primarily used by tests to inject a deterministic or in-memory adapter.
 * @param {import('@/shared/storage/storageAdapter').StorageAdapter | null} adapter
 *   The adapter to use, or `null` to reset to lazy provisioning.
 * @returns {void}
 */
export function configureSessionFacade(adapter) {
  sharedAdapter = adapter ?? null;
  cachedClaim = null;
  lastPersistedActivityMs = 0;
}

/**
 * Reads and validates the persisted session envelope.
 * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
 *   The session storage adapter.
 * @returns {import('@/shared/schemas/schemas').SessionClaimV1 | null}
 *   The stored session claim, or `null`.
 */
function readEnvelope(adapter) {
  const envelope = adapter.read(SESSION_DOMAIN, SessionEnvelopeSchema, undefined);
  if (!envelope || !envelope.data) {
    return null;
  }
  return envelope.data;
}

/**
 * Persists the supplied session claim, wrapping it in a stored envelope.
 * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
 *   The session storage adapter.
 * @param {import('@/shared/schemas/schemas').SessionClaimV1} claim - The claim.
 * @returns {boolean} `true` when the write succeeded.
 */
function persistClaim(adapter, claim) {
  const created = createStoredRecordEnvelope(claim, {
    createdAt: demoClock.now(),
    expiresAt: claim.expiresAt,
  });
  if (!created.ok) {
    safeLogger.error('sessionFacade: failed to build session envelope', {
      reason: created.error,
    });
    return false;
  }
  return adapter.write(SESSION_DOMAIN, created.value);
}

/**
 * Computes the lifecycle status of a session claim relative to the demo clock.
 * @param {import('@/shared/schemas/schemas').SessionClaimV1 | null} claim
 *   The session claim, or `null`.
 * @returns {string} One of {@link SESSION_STATUS}.
 */
export function computeStatus(claim) {
  if (!claim) {
    return SESSION_STATUS.NONE;
  }
  if (demoClock.isExpired(claim.expiresAt)) {
    return SESSION_STATUS.EXPIRED;
  }
  const minutesRemaining = demoClock.diffMinutes(demoClock.now(), claim.expiresAt);
  if (minutesRemaining <= SESSION_WARNING_MINUTES) {
    return SESSION_STATUS.WARNING;
  }
  return SESSION_STATUS.ACTIVE;
}

/**
 * Notifies all registered listeners with the current session snapshot.
 * @param {string} status - The current lifecycle status.
 * @param {string} [safeReasonCode] - Optional sanitized reason code.
 * @returns {void}
 */
function notify(status, safeReasonCode) {
  const snapshot = {
    session: cachedClaim,
    status,
    safeReasonCode: safeReasonCode ?? null,
  };
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {
      safeLogger.error('sessionFacade: listener threw during notify', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}

/**
 * Clears the persisted session and in-memory cache, notifying subscribers.
 * @param {string} safeReasonCode - A sanitized reason code for the transition.
 * @param {string} status - The resulting lifecycle status.
 * @returns {void}
 */
function clearSession(safeReasonCode, status) {
  const adapter = resolveAdapter();
  if (adapter) {
    adapter.remove(SESSION_DOMAIN);
  }
  cachedClaim = null;
  lastPersistedActivityMs = 0;
  notify(status, safeReasonCode);
}

/**
 * Restores a valid session at bootstrap, purging expired ones.
 * @returns {import('@/shared/schemas/schemas').SessionClaimV1 | null}
 *   The restored session claim, or `null`.
 */
export function restoreSession() {
  const adapter = resolveAdapter();
  if (!adapter) {
    cachedClaim = null;
    return null;
  }

  let claim;
  try {
    claim = readEnvelope(adapter);
  } catch (error) {
    safeLogger.error('sessionFacade: failed to restore session', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }

  if (!claim) {
    cachedClaim = null;
    return null;
  }

  if (demoClock.isExpired(claim.expiresAt)) {
    clearSession(SESSION_REASON_CODES.SESSION_EXPIRED, SESSION_STATUS.EXPIRED);
    return null;
  }

  cachedClaim = claim;
  lastPersistedActivityMs = demoClock.nowMs();
  return cachedClaim;
}

/**
 * Establishes a new session by validating and persisting a session claim.
 *
 * The passcode-like credential is never accepted here; only the sanitized
 * {@link SessionClaimV1} is persisted.
 *
 * @param {unknown} claim - The session claim to establish.
 * @returns {import('@/shared/schemas/schemas').SessionClaimV1 | null}
 *   The established session claim, or `null` when it could not be persisted.
 */
export function startSession(claim) {
  const parsed = safeParseWith(SessionClaimV1Schema, claim);
  if (!parsed.ok) {
    safeLogger.warn('sessionFacade: rejected invalid session claim', {
      reason: parsed.error,
    });
    return null;
  }

  const adapter = resolveAdapter();
  if (!adapter) {
    safeLogger.warn('sessionFacade: start skipped; no adapter available');
    return null;
  }

  if (!persistClaim(adapter, parsed.value)) {
    return null;
  }

  cachedClaim = parsed.value;
  lastPersistedActivityMs = demoClock.nowMs();
  notify(computeStatus(cachedClaim), null);
  return cachedClaim;
}

/**
 * Returns the current, non-expired session claim.
 *
 * When the cached session has lapsed relative to the demo clock, it is purged
 * and `null` is returned so callers never receive an expired session.
 *
 * @returns {import('@/shared/schemas/schemas').SessionClaimV1 | null}
 *   The active session claim, or `null`.
 */
export function getSession() {
  if (!cachedClaim) {
    return restoreSession();
  }
  if (demoClock.isExpired(cachedClaim.expiresAt)) {
    clearSession(SESSION_REASON_CODES.SESSION_EXPIRED, SESSION_STATUS.EXPIRED);
    return null;
  }
  return cachedClaim;
}

/**
 * Records throttled last-activity and re-evaluates the session lifecycle.
 *
 * Persisted last-activity updates are throttled to avoid excessive writes;
 * lifecycle transitions (active → warning → expired) are always re-evaluated
 * and subscribers are notified.
 *
 * @returns {string} The resulting lifecycle status.
 */
export function touch() {
  const claim = getSession();
  if (!claim) {
    return SESSION_STATUS.NONE;
  }

  const status = computeStatus(claim);
  if (status === SESSION_STATUS.EXPIRED) {
    clearSession(SESSION_REASON_CODES.SESSION_EXPIRED, SESSION_STATUS.EXPIRED);
    return SESSION_STATUS.EXPIRED;
  }

  const nowMs = demoClock.nowMs();
  if (nowMs - lastPersistedActivityMs >= TOUCH_THROTTLE_MS) {
    const refreshed = {
      ...claim,
      expiresAt: demoClock.addMinutes(demoClock.now(), SESSION_TIMEOUT_MINUTES),
    };
    const parsed = safeParseWith(SessionClaimV1Schema, refreshed);
    if (parsed.ok) {
      const adapter = resolveAdapter();
      if (adapter && persistClaim(adapter, parsed.value)) {
        cachedClaim = parsed.value;
        lastPersistedActivityMs = nowMs;
      }
    }
  }

  const nextStatus = computeStatus(cachedClaim);
  notify(nextStatus, null);
  return nextStatus;
}

/**
 * Clears the persisted session and notifies subscribers.
 * @param {string} [safeReasonCode] - Optional sanitized reason code.
 * @returns {void}
 */
export function logout(safeReasonCode) {
  clearSession(safeReasonCode ?? SESSION_REASON_CODES.SIGN_OUT, SESSION_STATUS.NONE);
}

/**
 * Registers a session change listener and returns an unsubscribe function.
 *
 * The listener is invoked with a `{ session, status, safeReasonCode }` snapshot
 * on every lifecycle transition. It is not invoked immediately; call
 * {@link getSession} for the current value.
 *
 * @param {(snapshot: {
 *   session: import('@/shared/schemas/schemas').SessionClaimV1 | null,
 *   status: string,
 *   safeReasonCode: string | null,
 * }) => void} listener - The change listener.
 * @returns {() => void} An unsubscribe function.
 */
export function subscribe(listener) {
  if (typeof listener !== 'function') {
    safeLogger.warn('sessionFacade: subscribe called without a function listener');
    return () => {};
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Runtime shape guard for the subscribe listener (documentation aid). */
const ListenerSchema = z.function();

/**
 * The SessionFacade contract, exposed as a single frozen object.
 * @type {{
 *   getSession: typeof getSession,
 *   touch: typeof touch,
 *   logout: typeof logout,
 *   subscribe: typeof subscribe,
 *   startSession: typeof startSession,
 *   restoreSession: typeof restoreSession,
 *   computeStatus: typeof computeStatus,
 *   configureSessionFacade: typeof configureSessionFacade,
 *   SESSION_STATUS: typeof SESSION_STATUS,
 *   SESSION_REASON_CODES: typeof SESSION_REASON_CODES,
 * }}
 */
export const sessionFacade = Object.freeze({
  getSession,
  touch,
  logout,
  subscribe,
  startSession,
  restoreSession,
  computeStatus,
  configureSessionFacade,
  SESSION_STATUS,
  SESSION_REASON_CODES,
});

// Referenced to document the expected listener shape without side effects.
void ListenerSchema;

export default sessionFacade;