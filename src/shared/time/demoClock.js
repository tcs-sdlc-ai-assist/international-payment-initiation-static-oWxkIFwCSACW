/**
 * Deterministic demo reference clock.
 *
 * Provides an injectable clock abstraction anchored to the configured
 * reference date (default 2026-07-28). Rather than reading `Date.now()`
 * directly, all temporal logic across the app should use this module so
 * behavior stays deterministic in tests and fixtures while remaining
 * interactive at runtime (elapsed real time is added to the anchor).
 *
 * The anchor is captured once at module load. `now()` returns the anchor
 * plus however much real time has elapsed since load, so relative timers
 * (session timeout, rolling windows) still advance during a session.
 */

import { REFERENCE_DATE } from '@/shared/config/constants';

/** Milliseconds in a single minute. */
const MS_PER_MINUTE = 60_000;

/** Milliseconds in a single hour. */
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** Milliseconds in a single day. */
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Parses the reference date into an epoch millisecond anchor.
 * Falls back to a fixed instant when the value is unusable.
 * @param {string} referenceDate - ISO date in `YYYY-MM-DD` form.
 * @returns {number} Epoch milliseconds for midnight UTC of the reference date.
 */
function resolveAnchorMs(referenceDate) {
  const parsed = new Date(`${referenceDate}T00:00:00.000Z`).getTime();
  if (Number.isNaN(parsed)) {
    return new Date('2026-07-28T00:00:00.000Z').getTime();
  }
  return parsed;
}

/** Epoch milliseconds for the configured reference date anchor. */
const ANCHOR_MS = resolveAnchorMs(REFERENCE_DATE);

/** Real-time epoch milliseconds captured when this module was loaded. */
const LOAD_REAL_MS = Date.now();

/**
 * Coerces an input into epoch milliseconds.
 * @param {string | number | Date} instant - ISO string, epoch ms, or Date.
 * @returns {number} Epoch milliseconds.
 * @throws {TypeError} When the value cannot be parsed into a valid instant.
 */
function toEpochMs(instant) {
  if (instant instanceof Date) {
    const ms = instant.getTime();
    if (Number.isNaN(ms)) {
      throw new TypeError('demoClock: received an invalid Date instance.');
    }
    return ms;
  }
  if (typeof instant === 'number') {
    if (!Number.isFinite(instant)) {
      throw new TypeError('demoClock: received a non-finite epoch value.');
    }
    return instant;
  }
  if (typeof instant === 'string') {
    const ms = new Date(instant).getTime();
    if (Number.isNaN(ms)) {
      throw new TypeError(`demoClock: "${instant}" is not a valid ISO instant.`);
    }
    return ms;
  }
  throw new TypeError('demoClock: instant must be a string, number, or Date.');
}

/**
 * Returns the current epoch milliseconds anchored to the reference date,
 * offset by real time elapsed since module load.
 * @returns {number} Epoch milliseconds for the current demo instant.
 */
export function nowMs() {
  return ANCHOR_MS + (Date.now() - LOAD_REAL_MS);
}

/**
 * Returns the current demo instant as an ISO 8601 string.
 * @returns {string} ISO instant anchored to the reference date.
 */
export function now() {
  return new Date(nowMs()).toISOString();
}

/**
 * Adds a number of minutes to an instant.
 * @param {string | number | Date} instant - The base instant.
 * @param {number} minutes - Minutes to add (may be negative).
 * @returns {string} The resulting ISO instant.
 */
export function addMinutes(instant, minutes) {
  return new Date(toEpochMs(instant) + minutes * MS_PER_MINUTE).toISOString();
}

/**
 * Adds a number of hours to an instant.
 * @param {string | number | Date} instant - The base instant.
 * @param {number} hours - Hours to add (may be negative).
 * @returns {string} The resulting ISO instant.
 */
export function addHours(instant, hours) {
  return new Date(toEpochMs(instant) + hours * MS_PER_HOUR).toISOString();
}

/**
 * Adds a number of days to an instant.
 * @param {string | number | Date} instant - The base instant.
 * @param {number} days - Days to add (may be negative).
 * @returns {string} The resulting ISO instant.
 */
export function addDays(instant, days) {
  return new Date(toEpochMs(instant) + days * MS_PER_DAY).toISOString();
}

/**
 * Determines whether an expiry instant is at or before the current demo time.
 * @param {string | number | Date} expiresAt - The expiry instant.
 * @param {string | number | Date} [reference] - Optional reference instant;
 *   defaults to the current demo instant.
 * @returns {boolean} `true` when `expiresAt` is not in the future.
 */
export function isExpired(expiresAt, reference) {
  const referenceMs = reference === undefined ? nowMs() : toEpochMs(reference);
  return toEpochMs(expiresAt) <= referenceMs;
}

/**
 * Computes the whole-minute difference between two instants (`to - from`).
 * @param {string | number | Date} from - The earlier instant.
 * @param {string | number | Date} to - The later instant.
 * @returns {number} Signed number of minutes, truncated toward zero.
 */
export function diffMinutes(from, to) {
  return Math.trunc((toEpochMs(to) - toEpochMs(from)) / MS_PER_MINUTE);
}

/**
 * Determines whether an instant falls within the rolling 24-hour window
 * ending at the reference instant.
 * @param {string | number | Date} instant - The instant to test.
 * @param {string | number | Date} [reference] - Optional window end; defaults
 *   to the current demo instant.
 * @returns {boolean} `true` when `instant` is within the last 24 hours and not
 *   in the future relative to `reference`.
 */
export function isWithinRolling24h(instant, reference) {
  const referenceMs = reference === undefined ? nowMs() : toEpochMs(reference);
  const instantMs = toEpochMs(instant);
  return instantMs <= referenceMs && referenceMs - instantMs < MS_PER_DAY;
}

/**
 * The demo clock API, exposed as a single frozen object for injection.
 * @type {{
 *   now: () => string,
 *   nowMs: () => number,
 *   addMinutes: (instant: string | number | Date, minutes: number) => string,
 *   addHours: (instant: string | number | Date, hours: number) => string,
 *   addDays: (instant: string | number | Date, days: number) => string,
 *   isExpired: (expiresAt: string | number | Date, reference?: string | number | Date) => boolean,
 *   diffMinutes: (from: string | number | Date, to: string | number | Date) => number,
 *   isWithinRolling24h: (instant: string | number | Date, reference?: string | number | Date) => boolean,
 * }}
 */
export const demoClock = Object.freeze({
  now,
  nowMs,
  addMinutes,
  addHours,
  addDays,
  isExpired,
  diffMinutes,
  isWithinRolling24h,
});

export default demoClock;