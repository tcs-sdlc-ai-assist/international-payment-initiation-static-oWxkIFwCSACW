/**
 * FX quote & charges page.
 *
 * QuotePage is the FX quote acceptance surface (SCRUM-813/816). It composes the
 * presentational {@link QuoteCard} with the {@link quoteFacade} workflow to
 * request an FX quote for a selected currency pair, recalculate it after an
 * amount amendment, and accept a non-expired quote into an immutable pricing
 * snapshot before advancing to CBPR+ transaction-detail capture.
 *
 * The page is intentionally conservative and demo-only:
 *
 *   - It surfaces the fee currency/amount, total debit, and estimated receipt
 *     (honoring the OUR/SHA/BEN charge rules) via the composed quote card.
 *   - Quote acceptance is gated on a fresh, non-expired quote; an expired quote
 *     transparently offers its successor scenario for a re-quote rather than
 *     accepting stale pricing.
 *   - Each async step (request/recalculate/accept) has an explicit loading and
 *     error state, and controls disable while a request is in flight so they can
 *     never be double-invoked.
 *
 * The page renders only sanitized, display-safe copy — never PII — and never
 * mutates application state beyond its own local quote/loading model. On a
 * successful acceptance it invokes `onContinue` with the accepted pricing
 * snapshot so the surrounding flow can proceed to CBPR+ capture.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { useAccessContext } from '@/app/useAccessContext';
import { useNotifications } from '@/app/NotificationContext';
import { quoteFacade } from '@/features/payment/services/quoteFacade';
import { fixtureRegistry } from '@/shared/fixtures/fixtureRegistry';
import { QuoteCard } from '@/features/payment/pages/QuoteCard';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { LoadingIndicator } from '@/shared/ui/LoadingIndicator';
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
 * Builds a minimal session claim shape for the quote facade from the sanitized
 * session identity.
 * @param {Record<string, unknown> | null | undefined} identity - The identity.
 * @returns {{ subjectId: string, roles: string[], capabilities: string[] }} A claim-like value.
 */
function toSessionClaim(identity) {
  if (!isPlainObject(identity)) {
    return { subjectId: '', roles: [], capabilities: [] };
  }
  const roles = Array.isArray(identity.roles)
    ? identity.roles.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
  const capabilities = Array.isArray(identity.capabilities)
    ? identity.capabilities.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
  return { subjectId: toText(identity.subjectId), roles, capabilities };
}

/**
 * Resolves the initial executable FX quote reference for a currency pair,
 * preferring an executable quote and falling back to any quote for the pair.
 * @param {string} pairId - The currency pair identifier.
 * @returns {string} A quote reference (empty when none resolves).
 */
function resolveInitialQuoteRef(pairId) {
  const id = toText(pairId);
  if (id.length === 0) {
    return '';
  }

  let quotes;
  try {
    quotes = fixtureRegistry.getFxQuotes();
  } catch (error) {
    safeLogger.warn('QuotePage: failed to read FX quotes for pair', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return '';
  }

  const forPair = Array.isArray(quotes)
    ? quotes.filter((quote) => isPlainObject(quote) && toText(quote.pair_id) === id)
    : [];

  const executable = forPair.find(
    (quote) => toText(quote.classification) === 'executable',
  );
  if (executable) {
    return toText(executable.quote_ref);
  }

  return forPair.length > 0 ? toText(forPair[0].quote_ref) : '';
}

/**
 * Renders the FX quote & charges page.
 *
 * The page requests an FX quote for the supplied pair, composes the quote card
 * for review and amendment, and gates acceptance on a fresh, non-expired quote.
 * An expired quote transparently surfaces its successor for a re-quote. On a
 * successful acceptance the immutable pricing snapshot is surfaced to the caller
 * via `onContinue` so the flow can advance to CBPR+ capture.
 *
 * @param {{
 *   pairId?: string,
 *   accountId?: string,
 *   sourceCurrency?: string,
 *   beneficiaryCurrency?: string,
 *   onContinue?: (result: {
 *     snapshot: Readonly<Record<string, unknown>>,
 *     accountId: string,
 *     pairId: string,
 *   }) => void,
 * }} props - The quote page props.
 * @returns {React.ReactElement} The quote page element.
 */
export function QuotePage({
  pairId,
  accountId,
  sourceCurrency,
  beneficiaryCurrency,
  onContinue,
}) {
  const { sessionIdentity } = useAccessContext();
  const { notify, NOTIFICATION_SEVERITIES } = useNotifications();

  const [quoteRef, setQuoteRef] = useState(() => resolveInitialQuoteRef(pairId));
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [recalculating, setRecalculating] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [snapshot, setSnapshot] = useState(null);

  const session = useMemo(() => toSessionClaim(sessionIdentity), [sessionIdentity]);

  const resolvedSourceCurrency = useMemo(() => toText(sourceCurrency), [sourceCurrency]);
  const resolvedBeneficiaryCurrency = useMemo(
    () => toText(beneficiaryCurrency),
    [beneficiaryCurrency],
  );

  const announce = useCallback(
    (severity, title, body) => {
      try {
        notify({ severity, title, body });
      } catch (error) {
        safeLogger.warn('QuotePage: failed to announce notification', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    },
    [notify],
  );

  // Re-seed the quote reference when the selected pair changes.
  useEffect(() => {
    setQuoteRef(resolveInitialQuoteRef(pairId));
    setSnapshot(null);
    setStatusMessage('');
    setAcceptError('');
  }, [pairId]);

  // Request the initial quote whenever the resolved quote reference changes.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');

    if (quoteRef.length === 0) {
      setQuote(null);
      setLoading(false);
      setLoadError(
        'No FX quote is available for the selected currencies. Choose a different combination to continue.',
      );
      return () => {
        active = false;
      };
    }

    let result;
    try {
      result = quoteFacade.requestQuote(session, { quoteRef });
    } catch (error) {
      safeLogger.warn('QuotePage: failed to request quote', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        safeReasonCode: quoteFacade.QUOTE_FACADE_REASON_CODES.UNEXPECTED,
      };
    }

    if (!active) {
      return () => {
        active = false;
      };
    }

    if (result.ok) {
      setQuote(isPlainObject(result.quote) ? result.quote : null);
      setLoadError('');
    } else {
      setQuote(null);
      setLoadError(
        'A quote could not be resolved for the selected currencies. Choose a supported currency pair and try again.',
      );
    }
    setLoading(false);

    return () => {
      active = false;
    };
  }, [quoteRef, session]);

  const handleRecalculate = useCallback(
    (request) => {
      if (recalculating || quoteRef.length === 0) {
        return;
      }

      const source = isPlainObject(request) ? request : {};

      setRecalculating(true);
      setAcceptError('');
      setStatusMessage('');
      setSnapshot(null);

      let result;
      try {
        result = quoteFacade.recalculateQuote(session, {
          quoteRef,
          amount: source.amount,
          amountMode: source.amountMode,
        });
      } catch (error) {
        safeLogger.warn('QuotePage: failed to recalculate quote', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
        result = {
          ok: false,
          safeReasonCode: quoteFacade.QUOTE_FACADE_REASON_CODES.UNEXPECTED,
        };
      }

      setRecalculating(false);

      if (result.ok) {
        setQuote(isPlainObject(result.quote) ? result.quote : null);
      } else {
        setAcceptError(
          'The quote could not be recalculated with the supplied amount. Check the amount and try again.',
        );
        announce(
          NOTIFICATION_SEVERITIES.WARNING,
          'Recalculation unavailable',
          'The quote could not be recalculated with the supplied amount.',
        );
      }
    },
    [recalculating, quoteRef, session, announce, NOTIFICATION_SEVERITIES],
  );

  const handleAccept = useCallback(() => {
    if (accepting || quoteRef.length === 0 || !isPlainObject(quote)) {
      return;
    }

    setAccepting(true);
    setAcceptError('');
    setStatusMessage('');

    let result;
    try {
      result = quoteFacade.acceptQuote(session, { quoteRef });
    } catch (error) {
      safeLogger.warn('QuotePage: failed to accept quote', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        safeReasonCode: quoteFacade.QUOTE_FACADE_REASON_CODES.UNEXPECTED,
      };
    }

    setAccepting(false);

    if (result.ok) {
      const accepted = isPlainObject(result.snapshot) ? result.snapshot : null;
      setSnapshot(accepted);
      const body = 'The quote has been accepted. Continue to enter the payment details.';
      setStatusMessage(body);
      announce(NOTIFICATION_SEVERITIES.SUCCESS, 'Quote accepted', body);
      if (accepted && typeof onContinue === 'function') {
        onContinue({
          snapshot: accepted,
          accountId: toText(accountId),
          pairId: toText(pairId),
        });
      }
      return;
    }

    if (
      result.safeReasonCode === quoteFacade.QUOTE_FACADE_REASON_CODES.REQUOTE_REQUIRED &&
      isPlainObject(result.nextQuote)
    ) {
      const nextRef = toText(result.nextQuote.quoteRef);
      setQuote(result.nextQuote);
      if (nextRef.length > 0) {
        setQuoteRef(nextRef);
      }
      const body =
        'The previous quote expired, so a fresh quote has been provided. Review it and accept to continue.';
      setAcceptError(body);
      announce(NOTIFICATION_SEVERITIES.WARNING, 'Quote refreshed', body);
      return;
    }

    if (result.safeReasonCode === quoteFacade.QUOTE_FACADE_REASON_CODES.QUOTE_EXPIRED) {
      const body =
        'This quote has expired and can no longer be accepted. Request a fresh quote to continue.';
      setAcceptError(body);
      announce(NOTIFICATION_SEVERITIES.WARNING, 'Quote expired', body);
      return;
    }

    const body = 'The quote could not be accepted with your current role. Try again.';
    setAcceptError(body);
    announce(NOTIFICATION_SEVERITIES.WARNING, 'Acceptance unavailable', body);
  }, [
    accepting,
    quoteRef,
    quote,
    session,
    accountId,
    pairId,
    onContinue,
    announce,
    NOTIFICATION_SEVERITIES,
  ]);

  const accepted = snapshot !== null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-primary-blue-700">FX quote and charges</h1>
        <p className="text-sm text-body">
          Review the simulated FX quote, fees, and estimated receipt for this payment. Accept a
          current quote to continue to the payment details.
          {resolvedSourceCurrency.length > 0 && resolvedBeneficiaryCurrency.length > 0
            ? ` Converting ${resolvedSourceCurrency} to ${resolvedBeneficiaryCurrency}.`
            : ''}
        </p>
      </div>

      {loadError.length > 0 ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="Quote unavailable">
          {loadError}
        </Alert>
      ) : null}

      {loading ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-primary-blue-100 bg-white px-4 py-6 text-center text-sm text-body"
        >
          Loading quote…
        </div>
      ) : (
        <>
          <QuoteCard
            quote={quote}
            recalculating={recalculating}
            onRecalculate={handleRecalculate}
          />

          {statusMessage.length > 0 ? (
            <div role="status" aria-live="polite">
              <Alert severity={ALERT_SEVERITIES.SUCCESS} title="Quote accepted">
                {statusMessage}
              </Alert>
            </div>
          ) : null}

          {acceptError.length > 0 ? (
            <Alert severity={ALERT_SEVERITIES.WARNING} title="Quote acceptance">
              {acceptError}
            </Alert>
          ) : null}

          <section
            aria-labelledby="quote-accept-heading"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-6"
          >
            <div className="flex flex-col gap-1">
              <h2 id="quote-accept-heading" className="text-lg font-medium text-body">
                Accept the quote
              </h2>
              <p className="text-sm text-body">
                Accepting locks the current simulated pricing into an immutable snapshot and takes
                you to the CBPR+ payment details. A quote can only be accepted while it is current.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="primary"
                size="md"
                disabled={accepting || accepted || !isPlainObject(quote)}
                onClick={handleAccept}
              >
                {accepted ? 'Quote accepted' : 'Accept quote and continue'}
              </Button>
              {accepting ? (
                <LoadingIndicator size="sm" label="Accepting quote…" showLabel />
              ) : null}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

QuotePage.propTypes = {
  pairId: PropTypes.string,
  accountId: PropTypes.string,
  sourceCurrency: PropTypes.string,
  beneficiaryCurrency: PropTypes.string,
  onContinue: PropTypes.func,
};

export default QuotePage;