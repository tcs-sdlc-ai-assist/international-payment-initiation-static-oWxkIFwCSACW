/**
 * ISO 20022 / CBPR+ message preview mappers.
 *
 * MessageBuilder maps a normalized payment aggregate into representative,
 * React-renderable view models for the ISO 20022 messages exercised by the
 * payment initiation flow (SCRUM-814/817/818):
 *
 *   - `buildPain001(aggregate, options)` maps the aggregate into a pain.001
 *     customer-credit-transfer initiation preview.
 *   - `buildPacs008(aggregate, options)` maps the aggregate into a pacs.008
 *     FI-to-FI customer credit transfer preview.
 *   - `buildPacs009(aggregate, options)` maps the aggregate into an optional,
 *     linked pacs.009 cover-payment preview (only when a cover route applies).
 *   - `buildMessages(aggregate, options)` builds the full preview set,
 *     resolving whether a linked cover message is required.
 *
 * The mappers are pure: they never mutate their arguments, never touch storage,
 * and never throw for malformed input — they degrade to a structurally-valid,
 * masked preview carrying a schema-validation state so the confirmation view can
 * render safely. Every rendered value is masked via the shared
 * {@link maskingPolicy} so PII never leaks into a preview, and the output is
 * structured data (groups of tagged lines) rather than XML. This builder applies
 * local ISO 20022 / CBPR+ demonstration rules only and carries no server
 * guarantee.
 */

import { maskingPolicy } from '@/shared/privacy/maskingPolicy';
import { cbprValidator } from '@/features/payment/domain/cbprValidator';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Placeholder rendered when a preview value is absent. */
const EMPTY_VALUE = '—';

/** Default masking context applied to preview line values. */
const DEFAULT_MASKING_CONTEXT = maskingPolicy.MASKING_CONTEXTS.CONFIRMATION;

/**
 * Supported ISO 20022 message types produced by this builder.
 * @type {{ PAIN_001: 'pain.001', PACS_008: 'pacs.008', PACS_009: 'pacs.009' }}
 */
export const MESSAGE_TYPES = Object.freeze({
  PAIN_001: 'pain.001',
  PACS_008: 'pacs.008',
  PACS_009: 'pacs.009',
});

/**
 * Supported route types governing whether a linked cover message applies.
 * @type {{ SERIAL: 'serial', COVER: 'cover' }}
 */
export const ROUTE_TYPES = Object.freeze({
  SERIAL: 'serial',
  COVER: 'cover',
});

/**
 * Schema-validation states surfaced with each preview.
 * @type {{ VALID: 'valid', INVALID: 'invalid', UNKNOWN: 'unknown' }}
 */
export const VALIDATION_STATES = Object.freeze({
  VALID: 'valid',
  INVALID: 'invalid',
  UNKNOWN: 'unknown',
});

/**
 * Safe reason codes surfaced by the message builder for gating and messaging.
 * @type {{
 *   BUILT: 'message.builder.built',
 *   INVALID_AGGREGATE: 'message.builder.invalid_aggregate',
 *   SCHEMA_INVALID: 'message.builder.schema_invalid',
 *   COVER_NOT_REQUIRED: 'message.builder.cover_not_required',
 * }}
 */
export const MESSAGE_BUILDER_REASON_CODES = Object.freeze({
  BUILT: 'message.builder.built',
  INVALID_AGGREGATE: 'message.builder.invalid_aggregate',
  SCHEMA_INVALID: 'message.builder.schema_invalid',
  COVER_NOT_REQUIRED: 'message.builder.cover_not_required',
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
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

/**
 * Resolves a supported masking context, falling back to the default.
 * @param {string} [context] - The requested context.
 * @returns {string} A valid masking context.
 */
function resolveContext(context) {
  const contexts = Object.values(maskingPolicy.MASKING_CONTEXTS);
  return typeof context === 'string' && contexts.includes(context)
    ? context
    : DEFAULT_MASKING_CONTEXT;
}

/**
 * Builds a single preview line, masking the value for a PII field when needed.
 * @param {string} tag - The ISO 20022 tag path (e.g. `CdtTrfTxInf/Cdtr/Nm`).
 * @param {string} label - The human-readable label.
 * @param {unknown} value - The raw value.
 * @param {{ piiField?: string, context: string }} options - Line options.
 * @returns {{ tag: string, label: string, value: string, masked: boolean }}
 *   A preview line entry.
 */
function buildLine(tag, label, value, options) {
  const source = isPlainObject(options) ? options : { context: DEFAULT_MASKING_CONTEXT };
  const raw = toText(value);
  if (raw.length === 0) {
    return { tag, label, value: EMPTY_VALUE, masked: false };
  }
  if (typeof source.piiField === 'string' && source.piiField.length > 0) {
    return {
      tag,
      label,
      value: maskingPolicy.mask(source.piiField, raw, source.context),
      masked: true,
    };
  }
  return { tag, label, value: raw, masked: false };
}

/**
 * Reads a nested plain object from an aggregate, returning an empty object when
 * absent so downstream reads never throw.
 * @param {Record<string, unknown>} source - The aggregate.
 * @param {string} key - The property name.
 * @returns {Record<string, unknown>} The nested object (may be empty).
 */
function readSection(source, key) {
  const value = source[key];
  return isPlainObject(value) ? value : {};
}

/**
 * Resolves the route type from the aggregate, honoring an explicit override.
 * @param {Record<string, unknown>} aggregate - The normalized aggregate.
 * @returns {string} One of {@link ROUTE_TYPES}.
 */
function resolveRouteType(aggregate) {
  const routing = readSection(aggregate, 'routing');
  const raw = toText(routing.routeType).toLowerCase();
  if (raw === ROUTE_TYPES.COVER) {
    return ROUTE_TYPES.COVER;
  }
  if (raw === ROUTE_TYPES.SERIAL) {
    return ROUTE_TYPES.SERIAL;
  }
  return routing.coverRequired === true ? ROUTE_TYPES.COVER : ROUTE_TYPES.SERIAL;
}

/**
 * Determines whether a linked cover (pacs.009) message applies.
 * @param {Record<string, unknown>} aggregate - The normalized aggregate.
 * @returns {boolean} `true` when a cover message is required.
 */
function requiresCover(aggregate) {
  return resolveRouteType(aggregate) === ROUTE_TYPES.COVER;
}

/**
 * Resolves the schema-validation state for the aggregate via the CBPR validator.
 * @param {Record<string, unknown>} aggregate - The normalized aggregate.
 * @returns {{
 *   state: string,
 *   safeReasonCode: string,
 *   issues: Array<{ field: string, safeReasonCode: string }>,
 *   ruleSetId: string | null,
 * }} The resolved schema-validation state.
 */
function resolveSchemaState(aggregate) {
  const details = readSection(aggregate, 'cbprDetails');
  const selector = readSection(aggregate, 'cbprSelector');

  if (Object.keys(details).length === 0) {
    return {
      state: VALIDATION_STATES.UNKNOWN,
      safeReasonCode: MESSAGE_BUILDER_REASON_CODES.BUILT,
      issues: [],
      ruleSetId: null,
    };
  }

  const result = cbprValidator.validate(selector, details);
  if (result.ok) {
    return {
      state: VALIDATION_STATES.VALID,
      safeReasonCode: MESSAGE_BUILDER_REASON_CODES.BUILT,
      issues: [],
      ruleSetId: result.ruleSetId,
    };
  }

  return {
    state: VALIDATION_STATES.INVALID,
    safeReasonCode: MESSAGE_BUILDER_REASON_CODES.SCHEMA_INVALID,
    issues: Array.isArray(result.issues) ? result.issues : [],
    ruleSetId: result.ruleSetId,
  };
}

/**
 * Builds a group of preview lines under a labeled heading.
 * @param {string} id - The group identifier.
 * @param {string} label - The group heading.
 * @param {Array<{ tag: string, label: string, value: string, masked: boolean }>} lines
 *   The preview lines for the group.
 * @returns {{
 *   id: string,
 *   label: string,
 *   lines: Array<{ tag: string, label: string, value: string, masked: boolean }>,
 * }} The preview group.
 */
function buildGroup(id, label, lines) {
  return { id, label, lines };
}

/**
 * Builds an empty, structurally-valid preview when the aggregate is unusable.
 * @param {string} messageType - One of {@link MESSAGE_TYPES}.
 * @returns {{
 *   ok: false,
 *   messageType: string,
 *   schemaState: string,
 *   groups: Array<Record<string, unknown>>,
 *   safeReasonCode: string,
 *   issues: Array<{ field: string, safeReasonCode: string }>,
 * }} An empty preview result.
 */
function emptyPreview(messageType) {
  return {
    ok: false,
    messageType,
    schemaState: VALIDATION_STATES.UNKNOWN,
    groups: [],
    safeReasonCode: MESSAGE_BUILDER_REASON_CODES.INVALID_AGGREGATE,
    issues: [],
  };
}

/**
 * Maps the normalized aggregate into a pain.001 customer-credit-transfer
 * initiation preview.
 *
 * Never mutates its arguments and never throws — malformed input degrades to an
 * empty, masked preview carrying a sanitized reason code.
 *
 * @param {Record<string, unknown>} aggregate - The normalized payment aggregate.
 * @param {{ context?: string }} [options] - Optional mapping options.
 * @returns {{
 *   ok: boolean,
 *   messageType: string,
 *   schemaState: string,
 *   groups: Array<{
 *     id: string,
 *     label: string,
 *     lines: Array<{ tag: string, label: string, value: string, masked: boolean }>,
 *   }>,
 *   safeReasonCode: string,
 *   issues: Array<{ field: string, safeReasonCode: string }>,
 * }} A pain.001 preview result.
 */
export function buildPain001(aggregate, options) {
  if (!isPlainObject(aggregate)) {
    safeLogger.warn('messageBuilder: rejected invalid aggregate for pain.001');
    return emptyPreview(MESSAGE_TYPES.PAIN_001);
  }

  const context = resolveContext(options?.context);
  const meta = readSection(aggregate, 'meta');
  const debtor = readSection(aggregate, 'debtor');
  const debtorAgent = readSection(aggregate, 'debtorAgent');
  const creditor = readSection(aggregate, 'creditor');
  const creditorAgent = readSection(aggregate, 'creditorAgent');
  const amount = readSection(aggregate, 'amount');
  const remittance = readSection(aggregate, 'remittance');

  const schema = resolveSchemaState(aggregate);

  const groups = [
    buildGroup('group-header', 'Group header', [
      buildLine('CstmrCdtTrfInitn/GrpHdr/MsgId', 'Message identifier', toText(meta.messageId), {
        context,
      }),
      buildLine('CstmrCdtTrfInitn/GrpHdr/CreDtTm', 'Creation date-time', toText(meta.createdAt), {
        context,
      }),
      buildLine('CstmrCdtTrfInitn/PmtInf/PmtInfId', 'Payment info id', toText(meta.paymentReference), {
        context,
      }),
    ]),
    buildGroup('group-debtor', 'Debtor', [
      buildLine('CstmrCdtTrfInitn/PmtInf/Dbtr/Nm', 'Debtor name', debtor.name, {
        piiField: 'name',
        context,
      }),
      buildLine('CstmrCdtTrfInitn/PmtInf/DbtrAcct/Id', 'Debtor account', debtor.account, {
        piiField: 'account',
        context,
      }),
      buildLine('CstmrCdtTrfInitn/PmtInf/DbtrAgt/BICFI', 'Debtor agent BIC', debtorAgent.bic, {
        piiField: 'bic',
        context,
      }),
    ]),
    buildGroup('group-amount', 'Amount', [
      buildLine('CstmrCdtTrfInitn/CdtTrfTxInf/Amt/InstdAmt', 'Instructed amount', amount.instructedValue, {
        context,
      }),
      buildLine('CstmrCdtTrfInitn/CdtTrfTxInf/XchgRateInf/CcyAmt', 'Settlement amount', amount.settlementValue, {
        context,
      }),
      buildLine('CstmrCdtTrfInitn/PmtInf/PmtTpInf/ChrgBr', 'Charge treatment', toText(amount.chargeTreatment), {
        context,
      }),
    ]),
    buildGroup('group-creditor', 'Creditor', [
      buildLine('CstmrCdtTrfInitn/CdtTrfTxInf/Cdtr/Nm', 'Creditor name', creditor.name, {
        piiField: 'name',
        context,
      }),
      buildLine('CstmrCdtTrfInitn/CdtTrfTxInf/CdtrAcct/Id', 'Creditor account', creditor.account, {
        piiField: 'iban',
        context,
      }),
      buildLine('CstmrCdtTrfInitn/CdtTrfTxInf/CdtrAgt/BICFI', 'Creditor agent BIC', creditorAgent.bic, {
        piiField: 'bic',
        context,
      }),
    ]),
    buildGroup('group-remittance', 'Remittance', [
      buildLine('CstmrCdtTrfInitn/CdtTrfTxInf/RmtInf/Ustrd', 'Remittance information', remittance.unstructured, {
        piiField: 'reference',
        context,
      }),
      buildLine('CstmrCdtTrfInitn/CdtTrfTxInf/PmtId/UETR', 'UETR', toText(meta.uetr), {
        context,
      }),
    ]),
  ];

  return {
    ok: true,
    messageType: MESSAGE_TYPES.PAIN_001,
    schemaState: schema.state,
    groups,
    safeReasonCode: schema.safeReasonCode,
    issues: schema.issues,
  };
}

/**
 * Maps the normalized aggregate into a pacs.008 FI-to-FI customer credit
 * transfer preview.
 *
 * Never mutates its arguments and never throws — malformed input degrades to an
 * empty, masked preview carrying a sanitized reason code.
 *
 * @param {Record<string, unknown>} aggregate - The normalized payment aggregate.
 * @param {{ context?: string }} [options] - Optional mapping options.
 * @returns {{
 *   ok: boolean,
 *   messageType: string,
 *   schemaState: string,
 *   groups: Array<{
 *     id: string,
 *     label: string,
 *     lines: Array<{ tag: string, label: string, value: string, masked: boolean }>,
 *   }>,
 *   safeReasonCode: string,
 *   issues: Array<{ field: string, safeReasonCode: string }>,
 * }} A pacs.008 preview result.
 */
export function buildPacs008(aggregate, options) {
  if (!isPlainObject(aggregate)) {
    safeLogger.warn('messageBuilder: rejected invalid aggregate for pacs.008');
    return emptyPreview(MESSAGE_TYPES.PACS_008);
  }

  const context = resolveContext(options?.context);
  const meta = readSection(aggregate, 'meta');
  const debtor = readSection(aggregate, 'debtor');
  const debtorAgent = readSection(aggregate, 'debtorAgent');
  const creditor = readSection(aggregate, 'creditor');
  const creditorAgent = readSection(aggregate, 'creditorAgent');
  const intermediaryAgent = readSection(aggregate, 'intermediaryAgent');
  const amount = readSection(aggregate, 'amount');
  const remittance = readSection(aggregate, 'remittance');

  const schema = resolveSchemaState(aggregate);

  const groups = [
    buildGroup('group-header', 'Group header', [
      buildLine('FIToFICstmrCdtTrf/GrpHdr/MsgId', 'Message identifier', toText(meta.messageId), {
        context,
      }),
      buildLine('FIToFICstmrCdtTrf/GrpHdr/CreDtTm', 'Creation date-time', toText(meta.createdAt), {
        context,
      }),
      buildLine('FIToFICstmrCdtTrf/CdtTrfTxInf/PmtId/UETR', 'UETR', toText(meta.uetr), {
        context,
      }),
    ]),
    buildGroup('group-settlement', 'Settlement', [
      buildLine('FIToFICstmrCdtTrf/CdtTrfTxInf/IntrBkSttlmAmt', 'Interbank settlement amount', amount.settlementValue, {
        context,
      }),
      buildLine('FIToFICstmrCdtTrf/CdtTrfTxInf/InstdAmt', 'Instructed amount', amount.instructedValue, {
        context,
      }),
      buildLine('FIToFICstmrCdtTrf/CdtTrfTxInf/ChrgBr', 'Charge treatment', toText(amount.chargeTreatment), {
        context,
      }),
    ]),
    buildGroup('group-agents', 'Agents', [
      buildLine('FIToFICstmrCdtTrf/CdtTrfTxInf/DbtrAgt/BICFI', 'Debtor agent BIC', debtorAgent.bic, {
        piiField: 'bic',
        context,
      }),
      buildLine('FIToFICstmrCdtTrf/CdtTrfTxInf/IntrmyAgt1/BICFI', 'Intermediary agent BIC', intermediaryAgent.bic, {
        piiField: 'bic',
        context,
      }),
      buildLine('FIToFICstmrCdtTrf/CdtTrfTxInf/CdtrAgt/BICFI', 'Creditor agent BIC', creditorAgent.bic, {
        piiField: 'bic',
        context,
      }),
    ]),
    buildGroup('group-parties', 'Parties', [
      buildLine('FIToFICstmrCdtTrf/CdtTrfTxInf/Dbtr/Nm', 'Debtor name', debtor.name, {
        piiField: 'name',
        context,
      }),
      buildLine('FIToFICstmrCdtTrf/CdtTrfTxInf/DbtrAcct/Id', 'Debtor account', debtor.account, {
        piiField: 'account',
        context,
      }),
      buildLine('FIToFICstmrCdtTrf/CdtTrfTxInf/Cdtr/Nm', 'Creditor name', creditor.name, {
        piiField: 'name',
        context,
      }),
      buildLine('FIToFICstmrCdtTrf/CdtTrfTxInf/CdtrAcct/Id', 'Creditor account', creditor.account, {
        piiField: 'iban',
        context,
      }),
    ]),
    buildGroup('group-remittance', 'Remittance', [
      buildLine('FIToFICstmrCdtTrf/CdtTrfTxInf/RmtInf/Ustrd', 'Remittance information', remittance.unstructured, {
        piiField: 'reference',
        context,
      }),
    ]),
  ];

  return {
    ok: true,
    messageType: MESSAGE_TYPES.PACS_008,
    schemaState: schema.state,
    groups,
    safeReasonCode: schema.safeReasonCode,
    issues: schema.issues,
  };
}

/**
 * Maps the normalized aggregate into an optional, linked pacs.009 cover-payment
 * preview. Only produced when the resolved route requires a cover message.
 *
 * Never mutates its arguments and never throws — malformed input or a serial
 * route degrades to a `null` preview carrying a sanitized reason code.
 *
 * @param {Record<string, unknown>} aggregate - The normalized payment aggregate.
 * @param {{ context?: string }} [options] - Optional mapping options.
 * @returns {{
 *   ok: boolean,
 *   applicable: boolean,
 *   messageType: string,
 *   schemaState: string,
 *   groups: Array<{
 *     id: string,
 *     label: string,
 *     lines: Array<{ tag: string, label: string, value: string, masked: boolean }>,
 *   }>,
 *   safeReasonCode: string,
 *   issues: Array<{ field: string, safeReasonCode: string }>,
 * }} A pacs.009 preview result.
 */
export function buildPacs009(aggregate, options) {
  if (!isPlainObject(aggregate)) {
    safeLogger.warn('messageBuilder: rejected invalid aggregate for pacs.009');
    return { ...emptyPreview(MESSAGE_TYPES.PACS_009), applicable: false };
  }

  if (!requiresCover(aggregate)) {
    return {
      ok: false,
      applicable: false,
      messageType: MESSAGE_TYPES.PACS_009,
      schemaState: VALIDATION_STATES.UNKNOWN,
      groups: [],
      safeReasonCode: MESSAGE_BUILDER_REASON_CODES.COVER_NOT_REQUIRED,
      issues: [],
    };
  }

  const context = resolveContext(options?.context);
  const meta = readSection(aggregate, 'meta');
  const debtorAgent = readSection(aggregate, 'debtorAgent');
  const creditorAgent = readSection(aggregate, 'creditorAgent');
  const instructingAgent = readSection(aggregate, 'instructingAgent');
  const instructedAgent = readSection(aggregate, 'instructedAgent');
  const amount = readSection(aggregate, 'amount');

  const schema = resolveSchemaState(aggregate);

  const groups = [
    buildGroup('group-header', 'Group header', [
      buildLine('FICdtTrf/GrpHdr/MsgId', 'Message identifier', toText(meta.coverMessageId) || `demo-cover-${toText(meta.paymentReference)}`, {
        context,
      }),
      buildLine('FICdtTrf/GrpHdr/CreDtTm', 'Creation date-time', toText(meta.createdAt), {
        context,
      }),
      buildLine('FICdtTrf/CdtTrfTxInf/PmtId/UETR', 'UETR', toText(meta.uetr), {
        context,
      }),
    ]),
    buildGroup('group-settlement', 'Settlement', [
      buildLine('FICdtTrf/CdtTrfTxInf/IntrBkSttlmAmt', 'Interbank settlement amount', amount.settlementValue, {
        context,
      }),
      buildLine('FICdtTrf/CdtTrfTxInf/UndrlygCstmrCdtTrf/InstdAmt', 'Underlying instructed amount', amount.instructedValue, {
        context,
      }),
    ]),
    buildGroup('group-institutions', 'Institutions', [
      buildLine('FICdtTrf/CdtTrfTxInf/InstgAgt/BICFI', 'Instructing agent BIC', instructingAgent.bic || debtorAgent.bic, {
        piiField: 'bic',
        context,
      }),
      buildLine('FICdtTrf/CdtTrfTxInf/InstdAgt/BICFI', 'Instructed agent BIC', instructedAgent.bic || creditorAgent.bic, {
        piiField: 'bic',
        context,
      }),
      buildLine('FICdtTrf/CdtTrfTxInf/DbtrAgt/BICFI', 'Debtor agent BIC', debtorAgent.bic, {
        piiField: 'bic',
        context,
      }),
      buildLine('FICdtTrf/CdtTrfTxInf/CdtrAgt/BICFI', 'Creditor agent BIC', creditorAgent.bic, {
        piiField: 'bic',
        context,
      }),
    ]),
  ];

  return {
    ok: true,
    applicable: true,
    messageType: MESSAGE_TYPES.PACS_009,
    schemaState: schema.state,
    groups,
    safeReasonCode: schema.safeReasonCode,
    issues: schema.issues,
  };
}

/**
 * Builds the full ISO 20022 preview set for a normalized aggregate, resolving
 * whether a linked cover (pacs.009) message applies.
 *
 * Never mutates its arguments and never throws — malformed input degrades to a
 * structurally-valid, masked preview set carrying a sanitized reason code.
 *
 * @param {Record<string, unknown>} aggregate - The normalized payment aggregate.
 * @param {{ context?: string }} [options] - Optional mapping options.
 * @returns {{
 *   ok: boolean,
 *   routeType: string,
 *   coverRequired: boolean,
 *   schemaState: string,
 *   safeReasonCode: string,
 *   pain001: Record<string, unknown>,
 *   pacs008: Record<string, unknown>,
 *   pacs009: Record<string, unknown> | null,
 *   issues: Array<{ field: string, safeReasonCode: string }>,
 * }} The full preview set.
 */
export function buildMessages(aggregate, options) {
  if (!isPlainObject(aggregate)) {
    safeLogger.warn('messageBuilder: rejected invalid aggregate for message set');
    return {
      ok: false,
      routeType: ROUTE_TYPES.SERIAL,
      coverRequired: false,
      schemaState: VALIDATION_STATES.UNKNOWN,
      safeReasonCode: MESSAGE_BUILDER_REASON_CODES.INVALID_AGGREGATE,
      pain001: emptyPreview(MESSAGE_TYPES.PAIN_001),
      pacs008: emptyPreview(MESSAGE_TYPES.PACS_008),
      pacs009: null,
      issues: [],
    };
  }

  const context = resolveContext(options?.context);
  const routeType = resolveRouteType(aggregate);
  const coverRequired = routeType === ROUTE_TYPES.COVER;
  const schema = resolveSchemaState(aggregate);

  const pain001 = buildPain001(aggregate, { context });
  const pacs008 = buildPacs008(aggregate, { context });
  const pacs009Preview = buildPacs009(aggregate, { context });
  const pacs009 = pacs009Preview.applicable === true ? pacs009Preview : null;

  return {
    ok: true,
    routeType,
    coverRequired,
    schemaState: schema.state,
    safeReasonCode: schema.safeReasonCode,
    pain001,
    pacs008,
    pacs009,
    issues: schema.issues,
  };
}

/**
 * The message builder contract, exposed as a single frozen object.
 * @type {{
 *   buildPain001: typeof buildPain001,
 *   buildPacs008: typeof buildPacs008,
 *   buildPacs009: typeof buildPacs009,
 *   buildMessages: typeof buildMessages,
 *   MESSAGE_TYPES: typeof MESSAGE_TYPES,
 *   ROUTE_TYPES: typeof ROUTE_TYPES,
 *   VALIDATION_STATES: typeof VALIDATION_STATES,
 *   MESSAGE_BUILDER_REASON_CODES: typeof MESSAGE_BUILDER_REASON_CODES,
 * }}
 */
export const messageBuilder = Object.freeze({
  buildPain001,
  buildPacs008,
  buildPacs009,
  buildMessages,
  MESSAGE_TYPES,
  ROUTE_TYPES,
  VALIDATION_STATES,
  MESSAGE_BUILDER_REASON_CODES,
});

export default messageBuilder;