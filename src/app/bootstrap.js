/**
 * Application bootstrap (initialization boundary).
 *
 * Bootstrap is the single entry point that prepares the runtime before any
 * protected content renders (SCRUM-827). It runs a fixed, conservative sequence:
 *
 *   1. Load and freeze the non-sensitive environment configuration.
 *   2. Provision the deterministic {@link demoClock} and capture the current
 *      demo instant.
 *   3. Validate that the bundled fixture manifests loaded and are structurally
 *      usable via the {@link fixtureRegistry}.
 *   4. Check storage availability by provisioning the local and session
 *      {@link StorageAdapter}s, recording whether either degraded to an
 *      in-memory fallback.
 *   5. Run the schema {@link migrationRunner} and the retention
 *      {@link expiryPurge} across every adapter-managed namespace.
 *   6. Recover any in-flight payment reservations and prune expired
 *      reservations/commit markers via the {@link paymentDemoDataManager}.
 *   7. Restore a valid, non-expired session via the {@link sessionFacade},
 *      purging expired ones.
 *
 * The bootstrap is intentionally defensive and demo-only: every step is isolated
 * so a single fault can never abort the whole sequence, and the result is a
 * discriminated snapshot carrying a sanitized safe reason code so the app shell
 * can gate rendering safely. No step throws for expected failures.
 */

import { ENV } from '@/shared/config/env';
import { FIXTURE_IDS, fixtureRegistry } from '@/shared/fixtures/fixtureRegistry';
import {
  createLocalStorageAdapter,
  createSessionStorageAdapter,
} from '@/shared/storage/storageAdapter';
import { runMigrations } from '@/shared/storage/migrationRunner';
import { runExpiryPurge } from '@/shared/storage/expiryPurge';
import { cleanupExpiredPaymentData } from '@/features/payment/services/paymentDemoDataManager';
import { sessionFacade } from '@/features/access/services/sessionFacade';
import { demoClock } from '@/shared/time/demoClock';
import { safeLogger } from '@/shared/logging/safeLogger';

/**
 * Safe reason codes surfaced by the bootstrap for gating and messaging.
 * @type {{
 *   READY: 'bootstrap.ready',
 *   DEGRADED_STORAGE: 'bootstrap.degraded_storage',
 *   DEGRADED_FIXTURES: 'bootstrap.degraded_fixtures',
 *   UNEXPECTED: 'bootstrap.unexpected',
 * }}
 */
export const BOOTSTRAP_REASON_CODES = Object.freeze({
  READY: 'bootstrap.ready',
  DEGRADED_STORAGE: 'bootstrap.degraded_storage',
  DEGRADED_FIXTURES: 'bootstrap.degraded_fixtures',
  UNEXPECTED: 'bootstrap.unexpected',
});

/**
 * The set of fixtures that must be present and non-empty for the app to run.
 * @type {readonly string[]}
 */
const REQUIRED_FIXTURES = Object.freeze([
  FIXTURE_IDS.NAVIGATION,
  FIXTURE_IDS.ROLES,
  FIXTURE_IDS.USERS,
  FIXTURE_IDS.CURRENCY_PAIRS,
  FIXTURE_IDS.ACCOUNTS,
]);

/** Cached bootstrap snapshot so the sequence runs at most once per session. */
let cachedSnapshot = null;

/**
 * Determines whether a value is a plain, non-array object.
 * @param {unknown} value - The candidate value.
 * @returns {boolean} `true` when `value` is a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates that the bundled fixture manifests loaded and are usable.
 *
 * Each required fixture must resolve to a validated envelope carrying its
 * expected metadata; a missing or empty fixture degrades the result rather than
 * throwing.
 * @returns {{ ok: boolean, checked: number, missing: string[] }} A validation summary.
 */
function validateFixtures() {
  const missing = [];
  let checked = 0;

  for (const fixtureId of REQUIRED_FIXTURES) {
    checked += 1;
    let fixture;
    try {
      fixture = fixtureRegistry.getFixture(fixtureId);
    } catch (error) {
      safeLogger.warn('bootstrap: failed to read fixture during validation', {
        fixture: String(fixtureId),
        reason: error instanceof Error ? error.name : 'unknown',
      });
      missing.push(fixtureId);
      continue;
    }
    if (!isPlainObject(fixture) || typeof fixture.schemaVersion !== 'string') {
      missing.push(fixtureId);
    }
  }

  return { ok: missing.length === 0, checked, missing };
}

/**
 * Provisions the local and session storage adapters, recording whether either
 * degraded to the in-memory fallback.
 * @returns {{
 *   localAdapter: import('@/shared/storage/storageAdapter').StorageAdapter | null,
 *   sessionAdapter: import('@/shared/storage/storageAdapter').StorageAdapter | null,
 *   degraded: boolean,
 * }} A storage provisioning summary.
 */
function provisionStorage() {
  let localAdapter = null;
  let sessionAdapter = null;

  try {
    localAdapter = createLocalStorageAdapter();
  } catch (error) {
    safeLogger.error('bootstrap: failed to provision local storage adapter', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }

  try {
    sessionAdapter = createSessionStorageAdapter();
  } catch (error) {
    safeLogger.error('bootstrap: failed to provision session storage adapter', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }

  const degraded =
    !localAdapter ||
    !sessionAdapter ||
    (typeof localAdapter.isInMemory === 'function' && localAdapter.isInMemory()) ||
    (typeof sessionAdapter.isInMemory === 'function' && sessionAdapter.isInMemory());

  return { localAdapter, sessionAdapter, degraded };
}

/**
 * Runs the schema migration and retention expiry purge across a single adapter,
 * isolating faults so a single adapter can never abort the sequence.
 * @param {import('@/shared/storage/storageAdapter').StorageAdapter | null} adapter
 *   The storage adapter to process.
 * @returns {{ migrated: number, purged: number, quarantined: number }} A summary.
 */
function reconcileAdapter(adapter) {
  if (!adapter) {
    return { migrated: 0, purged: 0, quarantined: 0 };
  }

  let migrated = 0;
  let quarantined = 0;
  try {
    const migrationSummary = runMigrations(adapter);
    migrated = migrationSummary.migrated;
    quarantined = migrationSummary.quarantined;
  } catch (error) {
    safeLogger.warn('bootstrap: migration run failed for adapter', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }

  let purged = 0;
  try {
    const purgeSummary = runExpiryPurge(adapter);
    purged = purgeSummary.purged;
  } catch (error) {
    safeLogger.warn('bootstrap: expiry purge failed for adapter', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }

  return { migrated, purged, quarantined };
}

/**
 * Recovers in-flight payment reservations and prunes expired reservations and
 * commit markers, never throwing on failure.
 * @returns {{ ok: boolean, purged: number }} A recovery summary.
 */
function recoverReservations() {
  try {
    const result = cleanupExpiredPaymentData();
    return { ok: result.ok === true, purged: typeof result.purged === 'number' ? result.purged : 0 };
  } catch (error) {
    safeLogger.warn('bootstrap: reservation recovery failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return { ok: false, purged: 0 };
  }
}

/**
 * Restores a valid, non-expired session, purging expired ones. Never throws.
 * @returns {import('@/shared/schemas/schemas').SessionClaimV1 | null}
 *   The restored session claim, or `null`.
 */
function restoreSession() {
  try {
    return sessionFacade.restoreSession();
  } catch (error) {
    safeLogger.warn('bootstrap: session restore failed', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * Runs the application bootstrap sequence, preparing the runtime before any
 * protected content renders.
 *
 * The sequence is idempotent per session: the first call performs the work and
 * caches the resulting snapshot; subsequent calls (unless forced) return the
 * cached snapshot. Every step is isolated so a single fault can never abort the
 * whole sequence, and the result carries a sanitized safe reason code so the app
 * shell can gate rendering safely. No step throws for expected failures.
 *
 * @param {{ force?: boolean }} [options] - Optional bootstrap options.
 * @returns {{
 *   ok: boolean,
 *   ready: boolean,
 *   startedAt: string,
 *   env: { buildLabel: string, fixturePack: string, referenceDate: string },
 *   fixtures: { ok: boolean, checked: number, missing: string[] },
 *   storage: { available: boolean, degraded: boolean },
 *   reconciliation: { migrated: number, purged: number, quarantined: number },
 *   reservations: { ok: boolean, purged: number },
 *   session: import('@/shared/schemas/schemas').SessionClaimV1 | null,
 *   safeReasonCode: string,
 * }} A discriminated bootstrap snapshot.
 */
export function bootstrap(options) {
  const source = isPlainObject(options) ? options : {};
  if (cachedSnapshot && source.force !== true) {
    return cachedSnapshot;
  }

  const startedAt = demoClock.now();
  const env = {
    buildLabel: ENV.buildLabel,
    fixturePack: ENV.fixturePack,
    referenceDate: ENV.referenceDate,
  };

  let fixtures = { ok: false, checked: 0, missing: [] };
  let storage = { available: false, degraded: true };
  let reconciliation = { migrated: 0, purged: 0, quarantined: 0 };
  let reservations = { ok: false, purged: 0 };
  let session = null;

  try {
    fixtures = validateFixtures();

    const provisioned = provisionStorage();
    storage = {
      available: Boolean(provisioned.localAdapter && provisioned.sessionAdapter),
      degraded: provisioned.degraded,
    };

    const localSummary = reconcileAdapter(provisioned.localAdapter);
    const sessionSummary = reconcileAdapter(provisioned.sessionAdapter);
    reconciliation = {
      migrated: localSummary.migrated + sessionSummary.migrated,
      purged: localSummary.purged + sessionSummary.purged,
      quarantined: localSummary.quarantined + sessionSummary.quarantined,
    };

    reservations = recoverReservations();
    session = restoreSession();
  } catch (error) {
    safeLogger.error('bootstrap: unexpected error during bootstrap', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    const snapshot = {
      ok: false,
      ready: false,
      startedAt,
      env,
      fixtures,
      storage,
      reconciliation,
      reservations,
      session,
      safeReasonCode: BOOTSTRAP_REASON_CODES.UNEXPECTED,
    };
    cachedSnapshot = snapshot;
    return snapshot;
  }

  let safeReasonCode = BOOTSTRAP_REASON_CODES.READY;
  if (!fixtures.ok) {
    safeReasonCode = BOOTSTRAP_REASON_CODES.DEGRADED_FIXTURES;
  } else if (storage.degraded) {
    safeReasonCode = BOOTSTRAP_REASON_CODES.DEGRADED_STORAGE;
  }

  const snapshot = {
    ok: fixtures.ok,
    ready: true,
    startedAt,
    env,
    fixtures,
    storage,
    reconciliation,
    reservations,
    session,
    safeReasonCode,
  };

  cachedSnapshot = snapshot;
  return snapshot;
}

/**
 * Returns the cached bootstrap snapshot from the most recent {@link bootstrap}
 * run, or `null` when the bootstrap has not yet run.
 * @returns {ReturnType<typeof bootstrap> | null} The cached snapshot, or `null`.
 */
export function getBootstrapSnapshot() {
  return cachedSnapshot;
}

/**
 * Resets the cached bootstrap snapshot so a subsequent {@link bootstrap} call
 * re-runs the full sequence. Primarily used by tests.
 * @returns {void}
 */
export function resetBootstrap() {
  cachedSnapshot = null;
}

/**
 * The bootstrap contract, exposed as a single frozen object.
 * @type {{
 *   bootstrap: typeof bootstrap,
 *   getBootstrapSnapshot: typeof getBootstrapSnapshot,
 *   resetBootstrap: typeof resetBootstrap,
 *   BOOTSTRAP_REASON_CODES: typeof BOOTSTRAP_REASON_CODES,
 * }}
 */
export const appBootstrap = Object.freeze({
  bootstrap,
  getBootstrapSnapshot,
  resetBootstrap,
  BOOTSTRAP_REASON_CODES,
});

export default appBootstrap;