/**
 * Capability-derived navigation builder.
 *
 * NavigationService is the single source of truth for building
 * role/capability-appropriate navigation from the bundled `navigation.json`
 * fixture. It layers atop the {@link authorizationPolicy} so menu visibility and
 * route guards derive from one deny-by-default policy:
 *
 *   - `buildNavigation(session)` returns the sanitized, ordered navigation items
 *     the acting session is entitled to see, grouped for display.
 *   - `buildGroups(session)` returns the allowed items partitioned into their
 *     display groups (from the fixture's `groups`), each ordered by the group's
 *     `order` field.
 *   - `isRouteAllowed(session, route)` answers whether a session may reach a
 *     given route, so route guards and menu rendering share one decision.
 *   - `resolveDefaultRoute(session)` returns the first allowed route so the app
 *     can land an authenticated user on a page they can actually see.
 *
 * This is a demo-only, non-regulatory policy: it enforces client-side
 * visibility and gating and carries no server guarantee. Items never carry PII —
 * only safe labels, descriptions, routes, and capability requirements.
 */

import { authorizationPolicy } from '@/features/access/services/authorizationPolicy';
import { fixtureRegistry, FIXTURE_IDS } from '@/shared/fixtures/fixtureRegistry';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Fallback route used when a session has no allowed navigation. */
const FALLBACK_ROUTE = '/';

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
 * Reads the display groups from the bundled navigation fixture.
 * @returns {Array<Record<string, unknown>>} The group records (may be empty).
 */
function readGroups() {
  const fixture = fixtureRegistry.getFixture(FIXTURE_IDS.NAVIGATION);
  if (!fixture || !Array.isArray(fixture.groups)) {
    return [];
  }
  return fixture.groups.filter(
    (group) => group !== null && typeof group === 'object' && !Array.isArray(group),
  );
}

/**
 * Builds a sanitized, display-safe navigation item from a fixture record.
 * @param {Record<string, unknown>} item - The raw navigation record.
 * @returns {{
 *   id: string,
 *   label: string,
 *   description: string,
 *   route: string,
 *   icon: string | null,
 *   order: number,
 *   group: string | null,
 *   requiredCapabilities: string[],
 *   exact: boolean,
 * }} The sanitized navigation item.
 */
function toDisplayItem(item) {
  return {
    id: typeof item.id === 'string' ? item.id : '',
    label: typeof item.label === 'string' ? item.label : '',
    description: typeof item.description === 'string' ? item.description : '',
    route: typeof item.route === 'string' ? item.route : '',
    icon: typeof item.icon === 'string' ? item.icon : null,
    order: typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : 0,
    group: typeof item.group === 'string' ? item.group : null,
    requiredCapabilities: toStringArray(item.required_capabilities),
    exact: item.exact === true,
  };
}

/**
 * Returns the sanitized, ordered navigation items the acting session is
 * entitled to see, derived from {@link authorizationPolicy.allowedNavigation}.
 *
 * Deny-by-default: an item is only included when the session holds every
 * capability listed in its `required_capabilities`.
 *
 * @param {{ capabilities?: string[], roles?: string[] } | null | undefined} session
 *   The acting session claim.
 * @returns {Array<Record<string, unknown>>} The allowed navigation items.
 */
export function buildNavigation(session) {
  if (!session || typeof session !== 'object') {
    return [];
  }

  const allowed = authorizationPolicy.allowedNavigation(session);
  return allowed
    .map((item) => toDisplayItem(item))
    .filter((item) => item.id.length > 0 && item.route.length > 0);
}

/**
 * Returns the allowed navigation items partitioned into their display groups.
 *
 * Groups are ordered by their fixture `order` field, and their items retain the
 * order produced by {@link buildNavigation}. Empty groups (no allowed items) are
 * omitted so the UI never renders an empty section.
 *
 * @param {{ capabilities?: string[], roles?: string[] } | null | undefined} session
 *   The acting session claim.
 * @returns {Array<{
 *   id: string,
 *   label: string,
 *   order: number,
 *   items: Array<Record<string, unknown>>,
 * }>} The allowed navigation groups.
 */
export function buildGroups(session) {
  const items = buildNavigation(session);
  if (items.length === 0) {
    return [];
  }

  const groups = readGroups();
  const groupOrder = new Map();
  const groupLabel = new Map();
  for (const group of groups) {
    const id = typeof group.id === 'string' ? group.id : undefined;
    if (id === undefined) {
      continue;
    }
    groupOrder.set(id, typeof group.order === 'number' && Number.isFinite(group.order) ? group.order : 0);
    groupLabel.set(id, typeof group.label === 'string' ? group.label : id);
  }

  const buckets = new Map();
  for (const item of items) {
    const groupId = typeof item.group === 'string' && item.group.length > 0 ? item.group : 'ungrouped';
    if (!buckets.has(groupId)) {
      buckets.set(groupId, []);
    }
    buckets.get(groupId).push(item);
  }

  return Array.from(buckets.entries())
    .map(([id, groupItems]) => ({
      id,
      label: groupLabel.has(id) ? groupLabel.get(id) : id,
      order: groupOrder.has(id) ? groupOrder.get(id) : Number.MAX_SAFE_INTEGER,
      items: groupItems,
    }))
    .sort((a, b) => a.order - b.order);
}

/**
 * Determines whether a session may reach a given route, so route guards and
 * menu rendering share one decision.
 *
 * A route is allowed when it exactly matches an allowed item's route, or when a
 * non-exact allowed item's route is a path prefix of the requested route.
 *
 * @param {{ capabilities?: string[], roles?: string[] } | null | undefined} session
 *   The acting session claim.
 * @param {string} route - The requested route.
 * @returns {boolean} `true` when the session may reach the route.
 */
export function isRouteAllowed(session, route) {
  if (typeof route !== 'string' || route.length === 0) {
    return false;
  }

  const items = buildNavigation(session);
  if (items.length === 0) {
    return false;
  }

  return items.some((item) => {
    if (item.route === route) {
      return true;
    }
    if (item.exact !== true) {
      return route === item.route || route.startsWith(`${item.route}/`);
    }
    return false;
  });
}

/**
 * Resolves the first allowed route for a session so the app can land an
 * authenticated user on a page they can actually see.
 *
 * @param {{ capabilities?: string[], roles?: string[] } | null | undefined} session
 *   The acting session claim.
 * @returns {string} The first allowed route, or a safe fallback.
 */
export function resolveDefaultRoute(session) {
  const items = buildNavigation(session);
  if (items.length === 0) {
    safeLogger.warn('navigationService: no allowed navigation; using fallback route');
    return FALLBACK_ROUTE;
  }
  return items[0].route;
}

/**
 * The NavigationService contract, exposed as a single frozen object.
 * @type {{
 *   buildNavigation: typeof buildNavigation,
 *   buildGroups: typeof buildGroups,
 *   isRouteAllowed: typeof isRouteAllowed,
 *   resolveDefaultRoute: typeof resolveDefaultRoute,
 * }}
 */
export const navigationService = Object.freeze({
  buildNavigation,
  buildGroups,
  isRouteAllowed,
  resolveDefaultRoute,
});

export default navigationService;