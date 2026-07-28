/**
 * Beneficiary allow/override/block policy engine (pure functions).
 *
 * PolicyEngine maps a simulated beneficiary validation outcome to one of three
 * disposition decisions — ALLOW, ALLOW_WITH_OVERRIDE, or BLOCK — using the
 * confidence thresholds and outcome flags exposed by the bundled
 * `beneficiaries.json` fixture (via the {@link fixtureRegistry}). It supports
 * the payment initiation flow (SCRUM-815):
 *
 *   - `evaluate(result, options)` inspects a beneficiary validation result
 *     (from the {@link beneficiaryValidator}) and resolves a disposition,
 *     honoring the configured full-match / partial-match confidence thresholds
 *     and the outcome's blocking / requires-confirmation flags. When the result
 *     requires manual confirmation, the engine reports ALLOW_WITH_OVERRIDE and
 *     demands a non-empty override reason before the payment may proceed.
 *   - `confirmOverride(result, override, options)` re-evaluates a disposition
 *     together with a supplied override, returning whether the override is
 *     accepted (a valid reason was captured) and the final disposition.
 *   - `getThresholds()` returns the configured confidence thresholds so the UI
 *     can explain how a disposition was derived.
 *
 * All functions are pure: they never mutate their arguments, never touch
 * storage, and never throw for malformed input — they degrade to a BLOCK
 * disposition carrying a sanitized reason code so callers can gate the UI
 * safely. Results carry only sanitized codes and safe copy — never PII and
 * never any restricted screening or scoring reasoning.
 */

import { fixtureRegistry, FIXTURE_IDS } from '@/shared/fixtures/fixtureRegistry';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default full-match minimum confidence when the fixture omits one. */
const DEFAULT_FULL_MATCH_MIN = 90;

/** Default partial-match minimum confidence when the fixture omits one. */
const DEFAULT_PARTIAL_MATCH_MIN = 60;

/** Minimum length of a captured override reason. */
const MIN_OVERRIDE_REASON_LENGTH = 4;

/** Maximum retained length of a captured override reason. */
const MAX_OVERRIDE_REASON_LENGTH = 280;

/**
 * Disposition decisions produced by the policy engine.
 * @type {{
 *   ALLOW: 'allow',
 *   ALLOW_WITH_OVERRIDE: 'allow_with_override',
 *   BLOCK: 'block',
 * }}
 */
export const POLICY_DISPOSITIONS = Object.freeze({
  ALLOW: 'allow',
  ALLOW_WITH_OVERRIDE: 'allow_with_override',
  BLOCK: 'block',
});

/**
 * Safe reason codes surfaced by the policy engine for gating and messaging.
 * @type {{
 *   ALLOWED: 'policy.beneficiary.allowed',
 *   OVERRIDE_REQUIRED: 'policy.beneficiary.override_required',
 *   OVERRIDE_ACCEPTED: 'policy.beneficiary.override_accepted',
 *   OVERRIDE_REASON_REQUIRED: 'policy.beneficiary.override_reason_required',
 *   BLOCKED: 'policy.beneficiary.blocked',
 *   INVALID_RESULT: 'policy.beneficiary.invalid_result',
 * }}
 */
export const POLICY_REASON_CODES = Object.freeze({
  ALLOWED: 'policy.beneficiary.allowed',
  OVERRIDE_REQUIRED: 'policy.beneficiary.override_required',
  OVERRIDE_ACCEPTED: 'policy.beneficiary.override_accepted',
  OVERRIDE_REASON_REQUIRED: 'policy.beneficiary.override_reason_required',
  BLOCKED: 'policy.beneficiary.blocked',
  INVALID_RESULT: 'policy.beneficiary.invalid_result',
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
 * Reads the configured confidence thresholds from the bundled fixture.
 * @returns {{ fullMatch: number, partialMatch: number }} The resolved thresholds.
 */
export function getThresholds() {
  const fixture = fixtureRegistry.getFixture(FIXTURE_IDS.BENEFICIARIES);
  const policy =
    isPlainObject(fixture) && isPlainObject(fixture.validationPolicy)
      ? fixture.validationPolicy
      : {};
  return {
    fullMatch: toFiniteNumber(policy.full_match_min_confidence, DEFAULT_FULL_MATCH_MIN),
    partialMatch: toFiniteNumber(policy.partial_match_min_confidence, DEFAULT_PARTIAL_MATCH_MIN),
  };
}

/**
 * Normalizes and validates a captured override reason.
 * @param {unknown} reason - The raw override reason.
 * @returns {{ ok: true, reason: string } | { ok: false }} A validation result.
 */
function normalizeOverrideReason(reason) {
  const text = toText(reason);
  if (text.length < MIN_OVERRIDE_REASON_LENGTH) {
    return { ok: false };
  }
  const bounded =
    text.length > MAX_OVERRIDE_REASON_LENGTH ? text.slice(0, MAX_OVERRIDE_REASON_LENGTH) : text;
  return { ok: true, reason: bounded };
}

/**
 * Builds a disposition result carrying sanitized codes and safe copy only.
 * @param {string} disposition - One of {@link POLICY_DISPOSITIONS}.
 * @param {string} safeReasonCode - The sanitized reason code.
 * @param {{
 *   requiresOverride?: boolean,
 *   overrideAccepted?: boolean,
 *   overrideReason?: string | null,
 *   confidenceScore?: number | null,
 *   thresholds?: { fullMatch: number, partialMatch: number },
 * }} [meta] - Optional result metadata.
 * @returns {{
 *   disposition: string,
 *   allowed: boolean,
 *   requiresOverride: boolean,
 *   overrideAccepted: boolean,
 *   overrideReason: string | null,
 *   confidenceScore: number | null,
 *   safeReasonCode: string,
 *   thresholds: { fullMatch: number, partialMatch: number },
 * }} A disposition result.
 */
function buildResult(disposition, safeReasonCode, meta) {
  const source = isPlainObject(meta) ? meta : {};
  const thresholds = isPlainObject(source.thresholds) ? source.thresholds : getThresholds();
  const requiresOverride = source.requiresOverride === true;
  const overrideAccepted = source.overrideAccepted === true;
  const allowed =
    disposition === POLICY_DISPOSITIONS.ALLOW ||
    (disposition === POLICY_DISPOSITIONS.ALLOW_WITH_OVERRIDE && overrideAccepted);

  return {
    disposition,
    allowed,
    requiresOverride,
    overrideAccepted,
    overrideReason:
      typeof source.overrideReason === 'string' && source.overrideReason.length > 0
        ? source.overrideReason
        : null,
    confidenceScore:
      typeof source.confidenceScore === 'number' && Number.isFinite(source.confidenceScore)
        ? source.confidenceScore
        : null,
    safeReasonCode,
    thresholds,
  };
}

/**
 * Resolves the base disposition for a validation result, ignoring any override.
 * @param {Record<string, unknown>} result - The validation result.
 * @param {{ fullMatch: number, partialMatch: number }} thresholds - Confidence thresholds.
 * @returns {{ disposition: string, safeReasonCode: string }} The base disposition.
 */
function resolveBaseDisposition(result, thresholds) {
  const blocking = result.blocking === true;
  const requiresConfirmation = result.requiresConfirmation === true;
  const confidenceScore = toFiniteNumber(result.confidenceScore, null);

  if (blocking || result.ok !== true) {
    return {
      disposition: POLICY_DISPOSITIONS.BLOCK,
      safeReasonCode: POLICY_REASON_CODES.BLOCKED,
    };
  }

  if (requiresConfirmation) {
    return {
      disposition: POLICY_DISPOSITIONS.ALLOW_WITH_OVERRIDE,
      safeReasonCode: POLICY_REASON_CODES.OVERRIDE_REQUIRED,
    };
  }

  if (
    typeof confidenceScore === 'number' &&
    confidenceScore < thresholds.fullMatch &&
    confidenceScore >= thresholds.partialMatch
  ) {
    return {
      disposition: POLICY_DISPOSITIONS.ALLOW_WITH_OVERRIDE,
      safeReasonCode: POLICY_REASON_CODES.OVERRIDE_REQUIRED,
    };
  }

  if (typeof confidenceScore === 'number' && confidenceScore < thresholds.partialMatch) {
    return {
      disposition: POLICY_DISPOSITIONS.BLOCK,
      safeReasonCode: POLICY_REASON_CODES.BLOCKED,
    };
  }

  return {
    disposition: POLICY_DISPOSITIONS.ALLOW,
    safeReasonCode: POLICY_REASON_CODES.ALLOWED,
  };
}

/**
 * Maps a beneficiary validation result to an ALLOW / ALLOW_WITH_OVERRIDE /
 * BLOCK disposition per the configured confidence thresholds.
 *
 * The result must originate from the {@link beneficiaryValidator}; only its
 * sanitized flags (`ok`, `blocking`, `requiresConfirmation`) and confidence
 * score are consulted. No restricted screening or scoring reasoning is ever
 * inspected or surfaced. When the disposition is ALLOW_WITH_OVERRIDE and a valid
 * override reason is supplied, the override is accepted here. Never mutates its
 * arguments and never throws — malformed input degrades to a BLOCK disposition.
 *
 * @param {Record<string, unknown>} result - The beneficiary validation result.
 * @param {{ overrideReason?: string }} [options] - Optional override context.
 * @returns {{
 *   disposition: string,
 *   allowed: boolean,
 *   requiresOverride: boolean,
 *   overrideAccepted: boolean,
 *   overrideReason: string | null,
 *   confidenceScore: number | null,
 *   safeReasonCode: string,
 *   thresholds: { fullMatch: number, partialMatch: number },
 * }} A disposition result.
 */
export function evaluate(result, options) {
  const thresholds = getThresholds();

  if (!isPlainObject(result)) {
    safeLogger.warn('policyEngine: rejected invalid validation result');
    return buildResult(POLICY_DISPOSITIONS.BLOCK, POLICY_REASON_CODES.INVALID_RESULT, {
      thresholds,
    });
  }

  const confidenceScore = toFiniteNumber(result.confidenceScore, null);
  const base = resolveBaseDisposition(result, thresholds);

  if (base.disposition !== POLICY_DISPOSITIONS.ALLOW_WITH_OVERRIDE) {
    return buildResult(base.disposition, base.safeReasonCode, {
      requiresOverride: false,
      overrideAccepted: false,
      confidenceScore,
      thresholds,
    });
  }

  const source = isPlainObject(options) ? options : {};
  const normalized = normalizeOverrideReason(source.overrideReason);

  if (!normalized.ok) {
    return buildResult(
      POLICY_DISPOSITIONS.ALLOW_WITH_OVERRIDE,
      POLICY_REASON_CODES.OVERRIDE_REQUIRED,
      {
        requiresOverride: true,
        overrideAccepted: false,
        confidenceScore,
        thresholds,
      },
    );
  }

  return buildResult(
    POLICY_DISPOSITIONS.ALLOW_WITH_OVERRIDE,
    POLICY_REASON_CODES.OVERRIDE_ACCEPTED,
    {
      requiresOverride: true,
      overrideAccepted: true,
      overrideReason: normalized.reason,
      confidenceScore,
      thresholds,
    },
  );
}

/**
 * Re-evaluates a disposition together with a supplied override, requiring a
 * non-empty override reason before an ALLOW_WITH_OVERRIDE disposition may
 * proceed.
 *
 * A BLOCK disposition can never be overridden; only ALLOW_WITH_OVERRIDE
 * dispositions accept a captured reason. Never mutates its arguments and never
 * throws — malformed input degrades to a BLOCK disposition.
 *
 * @param {Record<string, unknown>} result - The beneficiary validation result.
 * @param {{ reason?: string }} override - The captured override.
 * @param {{}} [options] - Reserved for future options.
 * @returns {{
 *   disposition: string,
 *   allowed: boolean,
 *   requiresOverride: boolean,
 *   overrideAccepted: boolean,
 *   overrideReason: string | null,
 *   confidenceScore: number | null,
 *   safeReasonCode: string,
 *   thresholds: { fullMatch: number, partialMatch: number },
 * }} A disposition result.
 */
export function confirmOverride(result, override) {
  const source = isPlainObject(override) ? override : {};
  const evaluated = evaluate(result, { overrideReason: source.reason });

  if (evaluated.disposition !== POLICY_DISPOSITIONS.ALLOW_WITH_OVERRIDE) {
    return evaluated;
  }

  if (!evaluated.overrideAccepted) {
    return buildResult(
      POLICY_DISPOSITIONS.ALLOW_WITH_OVERRIDE,
      POLICY_REASON_CODES.OVERRIDE_REASON_REQUIRED,
      {
        requiresOverride: true,
        overrideAccepted: false,
        confidenceScore: evaluated.confidenceScore,
        thresholds: evaluated.thresholds,
      },
    );
  }

  return evaluated;
}

/**
 * The policy engine contract, exposed as a single frozen object.
 * @type {{
 *   evaluate: typeof evaluate,
 *   confirmOverride: typeof confirmOverride,
 *   getThresholds: typeof getThresholds,
 *   POLICY_DISPOSITIONS: typeof POLICY_DISPOSITIONS,
 *   POLICY_REASON_CODES: typeof POLICY_REASON_CODES,
 * }}
 */
export const policyEngine = Object.freeze({
  evaluate,
  confirmOverride,
  getThresholds,
  POLICY_DISPOSITIONS,
  POLICY_REASON_CODES,
});

export default policyEngine;