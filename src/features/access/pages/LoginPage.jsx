/**
 * Mock login page.
 *
 * LoginPage is the single unauthenticated entry point into the demo (SCRUM-822).
 * It is deliberately login-only — no signup, password recovery, or account
 * management — and it authenticates against the mock {@link authService} via the
 * {@link useAccessContext} `login` action, which establishes the acting session
 * through the {@link sessionFacade}.
 *
 * The form is driven by React Hook Form with a Zod resolver so client-side
 * validation stays declarative and consistent. It surfaces:
 *
 *   - Visible, non-production credential hints (drawn from the bundled users
 *     fixture) so a reviewer can explore each demo role. These hints are shared
 *     demo logins and carry no real access.
 *   - A busy/loading state that disables submission while authentication is
 *     simulated.
 *   - Generic invalid-credential feedback that never distinguishes an unknown
 *     username from a wrong passcode, and never echoes the submitted values.
 *
 * On success the user is redirected to the location they originally attempted
 * (preserved by the {@link RouteGuard}) or to their capability-derived default
 * route. The page renders sanitized copy only and carries no PII beyond the
 * shared demo credential hints.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { useAccessContext } from '@/app/useAccessContext';
import { fixtureRegistry, FIXTURE_IDS } from '@/shared/fixtures/fixtureRegistry';
import { authService } from '@/features/access/services/authService';
import { SimulationBanner } from '@/shared/ui/SimulationBanner';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { FormField } from '@/shared/ui/FormField';
import { LoadingIndicator } from '@/shared/ui/LoadingIndicator';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { cn } from '@/shared/ui/cn';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Fallback route used when no attempted location or default route resolves. */
const FALLBACK_ROUTE = '/';

/** Generic, non-distinguishing invalid-credential message. */
const GENERIC_ERROR_MESSAGE =
  'The username or passcode did not match a known demo account. Pick a role from the credential hints and try again.';

/**
 * The login form validation schema. Validation is intentionally minimal — the
 * mock auth service performs the actual credential comparison.
 * @type {import('zod').ZodObject<Record<string, import('zod').ZodTypeAny>>}
 */
const LoginSchema = z
  .object({
    username: z.string().trim().min(1, 'Enter a username.'),
    passcode: z.string().min(1, 'Enter a passcode.'),
  })
  .strict();

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
 * Builds the sanitized, selectable credential hints from the bundled users
 * fixture. Each hint is a shared demo login and carries no real access.
 * @returns {Array<{
 *   userId: string,
 *   username: string,
 *   passcode: string,
 *   role: string,
 *   note: string,
 * }>} The credential hint models (may be empty).
 */
function buildCredentialHints() {
  let users = [];
  try {
    const fixture = fixtureRegistry.getFixture(FIXTURE_IDS.USERS);
    users = isPlainObject(fixture) && Array.isArray(fixture.users) ? fixture.users : [];
  } catch (error) {
    safeLogger.warn('LoginPage: failed to read users fixture for hints', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return [];
  }

  return users
    .map((user) => {
      if (!isPlainObject(user)) {
        return null;
      }
      const hint = isPlainObject(user.credential_hint) ? user.credential_hint : {};
      const username = toText(hint.username) || toText(user.user_name);
      const passcode = toText(hint.passcode);
      if (username.length === 0 || passcode.length === 0) {
        return null;
      }
      return {
        userId: toText(user.user_id) || username,
        username,
        passcode,
        role: toText(user.role),
        note: toText(hint.note),
      };
    })
    .filter((hint) => hint !== null);
}

/**
 * Resolves the target route to navigate to after a successful login.
 * @param {unknown} locationState - The router location state.
 * @param {string} defaultRoute - The session's capability-derived default route.
 * @returns {string} The resolved target route.
 */
function resolveTargetRoute(locationState, defaultRoute) {
  if (isPlainObject(locationState)) {
    const from = toText(locationState.from);
    if (from.length > 0) {
      return from;
    }
  }
  const resolvedDefault = toText(defaultRoute);
  return resolvedDefault.length > 0 ? resolvedDefault : FALLBACK_ROUTE;
}

/**
 * Renders the mock login page.
 *
 * The page authenticates against the mock auth service, redirecting an
 * already-authenticated session (or a session that becomes authenticated) to
 * the attempted location or the session's default route. Invalid credentials
 * surface a single generic message and never distinguish which field was wrong.
 *
 * @returns {React.ReactElement} The login page element.
 */
export function LoginPage() {
  const { isAuthenticated, defaultRoute, login } = useAccessContext();
  const navigate = useNavigate();
  const location = useLocation();

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const credentialHints = useMemo(() => buildCredentialHints(), []);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(LoginSchema),
    defaultValues: { username: '', passcode: '' },
    mode: 'onSubmit',
  });

  // Redirect an already-authenticated session away from the login page.
  useEffect(() => {
    if (isAuthenticated) {
      navigate(resolveTargetRoute(location.state, defaultRoute), { replace: true });
    }
  }, [isAuthenticated, defaultRoute, location.state, navigate]);

  const applyHint = useCallback(
    (hint) => {
      setFormError('');
      setValue('username', hint.username, { shouldValidate: false });
      setValue('passcode', hint.passcode, { shouldValidate: false });
    },
    [setValue],
  );

  const onSubmit = useCallback(
    async (values) => {
      setFormError('');
      setSubmitting(true);
      try {
        const result = await login({
          username: values.username,
          passcode: values.passcode,
        });
        if (!result.ok) {
          setFormError(GENERIC_ERROR_MESSAGE);
          return;
        }
        navigate(resolveTargetRoute(location.state, defaultRoute), { replace: true });
      } catch (error) {
        safeLogger.error('LoginPage: unexpected error during login submit', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
        setFormError(GENERIC_ERROR_MESSAGE);
      } finally {
        setSubmitting(false);
      }
    },
    [login, navigate, location.state, defaultRoute],
  );

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
            Sign in with a demo role to explore the simulation. This is a login-only demo — no
            signup or password recovery is available.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section
            aria-labelledby="login-heading"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
          >
            <h2 id="login-heading" className="text-lg font-medium text-body">
              Sign in
            </h2>

            {formError.length > 0 ? (
              <Alert severity={ALERT_SEVERITIES.CRITICAL} title="Sign-in failed">
                {formError}
              </Alert>
            ) : null}

            <form
              className="flex flex-col gap-4"
              onSubmit={handleSubmit(onSubmit)}
              noValidate
            >
              <FormField
                label="Username"
                required
                error={errors.username ? errors.username.message : undefined}
              >
                {(attrs) => (
                  <input
                    type="text"
                    autoComplete="username"
                    disabled={submitting}
                    className={cn(
                      'rounded-md border border-primary-blue-200 px-3 py-2 text-sm text-body',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500 focus-visible:ring-offset-2',
                      'disabled:cursor-not-allowed disabled:opacity-60',
                    )}
                    {...attrs}
                    {...register('username')}
                  />
                )}
              </FormField>

              <FormField
                label="Passcode"
                required
                error={errors.passcode ? errors.passcode.message : undefined}
              >
                {(attrs) => (
                  <input
                    type="password"
                    autoComplete="current-password"
                    disabled={submitting}
                    className={cn(
                      'rounded-md border border-primary-blue-200 px-3 py-2 text-sm text-body',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500 focus-visible:ring-offset-2',
                      'disabled:cursor-not-allowed disabled:opacity-60',
                    )}
                    {...attrs}
                    {...register('passcode')}
                  />
                )}
              </FormField>

              <div className="flex items-center gap-3">
                <Button type="submit" variant="primary" size="md" disabled={submitting}>
                  Sign in
                </Button>
                {submitting ? (
                  <LoadingIndicator size="sm" label="Signing in…" showLabel />
                ) : null}
              </div>
            </form>
          </section>

          <section
            aria-labelledby="hints-heading"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-6"
          >
            <div className="flex flex-col gap-1">
              <h2 id="hints-heading" className="text-lg font-medium text-body">
                Demo sign-in credentials
              </h2>
              <p className="text-sm text-body">
                Choose a role to explore its capabilities. Every credential below is a shared,
                non-production demo login and carries no real access.
              </p>
            </div>

            {credentialHints.length === 0 ? (
              <p className="text-sm text-body">No demo credentials are available.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {credentialHints.map((hint) => (
                  <li
                    key={hint.userId}
                    className="flex flex-col gap-2 rounded-md border border-primary-blue-100 bg-white p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-body">{hint.username}</span>
                      {hint.role.length > 0 ? (
                        <StatusBadge tone={STATUS_TONES.INFO}>{hint.role}</StatusBadge>
                      ) : null}
                    </div>
                    <dl className="flex flex-col gap-1 text-xs text-body">
                      <div className="flex gap-2">
                        <dt className="font-medium text-primary-blue-700">Username</dt>
                        <dd>{hint.username}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="font-medium text-primary-blue-700">Passcode</dt>
                        <dd>{hint.passcode}</dd>
                      </div>
                      {hint.note.length > 0 ? (
                        <div className="flex gap-2">
                          <dt className="font-medium text-primary-blue-700">Note</dt>
                          <dd>{hint.note}</dd>
                        </div>
                      ) : null}
                    </dl>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={submitting}
                      onClick={() => applyHint(hint)}
                    >
                      Use these credentials
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

// Referenced to document the mock auth service this page authenticates against.
void authService;

export default LoginPage;