/**
 * Async error/retry alert.
 *
 * AsyncAlert is a presentational, accessible alert that surfaces the outcome of
 * a simulated async operation (SCRUM-821). It composes the design-system
 * {@link Alert} with an optional retry action, rendering the retry control only
 * when the underlying condition is retryable. It covers the demo failure modes
 * exercised across the payment cluster — simulated failures, network errors,
 * quote/invitation expiry, and session timeout — mapping each to a sanitized,
 * customer-safe title and body plus an appropriate severity.
 *
 * Callers may pass a structured `error` object (typically a
 * {@link PaymentDomainError#toSafeObject} snapshot carrying `kind`, `retryable`,
 * and `customerCopy`) or override the copy and retryability directly. When both
 * are supplied the explicit props win. The component never derives copy from raw
 * error internals: it consumes only sanitized primitives and safe copy — never
 * PII, stack traces, or raw domain detail.
 *
 * The component is side-effect-free: it renders sanitized copy only and never
 * reads or mutates application state. The retry control is disabled while a
 * retry is in flight so it can never be double-invoked. Callers may append extra
 * utility classes via `className` without overriding the base styling or
 * accessibility affordances.
 */

import PropTypes from 'prop-types';
import { cn } from '@/shared/ui/cn';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { LoadingIndicator } from '@/shared/ui/LoadingIndicator';

/**
 * Supported async failure kinds surfaced by the alert.
 * @type {{
 *   FAILURE: 'failure',
 *   NETWORK: 'network',
 *   QUOTE_EXPIRED: 'quote_expired',
 *   INVITATION_EXPIRED: 'invitation_expired',
 *   SESSION_TIMEOUT: 'session_timeout',
 *   UNAVAILABLE: 'unavailable',
 *   UNEXPECTED: 'unexpected',
 * }}
 */
export const ASYNC_ALERT_KINDS = Object.freeze({
  FAILURE: 'failure',
  NETWORK: 'network',
  QUOTE_EXPIRED: 'quote_expired',
  INVITATION_EXPIRED: 'invitation_expired',
  SESSION_TIMEOUT: 'session_timeout',
  UNAVAILABLE: 'unavailable',
  UNEXPECTED: 'unexpected',
});

/**
 * Default, sanitized customer copy applied per async failure kind. Copy is
 * demo-safe and never carries raw domain detail or PII.
 * @type {Record<string, { title: string, body: string, severity: string, retryable: boolean }>}
 */
const KIND_DEFAULTS = Object.freeze({
  [ASYNC_ALERT_KINDS.FAILURE]: {
    title: 'Something went wrong',
    body: 'A simulated failure interrupted this action. No changes were saved — you can try again.',
    severity: ALERT_SEVERITIES.CRITICAL,
    retryable: true,
  },
  [ASYNC_ALERT_KINDS.NETWORK]: {
    title: 'Connection interrupted',
    body: 'A simulated network error interrupted this action. No changes were saved — please try again.',
    severity: ALERT_SEVERITIES.WARNING,
    retryable: true,
  },
  [ASYNC_ALERT_KINDS.QUOTE_EXPIRED]: {
    title: 'Quote expired',
    body: 'The FX quote expired before this action completed. Request a fresh quote to continue.',
    severity: ALERT_SEVERITIES.WARNING,
    retryable: true,
  },
  [ASYNC_ALERT_KINDS.INVITATION_EXPIRED]: {
    title: 'Invitation expired',
    body: 'The invitation lapsed before this action completed. Resend a fresh invitation to continue.',
    severity: ALERT_SEVERITIES.WARNING,
    retryable: true,
  },
  [ASYNC_ALERT_KINDS.SESSION_TIMEOUT]: {
    title: 'Session expired',
    body: 'Your demo session timed out due to inactivity. Sign in again to continue.',
    severity: ALERT_SEVERITIES.WARNING,
    retryable: false,
  },
  [ASYNC_ALERT_KINDS.UNAVAILABLE]: {
    title: 'Not available right now',
    body: 'This action is temporarily unavailable in the demo. Wait a moment and try again.',
    severity: ALERT_SEVERITIES.WARNING,
    retryable: true,
  },
  [ASYNC_ALERT_KINDS.UNEXPECTED]: {
    title: 'Something went wrong',
    body: 'An unexpected error interrupted this action. No changes were saved — please try again.',
    severity: ALERT_SEVERITIES.CRITICAL,
    retryable: true,
  },
});

/** Maximum retained length of a sanitized copy string. */
const MAX_COPY_LENGTH = 280;

/** Default label for the retry control. */
const DEFAULT_RETRY_LABEL = 'Try again';

/**
 * Maps a typed payment domain error kind to an async alert kind.
 * @type {Record<string, string>}
 */
const DOMAIN_KIND_MAP = Object.freeze({
  validation: ASYNC_ALERT_KINDS.FAILURE,
  unavailable_scenario: ASYNC_ALERT_KINDS.UNAVAILABLE,
  transient: ASYNC_ALERT_KINDS.NETWORK,
  storage_degraded: ASYNC_ALERT_KINDS.UNAVAILABLE,
  duplicate_reference: ASYNC_ALERT_KINDS.FAILURE,
  unauthorized: ASYNC_ALERT_KINDS.FAILURE,
  unexpected: ASYNC_ALERT_KINDS.UNEXPECTED,
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
 * Normalizes an arbitrary value into a trimmed, length-bounded copy string.
 * @param {unknown} value - The raw copy value.
 * @returns {string} A sanitized copy string (empty when unusable).
 */
function toCopyText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return '';
  }
  return trimmed.length > MAX_COPY_LENGTH ? `${trimmed.slice(0, MAX_COPY_LENGTH)}…` : trimmed;
}

/**
 * Resolves a supported async alert kind, falling back to unexpected.
 * @param {unknown} kind - The candidate kind.
 * @returns {string} A valid kind from {@link ASYNC_ALERT_KINDS}.
 */
function resolveKind(kind) {
  return typeof kind === 'string' &&
    Object.prototype.hasOwnProperty.call(KIND_DEFAULTS, kind)
    ? kind
    : ASYNC_ALERT_KINDS.UNEXPECTED;
}

/**
 * Resolves a supported alert severity, falling back to the kind default.
 * @param {unknown} severity - The candidate severity.
 * @param {string} fallback - The default severity for the resolved kind.
 * @returns {string} A valid severity from {@link ALERT_SEVERITIES}.
 */
function resolveSeverity(severity, fallback) {
  const values = Object.values(ALERT_SEVERITIES);
  return typeof severity === 'string' && values.includes(severity) ? severity : fallback;
}

/**
 * Resolves the effective async alert kind from an explicit prop or a structured
 * error snapshot.
 * @param {string | undefined} kind - The explicit kind prop.
 * @param {Record<string, unknown> | null | undefined} error - The error snapshot.
 * @returns {string} A valid kind from {@link ASYNC_ALERT_KINDS}.
 */
function resolveEffectiveKind(kind, error) {
  if (typeof kind === 'string' && Object.prototype.hasOwnProperty.call(KIND_DEFAULTS, kind)) {
    return kind;
  }
  if (isPlainObject(error) && typeof error.kind === 'string') {
    if (Object.prototype.hasOwnProperty.call(KIND_DEFAULTS, error.kind)) {
      return error.kind;
    }
    if (Object.prototype.hasOwnProperty.call(DOMAIN_KIND_MAP, error.kind)) {
      return DOMAIN_KIND_MAP[error.kind];
    }
  }
  return resolveKind(kind);
}

/**
 * Renders an accessible async error/retry alert.
 *
 * The alert derives its severity and sanitized copy from the resolved failure
 * kind (or a structured error snapshot), applying any explicit `title`, `body`,
 * or `severity` overrides. The retry control is rendered only when the condition
 * is retryable and an `onRetry` handler is supplied, and is disabled while a
 * retry is in flight so it can never be double-invoked. Unknown kinds degrade to
 * an unexpected error so the alert always renders safely.
 *
 * @param {{
 *   kind?: string,
 *   error?: Record<string, unknown> | null,
 *   title?: string,
 *   body?: string,
 *   severity?: string,
 *   retryable?: boolean,
 *   retrying?: boolean,
 *   retryLabel?: string,
 *   onRetry?: () => void,
 *   className?: string,
 * }} props - The async alert props.
 * @returns {React.ReactElement} The async alert element.
 */
export function AsyncAlert({
  kind,
  error,
  title,
  body,
  severity,
  retryable,
  retrying = false,
  retryLabel,
  onRetry,
  className,
}) {
  const source = isPlainObject(error) ? error : null;
  const effectiveKind = resolveEffectiveKind(kind, source);
  const defaults = KIND_DEFAULTS[effectiveKind];

  const customerCopy = source && isPlainObject(source.customerCopy) ? source.customerCopy : {};

  const resolvedTitle =
    toCopyText(title) || toCopyText(customerCopy.title) || defaults.title;
  const resolvedBody =
    toCopyText(body) ||
    toCopyText(customerCopy.body) ||
    toCopyText(source ? source.safeReasonCode : undefined) ||
    defaults.body;
  const resolvedSeverity = resolveSeverity(severity, defaults.severity);

  let resolvedRetryable = defaults.retryable;
  if (typeof retryable === 'boolean') {
    resolvedRetryable = retryable;
  } else if (source && typeof source.retryable === 'boolean') {
    resolvedRetryable = source.retryable;
  }

  const showRetry = resolvedRetryable && typeof onRetry === 'function';
  const retryText = toCopyText(retryLabel) || DEFAULT_RETRY_LABEL;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Alert severity={resolvedSeverity} title={resolvedTitle}>
        {resolvedBody}
      </Alert>
      {showRetry ? (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={retrying === true}
            onClick={onRetry}
          >
            {retryText}
          </Button>
          {retrying === true ? (
            <LoadingIndicator size="sm" label="Retrying…" showLabel />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

AsyncAlert.propTypes = {
  kind: PropTypes.oneOf(Object.values(ASYNC_ALERT_KINDS)),
  error: PropTypes.object,
  title: PropTypes.string,
  body: PropTypes.string,
  severity: PropTypes.oneOf(Object.values(ALERT_SEVERITIES)),
  retryable: PropTypes.bool,
  retrying: PropTypes.bool,
  retryLabel: PropTypes.string,
  onRetry: PropTypes.func,
  className: PropTypes.string,
};

export default AsyncAlert;