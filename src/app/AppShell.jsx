/**
 * Application shell layout.
 *
 * AppShell is the authenticated layout that frames every protected route
 * (SCRUM-822/823). It composes the app's persistent chrome and shell-level
 * behaviors around the routed content:
 *
 *   - A skip link so keyboard users can jump straight to the main content.
 *   - A persistent {@link SimulationBanner} making the demo nature unmistakable.
 *   - A header carrying the app title and capability-derived navigation, which
 *     collapses to a keyboard-accessible menu on small viewports.
 *   - The active session identity and a logout action.
 *   - A session-timeout warning modal that lets the user extend the session (by
 *     touching it) or sign out before it lapses.
 *   - The shared notification live regions (polite + assertive) so transient
 *     messages are announced with the correct politeness.
 *   - The routed content via `<Outlet />`.
 *
 * The shell derives its navigation from the {@link navigationService} using the
 * acting session claim, so menu visibility follows the same deny-by-default
 * policy that guards routes. It renders only sanitized copy, carries no PII
 * beyond the sanitized session identity, and degrades gracefully — session
 * lifecycle transitions never throw.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAccessContext } from '@/app/useAccessContext';
import { useNotifications } from '@/app/NotificationContext';
import { navigationService } from '@/features/access/services/navigationService';
import { sessionFacade } from '@/features/access/services/sessionFacade';
import { SimulationBanner } from '@/shared/ui/SimulationBanner';
import { Modal } from '@/shared/ui/Modal';
import { Button } from '@/shared/ui/Button';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { cn } from '@/shared/ui/cn';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Login route used when the session lapses and the shell must redirect. */
const LOGIN_ROUTE = '/login';

/** Interval, in milliseconds, at which the shell re-touches the session. */
const SESSION_POLL_MS = 30_000;

/**
 * Determines whether a value is a plain, non-array object.
 * @param {unknown} value - The candidate value.
 * @returns {boolean} `true` when `value` is a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes an arbitrary value into a trimmed string.
 * @param {unknown} value - The raw value.
 * @returns {string} A trimmed string (empty when unusable).
 */
function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Builds a minimal session claim shape from a sanitized session identity for
 * navigation resolution.
 * @param {Record<string, unknown> | null | undefined} identity - The identity.
 * @returns {{ capabilities: string[], roles: string[] } | null} A claim-like value.
 */
function toNavigationClaim(identity) {
  if (!isPlainObject(identity)) {
    return null;
  }
  const capabilities = Array.isArray(identity.capabilities)
    ? identity.capabilities.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
  const roles = Array.isArray(identity.roles)
    ? identity.roles.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
  return { capabilities, roles };
}

/**
 * Renders the authenticated application shell.
 *
 * The shell derives navigation from the acting session, announces notifications
 * via shared live regions, warns before session timeout, and renders the routed
 * content. It redirects to the login route when the session lapses.
 *
 * @returns {React.ReactElement} The application shell element.
 */
export function AppShell() {
  const {
    sessionIdentity,
    status,
    isAuthenticated,
    logout,
    touch,
  } = useAccessContext();
  const { politeMessages, assertiveMessages } = useNotifications();
  const navigate = useNavigate();

  const [menuOpen, setMenuOpen] = useState(false);
  const [warningOpen, setWarningOpen] = useState(false);

  const navigationGroups = useMemo(() => {
    const claim = toNavigationClaim(sessionIdentity);
    if (!claim) {
      return [];
    }
    try {
      return navigationService.buildGroups(claim);
    } catch (error) {
      safeLogger.warn('AppShell: failed to build navigation groups', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return [];
    }
  }, [sessionIdentity]);

  const subjectId = toText(isPlainObject(sessionIdentity) ? sessionIdentity.subjectId : '');

  const handleLogout = useCallback(() => {
    setWarningOpen(false);
    setMenuOpen(false);
    logout();
    navigate(LOGIN_ROUTE, { replace: true });
  }, [logout, navigate]);

  const handleExtend = useCallback(() => {
    const nextStatus = touch();
    if (nextStatus !== sessionFacade.SESSION_STATUS.WARNING) {
      setWarningOpen(false);
    }
  }, [touch]);

  const handleToggleMenu = useCallback(() => {
    setMenuOpen((previous) => !previous);
  }, []);

  const handleCloseMenu = useCallback(() => {
    setMenuOpen(false);
  }, []);

  // Redirect to login when the session lapses.
  useEffect(() => {
    if (!isAuthenticated || status === sessionFacade.SESSION_STATUS.EXPIRED) {
      navigate(LOGIN_ROUTE, { replace: true });
    }
  }, [isAuthenticated, status, navigate]);

  // Surface the warning modal when the session enters the warning window.
  useEffect(() => {
    if (status === sessionFacade.SESSION_STATUS.WARNING) {
      setWarningOpen(true);
    } else {
      setWarningOpen(false);
    }
  }, [status]);

  // Periodically re-evaluate the session lifecycle. This intentionally uses
  // `peekStatus` (not `touch`) so merely having the shell mounted never counts
  // as activity and resets the inactivity timer — otherwise the warning modal
  // and timeout would never trigger as long as the tab stayed open.
  useEffect(() => {
    if (!isAuthenticated) {
      return undefined;
    }
    const handle = setInterval(() => {
      sessionFacade.peekStatus();
    }, SESSION_POLL_MS);
    return () => {
      clearInterval(handle);
    };
  }, [isAuthenticated]);

  return (
    <div className="flex min-h-screen flex-col bg-white text-body">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <SimulationBanner />

      <header className="border-b border-primary-blue-100 bg-white">
        <div className="mx-auto flex max-w-screen-xl flex-wrap items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-lg font-medium text-primary-blue-700">
              International Payment Initiation
            </span>
          </div>

          <div className="flex items-center gap-3">
            {subjectId.length > 0 ? (
              <StatusBadge tone={STATUS_TONES.INFO}>{subjectId}</StatusBadge>
            ) : null}
            <Button type="button" variant="secondary" size="sm" onClick={handleLogout}>
              Sign out
            </Button>
            <button
              type="button"
              onClick={handleToggleMenu}
              aria-expanded={menuOpen}
              aria-controls="shell-navigation"
              className="rounded-md border border-primary-blue-500 px-3 py-1.5 text-sm font-medium text-primary-blue-700 transition-colors hover:bg-primary-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500 focus-visible:ring-offset-2 sm:hidden"
            >
              Menu
            </button>
          </div>
        </div>

        <nav
          id="shell-navigation"
          aria-label="Primary"
          className={cn(
            'border-t border-primary-blue-100 bg-primary-blue-50 sm:block',
            menuOpen ? 'block' : 'hidden',
          )}
        >
          <div className="mx-auto flex max-w-screen-xl flex-col gap-2 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
            {navigationGroups.length === 0 ? (
              <span className="text-sm text-body">No available navigation.</span>
            ) : (
              navigationGroups.map((group) => (
                <div key={group.id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                  <span className="sr-only">{group.label}</span>
                  {group.items.map((item) => (
                    <NavLink
                      key={item.id}
                      to={item.route}
                      end={item.exact === true}
                      onClick={handleCloseMenu}
                      className={({ isActive }) =>
                        cn(
                          'rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500 focus-visible:ring-offset-2',
                          isActive
                            ? 'bg-primary-blue-500 text-white'
                            : 'text-primary-blue-700 hover:bg-primary-blue-100',
                        )
                      }
                    >
                      {typeof item.label === 'string' ? item.label : ''}
                    </NavLink>
                  ))}
                </div>
              ))
            )}
          </div>
        </nav>
      </header>

      <main
        id="main-content"
        role="main"
        className="mx-auto w-full max-w-screen-xl flex-1 px-4 py-6"
      >
        <Outlet />
      </main>

      <div aria-live="polite" className="sr-only">
        {politeMessages.map((message, index) => (
          <p key={`polite-${index}`}>{message}</p>
        ))}
      </div>
      <div role="alert" aria-live="assertive" className="sr-only">
        {assertiveMessages.map((message, index) => (
          <p key={`assertive-${index}`}>{message}</p>
        ))}
      </div>

      <Modal
        open={warningOpen}
        onClose={handleExtend}
        title="Session about to expire"
        footer={
          <>
            <Button type="button" variant="secondary" size="sm" onClick={handleLogout}>
              Sign out
            </Button>
            <Button type="button" variant="primary" size="sm" onClick={handleExtend}>
              Stay signed in
            </Button>
          </>
        }
      >
        You will be signed out soon because of inactivity. Choose “Stay signed in” to
        continue your demo session, or sign out now.
      </Modal>
    </div>
  );
}

export default AppShell;