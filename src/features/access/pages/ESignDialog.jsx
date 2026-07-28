/**
 * Simulated eSign dialog.
 *
 * ESignDialog is the modal surface that runs the simulated eSign ceremony from
 * the signer entitlement edit flow (SCRUM-825). It composes the design-system
 * {@link Modal} with a scenario picker (drawn from the {@link esignService}) and
 * drives the mock ceremony through the {@link esignService.requestSignature}
 * adapter, handling every predefined outcome — success, declined, expired,
 * unavailable, and transient_error:
 *
 *   - While a request is in flight the confirm control disables so it can never
 *     be double-invoked, and a loading indicator is announced politely.
 *   - Retryable outcomes surface a retry action via the shared {@link AsyncAlert};
 *     terminal, non-retryable outcomes surface a safe, customer-facing message.
 *   - The in-flight request is cancelled via an {@link AbortController} when the
 *     dialog closes or the component unmounts, so no stray result ever lands.
 *   - Every resolved outcome is announced through the shared notification live
 *     regions and recorded as a sanitized audit event via the
 *     {@link auditFacade}.
 *
 * The dialog renders only sanitized, safe copy — never PII — and never mutates
 * application state beyond its own local ceremony model. It degrades gracefully:
 * aborts and unexpected faults resolve to a discriminated, customer-safe state
 * so the surrounding edit flow can gate the UI safely.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useAccessContext } from '@/app/useAccessContext';
import { useNotifications } from '@/app/NotificationContext';
import { esignService } from '@/features/access/services/esignService';
import { auditFacade } from '@/features/access/data/auditFacade';
import { Modal } from '@/shared/ui/Modal';
import { Button } from '@/shared/ui/Button';
import { FormField } from '@/shared/ui/FormField';
import { LoadingIndicator } from '@/shared/ui/LoadingIndicator';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { AsyncAlert, ASYNC_ALERT_KINDS } from '@/shared/ui/AsyncAlert';
import { cn } from '@/shared/ui/cn';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Audit event type recorded when a simulated eSign ceremony completes. */
const ESIGN_COMPLETED_EVENT = 'signer.esign_ceremony_completed';

/** Audit event type recorded when a simulated eSign ceremony is denied. */
const ESIGN_DENIED_EVENT = 'signer.esign_ceremony_denied';

/** Default scenario reference applied when none is supplied. */
const DEFAULT_SCENARIO_REF = 'demo-scn-esign-success';

/** Shared control class list for select inputs. */
const SELECT_CLASSES = cn(
  'rounded-md border border-primary-blue-200 bg-white px-3 py-2 text-sm text-body',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500 focus-visible:ring-offset-2',
  'disabled:cursor-not-allowed disabled:opacity-60',
);

/**
 * Maps an eSign outcome identifier to an async-alert kind.
 * @type {Record<string, string>}
 */
const OUTCOME_ALERT_KIND = Object.freeze({
  declined: ASYNC_ALERT_KINDS.FAILURE,
  expired: ASYNC_ALERT_KINDS.INVITATION_EXPIRED,
  unavailable: ASYNC_ALERT_KINDS.UNAVAILABLE,
  transient_error: ASYNC_ALERT_KINDS.NETWORK,
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
 * Formats a scenario outcome identifier into a readable label.
 * @param {unknown} value - The raw identifier.
 * @returns {string} A human-readable label.
 */
function toLabel(value) {
  const text = toText(value);
  if (text.length === 0) {
    return 'Scenario';
  }
  return text
    .split('_')
    .map((part) => (part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/**
 * Resolves the acting subject identifier from the sanitized session identity.
 * @param {Record<string, unknown> | null | undefined} identity - The identity.
 * @returns {string | undefined} The subject identifier, or `undefined`.
 */
function resolveActorId(identity) {
  if (!isPlainObject(identity)) {
    return undefined;
  }
  const subjectId = toText(identity.subjectId);
  return subjectId.length > 0 ? subjectId : undefined;
}

/**
 * Renders the simulated eSign dialog.
 *
 * The dialog runs the mock eSign ceremony for the chosen scenario, disabling the
 * confirm control while pending, offering retry for retryable outcomes, and
 * cancelling any in-flight request when it closes or unmounts. Every resolved
 * outcome is announced and recorded as a sanitized audit event. On a successful
 * signature it invokes `onSigned` so the surrounding edit flow can continue.
 *
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   signerId?: string,
 *   onSigned?: (result: { outcome: string | null, scenarioRef: string, safeReasonCode: string }) => void,
 * }} props - The eSign dialog props.
 * @returns {React.ReactElement} The eSign dialog element.
 */
export function ESignDialog({ open, onClose, signerId, onSigned }) {
  const { sessionIdentity } = useAccessContext();
  const { notify, NOTIFICATION_SEVERITIES } = useNotifications();

  const scenarios = useMemo(() => {
    try {
      return esignService.listScenarios();
    } catch (error) {
      safeLogger.warn('ESignDialog: failed to list eSign scenarios', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return [];
    }
  }, []);

  const defaultScenarioRef = useMemo(() => {
    const match = scenarios.find((scenario) => scenario.scenarioRef === DEFAULT_SCENARIO_REF);
    if (match) {
      return match.scenarioRef;
    }
    return scenarios.length > 0 ? scenarios[0].scenarioRef : DEFAULT_SCENARIO_REF;
  }, [scenarios]);

  const [scenarioRef, setScenarioRef] = useState(defaultScenarioRef);
  const [pending, setPending] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [result, setResult] = useState(null);

  /** @type {React.MutableRefObject<AbortController | null>} */
  const abortRef = useRef(null);

  const abortInFlight = useCallback(() => {
    if (abortRef.current) {
      try {
        abortRef.current.abort();
      } catch (error) {
        safeLogger.warn('ESignDialog: failed to abort in-flight request', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
      abortRef.current = null;
    }
  }, []);

  // Reset local ceremony state and cancel any in-flight request when closed.
  useEffect(() => {
    if (!open) {
      abortInFlight();
      setPending(false);
      setStatusMessage('');
      setResult(null);
      setScenarioRef(defaultScenarioRef);
    }
  }, [open, abortInFlight, defaultScenarioRef]);

  // Cancel any in-flight request on unmount so no stray result lands.
  useEffect(() => {
    return () => {
      abortInFlight();
    };
  }, [abortInFlight]);

  const announce = useCallback(
    (severity, title, body) => {
      try {
        notify({ severity, title, body });
      } catch (error) {
        safeLogger.warn('ESignDialog: failed to announce notification', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    },
    [notify],
  );

  const audit = useCallback(
    (eventType, safeReasonCode, metadata) => {
      const event = { eventType };
      const actorId = resolveActorId(sessionIdentity);
      if (actorId !== undefined) {
        event.actorId = actorId;
      }
      const subjectId = toText(signerId);
      if (subjectId.length > 0) {
        event.subjectId = subjectId;
      }
      if (typeof safeReasonCode === 'string' && safeReasonCode.length > 0) {
        event.safeReasonCode = safeReasonCode;
      }
      if (isPlainObject(metadata)) {
        event.metadata = metadata;
      }
      try {
        auditFacade.append(event);
      } catch (error) {
        safeLogger.warn('ESignDialog: failed to record audit event', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    },
    [sessionIdentity, signerId],
  );

  const handleScenarioChange = useCallback((event) => {
    setScenarioRef(event.target.value);
    setStatusMessage('');
    setResult(null);
  }, []);

  const runCeremony = useCallback(async () => {
    if (pending) {
      return;
    }

    abortInFlight();
    const controller = new AbortController();
    abortRef.current = controller;

    setPending(true);
    setStatusMessage('');
    setResult(null);

    let ceremony;
    try {
      ceremony = await esignService.requestSignature(scenarioRef, {
        signal: controller.signal,
      });
    } catch (error) {
      safeLogger.warn('ESignDialog: unexpected error during eSign ceremony', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      ceremony = {
        ok: false,
        outcome: null,
        safeReasonCode: esignService.ESIGN_REASON_CODES.UNEXPECTED,
        retryable: true,
        terminal: false,
        scenarioRef,
        nextStep: null,
      };
    }

    // A late result from an aborted or superseded request must never land.
    if (abortRef.current !== controller) {
      return;
    }
    abortRef.current = null;

    setPending(false);

    if (ceremony.ok) {
      setResult({ ok: true, outcome: ceremony.outcome, retryable: false });
      const body = isPlainObject(ceremony.nextStep) && toText(ceremony.nextStep.body).length > 0
        ? toText(ceremony.nextStep.body)
        : 'The change has been signed and recorded.';
      setStatusMessage(body);
      announce(NOTIFICATION_SEVERITIES.SUCCESS, 'Signature confirmed', body);
      audit(ESIGN_COMPLETED_EVENT, ceremony.safeReasonCode, {
        outcome: toText(ceremony.outcome) || undefined,
        scenarioRef: ceremony.scenarioRef,
      });
      if (typeof onSigned === 'function') {
        onSigned({
          outcome: ceremony.outcome ?? null,
          scenarioRef: ceremony.scenarioRef,
          safeReasonCode: ceremony.safeReasonCode,
        });
      }
      return;
    }

    const outcomeId = toText(ceremony.outcome);
    const kind =
      Object.prototype.hasOwnProperty.call(OUTCOME_ALERT_KIND, outcomeId)
        ? OUTCOME_ALERT_KIND[outcomeId]
        : ceremony.retryable
          ? ASYNC_ALERT_KINDS.NETWORK
          : ASYNC_ALERT_KINDS.FAILURE;

    setResult({ ok: false, outcome: ceremony.outcome, retryable: ceremony.retryable === true, kind });
    announce(
      ceremony.retryable ? NOTIFICATION_SEVERITIES.WARNING : NOTIFICATION_SEVERITIES.CRITICAL,
      'Signature not completed',
      'The eSign ceremony did not complete. Review the details and try again if available.',
    );
    audit(ESIGN_DENIED_EVENT, ceremony.safeReasonCode, {
      outcome: outcomeId || undefined,
      scenarioRef: ceremony.scenarioRef,
      retryable: ceremony.retryable === true,
    });
  }, [
    pending,
    abortInFlight,
    scenarioRef,
    announce,
    NOTIFICATION_SEVERITIES,
    audit,
    onSigned,
  ]);

  const handleClose = useCallback(() => {
    abortInFlight();
    setPending(false);
    if (typeof onClose === 'function') {
      onClose();
    }
  }, [abortInFlight, onClose]);

  const succeeded = isPlainObject(result) && result.ok === true;
  const failed = isPlainObject(result) && result.ok === false;
  const canRetry = failed && result.retryable === true;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Sign the change"
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={handleClose}>
            {succeeded ? 'Close' : 'Cancel'}
          </Button>
          {!succeeded ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={pending}
              onClick={runCeremony}
            >
              {failed ? 'Sign again' : 'Sign now'}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-body">
          Continue into the simulated eSign ceremony to record and confirm this change. No real
          signature is collected in this demo.
        </p>

        {scenarios.length > 0 ? (
          <FormField label="eSign scenario">
            {(attrs) => (
              <select
                className={SELECT_CLASSES}
                value={scenarioRef}
                disabled={pending}
                onChange={handleScenarioChange}
                {...attrs}
              >
                {scenarios.map((scenario) => (
                  <option key={scenario.scenarioRef} value={scenario.scenarioRef}>
                    {toLabel(scenario.outcome)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        ) : null}

        {pending ? (
          <LoadingIndicator size="sm" label="Awaiting signature…" showLabel />
        ) : null}

        {succeeded ? (
          <div role="status" aria-live="polite">
            <Alert severity={ALERT_SEVERITIES.SUCCESS} title="Signature confirmed">
              {statusMessage}
            </Alert>
          </div>
        ) : null}

        {failed ? (
          <AsyncAlert
            kind={result.kind}
            retryable={result.retryable}
            retrying={pending}
            retryLabel="Sign again"
            onRetry={canRetry ? runCeremony : undefined}
          />
        ) : null}
      </div>
    </Modal>
  );
}

ESignDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  signerId: PropTypes.string,
  onSigned: PropTypes.func,
};

export default ESignDialog;