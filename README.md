# International Payment Initiation

A front-end demonstration of an international (cross-border) payment initiation
and processing workflow. The entire experience is **simulated** — it exists to
showcase the end-to-end user journey across payment initiation, FX quoting,
CBPR+ transaction capture, beneficiary validation, approvals, and operations,
plus signer entitlement administration and a sanitized audit trail.

## Simulated-behavior notice

**Everything in this application is simulated and demo-only.** Nothing here is
real, and no server guarantee is implied:

- No real authentication is performed — the login accepts shared, non-production
  demo credentials only.
- No real payments are initiated, no funds ever move, and no message is
  transmitted to any provider or the SWIFT network.
- FX rates, fees, beneficiary validation, compliance checks, eSign ceremonies,
  and SWIFT acknowledgements are all deterministic mocks.
- No real signer authority is granted, and the audit trail is a local,
  non-immutable, non-regulatory demonstration.

All state lives in the browser (session/local storage, with an in-memory
fallback). Every displayed value is sanitized and masked. **Do not enter real
personal or banking information.**

## Tech stack

- **JavaScript (ES2022, JSX)**
- **React 18** — UI and routing (`react-router-dom`)
- **Vite** — dev server and build tooling
- **Tailwind CSS** — utility-first styling
- **Zod** — runtime schema validation
- **react-hook-form** — form state and validation
- **Vitest** + **@testing-library/react** — unit and component testing
- **ESLint** + **Prettier** — linting and formatting

## Folder structure

```
.
├── index.html
├── src/
│   ├── main.jsx                 # Vite entry point (renders <App /> only)
│   ├── App.jsx                  # Root: bootstrap gating, providers, router
│   ├── index.css                # Global styles (Tailwind layers)
│   ├── app/                     # App shell, routes, guards, contexts, bootstrap
│   ├── features/
│   │   ├── access/              # Auth, session, signers, audit, demo reset
│   │   │   ├── data/            # Repositories, ledgers, audit facade
│   │   │   ├── pages/           # Login, signer list/detail/edit, audit, clear-data
│   │   │   └── services/        # Auth, authorization, navigation, signer services
│   │   └── payment/             # Payment initiation and processing
│   │       ├── data/            # Payment repository, audit event factory
│   │       ├── domain/          # Money, pricing, CBPR, lifecycle, messages
│   │       ├── pages/           # Account/quote/details/review/confirmation/ops
│   │       └── services/        # Account, quote, payment, approval, ops facades
│   ├── fixtures/                # Bundled demo data (access + payment JSON)
│   └── shared/                  # Cross-cutting utilities
│       ├── config/              # Constants and environment configuration
│       ├── fixtures/            # Validated fixture registry
│       ├── logging/             # Sanitized safe logger
│       ├── mock/                # Async mock envelope + latency simulation
│       ├── privacy/             # PII masking policy
│       ├── schemas/             # Shared Zod schemas and contracts
│       ├── storage/             # Namespaced storage adapter, migration, expiry
│       ├── time/                # Deterministic demo clock
│       └── ui/                  # Design-system components
└── src/test/                    # Vitest setup
```

## Getting started

### Prerequisites

- Node.js 18+ and npm.

### Install

```bash
npm install
```

### Configure environment (optional)

Copy the template and adjust the non-sensitive build labels as needed. Vite only
exposes variables prefixed with `VITE_` to client code, and none of them are
secrets.

```bash
cp .env.example .env.local
```

Available variables:

- `VITE_APP_BUILD_LABEL` — human-readable build label shown in diagnostics.
- `VITE_FIXTURE_PACK` — selects the fixture data pack loaded at runtime.
- `VITE_REFERENCE_DATE` — ISO 8601 (`YYYY-MM-DD`) anchor for deterministic dates.

### Run the dev server

```bash
npm run dev
```

### Build for production

```bash
npm run build
```

### Preview the production build

```bash
npm run preview
```

### Test

```bash
npm test          # run the Vitest suite once
npm run test:watch
```

### Lint

```bash
npm run lint
```

## Demo credentials

The login page surfaces shared, non-production credential hints drawn from the
bundled users fixture so each demo role can be explored. These are demonstration
logins only and carry no real access.

## Fixtures and reference date

- **Fixtures** are bundled JSON files under `src/fixtures/` (access and payment
  data). They are statically imported, validated by the fixture registry, and
  indexed at load time. A malformed fixture degrades to a recoverable empty
  state rather than aborting startup — the demo always keeps working.
- **Reference date** — temporal logic is anchored to `VITE_REFERENCE_DATE`
  (default `2026-07-28`) via the deterministic demo clock rather than reading
  the wall clock directly. This keeps quote expiry, session timeouts, rolling
  24-hour windows, and retention purges reproducible in tests and fixtures while
  still advancing with elapsed real time at runtime.
- **Retention** — locally-stored demo records are subject to a 30-day retention
  window, purged at bootstrap. The **Clear demo data** page resets every
  application-managed store back to the baseline fixtures.

## License

This project is **private and proprietary**. All rights reserved. No part of
this codebase may be copied, distributed, modified, or used outside its intended
demonstration context without explicit written permission.