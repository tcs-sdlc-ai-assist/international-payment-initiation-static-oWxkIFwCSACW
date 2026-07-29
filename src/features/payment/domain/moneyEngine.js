/**
 * Integer-minor-units money engine (pure functions).
 *
 * MoneyEngine performs all payment money arithmetic using integer minor units
 * (e.g. cents/pence) and decimal-string parsing driven by per-currency
 * precision, so no binary floating-point drift ever enters a computed amount.
 * It supports the payment initiation flow (SCRUM-813/816):
 *
 *   - `parseAmount(value, precision)` parses a decimal string (or safe number)
 *     into an integer minor-unit amount at the requested precision.
 *   - `formatAmount(minor, precision)` renders an integer minor-unit amount back
 *     into a fixed-precision decimal string.
 *   - `convert(minor, options)` converts a source minor-unit amount into the
 *     beneficiary currency using a decimal-string rate + scale, honoring the
 *     conversion order (source → beneficiary) and deterministic rounding.
 *   - `computeTotalDebit(options)` sums the instructed amount and any fee legs
 *     into a total debit, keeping every leg in integer minor units.
 *
 * All functions are pure: they never mutate their arguments, never touch
 * storage, and never throw for malformed input — they degrade to a discriminated
 * `{ ok, ... }` result carrying a sanitized reason code so callers can gate the
 * UI safely. Rounding follows banker's rounding (half-even) by default to match
 * the fixture policies, with half-up available for explicit opt-in.
 */

import { safeLogger } from '@/shared/logging/safeLogger';

/** Default minor-unit precision applied when none is supplied. */
const DEFAULT_PRECISION = 2;

/** Maximum supported minor-unit precision (guards against runaway scaling). */
const MAX_PRECISION = 8;

/** Default rate scale applied when none is supplied. */
const DEFAULT_RATE_SCALE = 6;

/** Maximum supported rate scale. */
const MAX_RATE_SCALE = 12;

/**
 * Supported deterministic rounding modes.
 * @type {{ HALF_EVEN: 'half_even', HALF_UP: 'half_up' }}
 */
export const ROUNDING_MODES = Object.freeze({
  HALF_EVEN: 'half_even',
  HALF_UP: 'half_up',
});

/**
 * Safe reason codes surfaced by the money engine for gating and messaging.
 * @type {{
 *   INVALID_AMOUNT: 'money.error.invalid_amount',
 *   INVALID_PRECISION: 'money.error.invalid_precision',
 *   INVALID_RATE: 'money.error.invalid_rate',
 *   INVALID_LEG: 'money.error.invalid_leg',
 *   OVERFLOW: 'money.error.overflow',
 * }}
 */
export const MONEY_REASON_CODES = Object.freeze({
  INVALID_AMOUNT: 'money.error.invalid_amount',
  INVALID_PRECISION: 'money.error.invalid_precision',
  INVALID_RATE: 'money.error.invalid_rate',
  INVALID_LEG: 'money.error.invalid_leg',
  OVERFLOW: 'money.error.overflow',
});

/** Matches an optionally-signed decimal string (no scientific notation). */
const DECIMAL_PATTERN = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * Builds a discriminated failure result carrying a sanitized reason code.
 * @param {string} safeReasonCode - The sanitized reason code.
 * @returns {{ ok: false, safeReasonCode: string }} A failure result.
 */
function fail(safeReasonCode) {
  return { ok: false, safeReasonCode };
}

/**
 * Determines whether a value is a plain, non-array object.
 * @param {unknown} value - The candidate value.
 * @returns {boolean} `true` when `value` is a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolves a non-negative integer precision, falling back when unusable.
 * @param {unknown} value - The candidate precision.
 * @param {number} fallback - The value returned when `value` is unusable.
 * @returns {number} A bounded, non-negative integer precision.
 */
function resolvePrecision(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const truncated = Math.trunc(value);
    return truncated <= MAX_PRECISION ? truncated : MAX_PRECISION;
  }
  return fallback;
}

/**
 * Resolves a non-negative integer rate scale, falling back when unusable.
 * @param {unknown} value - The candidate rate scale.
 * @param {number} fallback - The value returned when `value` is unusable.
 * @returns {number} A bounded, non-negative integer rate scale.
 */
function resolveRateScale(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const truncated = Math.trunc(value);
    return truncated <= MAX_RATE_SCALE ? truncated : MAX_RATE_SCALE;
  }
  return fallback;
}

/**
 * Resolves a supported rounding mode, falling back to half-even.
 * @param {unknown} value - The candidate rounding mode.
 * @returns {string} A valid rounding mode from {@link ROUNDING_MODES}.
 */
function resolveRoundingMode(value) {
  return value === ROUNDING_MODES.HALF_UP ? ROUNDING_MODES.HALF_UP : ROUNDING_MODES.HALF_EVEN;
}

/**
 * Normalizes an arbitrary value into a trimmed decimal string.
 * @param {unknown} value - The raw value (decimal string or finite number).
 * @returns {string | null} A trimmed decimal string, or `null` when unusable.
 */
function toDecimalString(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 && DECIMAL_PATTERN.test(trimmed) ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rendered = String(value);
    return DECIMAL_PATTERN.test(rendered) ? rendered : null;
  }
  return null;
}

/**
 * Parses a validated decimal string into signed integer/fraction components.
 * @param {string} decimal - A validated decimal string.
 * @returns {{ negative: boolean, integer: string, fraction: string }} Components.
 */
function splitDecimal(decimal) {
  let negative = false;
  let body = decimal;
  if (body.startsWith('+')) {
    body = body.slice(1);
  } else if (body.startsWith('-')) {
    negative = true;
    body = body.slice(1);
  }
  const dotIndex = body.indexOf('.');
  if (dotIndex < 0) {
    return { negative, integer: body, fraction: '' };
  }
  return {
    negative,
    integer: body.slice(0, dotIndex),
    fraction: body.slice(dotIndex + 1),
  };
}

/**
 * Rounds a scaled numerator by a divisor using the requested rounding mode.
 * @param {bigint} numerator - The signed scaled numerator.
 * @param {bigint} divisor - The positive divisor.
 * @param {string} roundingMode - One of {@link ROUNDING_MODES}.
 * @returns {bigint} The rounded quotient.
 */
function roundDivide(numerator, divisor, roundingMode) {
  if (divisor === 0n) {
    return 0n;
  }
  const negative = numerator < 0n;
  const absNumerator = negative ? -numerator : numerator;
  const quotient = absNumerator / divisor;
  const remainder = absNumerator % divisor;

  if (remainder === 0n) {
    return negative ? -quotient : quotient;
  }

  const twiceRemainder = remainder * 2n;
  let rounded = quotient;

  if (twiceRemainder > divisor) {
    rounded = quotient + 1n;
  } else if (twiceRemainder < divisor) {
    rounded = quotient;
  } else if (roundingMode === ROUNDING_MODES.HALF_UP) {
    rounded = quotient + 1n;
  } else {
    // Half-even: round to the nearest even quotient on an exact tie.
    rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
  }

  return negative ? -rounded : rounded;
}

/**
 * Converts a validated decimal string into an integer minor-unit BigInt at the
 * requested precision, applying deterministic rounding to any excess fraction.
 * @param {string} decimal - A validated decimal string.
 * @param {number} precision - The target minor-unit precision.
 * @param {string} roundingMode - One of {@link ROUNDING_MODES}.
 * @returns {bigint} The signed integer minor-unit amount.
 */
function decimalToMinor(decimal, precision, roundingMode) {
  const { negative, integer, fraction } = splitDecimal(decimal);
  const integerPart = integer.length > 0 ? integer : '0';

  if (fraction.length <= precision) {
    const padded = fraction.padEnd(precision, '0');
    const combined = `${integerPart}${padded}`;
    const magnitude = BigInt(combined.length > 0 ? combined : '0');
    return negative ? -magnitude : magnitude;
  }

  // More fractional digits than precision: keep the retained digits and round
  // using the first discarded digit stream as a fractional remainder.
  const retained = fraction.slice(0, precision);
  const discarded = fraction.slice(precision);
  const baseCombined = `${integerPart}${retained}`;
  const baseMagnitude = BigInt(baseCombined.length > 0 ? baseCombined : '0');

  // Compare the discarded remainder against half the divisor directly, rather
  // than routing through `roundDivide` on the (tiny) remainder/divisor pair:
  // that quotient is always 0 and thus always "even", so half-even ties would
  // otherwise always round down regardless of the retained digits' parity.
  // The correct half-even tie-break depends on whether `baseMagnitude` itself
  // (the value actually being rounded) is odd or even.
  const divisor = 10n ** BigInt(discarded.length);
  const remainderNumerator = BigInt(discarded);
  const twiceRemainder = remainderNumerator * 2n;

  let roundingIncrement = 0n;
  if (twiceRemainder > divisor) {
    roundingIncrement = 1n;
  } else if (twiceRemainder === divisor) {
    roundingIncrement =
      roundingMode === ROUNDING_MODES.HALF_UP || baseMagnitude % 2n !== 0n ? 1n : 0n;
  }
  const magnitude = baseMagnitude + roundingIncrement;

  return negative ? -magnitude : magnitude;
}

/**
 * Renders a signed integer minor-unit BigInt into a fixed-precision decimal
 * string.
 * @param {bigint} minor - The signed integer minor-unit amount.
 * @param {number} precision - The minor-unit precision.
 * @returns {string} A fixed-precision decimal string.
 */
function minorToDecimal(minor, precision) {
  const negative = minor < 0n;
  const absValue = negative ? -minor : minor;
  const digits = absValue.toString();

  if (precision === 0) {
    return negative ? `-${digits}` : digits;
  }

  const padded = digits.padStart(precision + 1, '0');
  const cut = padded.length - precision;
  const integerPart = padded.slice(0, cut);
  const fractionPart = padded.slice(cut);
  const rendered = `${integerPart}.${fractionPart}`;
  return negative ? `-${rendered}` : rendered;
}

/**
 * Parses a decimal amount into an integer minor-unit value at the requested
 * precision, applying deterministic rounding to any excess fraction.
 *
 * Never throws for malformed input; it degrades to a discriminated failure
 * result carrying a sanitized reason code.
 *
 * @param {string | number} value - The decimal amount (string or finite number).
 * @param {number} [precision] - The target minor-unit precision.
 * @param {{ roundingMode?: string }} [options] - Optional rounding options.
 * @returns {{ ok: true, minor: number, minorString: string, precision: number }
 *   | { ok: false, safeReasonCode: string }} A discriminated parse result.
 */
export function parseAmount(value, precision, options) {
  const decimal = toDecimalString(value);
  if (decimal === null) {
    safeLogger.warn('moneyEngine: rejected invalid amount');
    return fail(MONEY_REASON_CODES.INVALID_AMOUNT);
  }

  const resolvedPrecision = resolvePrecision(precision, DEFAULT_PRECISION);
  const roundingMode = resolveRoundingMode(isPlainObject(options) ? options.roundingMode : undefined);

  let minor;
  try {
    minor = decimalToMinor(decimal, resolvedPrecision, roundingMode);
  } catch {
    return fail(MONEY_REASON_CODES.INVALID_AMOUNT);
  }

  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < BigInt(Number.MIN_SAFE_INTEGER)) {
    safeLogger.warn('moneyEngine: parsed amount exceeds safe integer range');
    return fail(MONEY_REASON_CODES.OVERFLOW);
  }

  return {
    ok: true,
    minor: Number(minor),
    minorString: minor.toString(),
    precision: resolvedPrecision,
  };
}

/**
 * Formats an integer minor-unit amount into a fixed-precision decimal string.
 *
 * Accepts a numeric or string-encoded minor-unit value so large amounts can be
 * formatted without floating-point drift. Never throws for malformed input.
 *
 * @param {number | string} minor - The integer minor-unit amount.
 * @param {number} [precision] - The minor-unit precision.
 * @returns {{ ok: true, value: string, precision: number }
 *   | { ok: false, safeReasonCode: string }} A discriminated format result.
 */
export function formatAmount(minor, precision) {
  const resolvedPrecision = resolvePrecision(precision, DEFAULT_PRECISION);

  let minorBig;
  if (typeof minor === 'number' && Number.isFinite(minor) && Number.isInteger(minor)) {
    minorBig = BigInt(minor);
  } else if (typeof minor === 'string' && /^[+-]?\d+$/.test(minor.trim())) {
    try {
      minorBig = BigInt(minor.trim());
    } catch {
      return fail(MONEY_REASON_CODES.INVALID_AMOUNT);
    }
  } else {
    safeLogger.warn('moneyEngine: rejected invalid minor-unit amount');
    return fail(MONEY_REASON_CODES.INVALID_AMOUNT);
  }

  return {
    ok: true,
    value: minorToDecimal(minorBig, resolvedPrecision),
    precision: resolvedPrecision,
  };
}

/**
 * Converts a source minor-unit amount into the beneficiary currency using a
 * decimal-string rate and its scale.
 *
 * The conversion order is source → beneficiary: the source minor-unit amount is
 * multiplied by the scaled rate and re-scaled to the beneficiary precision using
 * deterministic rounding. Never throws for malformed input.
 *
 * @param {number | string} sourceMinor - The source integer minor-unit amount.
 * @param {{
 *   rate: string | number,
 *   rateScale?: number,
 *   sourcePrecision?: number,
 *   beneficiaryPrecision?: number,
 *   roundingMode?: string,
 * }} options - Conversion options.
 * @returns {{
 *   ok: true,
 *   minor: number,
 *   minorString: string,
 *   value: string,
 *   beneficiaryPrecision: number,
 * } | { ok: false, safeReasonCode: string }} A discriminated conversion result.
 */
export function convert(sourceMinor, options) {
  const source = isPlainObject(options) ? options : {};

  let sourceBig;
  if (typeof sourceMinor === 'number' && Number.isFinite(sourceMinor) && Number.isInteger(sourceMinor)) {
    sourceBig = BigInt(sourceMinor);
  } else if (typeof sourceMinor === 'string' && /^[+-]?\d+$/.test(sourceMinor.trim())) {
    try {
      sourceBig = BigInt(sourceMinor.trim());
    } catch {
      return fail(MONEY_REASON_CODES.INVALID_AMOUNT);
    }
  } else {
    safeLogger.warn('moneyEngine: rejected invalid source amount for conversion');
    return fail(MONEY_REASON_CODES.INVALID_AMOUNT);
  }

  const rateDecimal = toDecimalString(source.rate);
  if (rateDecimal === null) {
    safeLogger.warn('moneyEngine: rejected invalid conversion rate');
    return fail(MONEY_REASON_CODES.INVALID_RATE);
  }

  const rateScale = resolveRateScale(source.rateScale, DEFAULT_RATE_SCALE);
  const sourcePrecision = resolvePrecision(source.sourcePrecision, DEFAULT_PRECISION);
  const beneficiaryPrecision = resolvePrecision(source.beneficiaryPrecision, DEFAULT_PRECISION);
  const roundingMode = resolveRoundingMode(source.roundingMode);

  let rateMinor;
  try {
    rateMinor = decimalToMinor(rateDecimal, rateScale, roundingMode);
  } catch {
    return fail(MONEY_REASON_CODES.INVALID_RATE);
  }

  if (rateMinor < 0n || sourceBig < 0n) {
    safeLogger.warn('moneyEngine: rejected negative operand for conversion');
    return fail(MONEY_REASON_CODES.INVALID_RATE);
  }

  // beneficiaryMinor = sourceMinor * rate * 10^(beneficiaryPrecision - sourcePrecision)
  //                  = (sourceBig * rateMinor / 10^rateScale) re-scaled to beneficiary precision.
  const numerator = sourceBig * rateMinor;
  const precisionDelta = beneficiaryPrecision - sourcePrecision;

  let scaledNumerator = numerator;
  let divisor = 10n ** BigInt(rateScale);

  if (precisionDelta > 0) {
    scaledNumerator *= 10n ** BigInt(precisionDelta);
  } else if (precisionDelta < 0) {
    divisor *= 10n ** BigInt(-precisionDelta);
  }

  const beneficiaryBig = roundDivide(scaledNumerator, divisor, roundingMode);

  if (
    beneficiaryBig > BigInt(Number.MAX_SAFE_INTEGER) ||
    beneficiaryBig < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    safeLogger.warn('moneyEngine: converted amount exceeds safe integer range');
    return fail(MONEY_REASON_CODES.OVERFLOW);
  }

  return {
    ok: true,
    minor: Number(beneficiaryBig),
    minorString: beneficiaryBig.toString(),
    value: minorToDecimal(beneficiaryBig, beneficiaryPrecision),
    beneficiaryPrecision,
  };
}

/**
 * Normalizes a single leg amount into an integer minor-unit BigInt.
 * @param {unknown} leg - A numeric or string-encoded minor-unit amount.
 * @returns {bigint | null} The signed minor-unit amount, or `null`.
 */
function toLegMinor(leg) {
  if (typeof leg === 'number' && Number.isFinite(leg) && Number.isInteger(leg)) {
    return BigInt(leg);
  }
  if (typeof leg === 'string' && /^[+-]?\d+$/.test(leg.trim())) {
    try {
      return BigInt(leg.trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Computes the total debit by summing the instructed amount with any fee legs,
 * keeping every leg in integer minor units so no floating-point drift occurs.
 *
 * Every leg must already be expressed in the same debit currency and precision.
 * Never throws for malformed input.
 *
 * @param {{
 *   instructedMinor: number | string,
 *   legs?: Array<number | string>,
 *   precision?: number,
 * }} options - Total-debit options.
 * @returns {{
 *   ok: true,
 *   minor: number,
 *   minorString: string,
 *   value: string,
 *   precision: number,
 * } | { ok: false, safeReasonCode: string }} A discriminated total result.
 */
export function computeTotalDebit(options) {
  const source = isPlainObject(options) ? options : {};

  const instructed = toLegMinor(source.instructedMinor);
  if (instructed === null) {
    safeLogger.warn('moneyEngine: rejected invalid instructed amount');
    return fail(MONEY_REASON_CODES.INVALID_AMOUNT);
  }

  const precision = resolvePrecision(source.precision, DEFAULT_PRECISION);
  const legs = Array.isArray(source.legs) ? source.legs : [];

  let total = instructed;
  for (const leg of legs) {
    const legMinor = toLegMinor(leg);
    if (legMinor === null) {
      safeLogger.warn('moneyEngine: rejected invalid fee leg');
      return fail(MONEY_REASON_CODES.INVALID_LEG);
    }
    total += legMinor;
  }

  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    safeLogger.warn('moneyEngine: total debit exceeds safe integer range');
    return fail(MONEY_REASON_CODES.OVERFLOW);
  }

  return {
    ok: true,
    minor: Number(total),
    minorString: total.toString(),
    value: minorToDecimal(total, precision),
    precision,
  };
}

/**
 * The money engine contract, exposed as a single frozen object.
 * @type {{
 *   parseAmount: typeof parseAmount,
 *   formatAmount: typeof formatAmount,
 *   convert: typeof convert,
 *   computeTotalDebit: typeof computeTotalDebit,
 *   ROUNDING_MODES: typeof ROUNDING_MODES,
 *   MONEY_REASON_CODES: typeof MONEY_REASON_CODES,
 * }}
 */
export const moneyEngine = Object.freeze({
  parseAmount,
  formatAmount,
  convert,
  computeTotalDebit,
  ROUNDING_MODES,
  MONEY_REASON_CODES,
});

export default moneyEngine;