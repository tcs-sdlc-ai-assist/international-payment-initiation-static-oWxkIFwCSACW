/**
 * FX quote card component.
 *
 * QuoteCard is the presentational surface for an accepted or in-progress FX
 * quote in the payment initiation flow (SCRUM-813/816). It renders the resolved
 * quote view model produced by the {@link quoteFacade} — source and beneficiary
 * currencies and amounts, the applied rate, the quote timestamp, an expiry
 * countdown driven by the deterministic {@link demoClock}, the quote
 * classification (indicative vs executable), and the pricing breakdown (fee,
 * charge treatment, and total debit). It also supports dynamic amendment:
 *
 *   - A controlled amount input in either source-amount or beneficiary-amount
 *     mode; changing the amount or mode surfaces the request to the caller via
 *     `onRecalculate` so the surrounding quote flow can re-price it.
 *   - A visible change indicator that highlights when the settlement amount,
 *     fee, or total debit changed since the previously-rendered quote, so a
 *     recalculation never silently shifts the figures.
 *   - A charge-treatment explanation and a persistent simulated-rate disclaimer
 *     so the demo nature of the pricing is always clear.
 *
 * The component renders only sanitized, display-safe copy — never PII — and is
 * side-effect-free beyond its own local amendment/countdown state. It degrades
 * gracefully: a missing or malformed quote resolves to an accessible empty
 * state so the surrounding flow can gate the UI safely.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { quoteFacade } from '@/features/payment/services/quoteFacade';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { FormField } from '@/shared/ui/FormField';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { LoadingIndicator } from '@/shared/ui/LoadingIndicator';
import { demoClock } from '@/shared/time/demoClock';
import { cn } from '@/shared/ui/cn';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Interval, in milliseconds, at which the expiry countdown re-evaluates. */
const COUNTDOWN_TICK_MS = 1000;

/** Persistent, demo-safe simulated-rate disclaimer copy. */
const SIMULATED_RATE_DISCLAIMER =
  'FX rates and fees shown here are simulated and for demonstration only. Indicative quotes must be refreshed into an executable quote before submission, and no rate shown constitutes a real dealing commitment.';

/**
 * Demo-safe charge-treatment explanations keyed by charge treatment code.
 * @type {Record<string, string>}
 */
const CHARGE_EXPLANATIONS = Object.freeze({
  OUR: 'You bear all transaction charges. The beneficiary receives the full instructed amount and no fees are deducted along the correspondent chain.',
  SHA: 'You pay your own bank\u2019s charges. Any charges levied by the receiving and intermediary banks are borne by the beneficiary and may reduce the amount they receive.',
  BEN: 'All transaction charges are deducted from the transfer amount and borne by the beneficiary. The amount received will be lower than the instructed amount.',
});

/** Shared control class list for text/select inputs. */
const CONTROL_CLASSES = cn(
  'rounded-md border border-primary-blue-200 bg-white px-3 py-2 text-sm text-body',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500 focus-visible:ring-offset-2',
  'disabled:cursor-not-allowed disabled:opacity-60',
);

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
 * Formats a classification/reason identifier into a readable label.
 * @param {unknown} value - The raw identifier.
 * @returns {string} A human-readable label.
 */
function toLabel(value) {
  const text = toText(value);
  if (text.length === 0) {
    return '\u2014';
  }
  return text
    .split(/[._-]/)
    .map((part) => (part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/**
 * Resolves a supported charge treatment, falling back to shared charges.
 * @param {unknown} value - The candidate charge treatment.
 * @returns {string} A valid charge treatment code.
 */
function resolveChargeTreatment(value) {
  const text = toText(value).toUpperCase();
  return Object.prototype.hasOwnProperty.call(CHARGE_EXPLANATIONS, text) ? text : 'SHA';
}

/**
 * Resolves the display amount for a currency leg from the pricing model.
 * @param {Record<string, unknown>} pricing - The pricing model.
 * @param {string} valueKey - The pricing value key.
 * @param {string} currency - The currency code.
 * @returns {string} A display-safe amount string.
 */
function formatAmount(pricing, valueKey, currency) {
  if (!isPlainObject(pricing)) {
    return '\u2014';
  }
  const value = toText(pricing[valueKey]);
  const code = toText(currency);
  if (value.length === 0) {
    return '\u2014';
  }
  return code.length > 0 ? `${value} ${code}` : value;
}

/**
 * Builds a human-readable expiry countdown model relative to the demo clock.
 * @param {string} expiresAt - The quote expiry instant.
 * @returns {{ expired: boolean, label: string, warning: boolean }} A countdown model.
 */
function buildCountdown(expiresAt) {
  const expiry = toText(expiresAt);
  if (expiry.length === 0) {
    return { expired: true, label: 'No expiry available', warning: true };
  }

  let expired = true;
  let secondsRemaining = 0;
  try {
    expired = demoClock.isExpired(expiry);
    if (!expired) {
      const nowMs = demoClock.nowMs();
      const expiryMs = new Date(expiry).getTime();
      if (Number.isFinite(expiryMs)) {
        secondsRemaining = Math.max(0, Math.floor((expiryMs - nowMs) / 1000));
      }
    }
  } catch (error) {
    safeLogger.warn('QuoteCard: failed to evaluate expiry countdown', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return { expired: true, label: 'Expiry unavailable', warning: true };
  }

  if (expired || secondsRemaining <= 0) {
    return { expired: true, label: 'Quote expired', warning: true };
  }

  const minutes = Math.floor(secondsRemaining / 60);
  const seconds = secondsRemaining % 60;
  const paddedSeconds = String(seconds).padStart(2, '0');
  const label =
    minutes > 0
      ? `Expires in ${minutes}m ${paddedSeconds}s`
      : `Expires in ${seconds}s`;
  return { expired: false, label, warning: secondsRemaining <= 15 };
}

/**
 * Resolves a badge tone for a quote classification value.
 * @param {string} classification - The quote classification.
 * @returns {string} A tone from {@link STATUS_TONES}.
 */
function classificationTone(classification) {
  return classification === 'executable' ? STATUS_TONES.SUCCESS : STATUS_TONES.INFO;
}

/**
 * Renders a single labeled detail row.
 * @param {{ label: string, children: React.ReactNode, changed?: boolean }} props - The row props.
 * @returns {React.ReactElement} The detail row element.
 */
function DetailRow({ label, children, changed = false }) {
  return (
    <div className="flex flex-col gap-1 border-b border-primary-blue-100 py-3 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="flex w-full items-center gap-2 text-sm font-medium text-primary-blue-700 sm:w-48">
        <span>{label}</span>
        {changed ? <StatusBadge tone={STATUS_TONES.INFO}>Updated</StatusBadge> : null}
      </dt>
      <dd className="text-sm text-body">{children}</dd>
    </div>
  );
}

DetailRow.propTypes = {
  label: PropTypes.string.isRequired,
  children: PropTypes.node,
  changed: PropTypes.bool,
};

/**
 * Renders the FX quote card with dynamic amendment.
 *
 * The card presents the resolved quote figures, an expiry countdown, the quote
 * classification, and the pricing breakdown, and highlights any figures that
 * changed since the previous render. Amount and amount-mode changes are
 * surfaced via `onRecalculate` so the surrounding flow can re-price the quote.
 * A missing or malformed quote degrades to an accessible empty state.
 *
 * @param {{
 *   quote: Record<string, unknown> | null | undefined,
 *   recalculating?: boolean,
 *   onRecalculate?: (request: { amount: string, amountMode: string }) => void,
 * }} props - The quote card props.
 * @returns {React.ReactElement} The quote card element.
 */
export function QuoteCard({ quote, recalculating = false, onRecalculate }) {
  const hasQuote = isPlainObject(quote);
  const pricing = hasQuote && isPlainObject(quote.pricing) ? quote.pricing : null;

  const sourceCurrency = hasQuote ? toText(quote.sourceCurrency) : '';
  const beneficiaryCurrency = hasQuote ? toText(quote.beneficiaryCurrency) : '';
  const classification = hasQuote ? toText(quote.classification) : '';
  const chargeTreatment = resolveChargeTreatment(pricing ? pricing.chargeTreatment : '');

  const [amount, setAmount] = useState(() =>
    pricing ? toText(pricing.instructedValue) : '',
  );
  const [amountMode, setAmountMode] = useState(quoteFacade.AMOUNT_MODES.SOURCE);
  const [countdown, setCountdown] = useState(() =>
    buildCountdown(hasQuote ? toText(quote.expiresAt) : ''),
  );

  /** @type {React.MutableRefObject<{ settlement: string, fee: string, total: string }>} */
  const previousFiguresRef = useRef({ settlement: '', fee: '', total: '' });
  const [changedFigures, setChangedFigures] = useState({
    settlement: false,
    fee: false,
    total: false,
  });

  // Re-seed the controlled amount when a fresh quote arrives.
  useEffect(() => {
    if (pricing) {
      setAmount(toText(pricing.instructedValue));
    }
  }, [pricing]);

  // Detect and highlight figure changes across successive quotes.
  useEffect(() => {
    if (!pricing) {
      previousFiguresRef.current = { settlement: '', fee: '', total: '' };
      setChangedFigures({ settlement: false, fee: false, total: false });
      return;
    }

    const next = {
      settlement: toText(pricing.settlementValue),
      fee: toText(pricing.feeValue),
      total: toText(pricing.totalDebitValue),
    };
    const previous = previousFiguresRef.current;

    if (
      previous.settlement.length > 0 ||
      previous.fee.length > 0 ||
      previous.total.length > 0
    ) {
      setChangedFigures({
        settlement: previous.settlement !== next.settlement,
        fee: previous.fee !== next.fee,
        total: previous.total !== next.total,
      });
    }

    previousFiguresRef.current = next;
  }, [pricing]);

  // Refresh the expiry countdown on a bounded interval.
  useEffect(() => {
    if (!hasQuote) {
      return undefined;
    }

    const expiresAt = toText(quote.expiresAt);
    setCountdown(buildCountdown(expiresAt));

    const handle = setInterval(() => {
      setCountdown(buildCountdown(expiresAt));
    }, COUNTDOWN_TICK_MS);

    return () => {
      clearInterval(handle);
    };
  }, [hasQuote, quote]);

  const handleAmountChange = useCallback((event) => {
    setAmount(event.target.value);
  }, []);

  const handleModeChange = useCallback((event) => {
    setAmountMode(event.target.value);
  }, []);

  const handleRecalculate = useCallback(() => {
    if (recalculating || typeof onRecalculate !== 'function') {
      return;
    }
    onRecalculate({ amount: toText(amount), amountMode });
  }, [recalculating, onRecalculate, amount, amountMode]);

  const rate = useMemo(() => (hasQuote ? toText(quote.rate) : ''), [hasQuote, quote]);
  const quotedLabel = useMemo(
    () => (hasQuote ? toText(quote.expiresAt) : ''),
    [hasQuote, quote],
  );

  const amountModeSummary = useMemo(
    () =>
      amountMode === quoteFacade.AMOUNT_MODES.BENEFICIARY
        ? `Amount is entered in the beneficiary currency (${beneficiaryCurrency || 'beneficiary'}).`
        : `Amount is entered in the source currency (${sourceCurrency || 'source'}).`,
    [amountMode, beneficiaryCurrency, sourceCurrency],
  );

  if (!hasQuote || !pricing) {
    return (
      <section
        aria-labelledby="quote-card-heading"
        className="flex flex-col gap-3 rounded-md border border-primary-blue-100 bg-white p-6"
      >
        <h2 id="quote-card-heading" className="text-lg font-medium text-body">
          FX quote
        </h2>
        <Alert severity={ALERT_SEVERITIES.WARNING} title="No quote available">
          A quote could not be resolved for the selected currencies. Choose a supported currency
          pair and request a quote to continue.
        </Alert>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="quote-card-heading"
      className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="quote-card-heading" className="text-lg font-medium text-body">
            FX quote
          </h2>
          <span className="text-xs text-body">{toText(quote.quoteRef)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={classificationTone(classification)}>
            {toLabel(classification) === '\u2014' ? 'Indicative' : toLabel(classification)}
          </StatusBadge>
          <StatusBadge
            tone={countdown.expired || countdown.warning ? STATUS_TONES.WARNING : STATUS_TONES.SUCCESS}
          >
            {countdown.label}
          </StatusBadge>
        </div>
      </div>

      {countdown.expired ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="Quote expired">
          This quote has expired and can no longer back a submission. Request a fresh quote to
          continue.
        </Alert>
      ) : null}

      <dl className="flex flex-col">
        <DetailRow label="Source amount">
          {formatAmount(pricing, 'instructedValue', sourceCurrency)}
        </DetailRow>
        <DetailRow label="Beneficiary amount" changed={changedFigures.settlement}>
          {formatAmount(pricing, 'settlementValue', beneficiaryCurrency)}
        </DetailRow>
        <DetailRow label="Rate">{rate.length > 0 ? rate : '\u2014'}</DetailRow>
        <DetailRow label="Fee" changed={changedFigures.fee}>
          {formatAmount(pricing, 'feeValue', sourceCurrency)}
        </DetailRow>
        <DetailRow label="Total debit" changed={changedFigures.total}>
          {formatAmount(pricing, 'totalDebitValue', sourceCurrency)}
        </DetailRow>
        <DetailRow label="Charge treatment">
          <StatusBadge tone={STATUS_TONES.NEUTRAL}>{chargeTreatment}</StatusBadge>
        </DetailRow>
        <DetailRow label="Classification">{toLabel(classification)}</DetailRow>
        <DetailRow label="Expires at">{quotedLabel.length > 0 ? quotedLabel : '\u2014'}</DetailRow>
      </dl>

      <section
        aria-labelledby="quote-amend-heading"
        className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-4"
      >
        <div className="flex flex-col gap-1">
          <h3 id="quote-amend-heading" className="text-sm font-medium text-body">
            Amend amount
          </h3>
          <p className="text-xs text-body">{amountModeSummary}</p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Amount">
            {(attrs) => (
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                className={CONTROL_CLASSES}
                value={amount}
                disabled={recalculating}
                onChange={handleAmountChange}
                {...attrs}
              />
            )}
          </FormField>

          <FormField label="Amount is in">
            {(attrs) => (
              <select
                className={CONTROL_CLASSES}
                value={amountMode}
                disabled={recalculating}
                onChange={handleModeChange}
                {...attrs}
              >
                <option value={quoteFacade.AMOUNT_MODES.SOURCE}>
                  {`Source currency${sourceCurrency.length > 0 ? ` (${sourceCurrency})` : ''}`}
                </option>
                <option value={quoteFacade.AMOUNT_MODES.BENEFICIARY}>
                  {`Beneficiary currency${beneficiaryCurrency.length > 0 ? ` (${beneficiaryCurrency})` : ''}`}
                </option>
              </select>
            )}
          </FormField>
        </div>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={recalculating || toText(amount).length === 0}
            onClick={handleRecalculate}
          >
            Recalculate
          </Button>
          {recalculating ? (
            <LoadingIndicator size="sm" label="Recalculating\u2026" showLabel />
          ) : null}
        </div>
      </section>

      <div className="flex flex-col gap-3 rounded-md border border-primary-blue-100 bg-white p-4">
        <h3 className="text-sm font-medium text-body">Who pays the charges</h3>
        <p className="text-sm text-body">{CHARGE_EXPLANATIONS[chargeTreatment]}</p>
      </div>

      <Alert severity={ALERT_SEVERITIES.INFO} title="Indicative pricing is non-binding">
        {SIMULATED_RATE_DISCLAIMER}
      </Alert>
    </section>
  );
}

QuoteCard.propTypes = {
  quote: PropTypes.object,
  recalculating: PropTypes.bool,
  onRecalculate: PropTypes.func,
};

export default QuoteCard;