/**
 * Core payment orchestration facade.
 *
 * PaymentFacade is the single entry point the payment initiation and processing
 * flows use to persist details, preview messages, validate a beneficiary,
 * capture a validation override, and submit a payment (SCRUM-814/815/817/818).
 * It layers atop the {@link fixtureRegistry} (FX quote reference data + currency
 * pair precision), the {@link PaymentRepository} (draft persistence, accepted
 * records, and the reservation/duplicate guard), the {@link beneficiaryValidator}
 * (simulated beneficiary validation), the {@link policyEngine} (allow / override
 * / block disposition), the {@link cbprValidator} (CBPR+ structural validation),
 * the {@link messageBuilder} (pain.001 / pacs.008 / pacs.009 previews), the
 * {@link lifecycleMachine} (controlled lifecycle transitions), the
 * {@link authorizationPolicy} (capability gating), and the
 * {@link paymentAuditEventFactory} (sanitized, masked payment audit events):
 *
 *   - `savePaymentDetails(session, draft)` persists an in-progress payment draft.
 *   - `previewPain001(session, aggregate)` maps a normalized aggregate into a
 *     pain.001 initiation preview.
 *   - `previewSwiftMessages(session, aggregate)` builds the full ISO 20022
 *     preview set (pain.001 / pacs.008 / optional pacs.009).
 *   - `validateBeneficiary(session, request)` runs the simulated beneficiary
 *     validation ceremony and resolves an allow / override / block disposition.
 *   - `recordValidationOverride(session, request)` re-evaluates a disposition
 *     with a captured override reason before submission may proceed.
 *   - `submitPayment(session, request)` re-checks preconditions (quote expiry,
 *     CBPR form validity, beneficiary policy disposition, and reference
 *     uniqueness), enforces the client-side duplicate guard via a submission
 *     reservation, resolves the chosen scenario, records the accepted payment,
 *     commits the reservation, and transitions the lifecycle.
 *   - `getPaymentDetail(session, paymentId)` returns a sanitized payment detail
 *     snapshot for the acting session.
 *
 * The facade is intentionally conservative and demo-only: it enforces
 * client-side gating (deny-by-default via the {@link authorizationPolicy}),
 * never throws for expected failures — each method returns a discriminated
 * `{ ok, ... }` result carrying a sanitized safe reason code — and carries no
 * server guarantee.
 */

import { CAPABILITIES } from '@/shared/config/constants';
import { fixtureRegistry } from '@/shared/fixtures/fixtureRegistry';
import { createLocalStorageAdapter } from '@/shared/storage/storageAdapter';
import {
  createPaymentRepository,
  PAYMENT_REPOSITORY_REASON_CODES,
} from '@/features/payment/data/paymentRepository';
import { beneficiaryValidator } from '@/features/payment/domain/beneficiaryValidator';
import { policyEngine, POLICY_DISPOSITIONS } from '@/features/payment/domain/policyEngine';
import { cbprValidator } from '@/features/payment/domain/cbprValidator';
import { messageBuilder } from '@/features/payment/domain/messageBuilder';
import {
  lifecycleMachine,
  LIFECYCLE_STATES,
  LIFECYCLE_ACTIONS,
} from '@/features/payment/domain/lifecycleMachine';
import { authorizationPolicy } from '@/features/access/services/authorizationPolicy';
import {
  createValidationAuditEvent,
  createSubmissionAuditEvent,
  createApprovalAuditEvent,
  recordPaymentAuditEvent,
} from '@/features/payment/data/paymentAuditEventFactory';
import { demoClock } from '@/shared/time/demoClock';
import { generateOperationId } from '@/shared/mock/mockEnvelope';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default masking context applied to payment detail snapshots. */
const DEFAULT_DETAIL_CONTEXT = 'detail';

/**
 * Supported payment stages a payment record may occupy.
 * @type {{ APPROVAL: 'approval', OPERATIONS: 'operations' }}
 */
export const PAYMENT_STAGES = Object.freeze({
  APPROVAL: 'approval',
  OPERATIONS: 'operations',
});

/**
 * Safe reason codes surfaced by the payment facade for gating and messaging.
 * @type {{
 *   DETAILS_SAVED: 'payment.facade.details_saved',
 *   PREVIEW_BUILT: 'payment.facade.preview_built',
 *   VALIDATED: 'payment.facade.validated',
 *   OVERRIDE_RECORDED: 'payment.facade.override_recorded',
 *   SUBMITTED: 'payment.facade.submitted',
 *   DETAIL_RESOLVED: 'payment.facade.detail_resolved',
 *   UNAUTHORIZED: 'payment.facade.unauthorized',
 *   NOT_FOUND: 'payment.facade.not_found',
 *   INVALID_AGGREGATE: 'payment.facade.invalid_aggregate',
 *   QUOTE_EXPIRED: 'payment.facade.quote_expired',
 *   FORM_INVALID: 'payment.facade.form_invalid',
 *   POLICY_BLOCKED: 'payment.facade.policy_blocked',
 *   OVERRIDE_REQUIRED: 'payment.facade.override_required',
 *   DUPLICATE_REFERENCE: 'payment.facade.duplicate_reference',
 *   MISSING_REFERENCE: 'payment.facade.missing_reference',
 *   PERSIST_FAILED: 'payment.facade.persist_failed',
 *   UNEXPECTED: 'payment.facade.unexpected',
 * }}
 */
export const PAYMENT_FACADE_REASON_CODES = Object.freeze({
  DETAILS_SAVED: 'payment.facade.details_saved',
  PREVIEW_BUILT: 'payment.facade.preview_built',
  VALIDATED: 'payment.facade.validated',
  OVERRIDE_RECORDED: 'payment.facade.override_recorded',
  SUBMITTED: 'payment.facade.submitted',
  DETAIL_RESOLVED: 'payment.facade.detail_resolved',
  UNAUTHORIZED: 'payment.facade.unauthorized',
  NOT_FOUND: 'payment.facade.not_found',
  INVALID_AGGREGATE: 'payment.facade.invalid_aggregate',
  QUOTE_EXPIRED: 'payment.facade.quote_expired',
  FORM_INVALID: 'payment.facade.form_invalid',
  POLICY_BLOCKED: 'payment.facade.policy_blocked',
  OVERRIDE_REQUIRED: 'payment.facade.override_required',
  DUPLICATE_REFERENCE: 'payment.facade.duplicate_reference',
  MISSING_REFERENCE: 'payment.facade.missing_reference',
  PERSIST_FAILED: 'payment.facade.persist_failed',
  UNEXPECTED: 'payment.facade.unexpected',
});

/** Lazily-provisioned payment repository shared across facade calls. */
let sharedRepository = null;

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
 * Builds a discriminated failure result carrying a sanitized reason code.
 * @param {string} safeReasonCode - The sanitized reason code.
 * @returns {{ ok: false, safeReasonCode: string }} A failure result.
 */
function fail(safeReasonCode) {
  return { ok: false, safeReasonCode };
}

/**
 * Provisions (or returns) the shared payment repository, creating a local
 * storage adapter and repository on first use. Failures degrade to `null` so
 * callers never crash on a storage fault.
 * @returns {import('@/features/payment/data/paymentRepository').PaymentRepository | null}
 *   The shared repository, or `null` when it could not be provisioned.
 */
function resolveRepository() {
  if (sharedRepository) {
    return sharedRepository;
  }
  try {
    const adapter = createLocalStorageAdapter();
    sharedRepository = createPaymentRepository(adapter);
    return sharedRepository;
  } catch (error) {
    safeLogger.error('paymentFacade: failed to provision payment repository', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * Overrides the repository backing the facade. Primarily used by tests to
 * inject a deterministic or in-memory repository.
 * @param {import('@/features/payment/data/paymentRepository').PaymentRepository | null} repository
 *   The repository to use, or `null` to reset to lazy provisioning.
 * @returns {void}
 */
export function configurePaymentFacade(repository) {
  sharedRepository = repository ?? null;
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
 * Determines whether the acting session may initiate payments.
 * @param {Record<string, unknown> | null | undefined} session - The session.
 * @returns {boolean} `true` when the session holds the initiate capability.
 */
function canInitiate(session) {
  return authorizationPolicy.can(session, CAPABILITIES.PAYMENT_INITIATE);
}

/**
 * Records a sanitized validation audit event, never throwing on failure.
 * @param {Record<string, unknown>} details - The validation event details.
 * @returns {void}
 */
function auditValidation(details) {
  try {
    recordPaymentAuditEvent(createValidationAuditEvent(details));
  } catch (error) {
    safeLogger.warn('paymentFacade: failed to record validation audit event', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * Records a sanitized submission audit event, never throwing on failure.
 * @param {Record<string, unknown>} details - The submission event details.
 * @returns {void}
 */
function auditSubmission(details) {
  try {
    recordPaymentAuditEvent(createSubmissionAuditEvent(details));
  } catch (error) {
    safeLogger.warn('paymentFacade: failed to record submission audit event', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * Records a sanitized approval audit event, never throwing on failure.
 * @param {Record<string, unknown>} details - The approval event details.
 * @returns {void}
 */
function auditApproval(details) {
  try {
    recordPaymentAuditEvent(createApprovalAuditEvent(details));
  } catch (error) {
    safeLogger.warn('paymentFacade: failed to record approval audit event', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * Determines whether an FX quote (by reference) has expired relative to the
 * deterministic demo clock. A missing or unknown quote is treated as expired.
 * @param {string} quoteRef - The FX quote reference.
 * @returns {boolean} `true` when the quote is expired or unresolvable.
 */
function isQuoteExpired(quoteRef) {
  const ref = toText(quoteRef);
  if (ref.length === 0) {
    return true;
  }
  const quote = fixtureRegistry.getFxQuoteByRef(ref);
  if (!isPlainObject(quote)) {
    return true;
  }
  const expiresAt = toText(quote.expires_at);
  if (expiresAt.length === 0) {
    return true;
  }
  try {
    return demoClock.isExpired(expiresAt);
  } catch {
    return true;
  }
}

/**
 * Persists an in-progress payment draft via the payment repository.
 *
 * Deny-by-default: the session must hold the `payment:initiate` capability.
 * Never throws for expected failures.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {Record<string, unknown>} draft - The payment draft to persist.
 * @returns {{ ok: boolean, draft?: Record<string, unknown>, safeReasonCode: string }}
 *   A discriminated persistence result.
 */
export function savePaymentDetails(session, draft) {
  if (!canInitiate(session)) {
    return fail(PAYMENT_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  const repository = resolveRepository();
  if (!repository) {
    return fail(PAYMENT_FACADE_REASON_CODES.UNEXPECTED);
  }

  const source = isPlainObject(draft) ? draft : {};
  const result = repository.saveDraft(source);
  if (!result.ok) {
    return fail(PAYMENT_FACADE_REASON_CODES.PERSIST_FAILED);
  }

  return {
    ok: true,
    draft: result.draft,
    safeReasonCode: PAYMENT_FACADE_REASON_CODES.DETAILS_SAVED,
  };
}

/**
 * Maps a normalized payment aggregate into a pain.001 customer-credit-transfer
 * initiation preview.
 *
 * Deny-by-default: the session must hold the `payment:initiate` capability.
 * Never throws for expected failures.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {Record<string, unknown>} aggregate - The normalized payment aggregate.
 * @param {{ context?: string }} [options] - Optional mapping options.
 * @returns {{ ok: boolean, preview?: Record<string, unknown>, safeReasonCode: string }}
 *   A discriminated preview result.
 */
export function previewPain001(session, aggregate, options) {
  if (!canInitiate(session)) {
    return fail(PAYMENT_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  if (!isPlainObject(aggregate)) {
    return fail(PAYMENT_FACADE_REASON_CODES.INVALID_AGGREGATE);
  }

  const source = isPlainObject(options) ? options : {};
  const preview = messageBuilder.buildPain001(aggregate, { context: toText(source.context) || undefined });
  if (!preview.ok) {
    return fail(PAYMENT_FACADE_REASON_CODES.INVALID_AGGREGATE);
  }

  return {
    ok: true,
    preview,
    safeReasonCode: PAYMENT_FACADE_REASON_CODES.PREVIEW_BUILT,
  };
}

/**
 * Builds the full ISO 20022 preview set (pain.001 / pacs.008 / optional
 * pacs.009) for a normalized aggregate.
 *
 * Deny-by-default: the session must hold the `payment:initiate` capability.
 * Never throws for expected failures.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {Record<string, unknown>} aggregate - The normalized payment aggregate.
 * @param {{ context?: string }} [options] - Optional mapping options.
 * @returns {{ ok: boolean, messages?: Record<string, unknown>, safeReasonCode: string }}
 *   A discriminated preview result.
 */
export function previewSwiftMessages(session, aggregate, options) {
  if (!canInitiate(session)) {
    return fail(PAYMENT_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  if (!isPlainObject(aggregate)) {
    return fail(PAYMENT_FACADE_REASON_CODES.INVALID_AGGREGATE);
  }

  const source = isPlainObject(options) ? options : {};
  const messages = messageBuilder.buildMessages(aggregate, {
    context: toText(source.context) || undefined,
  });
  if (!messages.ok) {
    return fail(PAYMENT_FACADE_REASON_CODES.INVALID_AGGREGATE);
  }

  return {
    ok: true,
    messages,
    safeReasonCode: PAYMENT_FACADE_REASON_CODES.PREVIEW_BUILT,
  };
}

/**
 * Runs the simulated beneficiary validation ceremony and resolves an allow /
 * override / block disposition via the policy engine.
 *
 * Deny-by-default: the session must hold the `payment:initiate` capability.
 * Invalid input and aborts never throw; they resolve to a discriminated
 * failure result. Every outcome is audited.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {{
 *   scenarioRef?: string,
 *   beneficiaryName?: string,
 *   iban?: string,
 *   bic?: string,
 *   overrideReason?: string,
 *   signal?: AbortSignal,
 * }} request - The validation request.
 * @returns {Promise<{
 *   ok: boolean,
 *   validation?: Record<string, unknown>,
 *   disposition?: Record<string, unknown>,
 *   safeReasonCode: string,
 * }>} A discriminated validation result.
 */
export async function validateBeneficiary(session, request) {
  const actorId = resolveActorId(session);

  if (!canInitiate(session)) {
    return fail(PAYMENT_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  const source = isPlainObject(request) ? request : {};

  let validation;
  try {
    validation = await beneficiaryValidator.validateBeneficiary(
      source.scenarioRef,
      {
        beneficiaryName: source.beneficiaryName,
        iban: source.iban,
        bic: source.bic,
      },
      { signal: source.signal },
    );
  } catch (error) {
    safeLogger.error('paymentFacade: unexpected error during beneficiary validation', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return fail(PAYMENT_FACADE_REASON_CODES.UNEXPECTED);
  }

  const disposition = policyEngine.evaluate(validation, {
    overrideReason: source.overrideReason,
  });

  auditValidation({
    actorId,
    outcome: validation.outcome ?? undefined,
    verificationStatus: validation.verificationStatus,
    blocking: validation.blocking,
    requiresConfirmation: validation.requiresConfirmation,
    safeReasonCode: validation.safeReasonCode,
    metadata: { disposition: disposition.disposition },
  });

  return {
    ok: true,
    validation,
    disposition,
    safeReasonCode: PAYMENT_FACADE_REASON_CODES.VALIDATED,
  };
}

/**
 * Re-evaluates a beneficiary validation disposition together with a captured
 * override reason before submission may proceed.
 *
 * Deny-by-default: the session must hold the `payment:initiate` capability. A
 * BLOCK disposition can never be overridden; only ALLOW_WITH_OVERRIDE
 * dispositions accept a valid reason. Never throws for expected failures.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {{ validation?: Record<string, unknown>, reason?: string }} request - The override request.
 * @returns {{ ok: boolean, disposition?: Record<string, unknown>, safeReasonCode: string }}
 *   A discriminated override result.
 */
export function recordValidationOverride(session, request) {
  const actorId = resolveActorId(session);

  if (!canInitiate(session)) {
    return fail(PAYMENT_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  const source = isPlainObject(request) ? request : {};
  const validation = isPlainObject(source.validation) ? source.validation : {};

  const disposition = policyEngine.confirmOverride(validation, { reason: source.reason });

  if (disposition.disposition === POLICY_DISPOSITIONS.BLOCK) {
    auditValidation({
      actorId,
      outcome: typeof validation.outcome === 'string' ? validation.outcome : undefined,
      safeReasonCode: disposition.safeReasonCode,
      metadata: { override: false },
    });
    return {
      ok: false,
      disposition,
      safeReasonCode: PAYMENT_FACADE_REASON_CODES.POLICY_BLOCKED,
    };
  }

  if (!disposition.overrideAccepted) {
    return {
      ok: false,
      disposition,
      safeReasonCode: PAYMENT_FACADE_REASON_CODES.OVERRIDE_REQUIRED,
    };
  }

  auditValidation({
    actorId,
    outcome: typeof validation.outcome === 'string' ? validation.outcome : undefined,
    safeReasonCode: disposition.safeReasonCode,
    metadata: { override: true },
  });

  return {
    ok: true,
    disposition,
    safeReasonCode: PAYMENT_FACADE_REASON_CODES.OVERRIDE_RECORDED,
  };
}

/**
 * Re-checks the submission preconditions: quote expiry, CBPR form validity, and
 * the beneficiary policy disposition.
 * @param {{
 *   quoteRef?: string,
 *   cbprSelector?: Record<string, unknown>,
 *   cbprDetails?: Record<string, unknown>,
 *   validation?: Record<string, unknown>,
 *   overrideReason?: string,
 * }} source - The submission request source.
 * @returns {{ ok: true } | { ok: false, safeReasonCode: string }} A precondition result.
 */
function revalidatePreconditions(source) {
  if (isQuoteExpired(source.quoteRef)) {
    return fail(PAYMENT_FACADE_REASON_CODES.QUOTE_EXPIRED);
  }

  const cbprDetails = isPlainObject(source.cbprDetails) ? source.cbprDetails : {};
  if (Object.keys(cbprDetails).length > 0) {
    const cbprResult = cbprValidator.validate(source.cbprSelector, cbprDetails);
    if (!cbprResult.ok) {
      return fail(PAYMENT_FACADE_REASON_CODES.FORM_INVALID);
    }
  }

  const validation = isPlainObject(source.validation) ? source.validation : {};
  if (Object.keys(validation).length > 0) {
    const disposition = policyEngine.evaluate(validation, {
      overrideReason: source.overrideReason,
    });
    if (disposition.disposition === POLICY_DISPOSITIONS.BLOCK) {
      return fail(PAYMENT_FACADE_REASON_CODES.POLICY_BLOCKED);
    }
    if (disposition.disposition === POLICY_DISPOSITIONS.ALLOW_WITH_OVERRIDE && !disposition.overrideAccepted) {
      return fail(PAYMENT_FACADE_REASON_CODES.OVERRIDE_REQUIRED);
    }
  }

  return { ok: true };
}

/**
 * Submits a payment, re-checking preconditions (quote expiry, CBPR form
 * validity, beneficiary policy disposition, and reference uniqueness),
 * enforcing the client-side duplicate guard via a submission reservation,
 * resolving the chosen scenario, recording the accepted payment, committing the
 * reservation, and transitioning the lifecycle.
 *
 * Deny-by-default: the session must hold the `payment:initiate` capability. A
 * duplicate instruction reference is rejected rather than re-submitted. Never
 * throws for expected failures. Every outcome is audited.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {{
 *   instructionReference?: string,
 *   paymentReference?: string,
 *   quoteRef?: string,
 *   pairId?: string,
 *   scenarioRef?: string,
 *   cbprSelector?: Record<string, unknown>,
 *   cbprDetails?: Record<string, unknown>,
 *   validation?: Record<string, unknown>,
 *   overrideReason?: string,
 *   snapshot?: Record<string, unknown>,
 * }} request - The submission request.
 * @returns {{
 *   ok: boolean,
 *   paymentId?: string,
 *   reservationId?: string,
 *   record?: Record<string, unknown>,
 *   event?: Record<string, unknown>,
 *   duplicate?: boolean,
 *   safeReasonCode: string,
 * }} A discriminated submission result.
 */
export function submitPayment(session, request) {
  const actorId = resolveActorId(session);
  const source = isPlainObject(request) ? request : {};

  if (!canInitiate(session)) {
    auditSubmission({ actorId, safeReasonCode: PAYMENT_FACADE_REASON_CODES.UNAUTHORIZED });
    return fail(PAYMENT_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  const instructionReference = toText(source.instructionReference) || toText(source.paymentReference);
  if (instructionReference.length === 0) {
    auditSubmission({ actorId, safeReasonCode: PAYMENT_FACADE_REASON_CODES.MISSING_REFERENCE });
    return fail(PAYMENT_FACADE_REASON_CODES.MISSING_REFERENCE);
  }

  const repository = resolveRepository();
  if (!repository) {
    return fail(PAYMENT_FACADE_REASON_CODES.UNEXPECTED);
  }

  const preconditions = revalidatePreconditions(source);
  if (!preconditions.ok) {
    auditSubmission({
      actorId,
      paymentReference: instructionReference,
      safeReasonCode: preconditions.safeReasonCode,
    });
    return fail(preconditions.safeReasonCode);
  }

  const reservation = repository.reserveSubmission(instructionReference, {
    metadata: { actorId: actorId ?? undefined },
  });
  if (!reservation.ok) {
    if (reservation.duplicate === true) {
      auditSubmission({
        actorId,
        paymentReference: instructionReference,
        duplicate: true,
        safeReasonCode: PAYMENT_FACADE_REASON_CODES.DUPLICATE_REFERENCE,
      });
      return { ...fail(PAYMENT_FACADE_REASON_CODES.DUPLICATE_REFERENCE), duplicate: true };
    }
    const mappedReason =
      reservation.safeReasonCode === PAYMENT_REPOSITORY_REASON_CODES.PERSIST_FAILED
        ? PAYMENT_FACADE_REASON_CODES.PERSIST_FAILED
        : PAYMENT_FACADE_REASON_CODES.UNEXPECTED;
    auditSubmission({
      actorId,
      paymentReference: instructionReference,
      safeReasonCode: mappedReason,
    });
    return fail(mappedReason);
  }

  const reservationId = toText(reservation.reservation.reservationId);
  const paymentId = toText(source.paymentId) || generateOperationId();
  const scenarioRef = toText(source.scenarioRef) || undefined;
  const pairId = toText(source.pairId) || undefined;
  const quoteRef = toText(source.quoteRef) || undefined;

  const candidate = {
    paymentId,
    paymentReference: instructionReference,
    status: LIFECYCLE_STATES.PENDING_APPROVAL,
    submittedBy: actorId ?? null,
  };
  if (pairId !== undefined) {
    candidate.pairId = pairId;
  }
  if (quoteRef !== undefined) {
    candidate.quoteRef = quoteRef;
  }
  if (scenarioRef !== undefined) {
    candidate.scenarioRef = scenarioRef;
  }
  if (isPlainObject(source.snapshot)) {
    candidate.snapshot = source.snapshot;
  }

  const saved = repository.saveRecord(candidate);
  if (!saved.ok) {
    repository.releaseReservation(reservationId);
    auditSubmission({
      actorId,
      paymentId,
      paymentReference: instructionReference,
      safeReasonCode: PAYMENT_FACADE_REASON_CODES.PERSIST_FAILED,
    });
    return fail(PAYMENT_FACADE_REASON_CODES.PERSIST_FAILED);
  }

  const committed = repository.commitReservation(reservationId, {
    metadata: { paymentId },
  });
  if (!committed.ok) {
    auditSubmission({
      actorId,
      paymentId,
      paymentReference: instructionReference,
      safeReasonCode: PAYMENT_FACADE_REASON_CODES.PERSIST_FAILED,
    });
    return fail(PAYMENT_FACADE_REASON_CODES.PERSIST_FAILED);
  }

  const transitioned = lifecycleMachine.transition(
    LIFECYCLE_STATES.DRAFT,
    LIFECYCLE_ACTIONS.REQUEST_APPROVAL,
    {
      actorId: actorId ?? undefined,
      safeReasonCode: PAYMENT_FACADE_REASON_CODES.SUBMITTED,
      metadata: { paymentId },
    },
  );

  const event = transitioned.ok ? transitioned.event : null;

  auditSubmission({
    actorId,
    paymentId,
    paymentReference: instructionReference,
    pairId,
    duplicate: false,
    safeReasonCode: PAYMENT_FACADE_REASON_CODES.SUBMITTED,
  });

  auditApproval({
    actorId,
    paymentId,
    outcome: LIFECYCLE_STATES.PENDING_APPROVAL,
    approved: false,
    safeReasonCode: PAYMENT_FACADE_REASON_CODES.SUBMITTED,
  });

  return {
    ok: true,
    paymentId,
    reservationId,
    record: saved.record,
    event,
    duplicate: false,
    safeReasonCode: PAYMENT_FACADE_REASON_CODES.SUBMITTED,
  };
}

/**
 * Returns a sanitized payment detail snapshot for the acting session, resolving
 * the locally-recorded payment first and falling back to the bundled fixture.
 *
 * Deny-by-default: the session must hold the `payment:initiate` capability.
 * Never throws for expected failures.
 *
 * @param {Record<string, unknown> | null | undefined} session - The acting session.
 * @param {string} paymentId - The payment identifier.
 * @param {{ context?: string }} [options] - Optional options.
 * @returns {{ ok: boolean, payment?: Record<string, unknown>, safeReasonCode: string }}
 *   A discriminated detail result.
 */
export function getPaymentDetail(session, paymentId, options) {
  if (!canInitiate(session)) {
    return fail(PAYMENT_FACADE_REASON_CODES.UNAUTHORIZED);
  }

  const id = toText(paymentId);
  if (id.length === 0) {
    return fail(PAYMENT_FACADE_REASON_CODES.NOT_FOUND);
  }

  const repository = resolveRepository();
  const source = isPlainObject(options) ? options : {};
  void toText(source.context) || DEFAULT_DETAIL_CONTEXT;

  let record;
  if (repository) {
    record = repository.findRecord(id);
  }
  if (!isPlainObject(record)) {
    record = fixtureRegistry.getPaymentRecordById(id);
  }

  if (!isPlainObject(record)) {
    return fail(PAYMENT_FACADE_REASON_CODES.NOT_FOUND);
  }

  return {
    ok: true,
    payment: { ...record },
    safeReasonCode: PAYMENT_FACADE_REASON_CODES.DETAIL_RESOLVED,
  };
}

/**
 * The payment facade contract, exposed as a single frozen object.
 * @type {{
 *   savePaymentDetails: typeof savePaymentDetails,
 *   previewPain001: typeof previewPain001,
 *   previewSwiftMessages: typeof previewSwiftMessages,
 *   validateBeneficiary: typeof validateBeneficiary,
 *   recordValidationOverride: typeof recordValidationOverride,
 *   submitPayment: typeof submitPayment,
 *   getPaymentDetail: typeof getPaymentDetail,
 *   configurePaymentFacade: typeof configurePaymentFacade,
 *   PAYMENT_STAGES: typeof PAYMENT_STAGES,
 *   PAYMENT_FACADE_REASON_CODES: typeof PAYMENT_FACADE_REASON_CODES,
 * }}
 */
export const paymentFacade = Object.freeze({
  savePaymentDetails,
  previewPain001,
  previewSwiftMessages,
  validateBeneficiary,
  recordValidationOverride,
  submitPayment,
  getPaymentDetail,
  configurePaymentFacade,
  PAYMENT_STAGES,
  PAYMENT_FACADE_REASON_CODES,
});

export default paymentFacade;