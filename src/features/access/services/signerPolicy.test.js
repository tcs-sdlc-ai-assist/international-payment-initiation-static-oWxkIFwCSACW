/**
 * Unit tests for the signer eligibility policy.
 *
 * These tests exercise the deny-by-default eligibility functions: field-level
 * edit permissions (active/unlocked, always-locked, explicitly-locked, and
 * editable-list checks), unlock conditions (active + currently locked), and the
 * resend rolling-24h boundary (a fourth attempt is blocked, and timestamps
 * outside the window are excluded from the count).
 */

import { describe, it, expect } from 'vitest';
import {
  canEditField,
  evaluateEditField,
  canUnlock,
  evaluateUnlock,
  canResend,
  evaluateResend,
  SIGNER_POLICY_REASON_CODES,
} from '@/features/access/services/signerPolicy';
import { MAX_RESENDS_24H } from '@/shared/config/constants';
import { demoClock } from '@/shared/time/demoClock';

/**
 * Builds a baseline active, unlocked signer record with sensible defaults that
 * individual tests may override.
 * @param {Record<string, unknown>} [overrides] - Field overrides.
 * @returns {Record<string, unknown>} A signer record.
 */
function buildSigner(overrides) {
  return {
    signer_id: 'demo-signer-0001',
    status: 'active',
    locked: false,
    lock_reason: null,
    invitation_state: 'accepted',
    editable_fields: ['signer_name', 'email', 'phone', 'authority', 'account_scopes', 'status'],
    locked_fields: ['signer_id', 'edit_revision', 'created_at'],
    ...(overrides ?? {}),
  };
}

describe('signerPolicy.evaluateEditField', () => {
  it('allows editing a permitted field on an active, unlocked signer', () => {
    const result = evaluateEditField(buildSigner(), 'signer_name');
    expect(result.allowed).toBe(true);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.ELIGIBLE);
  });

  it('denies editing when the signer is inactive', () => {
    const result = evaluateEditField(buildSigner({ status: 'suspended' }), 'signer_name');
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.INACTIVE);
  });

  it('denies editing when the signer is locked', () => {
    const result = evaluateEditField(
      buildSigner({ locked: true, lock_reason: 'concurrent_edit' }),
      'signer_name',
    );
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.LOCKED);
  });

  it('denies editing an always-locked field', () => {
    const result = evaluateEditField(
      buildSigner({ editable_fields: ['signer_id'] }),
      'signer_id',
    );
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.FIELD_LOCKED);
  });

  it('denies editing a field present in the locked_fields list', () => {
    const result = evaluateEditField(
      buildSigner({
        editable_fields: ['authority'],
        locked_fields: ['signer_id', 'edit_revision', 'created_at', 'authority'],
      }),
      'authority',
    );
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.FIELD_LOCKED);
  });

  it('denies editing a field that is not in the editable_fields list', () => {
    const result = evaluateEditField(
      buildSigner({ editable_fields: ['email'] }),
      'phone',
    );
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.FIELD_NOT_EDITABLE);
  });

  it('denies editing when the field name is missing', () => {
    const result = evaluateEditField(buildSigner(), '');
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.FIELD_NOT_EDITABLE);
  });

  it('denies editing when the signer record is malformed', () => {
    const result = evaluateEditField(null, 'signer_name');
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.NOT_FOUND);
  });

  it('exposes a boolean convenience via canEditField', () => {
    expect(canEditField(buildSigner(), 'email')).toBe(true);
    expect(canEditField(buildSigner({ status: 'revoked' }), 'email')).toBe(false);
  });
});

describe('signerPolicy.evaluateUnlock', () => {
  it('allows unlocking an active, currently locked signer', () => {
    const result = evaluateUnlock(buildSigner({ locked: true, lock_reason: 'concurrent_edit' }));
    expect(result.allowed).toBe(true);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.ELIGIBLE);
  });

  it('denies unlocking a signer that is not locked', () => {
    const result = evaluateUnlock(buildSigner({ locked: false }));
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.NOT_LOCKED);
  });

  it('denies unlocking an inactive signer', () => {
    const result = evaluateUnlock(buildSigner({ status: 'suspended', locked: true }));
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.INACTIVE);
  });

  it('denies unlocking a malformed signer record', () => {
    const result = evaluateUnlock(undefined);
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.NOT_FOUND);
  });

  it('exposes a boolean convenience via canUnlock', () => {
    expect(canUnlock(buildSigner({ locked: true }))).toBe(true);
    expect(canUnlock(buildSigner({ locked: false }))).toBe(false);
  });
});

describe('signerPolicy.evaluateResend', () => {
  /**
   * Builds a resend-eligible signer (active, unlocked, invitation expired).
   * @param {Record<string, unknown>} [overrides] - Field overrides.
   * @returns {Record<string, unknown>} A resend-eligible signer record.
   */
  function buildResendSigner(overrides) {
    return buildSigner({ invitation_state: 'expired', ...(overrides ?? {}) });
  }

  it('allows a resend for an active signer whose invitation has expired', () => {
    const result = evaluateResend(buildResendSigner(), { resendCount: 0 });
    expect(result.allowed).toBe(true);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.ELIGIBLE);
  });

  it('denies a resend when the invitation has not expired', () => {
    const result = evaluateResend(buildResendSigner({ invitation_state: 'accepted' }), {
      resendCount: 0,
    });
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.INVITATION_NOT_EXPIRED);
  });

  it('denies a resend for an inactive signer', () => {
    const result = evaluateResend(buildResendSigner({ status: 'revoked' }), { resendCount: 0 });
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.INACTIVE);
  });

  it('denies a resend for a locked signer', () => {
    const result = evaluateResend(buildResendSigner({ locked: true }), { resendCount: 0 });
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.LOCKED);
  });

  it('allows a resend when fewer than the maximum attempts are recorded', () => {
    const result = evaluateResend(buildResendSigner(), { resendCount: MAX_RESENDS_24H - 1 });
    expect(result.allowed).toBe(true);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.ELIGIBLE);
  });

  it('blocks the fourth resend once the maximum is reached in the rolling window', () => {
    const result = evaluateResend(buildResendSigner(), { resendCount: MAX_RESENDS_24H });
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.RESEND_LIMIT_REACHED);
  });

  it('counts only resend timestamps within the rolling 24-hour window', () => {
    const reference = demoClock.now();
    const withinWindow = demoClock.addHours(reference, -1);
    const outsideWindow = demoClock.addHours(reference, -25);

    // Two attempts inside the window plus one outside it stays under the limit.
    const result = evaluateResend(buildResendSigner(), {
      resendTimestamps: [withinWindow, withinWindow, outsideWindow],
      reference,
    });
    expect(result.allowed).toBe(true);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.ELIGIBLE);
  });

  it('blocks the fourth resend when three attempts fall within the window', () => {
    const reference = demoClock.now();
    const withinWindow = demoClock.addHours(reference, -2);

    const result = evaluateResend(buildResendSigner(), {
      resendTimestamps: [withinWindow, withinWindow, withinWindow],
      reference,
    });
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.RESEND_LIMIT_REACHED);
  });

  it('ignores malformed resend timestamps rather than blocking the count', () => {
    const reference = demoClock.now();
    const withinWindow = demoClock.addHours(reference, -1);

    const result = evaluateResend(buildResendSigner(), {
      resendTimestamps: ['not-a-date', withinWindow, null],
      reference,
    });
    expect(result.allowed).toBe(true);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.ELIGIBLE);
  });

  it('treats a negative precomputed resend count as zero', () => {
    const result = evaluateResend(buildResendSigner(), { resendCount: -5 });
    expect(result.allowed).toBe(true);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.ELIGIBLE);
  });

  it('denies a resend for a malformed signer record', () => {
    const result = evaluateResend(null, { resendCount: 0 });
    expect(result.allowed).toBe(false);
    expect(result.safeReasonCode).toBe(SIGNER_POLICY_REASON_CODES.NOT_FOUND);
  });

  it('exposes a boolean convenience via canResend', () => {
    expect(canResend(buildResendSigner(), { resendCount: 0 })).toBe(true);
    expect(canResend(buildResendSigner(), { resendCount: MAX_RESENDS_24H })).toBe(false);
  });
});