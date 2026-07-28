# Deployment Guide

This guide describes how to deploy the **International Payment Initiation**
demonstration to static hosting on [Vercel](https://vercel.com/). The app is a
client-only single-page application (SPA) built with Vite and React 18 — there
is no backend, no database, and no server-side rendering. All state lives in the
browser, and every displayed value is simulated, sanitized, and masked.

> **Simulated-behavior notice:** This deployment hosts a demonstration only. No
> real authentication is performed, no funds ever move, and no message is
> transmitted to any provider or the SWIFT network. Do not enter real personal
> or banking information.

## Prerequisites

- Node.js 18+ and npm.
- A Vercel account with access to the target project.
- The [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`) for local
  and manual deployments, or a connected Git repository for automatic
  deployments.

## Build output

Vite compiles the app into a fully static bundle. There is no runtime server
component to deploy.

| Setting          | Value           |
| ---------------- | --------------- |
| Framework preset | Vite            |
| Build command    | `npm run build` |
| Output directory | `dist`          |
| Install command  | `npm install`   |
| Node.js version  | 18.x            |

The build command is defined in `package.json`:

```bash
npm run build
```

This produces the immutable, content-hashed static assets under `dist/`.

## SPA fallback and clean URLs

Because the app uses client-side routing (`react-router-dom`), every route must
resolve to `index.html` so the router can render the correct view. This is
configured in `vercel.json`, which is already part of the repository:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "cleanUrls": true,
  "trailingSlash": false,
  "rewrites": [
    {
      "source": "/((?!api/).*)",
      "destination": "/index.html"
    }
  ]
}
```

- **`cleanUrls`** removes `.html` extensions from URLs.
- **`trailingSlash: false`** normalizes URLs without a trailing slash.
- **`rewrites`** send every non-`api/` path to `/index.html` so a direct visit
  or refresh on a deep link (for example `/payments/review`) is handled by the
  client router rather than returning a 404. There is no `api/` backend in this
  demo; the negative-lookahead pattern simply keeps the fallback future-proof.

Do not remove or weaken the rewrite rule — without it, refreshing any route
other than `/` will fail.

## Environment variables

Vite only exposes variables prefixed with `VITE_` to client code, and **all of
them are non-sensitive build labels — never store secrets here.** They mirror
the `.env.example` template.

| Variable               | Purpose                                             | Example         |
| ---------------------- | --------------------------------------------------- | --------------- |
| `VITE_APP_BUILD_LABEL` | Human-readable build label shown in diagnostics.    | `release-2026`  |
| `VITE_FIXTURE_PACK`    | Selects the fixture data pack loaded at runtime.    | `default`       |
| `VITE_REFERENCE_DATE`  | ISO 8601 (`YYYY-MM-DD`) anchor for demo dates.      | `2026-07-28`    |

Each variable is validated at load time with a safe fallback (see
`src/shared/config/env.js`), so a missing or malformed value never blocks the
build or the app from booting. Set them in **Project Settings → Environment
Variables** in the Vercel dashboard, or via the CLI:

```bash
vercel env add VITE_APP_BUILD_LABEL production
vercel env add VITE_FIXTURE_PACK production
vercel env add VITE_REFERENCE_DATE production
```

Because these variables are baked into the static bundle at build time, changing
one requires a new build/deployment to take effect.

## First-time project setup (Vercel dashboard)

1. Import the repository into Vercel (**Add New… → Project**).
2. When prompted, confirm the framework and build settings:
   - Framework preset: **Vite**
   - Build command: `npm run build`
   - Output directory: `dist`
   - Install command: `npm install`
3. Add the non-sensitive `VITE_*` environment variables for the **Production**
   (and optionally **Preview**) environments.
4. Deploy.

The bundled `vercel.json` is detected automatically and applies the SPA fallback
and clean-URL rules on every deployment.

## Preview and production flow

Vercel builds an immutable deployment for every push, and the deployment target
follows Git branch conventions:

- **Preview deployments** are created for every non-production branch and pull
  request. Each preview gets its own unique, immutable URL for review.
- **Production deployment** is promoted from the production branch (typically
  `main`). Merging or pushing to that branch triggers a fresh production build
  and, on success, updates the production alias.

To trigger deployments manually with the CLI:

```bash
# Build and deploy a preview
vercel

# Build and promote to production
vercel --prod
```

Validate a build locally before deploying:

```bash
npm run lint
npm test
npm run build
npm run preview
```

`npm run preview` serves the production build locally so you can confirm routing,
the SPA fallback, and the environment labels behave as expected.

## CI/CD notes

- **Automatic builds:** Connecting the Git repository to Vercel enables
  automatic preview builds on every branch/PR and production builds on the
  production branch — no separate CI pipeline is required for deployment.
- **Quality gates:** If you run CI checks (for example in GitHub Actions), run
  the same commands the project defines before allowing a merge:

  ```bash
  npm ci
  npm run lint
  npm test
  npm run build
  ```

  `npm run lint` is configured with `--max-warnings 0`, so any lint warning fails
  the check. `npm test` runs the Vitest suite once (`vitest run`).
- **Immutability:** Every deployment is content-addressed and immutable. A given
  deployment URL always serves exactly the bundle it was built from, which makes
  rollbacks deterministic.
- **No secrets in CI:** This project has no server secrets. The only variables
  are the non-sensitive `VITE_*` build labels described above.

## Rollback

Because every Vercel deployment is immutable, rolling back means re-pointing the
production alias at a previously-known-good deployment rather than rebuilding.

**Via the Vercel dashboard:**

1. Open the project and go to the **Deployments** tab.
2. Locate the previous, healthy production deployment.
3. Use the deployment's actions menu to **Promote to Production** (or
   **Rollback**), which re-aliases production to that immutable build.

**Via the Vercel CLI:**

```bash
# List recent deployments to find the target URL
vercel ls

# Promote a specific previous immutable deployment to production
vercel promote <deployment-url>
```

No rebuild occurs during a rollback — the previous immutable artifact is served
immediately. Once the underlying issue is fixed, deploy forward again through the
normal preview/production flow.

## Post-deployment checklist

- Load the production URL and confirm the login page renders with the demo
  credential hints.
- Refresh a deep link (for example `/operations`) and confirm the SPA fallback
  serves the app rather than a 404.
- Confirm the build label in the UI/diagnostics matches the expected
  `VITE_APP_BUILD_LABEL`.
- Confirm clean URLs resolve (no `.html` extensions, no unexpected trailing
  slashes).

## License

This project is **private and proprietary**. All rights reserved. No part of
this deployment configuration may be reused outside its intended demonstration
context without explicit written permission.