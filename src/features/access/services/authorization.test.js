/**
 * Unit tests for the authorization policy.
 *
 * These tests exercise the deny-by-default capability checks (`can`) — direct
 * capabilities, role-derived capabilities, missing/malformed sessions, empty
 * required sets, and array-of-capabilities semantics — and `allowedNavigation`,
 * which resolves the fixture navigation each role is entitled to see, ordered by
 * the fixture's `order` field.
 */

import { describe, it, expect } from 'vitest';
import { can, allowedNavigation } from '@/features/access/services/authorizationPolicy';
import { CAPABILITIES, ROLES } from '@/shared/config/constants';

/**
 * Builds a minimal session claim with the supplied capabilities and roles.
 * @param {{ capabilities?: string[], roles?: string[] }} [overrides] - Claim overrides.
 * @returns {{ capabilities: string[], roles: string[] }} A claim-like value.
 */
function buildSession(overrides) {
  const source = overrides ?? {};
  return {
    capabilities: Array.isArray(source.capabilities) ? source.capabilities : [],
    roles: Array.isArray(source.roles) ? source.roles : [],
  };
}

describe('authorizationPolicy.can', () => {
  it('allows a capability held directly on the session claim', () => {
    const session = buildSession({ capabilities: [CAPABILITIES.PAYMENT_INITIATE] });
    expect(can(session, CAPABILITIES.PAYMENT_INITIATE)).toBe(true);
  });

  it('allows a capability granted by the session role', () => {
    const session = buildSession({ roles: [ROLES.INITIATOR] });
    expect(can(session, CAPABILITIES.PAYMENT_INITIATE)).toBe(true);
  });

  it('merges direct and role-derived capabilities when resolving access', () => {
    const session = buildSession({
      roles: [ROLES.OPERATOR],
      capabilities: [CAPABILITIES.PAYMENT_INITIATE],
    });
    expect(can(session, CAPABILITIES.PAYMENT_OPERATE)).toBe(true);
    expect(can(session, CAPABILITIES.SIGNER_READ)).toBe(true);
    expect(can(session, CAPABILITIES.PAYMENT_INITIATE)).toBe(true);
  });

  it('denies a capability the session does not hold', () => {
    const session = buildSession({ roles: [ROLES.INITIATOR] });
    expect(can(session, CAPABILITIES.PAYMENT_APPROVE)).toBe(false);
  });

  it('requires every capability when an array is supplied', () => {
    const session = buildSession({ roles: [ROLES.SIGNER_ADMIN] });
    expect(can(session, [CAPABILITIES.SIGNER_READ, CAPABILITIES.SIGNER_MANAGE])).toBe(true);
    expect(can(session, [CAPABILITIES.SIGNER_READ, CAPABILITIES.PAYMENT_APPROVE])).toBe(false);
  });

  it('denies by default when the required capability set is empty', () => {
    const session = buildSession({ roles: [ROLES.SIGNER_ADMIN] });
    expect(can(session, [])).toBe(false);
    expect(can(session, '')).toBe(false);
  });

  it('denies a missing or malformed session', () => {
    expect(can(null, CAPABILITIES.PAYMENT_INITIATE)).toBe(false);
    expect(can(undefined, CAPABILITIES.PAYMENT_INITIATE)).toBe(false);
    expect(can('not-a-session', CAPABILITIES.PAYMENT_INITIATE)).toBe(false);
  });

  it('denies a session that holds no capabilities', () => {
    const session = buildSession();
    expect(can(session, CAPABILITIES.SIGNER_READ)).toBe(false);
  });

  it('denies an unknown capability the session cannot hold', () => {
    const session = buildSession({ roles: [ROLES.OPERATOR] });
    expect(can(session, 'unknown:capability')).toBe(false);
  });
});

describe('authorizationPolicy.allowedNavigation', () => {
  it('returns only the navigation items an initiator is entitled to see', () => {
    const session = buildSession({ roles: [ROLES.INITIATOR] });
    const items = allowedNavigation(session);
    const routes = items.map((item) => item.route);
    expect(routes).toContain('/payments/new');
    expect(routes).not.toContain('/payments/approvals');
    expect(routes).not.toContain('/signers');
  });

  it('returns the approval navigation for an approver', () => {
    const session = buildSession({ roles: [ROLES.APPROVER] });
    const routes = allowedNavigation(session).map((item) => item.route);
    expect(routes).toContain('/payments/approvals');
    expect(routes).not.toContain('/payments/new');
  });

  it('returns operations and signer navigation for an operator', () => {
    const session = buildSession({ roles: [ROLES.OPERATOR] });
    const routes = allowedNavigation(session).map((item) => item.route);
    expect(routes).toContain('/payments/operations');
    expect(routes).toContain('/signers');
    expect(routes).toContain('/audit');
  });

  it('returns signer and audit navigation for a signer administrator', () => {
    const session = buildSession({ roles: [ROLES.SIGNER_ADMIN] });
    const routes = allowedNavigation(session).map((item) => item.route);
    expect(routes).toContain('/signers');
    expect(routes).toContain('/audit');
    expect(routes).not.toContain('/payments/new');
  });

  it('returns read-only navigation for an auditor', () => {
    const session = buildSession({ roles: [ROLES.AUDITOR] });
    const routes = allowedNavigation(session).map((item) => item.route);
    expect(routes).toContain('/signers');
    expect(routes).toContain('/audit');
    expect(routes).not.toContain('/payments/approvals');
  });

  it('orders the resolved navigation items by the fixture order field', () => {
    const session = buildSession({ roles: [ROLES.OPERATOR] });
    const orders = allowedNavigation(session).map((item) =>
      typeof item.order === 'number' ? item.order : 0,
    );
    const sorted = [...orders].sort((a, b) => a - b);
    expect(orders).toEqual(sorted);
  });

  it('returns an empty list for a session with no capabilities', () => {
    expect(allowedNavigation(buildSession())).toHaveLength(0);
  });

  it('returns an empty list for a missing or malformed session', () => {
    expect(allowedNavigation(null)).toHaveLength(0);
    expect(allowedNavigation(undefined)).toHaveLength(0);
    expect(allowedNavigation('not-a-session')).toHaveLength(0);
  });
});