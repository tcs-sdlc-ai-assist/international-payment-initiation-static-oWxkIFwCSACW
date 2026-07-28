/**
 * Payment status lifecycle timeline.
 *
 * StatusTimeline is a presentational, accessible component that renders the
 * simulated payment lifecycle as an ordered, chronological timeline (SCRUM-818).
 * It consumes the sanitized transition events produced by the
 * {@link lifecycleMachine} (via {@link lifecycleMachine.getTimeline}) — or a
 * caller-supplied list of already-resolved timeline events — and renders each
 * transition with its resolved lifecycle state, a from/to state pair, a
 * timestamp, and a semantic status badge:
 *
 *   draft → validated → processing → {rejected | pending_review |
 *     repair_required | pending_approval | accepted} → sent_to_swift →
 *     acknowledged
 *
 * Each entry surfaces a demo-safe, simulated label so the demonstration nature
 * of the lifecycle is always clear; states are conveyed by both a badge icon and
 * text — never by color alone. The component renders only sanitized, masked-safe
 * copy — never PII — and never reads or mutates application state beyond its own
 * presentational rendering. It degrades gracefully: a missing or malformed
 * events list resolves to an accessible empty state, and any raw transition
 * records supplied via `records` are replayed through the lifecycle machine so
 * illegal transitions are never rendered as if they occurred.
 */

import { useMemo } from 'react';
import PropTypes from 'prop-types';
import {
  lifecycleMachine,
  LIFECYCLE_STATES,
} from '@/features/payment/domain/lifecycleMachine';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { cn } from '@/shared/ui/cn';

/** Persistent, demo-safe simulated-lifecycle disclaimer copy. */
const SIMULATED_LIFECYCLE_NOTICE =
  'This lifecycle timeline is simulated and for demonstration only. Every transition, timestamp, and state shown here is fabricated — no real payment processing, approval, or settlement occurs.';

/**
 * Human-readable labels for each supported lifecycle state.
 * @type {Record<string, string>}
 */
const STATE_LABELS = Object.freeze({
  [LIFECYCLE_STATES.DRAFT]: 'Draft',
  [LIFECYCLE_STATES.VALIDATED]: 'Validated',
  [LIFECYCLE_STATES.PROCESSING]: 'Processing',
  [LIFECYCLE_STATES.REJECTED]: 'Rejected',
  [LIFECYCLE_STATES.PENDING_REVIEW]: 'Pending review',
  [LIFECYCLE_STATES.REPAIR_REQUIRED]: 'Repair required',
  [LIFECYCLE_STATES.PENDING_APPROVAL]: 'Pending approval',
  [LIFECYCLE_STATES.ACCEPTED]: 'Accepted',
  [LIFECYCLE_STATES.SENT_TO_SWIFT]: 'Sent to SWIFT',
  [LIFECYCLE_STATES.ACKNOWLEDGED]: 'Acknowledged',
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
 * Formats a state/action identifier into a readable label.
 * @param {unknown} value - The raw identifier.
 * @returns {string} A human-readable label.
 */
function toLabel(value) {
  const text = toText(value);
  if (text.length === 0) {
    return '—';
  }
  if (Object.prototype.hasOwnProperty.call(STATE_LABELS, text)) {
    return STATE_LABELS[text];
  }
  return text
    .split(/[._-]/)
    .map((part) => (part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/**
 * Resolves a badge tone for a lifecycle state value.
 * @param {string} state - The lifecycle state.
 * @returns {string} A tone from {@link STATUS_TONES}.
 */
function stateTone(state) {
  switch (state) {
    case LIFECYCLE_STATES.ACKNOWLEDGED:
    case LIFECYCLE_STATES.ACCEPTED:
      return STATUS_TONES.SUCCESS;
    case LIFECYCLE_STATES.REJECTED:
      return STATUS_TONES.CRITICAL;
    case LIFECYCLE_STATES.PENDING_REVIEW:
    case LIFECYCLE_STATES.REPAIR_REQUIRED:
    case LIFECYCLE_STATES.PENDING_APPROVAL:
      return STATUS_TONES.WARNING;
    case LIFECYCLE_STATES.PROCESSING:
    case LIFECYCLE_STATES.VALIDATED:
    case LIFECYCLE_STATES.SENT_TO_SWIFT:
      return STATUS_TONES.INFO;
    case LIFECYCLE_STATES.DRAFT:
    default:
      return STATUS_TONES.NEUTRAL;
  }
}

/**
 * Normalizes a raw timeline event into a sanitized, display-safe entry.
 * @param {unknown} event - The raw timeline event.
 * @param {number} index - The event index (used to derive a stable key).
 * @returns {{
 *   eventId: string,
 *   occurredAt: string,
 *   fromState: string,
 *   toState: string,
 *   action: string,
 *   safeReasonCode: string,
 * } | null} A sanitized entry, or `null`.
 */
function toEntry(event, index) {
  if (!isPlainObject(event)) {
    return null;
  }
  const toState = toText(event.toState);
  if (toState.length === 0) {
    return null;
  }
  return {
    eventId: toText(event.eventId) || `event-${index}`,
    occurredAt: toText(event.occurredAt),
    fromState: toText(event.fromState),
    toState,
    action: toText(event.action),
    safeReasonCode: toText(event.safeReasonCode),
  };
}

/**
 * Renders the payment status lifecycle timeline.
 *
 * The component renders a supplied list of sanitized timeline `events`, or
 * replays a list of raw transition `records` through the lifecycle machine so
 * only legal transitions appear. Each entry surfaces its resolved state, a
 * from/to pair, a timestamp, and a semantic badge. A missing or empty timeline
 * degrades to an accessible empty state, and a persistent simulated-lifecycle
 * disclaimer makes the demo nature of the timeline clear.
 *
 * @param {{
 *   events?: Array<Record<string, unknown>>,
 *   records?: Array<Record<string, unknown>>,
 *   initialState?: string,
 *   className?: string,
 * }} props - The status timeline props.
 * @returns {React.ReactElement} The status timeline element.
 */
export function StatusTimeline({ events, records, initialState, className }) {
  const entries = useMemo(() => {
    if (Array.isArray(events)) {
      return events
        .map((event, index) => toEntry(event, index))
        .filter((entry) => entry !== null);
    }

    if (Array.isArray(records)) {
      let replayed;
      try {
        replayed = lifecycleMachine.getTimeline(records, {
          initialState: toText(initialState) || undefined,
        });
      } catch {
        return [];
      }
      const resolvedEvents = Array.isArray(replayed.events) ? replayed.events : [];
      return resolvedEvents
        .map((event, index) => toEntry(event, index))
        .filter((entry) => entry !== null);
    }

    return [];
  }, [events, records, initialState]);

  const hasEntries = entries.length > 0;

  return (
    <section
      aria-labelledby="status-timeline-heading"
      className={cn('flex flex-col gap-6', className)}
    >
      <div className="flex flex-col gap-1">
        <h2 id="status-timeline-heading" className="text-2xl font-medium text-primary-blue-700">
          Status timeline
        </h2>
        <p className="text-sm text-body">
          Review the simulated lifecycle of this payment. Each transition is shown in order with a
          demonstration timestamp and state.
        </p>
      </div>

      <Alert severity={ALERT_SEVERITIES.INFO} title="Simulated lifecycle only">
        {SIMULATED_LIFECYCLE_NOTICE}
      </Alert>

      {!hasEntries ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="No timeline available">
          There are no recorded lifecycle transitions to display for this payment. Transitions will
          appear here as the simulated payment progresses.
        </Alert>
      ) : (
        <ol className="flex flex-col gap-4">
          {entries.map((entry, index) => (
            <li
              key={entry.eventId}
              className="flex flex-col gap-2 rounded-md border border-primary-blue-100 bg-white p-4 sm:flex-row sm:items-start sm:gap-4"
            >
              <div className="flex items-center gap-3 sm:flex-col sm:items-center sm:gap-1">
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary-blue-500 text-xs font-medium text-white"
                >
                  {index + 1}
                </span>
                <span className="sr-only">{`Step ${index + 1}`}</span>
              </div>

              <div className="flex flex-1 flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <StatusBadge tone={stateTone(entry.toState)}>
                    {toLabel(entry.toState)}
                  </StatusBadge>
                  {entry.occurredAt.length > 0 ? (
                    <span className="text-xs text-body">{entry.occurredAt}</span>
                  ) : null}
                </div>

                <dl className="flex flex-col gap-1 text-sm text-body sm:flex-row sm:flex-wrap sm:gap-6">
                  <div className="flex gap-2">
                    <dt className="font-medium text-primary-blue-700">From</dt>
                    <dd>{toLabel(entry.fromState)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium text-primary-blue-700">To</dt>
                    <dd>{toLabel(entry.toState)}</dd>
                  </div>
                  {entry.action.length > 0 ? (
                    <div className="flex gap-2">
                      <dt className="font-medium text-primary-blue-700">Action</dt>
                      <dd>{toLabel(entry.action)}</dd>
                    </div>
                  ) : null}
                </dl>

                {entry.safeReasonCode.length > 0 ? (
                  <p className="text-xs text-body">{toLabel(entry.safeReasonCode)}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

StatusTimeline.propTypes = {
  events: PropTypes.arrayOf(PropTypes.object),
  records: PropTypes.arrayOf(PropTypes.object),
  initialState: PropTypes.string,
  className: PropTypes.string,
};

export default StatusTimeline;