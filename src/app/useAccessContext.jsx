/**
 * Session/entitlement React context and hook.
 *
 * useAccessContext provides a single React context over the acting demo session
 * and its entitlements (SCRUM-822/823). It layers atop the {@link sessionFacade}
 * (session lifecycle + subscription), the {@link authService} (mock credential
 * validation), the {@link authorizationPolicy} (deny-by-default capability
 * checks), and the {@link navigationService} (capability-derived default route):
 *
 *   - A {@link SessionProvider} owns a `useReducer` store seeded from the current
 *     session, subscribes to the SessionFacade for warning/timeout transitions,
 *     and refreshes the store on every lifecycle change.
 *   - The {@link useAccessContext} hook exposes the sanitized `sessionIdentity`,
 *     a `hasCapability(name)` predicate, the resolved `maskingPolicy`,
 *     `defaultRoute`, the lifecycle `status`, the latest `safeReasonCode`, and
 *     `login` / `logout` / `touch` actions.
 *
 * The provider is demo-only and non-regulatory: it enforces client-side gating
 * and carries no server guarantee. Actions never throw for expected failures —
 * `login` resolves a discriminated `{ ok, ... }` result carrying a sanitized safe
 * reason code so callers can gate the UI safely.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from 'react';
import PropTypes from 'prop-types';
import { sessionFacade } from '@/features/access/services/sessionFacade';
import { authService } from '@/features/access/services/authService';
import { authorizationPolicy } from '@/features/access/services/authorizationPolicy';
import { navigationService } from '@/features/access/services/navigationService';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default masking policy applied when a session carries none. */
const DEFAULT_MASKING_POLICY = 'list';

/** Fallback route used when no allowed navigation resolves. */
const FALLBACK_ROUTE = '/';

/**
 * Access action types dispatched to the reducer.
 * @type {{
 *   HYDRATE: 'access/hydrate',
 *   SYNC: 'access/sync',
 *   CLEAR: 'access/clear',
 * }}
 */
const ACCESS_ACTIONS = Object.freeze({
  HYDRATE: 'access/hydrate',
  SYNC: 'access/sync',
  CLEAR: 'access/clear',
});

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
 * Builds a sanitized session identity from a session claim and profile.
 * @param {import('@/shared/schemas/schemas').SessionClaimV1 | null | undefined} claim
 *   The session claim.
 * @param {{
 *   maskingPolicyId?: string,
 *   defaultRoute?: string,
 *   organizationId?: string,
 *   accountScopes?: string[],
 * } | null | undefined} profile - The session profile.
 * @returns {{
 *   sessionId: string,
 *   subjectId: string,
 *   roles: string[],
 *   capabilities: string[],
 *   organizationId: string | null,
 *   accountScopes: string[],
 *   issuedAt: string,
 *   expiresAt: string,
 * } | null} A sanitized session identity, or `null`.
 */
function buildSessionIdentity(claim, profile) {
  if (!isPlainObject(claim)) {
    return null;
  }
  const source = isPlainObject(profile) ? profile : {};
  const roles = Array.isArray(claim.roles)
    ? claim.roles.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
  const capabilities = Array.isArray(claim.capabilities)
    ? claim.capabilities.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
  const accountScopes = Array.isArray(source.accountScopes)
    ? source.accountScopes.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
  const organizationId = toText(source.organizationId);

  return {
    sessionId: toText(claim.sessionId),
    subjectId: toText(claim.subjectId),
    roles,
    capabilities,
    organizationId: organizationId.length > 0 ? organizationId : null,
    accountScopes,
    issuedAt: toText(claim.issuedAt),
    expiresAt: toText(claim.expiresAt),
  };
}

/**
 * Resolves the effective default route for a session claim.
 * @param {import('@/shared/schemas/schemas').SessionClaimV1 | null | undefined} claim
 *   The session claim.
 * @param {{ defaultRoute?: string } | null | undefined} profile - The session profile.
 * @returns {string} The resolved default route.
 */
function resolveDefaultRoute(claim, profile) {
  const source = isPlainObject(profile) ? profile : {};
  const profileRoute = toText(source.defaultRoute);
  if (profileRoute.length > 0) {
    return profileRoute;
  }
  if (!isPlainObject(claim)) {
    return FALLBACK_ROUTE;
  }
  try {
    return navigationService.resolveDefaultRoute(claim);
  } catch (error) {
    safeLogger.warn('useAccessContext: failed to resolve default route', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return FALLBACK_ROUTE;
  }
}

/**
 * Resolves the effective masking policy for a session profile.
 * @param {{ maskingPolicyId?: string } | null | undefined} profile - The session profile.
 * @returns {string} The masking policy identifier.
 */
function resolveMaskingPolicy(profile) {
  const source = isPlainObject(profile) ? profile : {};
  const maskingPolicyId = toText(source.maskingPolicyId);
  return maskingPolicyId.length > 0 ? maskingPolicyId : DEFAULT_MASKING_POLICY;
}

/**
 * Builds the derived access state from a session claim and profile.
 * @param {import('@/shared/schemas/schemas').SessionClaimV1 | null | undefined} claim
 *   The session claim.
 * @param {{
 *   maskingPolicyId?: string,
 *   defaultRoute?: string,
 *   organizationId?: string,
 *   accountScopes?: string[],
 * } | null | undefined} profile - The session profile.
 * @param {string} status - The lifecycle status.
 * @param {string | null} safeReasonCode - The latest sanitized reason code.
 * @returns {{
 *   sessionIdentity: Record<string, unknown> | null,
 *   claim: import('@/shared/schemas/schemas').SessionClaimV1 | null,
 *   profile: Record<string, unknown> | null,
 *   maskingPolicy: string,
 *   defaultRoute: string,
 *   status: string,
 *   safeReasonCode: string | null,
 * }} The derived access state.
 */
function buildState(claim, profile, status, safeReasonCode) {
  const normalizedClaim = isPlainObject(claim) ? claim : null;
  const normalizedProfile = isPlainObject(profile) ? profile : null;
  return {
    sessionIdentity: buildSessionIdentity(normalizedClaim, normalizedProfile),
    claim: normalizedClaim,
    profile: normalizedProfile,
    maskingPolicy: resolveMaskingPolicy(normalizedProfile),
    defaultRoute: resolveDefaultRoute(normalizedClaim, normalizedProfile),
    status,
    safeReasonCode: safeReasonCode ?? null,
  };
}

/**
 * Builds the initial access state from the current session, if any.
 * @returns {ReturnType<typeof buildState>} The initial access state.
 */
function createInitialState() {
  let claim = null;
  try {
    claim = sessionFacade.getSession();
  } catch (error) {
    safeLogger.warn('useAccessContext: failed to read initial session', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    claim = null;
  }
  const status = isPlainObject(claim)
    ? sessionFacade.computeStatus(claim)
    : sessionFacade.SESSION_STATUS.NONE;
  return buildState(claim, null, status, null);
}

/**
 * The access-state reducer.
 * @param {ReturnType<typeof buildState>} state - The current state.
 * @param {{
 *   type: string,
 *   claim?: import('@/shared/schemas/schemas').SessionClaimV1 | null,
 *   profile?: Record<string, unknown> | null,
 *   status?: string,
 *   safeReasonCode?: string | null,
 * }} action - The dispatched action.
 * @returns {ReturnType<typeof buildState>} The next state.
 */
function accessReducer(state, action) {
  switch (action.type) {
    case ACCESS_ACTIONS.HYDRATE: {
      return buildState(
        action.claim ?? null,
        action.profile ?? null,
        action.status ?? sessionFacade.SESSION_STATUS.NONE,
        action.safeReasonCode ?? null,
      );
    }
    case ACCESS_ACTIONS.SYNC: {
      return buildState(
        action.claim ?? state.claim,
        action.profile ?? state.profile,
        action.status ?? state.status,
        action.safeReasonCode ?? null,
      );
    }
    case ACCESS_ACTIONS.CLEAR: {
      return buildState(null, null, sessionFacade.SESSION_STATUS.NONE, action.safeReasonCode ?? null);
    }
    default:
      return state;
  }
}

/**
 * The access context value shape.
 * @type {React.Context<{
 *   sessionIdentity: Record<string, unknown> | null,
 *   hasCapability: (name: string | string[]) => boolean,
 *   maskingPolicy: string,
 *   defaultRoute: string,
 *   status: string,
 *   safeReasonCode: string | null,
 *   isAuthenticated: boolean,
 *   login: (credentials: { username: string, passcode: string }, options?: { signal?: AbortSignal }) => Promise<{ ok: boolean, safeReasonCode: string }>,
 *   logout: (safeReasonCode?: string) => void,
 *   touch: () => string,
 * } | null>}
 */
const SessionContext = createContext(null);

/**
 * Provides the session/entitlement context to descendant components.
 *
 * The provider seeds a `useReducer` store from the current session, subscribes
 * to the {@link sessionFacade} for warning/timeout transitions, and exposes
 * `login` / `logout` / `touch` actions that never throw for expected failures.
 *
 * @param {{ children: React.ReactNode }} props - The provider props.
 * @returns {React.ReactElement} The provider element.
 */
export function SessionProvider({ children }) {
  const [state, dispatch] = useReducer(accessReducer, undefined, createInitialState);

  useEffect(() => {
    let active = true;

    const unsubscribe = sessionFacade.subscribe((snapshot) => {
      if (!active || !isPlainObject(snapshot)) {
        return;
      }
      dispatch({
        type: ACCESS_ACTIONS.SYNC,
        claim: snapshot.session ?? null,
        status: typeof snapshot.status === 'string' ? snapshot.status : sessionFacade.SESSION_STATUS.NONE,
        safeReasonCode: snapshot.safeReasonCode ?? null,
      });
    });

    // Re-hydrate from the restored session on mount.
    let restored = null;
    try {
      restored = sessionFacade.getSession();
    } catch (error) {
      safeLogger.warn('useAccessContext: failed to restore session on mount', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      restored = null;
    }
    if (active && isPlainObject(restored)) {
      dispatch({
        type: ACCESS_ACTIONS.SYNC,
        claim: restored,
        status: sessionFacade.computeStatus(restored),
        safeReasonCode: null,
      });
    }

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const login = useCallback(async (credentials, options) => {
    let result;
    try {
      result = await authService.login(credentials, options);
    } catch (error) {
      safeLogger.error('useAccessContext: unexpected error during login', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return { ok: false, safeReasonCode: authService.AUTH_REASON_CODES.UNEXPECTED };
    }

    if (!result.ok) {
      dispatch({ type: ACCESS_ACTIONS.CLEAR, safeReasonCode: result.safeReasonCode });
      return { ok: false, safeReasonCode: result.safeReasonCode };
    }

    const started = sessionFacade.startSession(result.claim);
    if (!started) {
      dispatch({
        type: ACCESS_ACTIONS.CLEAR,
        safeReasonCode: authService.AUTH_REASON_CODES.UNEXPECTED,
      });
      return { ok: false, safeReasonCode: authService.AUTH_REASON_CODES.UNEXPECTED };
    }

    dispatch({
      type: ACCESS_ACTIONS.HYDRATE,
      claim: started,
      profile: result.profile,
      status: sessionFacade.computeStatus(started),
      safeReasonCode: result.safeReasonCode,
    });

    return { ok: true, safeReasonCode: result.safeReasonCode };
  }, []);

  const logout = useCallback((safeReasonCode) => {
    try {
      sessionFacade.logout(safeReasonCode);
    } catch (error) {
      safeLogger.warn('useAccessContext: failed to logout', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
    dispatch({
      type: ACCESS_ACTIONS.CLEAR,
      safeReasonCode: safeReasonCode ?? sessionFacade.SESSION_REASON_CODES.SIGN_OUT,
    });
  }, []);

  const touch = useCallback(() => {
    try {
      return sessionFacade.touch();
    } catch (error) {
      safeLogger.warn('useAccessContext: failed to touch session', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return sessionFacade.SESSION_STATUS.NONE;
    }
  }, []);

  const hasCapability = useCallback(
    (name) => {
      if (!state.claim) {
        return false;
      }
      return authorizationPolicy.can(state.claim, name);
    },
    [state.claim],
  );

  const value = useMemo(
    () => ({
      sessionIdentity: state.sessionIdentity,
      hasCapability,
      maskingPolicy: state.maskingPolicy,
      defaultRoute: state.defaultRoute,
      status: state.status,
      safeReasonCode: state.safeReasonCode,
      isAuthenticated: state.sessionIdentity !== null,
      login,
      logout,
      touch,
    }),
    [
      state.sessionIdentity,
      state.maskingPolicy,
      state.defaultRoute,
      state.status,
      state.safeReasonCode,
      hasCapability,
      login,
      logout,
      touch,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

SessionProvider.propTypes = {
  children: PropTypes.node,
};

/**
 * Returns the session/entitlement context.
 *
 * Must be called within a {@link SessionProvider}; it throws otherwise so
 * misuse is caught during development.
 *
 * @returns {{
 *   sessionIdentity: Record<string, unknown> | null,
 *   hasCapability: (name: string | string[]) => boolean,
 *   maskingPolicy: string,
 *   defaultRoute: string,
 *   status: string,
 *   safeReasonCode: string | null,
 *   isAuthenticated: boolean,
 *   login: (credentials: { username: string, passcode: string }, options?: { signal?: AbortSignal }) => Promise<{ ok: boolean, safeReasonCode: string }>,
 *   logout: (safeReasonCode?: string) => void,
 *   touch: () => string,
 * }} The access context value.
 * @throws {Error} When used outside a {@link SessionProvider}.
 */
export function useAccessContext() {
  const context = useContext(SessionContext);
  if (context === null) {
    throw new Error('useAccessContext: must be used within a SessionProvider.');
  }
  return context;
}

export default useAccessContext;