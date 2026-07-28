/**
 * Local audit history repository.
 *
 * AuditRepository provides an append-oriented view over demo audit events
 * persisted under the `access.audit.v2` storage domain via a
 * {@link StorageAdapter}. It appends validated {@link AuditEventV1} records,
 * enforces PII masking on any free-form metadata before persistence, supports
 * search/filter over the recorded history, and keeps the history bounded to a
 * maximum number of entries.
 *
 * This repository is intentionally NON-immutable and NON-regulatory: the demo
 * stores sanitized, masked audit entries in local browser storage only. It is
 * not an append-only ledger, provides no tamper evidence, and must never be
 * treated as a compliant audit trail.
 */

import { STORAGE_DOMAINS } from '@/shared/config/constants';
import {
  AuditEventV1Schema,
  parseAuditEventV1,
  createStoredRecordEnvelope,
  StoredRecordEnvelopeSchema,
} from '@/shared/schemas/schemas';
import { maskingPolicy } from '@/shared/privacy/maskingPolicy';
import { demoClock } from '@/shared/time/demoClock';
import { generateOperationId } from '@/shared/mock/mockEnvelope';
import { safeLogger } from '@/shared/logging/safeLogger';
import { z } from 'zod';

/** Storage domain suffix backing the audit history. */
const AUDIT_DOMAIN = STORAGE_DOMAINS.ACCESS.AUDIT;

/** Maximum number of audit entries retained in the bounded history. */
export const MAX_AUDIT_ENTRIES = 500;

/** Masking context applied to persisted audit metadata. */
const AUDIT_MASKING_CONTEXT = maskingPolicy.MASKING_CONTEXTS.AUDIT;

/** Schema describing the persisted audit history payload (an array of events). */
const AuditHistorySchema = z.array(AuditEventV1Schema).default([]);

/** Schema describing the stored envelope wrapping the audit history. */
const AuditEnvelopeSchema = StoredRecordEnvelopeSchema.extend({
  data: AuditHistorySchema,
});

/**
 * Masks any free-form metadata on an audit event before persistence, so that
 * PII never leaks into the stored history.
 * @param {Record<string, unknown> | undefined} metadata - The raw metadata.
 * @returns {Record<string, unknown> | undefined} Sanitized metadata, or `undefined`.
 */
function sanitizeMetadata(metadata) {
  if (metadata === null || metadata === undefined) {
    return undefined;
  }
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const sanitized = maskingPolicy.sanitizeObject(metadata, AUDIT_MASKING_CONTEXT);
  if (sanitized === null || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return undefined;
  }
  return sanitized;
}

/**
 * A local, non-immutable audit history repository backed by a storage adapter.
 */
export class AuditRepository {
  /**
   * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
   *   The storage adapter used to persist the audit history.
   * @param {{ maxEntries?: number }} [options] - Repository options.
   */
  constructor(adapter, options) {
    if (!adapter || typeof adapter.read !== 'function' || typeof adapter.write !== 'function') {
      throw new TypeError('AuditRepository: a valid StorageAdapter is required.');
    }
    /** @type {import('@/shared/storage/storageAdapter').StorageAdapter} */
    this.adapter = adapter;
    const requested = options?.maxEntries;
    /** @type {number} */
    this.maxEntries =
      typeof requested === 'number' && Number.isFinite(requested) && requested > 0
        ? Math.trunc(requested)
        : MAX_AUDIT_ENTRIES;
  }

  /**
   * Reads and validates the persisted audit history.
   * @returns {AuditEventV1[]} The recorded audit events (may be empty).
   */
  readAll() {
    const envelope = this.adapter.read(AUDIT_DOMAIN, AuditEnvelopeSchema, undefined);
    if (!envelope || !Array.isArray(envelope.data)) {
      return [];
    }
    return envelope.data;
  }

  /**
   * Persists the supplied audit history, wrapping it in a stored envelope.
   * @param {AuditEventV1[]} events - The audit events to persist.
   * @returns {boolean} `true` when the write succeeded.
   */
  persist(events) {
    const created = createStoredRecordEnvelope(events, {
      createdAt: demoClock.now(),
      expiresAt: null,
    });
    if (!created.ok) {
      safeLogger.error('auditRepository: failed to build stored envelope', {
        reason: created.error,
      });
      return false;
    }
    return this.adapter.write(AUDIT_DOMAIN, created.value);
  }

  /**
   * Appends a new audit event to the bounded history.
   *
   * Missing identifiers and timestamps are generated, and any free-form
   * metadata is masked before persistence. The history is trimmed to the
   * configured maximum, dropping the oldest entries first.
   *
   * @param {{
   *   eventType: string,
   *   actorId?: string,
   *   subjectId?: string,
   *   safeReasonCode?: string,
   *   metadata?: Record<string, unknown>,
   *   eventId?: string,
   *   occurredAt?: string,
   * }} entry - The audit entry to append.
   * @returns {AuditEventV1 | undefined} The appended event, or `undefined` on failure.
   */
  append(entry) {
    const source = entry ?? {};
    const candidate = {
      version: 'v1',
      eventId: source.eventId ?? generateOperationId(),
      eventType: source.eventType,
      occurredAt: source.occurredAt ?? demoClock.now(),
    };

    if (source.actorId !== undefined) {
      candidate.actorId = source.actorId;
    }
    if (source.subjectId !== undefined) {
      candidate.subjectId = source.subjectId;
    }
    if (source.safeReasonCode !== undefined) {
      candidate.safeReasonCode = source.safeReasonCode;
    }
    const sanitizedMetadata = sanitizeMetadata(source.metadata);
    if (sanitizedMetadata !== undefined) {
      candidate.metadata = sanitizedMetadata;
    }

    const parsed = parseAuditEventV1(candidate);
    if (!parsed.ok) {
      safeLogger.warn('auditRepository: rejected invalid audit entry', {
        reason: parsed.error,
      });
      return undefined;
    }

    const history = this.readAll();
    history.push(parsed.value);

    const bounded =
      history.length > this.maxEntries ? history.slice(history.length - this.maxEntries) : history;

    if (!this.persist(bounded)) {
      return undefined;
    }
    return parsed.value;
  }

  /**
   * Searches the audit history using an optional filter.
   *
   * All filters are combined with AND semantics. `text` performs a
   * case-insensitive substring match across the event type and safe reason
   * code. Results are returned newest-first.
   *
   * @param {{
   *   eventType?: string,
   *   actorId?: string,
   *   subjectId?: string,
   *   safeReasonCode?: string,
   *   text?: string,
   *   since?: string,
   *   until?: string,
   *   limit?: number,
   * }} [filter] - Optional search filter.
   * @returns {AuditEventV1[]} The matching audit events, newest-first.
   */
  search(filter) {
    const source = filter ?? {};
    const text =
      typeof source.text === 'string' && source.text.trim().length > 0
        ? source.text.trim().toLowerCase()
        : undefined;

    let matches = this.readAll().filter((event) => {
      if (source.eventType !== undefined && event.eventType !== source.eventType) {
        return false;
      }
      if (source.actorId !== undefined && event.actorId !== source.actorId) {
        return false;
      }
      if (source.subjectId !== undefined && event.subjectId !== source.subjectId) {
        return false;
      }
      if (source.safeReasonCode !== undefined && event.safeReasonCode !== source.safeReasonCode) {
        return false;
      }
      if (source.since !== undefined && event.occurredAt < source.since) {
        return false;
      }
      if (source.until !== undefined && event.occurredAt > source.until) {
        return false;
      }
      if (text !== undefined) {
        const haystack = `${event.eventType} ${event.safeReasonCode ?? ''}`.toLowerCase();
        if (!haystack.includes(text)) {
          return false;
        }
      }
      return true;
    });

    matches = matches.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));

    if (typeof source.limit === 'number' && Number.isFinite(source.limit) && source.limit >= 0) {
      matches = matches.slice(0, Math.trunc(source.limit));
    }

    return matches;
  }

  /**
   * Returns the entire audit history, newest-first.
   * @returns {AuditEventV1[]} The recorded audit events.
   */
  list() {
    return this.search();
  }

  /**
   * Returns the number of recorded audit events.
   * @returns {number} The history length.
   */
  count() {
    return this.readAll().length;
  }

  /**
   * Clears the entire audit history.
   * @returns {boolean} `true` when the history was cleared.
   */
  clear() {
    return this.adapter.remove(AUDIT_DOMAIN);
  }
}

/**
 * Creates an {@link AuditRepository} bound to the supplied storage adapter.
 * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
 *   The storage adapter used to persist the audit history.
 * @param {{ maxEntries?: number }} [options] - Repository options.
 * @returns {AuditRepository} A configured audit repository.
 */
export function createAuditRepository(adapter, options) {
  return new AuditRepository(adapter, options);
}

/**
 * The audit repository contract, exposed as a single frozen object.
 * @type {{
 *   AuditRepository: typeof AuditRepository,
 *   createAuditRepository: typeof createAuditRepository,
 *   MAX_AUDIT_ENTRIES: typeof MAX_AUDIT_ENTRIES,
 * }}
 */
export const auditRepository = Object.freeze({
  AuditRepository,
  createAuditRepository,
  MAX_AUDIT_ENTRIES,
});

export default auditRepository;