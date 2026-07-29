/**
 * Beneficiary validation page.
 *
 * BeneficiaryValidationPage is the beneficiary validation surface (SCRUM-815).
 * It composes local, structural BIC/IBAN/name syntax validation with the
 * simulated Bankcheck-style ceremony run through the {@link paymentFacade}
 * (which layers the {@link beneficiaryValidator} and the {@link policyEngine}),
 * resolving an allow / override / block disposition:
 *
 *   - A beneficiary details form captures the name, IBAN, and BIC and validates
 *     them structurally via the {@link beneficiaryValidator} before any request.
 *   - A scenario picker (drawn from {@link beneficiaryValidator.listScenarios})
 *     lets a reviewer exercise each predefined outcome — success, partial match,
 *     failed, and unavailable.
 *   - While a request is in flight the confirm control disables so it can never
 *     be double-invoked, and a loading indicator is announced politely.
 *   - When the disposition requires manual confirmation the page demands a
 *     non-empty override reason before the beneficiary may proceed; a blocked
 *     disposition can never be overridden.
 *   - The in-flight request is cancelled via an {@link AbortController} when the
 *     component unmounts, so no stray result ever lands.
 *
 * The page renders only sanitized, safe copy — never PII beyond the values the
 * user enters — and never mutates application state beyond its own local
 * ceremony/override model. It carries a persistent no-real-verification
 * disclaimer so the demo nature of the validation is always clear. On an allowed
 * (or accepted-override) disposition it invokes `onValidated` so the surrounding
 * flow can continue.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useAccessContext } from '@/app/useAccessContext';
import { useNotifications } from '@/app/NotificationContext';
import { beneficiaryValidator } from '@/features/payment/domain/beneficiaryValidator';
import { policyEngine, POLICY_DISPOSITIONS } from '@/features/payment/domain/policyEngine';
import { paymentFacade } from '@/features/payment/services/paymentFacade';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { FormField } from '@/shared/ui/FormField';
import { LoadingIndicator } from '@/shared/ui/LoadingIndicator';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { cn } from '@/shared/ui/cn';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Default scenario reference applied when none is supplied. */
const DEFAULT_SCENARIO_REF = 'demo-scn-beneficiary-validate-success';

/** Persistent, demo-safe no-real-verification disclaimer copy. */
const NO_VERIFICATION_DISCLAIMER =
  'Beneficiary validation here is simulated and for demonstration only. No real account is checked, no message leaves the app, and no name-on-account verification is performed. Do not enter real banking details.';

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
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Formats a scenario/outcome identifier into a readable label.
 * @param {unknown} value - The raw identifier.
 * @returns {string} A human-readable label.
 */
function toLabel(value) {
  const text = toText(value);
  if (text.length === 0) {
    return 'Scenario';
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
  const roles = Array.isArray(identity.roles)
    ? identity.roles.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
  const capabilities = Array.isArray(identity.capabilities)
    ? identity.capabilities.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
  return { subjectId: toText(identity.subjectId), roles, capabilities };
}

/**
 * Resolves a badge tone for a verification status value.
 * @param {string} status - The verification status.
 * @returns {string} A tone from {@link STATUS_TONES}.
 */
function verificationTone(status) {
  switch (status) {
    case 'verified':
      return STATUS_TONES.SUCCESS;
    case 'partially_verified':
      return STATUS_TONES.WARNING;
    case 'failed':
      return STATUS_TONES.CRITICAL;
    default:
      return STATUS_TONES.NEUTRAL;
  }
}

/**
 * Resolves a badge tone for a policy disposition value.
 * @param {string} disposition - The policy disposition.
 * @returns {string} A tone from {@link STATUS_TONES}.
 */
function dispositionTone(disposition) {
  switch (disposition) {
    case POLICY_DISPOSITIONS.ALLOW:
      return STATUS_TONES.SUCCESS;
    case POLICY_DISPOSITIONS.ALLOW_WITH_OVERRIDE:
      return STATUS_TONES.WARNING;
    case POLICY_DISPOSITIONS.BLOCK:
      return STATUS_TONES.CRITICAL;
    default:
      return STATUS_TONES.NEUTRAL;
  }
}

/**
 * Renders the beneficiary validation page.
 *
 * The page validates BIC/IBAN/name syntax locally, runs the simulated Bankcheck
 * ceremony for the chosen scenario, and resolves an allow / override / block
 * disposition. Override reasons are required before a manual-confirmation
 * disposition may proceed, and blocked dispositions can never be overridden. The
 * in-flight request is cancelled on unmount, and every outcome is announced. On
 * an allowed (or accepted-override) disposition it invokes `onValidated`.
 *
 * @param {{
 *   scenarioRef?: string,
 *   onValidated?: (result: {
 *     disposition: string,
 *     overrideReason: string | null,
 *     verificationStatus: string,
 *     scenarioRef: string,
 *     safeReasonCode: string,
 *   }) => void,
 * }} props - The beneficiary validation page props.
 * @returns {React.ReactElement} The beneficiary validation page element.
 */
export function BeneficiaryValidationPage({ scenarioRef, onValidated }) {
  const { sessionIdentity } = useAccessContext();
  const { notify, NOTIFICATION_SEVERITIES } = useNotifications();

  const scenarios = useMemo(() => {
    try {
      return beneficiaryValidator.listScenarios();
    } catch (error) {
      safeLogger.warn('BeneficiaryValidationPage: failed to list validation scenarios', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return [];
    }
  }, []);

  const defaultScenarioRef = useMemo(() => {
    const requested = toText(scenarioRef);
    if (requested.length > 0) {
      const requestedMatch = scenarios.find(
        (scenario) => scenario.scenarioRef === requested,
      );
      if (requestedMatch) {
        return requestedMatch.scenarioRef;
      }
    }
    const match = scenarios.find(
      (scenario) => scenario.scenarioRef === DEFAULT_SCENARIO_REF,
    );
    if (match) {
      return match.scenarioRef;
    }
    return scenarios.length > 0 ? scenarios[0].scenarioRef : DEFAULT_SCENARIO_REF;
  }, [scenarios, scenarioRef]);

  const [selectedScenario, setSelectedScenario] = useState(defaultScenarioRef);
  const [beneficiaryName, setBeneficiaryName] = useState('');
  const [iban, setIban] = useState('');
  const [bic, setBic] = useState('');
  const [pending, setPending] = useState(false);
  const [fieldIssues, setFieldIssues] = useState({});
  const [statusMessage, setStatusMessage] = useState('');
  const [validation, setValidation] = useState(null);
  const [disposition, setDisposition] = useState(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideError, setOverrideError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const session = useMemo(() => toSessionClaim(sessionIdentity), [sessionIdentity]);

  /** @type {React.MutableRefObject<AbortController | null>} */
  const abortRef = useRef(null);

  const abortInFlight = useCallback(() => {
    if (abortRef.current) {
      try {
        abortRef.current.abort();
      } catch (error) {
        safeLogger.warn('BeneficiaryValidationPage: failed to abort in-flight request', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
      abortRef.current = null;
    }
  }, []);

  // Re-seed the scenario when the resolved default changes.
  useEffect(() => {
    setSelectedScenario(defaultScenarioRef);
  }, [defaultScenarioRef]);

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
        safeLogger.warn('BeneficiaryValidationPage: failed to announce notification', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    },
    [notify],
  );

  const resetResult = useCallback(() => {
    setValidation(null);
    setDisposition(null);
    setOverrideReason('');
    setOverrideError('');
    setConfirmed(false);
    setStatusMessage('');
  }, []);

  const handleScenarioChange = useCallback(
    (event) => {
      setSelectedScenario(event.target.value);
      resetResult();
    },
    [resetResult],
  );

  const handleNameChange = useCallback((event) => {
    setBeneficiaryName(event.target.value);
  }, []);

  const handleIbanChange = useCallback((event) => {
    setIban(event.target.value);
  }, []);

  const handleBicChange = useCallback((event) => {
    setBic(event.target.value);
  }, []);

  const handleOverrideReasonChange = useCallback((event) => {
    setOverrideReason(event.target.value);
    setOverrideError('');
  }, []);

  const applyFieldIssues = useCallback((issues) => {
    const next = {};
    if (Array.isArray(issues)) {
      for (const issue of issues) {
        if (isPlainObject(issue) && toText(issue.field).length > 0) {
          next[toText(issue.field)] = toText(issue.safeReasonCode);
        }
      }
    }
    setFieldIssues(next);
  }, []);

  const runValidation = useCallback(async () => {
    if (pending) {
      return;
    }

    // Run local syntax validation first so structural issues surface inline.
    let syntax;
    try {
      syntax = beneficiaryValidator.validateSyntax({ beneficiaryName, iban, bic });
    } catch (error) {
      safeLogger.warn('BeneficiaryValidationPage: failed local syntax validation', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      syntax = {
        ok: false,
        issues: [],
        safeReasonCode: beneficiaryValidator.BENEFICIARY_REASON_CODES.UNEXPECTED,
      };
    }

    if (!syntax.ok) {
      applyFieldIssues(syntax.issues);
      resetResult();
      const body =
        'Some beneficiary details could not be validated. Review the highlighted fields and try again.';
      setStatusMessage('');
      announce(NOTIFICATION_SEVERITIES.WARNING, 'Check the beneficiary details', body);
      return;
    }

    applyFieldIssues([]);
    resetResult();

    abortInFlight();
    const controller = new AbortController();
    abortRef.current = controller;

    setPending(true);
    setStatusMessage('');

    let result;
    try {
      result = await paymentFacade.validateBeneficiary(session, {
        scenarioRef: selectedScenario,
        beneficiaryName,
        iban,
        bic,
        signal: controller.signal,
      });
    } catch (error) {
      safeLogger.warn('BeneficiaryValidationPage: unexpected error during validation', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        safeReasonCode: paymentFacade.PAYMENT_FACADE_REASON_CODES.UNEXPECTED,
      };
    }

    // A late result from an aborted or superseded request must never land.
    if (abortRef.current !== controller) {
      return;
    }
    abortRef.current = null;

    setPending(false);

    if (!result.ok) {
      const body =
        'The beneficiary validation could not be completed with your current role. Try again.';
      setStatusMessage('');
      announce(NOTIFICATION_SEVERITIES.WARNING, 'Validation unavailable', body);
      return;
    }

    const resolvedValidation = isPlainObject(result.validation) ? result.validation : null;
    const resolvedDisposition = isPlainObject(result.disposition) ? result.disposition : null;

    setValidation(resolvedValidation);
    setDisposition(resolvedDisposition);

    if (resolvedDisposition && resolvedDisposition.disposition === POLICY_DISPOSITIONS.ALLOW) {
      const body = 'The beneficiary was validated and may be used for this payment.';
      setStatusMessage(body);
      setConfirmed(true);
      announce(NOTIFICATION_SEVERITIES.SUCCESS, 'Beneficiary verified', body);
      if (typeof onValidated === 'function') {
        onValidated({
          disposition: resolvedDisposition.disposition,
          overrideReason: null,
          verificationStatus: resolvedValidation ? toText(resolvedValidation.verificationStatus) : '',
          scenarioRef: resolvedValidation ? toText(resolvedValidation.scenarioRef) : selectedScenario,
          safeReasonCode: resolvedDisposition.safeReasonCode,
          validationRecord: resolvedValidation,
          dispositionRecord: resolvedDisposition,
        });
      }
      return;
    }

    if (
      resolvedDisposition &&
      resolvedDisposition.disposition === POLICY_DISPOSITIONS.ALLOW_WITH_OVERRIDE
    ) {
      announce(
        NOTIFICATION_SEVERITIES.WARNING,
        'Confirm beneficiary details',
        'The account identifiers matched, but the name-on-account is only a close match. Capture an override reason to continue.',
      );
      return;
    }

    if (resolvedValidation && toText(resolvedValidation.outcome) === 'unavailable') {
      announce(
        NOTIFICATION_SEVERITIES.WARNING,
        resolvedValidation.nextStep?.title || 'Validation unavailable',
        resolvedValidation.nextStep?.body ||
          'The beneficiary validation service is temporarily unavailable. Try again shortly.',
      );
      return;
    }

    announce(
      NOTIFICATION_SEVERITIES.CRITICAL,
      'Beneficiary blocked',
      'The beneficiary could not be validated and cannot be used for this payment.',
    );
  }, [
    pending,
    beneficiaryName,
    iban,
    bic,
    applyFieldIssues,
    resetResult,
    abortInFlight,
    session,
    selectedScenario,
    announce,
    NOTIFICATION_SEVERITIES,
    onValidated,
  ]);

  const handleConfirmOverride = useCallback(() => {
    if (confirming || confirmed || !isPlainObject(validation)) {
      return;
    }

    setConfirming(true);
    setOverrideError('');
    setStatusMessage('');

    let result;
    try {
      result = paymentFacade.recordValidationOverride(session, {
        validation,
        reason: overrideReason,
      });
    } catch (error) {
      safeLogger.warn('BeneficiaryValidationPage: failed to record override', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        safeReasonCode: paymentFacade.PAYMENT_FACADE_REASON_CODES.UNEXPECTED,
      };
    }

    setConfirming(false);

    if (isPlainObject(result.disposition)) {
      setDisposition(result.disposition);
    }

    if (result.ok) {
      const body = 'The override has been recorded and the beneficiary may be used for this payment.';
      setStatusMessage(body);
      setConfirmed(true);
      announce(NOTIFICATION_SEVERITIES.SUCCESS, 'Override recorded', body);
      if (typeof onValidated === 'function') {
        onValidated({
          disposition: POLICY_DISPOSITIONS.ALLOW_WITH_OVERRIDE,
          overrideReason: toText(overrideReason),
          verificationStatus: toText(validation.verificationStatus),
          scenarioRef: toText(validation.scenarioRef) || selectedScenario,
          safeReasonCode: result.safeReasonCode,
          validationRecord: validation,
          dispositionRecord: isPlainObject(result.disposition) ? result.disposition : disposition,
        });
      }
      return;
    }

    if (
      result.safeReasonCode === paymentFacade.PAYMENT_FACADE_REASON_CODES.OVERRIDE_REQUIRED
    ) {
      setOverrideError('Enter a reason of at least four characters to record the override.');
      announce(
        NOTIFICATION_SEVERITIES.WARNING,
        'Override reason required',
        'Enter a reason to record the override before continuing.',
      );
      return;
    }

    setOverrideError('The override could not be recorded. Review the details and try again.');
    announce(
      NOTIFICATION_SEVERITIES.WARNING,
      'Override unavailable',
      'The override could not be recorded for this beneficiary.',
    );
  }, [
    confirming,
    confirmed,
    validation,
    session,
    overrideReason,
    announce,
    NOTIFICATION_SEVERITIES,
    onValidated,
    selectedScenario,
  ]);

  const requiresOverride = useMemo(
    () =>
      isPlainObject(disposition) &&
      disposition.disposition === POLICY_DISPOSITIONS.ALLOW_WITH_OVERRIDE,
    [disposition],
  );

  const isBlocked = useMemo(
    () => isPlainObject(disposition) && disposition.disposition === POLICY_DISPOSITIONS.BLOCK,
    [disposition],
  );

  const isAllowed = useMemo(
    () => isPlainObject(disposition) && disposition.disposition === POLICY_DISPOSITIONS.ALLOW,
    [disposition],
  );

  // The "unavailable" outcome (the simulated Bankcheck service being
  // temporarily down) is a distinct, recoverable state from a genuine
  // validation failure (name mismatch, invalid IBAN/BIC, account not found).
  // Both currently resolve to the same BLOCK disposition, so this flag lets
  // the UI surface the scenario's own next-step copy instead of collapsing
  // every blocked outcome into one identical "blocked" message.
  const isUnavailable = useMemo(
    () => isPlainObject(validation) && toText(validation.outcome) === 'unavailable',
    [validation],
  );

  const nameError = useMemo(
    () => (fieldIssues.beneficiaryName ? 'Enter the beneficiary name to continue.' : undefined),
    [fieldIssues],
  );
  const ibanError = useMemo(
    () => (fieldIssues.iban ? 'Enter a valid IBAN to continue.' : undefined),
    [fieldIssues],
  );
  const bicError = useMemo(
    () => (fieldIssues.bic ? 'Enter a valid BIC/SWIFT code to continue.' : undefined),
    [fieldIssues],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-primary-blue-700">Validate beneficiary</h1>
        <p className="text-sm text-body">
          Enter the beneficiary details and run a simulated validation. Account identifiers are
          checked structurally before the simulated Bankcheck result is resolved.
        </p>
      </div>

      <Alert severity={ALERT_SEVERITIES.INFO} title="Simulated validation only">
        {NO_VERIFICATION_DISCLAIMER}
      </Alert>

      <section
        aria-labelledby="beneficiary-details-heading"
        className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
      >
        <div className="flex flex-col gap-1">
          <h2 id="beneficiary-details-heading" className="text-lg font-medium text-body">
            Beneficiary details
          </h2>
          <p className="text-sm text-body">
            Provide the beneficiary name and account identifiers to validate.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Beneficiary name" required error={nameError}>
            {(attrs) => (
              <input
                type="text"
                autoComplete="off"
                className={CONTROL_CLASSES}
                value={beneficiaryName}
                disabled={pending}
                onChange={handleNameChange}
                {...attrs}
              />
            )}
          </FormField>

          <FormField label="IBAN" error={ibanError}>
            {(attrs) => (
              <input
                type="text"
                autoComplete="off"
                className={CONTROL_CLASSES}
                value={iban}
                disabled={pending}
                onChange={handleIbanChange}
                {...attrs}
              />
            )}
          </FormField>

          <FormField label="BIC / SWIFT" error={bicError}>
            {(attrs) => (
              <input
                type="text"
                autoComplete="off"
                className={CONTROL_CLASSES}
                value={bic}
                disabled={pending}
                onChange={handleBicChange}
                {...attrs}
              />
            )}
          </FormField>

          {scenarios.length > 0 ? (
            <FormField label="Validation scenario">
              {(attrs) => (
                <select
                  className={CONTROL_CLASSES}
                  value={selectedScenario}
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
        </div>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="primary"
            size="md"
            disabled={pending}
            onClick={runValidation}
          >
            Validate beneficiary
          </Button>
          {pending ? (
            <LoadingIndicator size="sm" label="Validating beneficiary…" showLabel />
          ) : null}
        </div>
      </section>

      {statusMessage.length > 0 ? (
        <div role="status" aria-live="polite">
          <Alert severity={ALERT_SEVERITIES.SUCCESS} title="Validation complete">
            {statusMessage}
          </Alert>
        </div>
      ) : null}

      {isPlainObject(validation) && isPlainObject(disposition) ? (
        <section
          aria-labelledby="beneficiary-result-heading"
          className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="beneficiary-result-heading" className="text-lg font-medium text-body">
              Validation result
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={verificationTone(toText(validation.verificationStatus))}>
                {toLabel(validation.verificationStatus)}
              </StatusBadge>
              <StatusBadge tone={dispositionTone(disposition.disposition)}>
                {toLabel(disposition.disposition)}
              </StatusBadge>
            </div>
          </div>

          <dl className="flex flex-col">
            <div className="flex flex-col gap-1 border-b border-primary-blue-100 py-3 sm:flex-row sm:items-baseline sm:gap-4">
              <dt className="w-full text-sm font-medium text-primary-blue-700 sm:w-48">
                Verification status
              </dt>
              <dd className="text-sm text-body">{toLabel(validation.verificationStatus)}</dd>
            </div>
            <div className="flex flex-col gap-1 border-b border-primary-blue-100 py-3 sm:flex-row sm:items-baseline sm:gap-4">
              <dt className="w-full text-sm font-medium text-primary-blue-700 sm:w-48">
                Confidence score
              </dt>
              <dd className="text-sm text-body">
                {typeof validation.confidenceScore === 'number'
                  ? String(validation.confidenceScore)
                  : '—'}
              </dd>
            </div>
            <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:gap-4">
              <dt className="w-full text-sm font-medium text-primary-blue-700 sm:w-48">
                Disposition
              </dt>
              <dd className="text-sm text-body">{toLabel(disposition.disposition)}</dd>
            </div>
          </dl>

          {isAllowed ? (
            <Alert severity={ALERT_SEVERITIES.SUCCESS} title="Beneficiary allowed">
              The beneficiary was validated and may be used for this payment.
            </Alert>
          ) : null}

          {isBlocked && isUnavailable ? (
            <Alert
              severity={ALERT_SEVERITIES.WARNING}
              title={validation?.nextStep?.title || 'Validation unavailable'}
            >
              {validation?.nextStep?.body ||
                'The beneficiary validation service is temporarily unavailable. Wait a moment and try validating again.'}
            </Alert>
          ) : null}

          {isBlocked && !isUnavailable ? (
            <Alert
              severity={ALERT_SEVERITIES.CRITICAL}
              title={validation?.nextStep?.title || 'Beneficiary blocked'}
            >
              {validation?.nextStep?.body ||
                'The beneficiary could not be validated and cannot be used for this payment. Correct the details and validate again.'}
            </Alert>
          ) : null}

          {requiresOverride ? (
            <div className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-4">
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-medium text-body">Confirm with an override reason</h3>
                <p className="text-xs text-body">
                  The name-on-account is only a close match. Capture a reason to proceed with this
                  beneficiary. A blocked beneficiary can never be overridden.
                </p>
              </div>

              <FormField label="Override reason" required error={overrideError || undefined}>
                {(attrs) => (
                  <textarea
                    rows={3}
                    autoComplete="off"
                    className={CONTROL_CLASSES}
                    value={overrideReason}
                    disabled={confirming || confirmed}
                    onChange={handleOverrideReasonChange}
                    {...attrs}
                  />
                )}
              </FormField>

              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={confirming || confirmed || toText(overrideReason).length === 0}
                  onClick={handleConfirmOverride}
                >
                  {confirmed ? 'Override recorded' : 'Record override and continue'}
                </Button>
                {confirming ? (
                  <LoadingIndicator size="sm" label="Recording override…" showLabel />
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

BeneficiaryValidationPage.propTypes = {
  scenarioRef: PropTypes.string,
  onValidated: PropTypes.func,
};

export default BeneficiaryValidationPage;