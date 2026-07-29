/**
 * Operations status page.
 *
 * OperationsPage is the payment operations surface (SCRUM-820/821). It reads the
 * entitlement-scoped, masked payment set from the read-only
 * {@link operationsFacade} (which enforces the deny-by-default
 * {@link authorizationPolicy}) and lets an operator search the processing,
 * repair, accounting, and SWIFT outcomes by status, currency, reference, and
 * scenario. It renders:
 *
 *   - A filter panel driven entirely by controlled React state; the page holds
 *     the full filter/pagination model so filtering and paging stay in sync.
 *   - A responsive {@link DataTable} listing every matching payment with masked
 *     identifiers, amounts, and a status badge, with server-side (facade)
 *     pagination.
 *   - A "Review" action per row that navigates to the {@link OperationsDetailPage}
 *     for that payment, where the sanitized checkpoints, postings, SWIFT status,
 *     and permitted lifecycle transitions actually live.
 *
 * The page renders only sanitized, masked copy — never raw PII beyond the
 * masked models the facade produces — and never mutates application state
 * beyond its own local search/pagination model.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccessContext } from '@/app/useAccessContext';
import { operationsFacade } from '@/features/payment/services/operationsFacade';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { DataTable } from '@/shared/ui/DataTable';
import { FormField } from '@/shared/ui/FormField';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { cn } from '@/shared/ui/cn';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default page size applied to the operations queue. */
const DEFAULT_PAGE_SIZE = 25;

/** Sentinel filter value meaning "no filter applied". */
const ANY_VALUE = 'any';

/**
 * Selectable status filter options.
 * @type {ReadonlyArray<{ value: string, label: string }>}
 */
const STATUS_OPTIONS = Object.freeze([
  { value: ANY_VALUE, label: 'All statuses' },
  { value: 'pending_approval', label: 'Pending approval' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'processing', label: 'Processing' },
  { value: 'pending_review', label: 'Pending review' },
  { value: 'repair_required', label: 'Repair required' },
  { value: 'sent_to_swift', label: 'Sent to SWIFT' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'rejected', label: 'Rejected' },
]);

/**
 * Selectable currency filter options.
 * @type {ReadonlyArray<{ value: string, label: string }>}
 */
const CURRENCY_OPTIONS = Object.freeze([
  { value: ANY_VALUE, label: 'All currencies' },
  { value: 'EUR', label: 'EUR' },
  { value: 'USD', label: 'USD' },
  { value: 'GBP', label: 'GBP' },
]);

/**
 * Initial filter model applied on mount and when filters are cleared.
 * @type {{
 *   status: string,
 *   currency: string,
 *   reference: string,
 *   scenarioRef: string,
 *   since: string,
 *   until: string,
 * }}
 */
const INITIAL_FILTERS = Object.freeze({
  status: ANY_VALUE,
  currency: ANY_VALUE,
  reference: '',
  scenarioRef: '',
  since: '',
  until: '',
});

/** Shared control class list for text/select inputs. */
const CONTROL_CLASSES = cn(
  'rounded-md border border-primary-blue-200 bg-white px-3 py-2 text-sm text-body',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500 focus-visible:ring-offset-2',
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
 * Renders the payment operations status page.
 *
 * The page loads the masked, entitlement-scoped payment set, applies the
 * controlled status/currency/reference/scenario/date filters with facade
 * pagination, and lists it with a "Review" action per row that navigates to
 * the {@link OperationsDetailPage} for that payment.
 *
 * @returns {React.ReactElement} The operations page element.
 */
export function OperationsPage() {
  const { sessionIdentity, maskingPolicy } = useAccessContext();
  const navigate = useNavigate();

  const [payments, setPayments] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [page, setPage] = useState(0);

  const session = useMemo(() => toSessionClaim(sessionIdentity), [sessionIdentity]);
  const context = useMemo(() => toText(maskingPolicy) || undefined, [maskingPolicy]);

  useEffect(() => {
    let active = true;
    setLoading(true);

    const filter = {
      page,
      pageSize: DEFAULT_PAGE_SIZE,
      context,
    };
    if (filters.status !== ANY_VALUE) {
      filter.status = filters.status;
    }
    if (filters.currency !== ANY_VALUE) {
      filter.currency = filters.currency;
    }
    if (toText(filters.reference).length > 0) {
      filter.reference = toText(filters.reference);
    }
    if (toText(filters.scenarioRef).length > 0) {
      filter.scenarioRef = toText(filters.scenarioRef);
    }
    if (toText(filters.since).length > 0) {
      filter.since = toText(filters.since);
    }
    if (toText(filters.until).length > 0) {
      filter.until = toText(filters.until);
    }

    let result;
    try {
      result = operationsFacade.searchPayments(session, filter);
    } catch (error) {
      safeLogger.warn('OperationsPage: failed to search payments', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        payments: [],
        total: 0,
        safeReasonCode: operationsFacade.OPERATIONS_FACADE_REASON_CODES.UNEXPECTED,
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
      setTotal(typeof result.total === 'number' && Number.isFinite(result.total) ? result.total : 0);
    } else {
      setAuthorized(
        result.safeReasonCode !==
          operationsFacade.OPERATIONS_FACADE_REASON_CODES.UNAUTHORIZED,
      );
      setPayments([]);
      setTotal(0);
    }
    setLoading(false);

    return () => {
      active = false;
    };
  }, [session, context, filters, page]);

  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);

  const filtersActive = useMemo(
    () =>
      filters.status !== ANY_VALUE ||
      filters.currency !== ANY_VALUE ||
      toText(filters.reference).length > 0 ||
      toText(filters.scenarioRef).length > 0 ||
      toText(filters.since).length > 0 ||
      toText(filters.until).length > 0,
    [filters],
  );

  const handleFilterChange = useCallback((key, value) => {
    setFilters((previous) => ({ ...previous, [key]: value }));
    setPage(0);
  }, []);

  const handleClearFilters = useCallback(() => {
    setFilters(INITIAL_FILTERS);
    setPage(0);
  }, []);

  const handlePageChange = useCallback((nextPage) => {
    setPage(nextPage);
  }, []);

  const handleReview = useCallback(
    (paymentId) => {
      navigate(`/operations/${paymentId}`);
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
        key: 'scenarioRef',
        header: 'Scenario',
        render: (row) => toText(row.scenarioRef) || '—',
      },
      {
        key: 'status',
        header: 'Status',
        render: (row) => (
          <StatusBadge tone={statusTone(toText(row.status))}>{toLabel(row.status)}</StatusBadge>
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
        <h1 className="text-2xl font-medium text-primary-blue-700">Payment operations</h1>
        <p className="text-sm text-body">
          Search and operate accepted payments. Identifiers, amounts, and remittance details are
          masked to protect information, and all processing outcomes are simulated.
        </p>
      </div>

      <Alert severity={ALERT_SEVERITIES.INFO} title="Simulated operations only">
        Operations here are a demonstration. Progressing, holding, releasing, or resetting a payment
        records a simulated transition — no funds move and no message reaches any provider.
      </Alert>

      {!authorized ? (
        <Alert severity={ALERT_SEVERITIES.CRITICAL} title="Access denied">
          Your current role does not hold the capability required to operate payments. Switch to a
          role that grants it and try again.
        </Alert>
      ) : (
        <>
          <section
            aria-label="Operations filters"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-4"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <FormField label="Status">
                {(attrs) => (
                  <select
                    className={CONTROL_CLASSES}
                    value={filters.status}
                    onChange={(event) => handleFilterChange('status', event.target.value)}
                    {...attrs}
                  >
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>

              <FormField label="Currency">
                {(attrs) => (
                  <select
                    className={CONTROL_CLASSES}
                    value={filters.currency}
                    onChange={(event) => handleFilterChange('currency', event.target.value)}
                    {...attrs}
                  >
                    {CURRENCY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>

              <FormField label="Reference">
                {(attrs) => (
                  <input
                    type="text"
                    autoComplete="off"
                    className={CONTROL_CLASSES}
                    value={filters.reference}
                    onChange={(event) => handleFilterChange('reference', event.target.value)}
                    {...attrs}
                  />
                )}
              </FormField>

              <FormField label="Scenario">
                {(attrs) => (
                  <input
                    type="text"
                    autoComplete="off"
                    className={CONTROL_CLASSES}
                    value={filters.scenarioRef}
                    onChange={(event) => handleFilterChange('scenarioRef', event.target.value)}
                    {...attrs}
                  />
                )}
              </FormField>

              <FormField label="From">
                {(attrs) => (
                  <input
                    type="date"
                    autoComplete="off"
                    className={CONTROL_CLASSES}
                    value={filters.since}
                    onChange={(event) => handleFilterChange('since', event.target.value)}
                    {...attrs}
                  />
                )}
              </FormField>

              <FormField label="To">
                {(attrs) => (
                  <input
                    type="date"
                    autoComplete="off"
                    className={CONTROL_CLASSES}
                    value={filters.until}
                    onChange={(event) => handleFilterChange('until', event.target.value)}
                    {...attrs}
                  />
                )}
              </FormField>
            </div>

            <div className="flex items-center justify-end">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!filtersActive}
                onClick={handleClearFilters}
              >
                Clear filters
              </Button>
            </div>
          </section>

          {loading ? (
            <div
              role="status"
              aria-live="polite"
              className="rounded-md border border-primary-blue-100 bg-white px-4 py-6 text-center text-sm text-body"
            >
              Loading payments…
            </div>
          ) : total === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-md border border-primary-blue-100 bg-primary-blue-50 px-4 py-8 text-center">
              <p className="text-sm text-body">
                {filtersActive
                  ? 'No payments match the current filters.'
                  : 'There are no payments to display for your entitlements.'}
              </p>
              {filtersActive ? (
                <Button type="button" variant="secondary" size="sm" onClick={handleClearFilters}>
                  Clear filters
                </Button>
              ) : null}
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={payments}
              rowKey="paymentId"
              caption="Payment operations"
              emptyMessage="No payments match the current filters."
              pagination={{ page: currentPage, pageSize: DEFAULT_PAGE_SIZE, total }}
              onPageChange={handlePageChange}
            />
          )}
        </>
      )}
    </div>
  );
}

export default OperationsPage;
