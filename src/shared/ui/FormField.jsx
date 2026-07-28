/**
 * Design-system form field wrapper.
 *
 * FormField is an accessible, presentational wrapper that composes a labeled
 * form control with the ARIA affordances a form field must provide for the
 * payment initiation and signer entitlement flows (SCRUM-817/825). It renders:
 *
 *   - A `<label>` associated with the control via a stable, generated id.
 *   - A required indicator (both visually and for assistive technology) when
 *     the field is required.
 *   - Optional help text and a sanitized error message, each linked to the
 *     control via `aria-describedby` so screen readers announce them.
 *   - `aria-invalid` on the control when an error is present.
 *
 * FormField uses a render-prop child so callers (typically React Hook Form
 * fields) receive the resolved `id`, `aria-invalid`, `aria-describedby`, and
 * `aria-required` values to spread onto their control. The component is
 * side-effect-free, renders sanitized copy only, carries no PII, and never
 * reads or mutates application state. Callers may append extra utility classes
 * via `className` without overriding the base styling or accessibility
 * affordances.
 */

import { useId } from 'react';
import PropTypes from 'prop-types';
import { cn } from '@/shared/ui/cn';

/**
 * Normalizes an arbitrary value into a trimmed string.
 * @param {unknown} value - The raw value.
 * @returns {string} A trimmed string (empty when unusable).
 */
function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Renders an accessible design-system form field wrapper.
 *
 * The child is a render prop invoked with the resolved control attributes so it
 * can spread them onto its input/select/textarea. When an error is present the
 * control is marked invalid and the error is announced via a linked live
 * region; help text is linked via `aria-describedby` regardless of error state.
 *
 * @param {{
 *   label: string,
 *   children: (attrs: {
 *     id: string,
 *     'aria-invalid': boolean,
 *     'aria-describedby': string | undefined,
 *     'aria-required': boolean,
 *   }) => React.ReactNode,
 *   id?: string,
 *   required?: boolean,
 *   error?: string,
 *   helpText?: string,
 *   className?: string,
 * }} props - The form field props.
 * @returns {React.ReactElement} The form field element.
 */
export function FormField({ label, children, id, required = false, error, helpText, className }) {
  const generatedId = useId();
  const fieldId = toText(id).length > 0 ? toText(id) : generatedId;
  const errorId = `${fieldId}-error`;
  const helpId = `${fieldId}-help`;

  const errorText = toText(error);
  const helpValue = toText(helpText);
  const hasError = errorText.length > 0;
  const hasHelp = helpValue.length > 0;

  const describedBy = [hasHelp ? helpId : null, hasError ? errorId : null]
    .filter((value) => value !== null)
    .join(' ');

  const controlAttrs = {
    id: fieldId,
    'aria-invalid': hasError,
    'aria-describedby': describedBy.length > 0 ? describedBy : undefined,
    'aria-required': required === true,
  };

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={fieldId} className="text-sm font-medium text-body">
        {label}
        {required ? (
          <span className="ml-1 text-alert-critical">
            <span aria-hidden="true">*</span>
            <span className="sr-only"> (required)</span>
          </span>
        ) : null}
      </label>
      {hasHelp ? (
        <span id={helpId} className="text-xs text-body">
          {helpValue}
        </span>
      ) : null}
      {typeof children === 'function' ? children(controlAttrs) : null}
      {hasError ? (
        <span id={errorId} role="alert" className="text-xs font-medium text-alert-critical">
          {errorText}
        </span>
      ) : null}
    </div>
  );
}

FormField.propTypes = {
  label: PropTypes.string.isRequired,
  children: PropTypes.func.isRequired,
  id: PropTypes.string,
  required: PropTypes.bool,
  error: PropTypes.string,
  helpText: PropTypes.string,
  className: PropTypes.string,
};

export default FormField;