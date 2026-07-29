/**
 * Payment initiation wizard flow.
 *
 * PaymentFlow is the stateful layout for the payment initiation wizard
 * (/payments/new through /payments/confirmation/:id). Each step page
 * (AccountSelectionPage, QuotePage, PaymentForm, BeneficiaryValidationPage,
 * ReviewSubmitPage, ConfirmationPage) is a pure, prop-driven component that
 * reads its inputs from props and surfaces its result via an
 * onContinue/onValidated/onSubmitted callback prop — it never reads or writes
 * cross-step state itself. Because react-router-dom unmounts and remounts the
 * matched route element on every navigation, the accumulated draft (selected
 * account/currencies, accepted quote snapshot, captured CBPR+ details,
 * beneficiary disposition) has to live in this layout, one level above the
 * `<Outlet/>`, rather than in any single step.
 *
 * Each step wrapper below reads its slice of the draft and the shared
 * `advance(path, patch)` helper via `useOutletContext()`, and wires it into
 * the corresponding page's input props and continuation callback.
 */

import { useCallback, useState } from 'react';
import { Outlet, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { AccountSelectionPage } from '@/features/payment/pages/AccountSelectionPage';
import { QuotePage } from '@/features/payment/pages/QuotePage';
import { PaymentForm } from '@/features/payment/pages/PaymentForm';
import { BeneficiaryValidationPage } from '@/features/payment/pages/BeneficiaryValidationPage';
import { ReviewSubmitPage } from '@/features/payment/pages/ReviewSubmitPage';
import { ConfirmationPage } from '@/features/payment/pages/ConfirmationPage';

/**
 * Renders the wizard layout: owns the cross-step draft and exposes it, plus
 * an `advance` helper that merges a step's result into the draft and
 * navigates to the next step, to nested step routes via outlet context.
 * @returns {React.ReactElement} The wizard layout element.
 */
export function PaymentFlow() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState({});

  const advance = useCallback(
    (path, patch) => {
      setDraft((previous) => ({ ...previous, ...(patch ?? {}) }));
      navigate(path);
    },
    [navigate],
  );

  return <Outlet context={{ draft, advance }} />;
}

/** Wires {@link AccountSelectionPage} into the wizard. */
export function NewPaymentStep() {
  const { advance } = useOutletContext();
  return (
    <AccountSelectionPage
      onContinue={(selection) => advance('/payments/quote', selection)}
    />
  );
}

/** Wires {@link QuotePage} into the wizard. */
export function QuoteStep() {
  const { draft, advance } = useOutletContext();
  return (
    <QuotePage
      pairId={draft.pairId}
      accountId={draft.accountId}
      sourceCurrency={draft.sourceCurrency}
      beneficiaryCurrency={draft.beneficiaryCurrency}
      onContinue={({ snapshot, accountId, pairId }) =>
        advance('/payments/details', { snapshot, accountId, pairId })
      }
    />
  );
}

/** Wires {@link PaymentForm} into the wizard. */
export function DetailsStep() {
  const { draft, advance } = useOutletContext();
  return (
    <PaymentForm
      currency={draft.beneficiaryCurrency}
      onContinue={({ values, ruleSetId }) =>
        advance('/payments/validate', {
          cbprDetails: values,
          cbprSelector: ruleSetId ? { ruleSetId } : {},
        })
      }
    />
  );
}

/** Wires {@link BeneficiaryValidationPage} into the wizard. */
export function ValidateStep() {
  const { advance } = useOutletContext();
  return (
    <BeneficiaryValidationPage
      onValidated={(result) =>
        advance('/payments/review', {
          validation: result.validationRecord,
          disposition: result.dispositionRecord,
          overrideReason: result.overrideReason,
          scenarioRef: result.scenarioRef,
        })
      }
    />
  );
}

/** Wires {@link ReviewSubmitPage} into the wizard. */
export function ReviewStep() {
  const { draft, advance } = useOutletContext();
  return (
    <ReviewSubmitPage
      snapshot={draft.snapshot}
      accountId={draft.accountId}
      pairId={draft.pairId}
      sourceCurrency={draft.sourceCurrency}
      beneficiaryCurrency={draft.beneficiaryCurrency}
      cbprSelector={draft.cbprSelector}
      cbprDetails={draft.cbprDetails}
      validation={draft.validation}
      disposition={draft.disposition}
      overrideReason={draft.overrideReason}
      scenarioRef={draft.scenarioRef}
      onSubmitted={({ paymentId, duplicate }) => {
        if (!duplicate && paymentId) {
          advance(`/payments/confirmation/${paymentId}`, { paymentId });
        }
      }}
    />
  );
}

/** Wires {@link ConfirmationPage} into the wizard, reading the id from the route. */
export function ConfirmationStep() {
  const { id } = useParams();
  return <ConfirmationPage paymentId={id} />;
}

export default PaymentFlow;
