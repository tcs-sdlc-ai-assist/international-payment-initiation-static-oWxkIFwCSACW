/**
 * Environment configuration loader.
 *
 * Reads and validates the non-sensitive Vite environment variables used by the
 * intl-payment-initiation app. Vite only exposes variables prefixed with
 * `VITE_` to client code, and these are all non-sensitive build labels.
 *
 * Each value is validated with a safe fallback so the app never fails to boot
 * because of a missing or malformed env var. The resulting configuration is
 * exposed as a frozen object.
 */

/** Default build label when {@link import.meta.env.VITE_APP_BUILD_LABEL} is unset. */
const DEFAULT_BUILD_LABEL = 'dev';

/** Default fixture pack when {@link import.meta.env.VITE_FIXTURE_PACK} is unset. */
const DEFAULT_FIXTURE_PACK = 'default';

/** Default reference date when {@link import.meta.env.VITE_REFERENCE_DATE} is unset or invalid. */
const DEFAULT_REFERENCE_DATE = '2026-07-28';

/** Matches an ISO 8601 calendar date in `YYYY-MM-DD` form. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalizes a raw env value to a trimmed, non-empty string or a fallback.
 * @param {unknown} value - The raw env value.
 * @param {string} fallback - The value returned when `value` is unusable.
 * @returns {string} The trimmed value, or `fallback` when empty/invalid.
 */
function readString(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Validates that a value is a real ISO 8601 date (`YYYY-MM-DD`).
 * @param {unknown} value - The raw env value.
 * @param {string} fallback - The date returned when `value` is invalid.
 * @returns {string} A valid ISO date string, or `fallback`.
 */
function readIsoDate(value, fallback) {
  const candidate = readString(value, fallback);
  if (!ISO_DATE_PATTERN.test(candidate)) {
    console.warn(
      `[env] VITE_REFERENCE_DATE "${candidate}" is not a valid ISO date; using "${fallback}".`,
    );
    return fallback;
  }
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    console.warn(
      `[env] VITE_REFERENCE_DATE "${candidate}" is not a real calendar date; using "${fallback}".`,
    );
    return fallback;
  }
  return candidate;
}

/**
 * Frozen application environment configuration derived from Vite env vars.
 * @type {{
 *   buildLabel: string,
 *   fixturePack: string,
 *   referenceDate: string,
 * }}
 */
export const ENV = Object.freeze({
  buildLabel: readString(import.meta.env.VITE_APP_BUILD_LABEL, DEFAULT_BUILD_LABEL),
  fixturePack: readString(import.meta.env.VITE_FIXTURE_PACK, DEFAULT_FIXTURE_PACK),
  referenceDate: readIsoDate(import.meta.env.VITE_REFERENCE_DATE, DEFAULT_REFERENCE_DATE),
});

export default ENV;