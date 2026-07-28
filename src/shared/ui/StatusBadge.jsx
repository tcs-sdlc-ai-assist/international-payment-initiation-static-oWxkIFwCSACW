/**
 * Design-system status badge.
 *
 * StatusBadge is a presentational, accessible badge that conveys lifecycle,
 * signer, and invitation states used across the intl-payment-initiation app
 * (SCRUM-818/824). Meaning is always carried by both an icon and text — never by
 * color alone — so the state survives for users who cannot perceive color
 * differences.
 *
 * Each badge maps to a semantic tone (neutral, info, success, warning, or
 * critical) driving both its container styling and its paired icon. Unknown
 * tones degrade to neutral so the badge always renders safely. The component is
 * side-effect-free: it renders sanitized copy only, carries no PII, and never
 * reads or mutates application state. Callers may append extra utility classes
 * via `className` without overriding the base styling or accessibility
 * affordances.
 */

import PropTypes from 'prop-types';
import { cn } from '@/shared/ui/cn';

/**
 * Supported badge tones.
 * @type {{
 *   NEUTRAL: 'neutral',
 *   INFO: 'info',
 *   SUCCESS: 'success',
 *   WARNING: 'warning',
 *   CRITICAL: 'critical',
 * }}
 */
export const STATUS_TONES = Object.freeze({
  NEUTRAL: 'neutral',
  INFO: 'info',
  SUCCESS: 'success',
  WARNING: 'warning',
  CRITICAL: 'critical',
});

/** Base utility classes shared by every badge tone. */
const BASE_CLASSES =
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium';

/**
 * Tone-specific container utility classes keyed by {@link STATUS_TONES}.
 * @type {Record<string, string>}
 */
const TONE_CLASSES = Object.freeze({
  [STATUS_TONES.NEUTRAL]: 'border-primary-blue-200 bg-primary-blue-50 text-body',
  [STATUS_TONES.INFO]: 'border-alert-info bg-primary-blue-50 text-body',
  [STATUS_TONES.SUCCESS]: 'border-alert-success bg-green-50 text-body',
  [STATUS_TONES.WARNING]: 'border-alert-warning bg-orange-50 text-body',
  [STATUS_TONES.CRITICAL]: 'border-alert-critical bg-red-50 text-body',
});

/**
 * Tone-specific icon color utility classes keyed by {@link STATUS_TONES}.
 * @type {Record<string, string>}
 */
const ICON_CLASSES = Object.freeze({
  [STATUS_TONES.NEUTRAL]: 'text-primary-blue-500',
  [STATUS_TONES.INFO]: 'text-alert-info',
  [STATUS_TONES.SUCCESS]: 'text-alert-success',
  [STATUS_TONES.WARNING]: 'text-alert-warning',
  [STATUS_TONES.CRITICAL]: 'text-alert-critical',
});

/**
 * Accessible tone description announced so meaning is conveyed by text.
 * @type {Record<string, string>}
 */
const TONE_LABELS = Object.freeze({
  [STATUS_TONES.NEUTRAL]: 'Status',
  [STATUS_TONES.INFO]: 'Status',
  [STATUS_TONES.SUCCESS]: 'Success status',
  [STATUS_TONES.WARNING]: 'Warning status',
  [STATUS_TONES.CRITICAL]: 'Critical status',
});

/**
 * Normalizes an arbitrary value into a trimmed string.
 * @param {unknown} value - The raw value.
 * @returns {string} A trimmed string (empty when unusable).
 */
function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolves a supported tone, falling back to neutral.
 * @param {string} tone - The requested tone.
 * @returns {string} A valid tone from {@link STATUS_TONES}.
 */
function resolveTone(tone) {
  return Object.prototype.hasOwnProperty.call(TONE_CLASSES, tone)
    ? tone
    : STATUS_TONES.NEUTRAL;
}

/**
 * Renders the SVG icon path for a given tone.
 * @param {string} tone - A resolved tone.
 * @returns {React.ReactElement} The icon path element(s).
 */
function renderIconPath(tone) {
  switch (tone) {
    case STATUS_TONES.SUCCESS:
      return (
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
          clipRule="evenodd"
        />
      );
    case STATUS_TONES.WARNING:
      return (
        <path
          fillRule="evenodd"
          d="M8.257 3.099c.765-1.36 2.721-1.36 3.486 0l6.518 11.59c.75 1.334-.213 2.98-1.742 2.98H3.48c-1.53 0-2.492-1.646-1.743-2.98L8.257 3.1zM11 13a1 1 0 10-2 0 1 1 0 002 0zm-1-8a1 1 0 00-1 1v3a1 1 0 102 0V6a1 1 0 00-1-1z"
          clipRule="evenodd"
        />
      );
    case STATUS_TONES.CRITICAL:
      return (
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM11 6a1 1 0 10-2 0v4a1 1 0 102 0V6zm-1 7a1 1 0 100 2 1 1 0 000-2z"
          clipRule="evenodd"
        />
      );
    case STATUS_TONES.INFO:
      return (
        <path
          fillRule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
          clipRule="evenodd"
        />
      );
    case STATUS_TONES.NEUTRAL:
    default:
      return (
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM4 10a6 6 0 1112 0 6 6 0 01-12 0z"
          clipRule="evenodd"
        />
      );
  }
}

/**
 * Renders an accessible design-system status badge.
 *
 * The badge conveys its state through both an icon and its visible label so the
 * meaning never relies on color alone; a visually-hidden tone description gives
 * assistive technology additional context. Unknown tones degrade to neutral so
 * the badge always renders safely.
 *
 * @param {{
 *   children: React.ReactNode,
 *   tone?: string,
 *   className?: string,
 * }} props - The status badge props.
 * @returns {React.ReactElement} The status badge element.
 */
export function StatusBadge({ children, tone = STATUS_TONES.NEUTRAL, className }) {
  const resolvedTone = resolveTone(tone);
  const toneLabel = TONE_LABELS[resolvedTone];
  const label = toText(children);

  return (
    <span
      className={cn(BASE_CLASSES, TONE_CLASSES[resolvedTone], className)}
    >
      <svg
        className={cn('h-3.5 w-3.5 flex-shrink-0', ICON_CLASSES[resolvedTone])}
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        {renderIconPath(resolvedTone)}
      </svg>
      <span className="sr-only">{`${toneLabel}: `}</span>
      <span>{label.length > 0 ? label : children}</span>
    </span>
  );
}

StatusBadge.propTypes = {
  children: PropTypes.node,
  tone: PropTypes.oneOf(Object.values(STATUS_TONES)),
  className: PropTypes.string,
};

export default StatusBadge;