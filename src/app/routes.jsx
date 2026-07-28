/**
 * Central route configuration with capability metadata.
 *
 * routes.jsx is the single source of truth for the app's route table
 * (SCRUM-823). It maps each path to its routed element together with the
 * capability required to reach it, so route guarding and navigation visibility
 * derive from one deny-by-default policy. Protected routes are wrapped in the
 * {@link RouteGuard} (capability enforcement) beneath the {@link AppShell}
 * (authenticated layout); the login route is public and rendered outside the
 * shell.
 *
 * The configuration is exported both as a declarative descriptor list (for
 * cross-referencing with navigation) and as a ready-to-render React Router
 * route element tree. It renders sanitized copy only, carries no PII, and never
 * mutates application state.
 */

import { Navigate, Route, Routes } from 'react-router-dom';
import { CAPABILITIES } from '@/shared/config/constants';
import { RouteGuard } from '@/app/RouteGuard';
import { AppShell } from '@/app/AppShell';
import { LoginPage } from '@/features/access/pages/LoginPage';
import { UnauthorizedPage } from '@/features/access/pages/UnauthorizedPage';
import { SignerListPage } from '@/features/access/pages/SignerListPage';
import { SignerDetailPage } from '@/features/access/pages/SignerDetailPage';
import { SignerEditPage } from '@/features/access/pages/SignerEditPage';
import { AuditHistoryPage } from '@/features/access/pages/AuditHistoryPage';
import { ClearDataPage } from '@/features/access/pages/ClearDataPage';
import { AccountSelectionPage } from '@/features/payment/pages/AccountSelectionPage';
import { QuotePage } from '@/features/payment/pages/QuotePage';
import { PaymentForm } from '@/features/payment/pages/PaymentForm';
import { BeneficiaryValidationPage } from '@/features/payment/pages/BeneficiaryValidationPage';
import { ReviewSubmitPage } from '@/features/payment/pages/ReviewSubmitPage';
import { ConfirmationPage } from '@/features/payment/pages/ConfirmationPage';
import { ApprovalQueuePage } from '@/features/payment/pages/ApprovalQueuePage';
import { OperationsPage } from '@/features/payment/pages/OperationsPage';

/** Login route rendered outside the authenticated shell. */
export const LOGIN_ROUTE = '/login';

/**
 * Declarative descriptors for every protected route, pairing each path with the
 * capability required to reach it. Shared with navigation so guarding and menu
 * visibility derive from one source.
 * @type {ReadonlyArray<{
 *   path: string,
 *   capability: string | null,
 *   exact: boolean,
 *   label: string,
 * }>}
 */
export const PROTECTED_ROUTES = Object.freeze([
  {
    path: '/payments/new',
    capability: CAPABILITIES.PAYMENT_INITIATE,
    exact: true,
    label: 'New payment',
  },
  {
    path: '/payments/quote',
    capability: CAPABILITIES.PAYMENT_INITIATE,
    exact: true,
    label: 'FX quote',
  },
  {
    path: '/payments/details',
    capability: CAPABILITIES.PAYMENT_INITIATE,
    exact: true,
    label: 'Payment details',
  },
  {
    path: '/payments/validate',
    capability: CAPABILITIES.PAYMENT_INITIATE,
    exact: true,
    label: 'Validate beneficiary',
  },
  {
    path: '/payments/review',
    capability: CAPABILITIES.PAYMENT_INITIATE,
    exact: true,
    label: 'Review and submit',
  },
  {
    path: '/payments/confirmation/:id',
    capability: CAPABILITIES.PAYMENT_INITIATE,
    exact: true,
    label: 'Payment confirmation',
  },
  {
    path: '/approvals',
    capability: CAPABILITIES.PAYMENT_APPROVE,
    exact: true,
    label: 'Approvals',
  },
  {
    path: '/operations',
    capability: CAPABILITIES.PAYMENT_OPERATE,
    exact: true,
    label: 'Operations',
  },
  {
    path: '/signers',
    capability: CAPABILITIES.SIGNER_READ,
    exact: true,
    label: 'Signers',
  },
  {
    path: '/signers/:id',
    capability: CAPABILITIES.SIGNER_READ,
    exact: true,
    label: 'Signer detail',
  },
  {
    path: '/signers/:id/edit',
    capability: CAPABILITIES.SIGNER_MANAGE,
    exact: true,
    label: 'Edit signer',
  },
  {
    path: '/audit',
    capability: CAPABILITIES.SIGNER_READ,
    exact: true,
    label: 'Audit history',
  },
  {
    path: '/clear-data',
    capability: null,
    exact: true,
    label: 'Clear demo data',
  },
]);

/**
 * Renders the application route element tree.
 *
 * The login route is public and rendered outside the authenticated shell. Every
 * other route is nested beneath the {@link AppShell} and guarded per-route by a
 * {@link RouteGuard} carrying the capability required to reach it. Unknown paths
 * fall back to the login route.
 *
 * @returns {React.ReactElement} The routes element.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path={LOGIN_ROUTE} element={<LoginPage />} />
      <Route path="/unauthorized" element={<UnauthorizedPage />} />

      <Route element={<AppShell />}>
        <Route
          path="/payments/new"
          element={
            <RouteGuard capability={CAPABILITIES.PAYMENT_INITIATE}>
              <AccountSelectionPage />
            </RouteGuard>
          }
        />
        <Route
          path="/payments/quote"
          element={
            <RouteGuard capability={CAPABILITIES.PAYMENT_INITIATE}>
              <QuotePage />
            </RouteGuard>
          }
        />
        <Route
          path="/payments/details"
          element={
            <RouteGuard capability={CAPABILITIES.PAYMENT_INITIATE}>
              <PaymentForm />
            </RouteGuard>
          }
        />
        <Route
          path="/payments/validate"
          element={
            <RouteGuard capability={CAPABILITIES.PAYMENT_INITIATE}>
              <BeneficiaryValidationPage />
            </RouteGuard>
          }
        />
        <Route
          path="/payments/review"
          element={
            <RouteGuard capability={CAPABILITIES.PAYMENT_INITIATE}>
              <ReviewSubmitPage />
            </RouteGuard>
          }
        />
        <Route
          path="/payments/confirmation/:id"
          element={
            <RouteGuard capability={CAPABILITIES.PAYMENT_INITIATE}>
              <ConfirmationPage />
            </RouteGuard>
          }
        />

        <Route
          path="/approvals"
          element={
            <RouteGuard capability={CAPABILITIES.PAYMENT_APPROVE}>
              <ApprovalQueuePage />
            </RouteGuard>
          }
        />
        <Route
          path="/operations"
          element={
            <RouteGuard capability={CAPABILITIES.PAYMENT_OPERATE}>
              <OperationsPage />
            </RouteGuard>
          }
        />

        <Route
          path="/signers"
          element={
            <RouteGuard capability={CAPABILITIES.SIGNER_READ}>
              <SignerListPage />
            </RouteGuard>
          }
        />
        <Route
          path="/signers/:signerId"
          element={
            <RouteGuard capability={CAPABILITIES.SIGNER_READ}>
              <SignerDetailPage />
            </RouteGuard>
          }
        />
        <Route
          path="/signers/:signerId/edit"
          element={
            <RouteGuard capability={CAPABILITIES.SIGNER_MANAGE}>
              <SignerEditPage />
            </RouteGuard>
          }
        />

        <Route
          path="/audit"
          element={
            <RouteGuard capability={CAPABILITIES.SIGNER_READ}>
              <AuditHistoryPage />
            </RouteGuard>
          }
        />

        <Route
          path="/clear-data"
          element={
            <RouteGuard>
              <ClearDataPage />
            </RouteGuard>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to={LOGIN_ROUTE} replace />} />
    </Routes>
  );
}

export default AppRoutes;