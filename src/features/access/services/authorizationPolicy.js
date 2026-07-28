/**
 * Authorization policy (cross-cluster contract).
 *
 * AuthorizationPolicy is the single entry point both clusters (access + payment)
 * use to make deny-by-default authorization decisions. It implements the
 * AuthorizationPolicy contract:
 *
 *   - `can(session, capability)` returns whether the acting session holds the
 *     required capability (or every capability when an array is supplied). It is
 *     deny-by-default: a missing session, missing capabilities, or unknown
 *     capability always resolves to `false`.
 *   - `allowedNavigation(session)` returns the navigation items (from the
 *     bundled `navigation.json` fixture) whose `required_capabilities` are ALL
 *     satisfied by the session, ordered by the fixture's `order` field.
 *
 * Capability resolution is derived from the session's own capabilities merged
 * with the capabilities granted by its roles (from the bundled `roles.json`
 * fixture), so a session is authorized when either source grants the capability.
 *
 * This is a demo-only, non-regulatory policy: it enforces client-side
 * visibility and gating and carries no server guarantee.
 */

import { fixtureRegistry, FIXTURE_IDS } from '@/shared/fixtures/fixtureRegistry';
import { safeLogger } from '@/shared/logging/safeLogger';

/**
 * Normalizes a value into a string array, dropping non-string entries.
 * @param {unknown} value - The candidate value.
 * @returns {string[]} A safe array of strings (may be empty).
 */
function toStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === 'string' && item.length > 0);
}

/**
 * Reads the navigation items from the bundled navigation fixture.
 * @returns {Array<Record<string, unknown>>} The navigation records (may be empty).
 */
function readNavigationItems() {
  const fixture = fixtureRegistry.getFixture(FIXTURE_IDS.NAVIGATION);
  if (!fixture || !Array.isArray(fixture.navigation)) {
    return [];
  }
  return fixture.navigation.filter(
    (item) => item !== null && typeof item === 'object' && !Array.isArray(item),
  );
}

/**
 * Resolves the effective capability set for a session by merging its own
 * capabilities with the capabilities granted by its roles.
 * @param {{ capabilities?: string[], roles?: string[] } | null | undefined} session
 *   The acting session claim.
 * @returns {Set<string>} The effective capability set (may be empty).
 */
function resolveCapabilitySet(session) {
  const capabilities = new Set();
  if (!session || typeof session !== 'object') {
    return capabilities;
  }

  for (const capability of toStringArray(session.capabilities)) {
    capabilities.add(capability);
  }

  for (const role of toStringArray(session.roles)) {
    const roleRecord = fixtureRegistry.getRoleById(role);
    if (!roleRecord) {
      continue;
    }
    for (const capability of toStringArray(roleRecord.capabilities)) {
      capabilities.add(capability);
    }
  }

  return capabilities;
}

/**
 * Determines whether a session holds the required capability (or every
 * capability when an array is supplied).
 *
 * Deny-by-default: a missing session, empty required set, or unknown capability
 * resolves to `false`.
 *
 * @param {{ capabilities?: string[], roles?: string[] } | null | undefined} session
 *   The acting session claim.
 * @param {string | string[]} capability - The required capability or capabilities.
 * @returns {boolean} `true` when all required capabilities are held.
 */
export function can(session, capability) {
  if (!session || typeof session !== 'object') {
    return false;
  }

  const required =
    typeof capability === 'string' && capability.length > 0
      ? [capability]
      : toStringArray(capability);

  if (required.length === 0) {
    return false;
  }

  const held = resolveCapabilitySet(session);
  if (held.size === 0) {
    return false;
  }

  return required.every((item) => held.has(item));
}

/**
 * Returns the navigation items whose required capabilities are ALL satisfied by
 * the acting session, ordered by the fixture's `order` field.
 *
 * Deny-by-default: a navigation item is hidden unless the session holds every
 * capability listed in its `required_capabilities`.
 *
 * @param {{ capabilities?: string[], roles?: string[] } | null | undefined} session
 *   The acting session claim.
 * @returns {Array<Record<string, unknown>>} The allowed navigation items.
 */
export function allowedNavigation(session) {
  if (!session || typeof session !== 'object') {
    return [];
  }

  const held = resolveCapabilitySet(session);
  if (held.size === 0) {
    safeLogger.warn('authorizationPolicy: session holds no capabilities; navigation denied');
    return [];
  }

  const items = readNavigationItems();

  return items
    .filter((item) => {
      const requiredCapabilities = toStringArray(item.required_capabilities);
      if (requiredCapabilities.length === 0) {
        return false;
      }
      return requiredCapabilities.every((capability) => held.has(capability));
    })
    .slice()
    .sort((a, b) => {
      const left = typeof a.order === 'number' && Number.isFinite(a.order) ? a.order : 0;
      const right = typeof b.order === 'number' && Number.isFinite(b.order) ? b.order : 0;
      return left - right;
    });
}

/**
 * The AuthorizationPolicy contract, exposed as a single frozen object.
 * @type {{
 *   can: typeof can,
 *   allowedNavigation: typeof allowedNavigation,
 * }}
 */
export const authorizationPolicy = Object.freeze({
  can,
  allowedNavigation,
});

export default authorizationPolicy;