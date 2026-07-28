/**
 * Integration tests for the storage lifecycle and duplicate guard.
 *
 * These tests exercise the {@link StorageAdapter} namespacing and in-memory
 * fallback, the schema {@link migrationRunner} migration/quarantine paths, the
 * 30-day {@link expiryPurge} retention window, and the client-side
 * duplicate-reference prevention in the {@link PaymentRepository} — the storage
 * plumbing underpinning SCRUM-821 (payment reservations) and SCRUM-827 (demo
 * data reset).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  StorageAdapter,
  createLocalStorageAdapter,
  createSessionStorageAdapter,
  STORAGE_KINDS,
} from '@/shared/storage/storageAdapter';
import { runMigrations, MIGRATION_OUTCOMES } from '@/shared/storage/migrationRunner';
import { runExpiryPurge, PURGE_OUTCOMES } from '@/shared/storage/expiryPurge';
import {
  createPaymentRepository,
  PAYMENT_REPOSITORY_REASON_CODES,
  RESERVATION_STATUS,
} from '@/features/payment/data/paymentRepository';
import { STORAGE_NAMESPACE, STORAGE_VERSION } from '@/shared/config/constants';
import {
  createStoredRecordEnvelope,
  StoredRecordEnvelopeSchema,
} from '@/shared/schemas/schemas';
import { demoClock } from '@/shared/time/demoClock';
import { z } from 'zod';

/**
 * A minimal in-memory implementation of the Web Storage surface used to inject
 * deterministic behavior into adapters during tests.
 */
class FakeStore {
  constructor() {
    /** @type {Map<string, string>} */
    this.map = new Map();
  }

  /**
   * @param {string} key - The key to read.
   * @returns {string | null} The stored value, or `null`.
   */
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  /**
   * @param {string} key - The key to write.
   * @param {string} value - The value to store.
   * @returns {void}
   */
  setItem(key, value) {
    this.map.set(key, value);
  }

  /**
   * @param {string} key - The key to remove.
   * @returns {void}
   */
  removeItem(key) {
    this.map.delete(key);
  }

  /**
   * @returns {number} The number of stored entries.
   */
  get length() {
    return this.map.size;
  }

  /**
   * @param {number} index - The entry index.
   * @returns {string | null} The key at `index`, or `null`.
   */
  key(index) {
    if (index < 0 || index >= this.map.size) {
      return null;
    }
    let cursor = 0;
    for (const key of this.map.keys()) {
      if (cursor === index) {
        return key;
      }
      cursor += 1;
    }
    return null;
  }
}

/**
 * A store that throws on every mutating operation, forcing the adapter to
 * degrade to its in-memory fallback.
 */
class ThrowingStore {
  /** @returns {never} */
  getItem() {
    throw new Error('storage unavailable');
  }

  /** @returns {never} */
  setItem() {
    throw new Error('storage unavailable');
  }

  /** @returns {never} */
  removeItem() {
    throw new Error('storage unavailable');
  }

  /** @returns {number} Always zero. */
  get length() {
    return 0;
  }

  /** @returns {null} Always null. */
  key() {
    return null;
  }
}

/** Schema wrapping a simple string payload used by adapter read/write tests. */
const StringEnvelopeSchema = StoredRecordEnvelopeSchema.extend({
  data: z.string(),
});

describe('StorageAdapter namespacing and read/write', () => {
  let store;

  beforeEach(() => {
    store = new FakeStore();
  });

  it('builds fully-qualified namespaced keys from a domain suffix', () => {
    const adapter = new StorageAdapter({
      kind: STORAGE_KINDS.LOCAL,
      org: 'demo-org-01',
      user: 'demo-user',
      store,
    });
    const key = adapter.buildKey('payment.records.v1');
    expect(key).toBe(
      `${STORAGE_NAMESPACE}:${STORAGE_VERSION}:demo-org-01:demo-user:payment.records.v1`,
    );
  });

  it('writes and reads a schema-validated envelope round-trip', () => {
    const adapter = new StorageAdapter({ kind: STORAGE_KINDS.LOCAL, store });
    const created = createStoredRecordEnvelope('demo-value', {
      createdAt: demoClock.now(),
      expiresAt: null,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    expect(adapter.write('payment.drafts.v1', created.value)).toBe(true);
    const read = adapter.read('payment.drafts.v1', StringEnvelopeSchema, undefined);
    expect(read).toBeDefined();
    expect(read?.data).toBe('demo-value');
  });

  it('returns the fallback when a stored value fails schema validation', () => {
    const adapter = new StorageAdapter({ kind: STORAGE_KINDS.LOCAL, store });
    const key = adapter.buildKey('payment.drafts.v1');
    store.setItem(key, JSON.stringify({ schemaVersion: 'v1', createdAt: 'not-a-date', data: 5 }));
    const read = adapter.read('payment.drafts.v1', StringEnvelopeSchema, 'fallback');
    expect(read).toBe('fallback');
  });

  it('scopes namespace enumeration and clearing to the adapter prefix only', () => {
    const adapter = new StorageAdapter({
      kind: STORAGE_KINDS.LOCAL,
      org: 'demo-org-01',
      user: 'demo-user',
      store,
    });
    const created = createStoredRecordEnvelope('scoped', {
      createdAt: demoClock.now(),
      expiresAt: null,
    });
    if (!created.ok) {
      return;
    }
    adapter.write('payment.drafts.v1', created.value);
    adapter.write('payment.records.v1', created.value);

    // A key outside the adapter namespace must never be touched.
    store.setItem('unrelated:key', 'external');

    const keys = adapter.keys();
    expect(keys).toHaveLength(2);

    const removed = adapter.clearNamespace();
    expect(removed).toBe(2);
    expect(store.getItem('unrelated:key')).toBe('external');
    expect(adapter.keys()).toHaveLength(0);
  });
});

describe('StorageAdapter in-memory fallback', () => {
  it('degrades to an in-memory fallback when the native store is unusable', () => {
    const adapter = new StorageAdapter({
      kind: STORAGE_KINDS.LOCAL,
      store: new ThrowingStore(),
    });
    expect(adapter.isInMemory()).toBe(true);
  });

  it('still writes and reads through the in-memory fallback', () => {
    const adapter = new StorageAdapter({
      kind: STORAGE_KINDS.LOCAL,
      store: new ThrowingStore(),
    });
    const created = createStoredRecordEnvelope('memory-value', {
      createdAt: demoClock.now(),
      expiresAt: null,
    });
    if (!created.ok) {
      return;
    }
    expect(adapter.write('payment.drafts.v1', created.value)).toBe(true);
    const read = adapter.read('payment.drafts.v1', StringEnvelopeSchema, undefined);
    expect(read?.data).toBe('memory-value');
  });

  it('provisions session and local adapters via the factory helpers', () => {
    const local = createLocalStorageAdapter({ store: new FakeStore() });
    const session = createSessionStorageAdapter({ store: new FakeStore() });
    expect(local.kind).toBe(STORAGE_KINDS.LOCAL);
    expect(session.kind).toBe(STORAGE_KINDS.SESSION);
  });
});

describe('migrationRunner migration and quarantine', () => {
  let store;
  let adapter;

  beforeEach(() => {
    store = new FakeStore();
    adapter = new StorageAdapter({ kind: STORAGE_KINDS.LOCAL, store });
  });

  it('leaves current-version records unchanged', () => {
    const created = createStoredRecordEnvelope('current', {
      createdAt: demoClock.now(),
      expiresAt: null,
    });
    if (!created.ok) {
      return;
    }
    adapter.write('payment.drafts.v1', created.value);

    const summary = runMigrations(adapter, { baseline: 'baseline' });
    expect(summary.scanned).toBe(1);
    expect(summary.unchanged).toBe(1);
    expect(summary.migrated).toBe(0);
    expect(summary.quarantined).toBe(0);
  });

  it('quarantines unreadable, non-JSON records', () => {
    const key = adapter.buildKey('payment.drafts.v1');
    store.setItem(key, 'not-json{');

    const summary = runMigrations(adapter, { baseline: 'baseline' });
    expect(summary.scanned).toBe(1);
    expect(summary.quarantined).toBe(1);
    expect(store.getItem(key)).toBeNull();
  });

  it('resets records carrying an unknown major version to the baseline', () => {
    const key = adapter.buildKey('payment.drafts.v1');
    store.setItem(
      key,
      JSON.stringify({
        schemaVersion: 'v9',
        createdAt: demoClock.now(),
        expiresAt: null,
        data: 'legacy',
      }),
    );

    const summary = runMigrations(adapter, { baseline: 'baseline-data' });
    expect(summary.reset).toBe(1);

    const read = adapter.read('payment.drafts.v1', StringEnvelopeSchema, undefined);
    expect(read?.schemaVersion).toBe('v1');
    expect(read?.data).toBe('baseline-data');
  });

  it('exposes the documented migration outcome codes', () => {
    expect(MIGRATION_OUTCOMES.UNCHANGED).toBe('unchanged');
    expect(MIGRATION_OUTCOMES.RESET).toBe('reset');
    expect(MIGRATION_OUTCOMES.QUARANTINED).toBe('quarantined');
  });
});

describe('expiryPurge 30-day retention window', () => {
  let store;
  let adapter;

  beforeEach(() => {
    store = new FakeStore();
    adapter = new StorageAdapter({ kind: STORAGE_KINDS.LOCAL, store });
  });

  it('retains a record within its retention window', () => {
    const created = createStoredRecordEnvelope('fresh', {
      createdAt: demoClock.now(),
      expiresAt: null,
    });
    if (!created.ok) {
      return;
    }
    adapter.write('payment.drafts.v1', created.value);

    const summary = runExpiryPurge(adapter);
    expect(summary.scanned).toBe(1);
    expect(summary.retained).toBe(1);
    expect(summary.purged).toBe(0);
  });

  it('purges a record whose explicit expiry is in the past', () => {
    const key = adapter.buildKey('payment.drafts.v1');
    const created = createStoredRecordEnvelope('stale', {
      createdAt: demoClock.addDays(demoClock.now(), -5),
      expiresAt: demoClock.addDays(demoClock.now(), -1),
    });
    if (!created.ok) {
      return;
    }
    adapter.write('payment.drafts.v1', created.value);

    const summary = runExpiryPurge(adapter);
    expect(summary.purged).toBe(1);
    expect(store.getItem(key)).toBeNull();
  });

  it('purges a record whose createdAt is older than the retention window', () => {
    const key = adapter.buildKey('payment.drafts.v1');
    const created = createStoredRecordEnvelope('aged', {
      createdAt: demoClock.addDays(demoClock.now(), -31),
      expiresAt: null,
    });
    if (!created.ok) {
      return;
    }
    adapter.write('payment.drafts.v1', created.value);

    const summary = runExpiryPurge(adapter);
    expect(summary.purged).toBe(1);
    expect(store.getItem(key)).toBeNull();
  });

  it('honors a custom retention window override', () => {
    const created = createStoredRecordEnvelope('recent', {
      createdAt: demoClock.addDays(demoClock.now(), -2),
      expiresAt: null,
    });
    if (!created.ok) {
      return;
    }
    adapter.write('payment.drafts.v1', created.value);

    const summary = runExpiryPurge(adapter, { retentionDays: 1 });
    expect(summary.purged).toBe(1);
  });

  it('exposes the documented purge outcome codes', () => {
    expect(PURGE_OUTCOMES.RETAINED).toBe('retained');
    expect(PURGE_OUTCOMES.PURGED).toBe('purged');
    expect(PURGE_OUTCOMES.SKIPPED).toBe('skipped');
  });
});

describe('PaymentRepository duplicate-reference prevention', () => {
  let repository;

  beforeEach(() => {
    const adapter = new StorageAdapter({ kind: STORAGE_KINDS.LOCAL, store: new FakeStore() });
    repository = createPaymentRepository(adapter);
  });

  it('reserves a submission for a fresh instruction reference', () => {
    const result = repository.reserveSubmission('demo-ref-0001');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.duplicate).toBe(false);
      expect(result.reservation.status).toBe(RESERVATION_STATUS.RESERVED);
    }
  });

  it('rejects a duplicate active instruction reference rather than re-reserving', () => {
    const first = repository.reserveSubmission('demo-ref-0002');
    expect(first.ok).toBe(true);

    const duplicate = repository.reserveSubmission('demo-ref-0002');
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.safeReasonCode).toBe(
        PAYMENT_REPOSITORY_REASON_CODES.DUPLICATE_REFERENCE,
      );
    }
  });

  it('frees a reference for re-reservation once its reservation is released', () => {
    const first = repository.reserveSubmission('demo-ref-0003');
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    expect(repository.releaseReservation(first.reservation.reservationId)).toBe(true);
    expect(repository.isReferenceReserved('demo-ref-0003')).toBe(false);

    const second = repository.reserveSubmission('demo-ref-0003');
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.duplicate).toBe(false);
    }
  });

  it('commits a reservation and records a recoverable commit marker', () => {
    const reserved = repository.reserveSubmission('demo-ref-0004');
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) {
      return;
    }

    const committed = repository.commitReservation(reserved.reservation.reservationId, {
      metadata: { paymentId: 'demo-pay-0004' },
    });
    expect(committed.ok).toBe(true);
    if (committed.ok) {
      expect(committed.reservation.status).toBe(RESERVATION_STATUS.COMMITTED);
    }

    const marker = repository.getCommitMarker();
    expect(marker).not.toBeNull();
    expect(marker?.instructionReference).toBe('demo-ref-0004');

    const recovery = repository.recoverReservations();
    expect(recovery.committed).toHaveLength(1);
    expect(recovery.commitMarker).not.toBeNull();
  });

  it('rejects reserving an empty instruction reference', () => {
    const result = repository.reserveSubmission('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeReasonCode).toBe(PAYMENT_REPOSITORY_REASON_CODES.PERSIST_FAILED);
    }
  });
});