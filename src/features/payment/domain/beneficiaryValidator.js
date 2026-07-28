/**
 * Beneficiary BIC/IBAN/name validator adapter.
 *
 * BeneficiaryValidator supports the payment initiation flow (SCRUM-815). It
 * performs local, structural BIC/IBAN syntax validation (using the CBPR+ ISO
 * code formats from the bundled `cbprRules.json` fixture, with safe fallbacks)
 * and then resolves a simulated Bankcheck-style outcome from the bundled
 * `beneficiaries.json` fixture (via the {@link fixtureRegistry}) with bounded,
 * deterministic latency and {@link AbortSignal} support:
 *
 *   - `validateSyntax(fields)` runs the local structural checks only and returns
 *     a discriminated `{ ok, ... }` result carrying sanitized field-level issues
 *     and safe reason codes — no PII ever leaves the app.
 *   - `validateBeneficiary(beneficiaryRef, fields, options)` runs the local
 *     syntax checks and, when they pass, runs the mock validation ceremony for
 *     the beneficiary's chosen scenario (defaulting to the success scenario),
 *     resolving the outcome, verification status, confidence score, whether the
 *     result blocks submission or requires manual confirmation, and the
 *     scenario's next-step copy.
 *   - `listScenarios()` returns the sanitized, selectable validation scenarios so
 *     the UI can offer a scenario picker in the demo.
 *
 * The adapter is demo-only and non-regulatory: no real account validation is
 * performed and no message ever leaves the app. Results carry only sanitized
 * codes and safe copy — never PII. Invalid input and aborts never throw; they
 * degrade to a discriminated failure result so callers can gate the UI safely.
 */

import { fixtureRegistry, FIXTURE_IDS } from '@/shared/fixtures/fixtureRegistry';
import { runMockOperation, ABORTED_REASON_CODE } from '@/shared/mock/mockEnvelope';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default minimum simulated validation latency, in milliseconds. */
const VALIDATION_MIN_LATENCY_MS = 200;

/** Default maximum simulated validation latency, in milliseconds. */
const VALIDATION_MAX_LATENCY_MS = 2400;

/** Scenario reference resolved when a beneficiary carries none. */
const DEFAULT_SCENARIO_REF = 'demo-scn-beneficiary-validate-success';

/** Fallback BIC pattern used when the fixture ISO format is unavailable. */
const FALLBACK_BIC_PATTERN = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** Fallback IBAN pattern used when the fixture ISO format is unavailable. */
const FALLBACK_IBAN_PATTERN = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$/;

/**
 * Safe reason codes surfaced by the beneficiary validator.
 * @type {{
 *   MATCHED: 'beneficiary.validation.matched',
 *   NAME_PARTIAL_MATCH: 'beneficiary.validation.name_partial_match',
 *   NAME_MISMATCH: 'beneficiary.validation.name_mismatch',
 *   IBAN_INVALID: 'beneficiary.validation.iban_invalid',
 *   BIC_UNKNOWN: 'beneficiary.validation.bic_unknown',
 *   ACCOUNT_NOT_FOUND: 'beneficiary.validation.account_not_found',
 *   SERVICE_UNAVAILABLE: 'beneficiary.validation.service_unavailable',
 *   NAME_REQUIRED: 'beneficiary.validation.name_required',
 *   SCENARIO_NOT_FOUND: 'beneficiary.validation.scenario_not_found',
 *   ABORTED: 'beneficiary.validation.aborted',
 *   UNEXPECTED: 'beneficiary.validation.unexpected',
 * }}
 */
export const BENEFICIARY_REASON_CODES = Object.freeze({
  MATCHED: 'beneficiary.validation.matched',
  NAME_PARTIAL_MATCH: 'beneficiary.validation.name_partial_match',
  NAME_MISMATCH: 'beneficiary.validation.name_mismatch',
  IBAN_INVALID: 'beneficiary.validation.iban_invalid',
  BIC_UNKNOWN: 'beneficiary.validation.bic_unknown',
  ACCOUNT_NOT_FOUND: 'beneficiary.validation.account_not_found',
  SERVICE_UNAVAILABLE: 'beneficiary.validation.service_unavailable',
  NAME_REQUIRED: 'beneficiary.validation.name_required',
  SCENARIO_NOT_FOUND: 'beneficiary.validation.scenario_not_found',
  ABORTED: 'beneficiary.validation.aborted',
  UNEXPECTED: 'beneficiary.validation.unexpected',
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
 * Resolves a finite number from a candidate value, falling back when unusable.
 * @param {unknown} value - The candidate value.
 * @param {number} fallback - The value returned when `value` is unusable.
 * @returns {number} A finite number.
 */
function toFiniteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Safely compiles a regular-expression string into a RegExp, returning `null`
 * when the pattern is malformed.
 * @param {unknown} pattern - The candidate pattern string.
 * @returns {RegExp | null} The compiled RegExp, or `null`.
 */
function compilePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return null;
  }
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * Reads the CBPR rules fixture envelope.
 * @returns {Record<string, unknown>} The CBPR rules envelope (may be sparse).
 */
function readCbprFixture() {
  const fixture = fixtureRegistry.getFixture(FIXTURE_IDS.CBPR_RULES);
  return isPlainObject(fixture) ? fixture : {};
}

/**
 * Resolves the ISO code pattern for a given format id from the CBPR fixture,
 * falling back to a built-in pattern when the fixture is unavailable.
 * @param {string} formatId - The ISO format identifier (`bic` or `iban`).
 * @param {RegExp} fallback - The built-in fallback pattern.
 * @returns {RegExp} A usable RegExp for the format.
 */
function resolveIsoPattern(formatId, fallback) {
  const fixture = readCbprFixture();
  if (Array.isArray(fixture.isoCodeFormats)) {
    for (const format of fixture.isoCodeFormats) {
      if (isPlainObject(format) && toText(format.id) === formatId) {
        const compiled = compilePattern(format.pattern);
        if (compiled) {
          return compiled;
        }
      }
    }
  }
  return fallback;
}

/**
 * Reads the beneficiary validation scenarios from the bundled fixture.
 * @returns {Array<Record<string, unknown>>} The scenario records (may be empty).
 */
function readScenarios() {
  const fixture = fixtureRegistry.getFixture(FIXTURE_IDS.BENEFICIARIES);
  if (!fixture || !Array.isArray(fixture.validationScenarios)) {
    return [];
  }
  return fixture.validationScenarios.filter((scenario) => isPlainObject(scenario));
}

/**
 * Reads the beneficiary validation outcomes from the bundled fixture, indexed
 * by id.
 * @returns {Map<string, Record<string, unknown>>} The outcome records by id.
 */
function readOutcomes() {
  const fixture = fixtureRegistry.getFixture(FIXTURE_IDS.BENEFICIARIES);
  const map = new Map();
  if (!fixture || !Array.isArray(fixture.validationOutcomes)) {
    return map;
  }
  for (const outcome of fixture.validationOutcomes) {
    if (isPlainObject(outcome) && typeof outcome.id === 'string' && outcome.id.length > 0) {
      map.set(outcome.id, outcome);
    }
  }
  return map;
}

/**
 * Reads the validation policy thresholds from the bundled fixture.
 * @returns {{
 *   fullMatch: number,
 *   partialMatch: number,
 *   minLatency: number,
 *   maxLatency: number,
 * }} The resolved validation policy.
 */
function readValidationPolicy() {
  const fixture = fixtureRegistry.getFixture(FIXTURE_IDS.BENEFICIARIES);
  const policy = isPlainObject(fixture) && isPlainObject(fixture.validationPolicy)
    ? fixture.validationPolicy
    : {};
  return {
    fullMatch: toFiniteNumber(policy.full_match_min_confidence, 90),
    partialMatch: toFiniteNumber(policy.partial_match_min_confidence, 60),
    minLatency: toFiniteNumber(policy.latency_min_ms, VALIDATION_MIN_LATENCY_MS),
    maxLatency: toFiniteNumber(policy.latency_max_ms, VALIDATION_MAX_LATENCY_MS),
  };
}

/**
 * Looks up a single beneficiary validation scenario by its reference.
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
 * Resolves whether an outcome blocks submission using the outcomes index.
 * @param {string} outcomeId - The outcome identifier.
 * @param {Map<string, Record<string, unknown>>} outcomes - Outcomes by id.
 * @returns {boolean} `true` when the outcome blocks submission.
 */
function resolveBlocking(outcomeId, outcomes) {
  const outcome = outcomes.get(outcomeId);
  return Boolean(outcome && outcome.blocking === true);
}

/**
 * Resolves whether an outcome requires manual confirmation using the outcomes
 * index.
 * @param {string} outcomeId - The outcome identifier.
 * @param {Map<string, Record<string, unknown>>} outcomes - Outcomes by id.
 * @returns {boolean} `true` when the outcome requires manual confirmation.
 */
function resolveRequiresConfirmation(outcomeId, outcomes) {
  const outcome = outcomes.get(outcomeId);
  return Boolean(outcome && outcome.requires_confirmation === true);
}

/**
 * Resolves the verification status for an outcome using the outcomes index.
 * @param {string} outcomeId - The outcome identifier.
 * @param {Map<string, Record<string, unknown>>} outcomes - Outcomes by id.
 * @returns {string} The verification status, or an empty string.
 */
function resolveVerificationStatus(outcomeId, outcomes) {
  const outcome = outcomes.get(outcomeId);
  return outcome ? toText(outcome.verification_status) : '';
}

/**
 * Runs the local, structural BIC/IBAN/name syntax validation.
 *
 * The check is deny-by-default for structure: a supplied BIC or IBAN that fails
 * its ISO pattern reports a sanitized issue, and a missing beneficiary name is
 * rejected. Never mutates its arguments and never throws — malformed input
 * degrades to a discriminated failure result.
 *
 * @param {{
 *   beneficiaryName?: string,
 *   iban?: string,
 *   bic?: string,
 * }} fields - The beneficiary fields to validate.
 * @returns {{
 *   ok: boolean,
 *   issues: Array<{ field: string, safeReasonCode: string }>,
 *   safeReasonCode: string,
 * }} A discriminated syntax validation result.
 */
export function validateSyntax(fields) {
  const source = isPlainObject(fields) ? fields : {};
  const issues = [];

  const name = toText(source.beneficiaryName);
  if (name.length === 0) {
    issues.push({ field: 'beneficiaryName', safeReasonCode: BENEFICIARY_REASON_CODES.NAME_REQUIRED });
  }

  const iban = toText(source.iban).replace(/\s+/g, '').toUpperCase();
  if (iban.length > 0) {
    const ibanPattern = resolveIsoPattern('iban', FALLBACK_IBAN_PATTERN);
    if (!ibanPattern.test(iban)) {
      issues.push({ field: 'iban', safeReasonCode: BENEFICIARY_REASON_CODES.IBAN_INVALID });
    }
  }

  const bic = toText(source.bic).replace(/\s+/g, '').toUpperCase();
  if (bic.length > 0) {
    const bicPattern = resolveIsoPattern('bic', FALLBACK_BIC_PATTERN);
    if (!bicPattern.test(bic)) {
      issues.push({ field: 'bic', safeReasonCode: BENEFICIARY_REASON_CODES.BIC_UNKNOWN });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues, safeReasonCode: issues[0].safeReasonCode };
  }

  return { ok: true, issues: [], safeReasonCode: BENEFICIARY_REASON_CODES.MATCHED };
}

/**
 * Validates a beneficiary by running local BIC/IBAN/name syntax checks and,
 * when they pass, the simulated Bankcheck-style validation ceremony for the
 * beneficiary's chosen scenario (defaulting to the success scenario).
 *
 * Simulates bounded latency and honors an optional {@link AbortSignal}. Invalid
 * input, unknown scenarios, and aborts never throw; they resolve to a
 * discriminated failure result so callers can degrade gracefully.
 *
 * @param {string} [scenarioRef] - The validation scenario reference to apply.
 * @param {{
 *   beneficiaryName?: string,
 *   iban?: string,
 *   bic?: string,
 * }} [fields] - The beneficiary fields to validate locally.
 * @param {{ signal?: AbortSignal }} [options] - Optional cancellation options.
 * @returns {Promise<{
 *   ok: boolean,
 *   outcome: string | null,
 *   verificationStatus: string,
 *   confidenceScore: number | null,
 *   blocking: boolean,
 *   requiresConfirmation: boolean,
 *   safeReasonCode: string,
 *   scenarioRef: string,
 *   issues: Array<{ field: string, safeReasonCode: string }>,
 *   nextStep: {
 *     title: string,
 *     body: string,
 *     actionLabel: string,
 *     actionRoute: string,
 *   } | null,
 * }>} A discriminated validation result.
 */
export async function validateBeneficiary(scenarioRef, fields, options) {
  const source = isPlainObject(options) ? options : {};
  const resolvedRef = toText(scenarioRef) || DEFAULT_SCENARIO_REF;

  const syntax = validateSyntax(fields);
  if (!syntax.ok) {
    safeLogger.warn('beneficiaryValidator: local syntax validation failed', {
      safeReasonCode: syntax.safeReasonCode,
    });
    return {
      ok: false,
      outcome: null,
      verificationStatus: 'failed',
      confidenceScore: null,
      blocking: true,
      requiresConfirmation: false,
      safeReasonCode: syntax.safeReasonCode,
      scenarioRef: resolvedRef,
      issues: syntax.issues,
      nextStep: null,
    };
  }

  const scenario = findScenario(scenarioRef);
  if (!scenario) {
    safeLogger.warn('beneficiaryValidator: scenario not found', { scenarioRef: resolvedRef });
    return {
      ok: false,
      outcome: null,
      verificationStatus: 'unverified',
      confidenceScore: null,
      blocking: true,
      requiresConfirmation: false,
      safeReasonCode: BENEFICIARY_REASON_CODES.SCENARIO_NOT_FOUND,
      scenarioRef: resolvedRef,
      issues: [],
      nextStep: null,
    };
  }

  const outcomes = readOutcomes();
  const policy = readValidationPolicy();
  const outcomeId = toText(scenario.outcome);
  const mockStatus = toText(scenario.mock_status);
  const safeReasonCode = toText(scenario.safe_reason_code) || BENEFICIARY_REASON_CODES.UNEXPECTED;
  const nextStep = toNextStep(scenario);
  const blocking = resolveBlocking(outcomeId, outcomes);
  const requiresConfirmation = resolveRequiresConfirmation(outcomeId, outcomes);
  const verificationStatus = resolveVerificationStatus(outcomeId, outcomes);
  const confidenceScore = toFiniteNumber(scenario.confidence_score, null);

  const minMs = toFiniteNumber(scenario.min_latency_ms, policy.minLatency);
  const maxMs = toFiniteNumber(scenario.max_latency_ms, policy.maxLatency);

  let envelope;
  try {
    envelope = await runMockOperation({
      scenarioId: resolvedRef,
      minMs,
      maxMs,
      shouldFail: mockStatus !== 'success',
      safeReasonCode,
      signal: source.signal,
    });
  } catch (error) {
    safeLogger.error('beneficiaryValidator: unexpected error during validation', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return {
      ok: false,
      outcome: outcomeId || null,
      verificationStatus: verificationStatus || 'unverified',
      confidenceScore,
      blocking: true,
      requiresConfirmation: false,
      safeReasonCode: BENEFICIARY_REASON_CODES.UNEXPECTED,
      scenarioRef: resolvedRef,
      issues: [],
      nextStep,
    };
  }

  if (envelope.safeReasonCode === ABORTED_REASON_CODE) {
    safeLogger.warn('beneficiaryValidator: validation aborted', { scenarioRef: resolvedRef });
    return {
      ok: false,
      outcome: outcomeId || null,
      verificationStatus: verificationStatus || 'unverified',
      confidenceScore,
      blocking: true,
      requiresConfirmation: false,
      safeReasonCode: BENEFICIARY_REASON_CODES.ABORTED,
      scenarioRef: resolvedRef,
      issues: [],
      nextStep,
    };
  }

  if (envelope.status !== 'success') {
    return {
      ok: false,
      outcome: outcomeId || null,
      verificationStatus: verificationStatus || 'failed',
      confidenceScore,
      blocking,
      requiresConfirmation,
      safeReasonCode,
      scenarioRef: resolvedRef,
      issues: [],
      nextStep,
    };
  }

  return {
    ok: true,
    outcome: outcomeId,
    verificationStatus: verificationStatus || 'verified',
    confidenceScore,
    blocking,
    requiresConfirmation,
    safeReasonCode,
    scenarioRef: resolvedRef,
    issues: [],
    nextStep,
  };
}

/**
 * Returns the sanitized, selectable beneficiary validation scenarios so the UI
 * can offer a scenario picker in the demo.
 * @returns {Array<{
 *   scenarioRef: string,
 *   outcome: string,
 *   safeReasonCode: string,
 *   verificationStatus: string,
 *   confidenceScore: number | null,
 *   blocking: boolean,
 *   requiresConfirmation: boolean,
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
        safeReasonCode: toText(scenario.safe_reason_code) || BENEFICIARY_REASON_CODES.UNEXPECTED,
        verificationStatus: resolveVerificationStatus(outcomeId, outcomes),
        confidenceScore: toFiniteNumber(scenario.confidence_score, null),
        blocking: resolveBlocking(outcomeId, outcomes),
        requiresConfirmation: resolveRequiresConfirmation(outcomeId, outcomes),
      };
    })
    .filter((summary) => summary !== null);
}

/**
 * The beneficiary validator contract, exposed as a single frozen object.
 * @type {{
 *   validateSyntax: typeof validateSyntax,
 *   validateBeneficiary: typeof validateBeneficiary,
 *   listScenarios: typeof listScenarios,
 *   BENEFICIARY_REASON_CODES: typeof BENEFICIARY_REASON_CODES,
 * }}
 */
export const beneficiaryValidator = Object.freeze({
  validateSyntax,
  validateBeneficiary,
  listScenarios,
  BENEFICIARY_REASON_CODES,
});

export default beneficiaryValidator;