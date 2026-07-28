/**
 * Storage schema migration and quarantine runner.
 *
 * MigrationRunner is executed once at bootstrap. For every key managed by a
 * {@link StorageAdapter} it parses the raw JSON in a try/catch, validates the
 * stored-record envelope shape (schemaVersion / createdAt / expiresAt / data),
 * and reconciles its version against the current baseline:
 *
 *   - Records already at the current version are left untouched.
 *   - Records at a supported older minor version are upgraded by applying the
 *     registered migration functions in sequence.
 *   - Records carrying an unknown/major-incompatible version are reset to the
 *     supplied baseline value so the app keeps working with clean data.
 *   - Records that cannot be parsed or validated are removed (quarantined) with
 *     a sanitized diagnostic and never leak into the app.
 *
 * Nothing thrown by an individual record ever aborts the run — each record is
 * isolated so a single malformed entry cannot block bootstrap.
 */

import { StoredRecordEnvelopeSchema, STORED_RECORD_SCHEMA_VERSION } from '@/shared/schemas/schemas';
import { demoClock } from '@/shared/time/demoClock';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Baseline schema version treated as the current target. */
const CURRENT_VERSION = STORED_RECORD_SCHEMA_VERSION;

/** Matches a versioned schema label of the form `v{major}` or `v{major}.{minor}`. */
const VERSION_PATTERN = /^v(\d+)(?:\.(\d+))?$/;

/**
 * Outcome codes describing what happened to a single record during migration.
 * @type {{
 *   UNCHANGED: 'unchanged',
 *   MIGRATED: 'migrated',
 *   RESET: 'reset',
 *   QUARANTINED: 'quarantined',
 *   SKIPPED: 'skipped',
 * }}
 */
export const MIGRATION_OUTCOMES = Object.freeze({
  UNCHANGED: 'unchanged',
  MIGRATED: 'migrated',
  RESET: 'reset',
  QUARANTINED: 'quarantined',
  SKIPPED: 'skipped',
});

/**
 * Parses a version label into its numeric major/minor components.
 * @param {unknown} version - The raw version label (e.g. `v1`, `v1.2`).
 * @returns {{ major: number, minor: number } | null} Parsed parts, or `null`.
 */
function parseVersion(version) {
  if (typeof version !== 'string') {
    return null;
  }
  const match = version.trim().match(VERSION_PATTERN);
  if (!match) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return null;
  }
  return { major, minor };
}

/**
 * Normalizes a migration registry into a map of `fromVersion -> function`.
 * @param {Record<string, (data: unknown) => unknown> | undefined} migrations
 *   Registry keyed by the source version each function upgrades from.
 * @returns {Map<string, (data: unknown) => unknown>} A validated migration map.
 */
function normalizeMigrations(migrations) {
  const map = new Map();
  if (!migrations || typeof migrations !== 'object') {
    return map;
  }
  for (const key of Object.keys(migrations)) {
    const fn = migrations[key];
    if (typeof fn === 'function') {
      map.set(key, fn);
    }
  }
  return map;
}

/**
 * Reads and parses the raw stored value for a fully-qualified key.
 * @param {Storage | import('@/shared/storage/storageAdapter').StorageAdapter} store
 *   The backing store exposing `getItem`.
 * @param {string} key - The fully-qualified key.
 * @returns {{ ok: true, value: unknown } | { ok: false }} A parse result.
 */
function readRaw(store, key) {
  let raw;
  try {
    raw = store.getItem(key);
  } catch {
    return { ok: false };
  }
  if (raw === null || raw === undefined) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * Applies the registered migration chain to upgrade an envelope's data to the
 * current version, one step at a time.
 * @param {import('@/shared/schemas/schemas').StoredRecordEnvelope} envelope
 *   The validated source envelope.
 * @param {Map<string, (data: unknown) => unknown>} migrations - Migration map.
 * @returns {{ ok: true, data: unknown, steps: number } | { ok: false }}
 *   The migrated data with the number of applied steps, or a failure.
 */
function applyMigrations(envelope, migrations) {
  let currentVersion = envelope.schemaVersion;
  let currentData = envelope.data;
  let steps = 0;
  const guard = migrations.size + 1;

  while (currentVersion !== CURRENT_VERSION && steps <= guard) {
    const migrate = migrations.get(currentVersion);
    if (typeof migrate !== 'function') {
      return { ok: false };
    }
    try {
      currentData = migrate(currentData);
    } catch {
      return { ok: false };
    }
    steps += 1;
    // The chain advances one supported minor version per applied migration.
    const parsed = parseVersion(currentVersion);
    if (!parsed) {
      return { ok: false };
    }
    currentVersion = `v${parsed.major}.${parsed.minor + 1}`;
    // Migrations that reach the current baseline collapse to it exactly.
    if (currentVersion === `v${parseVersion(CURRENT_VERSION)?.major}`) {
      currentVersion = CURRENT_VERSION;
    }
  }

  if (currentVersion !== CURRENT_VERSION) {
    return { ok: false };
  }
  return { ok: true, data: currentData, steps };
}

/**
 * Builds a fresh baseline envelope wrapping the supplied data.
 * @param {unknown} data - The baseline payload.
 * @returns {import('@/shared/schemas/schemas').StoredRecordEnvelope} A baseline envelope.
 */
function buildBaselineEnvelope(data) {
  return {
    schemaVersion: CURRENT_VERSION,
    createdAt: demoClock.now(),
    expiresAt: null,
    data,
  };
}

/**
 * Serializes and writes an envelope to the backing store for a key.
 * @param {Storage} store - The backing store exposing `setItem`.
 * @param {string} key - The fully-qualified key.
 * @param {import('@/shared/schemas/schemas').StoredRecordEnvelope} envelope - The envelope.
 * @returns {boolean} `true` when the write succeeded.
 */
function writeEnvelope(store, key, envelope) {
  try {
    store.setItem(key, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes a record from the backing store, swallowing storage errors.
 * @param {Storage} store - The backing store exposing `removeItem`.
 * @param {string} key - The fully-qualified key.
 * @returns {boolean} `true` when the removal succeeded.
 */
function removeKey(store, key) {
  try {
    store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Migrates a single stored record for one key, isolating all failures.
 * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
 *   The adapter owning the backing store.
 * @param {string} key - The fully-qualified key.
 * @param {{
 *   migrations: Map<string, (data: unknown) => unknown>,
 *   baseline: unknown,
 * }} config - Migration configuration.
 * @returns {string} One of {@link MIGRATION_OUTCOMES}.
 */
function migrateKey(adapter, key, config) {
  const store = adapter.store;
  const read = readRaw(store, key);

  if (!read.ok) {
    removeKey(store, key);
    safeLogger.warn('migrationRunner: removed unreadable record', { kind: adapter.kind });
    return MIGRATION_OUTCOMES.QUARANTINED;
  }

  const candidate = read.value;
  const rawVersion =
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? candidate.schemaVersion
      : undefined;
  const parsedVersion = parseVersion(rawVersion);
  const currentParts = parseVersion(CURRENT_VERSION);

  const parsed = StoredRecordEnvelopeSchema.safeParse(candidate);
  if (parsed.success) {
    if (parsed.data.schemaVersion === CURRENT_VERSION) {
      return MIGRATION_OUTCOMES.UNCHANGED;
    }
  }

  // Reject records whose major version is unknown/incompatible: reset them.
  if (!parsedVersion || !currentParts || parsedVersion.major !== currentParts.major) {
    const baselineEnvelope = buildBaselineEnvelope(config.baseline);
    if (writeEnvelope(store, key, baselineEnvelope)) {
      safeLogger.warn('migrationRunner: reset record to baseline', { kind: adapter.kind });
      return MIGRATION_OUTCOMES.RESET;
    }
    removeKey(store, key);
    safeLogger.warn('migrationRunner: removed record after failed reset', { kind: adapter.kind });
    return MIGRATION_OUTCOMES.QUARANTINED;
  }

  // Same major version but older minor: attempt an explicit migration chain.
  const source =
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? {
          schemaVersion: rawVersion,
          createdAt: candidate.createdAt,
          expiresAt: candidate.expiresAt ?? null,
          data: candidate.data,
        }
      : null;

  if (!source) {
    removeKey(store, key);
    safeLogger.warn('migrationRunner: quarantined malformed record', { kind: adapter.kind });
    return MIGRATION_OUTCOMES.QUARANTINED;
  }

  const migrated = applyMigrations(source, config.migrations);
  if (!migrated.ok) {
    removeKey(store, key);
    safeLogger.warn('migrationRunner: quarantined unmigratable record', { kind: adapter.kind });
    return MIGRATION_OUTCOMES.QUARANTINED;
  }

  const upgraded = {
    schemaVersion: CURRENT_VERSION,
    createdAt:
      typeof source.createdAt === 'string' && source.createdAt.length > 0
        ? source.createdAt
        : demoClock.now(),
    expiresAt: source.expiresAt ?? null,
    data: migrated.data,
  };

  const validated = StoredRecordEnvelopeSchema.safeParse(upgraded);
  if (!validated.success) {
    removeKey(store, key);
    safeLogger.warn('migrationRunner: quarantined post-migration record', { kind: adapter.kind });
    return MIGRATION_OUTCOMES.QUARANTINED;
  }

  if (writeEnvelope(store, key, validated.data)) {
    safeLogger.warn('migrationRunner: migrated record to current version', {
      kind: adapter.kind,
      steps: migrated.steps,
    });
    return MIGRATION_OUTCOMES.MIGRATED;
  }

  removeKey(store, key);
  safeLogger.warn('migrationRunner: removed record after failed migration write', {
    kind: adapter.kind,
  });
  return MIGRATION_OUTCOMES.QUARANTINED;
}

/**
 * Runs schema migration and quarantine across every key owned by an adapter.
 *
 * Each record is processed in isolation so a single malformed entry cannot
 * abort the run. Returns a tally of outcomes for diagnostics.
 *
 * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
 *   The storage adapter whose namespaced keys should be migrated.
 * @param {{
 *   migrations?: Record<string, (data: unknown) => unknown>,
 *   baseline?: unknown,
 * }} [options] - Migration options.
 * @returns {{
 *   scanned: number,
 *   unchanged: number,
 *   migrated: number,
 *   reset: number,
 *   quarantined: number,
 *   skipped: number,
 * }} A tally of migration outcomes.
 */
export function runMigrations(adapter, options) {
  const summary = {
    scanned: 0,
    unchanged: 0,
    migrated: 0,
    reset: 0,
    quarantined: 0,
    skipped: 0,
  };

  if (!adapter || typeof adapter.keys !== 'function' || !adapter.store) {
    safeLogger.warn('migrationRunner: no usable adapter supplied; skipping run');
    return summary;
  }

  const source = options ?? {};
  const config = {
    migrations: normalizeMigrations(source.migrations),
    baseline: source.baseline ?? null,
  };

  let keys;
  try {
    keys = adapter.keys();
  } catch {
    safeLogger.warn('migrationRunner: failed to enumerate keys; skipping run', {
      kind: adapter.kind,
    });
    return summary;
  }

  for (const key of keys) {
    summary.scanned += 1;
    let outcome;
    try {
      outcome = migrateKey(adapter, key, config);
    } catch {
      // A single record must never abort the whole bootstrap migration.
      outcome = MIGRATION_OUTCOMES.SKIPPED;
      safeLogger.warn('migrationRunner: unexpected error migrating record', {
        kind: adapter.kind,
      });
    }

    switch (outcome) {
      case MIGRATION_OUTCOMES.UNCHANGED:
        summary.unchanged += 1;
        break;
      case MIGRATION_OUTCOMES.MIGRATED:
        summary.migrated += 1;
        break;
      case MIGRATION_OUTCOMES.RESET:
        summary.reset += 1;
        break;
      case MIGRATION_OUTCOMES.QUARANTINED:
        summary.quarantined += 1;
        break;
      default:
        summary.skipped += 1;
        break;
    }
  }

  return summary;
}

/**
 * The migration runner contract, exposed as a single frozen object.
 * @type {{
 *   runMigrations: typeof runMigrations,
 *   MIGRATION_OUTCOMES: typeof MIGRATION_OUTCOMES,
 * }}
 */
export const migrationRunner = Object.freeze({
  runMigrations,
  MIGRATION_OUTCOMES,
});

export default migrationRunner;