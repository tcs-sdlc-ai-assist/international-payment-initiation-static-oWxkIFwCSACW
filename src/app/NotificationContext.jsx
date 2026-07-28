/**
 * Notification/alert context provider and hook.
 *
 * NotificationContext provides a single React context for dispatching
 * accessible toast/alert notifications shared across features. It layers a
 * bounded, in-memory notification queue over an ARIA live-region model so
 * screen readers announce transient messages appropriately:
 *
 *   - A {@link NotificationProvider} owns a `useReducer` store of active
 *     notifications, exposes `notify` / `dismiss` / `clear` actions, and
 *     schedules auto-dismissal for non-critical notifications.
 *   - The {@link useNotifications} hook exposes the current `notifications`
 *     list, its `notify` / `dismiss` / `clear` actions, and the resolved
 *     `politeMessages` / `assertiveMessages` live-region buckets so a shared
 *     live-region host can announce them with the correct politeness.
 *
 * Every notification carries only sanitized, display-safe copy — never raw
 * domain objects or PII. Critical notifications map to an assertive live region
 * (`role=alert`) and are never auto-dismissed; all other severities map to a
 * polite live region (`aria-live=polite`) and auto-dismiss after a bounded
 * timeout. The provider never throws for expected failures — `notify` degrades
 * malformed input to a minimal, structurally-valid notification.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import PropTypes from 'prop-types';
import { generateOperationId } from '@/shared/mock/mockEnvelope';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Maximum number of active notifications retained in the bounded queue. */
const MAX_NOTIFICATIONS = 6;

/** Default auto-dismiss timeout, in milliseconds, for non-critical notifications. */
const DEFAULT_TIMEOUT_MS = 6000;

/** Minimum permitted auto-dismiss timeout, in milliseconds. */
const MIN_TIMEOUT_MS = 2000;

/** Maximum permitted auto-dismiss timeout, in milliseconds. */
const MAX_TIMEOUT_MS = 20000;

/** Maximum retained length of a sanitized notification title. */
const MAX_TITLE_LENGTH = 120;

/** Maximum retained length of a sanitized notification body. */
const MAX_BODY_LENGTH = 280;

/**
 * Supported notification severities.
 * @type {{
 *   INFO: 'info',
 *   SUCCESS: 'success',
 *   WARNING: 'warning',
 *   CRITICAL: 'critical',
 * }}
 */
export const NOTIFICATION_SEVERITIES = Object.freeze({
  INFO: 'info',
  SUCCESS: 'success',
  WARNING: 'warning',
  CRITICAL: 'critical',
});

/**
 * Notification action types dispatched to the reducer.
 * @type {{
 *   ADD: 'notification/add',
 *   DISMISS: 'notification/dismiss',
 *   CLEAR: 'notification/clear',
 * }}
 */
const NOTIFICATION_ACTIONS = Object.freeze({
  ADD: 'notification/add',
  DISMISS: 'notification/dismiss',
  CLEAR: 'notification/clear',
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
 * Normalizes an arbitrary value into a trimmed, length-bounded string.
 * @param {unknown} value - The raw value.
 * @param {number} maxLength - The maximum retained length.
 * @returns {string} A sanitized string (empty when unusable).
 */
function toText(value, maxLength) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return '';
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

/**
 * Resolves a supported notification severity, falling back to info.
 * @param {unknown} value - The candidate severity.
 * @returns {string} A valid severity from {@link NOTIFICATION_SEVERITIES}.
 */
function resolveSeverity(value) {
  const values = Object.values(NOTIFICATION_SEVERITIES);
  return typeof value === 'string' && values.includes(value)
    ? value
    : NOTIFICATION_SEVERITIES.INFO;
}

/**
 * Resolves a bounded auto-dismiss timeout, falling back to the default.
 * @param {unknown} value - The candidate timeout in milliseconds.
 * @returns {number} A bounded timeout in milliseconds.
 */
function resolveTimeout(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.min(Math.max(Math.trunc(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Determines whether a severity maps to the assertive live region.
 * @param {string} severity - A resolved severity.
 * @returns {boolean} `true` when the severity is critical.
 */
function isAssertive(severity) {
  return severity === NOTIFICATION_SEVERITIES.CRITICAL;
}

/**
 * Builds a sanitized notification from raw input, degrading malformed input to
 * a minimal, structurally-valid notification.
 * @param {{
 *   title?: string,
 *   body?: string,
 *   severity?: string,
 *   safeReasonCode?: string,
 *   timeoutMs?: number,
 *   id?: string,
 * }} input - The raw notification input.
 * @returns {{
 *   id: string,
 *   title: string,
 *   body: string,
 *   severity: string,
 *   safeReasonCode: string | null,
 *   assertive: boolean,
 *   autoDismiss: boolean,
 *   timeoutMs: number,
 * }} A sanitized notification.
 */
function buildNotification(input) {
  const source = isPlainObject(input) ? input : {};
  const severity = resolveSeverity(source.severity);
  const assertive = isAssertive(severity);
  const title = toText(source.title, MAX_TITLE_LENGTH);
  const body = toText(source.body, MAX_BODY_LENGTH);
  const safeReasonCode = toText(source.safeReasonCode, MAX_TITLE_LENGTH);
  const id = toText(source.id, MAX_TITLE_LENGTH) || generateOperationId();

  return {
    id,
    title,
    body: body.length > 0 ? body : title,
    severity,
    safeReasonCode: safeReasonCode.length > 0 ? safeReasonCode : null,
    assertive,
    autoDismiss: !assertive,
    timeoutMs: resolveTimeout(source.timeoutMs),
  };
}

/**
 * The notification-state reducer.
 * @param {{ notifications: Array<Record<string, unknown>> }} state - The current state.
 * @param {{
 *   type: string,
 *   notification?: Record<string, unknown>,
 *   id?: string,
 * }} action - The dispatched action.
 * @returns {{ notifications: Array<Record<string, unknown>> }} The next state.
 */
function notificationReducer(state, action) {
  switch (action.type) {
    case NOTIFICATION_ACTIONS.ADD: {
      if (!isPlainObject(action.notification)) {
        return state;
      }
      const filtered = state.notifications.filter(
        (item) => item.id !== action.notification.id,
      );
      const next = [...filtered, action.notification];
      const bounded =
        next.length > MAX_NOTIFICATIONS ? next.slice(next.length - MAX_NOTIFICATIONS) : next;
      return { notifications: bounded };
    }
    case NOTIFICATION_ACTIONS.DISMISS: {
      if (typeof action.id !== 'string' || action.id.length === 0) {
        return state;
      }
      return {
        notifications: state.notifications.filter((item) => item.id !== action.id),
      };
    }
    case NOTIFICATION_ACTIONS.CLEAR: {
      return { notifications: [] };
    }
    default:
      return state;
  }
}

/**
 * The notification context value shape.
 * @type {React.Context<{
 *   notifications: Array<Record<string, unknown>>,
 *   politeMessages: string[],
 *   assertiveMessages: string[],
 *   notify: (input: {
 *     title?: string,
 *     body?: string,
 *     severity?: string,
 *     safeReasonCode?: string,
 *     timeoutMs?: number,
 *     id?: string,
 *   }) => string,
 *   dismiss: (id: string) => void,
 *   clear: () => void,
 *   NOTIFICATION_SEVERITIES: typeof NOTIFICATION_SEVERITIES,
 * } | null>}
 */
const NotificationContext = createContext(null);

/**
 * Derives the polite/assertive live-region message buckets from the active
 * notifications, using each notification's sanitized copy.
 * @param {Array<Record<string, unknown>>} notifications - The active notifications.
 * @returns {{ politeMessages: string[], assertiveMessages: string[] }} The buckets.
 */
function deriveLiveRegions(notifications) {
  const politeMessages = [];
  const assertiveMessages = [];
  for (const notification of notifications) {
    const title = typeof notification.title === 'string' ? notification.title : '';
    const body = typeof notification.body === 'string' ? notification.body : '';
    const message = [title, body].filter((part) => part.length > 0).join('. ');
    if (message.length === 0) {
      continue;
    }
    if (notification.assertive === true) {
      assertiveMessages.push(message);
    } else {
      politeMessages.push(message);
    }
  }
  return { politeMessages, assertiveMessages };
}

/**
 * Provides the notification/alert context to descendant components.
 *
 * The provider owns a `useReducer` store of active notifications, exposes
 * `notify` / `dismiss` / `clear` actions, and schedules auto-dismissal for
 * non-critical notifications. Actions never throw for expected failures.
 *
 * @param {{ children: React.ReactNode }} props - The provider props.
 * @returns {React.ReactElement} The provider element.
 */
export function NotificationProvider({ children }) {
  const [state, dispatch] = useReducer(notificationReducer, { notifications: [] });

  /** @type {React.MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>} */
  const timersRef = useRef(new Map());

  const clearTimer = useCallback((id) => {
    const timers = timersRef.current;
    const handle = timers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id) => {
      if (typeof id !== 'string' || id.length === 0) {
        return;
      }
      clearTimer(id);
      dispatch({ type: NOTIFICATION_ACTIONS.DISMISS, id });
    },
    [clearTimer],
  );

  const notify = useCallback(
    (input) => {
      let notification;
      try {
        notification = buildNotification(input);
      } catch (error) {
        safeLogger.warn('NotificationContext: failed to build notification', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
        notification = buildNotification({});
      }

      clearTimer(notification.id);
      dispatch({ type: NOTIFICATION_ACTIONS.ADD, notification });

      if (notification.autoDismiss) {
        const handle = setTimeout(() => {
          timersRef.current.delete(notification.id);
          dispatch({ type: NOTIFICATION_ACTIONS.DISMISS, id: notification.id });
        }, notification.timeoutMs);
        timersRef.current.set(notification.id, handle);
      }

      return notification.id;
    },
    [clearTimer],
  );

  const clear = useCallback(() => {
    const timers = timersRef.current;
    for (const handle of timers.values()) {
      clearTimeout(handle);
    }
    timers.clear();
    dispatch({ type: NOTIFICATION_ACTIONS.CLEAR });
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const handle of timers.values()) {
        clearTimeout(handle);
      }
      timers.clear();
    };
  }, []);

  const { politeMessages, assertiveMessages } = useMemo(
    () => deriveLiveRegions(state.notifications),
    [state.notifications],
  );

  const value = useMemo(
    () => ({
      notifications: state.notifications,
      politeMessages,
      assertiveMessages,
      notify,
      dismiss,
      clear,
      NOTIFICATION_SEVERITIES,
    }),
    [state.notifications, politeMessages, assertiveMessages, notify, dismiss, clear],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

NotificationProvider.propTypes = {
  children: PropTypes.node,
};

/**
 * Returns the notification/alert context.
 *
 * Must be called within a {@link NotificationProvider}; it throws otherwise so
 * misuse is caught during development.
 *
 * @returns {{
 *   notifications: Array<Record<string, unknown>>,
 *   politeMessages: string[],
 *   assertiveMessages: string[],
 *   notify: (input: {
 *     title?: string,
 *     body?: string,
 *     severity?: string,
 *     safeReasonCode?: string,
 *     timeoutMs?: number,
 *     id?: string,
 *   }) => string,
 *   dismiss: (id: string) => void,
 *   clear: () => void,
 *   NOTIFICATION_SEVERITIES: typeof NOTIFICATION_SEVERITIES,
 * }} The notification context value.
 * @throws {Error} When used outside a {@link NotificationProvider}.
 */
export function useNotifications() {
  const context = useContext(NotificationContext);
  if (context === null) {
    throw new Error('useNotifications: must be used within a NotificationProvider.');
  }
  return context;
}

export default useNotifications;