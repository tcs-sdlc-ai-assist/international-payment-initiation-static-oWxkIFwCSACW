/**
 * Local operation and change-request replay ledger.
 *
 * OperationLedger records local operation references under the
 * `access.operations.v1` storage domain and local change requests under the
 * `access.changeRequests.v2` storage domain via a {@link StorageAdapter}. It
 * exists to make demo mutations idempotent and recoverable:
 *
 *   - `recordOperation(entry)` registers an operation reference (e.g. a
 *     confirm/unlock/resend) so it can never be handled twice; a duplicate
 *     `operationId` is rejected rather than re-applied.
 *   - `completeOperation(operationId, ...)` marks an in-flight operation as
 *     committed, supporting replay recovery of incomplete commits.
 *   - `findIncompleteOperations()` returns operations that were started but
 *     never committed, so the app can recover them on bootstrap.
 *   - `recordChangeRequest`/`findChangeRequest` track change requests keyed by
 *     a stable `changeRequestId`.
 *   - `countResendsWithin24h(subjectId)` counts resend operations within the
 *     rolling 24-hour window for client-side resend eligibility.
 *
 * This is a demo-only, non-regulatory ledger: entries live in local browser
 * storage, are bounded, and carry no server guarantee. It is not an append-only
 * or tamper-evident audit trail.
 */

import { STORAGE_DOMAINS, MAX_RESENDS_24H } from '@/shared/config/constants';
import { StoredRecordEnvelopeSchema, createStoredRecordEnvelope } from '@/shared/schemas/schemas';
import { demoClock } from '@/shared/time/demoClock';
import { generateOperationId } from '@/shared/mock/mockEnvelope';
import { safeLogger } from '@/shared/logging/safeLogger';
import { z } from 'zod';

/** Storage domain suffix backing the operation ledger. */
const OPERATIONS_DOMAIN = STORAGE_DOMAINS.ACCESS.OPERATIONS;

/** Storage domain suffix backing the change-request ledger. */
const CHANGE_REQUESTS_DOMAIN = STORAGE_DOMAINS.ACCESS.CHANGE_REQUESTS;

/** Maximum number of ledger entries retained per domain. */
export const MAX_LEDGER_ENTRIES = 500;

/**
 * Operation kinds tracked by the ledger.
 * @type {{
 *   CONFIRM: 'confirm',
 *   UNLOCK: 'unlock',
 *   RESEND: 'resend',
 * }}
 */
export const OPERATION_KINDS = Object.freeze({
  CONFIRM: 'confirm',
  UNLOCK: 'unlock',
  RESEND: 'resend',
});

/**
 * Operation lifecycle statuses.
 * @type {{
 *   STARTED: 'started',
 *   COMPLETED: 'completed',
 * }}
 */
export const OPERATION_STATUS = Object.freeze({
  STARTED: 'started',
  COMPLETED: 'completed',
});

/** Schema describing a single persisted operation record. */
const OperationRecordSchema = z
  .object({
    operationId: z.string().min(1),
    kind: z.string().min(1),
    status: z.string().min(1),
    startedAt: z.string().min(1),
  })
  .passthrough();

/** Schema describing the persisted operations payload (an array of records). */
const OperationsSchema = z.array(OperationRecordSchema).default([]);

/** Schema describing the stored envelope wrapping the operations ledger. */
const OperationsEnvelopeSchema = StoredRecordEnvelopeSchema.extend({
  data: OperationsSchema,
});

/** Schema describing a single persisted change-request record. */
const ChangeRequestRecordSchema = z
  .object({
    changeRequestId: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .passthrough();

/** Schema describing the persisted change-request payload (an array of records). */
const ChangeRequestsSchema = z.array(ChangeRequestRecordSchema).default([]);

/** Schema describing the stored envelope wrapping the change-request ledger. */
const ChangeRequestsEnvelopeSchema = StoredRecordEnvelopeSchema.extend({
  data: ChangeRequestsSchema,
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
 * A local, bounded operation and change-request replay ledger.
 */
export class OperationLedger {
  /**
   * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
   *   The storage adapter used to persist the ledgers.
   * @param {{ maxEntries?: number }} [options] - Ledger options.
   */
  constructor(adapter, options) {
    if (
      !adapter ||
      typeof adapter.read !== 'function' ||
      typeof adapter.write !== 'function' ||
      typeof adapter.remove !== 'function'
    ) {
      throw new TypeError('OperationLedger: a valid StorageAdapter is required.');
    }
    /** @type {import('@/shared/storage/storageAdapter').StorageAdapter} */
    this.adapter = adapter;
    const requested = options?.maxEntries;
    /** @type {number} */
    this.maxEntries =
      typeof requested === 'number' && Number.isFinite(requested) && requested > 0
        ? Math.trunc(requested)
        : MAX_LEDGER_ENTRIES;
  }

  /**
   * Reads and validates the persisted operation records.
   * @returns {Array<Record<string, unknown>>} The recorded operations (may be empty).
   */
  readOperations() {
    const envelope = this.adapter.read(OPERATIONS_DOMAIN, OperationsEnvelopeSchema, undefined);
    if (!envelope || !Array.isArray(envelope.data)) {
      return [];
    }
    return envelope.data;
  }

  /**
   * Persists the supplied operation records, wrapping them in a stored envelope.
   * @param {Array<Record<string, unknown>>} operations - The operations to persist.
   * @returns {boolean} `true` when the write succeeded.
   */
  persistOperations(operations) {
    const created = createStoredRecordEnvelope(operations, {
      createdAt: demoClock.now(),
      expiresAt: null,
    });
    if (!created.ok) {
      safeLogger.error('operationLedger: failed to build operations envelope', {
        reason: created.error,
      });
      return false;
    }
    return this.adapter.write(OPERATIONS_DOMAIN, created.value);
  }

  /**
   * Reads and validates the persisted change-request records.
   * @returns {Array<Record<string, unknown>>} The recorded change requests (may be empty).
   */
  readChangeRequests() {
    const envelope = this.adapter.read(
      CHANGE_REQUESTS_DOMAIN,
      ChangeRequestsEnvelopeSchema,
      undefined,
    );
    if (!envelope || !Array.isArray(envelope.data)) {
      return [];
    }
    return envelope.data;
  }

  /**
   * Persists the supplied change-request records, wrapping them in an envelope.
   * @param {Array<Record<string, unknown>>} changeRequests - The change requests to persist.
   * @returns {boolean} `true` when the write succeeded.
   */
  persistChangeRequests(changeRequests) {
    const created = createStoredRecordEnvelope(changeRequests, {
      createdAt: demoClock.now(),
      expiresAt: null,
    });
    if (!created.ok) {
      safeLogger.error('operationLedger: failed to build change-requests envelope', {
        reason: created.error,
      });
      return false;
    }
    return this.adapter.write(CHANGE_REQUESTS_DOMAIN, created.value);
  }

  /**
   * Looks up a single operation record by its identifier.
   * @param {string} operationId - The operation identifier.
   * @returns {Record<string, unknown> | undefined} The operation, or `undefined`.
   */
  findOperation(operationId) {
    if (typeof operationId !== 'string' || operationId.length === 0) {
      return undefined;
    }
    return this.readOperations().find((record) => record.operationId === operationId);
  }

  /**
   * Determines whether an operation has already been handled (recorded).
   * @param {string} operationId - The operation identifier.
   * @returns {boolean} `true` when the operation is already present.
   */
  hasOperation(operationId) {
    return this.findOperation(operationId) !== undefined;
  }

  /**
   * Records a new operation reference, preventing duplicate handling.
   *
   * Missing identifiers and timestamps are generated. A duplicate
   * `operationId` is rejected rather than re-applied so confirm/unlock/resend
   * operations remain idempotent. The ledger is trimmed to the configured
   * maximum, dropping the oldest entries first.
   *
   * @param {{
   *   operationId?: string,
   *   kind: string,
   *   subjectId?: string,
   *   actorId?: string,
   *   safeReasonCode?: string,
   *   startedAt?: string,
   *   status?: string,
   * }} entry - The operation to record.
   * @returns {{ ok: true, record: Record<string, unknown>, duplicate: boolean }
   *   | { ok: false, error: string }} A discriminated result.
   */
  recordOperation(entry) {
    const source = isPlainObject(entry) ? entry : {};
    const kind = typeof source.kind === 'string' && source.kind.length > 0 ? source.kind : undefined;
    if (kind === undefined) {
      safeLogger.warn('operationLedger: rejected operation without a kind');
      return { ok: false, error: 'missing_kind' };
    }

    const operationId =
      typeof source.operationId === 'string' && source.operationId.length > 0
        ? source.operationId
        : generateOperationId();

    const existing = this.findOperation(operationId);
    if (existing) {
      return { ok: true, record: existing, duplicate: true };
    }

    const record = {
      operationId,
      kind,
      status:
        typeof source.status === 'string' && source.status.length > 0
          ? source.status
          : OPERATION_STATUS.STARTED,
      startedAt:
        typeof source.startedAt === 'string' && source.startedAt.length > 0
          ? source.startedAt
          : demoClock.now(),
    };

    if (typeof source.subjectId === 'string' && source.subjectId.length > 0) {
      record.subjectId = source.subjectId;
    }
    if (typeof source.actorId === 'string' && source.actorId.length > 0) {
      record.actorId = source.actorId;
    }
    if (typeof source.safeReasonCode === 'string' && source.safeReasonCode.length > 0) {
      record.safeReasonCode = source.safeReasonCode;
    }

    const parsed = OperationRecordSchema.safeParse(record);
    if (!parsed.success) {
      safeLogger.warn('operationLedger: rejected invalid operation record');
      return { ok: false, error: 'invalid_operation' };
    }

    const operations = this.readOperations();
    operations.push(parsed.data);

    const bounded =
      operations.length > this.maxEntries
        ? operations.slice(operations.length - this.maxEntries)
        : operations;

    if (!this.persistOperations(bounded)) {
      return { ok: false, error: 'persist_failed' };
    }
    return { ok: true, record: parsed.data, duplicate: false };
  }

  /**
   * Marks an in-flight operation as committed, supporting replay recovery.
   * @param {string} operationId - The operation identifier.
   * @param {{ completedAt?: string, safeReasonCode?: string }} [meta] - Optional metadata.
   * @returns {boolean} `true` when the operation was found and updated.
   */
  completeOperation(operationId, meta) {
    if (typeof operationId !== 'string' || operationId.length === 0) {
      return false;
    }
    const operations = this.readOperations();
    const index = operations.findIndex((record) => record.operationId === operationId);
    if (index < 0) {
      return false;
    }

    const source = isPlainObject(meta) ? meta : {};
    const updated = {
      ...operations[index],
      status: OPERATION_STATUS.COMPLETED,
      completedAt:
        typeof source.completedAt === 'string' && source.completedAt.length > 0
          ? source.completedAt
          : demoClock.now(),
    };
    if (typeof source.safeReasonCode === 'string' && source.safeReasonCode.length > 0) {
      updated.safeReasonCode = source.safeReasonCode;
    }

    operations[index] = updated;
    return this.persistOperations(operations);
  }

  /**
   * Returns operations that were started but never committed, newest-first, so
   * the app can recover incomplete commits on bootstrap.
   * @returns {Array<Record<string, unknown>>} The incomplete operation records.
   */
  findIncompleteOperations() {
    return this.readOperations()
      .filter((record) => record.status !== OPERATION_STATUS.COMPLETED)
      .sort((a, b) => {
        const left = typeof a.startedAt === 'string' ? a.startedAt : '';
        const right = typeof b.startedAt === 'string' ? b.startedAt : '';
        return left < right ? 1 : left > right ? -1 : 0;
      });
  }

  /**
   * Counts resend operations recorded within the rolling 24-hour window,
   * optionally scoped to a subject. Used for client-side resend eligibility.
   * @param {string} [subjectId] - Optional subject to scope the count.
   * @returns {number} The number of resends within the last 24 hours.
   */
  countResendsWithin24h(subjectId) {
    const scoped = typeof subjectId === 'string' && subjectId.length > 0 ? subjectId : undefined;
    return this.readOperations().filter((record) => {
      if (record.kind !== OPERATION_KINDS.RESEND) {
        return false;
      }
      if (scoped !== undefined && record.subjectId !== scoped) {
        return false;
      }
      if (typeof record.startedAt !== 'string' || record.startedAt.length === 0) {
        return false;
      }
      return demoClock.isWithinRolling24h(record.startedAt);
    }).length;
  }

  /**
   * Determines whether a further resend is permitted for a subject within the
   * rolling 24-hour window, enforced client-side only.
   * @param {string} [subjectId] - Optional subject to scope the check.
   * @returns {boolean} `true` when the resend limit has not been reached.
   */
  canResendWithin24h(subjectId) {
    return this.countResendsWithin24h(subjectId) < MAX_RESENDS_24H;
  }

  /**
   * Looks up a single change-request record by its identifier.
   * @param {string} changeRequestId - The change-request identifier.
   * @returns {Record<string, unknown> | undefined} The change request, or `undefined`.
   */
  findChangeRequest(changeRequestId) {
    if (typeof changeRequestId !== 'string' || changeRequestId.length === 0) {
      return undefined;
    }
    return this.readChangeRequests().find(
      (record) => record.changeRequestId === changeRequestId,
    );
  }

  /**
   * Determines whether a change request has already been recorded.
   * @param {string} changeRequestId - The change-request identifier.
   * @returns {boolean} `true` when the change request is already present.
   */
  hasChangeRequest(changeRequestId) {
    return this.findChangeRequest(changeRequestId) !== undefined;
  }

  /**
   * Records a change request, preventing duplicate handling.
   *
   * Missing identifiers and timestamps are generated. A duplicate
   * `changeRequestId` is rejected rather than re-applied. The ledger is trimmed
   * to the configured maximum, dropping the oldest entries first.
   *
   * @param {{
   *   changeRequestId?: string,
   *   subjectId?: string,
   *   actorId?: string,
   *   safeReasonCode?: string,
   *   createdAt?: string,
   *   metadata?: Record<string, unknown>,
   * }} entry - The change request to record.
   * @returns {{ ok: true, record: Record<string, unknown>, duplicate: boolean }
   *   | { ok: false, error: string }} A discriminated result.
   */
  recordChangeRequest(entry) {
    const source = isPlainObject(entry) ? entry : {};
    const changeRequestId =
      typeof source.changeRequestId === 'string' && source.changeRequestId.length > 0
        ? source.changeRequestId
        : generateOperationId();

    const existing = this.findChangeRequest(changeRequestId);
    if (existing) {
      return { ok: true, record: existing, duplicate: true };
    }

    const record = {
      changeRequestId,
      createdAt:
        typeof source.createdAt === 'string' && source.createdAt.length > 0
          ? source.createdAt
          : demoClock.now(),
    };

    if (typeof source.subjectId === 'string' && source.subjectId.length > 0) {
      record.subjectId = source.subjectId;
    }
    if (typeof source.actorId === 'string' && source.actorId.length > 0) {
      record.actorId = source.actorId;
    }
    if (typeof source.safeReasonCode === 'string' && source.safeReasonCode.length > 0) {
      record.safeReasonCode = source.safeReasonCode;
    }
    if (isPlainObject(source.metadata)) {
      record.metadata = source.metadata;
    }

    const parsed = ChangeRequestRecordSchema.safeParse(record);
    if (!parsed.success) {
      safeLogger.warn('operationLedger: rejected invalid change-request record');
      return { ok: false, error: 'invalid_change_request' };
    }

    const changeRequests = this.readChangeRequests();
    changeRequests.push(parsed.data);

    const bounded =
      changeRequests.length > this.maxEntries
        ? changeRequests.slice(changeRequests.length - this.maxEntries)
        : changeRequests;

    if (!this.persistChangeRequests(bounded)) {
      return { ok: false, error: 'persist_failed' };
    }
    return { ok: true, record: parsed.data, duplicate: false };
  }

  /**
   * Returns all recorded operations, newest-first.
   * @returns {Array<Record<string, unknown>>} The operation records.
   */
  listOperations() {
    return this.readOperations()
      .slice()
      .sort((a, b) => {
        const left = typeof a.startedAt === 'string' ? a.startedAt : '';
        const right = typeof b.startedAt === 'string' ? b.startedAt : '';
        return left < right ? 1 : left > right ? -1 : 0;
      });
  }

  /**
   * Returns all recorded change requests, newest-first.
   * @returns {Array<Record<string, unknown>>} The change-request records.
   */
  listChangeRequests() {
    return this.readChangeRequests()
      .slice()
      .sort((a, b) => {
        const left = typeof a.createdAt === 'string' ? a.createdAt : '';
        const right = typeof b.createdAt === 'string' ? b.createdAt : '';
        return left < right ? 1 : left > right ? -1 : 0;
      });
  }

  /**
   * Clears the persisted operation ledger.
   * @returns {boolean} `true` when the ledger was cleared.
   */
  clearOperations() {
    return this.adapter.remove(OPERATIONS_DOMAIN);
  }

  /**
   * Clears the persisted change-request ledger.
   * @returns {boolean} `true` when the ledger was cleared.
   */
  clearChangeRequests() {
    return this.adapter.remove(CHANGE_REQUESTS_DOMAIN);
  }
}

/**
 * Creates an {@link OperationLedger} bound to the supplied storage adapter.
 * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
 *   The storage adapter used to persist the ledgers.
 * @param {{ maxEntries?: number }} [options] - Ledger options.
 * @returns {OperationLedger} A configured operation ledger.
 */
export function createOperationLedger(adapter, options) {
  return new OperationLedger(adapter, options);
}

/**
 * The operation ledger contract, exposed as a single frozen object.
 * @type {{
 *   OperationLedger: typeof OperationLedger,
 *   createOperationLedger: typeof createOperationLedger,
 *   OPERATION_KINDS: typeof OPERATION_KINDS,
 *   OPERATION_STATUS: typeof OPERATION_STATUS,
 *   MAX_LEDGER_ENTRIES: typeof MAX_LEDGER_ENTRIES,
 * }}
 */
export const operationLedger = Object.freeze({
  OperationLedger,
  createOperationLedger,
  OPERATION_KINDS,
  OPERATION_STATUS,
  MAX_LEDGER_ENTRIES,
});

export default operationLedger;