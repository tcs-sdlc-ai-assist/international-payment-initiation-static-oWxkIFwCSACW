/**
 * Account selection facade.
 *
 * AccountFacade supports the FX quote and payment initiation flow (SCRUM-816).
 * It exposes two capabilities the payment initiation UI relies on:
 *
 *   - `listEligibleAccounts(session, options)` returns the entitlement-scoped
 *     set of source accounts a session may pay from, filtered by the session's
 *     account scopes (from its own claim), an active status, and (optionally) a
 *     required beneficiary currency. Every returned account carries only
 *     sanitized, masked display fields — no raw banking details.
 *   - `validateCurrencyPair(source)` resolves whether a source/beneficiary
 *     currency pair is eligible, blocking unsupported, restricted, or
 *     same-currency pairs with a sanitized reason code and demo-safe customer
 *     copy so the UI can gate and message consistently.
 *
 * This is a demo-only, non-regulatory facade: it enforces client-side
 * visibility and gating and carries no server guarantee. It never throws for
 * expected failures — each method returns a discriminated `{ ok, ... }` result
 * so callers can degrade the UI gracefully.
 */

import { CAPABILITIES } from '@/shared/config/constants';
import {
  fixtureRegistry,
  FIXTURE_IDS,
} from '@/shared/fixtures/fixtureRegistry';
import { authorizationPolicy } from '@/features/access/services/authorizationPolicy';
import { maskingPolicy } from '@/shared/privacy/maskingPolicy';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Account status required for an account to be selectable as a source. */
const ACTIVE_STATUS = 'active';

/** Default masking context applied to account display models. */
const DEFAULT_MASKING_CONTEXT = maskingPolicy.MASKING_CONTEXTS.LIST;

/**
 * Safe reason codes surfaced by the account facade for gating and messaging.
 * @type {{
 *   ACCOUNTS_LISTED: 'account.facade.accounts_listed',
 *   UNAUTHORIZED: 'account.facade.unauthorized',
 *   NO_ACCOUNTS: 'account.facade.no_accounts',
 *   PAIR_ELIGIBLE: 'account.facade.pair_eligible',
 *   PAIR_SAME_CURRENCY: 'account.facade.pair_same_currency',
 *   PAIR_UNSUPPORTED: 'account.facade.pair_unsupported',
 *   PAIR_RESTRICTED: 'account.facade.pair_restricted',
 *   PAIR_UNAVAILABLE: 'account.facade.pair_unavailable',
 *   PAIR_INVALID_INPUT: 'account.facade.pair_invalid_input',
 *   UNEXPECTED: 'account.facade.unexpected',
 * }}
 */
export const ACCOUNT_FACADE_REASON_CODES = Object.freeze({
  ACCOUNTS_LISTED: 'account.facade.accounts_listed',
  UNAUTHORIZED: 'account.facade.unauthorized',
  NO_ACCOUNTS: 'account.facade.no_accounts',
  PAIR_ELIGIBLE: 'account.facade.pair_eligible',
  PAIR_SAME_CURRENCY: 'account.facade.pair_same_currency',
  PAIR_UNSUPPORTED: 'account.facade.pair_unsupported',
  PAIR_RESTRICTED: 'account.facade.pair_restricted',
  PAIR_UNAVAILABLE: 'account.facade.pair_unavailable',
  PAIR_INVALID_INPUT: 'account.facade.pair_invalid_input',
  UNEXPECTED: 'account.facade.unexpected',
});

/**
 * Maps a currency pair fixture eligibility reason code to a facade reason code.
 * @type {Record<string, string>}
 */
const PAIR_REASON_MAP = Object.freeze({
  'pair.eligible': ACCOUNT_FACADE_REASON_CODES.PAIR_ELIGIBLE,
  'pair.same_currency': ACCOUNT_FACADE_REASON_CODES.PAIR_SAME_CURRENCY,
  'pair.unsupported': ACCOUNT_FACADE_REASON_CODES.PAIR_UNSUPPORTED,
  'pair.restricted_corridor': ACCOUNT_FACADE_REASON_CODES.PAIR_RESTRICTED,
  'pair.temporarily_unavailable': ACCOUNT_FACADE_REASON_CODES.PAIR_UNAVAILABLE,
});

/**
 * Demo-safe customer copy surfaced per facade reason code.
 * @type {Record<string, { title: string, body: string }>}
 */
const CUSTOMER_COPY = Object.freeze({
  [ACCOUNT_FACADE_REASON_CODES.PAIR_ELIGIBLE]: {
    title: 'Currency pair supported',
    body: 'This currency pair is fully supported and may be selected for international payment initiation.',
  },
  [ACCOUNT_FACADE_REASON_CODES.PAIR_SAME_CURRENCY]: {
    title: 'Same currency selected',
    body: 'The source and beneficiary currencies are identical, so no cross-currency conversion applies. Choose two different currencies to initiate an international payment.',
  },
  [ACCOUNT_FACADE_REASON_CODES.PAIR_UNSUPPORTED]: {
    title: 'Currency pair not supported',
    body: 'This currency pair is not supported for international payment initiation in this demo. Choose a supported combination to continue.',
  },
  [ACCOUNT_FACADE_REASON_CODES.PAIR_RESTRICTED]: {
    title: 'Restricted corridor',
    body: 'This corridor is restricted for compliance reasons and cannot be used in this demo. Select a different beneficiary currency.',
  },
  [ACCOUNT_FACADE_REASON_CODES.PAIR_UNAVAILABLE]: {
    title: 'Pricing temporarily unavailable',
    body: 'Pricing for this pair is temporarily unavailable, so selection is blocked until it is restored. Wait a moment and try again.',
  },
  [ACCOUNT_FACADE_REASON_CODES.PAIR_INVALID_INPUT]: {
    title: 'Select two currencies',
    body: 'Choose both a source and a beneficiary currency to validate the pair.',
  },
});

/** Fallback copy used when a specific reason code has no dedicated entry. */
const FALLBACK_COPY = Object.freeze({
  title: 'Currency pair unavailable',
  body: 'This currency pair cannot be used for international payment initiation right now. Choose a supported combination to continue.',
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
 * Normalizes a value into a string array, dropping non-string entries.
 * @param {unknown} value - The candidate value.
 * @returns {string[]} A safe array of strings (may be empty).
 */
function toStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === 'string' && item.length > 0);
}

/**
 * Resolves a supported masking context, falling back to the default.
 * @param {string} [context] - The requested context.
 * @returns {string} A valid masking context.
 */
function resolveContext(context) {
  const contexts = Object.values(maskingPolicy.MASKING_CONTEXTS);
  return typeof context === 'string' && contexts.includes(context)
    ? context
    : DEFAULT_MASKING_CONTEXT;
}

/**
 * Resolves the acting session's account scopes from its claim.
 * @param {Record<string, unknown> | null | undefined} session - The session.
 * @returns {string[]} The session's account scopes (may be empty).
 */
function resolveSessionScopes(session) {
  if (!isPlainObject(session)) {
    return [];
  }
  return toStringArray(session.accountScopes);
}

/**
 * Builds a sanitized, masked display model for a single account record.
 * @param {Record<string, unknown>} account - The raw account record.
 * @param {string} context - The resolved masking context.
 * @returns {{
 *   accountId: string,
 *   accountName: string,
 *   accountNumberMasked: string,
 *   currency: string,
 *   availableBalance: number | null,
 *   supportedBeneficiaryCurrencies: string[],
 *   customerSegment: string | null,
 *   product: string | null,
 *   channel: string | null,
 *   status: string | null,
 * }} A masked account display model.
 */
function toDisplayModel(account, context) {
  return {
    accountId: toText(account.account_id),
    accountName: toText(account.account_name),
    accountNumberMasked:
      toText(account.account_number_masked) ||
      maskingPolicy.mask('account', account.account_number_masked, context),
    currency: toText(account.currency),
    availableBalance:
      typeof account.available_balance === 'number' &&
      Number.isFinite(account.available_balance)
        ? account.available_balance
        : null,
    supportedBeneficiaryCurrencies: toStringArray(account.supported_beneficiary_currencies),
    customerSegment:
      typeof account.customer_segment === 'string' ? account.customer_segment : null,
    product: typeof account.product === 'string' ? account.product : null,
    channel: typeof account.channel === 'string' ? account.channel : null,
    status: typeof account.status === 'string' ? account.status : null,
  };
}

/**
 * Returns the entitlement-scoped set of eligible source accounts a session may
 * pay from, as sanitized, masked display models.
 *
 * Deny-by-default: the session must hold the `payment:initiate` capability, and
 * an account is only visible when its identifier is included in the session's
 * account scopes, its status is active, and (when a beneficiary currency is
 * supplied) it supports that beneficiary currency.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {{ beneficiaryCurrency?: string, context?: string }} [options] - Optional filter.
 * @returns {{
 *   ok: boolean,
 *   accounts: Array<Record<string, unknown>>,
 *   safeReasonCode: string,
 * }} A discriminated result with masked accounts.
 */
export function listEligibleAccounts(session, options) {
  if (!authorizationPolicy.can(session, CAPABILITIES.PAYMENT_INITIATE)) {
    safeLogger.warn('accountFacade: listEligibleAccounts denied; missing capability');
    return {
      ok: false,
      accounts: [],
      safeReasonCode: ACCOUNT_FACADE_REASON_CODES.UNAUTHORIZED,
    };
  }

  let accounts;
  try {
    accounts = fixtureRegistry.getAccounts();
  } catch (error) {
    safeLogger.error('accountFacade: failed to read accounts fixture', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return {
      ok: false,
      accounts: [],
      safeReasonCode: ACCOUNT_FACADE_REASON_CODES.UNEXPECTED,
    };
  }

  const source = isPlainObject(options) ? options : {};
  const context = resolveContext(source.context);
  const beneficiaryCurrency = toText(source.beneficiaryCurrency).toUpperCase();
  const scopeSet = new Set(resolveSessionScopes(session));

  const visible = accounts.filter((account) => {
    if (!isPlainObject(account)) {
      return false;
    }
    const accountId = toText(account.account_id);
    if (accountId.length === 0 || !scopeSet.has(accountId)) {
      return false;
    }
    if (toText(account.status) !== ACTIVE_STATUS) {
      return false;
    }
    if (beneficiaryCurrency.length > 0) {
      const supported = toStringArray(account.supported_beneficiary_currencies).map((item) =>
        item.toUpperCase(),
      );
      if (!supported.includes(beneficiaryCurrency)) {
        return false;
      }
    }
    return true;
  });

  const models = visible.map((account) => toDisplayModel(account, context));

  if (models.length === 0) {
    return {
      ok: true,
      accounts: [],
      safeReasonCode: ACCOUNT_FACADE_REASON_CODES.NO_ACCOUNTS,
    };
  }

  return {
    ok: true,
    accounts: models,
    safeReasonCode: ACCOUNT_FACADE_REASON_CODES.ACCOUNTS_LISTED,
  };
}

/**
 * Resolves the customer copy for a facade reason code.
 * @param {string} reasonCode - A facade reason code.
 * @returns {{ title: string, body: string }} Demo-safe customer copy.
 */
function resolveCopy(reasonCode) {
  const copy = CUSTOMER_COPY[reasonCode];
  return copy ? { title: copy.title, body: copy.body } : { ...FALLBACK_COPY };
}

/**
 * Validates whether a source/beneficiary currency pair is eligible for
 * international payment initiation, blocking unsupported, restricted, or
 * same-currency pairs with a sanitized reason code and demo-safe copy.
 *
 * Never throws for expected failures — malformed input degrades to a
 * discriminated failure result carrying a sanitized reason code.
 *
 * @param {{
 *   sourceCurrency?: string,
 *   beneficiaryCurrency?: string,
 *   pairId?: string,
 * }} pair - The currency pair to validate.
 * @returns {{
 *   ok: boolean,
 *   pairId: string | null,
 *   eligible: boolean,
 *   safeReasonCode: string,
 *   customerCopy: { title: string, body: string },
 * }} A discriminated validation result.
 */
export function validateCurrencyPair(pair) {
  const source = isPlainObject(pair) ? pair : {};
  const explicitPairId = toText(source.pairId).toUpperCase();
  const sourceCurrency = toText(source.sourceCurrency).toUpperCase();
  const beneficiaryCurrency = toText(source.beneficiaryCurrency).toUpperCase();

  const resolvedPairId =
    explicitPairId.length > 0
      ? explicitPairId
      : sourceCurrency.length > 0 && beneficiaryCurrency.length > 0
        ? `${sourceCurrency}-${beneficiaryCurrency}`
        : '';

  if (resolvedPairId.length === 0) {
    return {
      ok: false,
      pairId: null,
      eligible: false,
      safeReasonCode: ACCOUNT_FACADE_REASON_CODES.PAIR_INVALID_INPUT,
      customerCopy: resolveCopy(ACCOUNT_FACADE_REASON_CODES.PAIR_INVALID_INPUT),
    };
  }

  let record;
  try {
    record = fixtureRegistry.getCurrencyPairById(resolvedPairId);
  } catch (error) {
    safeLogger.error('accountFacade: failed to read currency pair fixture', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return {
      ok: false,
      pairId: resolvedPairId,
      eligible: false,
      safeReasonCode: ACCOUNT_FACADE_REASON_CODES.UNEXPECTED,
      customerCopy: { ...FALLBACK_COPY },
    };
  }

  if (!isPlainObject(record)) {
    safeLogger.warn('accountFacade: currency pair not found', { pair: resolvedPairId });
    return {
      ok: false,
      pairId: resolvedPairId,
      eligible: false,
      safeReasonCode: ACCOUNT_FACADE_REASON_CODES.PAIR_UNSUPPORTED,
      customerCopy: resolveCopy(ACCOUNT_FACADE_REASON_CODES.PAIR_UNSUPPORTED),
    };
  }

  const eligible = record.eligible === true;
  const fixtureReasonCode = toText(record.eligibility_reason_code);
  const mappedReasonCode = PAIR_REASON_MAP[fixtureReasonCode];

  if (eligible) {
    return {
      ok: true,
      pairId: resolvedPairId,
      eligible: true,
      safeReasonCode: ACCOUNT_FACADE_REASON_CODES.PAIR_ELIGIBLE,
      customerCopy: resolveCopy(ACCOUNT_FACADE_REASON_CODES.PAIR_ELIGIBLE),
    };
  }

  const reasonCode = mappedReasonCode ?? ACCOUNT_FACADE_REASON_CODES.PAIR_UNSUPPORTED;

  return {
    ok: false,
    pairId: resolvedPairId,
    eligible: false,
    safeReasonCode: reasonCode,
    customerCopy: resolveCopy(reasonCode),
  };
}

/**
 * The account facade contract, exposed as a single frozen object.
 * @type {{
 *   listEligibleAccounts: typeof listEligibleAccounts,
 *   validateCurrencyPair: typeof validateCurrencyPair,
 *   ACCOUNT_FACADE_REASON_CODES: typeof ACCOUNT_FACADE_REASON_CODES,
 * }}
 */
export const accountFacade = Object.freeze({
  listEligibleAccounts,
  validateCurrencyPair,
  ACCOUNT_FACADE_REASON_CODES,
});

// Referenced to document the fixture identifiers this facade relies upon.
void FIXTURE_IDS;

export default accountFacade;