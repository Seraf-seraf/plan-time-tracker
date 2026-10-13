# Plan Time Tracker for ChatGPT Sites

A private Site app for recording plan execution time. The browser UI, Worker API/MCP handler, and source-of-truth schema run inside ChatGPT Sites. GitHub is optional read-only source data; there is no separate backend.

## Current implementation

- Owner-scoped plans, immutable plan event history, server-timed half-open work intervals, idempotent commands, and a one-RUNNING-plan constraint.
- Explicit Start, Pause, Resume, Finish; time continues across nights and weekends until Pause or Finish.
- UI for plan creation, lifecycle controls, plan/date/repository filters, interval/event history, explicit Finish confirmation, branch/ref selection, commit status and conflict review, analytics sample details, timezone, private-cache controls, and owner JSON export.
- Shared API/MCP command processor. MCP schemas and calls use the same command types, receipts, owner identity, and D1 data model.
- Read-only GitHub REST adapter with bounded retries/Retry-After, durable page checkpoints/resume, full-ref reconciliation, commit de-duplication, exact Plan-ID conflict review, explicit owner exclusions, revoke/cache handling, and time-overlap candidates. It requires a Site runtime `GITHUB_TOKEN` and is disabled when absent.

## Published Site and verification

The existing owner-private Site is live at https://plan-time-tracker.seraf-k.chatgpt.site (version 1). It uses the existing Site identity and owner-only allowlist. Its `.openai/hosting.json` declares `"d1": "DB"`; the publish succeeded and the live database overview reports binding `DB` with 13 application tables. The initial schema is `drizzle/0001_initial.sql`.

The original deployment used Site source commit `8d0639abf461cd9abc9145fd68fad923220d6d63`. The complete source and responsive/accessibility improvements were restored to this repository from Site source commit `64a02657669668c11764443387d2d4f4c2d77c6e` on 2026-10-13. Restoring repository source does not by itself deploy that revision. The complete original requirements and plan remain unabridged in `../../docs/originals/`; checksums and traceability are in `../../docs/`.

Local verification (2026-10-13): `npm test` passed 47/47, `npm run build`, `npm run validate`, and `node --check worker/index.js` passed. A live MCP lifecycle smoke test on the published Site created, started, replayed, paused, resumed, and finished a QA plan, then returned analytics; that QA record remains in the database. This is not a full G1–G6 or A01–A24 pass.

## Local development

Requires Node.js 22+ (tests use built-in `node:sqlite`). From this directory:

```sh
npm test
npm run build
npm run validate
node --check worker/index.js
```

The local SQLite adapter exercises schema constraints and atomic statement rollback; it does not emulate Cloudflare D1 concurrency or Sites identity middleware.

## Remaining gates

The browser QA currently reaches the Site's ChatGPT sign-in screen. Owner sign-in was not completed because the flow requires a one-time authenticator code; do not claim UI identity middleware or cross-owner browser denial was tested. Hosted D1 concurrency and the full A01–A24 acceptance suite remain unverified. GitHub repository sync remains explicitly disabled until the owner configures a supported Site runtime integration and `GITHUB_TOKEN`; the ChatGPT GitHub connector does not supply runtime access. No GitHub runtime secret or OAuth grant is present.
