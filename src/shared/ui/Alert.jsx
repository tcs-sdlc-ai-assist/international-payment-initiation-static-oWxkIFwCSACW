/**
 * Design-system alert.
 *
 * Alert is a presentational, accessible alert supporting the critical, warning,
 * success, and info severities used across the intl-payment-initiation app. It
 * conveys severity through an icon paired with text — never color alone — so the
 * meaning survives for users who cannot perceive color differences.
 *
 * The component maps each severity to an appropriate ARIA live-region model:
 * critical alerts use `role="alert"` with `aria-live="assertive"` so screen
 * readers announce them immediately, while all other severities use
 * `role="status"` with `aria-live="polite"` for non-urgent announcements.
 *
 * The component is intentionally simple and side-effect-free: it renders
 * sanitized copy only, carries no PII, and never reads or mutates application
 * state. Callers may append extra utility classes via `className` without
 * overriding the base styling or accessibility affordances.
 */

import PropTypes from 'prop-types';
import { cn } from '@/shared/ui/cn';

/**
 * Supported alert severities.
 * @type {{
 *   CRITICAL: 'critical',
 *   WARNING: 'warning',
 *   SUCCESS: 'success',
 *   INFO: 'info',
 * }}
 */
export const ALERT_SEVERITIES = Object.freeze({
  CRITICAL: 'critical',
  WARNING: 'warning',
  SUCCESS: 'success',
  INFO: 'info',
});

/** Base utility classes shared by every alert severity. */
const BASE_CLASSES =
  'flex items-start gap-3 rounded-md border px-4 py-3 text-sm';

/**
 * Severity-specific container utility classes keyed by {@link ALERT_SEVERITIES}.
 * @type {Record<string, string>}
 */
const SEVERITY_CLASSES = Object.freeze({
  [ALERT_SEVERITIES.CRITICAL]: 'border-alert-critical bg-red-50 text-body',
  [ALERT_SEVERITIES.WARNING]: 'border-alert-warning bg-orange-50 text-body',
  [ALERT_SEVERITIES.SUCCESS]: 'border-alert-success bg-green-50 text-body',
  [ALERT_SEVERITIES.INFO]: 'border-alert-info bg-primary-blue-50 text-body',
});

/**
 * Severity-specific icon color utility classes keyed by {@link ALERT_SEVERITIES}.
 * @type {Record<string, string>}
 */
const ICON_CLASSES = Object.freeze({
  [ALERT_SEVERITIES.CRITICAL]: 'text-alert-critical',
  [ALERT_SEVERITIES.WARNING]: 'text-alert-warning',
  [ALERT_SEVERITIES.SUCCESS]: 'text-alert-success',
  [ALERT_SEVERITIES.INFO]: 'text-alert-info',
});

/**
 * Accessible label prefix announced per severity so meaning is conveyed by text.
 * @type {Record<string, string>}
 */
const SEVERITY_LABELS = Object.freeze({
  [ALERT_SEVERITIES.CRITICAL]: 'Error',
  [ALERT_SEVERITIES.WARNING]: 'Warning',
  [ALERT_SEVERITIES.SUCCESS]: 'Success',
  [ALERT_SEVERITIES.INFO]: 'Information',
});

/**
 * Resolves a supported severity, falling back to info.
 * @param {string} severity - The requested severity.
 * @returns {string} A valid severity from {@link ALERT_SEVERITIES}.
 */
function resolveSeverity(severity) {
  return Object.prototype.hasOwnProperty.call(SEVERITY_CLASSES, severity)
    ? severity
    : ALERT_SEVERITIES.INFO;
}

/**
 * Renders the SVG icon path for a given severity.
 * @param {string} severity - A resolved severity.
 * @returns {React.ReactElement} The icon path element(s).
 */
function renderIconPath(severity) {
  switch (severity) {
    case ALERT_SEVERITIES.CRITICAL:
      return (
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM11 6a1 1 0 10-2 0v4a1 1 0 102 0V6zm-1 7a1 1 0 100 2 1 1 0 000-2z"
          clipRule="evenodd"
        />
      );
    case ALERT_SEVERITIES.WARNING:
      return (
        <path
          fillRule="evenodd"
          d="M8.257 3.099c.765-1.36 2.721-1.36 3.486 0l6.518 11.59c.75 1.334-.213 2.98-1.742 2.98H3.48c-1.53 0-2.492-1.646-1.743-2.98L8.257 3.1zM11 13a1 1 0 10-2 0 1 1 0 002 0zm-1-8a1 1 0 00-1 1v3a1 1 0 102 0V6a1 1 0 00-1-1z"
          clipRule="evenodd"
        />
      );
    case ALERT_SEVERITIES.SUCCESS:
      return (
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
          clipRule="evenodd"
        />
      );
    case ALERT_SEVERITIES.INFO:
    default:
      return (
        <path
          fillRule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
          clipRule="evenodd"
        />
      );
  }
}

/**
 * Renders an accessible design-system alert.
 *
 * Severity is conveyed through both an icon and a visible severity label so the
 * meaning never relies on color alone. Critical alerts announce assertively;
 * all other severities announce politely. Unknown severities degrade to info so
 * the alert always renders safely.
 *
 * @param {{
 *   children?: React.ReactNode,
 *   severity?: string,
 *   title?: string,
 *   className?: string,
 * }} props - The alert props.
 * @returns {React.ReactElement} The alert element.
 */
export function Alert({ children, severity = ALERT_SEVERITIES.INFO, title, className }) {
  const resolvedSeverity = resolveSeverity(severity);
  const isCritical = resolvedSeverity === ALERT_SEVERITIES.CRITICAL;
  const severityLabel = SEVERITY_LABELS[resolvedSeverity];

  return (
    <div
      role={isCritical ? 'alert' : 'status'}
      aria-live={isCritical ? 'assertive' : 'polite'}
      className={cn(BASE_CLASSES, SEVERITY_CLASSES[resolvedSeverity], className)}
    >
      <svg
        className={cn('mt-0.5 h-5 w-5 flex-shrink-0', ICON_CLASSES[resolvedSeverity])}
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        {renderIconPath(resolvedSeverity)}
      </svg>
      <div className="flex flex-col gap-0.5">
        <span className="sr-only">{`${severityLabel}: `}</span>
        {title ? <span className="font-medium text-body">{title}</span> : null}
        {children ? <span className="text-body">{children}</span> : null}
      </div>
    </div>
  );
}

Alert.propTypes = {
  children: PropTypes.node,
  severity: PropTypes.oneOf(Object.values(ALERT_SEVERITIES)),
  title: PropTypes.string,
  className: PropTypes.string,
};

export default Alert;