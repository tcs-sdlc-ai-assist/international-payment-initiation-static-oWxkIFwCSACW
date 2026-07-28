/**
 * Account & currency selection page.
 *
 * AccountSelectionPage is the FX quote entry surface (SCRUM-816). It reads the
 * entitlement-scoped, masked source accounts from the {@link accountFacade}
 * (which enforces the deny-by-default {@link authorizationPolicy}) and lets the
 * user pick a source account and a beneficiary currency, then validates the
 * resulting currency pair before allowing the flow to proceed. It renders:
 *
 *   - An account picker listing each account's name, masked number, currency,
 *     simulated available balance, and supported beneficiary currencies.
 *   - A beneficiary-currency picker constrained to the currencies the selected
 *     account supports.
 *   - Live currency-pair validation that blocks unsupported, restricted, or
 *     same-currency pairs with a clear, demo-safe message drawn from the facade.
 *
 * The page renders only sanitized, masked copy — never raw banking details
 * beyond the masked display models the facade produces — and never mutates
 * application state beyond its own local selection model. On a supported pair it
 * invokes `onContinue` so the surrounding quote flow can proceed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { useAccessContext } from '@/app/useAccessContext';
import { accountFacade } from '@/features/payment/services/accountFacade';
import { Alert, ALERT_SEVERITIES } from '@/shared/ui/Alert';
import { Button } from '@/shared/ui/Button';
import { FormField } from '@/shared/ui/FormField';
import { StatusBadge, STATUS_TONES } from '@/shared/ui/StatusBadge';
import { cn } from '@/shared/ui/cn';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Sentinel select value meaning "no selection". */
const NONE_VALUE = '';

/** Shared control class list for select inputs. */
const SELECT_CLASSES = cn(
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
 * Builds a minimal session claim shape for the account facade from the
 * sanitized session identity.
 * @param {Record<string, unknown> | null | undefined} identity - The identity.
 * @returns {{
 *   subjectId: string,
 *   roles: string[],
 *   capabilities: string[],
 *   accountScopes: string[],
 * }} A claim-like value.
 */
function toSessionClaim(identity) {
  if (!isPlainObject(identity)) {
    return { subjectId: '', roles: [], capabilities: [], accountScopes: [] };
  }
  return {
    subjectId: toText(identity.subjectId),
    roles: toStringArray(identity.roles),
    capabilities: toStringArray(identity.capabilities),
    accountScopes: toStringArray(identity.accountScopes),
  };
}

/**
 * Formats a simulated balance amount for display.
 * @param {unknown} value - The raw balance.
 * @param {string} currency - The account currency.
 * @returns {string} A display-safe balance string.
 */
function formatBalance(value, currency) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }
  const formatted = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const code = toText(currency);
  return code.length > 0 ? `${formatted} ${code}` : formatted;
}

/**
 * Resolves a supported severity for a currency-pair customer-copy result.
 * @param {boolean} eligible - Whether the pair is eligible.
 * @returns {string} A severity from {@link ALERT_SEVERITIES}.
 */
function pairSeverity(eligible) {
  return eligible ? ALERT_SEVERITIES.SUCCESS : ALERT_SEVERITIES.WARNING;
}

/**
 * Renders the account & currency selection page.
 *
 * The page loads masked, entitlement-scoped source accounts, lets the user pick
 * an account and a beneficiary currency, and validates the resulting currency
 * pair. Unsupported, restricted, or same-currency pairs are blocked with clear
 * messaging; a supported pair enables the continue action, which surfaces the
 * selection to the caller via `onContinue`.
 *
 * @param {{
 *   onContinue?: (selection: {
 *     accountId: string,
 *     sourceCurrency: string,
 *     beneficiaryCurrency: string,
 *     pairId: string | null,
 *   }) => void,
 * }} props - The account selection page props.
 * @returns {React.ReactElement} The account selection page element.
 */
export function AccountSelectionPage({ onContinue }) {
  const { sessionIdentity, maskingPolicy } = useAccessContext();

  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);

  const [accountId, setAccountId] = useState(NONE_VALUE);
  const [beneficiaryCurrency, setBeneficiaryCurrency] = useState(NONE_VALUE);
  const [pairResult, setPairResult] = useState(null);

  const session = useMemo(() => toSessionClaim(sessionIdentity), [sessionIdentity]);

  useEffect(() => {
    let active = true;
    setLoading(true);

    const context = toText(maskingPolicy) || undefined;

    let result;
    try {
      result = accountFacade.listEligibleAccounts(session, { context });
    } catch (error) {
      safeLogger.warn('AccountSelectionPage: failed to load accounts', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        accounts: [],
        safeReasonCode: accountFacade.ACCOUNT_FACADE_REASON_CODES.UNEXPECTED,
      };
    }

    if (!active) {
      return;
    }

    if (result.ok) {
      setAuthorized(true);
      setAccounts(Array.isArray(result.accounts) ? result.accounts : []);
    } else {
      setAuthorized(
        result.safeReasonCode !==
          accountFacade.ACCOUNT_FACADE_REASON_CODES.UNAUTHORIZED,
      );
      setAccounts([]);
    }
    setLoading(false);

    return () => {
      active = false;
    };
  }, [session, maskingPolicy]);

  const selectedAccount = useMemo(
    () =>
      accounts.find(
        (account) => isPlainObject(account) && toText(account.accountId) === accountId,
      ) ?? null,
    [accounts, accountId],
  );

  const sourceCurrency = useMemo(
    () => (isPlainObject(selectedAccount) ? toText(selectedAccount.currency) : ''),
    [selectedAccount],
  );

  const beneficiaryOptions = useMemo(() => {
    if (!isPlainObject(selectedAccount)) {
      return [];
    }
    return toStringArray(selectedAccount.supportedBeneficiaryCurrencies).filter(
      (currency) => currency.toUpperCase() !== sourceCurrency.toUpperCase(),
    );
  }, [selectedAccount, sourceCurrency]);

  // Validate the currency pair whenever the selection changes.
  useEffect(() => {
    if (sourceCurrency.length === 0 || beneficiaryCurrency.length === 0) {
      setPairResult(null);
      return;
    }

    let result;
    try {
      result = accountFacade.validateCurrencyPair({
        sourceCurrency,
        beneficiaryCurrency,
      });
    } catch (error) {
      safeLogger.warn('AccountSelectionPage: failed to validate currency pair', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      result = {
        ok: false,
        pairId: null,
        eligible: false,
        safeReasonCode: accountFacade.ACCOUNT_FACADE_REASON_CODES.UNEXPECTED,
        customerCopy: {
          title: 'Currency pair unavailable',
          body: 'This currency pair could not be validated right now. Choose a different combination to continue.',
        },
      };
    }

    setPairResult(result);
  }, [sourceCurrency, beneficiaryCurrency]);

  const handleAccountChange = useCallback((event) => {
    setAccountId(event.target.value);
    setBeneficiaryCurrency(NONE_VALUE);
    setPairResult(null);
  }, []);

  const handleBeneficiaryChange = useCallback((event) => {
    setBeneficiaryCurrency(event.target.value);
  }, []);

  const canContinue = useMemo(
    () =>
      accountId.length > 0 &&
      beneficiaryCurrency.length > 0 &&
      isPlainObject(pairResult) &&
      pairResult.eligible === true,
    [accountId, beneficiaryCurrency, pairResult],
  );

  const handleContinue = useCallback(() => {
    if (!canContinue || typeof onContinue !== 'function') {
      return;
    }
    onContinue({
      accountId,
      sourceCurrency,
      beneficiaryCurrency,
      pairId: isPlainObject(pairResult) ? pairResult.pairId : null,
    });
  }, [canContinue, onContinue, accountId, sourceCurrency, beneficiaryCurrency, pairResult]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-primary-blue-700">
          Select account and currencies
        </h1>
        <p className="text-sm text-body">
          Choose the source account to pay from and the beneficiary currency. Account numbers and
          balances are simulated and masked for the demo.
        </p>
      </div>

      {!authorized ? (
        <Alert severity={ALERT_SEVERITIES.CRITICAL} title="Access denied">
          Your current role does not hold the capability required to initiate payments. Switch to a
          role that grants it and try again.
        </Alert>
      ) : loading ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-primary-blue-100 bg-white px-4 py-6 text-center text-sm text-body"
        >
          Loading accounts…
        </div>
      ) : accounts.length === 0 ? (
        <Alert severity={ALERT_SEVERITIES.WARNING} title="No eligible accounts">
          There are no source accounts available for your entitlements. You cannot initiate a
          payment until an eligible account is in scope.
        </Alert>
      ) : (
        <>
          <section
            aria-labelledby="account-selection-heading"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-white p-6"
          >
            <div className="flex flex-col gap-1">
              <h2 id="account-selection-heading" className="text-lg font-medium text-body">
                Source account
              </h2>
              <p className="text-sm text-body">
                Select the account to fund this international payment.
              </p>
            </div>

            <FormField label="Account" required>
              {(attrs) => (
                <select
                  className={SELECT_CLASSES}
                  value={accountId}
                  onChange={handleAccountChange}
                  {...attrs}
                >
                  <option value={NONE_VALUE}>Select an account</option>
                  {accounts.map((account) => {
                    const id = toText(account.accountId);
                    const name = toText(account.accountName) || id;
                    const masked = toText(account.accountNumberMasked);
                    const currency = toText(account.currency);
                    const label = [name, masked, currency]
                      .filter((part) => part.length > 0)
                      .join(' · ');
                    return (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              )}
            </FormField>

            {isPlainObject(selectedAccount) ? (
              <dl className="flex flex-col">
                <div className="flex flex-col gap-1 border-b border-primary-blue-100 py-3 sm:flex-row sm:items-baseline sm:gap-4">
                  <dt className="w-full text-sm font-medium text-primary-blue-700 sm:w-48">
                    Account number
                  </dt>
                  <dd className="text-sm text-body">
                    {toText(selectedAccount.accountNumberMasked) || '—'}
                  </dd>
                </div>
                <div className="flex flex-col gap-1 border-b border-primary-blue-100 py-3 sm:flex-row sm:items-baseline sm:gap-4">
                  <dt className="w-full text-sm font-medium text-primary-blue-700 sm:w-48">
                    Currency
                  </dt>
                  <dd className="text-sm text-body">{sourceCurrency || '—'}</dd>
                </div>
                <div className="flex flex-col gap-1 border-b border-primary-blue-100 py-3 sm:flex-row sm:items-baseline sm:gap-4">
                  <dt className="w-full text-sm font-medium text-primary-blue-700 sm:w-48">
                    Available balance
                  </dt>
                  <dd className="text-sm text-body">
                    {formatBalance(selectedAccount.availableBalance, sourceCurrency)}
                  </dd>
                </div>
                <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:gap-4">
                  <dt className="w-full text-sm font-medium text-primary-blue-700 sm:w-48">
                    Supported beneficiary currencies
                  </dt>
                  <dd className="flex flex-wrap gap-2 text-sm text-body">
                    {toStringArray(selectedAccount.supportedBeneficiaryCurrencies).length > 0
                      ? toStringArray(selectedAccount.supportedBeneficiaryCurrencies).map(
                          (currency) => (
                            <StatusBadge key={currency} tone={STATUS_TONES.NEUTRAL}>
                              {currency}
                            </StatusBadge>
                          ),
                        )
                      : '—'}
                  </dd>
                </div>
              </dl>
            ) : null}
          </section>

          <section
            aria-labelledby="currency-selection-heading"
            className="flex flex-col gap-4 rounded-md border border-primary-blue-100 bg-primary-blue-50 p-6"
          >
            <div className="flex flex-col gap-1">
              <h2 id="currency-selection-heading" className="text-lg font-medium text-body">
                Beneficiary currency
              </h2>
              <p className="text-sm text-body">
                Choose the currency the beneficiary will receive. Only currencies supported by the
                selected account are shown.
              </p>
            </div>

            <FormField label="Beneficiary currency" required>
              {(attrs) => (
                <select
                  className={SELECT_CLASSES}
                  value={beneficiaryCurrency}
                  disabled={!isPlainObject(selectedAccount)}
                  onChange={handleBeneficiaryChange}
                  {...attrs}
                >
                  <option value={NONE_VALUE}>Select a currency</option>
                  {beneficiaryOptions.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              )}
            </FormField>

            {isPlainObject(selectedAccount) && beneficiaryOptions.length === 0 ? (
              <Alert severity={ALERT_SEVERITIES.WARNING} title="No cross-currency options">
                This account does not support any beneficiary currency different from its own.
                Choose a different account to initiate an international payment.
              </Alert>
            ) : null}

            {isPlainObject(pairResult) && isPlainObject(pairResult.customerCopy) ? (
              <Alert
                severity={pairSeverity(pairResult.eligible === true)}
                title={toText(pairResult.customerCopy.title) || 'Currency pair'}
              >
                {toText(pairResult.customerCopy.body)}
              </Alert>
            ) : null}
          </section>

          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="primary"
              size="md"
              disabled={!canContinue}
              onClick={handleContinue}
            >
              Continue to quote
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

AccountSelectionPage.propTypes = {
  onContinue: PropTypes.func,
};

export default AccountSelectionPage;