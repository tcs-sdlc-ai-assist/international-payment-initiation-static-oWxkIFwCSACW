/**
 * Payment approval queue page.
 *
 * ApprovalQueuePage is the approver experience for the payment approval flow
 * (SCRUM-819). It reads the entitlement-scoped, masked pending-approval queue
 * from the {@link approvalFacade} (which enforces the deny-by-default
 * {@link authorizationPolicy}) and lists each payment's masked initiator,
 * beneficiary, amount, and status. It renders:
 *
 *   - A responsive {@link DataTable} listing every payment awaiting approval,
 *     with masked identifiers, amounts, and a status badge.
 *   - A "Review" action per row that navigates to the {@link ApprovalDetailPage}
 *     for that payment, where the approve/reject decision is actually recorded.
 *
 * The page renders only sanitized, masked copy — never raw PII beyond the
 * masked models the facade produces — and never mutates application state
 * beyond its own local queue/pagination model.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccessContext } from '@/app/useAccessContext';
import { approvalFacade } from '@/features/payment/services/approvalFacade';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { DataTable } from '@/shared/ui/DataTable';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default page size applied to the approval queue. */
const DEFAULT_PAGE_SIZE = 10;

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
 * Renders the payment approval queue page.
 *
 * The page loads the masked, entitlement-scoped pending-approval queue and
 * lists it with a "Review" action per row that navigates to the
 * {@link ApprovalDetailPage} for that payment, where the actual decision is
 * recorded.
 *
 * @returns {React.ReactElement} The approval queue page element.
 */
export function ApprovalQueuePage() {
  const { sessionIdentity, maskingPolicy } = useAccessContext();
  const navigate = useNavigate();

  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [page, setPage] = useState(0);

  const session = useMemo(() => toSessionClaim(sessionIdentity), [sessionIdentity]);

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
  }, [session, maskingPolicy]);

  const total = payments.length;
  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageStart = currentPage * DEFAULT_PAGE_SIZE;
  const pageRows = useMemo(
    () => payments.slice(pageStart, pageStart + DEFAULT_PAGE_SIZE),
    [payments, pageStart],
  );

  const handlePageChange = useCallback((nextPage) => {
    setPage(nextPage);
  }, []);

  const handleReview = useCallback(
    (paymentId) => {
      navigate(`/approvals/${paymentId}`);
    },
    [navigate],
  );

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
            onClick={() => handleReview(toText(row.paymentId))}
          >
            Review
          </Button>
        ),
      },
    ],
    [handleReview],
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
      ) : total === 0 ? (
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
    </div>
  );
}

export default ApprovalQueuePage;
