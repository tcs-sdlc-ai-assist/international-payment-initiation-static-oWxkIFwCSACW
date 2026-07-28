/**
 * Signer eligibility policy (pure functions).
 *
 * SignerPolicy provides deny-by-default, side-effect-free eligibility functions
 * for the signer entitlement operations exposed in the access cluster:
 *
 *   - `canEditField(signer, field)` answers whether a specific field may be
 *     edited on a signer, honoring the signer's editable/locked field lists and
 *     the always-locked fields that can never be changed. Editing is only
 *     permitted for active, unlocked signers.
 *   - `canUnlock(signer)` answers whether a signer may be unlocked; unlocking is
 *     only permitted when the signer is currently locked and otherwise eligible
 *     (active).
 *   - `canResend(signer, context)` answers whether a fresh invitation may be
 *     resent; resending is only permitted for signers whose invitation has
 *     expired, that are otherwise eligible, and when fewer than the configured
 *     maximum resend attempts have been recorded in the rolling 24-hour window
 *     relative to the deterministic {@link demoClock}.
 *
 * All functions are pure: they never mutate their arguments, never touch
 * storage, and never throw for malformed input — they degrade to `false` with a
 * sanitized reason code so callers can gate the UI safely. Boundaries follow the
 * fixture policy: the resend attempt count is compared with a strict less-than
 * against {@link MAX_RESENDS_24H}, and the rolling window is inclusive of its
 * lower edge and exclusive of the upper (future) edge, matching
 * {@link demoClock.isWithinRolling24h}.
 */

import { MAX_RESENDS_24H } from '@/shared/config/constants';
import { demoClock } from '@/shared/time/demoClock';

/** Fields that can never be modified regardless of a signer's field lists. */
const ALWAYS_LOCKED_FIELDS = Object.freeze([
  'signer_id',
  'edit_revision',
  'created_at',
]);

/** Signer status value required for a signer to be actionable. */
const ACTIVE_STATUS = 'active';

/** Invitation state value indicating a lapsed invitation. */
const EXPIRED_INVITATION_STATE = 'expired';

/**
 * Safe reason codes surfaced by the signer policy for gating and messaging.
 * @type {{
 *   ELIGIBLE: 'signer.policy.eligible',
 *   NOT_FOUND: 'signer.policy.not_found',
 *   INACTIVE: 'signer.policy.inactive',
 *   LOCKED: 'signer.policy.locked',
 *   NOT_LOCKED: 'signer.policy.not_locked',
 *   FIELD_LOCKED: 'signer.policy.field_locked',
 *   FIELD_NOT_EDITABLE: 'signer.policy.field_not_editable',
 *   INVITATION_NOT_EXPIRED: 'signer.policy.invitation_not_expired',
 *   RESEND_LIMIT_REACHED: 'signer.policy.resend_limit_reached',
 * }}
 */
export const SIGNER_POLICY_REASON_CODES = Object.freeze({
  ELIGIBLE: 'signer.policy.eligible',
  NOT_FOUND: 'signer.policy.not_found',
  INACTIVE: 'signer.policy.inactive',
  LOCKED: 'signer.policy.locked',
  NOT_LOCKED: 'signer.policy.not_locked',
  FIELD_LOCKED: 'signer.policy.field_locked',
  FIELD_NOT_EDITABLE: 'signer.policy.field_not_editable',
  INVITATION_NOT_EXPIRED: 'signer.policy.invitation_not_expired',
  RESEND_LIMIT_REACHED: 'signer.policy.resend_limit_reached',
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
 * Builds a discriminated allow result.
 * @param {string} reasonCode - A sanitized reason code.
 * @returns {{ allowed: true, safeReasonCode: string }} An allow result.
 */
function allow(reasonCode) {
  return { allowed: true, safeReasonCode: reasonCode };
}

/**
 * Builds a discriminated deny result.
 * @param {string} reasonCode - A sanitized reason code.
 * @returns {{ allowed: false, safeReasonCode: string }} A deny result.
 */
function deny(reasonCode) {
  return { allowed: false, safeReasonCode: reasonCode };
}

/**
 * Determines whether a signer is currently active.
 * @param {Record<string, unknown>} signer - The signer record.
 * @returns {boolean} `true` when the signer's status is active.
 */
function isActive(signer) {
  return typeof signer.status === 'string' && signer.status === ACTIVE_STATUS;
}

/**
 * Determines whether a signer is currently locked.
 * @param {Record<string, unknown>} signer - The signer record.
 * @returns {boolean} `true` when the signer is locked.
 */
function isLocked(signer) {
  return signer.locked === true;
}

/**
 * Evaluates whether a specific field may be edited on a signer.
 *
 * Deny-by-default: editing requires an active, unlocked signer; the field must
 * not be an always-locked or explicitly-locked field; and the field must be
 * present in the signer's `editable_fields` list.
 *
 * @param {Record<string, unknown>} signer - The signer record.
 * @param {string} field - The field to evaluate.
 * @returns {{ allowed: boolean, safeReasonCode: string }} A discriminated result.
 */
export function evaluateEditField(signer, field) {
  if (!isPlainObject(signer)) {
    return deny(SIGNER_POLICY_REASON_CODES.NOT_FOUND);
  }
  if (typeof field !== 'string' || field.length === 0) {
    return deny(SIGNER_POLICY_REASON_CODES.FIELD_NOT_EDITABLE);
  }
  if (!isActive(signer)) {
    return deny(SIGNER_POLICY_REASON_CODES.INACTIVE);
  }
  if (isLocked(signer)) {
    return deny(SIGNER_POLICY_REASON_CODES.LOCKED);
  }
  if (ALWAYS_LOCKED_FIELDS.includes(field)) {
    return deny(SIGNER_POLICY_REASON_CODES.FIELD_LOCKED);
  }
  const lockedFields = toStringArray(signer.locked_fields);
  if (lockedFields.includes(field)) {
    return deny(SIGNER_POLICY_REASON_CODES.FIELD_LOCKED);
  }
  const editableFields = toStringArray(signer.editable_fields);
  if (!editableFields.includes(field)) {
    return deny(SIGNER_POLICY_REASON_CODES.FIELD_NOT_EDITABLE);
  }
  return allow(SIGNER_POLICY_REASON_CODES.ELIGIBLE);
}

/**
 * Determines whether a specific field may be edited on a signer.
 * @param {Record<string, unknown>} signer - The signer record.
 * @param {string} field - The field to evaluate.
 * @returns {boolean} `true` when the field may be edited.
 */
export function canEditField(signer, field) {
  return evaluateEditField(signer, field).allowed;
}

/**
 * Evaluates whether a signer may be unlocked.
 *
 * Deny-by-default: unlocking requires an active signer that is currently locked.
 *
 * @param {Record<string, unknown>} signer - The signer record.
 * @returns {{ allowed: boolean, safeReasonCode: string }} A discriminated result.
 */
export function evaluateUnlock(signer) {
  if (!isPlainObject(signer)) {
    return deny(SIGNER_POLICY_REASON_CODES.NOT_FOUND);
  }
  if (!isActive(signer)) {
    return deny(SIGNER_POLICY_REASON_CODES.INACTIVE);
  }
  if (!isLocked(signer)) {
    return deny(SIGNER_POLICY_REASON_CODES.NOT_LOCKED);
  }
  return allow(SIGNER_POLICY_REASON_CODES.ELIGIBLE);
}

/**
 * Determines whether a signer may be unlocked.
 * @param {Record<string, unknown>} signer - The signer record.
 * @returns {boolean} `true` when the signer may be unlocked.
 */
export function canUnlock(signer) {
  return evaluateUnlock(signer).allowed;
}

/**
 * Resolves the recorded resend attempt count from an eligibility context.
 *
 * A caller may supply either a precomputed non-negative `resendCount` or a list
 * of resend attempt instants under `resendTimestamps`; when timestamps are
 * supplied they are filtered to the rolling 24-hour window ending at the
 * reference instant, honoring the inclusive lower / exclusive upper boundary
 * rule of {@link demoClock.isWithinRolling24h}.
 *
 * @param {{
 *   resendCount?: number,
 *   resendTimestamps?: Array<string | number | Date>,
 *   reference?: string | number | Date,
 * }} context - The resend eligibility context.
 * @returns {number} The effective resend attempt count within the window.
 */
function resolveResendCount(context) {
  if (typeof context.resendCount === 'number' && Number.isFinite(context.resendCount)) {
    return context.resendCount >= 0 ? Math.trunc(context.resendCount) : 0;
  }
  if (Array.isArray(context.resendTimestamps)) {
    const reference = context.reference;
    let count = 0;
    for (const instant of context.resendTimestamps) {
      try {
        if (demoClock.isWithinRolling24h(instant, reference)) {
          count += 1;
        }
      } catch {
        // Malformed instants are ignored rather than blocking the whole count.
      }
    }
    return count;
  }
  return 0;
}

/**
 * Evaluates whether a fresh invitation may be resent for a signer.
 *
 * Deny-by-default: resending requires an active signer whose invitation has
 * expired, and fewer than {@link MAX_RESENDS_24H} recorded resend attempts in
 * the rolling 24-hour window relative to the deterministic {@link demoClock}.
 * The attempt count is compared with a strict less-than against the maximum.
 *
 * @param {Record<string, unknown>} signer - The signer record.
 * @param {{
 *   resendCount?: number,
 *   resendTimestamps?: Array<string | number | Date>,
 *   reference?: string | number | Date,
 * }} [context] - Optional resend eligibility context.
 * @returns {{ allowed: boolean, safeReasonCode: string }} A discriminated result.
 */
export function evaluateResend(signer, context) {
  if (!isPlainObject(signer)) {
    return deny(SIGNER_POLICY_REASON_CODES.NOT_FOUND);
  }
  if (!isActive(signer)) {
    return deny(SIGNER_POLICY_REASON_CODES.INACTIVE);
  }
  if (isLocked(signer)) {
    return deny(SIGNER_POLICY_REASON_CODES.LOCKED);
  }
  if (
    typeof signer.invitation_state !== 'string' ||
    signer.invitation_state !== EXPIRED_INVITATION_STATE
  ) {
    return deny(SIGNER_POLICY_REASON_CODES.INVITATION_NOT_EXPIRED);
  }
  const source = isPlainObject(context) ? context : {};
  const resendCount = resolveResendCount(source);
  if (resendCount >= MAX_RESENDS_24H) {
    return deny(SIGNER_POLICY_REASON_CODES.RESEND_LIMIT_REACHED);
  }
  return allow(SIGNER_POLICY_REASON_CODES.ELIGIBLE);
}

/**
 * Determines whether a fresh invitation may be resent for a signer.
 * @param {Record<string, unknown>} signer - The signer record.
 * @param {{
 *   resendCount?: number,
 *   resendTimestamps?: Array<string | number | Date>,
 *   reference?: string | number | Date,
 * }} [context] - Optional resend eligibility context.
 * @returns {boolean} `true` when a resend is permitted.
 */
export function canResend(signer, context) {
  return evaluateResend(signer, context).allowed;
}

/**
 * The signer policy contract, exposed as a single frozen object.
 * @type {{
 *   canEditField: typeof canEditField,
 *   evaluateEditField: typeof evaluateEditField,
 *   canUnlock: typeof canUnlock,
 *   evaluateUnlock: typeof evaluateUnlock,
 *   canResend: typeof canResend,
 *   evaluateResend: typeof evaluateResend,
 *   ALWAYS_LOCKED_FIELDS: typeof ALWAYS_LOCKED_FIELDS,
 *   SIGNER_POLICY_REASON_CODES: typeof SIGNER_POLICY_REASON_CODES,
 * }}
 */
export const signerPolicy = Object.freeze({
  canEditField,
  evaluateEditField,
  canUnlock,
  evaluateUnlock,
  canResend,
  evaluateResend,
  ALWAYS_LOCKED_FIELDS,
  SIGNER_POLICY_REASON_CODES,
});

export default signerPolicy;