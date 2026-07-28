/**
 * ISO 20022 / SWIFT message preview component.
 *
 * MessagePreview is the presentational surface that renders the representative
 * ISO 20022 message previews produced for a payment (SCRUM-814/818): the
 * pain.001 customer-credit-transfer initiation, the pacs.008 FI-to-FI customer
 * credit transfer, and the optional, linked pacs.009 cover-payment message. It
 * consumes the sanitized, masked preview set built by the {@link messageBuilder}
 * (via the {@link paymentFacade}) and renders it as structured React elements —
 * grouped, tagged lines — never as parsed or serialized XML:
 *
 *   - Each message is rendered as a labeled section with its schema-validation
 *     state surfaced via a {@link StatusBadge} so a reviewer can see at a glance
 *     whether the aggregate satisfies the applicable CBPR+ rule set.
 *   - Field-level lines pair each ISO 20022 tag path with its masked value; the
 *     cover (pacs.009) section is rendered only when the resolved route requires
 *     it, and is otherwise omitted.
 *   - When the schema state is invalid, the sanitized field-level issues are
 *     surfaced so the underlying capture flow can be corrected.
 *
 * The component renders only sanitized, masked copy — never raw PII beyond the
 * masked values the message builder produces — and never reads or mutates
 * application state beyond its own presentational rendering. It carries a
 * persistent no-transmission disclaimer so the demo nature of the preview is
 * always clear, and degrades gracefully: a missing or malformed preview set
 * resolves to an accessible empty state so the surrounding flow can gate the UI
 * safely.
 */

import { useMemo } from 'react';
import PropTypes from 'prop-types';
import {
  MESSAGE_TYPES,
  VALIDATION_STATES,
} from '@/features/payment/domain/messageBuilder';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { cn } from '@/shared/ui/cn';

/** Persistent, demo-safe no-transmission disclaimer copy. */
const NO_TRANSMISSION_DISCLAIMER =
  'This is a representative ISO 20022 message preview for demonstration only. No message is transmitted, no SWIFT network is contacted, and no funds move. Field values are masked and never carry real routing instructions or account holder identity.';

/**
 * Human-readable labels for each supported ISO 20022 message type.
 * @type {Record<string, string>}
 */
const MESSAGE_TYPE_LABELS = Object.freeze({
  [MESSAGE_TYPES.PAIN_001]: 'pain.001 — Customer Credit Transfer Initiation',
  [MESSAGE_TYPES.PACS_008]: 'pacs.008 — FI to FI Customer Credit Transfer',
  [MESSAGE_TYPES.PACS_009]: 'pacs.009 — Financial Institution Credit Transfer (Cover)',
});

/**
 * Sanitized, inline field-issue messages keyed by CBPR safe reason code.
 * @type {Record<string, string>}
 */
const ISSUE_MESSAGES = Object.freeze({
  'cbpr.field.required': 'A required field is missing.',
  'cbpr.field.forbidden': 'A field is present that is not permitted.',
  'cbpr.field.too_long': 'A value is too long.',
  'cbpr.field.too_short': 'A value is too short.',
  'cbpr.field.invalid_characters': 'A value contains unsupported characters.',
  'cbpr.field.invalid_format': 'A value does not match the required format.',
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
 * Formats a field name into a readable label.
 * @param {unknown} value - The raw identifier.
 * @returns {string} A human-readable label.
 */
function toLabel(value) {
  const text = toText(value);
  if (text.length === 0) {
    return 'Field';
  }
  return text
    .split(/[._-]/)
    .map((part) => (part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/**
 * Resolves the human-readable label for a message type.
 * @param {string} messageType - One of {@link MESSAGE_TYPES}.
 * @returns {string} A display label for the message type.
 */
function resolveMessageLabel(messageType) {
  return Object.prototype.hasOwnProperty.call(MESSAGE_TYPE_LABELS, messageType)
    ? MESSAGE_TYPE_LABELS[messageType]
    : 'ISO 20022 message';
}

/**
 * Resolves a badge tone for a schema-validation state.
 * @param {string} state - One of {@link VALIDATION_STATES}.
 * @returns {string} A tone from {@link STATUS_TONES}.
 */
function schemaTone(state) {
  switch (state) {
    case VALIDATION_STATES.VALID:
      return STATUS_TONES.SUCCESS;
    case VALIDATION_STATES.INVALID:
      return STATUS_TONES.CRITICAL;
    case VALIDATION_STATES.UNKNOWN:
    default:
      return STATUS_TONES.NEUTRAL;
  }
}

/**
 * Resolves a display label for a schema-validation state.
 * @param {string} state - One of {@link VALIDATION_STATES}.
 * @returns {string} A display label for the schema state.
 */
function schemaLabel(state) {
  switch (state) {
    case VALIDATION_STATES.VALID:
      return 'Schema valid';
    case VALIDATION_STATES.INVALID:
      return 'Schema invalid';
    case VALIDATION_STATES.UNKNOWN:
    default:
      return 'Schema not evaluated';
  }
}

/**
 * Resolves the sanitized message for a CBPR safe reason code.
 * @param {unknown} safeReasonCode - The safe reason code.
 * @returns {string} A sanitized, inline issue message.
 */
function messageForIssue(safeReasonCode) {
  const code = toText(safeReasonCode);
  return Object.prototype.hasOwnProperty.call(ISSUE_MESSAGES, code)
    ? ISSUE_MESSAGES[code]
    : 'A value could not be validated.';
}

/**
 * Renders a single preview line pairing an ISO 20022 tag with its value.
 * @param {{ line: { tag: string, label: string, value: string, masked: boolean } }} props
 *   The preview line props.
 * @returns {React.ReactElement} The preview line element.
 */
function PreviewLine({ line }) {
  const tag = toText(line.tag);
  const label = toText(line.label) || toLabel(tag);
  const value = toText(line.value) || '—';

  return (
    <div className="flex flex-col gap-1 border-b border-primary-blue-100 py-2 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4">
      <div className="flex w-full flex-col gap-0.5 sm:w-64">
        <span className="text-sm font-medium text-primary-blue-700">{label}</span>
        {tag.length > 0 ? <span className="text-xs text-body">{tag}</span> : null}
      </div>
      <div className="flex flex-1 items-center gap-2 text-sm text-body">
        <span>{value}</span>
        {line.masked === true ? (
          <StatusBadge tone={STATUS_TONES.NEUTRAL}>Masked</StatusBadge>
        ) : null}
      </div>
    </div>
  );
}

PreviewLine.propTypes = {
  line: PropTypes.shape({
    tag: PropTypes.string,
    label: PropTypes.string,
    value: PropTypes.string,
    masked: PropTypes.bool,
  }).isRequired,
};

/**
 * Renders a single ISO 20022 message preview as grouped, tagged lines.
 * @param {{ preview: Record<string, unknown> }} props - The message preview props.
 * @returns {React.ReactElement | null} The message preview element, or `null`.
 */
function MessageSection({ preview }) {
  if (!isPlainObject(preview)) {
    return null;
  }

  const messageType = toText(preview.messageType);
  const schemaState = toText(preview.schemaState) || VALIDATION_STATES.UNKNOWN;
  const groups = Array.isArray(preview.groups) ? preview.groups.filter(isPlainObject) : [];
  const issues = Array.isArray(preview.issues) ? preview.issues.filter(isPlainObject) : [];
  const headingId = `message-${messageType || 'unknown'}-heading`;

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={headingId} className="text-lg font-medium text-body">
          {resolveMessageLabel(messageType)}
        </h3>
        <StatusBadge tone={schemaTone(schemaState)}>{schemaLabel(schemaState)}</StatusBadge>
      </div>

      {schemaState === VALIDATION_STATES.INVALID && issues.length > 0 ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="Schema validation issues">
          <ul className="flex flex-col gap-1">
            {issues.map((issue, index) => (
              <li key={`${toText(issue.field)}-${index}`} className="flex gap-2">
                <span className="font-medium text-primary-blue-700">{toLabel(issue.field)}</span>
                <span>{messageForIssue(issue.safeReasonCode)}</span>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {groups.length > 0 ? (
        <div className="flex flex-col gap-4">
          {groups.map((group) => {
            const groupLines = Array.isArray(group.lines)
              ? group.lines.filter(isPlainObject)
              : [];
            return (
              <div key={toText(group.id) || toText(group.label)} className="flex flex-col gap-1">
                <h4 className="text-sm font-medium text-primary-blue-700">
                  {toText(group.label) || 'Group'}
                </h4>
                <dl className="flex flex-col">
                  {groupLines.map((line, index) => (
                    <PreviewLine key={`${toText(line.tag)}-${index}`} line={line} />
                  ))}
                </dl>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-body">No preview lines are available for this message.</p>
      )}
    </section>
  );
}

MessageSection.propTypes = {
  preview: PropTypes.object.isRequired,
};

/**
 * Renders the representative ISO 20022 message preview set.
 *
 * The component renders the pain.001 and pacs.008 previews as structured React
 * elements and, when the resolved route requires it, the linked pacs.009 cover
 * preview. Each message surfaces its schema-validation state and any sanitized
 * field-level issues. A missing or malformed preview set degrades to an
 * accessible empty state, and a persistent no-transmission disclaimer makes the
 * demo nature of the preview clear.
 *
 * @param {{
 *   messages?: Record<string, unknown> | null,
 *   className?: string,
 * }} props - The message preview props.
 * @returns {React.ReactElement} The message preview element.
 */
export function MessagePreview({ messages, className }) {
  const hasMessages = isPlainObject(messages);

  const pain001 = useMemo(
    () => (hasMessages && isPlainObject(messages.pain001) ? messages.pain001 : null),
    [hasMessages, messages],
  );

  const pacs008 = useMemo(
    () => (hasMessages && isPlainObject(messages.pacs008) ? messages.pacs008 : null),
    [hasMessages, messages],
  );

  const pacs009 = useMemo(
    () => (hasMessages && isPlainObject(messages.pacs009) ? messages.pacs009 : null),
    [hasMessages, messages],
  );

  const coverRequired = hasMessages && messages.coverRequired === true;
  const routeType = hasMessages ? toText(messages.routeType) : '';
  const hasAnyMessage = pain001 !== null || pacs008 !== null || pacs009 !== null;

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-medium text-primary-blue-700">Message preview</h2>
        <p className="text-sm text-body">
          Review the representative ISO 20022 messages generated for this payment. Values are masked
          and rendered as structured fields — never transmitted.
          {routeType.length > 0
            ? ` Route: ${toLabel(routeType)}${coverRequired ? ' (cover payment required).' : '.'}`
            : ''}
        </p>
      </div>

      <Alert severity={ALERT_SEVERITIES.INFO} title="No message is transmitted">
        {NO_TRANSMISSION_DISCLAIMER}
      </Alert>

      {!hasMessages || !hasAnyMessage ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="No preview available">
          A message preview could not be produced for this payment. Complete the payment details and
          try again.
        </Alert>
      ) : (
        <>
          {pain001 !== null ? <MessageSection preview={pain001} /> : null}
          {pacs008 !== null ? <MessageSection preview={pacs008} /> : null}
          {coverRequired && pacs009 !== null ? (
            <MessageSection preview={pacs009} />
          ) : coverRequired ? (
            <Alert severity={ALERT_SEVERITIES.WARNING} title="Cover message unavailable">
              This route requires a linked cover (pacs.009) message, but it could not be produced.
              Review the payment routing details and try again.
            </Alert>
          ) : null}
        </>
      )}
    </div>
  );
}

MessagePreview.propTypes = {
  messages: PropTypes.object,
  className: PropTypes.string,
};

export default MessagePreview;