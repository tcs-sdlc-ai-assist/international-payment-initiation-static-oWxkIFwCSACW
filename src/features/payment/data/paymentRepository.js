/**
 * Payment storage repository with duplicate guard.
 *
 * PaymentRepository is the single persistence gateway for the payment cluster's
 * local demo state. It stores four kinds of records under namespaced,
 * versioned {@link StorageAdapter} domains, each wrapped in a validated
 * stored-record envelope:
 *
 *   - `payment.drafts.v1`     — in-progress payment drafts keyed by draft id.
 *   - `payment.records.v1`    — accepted payment snapshots keyed by payment id.
 *   - `payment.reservations.v1` — short-lived submission reservations (with an
 *     active-instruction-reference index) that prevent a duplicate submission
 *     of the same instruction reference, plus a short-lived commit marker that
 *     lets an interrupted submission be recovered on bootstrap.
 *   - `payment.scenarioOverrides.v1` — per-scenario demo overrides keyed by ref.
 *
 * Every read is validated with Zod (via the shared safe-parse helpers) so
 * malformed or tampered records never leak into the app; invalid payloads
 * degrade to an empty collection rather than throwing. Duplicate prevention is
 * client-side only: an active instruction reference is rejected as a duplicate
 * rather than re-submitted, and reservations expire after a bounded window so
 * an abandoned submission never blocks the reference forever.
 *
 * This is a demo-only, non-regulatory store: entries live in local browser
 * storage, are bounded, and carry no server guarantee.
 */

import { STORAGE_DOMAINS } from '@/shared/config/constants';
import { StoredRecordEnvelopeSchema, createStoredRecordEnvelope } from '@/shared/schemas/schemas';
import { demoClock } from '@/shared/time/demoClock';
import { generateOperationId } from '@/shared/mock/mockEnvelope';
import { safeLogger } from '@/shared/logging/safeLogger';
import { z } from 'zod';

/** Storage domain suffix backing the payment drafts. */
const DRAFTS_DOMAIN = STORAGE_DOMAINS.PAYMENT.DRAFTS;

/** Storage domain suffix backing the accepted payment records. */
const RECORDS_DOMAIN = STORAGE_DOMAINS.PAYMENT.RECORDS;

/** Storage domain suffix backing the submission reservations. */
const RESERVATIONS_DOMAIN = STORAGE_DOMAINS.PAYMENT.RESERVATIONS;

/** Storage domain suffix backing the per-scenario overrides. */
const SCENARIO_OVERRIDES_DOMAIN = STORAGE_DOMAINS.PAYMENT.SCENARIO_OVERRIDES;

/** Maximum number of entries retained per collection. */
export const MAX_PAYMENT_ENTRIES = 500;

/** Minutes a submission reservation remains active before it expires. */
export const RESERVATION_TTL_MINUTES = 10;

/** Minutes a commit marker remains valid for interrupted-submission recovery. */
export const COMMIT_MARKER_TTL_MINUTES = 5;

/**
 * Reservation lifecycle statuses.
 * @type {{
 *   RESERVED: 'reserved',
 *   COMMITTED: 'committed',
 *   RELEASED: 'released',
 * }}
 */
export const RESERVATION_STATUS = Object.freeze({
  RESERVED: 'reserved',
  COMMITTED: 'committed',
  RELEASED: 'released',
});

/**
 * Safe reason codes surfaced by the payment repository for gating and messaging.
 * @type {{
 *   RESERVED: 'payment.repository.reserved',
 *   DUPLICATE_REFERENCE: 'payment.repository.duplicate_reference',
 *   PERSIST_FAILED: 'payment.repository.persist_failed',
 *   RESERVATION_NOT_FOUND: 'payment.repository.reservation_not_found',
 *   COMMITTED: 'payment.repository.committed',
 * }}
 */
export const PAYMENT_REPOSITORY_REASON_CODES = Object.freeze({
  RESERVED: 'payment.repository.reserved',
  DUPLICATE_REFERENCE: 'payment.repository.duplicate_reference',
  PERSIST_FAILED: 'payment.repository.persist_failed',
  RESERVATION_NOT_FOUND: 'payment.repository.reservation_not_found',
  COMMITTED: 'payment.repository.committed',
});

/** Schema describing a single persisted payment draft. */
const DraftRecordSchema = z
  .object({
    draftId: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .passthrough();

/** Schema describing the persisted drafts payload (an array of drafts). */
const DraftsSchema = z.array(DraftRecordSchema).default([]);

/** Schema describing the stored envelope wrapping the drafts collection. */
const DraftsEnvelopeSchema = StoredRecordEnvelopeSchema.extend({
  data: DraftsSchema,
});

/** Schema describing a single persisted accepted payment record. */
const PaymentRecordSchema = z
  .object({
    paymentId: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .passthrough();

/** Schema describing the persisted records payload (an array of records). */
const RecordsSchema = z.array(PaymentRecordSchema).default([]);

/** Schema describing the stored envelope wrapping the records collection. */
const RecordsEnvelopeSchema = StoredRecordEnvelopeSchema.extend({
  data: RecordsSchema,
});

/** Schema describing a single persisted submission reservation. */
const ReservationRecordSchema = z
  .object({
    reservationId: z.string().min(1),
    instructionReference: z.string().min(1),
    status: z.string().min(1),
    reservedAt: z.string().min(1),
    expiresAt: z.string().min(1),
  })
  .passthrough();

/** Schema describing a single persisted commit marker. */
const CommitMarkerSchema = z
  .object({
    reservationId: z.string().min(1),
    instructionReference: z.string().min(1),
    markedAt: z.string().min(1),
    expiresAt: z.string().min(1),
  })
  .passthrough();

/** Schema describing the persisted reservations payload. */
const ReservationsPayloadSchema = z
  .object({
    reservations: z.array(ReservationRecordSchema).default([]),
    commitMarker: CommitMarkerSchema.nullable().default(null),
  })
  .passthrough();

/** Schema describing the stored envelope wrapping the reservations payload. */
const ReservationsEnvelopeSchema = StoredRecordEnvelopeSchema.extend({
  data: ReservationsPayloadSchema,
});

/** Schema describing a single persisted scenario override. */
const ScenarioOverrideRecordSchema = z
  .object({
    scenarioRef: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .passthrough();

/** Schema describing the persisted scenario overrides payload. */
const ScenarioOverridesSchema = z.array(ScenarioOverrideRecordSchema).default([]);

/** Schema describing the stored envelope wrapping the scenario overrides. */
const ScenarioOverridesEnvelopeSchema = StoredRecordEnvelopeSchema.extend({
  data: ScenarioOverridesSchema,
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
 * Normalizes an arbitrary value into a trimmed string.
 * @param {unknown} value - The raw value.
 * @returns {string} A trimmed string (empty when unusable).
 */
function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A local, bounded payment repository with client-side duplicate prevention.
 */
export class PaymentRepository {
  /**
   * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
   *   The storage adapter used to persist the payment collections.
   * @param {{ maxEntries?: number, reservationTtlMinutes?: number, commitMarkerTtlMinutes?: number }} [options]
   *   Repository options.
   */
  constructor(adapter, options) {
    if (
      !adapter ||
      typeof adapter.read !== 'function' ||
      typeof adapter.write !== 'function' ||
      typeof adapter.remove !== 'function'
    ) {
      throw new TypeError('PaymentRepository: a valid StorageAdapter is required.');
    }
    /** @type {import('@/shared/storage/storageAdapter').StorageAdapter} */
    this.adapter = adapter;

    const source = isPlainObject(options) ? options : {};
    const requestedMax = source.maxEntries;
    /** @type {number} */
    this.maxEntries =
      typeof requestedMax === 'number' && Number.isFinite(requestedMax) && requestedMax > 0
        ? Math.trunc(requestedMax)
        : MAX_PAYMENT_ENTRIES;

    const requestedReservationTtl = source.reservationTtlMinutes;
    /** @type {number} */
    this.reservationTtlMinutes =
      typeof requestedReservationTtl === 'number' &&
      Number.isFinite(requestedReservationTtl) &&
      requestedReservationTtl > 0
        ? Math.trunc(requestedReservationTtl)
        : RESERVATION_TTL_MINUTES;

    const requestedCommitTtl = source.commitMarkerTtlMinutes;
    /** @type {number} */
    this.commitMarkerTtlMinutes =
      typeof requestedCommitTtl === 'number' &&
      Number.isFinite(requestedCommitTtl) &&
      requestedCommitTtl > 0
        ? Math.trunc(requestedCommitTtl)
        : COMMIT_MARKER_TTL_MINUTES;
  }

  /**
   * Bounds a collection to the configured maximum, dropping oldest entries first.
   * @template T
   * @param {T[]} entries - The collection to bound.
   * @returns {T[]} The bounded collection.
   */
  boundCollection(entries) {
    return entries.length > this.maxEntries
      ? entries.slice(entries.length - this.maxEntries)
      : entries;
  }

  /**
   * Persists an arbitrary payload for a domain, wrapping it in a stored envelope.
   * @param {string} domain - The storage domain suffix.
   * @param {unknown} data - The payload to persist.
   * @returns {boolean} `true` when the write succeeded.
   */
  persist(domain, data) {
    const created = createStoredRecordEnvelope(data, {
      createdAt: demoClock.now(),
      expiresAt: null,
    });
    if (!created.ok) {
      safeLogger.error('paymentRepository: failed to build stored envelope', {
        reason: created.error,
      });
      return false;
    }
    return this.adapter.write(domain, created.value);
  }

  /**
   * Reads and validates the persisted payment drafts.
   * @returns {Array<Record<string, unknown>>} The recorded drafts (may be empty).
   */
  readDrafts() {
    const envelope = this.adapter.read(DRAFTS_DOMAIN, DraftsEnvelopeSchema, undefined);
    if (!envelope || !Array.isArray(envelope.data)) {
      return [];
    }
    return envelope.data;
  }

  /**
   * Looks up a single draft by its identifier.
   * @param {string} draftId - The draft identifier.
   * @returns {Record<string, unknown> | undefined} The draft, or `undefined`.
   */
  findDraft(draftId) {
    const id = toText(draftId);
    if (id.length === 0) {
      return undefined;
    }
    return this.readDrafts().find((draft) => draft.draftId === id);
  }

  /**
   * Saves (creates or updates) a payment draft, bounding the collection.
   *
   * Missing identifiers and timestamps are generated. An existing draft with the
   * same `draftId` is replaced, preserving its original `createdAt`.
   *
   * @param {Record<string, unknown>} draft - The draft to save.
   * @returns {{ ok: true, draft: Record<string, unknown> } | { ok: false, safeReasonCode: string }}
   *   A discriminated result.
   */
  saveDraft(draft) {
    const source = isPlainObject(draft) ? draft : {};
    const drafts = this.readDrafts().slice();
    const draftId = toText(source.draftId) || generateOperationId();
    const now = demoClock.now();
    const existingIndex = drafts.findIndex((item) => item.draftId === draftId);
    const createdAt =
      existingIndex >= 0 && typeof drafts[existingIndex].createdAt === 'string'
        ? drafts[existingIndex].createdAt
        : now;

    const record = { ...source, draftId, createdAt, updatedAt: now };
    const parsed = DraftRecordSchema.safeParse(record);
    if (!parsed.success) {
      safeLogger.warn('paymentRepository: rejected invalid draft record');
      return { ok: false, safeReasonCode: PAYMENT_REPOSITORY_REASON_CODES.PERSIST_FAILED };
    }

    if (existingIndex >= 0) {
      drafts[existingIndex] = parsed.data;
    } else {
      drafts.push(parsed.data);
    }

    const bounded = this.boundCollection(drafts);
    if (!this.persist(DRAFTS_DOMAIN, bounded)) {
      return { ok: false, safeReasonCode: PAYMENT_REPOSITORY_REASON_CODES.PERSIST_FAILED };
    }
    return { ok: true, draft: parsed.data };
  }

  /**
   * Removes a single draft by its identifier.
   * @param {string} draftId - The draft identifier.
   * @returns {boolean} `true` when the collection was persisted.
   */
  removeDraft(draftId) {
    const id = toText(draftId);
    if (id.length === 0) {
      return false;
    }
    const drafts = this.readDrafts().filter((draft) => draft.draftId !== id);
    return this.persist(DRAFTS_DOMAIN, drafts);
  }

  /**
   * Reads and validates the persisted accepted payment records.
   * @returns {Array<Record<string, unknown>>} The recorded payments (may be empty).
   */
  readRecords() {
    const envelope = this.adapter.read(RECORDS_DOMAIN, RecordsEnvelopeSchema, undefined);
    if (!envelope || !Array.isArray(envelope.data)) {
      return [];
    }
    return envelope.data;
  }

  /**
   * Looks up a single accepted payment record by its identifier.
   * @param {string} paymentId - The payment identifier.
   * @returns {Record<string, unknown> | undefined} The record, or `undefined`.
   */
  findRecord(paymentId) {
    const id = toText(paymentId);
    if (id.length === 0) {
      return undefined;
    }
    return this.readRecords().find((record) => record.paymentId === id);
  }

  /**
   * Saves an accepted payment snapshot, bounding the collection. An existing
   * record with the same `paymentId` is replaced, preserving its `createdAt`.
   *
   * @param {Record<string, unknown>} record - The payment snapshot to save.
   * @returns {{ ok: true, record: Record<string, unknown> } | { ok: false, safeReasonCode: string }}
   *   A discriminated result.
   */
  saveRecord(record) {
    const source = isPlainObject(record) ? record : {};
    const records = this.readRecords().slice();
    const paymentId = toText(source.paymentId) || generateOperationId();
    const existingIndex = records.findIndex((item) => item.paymentId === paymentId);
    const createdAt =
      existingIndex >= 0 && typeof records[existingIndex].createdAt === 'string'
        ? records[existingIndex].createdAt
        : demoClock.now();

    const candidate = { ...source, paymentId, createdAt };
    const parsed = PaymentRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      safeLogger.warn('paymentRepository: rejected invalid payment record');
      return { ok: false, safeReasonCode: PAYMENT_REPOSITORY_REASON_CODES.PERSIST_FAILED };
    }

    if (existingIndex >= 0) {
      records[existingIndex] = parsed.data;
    } else {
      records.push(parsed.data);
    }

    const bounded = this.boundCollection(records);
    if (!this.persist(RECORDS_DOMAIN, bounded)) {
      return { ok: false, safeReasonCode: PAYMENT_REPOSITORY_REASON_CODES.PERSIST_FAILED };
    }
    return { ok: true, record: parsed.data };
  }

  /**
   * Reads and validates the persisted reservations payload.
   * @returns {{ reservations: Array<Record<string, unknown>>, commitMarker: Record<string, unknown> | null }}
   *   The reservations payload.
   */
  readReservationsPayload() {
    const envelope = this.adapter.read(RESERVATIONS_DOMAIN, ReservationsEnvelopeSchema, undefined);
    if (!envelope || !isPlainObject(envelope.data)) {
      return { reservations: [], commitMarker: null };
    }
    const data = envelope.data;
    return {
      reservations: Array.isArray(data.reservations) ? data.reservations : [],
      commitMarker: isPlainObject(data.commitMarker) ? data.commitMarker : null,
    };
  }

  /**
   * Persists the supplied reservations payload.
   * @param {{ reservations: Array<Record<string, unknown>>, commitMarker: Record<string, unknown> | null }} payload
   *   The reservations payload to persist.
   * @returns {boolean} `true` when the write succeeded.
   */
  persistReservationsPayload(payload) {
    const reservations = Array.isArray(payload.reservations)
      ? this.boundCollection(payload.reservations)
      : [];
    const commitMarker = isPlainObject(payload.commitMarker) ? payload.commitMarker : null;
    return this.persist(RESERVATIONS_DOMAIN, { reservations, commitMarker });
  }

  /**
   * Determines whether a reservation is still active (reserved and not expired).
   * @param {Record<string, unknown>} reservation - The reservation record.
   * @returns {boolean} `true` when the reservation is active.
   */
  isReservationActive(reservation) {
    if (!isPlainObject(reservation)) {
      return false;
    }
    if (reservation.status !== RESERVATION_STATUS.RESERVED) {
      return false;
    }
    if (typeof reservation.expiresAt !== 'string' || reservation.expiresAt.length === 0) {
      return false;
    }
    return !demoClock.isExpired(reservation.expiresAt);
  }

  /**
   * Prunes expired or released reservations and an expired commit marker.
   * @param {{ reservations: Array<Record<string, unknown>>, commitMarker: Record<string, unknown> | null }} payload
   *   The reservations payload.
   * @returns {{ reservations: Array<Record<string, unknown>>, commitMarker: Record<string, unknown> | null }}
   *   The pruned payload.
   */
  prunePayload(payload) {
    const reservations = payload.reservations.filter((reservation) => {
      if (!isPlainObject(reservation)) {
        return false;
      }
      if (reservation.status === RESERVATION_STATUS.RELEASED) {
        return false;
      }
      if (typeof reservation.expiresAt !== 'string' || reservation.expiresAt.length === 0) {
        return false;
      }
      return !demoClock.isExpired(reservation.expiresAt);
    });

    let commitMarker = payload.commitMarker;
    if (
      isPlainObject(commitMarker) &&
      typeof commitMarker.expiresAt === 'string' &&
      commitMarker.expiresAt.length > 0 &&
      demoClock.isExpired(commitMarker.expiresAt)
    ) {
      commitMarker = null;
    }

    return { reservations, commitMarker };
  }

  /**
   * Builds the active-instruction-reference index from the current reservations.
   * @returns {Map<string, Record<string, unknown>>} Active reservations by reference.
   */
  buildActiveReferenceIndex() {
    const payload = this.prunePayload(this.readReservationsPayload());
    const index = new Map();
    for (const reservation of payload.reservations) {
      if (this.isReservationActive(reservation)) {
        const reference = toText(reservation.instructionReference);
        if (reference.length > 0) {
          index.set(reference, reservation);
        }
      }
    }
    return index;
  }

  /**
   * Reserves a submission for an instruction reference, preventing a duplicate
   * submission of the same active reference.
   *
   * Deny-by-default for duplicates: an already-active reference is rejected
   * rather than re-reserved. Expired reservations are pruned first so an
   * abandoned submission never blocks the reference forever.
   *
   * @param {string} instructionReference - The instruction reference to reserve.
   * @param {{ reservationId?: string, metadata?: Record<string, unknown> }} [options]
   *   Optional reservation options.
   * @returns {{ ok: true, reservation: Record<string, unknown>, duplicate: false }
   *   | { ok: false, safeReasonCode: string, reservation?: Record<string, unknown>, duplicate?: boolean }}
   *   A discriminated result.
   */
  reserveSubmission(instructionReference, options) {
    const reference = toText(instructionReference);
    if (reference.length === 0) {
      return { ok: false, safeReasonCode: PAYMENT_REPOSITORY_REASON_CODES.PERSIST_FAILED };
    }

    const source = isPlainObject(options) ? options : {};
    const payload = this.prunePayload(this.readReservationsPayload());

    const existing = payload.reservations.find(
      (reservation) =>
        this.isReservationActive(reservation) &&
        toText(reservation.instructionReference) === reference,
    );
    if (existing) {
      safeLogger.warn('paymentRepository: rejected duplicate submission reference');
      return {
        ok: false,
        safeReasonCode: PAYMENT_REPOSITORY_REASON_CODES.DUPLICATE_REFERENCE,
        reservation: existing,
        duplicate: true,
      };
    }

    const now = demoClock.now();
    const record = {
      reservationId: toText(source.reservationId) || generateOperationId(),
      instructionReference: reference,
      status: RESERVATION_STATUS.RESERVED,
      reservedAt: now,
      expiresAt: demoClock.addMinutes(now, this.reservationTtlMinutes),
    };
    if (isPlainObject(source.metadata)) {
      record.metadata = source.metadata;
    }

    const parsed = ReservationRecordSchema.safeParse(record);
    if (!parsed.success) {
      safeLogger.warn('paymentRepository: rejected invalid reservation record');
      return { ok: false, safeReasonCode: PAYMENT_REPOSITORY_REASON_CODES.PERSIST_FAILED };
    }

    payload.reservations.push(parsed.data);
    if (!this.persistReservationsPayload(payload)) {
      return { ok: false, safeReasonCode: PAYMENT_REPOSITORY_REASON_CODES.PERSIST_FAILED };
    }
    return { ok: true, reservation: parsed.data, duplicate: false };
  }

  /**
   * Marks an in-flight reservation as committed and records a short-lived commit
   * marker so an interrupted submission can be recovered on bootstrap.
   *
   * @param {string} reservationId - The reservation identifier.
   * @param {{ metadata?: Record<string, unknown> }} [options] - Optional metadata.
   * @returns {{ ok: true, reservation: Record<string, unknown> } | { ok: false, safeReasonCode: string }}
   *   A discriminated result.
   */
  commitReservation(reservationId, options) {
    const id = toText(reservationId);
    if (id.length === 0) {
      return { ok: false, safeReasonCode: PAYMENT_REPOSITORY_REASON_CODES.RESERVATION_NOT_FOUND };
    }

    const payload = this.prunePayload(this.readReservationsPayload());
    const index = payload.reservations.findIndex(
      (reservation) => toText(reservation.reservationId) === id,
    );
    if (index < 0) {
      return { ok: false, safeReasonCode: PAYMENT_REPOSITORY_REASON_CODES.RESERVATION_NOT_FOUND };
    }

    const now = demoClock.now();
    const updated = {
      ...payload.reservations[index],
      status: RESERVATION_STATUS.COMMITTED,
      committedAt: now,
    };
    const source = isPlainObject(options) ? options : {};
    if (isPlainObject(source.metadata)) {
      updated.metadata = { ...(isPlainObject(updated.metadata) ? updated.metadata : {}), ...source.metadata };
    }
    payload.reservations[index] = updated;

    payload.commitMarker = {
      reservationId: id,
      instructionReference: toText(updated.instructionReference),
      markedAt: now,
      expiresAt: demoClock.addMinutes(now, this.commitMarkerTtlMinutes),
    };

    if (!this.persistReservationsPayload(payload)) {
      return { ok: false, safeReasonCode: PAYMENT_REPOSITORY_REASON_CODES.PERSIST_FAILED };
    }
    return { ok: true, reservation: updated };
  }

  /**
   * Releases (removes) a reservation, freeing its instruction reference. When
   * the released reservation matches the commit marker, the marker is cleared.
   *
   * @param {string} reservationId - The reservation identifier.
   * @returns {boolean} `true` when the payload was persisted.
   */
  releaseReservation(reservationId) {
    const id = toText(reservationId);
    if (id.length === 0) {
      return false;
    }
    const payload = this.prunePayload(this.readReservationsPayload());
    payload.reservations = payload.reservations.filter(
      (reservation) => toText(reservation.reservationId) !== id,
    );
    if (
      isPlainObject(payload.commitMarker) &&
      toText(payload.commitMarker.reservationId) === id
    ) {
      payload.commitMarker = null;
    }
    return this.persistReservationsPayload(payload);
  }

  /**
   * Looks up a single reservation by its identifier.
   * @param {string} reservationId - The reservation identifier.
   * @returns {Record<string, unknown> | undefined} The reservation, or `undefined`.
   */
  findReservation(reservationId) {
    const id = toText(reservationId);
    if (id.length === 0) {
      return undefined;
    }
    return this.readReservationsPayload().reservations.find(
      (reservation) => toText(reservation.reservationId) === id,
    );
  }

  /**
   * Determines whether an instruction reference is currently reserved (active).
   * @param {string} instructionReference - The instruction reference.
   * @returns {boolean} `true` when the reference has an active reservation.
   */
  isReferenceReserved(instructionReference) {
    const reference = toText(instructionReference);
    if (reference.length === 0) {
      return false;
    }
    return this.buildActiveReferenceIndex().has(reference);
  }

  /**
   * Returns the short-lived commit marker for interrupted-submission recovery,
   * pruning it when expired.
   * @returns {Record<string, unknown> | null} The commit marker, or `null`.
   */
  getCommitMarker() {
    const payload = this.prunePayload(this.readReservationsPayload());
    return payload.commitMarker;
  }

  /**
   * Recovers reservations left in-flight, returning any active commit marker and
   * the committed reservations that were never released. The pruned payload is
   * persisted so expired reservations and markers are cleaned up on bootstrap.
   *
   * @returns {{
   *   commitMarker: Record<string, unknown> | null,
   *   committed: Array<Record<string, unknown>>,
   *   active: Array<Record<string, unknown>>,
   * }} The recovery snapshot.
   */
  recoverReservations() {
    const payload = this.prunePayload(this.readReservationsPayload());
    this.persistReservationsPayload(payload);

    const committed = payload.reservations.filter(
      (reservation) => reservation.status === RESERVATION_STATUS.COMMITTED,
    );
    const active = payload.reservations.filter((reservation) =>
      this.isReservationActive(reservation),
    );

    return { commitMarker: payload.commitMarker, committed, active };
  }

  /**
   * Reads and validates the persisted scenario overrides.
   * @returns {Array<Record<string, unknown>>} The scenario overrides (may be empty).
   */
  readScenarioOverrides() {
    const envelope = this.adapter.read(
      SCENARIO_OVERRIDES_DOMAIN,
      ScenarioOverridesEnvelopeSchema,
      undefined,
    );
    if (!envelope || !Array.isArray(envelope.data)) {
      return [];
    }
    return envelope.data;
  }

  /**
   * Looks up a single scenario override by its reference.
   * @param {string} scenarioRef - The scenario reference.
   * @returns {Record<string, unknown> | undefined} The override, or `undefined`.
   */
  findScenarioOverride(scenarioRef) {
    const ref = toText(scenarioRef);
    if (ref.length === 0) {
      return undefined;
    }
    return this.readScenarioOverrides().find((override) => override.scenarioRef === ref);
  }

  /**
   * Saves (creates or updates) a scenario override, bounding the collection.
   * @param {Record<string, unknown>} override - The scenario override to save.
   * @returns {{ ok: true, override: Record<string, unknown> } | { ok: false, safeReasonCode: string }}
   *   A discriminated result.
   */
  saveScenarioOverride(override) {
    const source = isPlainObject(override) ? override : {};
    const scenarioRef = toText(source.scenarioRef);
    if (scenarioRef.length === 0) {
      return { ok: false, safeReasonCode: PAYMENT_REPOSITORY_REASON_CODES.PERSIST_FAILED };
    }

    const overrides = this.readScenarioOverrides().slice();
    const record = { ...source, scenarioRef, updatedAt: demoClock.now() };
    const parsed = ScenarioOverrideRecordSchema.safeParse(record);
    if (!parsed.success) {
      safeLogger.warn('paymentRepository: rejected invalid scenario override');
      return { ok: false, safeReasonCode: PAYMENT_REPOSITORY_REASON_CODES.PERSIST_FAILED };
    }

    const existingIndex = overrides.findIndex((item) => item.scenarioRef === scenarioRef);
    if (existingIndex >= 0) {
      overrides[existingIndex] = parsed.data;
    } else {
      overrides.push(parsed.data);
    }

    const bounded = this.boundCollection(overrides);
    if (!this.persist(SCENARIO_OVERRIDES_DOMAIN, bounded)) {
      return { ok: false, safeReasonCode: PAYMENT_REPOSITORY_REASON_CODES.PERSIST_FAILED };
    }
    return { ok: true, override: parsed.data };
  }

  /**
   * Removes a single scenario override by its reference.
   * @param {string} scenarioRef - The scenario reference.
   * @returns {boolean} `true` when the collection was persisted.
   */
  removeScenarioOverride(scenarioRef) {
    const ref = toText(scenarioRef);
    if (ref.length === 0) {
      return false;
    }
    const overrides = this.readScenarioOverrides().filter(
      (override) => override.scenarioRef !== ref,
    );
    return this.persist(SCENARIO_OVERRIDES_DOMAIN, overrides);
  }

  /**
   * Runs a bootstrap cleanup pass across every collection, pruning expired
   * reservations and commit markers and returning the recovery snapshot.
   * @returns {{
   *   commitMarker: Record<string, unknown> | null,
   *   committed: Array<Record<string, unknown>>,
   *   active: Array<Record<string, unknown>>,
   * }} The recovery snapshot after cleanup.
   */
  runCleanup() {
    return this.recoverReservations();
  }

  /**
   * Clears the persisted payment drafts.
   * @returns {boolean} `true` when the drafts were cleared.
   */
  clearDrafts() {
    return this.adapter.remove(DRAFTS_DOMAIN);
  }

  /**
   * Clears the persisted accepted payment records.
   * @returns {boolean} `true` when the records were cleared.
   */
  clearRecords() {
    return this.adapter.remove(RECORDS_DOMAIN);
  }

  /**
   * Clears the persisted submission reservations and commit marker.
   * @returns {boolean} `true` when the reservations were cleared.
   */
  clearReservations() {
    return this.adapter.remove(RESERVATIONS_DOMAIN);
  }

  /**
   * Clears the persisted scenario overrides.
   * @returns {boolean} `true` when the overrides were cleared.
   */
  clearScenarioOverrides() {
    return this.adapter.remove(SCENARIO_OVERRIDES_DOMAIN);
  }
}

/**
 * Creates a {@link PaymentRepository} bound to the supplied storage adapter.
 * @param {import('@/shared/storage/storageAdapter').StorageAdapter} adapter
 *   The storage adapter used to persist the payment collections.
 * @param {{ maxEntries?: number, reservationTtlMinutes?: number, commitMarkerTtlMinutes?: number }} [options]
 *   Repository options.
 * @returns {PaymentRepository} A configured payment repository.
 */
export function createPaymentRepository(adapter, options) {
  return new PaymentRepository(adapter, options);
}

/**
 * The payment repository contract, exposed as a single frozen object.
 * @type {{
 *   PaymentRepository: typeof PaymentRepository,
 *   createPaymentRepository: typeof createPaymentRepository,
 *   RESERVATION_STATUS: typeof RESERVATION_STATUS,
 *   PAYMENT_REPOSITORY_REASON_CODES: typeof PAYMENT_REPOSITORY_REASON_CODES,
 *   MAX_PAYMENT_ENTRIES: typeof MAX_PAYMENT_ENTRIES,
 *   RESERVATION_TTL_MINUTES: typeof RESERVATION_TTL_MINUTES,
 *   COMMIT_MARKER_TTL_MINUTES: typeof COMMIT_MARKER_TTL_MINUTES,
 * }}
 */
export const paymentRepository = Object.freeze({
  PaymentRepository,
  createPaymentRepository,
  RESERVATION_STATUS,
  PAYMENT_REPOSITORY_REASON_CODES,
  MAX_PAYMENT_ENTRIES,
  RESERVATION_TTL_MINUTES,
  COMMIT_MARKER_TTL_MINUTES,
});

export default paymentRepository;