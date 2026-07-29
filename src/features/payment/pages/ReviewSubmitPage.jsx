/**
 * Review & simulated submission page.
 *
 * ReviewSubmitPage is the final review-and-submit surface for the payment
 * initiation flow (SCRUM-814/817). It composes the representative ISO 20022
 * pain.001 message preview (via the {@link paymentFacade} and the presentational
 * {@link MessagePreview}) with a masked summary of the accepted FX quote and
 * fees, the validated beneficiary disposition, and the captured CBPR+ payment
 * details, then runs the simulated submission through the {@link paymentFacade}:
 *
 *   - A composed review section renders the source account, currency pair,
 *     accepted quote figures (instructed/settlement amounts, rate, fee, total
 *     debit, charge treatment), beneficiary disposition, and the CBPR+ message
 *     preview, all from sanitized, masked models.
 *   - Simulated submission runs the client-side duplicate guard: a repeated
 *     click after a completed submission is rejected as a duplicate rather than
 *     re-applied, and a duplicate instruction reference is surfaced with a
 *     clear, demo-safe message.
 *   - The submit control disables while its request is in flight so it can never
 *     be double-invoked, and the resolved payment reference is retained.
 *   - Outcomes are announced through the shared notification live regions and a
 *     local status message; a successful submission surfaces the accepted
 *     payment id and safe reason code so the surrounding flow can continue.
 *
 * The page renders only sanitized, masked copy — never PII beyond the masked
 * models the facade produces — and never mutates application state beyond its
 * own local submission model. It degrades gracefully: unauthorized, invalid, or
 * duplicate submissions resolve to a discriminated, customer-safe state so the
 * flow can gate the UI safely.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useAccessContext } from '@/app/useAccessContext';
import { useNotifications } from '@/app/NotificationContext';
import { paymentFacade } from '@/features/payment/services/paymentFacade';
import { fixtureRegistry } from '@/shared/fixtures/fixtureRegistry';
import { MessagePreview } from '@/features/payment/pages/MessagePreview';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { LoadingIndicator } from '@/shared/ui/LoadingIndicator';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { safeLogger } from '@/shared/logging/safeLogger';

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
 * Formats an identifier into a readable label.
 * @param {unknown} value - The raw identifier.
 * @returns {string} A human-readable label.
 */
function toLabel(value) {
  const text = toText(value);
  if (text.length === 0) {
    return '—';
  }
  return text
    .split(/[._-]/)
    .map((part) => (part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/**
 * Builds a minimal session claim shape for the payment facade from the
 * sanitized session identity.
 * @param {Record<string, unknown> | null | undefined} identity - The identity.
 * @returns {{ subjectId: string, roles: string[], capabilities: string[] }} A claim-like value.
 */
function toSessionClaim(identity) {
  if (!isPlainObject(identity)) {
    return { subjectId: '', roles: [], capabilities: [] };
  }
  return {
    subjectId: toText(identity.subjectId),
    roles: toStringArray(identity.roles),
    capabilities: toStringArray(identity.capabilities),
  };
}

/**
 * Formats a currency-leg amount for display.
 * @param {unknown} value - The raw amount.
 * @param {string} currency - The currency code.
 * @returns {string} A display-safe amount string.
 */
function formatAmount(value, currency) {
  const amount = toText(value);
  const code = toText(currency);
  if (amount.length === 0) {
    return '—';
  }
  return code.length > 0 ? `${amount} ${code}` : amount;
}

/**
 * Resolves a badge tone for a beneficiary disposition value.
 * @param {string} disposition - The policy disposition.
 * @returns {string} A tone from {@link STATUS_TONES}.
 */
function dispositionTone(disposition) {
  switch (disposition) {
    case 'allow':
      return STATUS_TONES.SUCCESS;
    case 'allow_with_override':
      return STATUS_TONES.WARNING;
    case 'block':
      return STATUS_TONES.CRITICAL;
    default:
      return STATUS_TONES.NEUTRAL;
  }
}

/**
 * Renders a single labeled detail row.
 * @param {{ label: string, children: React.ReactNode }} props - The row props.
 * @returns {React.ReactElement} The detail row element.
 */
function DetailRow({ label, children }) {
  return (
    <div className="flex flex-col gap-1 border-b border-primary-blue-100 py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="w-full text-sm font-medium text-primary-blue-700 sm:w-48">{label}</dt>
      <dd className="text-sm text-body">{children}</dd>
    </div>
  );
}

DetailRow.propTypes = {
  label: PropTypes.string.isRequired,
  children: PropTypes.node,
};

/**
 * Resolves the route determination (serial vs. cover) for a currency pair from
 * the bundled SWIFT scenarios fixture, falling back to the fixture's default
 * route determination when the pair has no specific entry.
 * @param {string} pairId - The currency pair identifier (e.g. `EUR-USD`).
 * @returns {{ routeType: string, coverRequired: boolean }} The resolved route.
 */
function resolveRouteDetermination(pairId) {
  const id = toText(pairId);
  let determinations = [];
  let defaultDetermination = null;
  try {
    const fixture = fixtureRegistry.getFixture(fixtureRegistry.FIXTURE_IDS.SWIFT_SCENARIOS);
    determinations = Array.isArray(fixture?.routeDeterminations) ? fixture.routeDeterminations : [];
    defaultDetermination = isPlainObject(fixture?.defaultRouteDetermination)
      ? fixture.defaultRouteDetermination
      : null;
  } catch {
    determinations = [];
    defaultDetermination = null;
  }

  const match =
    id.length > 0
      ? determinations.find((determination) => toText(determination?.pair_id) === id)
      : undefined;
  const resolved = match || defaultDetermination;
  if (!isPlainObject(resolved)) {
    return { routeType: 'serial', coverRequired: false };
  }
  return {
    routeType: toText(resolved.route_type) || 'serial',
    coverRequired: resolved.cover_required === true,
  };
}

/**
 * Builds the normalized payment aggregate used to preview the ISO 20022
 * messages from the accepted snapshot and captured CBPR+ details.
 * @param {Record<string, unknown>} snapshot - The accepted pricing snapshot.
 * @param {Record<string, unknown>} cbprDetails - The captured CBPR+ details.
 * @param {Record<string, unknown>} cbprSelector - The CBPR+ rule-set selector.
 * @param {string} [pairId] - The currency pair identifier, when known outside the snapshot.
 * @returns {Record<string, unknown>} The normalized aggregate.
 */
function buildAggregate(snapshot, cbprDetails, cbprSelector, pairId) {
  const pricing = isPlainObject(snapshot) && isPlainObject(snapshot.pricing) ? snapshot.pricing : {};
  const details = isPlainObject(cbprDetails) ? cbprDetails : {};
  const resolvedPairId = toText(pairId) || toText(snapshot?.pairId) || toText(pricing.pairId);
  const routing = resolveRouteDetermination(resolvedPairId);
  return {
    meta: {
      messageId: toText(snapshot.snapshotId),
      paymentReference: toText(snapshot.quoteRef),
      createdAt: toText(snapshot.acceptedAt),
      uetr: toText(details.uetr),
    },
    debtor: {
      name: toText(details.debtor_name),
      account: toText(details.debtor_account),
    },
    debtorAgent: {
      bic: toText(details.debtor_agent_bic),
    },
    creditor: {
      name: toText(details.creditor_name),
      account: toText(details.creditor_iban) || toText(details.creditor_account),
    },
    creditorAgent: {
      bic: toText(details.creditor_agent_bic),
    },
    intermediaryAgent: {
      bic: toText(details.intermediary_agent_bic),
    },
    amount: {
      instructedValue: toText(pricing.instructedValue),
      settlementValue: toText(pricing.settlementValue),
      chargeTreatment: toText(pricing.chargeTreatment) || toText(details.charge_treatment),
    },
    remittance: {
      unstructured: toText(details.remittance_information),
    },
    routing: {
      routeType: routing.routeType,
      coverRequired: routing.coverRequired,
    },
    cbprSelector: isPlainObject(cbprSelector) ? cbprSelector : {},
    cbprDetails: details,
  };
}

/**
 * Renders the review & simulated submission page.
 *
 * The page composes the pain.001 message preview with a masked summary of the
 * accepted quote, fees, beneficiary disposition, and captured CBPR+ details,
 * then runs the simulated submission through the payment facade. The submit
 * control disables while pending and retains its resolved payment reference so a
 * repeated click is rejected as a duplicate. Every outcome is announced, and a
 * successful submission surfaces the accepted payment to the caller via
 * `onSubmitted`.
 *
 * @param {{
 *   snapshot?: Record<string, unknown>,
 *   accountId?: string,
 *   pairId?: string,
 *   sourceCurrency?: string,
 *   beneficiaryCurrency?: string,
 *   cbprSelector?: Record<string, unknown>,
 *   cbprDetails?: Record<string, unknown>,
 *   validation?: Record<string, unknown>,
 *   disposition?: Record<string, unknown>,
 *   overrideReason?: string,
 *   scenarioRef?: string,
 *   onSubmitted?: (result: {
 *     paymentId: string,
 *     duplicate: boolean,
 *     safeReasonCode: string,
 *   }) => void,
 * }} props - The review submit page props.
 * @returns {React.ReactElement} The review submit page element.
 */
export function ReviewSubmitPage({
  snapshot,
  accountId,
  pairId,
  sourceCurrency,
  beneficiaryCurrency,
  cbprSelector,
  cbprDetails,
  validation,
  disposition,
  overrideReason,
  scenarioRef,
  onSubmitted,
}) {
  const { sessionIdentity } = useAccessContext();
  const { notify, NOTIFICATION_SEVERITIES } = useNotifications();

  const [messages, setMessages] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [acceptedPaymentId, setAcceptedPaymentId] = useState('');

  /** @type {React.MutableRefObject<string | null>} */
  const submissionRef = useRef(null);

  const session = useMemo(() => toSessionClaim(sessionIdentity), [sessionIdentity]);

  const resolvedSnapshot = useMemo(
    () => (isPlainObject(snapshot) ? snapshot : null),
    [snapshot],
  );

  const pricing = useMemo(
    () => (isPlainObject(resolvedSnapshot) && isPlainObject(resolvedSnapshot.pricing)
      ? resolvedSnapshot.pricing
      : null),
    [resolvedSnapshot],
  );

  const aggregate = useMemo(
    () =>
      resolvedSnapshot
        ? buildAggregate(
            resolvedSnapshot,
            cbprDetails,
            cbprSelector,
            toText(pairId) || toText(resolvedSnapshot.pairId),
          )
        : null,
    [resolvedSnapshot, cbprDetails, cbprSelector, pairId],
  );

  const resolvedSourceCurrency = useMemo(
    () => toText(sourceCurrency) || (pricing ? toText(pricing.sourceCurrency) : ''),
    [sourceCurrency, pricing],
  );

  const resolvedBeneficiaryCurrency = useMemo(
    () => toText(beneficiaryCurrency) || (pricing ? toText(pricing.beneficiaryCurrency) : ''),
    [beneficiaryCurrency, pricing],
  );

  const announce = useCallback(
    (severity, title, body) => {
      try {
        notify({ severity, title, body });
      } catch (error) {
        safeLogger.warn('ReviewSubmitPage: failed to announce notification', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    },
    [notify],
  );

  // Build the ISO 20022 message preview set for the composed aggregate.
  useEffect(() => {
    if (!aggregate) {
      setMessages(null);
      return;
    }

    let result;
    try {
      result = paymentFacade.previewSwiftMessages(session, aggregate);
    } catch (error) {
      safeLogger.warn('ReviewSubmitPage: failed to preview messages', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        safeReasonCode: paymentFacade.PAYMENT_FACADE_REASON_CODES.UNEXPECTED,
      };
    }

    setMessages(result.ok && isPlainObject(result.messages) ? result.messages : null);
  }, [aggregate, session]);

  const handleSubmit = useCallback(() => {
    if (submitting || !resolvedSnapshot) {
      return;
    }

    // Duplicate submission-reference rejection: a repeated click after a
    // completed submission is refused rather than re-applied.
    if (submissionRef.current !== null) {
      setErrorMessage('');
      setStatusMessage('This payment has already been submitted in this session.');
      announce(
        NOTIFICATION_SEVERITIES.INFO,
        'Already submitted',
        'This payment has already been submitted in this session.',
      );
      return;
    }

    setSubmitting(true);
    setErrorMessage('');
    setStatusMessage('');

    const instructionReference =
      toText(resolvedSnapshot.quoteRef) || toText(resolvedSnapshot.snapshotId);

    let result;
    try {
      result = paymentFacade.submitPayment(session, {
        instructionReference,
        paymentReference: instructionReference,
        quoteRef: toText(resolvedSnapshot.quoteRef) || undefined,
        pairId: toText(pairId) || toText(resolvedSnapshot.pairId) || undefined,
        accountId: toText(accountId) || undefined,
        scenarioRef: toText(scenarioRef) || undefined,
        cbprSelector: isPlainObject(cbprSelector) ? cbprSelector : undefined,
        cbprDetails: isPlainObject(cbprDetails) ? cbprDetails : undefined,
        validation: isPlainObject(validation) ? validation : undefined,
        overrideReason: toText(overrideReason) || undefined,
        snapshot: resolvedSnapshot,
      });
    } catch (error) {
      safeLogger.warn('ReviewSubmitPage: failed to submit payment', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        safeReasonCode: paymentFacade.PAYMENT_FACADE_REASON_CODES.UNEXPECTED,
      };
    }

    setSubmitting(false);

    if (result.ok) {
      const paymentId = toText(result.paymentId);
      submissionRef.current = paymentId || 'submitted';
      setAcceptedPaymentId(paymentId);
      const body =
        'The payment has been submitted for approval. No funds move — this is a simulated submission.';
      setStatusMessage(body);
      announce(NOTIFICATION_SEVERITIES.SUCCESS, 'Payment submitted', body);
      if (typeof onSubmitted === 'function') {
        onSubmitted({
          paymentId,
          duplicate: false,
          safeReasonCode: result.safeReasonCode,
        });
      }
      return;
    }

    if (result.safeReasonCode === paymentFacade.PAYMENT_FACADE_REASON_CODES.DUPLICATE_REFERENCE) {
      submissionRef.current = 'duplicate';
      const body =
        'A payment with this reference has already been recorded. No duplicate was created.';
      setErrorMessage(body);
      announce(NOTIFICATION_SEVERITIES.WARNING, 'Duplicate payment', body);
      if (typeof onSubmitted === 'function') {
        onSubmitted({
          paymentId: '',
          duplicate: true,
          safeReasonCode: result.safeReasonCode,
        });
      }
      return;
    }

    if (result.safeReasonCode === paymentFacade.PAYMENT_FACADE_REASON_CODES.QUOTE_EXPIRED) {
      const body =
        'The FX quote expired before this payment could be submitted. Request a fresh quote and try again.';
      setErrorMessage(body);
      announce(NOTIFICATION_SEVERITIES.WARNING, 'Quote expired', body);
      return;
    }

    if (result.safeReasonCode === paymentFacade.PAYMENT_FACADE_REASON_CODES.POLICY_BLOCKED) {
      const body =
        'The beneficiary could not be used for this payment and the submission was blocked.';
      setErrorMessage(body);
      announce(NOTIFICATION_SEVERITIES.CRITICAL, 'Submission blocked', body);
      return;
    }

    if (result.safeReasonCode === paymentFacade.PAYMENT_FACADE_REASON_CODES.OVERRIDE_REQUIRED) {
      const body =
        'A beneficiary override reason is required before this payment can be submitted.';
      setErrorMessage(body);
      announce(NOTIFICATION_SEVERITIES.WARNING, 'Override required', body);
      return;
    }

    if (result.safeReasonCode === paymentFacade.PAYMENT_FACADE_REASON_CODES.FORM_INVALID) {
      const body =
        'Some payment details could not be validated. Correct the details and try again.';
      setErrorMessage(body);
      announce(NOTIFICATION_SEVERITIES.WARNING, 'Check the payment details', body);
      return;
    }

    const body = 'The payment could not be submitted with your current role. Try again.';
    setErrorMessage(body);
    announce(NOTIFICATION_SEVERITIES.WARNING, 'Submission unavailable', body);
  }, [
    submitting,
    resolvedSnapshot,
    session,
    pairId,
    accountId,
    scenarioRef,
    cbprSelector,
    cbprDetails,
    validation,
    overrideReason,
    announce,
    NOTIFICATION_SEVERITIES,
    onSubmitted,
  ]);

  const submitted = submissionRef.current !== null && acceptedPaymentId.length > 0;
  const chargeTreatment = pricing ? toText(pricing.chargeTreatment) : '';
  const dispositionValue = isPlainObject(disposition) ? toText(disposition.disposition) : '';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-primary-blue-700">Review and submit</h1>
        <p className="text-sm text-body">
          Review the payment details, pricing, and message preview before submitting. Submission is
          simulated — no funds move and no message is transmitted.
        </p>
      </div>

      <Alert severity={ALERT_SEVERITIES.INFO} title="Simulated submission only">
        This is a demonstration. Submitting records a simulated payment for approval; no real funds
        move, no message reaches any provider, and duplicate submissions are prevented locally.
      </Alert>

      {!resolvedSnapshot || !pricing ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="Nothing to review">
          There is no accepted quote to review. Complete the quote and payment details steps before
          submitting.
        </Alert>
      ) : (
        <>
          <section
            aria-labelledby="review-summary-heading"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
          >
            <div className="flex flex-col gap-1">
              <h2 id="review-summary-heading" className="text-lg font-medium text-body">
                Payment summary
              </h2>
              <p className="text-sm text-body">
                Confirm the account, currencies, pricing, and charges for this payment.
              </p>
            </div>

            <dl className="flex flex-col">
              <DetailRow label="Source account">{toText(accountId) || '—'}</DetailRow>
              <DetailRow label="Currency pair">
                {toText(pairId) || toText(resolvedSnapshot.pairId) || '—'}
              </DetailRow>
              <DetailRow label="Source amount">
                {formatAmount(pricing.instructedValue, resolvedSourceCurrency)}
              </DetailRow>
              <DetailRow label="Beneficiary amount">
                {formatAmount(pricing.settlementValue, resolvedBeneficiaryCurrency)}
              </DetailRow>
              <DetailRow label="Rate">{toText(resolvedSnapshot.rate) || '—'}</DetailRow>
              <DetailRow label="Fee">
                {formatAmount(pricing.feeValue, resolvedSourceCurrency)}
              </DetailRow>
              <DetailRow label="Total debit">
                {formatAmount(pricing.totalDebitValue, resolvedSourceCurrency)}
              </DetailRow>
              <DetailRow label="Charge treatment">
                {chargeTreatment.length > 0 ? (
                  <StatusBadge tone={STATUS_TONES.NEUTRAL}>{chargeTreatment}</StatusBadge>
                ) : (
                  '—'
                )}
              </DetailRow>
            </dl>
          </section>

          {isPlainObject(validation) || isPlainObject(disposition) ? (
            <section
              aria-labelledby="review-beneficiary-heading"
              className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="review-beneficiary-heading" className="text-lg font-medium text-body">
                  Beneficiary
                </h2>
                {dispositionValue.length > 0 ? (
                  <StatusBadge tone={dispositionTone(dispositionValue)}>
                    {toLabel(dispositionValue)}
                  </StatusBadge>
                ) : null}
              </div>

              <dl className="flex flex-col">
                {isPlainObject(validation) ? (
                  <DetailRow label="Verification status">
                    {toLabel(validation.verificationStatus)}
                  </DetailRow>
                ) : null}
                <DetailRow label="Disposition">{toLabel(dispositionValue)}</DetailRow>
                {toText(overrideReason).length > 0 ? (
                  <DetailRow label="Override reason">{toText(overrideReason)}</DetailRow>
                ) : null}
              </dl>
            </section>
          ) : null}

          {messages !== null ? <MessagePreview messages={messages} /> : null}

          {statusMessage.length > 0 ? (
            <div role="status" aria-live="polite">
              <Alert severity={ALERT_SEVERITIES.SUCCESS} title="Payment submitted">
                {statusMessage}
                {acceptedPaymentId.length > 0 ? ` Payment reference: ${acceptedPaymentId}.` : ''}
              </Alert>
            </div>
          ) : null}

          {errorMessage.length > 0 ? (
            <Alert severity={ALERT_SEVERITIES.WARNING} title="Submission not completed">
              {errorMessage}
            </Alert>
          ) : null}

          <section
            aria-labelledby="review-submit-heading"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
          >
            <div className="flex flex-col gap-1">
              <h2 id="review-submit-heading" className="text-lg font-medium text-body">
                Submit payment
              </h2>
              <p className="text-sm text-body">
                Submitting records a simulated payment for approval. Duplicate submissions of the
                same reference are prevented in your browser for the demo only.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="primary"
                size="md"
                disabled={submitting || submitted}
                onClick={handleSubmit}
              >
                {submitted ? 'Payment submitted' : 'Submit payment'}
              </Button>
              {submitting ? (
                <LoadingIndicator size="sm" label="Submitting payment…" showLabel />
              ) : null}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

ReviewSubmitPage.propTypes = {
  snapshot: PropTypes.object,
  accountId: PropTypes.string,
  pairId: PropTypes.string,
  sourceCurrency: PropTypes.string,
  beneficiaryCurrency: PropTypes.string,
  cbprSelector: PropTypes.object,
  cbprDetails: PropTypes.object,
  validation: PropTypes.object,
  disposition: PropTypes.object,
  overrideReason: PropTypes.string,
  scenarioRef: PropTypes.string,
  onSubmitted: PropTypes.func,
};

export default ReviewSubmitPage;