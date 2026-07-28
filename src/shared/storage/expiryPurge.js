/**
 * 30-day retention expiry purge.
 *
 * ExpiryPurge is executed once at bootstrap. For every key managed by a
 * {@link StorageAdapter} it parses the raw JSON in a try/catch, validates the
 * stored-record envelope shape (schemaVersion / createdAt / expiresAt / data),
 * and removes entries that are past their retention window relative to the
 * deterministic {@link demoClock}:
 *
 *   - Records whose explicit `expiresAt` is at or before the current demo
 *     instant are purged.
 *   - Records without an explicit `expiresAt` are purged once their `createdAt`
 *     is older than the configured retention window ({@link RETENTION_DAYS}).
 *   - Records that cannot be read, parsed, or validated are left untouched here
 *     (the migration runner is responsible for quarantining malformed data).
 *
 * Each record is processed in isolation so a single failure can never abort the
 * run. Removal is always scoped to explicit adapter-managed keys — the purge
 * never calls `Storage.clear()`.
 */

import { RETENTION_DAYS } from '@/shared/config/constants';
import { StoredRecordEnvelopeSchema } from '@/shared/schemas/schemas';
import { demoClock } from '@/shared/time/demoClock';
import { safeLogger } from '@/shared/logging/safeLogger';

/**
 * Outcome codes describing what happened to a single record during the purge.
 * @type {{
 *   RETAINED: 'retained',
 *   PURGED: 'purged',
 *   SKIPPED: 'skipped',
 * }}
 */
export const PURGE_OUTCOMES = Object.freeze({
  RETAINED: 'retained',
  PURGED: 'purged',
  SKIPPED: 'skipped',
});

/**
 * Resolves an effective retention window in days, falling back to the
 * configured baseline when an override is unusable.
 * @param {unknown} value - The requested retention window in days.
 * @returns {number} A positive retention window in days.
 */
function resolveRetentionDays(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return RETENTION_DAYS;
}

/**
 * Reads and parses the raw stored value for a fully-qualified key.
 * @param {Storage} store - The backing store exposing `getItem`.
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
 * Determines whether a validated envelope is past its retention window.
 * @param {import('@/shared/schemas/schemas').StoredRecordEnvelope} envelope
 *   The validated stored-record envelope.
 * @param {number} retentionDays - The effective retention window in days.
 * @returns {boolean} `true` when the record should be purged.
 */
function isPastRetention(envelope, retentionDays) {
  if (typeof envelope.expiresAt === 'string' && envelope.expiresAt.length > 0) {
    return demoClock.isExpired(envelope.expiresAt);
  }
  const retentionExpiry = demoClock.addDays(envelope.createdAt, retentionDays);
  return demoClock.isExpired(retentionExpiry);
}

/**
 * Evaluates and purges a single stored record for one key, isolating failures.
 * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
 *   The adapter owning the backing store.
 * @param {string} key - The fully-qualified key.
 * @param {number} retentionDays - The effective retention window in days.
 * @returns {string} One of {@link PURGE_OUTCOMES}.
 */
function purgeKey(adapter, key, retentionDays) {
  const store = adapter.store;
  const read = readRaw(store, key);

  if (!read.ok) {
    return PURGE_OUTCOMES.SKIPPED;
  }

  const parsed = StoredRecordEnvelopeSchema.safeParse(read.value);
  if (!parsed.success) {
    return PURGE_OUTCOMES.SKIPPED;
  }

  let expired;
  try {
    expired = isPastRetention(parsed.data, retentionDays);
  } catch {
    return PURGE_OUTCOMES.SKIPPED;
  }

  if (!expired) {
    return PURGE_OUTCOMES.RETAINED;
  }

  if (removeKey(store, key)) {
    safeLogger.warn('expiryPurge: purged expired record', { kind: adapter.kind });
    return PURGE_OUTCOMES.PURGED;
  }

  safeLogger.warn('expiryPurge: failed to remove expired record', { kind: adapter.kind });
  return PURGE_OUTCOMES.SKIPPED;
}

/**
 * Runs the retention expiry purge across every key owned by an adapter.
 *
 * Each record is processed in isolation so a single malformed or unremovable
 * entry cannot abort the run. Returns a tally of outcomes for diagnostics.
 *
 * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
 *   The storage adapter whose namespaced keys should be purged.
 * @param {{ retentionDays?: number }} [options] - Purge options.
 * @returns {{
 *   scanned: number,
 *   retained: number,
 *   purged: number,
 *   skipped: number,
 * }} A tally of purge outcomes.
 */
export function runExpiryPurge(adapter, options) {
  const summary = {
    scanned: 0,
    retained: 0,
    purged: 0,
    skipped: 0,
  };

  if (!adapter || typeof adapter.keys !== 'function' || !adapter.store) {
    safeLogger.warn('expiryPurge: no usable adapter supplied; skipping run');
    return summary;
  }

  const source = options ?? {};
  const retentionDays = resolveRetentionDays(source.retentionDays);

  let keys;
  try {
    keys = adapter.keys();
  } catch {
    safeLogger.warn('expiryPurge: failed to enumerate keys; skipping run', {
      kind: adapter.kind,
    });
    return summary;
  }

  for (const key of keys) {
    summary.scanned += 1;
    let outcome;
    try {
      outcome = purgeKey(adapter, key, retentionDays);
    } catch {
      // A single record must never abort the whole bootstrap purge.
      outcome = PURGE_OUTCOMES.SKIPPED;
      safeLogger.warn('expiryPurge: unexpected error purging record', {
        kind: adapter.kind,
      });
    }

    switch (outcome) {
      case PURGE_OUTCOMES.RETAINED:
        summary.retained += 1;
        break;
      case PURGE_OUTCOMES.PURGED:
        summary.purged += 1;
        break;
      default:
        summary.skipped += 1;
        break;
    }
  }

  return summary;
}

/**
 * The expiry purge contract, exposed as a single frozen object.
 * @type {{
 *   runExpiryPurge: typeof runExpiryPurge,
 *   PURGE_OUTCOMES: typeof PURGE_OUTCOMES,
 * }}
 */
export const expiryPurge = Object.freeze({
  runExpiryPurge,
  PURGE_OUTCOMES,
});

export default expiryPurge;