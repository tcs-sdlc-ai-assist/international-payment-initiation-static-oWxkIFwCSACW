/**
 * Signer list page.
 *
 * SignerListPage is the authorized-signer list surface (SCRUM-824). It reads the
 * entitlement-scoped, masked signer display models from the {@link signerService}
 * (which enforces the deny-by-default {@link authorizationPolicy}), and lets the
 * user narrow the list by account scope, status, invitation state, and signing
 * authority. It renders:
 *
 *   - A filter panel driven entirely by controlled React state; the page holds
 *     the full filter/pagination model so filtering and paging stay in sync.
 *   - A responsive {@link DataTable} that renders a semantic table on wide
 *     viewports and a labeled card list on small screens, with client-side
 *     pagination.
 *   - An accessible empty state offering a clear-filters action when the active
 *     filters exclude every signer, and a distinct unauthorized state when the
 *     session lacks the read capability.
 *
 * The page renders only sanitized, masked copy — never raw PII beyond the
 * masked display models the service produces — and never mutates application
 * state beyond its own local filter/pagination model.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccessContext } from '@/app/useAccessContext';
import { signerService } from '@/features/access/services/signerService';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { DataTable } from '@/shared/ui/DataTable';
import { FormField } from '@/shared/ui/FormField';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { cn } from '@/shared/ui/cn';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default page size applied to the signer list. */
const DEFAULT_PAGE_SIZE = 10;

/** Sentinel filter value meaning "no filter applied". */
const ANY_VALUE = 'any';

/**
 * Selectable status filter options.
 * @type {ReadonlyArray<{ value: string, label: string }>}
 */
const STATUS_OPTIONS = Object.freeze([
  { value: ANY_VALUE, label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'pending', label: 'Pending' },
]);

/**
 * Selectable invitation-state filter options.
 * @type {ReadonlyArray<{ value: string, label: string }>}
 */
const INVITATION_OPTIONS = Object.freeze([
  { value: ANY_VALUE, label: 'All invitation states' },
  { value: 'not_invited', label: 'Not invited' },
  { value: 'invited', label: 'Invited' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'expired', label: 'Expired' },
]);

/**
 * Selectable signing-authority filter options.
 * @type {ReadonlyArray<{ value: string, label: string }>}
 */
const AUTHORITY_OPTIONS = Object.freeze([
  { value: ANY_VALUE, label: 'All authorities' },
  { value: 'sole', label: 'Sole' },
  { value: 'joint', label: 'Joint' },
  { value: 'limited', label: 'Limited' },
]);

/**
 * Initial filter model applied on mount and when filters are cleared.
 * @type {{
 *   account: string,
 *   status: string,
 *   invitationState: string,
 *   authority: string,
 * }}
 */
const INITIAL_FILTERS = Object.freeze({
  account: ANY_VALUE,
  status: ANY_VALUE,
  invitationState: ANY_VALUE,
  authority: ANY_VALUE,
});

/** Shared control class list for select inputs. */
const SELECT_CLASSES = cn(
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
 * Builds the distinct account-scope filter options from the visible signers.
 * @param {Array<Record<string, unknown>>} signers - The masked signer models.
 * @returns {Array<{ value: string, label: string }>} The account options.
 */
function buildAccountOptions(signers) {
  const scopes = new Set();
  for (const signer of signers) {
    if (!isPlainObject(signer)) {
      continue;
    }
    for (const scope of toStringArray(signer.account_scopes)) {
      scopes.add(scope);
    }
  }
  const sorted = Array.from(scopes).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [{ value: ANY_VALUE, label: 'All accounts' }].concat(
    sorted.map((scope) => ({ value: scope, label: scope })),
  );
}

/**
 * Renders the authorized-signer list page.
 *
 * The page loads masked signer display models scoped to the acting session's
 * entitlements, applies the controlled account/status/invitation/authority
 * filters, and paginates the filtered results. It renders an unauthorized state
 * when the session lacks the read capability and an empty state with a
 * clear-filters action when the active filters exclude every signer.
 *
 * @returns {React.ReactElement} The signer list page element.
 */
export function SignerListPage() {
  const { sessionIdentity, maskingPolicy } = useAccessContext();

  const [signers, setSigners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [page, setPage] = useState(0);

  const accountScopes = useMemo(
    () => resolveAccountScopes(sessionIdentity),
    [sessionIdentity],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);

    const claim = toSessionClaim(sessionIdentity);
    const context = toText(maskingPolicy) || undefined;

    let result;
    try {
      result = signerService.search(claim, { accountScopes, context });
    } catch (error) {
      safeLogger.warn('SignerListPage: failed to load signers', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = { ok: false, signers: [], safeReasonCode: 'signer.service.unexpected' };
    }

    if (!active) {
      return;
    }

    if (result.ok) {
      setAuthorized(true);
      setSigners(Array.isArray(result.signers) ? result.signers : []);
    } else {
      setAuthorized(result.safeReasonCode !== signerService.SIGNER_SERVICE_REASON_CODES.UNAUTHORIZED);
      setSigners([]);
    }
    setLoading(false);

    return () => {
      active = false;
    };
  }, [sessionIdentity, maskingPolicy, accountScopes]);

  const accountOptions = useMemo(() => buildAccountOptions(signers), [signers]);

  const filteredSigners = useMemo(() => {
    return signers.filter((signer) => {
      if (!isPlainObject(signer)) {
        return false;
      }
      if (filters.status !== ANY_VALUE && toText(signer.status) !== filters.status) {
        return false;
      }
      if (
        filters.invitationState !== ANY_VALUE &&
        toText(signer.invitation_state) !== filters.invitationState
      ) {
        return false;
      }
      if (filters.authority !== ANY_VALUE && toText(signer.authority) !== filters.authority) {
        return false;
      }
      if (filters.account !== ANY_VALUE) {
        const scopes = toStringArray(signer.account_scopes);
        if (!scopes.includes(filters.account)) {
          return false;
        }
      }
      return true;
    });
  }, [signers, filters]);

  const total = filteredSigners.length;
  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageStart = currentPage * DEFAULT_PAGE_SIZE;
  const pageRows = useMemo(
    () => filteredSigners.slice(pageStart, pageStart + DEFAULT_PAGE_SIZE),
    [filteredSigners, pageStart],
  );

  const filtersActive = useMemo(
    () =>
      filters.account !== ANY_VALUE ||
      filters.status !== ANY_VALUE ||
      filters.invitationState !== ANY_VALUE ||
      filters.authority !== ANY_VALUE,
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

  const columns = useMemo(
    () => [
      {
        key: 'signer_name',
        header: 'Signer',
        render: (row) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-body">{toText(row.signer_name) || '—'}</span>
            <span className="text-xs text-body">{toText(row.signer_id)}</span>
          </div>
        ),
      },
      {
        key: 'authority',
        header: 'Authority',
        render: (row) => (
          <StatusBadge tone={STATUS_TONES.NEUTRAL}>{toLabel(row.authority)}</StatusBadge>
        ),
      },
      {
        key: 'account_scopes',
        header: 'Accounts',
        render: (row) => {
          const scopes = toStringArray(row.account_scopes);
          return scopes.length > 0 ? scopes.join(', ') : '—';
        },
      },
      {
        key: 'status',
        header: 'Status',
        render: (row) => (
          <StatusBadge tone={statusTone(toText(row.status))}>{toLabel(row.status)}</StatusBadge>
        ),
      },
      {
        key: 'invitation_state',
        header: 'Invitation',
        render: (row) => (
          <StatusBadge tone={invitationTone(toText(row.invitation_state))}>
            {toLabel(row.invitation_state)}
          </StatusBadge>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-primary-blue-700">Authorized signers</h1>
        <p className="text-sm text-body">
          Review the entitlement-scoped signer list. Contact and identifier fields are masked to
          protect information, and this view is read-only.
        </p>
      </div>

      {!authorized ? (
        <Alert severity={ALERT_SEVERITIES.CRITICAL} title="Access denied">
          Your current role does not hold the capability required to view signers. Switch to a role
          that grants it and try again.
        </Alert>
      ) : (
        <>
          <section
            aria-label="Signer filters"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-4"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <FormField label="Account">
                {(attrs) => (
                  <select
                    className={SELECT_CLASSES}
                    value={filters.account}
                    onChange={(event) => handleFilterChange('account', event.target.value)}
                    {...attrs}
                  >
                    {accountOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>

              <FormField label="Status">
                {(attrs) => (
                  <select
                    className={SELECT_CLASSES}
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

              <FormField label="Invitation state">
                {(attrs) => (
                  <select
                    className={SELECT_CLASSES}
                    value={filters.invitationState}
                    onChange={(event) => handleFilterChange('invitationState', event.target.value)}
                    {...attrs}
                  >
                    {INVITATION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>

              <FormField label="Signing authority">
                {(attrs) => (
                  <select
                    className={SELECT_CLASSES}
                    value={filters.authority}
                    onChange={(event) => handleFilterChange('authority', event.target.value)}
                    {...attrs}
                  >
                    {AUTHORITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
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
              Loading signers…
            </div>
          ) : total === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-md border border-primary-blue-100 bg-primary-blue-50 px-4 py-8 text-center">
              <p className="text-sm text-body">
                {filtersActive
                  ? 'No signers match the current filters.'
                  : 'There are no signers to display for your entitlements.'}
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
              rows={pageRows}
              rowKey="signer_id"
              caption="Authorized signers"
              emptyMessage="No signers match the current filters."
              pagination={{ page: currentPage, pageSize: DEFAULT_PAGE_SIZE, total }}
              onPageChange={handlePageChange}
            />
          )}
        </>
      )}
    </div>
  );
}

export default SignerListPage;