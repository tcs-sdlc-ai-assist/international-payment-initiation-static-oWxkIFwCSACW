/**
 * Capability-based route guard.
 *
 * RouteGuard (RequireCapability) gates a protected route by first checking that
 * the acting session is authenticated and then verifying that it holds every
 * required capability before mounting the guarded element (SCRUM-823). It layers
 * atop the {@link useAccessContext} session/entitlement context so its decision
 * derives from the same deny-by-default {@link authorizationPolicy} that drives
 * navigation and menu visibility:
 *
 *   - An unauthenticated session is redirected to the login route, preserving
 *     the attempted location so callers can return the user afterwards.
 *   - An authenticated session that lacks one or more required capabilities is
 *     shown an accessible unauthorized state rather than the protected content,
 *     so protected content is never briefly flashed.
 *   - When every required capability is held, the guarded element (or nested
 *     route via `<Outlet />`) is rendered.
 *
 * The guard is presentational and side-effect-free beyond navigation: it renders
 * only sanitized copy, carries no PII, and never mutates application state.
 */

import { Navigate, Outlet, useLocation } from 'react-router-dom';
import PropTypes from 'prop-types';
import { useAccessContext } from '@/app/useAccessContext';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';

/** Default route users are redirected to when unauthenticated. */
const DEFAULT_LOGIN_ROUTE = '/login';

/** Default title rendered when the session lacks a required capability. */
const DEFAULT_UNAUTHORIZED_TITLE = 'Access denied';

/** Default body rendered when the session lacks a required capability. */
const DEFAULT_UNAUTHORIZED_BODY =
  'Your current role does not hold the capability required for this page. Switch to a role that grants it and try again.';

/**
 * Normalizes a value into a string array, dropping non-string entries.
 * @param {unknown} value - The candidate value.
 * @returns {string[]} A safe array of strings (may be empty).
 */
function toCapabilityList(value) {
  if (typeof value === 'string' && value.length > 0) {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === 'string' && item.length > 0);
}

/**
 * Renders a capability-based route guard.
 *
 * The guard checks session validity, then all required capabilities, before
 * mounting the guarded content. It redirects unauthenticated sessions to the
 * login route (preserving the attempted location) and renders an accessible
 * unauthorized state for authenticated sessions missing a required capability,
 * so protected content is never briefly shown.
 *
 * @param {{
 *   capability?: string | string[],
 *   children?: React.ReactNode,
 *   loginRoute?: string,
 *   unauthorizedTitle?: string,
 *   unauthorizedBody?: string,
 * }} props - The route guard props.
 * @returns {React.ReactElement} The guarded content, a redirect, or an unauthorized state.
 */
export function RouteGuard({
  capability,
  children,
  loginRoute = DEFAULT_LOGIN_ROUTE,
  unauthorizedTitle = DEFAULT_UNAUTHORIZED_TITLE,
  unauthorizedBody = DEFAULT_UNAUTHORIZED_BODY,
}) {
  const { isAuthenticated, hasCapability } = useAccessContext();
  const location = useLocation();

  if (!isAuthenticated) {
    return (
      <Navigate to={loginRoute} replace state={{ from: location.pathname + location.search }} />
    );
  }

  const required = toCapabilityList(capability);
  const authorized = required.length === 0 || required.every((name) => hasCapability(name));

  if (!authorized) {
    return (
      <div role="main" className="mx-auto flex max-w-screen-md flex-col gap-4 px-4 py-8">
        <Alert severity={ALERT_SEVERITIES.CRITICAL} title={unauthorizedTitle}>
          {unauthorizedBody}
        </Alert>
      </div>
    );
  }

  return children !== undefined && children !== null ? children : <Outlet />;
}

RouteGuard.propTypes = {
  capability: PropTypes.oneOfType([PropTypes.string, PropTypes.arrayOf(PropTypes.string)]),
  children: PropTypes.node,
  loginRoute: PropTypes.string,
  unauthorizedTitle: PropTypes.string,
  unauthorizedBody: PropTypes.string,
};

export default RouteGuard;