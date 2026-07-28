/**
 * Sanitized diagnostic logging wrapper.
 *
 * SafeLogger is the only permitted logging interface in the
 * intl-payment-initiation app (enforced by ESLint's `no-console` rule, which
 * allows only `console.warn`/`console.error`). It accepts a short message and
 * an optional context of safe primitives and sanitized codes. Raw domain
 * objects, nested structures, and anything resembling PII are stripped or
 * redacted before ever reaching the console.
 *
 * In production builds (when {@link import.meta.env.PROD} is true) informational
 * and debug output is suppressed entirely; warnings and errors are still
 * emitted but only ever carry sanitized data.
 */

import { ENV } from '@/shared/config/env';

/** Whether the app is running in a production build. */
const IS_PRODUCTION = Boolean(import.meta.env.PROD);

/** Maximum length of a logged message before truncation. */
const MAX_MESSAGE_LENGTH = 200;

/** Maximum length of a sanitized string value before truncation. */
const MAX_VALUE_LENGTH = 120;

/** Maximum number of context keys retained after sanitization. */
const MAX_CONTEXT_KEYS = 20;

/** Placeholder emitted when a value is rejected for being unsafe. */
const REDACTED = '[redacted]';

/**
 * Keys whose values are always redacted regardless of their type, because they
 * commonly carry PII or sensitive material.
 */
const SENSITIVE_KEY_PATTERN =
  /(pan|iban|bic|swift|account|card|cvv|cvc|secret|password|token|otp|pin|ssn|email|phone|name|address|dob|birth|auth)/i;

/** Matches keys that are considered safe, sanitized codes/identifiers. */
const SAFE_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;

/** Log severity levels, ordered from most to least verbose. */
const LEVELS = Object.freeze({
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
});

/**
 * Coerces an arbitrary message into a safe, trimmed, length-bounded string.
 * @param {unknown} message - The raw message.
 * @returns {string} A sanitized message string.
 */
function sanitizeMessage(message) {
  const text = typeof message === 'string' ? message : String(message ?? '');
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return '(empty message)';
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return `${trimmed.slice(0, MAX_MESSAGE_LENGTH)}…`;
  }
  return trimmed;
}

/**
 * Sanitizes a single primitive value, rejecting anything unsafe.
 * @param {unknown} value - The raw value.
 * @returns {string | number | boolean | null} A safe primitive, or a redaction marker.
 */
function sanitizeValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const type = typeof value;
  if (type === 'boolean') {
    return value;
  }
  if (type === 'number') {
    return Number.isFinite(value) ? value : REDACTED;
  }
  if (type === 'bigint') {
    return `${value.toString()}n`;
  }
  if (type === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return '';
    }
    return trimmed.length > MAX_VALUE_LENGTH ? `${trimmed.slice(0, MAX_VALUE_LENGTH)}…` : trimmed;
  }
  // Objects, arrays, functions, symbols and other complex types are rejected.
  return REDACTED;
}

/**
 * Sanitizes a flat context object into a safe, bounded record of primitives.
 * Nested objects/arrays and sensitive keys are redacted.
 * @param {unknown} context - The raw context.
 * @returns {Record<string, string | number | boolean | null> | undefined}
 *   A sanitized context, or `undefined` when there is nothing safe to log.
 */
function sanitizeContext(context) {
  if (context === null || context === undefined) {
    return undefined;
  }
  if (typeof context !== 'object' || Array.isArray(context)) {
    return { value: sanitizeValue(context) };
  }

  const output = {};
  let count = 0;
  for (const key of Object.keys(context)) {
    if (count >= MAX_CONTEXT_KEYS) {
      break;
    }
    if (!SAFE_KEY_PATTERN.test(key)) {
      continue;
    }
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = REDACTED;
      count += 1;
      continue;
    }
    output[key] = sanitizeValue(context[key]);
    count += 1;
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

/**
 * Emits a sanitized log entry to the appropriate console channel.
 * @param {string} level - One of {@link LEVELS}.
 * @param {unknown} message - The raw message.
 * @param {unknown} [context] - Optional raw context of safe primitives.
 * @returns {void}
 */
function emit(level, message, context) {
  // Suppress verbose output entirely in production builds.
  if (IS_PRODUCTION && (level === LEVELS.DEBUG || level === LEVELS.INFO)) {
    return;
  }

  const safeMessage = sanitizeMessage(message);
  const safeContext = sanitizeContext(context);
  const prefix = `[${ENV.buildLabel}] ${safeMessage}`;

  // Only console.warn and console.error are permitted by ESLint, so all
  // levels are routed through those two channels.
  if (level === LEVELS.ERROR) {
    if (safeContext) {
      console.error(prefix, safeContext);
    } else {
      console.error(prefix);
    }
    return;
  }

  if (safeContext) {
    console.warn(prefix, safeContext);
  } else {
    console.warn(prefix);
  }
}

/**
 * The sanitized logging API, exposed as a single frozen object.
 * @type {{
 *   debug: (message: unknown, context?: unknown) => void,
 *   info: (message: unknown, context?: unknown) => void,
 *   warn: (message: unknown, context?: unknown) => void,
 *   error: (message: unknown, context?: unknown) => void,
 * }}
 */
export const safeLogger = Object.freeze({
  /**
   * Logs a debug-level entry (suppressed in production).
   * @param {unknown} message - The raw message.
   * @param {unknown} [context] - Optional safe primitive context.
   * @returns {void}
   */
  debug(message, context) {
    emit(LEVELS.DEBUG, message, context);
  },
  /**
   * Logs an info-level entry (suppressed in production).
   * @param {unknown} message - The raw message.
   * @param {unknown} [context] - Optional safe primitive context.
   * @returns {void}
   */
  info(message, context) {
    emit(LEVELS.INFO, message, context);
  },
  /**
   * Logs a warning-level entry.
   * @param {unknown} message - The raw message.
   * @param {unknown} [context] - Optional safe primitive context.
   * @returns {void}
   */
  warn(message, context) {
    emit(LEVELS.WARN, message, context);
  },
  /**
   * Logs an error-level entry.
   * @param {unknown} message - The raw message.
   * @param {unknown} [context] - Optional safe primitive context.
   * @returns {void}
   */
  error(message, context) {
    emit(LEVELS.ERROR, message, context);
  },
});

export default safeLogger;