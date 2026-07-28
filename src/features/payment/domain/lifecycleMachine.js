/**
 * Controlled payment lifecycle state machine.
 *
 * LifecycleMachine is a compiled, allow-list state machine governing the demo
 * payment lifecycle exercised by the payment initiation and operations flows
 * (SCRUM-814/818/819/820). Transitions are declared once as a frozen allow-list
 * and compiled into an index so every transition attempt is validated against a
 * closed set of permitted (state, action) pairs:
 *
 *   draft → validated → processing → {rejected | pending_review |
 *     repair_required | pending_approval | accepted}
 *
 * plus approval reject/resume, `sent_to_swift`/`acknowledged` progressions that
 * only apply on satisfactory paths, repair/review resumption back into
 * processing, and an operations-reset path back to a draft/validated baseline.
 *
 * The machine is intentionally conservative and demo-only:
 *
 *   - `canTransition(state, action)` and `transition(state, action, context)`
 *     validate an attempted transition against the compiled allow-list; an
 *     illegal transition is denied rather than applied.
 *   - Every applied transition produces a sanitized timeline event carrying only
 *     safe codes and masked-safe metadata — never PII.
 *   - `getTimeline(records)` replays a sequence of transition attempts into an
 *     ordered timeline for the operations view.
 *
 * All functions are pure with respect to their arguments (they never mutate the
 * caller's objects, never touch storage, and never throw for malformed input) —
 * they degrade to a discriminated `{ ok, ... }` result carrying a sanitized
 * reason code so callers can gate the UI safely. This is a client-side,
 * non-regulatory control and carries no server guarantee.
 */

import { demoClock } from '@/shared/time/demoClock';
import { generateOperationId } from '@/shared/mock/mockEnvelope';
import { safeLogger } from '@/shared/logging/safeLogger';

/**
 * Lifecycle states recognized by the machine.
 * @type {{
 *   DRAFT: 'draft',
 *   VALIDATED: 'validated',
 *   PROCESSING: 'processing',
 *   REJECTED: 'rejected',
 *   PENDING_REVIEW: 'pending_review',
 *   REPAIR_REQUIRED: 'repair_required',
 *   PENDING_APPROVAL: 'pending_approval',
 *   ACCEPTED: 'accepted',
 *   SENT_TO_SWIFT: 'sent_to_swift',
 *   ACKNOWLEDGED: 'acknowledged',
 * }}
 */
export const LIFECYCLE_STATES = Object.freeze({
  DRAFT: 'draft',
  VALIDATED: 'validated',
  PROCESSING: 'processing',
  REJECTED: 'rejected',
  PENDING_REVIEW: 'pending_review',
  REPAIR_REQUIRED: 'repair_required',
  PENDING_APPROVAL: 'pending_approval',
  ACCEPTED: 'accepted',
  SENT_TO_SWIFT: 'sent_to_swift',
  ACKNOWLEDGED: 'acknowledged',
});

/**
 * Lifecycle actions that drive transitions.
 * @type {{
 *   VALIDATE: 'validate',
 *   PROCESS: 'process',
 *   REJECT: 'reject',
 *   FLAG_REVIEW: 'flag_review',
 *   FLAG_REPAIR: 'flag_repair',
 *   REQUEST_APPROVAL: 'request_approval',
 *   ACCEPT: 'accept',
 *   APPROVE: 'approve',
 *   RESUME: 'resume',
 *   REPAIR: 'repair',
 *   SEND_TO_SWIFT: 'send_to_swift',
 *   ACKNOWLEDGE: 'acknowledge',
 *   RESET: 'reset',
 * }}
 */
export const LIFECYCLE_ACTIONS = Object.freeze({
  VALIDATE: 'validate',
  PROCESS: 'process',
  REJECT: 'reject',
  FLAG_REVIEW: 'flag_review',
  FLAG_REPAIR: 'flag_repair',
  REQUEST_APPROVAL: 'request_approval',
  ACCEPT: 'accept',
  APPROVE: 'approve',
  RESUME: 'resume',
  REPAIR: 'repair',
  SEND_TO_SWIFT: 'send_to_swift',
  ACKNOWLEDGE: 'acknowledge',
  RESET: 'reset',
});

/**
 * Safe reason codes surfaced by the lifecycle machine for gating and messaging.
 * @type {{
 *   TRANSITIONED: 'lifecycle.transitioned',
 *   ILLEGAL_TRANSITION: 'lifecycle.error.illegal_transition',
 *   UNKNOWN_STATE: 'lifecycle.error.unknown_state',
 *   UNKNOWN_ACTION: 'lifecycle.error.unknown_action',
 *   TERMINAL_STATE: 'lifecycle.error.terminal_state',
 *   INVALID_INPUT: 'lifecycle.error.invalid_input',
 * }}
 */
export const LIFECYCLE_REASON_CODES = Object.freeze({
  TRANSITIONED: 'lifecycle.transitioned',
  ILLEGAL_TRANSITION: 'lifecycle.error.illegal_transition',
  UNKNOWN_STATE: 'lifecycle.error.unknown_state',
  UNKNOWN_ACTION: 'lifecycle.error.unknown_action',
  TERMINAL_STATE: 'lifecycle.error.terminal_state',
  INVALID_INPUT: 'lifecycle.error.invalid_input',
});

/**
 * Terminal states from which no further transition is permitted.
 * @type {readonly string[]}
 */
const TERMINAL_STATES = Object.freeze([
  LIFECYCLE_STATES.REJECTED,
  LIFECYCLE_STATES.ACKNOWLEDGED,
]);

/**
 * The declarative transition allow-list. Each entry is a permitted
 * `(from, action) -> to` triple; any pair absent from this list is denied.
 * @type {ReadonlyArray<{ from: string, action: string, to: string }>}
 */
const TRANSITIONS = Object.freeze([
  // Draft → validated → processing.
  { from: LIFECYCLE_STATES.DRAFT, action: LIFECYCLE_ACTIONS.VALIDATE, to: LIFECYCLE_STATES.VALIDATED },
  { from: LIFECYCLE_STATES.VALIDATED, action: LIFECYCLE_ACTIONS.PROCESS, to: LIFECYCLE_STATES.PROCESSING },

  // Processing fan-out.
  { from: LIFECYCLE_STATES.PROCESSING, action: LIFECYCLE_ACTIONS.REJECT, to: LIFECYCLE_STATES.REJECTED },
  { from: LIFECYCLE_STATES.PROCESSING, action: LIFECYCLE_ACTIONS.FLAG_REVIEW, to: LIFECYCLE_STATES.PENDING_REVIEW },
  { from: LIFECYCLE_STATES.PROCESSING, action: LIFECYCLE_ACTIONS.FLAG_REPAIR, to: LIFECYCLE_STATES.REPAIR_REQUIRED },
  { from: LIFECYCLE_STATES.PROCESSING, action: LIFECYCLE_ACTIONS.REQUEST_APPROVAL, to: LIFECYCLE_STATES.PENDING_APPROVAL },
  { from: LIFECYCLE_STATES.PROCESSING, action: LIFECYCLE_ACTIONS.ACCEPT, to: LIFECYCLE_STATES.ACCEPTED },

  // Manual review resolution.
  { from: LIFECYCLE_STATES.PENDING_REVIEW, action: LIFECYCLE_ACTIONS.RESUME, to: LIFECYCLE_STATES.PROCESSING },
  { from: LIFECYCLE_STATES.PENDING_REVIEW, action: LIFECYCLE_ACTIONS.REJECT, to: LIFECYCLE_STATES.REJECTED },

  // Repair resolution.
  { from: LIFECYCLE_STATES.REPAIR_REQUIRED, action: LIFECYCLE_ACTIONS.REPAIR, to: LIFECYCLE_STATES.VALIDATED },
  { from: LIFECYCLE_STATES.REPAIR_REQUIRED, action: LIFECYCLE_ACTIONS.REJECT, to: LIFECYCLE_STATES.REJECTED },

  // Approval resolution.
  { from: LIFECYCLE_STATES.PENDING_APPROVAL, action: LIFECYCLE_ACTIONS.APPROVE, to: LIFECYCLE_STATES.ACCEPTED },
  { from: LIFECYCLE_STATES.PENDING_APPROVAL, action: LIFECYCLE_ACTIONS.REJECT, to: LIFECYCLE_STATES.REJECTED },
  { from: LIFECYCLE_STATES.PENDING_APPROVAL, action: LIFECYCLE_ACTIONS.RESUME, to: LIFECYCLE_STATES.PROCESSING },

  // Satisfactory settlement path only.
  { from: LIFECYCLE_STATES.ACCEPTED, action: LIFECYCLE_ACTIONS.SEND_TO_SWIFT, to: LIFECYCLE_STATES.SENT_TO_SWIFT },
  { from: LIFECYCLE_STATES.SENT_TO_SWIFT, action: LIFECYCLE_ACTIONS.ACKNOWLEDGE, to: LIFECYCLE_STATES.ACKNOWLEDGED },
  { from: LIFECYCLE_STATES.SENT_TO_SWIFT, action: LIFECYCLE_ACTIONS.FLAG_REPAIR, to: LIFECYCLE_STATES.REPAIR_REQUIRED },
  { from: LIFECYCLE_STATES.SENT_TO_SWIFT, action: LIFECYCLE_ACTIONS.REJECT, to: LIFECYCLE_STATES.REJECTED },

  // Operations reset back to a clean baseline.
  { from: LIFECYCLE_STATES.PENDING_REVIEW, action: LIFECYCLE_ACTIONS.RESET, to: LIFECYCLE_STATES.DRAFT },
  { from: LIFECYCLE_STATES.REPAIR_REQUIRED, action: LIFECYCLE_ACTIONS.RESET, to: LIFECYCLE_STATES.DRAFT },
  { from: LIFECYCLE_STATES.PENDING_APPROVAL, action: LIFECYCLE_ACTIONS.RESET, to: LIFECYCLE_STATES.DRAFT },
  { from: LIFECYCLE_STATES.ACCEPTED, action: LIFECYCLE_ACTIONS.RESET, to: LIFECYCLE_STATES.DRAFT },
]);

/** Set of known lifecycle states for fast membership checks. */
const KNOWN_STATES = new Set(Object.values(LIFECYCLE_STATES));

/** Set of known lifecycle actions for fast membership checks. */
const KNOWN_ACTIONS = new Set(Object.values(LIFECYCLE_ACTIONS));

/**
 * Builds the compiled transition index keyed by `${from}|${action}`.
 * @returns {Map<string, { from: string, action: string, to: string }>} The index.
 */
function compileTransitions() {
  const index = new Map();
  for (const transition of TRANSITIONS) {
    index.set(`${transition.from}|${transition.action}`, transition);
  }
  return index;
}

/** The compiled transition index, built once at module load. */
const TRANSITION_INDEX = compileTransitions();

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
 * Sanitizes an arbitrary metadata object into a bounded record of safe
 * primitives so no PII or nested structure leaks into a timeline event.
 * @param {unknown} metadata - The raw metadata.
 * @returns {Record<string, string | number | boolean> | undefined} Safe metadata.
 */
function sanitizeMetadata(metadata) {
  if (!isPlainObject(metadata)) {
    return undefined;
  }
  const output = {};
  let count = 0;
  for (const key of Object.keys(metadata)) {
    if (count >= 12) {
      break;
    }
    const value = metadata[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      output[key] = trimmed.length > 64 ? `${trimmed.slice(0, 64)}…` : trimmed;
      count += 1;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      output[key] = value;
      count += 1;
    } else if (typeof value === 'boolean') {
      output[key] = value;
      count += 1;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

/**
 * Determines whether a state is terminal (no further transition permitted).
 * @param {string} state - The lifecycle state.
 * @returns {boolean} `true` when the state is terminal.
 */
export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * Returns the ordered list of actions permitted from a given state.
 * @param {string} state - The lifecycle state.
 * @returns {string[]} The permitted action identifiers (may be empty).
 */
export function getAllowedActions(state) {
  const source = toText(state);
  if (!KNOWN_STATES.has(source)) {
    return [];
  }
  return TRANSITIONS.filter((transition) => transition.from === source).map(
    (transition) => transition.action,
  );
}

/**
 * Builds a discriminated failure result carrying a sanitized reason code.
 * @param {string} safeReasonCode - The sanitized reason code.
 * @returns {{ ok: false, safeReasonCode: string }} A failure result.
 */
function fail(safeReasonCode) {
  return { ok: false, safeReasonCode };
}

/**
 * Determines whether a transition is permitted by the compiled allow-list.
 *
 * Deny-by-default: unknown states or actions, terminal states, and any pair
 * absent from the allow-list all resolve to a discriminated failure.
 *
 * @param {string} state - The current lifecycle state.
 * @param {string} action - The attempted action.
 * @returns {{ ok: true, from: string, action: string, to: string }
 *   | { ok: false, safeReasonCode: string }} A discriminated result.
 */
export function canTransition(state, action) {
  const from = toText(state);
  const act = toText(action);

  if (!KNOWN_STATES.has(from)) {
    return fail(LIFECYCLE_REASON_CODES.UNKNOWN_STATE);
  }
  if (!KNOWN_ACTIONS.has(act)) {
    return fail(LIFECYCLE_REASON_CODES.UNKNOWN_ACTION);
  }
  if (isTerminal(from)) {
    return fail(LIFECYCLE_REASON_CODES.TERMINAL_STATE);
  }

  const transition = TRANSITION_INDEX.get(`${from}|${act}`);
  if (!transition) {
    return fail(LIFECYCLE_REASON_CODES.ILLEGAL_TRANSITION);
  }

  return { ok: true, from, action: act, to: transition.to };
}

/**
 * Builds a sanitized timeline event describing an applied transition.
 * @param {{ from: string, action: string, to: string }} transition - The transition.
 * @param {{
 *   actorId?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, unknown>,
 *   occurredAt?: string,
 *   eventId?: string,
 * }} context - The transition context.
 * @returns {{
 *   eventId: string,
 *   occurredAt: string,
 *   fromState: string,
 *   toState: string,
 *   action: string,
 *   actorId: string | null,
 *   safeReasonCode: string,
 *   metadata: Record<string, string | number | boolean> | null,
 * }} A sanitized timeline event.
 */
function buildTimelineEvent(transition, context) {
  const source = isPlainObject(context) ? context : {};
  const actorId = toText(source.actorId);
  const safeReasonCode = toText(source.safeReasonCode) || LIFECYCLE_REASON_CODES.TRANSITIONED;
  const metadata = sanitizeMetadata(source.metadata);

  return {
    eventId: toText(source.eventId) || generateOperationId(),
    occurredAt: toText(source.occurredAt) || demoClock.now(),
    fromState: transition.from,
    toState: transition.to,
    action: transition.action,
    actorId: actorId.length > 0 ? actorId : null,
    safeReasonCode,
    metadata: metadata ?? null,
  };
}

/**
 * Validates and applies a lifecycle transition, producing the resulting state
 * and a sanitized timeline event.
 *
 * Deny-by-default: an illegal transition is denied rather than applied. Never
 * mutates its arguments and never throws — malformed input degrades to a
 * discriminated failure result carrying a sanitized reason code.
 *
 * @param {string} state - The current lifecycle state.
 * @param {string} action - The attempted action.
 * @param {{
 *   actorId?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, unknown>,
 *   occurredAt?: string,
 *   eventId?: string,
 * }} [context] - Optional transition context (attribution only).
 * @returns {{
 *   ok: true,
 *   fromState: string,
 *   toState: string,
 *   action: string,
 *   terminal: boolean,
 *   event: {
 *     eventId: string,
 *     occurredAt: string,
 *     fromState: string,
 *     toState: string,
 *     action: string,
 *     actorId: string | null,
 *     safeReasonCode: string,
 *     metadata: Record<string, string | number | boolean> | null,
 *   },
 *   safeReasonCode: string,
 * } | { ok: false, safeReasonCode: string }} A discriminated result.
 */
export function transition(state, action, context) {
  const evaluation = canTransition(state, action);
  if (!evaluation.ok) {
    safeLogger.warn('lifecycleMachine: rejected illegal transition', {
      safeReasonCode: evaluation.safeReasonCode,
    });
    return fail(evaluation.safeReasonCode);
  }

  const event = buildTimelineEvent(
    { from: evaluation.from, action: evaluation.action, to: evaluation.to },
    context,
  );

  return {
    ok: true,
    fromState: evaluation.from,
    toState: evaluation.to,
    action: evaluation.action,
    terminal: isTerminal(evaluation.to),
    event,
    safeReasonCode: LIFECYCLE_REASON_CODES.TRANSITIONED,
  };
}

/**
 * Replays a sequence of transition attempts into an ordered timeline for the
 * operations view.
 *
 * Each record advances the current state when its transition is legal; illegal
 * or malformed records are skipped and recorded as denied entries rather than
 * aborting the replay. Never mutates its arguments and never throws.
 *
 * @param {Array<{
 *   action: string,
 *   actorId?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, unknown>,
 *   occurredAt?: string,
 *   eventId?: string,
 * }>} records - The ordered transition attempts.
 * @param {{ initialState?: string }} [options] - Optional replay options.
 * @returns {{
 *   ok: boolean,
 *   finalState: string,
 *   events: Array<Record<string, unknown>>,
 *   denied: Array<{ action: string, fromState: string, safeReasonCode: string }>,
 * }} The replayed timeline.
 */
export function getTimeline(records, options) {
  const source = isPlainObject(options) ? options : {};
  const requestedInitial = toText(source.initialState);
  let currentState = KNOWN_STATES.has(requestedInitial)
    ? requestedInitial
    : LIFECYCLE_STATES.DRAFT;

  const events = [];
  const denied = [];

  if (!Array.isArray(records)) {
    return { ok: true, finalState: currentState, events, denied };
  }

  for (const record of records) {
    if (!isPlainObject(record)) {
      denied.push({
        action: '',
        fromState: currentState,
        safeReasonCode: LIFECYCLE_REASON_CODES.INVALID_INPUT,
      });
      continue;
    }

    const result = transition(currentState, record.action, {
      actorId: record.actorId,
      safeReasonCode: record.safeReasonCode,
      metadata: record.metadata,
      occurredAt: record.occurredAt,
      eventId: record.eventId,
    });

    if (!result.ok) {
      denied.push({
        action: toText(record.action),
        fromState: currentState,
        safeReasonCode: result.safeReasonCode,
      });
      continue;
    }

    events.push(result.event);
    currentState = result.toState;
  }

  return { ok: true, finalState: currentState, events, denied };
}

/**
 * The lifecycle machine contract, exposed as a single frozen object.
 * @type {{
 *   canTransition: typeof canTransition,
 *   transition: typeof transition,
 *   getTimeline: typeof getTimeline,
 *   getAllowedActions: typeof getAllowedActions,
 *   isTerminal: typeof isTerminal,
 *   LIFECYCLE_STATES: typeof LIFECYCLE_STATES,
 *   LIFECYCLE_ACTIONS: typeof LIFECYCLE_ACTIONS,
 *   LIFECYCLE_REASON_CODES: typeof LIFECYCLE_REASON_CODES,
 * }}
 */
export const lifecycleMachine = Object.freeze({
  canTransition,
  transition,
  getTimeline,
  getAllowedActions,
  isTerminal,
  LIFECYCLE_STATES,
  LIFECYCLE_ACTIONS,
  LIFECYCLE_REASON_CODES,
});

export default lifecycleMachine;