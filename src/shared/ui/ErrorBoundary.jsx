/**
 * React error boundary.
 *
 * ErrorBoundary is a class component that catches render-time faults anywhere in
 * its subtree so a single failing feature can never replace the whole app shell
 * with a blank screen (SCRUM-821). It supports both top-level and feature-level
 * placement:
 *
 *   - At the top level it wraps the shell, surfacing a safe fallback with a
 *     reload action when an unexpected render fault occurs.
 *   - At the feature level it isolates a single scenario, offering a reset
 *     action that clears the caught error and re-attempts to render the children
 *     without reloading the whole page.
 *
 * The boundary never leaks raw error internals: it renders only sanitized,
 * customer-safe copy and routes the underlying fault through the sanitized
 * {@link safeLogger}. Callers may supply a `fallback` render function to
 * customize the recovery UI, an `onReset` callback to coordinate feature-level
 * recovery, and a `title`/`description` to tailor the default copy. Extra
 * utility classes may be appended via `className` without overriding the base
 * styling or accessibility affordances.
 */

import { Component } from 'react';
import PropTypes from 'prop-types';
import { cn } from '@/shared/ui/cn';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default fallback title rendered when a render fault is caught. */
const DEFAULT_TITLE = 'Something went wrong';

/** Default fallback description rendered when a render fault is caught. */
const DEFAULT_DESCRIPTION =
  'An unexpected error interrupted this part of the demo. No changes were saved — you can try again or reload the page.';

/**
 * A top-level and feature-level React error boundary.
 */
export class ErrorBoundary extends Component {
  /**
   * @param {{
   *   children?: React.ReactNode,
   *   fallback?: (state: { reset: () => void, reload: () => void }) => React.ReactNode,
   *   onReset?: () => void,
   *   title?: string,
   *   description?: string,
   *   className?: string,
   * }} props - The error boundary props.
   */
  constructor(props) {
    super(props);
    /** @type {{ hasError: boolean }} */
    this.state = { hasError: false };
    this.handleReset = this.handleReset.bind(this);
    this.handleReload = this.handleReload.bind(this);
  }

  /**
   * Derives the next error state when a descendant throws during render.
   * @param {unknown} error - The thrown value.
   * @returns {{ hasError: boolean }} The next state.
   */
  static getDerivedStateFromError() {
    return { hasError: true };
  }

  /**
   * Logs a sanitized diagnostic for a caught render fault. Never surfaces raw
   * error internals or stack traces to the UI.
   * @param {unknown} error - The thrown value.
   * @returns {void}
   */
  componentDidCatch(error) {
    safeLogger.error('ErrorBoundary: caught render fault', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }

  /**
   * Clears the caught error and re-attempts to render the children, invoking
   * the optional `onReset` callback so callers can coordinate recovery.
   * @returns {void}
   */
  handleReset() {
    const { onReset } = this.props;
    if (typeof onReset === 'function') {
      try {
        onReset();
      } catch (error) {
        safeLogger.warn('ErrorBoundary: onReset handler threw during reset', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
    this.setState({ hasError: false });
  }

  /**
   * Reloads the page to recover the whole shell from an unexpected fault.
   * @returns {void}
   */
  handleReload() {
    try {
      if (typeof globalThis !== 'undefined' && globalThis.location) {
        globalThis.location.reload();
      }
    } catch (error) {
      safeLogger.warn('ErrorBoundary: failed to reload the page', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  /**
   * Renders the children, or a safe fallback when a render fault was caught.
   * @returns {React.ReactNode} The rendered content.
   */
  render() {
    const { children, fallback, title, description, className } = this.props;

    if (!this.state.hasError) {
      return children;
    }

    if (typeof fallback === 'function') {
      return fallback({ reset: this.handleReset, reload: this.handleReload });
    }

    const resolvedTitle =
      typeof title === 'string' && title.trim().length > 0 ? title.trim() : DEFAULT_TITLE;
    const resolvedDescription =
      typeof description === 'string' && description.trim().length > 0
        ? description.trim()
        : DEFAULT_DESCRIPTION;

    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <Alert severity={ALERT_SEVERITIES.CRITICAL} title={resolvedTitle}>
          {resolvedDescription}
        </Alert>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={this.handleReset}>
            Try again
          </Button>
          <Button type="button" variant="primary" size="sm" onClick={this.handleReload}>
            Reload page
          </Button>
        </div>
      </div>
    );
  }
}

ErrorBoundary.propTypes = {
  children: PropTypes.node,
  fallback: PropTypes.func,
  onReset: PropTypes.func,
  title: PropTypes.string,
  description: PropTypes.string,
  className: PropTypes.string,
};

export default ErrorBoundary;