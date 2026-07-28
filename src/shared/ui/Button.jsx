/**
 * Design-system button.
 *
 * Button is a presentational, accessible button supporting the primary,
 * secondary, and danger variants used across the intl-payment-initiation app.
 * It composes Tailwind design tokens (brand blue for primary, alert red for
 * danger) with consistent focus rings, disabled styling, and full-width layout
 * so calls to action stay visually and behaviorally consistent.
 *
 * The component is intentionally simple and side-effect-free: it forwards its
 * `type`, `onClick`, and any extra props to the native `<button>` element,
 * merges caller-supplied utility classes over the base styling, and never reads
 * or mutates application state.
 */

import PropTypes from 'prop-types';
import { cn } from '@/shared/ui/cn';

/**
 * Supported button variants.
 * @type {{ PRIMARY: 'primary', SECONDARY: 'secondary', DANGER: 'danger' }}
 */
export const BUTTON_VARIANTS = Object.freeze({
  PRIMARY: 'primary',
  SECONDARY: 'secondary',
  DANGER: 'danger',
});

/**
 * Supported button sizes.
 * @type {{ SM: 'sm', MD: 'md', LG: 'lg' }}
 */
export const BUTTON_SIZES = Object.freeze({
  SM: 'sm',
  MD: 'md',
  LG: 'lg',
});

/** Base utility classes shared by every button variant and size. */
const BASE_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors ' +
  'focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Variant-specific utility classes keyed by {@link BUTTON_VARIANTS}.
 * @type {Record<string, string>}
 */
const VARIANT_CLASSES = Object.freeze({
  [BUTTON_VARIANTS.PRIMARY]:
    'bg-primary-blue-500 text-white hover:bg-primary-blue-600 ' +
    'focus-visible:ring-primary-blue-500 disabled:hover:bg-primary-blue-500',
  [BUTTON_VARIANTS.SECONDARY]:
    'border border-primary-blue-500 bg-white text-primary-blue-700 hover:bg-primary-blue-50 ' +
    'focus-visible:ring-primary-blue-500 disabled:hover:bg-white',
  [BUTTON_VARIANTS.DANGER]:
    'bg-alert-critical text-white hover:bg-red-700 ' +
    'focus-visible:ring-alert-critical disabled:hover:bg-alert-critical',
});

/**
 * Size-specific utility classes keyed by {@link BUTTON_SIZES}.
 * @type {Record<string, string>}
 */
const SIZE_CLASSES = Object.freeze({
  [BUTTON_SIZES.SM]: 'px-3 py-1.5 text-sm',
  [BUTTON_SIZES.MD]: 'px-4 py-2 text-base',
  [BUTTON_SIZES.LG]: 'px-6 py-3 text-lg',
});

/**
 * Resolves a supported variant, falling back to primary.
 * @param {string} variant - The requested variant.
 * @returns {string} A valid variant from {@link BUTTON_VARIANTS}.
 */
function resolveVariant(variant) {
  return Object.prototype.hasOwnProperty.call(VARIANT_CLASSES, variant)
    ? variant
    : BUTTON_VARIANTS.PRIMARY;
}

/**
 * Resolves a supported size, falling back to medium.
 * @param {string} size - The requested size.
 * @returns {string} A valid size from {@link BUTTON_SIZES}.
 */
function resolveSize(size) {
  return Object.prototype.hasOwnProperty.call(SIZE_CLASSES, size)
    ? size
    : BUTTON_SIZES.MD;
}

/**
 * Renders an accessible design-system button.
 *
 * The button is purely presentational — it forwards its interaction props to
 * the native element and merges caller-supplied classes over the base styling
 * without overriding accessibility affordances. Unknown variants and sizes
 * degrade to sensible defaults so the button always renders safely.
 *
 * @param {{
 *   children: React.ReactNode,
 *   type?: 'button' | 'submit' | 'reset',
 *   variant?: string,
 *   size?: string,
 *   disabled?: boolean,
 *   fullWidth?: boolean,
 *   onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void,
 *   className?: string,
 * }} props - The button props.
 * @returns {React.ReactElement} The button element.
 */
export function Button({
  children,
  type = 'button',
  variant = BUTTON_VARIANTS.PRIMARY,
  size = BUTTON_SIZES.MD,
  disabled = false,
  fullWidth = false,
  onClick,
  className,
  ...rest
}) {
  const resolvedVariant = resolveVariant(variant);
  const resolvedSize = resolveSize(size);

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        BASE_CLASSES,
        VARIANT_CLASSES[resolvedVariant],
        SIZE_CLASSES[resolvedSize],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

Button.propTypes = {
  children: PropTypes.node,
  type: PropTypes.oneOf(['button', 'submit', 'reset']),
  variant: PropTypes.oneOf(Object.values(BUTTON_VARIANTS)),
  size: PropTypes.oneOf(Object.values(BUTTON_SIZES)),
  disabled: PropTypes.bool,
  fullWidth: PropTypes.bool,
  onClick: PropTypes.func,
  className: PropTypes.string,
};

export default Button;