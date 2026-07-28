/**
 * Confirmation & tracking page.
 *
 * ConfirmationPage is the post-submission confirmation and tracking surface for
 * the payment initiation flow (SCRUM-818). It reads a sanitized, masked payment
 * detail snapshot from the read-only {@link paymentLifecycleFacade} for the
 * payment id it is given, and presents:
 *
 *   - The payment reference, current lifecycle status, and a fake SWIFT/UETR
 *     tracking reference so the demo nature of the tracking is unmistakable.
 *   - A masked summary of the debit account, beneficiary, instructed and
 *     settlement amounts, the applied FX rate, fees, and charge treatment.
 *   - A clear next-steps panel derived from the payment's current lifecycle
 *     state so the user knows what happens next.
 *   - The simulated {@link StatusTimeline} for the payment and, when message
 *     preview inputs are supplied, the representative ISO 20022 previews via
 *     {@link MessagePreview}.
 *
 * The page renders only sanitized, masked copy — never raw PII beyond the masked
 * models the facade produces — and never mutates application state beyond its
 * own local load/error model. It degrades gracefully: a missing or unresolvable
 * payment resolves to an accessible not-found state so the surrounding flow can
 * gate the UI safely.
 */

import { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { paymentLifecycleFacade } from '@/features/payment/services/paymentLifecycleFacade';
import { StatusTimeline } from '@/features/payment/pages/StatusTimeline';
import { MessagePreview } from '@/features/payment/pages/MessagePreview';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { cn } from '@/shared/ui/cn';
import { safeLogger } from '@/shared/logging/safeLogger';

/**
 * Next-step guidance keyed by lifecycle status, so the user always knows what
 * happens next after a submission.
 * @type {Record<string, { title: string, body: string }>}
 */
const NEXT_STEPS = Object.freeze({
  draft: {
    title: 'Complete the payment',
    body: 'This payment is still a draft. Finish entering the details and submit it for approval.',
  },
  validated: {
    title: 'Awaiting processing',
    body: 'The payment details have been validated and the payment is ready to progress.',
  },
  processing: {
    title: 'Processing in progress',
    body: 'The payment is progressing through the simulated compliance and settlement checks. No action is needed right now.',
  },
  pending_review: {
    title: 'Held for review',
    body: 'A check raised a concern, so this payment is held pending an operator decision in the operations queue.',
  },
  repair_required: {
    title: 'Repair required',
    body: 'A correctable data issue was found. Repair the payment details in the operations view and resubmit.',
  },
  pending_approval: {
    title: 'Awaiting approval',
    body: 'This payment has been submitted and is waiting for an approver to review and approve it before release.',
  },
  accepted: {
    title: 'Accepted for processing',
    body: 'The payment was approved and accepted. It will now progress toward transmission.',
  },
  sent_to_swift: {
    title: 'Sent to SWIFT',
    body: 'The payment message has been transmitted to the simulated SWIFT network and is awaiting acknowledgement.',
  },
  acknowledged: {
    title: 'Acknowledged',
    body: 'The simulated SWIFT network acknowledged the message and accepted it for onward delivery. No further action is required.',
  },
  rejected: {
    title: 'Payment rejected',
    body: 'A blocking check or acknowledgement failure rejected this payment. No funds were moved.',
  },
});

/** Fallback next-step guidance used when a status has no dedicated entry. */
const FALLBACK_NEXT_STEP = Object.freeze({
  title: 'Track your payment',
  body: 'Use the status timeline below to follow the simulated progress of this payment.',
});

/** Prefix applied to the fake SWIFT tracking reference. */
const SWIFT_TRACKING_PREFIX = 'demo-swift';

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
 * Resolves a badge tone for a lifecycle status value.
 * @param {string} status - The lifecycle status.
 * @returns {string} A tone from {@link STATUS_TONES}.
 */
function statusTone(status) {
  switch (status) {
    case 'acknowledged':
    case 'accepted':
      return STATUS_TONES.SUCCESS;
    case 'rejected':
      return STATUS_TONES.CRITICAL;
    case 'pending_review':
    case 'repair_required':
    case 'pending_approval':
      return STATUS_TONES.WARNING;
    case 'processing':
    case 'validated':
    case 'sent_to_swift':
      return STATUS_TONES.INFO;
    case 'draft':
    default:
      return STATUS_TONES.NEUTRAL;
  }
}

/**
 * Builds a demo-safe SWIFT/UETR tracking reference from the payment snapshot.
 * @param {Record<string, unknown>} payment - The masked payment detail model.
 * @returns {string} A fake SWIFT tracking reference.
 */
function buildTrackingReference(payment) {
  const uetr = toText(payment.uetr);
  if (uetr.length > 0) {
    return `${SWIFT_TRACKING_PREFIX}-${uetr}`;
  }
  const reference = toText(payment.paymentReference) || toText(payment.paymentId);
  return reference.length > 0 ? `${SWIFT_TRACKING_PREFIX}-${reference}` : '—';
}

/**
 * Resolves the next-step guidance for a lifecycle status.
 * @param {string} status - The lifecycle status.
 * @returns {{ title: string, body: string }} The next-step guidance.
 */
function resolveNextStep(status) {
  return Object.prototype.hasOwnProperty.call(NEXT_STEPS, status)
    ? NEXT_STEPS[status]
    : FALLBACK_NEXT_STEP;
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
 * Renders the confirmation & tracking page.
 *
 * The page loads a masked payment detail snapshot for the supplied payment id,
 * presents its reference, status, fake SWIFT/UETR tracking reference, masked
 * summary, and next-step guidance, and composes the simulated status timeline
 * (and, when preview inputs are supplied, the ISO 20022 message previews). A
 * missing or unresolvable payment degrades to an accessible not-found state.
 *
 * @param {{
 *   paymentId?: string,
 *   timelineRecords?: Array<Record<string, unknown>>,
 *   timelineEvents?: Array<Record<string, unknown>>,
 *   messages?: Record<string, unknown> | null,
 * }} props - The confirmation page props.
 * @returns {React.ReactElement} The confirmation page element.
 */
export function ConfirmationPage({ paymentId, timelineRecords, timelineEvents, messages }) {
  const [payment, setPayment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotFound(false);

    const id = toText(paymentId);

    let result;
    try {
      result = paymentLifecycleFacade.getPaymentDetail(id);
    } catch (error) {
      safeLogger.warn('ConfirmationPage: failed to load payment detail', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        safeReasonCode: paymentLifecycleFacade.PAYMENT_LIFECYCLE_REASON_CODES.UNEXPECTED,
      };
    }

    if (!active) {
      return;
    }

    if (result.ok && isPlainObject(result.payment)) {
      setPayment(result.payment);
      setNotFound(false);
    } else {
      setPayment(null);
      setNotFound(true);
    }
    setLoading(false);

    return () => {
      active = false;
    };
  }, [paymentId]);

  const status = useMemo(
    () => (isPlainObject(payment) ? toText(payment.status) : ''),
    [payment],
  );

  const trackingReference = useMemo(
    () => (isPlainObject(payment) ? buildTrackingReference(payment) : '—'),
    [payment],
  );

  const nextStep = useMemo(() => resolveNextStep(status), [status]);

  const sourceCurrency = useMemo(
    () => (isPlainObject(payment) ? toText(payment.sourceCurrency) : ''),
    [payment],
  );

  const beneficiaryCurrency = useMemo(
    () => (isPlainObject(payment) ? toText(payment.beneficiaryCurrency) : ''),
    [payment],
  );

  const hasMessages = isPlainObject(messages);

  const resolvedInitialState = useMemo(
    () => (status.length > 0 ? status : undefined),
    [status],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-primary-blue-700">Payment confirmation</h1>
        <p className="text-sm text-body">
          Track the simulated progress of your payment. All references, statuses, and tracking data
          shown here are fabricated for demonstration only.
        </p>
      </div>

      <Alert severity={ALERT_SEVERITIES.INFO} title="Simulated tracking only">
        This confirmation and tracking view is a demonstration. No funds move, no message reaches any
        provider, and the SWIFT/UETR tracking reference is fabricated. Do not treat it as a real
        payment status.
      </Alert>

      {loading ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-primary-blue-100 bg-white px-4 py-6 text-center text-sm text-body"
        >
          Loading payment…
        </div>
      ) : notFound || !isPlainObject(payment) ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="Payment not found">
          The requested payment could not be located for tracking. It may not exist in this demo
          session, or the reference may be incorrect.
        </Alert>
      ) : (
        <>
          <section
            aria-labelledby="confirmation-summary-heading"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <h2 id="confirmation-summary-heading" className="text-lg font-medium text-body">
                  {toText(payment.paymentReference) || toText(payment.paymentId) || '—'}
                </h2>
                <span className="text-xs text-body">{toText(payment.paymentId)}</span>
              </div>
              {status.length > 0 ? (
                <StatusBadge tone={statusTone(status)}>{toLabel(status)}</StatusBadge>
              ) : null}
            </div>

            <dl className="flex flex-col">
              <DetailRow label="Payment reference">
                {toText(payment.paymentReference) || '—'}
              </DetailRow>
              <DetailRow label="Status">{toLabel(status)}</DetailRow>
              <DetailRow label="Tracking reference">{trackingReference}</DetailRow>
              <DetailRow label="Debit account">{toText(payment.accountId) || '—'}</DetailRow>
              <DetailRow label="Beneficiary">{toText(payment.beneficiaryName) || '—'}</DetailRow>
              <DetailRow label="Currency pair">{toText(payment.pairId) || '—'}</DetailRow>
              <DetailRow label="Instructed amount">
                {formatAmount(payment.instructedAmount, sourceCurrency)}
              </DetailRow>
              <DetailRow label="Settlement amount">
                {formatAmount(payment.settlementAmount, beneficiaryCurrency)}
              </DetailRow>
              <DetailRow label="FX rate">{toText(payment.rate) || '—'}</DetailRow>
              <DetailRow label="Fee">
                {formatAmount(payment.feeAmount, toText(payment.feeCurrency) || sourceCurrency)}
              </DetailRow>
              <DetailRow label="Charge treatment">
                {toText(payment.chargeTreatment).length > 0 ? (
                  <StatusBadge tone={STATUS_TONES.NEUTRAL}>
                    {toText(payment.chargeTreatment)}
                  </StatusBadge>
                ) : (
                  '—'
                )}
              </DetailRow>
              <DetailRow label="Remittance information">
                {toText(payment.remittanceInfo) || '—'}
              </DetailRow>
            </dl>
          </section>

          <section
            aria-labelledby="confirmation-next-heading"
            className={cn(
              'flex flex-col gap-2 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-6',
            )}
          >
            <h2 id="confirmation-next-heading" className="text-lg font-medium text-body">
              What happens next
            </h2>
            <p className="text-sm font-medium text-primary-blue-700">{nextStep.title}</p>
            <p className="text-sm text-body">{nextStep.body}</p>
          </section>

          <StatusTimeline
            events={Array.isArray(timelineEvents) ? timelineEvents : undefined}
            records={Array.isArray(timelineRecords) ? timelineRecords : undefined}
            initialState={resolvedInitialState}
          />

          {hasMessages ? <MessagePreview messages={messages} /> : null}
        </>
      )}
    </div>
  );
}

ConfirmationPage.propTypes = {
  paymentId: PropTypes.string,
  timelineRecords: PropTypes.arrayOf(PropTypes.object),
  timelineEvents: PropTypes.arrayOf(PropTypes.object),
  messages: PropTypes.object,
};

export default ConfirmationPage;