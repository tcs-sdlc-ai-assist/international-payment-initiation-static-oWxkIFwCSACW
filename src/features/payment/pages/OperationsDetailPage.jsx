/**
 * Payment operations detail page.
 *
 * OperationsDetailPage is the single-payment review surface for the payment
 * operations flow (SCRUM-820/821), reached by following "Review" from the
 * {@link OperationsPage} list. It reads one masked, entitlement-scoped payment
 * via the read-only {@link operationsFacade} for the id in the route, and
 * presents its sanitized processing checkpoints, ledger postings, and SWIFT
 * status — never restricted rule data — plus the permitted local lifecycle
 * transitions and a reset action, gated on the operate capability.
 *
 *   - Each transition disables its controls while the request is in flight so
 *     it can never be double-invoked.
 *   - A successful transition reloads this same payment in place (rather than
 *     navigating away), so an operator can apply several permitted actions in
 *     sequence and see each resulting state; a "Back to operations" action
 *     returns to the list explicitly when the operator is done.
 *   - The outcome is announced through the shared notification live regions.
 *
 * The page renders only sanitized, masked copy — never raw PII beyond the
 * masked models the facade produces — and never mutates application state
 * beyond its own local detail/action model.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAccessContext } from '@/app/useAccessContext';
import { useNotifications } from '@/app/NotificationContext';
import { operationsFacade } from '@/features/payment/services/operationsFacade';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { LoadingIndicator } from '@/shared/ui/LoadingIndicator';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Human-readable labels for permitted lifecycle actions. */
const ACTION_LABELS = Object.freeze({
  validate: 'Validate',
  process: 'Process',
  reject: 'Reject',
  flag_review: 'Flag for review',
  flag_repair: 'Flag for repair',
  request_approval: 'Request approval',
  accept: 'Accept',
  approve: 'Approve',
  resume: 'Resume processing',
  repair: 'Repair',
  send_to_swift: 'Send to SWIFT',
  acknowledge: 'Acknowledge',
  reset: 'Reset to draft',
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
 * Formats an identifier into a readable label.
 * @param {unknown} value - The raw identifier.
 * @returns {string} A human-readable label.
 */
function toLabel(value) {
  const text = toText(value);
  if (text.length === 0) {
    return '—';
  }
  return text
    .split(/[._-]/)
    .map((part) => (part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/**
 * Resolves a human-readable label for a lifecycle action.
 * @param {string} action - The lifecycle action identifier.
 * @returns {string} A display label for the action.
 */
function actionLabel(action) {
  const key = toText(action);
  return Object.prototype.hasOwnProperty.call(ACTION_LABELS, key)
    ? ACTION_LABELS[key]
    : toLabel(action);
}

/**
 * Builds a minimal session claim shape for the operations facade from the
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
 * Formats a currency-leg amount for display.
 * @param {unknown} value - The raw amount.
 * @param {string} currency - The currency code.
 * @returns {string} A display-safe amount string.
 */
function formatAmount(value, currency) {
  const amount = toText(value);
  const code = toText(currency);
  if (amount.length === 0) {
    return '—';
  }
  return code.length > 0 ? `${amount} ${code}` : amount;
}

/**
 * Resolves a badge tone for a lifecycle status value.
 * @param {string} status - The lifecycle status.
 * @returns {string} A tone from {@link STATUS_TONES}.
 */
function statusTone(status) {
  switch (status) {
    case 'acknowledged':
    case 'accepted':
      return STATUS_TONES.SUCCESS;
    case 'rejected':
      return STATUS_TONES.CRITICAL;
    case 'pending_review':
    case 'repair_required':
    case 'pending_approval':
      return STATUS_TONES.WARNING;
    case 'processing':
    case 'validated':
    case 'sent_to_swift':
      return STATUS_TONES.INFO;
    case 'draft':
    default:
      return STATUS_TONES.NEUTRAL;
  }
}

/**
 * Resolves a badge tone for a checkpoint result value.
 * @param {string} result - The checkpoint result.
 * @returns {string} A tone from {@link STATUS_TONES}.
 */
function checkpointTone(result) {
  switch (result) {
    case 'passed':
      return STATUS_TONES.SUCCESS;
    case 'review':
    case 'repair':
      return STATUS_TONES.WARNING;
    case 'failed':
      return STATUS_TONES.CRITICAL;
    case 'skipped':
    default:
      return STATUS_TONES.NEUTRAL;
  }
}

/**
 * Determines whether the acting session holds the payment operate capability.
 * @param {Record<string, unknown> | null | undefined} identity - The identity.
 * @returns {boolean} `true` when the session holds the operate capability.
 */
function hasOperateCapability(identity) {
  if (!isPlainObject(identity)) {
    return false;
  }
  return toStringArray(identity.capabilities).includes('payment:operate');
}

/**
 * Renders a single labeled detail row.
 * @param {{ label: string, children: React.ReactNode }} props - The row props.
 * @returns {React.ReactElement} The detail row element.
 */
function DetailRow({ label, children }) {
  return (
    <div className="flex flex-col gap-1 border-b border-primary-blue-100 py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="w-full text-sm font-medium text-primary-blue-700 sm:w-48">{label}</dt>
      <dd className="text-sm text-body">{children}</dd>
    </div>
  );
}

/**
 * Renders the payment operations detail page.
 *
 * The page loads the masked payment for the route's payment id, presents its
 * sanitized checkpoints, ledger postings, and SWIFT status, and lets an
 * operator apply a permitted local lifecycle transition or reset. A
 * successful action reloads the same payment in place so several actions can
 * be applied in sequence; a "Back to operations" action returns to the list.
 *
 * @returns {React.ReactElement} The operations detail page element.
 */
export function OperationsDetailPage() {
  const { paymentId } = useParams();
  const navigate = useNavigate();
  const { sessionIdentity, maskingPolicy } = useAccessContext();
  const { notify, NOTIFICATION_SEVERITIES } = useNotifications();

  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [acting, setActing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const session = useMemo(() => toSessionClaim(sessionIdentity), [sessionIdentity]);
  const canOperate = useMemo(() => hasOperateCapability(sessionIdentity), [sessionIdentity]);
  const context = useMemo(() => toText(maskingPolicy) || undefined, [maskingPolicy]);

  const announce = useCallback(
    (severity, title, body) => {
      try {
        notify({ severity, title, body });
      } catch (error) {
        safeLogger.warn('OperationsDetailPage: failed to announce notification', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    },
    [notify],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotFound(false);

    const id = toText(paymentId);

    let result;
    try {
      result = operationsFacade.getPaymentDetail(session, id, { context });
    } catch (error) {
      safeLogger.warn('OperationsDetailPage: failed to load payment detail', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        safeReasonCode: operationsFacade.OPERATIONS_FACADE_REASON_CODES.UNEXPECTED,
      };
    }

    if (!active) {
      return;
    }

    if (result.ok && isPlainObject(result.payment)) {
      setAuthorized(true);
      setNotFound(false);
      setDetail(result.payment);
    } else if (
      result.safeReasonCode === operationsFacade.OPERATIONS_FACADE_REASON_CODES.UNAUTHORIZED
    ) {
      setAuthorized(false);
      setDetail(null);
    } else {
      setAuthorized(true);
      setNotFound(true);
      setDetail(null);
    }
    setLoading(false);

    return () => {
      active = false;
    };
  }, [session, context, paymentId, reloadToken]);

  const handleBack = useCallback(() => {
    navigate('/operations');
  }, [navigate]);

  const handleTransition = useCallback(
    (action) => {
      if (acting || !isPlainObject(detail)) {
        return;
      }

      const id = toText(detail.paymentId);
      if (id.length === 0) {
        return;
      }

      setActing(true);
      setStatusMessage('');
      setErrorMessage('');

      const isReset = toText(action) === 'reset';

      let result;
      try {
        result = isReset
          ? operationsFacade.resetPayment(session, id)
          : operationsFacade.transitionPayment(session, id, action);
      } catch (error) {
        safeLogger.warn('OperationsDetailPage: failed to apply transition', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
        result = {
          ok: false,
          safeReasonCode: operationsFacade.OPERATIONS_FACADE_REASON_CODES.UNEXPECTED,
        };
      }

      setActing(false);

      if (result.ok) {
        const body = isReset
          ? 'The payment has been reset to a clean baseline.'
          : `The payment has moved to ${toLabel(result.status)}.`;
        setStatusMessage(body);
        announce(
          NOTIFICATION_SEVERITIES.SUCCESS,
          isReset ? 'Payment reset' : 'Payment updated',
          body,
        );
        setReloadToken((previous) => previous + 1);
        return;
      }

      if (
        result.safeReasonCode ===
        operationsFacade.OPERATIONS_FACADE_REASON_CODES.INVALID_TRANSITION
      ) {
        const body =
          'This action is not permitted from the payment’s current status. Refresh and try a permitted action.';
        setErrorMessage(body);
        announce(NOTIFICATION_SEVERITIES.WARNING, 'Action not permitted', body);
        setReloadToken((previous) => previous + 1);
        return;
      }

      if (result.safeReasonCode === operationsFacade.OPERATIONS_FACADE_REASON_CODES.NOT_FOUND) {
        const body =
          'This payment could not be located. It may have already been actioned elsewhere.';
        setErrorMessage(body);
        announce(NOTIFICATION_SEVERITIES.WARNING, 'Payment not found', body);
        return;
      }

      const body = 'The action could not be applied with your current role. Try again.';
      setErrorMessage(body);
      announce(NOTIFICATION_SEVERITIES.WARNING, 'Action unavailable', body);
    },
    [acting, detail, session, announce, NOTIFICATION_SEVERITIES],
  );

  const checkpoints = useMemo(
    () => (isPlainObject(detail) && Array.isArray(detail.checkpoints) ? detail.checkpoints : []),
    [detail],
  );

  const postings = useMemo(
    () => (isPlainObject(detail) && Array.isArray(detail.postings) ? detail.postings : []),
    [detail],
  );

  const swiftStatus = useMemo(
    () => (isPlainObject(detail) && isPlainObject(detail.swiftStatus) ? detail.swiftStatus : null),
    [detail],
  );

  const allowedActions = useMemo(
    () => (isPlainObject(detail) ? toStringArray(detail.allowedActions) : []),
    [detail],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-primary-blue-700">Review payment</h1>
        <p className="text-sm text-body">
          Review this payment's masked details, sanitized processing checkpoints, ledger postings,
          and SWIFT status.
        </p>
      </div>

      <div>
        <Button type="button" variant="secondary" size="sm" onClick={handleBack}>
          Back to operations
        </Button>
      </div>

      {loading ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-primary-blue-100 bg-white px-4 py-6 text-center text-sm text-body"
        >
          Loading payment…
        </div>
      ) : !authorized ? (
        <Alert severity={ALERT_SEVERITIES.CRITICAL} title="Access denied">
          Your current role does not hold the capability required to operate payments. Switch to a
          role that grants it and try again.
        </Alert>
      ) : notFound || !isPlainObject(detail) ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="Payment not found">
          The requested payment could not be located for your entitlements. It may have been
          actioned elsewhere.
        </Alert>
      ) : (
        <>
          {statusMessage.length > 0 ? (
            <div role="status" aria-live="polite">
              <Alert severity={ALERT_SEVERITIES.SUCCESS} title="Action completed">
                {statusMessage}
              </Alert>
            </div>
          ) : null}

          <section
            aria-labelledby="operations-detail-heading"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <h2 id="operations-detail-heading" className="text-lg font-medium text-body">
                  {toText(detail.paymentReference) || toText(detail.paymentId) || '—'}
                </h2>
                <span className="text-xs text-body">{toText(detail.paymentId)}</span>
              </div>
              <StatusBadge tone={statusTone(toText(detail.status))}>
                {toLabel(detail.status)}
              </StatusBadge>
            </div>

            <dl className="flex flex-col">
              <DetailRow label="Beneficiary">{toText(detail.beneficiaryName) || '—'}</DetailRow>
              <DetailRow label="Debit account">{toText(detail.accountId) || '—'}</DetailRow>
              <DetailRow label="Currency pair">{toText(detail.pairId) || '—'}</DetailRow>
              <DetailRow label="Instructed amount">
                {formatAmount(detail.instructedAmount, toText(detail.sourceCurrency))}
              </DetailRow>
              <DetailRow label="Settlement amount">
                {formatAmount(detail.settlementAmount, toText(detail.beneficiaryCurrency))}
              </DetailRow>
              <DetailRow label="Fee">
                {formatAmount(
                  detail.feeAmount,
                  toText(detail.feeCurrency) || toText(detail.sourceCurrency),
                )}
              </DetailRow>
              <DetailRow label="Charge treatment">
                {toText(detail.chargeTreatment).length > 0 ? (
                  <StatusBadge tone={STATUS_TONES.NEUTRAL}>
                    {toText(detail.chargeTreatment)}
                  </StatusBadge>
                ) : (
                  '—'
                )}
              </DetailRow>
              <DetailRow label="Remittance information">
                {toText(detail.remittanceInfo) || '—'}
              </DetailRow>
              <DetailRow label="Scenario">{toText(detail.scenarioRef) || '—'}</DetailRow>
              <DetailRow label="Reason code">
                {toText(detail.safeReasonCode).length > 0 ? (
                  <StatusBadge tone={STATUS_TONES.INFO}>
                    {toLabel(detail.safeReasonCode)}
                  </StatusBadge>
                ) : (
                  '—'
                )}
              </DetailRow>
              <DetailRow label="Decision comment">
                {toText(detail.decisionComment) || '—'}
              </DetailRow>
            </dl>
          </section>

          <section
            aria-labelledby="operations-checks-heading"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
          >
            <h2 id="operations-checks-heading" className="text-lg font-medium text-body">
              Processing checkpoints
            </h2>
            {checkpoints.length === 0 ? (
              <p className="text-sm text-body">
                No processing checkpoints are recorded for this payment.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {checkpoints.map((checkpoint, index) => (
                  <li
                    key={`${toText(checkpoint.stage)}-${index}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary-blue-100 bg-primary-blue-50 px-3 py-2"
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-body">
                        {toLabel(checkpoint.stage)}
                      </span>
                      {toText(checkpoint.safeReasonCode).length > 0 ? (
                        <span className="text-xs text-body">
                          {toLabel(checkpoint.safeReasonCode)}
                        </span>
                      ) : null}
                    </div>
                    <StatusBadge tone={checkpointTone(toText(checkpoint.result))}>
                      {toLabel(checkpoint.result)}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            aria-labelledby="operations-postings-heading"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
          >
            <h2 id="operations-postings-heading" className="text-lg font-medium text-body">
              Ledger postings
            </h2>
            {postings.length === 0 ? (
              <p className="text-sm text-body">
                No simulated ledger postings are recorded for this payment.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {postings.map((posting, index) => (
                  <li
                    key={`${toText(posting.postingId)}-${index}`}
                    className="flex flex-col gap-1 rounded-md border border-primary-blue-100 bg-primary-blue-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-body">
                        {toText(posting.ledgerAccount) || '—'}
                      </span>
                      <span className="text-xs text-body">{toText(posting.reference) || '—'}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {toText(posting.direction).length > 0 ? (
                        <StatusBadge tone={STATUS_TONES.NEUTRAL}>
                          {toLabel(posting.direction)}
                        </StatusBadge>
                      ) : null}
                      <span className="text-sm text-body">
                        {formatAmount(posting.amount, toText(posting.currency))}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            aria-labelledby="operations-swift-heading"
            className="flex flex-col gap-3 rounded-md border border-primary-blue-100 bg-white p-6"
          >
            <h2 id="operations-swift-heading" className="text-lg font-medium text-body">
              SWIFT status
            </h2>
            {swiftStatus === null ? (
              <p className="text-sm text-body">
                No simulated SWIFT status is recorded for this payment.
              </p>
            ) : (
              <dl className="flex flex-col">
                <DetailRow label="Status">
                  {toText(swiftStatus.status).length > 0 ? (
                    <StatusBadge tone={STATUS_TONES.INFO}>{toLabel(swiftStatus.status)}</StatusBadge>
                  ) : (
                    '—'
                  )}
                </DetailRow>
                <DetailRow label="Reason code">
                  {toText(swiftStatus.safeReasonCode).length > 0 ? (
                    <StatusBadge tone={STATUS_TONES.INFO}>
                      {toLabel(swiftStatus.safeReasonCode)}
                    </StatusBadge>
                  ) : (
                    '—'
                  )}
                </DetailRow>
              </dl>
            )}
          </section>

          <section
            aria-labelledby="operations-actions-heading"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-6"
          >
            <div className="flex flex-col gap-1">
              <h2 id="operations-actions-heading" className="text-lg font-medium text-body">
                Operate payment
              </h2>
              <p className="text-sm text-body">
                Permitted transitions appear only when your role holds the operate capability and the
                payment is eligible for the action. Otherwise this view is read-only.
              </p>
            </div>

            {errorMessage.length > 0 ? (
              <Alert severity={ALERT_SEVERITIES.WARNING} title="Action not completed">
                {errorMessage}
              </Alert>
            ) : null}

            {!canOperate ? (
              <p className="text-sm text-body">
                Your current role does not hold the capability required to operate this payment.
              </p>
            ) : allowedActions.length === 0 ? (
              <p className="text-sm text-body">
                No permitted transitions are available for this payment in its current status.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                {allowedActions.map((action) => (
                  <Button
                    key={action}
                    type="button"
                    variant={action === 'reset' ? 'danger' : 'secondary'}
                    size="sm"
                    disabled={acting}
                    onClick={() => handleTransition(action)}
                  >
                    {actionLabel(action)}
                  </Button>
                ))}
                {acting ? <LoadingIndicator size="sm" label="Applying action…" showLabel /> : null}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

export default OperationsDetailPage;
