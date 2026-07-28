/**
 * Audit history page.
 *
 * AuditHistoryPage is the local audit-history surface (SCRUM-827). It reads
 * sanitized, masked audit events from the shared {@link auditFacade} and lets the
 * user narrow the recorded activity by event type, actor, subject, safe reason
 * code, free text, and a since/until instant window. It renders:
 *
 *   - A filter panel driven entirely by controlled React state; the page holds
 *     the full filter/pagination model so filtering and paging stay in sync.
 *   - A responsive {@link DataTable} that renders a semantic table on wide
 *     viewports and a labeled card list on small screens, with client-side
 *     pagination.
 *   - An accessible empty state offering a clear-filters action when the active
 *     filters exclude every event, and a distinct disclaimer stating that this
 *     audit trail is local demonstration data — non-immutable and
 *     non-regulatory.
 *
 * The page renders only sanitized, masked copy — never raw PII beyond the
 * sanitized audit events the facade produces — and never mutates application
 * state beyond its own local filter/pagination model.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { auditFacade } from '@/features/access/data/auditFacade';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { DataTable } from '@/shared/ui/DataTable';
import { FormField } from '@/shared/ui/FormField';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { cn } from '@/shared/ui/cn';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default page size applied to the audit history list. */
const DEFAULT_PAGE_SIZE = 10;

/** Sentinel filter value meaning "no filter applied". */
const ANY_VALUE = 'any';

/**
 * Initial filter model applied on mount and when filters are cleared.
 * @type {{
 *   eventType: string,
 *   actorId: string,
 *   subjectId: string,
 *   text: string,
 * }}
 */
const INITIAL_FILTERS = Object.freeze({
  eventType: ANY_VALUE,
  actorId: '',
  subjectId: '',
  text: '',
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
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Formats an event-type / reason-code identifier into a readable label.
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
 * Resolves the initial subject filter from the router query string, when
 * present, so a signer detail deep-link can pre-scope the audit history.
 * @param {string} search - The location search string.
 * @returns {string} The initial subject filter (empty when absent).
 */
function resolveInitialSubject(search) {
  if (typeof search !== 'string' || search.length === 0) {
    return '';
  }
  try {
    const params = new URLSearchParams(search);
    return toText(params.get('subjectId'));
  } catch (error) {
    safeLogger.warn('AuditHistoryPage: failed to parse subject query parameter', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return '';
  }
}

/**
 * Builds the distinct event-type filter options from the recorded events.
 * @param {Array<Record<string, unknown>>} events - The audit events.
 * @returns {Array<{ value: string, label: string }>} The event-type options.
 */
function buildEventTypeOptions(events) {
  const types = new Set();
  for (const event of events) {
    if (!isPlainObject(event)) {
      continue;
    }
    const eventType = toText(event.eventType);
    if (eventType.length > 0) {
      types.add(eventType);
    }
  }
  const sorted = Array.from(types).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [{ value: ANY_VALUE, label: 'All event types' }].concat(
    sorted.map((eventType) => ({ value: eventType, label: toLabel(eventType) })),
  );
}

/**
 * Renders the local audit-history page.
 *
 * The page loads sanitized, masked audit events from the shared audit facade,
 * applies the controlled event-type / actor / subject / text filters, and
 * paginates the filtered results. It surfaces a local-data disclaimer and an
 * empty state with a clear-filters action when the active filters exclude every
 * event.
 *
 * @returns {React.ReactElement} The audit history page element.
 */
export function AuditHistoryPage() {
  const location = useLocation();

  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filters, setFilters] = useState(() => ({
    ...INITIAL_FILTERS,
    subjectId: resolveInitialSubject(location.search),
  }));
  const [page, setPage] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);

    let result;
    try {
      result = auditFacade.search();
    } catch (error) {
      safeLogger.warn('AuditHistoryPage: failed to load audit history', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = [];
    }

    if (!active) {
      return;
    }

    setEvents(Array.isArray(result) ? result.filter((event) => isPlainObject(event)) : []);
    setLoadError(!Array.isArray(result));
    setLoading(false);

    return () => {
      active = false;
    };
  }, []);

  const eventTypeOptions = useMemo(() => buildEventTypeOptions(events), [events]);

  const filteredEvents = useMemo(() => {
    const actorFilter = toText(filters.actorId).toLowerCase();
    const subjectFilter = toText(filters.subjectId).toLowerCase();
    const textFilter = toText(filters.text).toLowerCase();

    return events.filter((event) => {
      if (!isPlainObject(event)) {
        return false;
      }
      if (filters.eventType !== ANY_VALUE && toText(event.eventType) !== filters.eventType) {
        return false;
      }
      if (actorFilter.length > 0 && !toText(event.actorId).toLowerCase().includes(actorFilter)) {
        return false;
      }
      if (
        subjectFilter.length > 0 &&
        !toText(event.subjectId).toLowerCase().includes(subjectFilter)
      ) {
        return false;
      }
      if (textFilter.length > 0) {
        const haystack = `${toText(event.eventType)} ${toText(event.safeReasonCode)}`.toLowerCase();
        if (!haystack.includes(textFilter)) {
          return false;
        }
      }
      return true;
    });
  }, [events, filters]);

  const total = filteredEvents.length;
  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageStart = currentPage * DEFAULT_PAGE_SIZE;
  const pageRows = useMemo(
    () => filteredEvents.slice(pageStart, pageStart + DEFAULT_PAGE_SIZE),
    [filteredEvents, pageStart],
  );

  const filtersActive = useMemo(
    () =>
      filters.eventType !== ANY_VALUE ||
      toText(filters.actorId).length > 0 ||
      toText(filters.subjectId).length > 0 ||
      toText(filters.text).length > 0,
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
        key: 'eventType',
        header: 'Event',
        render: (row) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-body">{toLabel(row.eventType)}</span>
            <span className="text-xs text-body">{toText(row.eventId)}</span>
          </div>
        ),
      },
      {
        key: 'actorId',
        header: 'Actor',
        render: (row) => toText(row.actorId) || '—',
      },
      {
        key: 'subjectId',
        header: 'Subject',
        render: (row) => toText(row.subjectId) || '—',
      },
      {
        key: 'safeReasonCode',
        header: 'Reason',
        render: (row) => {
          const code = toText(row.safeReasonCode);
          return code.length > 0 ? (
            <StatusBadge tone={STATUS_TONES.INFO}>{toLabel(code)}</StatusBadge>
          ) : (
            '—'
          );
        },
      },
      {
        key: 'occurredAt',
        header: 'Occurred',
        render: (row) => toText(row.occurredAt) || '—',
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-primary-blue-700">Audit history</h1>
        <p className="text-sm text-body">
          Review the recorded, sanitized activity for this demo session. Contact and identifier
          fields are masked to protect information, and this view is read-only.
        </p>
      </div>

      <Alert severity={ALERT_SEVERITIES.INFO} title="Local demonstration data">
        This audit trail is stored locally in your browser for the demo only. It is non-immutable
        and non-regulatory — it provides no tamper evidence and must never be treated as a compliant
        audit trail.
      </Alert>

      {loadError ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="Audit history unavailable">
          The recorded audit history could not be loaded for this session. No entries are available
          to display.
        </Alert>
      ) : null}

      <section
        aria-label="Audit filters"
        className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-4"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FormField label="Event type">
            {(attrs) => (
              <select
                className={CONTROL_CLASSES}
                value={filters.eventType}
                onChange={(event) => handleFilterChange('eventType', event.target.value)}
                {...attrs}
              >
                {eventTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </FormField>

          <FormField label="Actor">
            {(attrs) => (
              <input
                type="text"
                autoComplete="off"
                className={CONTROL_CLASSES}
                value={filters.actorId}
                onChange={(event) => handleFilterChange('actorId', event.target.value)}
                {...attrs}
              />
            )}
          </FormField>

          <FormField label="Subject">
            {(attrs) => (
              <input
                type="text"
                autoComplete="off"
                className={CONTROL_CLASSES}
                value={filters.subjectId}
                onChange={(event) => handleFilterChange('subjectId', event.target.value)}
                {...attrs}
              />
            )}
          </FormField>

          <FormField label="Search text">
            {(attrs) => (
              <input
                type="search"
                autoComplete="off"
                className={CONTROL_CLASSES}
                value={filters.text}
                onChange={(event) => handleFilterChange('text', event.target.value)}
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
          Loading audit history…
        </div>
      ) : total === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-primary-blue-100 bg-primary-blue-50 px-4 py-8 text-center">
          <p className="text-sm text-body">
            {filtersActive
              ? 'No audit events match the current filters.'
              : 'There is no recorded activity to display for this session.'}
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
          rowKey="eventId"
          caption="Audit history"
          emptyMessage="No audit events match the current filters."
          pagination={{ page: currentPage, pageSize: DEFAULT_PAGE_SIZE, total }}
          onPageChange={handlePageChange}
        />
      )}
    </div>
  );
}

export default AuditHistoryPage;