/**
 * Signer edit and before/after comparison page.
 *
 * SignerEditPage is the authorized-signer entitlement edit surface (SCRUM-825).
 * It loads a single masked signer display model scoped to the acting session,
 * builds a field-aware Zod schema for only the permitted, editable fields via
 * the {@link signerSchema} builder, and drives a React Hook Form so client-side
 * validation stays declarative and consistent. On submit it proposes the edit
 * through the {@link signerService} (which re-checks entitlement, record
 * eligibility, and the local edit revision), renders a masked before-and-after
 * comparison from the returned diff, and offers continuation into the simulated
 * eSign ceremony with a pending-confirmation state.
 *
 * The page is intentionally conservative and demo-only:
 *
 *   - Only permitted, editable fields are rendered; always-locked and
 *     non-editable fields are never presented for edit.
 *   - The confirmation step disables while its request is pending so it can
 *     never be double-invoked; the resolved operation reference is retained so a
 *     repeated eSign click is refused rather than re-applied.
 *   - Outcomes are announced through the shared notification live regions and a
 *     local status message; the page renders only sanitized, masked copy and
 *     carries no PII beyond the masked display model it receives.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate, useParams } from 'react-router-dom';
import { useAccessContext } from '@/app/useAccessContext';
import { useNotifications } from '@/app/NotificationContext';
import { signerService } from '@/features/access/services/signerService';
import { signerSchema } from '@/features/access/services/signerSchema';
import { esignService } from '@/features/access/services/esignService';
import { CAPABILITIES } from '@/shared/config/constants';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { FormField } from '@/shared/ui/FormField';
import { LoadingIndicator } from '@/shared/ui/LoadingIndicator';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { cn } from '@/shared/ui/cn';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Permitted authority values for the signer edit form. */
const AUTHORITY_OPTIONS = Object.freeze(['sole', 'joint', 'limited']);

/** Permitted status values for the signer edit form. */
const STATUS_OPTIONS = Object.freeze(['active', 'suspended', 'revoked', 'pending']);

/** Shared control class list for text/select inputs. */
const CONTROL_CLASSES = cn(
  'rounded-md border border-primary-blue-200 px-3 py-2 text-sm text-body',
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
 * Resolves the acting session's account scopes from the sanitized identity.
 * @param {Record<string, unknown> | null | undefined} identity - The identity.
 * @returns {string[]} The session's account scopes (may be empty).
 */
function resolveAccountScopes(identity) {
  if (!isPlainObject(identity)) {
    return [];
  }
  return toStringArray(identity.accountScopes);
}

/**
 * Builds a minimal session claim shape for the signer service from the
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
 * Determines whether the acting session holds the signer manage capability.
 * @param {Record<string, unknown> | null | undefined} identity - The identity.
 * @returns {boolean} `true` when the session holds the manage capability.
 */
function hasManageCapability(identity) {
  if (!isPlainObject(identity)) {
    return false;
  }
  return toStringArray(identity.capabilities).includes(CAPABILITIES.SIGNER_MANAGE);
}

/**
 * Formats a status/authority identifier into a readable label.
 * @param {unknown} value - The raw identifier.
 * @returns {string} A human-readable label.
 */
function toLabel(value) {
  const text = toText(value);
  if (text.length === 0) {
    return '—';
  }
  return text
    .split('_')
    .map((part) => (part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/**
 * Builds the default form values for the editable fields of a signer.
 * @param {Record<string, unknown>} signer - The masked signer display model.
 * @param {string[]} fields - The editable field names.
 * @returns {Record<string, unknown>} The default form values.
 */
function buildDefaultValues(signer, fields) {
  const values = {};
  for (const field of fields) {
    if (field === 'amount_limit') {
      values[field] =
        typeof signer.amount_limit === 'number' && Number.isFinite(signer.amount_limit)
          ? signer.amount_limit
          : null;
    } else if (field === 'account_scopes') {
      values[field] = toStringArray(signer.account_scopes);
    } else {
      values[field] = toText(signer[field]);
    }
  }
  return values;
}

/**
 * Renders a single field-level diff row for the comparison view.
 * @param {{
 *   field: string,
 *   changed: boolean,
 *   beforeDisplay: string,
 *   afterDisplay: string,
 * }} entry - The field diff entry.
 * @returns {React.ReactElement} The diff row element.
 */
function DiffRow({ entry }) {
  return (
    <div className="flex flex-col gap-1 border-b border-primary-blue-100 py-3 sm:flex-row sm:items-baseline sm:gap-4">
      <div className="flex w-full items-center gap-2 sm:w-48">
        <span className="text-sm font-medium text-primary-blue-700">{toLabel(entry.field)}</span>
        {entry.changed ? (
          <StatusBadge tone={STATUS_TONES.INFO}>Changed</StatusBadge>
        ) : null}
      </div>
      <dl className="flex flex-1 flex-col gap-1 text-sm text-body sm:flex-row sm:gap-6">
        <div className="flex gap-2">
          <dt className="font-medium text-primary-blue-700">Before</dt>
          <dd>{entry.beforeDisplay}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium text-primary-blue-700">After</dt>
          <dd>{entry.afterDisplay}</dd>
        </div>
      </dl>
    </div>
  );
}

DiffRow.propTypes = {};

/**
 * Renders the authorized-signer edit and comparison page.
 *
 * The page loads a masked signer display model scoped to the acting session's
 * entitlements, builds a permitted-fields-only edit form, proposes the edit via
 * the signer service, and renders a masked before-and-after comparison. It then
 * offers continuation into the simulated eSign ceremony with a pending state.
 * It renders an unauthorized state when the session lacks the manage capability
 * and a not-found state when the signer is not visible.
 *
 * @returns {React.ReactElement} The signer edit page element.
 */
export function SignerEditPage() {
  const { signerId } = useParams();
  const navigate = useNavigate();
  const { sessionIdentity, maskingPolicy } = useAccessContext();
  const { notify, NOTIFICATION_SEVERITIES } = useNotifications();

  const [signer, setSigner] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  const [diff, setDiff] = useState(null);
  const [operationId, setOperationId] = useState('');

  const [esignPending, setEsignPending] = useState(false);
  const [esignError, setEsignError] = useState('');

  /** @type {React.MutableRefObject<string | null>} */
  const esignOperationRef = useRef(null);

  const accountScopes = useMemo(() => resolveAccountScopes(sessionIdentity), [sessionIdentity]);

  const canManage = useMemo(() => hasManageCapability(sessionIdentity), [sessionIdentity]);

  const editableFields = useMemo(() => {
    if (!isPlainObject(signer)) {
      return [];
    }
    return signerSchema.getEditableFieldNames({
      editableFields: toStringArray(signer.editable_fields),
      lockedFields: toStringArray(signer.locked_fields),
    });
  }, [signer]);

  const schema = useMemo(() => {
    if (!isPlainObject(signer)) {
      return signerSchema.buildSignerSchema({});
    }
    return signerSchema.buildSignerSchema({
      editableFields: toStringArray(signer.editable_fields),
      lockedFields: toStringArray(signer.locked_fields),
    });
  }, [signer]);

  const defaultValues = useMemo(() => {
    if (!isPlainObject(signer)) {
      return {};
    }
    return buildDefaultValues(signer, editableFields);
  }, [signer, editableFields]);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues,
    mode: 'onSubmit',
  });

  useEffect(() => {
    reset(defaultValues);
  }, [defaultValues, reset]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotFound(false);

    const claim = toSessionClaim(sessionIdentity);
    const context = toText(maskingPolicy) || undefined;
    const id = toText(signerId);

    let result;
    try {
      result = signerService.getById(claim, id, { accountScopes, context });
    } catch (error) {
      safeLogger.warn('SignerEditPage: failed to load signer', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = { ok: false, safeReasonCode: 'signer.service.unexpected' };
    }

    if (!active) {
      return;
    }

    if (result.ok) {
      setAuthorized(true);
      setNotFound(false);
      setSigner(isPlainObject(result.signer) ? result.signer : null);
    } else if (
      result.safeReasonCode === signerService.SIGNER_SERVICE_REASON_CODES.UNAUTHORIZED
    ) {
      setAuthorized(false);
      setSigner(null);
    } else {
      setAuthorized(true);
      setNotFound(true);
      setSigner(null);
    }
    setLoading(false);

    return () => {
      active = false;
    };
  }, [sessionIdentity, maskingPolicy, accountScopes, signerId]);

  const announce = useCallback(
    (severity, title, body) => {
      try {
        notify({ severity, title, body });
      } catch (error) {
        safeLogger.warn('SignerEditPage: failed to announce notification', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    },
    [notify],
  );

  const handleBack = useCallback(() => {
    navigate(`/signers/${toText(signerId)}`);
  }, [navigate, signerId]);

  const onSubmit = useCallback(
    (values) => {
      if (submitting || !isPlainObject(signer)) {
        return;
      }

      setSubmitting(true);
      setFormError('');
      setStatusMessage('');

      const expectedRevision =
        typeof signer.edit_revision === 'number' && Number.isFinite(signer.edit_revision)
          ? signer.edit_revision
          : undefined;
      const context = toText(maskingPolicy) || undefined;

      let result;
      try {
        result = signerService.proposeEdit(
          toSessionClaim(sessionIdentity),
          toText(signerId),
          values,
          { accountScopes, expectedRevision, context },
        );
      } catch (error) {
        safeLogger.warn('SignerEditPage: failed to propose edit', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
        result = {
          ok: false,
          safeReasonCode: signerService.SIGNER_SERVICE_REASON_CODES.UNEXPECTED,
        };
      }

      setSubmitting(false);

      if (result.ok) {
        setDiff(isPlainObject(result.diff) ? result.diff : null);
        setOperationId(toText(result.operationId));
        setStatusMessage('Your changes have been recorded and are ready to sign.');
        announce(
          NOTIFICATION_SEVERITIES.SUCCESS,
          'Changes recorded',
          'Your changes have been recorded and are ready to sign.',
        );
      } else if (
        result.safeReasonCode === signerService.SIGNER_SERVICE_REASON_CODES.CONCURRENT_EDIT
      ) {
        setFormError(
          'This signer was updated elsewhere while you were editing. Reload the latest details and reapply your changes.',
        );
        announce(
          NOTIFICATION_SEVERITIES.WARNING,
          'Changes could not be saved',
          'This signer was updated elsewhere while you were editing.',
        );
      } else if (
        result.safeReasonCode === signerService.SIGNER_SERVICE_REASON_CODES.NO_CHANGES
      ) {
        setFormError('No changes were detected. Edit at least one field before continuing.');
      } else {
        setFormError('Your changes could not be saved with your current role and its status.');
        announce(
          NOTIFICATION_SEVERITIES.WARNING,
          'Changes could not be saved',
          'Your changes could not be saved with your current role and its status.',
        );
      }
    },
    [
      submitting,
      signer,
      sessionIdentity,
      signerId,
      accountScopes,
      maskingPolicy,
      announce,
      NOTIFICATION_SEVERITIES,
    ],
  );

  const handleESign = useCallback(async () => {
    if (esignPending || operationId.length === 0) {
      return;
    }

    if (esignOperationRef.current !== null) {
      setEsignError('');
      setStatusMessage('This change has already been signed in this session.');
      return;
    }

    setEsignPending(true);
    setEsignError('');
    setStatusMessage('');

    let result;
    try {
      result = await signerService.completeESign(
        toSessionClaim(sessionIdentity),
        toText(signerId),
        operationId,
      );
    } catch (error) {
      safeLogger.warn('SignerEditPage: failed to complete eSign', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        safeReasonCode: signerService.SIGNER_SERVICE_REASON_CODES.UNEXPECTED,
      };
    }

    setEsignPending(false);

    if (result.ok) {
      esignOperationRef.current = operationId;
      setStatusMessage('The change has been signed and recorded.');
      announce(
        NOTIFICATION_SEVERITIES.SUCCESS,
        'Signature confirmed',
        'The change has been signed and recorded.',
      );
    } else {
      setEsignError('The change could not be signed. You can review the details and try again.');
      announce(
        NOTIFICATION_SEVERITIES.WARNING,
        'Signature unavailable',
        'The change could not be signed. You can review the details and try again.',
      );
    }
  }, [esignPending, operationId, sessionIdentity, signerId, announce, NOTIFICATION_SEVERITIES]);

  const changedFields = useMemo(
    () => (isPlainObject(diff) && Array.isArray(diff.fields) ? diff.fields : []),
    [diff],
  );

  const esignDone = esignOperationRef.current !== null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-primary-blue-700">Edit signer entitlements</h1>
        <p className="text-sm text-body">
          Update only the permitted fields for this signer, review the before-and-after comparison,
          and sign to record the change. Contact and identifier fields are masked to protect
          information.
        </p>
      </div>

      <div>
        <Button type="button" variant="secondary" size="sm" onClick={handleBack}>
          Back to signer detail
        </Button>
      </div>

      {loading ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-primary-blue-100 bg-white px-4 py-6 text-center text-sm text-body"
        >
          Loading signer…
        </div>
      ) : !authorized || !canManage ? (
        <Alert severity={ALERT_SEVERITIES.CRITICAL} title="Access denied">
          Your current role does not hold the capability required to edit this signer. Switch to a
          role that grants it and try again.
        </Alert>
      ) : notFound || !isPlainObject(signer) ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="Signer not found">
          The requested signer record could not be located for your entitlements. It may have been
          removed or is outside your account scope.
        </Alert>
      ) : editableFields.length === 0 ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="No editable fields">
          This signer has no fields available for edit with your current role and its status.
        </Alert>
      ) : (
        <>
          <section
            aria-labelledby="signer-edit-heading"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
          >
            <h2 id="signer-edit-heading" className="text-lg font-medium text-body">
              {toText(signer.signer_name) || '—'}
            </h2>

            {formError.length > 0 ? (
              <Alert severity={ALERT_SEVERITIES.CRITICAL} title="Changes could not be saved">
                {formError}
              </Alert>
            ) : null}

            <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)} noValidate>
              {editableFields.map((field) => {
                const errorMessage = errors[field] ? errors[field].message : undefined;

                if (field === 'authority') {
                  return (
                    <FormField key={field} label="Signing authority" error={errorMessage}>
                      {(attrs) => (
                        <select
                          className={CONTROL_CLASSES}
                          disabled={submitting}
                          {...attrs}
                          {...register(field)}
                        >
                          <option value="">Select an authority</option>
                          {AUTHORITY_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                              {toLabel(option)}
                            </option>
                          ))}
                        </select>
                      )}
                    </FormField>
                  );
                }

                if (field === 'status') {
                  return (
                    <FormField key={field} label="Status" error={errorMessage}>
                      {(attrs) => (
                        <select
                          className={CONTROL_CLASSES}
                          disabled={submitting}
                          {...attrs}
                          {...register(field)}
                        >
                          <option value="">Select a status</option>
                          {STATUS_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                              {toLabel(option)}
                            </option>
                          ))}
                        </select>
                      )}
                    </FormField>
                  );
                }

                if (field === 'amount_limit') {
                  return (
                    <FormField key={field} label="Amount limit" error={errorMessage}>
                      {(attrs) => (
                        <input
                          type="number"
                          inputMode="decimal"
                          disabled={submitting}
                          className={CONTROL_CLASSES}
                          {...attrs}
                          {...register(field, { valueAsNumber: true })}
                        />
                      )}
                    </FormField>
                  );
                }

                if (field === 'email') {
                  return (
                    <FormField key={field} label="Email" error={errorMessage}>
                      {(attrs) => (
                        <input
                          type="email"
                          autoComplete="off"
                          disabled={submitting}
                          className={CONTROL_CLASSES}
                          {...attrs}
                          {...register(field)}
                        />
                      )}
                    </FormField>
                  );
                }

                if (field === 'phone') {
                  return (
                    <FormField key={field} label="Phone" error={errorMessage}>
                      {(attrs) => (
                        <input
                          type="tel"
                          autoComplete="off"
                          disabled={submitting}
                          className={CONTROL_CLASSES}
                          {...attrs}
                          {...register(field)}
                        />
                      )}
                    </FormField>
                  );
                }

                return (
                  <FormField key={field} label={toLabel(field)} error={errorMessage}>
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

              <div className="flex items-center gap-3">
                <Button type="submit" variant="primary" size="md" disabled={submitting}>
                  Review changes
                </Button>
                {submitting ? (
                  <LoadingIndicator size="sm" label="Recording changes…" showLabel />
                ) : null}
              </div>
            </form>
          </section>

          {statusMessage.length > 0 ? (
            <div role="status" aria-live="polite">
              <Alert severity={ALERT_SEVERITIES.SUCCESS} title="Action completed">
                {statusMessage}
              </Alert>
            </div>
          ) : null}

          {isPlainObject(diff) ? (
            <section
              aria-labelledby="signer-diff-heading"
              className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
            >
              <div className="flex flex-col gap-1">
                <h2 id="signer-diff-heading" className="text-lg font-medium text-body">
                  Before and after
                </h2>
                <p className="text-sm text-body">
                  Review the recorded changes below. Values are masked to protect information.
                </p>
              </div>

              <dl className="flex flex-col">
                {changedFields.length > 0 ? (
                  changedFields.map((entry) => <DiffRow key={entry.field} entry={entry} />)
                ) : (
                  <p className="py-3 text-sm text-body">No comparable field changes to display.</p>
                )}
              </dl>
            </section>
          ) : null}

          {operationId.length > 0 ? (
            <section
              aria-labelledby="signer-esign-heading"
              className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-6"
            >
              <div className="flex flex-col gap-1">
                <h2 id="signer-esign-heading" className="text-lg font-medium text-body">
                  Sign the change
                </h2>
                <p className="text-sm text-body">
                  Continue into the simulated eSign ceremony to record and confirm this change. No
                  real signature is collected in this demo.
                </p>
              </div>

              {esignError.length > 0 ? (
                <Alert severity={ALERT_SEVERITIES.WARNING} title="Signature unavailable">
                  {esignError}
                </Alert>
              ) : null}

              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="primary"
                  size="md"
                  disabled={esignPending || esignDone}
                  onClick={handleESign}
                >
                  {esignDone ? 'Change signed' : 'Continue to eSign'}
                </Button>
                {esignPending ? (
                  <LoadingIndicator size="sm" label="Awaiting signature…" showLabel />
                ) : null}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

// Referenced to document the simulated eSign service this page continues into.
void esignService;

export default SignerEditPage;