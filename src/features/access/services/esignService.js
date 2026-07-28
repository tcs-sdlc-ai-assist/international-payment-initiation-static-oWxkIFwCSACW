/**
 * Simulated eSign mock adapter.
 *
 * EsignService resolves predefined eSign ceremony outcomes from the bundled
 * `esignScenarios.json` fixture (via the {@link fixtureRegistry}) with bounded,
 * deterministic latency and {@link AbortSignal} support. It is the single entry
 * point the payment approval flow (SCRUM-825) uses to simulate signing:
 *
 *   - `requestSignature(scenarioRef, options)` runs the mock eSign ceremony for
 *     a chosen scenario (defaulting to the success scenario) and resolves a
 *     discriminated `{ ok, ... }` result carrying the outcome, sanitized safe
 *     reason code, retryability, and the scenario's next-step copy.
 *   - `listScenarios()` returns the sanitized, selectable eSign scenarios so the
 *     UI can offer a scenario picker in the demo.
 *
 * The service is demo-only and non-regulatory: no real signatures are collected
 * and no message ever leaves the app. Results carry only sanitized codes and
 * safe copy — never PII. Invalid input and aborts never throw; they degrade to
 * a discriminated failure result so callers can gate the UI safely.
 */

import { fixtureRegistry, FIXTURE_IDS } from '@/shared/fixtures/fixtureRegistry';
import { runMockOperation, ABORTED_REASON_CODE } from '@/shared/mock/mockEnvelope';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default minimum simulated eSign latency, in milliseconds. */
const ESIGN_MIN_LATENCY_MS = 120;

/** Default maximum simulated eSign latency, in milliseconds. */
const ESIGN_MAX_LATENCY_MS = 4000;

/** Scenario reference resolved when none is supplied. */
const DEFAULT_SCENARIO_REF = 'demo-scn-esign-success';

/**
 * Safe reason codes surfaced by the eSign service for unexpected states.
 * @type {{
 *   UNEXPECTED: 'esign.error.unexpected',
 *   SCENARIO_NOT_FOUND: 'esign.error.scenario_not_found',
 *   ABORTED: 'esign.error.aborted',
 * }}
 */
export const ESIGN_REASON_CODES = Object.freeze({
  UNEXPECTED: 'esign.error.unexpected',
  SCENARIO_NOT_FOUND: 'esign.error.scenario_not_found',
  ABORTED: 'esign.error.aborted',
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
 * Reads the eSign scenarios from the bundled fixture.
 * @returns {Array<Record<string, unknown>>} The scenario records (may be empty).
 */
function readScenarios() {
  const fixture = fixtureRegistry.getFixture(FIXTURE_IDS.ESIGN_SCENARIOS);
  if (!fixture || !Array.isArray(fixture.scenarios)) {
    return [];
  }
  return fixture.scenarios.filter((scenario) => isPlainObject(scenario));
}

/**
 * Reads the eSign outcomes from the bundled fixture, indexed by id.
 * @returns {Map<string, Record<string, unknown>>} The outcome records by id.
 */
function readOutcomes() {
  const fixture = fixtureRegistry.getFixture(FIXTURE_IDS.ESIGN_SCENARIOS);
  const map = new Map();
  if (!fixture || !Array.isArray(fixture.outcomes)) {
    return map;
  }
  for (const outcome of fixture.outcomes) {
    if (isPlainObject(outcome) && typeof outcome.id === 'string' && outcome.id.length > 0) {
      map.set(outcome.id, outcome);
    }
  }
  return map;
}

/**
 * Looks up a single eSign scenario by its reference.
 * @param {string} scenarioRef - The scenario reference.
 * @returns {Record<string, unknown> | undefined} The scenario, or `undefined`.
 */
function findScenario(scenarioRef) {
  const ref = toText(scenarioRef) || DEFAULT_SCENARIO_REF;
  return readScenarios().find((scenario) => scenario.scenario_ref === ref);
}

/**
 * Builds a sanitized, display-safe next-step model from a scenario record.
 * @param {Record<string, unknown>} scenario - The raw scenario record.
 * @returns {{
 *   title: string,
 *   body: string,
 *   actionLabel: string,
 *   actionRoute: string,
 * } | null} The sanitized next-step, or `null`.
 */
function toNextStep(scenario) {
  const nextStep = scenario.next_step;
  if (!isPlainObject(nextStep)) {
    return null;
  }
  return {
    title: toText(nextStep.title),
    body: toText(nextStep.body),
    actionLabel: toText(nextStep.action_label),
    actionRoute: toText(nextStep.action_route),
  };
}

/**
 * Resolves whether an outcome is retryable using the outcomes index.
 * @param {string} outcomeId - The outcome identifier.
 * @param {Map<string, Record<string, unknown>>} outcomes - Outcomes by id.
 * @returns {boolean} `true` when the outcome may be retried.
 */
function resolveRetryable(outcomeId, outcomes) {
  const outcome = outcomes.get(outcomeId);
  return Boolean(outcome && outcome.retryable === true);
}

/**
 * Resolves whether an outcome is terminal using the outcomes index.
 * @param {string} outcomeId - The outcome identifier.
 * @param {Map<string, Record<string, unknown>>} outcomes - Outcomes by id.
 * @returns {boolean} `true` when the outcome is terminal.
 */
function resolveTerminal(outcomeId, outcomes) {
  const outcome = outcomes.get(outcomeId);
  return Boolean(outcome && outcome.terminal === true);
}

/**
 * Runs the simulated eSign ceremony for a chosen scenario, resolving a
 * discriminated result carrying the outcome, safe reason code, retryability,
 * and next-step copy.
 *
 * Simulates bounded latency and honors an optional {@link AbortSignal}. Invalid
 * scenario references and aborts never throw; they resolve to a discriminated
 * failure result so callers can degrade gracefully.
 *
 * @param {string} [scenarioRef] - The eSign scenario reference to apply.
 * @param {{ signal?: AbortSignal }} [options] - Optional cancellation options.
 * @returns {Promise<{
 *   ok: true,
 *   outcome: string,
 *   safeReasonCode: string,
 *   retryable: boolean,
 *   terminal: boolean,
 *   scenarioRef: string,
 *   nextStep: {
 *     title: string,
 *     body: string,
 *     actionLabel: string,
 *     actionRoute: string,
 *   } | null,
 * } | {
 *   ok: false,
 *   outcome: string | null,
 *   safeReasonCode: string,
 *   retryable: boolean,
 *   terminal: boolean,
 *   scenarioRef: string,
 *   nextStep: {
 *     title: string,
 *     body: string,
 *     actionLabel: string,
 *     actionRoute: string,
 *   } | null,
 * }>} A discriminated eSign result.
 */
export async function requestSignature(scenarioRef, options) {
  const scenario = findScenario(scenarioRef);
  const resolvedRef = toText(scenarioRef) || DEFAULT_SCENARIO_REF;

  if (!scenario) {
    safeLogger.warn('esignService: scenario not found', { scenarioRef: resolvedRef });
    return {
      ok: false,
      outcome: null,
      safeReasonCode: ESIGN_REASON_CODES.SCENARIO_NOT_FOUND,
      retryable: false,
      terminal: true,
      scenarioRef: resolvedRef,
      nextStep: null,
    };
  }

  const outcomes = readOutcomes();
  const outcomeId = toText(scenario.outcome);
  const mockStatus = toText(scenario.mock_status);
  const safeReasonCode = toText(scenario.safe_reason_code) || ESIGN_REASON_CODES.UNEXPECTED;
  const nextStep = toNextStep(scenario);
  const retryable = resolveRetryable(outcomeId, outcomes);
  const terminal = resolveTerminal(outcomeId, outcomes);

  const minMs =
    typeof scenario.min_latency_ms === 'number' && Number.isFinite(scenario.min_latency_ms)
      ? scenario.min_latency_ms
      : ESIGN_MIN_LATENCY_MS;
  const maxMs =
    typeof scenario.max_latency_ms === 'number' && Number.isFinite(scenario.max_latency_ms)
      ? scenario.max_latency_ms
      : ESIGN_MAX_LATENCY_MS;

  let envelope;
  try {
    envelope = await runMockOperation({
      scenarioId: resolvedRef,
      minMs,
      maxMs,
      shouldFail: mockStatus !== 'success',
      safeReasonCode,
      signal: options ? options.signal : undefined,
    });
  } catch (error) {
    safeLogger.error('esignService: unexpected error during signature request', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return {
      ok: false,
      outcome: outcomeId || null,
      safeReasonCode: ESIGN_REASON_CODES.UNEXPECTED,
      retryable,
      terminal,
      scenarioRef: resolvedRef,
      nextStep,
    };
  }

  if (envelope.safeReasonCode === ABORTED_REASON_CODE) {
    safeLogger.warn('esignService: signature request aborted', { scenarioRef: resolvedRef });
    return {
      ok: false,
      outcome: outcomeId || null,
      safeReasonCode: ESIGN_REASON_CODES.ABORTED,
      retryable: true,
      terminal: false,
      scenarioRef: resolvedRef,
      nextStep,
    };
  }

  if (envelope.status !== 'success') {
    return {
      ok: false,
      outcome: outcomeId || null,
      safeReasonCode,
      retryable,
      terminal,
      scenarioRef: resolvedRef,
      nextStep,
    };
  }

  return {
    ok: true,
    outcome: outcomeId,
    safeReasonCode,
    retryable,
    terminal,
    scenarioRef: resolvedRef,
    nextStep,
  };
}

/**
 * Returns the sanitized, selectable eSign scenarios so the UI can offer a
 * scenario picker in the demo.
 * @returns {Array<{
 *   scenarioRef: string,
 *   outcome: string,
 *   safeReasonCode: string,
 *   retryable: boolean,
 *   terminal: boolean,
 * }>} The sanitized scenario summaries.
 */
export function listScenarios() {
  const outcomes = readOutcomes();
  return readScenarios()
    .map((scenario) => {
      const scenarioRef = toText(scenario.scenario_ref);
      if (scenarioRef.length === 0) {
        return null;
      }
      const outcomeId = toText(scenario.outcome);
      return {
        scenarioRef,
        outcome: outcomeId,
        safeReasonCode: toText(scenario.safe_reason_code) || ESIGN_REASON_CODES.UNEXPECTED,
        retryable: resolveRetryable(outcomeId, outcomes),
        terminal: resolveTerminal(outcomeId, outcomes),
      };
    })
    .filter((summary) => summary !== null);
}

/**
 * The eSign service contract, exposed as a single frozen object.
 * @type {{
 *   requestSignature: typeof requestSignature,
 *   listScenarios: typeof listScenarios,
 *   ESIGN_REASON_CODES: typeof ESIGN_REASON_CODES,
 * }}
 */
export const esignService = Object.freeze({
  requestSignature,
  listScenarios,
  ESIGN_REASON_CODES,
});

export default esignService;