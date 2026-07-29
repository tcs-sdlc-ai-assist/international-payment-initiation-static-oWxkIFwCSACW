/**
 * Pure FX pricing and fee engine.
 *
 * PricingEngine composes the deterministic payment pricing pipeline for the
 * payment initiation flow (SCRUM-813/816). It orchestrates a fixed calculation
 * order using only pure functions and integer-minor-unit money arithmetic (via
 * the {@link moneyEngine}) and the validated reference data indexes exposed by
 * the {@link fixtureRegistry}:
 *
 *   1. Pair eligibility — the currency pair must exist and be eligible.
 *   2. Amount normalization — the instructed decimal is parsed into integer
 *      minor units at the source precision.
 *   3. Tier selection — the applicable fee tier band is resolved from the
 *      dimension key, falling back to the default tier, honoring half-open
 *      amount bands (inclusive lower, exclusive upper) with an inclusive final
 *      band.
 *   4. Rate application — the source amount is converted into the beneficiary
 *      currency using the supplied decimal rate and scale.
 *   5. Counterpart rounding — the converted amount is re-scaled to the
 *      beneficiary settlement precision using deterministic rounding.
 *   6. Fee calculation — the fee is computed from the tier (flat / percentage /
 *      hybrid), bounded by the tier's min/max caps.
 *   7. BEN deduction — for BEN charge treatment the fee is converted into the
 *      beneficiary currency and deducted from the converted settlement amount
 *      so the beneficiary actually receives less; the fee is then displayed
 *      in the beneficiary currency rather than the source currency.
 *   8. Total debit — the instructed amount plus any sender-borne fee legs are
 *      summed into the total debit in the source currency.
 *
 * Every result carries provenance (the selected pair, fee tier, and rule IDs)
 * so the confirmation view can explain how the price was derived. All functions
 * are pure: they never mutate their arguments, never touch storage, and never
 * throw for malformed input — they degrade to a discriminated `{ ok, ... }`
 * result carrying a sanitized reason code so callers can gate the UI safely.
 * This engine contains no restricted pricing, screening, or routing logic.
 */

import { fixtureRegistry } from '@/shared/fixtures/fixtureRegistry';
import { moneyEngine, ROUNDING_MODES } from '@/features/payment/domain/moneyEngine';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default minor-unit precision applied when none is supplied. */
const DEFAULT_PRECISION = 2;

/** Default rate scale applied when a quote does not carry one. */
const DEFAULT_RATE_SCALE = 6;

/** Default rounding mode used across the pricing pipeline. */
const DEFAULT_ROUNDING_MODE = ROUNDING_MODES.HALF_EVEN;

/**
 * Supported fee types resolved from a fee tier.
 * @type {{ FLAT: 'flat', PERCENTAGE: 'percentage', HYBRID: 'hybrid' }}
 */
export const FEE_TYPES = Object.freeze({
  FLAT: 'flat',
  PERCENTAGE: 'percentage',
  HYBRID: 'hybrid',
});

/**
 * Supported charge treatments governing who bears the transaction fee.
 * @type {{ OUR: 'OUR', SHA: 'SHA', BEN: 'BEN' }}
 */
export const CHARGE_TREATMENTS = Object.freeze({
  OUR: 'OUR',
  SHA: 'SHA',
  BEN: 'BEN',
});

/**
 * Safe reason codes surfaced by the pricing engine for gating and messaging.
 * @type {{
 *   PRICED: 'pricing.success.priced',
 *   PAIR_INELIGIBLE: 'pricing.error.pair_ineligible',
 *   INVALID_AMOUNT: 'pricing.error.invalid_amount',
 *   NO_FEE_TIER: 'pricing.error.no_fee_tier',
 *   INVALID_RATE: 'pricing.error.invalid_rate',
 *   INVALID_FEE: 'pricing.error.invalid_fee',
 *   INVALID_TOTAL: 'pricing.error.invalid_total',
 *   UNEXPECTED: 'pricing.error.unexpected',
 * }}
 */
export const PRICING_REASON_CODES = Object.freeze({
  PRICED: 'pricing.success.priced',
  PAIR_INELIGIBLE: 'pricing.error.pair_ineligible',
  INVALID_AMOUNT: 'pricing.error.invalid_amount',
  NO_FEE_TIER: 'pricing.error.no_fee_tier',
  INVALID_RATE: 'pricing.error.invalid_rate',
  INVALID_FEE: 'pricing.error.invalid_fee',
  INVALID_TOTAL: 'pricing.error.invalid_total',
  UNEXPECTED: 'pricing.error.unexpected',
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
 * Builds a discriminated failure result carrying a sanitized reason code.
 * @param {string} safeReasonCode - The sanitized reason code.
 * @returns {{ ok: false, safeReasonCode: string }} A failure result.
 */
function fail(safeReasonCode) {
  return { ok: false, safeReasonCode };
}

/**
 * Resolves a non-negative integer precision, falling back when unusable.
 * @param {unknown} value - The candidate precision.
 * @param {number} fallback - The value returned when `value` is unusable.
 * @returns {number} A finite, non-negative integer precision.
 */
function resolvePrecision(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return fallback;
}

/**
 * Resolves a supported rounding mode, falling back to half-even.
 * @param {unknown} value - The candidate rounding mode.
 * @returns {string} A valid rounding mode from {@link ROUNDING_MODES}.
 */
function resolveRoundingMode(value) {
  return value === ROUNDING_MODES.HALF_UP ? ROUNDING_MODES.HALF_UP : DEFAULT_ROUNDING_MODE;
}

/**
 * Resolves a supported charge treatment, falling back when unusable.
 * @param {unknown} value - The candidate charge treatment.
 * @param {string} fallback - The value returned when `value` is unusable.
 * @returns {string} A valid charge treatment from {@link CHARGE_TREATMENTS}.
 */
function resolveChargeTreatment(value, fallback) {
  const text = toText(value).toUpperCase();
  const values = Object.values(CHARGE_TREATMENTS);
  return values.includes(text) ? text : fallback;
}

/**
 * Parses a decimal amount into an integer minor-unit value at a precision.
 * @param {unknown} value - The decimal amount (string or finite number).
 * @param {number} precision - The target minor-unit precision.
 * @returns {number | null} The parsed integer minor-unit amount, or `null`.
 */
function parseMinor(value, precision) {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = moneyEngine.parseAmount(value, precision, {
    roundingMode: DEFAULT_ROUNDING_MODE,
  });
  return parsed.ok ? parsed.minor : null;
}

/**
 * Determines whether an instructed minor amount falls within a fee-tier band,
 * honoring the tier's inclusive/exclusive boundary flags.
 * @param {Record<string, unknown>} tier - The fee-tier record.
 * @param {number} instructedMinor - The instructed amount in minor units.
 * @param {number} precision - The band precision (minor units).
 * @returns {boolean} `true` when the amount belongs to the band.
 */
function amountWithinBand(tier, instructedMinor, precision) {
  const minInclusive = tier.min_inclusive !== false;
  const maxInclusive = tier.max_inclusive === true;

  const minMinor = parseMinor(tier.min_amount, precision);
  if (minMinor !== null) {
    if (minInclusive ? instructedMinor < minMinor : instructedMinor <= minMinor) {
      return false;
    }
  }

  const hasMax = tier.max_amount !== null && tier.max_amount !== undefined;
  if (hasMax) {
    const maxMinor = parseMinor(tier.max_amount, precision);
    if (maxMinor !== null) {
      if (maxInclusive ? instructedMinor > maxMinor : instructedMinor >= maxMinor) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Selects the applicable fee-tier band for a set of dimensions and instructed
 * amount, falling back to the default tier when no band matches.
 * @param {{
 *   pairId: string,
 *   segment: string,
 *   product: string,
 *   channel: string,
 * }} dimensions - The fee-tier dimensions.
 * @param {number} instructedMinor - The instructed amount in minor units.
 * @param {number} precision - The band precision (minor units).
 * @returns {{ tier: Record<string, unknown>, usedDefault: boolean } | null}
 *   The selected tier and whether the default was used, or `null`.
 */
function selectFeeTier(dimensions, instructedMinor, precision) {
  const bands = fixtureRegistry.getFeeTiersForDimensions(dimensions);
  for (const band of bands) {
    if (isPlainObject(band) && amountWithinBand(band, instructedMinor, precision)) {
      return { tier: band, usedDefault: false };
    }
  }

  const defaultTier = fixtureRegistry.getDefaultFeeTier();
  if (isPlainObject(defaultTier)) {
    return { tier: defaultTier, usedDefault: true };
  }

  return null;
}

/**
 * Clamps a fee minor amount to a tier's min/max caps, when present.
 * @param {Record<string, unknown>} tier - The fee-tier record.
 * @param {number} feeMinor - The uncapped fee in minor units.
 * @param {number} precision - The fee precision (minor units).
 * @returns {number} The bounded fee in minor units.
 */
function applyFeeCaps(tier, feeMinor, precision) {
  let bounded = feeMinor;

  const minFee = parseMinor(tier.min_fee, precision);
  if (minFee !== null && bounded < minFee) {
    bounded = minFee;
  }

  const maxFee = parseMinor(tier.max_fee, precision);
  if (maxFee !== null && bounded > maxFee) {
    bounded = maxFee;
  }

  return bounded < 0 ? 0 : bounded;
}

/**
 * Computes the raw fee (before caps) for a fee tier against an instructed
 * amount, keeping every leg in integer minor units.
 * @param {Record<string, unknown>} tier - The fee-tier record.
 * @param {number} instructedMinor - The instructed amount in minor units.
 * @param {number} precision - The fee precision (minor units).
 * @param {string} roundingMode - The rounding mode to apply.
 * @returns {number | null} The raw fee in minor units, or `null`.
 */
function computeRawFee(tier, instructedMinor, precision, roundingMode) {
  const feeType = toText(tier.fee_type) || FEE_TYPES.FLAT;
  const flatMinor = parseMinor(tier.flat_fee, precision) ?? 0;

  let percentageMinor = 0;
  const percentageRate = toText(tier.percentage_rate);
  if (percentageRate.length > 0 && percentageRate !== '0' && percentageRate !== '0.0') {
    const converted = moneyEngine.convert(instructedMinor, {
      rate: percentageRate,
      rateScale: DEFAULT_RATE_SCALE,
      sourcePrecision: precision,
      beneficiaryPrecision: precision,
      roundingMode,
    });
    if (!converted.ok) {
      return null;
    }
    percentageMinor = converted.minor;
  }

  switch (feeType) {
    case FEE_TYPES.FLAT:
      return flatMinor;
    case FEE_TYPES.PERCENTAGE:
      return percentageMinor;
    case FEE_TYPES.HYBRID:
    default:
      return flatMinor + percentageMinor;
  }
}

/**
 * Prices an international payment using the fixed calculation pipeline.
 *
 * The pipeline enforces pair eligibility, normalizes the instructed amount into
 * integer minor units, selects the applicable fee tier band, applies the supplied
 * FX rate, rounds the counterpart amount, computes and caps the fee, applies BEN
 * deduction where relevant, and sums the total debit. The result carries
 * provenance (pair, fee tier, and rule IDs). Never mutates its arguments and
 * never throws — malformed input degrades to a discriminated failure result.
 *
 * @param {{
 *   pairId: string,
 *   instructedAmount: string | number,
 *   rate: string | number,
 *   rateScale?: number,
 *   sourcePrecision?: number,
 *   beneficiaryPrecision?: number,
 *   feePrecision?: number,
 *   roundingMode?: string,
 *   chargeTreatment?: string,
 *   dimensions?: {
 *     segment?: string,
 *     product?: string,
 *     channel?: string,
 *   },
 *   quoteRef?: string,
 *   ruleSetId?: string,
 * }} request - The pricing request.
 * @returns {{
 *   ok: true,
 *   safeReasonCode: string,
 *   pricing: {
 *     pairId: string,
 *     chargeTreatment: string,
 *     sourceCurrency: string,
 *     beneficiaryCurrency: string,
 *     instructedMinor: number,
 *     instructedValue: string,
 *     settlementMinor: number,
 *     settlementValue: string,
 *     transferMinor: number,
 *     transferValue: string,
 *     feeMinor: number,
 *     feeValue: string,
 *     feeCurrency: string,
 *     totalDebitMinor: number,
 *     totalDebitValue: string,
 *     sourcePrecision: number,
 *     beneficiaryPrecision: number,
 *     feePrecision: number,
 *     roundingMode: string,
 *   },
 *   provenance: {
 *     pairId: string,
 *     feeTierId: string | null,
 *     usedDefaultFeeTier: boolean,
 *     quoteRef: string | null,
 *     ruleSetId: string | null,
 *     rate: string,
 *   },
 * } | { ok: false, safeReasonCode: string }} A discriminated pricing result.
 */
export function price(request) {
  const source = isPlainObject(request) ? request : {};

  const pairId = toText(source.pairId);
  const pair = pairId.length > 0 ? fixtureRegistry.getCurrencyPairById(pairId) : undefined;
  if (!pair || pair.eligible !== true) {
    safeLogger.warn('pricingEngine: rejected ineligible currency pair');
    return fail(PRICING_REASON_CODES.PAIR_INELIGIBLE);
  }

  const sourcePrecision = resolvePrecision(source.sourcePrecision, DEFAULT_PRECISION);
  const beneficiaryPrecision = resolvePrecision(source.beneficiaryPrecision, DEFAULT_PRECISION);
  const feePrecision = resolvePrecision(source.feePrecision, DEFAULT_PRECISION);
  const roundingMode = resolveRoundingMode(source.roundingMode);
  const chargeTreatment = resolveChargeTreatment(source.chargeTreatment, CHARGE_TREATMENTS.SHA);

  const instructedMinor = parseMinor(source.instructedAmount, sourcePrecision);
  if (instructedMinor === null || instructedMinor < 0) {
    safeLogger.warn('pricingEngine: rejected invalid instructed amount');
    return fail(PRICING_REASON_CODES.INVALID_AMOUNT);
  }

  const dimensions = isPlainObject(source.dimensions) ? source.dimensions : {};
  const selection = selectFeeTier(
    {
      pairId,
      segment: toText(dimensions.segment),
      product: toText(dimensions.product),
      channel: toText(dimensions.channel),
    },
    instructedMinor,
    feePrecision,
  );
  if (!selection) {
    safeLogger.warn('pricingEngine: no applicable fee tier found');
    return fail(PRICING_REASON_CODES.NO_FEE_TIER);
  }

  const rateScale = resolvePrecision(source.rateScale, DEFAULT_RATE_SCALE);
  const converted = moneyEngine.convert(instructedMinor, {
    rate: source.rate,
    rateScale,
    sourcePrecision,
    beneficiaryPrecision,
    roundingMode,
  });
  if (!converted.ok) {
    safeLogger.warn('pricingEngine: failed to apply conversion rate');
    return fail(PRICING_REASON_CODES.INVALID_RATE);
  }

  const rawFee = computeRawFee(selection.tier, instructedMinor, feePrecision, roundingMode);
  if (rawFee === null) {
    safeLogger.warn('pricingEngine: failed to compute fee');
    return fail(PRICING_REASON_CODES.INVALID_FEE);
  }
  const feeMinor = applyFeeCaps(selection.tier, rawFee, feePrecision);

  // The gross beneficiary-currency amount before any BEN fee deduction. This
  // is always the full converted instructed amount, regardless of charge
  // treatment, and is exposed as `transferValue` for provenance.
  const transferMinor = converted.minor;

  const sourceCurrencyCode = toText(pair.base_currency);
  const beneficiaryCurrencyCode = toText(pair.quote_currency);

  // For BEN, the beneficiary bears the fee: it must be expressed in the
  // beneficiary currency (converted using the same rate) and deducted from
  // what the beneficiary actually receives. For OUR/SHA, the fee is borne by
  // the sender and stays denominated in the source currency, added to the
  // total debit instead of reducing the beneficiary's receipt.
  let settlementMinor = converted.minor;
  let feeDisplayMinor = feeMinor;
  let feeDisplayPrecision = feePrecision;
  let feeCurrency = sourceCurrencyCode;

  if (chargeTreatment === CHARGE_TREATMENTS.BEN) {
    const feeConverted = moneyEngine.convert(feeMinor, {
      rate: source.rate,
      rateScale,
      sourcePrecision: feePrecision,
      beneficiaryPrecision,
      roundingMode,
    });
    if (!feeConverted.ok) {
      safeLogger.warn('pricingEngine: failed to convert BEN fee to beneficiary currency');
      return fail(PRICING_REASON_CODES.INVALID_RATE);
    }
    feeDisplayMinor = feeConverted.minor;
    feeDisplayPrecision = beneficiaryPrecision;
    feeCurrency = beneficiaryCurrencyCode;
    settlementMinor = converted.minor - feeConverted.minor;
    if (settlementMinor < 0) {
      settlementMinor = 0;
    }
  }

  const senderFeeLegs =
    chargeTreatment === CHARGE_TREATMENTS.BEN ? [] : [feeMinor];
  const totalDebit = moneyEngine.computeTotalDebit({
    instructedMinor,
    legs: senderFeeLegs,
    precision: sourcePrecision,
  });
  if (!totalDebit.ok) {
    safeLogger.warn('pricingEngine: failed to compute total debit');
    return fail(PRICING_REASON_CODES.INVALID_TOTAL);
  }

  const instructedFormatted = moneyEngine.formatAmount(instructedMinor, sourcePrecision);
  const settlementFormatted = moneyEngine.formatAmount(settlementMinor, beneficiaryPrecision);
  const transferFormatted = moneyEngine.formatAmount(transferMinor, beneficiaryPrecision);
  const feeFormatted = moneyEngine.formatAmount(feeDisplayMinor, feeDisplayPrecision);

  if (
    !instructedFormatted.ok ||
    !settlementFormatted.ok ||
    !transferFormatted.ok ||
    !feeFormatted.ok
  ) {
    safeLogger.error('pricingEngine: failed to format pricing amounts');
    return fail(PRICING_REASON_CODES.UNEXPECTED);
  }

  const feeTierId = toText(selection.tier.tier_id) || null;
  const quoteRef = toText(source.quoteRef) || null;
  const ruleSetId = toText(source.ruleSetId) || null;
  const rate = toText(source.rate) || String(source.rate ?? '');

  return {
    ok: true,
    safeReasonCode: PRICING_REASON_CODES.PRICED,
    pricing: {
      pairId,
      chargeTreatment,
      sourceCurrency: sourceCurrencyCode,
      beneficiaryCurrency: beneficiaryCurrencyCode,
      instructedMinor,
      instructedValue: instructedFormatted.value,
      settlementMinor,
      settlementValue: settlementFormatted.value,
      transferMinor,
      transferValue: transferFormatted.value,
      feeMinor: feeDisplayMinor,
      feeValue: feeFormatted.value,
      feeCurrency,
      totalDebitMinor: totalDebit.minor,
      totalDebitValue: totalDebit.value,
      sourcePrecision,
      beneficiaryPrecision,
      feePrecision,
      roundingMode,
    },
    provenance: {
      pairId,
      feeTierId,
      usedDefaultFeeTier: selection.usedDefault,
      quoteRef,
      ruleSetId,
      rate,
    },
  };
}

/**
 * The pricing engine contract, exposed as a single frozen object.
 * @type {{
 *   price: typeof price,
 *   FEE_TYPES: typeof FEE_TYPES,
 *   CHARGE_TREATMENTS: typeof CHARGE_TREATMENTS,
 *   PRICING_REASON_CODES: typeof PRICING_REASON_CODES,
 * }}
 */
export const pricingEngine = Object.freeze({
  price,
  FEE_TYPES,
  CHARGE_TREATMENTS,
  PRICING_REASON_CODES,
});

export default pricingEngine;