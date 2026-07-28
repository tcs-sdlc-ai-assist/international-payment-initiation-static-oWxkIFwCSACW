/**
 * Shared Zod schemas and contract typedefs.
 *
 * This module is the single source of truth for cross-cutting, versioned
 * contracts shared by both clusters (access + payment):
 *
 *   - {@link SessionClaimV1Schema}      — an authenticated session claim.
 *   - {@link AuditEventV1Schema}         — an append-only audit event envelope.
 *   - {@link MockResultEnvelopeSchema}   — the standard result envelope returned
 *     by the mock/service layer (contractVersion / requestId / scenarioId /
 *     status / occurredAt / data / safeReasonCode).
 *   - {@link StoredRecordEnvelopeSchema} — the persistence envelope wrapping any
 *     stored payload (schemaVersion / createdAt / expiresAt / data).
 *
 * Each schema is paired with a JSDoc typedef and a set of safe validate/parse
 * helpers. Parsing helpers never throw for malformed input; instead they return
 * a discriminated `{ ok, ... }` result so callers can degrade gracefully.
 */

import { z } from 'zod';
import { CAPABILITIES, ROLES } from '@/shared/config/constants';

/** Current contract version for {@link MockResultEnvelopeSchema}. */
export const MOCK_RESULT_CONTRACT_VERSION = 'v1';

/** Current schema version for {@link StoredRecordEnvelopeSchema}. */
export const STORED_RECORD_SCHEMA_VERSION = 'v1';

/** Matches an ISO 8601 instant (loosely: date + time + zone/offset). */
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Matches a safe, sanitized reason/scenario code identifier. */
const SAFE_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Reusable Zod schema for a non-empty ISO 8601 instant string.
 * @type {z.ZodString}
 */
export const IsoInstantSchema = z
  .string()
  .trim()
  .regex(ISO_INSTANT_PATTERN, 'Expected an ISO 8601 instant.')
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: 'Expected a real calendar instant.',
  });

/**
 * Reusable Zod schema for a safe, sanitized code identifier.
 * @type {z.ZodString}
 */
export const SafeCodeSchema = z
  .string()
  .trim()
  .regex(SAFE_CODE_PATTERN, 'Expected a safe code identifier.');

/**
 * Supported statuses for {@link MockResultEnvelopeSchema}.
 * @type {{ SUCCESS: 'success', ERROR: 'error', PENDING: 'pending' }}
 */
export const MOCK_RESULT_STATUS = Object.freeze({
  SUCCESS: 'success',
  ERROR: 'error',
  PENDING: 'pending',
});

/**
 * Zod schema for an authenticated session claim (v1).
 * @type {z.ZodType}
 */
export const SessionClaimV1Schema = z
  .object({
    version: z.literal('v1').default('v1'),
    sessionId: SafeCodeSchema,
    subjectId: SafeCodeSchema,
    roles: z.array(z.nativeEnum(ROLES)).default([]),
    capabilities: z.array(z.nativeEnum(CAPABILITIES)).default([]),
    issuedAt: IsoInstantSchema,
    expiresAt: IsoInstantSchema,
  })
  .strict();

/**
 * An authenticated session claim (v1).
 * @typedef {z.infer<typeof SessionClaimV1Schema>} SessionClaimV1
 */

/**
 * Zod schema for an append-only audit event envelope (v1).
 * @type {z.ZodType}
 */
export const AuditEventV1Schema = z
  .object({
    version: z.literal('v1').default('v1'),
    eventId: SafeCodeSchema,
    eventType: SafeCodeSchema,
    occurredAt: IsoInstantSchema,
    actorId: SafeCodeSchema.optional(),
    subjectId: SafeCodeSchema.optional(),
    safeReasonCode: SafeCodeSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * An append-only audit event envelope (v1).
 * @typedef {z.infer<typeof AuditEventV1Schema>} AuditEventV1
 */

/**
 * Zod schema for the standard mock/service result envelope.
 * @type {z.ZodType}
 */
export const MockResultEnvelopeSchema = z
  .object({
    contractVersion: z.literal(MOCK_RESULT_CONTRACT_VERSION).default(MOCK_RESULT_CONTRACT_VERSION),
    requestId: SafeCodeSchema,
    scenarioId: SafeCodeSchema,
    status: z.nativeEnum(MOCK_RESULT_STATUS),
    occurredAt: IsoInstantSchema,
    data: z.unknown().optional(),
    safeReasonCode: SafeCodeSchema.optional(),
  })
  .strict();

/**
 * The standard mock/service result envelope.
 * @typedef {z.infer<typeof MockResultEnvelopeSchema>} MockResultEnvelope
 */

/**
 * Zod schema for the persistence envelope wrapping any stored payload.
 * @type {z.ZodType}
 */
export const StoredRecordEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(STORED_RECORD_SCHEMA_VERSION).default(STORED_RECORD_SCHEMA_VERSION),
    createdAt: IsoInstantSchema,
    expiresAt: IsoInstantSchema.nullable().optional(),
    data: z.unknown(),
  })
  .strict();

/**
 * The persistence envelope wrapping any stored payload.
 * @typedef {z.infer<typeof StoredRecordEnvelopeSchema>} StoredRecordEnvelope
 */

/**
 * A successful safe-parse result.
 * @template T
 * @typedef {{ ok: true, value: T }} ParseSuccess
 */

/**
 * A failed safe-parse result.
 * @typedef {{ ok: false, error: string, issues: Array<{ path: string, message: string }> }} ParseFailure
 */

/**
 * Flattens Zod issues into a compact, log-safe list.
 * @param {z.ZodError} error - The Zod error to flatten.
 * @returns {Array<{ path: string, message: string }>} Flattened issues.
 */
function flattenIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

/**
 * Safely parses a value against a schema without throwing.
 * @template T
 * @param {z.ZodType<T>} schema - The schema to parse against.
 * @param {unknown} value - The raw value to validate.
 * @returns {ParseSuccess<T> | ParseFailure} A discriminated parse result.
 */
export function safeParseWith(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const issues = flattenIssues(result.error);
  const error = issues.length > 0 ? issues[0].message : 'Validation failed.';
  return { ok: false, error, issues };
}

/**
 * Safely parses a session claim (v1).
 * @param {unknown} value - The raw value to validate.
 * @returns {ParseSuccess<SessionClaimV1> | ParseFailure} A parse result.
 */
export function parseSessionClaimV1(value) {
  return safeParseWith(SessionClaimV1Schema, value);
}

/**
 * Safely parses an audit event envelope (v1).
 * @param {unknown} value - The raw value to validate.
 * @returns {ParseSuccess<AuditEventV1> | ParseFailure} A parse result.
 */
export function parseAuditEventV1(value) {
  return safeParseWith(AuditEventV1Schema, value);
}

/**
 * Safely parses a mock/service result envelope.
 * @param {unknown} value - The raw value to validate.
 * @returns {ParseSuccess<MockResultEnvelope> | ParseFailure} A parse result.
 */
export function parseMockResultEnvelope(value) {
  return safeParseWith(MockResultEnvelopeSchema, value);
}

/**
 * Safely parses a stored record envelope.
 * @param {unknown} value - The raw value to validate.
 * @returns {ParseSuccess<StoredRecordEnvelope> | ParseFailure} A parse result.
 */
export function parseStoredRecordEnvelope(value) {
  return safeParseWith(StoredRecordEnvelopeSchema, value);
}

/**
 * Wraps an arbitrary payload in a validated {@link StoredRecordEnvelope}.
 * @param {unknown} data - The payload to persist.
 * @param {{ createdAt: string, expiresAt?: string | null }} meta - Envelope metadata.
 * @returns {ParseSuccess<StoredRecordEnvelope> | ParseFailure} A parse result.
 */
export function createStoredRecordEnvelope(data, meta) {
  return safeParseWith(StoredRecordEnvelopeSchema, {
    schemaVersion: STORED_RECORD_SCHEMA_VERSION,
    createdAt: meta?.createdAt,
    expiresAt: meta?.expiresAt ?? null,
    data,
  });
}

/**
 * The shared schema contract, exposed as a single frozen object.
 * @type {{
 *   SessionClaimV1Schema: typeof SessionClaimV1Schema,
 *   AuditEventV1Schema: typeof AuditEventV1Schema,
 *   MockResultEnvelopeSchema: typeof MockResultEnvelopeSchema,
 *   StoredRecordEnvelopeSchema: typeof StoredRecordEnvelopeSchema,
 *   MOCK_RESULT_STATUS: typeof MOCK_RESULT_STATUS,
 *   MOCK_RESULT_CONTRACT_VERSION: typeof MOCK_RESULT_CONTRACT_VERSION,
 *   STORED_RECORD_SCHEMA_VERSION: typeof STORED_RECORD_SCHEMA_VERSION,
 *   safeParseWith: typeof safeParseWith,
 *   parseSessionClaimV1: typeof parseSessionClaimV1,
 *   parseAuditEventV1: typeof parseAuditEventV1,
 *   parseMockResultEnvelope: typeof parseMockResultEnvelope,
 *   parseStoredRecordEnvelope: typeof parseStoredRecordEnvelope,
 *   createStoredRecordEnvelope: typeof createStoredRecordEnvelope,
 * }}
 */
export const schemas = Object.freeze({
  SessionClaimV1Schema,
  AuditEventV1Schema,
  MockResultEnvelopeSchema,
  StoredRecordEnvelopeSchema,
  MOCK_RESULT_STATUS,
  MOCK_RESULT_CONTRACT_VERSION,
  STORED_RECORD_SCHEMA_VERSION,
  safeParseWith,
  parseSessionClaimV1,
  parseAuditEventV1,
  parseMockResultEnvelope,
  parseStoredRecordEnvelope,
  createStoredRecordEnvelope,
});

export default schemas;