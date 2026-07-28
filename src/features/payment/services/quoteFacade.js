/**
 * FX quote workflow facade.
 *
 * QuoteFacade orchestrates the FX quote lifecycle exercised by the payment
 * initiation flow (SCRUM-813/816). It layers atop the {@link fixtureRegistry}
 * (FX quote reference data + currency pair precision), the
 * {@link pricingEngine} (deterministic FX pricing and fee calculation), the
 * {@link PaymentRepository} (draft persistence), and the
 * {@link paymentAuditEventFactory} (sanitized, masked quote audit events):
 *
 *   - `requestQuote(session, request)` resolves an FX quote for a currency pair,
 *     defaulting the instructed amount to 1,000 source units unless a
 *     beneficiary-amount mode is requested, prices it, and records a quote audit
 *     event.
 *   - `recalculateQuote(session, request)` re-prices a quote after the amount is
 *     amended, honoring the same source/beneficiary amount modes.
 *   - `acceptQuote(session, request)` verifies the quote has not expired relative
 *     to the deterministic {@link demoClock}, produces an immutable
 *     {@link AcceptedPricingSnapshotV1}, and — when the chosen quote has expired —
 *     transparently replaces it with its successor scenario before failing.
 *   - `saveDraft(session, draft)` persists an in-progress payment draft.
 *
 * The facade is intentionally conservative and demo-only: it enforces
 * client-side gating (deny-by-default via the {@link authorizationPolicy}),
 * never throws for expected failures — each method returns a discriminated
 * `{ ok, ... }` result carrying a sanitized safe reason code — and carries no
 * server guarantee.
 */

import { CAPABILITIES } from '@/shared/config/constants';
import { fixtureRegistry } from '@/shared/fixtures/fixtureRegistry';
import { createLocalStorageAdapter } from '@/shared/storage/storageAdapter';
import { createPaymentRepository } from '@/features/payment/data/paymentRepository';
import { pricingEngine } from '@/features/payment/domain/pricingEngine';
import { moneyEngine } from '@/features/payment/domain/moneyEngine';
import { authorizationPolicy } from '@/features/access/services/authorizationPolicy';
import {
  createQuoteAuditEvent,
  recordPaymentAuditEvent,
} from '@/features/payment/data/paymentAuditEventFactory';
import { demoClock } from '@/shared/time/demoClock';
import { generateOperationId } from '@/shared/mock/mockEnvelope';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default instructed amount, in source units, applied in source-amount mode. */
const DEFAULT_SOURCE_AMOUNT = '1000';

/** Contract version stamped on an accepted pricing snapshot. */
export const ACCEPTED_PRICING_SNAPSHOT_VERSION = 'v1';

/** Default minor-unit precision applied when a pair carries none. */
const DEFAULT_PRECISION = 2;

/** Default rate scale applied when a quote carries none. */
const DEFAULT_RATE_SCALE = 6;

/**
 * Supported amount modes governing how the instructed amount is interpreted.
 * @type {{ SOURCE: 'source', BENEFICIARY: 'beneficiary' }}
 */
export const AMOUNT_MODES = Object.freeze({
  SOURCE: 'source',
  BENEFICIARY: 'beneficiary',
});

/**
 * Safe reason codes surfaced by the quote facade for gating and messaging.
 * @type {{
 *   QUOTED: 'quote.facade.quoted',
 *   RECALCULATED: 'quote.facade.recalculated',
 *   ACCEPTED: 'quote.facade.accepted',
 *   DRAFT_SAVED: 'quote.facade.draft_saved',
 *   UNAUTHORIZED: 'quote.facade.unauthorized',
 *   QUOTE_NOT_FOUND: 'quote.facade.quote_not_found',
 *   PAIR_INELIGIBLE: 'quote.facade.pair_ineligible',
 *   INVALID_AMOUNT: 'quote.facade.invalid_amount',
 *   PRICING_FAILED: 'quote.facade.pricing_failed',
 *   QUOTE_EXPIRED: 'quote.facade.quote_expired',
 *   REQUOTE_REQUIRED: 'quote.facade.requote_required',
 *   PERSIST_FAILED: 'quote.facade.persist_failed',
 *   UNEXPECTED: 'quote.facade.unexpected',
 * }}
 */
export const QUOTE_FACADE_REASON_CODES = Object.freeze({
  QUOTED: 'quote.facade.quoted',
  RECALCULATED: 'quote.facade.recalculated',
  ACCEPTED: 'quote.facade.accepted',
  DRAFT_SAVED: 'quote.facade.draft_saved',
  UNAUTHORIZED: 'quote.facade.unauthorized',
  QUOTE_NOT_FOUND: 'quote.facade.quote_not_found',
  PAIR_INELIGIBLE: 'quote.facade.pair_ineligible',
  INVALID_AMOUNT: 'quote.facade.invalid_amount',
  PRICING_FAILED: 'quote.facade.pricing_failed',
  QUOTE_EXPIRED: 'quote.facade.quote_expired',
  REQUOTE_REQUIRED: 'quote.facade.requote_required',
  PERSIST_FAILED: 'quote.facade.persist_failed',
  UNEXPECTED: 'quote.facade.unexpected',
});

/** Lazily-provisioned payment repository shared across facade calls. */
let sharedRepository = null;

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
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
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
 * Builds a discriminated failure result carrying a sanitized reason code.
 * @param {string} safeReasonCode - The sanitized reason code.
 * @returns {{ ok: false, safeReasonCode: string }} A failure result.
 */
function fail(safeReasonCode) {
  return { ok: false, safeReasonCode };
}

/**
 * Provisions (or returns) the shared payment repository, creating a local
 * storage adapter and repository on first use. Failures degrade to `null` so
 * callers never crash on a storage fault.
 * @returns {import('@/features/payment/data/paymentRepository').PaymentRepository | null}
 *   The shared repository, or `null` when it could not be provisioned.
 */
function resolveRepository() {
  if (sharedRepository) {
    return sharedRepository;
  }
  try {
    const adapter = createLocalStorageAdapter();
    sharedRepository = createPaymentRepository(adapter);
    return sharedRepository;
  } catch (error) {
    safeLogger.error('quoteFacade: failed to provision payment repository', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * Overrides the repository backing the facade. Primarily used by tests to
 * inject a deterministic or in-memory repository.
 * @param {import('@/features/payment/data/paymentRepository').PaymentRepository | null} repository
 *   The repository to use, or `null` to reset to lazy provisioning.
 * @returns {void}
 */
export function configureQuoteFacade(repository) {
  sharedRepository = repository ?? null;
}

/**
 * Resolves the acting subject identifier from a session claim.
 * @param {Record<string, unknown> | null | undefined} session - The session.
 * @returns {string | undefined} The subject identifier, or `undefined`.
 */
function resolveActorId(session) {
  if (!isPlainObject(session)) {
    return undefined;
  }
  const subjectId = toText(session.subjectId);
  return subjectId.length > 0 ? subjectId : undefined;
}

/**
 * Determines whether the acting session may initiate payments (and thus quote).
 * @param {Record<string, unknown> | null | undefined} session - The session.
 * @returns {boolean} `true` when the session holds the initiate capability.
 */
function canInitiate(session) {
  return authorizationPolicy.can(session, CAPABILITIES.PAYMENT_INITIATE);
}

/**
 * Records a sanitized quote audit event, never throwing on failure.
 * @param {{
 *   actorId?: string,
 *   subjectId?: string,
 *   quoteRef?: string,
 *   pairId?: string,
 *   classification?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, unknown>,
 * }} details - The quote audit event details.
 * @returns {void}
 */
function audit(details) {
  try {
    recordPaymentAuditEvent(createQuoteAuditEvent(details));
  } catch (error) {
    safeLogger.warn('quoteFacade: failed to record quote audit event', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * Resolves a supported amount mode, falling back to source-amount mode.
 * @param {unknown} value - The candidate mode.
 * @returns {string} A valid amount mode from {@link AMOUNT_MODES}.
 */
function resolveAmountMode(value) {
  return value === AMOUNT_MODES.BENEFICIARY ? AMOUNT_MODES.BENEFICIARY : AMOUNT_MODES.SOURCE;
}

/**
 * Reads the numeric rate scale from a quote record, falling back when absent.
 * @param {Record<string, unknown>} quote - The quote record.
 * @returns {number} The rate scale.
 */
function readRateScale(quote) {
  return resolvePrecision(quote.rate_scale, DEFAULT_RATE_SCALE);
}

/**
 * Resolves the effective source instructed amount for a request, converting a
 * beneficiary-mode amount back into source units via the quote's inverse rate.
 * @param {Record<string, unknown>} quote - The resolved quote record.
 * @param {{ amount?: string | number, amountMode?: string }} request - The request.
 * @param {number} sourcePrecision - The source minor-unit precision.
 * @param {number} beneficiaryPrecision - The beneficiary minor-unit precision.
 * @returns {{ ok: true, instructedAmount: string } | { ok: false, safeReasonCode: string }}
 *   A discriminated result carrying the resolved source instructed amount.
 */
function resolveInstructedAmount(quote, request, sourcePrecision, beneficiaryPrecision) {
  const mode = resolveAmountMode(request.amountMode);
  const rawAmount = toText(request.amount);

  if (mode === AMOUNT_MODES.BENEFICIARY) {
    if (rawAmount.length === 0) {
      return fail(QUOTE_FACADE_REASON_CODES.INVALID_AMOUNT);
    }
    const beneficiaryMinor = moneyEngine.parseAmount(rawAmount, beneficiaryPrecision);
    if (!beneficiaryMinor.ok) {
      return fail(QUOTE_FACADE_REASON_CODES.INVALID_AMOUNT);
    }
    const inverseRate = toText(quote.inverse_rate);
    if (inverseRate.length === 0) {
      return fail(QUOTE_FACADE_REASON_CODES.INVALID_AMOUNT);
    }
    const inverseScale = resolvePrecision(quote.inverse_rate_scale, DEFAULT_RATE_SCALE);
    const converted = moneyEngine.convert(beneficiaryMinor.minor, {
      rate: inverseRate,
      rateScale: inverseScale,
      sourcePrecision: beneficiaryPrecision,
      beneficiaryPrecision: sourcePrecision,
    });
    if (!converted.ok) {
      return fail(QUOTE_FACADE_REASON_CODES.INVALID_AMOUNT);
    }
    return { ok: true, instructedAmount: converted.value };
  }

  const sourceAmount = rawAmount.length > 0 ? rawAmount : DEFAULT_SOURCE_AMOUNT;
  const parsed = moneyEngine.parseAmount(sourceAmount, sourcePrecision);
  if (!parsed.ok) {
    return fail(QUOTE_FACADE_REASON_CODES.INVALID_AMOUNT);
  }
  return { ok: true, instructedAmount: parsed.value };
}

/**
 * Resolves and validates the FX quote and its currency pair for a request.
 * @param {{ quoteRef?: string }} request - The quote request.
 * @returns {{
 *   ok: true,
 *   quote: Record<string, unknown>,
 *   pair: Record<string, unknown>,
 *   sourcePrecision: number,
 *   beneficiaryPrecision: number,
 * } | { ok: false, safeReasonCode: string }} A discriminated resolution result.
 */
function resolveQuoteContext(request) {
  const quoteRef = toText(request.quoteRef);
  const quote = quoteRef.length > 0 ? fixtureRegistry.getFxQuoteByRef(quoteRef) : undefined;
  if (!isPlainObject(quote)) {
    return fail(QUOTE_FACADE_REASON_CODES.QUOTE_NOT_FOUND);
  }

  const pairId = toText(quote.pair_id);
  const pair = pairId.length > 0 ? fixtureRegistry.getCurrencyPairById(pairId) : undefined;
  if (!isPlainObject(pair) || pair.eligible !== true) {
    return fail(QUOTE_FACADE_REASON_CODES.PAIR_INELIGIBLE);
  }

  const sourcePrecision = resolvePrecision(
    pair.settlement_precision ?? quote.settlement_precision,
    DEFAULT_PRECISION,
  );
  const beneficiaryPrecision = resolvePrecision(
    pair.settlement_precision ?? quote.settlement_precision,
    DEFAULT_PRECISION,
  );

  return { ok: true, quote, pair, sourcePrecision, beneficiaryPrecision };
}

/**
 * Prices a resolved quote for a request, producing the pricing result and a
 * sanitized quote view model shared by request/recalculate.
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {Record<string, unknown>} quote - The resolved quote record.
 * @param {Record<string, unknown>} pair - The resolved currency pair record.
 * @param {number} sourcePrecision - The source minor-unit precision.
 * @param {number} beneficiaryPrecision - The beneficiary minor-unit precision.
 * @param {{
 *   amount?: string | number,
 *   amountMode?: string,
 *   chargeTreatment?: string,
 *   dimensions?: { segment?: string, product?: string, channel?: string },
 * }} request - The quote request.
 * @returns {{ ok: true, pricing: Record<string, unknown>, provenance: Record<string, unknown> }
 *   | { ok: false, safeReasonCode: string }} A discriminated pricing result.
 */
function priceQuote(session, quote, pair, sourcePrecision, beneficiaryPrecision, request) {
  const instructed = resolveInstructedAmount(quote, request, sourcePrecision, beneficiaryPrecision);
  if (!instructed.ok) {
    return fail(instructed.safeReasonCode);
  }

  const rate = toText(quote.rate);
  if (rate.length === 0) {
    return fail(QUOTE_FACADE_REASON_CODES.PRICING_FAILED);
  }

  const source = isPlainObject(request) ? request : {};
  const dimensions = isPlainObject(source.dimensions) ? source.dimensions : {};

  const priced = pricingEngine.price({
    pairId: toText(pair.pair_id),
    instructedAmount: instructed.instructedAmount,
    rate,
    rateScale: readRateScale(quote),
    sourcePrecision,
    beneficiaryPrecision,
    feePrecision: sourcePrecision,
    chargeTreatment: source.chargeTreatment,
    dimensions: {
      segment: toText(dimensions.segment),
      product: toText(dimensions.product),
      channel: toText(dimensions.channel),
    },
    quoteRef: toText(quote.quote_ref),
    ruleSetId: toText(source.ruleSetId),
  });

  if (!priced.ok) {
    safeLogger.warn('quoteFacade: pricing failed', { safeReasonCode: priced.safeReasonCode });
    return fail(QUOTE_FACADE_REASON_CODES.PRICING_FAILED);
  }

  return { ok: true, pricing: priced.pricing, provenance: priced.provenance };
}

/**
 * Builds a sanitized quote view model from a quote record and its pricing.
 * @param {Record<string, unknown>} quote - The resolved quote record.
 * @param {Record<string, unknown>} pricing - The pricing result.
 * @param {Record<string, unknown>} provenance - The pricing provenance.
 * @returns {Record<string, unknown>} The sanitized quote view model.
 */
function toQuoteViewModel(quote, pricing, provenance) {
  return {
    quoteRef: toText(quote.quote_ref),
    pairId: toText(quote.pair_id),
    sourceCurrency: toText(quote.source_currency),
    beneficiaryCurrency: toText(quote.beneficiary_currency),
    classification: toText(quote.classification),
    quoteState: toText(quote.quote_state),
    expiryReasonCode: toText(quote.expiry_reason_code),
    rate: toText(quote.rate),
    expiresAt: toText(quote.expires_at),
    nextQuoteRef: toText(quote.next_quote_ref) || null,
    pricing,
    provenance,
  };
}

/**
 * Determines whether a quote is expired relative to the deterministic clock.
 * @param {Record<string, unknown>} quote - The quote record.
 * @returns {boolean} `true` when the quote has expired.
 */
function isQuoteExpired(quote) {
  const expiresAt = toText(quote.expires_at);
  if (expiresAt.length === 0) {
    return true;
  }
  try {
    return demoClock.isExpired(expiresAt);
  } catch {
    return true;
  }
}

/**
 * Requests an FX quote for a currency pair, defaulting the instructed amount to
 * 1,000 source units unless a beneficiary-amount mode is supplied, pricing it,
 * and recording a quote audit event.
 *
 * Deny-by-default: the session must hold the `payment:initiate` capability, the
 * quote and its pair must be eligible, and the amount must be valid. Never
 * throws for expected failures.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {{
 *   quoteRef?: string,
 *   amount?: string | number,
 *   amountMode?: string,
 *   chargeTreatment?: string,
 *   dimensions?: { segment?: string, product?: string, channel?: string },
 *   ruleSetId?: string,
 * }} request - The quote request.
 * @returns {{ ok: boolean, quote?: Record<string, unknown>, safeReasonCode: string }}
 *   A discriminated quote result.
 */
export function requestQuote(session, request) {
  const actorId = resolveActorId(session);
  const source = isPlainObject(request) ? request : {};

  if (!canInitiate(session)) {
    audit({ actorId, safeReasonCode: QUOTE_FACADE_REASON_CODES.UNAUTHORIZED });
    return fail(QUOTE_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  const context = resolveQuoteContext(source);
  if (!context.ok) {
    audit({
      actorId,
      quoteRef: toText(source.quoteRef) || undefined,
      safeReasonCode: context.safeReasonCode,
    });
    return fail(context.safeReasonCode);
  }

  const priced = priceQuote(
    session,
    context.quote,
    context.pair,
    context.sourcePrecision,
    context.beneficiaryPrecision,
    source,
  );
  if (!priced.ok) {
    audit({
      actorId,
      quoteRef: toText(context.quote.quote_ref),
      pairId: toText(context.quote.pair_id),
      safeReasonCode: priced.safeReasonCode,
    });
    return fail(priced.safeReasonCode);
  }

  const model = toQuoteViewModel(context.quote, priced.pricing, priced.provenance);

  audit({
    actorId,
    quoteRef: model.quoteRef,
    pairId: model.pairId,
    classification: model.classification,
    safeReasonCode: QUOTE_FACADE_REASON_CODES.QUOTED,
    metadata: { amountMode: resolveAmountMode(source.amountMode) },
  });

  return { ok: true, quote: model, safeReasonCode: QUOTE_FACADE_REASON_CODES.QUOTED };
}

/**
 * Recalculates a quote after the instructed amount is amended, re-pricing it
 * and recording a quote audit event.
 *
 * Deny-by-default: the session must hold the `payment:initiate` capability, the
 * quote and its pair must be eligible, and the amended amount must be valid.
 * Never throws for expected failures.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {{
 *   quoteRef?: string,
 *   amount?: string | number,
 *   amountMode?: string,
 *   chargeTreatment?: string,
 *   dimensions?: { segment?: string, product?: string, channel?: string },
 *   ruleSetId?: string,
 * }} request - The recalculation request.
 * @returns {{ ok: boolean, quote?: Record<string, unknown>, safeReasonCode: string }}
 *   A discriminated recalculation result.
 */
export function recalculateQuote(session, request) {
  const actorId = resolveActorId(session);
  const source = isPlainObject(request) ? request : {};

  if (!canInitiate(session)) {
    audit({ actorId, safeReasonCode: QUOTE_FACADE_REASON_CODES.UNAUTHORIZED });
    return fail(QUOTE_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  const context = resolveQuoteContext(source);
  if (!context.ok) {
    audit({
      actorId,
      quoteRef: toText(source.quoteRef) || undefined,
      safeReasonCode: context.safeReasonCode,
    });
    return fail(context.safeReasonCode);
  }

  const priced = priceQuote(
    session,
    context.quote,
    context.pair,
    context.sourcePrecision,
    context.beneficiaryPrecision,
    source,
  );
  if (!priced.ok) {
    audit({
      actorId,
      quoteRef: toText(context.quote.quote_ref),
      pairId: toText(context.quote.pair_id),
      safeReasonCode: priced.safeReasonCode,
    });
    return fail(priced.safeReasonCode);
  }

  const model = toQuoteViewModel(context.quote, priced.pricing, priced.provenance);

  audit({
    actorId,
    quoteRef: model.quoteRef,
    pairId: model.pairId,
    classification: model.classification,
    safeReasonCode: QUOTE_FACADE_REASON_CODES.RECALCULATED,
    metadata: { amountMode: resolveAmountMode(source.amountMode) },
  });

  return { ok: true, quote: model, safeReasonCode: QUOTE_FACADE_REASON_CODES.RECALCULATED };
}

/**
 * Builds an immutable accepted-pricing snapshot from a priced quote.
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {Record<string, unknown>} quote - The resolved quote record.
 * @param {Record<string, unknown>} pricing - The pricing result.
 * @param {Record<string, unknown>} provenance - The pricing provenance.
 * @returns {Readonly<Record<string, unknown>>} A frozen accepted-pricing snapshot.
 */
function buildAcceptedSnapshot(session, quote, pricing, provenance) {
  const snapshot = {
    version: ACCEPTED_PRICING_SNAPSHOT_VERSION,
    snapshotId: generateOperationId(),
    acceptedAt: demoClock.now(),
    acceptedBy: resolveActorId(session) ?? null,
    quoteRef: toText(quote.quote_ref),
    pairId: toText(quote.pair_id),
    sourceCurrency: toText(quote.source_currency),
    beneficiaryCurrency: toText(quote.beneficiary_currency),
    classification: toText(quote.classification),
    rate: toText(quote.rate),
    rateScale: readRateScale(quote),
    expiresAt: toText(quote.expires_at),
    pricing: Object.freeze({ ...pricing }),
    provenance: Object.freeze({ ...provenance }),
  };
  return Object.freeze(snapshot);
}

/**
 * Accepts an FX quote, verifying it has not expired relative to the demo clock,
 * producing an immutable {@link AcceptedPricingSnapshotV1}. When the chosen
 * quote has expired, it is transparently replaced with its successor scenario
 * (surfaced via `nextQuote`) before the acceptance fails with a re-quote code.
 *
 * Deny-by-default: the session must hold the `payment:initiate` capability, the
 * quote and its pair must be eligible, and the amount must be valid. Never
 * throws for expected failures.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {{
 *   quoteRef?: string,
 *   amount?: string | number,
 *   amountMode?: string,
 *   chargeTreatment?: string,
 *   dimensions?: { segment?: string, product?: string, channel?: string },
 *   ruleSetId?: string,
 * }} request - The acceptance request.
 * @returns {{
 *   ok: boolean,
 *   snapshot?: Readonly<Record<string, unknown>>,
 *   nextQuote?: Record<string, unknown>,
 *   safeReasonCode: string,
 * }} A discriminated acceptance result.
 */
export function acceptQuote(session, request) {
  const actorId = resolveActorId(session);
  const source = isPlainObject(request) ? request : {};

  if (!canInitiate(session)) {
    audit({ actorId, safeReasonCode: QUOTE_FACADE_REASON_CODES.UNAUTHORIZED });
    return fail(QUOTE_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  const context = resolveQuoteContext(source);
  if (!context.ok) {
    audit({
      actorId,
      quoteRef: toText(source.quoteRef) || undefined,
      safeReasonCode: context.safeReasonCode,
    });
    return fail(context.safeReasonCode);
  }

  if (isQuoteExpired(context.quote)) {
    const nextRef = toText(context.quote.next_quote_ref);
    const successor = nextRef.length > 0 ? fixtureRegistry.getFxQuoteByRef(nextRef) : undefined;

    audit({
      actorId,
      quoteRef: toText(context.quote.quote_ref),
      pairId: toText(context.quote.pair_id),
      safeReasonCode: QUOTE_FACADE_REASON_CODES.QUOTE_EXPIRED,
    });

    if (isPlainObject(successor)) {
      const replacement = requestQuote(session, { ...source, quoteRef: nextRef });
      if (replacement.ok) {
        return {
          ok: false,
          nextQuote: replacement.quote,
          safeReasonCode: QUOTE_FACADE_REASON_CODES.REQUOTE_REQUIRED,
        };
      }
    }

    return fail(QUOTE_FACADE_REASON_CODES.QUOTE_EXPIRED);
  }

  const priced = priceQuote(
    session,
    context.quote,
    context.pair,
    context.sourcePrecision,
    context.beneficiaryPrecision,
    source,
  );
  if (!priced.ok) {
    audit({
      actorId,
      quoteRef: toText(context.quote.quote_ref),
      pairId: toText(context.quote.pair_id),
      safeReasonCode: priced.safeReasonCode,
    });
    return fail(priced.safeReasonCode);
  }

  const snapshot = buildAcceptedSnapshot(session, context.quote, priced.pricing, priced.provenance);

  audit({
    actorId,
    quoteRef: snapshot.quoteRef,
    pairId: snapshot.pairId,
    classification: snapshot.classification,
    safeReasonCode: QUOTE_FACADE_REASON_CODES.ACCEPTED,
  });

  return { ok: true, snapshot, safeReasonCode: QUOTE_FACADE_REASON_CODES.ACCEPTED };
}

/**
 * Persists an in-progress payment draft via the payment repository.
 *
 * Deny-by-default: the session must hold the `payment:initiate` capability.
 * Never throws for expected failures.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {Record<string, unknown>} draft - The payment draft to persist.
 * @returns {{ ok: boolean, draft?: Record<string, unknown>, safeReasonCode: string }}
 *   A discriminated persistence result.
 */
export function saveDraft(session, draft) {
  const actorId = resolveActorId(session);

  if (!canInitiate(session)) {
    audit({ actorId, safeReasonCode: QUOTE_FACADE_REASON_CODES.UNAUTHORIZED });
    return fail(QUOTE_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  const repository = resolveRepository();
  if (!repository) {
    return fail(QUOTE_FACADE_REASON_CODES.UNEXPECTED);
  }

  const source = isPlainObject(draft) ? draft : {};
  const result = repository.saveDraft(source);
  if (!result.ok) {
    return fail(QUOTE_FACADE_REASON_CODES.PERSIST_FAILED);
  }

  return {
    ok: true,
    draft: result.draft,
    safeReasonCode: QUOTE_FACADE_REASON_CODES.DRAFT_SAVED,
  };
}

/**
 * The quote facade contract, exposed as a single frozen object.
 * @type {{
 *   requestQuote: typeof requestQuote,
 *   recalculateQuote: typeof recalculateQuote,
 *   acceptQuote: typeof acceptQuote,
 *   saveDraft: typeof saveDraft,
 *   configureQuoteFacade: typeof configureQuoteFacade,
 *   AMOUNT_MODES: typeof AMOUNT_MODES,
 *   ACCEPTED_PRICING_SNAPSHOT_VERSION: typeof ACCEPTED_PRICING_SNAPSHOT_VERSION,
 *   QUOTE_FACADE_REASON_CODES: typeof QUOTE_FACADE_REASON_CODES,
 * }}
 */
export const quoteFacade = Object.freeze({
  requestQuote,
  recalculateQuote,
  acceptQuote,
  saveDraft,
  configureQuoteFacade,
  AMOUNT_MODES,
  ACCEPTED_PRICING_SNAPSHOT_VERSION,
  QUOTE_FACADE_REASON_CODES,
});

export default quoteFacade;