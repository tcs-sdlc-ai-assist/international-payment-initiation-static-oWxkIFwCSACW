# International Payment Initiation

**Type**: business_banking_web / corporate_payments_web — static frontend demonstration
**Audience**: Business and corporate banking clients acting as payment initiators or approvers; operations users reviewing simulated outcomes; and controlling parties using the signer-management experience.

## Business Context
Business and corporate customers need a transparent digital journey for initiating international payments, understanding simulated FX rates, fees, debit and credit amounts, capturing representative CBPR+ data, and viewing simulated validation, accounting, approval, repair, and SWIFT outcomes. The MVP also demonstrates self-service authorized-signer maintenance following Digital KYC offramp activity. All financial, identity, screening, accounting, messaging, KYC, and eSign behavior is represented by predefined frontend responses; no transaction or external service action is executed. [Pipeline-aligned]

## Functional Requirements

### FR-001 — Source Account and Currency Selection [Pipeline-aligned]
Display eligible fixture-backed source accounts for the active mock user, including account name, masked account number, currency, simulated available balance, and supported beneficiary currencies. Prevent unsupported or restricted currency pairs. [Pipeline-aligned]
**Priority**: must_have | **Complexity**: medium | **Source**: original_prd
**Acceptance Criteria**:
  - Only source accounts permitted by the active user's local fixture entitlements are displayed.
  - Each account displays its name, masked account number, currency, and simulated available balance.
  - The user can select the source account currency and a beneficiary currency from supported pairs.
  - Unsupported or restricted currency-pair selections are blocked with a clear message.

### FR-002 — Simulated FX Quote and Sample Amount Display [Pipeline-aligned]
Provide predefined FX quotes from local JSON fixtures representing Refinitiv or HSBC internal FX services, defaulting to a sample amount of 1,000 in source currency unless beneficiary-amount mode is selected. [Pipeline-aligned]
**Priority**: must_have | **Complexity**: high | **Source**: original_prd
**Acceptance Criteria**:
  - The initial quote uses 1,000 in source currency unless beneficiary-currency amount mode is selected.
  - The UI displays source currency, beneficiary currency, source amount, beneficiary amount, exchange rate, timestamp, expiry, and indicative or executable-style fixture classification.
  - An expired quote is replaced using the next predefined scenario before continuation.
  - The UI states that displayed rates are simulated and are not real or executable financial quotes. [Pipeline-aligned]

### FR-003 — Dynamic Amount Amendment and Recalculation [Pipeline-aligned]
Allow either source or beneficiary amount to be edited and immediately recalculate the counterpart amount, mock exchange rate, charges, and total debit according to local currency-pair tiers. [Pipeline-aligned]
**Priority**: must_have | **Complexity**: high | **Source**: original_prd
**Acceptance Criteria**:
  - Editing the source amount recalculates the beneficiary amount, charges, and total debit.
  - Editing the beneficiary amount recalculates the source amount, charges, and total debit.
  - Local tiers can vary by amount band, customer segment, product, or channel fixture configuration.
  - Rate or charge changes are visibly identified immediately after recalculation.

### FR-004 — Fees, Charges, and Tier Handling [Pipeline-aligned]
Calculate demonstration fees from local fixture tiers and support applicable OUR, SHA, and BEN charge options with transparent estimated totals. [Pipeline-aligned]
**Priority**: must_have | **Complexity**: high | **Source**: original_prd
**Acceptance Criteria**:
  - The UI displays fee currency, fee amount, total debit amount, and estimated beneficiary receipt.
  - Fees and charges are shown in source currency for OUR and SHA and in destination currency for BEN; total debit is shown only in source currency.
  - Fees recalculate when the amount, pair, charge option, or source account changes.
  - A customer-friendly charge explanation is shown before continuation.
  - Fees and receiving amounts are clearly labeled as demonstration estimates. [Pipeline-aligned]

### FR-005 — Mock Quote Acceptance and Payment Continuation [Pipeline-aligned]
Permit continuation only with a valid, non-expired mock quote; capture acceptance details locally and require refresh and re-acceptance after expiry. [Pipeline-aligned]
**Priority**: must_have | **Complexity**: medium | **Source**: original_prd
**Acceptance Criteria**:
  - Continuation is disabled until a valid, non-expired quote is available.
  - Acceptance stores the timestamp, quote reference, amounts, exchange rate, and charges in local state.
  - Fixture expiry rules simulate quote locking without reserving a market rate. [Pipeline-aligned]
  - A quote expiring before submission must be refreshed and accepted again.
  - Successful acceptance navigates to CBPR+ transaction-detail capture.

### FR-006 — Representative CBPR+ Transaction Detail Capture
Capture and locally validate representative CBPR+ debtor, creditor, agent, amount, settlement, purpose, remittance, address, and regulatory data.
**Priority**: must_have | **Complexity**: high | **Source**: original_prd
**Acceptance Criteria**:
  - Mandatory debtor, creditor, debtor-agent, creditor-agent, instructed-amount, settlement, purpose, remittance, and regulatory fields are available.
  - Structured and unstructured addresses are supported according to representative scheme and jurisdiction rules.
  - Mandatory values, lengths, permitted characters, and ISO code formats are validated before submission.
  - A mock UETR is generated where required.
  - Missing or invalid data produces clear inline errors and blocks submission.

### FR-007 — Simulated Beneficiary Validation [Pipeline-aligned]
Validate BIC and IBAN syntax locally, then display predefined BIC, IBAN, and name-on-account outcomes representing Bankcheck responses. [Pipeline-aligned]
**Priority**: must_have | **Complexity**: high | **Source**: original_prd
**Acceptance Criteria**:
  - BIC and IBAN formats are validated locally before a service-style result is displayed.
  - Results support successful, partial-match, failed, and unavailable states.
  - Continuation is allowed only when the selected scenario meets configured mock policy thresholds or permits an override.
  - Response codes, outcomes, and permitted override decisions are stored in local audit history.
  - The UI clearly states that no real beneficiary account was verified. [Pipeline-aligned]

### FR-008 — Simulated CBCC Submission and Outcome [Pipeline-aligned]
Display a mock pain.001 preview and simulate submission to the HSBC CBCC engine through predefined funds, fraud, AML/FTR, sanctions, and processing outcomes. [Pipeline-aligned]
**Priority**: must_have | **Complexity**: medium | **Source**: original_prd
**Acceptance Criteria**:
  - The pain.001 preview includes the accepted quote, payment details, beneficiary details, and validation evidence.
  - Predefined funds, fraud, AML/FTR, and sanctions outcomes are displayed.
  - The result is accepted, rejected, pending review, or repair required and includes sanitized reason codes.
  - Customer-facing status and next steps do not expose sensitive screening logic.
  - The UI states that no instruction was submitted to HSBC and no financial check occurred. [Pipeline-aligned]

### FR-009 — Simulated Account, Nostro, and Ledger Determination [Pipeline-aligned]
Present fixture-backed customer debit account, nostro, correspondent, intermediary, SSI, and mock ledger determinations with fake posting references. [Pipeline-aligned]
**Priority**: must_have | **Complexity**: medium | **Source**: original_prd
**Acceptance Criteria**:
  - The selected simulated customer debit account is shown.
  - Predefined nostro, creditor-agent, intermediary-bank, and SSI details are shown where applicable.
  - Mock ledger accounts cover fees, FX, settlement, and customer postings.
  - Determinations and fake posting references are recorded in local audit history.
  - The UI states that no real account, SSI, routing, or ledger determination occurred. [Pipeline-aligned]

### FR-010 — Simulated Debit, Posting, and Ledger Updates [Pipeline-aligned]
For scenarios with satisfactory checks, display representative debit, FX, fee, nostro, settlement, and ledger outcomes without changing any real balance or accounting system. [Pipeline-aligned]
**Priority**: must_have | **Complexity**: medium | **Source**: original_prd
**Acceptance Criteria**:
  - Satisfactory scenarios produce simulated debit and posting outcomes.
  - Representative FX, fee, nostro, settlement, and internal-ledger entries are displayed.
  - Local instruction references prevent duplicate demonstration submissions.
  - Fake posting and confirmation references are generated.
  - The UI does not claim real balance modification, accounting entries, or server-side atomicity, idempotency, or reversibility. [Pipeline-aligned]

### FR-011 — Mock SWIFT pacs.008 Preview and Status [Pipeline-aligned]
After successful simulated validation and posting, display a browser-only pacs.008 preview and predefined SWIFT acknowledgement, rejection, or repair progression. [Pipeline-aligned]
**Priority**: must_have | **Complexity**: medium | **Source**: original_prd
**Acceptance Criteria**:
  - A pacs.008 preview appears only after the configured successful simulated outcome.
  - The preview includes representative debtor, creditor, agents, amounts, remittance, purpose, regulatory, and settlement details.
  - Local demonstration rules provide a schema-validation state.
  - Predefined responses simulate transmission progression, acknowledgement, rejection, and repair outcomes.
  - The UI states that no SWIFT message was generated outside the browser or transmitted. [Pipeline-aligned]

### FR-012 — Optional Mock SWIFT pacs.009 Preview [Pipeline-aligned]
Use local route and cover-payment fixtures to determine whether to display a linked pacs.009 preview alongside the pacs.008 preview. [Pipeline-aligned]
**Priority**: must_have | **Complexity**: medium | **Source**: original_prd
**Acceptance Criteria**:
  - Local correspondent, cover-payment, settlement-route, and currency fixtures determine pacs.009 applicability.
  - When applicable, a pacs.009 preview includes representative settlement, agent, intermediary, and nostro details.
  - Local ISO 20022 and CBPR+ demonstration rules are applied.
  - The pacs.009 is linked to its pacs.008 and payment instruction reference.
  - The UI states that no pacs.009 was transmitted. [Pipeline-aligned]

### FR-013 — Simulated Confirmation, Status, and Tracking [Pipeline-aligned]
Display a confirmation and locally tracked status lifecycle using fake payment, SWIFT, and UETR references. [Pipeline-aligned]
**Priority**: must_have | **Complexity**: medium | **Source**: original_prd
**Acceptance Criteria**:
  - Confirmation shows a reference, status, masked debit account, beneficiary, amount, FX rate, charges, and expected processing state.
  - Supported statuses include accepted, processing, pending approval, pending review, rejected, sent to SWIFT, acknowledged, and repair required.
  - A fake SWIFT tracking reference or UETR is shown where available.
  - Representative next steps and timelines are displayed.
  - Status transitions are recorded locally and labeled as simulated. [Pipeline-aligned]

### FR-014 — Error Handling and User Feedback [Pipeline-aligned]
Provide consistent, accessible feedback and retry behavior for predefined failures while sanitizing local audit and console output. [Pipeline-aligned]
**Priority**: must_have | **Complexity**: medium | **Source**: original_prd
**Acceptance Criteria**:
  - Contextual messages cover simulated network errors, validation failures, quote expiry, invitation expiry, and session timeout.
  - Error, warning, success, and informational alerts use consistent styling and do not rely on color alone.
  - Transient simulated failures provide a retry action.
  - Sanitized errors are recorded in local audit history.
  - Unmasked PII is never written to the browser console.

### FR-015 — Mock Login and Role Experience [Clarified] [Pipeline-aligned]
Provide a login-only experience for pre-provisioned initiator, approver, and operations fixture accounts, with role-specific UI, local sessions, logout, and simulated timeout. [Clarified] [Pipeline-aligned]
**Priority**: must_have | **Complexity**: medium | **Source**: user_clarification
**Acceptance Criteria**:
  - Only a login page is provided; signup and self-service provisioning are absent. [Clarified]
  - Visible non-production credential hints appear below the login form. [Clarified]
  - Credentials are validated against fake local fixtures and the active session is stored in sessionStorage. [Clarified] [Pipeline-aligned]
  - Initiator, approver, and operations accounts route to role-appropriate navigation and screens. [Clarified]
  - Logout and a reference-date-relative simulated inactivity timeout are available. [Clarified] [Pipeline-aligned]
  - The UI states that no real authentication, SSO, OIDC, SAML, MFA, recovery, or identity verification is performed. [Clarified] [Pipeline-aligned]

### FR-016 — Representative Payment Approval Experience [Clarified] [Pipeline-aligned]
Provide approvers with a fixture-backed queue and locally recorded approval or rejection actions; no payment authorization or release occurs. [Clarified] [Pipeline-aligned]
**Priority**: must_have | **Complexity**: medium | **Source**: user_clarification
**Acceptance Criteria**:
  - The approver sees a fixture-backed queue of payments awaiting approval. [Clarified]
  - Payment, initiator, beneficiary, amount, quote, and validation information is masked as required. [Clarified]
  - The approver can record approval or rejection with an optional comment. [Clarified]
  - Where configured, segregation-of-duties rules prevent the fixture initiator from approving the same payment. [Clarified]
  - The decision and resulting status are stored locally. [Clarified] [Pipeline-aligned]
  - The UI states that no real authorization or release occurs. [Clarified] [Pipeline-aligned]

### FR-017 — Representative Operations Status Experience [Clarified] [Pipeline-aligned]
Provide operations users with searchable fixture-backed processing, repair, accounting, and SWIFT outcomes while withholding restricted screening logic. [Clarified] [Pipeline-aligned]
**Priority**: must_have | **Complexity**: medium | **Source**: user_clarification
**Acceptance Criteria**:
  - The operations list includes accepted, pending-review, rejected, and repair-required fixture records. [Clarified]
  - Records can be filtered by status, date, currency, reference, and scenario. [Clarified]
  - The detail view displays checkpoints, sanitized reason codes, mock accounting references, and SWIFT statuses. [Clarified] [Pipeline-aligned]
  - Restricted screening rules, watchlist data, and internal decision logic are not displayed. [Clarified]
  - Operations behavior is read-only except for permitted local scenario transitions or reset. [Clarified] [Pipeline-aligned]
  - The UI states that no real repair, investigation, or case action occurs. [Clarified] [Pipeline-aligned]

### FR-018 — Authorized Signer Management [Clarified] [Pipeline-aligned]
Provide an explicit MVP signer-management experience using fixtures and local state for listing, filtering, editing, simulated eSign, unlock, invitation resend, and audit history. [Clarified] [Pipeline-aligned]
**Priority**: must_have | **Complexity**: high | **Source**: user_clarification
**Acceptance Criteria**:
  - A consolidated fixture-backed signer list supports account, status, invitation-status, and signing-authority filters. [Clarified]
  - An existing signer's permitted details can be edited in a pre-populated form. [Clarified]
  - A before-and-after summary is shown and the signer enters a locally simulated pending-confirmation state. [Clarified] [Pipeline-aligned]
  - The simulated eSign flow supports predefined success, declined, and expired outcomes. [Clarified] [Pipeline-aligned]
  - Eligible locked signers can be locally unlocked and expired invitations can be locally resent. [Clarified] [Pipeline-aligned]
  - The UI demonstrates at most three resend attempts in 24 hours relative to 2026-07-28 and states that this is not server-enforced. [Clarified] [Pipeline-aligned]
  - Signer edits, unlocks, resends, and eSign outcomes are stored in local audit history. [Clarified] [Pipeline-aligned]
  - The UI states that no real authority, customer record, invitation, or agreement is changed. [Clarified] [Pipeline-aligned]

## Non-Functional Requirements

### NFR-001 — security
Demonstrate role-based frontend visibility for payment initiation, approval, operations, and signer-management experiences. [Clarified] [Pipeline-aligned]
**Target**: Role-inappropriate navigation and screens are absent for each pre-provisioned demo account.

### NFR-002 — security
Use mock authentication only; users are pre-provisioned and credentials are visibly identified as non-production. [Clarified] [Pipeline-aligned]
**Target**: 100% of credential displays are labeled as demo/non-production.

### NFR-003 — privacy
Mask PII, account data, and screening outcomes in screens, console output, and local audit history.
**Target**: No unmasked listed PII appears in list, confirmation, audit, operations, or console output.

### NFR-004 — security
Demonstrate duplicate-submission and quote-acceptance safeguards through local instruction references. [Pipeline-aligned]
**Target**: A repeated active local instruction reference is blocked.

### NFR-005 — security
Do not claim real encryption at rest, strong customer authentication, CSRF protection, or server-enforced access control; browser and hosting transport behavior is outside application enforcement. [Pipeline-aligned]
**Target**: No product copy represents these controls as implemented.

### NFR-006 — security
Treat CSP, HSTS, and server-side rate limits only as documentation or UI hints because the application is static. [Pipeline-aligned]
**Target**: No server-side enforcement claim appears in the application.

### NFR-007 — performance
Mock FX quote retrieval and fee calculation must meet the defined response target, including intentional loading simulation. [Pipeline-aligned]
**Target**: ≤ 3 seconds at P95.

### NFR-008 — performance
Mock beneficiary-validation responses must meet the defined response target. [Pipeline-aligned]
**Target**: ≤ 5 seconds at P95.

### NFR-009 — performance
Simulated payment submission must provide an initial response within the defined target. [Pipeline-aligned]
**Target**: ≤ 10 seconds at P95.

### NFR-010 — performance
Routine local calculations and screen transitions should normally complete promptly on a modern desktop browser. [Auto-filled]
**Target**: ≤ 500 milliseconds under normal conditions.

### NFR-011 — usability
The UI must remain responsive during simulated calls and show loading indicators and retry messaging. [Pipeline-aligned]
**Target**: Every simulated asynchronous state exposes loading feedback; retryable failures expose a retry action.

### NFR-012 — reliability
The frontend must degrade gracefully when a selected mock integration scenario is unavailable. [Pipeline-aligned]
**Target**: Unavailable fixture scenarios show a recoverable error state without crashing the application.

### NFR-013 — reliability
Local instruction references must demonstrate duplicate-submission prevention. [Pipeline-aligned]
**Target**: Duplicate active references produce no second local submission.

### NFR-014 — reliability
Independent browser sessions must not create frontend state conflicts. [Pipeline-aligned]
**Target**: State changes in one browser storage context do not alter another independent context.

### NFR-015 — availability
Static hosting availability depends on Vercel and is not represented as an application-side 99.9% SLA. [Pipeline-aligned]
**Target**: No application-side 99.9% availability claim.

### NFR-016 — scalability
The demonstration should behave correctly for independent static browser sessions. [Auto-filled] [Pipeline-aligned]
**Target**: Up to 25 independent concurrent sessions; no shared state is expected.

### NFR-017 — scalability
No shared multi-user transaction state, real autoscaling, or backend availability target is included. [Pipeline-aligned]
**Target**: No backend, database, or shared-state dependency in the production build.

### NFR-018 — accessibility
Target WCAG 2.1 AA with keyboard navigation, ARIA labels, sufficient contrast, and focus management.
**Target**: WCAG 2.1 AA target.

### NFR-019 — accessibility
Forms, errors, status updates, and navigation must be compatible with screen readers.
**Target**: All interactive controls have accessible names; errors and dynamic statuses are programmatically associated or announced.

### NFR-020 — accessibility
Modals must implement focus trapping, Escape handling, and return-focus behavior.
**Target**: All modal dialogs pass keyboard focus-cycle, Escape-close, and return-focus checks.

### NFR-021 — responsive_design
Support responsive desktop, tablet, and mobile web viewports.
**Target**: Usable at 320px, 640px, 1024px, and 1200px breakpoints.

### NFR-022 — audit
Record quote requests and acceptances, validation outcomes, approval decisions, submissions, signer changes, and status changes in local demonstration audit history. [Pipeline-aligned]
**Target**: Each listed event type creates a local audit entry.

### NFR-023 — audit
Audit entries must include fake user ID, timestamp, masked source account, masked beneficiary reference, instruction reference, and action outcome.
**Target**: Every generated audit entry contains all specified fields with required masking.

### NFR-024 — compliance
Expose only role-appropriate sanitized financial-crime information.
**Target**: No watchlist details, restricted rules, or internal decision logic are rendered.

### NFR-025 — audit
Local audit history is not immutable, centrally retained, or suitable for regulatory evidence. [Pipeline-aligned]
**Target**: The UI/documentation labels audit history as local demonstration data.

### NFR-026 — compatibility
Support current mainstream desktop browsers. [Auto-filled]
**Target**: Latest two stable versions of Chrome, Edge, Firefox, and Safari.

### NFR-027 — responsive_design
Provide a usable responsive experience from the minimum viewport width upward.
**Target**: 320px minimum viewport width.

### NFR-028 — platform
Native mobile applications are not supported.
**Target**: Web application only; no native mobile deliverable.

### NFR-029 — temporal_consistency
Generate all date-sensitive mock fixtures, including quote expiration, sessions, invitation expiration, payment timelines, and status timestamps, relative to the reference date 2026-07-28. [Auto-filled] [Pipeline-aligned]
**Target**: 100% of date-sensitive fixtures derive from 2026-07-28 rather than uncontrolled absolute dates.

### NFR-030 — privacy
Use only obviously fake PII; mask account numbers, IBANs, emails, and phones where full display is unnecessary; omit unmasked PII from console/debug logs; and permit users to clear local demo data. The PII inventory is user_id, user_name, email, phone, organization_name, account_name, account_number, iban, beneficiary_name, beneficiary_address, signer_name, signer_email, signer_phone, remittance_information, payment_reference, and uetr. [Auto-filled] [Pipeline-aligned]
**Target**: All 16 inventoried fields are covered by fixture, masking, logging, and clearing checks as applicable.

### NFR-031 — persistence
Use bundled JSON fixtures and React memory for baseline/transient state, sessionStorage for the mock session, and localStorage for drafts, scenarios, signer changes, and local audit history; use no live database. Remove expired local entries at initialization. [Auto-filled] [Pipeline-aligned]
**Target**: Local draft/audit/payment/signer state expires within 30 days in the same browser unless manually cleared.

### NFR-032 — test_data_scale
Provide fixture volumes sufficient to exercise list, filtering, and pagination behavior. [Auto-filled] [Pipeline-aligned]
**Target**: At least 20 source accounts, 50 beneficiaries, 100 payment/status records, and 50 signers.

## Tech Stack
- **Frontend**: Vite + React JS using JavaScript/JSX only, with Tailwind CSS; React controlled components and hooks. [Pipeline-aligned]
- **Backend**: None; mock service behavior uses predefined local responses only. [Pipeline-aligned]
- **Database**: None; JSON fixtures, React memory, sessionStorage, and localStorage only. [Pipeline-aligned]
- **Infrastructure**: Static Vercel hosting configuration only. [Pipeline-aligned]
- *Specified by user*: True

## In Scope
- Mock login-only access for pre-provisioned users. [Clarified] [Pipeline-aligned]
- Payment initiator, approver, and operations user experiences. [Clarified]
- Source account and currency-pair selection.
- Simulated FX-rate retrieval and display for a sample amount of 1,000. [Pipeline-aligned]
- Dynamic source/beneficiary amount recalculation.
- Fee and charge calculation based on local fixture tiers. [Pipeline-aligned]
- Quote acceptance and quote-expiry handling.
- Representative CBPR+ transaction-detail capture.
- Simulated beneficiary BIC, IBAN, and name-on-account validation. [Pipeline-aligned]
- Simulated CBCC outcomes for funds, fraud, AML/FTR, sanctions, and accounting validation. [Pipeline-aligned]
- Simulated customer debit and ledger-posting confirmation. [Pipeline-aligned]
- Mock pain.001, pacs.008, and optional pacs.009 previews. [Pipeline-aligned]
- Confirmation, tracking, local audit logging, and representative operational-status handling. [Pipeline-aligned]
- Representative payment approval and rejection. [Clarified] [Pipeline-aligned]
- Signer listing, signer editing, simulated eSign confirmation, unlock, and invitation resend. [Clarified] [Pipeline-aligned]
- Static responsive frontend deployment to Vercel. [Pipeline-aligned]

## Out of Scope
- Any backend application, serverless business logic, or real API.
- Real databases, shared persistence, and immutable audit storage.
- Live Refinitiv, HSBC FX, Bankcheck, CBCC, SWIFT, KYC, or eSign connectivity.
- Real funds, fraud, AML/FTR, sanctions, SSI, accounting, or ledger processing.
- Real payment initiation, debit, posting, settlement, or message transmission.
- Real identity authentication, SSO, OIDC, SAML, MFA, signup, password reset, or user provisioning.
- Production approval orchestration or payment release.
- Bulk international payment upload and batch processing.
- Real-time repair operations by back-office teams.
- Full exception-investigation case management.
- Native mobile application implementation.
- Non-SWIFT alternative network routing unless represented as a future mock enhancement.
- Real signer-authority changes, real Digital KYC processing, or legally binding eSign.
- Server-side encryption-at-rest controls, TLS configuration, CSP, HSTS, API gateways, or server-enforced rate limiting.
- Kubernetes, Terraform, cloud databases, Redis, AWS/Azure storage, or other backend infrastructure.

## Assumptions
- Users are pre-provisioned in fake fixtures and access the MVP through a login-only mock experience. [Clarified] [Pipeline-aligned]
- Demo credential hints are displayed beneath the login form because there is no signup or account-recovery flow. [Clarified] [Pipeline-aligned]
- Supported currency pairs and amount tiers are defined in local pricing and FX fixtures.
- FX rates are predefined responses representing Refinitiv or HSBC internal FX APIs. [Pipeline-aligned]
- Beneficiary-validation results are predefined responses representing Bankcheck checks. [Pipeline-aligned]
- CBCC outcomes are simulated and are not a system of record. [Pipeline-aligned]
- SWIFT SSIs, nostro details, creditor agents, and intermediary-bank determinations are fake fixture data.
- All payment, accounting, screening, eSign, and SWIFT outcomes are demonstrative only. [Pipeline-aligned]
- The application uses JSON fixtures, in-memory state, sessionStorage, and localStorage; no live database is used. [Pipeline-aligned]
- Approver and operations experiences use representative queues rather than shared workflow state. [Pipeline-aligned]
- Signer management is an explicit MVP capability. [Clarified]
- All dates and expirations are calculated relative to the reference date of 2026-07-28. [Auto-filled]
- Real production integration requirements are deferred to a future architecture phase and are outside this static frontend deliverable.

## Constraints
- Quotes must not be used after simulated expiry; expired quotes require refresh and re-acceptance.
- Payment cannot proceed if mandatory CBPR+ fields are missing or invalid.
- Payment cannot proceed if the selected beneficiary-validation scenario fails and mock policy does not permit override.
- Payment cannot proceed if the selected funds, sanctions, AML/FTR, or fraud scenario fails.
- Duplicate local submissions must be prevented through mock instruction references. [Pipeline-aligned]
- Customer-facing screens must not expose sensitive financial-crime screening rules or internal decision logic.
- All integrations must use predefined frontend responses. [Clarified] [Pipeline-aligned]
- No real money movement, account update, signer-authority change, approval release, or external message transmission may occur. [Pipeline-aligned]
- The implementation must use Vite, React JS, JavaScript/JSX, and Tailwind CSS; TypeScript and backend frameworks are prohibited. [Pipeline-aligned]
- The application must remain functional as a static Vercel-hosted frontend. [Pipeline-aligned]
- Browser storage is user-controlled and cannot provide secure, immutable, or shared persistence. [Pipeline-aligned]
- Client-side resend throttling, session timeout, and duplicate-prevention rules are demonstration controls only and cannot substitute for server-side enforcement. [Pipeline-aligned]

## Additional Context
Verbatim supplementary details from the original PRD:

## 14. Branding and Visual Design Guidelines

- Use Tailwind CSS for all UI styling. [Pipeline-aligned]
- Reproduce the intended HB/Honeybee-inspired visual language using Tailwind theme tokens rather than requiring Honeybee CSS classes. [Pipeline-aligned]
- Font should be Roboto, base 16px, body color `#292929`.
- Primary brand color should be `#00468b`, exposed through Tailwind tokens such as `text-primary-blue` and `bg-primary-blue`.
- Primary actions such as Get Started, Submit, Approve, and Continue should use a consistent Tailwind primary-button component style.
- Secondary actions such as Cancel, Back, and Edit should use a consistent Tailwind secondary-button component style.
- Alerts must have consistent critical, warning, success, and informational variants with icons and text, not color alone.
- Responsive layout should use Tailwind container, grid, flex, and breakpoint utilities.
- Modals should use accessible React dialog components styled with Tailwind, including focus trapping.
- Forms should use accessible labels; floating labels may be used where they remain legible and screen-reader compatible.
- Invalid fields must include visible error text, `aria-invalid`, and linked error descriptions.
- Responsive breakpoints should support Mobile 320px, Tablet 640px, Desktop 1024px, and Widescreen 1200px.

## 16. User Journey / Screen Flow

### Primary Payment Initiator Journey

1. **Login** — Enter pre-provisioned demo credentials; credential hints appear below the form.
2. **Select Account and Currency Pair** — Choose a mock source account, source currency, and beneficiary currency.
3. **View FX Quote and Charges** — Display simulated rate, fees, source amount, beneficiary amount, and quote expiry.
4. **Amend Amount** — Recalculate source or beneficiary amount, rate, and charges dynamically.
5. **Enter Payment Details** — Capture representative CBPR+ debtor, creditor, agent, remittance, and regulatory data.
6. **Validate Beneficiary** — Display predefined BIC, IBAN, and name-on-account validation results.
7. **Review and Submit** — Review quote, fees, beneficiary, payment details, and mock pain.001 preview.
8. **CBCC Processing** — Display predefined funds, fraud, AML/FTR, sanctions, SSI, accounting, and ledger outcomes.
9. **Confirmation** — Display fake payment reference, status, UETR, SWIFT outcome, and next steps.

### Payment Approver Journey

1. Login using a pre-provisioned approver fixture.
2. Open the pending-approval queue.
3. Review masked payment and validation information.
4. Approve or reject with an optional comment.
5. View the locally updated status and audit entry.

### Operations User Journey

1. Login using a pre-provisioned operations fixture.
2. Open the payment-status dashboard.
3. Filter and select a payment.
4. Review processing checkpoints, sanitized reason codes, mock postings, and SWIFT status.
5. Trigger a permitted local scenario transition or reset.

### Signer Management Journey

1. Login using a pre-provisioned controlling-party fixture.
2. Open the authorized-signer list.
3. Filter signers by account or status.
4. Review and edit an existing signer.
5. Confirm before-and-after changes.
6. Complete a simulated eSign flow.
7. Unlock an eligible signer or resend an expired invitation.
8. View the locally updated signer state and audit history.

## 17. MVP Dummy Data Fixture

The MVP sample fixture must include:

- Pre-provisioned users for initiator, approver, operations, and controlling-party experiences.
- User entitlements and role-specific navigation.
- Fake source accounts with masked account numbers.
- Supported and unsupported currency pairs.
- FX quote responses with timestamps and expiry relative to the reference date.
- Fee tiers and OUR/SHA/BEN charge scenarios.
- Beneficiary-validation success, partial-match, failed, and unavailable responses.
- CBCC accepted, rejected, pending-review, and repair-required responses.
- Representative accounting entries and fake posting references.
- Mock pain.001, pacs.008, and pacs.009 previews.
- Simulated SWIFT acknowledgement, rejection, and repair statuses.
- Approval queue and approval/rejection scenarios.
- Signer records, locked states, expired invitations, edit histories, and simulated eSign outcomes.
- Sanitized local audit-history records.
- Obviously fake PII values only.

Role-model note from the analysis: “the controlling-party signer persona is required by signer-management stories and fixtures but is omitted from the initial three-role MVP role list; clarify whether it is a distinct fourth role or an entitlement assigned to an initiator/approver.” No resolution was supplied, so this remains an implementation clarification and is not converted into a new role requirement.