/**
 * Clear-all-demo-data page.
 *
 * ClearDataPage is the demo-reset surface (SCRUM-827). It offers a single,
 * clearly-scoped action to clear every application-managed store back to a clean
 * baseline via the {@link demoDataService}: sessions, signer overlays, change
 * requests, operation ledgers, audit history, and every payment domain. It is
 * intentionally conservative and demo-only:
 *
 *   - A confirmation {@link Modal} explains exactly what will be cleared before
 *     any destructive action runs, and preserves correct return focus so the
 *     trigger regains focus when the dialog closes.
 *   - The confirm control disables while the reset is in flight so it can never
 *     be double-invoked.
 *   - The outcome is announced through the shared notification live regions and
 *     surfaced as a local status message; a successful clear signs the acting
 *     session out and returns the user to the login route so the app
 *     re-provisions cleanly against the pristine baseline fixtures.
 *
 * The page renders only sanitized copy — never PII — and never mutates
 * application state beyond invoking the reset service and clearing the acting
 * session.
 */

import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccessContext } from '@/app/useAccessContext';
import { useNotifications } from '@/app/NotificationContext';
import { demoDataService } from '@/features/access/services/demoDataService';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { LoadingIndicator } from '@/shared/ui/LoadingIndicator';
import { Modal } from '@/shared/ui/Modal';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Login route the user is returned to after a successful clear. */
const LOGIN_ROUTE = '/login';

/**
 * The set of application-managed stores cleared by the reset, surfaced so the
 * confirmation dialog can explain the scope precisely.
 * @type {ReadonlyArray<{ id: string, label: string, description: string }>}
 */
const CLEARED_STORES = Object.freeze([
  {
    id: 'sessions',
    label: 'Sessions',
    description: 'The acting demo session is signed out and any restored session is purged.',
  },
  {
    id: 'signer-overlays',
    label: 'Signer overlays',
    description: 'Local signer entitlement overrides are removed, restoring the baseline signers.',
  },
  {
    id: 'change-requests',
    label: 'Change requests',
    description: 'Recorded signer change requests are cleared.',
  },
  {
    id: 'operations',
    label: 'Operation ledgers',
    description: 'Confirm, unlock, and resend operation references are cleared.',
  },
  {
    id: 'audit',
    label: 'Audit history',
    description: 'The local, sanitized audit trail is removed.',
  },
  {
    id: 'payment',
    label: 'Payment data',
    description: 'Payment drafts, accepted records, reservations, and scenario overrides are cleared.',
  },
]);

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
 * Builds a minimal session shape used only to attribute the reset audit event.
 * @param {Record<string, unknown> | null | undefined} identity - The identity.
 * @returns {{ subjectId: string } | null} A session-like value, or `null`.
 */
function toAuditSession(identity) {
  if (!isPlainObject(identity)) {
    return null;
  }
  const subjectId = toText(identity.subjectId);
  return subjectId.length > 0 ? { subjectId } : null;
}

/**
 * Renders the clear-all-demo-data page.
 *
 * The page gates the destructive reset behind a scoped confirmation dialog,
 * disables the confirm control while the reset runs, announces the outcome, and
 * — on success — signs the session out and returns the user to the login route
 * so the app re-provisions against the baseline fixtures.
 *
 * @returns {React.ReactElement} The clear data page element.
 */
export function ClearDataPage() {
  const { sessionIdentity, logout } = useAccessContext();
  const { notify, NOTIFICATION_SEVERITIES } = useNotifications();
  const navigate = useNavigate();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const auditSession = useMemo(() => toAuditSession(sessionIdentity), [sessionIdentity]);

  const announce = useCallback(
    (severity, title, body) => {
      try {
        notify({ severity, title, body });
      } catch (error) {
        safeLogger.warn('ClearDataPage: failed to announce notification', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    },
    [notify],
  );

  const handleOpenConfirm = useCallback(() => {
    setStatusMessage('');
    setErrorMessage('');
    setConfirmOpen(true);
  }, []);

  const handleCloseConfirm = useCallback(() => {
    if (clearing) {
      return;
    }
    setConfirmOpen(false);
  }, [clearing]);

  const handleConfirmClear = useCallback(() => {
    if (clearing) {
      return;
    }

    setClearing(true);
    setStatusMessage('');
    setErrorMessage('');

    let result;
    try {
      result = demoDataService.clear(auditSession);
    } catch (error) {
      safeLogger.warn('ClearDataPage: failed to clear demo data', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = { ok: false, safeReasonCode: demoDataService.DEMO_DATA_REASON_CODES.UNEXPECTED };
    }

    setClearing(false);
    setConfirmOpen(false);

    if (result.ok) {
      const body =
        'All demo data has been cleared and reset to the baseline fixtures. You will be returned to the sign-in page.';
      setStatusMessage(body);
      announce(NOTIFICATION_SEVERITIES.SUCCESS, 'Demo data cleared', body);
      try {
        logout(demoDataService.DEMO_DATA_REASON_CODES.CLEARED);
      } catch (error) {
        safeLogger.warn('ClearDataPage: failed to sign out after clear', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
      navigate(LOGIN_ROUTE, { replace: true });
      return;
    }

    const body =
      'The demo data could not be fully cleared. Some browser storage may be unavailable — try again.';
    setErrorMessage(body);
    announce(NOTIFICATION_SEVERITIES.WARNING, 'Clear unavailable', body);
  }, [clearing, auditSession, announce, NOTIFICATION_SEVERITIES, logout, navigate]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-primary-blue-700">Clear demo data</h1>
        <p className="text-sm text-body">
          Reset this demonstration back to a clean baseline. This clears the locally-stored data
          created during your session and reloads the pristine baseline fixtures.
        </p>
      </div>

      <Alert severity={ALERT_SEVERITIES.WARNING} title="This action cannot be undone">
        Clearing demo data removes every locally-stored change created during this session. It only
        affects data stored in your browser for the demo and never touches anything outside the
        app&apos;s own namespace.
      </Alert>

      {statusMessage.length > 0 ? (
        <div role="status" aria-live="polite">
          <Alert severity={ALERT_SEVERITIES.SUCCESS} title="Demo data cleared">
            {statusMessage}
          </Alert>
        </div>
      ) : null}

      {errorMessage.length > 0 ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="Clear unavailable">
          {errorMessage}
        </Alert>
      ) : null}

      <section
        aria-labelledby="clear-scope-heading"
        className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
      >
        <div className="flex flex-col gap-1">
          <h2 id="clear-scope-heading" className="text-lg font-medium text-body">
            What will be cleared
          </h2>
          <p className="text-sm text-body">
            The following application-managed stores are reset to their baseline state.
          </p>
        </div>

        <dl className="flex flex-col">
          {CLEARED_STORES.map((store) => (
            <div
              key={store.id}
              className="flex flex-col gap-1 border-b border-primary-blue-100 py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4"
            >
              <dt className="w-full text-sm font-medium text-primary-blue-700 sm:w-48">
                {store.label}
              </dt>
              <dd className="text-sm text-body">{store.description}</dd>
            </div>
          ))}
        </dl>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="danger"
            size="md"
            disabled={clearing}
            onClick={handleOpenConfirm}
          >
            Clear all demo data
          </Button>
          {clearing ? <LoadingIndicator size="sm" label="Clearing demo data…" showLabel /> : null}
        </div>
      </section>

      <Modal
        open={confirmOpen}
        onClose={handleCloseConfirm}
        title="Clear all demo data?"
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={clearing}
              onClick={handleCloseConfirm}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={clearing}
              onClick={handleConfirmClear}
            >
              Clear demo data
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-body">
            This will clear your session, signer overlays, change requests, operation ledgers, audit
            history, and all payment data, then reset the demo to the baseline fixtures. You will be
            signed out and returned to the sign-in page.
          </p>
          <ul className="flex flex-col gap-1 text-sm text-body">
            {CLEARED_STORES.map((store) => (
              <li key={store.id} className="flex gap-2">
                <span className="font-medium text-primary-blue-700">{store.label}</span>
                <span>{store.description}</span>
              </li>
            ))}
          </ul>
          {clearing ? <LoadingIndicator size="sm" label="Clearing demo data…" showLabel /> : null}
        </div>
      </Modal>
    </div>
  );
}

export default ClearDataPage;