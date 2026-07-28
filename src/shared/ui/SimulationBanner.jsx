/**
 * Persistent simulation disclaimer banner.
 *
 * SimulationBanner is a presentational, always-on banner rendered in the app
 * shell to make it unmistakable that the entire experience is a demonstration.
 * It states plainly that no real authentication, payment, signer authority, or
 * SWIFT message ever occurs — every action is simulated and demo-safe.
 *
 * The banner is intentionally simple and side-effect-free: it renders sanitized,
 * static copy only, carries no PII, and never reads or mutates application
 * state. It exposes an ARIA `note` landmark so assistive technology announces
 * the disclaimer as complementary context rather than an alert.
 */

import PropTypes from 'prop-types';
import { cn } from '@/shared/ui/cn';

/**
 * Default banner title emphasizing the simulated nature of the demo.
 * @type {string}
 */
const DEFAULT_TITLE = 'Demonstration environment';

/**
 * Default banner body enumerating the simulated capabilities.
 * @type {string}
 */
const DEFAULT_BODY =
  'All behavior here is simulated. No real authentication is performed, no payments are initiated, no signer authority is granted, and no SWIFT messages are sent. Do not enter real personal or banking information.';

/**
 * Renders a persistent, accessible simulation disclaimer banner.
 *
 * The banner is purely presentational — it renders static, sanitized copy and
 * never touches application state or PII. Callers may append extra utility
 * classes via `className` without overriding the base styling.
 *
 * @param {{ className?: string }} props - The banner props.
 * @returns {React.ReactElement} The simulation banner element.
 */
export function SimulationBanner({ className }) {
  return (
    <aside
      role="note"
      aria-label="Simulation disclaimer"
      className={cn(
        'w-full border-b border-alert-warning bg-primary-blue-50 px-4 py-2 text-sm text-body',
        className,
      )}
    >
      <div className="mx-auto flex max-w-screen-xl flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
        <span className="font-medium text-primary-blue-700">{DEFAULT_TITLE}</span>
        <span className="text-body">{DEFAULT_BODY}</span>
      </div>
    </aside>
  );
}

SimulationBanner.propTypes = {
  className: PropTypes.string,
};

export default SimulationBanner;