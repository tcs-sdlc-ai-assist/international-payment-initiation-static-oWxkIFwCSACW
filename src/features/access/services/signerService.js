/**
 * Signer administration domain service.
 *
 * SignerService orchestrates the signer entitlement use cases exposed in the
 * access cluster (SCRUM-824/825/826). It layers atop the {@link SignerRepository}
 * (baseline + overlay merge), the {@link OperationLedger} (idempotent operation
 * and change-request references), the {@link signerPolicy} (deny-by-default
 * eligibility), the {@link signerDiffService} (before/after confirmation model),
 * the {@link esignService} (simulated eSign ceremony), and the
 * {@link authorizationPolicy} (capability gating). Every outcome — allowed or
 * denied, success or failure — is routed through the {@link auditFacade} as a
 * sanitized, masked audit event.
 *
 * The service is intentionally conservative and demo-only:
 *
 *   - `search(session, filter)` and `getById(session, signerId)` return masked
 *     display models scoped to the session's entitlements.
 *   - `proposeEdit(session, signerId, changes, options)` re-checks capability,
 *     record eligibility, and the local edit revision, produces a before/after
 *     diff, records an operation reference and a change request, and persists a
 *     conservative overlay.
 *   - `completeESign(session, signerId, operationId, options)` runs the
 *     simulated eSign ceremony and, on success, commits the in-flight operation.
 *   - `unlock(session, signerId, options)` clears a signer's lock via a bounded,
 *     revision-checked overlay.
 *   - `resendInvitation(session, signerId, options)` re-checks resend
 *     eligibility (including the rolling 24-hour window) and records a resend
 *     operation reference.
 *
 * All mutating use cases re-check entitlement, record eligibility, and the local
 * revision before acting; a stale revision is rejected as a concurrent edit
 * rather than silently overwriting. No method throws for expected failures —
 * each returns a discriminated `{ ok, ... }` result carrying a sanitized safe
 * reason code so callers can gate the UI safely. It is a client-side,
 * non-regulatory service and carries no server guarantee.
 */

import { CAPABILITIES } from '@/shared/config/constants';
import { createLocalStorageAdapter } from '@/shared/storage/storageAdapter';
import { createSignerRepository } from '@/features/access/data/signerRepository';
import {
  createOperationLedger,
  OPERATION_KINDS,
} from '@/features/access/data/operationLedger';
import { authorizationPolicy } from '@/features/access/services/authorizationPolicy';
import { signerPolicy } from '@/features/access/services/signerPolicy';
import { signerDiffService } from '@/features/access/services/signerDiffService';
import { esignService } from '@/features/access/services/esignService';
import { auditFacade } from '@/features/access/data/auditFacade';
import { maskingPolicy } from '@/shared/privacy/maskingPolicy';
import { generateOperationId } from '@/shared/mock/mockEnvelope';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Fields that can never be modified by a signer overlay. */
const ALWAYS_LOCKED_FIELDS = Object.freeze(['signer_id', 'edit_revision', 'created_at']);

/** Comparable/writable fields permitted in a signer edit overlay. */
const WRITABLE_FIELDS = Object.freeze([
  'signer_name',
  'email',
  'phone',
  'authority',
  'amount_limit',
  'account_scopes',
  'status',
]);

/**
 * Safe reason codes surfaced by the signer service for gating and messaging.
 * @type {{
 *   UNAUTHORIZED: 'signer.service.unauthorized',
 *   NOT_FOUND: 'signer.service.not_found',
 *   CONCURRENT_EDIT: 'signer.service.concurrent_edit',
 *   NO_CHANGES: 'signer.service.no_changes',
 *   FIELD_NOT_EDITABLE: 'signer.service.field_not_editable',
 *   PERSIST_FAILED: 'signer.service.persist_failed',
 *   OPERATION_NOT_FOUND: 'signer.service.operation_not_found',
 *   EDIT_RECORDED: 'signer.service.edit_recorded',
 *   ESIGN_COMPLETED: 'signer.service.esign_completed',
 *   UNLOCKED: 'signer.service.unlocked',
 *   INVITATION_RESENT: 'signer.service.invitation_resent',
 *   UNEXPECTED: 'signer.service.unexpected',
 * }}
 */
export const SIGNER_SERVICE_REASON_CODES = Object.freeze({
  UNAUTHORIZED: 'signer.service.unauthorized',
  NOT_FOUND: 'signer.service.not_found',
  CONCURRENT_EDIT: 'signer.service.concurrent_edit',
  NO_CHANGES: 'signer.service.no_changes',
  FIELD_NOT_EDITABLE: 'signer.service.field_not_editable',
  PERSIST_FAILED: 'signer.service.persist_failed',
  OPERATION_NOT_FOUND: 'signer.service.operation_not_found',
  EDIT_RECORDED: 'signer.service.edit_recorded',
  ESIGN_COMPLETED: 'signer.service.esign_completed',
  UNLOCKED: 'signer.service.unlocked',
  INVITATION_RESENT: 'signer.service.invitation_resent',
  UNEXPECTED: 'signer.service.unexpected',
});

/**
 * Audit event types emitted by the signer service.
 * @type {{
 *   SEARCH: 'signer.search',
 *   VIEW: 'signer.view',
 *   EDIT_PROPOSED: 'signer.edit_proposed',
 *   EDIT_DENIED: 'signer.edit_denied',
 *   ESIGN_COMPLETED: 'signer.esign_completed',
 *   ESIGN_DENIED: 'signer.esign_denied',
 *   UNLOCKED: 'signer.unlocked',
 *   UNLOCK_DENIED: 'signer.unlock_denied',
 *   INVITATION_RESENT: 'signer.invitation_resent',
 *   RESEND_DENIED: 'signer.resend_denied',
 * }}
 */
export const SIGNER_AUDIT_EVENTS = Object.freeze({
  SEARCH: 'signer.search',
  VIEW: 'signer.view',
  EDIT_PROPOSED: 'signer.edit_proposed',
  EDIT_DENIED: 'signer.edit_denied',
  ESIGN_COMPLETED: 'signer.esign_completed',
  ESIGN_DENIED: 'signer.esign_denied',
  UNLOCKED: 'signer.unlocked',
  UNLOCK_DENIED: 'signer.unlock_denied',
  INVITATION_RESENT: 'signer.invitation_resent',
  RESEND_DENIED: 'signer.resend_denied',
});

/** Lazily-provisioned repository shared across service calls. */
let sharedRepository = null;

/** Lazily-provisioned operation ledger shared across service calls. */
let sharedLedger = null;

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
 * Provisions (or returns) the shared signer repository, creating a local
 * storage adapter and repository on first use. Failures degrade to `null` so
 * callers never crash on a storage fault.
 * @returns {import('@/features/access/data/signerRepository').SignerRepository | null}
 *   The shared repository, or `null` when it could not be provisioned.
 */
function resolveRepository() {
  if (sharedRepository) {
    return sharedRepository;
  }
  try {
    const adapter = createLocalStorageAdapter();
    sharedRepository = createSignerRepository(adapter);
    return sharedRepository;
  } catch (error) {
    safeLogger.error('signerService: failed to provision signer repository', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * Provisions (or returns) the shared operation ledger, creating a local storage
 * adapter and ledger on first use. Failures degrade to `null`.
 * @returns {import('@/features/access/data/operationLedger').OperationLedger | null}
 *   The shared ledger, or `null` when it could not be provisioned.
 */
function resolveLedger() {
  if (sharedLedger) {
    return sharedLedger;
  }
  try {
    const adapter = createLocalStorageAdapter();
    sharedLedger = createOperationLedger(adapter);
    return sharedLedger;
  } catch (error) {
    safeLogger.error('signerService: failed to provision operation ledger', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * Overrides the collaborators backing the service. Primarily used by tests to
 * inject deterministic or in-memory implementations.
 * @param {{
 *   repository?: import('@/features/access/data/signerRepository').SignerRepository | null,
 *   ledger?: import('@/features/access/data/operationLedger').OperationLedger | null,
 * }} [overrides] - The collaborators to use, or `null` to reset each.
 * @returns {void}
 */
export function configureSignerService(overrides) {
  const source = isPlainObject(overrides) ? overrides : {};
  if (Object.prototype.hasOwnProperty.call(source, 'repository')) {
    sharedRepository = source.repository ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'ledger')) {
    sharedLedger = source.ledger ?? null;
  }
}

/**
 * Resolves the acting subject identifier from a session claim.
 * @param {Record<string, unknown> | null | undefined} session - The session.
 * @returns {string | undefined} The subject identifier, or `undefined`.
 */
function resolveActorId(session) {
  if (!isPlainObject(session)) {
    return undefined;
  }
  const subjectId = toText(session.subjectId);
  return subjectId.length > 0 ? subjectId : undefined;
}

/**
 * Records a sanitized audit event, never throwing on failure.
 * @param {string} eventType - The audit event type.
 * @param {{
 *   actorId?: string,
 *   subjectId?: string,
 *   safeReasonCode?: string,
 *   metadata?: Record<string, unknown>,
 * }} entry - The audit entry fields.
 * @returns {void}
 */
function audit(eventType, entry) {
  const source = isPlainObject(entry) ? entry : {};
  const event = { eventType };
  if (source.actorId !== undefined) {
    event.actorId = source.actorId;
  }
  if (source.subjectId !== undefined) {
    event.subjectId = source.subjectId;
  }
  if (source.safeReasonCode !== undefined) {
    event.safeReasonCode = source.safeReasonCode;
  }
  if (isPlainObject(source.metadata)) {
    event.metadata = source.metadata;
  }
  auditFacade.append(event);
}

/**
 * Determines whether the acting session may read signer entitlements.
 * @param {Record<string, unknown> | null | undefined} session - The session.
 * @returns {boolean} `true` when the session holds the read capability.
 */
function canRead(session) {
  return authorizationPolicy.can(session, CAPABILITIES.SIGNER_READ);
}

/**
 * Determines whether the acting session may manage signer entitlements.
 * @param {Record<string, unknown> | null | undefined} session - The session.
 * @returns {boolean} `true` when the session holds the manage capability.
 */
function canManage(session) {
  return authorizationPolicy.can(session, CAPABILITIES.SIGNER_MANAGE);
}

/**
 * Resolves the entitlement descriptor used to scope repository visibility.
 * @param {Record<string, unknown> | null | undefined} session - The session.
 * @param {string[]} accountScopes - The session's account scopes.
 * @returns {{ capabilities: string[], accountScopes: string[], requiredCapability: string }}
 *   The entitlement descriptor.
 */
function toEntitlements(session, accountScopes) {
  const capabilities =
    isPlainObject(session) && Array.isArray(session.capabilities)
      ? session.capabilities.filter((item) => typeof item === 'string' && item.length > 0)
      : [];
  return {
    capabilities,
    accountScopes: Array.isArray(accountScopes) ? accountScopes : [],
    requiredCapability: CAPABILITIES.SIGNER_READ,
  };
}

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
 * Reads the numeric local edit revision from a signer record.
 * @param {Record<string, unknown>} signer - The signer record.
 * @returns {number} The edit revision (0 when absent).
 */
function readRevision(signer) {
  return typeof signer.edit_revision === 'number' && Number.isFinite(signer.edit_revision)
    ? signer.edit_revision
    : 0;
}

/**
 * Restricts a proposed change set to writable, non-locked fields.
 * @param {Record<string, unknown>} changes - The raw proposed changes.
 * @returns {Record<string, unknown>} A sanitized change set.
 */
function sanitizeChanges(changes) {
  const source = isPlainObject(changes) ? changes : {};
  const sanitized = {};
  for (const field of WRITABLE_FIELDS) {
    if (ALWAYS_LOCKED_FIELDS.includes(field)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      sanitized[field] = source[field];
    }
  }
  return sanitized;
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
 * Searches the entitlement-scoped signer dataset, returning masked display
 * models. Deny-by-default: an unauthorized session receives an empty result.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {{
 *   accountScopes?: string[],
 *   text?: string,
 *   status?: string,
 *   context?: string,
 * }} [filter] - Optional search filter.
 * @returns {{
 *   ok: boolean,
 *   signers: Array<Record<string, unknown>>,
 *   safeReasonCode: string,
 * }} A discriminated search result with masked signers.
 */
export function search(session, filter) {
  const actorId = resolveActorId(session);
  if (!canRead(session)) {
    audit(SIGNER_AUDIT_EVENTS.SEARCH, {
      actorId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.UNAUTHORIZED,
    });
    return { ok: false, signers: [], safeReasonCode: SIGNER_SERVICE_REASON_CODES.UNAUTHORIZED };
  }

  const repository = resolveRepository();
  if (!repository) {
    return { ok: false, signers: [], safeReasonCode: SIGNER_SERVICE_REASON_CODES.UNEXPECTED };
  }

  const source = isPlainObject(filter) ? filter : {};
  const entitlements = toEntitlements(session, toStringArray(source.accountScopes));
  const context = toText(source.context) || undefined;

  let models = repository.listVisibleDisplayModels(entitlements, context);

  const text = toText(source.text).toLowerCase();
  if (text.length > 0) {
    models = models.filter((model) => {
      const haystack = `${toText(model.signer_id)} ${toText(model.signer_name)}`.toLowerCase();
      return haystack.includes(text);
    });
  }

  const status = toText(source.status);
  if (status.length > 0) {
    models = models.filter((model) => model.status === status);
  }

  audit(SIGNER_AUDIT_EVENTS.SEARCH, {
    actorId,
    metadata: { count: models.length },
  });

  return { ok: true, signers: models, safeReasonCode: SIGNER_SERVICE_REASON_CODES.EDIT_RECORDED };
}

/**
 * Returns a single masked signer display model scoped to the session's
 * entitlements. Deny-by-default: unauthorized or out-of-scope requests fail.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {string} signerId - The signer identifier.
 * @param {{ accountScopes?: string[], context?: string }} [options] - Optional options.
 * @returns {{
 *   ok: boolean,
 *   signer?: Record<string, unknown>,
 *   safeReasonCode: string,
 * }} A discriminated result with the masked signer.
 */
export function getById(session, signerId, options) {
  const actorId = resolveActorId(session);
  const subjectId = toText(signerId) || undefined;

  if (!canRead(session)) {
    audit(SIGNER_AUDIT_EVENTS.VIEW, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.UNAUTHORIZED,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.UNAUTHORIZED);
  }

  const repository = resolveRepository();
  if (!repository) {
    return fail(SIGNER_SERVICE_REASON_CODES.UNEXPECTED);
  }

  const source = isPlainObject(options) ? options : {};
  const entitlements = toEntitlements(session, toStringArray(source.accountScopes));
  const visible = repository.listVisible(entitlements);
  const match = visible.find((signer) => signer.signer_id === toText(signerId));

  if (!match) {
    audit(SIGNER_AUDIT_EVENTS.VIEW, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.NOT_FOUND,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.NOT_FOUND);
  }

  const context = toText(source.context) || undefined;
  const model = repository.toDisplayModel(match, context);

  audit(SIGNER_AUDIT_EVENTS.VIEW, { actorId, subjectId });

  return {
    ok: true,
    signer: model,
    safeReasonCode: SIGNER_SERVICE_REASON_CODES.EDIT_RECORDED,
  };
}

/**
 * Loads the visible, unmasked signer record for a mutating use case, enforcing
 * entitlement scoping.
 * @param {import('@/features/access/data/signerRepository').SignerRepository} repository
 *   The signer repository.
 * @param {Record<string, unknown> | null | undefined} session - The session.
 * @param {string} signerId - The signer identifier.
 * @param {string[]} accountScopes - The session's account scopes.
 * @returns {Record<string, unknown> | undefined} The visible signer, or `undefined`.
 */
function loadVisibleSigner(repository, session, signerId, accountScopes) {
  const entitlements = toEntitlements(session, accountScopes);
  const visible = repository.listVisible(entitlements);
  return visible.find((signer) => signer.signer_id === toText(signerId));
}

/**
 * Proposes an edit to a signer, re-checking entitlement, record eligibility,
 * and the local edit revision before recording an operation reference, a change
 * request, and a conservative overlay.
 *
 * Deny-by-default: the session must hold the manage capability, the signer must
 * be visible and eligible for each changed field, the supplied revision must
 * match the current record (else a concurrent edit is reported), and at least
 * one field must actually change. Every outcome is audited.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {string} signerId - The signer identifier.
 * @param {Record<string, unknown>} changes - The proposed field changes.
 * @param {{
 *   accountScopes?: string[],
 *   expectedRevision?: number,
 *   context?: string,
 * }} [options] - Optional options.
 * @returns {{
 *   ok: boolean,
 *   operationId?: string,
 *   changeRequestId?: string,
 *   diff?: Record<string, unknown>,
 *   safeReasonCode: string,
 * }} A discriminated result.
 */
export function proposeEdit(session, signerId, changes, options) {
  const actorId = resolveActorId(session);
  const subjectId = toText(signerId) || undefined;
  const source = isPlainObject(options) ? options : {};

  if (!canManage(session)) {
    audit(SIGNER_AUDIT_EVENTS.EDIT_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.UNAUTHORIZED,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.UNAUTHORIZED);
  }

  const repository = resolveRepository();
  const ledger = resolveLedger();
  if (!repository || !ledger) {
    return fail(SIGNER_SERVICE_REASON_CODES.UNEXPECTED);
  }

  const signer = loadVisibleSigner(
    repository,
    session,
    signerId,
    toStringArray(source.accountScopes),
  );
  if (!signer) {
    audit(SIGNER_AUDIT_EVENTS.EDIT_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.NOT_FOUND,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.NOT_FOUND);
  }

  const currentRevision = readRevision(signer);
  if (
    typeof source.expectedRevision === 'number' &&
    Number.isFinite(source.expectedRevision) &&
    Math.trunc(source.expectedRevision) !== currentRevision
  ) {
    audit(SIGNER_AUDIT_EVENTS.EDIT_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.CONCURRENT_EDIT,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.CONCURRENT_EDIT);
  }

  const sanitizedChanges = sanitizeChanges(changes);
  const diff = signerDiffService.diffSigner(signer, sanitizedChanges, {
    context: toText(source.context) || undefined,
  });

  if (!diff.hasChanges) {
    audit(SIGNER_AUDIT_EVENTS.EDIT_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.NO_CHANGES,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.NO_CHANGES);
  }

  for (const field of diff.changedFieldNames) {
    const evaluation = signerPolicy.evaluateEditField(signer, field);
    if (!evaluation.allowed) {
      audit(SIGNER_AUDIT_EVENTS.EDIT_DENIED, {
        actorId,
        subjectId,
        safeReasonCode: evaluation.safeReasonCode,
        metadata: { field },
      });
      return fail(SIGNER_SERVICE_REASON_CODES.FIELD_NOT_EDITABLE);
    }
  }

  const operationId = generateOperationId();
  const operationResult = ledger.recordOperation({
    operationId,
    kind: OPERATION_KINDS.CONFIRM,
    subjectId: toText(signerId),
    actorId,
    safeReasonCode: SIGNER_SERVICE_REASON_CODES.EDIT_RECORDED,
  });
  if (!operationResult.ok) {
    audit(SIGNER_AUDIT_EVENTS.EDIT_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.PERSIST_FAILED,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.PERSIST_FAILED);
  }

  const changeRequestId = generateOperationId();
  const changeRequestResult = ledger.recordChangeRequest({
    changeRequestId,
    subjectId: toText(signerId),
    actorId,
    safeReasonCode: SIGNER_SERVICE_REASON_CODES.EDIT_RECORDED,
    metadata: { fields: diff.changedFieldNames },
  });
  if (!changeRequestResult.ok) {
    audit(SIGNER_AUDIT_EVENTS.EDIT_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.PERSIST_FAILED,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.PERSIST_FAILED);
  }

  const overlays = repository.readOverlays().slice();
  const overlay = { signer_id: toText(signerId), ...sanitizedChanges };
  const existingIndex = overlays.findIndex(
    (item) => isPlainObject(item) && item.signer_id === toText(signerId),
  );
  if (existingIndex >= 0) {
    overlays[existingIndex] = { ...overlays[existingIndex], ...overlay };
  } else {
    overlays.push(overlay);
  }

  if (!repository.persistOverlays(overlays)) {
    audit(SIGNER_AUDIT_EVENTS.EDIT_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.PERSIST_FAILED,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.PERSIST_FAILED);
  }

  audit(SIGNER_AUDIT_EVENTS.EDIT_PROPOSED, {
    actorId,
    subjectId,
    safeReasonCode: SIGNER_SERVICE_REASON_CODES.EDIT_RECORDED,
    metadata: { fields: diff.changedFieldNames, revision: currentRevision },
  });

  return {
    ok: true,
    operationId,
    changeRequestId,
    diff,
    safeReasonCode: SIGNER_SERVICE_REASON_CODES.EDIT_RECORDED,
  };
}

/**
 * Completes the simulated eSign ceremony for an in-flight signer operation and,
 * on success, commits the recorded operation reference. Deny-by-default: the
 * session must hold the manage capability and the operation must exist.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {string} signerId - The signer identifier.
 * @param {string} operationId - The in-flight operation identifier.
 * @param {{ scenarioRef?: string, signal?: AbortSignal }} [options] - Optional options.
 * @returns {Promise<{
 *   ok: boolean,
 *   outcome?: string | null,
 *   nextStep?: Record<string, unknown> | null,
 *   safeReasonCode: string,
 * }>} A discriminated result.
 */
export async function completeESign(session, signerId, operationId, options) {
  const actorId = resolveActorId(session);
  const subjectId = toText(signerId) || undefined;
  const source = isPlainObject(options) ? options : {};

  if (!canManage(session)) {
    audit(SIGNER_AUDIT_EVENTS.ESIGN_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.UNAUTHORIZED,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.UNAUTHORIZED);
  }

  const ledger = resolveLedger();
  if (!ledger) {
    return fail(SIGNER_SERVICE_REASON_CODES.UNEXPECTED);
  }

  const resolvedOperationId = toText(operationId);
  if (resolvedOperationId.length === 0 || !ledger.hasOperation(resolvedOperationId)) {
    audit(SIGNER_AUDIT_EVENTS.ESIGN_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.OPERATION_NOT_FOUND,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.OPERATION_NOT_FOUND);
  }

  let result;
  try {
    result = await esignService.requestSignature(source.scenarioRef, { signal: source.signal });
  } catch (error) {
    safeLogger.error('signerService: unexpected error during eSign', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    audit(SIGNER_AUDIT_EVENTS.ESIGN_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.UNEXPECTED,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.UNEXPECTED);
  }

  if (!result.ok) {
    audit(SIGNER_AUDIT_EVENTS.ESIGN_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: result.safeReasonCode,
    });
    return {
      ok: false,
      outcome: result.outcome ?? null,
      nextStep: result.nextStep ?? null,
      safeReasonCode: result.safeReasonCode,
    };
  }

  const committed = ledger.completeOperation(resolvedOperationId, {
    safeReasonCode: SIGNER_SERVICE_REASON_CODES.ESIGN_COMPLETED,
  });
  if (!committed) {
    audit(SIGNER_AUDIT_EVENTS.ESIGN_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.PERSIST_FAILED,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.PERSIST_FAILED);
  }

  audit(SIGNER_AUDIT_EVENTS.ESIGN_COMPLETED, {
    actorId,
    subjectId,
    safeReasonCode: result.safeReasonCode,
    metadata: { outcome: result.outcome },
  });

  return {
    ok: true,
    outcome: result.outcome,
    nextStep: result.nextStep ?? null,
    safeReasonCode: SIGNER_SERVICE_REASON_CODES.ESIGN_COMPLETED,
  };
}

/**
 * Unlocks a locked signer via a bounded, revision-checked overlay, recording an
 * operation reference. Deny-by-default: the session must hold the manage
 * capability, the signer must be visible and unlock-eligible, and the supplied
 * revision (when present) must match the current record.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {string} signerId - The signer identifier.
 * @param {{ accountScopes?: string[], expectedRevision?: number }} [options] - Optional options.
 * @returns {{ ok: boolean, operationId?: string, safeReasonCode: string }} A discriminated result.
 */
export function unlock(session, signerId, options) {
  const actorId = resolveActorId(session);
  const subjectId = toText(signerId) || undefined;
  const source = isPlainObject(options) ? options : {};

  if (!canManage(session)) {
    audit(SIGNER_AUDIT_EVENTS.UNLOCK_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.UNAUTHORIZED,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.UNAUTHORIZED);
  }

  const repository = resolveRepository();
  const ledger = resolveLedger();
  if (!repository || !ledger) {
    return fail(SIGNER_SERVICE_REASON_CODES.UNEXPECTED);
  }

  const signer = loadVisibleSigner(
    repository,
    session,
    signerId,
    toStringArray(source.accountScopes),
  );
  if (!signer) {
    audit(SIGNER_AUDIT_EVENTS.UNLOCK_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.NOT_FOUND,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.NOT_FOUND);
  }

  const currentRevision = readRevision(signer);
  if (
    typeof source.expectedRevision === 'number' &&
    Number.isFinite(source.expectedRevision) &&
    Math.trunc(source.expectedRevision) !== currentRevision
  ) {
    audit(SIGNER_AUDIT_EVENTS.UNLOCK_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.CONCURRENT_EDIT,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.CONCURRENT_EDIT);
  }

  const evaluation = signerPolicy.evaluateUnlock(signer);
  if (!evaluation.allowed) {
    audit(SIGNER_AUDIT_EVENTS.UNLOCK_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: evaluation.safeReasonCode,
    });
    return fail(evaluation.safeReasonCode);
  }

  const operationId = generateOperationId();
  const operationResult = ledger.recordOperation({
    operationId,
    kind: OPERATION_KINDS.UNLOCK,
    subjectId: toText(signerId),
    actorId,
    safeReasonCode: SIGNER_SERVICE_REASON_CODES.UNLOCKED,
  });
  if (!operationResult.ok) {
    audit(SIGNER_AUDIT_EVENTS.UNLOCK_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.PERSIST_FAILED,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.PERSIST_FAILED);
  }

  const overlays = repository.readOverlays().slice();
  const overlay = { signer_id: toText(signerId), locked: false, lock_reason: null };
  const existingIndex = overlays.findIndex(
    (item) => isPlainObject(item) && item.signer_id === toText(signerId),
  );
  if (existingIndex >= 0) {
    overlays[existingIndex] = { ...overlays[existingIndex], ...overlay };
  } else {
    overlays.push(overlay);
  }

  if (!repository.persistOverlays(overlays)) {
    audit(SIGNER_AUDIT_EVENTS.UNLOCK_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.PERSIST_FAILED,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.PERSIST_FAILED);
  }

  ledger.completeOperation(operationId, {
    safeReasonCode: SIGNER_SERVICE_REASON_CODES.UNLOCKED,
  });

  audit(SIGNER_AUDIT_EVENTS.UNLOCKED, {
    actorId,
    subjectId,
    safeReasonCode: SIGNER_SERVICE_REASON_CODES.UNLOCKED,
    metadata: { revision: currentRevision },
  });

  return { ok: true, operationId, safeReasonCode: SIGNER_SERVICE_REASON_CODES.UNLOCKED };
}

/**
 * Resends a fresh invitation for an eligible signer, re-checking resend
 * eligibility (including the rolling 24-hour window) and recording a resend
 * operation reference. Deny-by-default: the session must hold the manage
 * capability and the signer must be visible and resend-eligible.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {string} signerId - The signer identifier.
 * @param {{ accountScopes?: string[] }} [options] - Optional options.
 * @returns {{ ok: boolean, operationId?: string, safeReasonCode: string }} A discriminated result.
 */
export function resendInvitation(session, signerId, options) {
  const actorId = resolveActorId(session);
  const subjectId = toText(signerId) || undefined;
  const source = isPlainObject(options) ? options : {};

  if (!canManage(session)) {
    audit(SIGNER_AUDIT_EVENTS.RESEND_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.UNAUTHORIZED,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.UNAUTHORIZED);
  }

  const repository = resolveRepository();
  const ledger = resolveLedger();
  if (!repository || !ledger) {
    return fail(SIGNER_SERVICE_REASON_CODES.UNEXPECTED);
  }

  const signer = loadVisibleSigner(
    repository,
    session,
    signerId,
    toStringArray(source.accountScopes),
  );
  if (!signer) {
    audit(SIGNER_AUDIT_EVENTS.RESEND_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.NOT_FOUND,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.NOT_FOUND);
  }

  const resendCount = ledger.countResendsWithin24h(toText(signerId));
  const evaluation = signerPolicy.evaluateResend(signer, { resendCount });
  if (!evaluation.allowed) {
    audit(SIGNER_AUDIT_EVENTS.RESEND_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: evaluation.safeReasonCode,
    });
    return fail(evaluation.safeReasonCode);
  }

  const operationId = generateOperationId();
  const operationResult = ledger.recordOperation({
    operationId,
    kind: OPERATION_KINDS.RESEND,
    subjectId: toText(signerId),
    actorId,
    safeReasonCode: SIGNER_SERVICE_REASON_CODES.INVITATION_RESENT,
  });
  if (!operationResult.ok) {
    audit(SIGNER_AUDIT_EVENTS.RESEND_DENIED, {
      actorId,
      subjectId,
      safeReasonCode: SIGNER_SERVICE_REASON_CODES.PERSIST_FAILED,
    });
    return fail(SIGNER_SERVICE_REASON_CODES.PERSIST_FAILED);
  }

  ledger.completeOperation(operationId, {
    safeReasonCode: SIGNER_SERVICE_REASON_CODES.INVITATION_RESENT,
  });

  audit(SIGNER_AUDIT_EVENTS.INVITATION_RESENT, {
    actorId,
    subjectId,
    safeReasonCode: SIGNER_SERVICE_REASON_CODES.INVITATION_RESENT,
    metadata: { resendCount: resendCount + 1 },
  });

  return {
    ok: true,
    operationId,
    safeReasonCode: SIGNER_SERVICE_REASON_CODES.INVITATION_RESENT,
  };
}

/**
 * Masks a raw value for a single PII field using the shared masking policy.
 * Exposed so callers can mask ad-hoc values consistently with the service.
 * @param {string} field - The PII field identifier.
 * @param {unknown} value - The raw value.
 * @param {string} [context] - Optional masking context.
 * @returns {string} The masked value.
 */
export function maskField(field, value, context) {
  return maskingPolicy.mask(field, value, context);
}

/**
 * The signer service contract, exposed as a single frozen object.
 * @type {{
 *   search: typeof search,
 *   getById: typeof getById,
 *   proposeEdit: typeof proposeEdit,
 *   completeESign: typeof completeESign,
 *   unlock: typeof unlock,
 *   resendInvitation: typeof resendInvitation,
 *   maskField: typeof maskField,
 *   configureSignerService: typeof configureSignerService,
 *   SIGNER_SERVICE_REASON_CODES: typeof SIGNER_SERVICE_REASON_CODES,
 *   SIGNER_AUDIT_EVENTS: typeof SIGNER_AUDIT_EVENTS,
 * }}
 */
export const signerService = Object.freeze({
  search,
  getById,
  proposeEdit,
  completeESign,
  unlock,
  resendInvitation,
  maskField,
  configureSignerService,
  SIGNER_SERVICE_REASON_CODES,
  SIGNER_AUDIT_EVENTS,
});

export default signerService;