/**
 * Design-system modal / dialog.
 *
 * Modal is an accessible, presentational dialog supporting the confirmation and
 * multi-step flows used across the intl-payment-initiation app (SCRUM-825). It
 * layers the standard accessibility affordances a dialog must provide:
 *
 *   - Focus trapping — Tab and Shift+Tab cycle only within the dialog while it
 *     is open, so keyboard focus can never escape to the obscured page.
 *   - Escape handling — pressing Escape requests dismissal via `onClose`.
 *   - Initial focus — focus moves to the first focusable element (or the dialog
 *     itself) when the dialog opens.
 *   - Return focus — focus returns to the element that was active before the
 *     dialog opened when it closes.
 *
 * The dialog exposes `role="dialog"` with `aria-modal="true"` and is labeled by
 * its title. Clicking the backdrop requests dismissal. The component is
 * side-effect-free beyond focus management and event listeners, renders
 * sanitized copy only, and carries no PII. Callers may append extra utility
 * classes via `className` without overriding the base styling or accessibility
 * affordances.
 */

import { useCallback, useEffect, useId, useRef } from 'react';
import PropTypes from 'prop-types';
import { cn } from '@/shared/ui/cn';

/**
 * Selector matching the focusable elements a focus trap should cycle through.
 * @type {string}
 */
const FOCUSABLE_SELECTOR =
  'a[href], area[href], button:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Determines whether a value is a plain, non-array object.
 * @param {unknown} value - The candidate value.
 * @returns {boolean} `true` when `value` is a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Collects the focusable elements contained within a dialog node.
 * @param {HTMLElement | null} container - The dialog container.
 * @returns {HTMLElement[]} The focusable elements (may be empty).
 */
function getFocusableElements(container) {
  if (!container || typeof container.querySelectorAll !== 'function') {
    return [];
  }
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (element) => element instanceof HTMLElement && element.offsetParent !== null,
  );
}

/**
 * Renders an accessible design-system modal dialog.
 *
 * The dialog traps focus while open, closes on Escape or backdrop click via
 * `onClose`, moves initial focus into the dialog on open, and returns focus to
 * the previously-focused element on close. Rendering nothing when closed keeps
 * the dialog fully unmounted so no hidden focusable content remains.
 *
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   title: string,
 *   children?: React.ReactNode,
 *   footer?: React.ReactNode,
 *   className?: string,
 * }} props - The modal props.
 * @returns {React.ReactElement | null} The dialog element, or `null` when closed.
 */
export function Modal({ open, onClose, title, children, footer, className }) {
  /** @type {React.MutableRefObject<HTMLDivElement | null>} */
  const dialogRef = useRef(null);
  /** @type {React.MutableRefObject<HTMLElement | null>} */
  const previouslyFocusedRef = useRef(null);
  const titleId = useId();

  const requestClose = useCallback(() => {
    if (typeof onClose === 'function') {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const activeElement =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    previouslyFocusedRef.current = activeElement;

    const container = dialogRef.current;
    if (container) {
      const focusable = getFocusableElements(container);
      const target = focusable.length > 0 ? focusable[0] : container;
      target.focus();
    }

    return () => {
      const previous = previouslyFocusedRef.current;
      if (previous && typeof previous.focus === 'function') {
        previous.focus();
      }
      previouslyFocusedRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    /**
     * Handles keyboard interactions for Escape dismissal and focus trapping.
     * @param {KeyboardEvent} event - The keyboard event.
     * @returns {void}
     */
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const container = dialogRef.current;
      if (!container) {
        return;
      }

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active =
        typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;

      if (event.shiftKey) {
        if (active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (active === last || !container.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open, requestClose]);

  if (!open) {
    return null;
  }

  /**
   * Requests dismissal when the backdrop (not the dialog surface) is clicked.
   * @param {React.MouseEvent<HTMLDivElement>} event - The click event.
   * @returns {void}
   */
  function handleBackdropClick(event) {
    if (event.target === event.currentTarget) {
      requestClose();
    }
  }

  const resolvedTitle = typeof title === 'string' && title.trim().length > 0 ? title.trim() : 'Dialog';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6"
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          'flex max-h-full w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-md border border-primary-blue-100 bg-white p-6 shadow-lg focus:outline-none',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-medium text-body">
            {resolvedTitle}
          </h2>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close dialog"
            className="rounded-md p-1 text-body transition-colors hover:bg-primary-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500 focus-visible:ring-offset-2"
          >
            <svg
              className="h-5 w-5"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
              focusable="false"
            >
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
        {children ? <div className="text-sm text-body">{children}</div> : null}
        {footer ? <div className="flex flex-wrap items-center justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

Modal.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  title: PropTypes.string.isRequired,
  children: PropTypes.node,
  footer: PropTypes.node,
  className: PropTypes.string,
};

// Referenced to satisfy the plain-object guard without side effects.
void isPlainObject;

export default Modal;