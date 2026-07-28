/**
 * Unauthorized state page.
 *
 * UnauthorizedPage is the accessible landing surface shown when an authenticated
 * session attempts to reach a route it does not hold the required capability for
 * (SCRUM-823). It complements the {@link RouteGuard}'s inline unauthorized state
 * by offering a full-page explanation that the gating is a client-side
 * demonstration control — deny-by-default and non-regulatory — and a link back
 * to a route the session can actually see (its capability-derived default
 * route).
 *
 * The page derives its safe landing target from the {@link useAccessContext}
 * `defaultRoute`, falling back to the site root when none resolves. It renders
 * only sanitized, static copy, carries no PII beyond the sanitized session
 * identity it never displays, and never mutates application state.
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAccessContext } from '@/app/useAccessContext';
import { SimulationBanner } from '@/shared/ui/SimulationBanner';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { cn } from '@/shared/ui/cn';

/** Fallback route used when no capability-derived default route resolves. */
const FALLBACK_ROUTE = '/';

/** Default title rendered for the unauthorized state. */
const UNAUTHORIZED_TITLE = 'Access denied';

/** Default body rendered for the unauthorized state. */
const UNAUTHORIZED_BODY =
  'Your current role does not hold the capability required for this page. Access is denied by default in this demonstration and enforced entirely client-side — it is not a server guarantee. Switch to a role that grants the capability, or return to a page you can access.';

/**
 * Normalizes an arbitrary value into a trimmed string.
 * @param {unknown} value - The raw value.
 * @returns {string} A trimmed string (empty when unusable).
 */
function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Renders the accessible unauthorized state page.
 *
 * The page explains the client-side, deny-by-default nature of the demo's
 * capability gating and links the user back to their capability-derived default
 * route (or the site root when none resolves). It is presentational and
 * side-effect-free: it renders sanitized copy only and never mutates state.
 *
 * @returns {React.ReactElement} The unauthorized page element.
 */
export function UnauthorizedPage() {
  const { defaultRoute } = useAccessContext();

  const targetRoute = useMemo(() => {
    const resolved = toText(defaultRoute);
    return resolved.length > 0 ? resolved : FALLBACK_ROUTE;
  }, [defaultRoute]);

  return (
    <div className="flex min-h-screen flex-col bg-white text-body">
      <SimulationBanner />

      <main
        id="main-content"
        role="main"
        className="mx-auto flex w-full max-w-screen-md flex-1 flex-col gap-6 px-4 py-8"
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-medium text-primary-blue-700">
            International Payment Initiation
          </h1>
          <p className="text-sm text-body">
            This is a demonstration environment. Access controls here are simulated and enforced
            client-side only.
          </p>
        </div>

        <Alert severity={ALERT_SEVERITIES.CRITICAL} title={UNAUTHORIZED_TITLE}>
          {UNAUTHORIZED_BODY}
        </Alert>

        <div className="flex flex-col gap-3 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-6">
          <h2 className="text-lg font-medium text-body">Return to an available page</h2>
          <p className="text-sm text-body">
            You can continue exploring the demo from a page your current role is entitled to see.
          </p>
          <Link
            to={targetRoute}
            className={cn(
              'inline-flex w-fit items-center justify-center rounded-md bg-primary-blue-500 px-4 py-2 text-base font-medium text-white transition-colors',
              'hover:bg-primary-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500 focus-visible:ring-offset-2',
            )}
          >
            Go to your landing page
          </Link>
        </div>
      </main>
    </div>
  );
}

export default UnauthorizedPage;