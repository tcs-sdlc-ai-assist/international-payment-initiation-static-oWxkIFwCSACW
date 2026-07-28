/**
 * Root application component.
 *
 * App composes the app-wide providers and gating around the routed content
 * (SCRUM-822/823/827). It runs the {@link bootstrap} sequence once before any
 * protected content renders, gating on the resulting discriminated snapshot so
 * a fatal fixture failure surfaces a safe, accessible fallback rather than a
 * blank screen. On a ready (or gracefully-degraded) bootstrap it composes:
 *
 *   - A top-level {@link ErrorBoundary} so a render fault in any feature can
 *     never replace the whole shell with a blank page.
 *   - The {@link NotificationProvider} and {@link SessionProvider} so shared
 *     notification and session/entitlement context are available app-wide.
 *   - A {@link BrowserRouter} hosting the {@link AppRoutes} route element tree.
 *
 * The router lives here exactly once; `main.jsx` only renders `<App />`. The
 * component surfaces a storage-degradation notice when the bootstrap reports an
 * in-memory fallback, but never blocks rendering on it. It renders sanitized
 * copy only, carries no PII, and never mutates application state beyond running
 * the idempotent bootstrap.
 */

import { useMemo } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { SessionProvider } from '@/app/useAccessContext';
import { NotificationProvider } from '@/app/NotificationContext';
import { AppRoutes } from '@/app/routes';
import { bootstrap, BOOTSTRAP_REASON_CODES } from '@/app/bootstrap';
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary';
import { SimulationBanner } from '@/shared/ui/SimulationBanner';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { safeLogger } from '@/shared/logging/safeLogger';

/**
 * Determines whether a value is a plain, non-array object.
 * @param {unknown} value - The candidate value.
 * @returns {boolean} `true` when `value` is a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Runs the idempotent application bootstrap once, degrading to a fatal snapshot
 * when the sequence itself throws unexpectedly.
 * @returns {ReturnType<typeof bootstrap>} A discriminated bootstrap snapshot.
 */
function runBootstrap() {
  try {
    return bootstrap();
  } catch (error) {
    safeLogger.error('App: unexpected error running bootstrap', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return {
      ok: false,
      ready: false,
      startedAt: '',
      env: { buildLabel: '', fixturePack: '', referenceDate: '' },
      fixtures: { ok: false, checked: 0, missing: [] },
      storage: { available: false, degraded: true },
      reconciliation: { migrated: 0, purged: 0, quarantined: 0 },
      reservations: { ok: false, purged: 0 },
      session: null,
      safeReasonCode: BOOTSTRAP_REASON_CODES.UNEXPECTED,
    };
  }
}

/**
 * Reloads the page so the bootstrap sequence can re-run from a clean state.
 * @returns {void}
 */
function reloadPage() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.location) {
      globalThis.location.reload();
    }
  } catch (error) {
    safeLogger.warn('App: failed to reload the page', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * Renders a full-page, accessible fallback when the bootstrap cannot produce a
 * usable runtime (missing/malformed fixtures or an unexpected fault).
 * @returns {React.ReactElement} The fatal bootstrap fallback element.
 */
function BootstrapFallback() {
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
            This is a demonstration environment. The app could not finish preparing its demo data.
          </p>
        </div>

        <Alert severity={ALERT_SEVERITIES.CRITICAL} title="Unable to start the demo">
          The demonstration data could not be prepared, so the app cannot start right now. This is a
          local demo issue and no data was affected. Try reloading the page.
        </Alert>

        <div>
          <Button type="button" variant="primary" size="md" onClick={reloadPage}>
            Reload page
          </Button>
        </div>
      </main>
    </div>
  );
}

/**
 * Renders the root application component.
 *
 * The component runs the bootstrap once, gates on the resulting snapshot to
 * surface a safe fallback when the runtime cannot be prepared, and otherwise
 * composes the top-level error boundary, shared providers, and router-hosted
 * routes. A storage-degradation notice is surfaced without blocking rendering.
 *
 * @returns {React.ReactElement} The root application element.
 */
export function App() {
  const snapshot = useMemo(() => runBootstrap(), []);

  const isFatal =
    !isPlainObject(snapshot) ||
    snapshot.ready !== true ||
    snapshot.safeReasonCode === BOOTSTRAP_REASON_CODES.UNEXPECTED ||
    snapshot.safeReasonCode === BOOTSTRAP_REASON_CODES.DEGRADED_FIXTURES;

  const storageDegraded =
    isPlainObject(snapshot) &&
    isPlainObject(snapshot.storage) &&
    snapshot.storage.degraded === true;

  if (isFatal) {
    return <BootstrapFallback />;
  }

  return (
    <ErrorBoundary>
      <NotificationProvider>
        <SessionProvider>
          {storageDegraded ? (
            <div className="mx-auto w-full max-w-screen-xl px-4 pt-4">
              <Alert severity={ALERT_SEVERITIES.WARNING} title="Storage unavailable">
                Browser storage is unavailable, so this demo is running from temporary data. Your
                changes will not persist across reloads.
              </Alert>
            </div>
          ) : null}
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </SessionProvider>
      </NotificationProvider>
    </ErrorBoundary>
  );
}

export default App;