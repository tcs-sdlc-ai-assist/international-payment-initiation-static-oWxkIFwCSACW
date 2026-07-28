/**
 * Design-system loading indicator.
 *
 * LoadingIndicator is a presentational, accessible spinner paired with a live
 * region so the simulated async states across the intl-payment-initiation app
 * (quote requests, beneficiary validation, eSign ceremonies) are announced to
 * assistive technology. Meaning is conveyed by text — never by the spinner
 * alone — so users who cannot perceive the animation still learn the app is
 * busy.
 *
 * The component exposes `role="status"` with `aria-live="polite"` so the
 * accompanying label is announced without interrupting the user, and marks the
 * decorative spinner `aria-hidden` so it is never double-announced. It is
 * side-effect-free: it renders sanitized copy only, carries no PII, and never
 * reads or mutates application state. Callers may append extra utility classes
 * via `className` without overriding the base styling or accessibility
 * affordances.
 */

import PropTypes from 'prop-types';
import { cn } from '@/shared/ui/cn';

/**
 * Supported loading indicator sizes.
 * @type {{ SM: 'sm', MD: 'md', LG: 'lg' }}
 */
export const LOADING_SIZES = Object.freeze({
  SM: 'sm',
  MD: 'md',
  LG: 'lg',
});

/** Default label announced when none is supplied. */
const DEFAULT_LABEL = 'Loading…';

/**
 * Size-specific spinner utility classes keyed by {@link LOADING_SIZES}.
 * @type {Record<string, string>}
 */
const SPINNER_SIZE_CLASSES = Object.freeze({
  [LOADING_SIZES.SM]: 'h-4 w-4 border-2',
  [LOADING_SIZES.MD]: 'h-6 w-6 border-2',
  [LOADING_SIZES.LG]: 'h-8 w-8 border-[3px]',
});

/**
 * Size-specific label text utility classes keyed by {@link LOADING_SIZES}.
 * @type {Record<string, string>}
 */
const LABEL_SIZE_CLASSES = Object.freeze({
  [LOADING_SIZES.SM]: 'text-xs',
  [LOADING_SIZES.MD]: 'text-sm',
  [LOADING_SIZES.LG]: 'text-base',
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
 * Resolves a supported size, falling back to medium.
 * @param {string} size - The requested size.
 * @returns {string} A valid size from {@link LOADING_SIZES}.
 */
function resolveSize(size) {
  return Object.prototype.hasOwnProperty.call(SPINNER_SIZE_CLASSES, size)
    ? size
    : LOADING_SIZES.MD;
}

/**
 * Renders an accessible design-system loading indicator.
 *
 * The indicator announces its label through a polite live region so screen
 * readers convey the busy state without interrupting the user; the animated
 * spinner is decorative and hidden from assistive technology. When `showLabel`
 * is false the label is still announced via a visually-hidden node so the
 * meaning is never lost. Unknown sizes degrade to medium so the indicator
 * always renders safely.
 *
 * @param {{
 *   label?: string,
 *   size?: string,
 *   showLabel?: boolean,
 *   className?: string,
 * }} props - The loading indicator props.
 * @returns {React.ReactElement} The loading indicator element.
 */
export function LoadingIndicator({
  label,
  size = LOADING_SIZES.MD,
  showLabel = true,
  className,
}) {
  const resolvedSize = resolveSize(size);
  const labelText = toText(label).length > 0 ? toText(label) : DEFAULT_LABEL;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('inline-flex items-center gap-2 text-body', className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block flex-shrink-0 animate-spin rounded-full border-solid border-primary-blue-100 border-t-primary-blue-500',
          SPINNER_SIZE_CLASSES[resolvedSize],
        )}
      />
      {showLabel ? (
        <span className={cn('text-body', LABEL_SIZE_CLASSES[resolvedSize])}>{labelText}</span>
      ) : (
        <span className="sr-only">{labelText}</span>
      )}
    </div>
  );
}

LoadingIndicator.propTypes = {
  label: PropTypes.string,
  size: PropTypes.oneOf(Object.values(LOADING_SIZES)),
  showLabel: PropTypes.bool,
  className: PropTypes.string,
};

export default LoadingIndicator;