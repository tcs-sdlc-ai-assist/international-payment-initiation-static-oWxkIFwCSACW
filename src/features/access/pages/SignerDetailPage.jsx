/**
 * Signer detail page.
 *
 * SignerDetailPage is the authorized-signer detail surface (SCRUM-824). It reads
 * a single masked signer display model from the {@link signerService} (which
 * enforces the deny-by-default {@link authorizationPolicy}) for the signer id in
 * the route, and presents its masked contact fields, status, invitation state,
 * signing authority, account scopes, and edit-revision. It also surfaces
 * capability-gated entry points to the signer management operations (edit,
 * unlock, resend invitation) and a link back to the audit history, without ever
 * performing the mutations itself.
 *
 * The page renders only sanitized, masked copy — never raw PII beyond the masked
 * display model the service produces — and never mutates application state
 * beyond its own local load/error model. Management actions are shown only when
 * the acting session holds the manage capability and the record is eligible for
 * that action; otherwise the entry points are omitted so the UI degrades safely.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAccessContext } from '@/app/useAccessContext';
import { signerService } from '@/features/access/services/signerService';
import { signerPolicy } from '@/features/access/services/signerPolicy';
import { CAPABILITIES } from '@/shared/config/constants';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { safeLogger } from '@/shared/logging/safeLogger';

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
 * Resolves a badge tone for a signer status value.
 * @param {string} status - The signer status.
 * @returns {string} A tone from {@link STATUS_TONES}.
 */
function statusTone(status) {
  switch (status) {
    case 'active':
      return STATUS_TONES.SUCCESS;
    case 'suspended':
      return STATUS_TONES.WARNING;
    case 'revoked':
      return STATUS_TONES.CRITICAL;
    case 'pending':
      return STATUS_TONES.INFO;
    default:
      return STATUS_TONES.NEUTRAL;
  }
}

/**
 * Resolves a badge tone for an invitation state value.
 * @param {string} invitationState - The invitation state.
 * @returns {string} A tone from {@link STATUS_TONES}.
 */
function invitationTone(invitationState) {
  switch (invitationState) {
    case 'accepted':
      return STATUS_TONES.SUCCESS;
    case 'invited':
      return STATUS_TONES.INFO;
    case 'expired':
      return STATUS_TONES.WARNING;
    default:
      return STATUS_TONES.NEUTRAL;
  }
}

/**
 * Formats a status/invitation/authority identifier into a readable label.
 * @param {unknown} value - The raw identifier.
 * @returns {string} A human-readable label.
 */
function toLabel(value) {
  const text = toText(value);
  if (text.length === 0) {
    return '—';
  }
  return text
    .split('_')
    .map((part) => (part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/**
 * Renders a single labeled detail row.
 * @param {{ label: string, children: React.ReactNode }} props - The row props.
 * @returns {React.ReactElement} The detail row element.
 */
function DetailRow({ label, children }) {
  return (
    <div className="flex flex-col gap-1 border-b border-primary-blue-100 py-3 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="w-full text-sm font-medium text-primary-blue-700 sm:w-48">{label}</dt>
      <dd className="text-sm text-body">{children}</dd>
    </div>
  );
}

DetailRow.propTypes = {};

/**
 * Renders the authorized-signer detail page.
 *
 * The page loads a masked signer display model scoped to the acting session's
 * entitlements for the route's signer id. It renders an unauthorized state when
 * the session lacks the read capability, a not-found state when the signer is
 * not visible, and otherwise presents the masked fields alongside
 * capability-gated management entry points and a link to audit history.
 *
 * @returns {React.ReactElement} The signer detail page element.
 */
export function SignerDetailPage() {
  const { signerId } = useParams();
  const navigate = useNavigate();
  const { sessionIdentity, maskingPolicy } = useAccessContext();

  const [signer, setSigner] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const accountScopes = useMemo(
    () => resolveAccountScopes(sessionIdentity),
    [sessionIdentity],
  );

  const canManage = useMemo(() => hasManageCapability(sessionIdentity), [sessionIdentity]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotFound(false);

    const claim = toSessionClaim(sessionIdentity);
    const context = toText(maskingPolicy) || undefined;
    const id = toText(signerId);

    let result;
    try {
      result = signerService.getById(claim, id, { accountScopes, context });
    } catch (error) {
      safeLogger.warn('SignerDetailPage: failed to load signer', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = { ok: false, safeReasonCode: 'signer.service.unexpected' };
    }

    if (!active) {
      return;
    }

    if (result.ok) {
      setAuthorized(true);
      setNotFound(false);
      setSigner(isPlainObject(result.signer) ? result.signer : null);
    } else if (
      result.safeReasonCode === signerService.SIGNER_SERVICE_REASON_CODES.UNAUTHORIZED
    ) {
      setAuthorized(false);
      setSigner(null);
    } else {
      setAuthorized(true);
      setNotFound(true);
      setSigner(null);
    }
    setLoading(false);

    return () => {
      active = false;
    };
  }, [sessionIdentity, maskingPolicy, accountScopes, signerId]);

  const handleBack = useCallback(() => {
    navigate('/signers');
  }, [navigate]);

  const scopes = useMemo(
    () => (isPlainObject(signer) ? toStringArray(signer.account_scopes) : []),
    [signer],
  );

  const canEdit = useMemo(() => {
    if (!canManage || !isPlainObject(signer)) {
      return false;
    }
    return toStringArray(signer.editable_fields).some((field) =>
      signerPolicy.canEditField(signer, field),
    );
  }, [canManage, signer]);

  const canUnlock = useMemo(
    () => (canManage && isPlainObject(signer) ? signerPolicy.canUnlock(signer) : false),
    [canManage, signer],
  );

  const canResend = useMemo(
    () => (canManage && isPlainObject(signer) ? signerPolicy.canResend(signer) : false),
    [canManage, signer],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-primary-blue-700">Signer detail</h1>
        <p className="text-sm text-body">
          Review this signer&apos;s entitlement details. Contact and identifier fields are masked to
          protect information, and this view is read-only.
        </p>
      </div>

      <div>
        <Button type="button" variant="secondary" size="sm" onClick={handleBack}>
          Back to signers
        </Button>
      </div>

      {loading ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-primary-blue-100 bg-white px-4 py-6 text-center text-sm text-body"
        >
          Loading signer…
        </div>
      ) : !authorized ? (
        <Alert severity={ALERT_SEVERITIES.CRITICAL} title="Access denied">
          Your current role does not hold the capability required to view signers. Switch to a role
          that grants it and try again.
        </Alert>
      ) : notFound || !isPlainObject(signer) ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="Signer not found">
          The requested signer record could not be located for your entitlements. It may have been
          removed or is outside your account scope.
        </Alert>
      ) : (
        <>
          <section
            aria-labelledby="signer-summary-heading"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <h2 id="signer-summary-heading" className="text-lg font-medium text-body">
                  {toText(signer.signer_name) || '—'}
                </h2>
                <span className="text-xs text-body">{toText(signer.signer_id)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={statusTone(toText(signer.status))}>
                  {toLabel(signer.status)}
                </StatusBadge>
                <StatusBadge tone={invitationTone(toText(signer.invitation_state))}>
                  {toLabel(signer.invitation_state)}
                </StatusBadge>
                {signer.locked === true ? (
                  <StatusBadge tone={STATUS_TONES.WARNING}>Locked</StatusBadge>
                ) : null}
              </div>
            </div>

            <dl className="flex flex-col">
              <DetailRow label="Email">{toText(signer.email) || '—'}</DetailRow>
              <DetailRow label="Phone">{toText(signer.phone) || '—'}</DetailRow>
              <DetailRow label="Organization">
                {toText(signer.organization_id) || '—'}
              </DetailRow>
              <DetailRow label="Signing authority">{toLabel(signer.authority)}</DetailRow>
              <DetailRow label="Amount limit">
                {typeof signer.amount_limit === 'number' ? String(signer.amount_limit) : '—'}
              </DetailRow>
              <DetailRow label="Accounts">
                {scopes.length > 0 ? scopes.join(', ') : '—'}
              </DetailRow>
              <DetailRow label="Status">{toLabel(signer.status)}</DetailRow>
              <DetailRow label="Invitation state">{toLabel(signer.invitation_state)}</DetailRow>
              <DetailRow label="Lock reason">
                {toText(signer.lock_reason) || '—'}
              </DetailRow>
              <DetailRow label="Edit revision">
                {typeof signer.edit_revision === 'number' ? String(signer.edit_revision) : '0'}
              </DetailRow>
            </dl>
          </section>

          <section
            aria-labelledby="signer-actions-heading"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-6"
          >
            <div className="flex flex-col gap-1">
              <h2 id="signer-actions-heading" className="text-lg font-medium text-body">
                Manage signer
              </h2>
              <p className="text-sm text-body">
                Management actions appear only when your role holds the manage capability and the
                signer is eligible for the action.
              </p>
            </div>

            {canManage && (canEdit || canUnlock || canResend) ? (
              <div className="flex flex-wrap items-center gap-2">
                {canEdit ? (
                  <Link
                    to={`/signers/${toText(signer.signer_id)}/edit`}
                    className="inline-flex items-center justify-center gap-2 rounded-md border border-primary-blue-500 bg-white px-3 py-1.5 text-sm font-medium text-primary-blue-700 transition-colors hover:bg-primary-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500 focus-visible:ring-offset-2"
                  >
                    Edit entitlements
                  </Link>
                ) : null}
                {canUnlock ? (
                  <Link
                    to={`/signers/${toText(signer.signer_id)}/unlock`}
                    className="inline-flex items-center justify-center gap-2 rounded-md border border-primary-blue-500 bg-white px-3 py-1.5 text-sm font-medium text-primary-blue-700 transition-colors hover:bg-primary-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500 focus-visible:ring-offset-2"
                  >
                    Unlock signer
                  </Link>
                ) : null}
                {canResend ? (
                  <Link
                    to={`/signers/${toText(signer.signer_id)}/resend`}
                    className="inline-flex items-center justify-center gap-2 rounded-md border border-primary-blue-500 bg-white px-3 py-1.5 text-sm font-medium text-primary-blue-700 transition-colors hover:bg-primary-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500 focus-visible:ring-offset-2"
                  >
                    Resend invitation
                  </Link>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-body">
                No management actions are available for this signer with your current role.
              </p>
            )}
          </section>

          <section
            aria-labelledby="signer-audit-heading"
            className="flex flex-col gap-3 rounded-md border border-primary-blue-100 bg-white p-6"
          >
            <h2 id="signer-audit-heading" className="text-lg font-medium text-body">
              Audit history
            </h2>
            <p className="text-sm text-body">
              Review the recorded, sanitized activity for this signer in the audit trail.
            </p>
            <Link
              to={`/audit?subjectId=${encodeURIComponent(toText(signer.signer_id))}`}
              className="inline-flex w-fit items-center justify-center rounded-md bg-primary-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500 focus-visible:ring-offset-2"
            >
              View audit history
            </Link>
          </section>
        </>
      )}
    </div>
  );
}

export default SignerDetailPage;