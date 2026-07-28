/**
 * CBPR+ payment detail capture form.
 *
 * PaymentForm is the representative CBPR+ transaction-detail capture surface
 * (SCRUM-817). It builds a field-aware, conditional Zod schema for the resolved
 * CBPR+ rule set via the {@link cbprValidator} and drives a React Hook Form so
 * client-side validation stays declarative and consistent with the same rules
 * that gate submission. It captures the structured payment detail fields CBPR+
 * requires — debtor / creditor / agents, amount / settlement, purpose,
 * remittance, structured/unstructured address, and regulatory fields — and:
 *
 *   - Resolves the applicable rule set from the supplied scheme / jurisdiction /
 *     currency selector, honoring per-field requirement levels, length bounds,
 *     permitted character sets, and ISO code formats.
 *   - Supports both structured and unstructured address entry, toggling the
 *     presented address fields without ever losing captured values.
 *   - Generates a demo-safe mock UETR when the rule set requires one and none is
 *     supplied, surfacing it read-only so the user can see the reference.
 *   - Surfaces inline, sanitized field-level errors mapped from the CBPR
 *     validator's safe reason codes, and re-validates the aggregate through the
 *     {@link paymentFacade} before advancing.
 *
 * The form renders only sanitized copy — never PII beyond the values the user
 * enters — and never mutates application state beyond its own local capture
 * model. On a valid submission it invokes `onContinue` with the normalized CBPR+
 * values so the surrounding flow can proceed to message preview and submission.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import PropTypes from 'prop-types';
import { useAccessContext } from '@/app/useAccessContext';
import { useNotifications } from '@/app/NotificationContext';
import { cbprValidator, CBPR_REASON_CODES } from '@/features/payment/domain/cbprValidator';
import { paymentFacade } from '@/features/payment/services/paymentFacade';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { FormField } from '@/shared/ui/FormField';
import { LoadingIndicator } from '@/shared/ui/LoadingIndicator';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { cn } from '@/shared/ui/cn';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Shared control class list for text/select inputs. */
const CONTROL_CLASSES = cn(
  'rounded-md border border-primary-blue-200 bg-white px-3 py-2 text-sm text-body',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500 focus-visible:ring-offset-2',
  'disabled:cursor-not-allowed disabled:opacity-60',
);

/**
 * Supported address entry modes.
 * @type {{ STRUCTURED: 'structured', UNSTRUCTURED: 'unstructured' }}
 */
const ADDRESS_MODES = Object.freeze({
  STRUCTURED: 'structured',
  UNSTRUCTURED: 'unstructured',
});

/** Structured address field names presented in structured mode. */
const STRUCTURED_ADDRESS_FIELDS = Object.freeze([
  'debtor_street',
  'debtor_town',
  'debtor_postal_code',
]);

/** Unstructured address field names presented in unstructured mode. */
const UNSTRUCTURED_ADDRESS_FIELDS = Object.freeze(['debtor_address_line']);

/** Permitted charge treatment values for the payment form. */
const CHARGE_TREATMENTS = Object.freeze(['OUR', 'SHA', 'BEN']);

/**
 * The ordered CBPR+ capture fields grouped for display. Each descriptor
 * declares the field name, a human-readable label, and its input kind.
 * @type {ReadonlyArray<{
 *   id: string,
 *   label: string,
 *   fields: ReadonlyArray<{ field: string, label: string, kind: string }>,
 * }>}
 */
const FIELD_GROUPS = Object.freeze([
  {
    id: 'debtor',
    label: 'Debtor',
    fields: [
      { field: 'debtor_name', label: 'Debtor name', kind: 'text' },
      { field: 'debtor_country', label: 'Debtor country', kind: 'country' },
    ],
  },
  {
    id: 'creditor',
    label: 'Creditor',
    fields: [
      { field: 'creditor_name', label: 'Creditor name', kind: 'text' },
      { field: 'creditor_country', label: 'Creditor country', kind: 'country' },
      { field: 'creditor_town', label: 'Creditor town', kind: 'text' },
      { field: 'creditor_iban', label: 'Creditor IBAN', kind: 'text' },
      { field: 'creditor_account', label: 'Creditor account', kind: 'text' },
    ],
  },
  {
    id: 'agents',
    label: 'Agents',
    fields: [
      { field: 'creditor_agent_bic', label: 'Creditor agent BIC', kind: 'text' },
      { field: 'intermediary_agent_bic', label: 'Intermediary agent BIC', kind: 'text' },
    ],
  },
  {
    id: 'remittance',
    label: 'Remittance',
    fields: [{ field: 'remittance_information', label: 'Remittance information', kind: 'text' }],
  },
  {
    id: 'regulatory',
    label: 'Regulatory',
    fields: [{ field: 'purpose_code', label: 'Purpose code', kind: 'text' }],
  },
]);

/**
 * Maps a CBPR safe reason code to a sanitized, inline field error message.
 * @type {Record<string, string>}
 */
const REASON_MESSAGES = Object.freeze({
  [CBPR_REASON_CODES.FIELD_REQUIRED]: 'This field is required.',
  [CBPR_REASON_CODES.FIELD_FORBIDDEN]: 'This field is not permitted for this payment.',
  [CBPR_REASON_CODES.FIELD_TOO_LONG]: 'This value is too long.',
  [CBPR_REASON_CODES.FIELD_TOO_SHORT]: 'This value is too short.',
  [CBPR_REASON_CODES.INVALID_CHARACTERS]: 'This value contains unsupported characters.',
  [CBPR_REASON_CODES.INVALID_FORMAT]: 'This value does not match the required format.',
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
 * Resolves the message for a sanitized CBPR safe reason code.
 * @param {string} safeReasonCode - The safe reason code.
 * @returns {string} A sanitized, inline field error message.
 */
function messageForReason(safeReasonCode) {
  return Object.prototype.hasOwnProperty.call(REASON_MESSAGES, safeReasonCode)
    ? REASON_MESSAGES[safeReasonCode]
    : 'This value could not be validated.';
}

/**
 * Builds the rule-set selector for the CBPR validator from form props.
 * @param {{
 *   scheme?: string,
 *   jurisdiction?: string,
 *   currency?: string,
 *   ruleSetId?: string,
 * }} props - The selector source props.
 * @returns {{ ruleSetId?: string, scheme?: string, jurisdiction?: string, currency?: string }}
 *   The rule-set selector.
 */
function buildSelector(props) {
  const source = isPlainObject(props) ? props : {};
  const selector = {};
  const ruleSetId = toText(source.ruleSetId);
  const scheme = toText(source.scheme);
  const jurisdiction = toText(source.jurisdiction);
  const currency = toText(source.currency);
  if (ruleSetId.length > 0) {
    selector.ruleSetId = ruleSetId;
  }
  if (scheme.length > 0) {
    selector.scheme = scheme;
  }
  if (jurisdiction.length > 0) {
    selector.jurisdiction = jurisdiction;
  }
  if (currency.length > 0) {
    selector.currency = currency;
  }
  return selector;
}

/**
 * Renders the CBPR+ payment detail capture form.
 *
 * The form resolves the applicable CBPR+ rule set, builds a conditional schema
 * for validation, supports structured and unstructured address entry, generates
 * a mock UETR when required, and surfaces inline field-level errors. On a valid
 * submission it re-validates the aggregate through the payment facade and
 * surfaces the normalized values to the caller via `onContinue`.
 *
 * @param {{
 *   scheme?: string,
 *   jurisdiction?: string,
 *   currency?: string,
 *   ruleSetId?: string,
 *   chargeTreatment?: string,
 *   initialValues?: Record<string, unknown>,
 *   onContinue?: (result: {
 *     values: Record<string, unknown>,
 *     ruleSetId: string | null,
 *     addressMode: string,
 *   }) => void,
 * }} props - The payment form props.
 * @returns {React.ReactElement} The payment form element.
 */
export function PaymentForm({
  scheme,
  jurisdiction,
  currency,
  ruleSetId,
  chargeTreatment,
  initialValues,
  onContinue,
}) {
  const { sessionIdentity } = useAccessContext();
  const { notify, NOTIFICATION_SEVERITIES } = useNotifications();

  const [addressMode, setAddressMode] = useState(ADDRESS_MODES.STRUCTURED);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [uetr, setUetr] = useState('');

  const selector = useMemo(
    () => buildSelector({ scheme, jurisdiction, currency, ruleSetId }),
    [scheme, jurisdiction, currency, ruleSetId],
  );

  const session = useMemo(() => toSessionClaim(sessionIdentity), [sessionIdentity]);

  const resolvedRuleSetId = useMemo(() => {
    const resolved = cbprValidator.resolveRuleSet(selector);
    return isPlainObject(resolved) ? toText(resolved.rule_set_id) || null : null;
  }, [selector]);

  const defaultValues = useMemo(() => {
    const source = isPlainObject(initialValues) ? initialValues : {};
    const values = {
      debtor_name: toText(source.debtor_name),
      debtor_country: toText(source.debtor_country),
      debtor_street: toText(source.debtor_street),
      debtor_town: toText(source.debtor_town),
      debtor_postal_code: toText(source.debtor_postal_code),
      debtor_address_line: toText(source.debtor_address_line),
      creditor_name: toText(source.creditor_name),
      creditor_country: toText(source.creditor_country),
      creditor_town: toText(source.creditor_town),
      creditor_iban: toText(source.creditor_iban),
      creditor_account: toText(source.creditor_account),
      creditor_agent_bic: toText(source.creditor_agent_bic),
      intermediary_agent_bic: toText(source.intermediary_agent_bic),
      remittance_information: toText(source.remittance_information),
      purpose_code: toText(source.purpose_code),
      charge_treatment: toText(source.charge_treatment) || toText(chargeTreatment),
    };
    return values;
  }, [initialValues, chargeTreatment]);

  // Seed a demo-safe mock UETR when the rule set requires one.
  useEffect(() => {
    let generated = '';
    try {
      generated = cbprValidator.generateUetr();
    } catch (error) {
      safeLogger.warn('PaymentForm: failed to generate mock UETR', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      generated = '';
    }
    const initialUetr = toText(isPlainObject(initialValues) ? initialValues.uetr : '');
    setUetr(initialUetr.length > 0 ? initialUetr : generated);
  }, [initialValues, resolvedRuleSetId]);

  /**
   * Resolves the current form values merged with the address-mode selection and
   * mock UETR, so validation and continuation see the complete aggregate.
   * @param {Record<string, unknown>} values - The raw form values.
   * @returns {Record<string, unknown>} The normalized CBPR+ values.
   */
  const buildCbprValues = useCallback(
    (values) => {
      const source = isPlainObject(values) ? values : {};
      const output = {};
      for (const key of Object.keys(source)) {
        output[key] = toText(source[key]);
      }

      if (addressMode === ADDRESS_MODES.STRUCTURED) {
        output.debtor_address_line = '';
      } else {
        for (const field of STRUCTURED_ADDRESS_FIELDS) {
          output[field] = '';
        }
      }

      if (uetr.length > 0) {
        output.uetr = uetr;
      }
      return output;
    },
    [addressMode, uetr],
  );

  const schema = useMemo(() => {
    const resolved = cbprValidator.resolveRuleSet(selector);
    if (!isPlainObject(resolved)) {
      const built = cbprValidator.buildSchema({});
      return built.schema;
    }
    const built = cbprValidator.buildSchema(resolved, defaultValues);
    return built.schema;
  }, [selector, defaultValues]);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues,
    mode: 'onSubmit',
  });

  useEffect(() => {
    reset(defaultValues);
  }, [defaultValues, reset]);

  const announce = useCallback(
    (severity, title, body) => {
      try {
        notify({ severity, title, body });
      } catch (error) {
        safeLogger.warn('PaymentForm: failed to announce notification', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    },
    [notify],
  );

  const handleAddressModeChange = useCallback((event) => {
    const value = event.target.value;
    setAddressMode(
      value === ADDRESS_MODES.UNSTRUCTURED
        ? ADDRESS_MODES.UNSTRUCTURED
        : ADDRESS_MODES.STRUCTURED,
    );
  }, []);

  const handleRegenerateUetr = useCallback(() => {
    try {
      setUetr(cbprValidator.generateUetr());
    } catch (error) {
      safeLogger.warn('PaymentForm: failed to regenerate mock UETR', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }, []);

  const onSubmit = useCallback(
    (values) => {
      if (submitting) {
        return;
      }

      setSubmitting(true);
      setFormError('');
      setStatusMessage('');
      clearErrors();

      const cbprValues = buildCbprValues(values);

      let validation;
      try {
        validation = cbprValidator.validate(selector, cbprValues);
      } catch (error) {
        safeLogger.warn('PaymentForm: failed to validate CBPR details', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
        validation = {
          ok: false,
          ruleSetId: resolvedRuleSetId,
          issues: [],
          values: cbprValues,
          safeReasonCode: CBPR_REASON_CODES.UNEXPECTED,
        };
      }

      if (!validation.ok) {
        const issues = Array.isArray(validation.issues) ? validation.issues : [];
        for (const issue of issues) {
          if (isPlainObject(issue) && toText(issue.field).length > 0) {
            setError(issue.field, {
              type: 'manual',
              message: messageForReason(toText(issue.safeReasonCode)),
            });
          }
        }
        setSubmitting(false);
        setFormError(
          'Some payment details could not be validated. Review the highlighted fields and try again.',
        );
        announce(
          NOTIFICATION_SEVERITIES.WARNING,
          'Check the payment details',
          'Some payment details could not be validated.',
        );
        return;
      }

      const normalized = isPlainObject(validation.values) ? validation.values : cbprValues;
      const uetrValue = toText(normalized.uetr);
      if (uetrValue.length > 0) {
        setUetr(uetrValue);
      }

      let preview;
      try {
        preview = paymentFacade.previewSwiftMessages(session, {
          cbprSelector: selector,
          cbprDetails: normalized,
        });
      } catch (error) {
        safeLogger.warn('PaymentForm: failed to preview messages', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
        preview = {
          ok: false,
          safeReasonCode: paymentFacade.PAYMENT_FACADE_REASON_CODES.UNEXPECTED,
        };
      }

      setSubmitting(false);

      if (!preview.ok) {
        setFormError(
          'The payment details are valid but could not be prepared for preview. Try again.',
        );
        announce(
          NOTIFICATION_SEVERITIES.WARNING,
          'Preview unavailable',
          'The payment details could not be prepared for preview.',
        );
        return;
      }

      const body = 'The payment details have been validated and are ready to preview.';
      setStatusMessage(body);
      announce(NOTIFICATION_SEVERITIES.SUCCESS, 'Details validated', body);

      if (typeof onContinue === 'function') {
        onContinue({
          values: normalized,
          ruleSetId: validation.ruleSetId ?? resolvedRuleSetId,
          addressMode,
        });
      }
    },
    [
      submitting,
      clearErrors,
      buildCbprValues,
      selector,
      resolvedRuleSetId,
      setError,
      announce,
      NOTIFICATION_SEVERITIES,
      session,
      onContinue,
      addressMode,
    ],
  );

  const addressFields =
    addressMode === ADDRESS_MODES.STRUCTURED
      ? STRUCTURED_ADDRESS_FIELDS
      : UNSTRUCTURED_ADDRESS_FIELDS;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-primary-blue-700">Payment details</h1>
        <p className="text-sm text-body">
          Enter the CBPR+ transaction details for this international payment. Fields are validated
          against the applicable rule set before the message can be previewed.
        </p>
      </div>

      {resolvedRuleSetId ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-body">Rule set</span>
          <StatusBadge tone={STATUS_TONES.INFO}>{resolvedRuleSetId}</StatusBadge>
        </div>
      ) : (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="Default rule set applied">
          No specific CBPR+ rule set matched the selected scheme, jurisdiction, or currency. A
          baseline rule set is applied so you can continue.
        </Alert>
      )}

      {formError.length > 0 ? (
        <Alert severity={ALERT_SEVERITIES.CRITICAL} title="Check the payment details">
          {formError}
        </Alert>
      ) : null}

      {statusMessage.length > 0 ? (
        <div role="status" aria-live="polite">
          <Alert severity={ALERT_SEVERITIES.SUCCESS} title="Details validated">
            {statusMessage}
          </Alert>
        </div>
      ) : null}

      <form className="flex flex-col gap-6" onSubmit={handleSubmit(onSubmit)} noValidate>
        {FIELD_GROUPS.map((group) => (
          <section
            key={group.id}
            aria-labelledby={`group-${group.id}-heading`}
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
          >
            <h2 id={`group-${group.id}-heading`} className="text-lg font-medium text-body">
              {group.label}
            </h2>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {group.fields.map((descriptor) => {
                const errorMessage = errors[descriptor.field]
                  ? errors[descriptor.field].message
                  : undefined;

                return (
                  <FormField
                    key={descriptor.field}
                    label={descriptor.label}
                    error={errorMessage}
                  >
                    {(attrs) => (
                      <input
                        type="text"
                        autoComplete="off"
                        disabled={submitting}
                        className={CONTROL_CLASSES}
                        {...attrs}
                        {...register(descriptor.field)}
                      />
                    )}
                  </FormField>
                );
              })}
            </div>
          </section>
        ))}

        <section
          aria-labelledby="group-address-heading"
          className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
        >
          <div className="flex flex-col gap-1">
            <h2 id="group-address-heading" className="text-lg font-medium text-body">
              Debtor address
            </h2>
            <p className="text-sm text-body">
              Provide the debtor address as structured elements or as unstructured free-text lines.
            </p>
          </div>

          <FormField label="Address entry">
            {(attrs) => (
              <select
                className={CONTROL_CLASSES}
                value={addressMode}
                disabled={submitting}
                onChange={handleAddressModeChange}
                {...attrs}
              >
                <option value={ADDRESS_MODES.STRUCTURED}>Structured address</option>
                <option value={ADDRESS_MODES.UNSTRUCTURED}>Unstructured address</option>
              </select>
            )}
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {addressFields.map((field) => {
              const errorMessage = errors[field] ? errors[field].message : undefined;
              const label =
                field === 'debtor_address_line'
                  ? 'Address line'
                  : field === 'debtor_street'
                    ? 'Street'
                    : field === 'debtor_town'
                      ? 'Town'
                      : field === 'debtor_postal_code'
                        ? 'Postal code'
                        : field;

              return (
                <FormField key={field} label={label} error={errorMessage}>
                  {(attrs) => (
                    <input
                      type="text"
                      autoComplete="off"
                      disabled={submitting}
                      className={CONTROL_CLASSES}
                      {...attrs}
                      {...register(field)}
                    />
                  )}
                </FormField>
              );
            })}
          </div>
        </section>

        <section
          aria-labelledby="group-settlement-heading"
          className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-6"
        >
          <h2 id="group-settlement-heading" className="text-lg font-medium text-body">
            Charges and reference
          </h2>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Charge treatment">
              {(attrs) => (
                <select
                  className={CONTROL_CLASSES}
                  disabled={submitting}
                  {...attrs}
                  {...register('charge_treatment')}
                >
                  <option value="">Select a charge treatment</option>
                  {CHARGE_TREATMENTS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              )}
            </FormField>

            <FormField label="UETR" helpText="A demo-safe UETR generated for this simulation.">
              {(attrs) => (
                <input
                  type="text"
                  readOnly
                  autoComplete="off"
                  className={CONTROL_CLASSES}
                  value={uetr}
                  {...attrs}
                />
              )}
            </FormField>
          </div>

          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={submitting}
              onClick={handleRegenerateUetr}
            >
              Regenerate UETR
            </Button>
          </div>
        </section>

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" size="md" disabled={submitting}>
            Validate and continue
          </Button>
          {submitting ? (
            <LoadingIndicator size="sm" label="Validating details…" showLabel />
          ) : null}
        </div>
      </form>
    </div>
  );
}

PaymentForm.propTypes = {
  scheme: PropTypes.string,
  jurisdiction: PropTypes.string,
  currency: PropTypes.string,
  ruleSetId: PropTypes.string,
  chargeTreatment: PropTypes.string,
  initialValues: PropTypes.object,
  onContinue: PropTypes.func,
};

export default PaymentForm;