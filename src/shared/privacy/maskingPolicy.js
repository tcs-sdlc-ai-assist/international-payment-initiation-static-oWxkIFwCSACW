/**
 * Centralized PII masking policy (cross-cluster contract).
 *
 * MaskingPolicy is the single source of truth for how personally identifiable
 * information (PII) is masked before it is displayed, logged, or persisted in
 * the intl-payment-initiation app. It implements the MaskingPolicy contract:
 *
 *   - `mask(field, value, context)` masks a single field-aware value.
 *   - `sanitizeObject(obj, context)` masks every known PII field within a flat
 *     or shallowly-nested plain object.
 *
 * Field-aware masking functions cover the full 16-field PII inventory:
 * account number, IBAN, BIC/SWIFT, card/PAN, email, phone, full name, first
 * name, last name, reference/remittance text, street address, city, postal
 * code, country, date of birth, and tax/national identifier.
 *
 * Each field is masked according to the active display context. Contexts range
 * from the most conservative (`audit`, which reveals almost nothing) to the
 * least (`detail`, which reveals more trailing characters for verification).
 */

/** Placeholder used when a value is absent or cannot be masked. */
const EMPTY_MASK = '—';

/** Default masking character. */
const MASK_CHAR = '•';

/**
 * Supported display contexts, ordered from most to least revealing.
 * @type {{
 *   LIST: 'list',
 *   DETAIL: 'detail',
 *   CONFIRMATION: 'confirmation',
 *   AUDIT: 'audit',
 * }}
 */
export const MASKING_CONTEXTS = Object.freeze({
  LIST: 'list',
  DETAIL: 'detail',
  CONFIRMATION: 'confirmation',
  AUDIT: 'audit',
});

/** Default context applied when none is supplied. */
const DEFAULT_CONTEXT = MASKING_CONTEXTS.LIST;

/**
 * Canonical PII field identifiers making up the 16-field inventory.
 * @type {{
 *   ACCOUNT: 'account',
 *   IBAN: 'iban',
 *   BIC: 'bic',
 *   CARD: 'card',
 *   EMAIL: 'email',
 *   PHONE: 'phone',
 *   NAME: 'name',
 *   FIRST_NAME: 'firstName',
 *   LAST_NAME: 'lastName',
 *   REFERENCE: 'reference',
 *   ADDRESS: 'address',
 *   CITY: 'city',
 *   POSTAL_CODE: 'postalCode',
 *   COUNTRY: 'country',
 *   DATE_OF_BIRTH: 'dateOfBirth',
 *   TAX_ID: 'taxId',
 * }}
 */
export const PII_FIELDS = Object.freeze({
  ACCOUNT: 'account',
  IBAN: 'iban',
  BIC: 'bic',
  CARD: 'card',
  EMAIL: 'email',
  PHONE: 'phone',
  NAME: 'name',
  FIRST_NAME: 'firstName',
  LAST_NAME: 'lastName',
  REFERENCE: 'reference',
  ADDRESS: 'address',
  CITY: 'city',
  POSTAL_CODE: 'postalCode',
  COUNTRY: 'country',
  DATE_OF_BIRTH: 'dateOfBirth',
  TAX_ID: 'taxId',
});

/**
 * Number of trailing characters to reveal per context for numeric-style
 * identifiers (account, IBAN, card, tax id).
 * @type {Record<string, number>}
 */
const REVEAL_TAIL_BY_CONTEXT = Object.freeze({
  [MASKING_CONTEXTS.LIST]: 4,
  [MASKING_CONTEXTS.DETAIL]: 4,
  [MASKING_CONTEXTS.CONFIRMATION]: 2,
  [MASKING_CONTEXTS.AUDIT]: 0,
});

/**
 * Normalizes an arbitrary value into a trimmed string.
 * @param {unknown} value - The raw value.
 * @returns {string} A trimmed string (empty when the value is unusable).
 */
function toText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value).trim();
  }
  return '';
}

/**
 * Resolves a supported context, falling back to the default.
 * @param {string} [context] - The requested context.
 * @returns {string} A valid context from {@link MASKING_CONTEXTS}.
 */
function resolveContext(context) {
  if (typeof context !== 'string') {
    return DEFAULT_CONTEXT;
  }
  const values = Object.values(MASKING_CONTEXTS);
  return values.includes(context) ? context : DEFAULT_CONTEXT;
}

/**
 * Builds a run of masking characters of the requested length.
 * @param {number} length - Desired mask length (clamped to a small maximum).
 * @returns {string} A string of masking characters.
 */
function maskRun(length) {
  const safeLength = Math.max(0, Math.min(length, 8));
  return MASK_CHAR.repeat(safeLength);
}

/**
 * Reveals the last `tail` characters of a compacted identifier, masking the
 * remainder with a fixed-width run.
 * @param {string} raw - The raw identifier value.
 * @param {number} tail - Number of trailing characters to reveal.
 * @returns {string} The masked identifier.
 */
function maskTail(raw, tail) {
  const compact = raw.replace(/\s+/g, '');
  if (compact.length === 0) {
    return EMPTY_MASK;
  }
  if (tail <= 0 || compact.length <= tail) {
    return maskRun(4);
  }
  return `${maskRun(4)}${compact.slice(-tail)}`;
}

/**
 * Masks a bank account number.
 * @param {unknown} value - The raw account number.
 * @param {string} [context] - The display context.
 * @returns {string} The masked account number.
 */
export function maskAccount(value, context) {
  const raw = toText(value);
  if (raw.length === 0) {
    return EMPTY_MASK;
  }
  return maskTail(raw, REVEAL_TAIL_BY_CONTEXT[resolveContext(context)]);
}

/**
 * Masks an IBAN, always preserving its country prefix outside of audit.
 * @param {unknown} value - The raw IBAN.
 * @param {string} [context] - The display context.
 * @returns {string} The masked IBAN.
 */
export function maskIban(value, context) {
  const raw = toText(value);
  if (raw.length === 0) {
    return EMPTY_MASK;
  }
  const ctx = resolveContext(context);
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  const tail = REVEAL_TAIL_BY_CONTEXT[ctx];
  if (ctx === MASKING_CONTEXTS.AUDIT) {
    return compact.slice(0, 2) || EMPTY_MASK;
  }
  const prefix = compact.slice(0, 2);
  if (compact.length <= 2 + tail) {
    return `${prefix}${maskRun(4)}`;
  }
  return `${prefix}${maskRun(4)}${compact.slice(-tail)}`;
}

/**
 * Masks a BIC/SWIFT code, revealing only the bank identifier segment.
 * @param {unknown} value - The raw BIC/SWIFT code.
 * @param {string} [context] - The display context.
 * @returns {string} The masked BIC/SWIFT code.
 */
export function maskBic(value, context) {
  const raw = toText(value);
  if (raw.length === 0) {
    return EMPTY_MASK;
  }
  const ctx = resolveContext(context);
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  if (ctx === MASKING_CONTEXTS.AUDIT) {
    return `${compact.slice(0, 4)}${maskRun(4)}`;
  }
  return `${compact.slice(0, 6)}${maskRun(4)}`;
}

/**
 * Masks a card/PAN value.
 * @param {unknown} value - The raw card number.
 * @param {string} [context] - The display context.
 * @returns {string} The masked card number.
 */
export function maskCard(value, context) {
  const raw = toText(value);
  if (raw.length === 0) {
    return EMPTY_MASK;
  }
  const ctx = resolveContext(context);
  const tail = ctx === MASKING_CONTEXTS.AUDIT ? 0 : 4;
  return maskTail(raw, tail);
}

/**
 * Masks an email address, preserving only leading and domain hints.
 * @param {unknown} value - The raw email address.
 * @param {string} [context] - The display context.
 * @returns {string} The masked email address.
 */
export function maskEmail(value, context) {
  const raw = toText(value);
  if (raw.length === 0) {
    return EMPTY_MASK;
  }
  const ctx = resolveContext(context);
  const atIndex = raw.indexOf('@');
  if (atIndex <= 0 || atIndex === raw.length - 1) {
    return maskRun(4);
  }
  const local = raw.slice(0, atIndex);
  const domain = raw.slice(atIndex + 1);
  if (ctx === MASKING_CONTEXTS.AUDIT) {
    return `${local.charAt(0)}${maskRun(4)}`;
  }
  const dotIndex = domain.lastIndexOf('.');
  const tld = dotIndex >= 0 ? domain.slice(dotIndex) : '';
  return `${local.charAt(0)}${maskRun(4)}@${maskRun(4)}${tld}`;
}

/**
 * Masks a phone number, revealing only the final digits.
 * @param {unknown} value - The raw phone number.
 * @param {string} [context] - The display context.
 * @returns {string} The masked phone number.
 */
export function maskPhone(value, context) {
  const raw = toText(value);
  if (raw.length === 0) {
    return EMPTY_MASK;
  }
  const ctx = resolveContext(context);
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.length === 0) {
    return maskRun(4);
  }
  if (ctx === MASKING_CONTEXTS.AUDIT) {
    return maskRun(4);
  }
  const tail = digits.slice(-2);
  return `${maskRun(4)}${tail}`;
}

/**
 * Masks a person's name (full, first, or last) by revealing initials only.
 * @param {unknown} value - The raw name.
 * @param {string} [context] - The display context.
 * @returns {string} The masked name.
 */
export function maskName(value, context) {
  const raw = toText(value);
  if (raw.length === 0) {
    return EMPTY_MASK;
  }
  const ctx = resolveContext(context);
  const parts = raw.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return EMPTY_MASK;
  }
  if (ctx === MASKING_CONTEXTS.AUDIT) {
    return parts.map((part) => `${part.charAt(0).toUpperCase()}.`).join('');
  }
  return parts.map((part) => `${part.charAt(0).toUpperCase()}${maskRun(3)}`).join(' ');
}

/**
 * Masks a payment reference / remittance text, revealing only a short prefix.
 * @param {unknown} value - The raw reference text.
 * @param {string} [context] - The display context.
 * @returns {string} The masked reference.
 */
export function maskReference(value, context) {
  const raw = toText(value);
  if (raw.length === 0) {
    return EMPTY_MASK;
  }
  const ctx = resolveContext(context);
  if (ctx === MASKING_CONTEXTS.AUDIT) {
    return maskRun(4);
  }
  const head = raw.slice(0, 3);
  return `${head}${maskRun(4)}`;
}

/**
 * Masks a street address, city, or postal code by revealing only a hint.
 * @param {unknown} value - The raw address component.
 * @param {string} [context] - The display context.
 * @returns {string} The masked address component.
 */
export function maskAddress(value, context) {
  const raw = toText(value);
  if (raw.length === 0) {
    return EMPTY_MASK;
  }
  const ctx = resolveContext(context);
  if (ctx === MASKING_CONTEXTS.AUDIT) {
    return maskRun(4);
  }
  const head = raw.slice(0, 2);
  return `${head}${maskRun(4)}`;
}

/**
 * Masks a date of birth, revealing only the birth year outside of audit.
 * @param {unknown} value - The raw date of birth.
 * @param {string} [context] - The display context.
 * @returns {string} The masked date of birth.
 */
export function maskDateOfBirth(value, context) {
  const raw = toText(value);
  if (raw.length === 0) {
    return EMPTY_MASK;
  }
  const ctx = resolveContext(context);
  if (ctx === MASKING_CONTEXTS.AUDIT) {
    return maskRun(4);
  }
  const yearMatch = raw.match(/(\d{4})/);
  const year = yearMatch ? yearMatch[1] : '';
  if (year.length === 0) {
    return maskRun(4);
  }
  return `${maskRun(4)}-${maskRun(2)}-${year.slice(-4)}`.replace(`-${year.slice(-4)}`, `-${year}`);
}

/**
 * Masks a country label, which is low-sensitivity and revealed except in audit.
 * @param {unknown} value - The raw country name or code.
 * @param {string} [context] - The display context.
 * @returns {string} The country label or a masked placeholder.
 */
export function maskCountry(value, context) {
  const raw = toText(value);
  if (raw.length === 0) {
    return EMPTY_MASK;
  }
  const ctx = resolveContext(context);
  if (ctx === MASKING_CONTEXTS.AUDIT) {
    return `${raw.slice(0, 2).toUpperCase()}`;
  }
  return raw;
}

/**
 * Masks a tax / national identifier.
 * @param {unknown} value - The raw identifier.
 * @param {string} [context] - The display context.
 * @returns {string} The masked identifier.
 */
export function maskTaxId(value, context) {
  const raw = toText(value);
  if (raw.length === 0) {
    return EMPTY_MASK;
  }
  const ctx = resolveContext(context);
  const tail = ctx === MASKING_CONTEXTS.AUDIT ? 0 : REVEAL_TAIL_BY_CONTEXT[ctx];
  return maskTail(raw, tail);
}

/**
 * Registry mapping each PII field to its masking function.
 * @type {Record<string, (value: unknown, context?: string) => string>}
 */
const FIELD_MASKERS = Object.freeze({
  [PII_FIELDS.ACCOUNT]: maskAccount,
  [PII_FIELDS.IBAN]: maskIban,
  [PII_FIELDS.BIC]: maskBic,
  [PII_FIELDS.CARD]: maskCard,
  [PII_FIELDS.EMAIL]: maskEmail,
  [PII_FIELDS.PHONE]: maskPhone,
  [PII_FIELDS.NAME]: maskName,
  [PII_FIELDS.FIRST_NAME]: maskName,
  [PII_FIELDS.LAST_NAME]: maskName,
  [PII_FIELDS.REFERENCE]: maskReference,
  [PII_FIELDS.ADDRESS]: maskAddress,
  [PII_FIELDS.CITY]: maskAddress,
  [PII_FIELDS.POSTAL_CODE]: maskAddress,
  [PII_FIELDS.COUNTRY]: maskCountry,
  [PII_FIELDS.DATE_OF_BIRTH]: maskDateOfBirth,
  [PII_FIELDS.TAX_ID]: maskTaxId,
});

/**
 * Aliases mapping common object property names to canonical PII fields.
 * @type {Record<string, string>}
 */
const FIELD_ALIASES = Object.freeze({
  account: PII_FIELDS.ACCOUNT,
  accountnumber: PII_FIELDS.ACCOUNT,
  accountno: PII_FIELDS.ACCOUNT,
  iban: PII_FIELDS.IBAN,
  bic: PII_FIELDS.BIC,
  swift: PII_FIELDS.BIC,
  swiftcode: PII_FIELDS.BIC,
  card: PII_FIELDS.CARD,
  cardnumber: PII_FIELDS.CARD,
  pan: PII_FIELDS.CARD,
  email: PII_FIELDS.EMAIL,
  emailaddress: PII_FIELDS.EMAIL,
  phone: PII_FIELDS.PHONE,
  phonenumber: PII_FIELDS.PHONE,
  mobile: PII_FIELDS.PHONE,
  telephone: PII_FIELDS.PHONE,
  name: PII_FIELDS.NAME,
  fullname: PII_FIELDS.NAME,
  beneficiaryname: PII_FIELDS.NAME,
  firstname: PII_FIELDS.FIRST_NAME,
  givenname: PII_FIELDS.FIRST_NAME,
  lastname: PII_FIELDS.LAST_NAME,
  surname: PII_FIELDS.LAST_NAME,
  familyname: PII_FIELDS.LAST_NAME,
  reference: PII_FIELDS.REFERENCE,
  remittance: PII_FIELDS.REFERENCE,
  remittanceinfo: PII_FIELDS.REFERENCE,
  memo: PII_FIELDS.REFERENCE,
  address: PII_FIELDS.ADDRESS,
  street: PII_FIELDS.ADDRESS,
  addressline1: PII_FIELDS.ADDRESS,
  addressline2: PII_FIELDS.ADDRESS,
  city: PII_FIELDS.CITY,
  town: PII_FIELDS.CITY,
  postalcode: PII_FIELDS.POSTAL_CODE,
  postcode: PII_FIELDS.POSTAL_CODE,
  zip: PII_FIELDS.POSTAL_CODE,
  zipcode: PII_FIELDS.POSTAL_CODE,
  country: PII_FIELDS.COUNTRY,
  countrycode: PII_FIELDS.COUNTRY,
  dateofbirth: PII_FIELDS.DATE_OF_BIRTH,
  dob: PII_FIELDS.DATE_OF_BIRTH,
  birthdate: PII_FIELDS.DATE_OF_BIRTH,
  taxid: PII_FIELDS.TAX_ID,
  nationalid: PII_FIELDS.TAX_ID,
  ssn: PII_FIELDS.TAX_ID,
});

/**
 * Resolves a raw field/property name to a canonical PII field, if any.
 * @param {string} field - The requested field or object property name.
 * @returns {string | undefined} The canonical PII field, or `undefined`.
 */
function resolveField(field) {
  if (typeof field !== 'string') {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(FIELD_MASKERS, field)) {
    return field;
  }
  const normalized = field.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (Object.prototype.hasOwnProperty.call(FIELD_ALIASES, normalized)) {
    return FIELD_ALIASES[normalized];
  }
  return undefined;
}

/**
 * Masks a single field-aware value according to the active context. Unknown
 * fields are returned unchanged, since only known PII fields are masked.
 * @param {string} field - The PII field identifier or object property name.
 * @param {unknown} value - The raw value to mask.
 * @param {string} [context] - The display context.
 * @returns {string} The masked (or unchanged) value.
 */
export function mask(field, value, context) {
  const canonical = resolveField(field);
  if (canonical === undefined) {
    return toText(value);
  }
  const masker = FIELD_MASKERS[canonical];
  return masker(value, resolveContext(context));
}

/**
 * Masks every known PII field within a flat or shallowly-nested plain object,
 * returning a new object. Nested plain objects are sanitized recursively (to a
 * bounded depth); arrays of plain objects are sanitized element-wise. Values
 * for unknown keys are preserved as-is.
 * @param {unknown} obj - The object to sanitize.
 * @param {string} [context] - The display context.
 * @param {number} [depth] - Internal recursion guard.
 * @returns {unknown} A sanitized copy of the input.
 */
export function sanitizeObject(obj, context, depth = 0) {
  const ctx = resolveContext(context);

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    if (depth >= 4) {
      return obj;
    }
    return obj.map((item) => sanitizeObject(item, ctx, depth + 1));
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  const output = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const canonical = resolveField(key);
    if (canonical !== undefined) {
      output[key] = FIELD_MASKERS[canonical](value, ctx);
      continue;
    }
    if (value !== null && typeof value === 'object' && depth < 4) {
      output[key] = sanitizeObject(value, ctx, depth + 1);
      continue;
    }
    output[key] = value;
  }

  return output;
}

/**
 * The MaskingPolicy contract, exposed as a single frozen object.
 * @type {{
 *   mask: (field: string, value: unknown, context?: string) => string,
 *   sanitizeObject: (obj: unknown, context?: string) => unknown,
 *   MASKING_CONTEXTS: typeof MASKING_CONTEXTS,
 *   PII_FIELDS: typeof PII_FIELDS,
 * }}
 */
export const maskingPolicy = Object.freeze({
  mask,
  sanitizeObject: (obj, context) => sanitizeObject(obj, context),
  MASKING_CONTEXTS,
  PII_FIELDS,
});

export default maskingPolicy;