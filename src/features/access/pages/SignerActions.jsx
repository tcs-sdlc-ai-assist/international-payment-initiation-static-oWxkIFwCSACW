/**
 * Signer unlock and invitation-resend actions.
 *
 * SignerActions provides the two capability-gated signer management operations
 * exposed in the access cluster (SCRUM-826): unlocking a locked signer and
 * resending a lapsed invitation. It is intentionally policy-driven, not merely
 * button-gated: eligibility is derived from the deny-by-default
 * {@link signerPolicy} (active, unlocked/locked-as-appropriate, invitation
 * expired, and the rolling 24-hour resend window) so a control is never enabled
 * for an ineligible record. Every mutation is routed through the
 * {@link signerService}, which re-checks entitlement and eligibility server-side
 * of the demo boundary.
 *
 * The component is deliberately conservative and demo-only:
 *
 *   - Each action disables while its request is pending so it can never be
 *     double-invoked; the resolved operation reference is retained so a repeated
 *     click is rejected as a duplicate rather than re-applied.
 *   - The resend control surfaces that the 3-per-24-hour limit is browser-local
 *     and NOT server-enforced, matching the fixture messaging.
 *   - Outcomes are announced through the shared notification live regions and a
 *     local status message; the component renders only sanitized copy and
 *     carries no PII beyond the masked display model it receives.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useAccessContext } from '@/app/useAccessContext';
import { useNotifications } from '@/app/NotificationContext';
import { signerService } from '@/features/access/services/signerService';
import { signerPolicy } from '@/features/access/services/signerPolicy';
import { CAPABILITIES, MAX_RESENDS_24H } from '@/shared/config/constants';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { LoadingIndicator } from '@/shared/ui/LoadingIndicator';
import { safeLogger } from '@/shared/logging/safeLogger';

/**
 * Message stating that the resend limit is enforced client-side only.
 * @type {string}
 */
const RESEND_LIMIT_NOTICE =
  `Up to ${MAX_RESENDS_24H} invitation resends are permitted within a rolling 24-hour window. ` +
  'This limit is enforced in your browser for the demo only and is not a server guarantee.';

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
 * Resolves the acting session's account scopes from the sanitized identity.
 * @param {Record<string, unknown> | null | undefined} identity - The identity.
 * @returns {string[]} The session's account scopes (may be empty).
 */
function resolveAccountScopes(identity) {
  if (!isPlainObject(identity)) {
    return [];
  }
  return toStringArray(identity.accountScopes);
}

/**
 * Builds a minimal session claim shape for the signer service from the
 * sanitized session identity.
 * @param {Record<string, unknown> | null | undefined} identity - The identity.
 * @returns {{ subjectId: string, roles: string[], capabilities: string[] }} A claim-like value.
 */
function toSessionClaim(identity) {
  if (!isPlainObject(identity)) {
    return { subjectId: '', roles: [], capabilities: [] };
  }
  return {
    subjectId: toText(identity.subjectId),
    roles: toStringArray(identity.roles),
    capabilities: toStringArray(identity.capabilities),
  };
}

/**
 * Determines whether the acting session holds the signer manage capability.
 * @param {Record<string, unknown> | null | undefined} identity - The identity.
 * @returns {boolean} `true` when the session holds the manage capability.
 */
function hasManageCapability(identity) {
  if (!isPlainObject(identity)) {
    return false;
  }
  return toStringArray(identity.capabilities).includes(CAPABILITIES.SIGNER_MANAGE);
}

/**
 * Renders the signer unlock and invitation-resend action controls.
 *
 * The controls are policy-gated via {@link signerPolicy}: unlock is offered only
 * for locked, active signers and resend only for active signers whose invitation
 * has expired and are within the rolling 24-hour resend window. Each action
 * disables while pending and retains its resolved operation reference so a
 * repeated click is rejected as a duplicate. When the acting session lacks the
 * manage capability no actionable controls are rendered.
 *
 * @param {{
 *   signer: Record<string, unknown> | null | undefined,
 *   onCompleted?: (result: { action: string, operationId?: string, safeReasonCode: string }) => void,
 * }} props - The signer actions props.
 * @returns {React.ReactElement} The signer actions element.
 */
export function SignerActions({ signer, onCompleted }) {
  const { sessionIdentity } = useAccessContext();
  const { notify, NOTIFICATION_SEVERITIES } = useNotifications();

  const [unlockPending, setUnlockPending] = useState(false);
  const [resendPending, setResendPending] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  /** @type {React.MutableRefObject<string | null>} */
  const unlockOperationRef = useRef(null);
  /** @type {React.MutableRefObject<string | null>} */
  const resendOperationRef = useRef(null);

  const accountScopes = useMemo(
    () => resolveAccountScopes(sessionIdentity),
    [sessionIdentity],
  );

  const canManage = useMemo(() => hasManageCapability(sessionIdentity), [sessionIdentity]);

  const canUnlock = useMemo(
    () => (canManage && isPlainObject(signer) ? signerPolicy.canUnlock(signer) : false),
    [canManage, signer],
  );

  const canResend = useMemo(
    () => (canManage && isPlainObject(signer) ? signerPolicy.canResend(signer) : false),
    [canManage, signer],
  );

  const signerId = useMemo(
    () => (isPlainObject(signer) ? toText(signer.signer_id) : ''),
    [signer],
  );

  const announce = useCallback(
    (severity, title, body) => {
      try {
        notify({ severity, title, body });
      } catch (error) {
        safeLogger.warn('SignerActions: failed to announce notification', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    },
    [notify],
  );

  const handleUnlock = useCallback(async () => {
    if (unlockPending || !canUnlock || signerId.length === 0) {
      return;
    }

    // Duplicate operation-reference rejection: a repeated click after a
    // completed unlock is refused rather than re-applied.
    if (unlockOperationRef.current !== null) {
      setErrorMessage('');
      setStatusMessage('This signer has already been unlocked in this session.');
      return;
    }

    setUnlockPending(true);
    setErrorMessage('');
    setStatusMessage('');

    let result;
    try {
      result = signerService.unlock(toSessionClaim(sessionIdentity), signerId, {
        accountScopes,
      });
    } catch (error) {
      safeLogger.warn('SignerActions: failed to unlock signer', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        safeReasonCode: signerService.SIGNER_SERVICE_REASON_CODES.UNEXPECTED,
      };
    }

    setUnlockPending(false);

    if (result.ok) {
      unlockOperationRef.current = toText(result.operationId) || 'unlocked';
      setStatusMessage('The signer has been unlocked.');
      announce(NOTIFICATION_SEVERITIES.SUCCESS, 'Signer unlocked', 'The signer has been unlocked.');
      if (typeof onCompleted === 'function') {
        onCompleted({
          action: 'unlock',
          operationId: toText(result.operationId) || undefined,
          safeReasonCode: result.safeReasonCode,
        });
      }
    } else {
      setErrorMessage('The signer could not be unlocked with your current role and its status.');
      announce(
        NOTIFICATION_SEVERITIES.WARNING,
        'Unlock unavailable',
        'The signer could not be unlocked with your current role and its status.',
      );
    }
  }, [
    unlockPending,
    canUnlock,
    signerId,
    sessionIdentity,
    accountScopes,
    announce,
    NOTIFICATION_SEVERITIES,
    onCompleted,
  ]);

  const handleResend = useCallback(async () => {
    if (resendPending || !canResend || signerId.length === 0) {
      return;
    }

    // Duplicate operation-reference rejection: a repeated click after a
    // completed resend is refused rather than re-applied.
    if (resendOperationRef.current !== null) {
      setErrorMessage('');
      setStatusMessage('A fresh invitation has already been resent in this session.');
      return;
    }

    setResendPending(true);
    setErrorMessage('');
    setStatusMessage('');

    let result;
    try {
      result = signerService.resendInvitation(toSessionClaim(sessionIdentity), signerId, {
        accountScopes,
      });
    } catch (error) {
      safeLogger.warn('SignerActions: failed to resend invitation', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        safeReasonCode: signerService.SIGNER_SERVICE_REASON_CODES.UNEXPECTED,
      };
    }

    setResendPending(false);

    if (result.ok) {
      resendOperationRef.current = toText(result.operationId) || 'resent';
      setStatusMessage('A fresh invitation has been resent. Your remaining resends have been reduced.');
      announce(
        NOTIFICATION_SEVERITIES.SUCCESS,
        'Invitation resent',
        'A fresh invitation has been resent. Your remaining resends have been reduced.',
      );
      if (typeof onCompleted === 'function') {
        onCompleted({
          action: 'resend',
          operationId: toText(result.operationId) || undefined,
          safeReasonCode: result.safeReasonCode,
        });
      }
    } else if (
      result.safeReasonCode ===
      signerPolicy.SIGNER_POLICY_REASON_CODES.RESEND_LIMIT_REACHED
    ) {
      setErrorMessage(RESEND_LIMIT_NOTICE);
      announce(NOTIFICATION_SEVERITIES.WARNING, 'Resend limit reached', RESEND_LIMIT_NOTICE);
    } else {
      setErrorMessage('The invitation could not be resent with your current role and its status.');
      announce(
        NOTIFICATION_SEVERITIES.WARNING,
        'Resend unavailable',
        'The invitation could not be resent with your current role and its status.',
      );
    }
  }, [
    resendPending,
    canResend,
    signerId,
    sessionIdentity,
    accountScopes,
    announce,
    NOTIFICATION_SEVERITIES,
    onCompleted,
  ]);

  if (!isPlainObject(signer)) {
    return (
      <section
        aria-labelledby="signer-actions-heading"
        className="flex flex-col gap-3 rounded-md border border-primary-blue-100 bg-white p-6"
      >
        <h2 id="signer-actions-heading" className="text-lg font-medium text-body">
          Signer actions
        </h2>
        <p className="text-sm text-body">No signer is available to act on.</p>
      </section>
    );
  }

  const unlockDone = unlockOperationRef.current !== null;
  const resendDone = resendOperationRef.current !== null;
  const showUnlock = canUnlock || unlockDone;
  const showResend = canResend || resendDone;

  return (
    <section
      aria-labelledby="signer-actions-heading"
      className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id="signer-actions-heading" className="text-lg font-medium text-body">
          Signer actions
        </h2>
        <p className="text-sm text-body">
          Actions appear only when your role holds the manage capability and the signer is eligible
          for the action.
        </p>
      </div>

      {statusMessage.length > 0 ? (
        <div role="status" aria-live="polite">
          <Alert severity={ALERT_SEVERITIES.SUCCESS} title="Action completed">
            {statusMessage}
          </Alert>
        </div>
      ) : null}

      {errorMessage.length > 0 ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="Action unavailable">
          {errorMessage}
        </Alert>
      ) : null}

      {!canManage ? (
        <p className="text-sm text-body">
          Your current role does not hold the capability required to manage this signer.
        </p>
      ) : showUnlock || showResend ? (
        <div className="flex flex-col gap-4">
          {showUnlock ? (
            <div className="flex flex-col gap-2 rounded-md border border-primary-blue-100 bg-white p-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-body">Unlock signer</span>
                <span className="text-xs text-body">
                  Clears the concurrent-edit lock so the signer can be edited again.
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={unlockPending || unlockDone || !canUnlock}
                  onClick={handleUnlock}
                >
                  {unlockDone ? 'Signer unlocked' : 'Unlock signer'}
                </Button>
                {unlockPending ? (
                  <LoadingIndicator size="sm" label="Unlocking…" showLabel />
                ) : null}
              </div>
            </div>
          ) : null}

          {showResend ? (
            <div className="flex flex-col gap-2 rounded-md border border-primary-blue-100 bg-white p-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-body">Resend invitation</span>
                <span className="text-xs text-body">
                  Issues a fresh simulated invitation for a signer whose invitation has expired.
                </span>
              </div>
              <p className="text-xs text-body">{RESEND_LIMIT_NOTICE}</p>
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={resendPending || resendDone || !canResend}
                  onClick={handleResend}
                >
                  {resendDone ? 'Invitation resent' : 'Resend invitation'}
                </Button>
                {resendPending ? (
                  <LoadingIndicator size="sm" label="Resending…" showLabel />
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-body">
          No unlock or resend actions are available for this signer with your current role and its
          status.
        </p>
      )}
    </section>
  );
}

SignerActions.propTypes = {
  signer: PropTypes.object,
  onCompleted: PropTypes.func,
};

export default SignerActions;