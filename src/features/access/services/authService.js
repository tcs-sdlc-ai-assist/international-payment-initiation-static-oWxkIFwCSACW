/**
 * Mock authentication service.
 *
 * AuthService validates demo credentials against the bundled users fixture and,
 * on success, resolves a versioned {@link SessionClaimV1} describing the acting
 * demo user (subject, org, role, capabilities, masking policy, issue/expiry
 * instants, and default route). It is intentionally demo-only:
 *
 *   - Credential validation is simulated deterministically with bounded latency
 *     via the mock envelope layer; no real authentication ever occurs.
 *   - The passcode-like fixture value is compared in-memory only and is NEVER
 *     persisted, logged, audited, or returned in any result payload.
 *   - The resolved session claim carries only sanitized identifiers and safe
 *     codes; no PII (username, email, phone) is included.
 *
 * The service returns a discriminated `{ ok, ... }` result so callers can
 * degrade gracefully; it never throws for invalid credentials.
 */

import { CAPABILITIES, ROLES, SESSION_TIMEOUT_MINUTES } from '@/shared/config/constants';
import { fixtureRegistry } from '@/shared/fixtures/fixtureRegistry';
import { parseSessionClaimV1 } from '@/shared/schemas/schemas';
import { demoClock } from '@/shared/time/demoClock';
import { generateOperationId, runMockOperation } from '@/shared/mock/mockEnvelope';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Minimum simulated authentication latency, in milliseconds. */
const AUTH_MIN_LATENCY_MS = 200;

/** Maximum simulated authentication latency, in milliseconds. */
const AUTH_MAX_LATENCY_MS = 1200;

/** Default route used when a user record does not carry one. */
const DEFAULT_ROUTE = '/payments/new';

/** Default masking policy applied when a user record does not carry one. */
const DEFAULT_MASKING_POLICY_ID = 'list';

/**
 * Safe reason codes surfaced by the auth service.
 * @type {{
 *   INVALID_CREDENTIALS: 'auth.error.invalid_credentials',
 *   UNEXPECTED: 'auth.error.unexpected',
 *   ABORTED: 'auth.error.aborted',
 *   SUCCESS: 'auth.success.sign_in',
 * }}
 */
export const AUTH_REASON_CODES = Object.freeze({
  INVALID_CREDENTIALS: 'auth.error.invalid_credentials',
  UNEXPECTED: 'auth.error.unexpected',
  ABORTED: 'auth.error.aborted',
  SUCCESS: 'auth.success.sign_in',
});

/** Set of known capability values for filtering fixture capabilities. */
const KNOWN_CAPABILITIES = new Set(Object.values(CAPABILITIES));

/** Set of known role values for validating fixture roles. */
const KNOWN_ROLES = new Set(Object.values(ROLES));

/**
 * Normalizes an arbitrary value into a trimmed string.
 * @param {unknown} value - The raw value.
 * @returns {string} A trimmed string (empty when unusable).
 */
function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Filters a raw capabilities list down to known capability identifiers.
 * @param {unknown} value - The raw capabilities value.
 * @returns {string[]} A safe array of known capabilities.
 */
function toKnownCapabilities(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === 'string' && KNOWN_CAPABILITIES.has(item));
}

/**
 * Reads the passcode-like credential hint from a user fixture record without
 * ever retaining it beyond the comparison.
 * @param {Record<string, unknown>} user - The user fixture record.
 * @returns {string} The expected passcode, or an empty string.
 */
function readExpectedPasscode(user) {
  const hint = user.credential_hint;
  if (hint === null || typeof hint !== 'object' || Array.isArray(hint)) {
    return '';
  }
  return toText(hint.passcode);
}

/**
 * Builds a validated {@link SessionClaimV1} for an authenticated user.
 *
 * The claim carries only sanitized identifiers and safe codes — no PII and no
 * passcode-like material.
 *
 * @param {Record<string, unknown>} user - The matched user fixture record.
 * @returns {{
 *   ok: true,
 *   claim: import('@/shared/schemas/schemas').SessionClaimV1,
 *   profile: {
 *     maskingPolicyId: string,
 *     defaultRoute: string,
 *     organizationId: string,
 *     accountScopes: string[],
 *   },
 * } | { ok: false, error: string }} A discriminated result.
 */
function buildSessionClaim(user) {
  const subjectId = toText(user.user_id);
  const role = toText(user.role);
  if (subjectId.length === 0 || !KNOWN_ROLES.has(role)) {
    return { ok: false, error: 'invalid_user_record' };
  }

  const issuedAt = demoClock.now();
  const expiresAt = demoClock.addMinutes(issuedAt, SESSION_TIMEOUT_MINUTES);

  const candidate = {
    version: 'v1',
    sessionId: generateOperationId(),
    subjectId,
    roles: [role],
    capabilities: toKnownCapabilities(user.capabilities),
    issuedAt,
    expiresAt,
  };

  const parsed = parseSessionClaimV1(candidate);
  if (!parsed.ok) {
    safeLogger.error('authService: failed to build a valid session claim', {
      reason: parsed.error,
    });
    return { ok: false, error: 'invalid_session_claim' };
  }

  const organizationId = toText(user.organization_id);
  const maskingPolicyId = toText(user.masking_policy_id) || DEFAULT_MASKING_POLICY_ID;
  const defaultRoute = toText(user.default_route) || DEFAULT_ROUTE;
  const accountScopes = Array.isArray(user.account_scopes)
    ? user.account_scopes.filter((scope) => typeof scope === 'string' && scope.length > 0)
    : [];

  return {
    ok: true,
    claim: parsed.value,
    profile: {
      maskingPolicyId,
      defaultRoute,
      organizationId,
      accountScopes,
    },
  };
}

/**
 * Validates demo credentials and, on success, resolves a versioned session
 * claim describing the acting user.
 *
 * Simulates bounded latency and honors an optional {@link AbortSignal}. The
 * passcode-like credential is compared in-memory only and never persisted,
 * logged, audited, or returned. Invalid credentials never throw; they resolve
 * to a discriminated failure result.
 *
 * @param {{ username: string, passcode: string }} credentials - The demo credentials.
 * @param {{ signal?: AbortSignal }} [options] - Optional cancellation options.
 * @returns {Promise<{
 *   ok: true,
 *   claim: import('@/shared/schemas/schemas').SessionClaimV1,
 *   profile: {
 *     maskingPolicyId: string,
 *     defaultRoute: string,
 *     organizationId: string,
 *     accountScopes: string[],
 *   },
 *   safeReasonCode: string,
 * } | { ok: false, safeReasonCode: string }>} A discriminated auth result.
 */
export async function login(credentials, options) {
  const source = credentials ?? {};
  const username = toText(source.username);
  const passcode = typeof source.passcode === 'string' ? source.passcode : '';

  const user = username.length > 0 ? fixtureRegistry.getUserByUsername(username) : undefined;
  const expectedPasscode = user ? readExpectedPasscode(user) : '';
  const credentialsMatch =
    user !== undefined && expectedPasscode.length > 0 && expectedPasscode === passcode.trim();

  let envelope;
  try {
    envelope = await runMockOperation({
      scenarioId: 'demo-scn-auth-login',
      minMs: AUTH_MIN_LATENCY_MS,
      maxMs: AUTH_MAX_LATENCY_MS,
      shouldFail: !credentialsMatch,
      safeReasonCode: AUTH_REASON_CODES.INVALID_CREDENTIALS,
      signal: source && options ? options.signal : undefined,
    });
  } catch (error) {
    safeLogger.error('authService: unexpected error during login', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return { ok: false, safeReasonCode: AUTH_REASON_CODES.UNEXPECTED };
  }

  if (envelope.status !== 'success') {
    const safeReasonCode =
      typeof envelope.safeReasonCode === 'string' && envelope.safeReasonCode.length > 0
        ? envelope.safeReasonCode
        : AUTH_REASON_CODES.INVALID_CREDENTIALS;
    safeLogger.warn('authService: login rejected', { safeReasonCode });
    return { ok: false, safeReasonCode };
  }

  if (!user) {
    return { ok: false, safeReasonCode: AUTH_REASON_CODES.INVALID_CREDENTIALS };
  }

  const built = buildSessionClaim(user);
  if (!built.ok) {
    return { ok: false, safeReasonCode: AUTH_REASON_CODES.UNEXPECTED };
  }

  return {
    ok: true,
    claim: built.claim,
    profile: built.profile,
    safeReasonCode: AUTH_REASON_CODES.SUCCESS,
  };
}

/**
 * The auth service contract, exposed as a single frozen object.
 * @type {{
 *   login: typeof login,
 *   AUTH_REASON_CODES: typeof AUTH_REASON_CODES,
 * }}
 */
export const authService = Object.freeze({
  login,
  AUTH_REASON_CODES,
});

export default authService;