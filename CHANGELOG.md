# Changelog

All notable changes to the **International Payment Initiation** demonstration are
documented in this file.

This project is a front-end demonstration of an international (cross-border)
payment initiation and processing workflow. **Everything in this application is
simulated and demo-only** — no real authentication is performed, no funds ever
move, no message is transmitted to any provider or the SWIFT network, and no
real signer authority is granted. All state lives in the browser, and every
displayed value is sanitized and masked.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-28

Initial demonstration release.

### Added

#### Access, authentication, and session

- Mock login page offering shared, non-production demo credential hints drawn
  from the bundled users fixture, with generic invalid-credential feedback that
  never distinguishes an unknown username from a wrong passcode.
- Deterministic mock authentication service that validates demo credentials
  against the bundled users fixture and resolves a versioned session claim
  carrying only sanitized identifiers and safe codes — never PII or the
  passcode-like credential.
- Session lifecycle management via a session facade (active → warning → expired)
  anchored to the deterministic demo clock, with a session-timeout warning modal
  that lets the user extend or sign out.
- Deny-by-default authorization policy and capability-derived navigation, with a
  capability-based route guard and an accessible unauthorized state.
- Five demo roles — initiator, approver, operator, signer administrator, and
  auditor — each mapped to its own capabilities and landing route.

#### Payment initiation and processing

- Account and currency selection with entitlement-scoped, masked source
  accounts and live currency-pair eligibility validation.
- FX quote and charges flow with indicative/executable quote classification,
  an expiry countdown, dynamic amount amendment and recalculation, and immutable
  accepted-pricing snapshots.
- Integer-minor-units money engine and pure FX pricing/fee engine with
  deterministic banker's (half-even) rounding and no floating-point drift.
- Representative CBPR+ transaction-detail capture with field-aware, conditional
  Zod validation, structured/unstructured address entry, and a demo-safe mock
  UETR.
- Simulated beneficiary validation composing local BIC/IBAN/name syntax checks
  with a Bankcheck-style ceremony and an allow / override / block disposition
  policy engine.
- Review-and-submit flow producing representative ISO 20022 message previews
  (pain.001 / pacs.008 / optional pacs.009), with a client-side duplicate-guard
  reservation preventing duplicate submissions.
- Post-submission confirmation and tracking with a fabricated SWIFT/UETR
  tracking reference, a simulated status timeline, and lifecycle-derived
  next-steps guidance.

#### Approvals and operations

- Payment approval queue with masked payment summaries, simulated
  segregation-of-duties (an approver may not approve a payment they submitted),
  and approve/reject decisions with optional comments.
- Payment operations surface with status/currency/reference/scenario filtering,
  sanitized processing checkpoints, ledger postings, and SWIFT status, plus
  permitted local lifecycle transitions and a reset action gated on the operate
  capability.
- Controlled, allow-list lifecycle state machine governing every permitted
  transition, with SWIFT settlement reachable only along the satisfactory path.

#### Signer administration

- Authorized-signer list and detail surfaces with entitlement-scoped, masked
  display models.
- Signer entitlement editing with field-aware schema building, a masked
  before-and-after comparison, and continuation into a simulated eSign ceremony.
- Signer unlock and invitation-resend actions with a browser-local, non-server
  three-per-24-hour resend limit.

#### Shared infrastructure

- Idempotent application bootstrap that validates fixtures, provisions storage,
  runs schema migrations and 30-day retention purges, recovers in-flight payment
  reservations, and restores a valid session.
- Namespaced storage adapter with Zod-validated reads and a transparent
  in-memory fallback when browser storage is unavailable.
- Centralized 16-field PII masking policy, sanitized safe logger, deterministic
  demo clock, validated fixture registry, and async mock-service envelope layer.
- Local, non-immutable, non-regulatory audit trail and a clear-all-demo-data
  reset that scopes removal to the app's own namespaced keys.
- Accessible design-system components (alert, async alert, button, data table,
  error boundary, form field, loading indicator, modal, simulation banner, and
  status badge) conveying meaning by text and icon — never color alone.

### Deployment

- Static single-page-application deployment on Vercel with clean URLs and
  SPA rewrites, built with Vite.

### Security and privacy

- Login accepts shared, non-production demo credentials only; no real
  authentication is performed.
- All displayed values are sanitized and masked; no real personal or banking
  information should ever be entered.
- FX rates, fees, beneficiary validation, compliance checks, eSign ceremonies,
  and SWIFT acknowledgements are deterministic mocks.

[1.0.0]: https://example.test/intl-payment-initiation/releases/tag/v1.0.0