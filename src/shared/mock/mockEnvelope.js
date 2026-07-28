/**
 * Async mock-service envelope and latency simulation helpers.
 *
 * This module builds and validates the versioned mock-service result envelope
 * (see {@link MockResultEnvelopeSchema}), generates demo-safe request and
 * operation references (e.g. `demo-req-...`, `demo-op-...`), and simulates
 * bounded network latency with `AbortSignal` support and configurable failure
 * states.
 *
 * All produced envelopes carry only sanitized codes and safe primitives; raw
 * domain payloads are the caller's responsibility. Latency simulation is bound
 * to the deterministic demo clock for consistent behavior in tests.
 */

import {
  MOCK_RESULT_CONTRACT_VERSION,
  MOCK_RESULT_STATUS,
  parseMockResultEnvelope,
} from '@/shared/schemas/schemas';
import { demoClock } from '@/shared/time/demoClock';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default minimum simulated latency, in milliseconds. */
const DEFAULT_MIN_LATENCY_MS = 120;

/** Default maximum simulated latency, in milliseconds. */
const DEFAULT_MAX_LATENCY_MS = 480;

/** Hard ceiling for simulated latency to keep the demo responsive. */
const MAX_ALLOWED_LATENCY_MS = 5_000;

/** Safe reason code emitted when a simulated request is aborted. */
export const ABORTED_REASON_CODE = 'mock.aborted';

/** Safe reason code emitted when a simulated request fails. */
export const FAILURE_REASON_CODE = 'mock.failure';

/**
 * Prefixes used when generating demo references.
 * @type {{ REQUEST: 'demo-req', OPERATION: 'demo-op', SCENARIO: 'demo-scn' }}
 */
export const REFERENCE_PREFIXES = Object.freeze({
  REQUEST: 'demo-req',
  OPERATION: 'demo-op',
  SCENARIO: 'demo-scn',
});

/** Default scenario identifier used when none is supplied. */
const DEFAULT_SCENARIO_ID = 'demo-scn-default';

/** Characters used to build the random suffix of a demo reference. */
const REFERENCE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Number of random characters appended to a generated reference. */
const REFERENCE_SUFFIX_LENGTH = 8;

/** Monotonic counter ensuring generated references stay unique per session. */
let referenceCounter = 0;

/**
 * Clamps a numeric value into an inclusive range, falling back when unusable.
 * @param {unknown} value - The candidate value.
 * @param {number} min - The lower bound.
 * @param {number} max - The upper bound.
 * @param {number} fallback - Returned when `value` is not a finite number.
 * @returns {number} The clamped value or the fallback.
 */
function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * Generates a short, URL-safe random suffix for demo references.
 * @returns {string} A lowercase alphanumeric suffix.
 */
function randomSuffix() {
  let suffix = '';
  for (let index = 0; index < REFERENCE_SUFFIX_LENGTH; index += 1) {
    const position = Math.floor(Math.random() * REFERENCE_ALPHABET.length);
    suffix += REFERENCE_ALPHABET.charAt(position);
  }
  return suffix;
}

/**
 * Builds a demo reference from a prefix, a monotonic counter, and randomness.
 * @param {string} prefix - A value from {@link REFERENCE_PREFIXES}.
 * @returns {string} A safe, unique demo reference (e.g. `demo-op-0001-abcd1234`).
 */
function buildReference(prefix) {
  referenceCounter += 1;
  const counter = String(referenceCounter).padStart(4, '0');
  return `${prefix}-${counter}-${randomSuffix()}`;
}

/**
 * Generates a demo request reference (e.g. `demo-req-...`).
 * @returns {string} A safe, unique request reference.
 */
export function generateRequestId() {
  return buildReference(REFERENCE_PREFIXES.REQUEST);
}

/**
 * Generates a demo operation reference (e.g. `demo-op-...`).
 * @returns {string} A safe, unique operation reference.
 */
export function generateOperationId() {
  return buildReference(REFERENCE_PREFIXES.OPERATION);
}

/**
 * Generates a demo scenario reference (e.g. `demo-scn-...`).
 * @returns {string} A safe, unique scenario reference.
 */
export function generateScenarioId() {
  return buildReference(REFERENCE_PREFIXES.SCENARIO);
}

/**
 * Normalizes a candidate status to a supported {@link MOCK_RESULT_STATUS}.
 * @param {unknown} status - The requested status.
 * @param {string} fallback - Status returned when `status` is invalid.
 * @returns {string} A valid mock result status.
 */
function resolveStatus(status, fallback) {
  const values = Object.values(MOCK_RESULT_STATUS);
  return typeof status === 'string' && values.includes(status) ? status : fallback;
}

/**
 * Builds and validates a mock-service result envelope.
 *
 * Missing identifiers are auto-generated, and `occurredAt` defaults to the
 * current demo instant. The result is validated against
 * {@link MockResultEnvelopeSchema}; validation failures throw so callers never
 * emit malformed envelopes.
 *
 * @param {{
 *   status: string,
 *   requestId?: string,
 *   scenarioId?: string,
 *   occurredAt?: string,
 *   data?: unknown,
 *   safeReasonCode?: string,
 * }} params - Envelope parameters.
 * @returns {import('@/shared/schemas/schemas').MockResultEnvelope} A validated envelope.
 * @throws {Error} When the constructed envelope fails validation.
 */
export function buildEnvelope(params) {
  const source = params ?? {};
  const candidate = {
    contractVersion: MOCK_RESULT_CONTRACT_VERSION,
    requestId: source.requestId ?? generateRequestId(),
    scenarioId: source.scenarioId ?? DEFAULT_SCENARIO_ID,
    status: resolveStatus(source.status, MOCK_RESULT_STATUS.SUCCESS),
    occurredAt: source.occurredAt ?? demoClock.now(),
  };

  if (source.data !== undefined) {
    candidate.data = source.data;
  }
  if (source.safeReasonCode !== undefined) {
    candidate.safeReasonCode = source.safeReasonCode;
  }

  const parsed = parseMockResultEnvelope(candidate);
  if (!parsed.ok) {
    safeLogger.error('mockEnvelope: failed to build a valid envelope', {
      reason: parsed.error,
    });
    throw new Error(`mockEnvelope: invalid envelope (${parsed.error}).`);
  }
  return parsed.value;
}

/**
 * Builds a success envelope wrapping the supplied data.
 * @param {unknown} data - The payload to wrap.
 * @param {{ requestId?: string, scenarioId?: string, occurredAt?: string }} [meta] - Optional metadata.
 * @returns {import('@/shared/schemas/schemas').MockResultEnvelope} A validated success envelope.
 */
export function buildSuccessEnvelope(data, meta) {
  return buildEnvelope({
    status: MOCK_RESULT_STATUS.SUCCESS,
    data,
    requestId: meta?.requestId,
    scenarioId: meta?.scenarioId,
    occurredAt: meta?.occurredAt,
  });
}

/**
 * Builds an error envelope carrying a safe reason code.
 * @param {string} safeReasonCode - A sanitized reason code.
 * @param {{ requestId?: string, scenarioId?: string, occurredAt?: string, data?: unknown }} [meta] - Optional metadata.
 * @returns {import('@/shared/schemas/schemas').MockResultEnvelope} A validated error envelope.
 */
export function buildErrorEnvelope(safeReasonCode, meta) {
  return buildEnvelope({
    status: MOCK_RESULT_STATUS.ERROR,
    safeReasonCode: safeReasonCode ?? FAILURE_REASON_CODE,
    data: meta?.data,
    requestId: meta?.requestId,
    scenarioId: meta?.scenarioId,
    occurredAt: meta?.occurredAt,
  });
}

/**
 * Builds a pending envelope, typically used while an operation is in flight.
 * @param {{ requestId?: string, scenarioId?: string, occurredAt?: string, data?: unknown }} [meta] - Optional metadata.
 * @returns {import('@/shared/schemas/schemas').MockResultEnvelope} A validated pending envelope.
 */
export function buildPendingEnvelope(meta) {
  return buildEnvelope({
    status: MOCK_RESULT_STATUS.PENDING,
    data: meta?.data,
    requestId: meta?.requestId,
    scenarioId: meta?.scenarioId,
    occurredAt: meta?.occurredAt,
  });
}

/**
 * Validates an arbitrary value as a mock-service result envelope.
 * @param {unknown} value - The value to validate.
 * @returns {import('@/shared/schemas/schemas').ParseSuccess<import('@/shared/schemas/schemas').MockResultEnvelope>
 *   | import('@/shared/schemas/schemas').ParseFailure} A discriminated parse result.
 */
export function validateEnvelope(value) {
  return parseMockResultEnvelope(value);
}

/**
 * Error thrown when a simulated latency wait is aborted via an AbortSignal.
 */
export class MockAbortError extends Error {
  /**
   * @param {string} [message] - Optional message.
   */
  constructor(message = 'mockEnvelope: the simulated request was aborted.') {
    super(message);
    this.name = 'MockAbortError';
    this.safeReasonCode = ABORTED_REASON_CODE;
  }
}

/**
 * Resolves an effective latency window from the supplied options.
 * @param {{ minMs?: number, maxMs?: number, latencyMs?: number }} [options] - Latency options.
 * @returns {number} A latency value in milliseconds.
 */
function resolveLatencyMs(options) {
  const source = options ?? {};
  if (source.latencyMs !== undefined) {
    return clampNumber(source.latencyMs, 0, MAX_ALLOWED_LATENCY_MS, DEFAULT_MIN_LATENCY_MS);
  }
  const min = clampNumber(source.minMs, 0, MAX_ALLOWED_LATENCY_MS, DEFAULT_MIN_LATENCY_MS);
  const maxCandidate = clampNumber(source.maxMs, 0, MAX_ALLOWED_LATENCY_MS, DEFAULT_MAX_LATENCY_MS);
  const max = Math.max(min, maxCandidate);
  const span = max - min;
  return Math.round(min + Math.random() * span);
}

/**
 * Simulates bounded network latency, resolving after a delay and honoring an
 * optional {@link AbortSignal}.
 * @param {{
 *   minMs?: number,
 *   maxMs?: number,
 *   latencyMs?: number,
 *   signal?: AbortSignal,
 * }} [options] - Latency and cancellation options.
 * @returns {Promise<number>} Resolves with the applied delay in milliseconds.
 * @throws {MockAbortError} When the wait is aborted.
 */
export function simulateLatency(options) {
  const source = options ?? {};
  const signal = source.signal;
  const delayMs = resolveLatencyMs(source);

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new MockAbortError());
      return;
    }

    let onAbort = null;

    const timeoutId = setTimeout(() => {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve(delayMs);
    }, delayMs);

    if (signal) {
      onAbort = () => {
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', onAbort);
        reject(new MockAbortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Runs a mock operation with simulated latency, returning a validated envelope.
 *
 * When `shouldFail` is set, an error envelope is produced with the supplied (or
 * default) safe reason code. Aborts are surfaced as an error envelope carrying
 * {@link ABORTED_REASON_CODE} rather than rejecting, so callers always receive a
 * usable result.
 *
 * @param {{
 *   requestId?: string,
 *   scenarioId?: string,
 *   data?: unknown,
 *   shouldFail?: boolean,
 *   safeReasonCode?: string,
 *   minMs?: number,
 *   maxMs?: number,
 *   latencyMs?: number,
 *   signal?: AbortSignal,
 * }} [options] - Operation options.
 * @returns {Promise<import('@/shared/schemas/schemas').MockResultEnvelope>} A validated envelope.
 */
export async function runMockOperation(options) {
  const source = options ?? {};
  const requestId = source.requestId ?? generateRequestId();
  const scenarioId = source.scenarioId ?? DEFAULT_SCENARIO_ID;

  try {
    await simulateLatency({
      minMs: source.minMs,
      maxMs: source.maxMs,
      latencyMs: source.latencyMs,
      signal: source.signal,
    });
  } catch (error) {
    if (error instanceof MockAbortError) {
      safeLogger.warn('mockEnvelope: operation aborted', { scenarioId });
      return buildErrorEnvelope(ABORTED_REASON_CODE, { requestId, scenarioId });
    }
    safeLogger.error('mockEnvelope: unexpected latency error', { scenarioId });
    return buildErrorEnvelope(FAILURE_REASON_CODE, { requestId, scenarioId });
  }

  if (source.shouldFail) {
    return buildErrorEnvelope(source.safeReasonCode ?? FAILURE_REASON_CODE, {
      requestId,
      scenarioId,
      data: source.data,
    });
  }

  return buildSuccessEnvelope(source.data, { requestId, scenarioId });
}

/**
 * The mock envelope contract, exposed as a single frozen object.
 * @type {{
 *   generateRequestId: typeof generateRequestId,
 *   generateOperationId: typeof generateOperationId,
 *   generateScenarioId: typeof generateScenarioId,
 *   buildEnvelope: typeof buildEnvelope,
 *   buildSuccessEnvelope: typeof buildSuccessEnvelope,
 *   buildErrorEnvelope: typeof buildErrorEnvelope,
 *   buildPendingEnvelope: typeof buildPendingEnvelope,
 *   validateEnvelope: typeof validateEnvelope,
 *   simulateLatency: typeof simulateLatency,
 *   runMockOperation: typeof runMockOperation,
 *   MockAbortError: typeof MockAbortError,
 *   REFERENCE_PREFIXES: typeof REFERENCE_PREFIXES,
 *   ABORTED_REASON_CODE: typeof ABORTED_REASON_CODE,
 *   FAILURE_REASON_CODE: typeof FAILURE_REASON_CODE,
 * }}
 */
export const mockEnvelope = Object.freeze({
  generateRequestId,
  generateOperationId,
  generateScenarioId,
  buildEnvelope,
  buildSuccessEnvelope,
  buildErrorEnvelope,
  buildPendingEnvelope,
  validateEnvelope,
  simulateLatency,
  runMockOperation,
  MockAbortError,
  REFERENCE_PREFIXES,
  ABORTED_REASON_CODE,
  FAILURE_REASON_CODE,
});

export default mockEnvelope;