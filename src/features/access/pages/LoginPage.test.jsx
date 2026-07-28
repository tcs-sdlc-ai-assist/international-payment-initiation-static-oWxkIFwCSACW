/**
 * Component tests for the mock login page.
 *
 * These tests exercise the login-only surface (SCRUM-822): the visible,
 * non-production credential hints drawn from the bundled users fixture, the
 * accessible generic invalid-credential error, the busy/loading state that
 * disables submission while authentication is simulated, and the successful
 * mock-login redirect to the acting session's default route.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { LoginPage } from '@/features/access/pages/LoginPage';
import { SessionProvider } from '@/app/useAccessContext';
import { NotificationProvider } from '@/app/NotificationContext';
import { sessionFacade } from '@/features/access/services/sessionFacade';
import { authService } from '@/features/access/services/authService';

/**
 * Renders the login page inside the providers and router it depends on.
 * @param {{ initialEntries?: string[] }} [options] - Optional router options.
 * @returns {ReturnType<typeof render>} The rendered result.
 */
function renderLoginPage(options) {
  const source = options ?? {};
  const initialEntries = Array.isArray(source.initialEntries)
    ? source.initialEntries
    : ['/login'];

  return render(
    <NotificationProvider>
      <SessionProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/payments/new" element={<div>New payment page</div>} />
            <Route path="/payments/approvals" element={<div>Approvals page</div>} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </NotificationProvider>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    try {
      sessionFacade.logout();
    } catch {
      // Ignore logout faults in the test harness.
    }
  });

  it('renders the demo credential hints from the users fixture', () => {
    renderLoginPage();

    expect(
      screen.getByRole('heading', { name: /demo sign-in credentials/i }),
    ).toBeInTheDocument();

    const hintButtons = screen.getAllByRole('button', { name: /use these credentials/i });
    expect(hintButtons.length).toBeGreaterThan(0);

    expect(screen.getByText('i.demo')).toBeInTheDocument();
    expect(screen.getByText('demo-initiator-2026')).toBeInTheDocument();
  });

  it('populates the form when a credential hint is applied', async () => {
    const user = userEvent.setup();
    renderLoginPage();

    const applyButtons = screen.getAllByRole('button', { name: /use these credentials/i });
    await user.click(applyButtons[0]);

    const username = screen.getByLabelText(/username/i);
    const passcode = screen.getByLabelText(/passcode/i);

    expect(username).toHaveValue('i.demo');
    expect(passcode).toHaveValue('demo-initiator-2026');
  });

  it('surfaces a single accessible generic error for invalid credentials', async () => {
    const user = userEvent.setup();
    vi.spyOn(authService, 'login').mockResolvedValue({
      ok: false,
      safeReasonCode: authService.AUTH_REASON_CODES.INVALID_CREDENTIALS,
    });

    renderLoginPage();

    await user.type(screen.getByLabelText(/username/i), 'unknown.user');
    await user.type(screen.getByLabelText(/passcode/i), 'wrong-passcode');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/did not match a known demo account/i);
    expect(alert).not.toHaveTextContent('unknown.user');
    expect(alert).not.toHaveTextContent('wrong-passcode');
  });

  it('shows a loading state while authentication is in flight', async () => {
    const user = userEvent.setup();
    let resolveLogin;
    vi.spyOn(authService, 'login').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLogin = resolve;
        }),
    );

    renderLoginPage();

    await user.type(screen.getByLabelText(/username/i), 'i.demo');
    await user.type(screen.getByLabelText(/passcode/i), 'demo-initiator-2026');

    const submitButton = screen.getByRole('button', { name: /^sign in$/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/signing in…/i)).toBeInTheDocument();
    });
    expect(submitButton).toBeDisabled();

    resolveLogin({
      ok: false,
      safeReasonCode: authService.AUTH_REASON_CODES.INVALID_CREDENTIALS,
    });

    await waitFor(() => {
      expect(submitButton).not.toBeDisabled();
    });
  });

  it('routes to the default route after a successful mock login', async () => {
    const user = userEvent.setup();
    const issuedAt = '2026-07-28T09:00:00.000Z';
    const expiresAt = '2026-07-28T09:15:00.000Z';

    vi.spyOn(authService, 'login').mockResolvedValue({
      ok: true,
      claim: {
        version: 'v1',
        sessionId: 'demo-session-01',
        subjectId: 'demo-user-initiator-01',
        roles: ['initiator'],
        capabilities: ['payment:initiate'],
        issuedAt,
        expiresAt,
      },
      profile: {
        maskingPolicyId: 'list',
        defaultRoute: '/payments/new',
        organizationId: 'demo-org-01',
        accountScopes: ['demo-acct-eur-01'],
      },
      safeReasonCode: authService.AUTH_REASON_CODES.SUCCESS,
    });

    renderLoginPage();

    await user.type(screen.getByLabelText(/username/i), 'i.demo');
    await user.type(screen.getByLabelText(/passcode/i), 'demo-initiator-2026');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByText(/new payment page/i)).toBeInTheDocument();
  });
});