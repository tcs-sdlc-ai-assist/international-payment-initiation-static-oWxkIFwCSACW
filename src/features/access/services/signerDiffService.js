/**
 * Signer before/after diff service (pure functions).
 *
 * SignerDiffService compares a normalized original signer record against a
 * proposed set of changes and emits a field-by-field before-and-after model for
 * the confirmation view. It supports the confirmation step in the signer
 * entitlement flow (SCRUM-825):
 *
 *   - `diffSigner(original, proposed, options)` normalizes both sides, restricts
 *     the comparison to a bounded, allow-listed set of comparable fields, and
 *     produces a deterministic diff describing which fields changed, their
 *     before/after values, and their masked display values.
 *
 * All functions are pure: they never mutate their arguments, never touch
 * storage, and never throw for malformed input — they degrade to an empty diff
 * so the confirmation view can render safely. Always-locked fields
 * (`signer_id`, `edit_revision`, `created_at`) are never treated as editable and
 * are excluded from the change set. Masked display values are derived via the
 * shared {@link maskingPolicy} so PII never leaks into the confirmation UI.
 */

import { maskingPolicy } from '@/shared/privacy/maskingPolicy';

/** Fields that can never be modified and are excluded from the diff. */
const ALWAYS_LOCKED_FIELDS = Object.freeze(['signer_id', 'edit_revision', 'created_at']);

/** Default masking context applied to before/after display values. */
const DEFAULT_MASKING_CONTEXT = maskingPolicy.MASKING_CONTEXTS.CONFIRMATION;

/**
 * The set of comparable signer fields, keyed by field name. Each descriptor
 * declares the value kind used for normalization and the PII field (if any)
 * used to derive a masked display value.
 * @type {Record<string, { kind: string, piiField?: string }>}
 */
const COMPARABLE_FIELDS = Object.freeze({
  signer_name: { kind: 'text', piiField: 'name' },
  email: { kind: 'text', piiField: 'email' },
  phone: { kind: 'text', piiField: 'phone' },
  authority: { kind: 'text' },
  amount_limit: { kind: 'number' },
  account_scopes: { kind: 'stringArray' },
  status: { kind: 'text' },
});

/** Ordered list of comparable field names for deterministic diff output. */
const COMPARABLE_FIELD_ORDER = Object.freeze(Object.keys(COMPARABLE_FIELDS));

/**
 * Determines whether a value is a plain, non-array object.
 * @param {unknown} value - The candidate value.
 * @returns {boolean} `true` when `value` is a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes an arbitrary value into a trimmed string, or `null` when empty.
 * @param {unknown} value - The raw value.
 * @returns {string | null} A trimmed string, or `null`.
 */
function normalizeText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/**
 * Normalizes an arbitrary value into a finite number, or `null`.
 * @param {unknown} value - The raw value.
 * @returns {number | null} A finite number, or `null`.
 */
function normalizeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Normalizes an arbitrary value into a sorted array of non-empty strings.
 * @param {unknown} value - The raw value.
 * @returns {string[]} A safe, sorted array of strings (may be empty).
 */
function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice()
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Normalizes a single field value according to its descriptor kind.
 * @param {unknown} value - The raw field value.
 * @param {string} kind - The value kind (`text`, `number`, `stringArray`).
 * @returns {string | number | string[] | null} The normalized value.
 */
function normalizeField(value, kind) {
  switch (kind) {
    case 'number':
      return normalizeNumber(value);
    case 'stringArray':
      return normalizeStringArray(value);
    case 'text':
    default:
      return normalizeText(value);
  }
}

/**
 * Determines whether two normalized field values are equal.
 * @param {string | number | string[] | null} left - The normalized before value.
 * @param {string | number | string[] | null} right - The normalized after value.
 * @returns {boolean} `true` when the values are equal.
 */
function valuesEqual(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    const leftArray = Array.isArray(left) ? left : [];
    const rightArray = Array.isArray(right) ? right : [];
    if (leftArray.length !== rightArray.length) {
      return false;
    }
    return leftArray.every((item, index) => item === rightArray[index]);
  }
  return left === right;
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
 * Derives a display value for a normalized field value, applying PII masking
 * when the field carries a masking descriptor.
 * @param {string | number | string[] | null} value - The normalized value.
 * @param {{ kind: string, piiField?: string }} descriptor - The field descriptor.
 * @param {string} context - The resolved masking context.
 * @returns {string} A display-safe representation of the value.
 */
function toDisplayValue(value, descriptor, context) {
  if (value === null || value === undefined) {
    return '—';
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(', ') : '—';
  }
  if (descriptor.piiField) {
    return maskingPolicy.mask(descriptor.piiField, value, context);
  }
  return String(value);
}

/**
 * Builds a single field-level diff entry.
 * @param {string} field - The field name.
 * @param {{ kind: string, piiField?: string }} descriptor - The field descriptor.
 * @param {Record<string, unknown>} original - The normalized original record.
 * @param {Record<string, unknown>} proposed - The normalized proposed record.
 * @param {string} context - The resolved masking context.
 * @returns {{
 *   field: string,
 *   changed: boolean,
 *   before: string | number | string[] | null,
 *   after: string | number | string[] | null,
 *   beforeDisplay: string,
 *   afterDisplay: string,
 * }} The field diff entry.
 */
function buildFieldDiff(field, descriptor, original, proposed, context) {
  const before = normalizeField(original[field], descriptor.kind);
  const hasProposed = Object.prototype.hasOwnProperty.call(proposed, field);
  const after = hasProposed ? normalizeField(proposed[field], descriptor.kind) : before;
  const changed = !valuesEqual(before, after);

  return {
    field,
    changed,
    before,
    after,
    beforeDisplay: toDisplayValue(before, descriptor, context),
    afterDisplay: toDisplayValue(after, descriptor, context),
  };
}

/**
 * Produces an empty diff result, used when inputs are unusable.
 * @returns {{
 *   hasChanges: boolean,
 *   fields: Array<Record<string, unknown>>,
 *   changedFields: Array<Record<string, unknown>>,
 *   changedFieldNames: string[],
 * }} An empty diff result.
 */
function emptyDiff() {
  return {
    hasChanges: false,
    fields: [],
    changedFields: [],
    changedFieldNames: [],
  };
}

/**
 * Compares a normalized original signer record against a proposed set of
 * changes, emitting a field-by-field before-and-after model for the
 * confirmation view.
 *
 * The comparison is restricted to an allow-listed set of comparable fields and
 * excludes always-locked fields. Values are normalized before comparison so
 * insignificant differences (whitespace, ordering) never register as changes.
 * Display values are masked via the shared {@link maskingPolicy} so PII never
 * leaks into the confirmation UI. The function never mutates its arguments and
 * never throws — malformed input degrades to an empty diff.
 *
 * @param {Record<string, unknown>} original - The original signer record.
 * @param {Record<string, unknown>} proposed - The proposed changes; only
 *   present keys are considered, all others inherit the original value.
 * @param {{ context?: string }} [options] - Optional diff options.
 * @returns {{
 *   hasChanges: boolean,
 *   fields: Array<{
 *     field: string,
 *     changed: boolean,
 *     before: string | number | string[] | null,
 *     after: string | number | string[] | null,
 *     beforeDisplay: string,
 *     afterDisplay: string,
 *   }>,
 *   changedFields: Array<Record<string, unknown>>,
 *   changedFieldNames: string[],
 * }} The before/after diff model.
 */
export function diffSigner(original, proposed, options) {
  if (!isPlainObject(original)) {
    return emptyDiff();
  }
  const proposedSource = isPlainObject(proposed) ? proposed : {};
  const context = resolveContext(options?.context);

  const fields = [];
  for (const field of COMPARABLE_FIELD_ORDER) {
    if (ALWAYS_LOCKED_FIELDS.includes(field)) {
      continue;
    }
    const descriptor = COMPARABLE_FIELDS[field];
    fields.push(buildFieldDiff(field, descriptor, original, proposedSource, context));
  }

  const changedFields = fields.filter((entry) => entry.changed);

  return {
    hasChanges: changedFields.length > 0,
    fields,
    changedFields,
    changedFieldNames: changedFields.map((entry) => entry.field),
  };
}

/**
 * Returns the ordered list of comparable signer field names.
 * @returns {string[]} The comparable field names.
 */
export function getComparableFields() {
  return COMPARABLE_FIELD_ORDER.slice();
}

/**
 * The signer diff service contract, exposed as a single frozen object.
 * @type {{
 *   diffSigner: typeof diffSigner,
 *   getComparableFields: typeof getComparableFields,
 *   COMPARABLE_FIELDS: typeof COMPARABLE_FIELDS,
 *   ALWAYS_LOCKED_FIELDS: typeof ALWAYS_LOCKED_FIELDS,
 * }}
 */
export const signerDiffService = Object.freeze({
  diffSigner,
  getComparableFields,
  COMPARABLE_FIELDS,
  ALWAYS_LOCKED_FIELDS,
});

export default signerDiffService;