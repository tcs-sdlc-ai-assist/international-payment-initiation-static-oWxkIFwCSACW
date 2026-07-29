/**
 * Payment approval detail page.
 *
 * ApprovalDetailPage is the single-payment review surface for the payment
 * approval flow (SCRUM-819), reached by following "Review" from the
 * {@link ApprovalQueuePage} queue. It reads one masked, entitlement-scoped
 * payment via the {@link approvalFacade} for the id in the route, and lets an
 * approver record an approve/reject decision — optionally with a comment —
 * before returning to the queue.
 *
 *   - Simulated segregation-of-duties: an approver may not approve a payment
 *     they submitted, surfaced with a clear, demo-safe message.
 *   - The decision controls disable while the request is in flight so a
 *     decision can never be double-invoked.
 *   - A successful decision announces the outcome and navigates back to the
 *     approval queue; a failed decision surfaces a clear, demo-safe message
 *     and leaves the payment on screen so the approver can retry.
 *
 * The page renders only sanitized, masked copy — never raw PII beyond the
 * masked models the facade produces — and never mutates application state
 * beyond its own local decision model.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAccessContext } from '@/app/useAccessContext';
import { useNotifications } from '@/app/NotificationContext';
import { approvalFacade } from '@/features/payment/services/approvalFacade';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { FormField } from '@/shared/ui/FormField';
import { LoadingIndicator } from '@/shared/ui/LoadingIndicator';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { cn } from '@/shared/ui/cn';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Maximum retained length of a captured decision comment. */
const MAX_COMMENT_LENGTH = 280;

/** Shared control class list for textarea inputs. */
const CONTROL_CLASSES = cn(
  'rounded-md border border-primary-blue-200 bg-white px-3 py-2 text-sm text-body',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500 focus-visible:ring-offset-2',
  'disabled:cursor-not-allowed disabled:opacity-60',
);

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
 * Builds a minimal session claim shape for the approval facade from the
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
 * Renders the payment approval detail page.
 *
 * The page loads the masked payment for the route's payment id, presents its
 * summary, and lets the approver record an approve/reject decision. A
 * successful decision returns to the approval queue; simulated
 * segregation-of-duties prevents approving a payment the approver submitted.
 *
 * @returns {React.ReactElement} The approval detail page element.
 */
export function ApprovalDetailPage() {
  const { paymentId } = useParams();
  const navigate = useNavigate();
  const { sessionIdentity, maskingPolicy } = useAccessContext();
  const { notify, NOTIFICATION_SEVERITIES } = useNotifications();

  const [payment, setPayment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [comment, setComment] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const session = useMemo(() => toSessionClaim(sessionIdentity), [sessionIdentity]);

  const actingSubjectId = useMemo(
    () => (isPlainObject(sessionIdentity) ? toText(sessionIdentity.subjectId) : ''),
    [sessionIdentity],
  );

  const announce = useCallback(
    (severity, title, body) => {
      try {
        notify({ severity, title, body });
      } catch (error) {
        safeLogger.warn('ApprovalDetailPage: failed to announce notification', {
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

    const context = toText(maskingPolicy) || undefined;
    const id = toText(paymentId);

    let result;
    try {
      result = approvalFacade.getPaymentDetail(session, id, { context });
    } catch (error) {
      safeLogger.warn('ApprovalDetailPage: failed to load payment', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        safeReasonCode: approvalFacade.APPROVAL_FACADE_REASON_CODES.UNEXPECTED,
      };
    }

    if (!active) {
      return;
    }

    if (result.ok) {
      setAuthorized(true);
      setNotFound(false);
      setPayment(isPlainObject(result.payment) ? result.payment : null);
    } else if (
      result.safeReasonCode === approvalFacade.APPROVAL_FACADE_REASON_CODES.UNAUTHORIZED
    ) {
      setAuthorized(false);
      setPayment(null);
    } else {
      setAuthorized(true);
      setNotFound(true);
      setPayment(null);
    }
    setLoading(false);

    return () => {
      active = false;
    };
  }, [session, maskingPolicy, paymentId]);

  const isOwnSubmission = useMemo(() => {
    if (!isPlainObject(payment) || actingSubjectId.length === 0) {
      return false;
    }
    return toText(payment.submittedBy) === actingSubjectId;
  }, [payment, actingSubjectId]);

  const handleCommentChange = useCallback((event) => {
    const value = event.target.value;
    setComment(value.length > MAX_COMMENT_LENGTH ? value.slice(0, MAX_COMMENT_LENGTH) : value);
  }, []);

  const handleBack = useCallback(() => {
    navigate('/approvals');
  }, [navigate]);

  const handleDecision = useCallback(
    (decision) => {
      if (deciding || !isPlainObject(payment)) {
        return;
      }

      const id = toText(payment.paymentId);
      if (id.length === 0) {
        return;
      }

      setDeciding(true);
      setErrorMessage('');

      const commentText = toText(comment);
      const options = commentText.length > 0 ? { comment: commentText } : undefined;

      let result;
      try {
        result =
          decision === 'approve'
            ? approvalFacade.approvePayment(session, id, options)
            : approvalFacade.rejectPayment(session, id, options);
      } catch (error) {
        safeLogger.warn('ApprovalDetailPage: failed to record decision', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
        result = {
          ok: false,
          safeReasonCode: approvalFacade.APPROVAL_FACADE_REASON_CODES.UNEXPECTED,
        };
      }

      setDeciding(false);

      if (result.ok) {
        const body =
          decision === 'approve'
            ? 'The payment has been approved and moved out of the approval queue.'
            : 'The payment has been rejected and moved out of the approval queue.';
        announce(
          NOTIFICATION_SEVERITIES.SUCCESS,
          decision === 'approve' ? 'Payment approved' : 'Payment rejected',
          body,
        );
        navigate('/approvals');
        return;
      }

      if (
        result.safeReasonCode ===
        approvalFacade.APPROVAL_FACADE_REASON_CODES.SEGREGATION_VIOLATION
      ) {
        const body =
          'You cannot approve a payment you submitted. Segregation-of-duties requires a different approver.';
        setErrorMessage(body);
        announce(NOTIFICATION_SEVERITIES.WARNING, 'Approval not permitted', body);
        return;
      }

      if (result.safeReasonCode === approvalFacade.APPROVAL_FACADE_REASON_CODES.NOT_PENDING) {
        const body =
          'This payment is no longer awaiting approval. It may have already been actioned.';
        setErrorMessage(body);
        announce(NOTIFICATION_SEVERITIES.WARNING, 'No longer pending', body);
        return;
      }

      if (result.safeReasonCode === approvalFacade.APPROVAL_FACADE_REASON_CODES.NOT_FOUND) {
        const body =
          'This payment could not be located. It may have already been actioned by another approver.';
        setErrorMessage(body);
        announce(NOTIFICATION_SEVERITIES.WARNING, 'Payment not found', body);
        return;
      }

      const body = 'The decision could not be recorded with your current role. Try again.';
      setErrorMessage(body);
      announce(NOTIFICATION_SEVERITIES.WARNING, 'Decision unavailable', body);
    },
    [deciding, payment, comment, session, announce, NOTIFICATION_SEVERITIES, navigate],
  );

  const handleApprove = useCallback(() => handleDecision('approve'), [handleDecision]);
  const handleReject = useCallback(() => handleDecision('reject'), [handleDecision]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-primary-blue-700">Review payment</h1>
        <p className="text-sm text-body">
          Review the masked payment details and record an approval or rejection.
        </p>
      </div>

      <div>
        <Button type="button" variant="secondary" size="sm" onClick={handleBack}>
          Back to approval queue
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
          Your current role does not hold the capability required to approve payments. Switch to a
          role that grants it and try again.
        </Alert>
      ) : notFound || !isPlainObject(payment) ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="Payment not found">
          The requested payment could not be located for your entitlements. It may have already been
          actioned by another approver.
        </Alert>
      ) : (
        <section
          aria-labelledby="approval-detail-heading"
          className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 id="approval-detail-heading" className="text-lg font-medium text-body">
                {toText(payment.paymentReference) || toText(payment.paymentId) || '—'}
              </h2>
              <span className="text-xs text-body">{toText(payment.paymentId)}</span>
            </div>
            <StatusBadge tone={STATUS_TONES.WARNING}>{toLabel(payment.status)}</StatusBadge>
          </div>

          <dl className="flex flex-col">
            <DetailRow label="Initiator">{toText(payment.submittedBy) || '—'}</DetailRow>
            <DetailRow label="Beneficiary">{toText(payment.beneficiaryName) || '—'}</DetailRow>
            <DetailRow label="Debit account">{toText(payment.accountId) || '—'}</DetailRow>
            <DetailRow label="Currency pair">{toText(payment.pairId) || '—'}</DetailRow>
            <DetailRow label="Instructed amount">
              {formatAmount(payment.instructedAmount, toText(payment.sourceCurrency))}
            </DetailRow>
            <DetailRow label="Settlement amount">
              {formatAmount(payment.settlementAmount, toText(payment.beneficiaryCurrency))}
            </DetailRow>
            <DetailRow label="Fee">
              {formatAmount(
                payment.feeAmount,
                toText(payment.feeCurrency) || toText(payment.sourceCurrency),
              )}
            </DetailRow>
            <DetailRow label="Charge treatment">
              {toText(payment.chargeTreatment).length > 0 ? (
                <StatusBadge tone={STATUS_TONES.NEUTRAL}>
                  {toText(payment.chargeTreatment)}
                </StatusBadge>
              ) : (
                '—'
              )}
            </DetailRow>
            <DetailRow label="Remittance information">
              {toText(payment.remittanceInfo) || '—'}
            </DetailRow>
          </dl>

          {isOwnSubmission ? (
            <Alert severity={ALERT_SEVERITIES.WARNING} title="Segregation of duties">
              You submitted this payment, so you cannot approve it. A different approver must action
              it. You may still reject it if appropriate.
            </Alert>
          ) : null}

          {errorMessage.length > 0 ? (
            <Alert severity={ALERT_SEVERITIES.WARNING} title="Decision not completed">
              {errorMessage}
            </Alert>
          ) : null}

          <FormField label="Decision comment" helpText="An optional note recorded with your decision.">
            {(attrs) => (
              <textarea
                rows={3}
                autoComplete="off"
                className={CONTROL_CLASSES}
                value={comment}
                disabled={deciding}
                onChange={handleCommentChange}
                {...attrs}
              />
            )}
          </FormField>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="primary"
              size="md"
              disabled={deciding || isOwnSubmission}
              onClick={handleApprove}
            >
              Approve payment
            </Button>
            <Button
              type="button"
              variant="danger"
              size="md"
              disabled={deciding}
              onClick={handleReject}
            >
              Reject payment
            </Button>
            {deciding ? <LoadingIndicator size="sm" label="Recording decision…" showLabel /> : null}
          </div>
        </section>
      )}
    </div>
  );
}

export default ApprovalDetailPage;
