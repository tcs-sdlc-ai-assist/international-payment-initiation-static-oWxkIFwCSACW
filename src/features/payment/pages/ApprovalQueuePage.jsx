/**
 * Payment approval queue page.
 *
 * ApprovalQueuePage is the approver experience for the payment approval flow
 * (SCRUM-819). It reads the entitlement-scoped, masked pending-approval queue
 * from the {@link approvalFacade} (which enforces the deny-by-default
 * {@link authorizationPolicy}) and lets an approver review each payment's masked
 * initiator, beneficiary, amount, quote, and validation information before
 * approving or rejecting it — optionally with a comment. It renders:
 *
 *   - A responsive {@link DataTable} listing every payment awaiting approval,
 *     with masked identifiers, amounts, and a status badge.
 *   - A selectable detail panel presenting the masked payment summary alongside
 *     approve/reject controls and an optional decision comment.
 *   - Simulated segregation-of-duties: an approver may not approve a payment
 *     they submitted, surfaced with a clear, demo-safe message drawn from the
 *     facade.
 *
 * Each decision disables its controls while the request is in flight so it can
 * never be double-invoked, and the outcome is announced through the shared
 * notification live regions and recorded as a sanitized audit event by the
 * facade. The page renders only sanitized, masked copy — never raw PII beyond
 * the masked models the facade produces — and never mutates application state
 * beyond its own local queue/decision model.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccessContext } from '@/app/useAccessContext';
import { useNotifications } from '@/app/NotificationContext';
import { approvalFacade } from '@/features/payment/services/approvalFacade';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { DataTable } from '@/shared/ui/DataTable';
import { FormField } from '@/shared/ui/FormField';
import { LoadingIndicator } from '@/shared/ui/LoadingIndicator';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { cn } from '@/shared/ui/cn';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default page size applied to the approval queue. */
const DEFAULT_PAGE_SIZE = 10;

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

DetailRow.propTypes = {};

/**
 * Renders the payment approval queue page.
 *
 * The page loads the masked, entitlement-scoped pending-approval queue, lets an
 * approver select a payment to review its masked details, and approve or reject
 * it with an optional comment. Simulated segregation-of-duties prevents an
 * approver from approving a payment they submitted. Each decision disables its
 * controls while pending and, on success, refreshes the queue and clears the
 * selection.
 *
 * @returns {React.ReactElement} The approval queue page element.
 */
export function ApprovalQueuePage() {
  const { sessionIdentity, maskingPolicy } = useAccessContext();
  const { notify, NOTIFICATION_SEVERITIES } = useNotifications();

  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const [comment, setComment] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

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
        safeLogger.warn('ApprovalQueuePage: failed to announce notification', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    },
    [notify],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);

    const context = toText(maskingPolicy) || undefined;

    let result;
    try {
      result = approvalFacade.listApprovalQueue(session, { context });
    } catch (error) {
      safeLogger.warn('ApprovalQueuePage: failed to load approval queue', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        payments: [],
        safeReasonCode: approvalFacade.APPROVAL_FACADE_REASON_CODES.UNEXPECTED,
      };
    }

    if (!active) {
      return;
    }

    if (result.ok) {
      setAuthorized(true);
      setPayments(
        Array.isArray(result.payments) ? result.payments.filter((item) => isPlainObject(item)) : [],
      );
    } else {
      setAuthorized(
        result.safeReasonCode !==
          approvalFacade.APPROVAL_FACADE_REASON_CODES.UNAUTHORIZED,
      );
      setPayments([]);
    }
    setLoading(false);

    return () => {
      active = false;
    };
  }, [session, maskingPolicy, reloadToken]);

  const total = payments.length;
  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageStart = currentPage * DEFAULT_PAGE_SIZE;
  const pageRows = useMemo(
    () => payments.slice(pageStart, pageStart + DEFAULT_PAGE_SIZE),
    [payments, pageStart],
  );

  const selectedPayment = useMemo(
    () =>
      payments.find(
        (payment) => isPlainObject(payment) && toText(payment.paymentId) === selectedId,
      ) ?? null,
    [payments, selectedId],
  );

  const isOwnSubmission = useMemo(() => {
    if (!isPlainObject(selectedPayment) || actingSubjectId.length === 0) {
      return false;
    }
    return toText(selectedPayment.submittedBy) === actingSubjectId;
  }, [selectedPayment, actingSubjectId]);

  const handlePageChange = useCallback((nextPage) => {
    setPage(nextPage);
  }, []);

  const handleSelect = useCallback((paymentId) => {
    setSelectedId(paymentId);
    setComment('');
    setStatusMessage('');
    setErrorMessage('');
  }, []);

  const handleCommentChange = useCallback((event) => {
    const value = event.target.value;
    setComment(value.length > MAX_COMMENT_LENGTH ? value.slice(0, MAX_COMMENT_LENGTH) : value);
  }, []);

  const handleDecision = useCallback(
    (decision) => {
      if (deciding || !isPlainObject(selectedPayment)) {
        return;
      }

      const paymentId = toText(selectedPayment.paymentId);
      if (paymentId.length === 0) {
        return;
      }

      setDeciding(true);
      setStatusMessage('');
      setErrorMessage('');

      const commentText = toText(comment);
      const options = commentText.length > 0 ? { comment: commentText } : undefined;

      let result;
      try {
        result =
          decision === 'approve'
            ? approvalFacade.approvePayment(session, paymentId, options)
            : approvalFacade.rejectPayment(session, paymentId, options);
      } catch (error) {
        safeLogger.warn('ApprovalQueuePage: failed to record decision', {
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
        setStatusMessage(body);
        announce(
          NOTIFICATION_SEVERITIES.SUCCESS,
          decision === 'approve' ? 'Payment approved' : 'Payment rejected',
          body,
        );
        setSelectedId('');
        setComment('');
        setReloadToken((previous) => previous + 1);
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
          'This payment is no longer awaiting approval. Refresh the queue to see its current status.';
        setErrorMessage(body);
        announce(NOTIFICATION_SEVERITIES.WARNING, 'No longer pending', body);
        setReloadToken((previous) => previous + 1);
        return;
      }

      if (result.safeReasonCode === approvalFacade.APPROVAL_FACADE_REASON_CODES.NOT_FOUND) {
        const body =
          'This payment could not be located. It may have already been actioned by another approver.';
        setErrorMessage(body);
        announce(NOTIFICATION_SEVERITIES.WARNING, 'Payment not found', body);
        setReloadToken((previous) => previous + 1);
        return;
      }

      const body = 'The decision could not be recorded with your current role. Try again.';
      setErrorMessage(body);
      announce(NOTIFICATION_SEVERITIES.WARNING, 'Decision unavailable', body);
    },
    [
      deciding,
      selectedPayment,
      comment,
      session,
      announce,
      NOTIFICATION_SEVERITIES,
    ],
  );

  const handleApprove = useCallback(() => handleDecision('approve'), [handleDecision]);
  const handleReject = useCallback(() => handleDecision('reject'), [handleDecision]);

  const columns = useMemo(
    () => [
      {
        key: 'paymentReference',
        header: 'Payment',
        render: (row) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-body">
              {toText(row.paymentReference) || toText(row.paymentId) || '—'}
            </span>
            <span className="text-xs text-body">{toText(row.paymentId)}</span>
          </div>
        ),
      },
      {
        key: 'beneficiaryName',
        header: 'Beneficiary',
        render: (row) => toText(row.beneficiaryName) || '—',
      },
      {
        key: 'instructedAmount',
        header: 'Amount',
        render: (row) => formatAmount(row.instructedAmount, toText(row.sourceCurrency)),
      },
      {
        key: 'pairId',
        header: 'Currency pair',
        render: (row) => toText(row.pairId) || '—',
      },
      {
        key: 'status',
        header: 'Status',
        render: (row) => (
          <StatusBadge tone={STATUS_TONES.WARNING}>{toLabel(row.status)}</StatusBadge>
        ),
      },
      {
        key: 'review',
        header: 'Review',
        render: (row) => (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => handleSelect(toText(row.paymentId))}
          >
            Review
          </Button>
        ),
      },
    ],
    [handleSelect],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-primary-blue-700">Approval queue</h1>
        <p className="text-sm text-body">
          Review payments awaiting approval and approve or reject each one. Identifiers, amounts, and
          contact details are masked to protect information.
        </p>
      </div>

      <Alert severity={ALERT_SEVERITIES.INFO} title="Simulated approvals only">
        Approvals here are a demonstration. Approving or rejecting a payment records a simulated
        decision — no funds move, no message reaches any provider, and segregation-of-duties is
        enforced in your browser for the demo only.
      </Alert>

      {!authorized ? (
        <Alert severity={ALERT_SEVERITIES.CRITICAL} title="Access denied">
          Your current role does not hold the capability required to approve payments. Switch to a
          role that grants it and try again.
        </Alert>
      ) : loading ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-primary-blue-100 bg-white px-4 py-6 text-center text-sm text-body"
        >
          Loading approval queue…
        </div>
      ) : (
        <>
          {statusMessage.length > 0 ? (
            <div role="status" aria-live="polite">
              <Alert severity={ALERT_SEVERITIES.SUCCESS} title="Decision recorded">
                {statusMessage}
              </Alert>
            </div>
          ) : null}

          {total === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-md border border-primary-blue-100 bg-primary-blue-50 px-4 py-8 text-center">
              <p className="text-sm text-body">
                There are no payments awaiting approval for your entitlements.
              </p>
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={pageRows}
              rowKey="paymentId"
              caption="Payments awaiting approval"
              emptyMessage="There are no payments awaiting approval."
              pagination={{ page: currentPage, pageSize: DEFAULT_PAGE_SIZE, total }}
              onPageChange={handlePageChange}
            />
          )}

          {isPlainObject(selectedPayment) ? (
            <section
              aria-labelledby="approval-detail-heading"
              className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <h2 id="approval-detail-heading" className="text-lg font-medium text-body">
                    {toText(selectedPayment.paymentReference) ||
                      toText(selectedPayment.paymentId) ||
                      '—'}
                  </h2>
                  <span className="text-xs text-body">{toText(selectedPayment.paymentId)}</span>
                </div>
                <StatusBadge tone={STATUS_TONES.WARNING}>
                  {toLabel(selectedPayment.status)}
                </StatusBadge>
              </div>

              <dl className="flex flex-col">
                <DetailRow label="Initiator">
                  {toText(selectedPayment.submittedBy) || '—'}
                </DetailRow>
                <DetailRow label="Beneficiary">
                  {toText(selectedPayment.beneficiaryName) || '—'}
                </DetailRow>
                <DetailRow label="Debit account">
                  {toText(selectedPayment.accountId) || '—'}
                </DetailRow>
                <DetailRow label="Currency pair">
                  {toText(selectedPayment.pairId) || '—'}
                </DetailRow>
                <DetailRow label="Instructed amount">
                  {formatAmount(
                    selectedPayment.instructedAmount,
                    toText(selectedPayment.sourceCurrency),
                  )}
                </DetailRow>
                <DetailRow label="Settlement amount">
                  {formatAmount(
                    selectedPayment.settlementAmount,
                    toText(selectedPayment.beneficiaryCurrency),
                  )}
                </DetailRow>
                <DetailRow label="Fee">
                  {formatAmount(
                    selectedPayment.feeAmount,
                    toText(selectedPayment.feeCurrency) || toText(selectedPayment.sourceCurrency),
                  )}
                </DetailRow>
                <DetailRow label="Charge treatment">
                  {toText(selectedPayment.chargeTreatment).length > 0 ? (
                    <StatusBadge tone={STATUS_TONES.NEUTRAL}>
                      {toText(selectedPayment.chargeTreatment)}
                    </StatusBadge>
                  ) : (
                    '—'
                  )}
                </DetailRow>
                <DetailRow label="Remittance information">
                  {toText(selectedPayment.remittanceInfo) || '—'}
                </DetailRow>
              </dl>

              {isOwnSubmission ? (
                <Alert severity={ALERT_SEVERITIES.WARNING} title="Segregation of duties">
                  You submitted this payment, so you cannot approve it. A different approver must
                  action it. You may still reject it if appropriate.
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
                {deciding ? (
                  <LoadingIndicator size="sm" label="Recording decision…" showLabel />
                ) : null}
              </div>
            </section>
          ) : (
            <section
              aria-labelledby="approval-detail-heading"
              className="flex flex-col gap-3 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-6"
            >
              <h2 id="approval-detail-heading" className="text-lg font-medium text-body">
                Review a payment
              </h2>
              <p className="text-sm text-body">
                Select a payment from the queue to review its masked details and record an approval
                or rejection.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

export default ApprovalQueuePage;