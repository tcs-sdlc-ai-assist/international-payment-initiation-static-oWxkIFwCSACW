/**
 * CBPR+ transaction detail validator.
 *
 * CbprValidator builds field-aware, conditional Zod schemas from the bundled
 * `cbprRules.json` rule sets (via the {@link fixtureRegistry}) and validates the
 * structured payment detail fields required by CBPR+ (debtor/creditor/agent,
 * amount/settlement, purpose, remittance, structured address, and regulatory
 * fields). It supports the payment initiation flow (SCRUM-817):
 *
 *   - `resolveRuleSet(selector)` selects the applicable rule set by scheme /
 *     jurisdiction / currency, falling back to the default rule set, and only
 *     ever returns an eligible rule set.
 *   - `buildSchema(ruleSet, values)` builds a conditional Zod object schema from
 *     the rule set's field rules, honoring per-field requirement levels
 *     (mandatory / conditional / optional / forbidden), length bounds, permitted
 *     character sets, and ISO code formats (BIC, IBAN, country, currency, UETR,
 *     LEI). Conditional rules are evaluated against the supplied values.
 *   - `validate(selector, values)` resolves the rule set, generates a mock UETR
 *     when one is required but absent, builds the schema, and returns a
 *     discriminated `{ ok, ... }` result carrying sanitized field-level issues,
 *     safe reason codes, and the normalized values (including any generated
 *     UETR).
 *   - `generateUetr()` produces a deterministic-looking, demo-safe UETR (a v4
 *     UUID shape) used only for simulation.
 *
 * All functions are pure with respect to their arguments (they never mutate the
 * caller's object) and never throw for malformed input — they degrade to a
 * discriminated failure result carrying sanitized reason codes so callers can
 * gate the UI safely. This validator enforces client-side structural rules only
 * and carries no server guarantee.
 */

import { z } from 'zod';
import { fixtureRegistry, FIXTURE_IDS } from '@/shared/fixtures/fixtureRegistry';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Requirement levels a field rule may declare. */
const REQUIREMENT_LEVELS = Object.freeze({
  MANDATORY: 'mandatory',
  CONDITIONAL: 'conditional',
  OPTIONAL: 'optional',
  FORBIDDEN: 'forbidden',
});

/** Condition operators a conditional field rule may use. */
const CONDITION_OPERATORS = Object.freeze({
  EQUALS: 'equals',
  NOT_EQUALS: 'not_equals',
  IN: 'in',
  IS_PRESENT: 'is_present',
  IS_ABSENT: 'is_absent',
});

/**
 * Safe reason codes surfaced by the CBPR validator for gating and messaging.
 * @type {{
 *   VALID: 'cbpr.valid',
 *   RULE_SET_INELIGIBLE: 'cbpr.error.rule_set_ineligible',
 *   NO_RULE_SET: 'cbpr.error.no_rule_set',
 *   FIELD_REQUIRED: 'cbpr.field.required',
 *   FIELD_FORBIDDEN: 'cbpr.field.forbidden',
 *   FIELD_TOO_LONG: 'cbpr.field.too_long',
 *   FIELD_TOO_SHORT: 'cbpr.field.too_short',
 *   INVALID_CHARACTERS: 'cbpr.field.invalid_characters',
 *   INVALID_FORMAT: 'cbpr.field.invalid_format',
 *   UNEXPECTED: 'cbpr.error.unexpected',
 * }}
 */
export const CBPR_REASON_CODES = Object.freeze({
  VALID: 'cbpr.valid',
  RULE_SET_INELIGIBLE: 'cbpr.error.rule_set_ineligible',
  NO_RULE_SET: 'cbpr.error.no_rule_set',
  FIELD_REQUIRED: 'cbpr.field.required',
  FIELD_FORBIDDEN: 'cbpr.field.forbidden',
  FIELD_TOO_LONG: 'cbpr.field.too_long',
  FIELD_TOO_SHORT: 'cbpr.field.too_short',
  INVALID_CHARACTERS: 'cbpr.field.invalid_characters',
  INVALID_FORMAT: 'cbpr.field.invalid_format',
  UNEXPECTED: 'cbpr.error.unexpected',
});

/** Characters used to build the hexadecimal segments of a mock UETR. */
const HEX_ALPHABET = '0123456789abcdef';

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
 * Resolves a non-negative integer from a candidate value, falling back.
 * @param {unknown} value - The candidate value.
 * @param {number} fallback - The value returned when `value` is unusable.
 * @returns {number} A finite, non-negative integer.
 */
function toNonNegativeInt(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return fallback;
}

/**
 * Reads the CBPR rules fixture envelope.
 * @returns {Record<string, unknown>} The CBPR rules envelope (may be sparse).
 */
function readFixture() {
  const fixture = fixtureRegistry.getFixture(FIXTURE_IDS.CBPR_RULES);
  return isPlainObject(fixture) ? fixture : {};
}

/**
 * Reads the eligible rule sets from the bundled fixture.
 * @returns {Array<Record<string, unknown>>} The rule set records (may be empty).
 */
function readRuleSets() {
  const fixture = readFixture();
  if (!Array.isArray(fixture.ruleSets)) {
    return [];
  }
  return fixture.ruleSets.filter((ruleSet) => isPlainObject(ruleSet));
}

/**
 * Reads the default rule set from the bundled fixture.
 * @returns {Record<string, unknown> | undefined} The default rule set.
 */
function readDefaultRuleSet() {
  const fixture = readFixture();
  return isPlainObject(fixture.defaultRuleSet) ? fixture.defaultRuleSet : undefined;
}

/**
 * Reads the character sets from the bundled fixture, indexed by id.
 * @returns {Map<string, Record<string, unknown>>} Charset records by id.
 */
function readCharsets() {
  const fixture = readFixture();
  const map = new Map();
  if (!Array.isArray(fixture.charsets)) {
    return map;
  }
  for (const charset of fixture.charsets) {
    if (isPlainObject(charset) && typeof charset.id === 'string' && charset.id.length > 0) {
      map.set(charset.id, charset);
    }
  }
  return map;
}

/**
 * Reads the ISO code formats from the bundled fixture, indexed by id.
 * @returns {Map<string, Record<string, unknown>>} ISO format records by id.
 */
function readIsoFormats() {
  const fixture = readFixture();
  const map = new Map();
  if (!Array.isArray(fixture.isoCodeFormats)) {
    return map;
  }
  for (const format of fixture.isoCodeFormats) {
    if (isPlainObject(format) && typeof format.id === 'string' && format.id.length > 0) {
      map.set(format.id, format);
    }
  }
  return map;
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
 * Selects the applicable, eligible rule set for a selector, falling back to the
 * default rule set. Only eligible rule sets are ever returned.
 *
 * @param {{
 *   ruleSetId?: string,
 *   scheme?: string,
 *   jurisdiction?: string,
 *   currency?: string,
 * }} [selector] - The rule-set selector.
 * @returns {Record<string, unknown> | undefined} The resolved rule set.
 */
export function resolveRuleSet(selector) {
  const source = isPlainObject(selector) ? selector : {};
  const ruleSets = readRuleSets();

  const ruleSetId = toText(source.ruleSetId);
  if (ruleSetId.length > 0) {
    const byId = ruleSets.find(
      (ruleSet) => toText(ruleSet.rule_set_id) === ruleSetId && ruleSet.eligible === true,
    );
    if (byId) {
      return byId;
    }
  }

  const scheme = toText(source.scheme);
  const jurisdiction = toText(source.jurisdiction);
  const currency = toText(source.currency);

  // Only attempt criteria-based matching when at least one selector criterion
  // was actually supplied. Without this guard, an empty selector (or a
  // `ruleSetId` that doesn't resolve, with no other criteria) would fall
  // through to a predicate that vacuously matches every eligible rule set,
  // silently latching onto the first one in fixture order instead of
  // genuinely falling back to the default rule set.
  const hasCriteria = scheme.length > 0 || jurisdiction.length > 0 || currency.length > 0;

  const matched = hasCriteria
    ? ruleSets.find((ruleSet) => {
        if (ruleSet.eligible !== true) {
          return false;
        }
        if (scheme.length > 0 && toText(ruleSet.scheme) !== scheme) {
          return false;
        }
        if (jurisdiction.length > 0 && toText(ruleSet.jurisdiction) !== jurisdiction) {
          return false;
        }
        if (currency.length > 0 && toText(ruleSet.currency) !== currency) {
          return false;
        }
        return true;
      })
    : undefined;

  if (matched) {
    return matched;
  }

  const fallback = readDefaultRuleSet();
  if (fallback) {
    return fallback;
  }

  safeLogger.warn('cbprValidator: no applicable CBPR rule set found');
  return undefined;
}

/**
 * Reads a field value from the supplied values as a trimmed string.
 * @param {Record<string, unknown>} values - The candidate field values.
 * @param {string} field - The field name.
 * @returns {string} The trimmed field value (empty when absent).
 */
function readFieldValue(values, field) {
  return toText(values[field]);
}

/**
 * Evaluates a conditional field rule's condition against the supplied values.
 * @param {Record<string, unknown> | null | undefined} condition - The condition.
 * @param {Record<string, unknown>} values - The candidate field values.
 * @returns {boolean} `true` when the condition is satisfied (field required).
 */
function evaluateCondition(condition, values) {
  if (!isPlainObject(condition)) {
    return false;
  }
  const operator = toText(condition.operator);
  const field = toText(condition.field);
  const comparisons = toStringArray(condition.values);
  const actual = field.length > 0 ? readFieldValue(values, field) : '';

  switch (operator) {
    case CONDITION_OPERATORS.EQUALS:
      return comparisons.length > 0 && comparisons.includes(actual);
    case CONDITION_OPERATORS.NOT_EQUALS:
      return comparisons.length > 0 && !comparisons.includes(actual);
    case CONDITION_OPERATORS.IN:
      return comparisons.length > 0 && comparisons.includes(actual);
    case CONDITION_OPERATORS.IS_PRESENT:
      return actual.length > 0;
    case CONDITION_OPERATORS.IS_ABSENT:
      return actual.length === 0;
    default:
      return false;
  }
}

/**
 * Determines the effective requirement for a field rule, resolving conditional
 * rules against the supplied values.
 * @param {Record<string, unknown>} rule - The field rule.
 * @param {Record<string, unknown>} values - The candidate field values.
 * @returns {string} One of {@link REQUIREMENT_LEVELS}.
 */
function resolveRequirement(rule, values) {
  const requirement = toText(rule.requirement);
  if (requirement === REQUIREMENT_LEVELS.CONDITIONAL) {
    return evaluateCondition(rule.condition, values)
      ? REQUIREMENT_LEVELS.MANDATORY
      : REQUIREMENT_LEVELS.OPTIONAL;
  }
  if (
    requirement === REQUIREMENT_LEVELS.MANDATORY ||
    requirement === REQUIREMENT_LEVELS.OPTIONAL ||
    requirement === REQUIREMENT_LEVELS.FORBIDDEN
  ) {
    return requirement;
  }
  return REQUIREMENT_LEVELS.OPTIONAL;
}

/**
 * Builds the Zod schema for a single CBPR field rule.
 * @param {Record<string, unknown>} rule - The field rule.
 * @param {string} effectiveRequirement - The resolved requirement level.
 * @param {{
 *   charsets: Map<string, Record<string, unknown>>,
 *   isoFormats: Map<string, Record<string, unknown>>,
 * }} indexes - Charset and ISO-format indexes.
 * @returns {import('zod').ZodTypeAny} The field schema.
 */
function buildFieldSchema(rule, effectiveRequirement, indexes) {
  const minLength = toNonNegativeInt(rule.min_length, 0);
  const maxLength = toNonNegativeInt(rule.max_length, 140);
  const effectiveMax = Math.max(minLength, maxLength);

  const charsetId = toText(rule.charset_id);
  const charset = charsetId.length > 0 ? indexes.charsets.get(charsetId) : undefined;
  const permittedPattern = charset ? compilePattern(charset.permitted_pattern) : null;

  const isoFormatId = toText(rule.iso_format_id);
  const isoFormat = isoFormatId.length > 0 ? indexes.isoFormats.get(isoFormatId) : undefined;
  const isoPattern = isoFormat ? compilePattern(isoFormat.pattern) : null;

  let schema = z
    .string({ invalid_type_error: 'Enter a valid value.' })
    .trim()
    .max(effectiveMax, CBPR_REASON_CODES.FIELD_TOO_LONG);

  const required = effectiveRequirement === REQUIREMENT_LEVELS.MANDATORY;

  if (required) {
    schema = schema.min(Math.max(1, minLength), CBPR_REASON_CODES.FIELD_REQUIRED);
    if (permittedPattern) {
      schema = schema.regex(permittedPattern, CBPR_REASON_CODES.INVALID_CHARACTERS);
    }
    if (isoPattern) {
      schema = schema.regex(isoPattern, CBPR_REASON_CODES.INVALID_FORMAT);
    }
    return schema;
  }

  return schema
    .refine((value) => value.length === 0 || value.length >= minLength, {
      message: CBPR_REASON_CODES.FIELD_TOO_SHORT,
    })
    .refine((value) => value.length === 0 || !permittedPattern || permittedPattern.test(value), {
      message: CBPR_REASON_CODES.INVALID_CHARACTERS,
    })
    .refine((value) => value.length === 0 || !isoPattern || isoPattern.test(value), {
      message: CBPR_REASON_CODES.INVALID_FORMAT,
    })
    .optional()
    .or(z.literal(''));
}

/**
 * Builds a conditional Zod object schema from a rule set's field rules,
 * evaluating conditional requirements against the supplied values.
 *
 * @param {Record<string, unknown>} ruleSet - The resolved CBPR rule set.
 * @param {Record<string, unknown>} [values] - The candidate field values used
 *   to resolve conditional rules (never mutated).
 * @returns {{
 *   schema: import('zod').ZodObject<Record<string, import('zod').ZodTypeAny>>,
 *   forbiddenFields: string[],
 *   requiredFields: string[],
 * }} The built schema and its resolved field classifications.
 */
export function buildSchema(ruleSet, values) {
  const source = isPlainObject(ruleSet) ? ruleSet : {};
  const candidateValues = isPlainObject(values) ? values : {};
  const fieldRules = Array.isArray(source.fieldRules)
    ? source.fieldRules.filter((rule) => isPlainObject(rule))
    : [];

  const indexes = {
    charsets: readCharsets(),
    isoFormats: readIsoFormats(),
  };

  const shape = {};
  const forbiddenFields = [];
  const requiredFields = [];

  for (const rule of fieldRules) {
    const field = toText(rule.field);
    if (field.length === 0) {
      continue;
    }
    const effectiveRequirement = resolveRequirement(rule, candidateValues);
    if (effectiveRequirement === REQUIREMENT_LEVELS.FORBIDDEN) {
      forbiddenFields.push(field);
      continue;
    }
    if (effectiveRequirement === REQUIREMENT_LEVELS.MANDATORY) {
      requiredFields.push(field);
    }
    shape[field] = buildFieldSchema(rule, effectiveRequirement, indexes);
  }

  return {
    schema: z.object(shape),
    forbiddenFields,
    requiredFields,
  };
}

/**
 * Builds a single hexadecimal run of the requested length.
 * @param {number} length - The number of hex characters.
 * @returns {string} A random hexadecimal string.
 */
function hexRun(length) {
  let output = '';
  for (let index = 0; index < length; index += 1) {
    const position = Math.floor(Math.random() * HEX_ALPHABET.length);
    output += HEX_ALPHABET.charAt(position);
  }
  return output;
}

/**
 * Generates a demo-safe UETR shaped as a v4 UUID, used only for simulation.
 * @returns {string} A mock UETR string.
 */
export function generateUetr() {
  const variant = HEX_ALPHABET.charAt(8 + Math.floor(Math.random() * 4));
  return `${hexRun(8)}-${hexRun(4)}-4${hexRun(3)}-${variant}${hexRun(3)}-${hexRun(12)}`;
}

/**
 * Determines whether a rule set requires a UETR field.
 * @param {Record<string, unknown>} ruleSet - The resolved rule set.
 * @returns {boolean} `true` when a `uetr` field rule is mandatory.
 */
export function requiresUetr(ruleSet) {
  const source = isPlainObject(ruleSet) ? ruleSet : {};
  const fieldRules = Array.isArray(source.fieldRules) ? source.fieldRules : [];
  return fieldRules.some(
    (rule) =>
      isPlainObject(rule) &&
      toText(rule.field) === 'uetr' &&
      toText(rule.requirement) === REQUIREMENT_LEVELS.MANDATORY,
  );
}

/**
 * Builds a normalized values object, generating a mock UETR when the rule set
 * requires one and none is supplied.
 * @param {Record<string, unknown>} ruleSet - The resolved rule set.
 * @param {Record<string, unknown>} values - The supplied field values.
 * @returns {Record<string, unknown>} A new, normalized values object.
 */
function normalizeValues(ruleSet, values) {
  const normalized = { ...values };
  if (requiresUetr(ruleSet) && toText(normalized.uetr).length === 0) {
    normalized.uetr = generateUetr();
  }
  return normalized;
}

/**
 * Flattens Zod issues into sanitized, field-level entries.
 * @param {import('zod').ZodError} error - The Zod validation error.
 * @returns {Array<{ field: string, safeReasonCode: string }>} Sanitized issues.
 */
function flattenIssues(error) {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? String(issue.path[0]) : 'unknown';
    const message = typeof issue.message === 'string' ? issue.message : '';
    const safeReasonCode = message.startsWith('cbpr.')
      ? message
      : CBPR_REASON_CODES.INVALID_FORMAT;
    return { field, safeReasonCode };
  });
}

/**
 * Validates CBPR+ transaction detail fields against the applicable rule set.
 *
 * Resolves the rule set, generates a mock UETR when required, builds a
 * conditional schema, and validates the supplied values. Forbidden fields that
 * carry a value are reported. Never mutates its arguments and never throws —
 * malformed input degrades to a discriminated failure result.
 *
 * @param {{
 *   ruleSetId?: string,
 *   scheme?: string,
 *   jurisdiction?: string,
 *   currency?: string,
 * }} selector - The rule-set selector.
 * @param {Record<string, unknown>} values - The candidate field values.
 * @returns {{
 *   ok: true,
 *   ruleSetId: string | null,
 *   values: Record<string, unknown>,
 *   safeReasonCode: string,
 * } | {
 *   ok: false,
 *   ruleSetId: string | null,
 *   issues: Array<{ field: string, safeReasonCode: string }>,
 *   values: Record<string, unknown>,
 *   safeReasonCode: string,
 * }} A discriminated validation result.
 */
export function validate(selector, values) {
  const candidateValues = isPlainObject(values) ? values : {};

  const ruleSet = resolveRuleSet(selector);
  if (!ruleSet) {
    return {
      ok: false,
      ruleSetId: null,
      issues: [],
      values: { ...candidateValues },
      safeReasonCode: CBPR_REASON_CODES.NO_RULE_SET,
    };
  }

  const ruleSetId = toText(ruleSet.rule_set_id) || null;
  const normalized = normalizeValues(ruleSet, candidateValues);

  let built;
  try {
    built = buildSchema(ruleSet, normalized);
  } catch (error) {
    safeLogger.error('cbprValidator: failed to build CBPR schema', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return {
      ok: false,
      ruleSetId,
      issues: [],
      values: normalized,
      safeReasonCode: CBPR_REASON_CODES.UNEXPECTED,
    };
  }

  const issues = [];

  for (const field of built.forbiddenFields) {
    if (toText(normalized[field]).length > 0) {
      issues.push({ field, safeReasonCode: CBPR_REASON_CODES.FIELD_FORBIDDEN });
    }
  }

  const parsed = built.schema.safeParse(normalized);
  if (!parsed.success) {
    for (const issue of flattenIssues(parsed.error)) {
      issues.push(issue);
    }
  }

  if (issues.length > 0) {
    return {
      ok: false,
      ruleSetId,
      issues,
      values: normalized,
      safeReasonCode: issues[0].safeReasonCode,
    };
  }

  const sanitized = { ...normalized };
  if (parsed.success && isPlainObject(parsed.data)) {
    for (const key of Object.keys(parsed.data)) {
      sanitized[key] = parsed.data[key];
    }
  }

  return {
    ok: true,
    ruleSetId,
    values: sanitized,
    safeReasonCode: CBPR_REASON_CODES.VALID,
  };
}

/**
 * The CBPR validator contract, exposed as a single frozen object.
 * @type {{
 *   resolveRuleSet: typeof resolveRuleSet,
 *   buildSchema: typeof buildSchema,
 *   validate: typeof validate,
 *   generateUetr: typeof generateUetr,
 *   CBPR_REASON_CODES: typeof CBPR_REASON_CODES,
 * }}
 */
export const cbprValidator = Object.freeze({
  resolveRuleSet,
  buildSchema,
  validate,
  generateUetr,
  requiresUetr,
  CBPR_REASON_CODES,
});

export default cbprValidator;