/**
 * Validated fixture registry and indexing.
 *
 * FixtureRegistry loads every bundled JSON fixture at build time (statically
 * imported so Vite includes them in the bundle), validates each one with a
 * permissive-but-safe Zod schema, and builds composite-key indexes over the
 * high-traffic reference data (accounts, currency pairs, fee tiers). It exposes
 * typed accessors that never throw for missing data — callers receive
 * `undefined` or an empty array rather than a crash.
 *
 * Validation is intentionally tolerant: fixtures are demo-safe and may evolve,
 * so the registry validates the structural envelope and the fields it indexes,
 * then retains the raw records for everything else. If a fixture fails
 * validation the registry degrades to an empty, recoverable state for that
 * fixture and logs a sanitized diagnostic rather than aborting bootstrap.
 */

import { z } from 'zod';
import { safeLogger } from '@/shared/logging/safeLogger';

import esignScenarios from '@/fixtures/access/esignScenarios.json';
import accessMessages from '@/fixtures/access/messages.json';
import navigation from '@/fixtures/access/navigation.json';
import roles from '@/fixtures/access/roles.json';
import signers from '@/fixtures/access/signers.json';
import users from '@/fixtures/access/users.json';

import accounting from '@/fixtures/payment/accounting.json';
import accounts from '@/fixtures/payment/accounts.json';
import beneficiaries from '@/fixtures/payment/beneficiaries.json';
import cbccScenarios from '@/fixtures/payment/cbccScenarios.json';
import cbprRules from '@/fixtures/payment/cbprRules.json';
import currencyPairs from '@/fixtures/payment/currencyPairs.json';
import feeTiers from '@/fixtures/payment/feeTiers.json';
import fxQuotes from '@/fixtures/payment/fxQuotes.json';
import paymentMessages from '@/fixtures/payment/paymentMessages.json';
import paymentRecords from '@/fixtures/payment/paymentRecords.json';
import swiftScenarios from '@/fixtures/payment/swiftScenarios.json';

/** Stable identifiers for each bundled fixture. */
export const FIXTURE_IDS = Object.freeze({
  ESIGN_SCENARIOS: 'esignScenarios',
  ACCESS_MESSAGES: 'accessMessages',
  NAVIGATION: 'navigation',
  ROLES: 'roles',
  SIGNERS: 'signers',
  USERS: 'users',
  ACCOUNTING: 'accounting',
  ACCOUNTS: 'accounts',
  BENEFICIARIES: 'beneficiaries',
  CBCC_SCENARIOS: 'cbccScenarios',
  CBPR_RULES: 'cbprRules',
  CURRENCY_PAIRS: 'currencyPairs',
  FEE_TIERS: 'feeTiers',
  FX_QUOTES: 'fxQuotes',
  PAYMENT_MESSAGES: 'paymentMessages',
  PAYMENT_RECORDS: 'paymentRecords',
  SWIFT_SCENARIOS: 'swiftScenarios',
});

/** Common metadata envelope shared by every fixture. */
const FixtureEnvelopeSchema = z
  .object({
    schemaVersion: z.string().min(1),
    fixturePack: z.string().min(1),
    referenceDate: z.string().min(1),
    generatedAt: z.string().min(1),
  })
  .passthrough();

/** Schema for the accounts fixture (indexed by account_id + currency). */
const AccountsFixtureSchema = FixtureEnvelopeSchema.extend({
  accounts: z
    .array(
      z
        .object({
          account_id: z.string().min(1),
          currency: z.string().min(1),
          customer_segment: z.string().min(1).optional(),
          product: z.string().min(1).optional(),
          channel: z.string().min(1).optional(),
          status: z.string().min(1).optional(),
        })
        .passthrough(),
    )
    .default([]),
});

/** Schema for the currency pairs fixture (indexed by pair_id). */
const CurrencyPairsFixtureSchema = FixtureEnvelopeSchema.extend({
  currencyPairs: z
    .array(
      z
        .object({
          pair_id: z.string().min(1),
          base_currency: z.string().min(1),
          quote_currency: z.string().min(1),
          eligible: z.boolean(),
        })
        .passthrough(),
    )
    .default([]),
});

/** Schema for the fee tiers fixture (indexed by composite dimension key). */
const FeeTiersFixtureSchema = FixtureEnvelopeSchema.extend({
  feeTiers: z
    .array(
      z
        .object({
          tier_id: z.string().min(1),
          pair_id: z.string().min(1),
          customer_segment: z.string().min(1),
          product: z.string().min(1),
          channel: z.string().min(1),
        })
        .passthrough(),
    )
    .default([]),
  defaultTier: z.object({ tier_id: z.string().min(1) }).passthrough().optional(),
});

/** Schema for the beneficiaries fixture (indexed by beneficiary_id). */
const BeneficiariesFixtureSchema = FixtureEnvelopeSchema.extend({
  beneficiaries: z
    .array(
      z
        .object({
          beneficiary_id: z.string().min(1),
          currency: z.string().min(1),
          status: z.string().min(1).optional(),
        })
        .passthrough(),
    )
    .default([]),
});

/** Schema for the payment records fixture (indexed by payment_id). */
const PaymentRecordsFixtureSchema = FixtureEnvelopeSchema.extend({
  records: z
    .array(
      z
        .object({
          payment_id: z.string().min(1),
          status: z.string().min(1),
        })
        .passthrough(),
    )
    .default([]),
});

/** Schema for the roles fixture (indexed by role). */
const RolesFixtureSchema = FixtureEnvelopeSchema.extend({
  roles: z
    .array(
      z
        .object({
          role: z.string().min(1),
          capabilities: z.array(z.string()).default([]),
        })
        .passthrough(),
    )
    .default([]),
});

/** Schema for the users fixture (indexed by user_name). */
const UsersFixtureSchema = FixtureEnvelopeSchema.extend({
  users: z
    .array(
      z
        .object({
          user_id: z.string().min(1),
          user_name: z.string().min(1),
          role: z.string().min(1),
        })
        .passthrough(),
    )
    .default([]),
});

/** Schema for the signers fixture (indexed by signer_id). */
const SignersFixtureSchema = FixtureEnvelopeSchema.extend({
  signers: z
    .array(
      z
        .object({
          signer_id: z.string().min(1),
          status: z.string().min(1).optional(),
        })
        .passthrough(),
    )
    .default([]),
});

/** Schema for the FX quotes fixture (indexed by quote_ref). */
const FxQuotesFixtureSchema = FixtureEnvelopeSchema.extend({
  quotes: z
    .array(
      z
        .object({
          quote_ref: z.string().min(1),
          pair_id: z.string().min(1),
        })
        .passthrough(),
    )
    .default([]),
});

/** Loosely-validated schema for fixtures that are retained but not indexed. */
const LooseFixtureSchema = FixtureEnvelopeSchema;

/**
 * Safely validates a raw fixture against a schema, returning a recoverable
 * fallback when validation fails.
 * @template T
 * @param {string} fixtureId - A value from {@link FIXTURE_IDS}.
 * @param {z.ZodType<T>} schema - The schema to validate against.
 * @param {unknown} raw - The imported fixture value.
 * @param {T} fallback - Value returned when validation fails.
 * @returns {T} The validated fixture, or the fallback.
 */
function validateFixture(fixtureId, schema, raw, fallback) {
  const result = schema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  const firstIssue = result.error.issues[0];
  safeLogger.warn('fixtureRegistry: fixture failed validation; using recoverable fallback', {
    fixture: fixtureId,
    reason: firstIssue ? firstIssue.message : 'unknown',
  });
  return fallback;
}

/**
 * Builds a recoverable empty envelope for a keyed fixture.
 * @param {string} key - The array property name (e.g. `accounts`).
 * @returns {Record<string, unknown>} An empty, structurally-valid envelope.
 */
function emptyEnvelope(key) {
  return {
    schemaVersion: 'v1',
    fixturePack: 'default',
    referenceDate: '2026-07-28',
    generatedAt: '2026-07-28T00:00:00.000Z',
    [key]: [],
  };
}

/** Validated accounts fixture. */
const accountsFixture = validateFixture(
  FIXTURE_IDS.ACCOUNTS,
  AccountsFixtureSchema,
  accounts,
  emptyEnvelope('accounts'),
);

/** Validated currency pairs fixture. */
const currencyPairsFixture = validateFixture(
  FIXTURE_IDS.CURRENCY_PAIRS,
  CurrencyPairsFixtureSchema,
  currencyPairs,
  emptyEnvelope('currencyPairs'),
);

/** Validated fee tiers fixture. */
const feeTiersFixture = validateFixture(
  FIXTURE_IDS.FEE_TIERS,
  FeeTiersFixtureSchema,
  feeTiers,
  emptyEnvelope('feeTiers'),
);

/** Validated beneficiaries fixture. */
const beneficiariesFixture = validateFixture(
  FIXTURE_IDS.BENEFICIARIES,
  BeneficiariesFixtureSchema,
  beneficiaries,
  emptyEnvelope('beneficiaries'),
);

/** Validated payment records fixture. */
const paymentRecordsFixture = validateFixture(
  FIXTURE_IDS.PAYMENT_RECORDS,
  PaymentRecordsFixtureSchema,
  paymentRecords,
  emptyEnvelope('records'),
);

/** Validated roles fixture. */
const rolesFixture = validateFixture(
  FIXTURE_IDS.ROLES,
  RolesFixtureSchema,
  roles,
  emptyEnvelope('roles'),
);

/** Validated users fixture. */
const usersFixture = validateFixture(
  FIXTURE_IDS.USERS,
  UsersFixtureSchema,
  users,
  emptyEnvelope('users'),
);

/** Validated signers fixture. */
const signersFixture = validateFixture(
  FIXTURE_IDS.SIGNERS,
  SignersFixtureSchema,
  signers,
  emptyEnvelope('signers'),
);

/** Validated FX quotes fixture. */
const fxQuotesFixture = validateFixture(
  FIXTURE_IDS.FX_QUOTES,
  FxQuotesFixtureSchema,
  fxQuotes,
  emptyEnvelope('quotes'),
);

/** Validated navigation fixture (retained, not indexed). */
const navigationFixture = validateFixture(
  FIXTURE_IDS.NAVIGATION,
  LooseFixtureSchema,
  navigation,
  emptyEnvelope('navigation'),
);

/** Validated accounting fixture (retained, not indexed). */
const accountingFixture = validateFixture(
  FIXTURE_IDS.ACCOUNTING,
  LooseFixtureSchema,
  accounting,
  emptyEnvelope('accountingDeterminations'),
);

/** Validated CBPR rules fixture (retained, not indexed). */
const cbprRulesFixture = validateFixture(
  FIXTURE_IDS.CBPR_RULES,
  LooseFixtureSchema,
  cbprRules,
  emptyEnvelope('ruleSets'),
);

/** Validated CBCC scenarios fixture (retained, not indexed). */
const cbccScenariosFixture = validateFixture(
  FIXTURE_IDS.CBCC_SCENARIOS,
  LooseFixtureSchema,
  cbccScenarios,
  emptyEnvelope('scenarios'),
);

/** Validated SWIFT scenarios fixture (retained, not indexed). */
const swiftScenariosFixture = validateFixture(
  FIXTURE_IDS.SWIFT_SCENARIOS,
  LooseFixtureSchema,
  swiftScenarios,
  emptyEnvelope('scenarios'),
);

/** Validated eSign scenarios fixture (retained, not indexed). */
const esignScenariosFixture = validateFixture(
  FIXTURE_IDS.ESIGN_SCENARIOS,
  LooseFixtureSchema,
  esignScenarios,
  emptyEnvelope('scenarios'),
);

/** Validated access messages fixture (retained, not indexed). */
const accessMessagesFixture = validateFixture(
  FIXTURE_IDS.ACCESS_MESSAGES,
  LooseFixtureSchema,
  accessMessages,
  { schemaVersion: 'v1', fixturePack: 'default', referenceDate: '2026-07-28', generatedAt: '2026-07-28T00:00:00.000Z' },
);

/** Validated payment messages fixture (retained, not indexed). */
const paymentMessagesFixture = validateFixture(
  FIXTURE_IDS.PAYMENT_MESSAGES,
  LooseFixtureSchema,
  paymentMessages,
  { schemaVersion: 'v1', fixturePack: 'default', referenceDate: '2026-07-28', generatedAt: '2026-07-28T00:00:00.000Z' },
);

/**
 * Builds a composite fee-tier index key from its dimensions.
 * @param {string} pairId - The currency pair identifier.
 * @param {string} segment - The customer segment.
 * @param {string} product - The product.
 * @param {string} channel - The channel.
 * @returns {string} A composite index key.
 */
function buildFeeTierKey(pairId, segment, product, channel) {
  return `${pairId}|${segment}|${product}|${channel}`;
}

/**
 * Builds a Map index over a list of records keyed by a stable identifier.
 * @template T
 * @param {T[]} list - The records to index.
 * @param {(record: T) => string | undefined} keyFn - Extracts the index key.
 * @returns {Map<string, T>} The built index.
 */
function indexBy(list, keyFn) {
  const map = new Map();
  for (const record of list) {
    const key = keyFn(record);
    if (typeof key === 'string' && key.length > 0 && !map.has(key)) {
      map.set(key, record);
    }
  }
  return map;
}

/** Accounts indexed by `account_id`. */
const accountsById = indexBy(accountsFixture.accounts, (record) => record.account_id);

/** Currency pairs indexed by `pair_id`. */
const currencyPairsById = indexBy(currencyPairsFixture.currencyPairs, (record) => record.pair_id);

/** Fee tiers indexed by composite dimension key. */
const feeTiersByKey = indexBy(feeTiersFixture.feeTiers, (record) =>
  buildFeeTierKey(record.pair_id, record.customer_segment, record.product, record.channel),
);

/** Beneficiaries indexed by `beneficiary_id`. */
const beneficiariesById = indexBy(
  beneficiariesFixture.beneficiaries,
  (record) => record.beneficiary_id,
);

/** Payment records indexed by `payment_id`. */
const paymentRecordsById = indexBy(paymentRecordsFixture.records, (record) => record.payment_id);

/** Roles indexed by `role`. */
const rolesById = indexBy(rolesFixture.roles, (record) => record.role);

/** Users indexed by lowercased `user_name`. */
const usersByUsername = indexBy(usersFixture.users, (record) =>
  typeof record.user_name === 'string' ? record.user_name.toLowerCase() : undefined,
);

/** Signers indexed by `signer_id`. */
const signersById = indexBy(signersFixture.signers, (record) => record.signer_id);

/** FX quotes indexed by `quote_ref`. */
const fxQuotesByRef = indexBy(fxQuotesFixture.quotes, (record) => record.quote_ref);

/**
 * Returns all validated accounts.
 * @returns {Array<Record<string, unknown>>} The account records.
 */
export function getAccounts() {
  return accountsFixture.accounts;
}

/**
 * Looks up a single account by its identifier.
 * @param {string} accountId - The account identifier.
 * @returns {Record<string, unknown> | undefined} The account, or `undefined`.
 */
export function getAccountById(accountId) {
  if (typeof accountId !== 'string') {
    return undefined;
  }
  return accountsById.get(accountId);
}

/**
 * Returns all validated currency pairs.
 * @returns {Array<Record<string, unknown>>} The currency pair records.
 */
export function getCurrencyPairs() {
  return currencyPairsFixture.currencyPairs;
}

/**
 * Looks up a single currency pair by its identifier.
 * @param {string} pairId - The pair identifier (e.g. `EUR-USD`).
 * @returns {Record<string, unknown> | undefined} The pair, or `undefined`.
 */
export function getCurrencyPairById(pairId) {
  if (typeof pairId !== 'string') {
    return undefined;
  }
  return currencyPairsById.get(pairId);
}

/**
 * Determines whether a currency pair is eligible for selection.
 * @param {string} pairId - The pair identifier.
 * @returns {boolean} `true` when the pair exists and is eligible.
 */
export function isPairEligible(pairId) {
  const pair = getCurrencyPairById(pairId);
  return Boolean(pair && pair.eligible === true);
}

/**
 * Returns all validated fee tiers.
 * @returns {Array<Record<string, unknown>>} The fee tier records.
 */
export function getFeeTiers() {
  return feeTiersFixture.feeTiers;
}

/**
 * Looks up the fee tiers matching a composite dimension key, ordered as in the
 * source fixture. Multiple bands may share the same dimensions.
 * @param {{
 *   pairId: string,
 *   segment: string,
 *   product: string,
 *   channel: string,
 * }} dimensions - The fee-tier dimensions.
 * @returns {Array<Record<string, unknown>>} Matching fee tier bands.
 */
export function getFeeTiersForDimensions(dimensions) {
  const source = dimensions ?? {};
  const pairId = typeof source.pairId === 'string' ? source.pairId : '';
  const segment = typeof source.segment === 'string' ? source.segment : '';
  const product = typeof source.product === 'string' ? source.product : '';
  const channel = typeof source.channel === 'string' ? source.channel : '';
  const key = buildFeeTierKey(pairId, segment, product, channel);
  return feeTiersFixture.feeTiers.filter(
    (record) =>
      buildFeeTierKey(record.pair_id, record.customer_segment, record.product, record.channel) ===
      key,
  );
}

/**
 * Returns the default fee tier, if present.
 * @returns {Record<string, unknown> | undefined} The default tier.
 */
export function getDefaultFeeTier() {
  return feeTiersFixture.defaultTier;
}

/**
 * Returns all validated beneficiaries.
 * @returns {Array<Record<string, unknown>>} The beneficiary records.
 */
export function getBeneficiaries() {
  return beneficiariesFixture.beneficiaries;
}

/**
 * Looks up a single beneficiary by its identifier.
 * @param {string} beneficiaryId - The beneficiary identifier.
 * @returns {Record<string, unknown> | undefined} The beneficiary.
 */
export function getBeneficiaryById(beneficiaryId) {
  if (typeof beneficiaryId !== 'string') {
    return undefined;
  }
  return beneficiariesById.get(beneficiaryId);
}

/**
 * Returns all validated payment records.
 * @returns {Array<Record<string, unknown>>} The payment records.
 */
export function getPaymentRecords() {
  return paymentRecordsFixture.records;
}

/**
 * Looks up a single payment record by its identifier.
 * @param {string} paymentId - The payment identifier.
 * @returns {Record<string, unknown> | undefined} The payment record.
 */
export function getPaymentRecordById(paymentId) {
  if (typeof paymentId !== 'string') {
    return undefined;
  }
  return paymentRecordsById.get(paymentId);
}

/**
 * Returns all validated roles.
 * @returns {Array<Record<string, unknown>>} The role records.
 */
export function getRoles() {
  return rolesFixture.roles;
}

/**
 * Looks up a single role by its identifier.
 * @param {string} role - The role identifier.
 * @returns {Record<string, unknown> | undefined} The role record.
 */
export function getRoleById(role) {
  if (typeof role !== 'string') {
    return undefined;
  }
  return rolesById.get(role);
}

/**
 * Returns all validated users.
 * @returns {Array<Record<string, unknown>>} The user records.
 */
export function getUsers() {
  return usersFixture.users;
}

/**
 * Looks up a single user by their (case-insensitive) username.
 * @param {string} username - The username.
 * @returns {Record<string, unknown> | undefined} The user record.
 */
export function getUserByUsername(username) {
  if (typeof username !== 'string') {
    return undefined;
  }
  return usersByUsername.get(username.toLowerCase());
}

/**
 * Returns all validated signers.
 * @returns {Array<Record<string, unknown>>} The signer records.
 */
export function getSigners() {
  return signersFixture.signers;
}

/**
 * Looks up a single signer by its identifier.
 * @param {string} signerId - The signer identifier.
 * @returns {Record<string, unknown> | undefined} The signer record.
 */
export function getSignerById(signerId) {
  if (typeof signerId !== 'string') {
    return undefined;
  }
  return signersById.get(signerId);
}

/**
 * Returns all validated FX quotes.
 * @returns {Array<Record<string, unknown>>} The FX quote records.
 */
export function getFxQuotes() {
  return fxQuotesFixture.quotes;
}

/**
 * Looks up a single FX quote by its reference.
 * @param {string} quoteRef - The quote reference.
 * @returns {Record<string, unknown> | undefined} The FX quote record.
 */
export function getFxQuoteByRef(quoteRef) {
  if (typeof quoteRef !== 'string') {
    return undefined;
  }
  return fxQuotesByRef.get(quoteRef);
}

/**
 * Returns the full validated fixture envelope for a given fixture id.
 * @param {string} fixtureId - A value from {@link FIXTURE_IDS}.
 * @returns {Record<string, unknown> | undefined} The fixture envelope.
 */
export function getFixture(fixtureId) {
  switch (fixtureId) {
    case FIXTURE_IDS.ACCOUNTS:
      return accountsFixture;
    case FIXTURE_IDS.CURRENCY_PAIRS:
      return currencyPairsFixture;
    case FIXTURE_IDS.FEE_TIERS:
      return feeTiersFixture;
    case FIXTURE_IDS.BENEFICIARIES:
      return beneficiariesFixture;
    case FIXTURE_IDS.PAYMENT_RECORDS:
      return paymentRecordsFixture;
    case FIXTURE_IDS.ROLES:
      return rolesFixture;
    case FIXTURE_IDS.USERS:
      return usersFixture;
    case FIXTURE_IDS.SIGNERS:
      return signersFixture;
    case FIXTURE_IDS.FX_QUOTES:
      return fxQuotesFixture;
    case FIXTURE_IDS.NAVIGATION:
      return navigationFixture;
    case FIXTURE_IDS.ACCOUNTING:
      return accountingFixture;
    case FIXTURE_IDS.CBPR_RULES:
      return cbprRulesFixture;
    case FIXTURE_IDS.CBCC_SCENARIOS:
      return cbccScenariosFixture;
    case FIXTURE_IDS.SWIFT_SCENARIOS:
      return swiftScenariosFixture;
    case FIXTURE_IDS.ESIGN_SCENARIOS:
      return esignScenariosFixture;
    case FIXTURE_IDS.ACCESS_MESSAGES:
      return accessMessagesFixture;
    case FIXTURE_IDS.PAYMENT_MESSAGES:
      return paymentMessagesFixture;
    default:
      safeLogger.warn('fixtureRegistry: unknown fixture requested', { fixture: String(fixtureId) });
      return undefined;
  }
}

/**
 * The fixture registry contract, exposed as a single frozen object.
 * @type {{
 *   FIXTURE_IDS: typeof FIXTURE_IDS,
 *   getFixture: typeof getFixture,
 *   getAccounts: typeof getAccounts,
 *   getAccountById: typeof getAccountById,
 *   getCurrencyPairs: typeof getCurrencyPairs,
 *   getCurrencyPairById: typeof getCurrencyPairById,
 *   isPairEligible: typeof isPairEligible,
 *   getFeeTiers: typeof getFeeTiers,
 *   getFeeTiersForDimensions: typeof getFeeTiersForDimensions,
 *   getDefaultFeeTier: typeof getDefaultFeeTier,
 *   getBeneficiaries: typeof getBeneficiaries,
 *   getBeneficiaryById: typeof getBeneficiaryById,
 *   getPaymentRecords: typeof getPaymentRecords,
 *   getPaymentRecordById: typeof getPaymentRecordById,
 *   getRoles: typeof getRoles,
 *   getRoleById: typeof getRoleById,
 *   getUsers: typeof getUsers,
 *   getUserByUsername: typeof getUserByUsername,
 *   getSigners: typeof getSigners,
 *   getSignerById: typeof getSignerById,
 *   getFxQuotes: typeof getFxQuotes,
 *   getFxQuoteByRef: typeof getFxQuoteByRef,
 * }}
 */
export const fixtureRegistry = Object.freeze({
  FIXTURE_IDS,
  getFixture,
  getAccounts,
  getAccountById,
  getCurrencyPairs,
  getCurrencyPairById,
  isPairEligible,
  getFeeTiers,
  getFeeTiersForDimensions,
  getDefaultFeeTier,
  getBeneficiaries,
  getBeneficiaryById,
  getPaymentRecords,
  getPaymentRecordById,
  getRoles,
  getRoleById,
  getUsers,
  getUserByUsername,
  getSigners,
  getSignerById,
  getFxQuotes,
  getFxQuoteByRef,
});

export default fixtureRegistry;