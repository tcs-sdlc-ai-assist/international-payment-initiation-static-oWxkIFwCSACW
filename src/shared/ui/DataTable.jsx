/**
 * Responsive design-system data table.
 *
 * DataTable is a presentational, accessible table that renders a semantic
 * `<table>` on wide viewports and transparently converts to a labeled card list
 * at the 320/640 breakpoints so every row remains readable on small screens. It
 * supports the signer administration and payment operations views (SCRUM-824 /
 * SCRUM-820):
 *
 *   - Column definitions declare a stable `key`, a human-readable `header`, and
 *     an optional `render` function; when a column omits `render` the raw cell
 *     value is coerced to text.
 *   - An empty state is rendered when there are no rows, so the table never
 *     shows a bare header with no content.
 *   - Pagination controls (previous/next plus a page indicator) are rendered
 *     when a bounded `pagination` model is supplied, preserving the caller's
 *     filter/pagination model — the component itself is stateless and simply
 *     invokes `onPageChange` with the requested zero-based page index.
 *
 * The card layout mirrors the table by pairing each column header with its cell
 * value via `data-label`, so assistive technology and sighted users both retain
 * the column context. The component is side-effect-free, renders sanitized copy
 * only, carries no PII beyond what callers supply, and never reads or mutates
 * application state. Callers may append extra utility classes via `className`
 * without overriding the base styling or accessibility affordances.
 */

import { useCallback } from 'react';
import PropTypes from 'prop-types';
import { cn } from '@/shared/ui/cn';
import { Button } from '@/shared/ui/Button';

/**
 * Determines whether a value is a plain, non-array object.
 * @param {unknown} value - The candidate value.
 * @returns {boolean} `true` when `value` is a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Coerces an arbitrary cell value into a display-safe string.
 * @param {unknown} value - The raw cell value.
 * @returns {string} A display string (empty placeholder when unusable).
 */
function toCellText(value) {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'string') {
    return value.length > 0 ? value : '—';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  return '—';
}

/**
 * Resolves a stable row key for a record at a given index.
 * @param {Record<string, unknown>} row - The row record.
 * @param {number} index - The row index.
 * @param {string | undefined} rowKey - Optional row-key property name.
 * @returns {string} A stable row key.
 */
function resolveRowKey(row, index, rowKey) {
  if (typeof rowKey === 'string' && rowKey.length > 0 && isPlainObject(row)) {
    const value = row[rowKey];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return `row-${index}`;
}

/**
 * Renders a single cell value for a column, honoring its optional renderer.
 * @param {{ key: string, render?: (row: Record<string, unknown>) => React.ReactNode }} column
 *   The column definition.
 * @param {Record<string, unknown>} row - The row record.
 * @returns {React.ReactNode} The rendered cell content.
 */
function renderCell(column, row) {
  if (typeof column.render === 'function') {
    return column.render(row);
  }
  const value = isPlainObject(row) ? row[column.key] : undefined;
  return toCellText(value);
}

/**
 * Resolves a bounded, non-negative integer, falling back when unusable.
 * @param {unknown} value - The candidate value.
 * @param {number} fallback - The value returned when `value` is unusable.
 * @returns {number} A finite, non-negative integer.
 */
function toNonNegativeInt(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return fallback;
}

/**
 * Renders an accessible, responsive design-system data table.
 *
 * The table renders semantically on wide viewports and switches to a labeled
 * card list at small breakpoints. It is stateless with respect to pagination:
 * the supplied `pagination` model drives the controls, and page changes are
 * surfaced via `onPageChange` so the caller retains full control of its
 * filter/pagination model.
 *
 * @param {{
 *   columns: Array<{
 *     key: string,
 *     header: string,
 *     render?: (row: Record<string, unknown>) => React.ReactNode,
 *     className?: string,
 *   }>,
 *   rows: Array<Record<string, unknown>>,
 *   caption?: string,
 *   rowKey?: string,
 *   emptyMessage?: string,
 *   pagination?: {
 *     page: number,
 *     pageSize: number,
 *     total: number,
 *   },
 *   onPageChange?: (page: number) => void,
 *   className?: string,
 * }} props - The data table props.
 * @returns {React.ReactElement} The data table element.
 */
export function DataTable({
  columns,
  rows,
  caption,
  rowKey,
  emptyMessage = 'No records to display.',
  pagination,
  onPageChange,
  className,
}) {
  const safeColumns = Array.isArray(columns)
    ? columns.filter(
        (column) =>
          isPlainObject(column) &&
          typeof column.key === 'string' &&
          column.key.length > 0 &&
          typeof column.header === 'string',
      )
    : [];
  const safeRows = Array.isArray(rows) ? rows.filter((row) => isPlainObject(row)) : [];

  const handlePageChange = useCallback(
    (nextPage) => {
      if (typeof onPageChange === 'function' && nextPage >= 0) {
        onPageChange(nextPage);
      }
    },
    [onPageChange],
  );

  const hasPagination = isPlainObject(pagination);
  const page = hasPagination ? toNonNegativeInt(pagination.page, 0) : 0;
  const pageSize = hasPagination ? Math.max(1, toNonNegativeInt(pagination.pageSize, 1)) : 1;
  const total = hasPagination ? toNonNegativeInt(pagination.total, 0) : 0;
  const totalPages = hasPagination ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const currentPage = Math.min(page, totalPages - 1);
  const canGoPrevious = hasPagination && currentPage > 0;
  const canGoNext = hasPagination && currentPage < totalPages - 1;

  const hasRows = safeRows.length > 0;
  const resolvedCaption =
    typeof caption === 'string' && caption.trim().length > 0 ? caption.trim() : undefined;

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {hasRows ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            {resolvedCaption ? (
              <caption className="sr-only">{resolvedCaption}</caption>
            ) : null}
            <thead className="hidden sm:table-header-group">
              <tr className="border-b border-primary-blue-100">
                {safeColumns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn(
                      'px-3 py-2 font-medium text-primary-blue-700',
                      column.className,
                    )}
                  >
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {safeRows.map((row, index) => (
                <tr
                  key={resolveRowKey(row, index, rowKey)}
                  className={cn(
                    'block border-b border-primary-blue-100 sm:table-row',
                    'mb-4 rounded-md border p-3 sm:mb-0 sm:rounded-none sm:border-x-0 sm:border-t-0 sm:p-0',
                  )}
                >
                  {safeColumns.map((column) => (
                    <td
                      key={column.key}
                      data-label={column.header}
                      className={cn(
                        'flex justify-between gap-4 py-1 text-body sm:table-cell sm:px-3 sm:py-2',
                        "before:font-medium before:text-primary-blue-700 before:content-[attr(data-label)] sm:before:content-none",
                        column.className,
                      )}
                    >
                      <span className="text-right sm:text-left">{renderCell(column, row)}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          role="status"
          className="rounded-md border border-primary-blue-100 bg-primary-blue-50 px-4 py-6 text-center text-sm text-body"
        >
          {emptyMessage}
        </div>
      )}

      {hasPagination ? (
        <nav
          aria-label="Pagination"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <p className="text-sm text-body" aria-live="polite">
            {`Page ${currentPage + 1} of ${totalPages}`}
            {total > 0 ? ` — ${total} total` : ''}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!canGoPrevious}
              onClick={() => handlePageChange(currentPage - 1)}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!canGoNext}
              onClick={() => handlePageChange(currentPage + 1)}
            >
              Next
            </Button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}

DataTable.propTypes = {
  columns: PropTypes.arrayOf(
    PropTypes.shape({
      key: PropTypes.string.isRequired,
      header: PropTypes.string.isRequired,
      render: PropTypes.func,
      className: PropTypes.string,
    }),
  ).isRequired,
  rows: PropTypes.arrayOf(PropTypes.object).isRequired,
  caption: PropTypes.string,
  rowKey: PropTypes.string,
  emptyMessage: PropTypes.string,
  pagination: PropTypes.shape({
    page: PropTypes.number.isRequired,
    pageSize: PropTypes.number.isRequired,
    total: PropTypes.number.isRequired,
  }),
  onPageChange: PropTypes.func,
  className: PropTypes.string,
};

export default DataTable;