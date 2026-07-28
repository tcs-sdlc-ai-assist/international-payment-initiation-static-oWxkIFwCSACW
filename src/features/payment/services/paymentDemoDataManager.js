/**
 * Payment demo-data manager (cross-cluster contract).
 *
 * PaymentDemoDataManager owns the payment-domain storage lifecycle consumed by
 * the shared clear-all-demo-data flow (SCRUM-821). It layers atop the
 * {@link PaymentRepository} (draft persistence, accepted records, submission
 * reservations, and scenario overrides) and the shared storage plumbing (the
 * {@link StorageAdapter}, the retention {@link expiryPurge}, and the
 * {@link migrationRunner}). It implements the PaymentDemoDataManager contract:
 *
 *   - `getOwnedStorageKeys()` returns the complete set of namespaced storage
 *     domains this manager owns, so the shared reset flow can enumerate and
 *     clear payment-domain state without hard-coding payment internals.
 *   - `cleanupExpiredPaymentData()` runs the bootstrap cleanup pass: it prunes
 *     expired submission reservations and commit markers via the repository and
 *     runs the retention expiry purge across the payment adapter's namespaced
 *     keys.
 *   - `clearPaymentDemoData()` clears every payment-domain storage domain
 *     (drafts, accepted records, reservations, and scenario overrides) so the
 *     baseline fixtures become the source of truth again, and resets the
 *     in-memory repository provider so subsequent reads re-provision cleanly.
 *
 * The manager is intentionally conservative and demo-only: each removal is
 * isolated so a single storage fault can never abort the whole reset, it never
 * calls `Storage.clear()` (removal is always scoped to the payment adapter's own
 * namespaced keys), and every method returns a discriminated `{ ok, ... }`
 * result carrying a sanitized safe reason code so callers can gate the UI
 * safely. No method throws for expected failures. It carries no server
 * guarantee.
 */

import { STORAGE_DOMAINS } from '@/shared/config/constants';
import { createLocalStorageAdapter } from '@/shared/storage/storageAdapter';
import { runExpiryPurge } from '@/shared/storage/expiryPurge';
import { createPaymentRepository } from '@/features/payment/data/paymentRepository';
import { safeLogger } from '@/shared/logging/safeLogger';

/**
 * Safe reason codes surfaced by the payment demo-data manager.
 * @type {{
 *   KEYS_LISTED: 'payment.demo_data.keys_listed',
 *   CLEANED: 'payment.demo_data.cleaned',
 *   CLEARED: 'payment.demo_data.cleared',
 *   UNEXPECTED: 'payment.demo_data.unexpected',
 * }}
 */
export const PAYMENT_DEMO_DATA_REASON_CODES = Object.freeze({
  KEYS_LISTED: 'payment.demo_data.keys_listed',
  CLEANED: 'payment.demo_data.cleaned',
  CLEARED: 'payment.demo_data.cleared',
  UNEXPECTED: 'payment.demo_data.unexpected',
});

/**
 * The complete set of payment-domain storage domains owned by this manager.
 * @type {readonly string[]}
 */
const OWNED_DOMAINS = Object.freeze([
  STORAGE_DOMAINS.PAYMENT.DRAFTS,
  STORAGE_DOMAINS.PAYMENT.RECORDS,
  STORAGE_DOMAINS.PAYMENT.RESERVATIONS,
  STORAGE_DOMAINS.PAYMENT.SCENARIO_OVERRIDES,
]);

/** Lazily-provisioned payment repository shared across manager calls. */
let sharedRepository = null;

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
    safeLogger.error('paymentDemoDataManager: failed to provision payment repository', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * Overrides the repository backing the manager. Primarily used by tests to
 * inject a deterministic or in-memory repository.
 * @param {import('@/features/payment/data/paymentRepository').PaymentRepository | null} repository
 *   The repository to use, or `null` to reset to lazy provisioning.
 * @returns {void}
 */
export function configurePaymentDemoDataManager(repository) {
  sharedRepository = repository ?? null;
}

/**
 * Resets the cached in-memory repository provider so subsequent reads
 * re-provision cleanly against the freshly-cleared storage.
 * @returns {void}
 */
function resetRepository() {
  sharedRepository = null;
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
    safeLogger.warn('paymentDemoDataManager: failed to remove domain key', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return false;
  }
}

/**
 * Returns the complete set of namespaced storage domains this manager owns.
 *
 * The shared clear-all-demo-data flow uses this list to enumerate and clear
 * payment-domain state without hard-coding payment internals.
 *
 * @returns {{ ok: boolean, keys: string[], safeReasonCode: string }}
 *   A discriminated result carrying the owned storage domains.
 */
export function getOwnedStorageKeys() {
  return {
    ok: true,
    keys: OWNED_DOMAINS.slice(),
    safeReasonCode: PAYMENT_DEMO_DATA_REASON_CODES.KEYS_LISTED,
  };
}

/**
 * Runs the bootstrap cleanup pass for payment-domain storage.
 *
 * Prunes expired submission reservations and commit markers via the repository
 * and runs the retention expiry purge across the payment adapter's namespaced
 * keys. Never throws for expected failures.
 *
 * @returns {{
 *   ok: boolean,
 *   recovered: { committed: number, active: number, commitMarker: boolean },
 *   purged: number,
 *   safeReasonCode: string,
 * }} A discriminated cleanup result.
 */
export function cleanupExpiredPaymentData() {
  const repository = resolveRepository();
  if (!repository) {
    return {
      ok: false,
      recovered: { committed: 0, active: 0, commitMarker: false },
      purged: 0,
      safeReasonCode: PAYMENT_DEMO_DATA_REASON_CODES.UNEXPECTED,
    };
  }

  let committed = 0;
  let active = 0;
  let commitMarker = false;
  try {
    const recovery = repository.runCleanup();
    committed = Array.isArray(recovery.committed) ? recovery.committed.length : 0;
    active = Array.isArray(recovery.active) ? recovery.active.length : 0;
    commitMarker = recovery.commitMarker !== null && recovery.commitMarker !== undefined;
  } catch (error) {
    safeLogger.error('paymentDemoDataManager: failed to recover reservations', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return {
      ok: false,
      recovered: { committed: 0, active: 0, commitMarker: false },
      purged: 0,
      safeReasonCode: PAYMENT_DEMO_DATA_REASON_CODES.UNEXPECTED,
    };
  }

  let purged = 0;
  try {
    const adapter = createLocalStorageAdapter();
    const summary = runExpiryPurge(adapter);
    purged = summary.purged;
  } catch (error) {
    safeLogger.warn('paymentDemoDataManager: expiry purge failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }

  return {
    ok: true,
    recovered: { committed, active, commitMarker },
    purged,
    safeReasonCode: PAYMENT_DEMO_DATA_REASON_CODES.CLEANED,
  };
}

/**
 * Clears every payment-domain storage domain (drafts, accepted records,
 * reservations, and scenario overrides) so the baseline fixtures become the
 * source of truth again, and resets the in-memory repository provider.
 *
 * Each removal is isolated so a single storage fault can never abort the whole
 * reset, and removal is always scoped to the payment adapter's own namespaced
 * keys — never `Storage.clear()`. Never throws for expected failures.
 *
 * @returns {{ ok: boolean, removed: number, safeReasonCode: string }}
 *   A discriminated clear result.
 */
export function clearPaymentDemoData() {
  let adapter;
  try {
    adapter = createLocalStorageAdapter();
  } catch (error) {
    safeLogger.error('paymentDemoDataManager: failed to provision storage adapter', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    resetRepository();
    return {
      ok: false,
      removed: 0,
      safeReasonCode: PAYMENT_DEMO_DATA_REASON_CODES.UNEXPECTED,
    };
  }

  let removed = 0;
  try {
    for (const domain of OWNED_DOMAINS) {
      if (removeDomain(adapter, domain)) {
        removed += 1;
      }
    }
  } catch (error) {
    safeLogger.error('paymentDemoDataManager: unexpected error clearing payment demo data', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    resetRepository();
    return {
      ok: false,
      removed,
      safeReasonCode: PAYMENT_DEMO_DATA_REASON_CODES.UNEXPECTED,
    };
  }

  resetRepository();

  return {
    ok: true,
    removed,
    safeReasonCode: PAYMENT_DEMO_DATA_REASON_CODES.CLEARED,
  };
}

/**
 * The payment demo-data manager contract, exposed as a single frozen object.
 * @type {{
 *   getOwnedStorageKeys: typeof getOwnedStorageKeys,
 *   cleanupExpiredPaymentData: typeof cleanupExpiredPaymentData,
 *   clearPaymentDemoData: typeof clearPaymentDemoData,
 *   configurePaymentDemoDataManager: typeof configurePaymentDemoDataManager,
 *   PAYMENT_DEMO_DATA_REASON_CODES: typeof PAYMENT_DEMO_DATA_REASON_CODES,
 * }}
 */
export const paymentDemoDataManager = Object.freeze({
  getOwnedStorageKeys,
  cleanupExpiredPaymentData,
  clearPaymentDemoData,
  configurePaymentDemoDataManager,
  PAYMENT_DEMO_DATA_REASON_CODES,
});

export default paymentDemoDataManager;