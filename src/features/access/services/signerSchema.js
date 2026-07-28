/**
 * Signer edit-form schema builder.
 *
 * SignerSchema builds field-aware Zod schemas for the signer entitlement edit
 * form (SCRUM-825) from a representative jurisdiction / permitted-field
 * configuration. It is the single source of truth for client-side signer form
 * validation so the same rules drive both the React Hook Form resolver and any
 * programmatic validation:
 *
 *   - `buildSignerSchema(config)` returns a Zod object schema covering only the
 *     editable, permitted fields of a signer, honoring per-field required
 *     values, length bounds, and structural formats (email, phone, authority,
 *     amount limit, account scopes, status).
 *   - `getEditableFieldNames(config)` returns the ordered list of field names
 *     the resulting schema validates.
 *
 * The builder is intentionally conservative: always-locked fields
 * (`signer_id`, `edit_revision`, `created_at`) are never included, unknown or
 * non-editable fields are dropped, and a malformed configuration degrades to an
 * empty-but-valid schema rather than throwing. This keeps the edit form safe to
 * render even when the permitted-field configuration is incomplete.
 */

import { z } from 'zod';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Fields that can never be edited and are always excluded from the schema. */
const ALWAYS_LOCKED_FIELDS = Object.freeze(['signer_id', 'edit_revision', 'created_at']);

/** Default maximum length applied to free-text fields when unspecified. */
const DEFAULT_TEXT_MAX_LENGTH = 140;

/** Default minimum amount limit permitted for a signer. */
const DEFAULT_AMOUNT_MIN = 0;

/** Default maximum amount limit permitted for a signer. */
const DEFAULT_AMOUNT_MAX = 100_000_000;

/** Permitted authority values for the signer edit form. */
const AUTHORITY_VALUES = Object.freeze(['sole', 'joint', 'limited']);

/** Permitted status values for the signer edit form. */
const STATUS_VALUES = Object.freeze(['active', 'suspended', 'revoked', 'pending']);

/** Loose email pattern used for client-side signer email validation. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Loose international phone pattern (digits, spaces, dashes, parentheses, +). */
const PHONE_PATTERN = /^\+?[0-9()\-\s]{6,20}$/;

/**
 * The set of buildable signer fields, keyed by field name. Each descriptor
 * declares the value kind used to build the field's Zod schema.
 * @type {Record<string, { kind: string }>}
 */
const BUILDABLE_FIELDS = Object.freeze({
  signer_name: { kind: 'text' },
  email: { kind: 'email' },
  phone: { kind: 'phone' },
  authority: { kind: 'enum' },
  amount_limit: { kind: 'amount' },
  account_scopes: { kind: 'stringArray' },
  status: { kind: 'status' },
});

/** Ordered list of buildable field names for deterministic schema output. */
const BUILDABLE_FIELD_ORDER = Object.freeze(Object.keys(BUILDABLE_FIELDS));

/**
 * Determines whether a value is a plain, non-array object.
 * @param {unknown} value - The candidate value.
 * @returns {boolean} `true` when `value` is a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
 * Resolves a positive integer from a candidate value, falling back when unusable.
 * @param {unknown} value - The candidate value.
 * @param {number} fallback - The value returned when `value` is unusable.
 * @returns {number} A finite, non-negative integer.
 */
function toPositiveInt(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return fallback;
}

/**
 * Resolves a finite number from a candidate value, falling back when unusable.
 * @param {unknown} value - The candidate value.
 * @param {number} fallback - The value returned when `value` is unusable.
 * @returns {number} A finite number.
 */
function toFiniteNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

/**
 * Reads the per-field rule for a field from a normalized rules map.
 * @param {Record<string, unknown>} rules - The per-field rules map.
 * @param {string} field - The field name.
 * @returns {Record<string, unknown>} The field rule (may be empty).
 */
function readFieldRule(rules, field) {
  const rule = rules[field];
  return isPlainObject(rule) ? rule : {};
}

/**
 * Builds the Zod schema for a free-text field.
 * @param {Record<string, unknown>} rule - The field rule.
 * @returns {import('zod').ZodTypeAny} The field schema.
 */
function buildTextSchema(rule) {
  const required = rule.required === true;
  const minLength = toPositiveInt(rule.min_length, required ? 1 : 0);
  const maxLength = toPositiveInt(rule.max_length, DEFAULT_TEXT_MAX_LENGTH);
  const effectiveMax = Math.max(minLength, maxLength);

  let schema = z
    .string({ invalid_type_error: 'Enter a valid value.' })
    .trim()
    .max(effectiveMax, `Must be at most ${effectiveMax} characters.`);

  if (required) {
    schema = schema.min(Math.max(1, minLength), 'This field is required.');
    return schema;
  }

  if (minLength > 0) {
    return schema
      .refine((value) => value.length === 0 || value.length >= minLength, {
        message: `Must be at least ${minLength} characters.`,
      })
      .optional()
      .or(z.literal(''));
  }

  return schema.optional().or(z.literal(''));
}

/**
 * Builds the Zod schema for an email field.
 * @param {Record<string, unknown>} rule - The field rule.
 * @returns {import('zod').ZodTypeAny} The field schema.
 */
function buildEmailSchema(rule) {
  const required = rule.required === true;
  const maxLength = toPositiveInt(rule.max_length, DEFAULT_TEXT_MAX_LENGTH);

  const base = z
    .string({ invalid_type_error: 'Enter a valid email address.' })
    .trim()
    .max(maxLength, `Must be at most ${maxLength} characters.`);

  if (required) {
    return base
      .min(1, 'This field is required.')
      .regex(EMAIL_PATTERN, 'Enter a valid email address.');
  }

  return base
    .refine((value) => value.length === 0 || EMAIL_PATTERN.test(value), {
      message: 'Enter a valid email address.',
    })
    .optional()
    .or(z.literal(''));
}

/**
 * Builds the Zod schema for a phone field.
 * @param {Record<string, unknown>} rule - The field rule.
 * @returns {import('zod').ZodTypeAny} The field schema.
 */
function buildPhoneSchema(rule) {
  const required = rule.required === true;
  const maxLength = toPositiveInt(rule.max_length, 20);

  const base = z
    .string({ invalid_type_error: 'Enter a valid phone number.' })
    .trim()
    .max(maxLength, `Must be at most ${maxLength} characters.`);

  if (required) {
    return base
      .min(1, 'This field is required.')
      .regex(PHONE_PATTERN, 'Enter a valid phone number.');
  }

  return base
    .refine((value) => value.length === 0 || PHONE_PATTERN.test(value), {
      message: 'Enter a valid phone number.',
    })
    .optional()
    .or(z.literal(''));
}

/**
 * Resolves a permitted set of enum values from a rule, falling back to defaults.
 * @param {Record<string, unknown>} rule - The field rule.
 * @param {readonly string[]} fallback - The default permitted values.
 * @returns {string[]} A non-empty array of permitted values.
 */
function resolveEnumValues(rule, fallback) {
  const values = toStringArray(rule.values);
  return values.length > 0 ? values : fallback.slice();
}

/**
 * Builds the Zod schema for an enum-like field (authority/status).
 * @param {Record<string, unknown>} rule - The field rule.
 * @param {readonly string[]} fallbackValues - Default permitted values.
 * @returns {import('zod').ZodTypeAny} The field schema.
 */
function buildEnumSchema(rule, fallbackValues) {
  const required = rule.required === true;
  const permitted = new Set(resolveEnumValues(rule, fallbackValues));

  const base = z
    .string({ invalid_type_error: 'Select a valid option.' })
    .trim()
    .refine((value) => value.length === 0 || permitted.has(value), {
      message: 'Select a valid option.',
    });

  if (required) {
    return base.min(1, 'This field is required.');
  }

  return base.optional().or(z.literal(''));
}

/**
 * Builds the Zod schema for the amount-limit field.
 * @param {Record<string, unknown>} rule - The field rule.
 * @returns {import('zod').ZodTypeAny} The field schema.
 */
function buildAmountSchema(rule) {
  const required = rule.required === true;
  const min = toFiniteNumber(rule.min_amount, DEFAULT_AMOUNT_MIN);
  const maxCandidate = toFiniteNumber(rule.max_amount, DEFAULT_AMOUNT_MAX);
  const max = Math.max(min, maxCandidate);

  const numberSchema = z
    .number({ invalid_type_error: 'Enter a valid amount.' })
    .finite('Enter a valid amount.')
    .min(min, `Must be at least ${min}.`)
    .max(max, `Must be at most ${max}.`);

  if (required) {
    return numberSchema;
  }

  return numberSchema.nullable().optional();
}

/**
 * Builds the Zod schema for the account-scopes field.
 * @param {Record<string, unknown>} rule - The field rule.
 * @returns {import('zod').ZodTypeAny} The field schema.
 */
function buildStringArraySchema(rule) {
  const required = rule.required === true;
  const minItems = toPositiveInt(rule.min_items, required ? 1 : 0);
  const maxItems = toPositiveInt(rule.max_items, 50);
  const effectiveMax = Math.max(minItems, maxItems);

  let schema = z
    .array(z.string().trim().min(1, 'Each scope must be non-empty.'), {
      invalid_type_error: 'Select at least one account scope.',
    })
    .max(effectiveMax, `Select at most ${effectiveMax} account scopes.`);

  if (minItems > 0) {
    schema = schema.min(minItems, `Select at least ${minItems} account scope(s).`);
  }

  return required ? schema : schema.optional();
}

/**
 * Builds the Zod schema for a single buildable field.
 * @param {string} field - The field name.
 * @param {{ kind: string }} descriptor - The field descriptor.
 * @param {Record<string, unknown>} rule - The per-field rule.
 * @returns {import('zod').ZodTypeAny | undefined} The field schema, or `undefined`.
 */
function buildFieldSchema(field, descriptor, rule) {
  switch (descriptor.kind) {
    case 'text':
      return buildTextSchema(rule);
    case 'email':
      return buildEmailSchema(rule);
    case 'phone':
      return buildPhoneSchema(rule);
    case 'enum':
      return buildEnumSchema(rule, AUTHORITY_VALUES);
    case 'status':
      return buildEnumSchema(rule, STATUS_VALUES);
    case 'amount':
      return buildAmountSchema(rule);
    case 'stringArray':
      return buildStringArraySchema(rule);
    default:
      return undefined;
  }
}

/**
 * Resolves the ordered set of editable field names from a configuration.
 *
 * Only fields present in `editableFields`, buildable by this module, and not
 * always-locked are retained. Order follows the deterministic buildable order.
 *
 * @param {{
 *   editableFields?: string[],
 *   lockedFields?: string[],
 * }} config - The permitted-field configuration.
 * @returns {string[]} The ordered editable field names.
 */
export function getEditableFieldNames(config) {
  const source = isPlainObject(config) ? config : {};
  const editable = new Set(toStringArray(source.editableFields));
  const locked = new Set([...ALWAYS_LOCKED_FIELDS, ...toStringArray(source.lockedFields)]);

  return BUILDABLE_FIELD_ORDER.filter(
    (field) => editable.has(field) && !locked.has(field),
  );
}

/**
 * Builds a Zod object schema for a signer edit form from a representative
 * jurisdiction / permitted-field configuration.
 *
 * Only editable, permitted fields are included; always-locked and non-editable
 * fields are excluded. Per-field rules drive required values, length bounds, and
 * structural formats. A malformed configuration degrades to an empty-but-valid
 * schema so the edit form can still render safely.
 *
 * @param {{
 *   editableFields?: string[],
 *   lockedFields?: string[],
 *   fieldRules?: Record<string, Record<string, unknown>>,
 * }} config - The permitted-field configuration.
 * @returns {import('zod').ZodObject<Record<string, import('zod').ZodTypeAny>>}
 *   The built signer form schema.
 */
export function buildSignerSchema(config) {
  const source = isPlainObject(config) ? config : {};
  const rules = isPlainObject(source.fieldRules) ? source.fieldRules : {};
  const fields = getEditableFieldNames(source);

  const shape = {};
  for (const field of fields) {
    const descriptor = BUILDABLE_FIELDS[field];
    if (!descriptor) {
      continue;
    }
    const fieldSchema = buildFieldSchema(field, descriptor, readFieldRule(rules, field));
    if (fieldSchema === undefined) {
      safeLogger.warn('signerSchema: skipped unbuildable field', { field });
      continue;
    }
    shape[field] = fieldSchema;
  }

  return z.object(shape).strict();
}

/**
 * The signer schema builder contract, exposed as a single frozen object.
 * @type {{
 *   buildSignerSchema: typeof buildSignerSchema,
 *   getEditableFieldNames: typeof getEditableFieldNames,
 *   ALWAYS_LOCKED_FIELDS: typeof ALWAYS_LOCKED_FIELDS,
 *   AUTHORITY_VALUES: typeof AUTHORITY_VALUES,
 *   STATUS_VALUES: typeof STATUS_VALUES,
 * }}
 */
export const signerSchema = Object.freeze({
  buildSignerSchema,
  getEditableFieldNames,
  ALWAYS_LOCKED_FIELDS,
  AUTHORITY_VALUES,
  STATUS_VALUES,
});

export default signerSchema;