# Plan Time Tracker for ChatGPT Sites

A private-Site application prototype for recording plan execution time. The browser UI, Worker API/MCP handler, and source-of-truth schema are intended to live inside ChatGPT Sites. GitHub is read-only external data; no separate backend is used.

## Current implementation

- Owner-scoped plans, plan date distinct from server registration/start, immutable plan event history, server-timed half-open work intervals, idempotent commands, and a one-RUNNING-plan constraint.
- Explicit Start, Pause, Resume, Finish; time continues across nights and weekends until Pause/Finish.
- UI for plan creation, lifecycle controls, plan/date/repository filters, interval/event history, explicit Finish confirmation, branch/ref selection, commit status and conflict review, analytics sample details, timezone, private-cache controls, and owner JSON export.
- Shared API/MCP command processor. MCP schemas and calls use the same command types, receipts, owner identity, and D1 data model.
- Read-only GitHub REST adapter with bounded retries/Retry-After, durable page checkpoints/resume, full-ref reconciliation, commit de-duplication, exact Plan-ID conflict review, explicit owner exclusions, revoke/cache handling, and time-overlap candidates. It requires a Site runtime `GITHUB_TOKEN` and is disabled when absent.

## Normative sources and verification status

The exact full requirement and plan files are in `../../docs/originals/`. Their checksums and the task-by-task mapping to source code and evidence are recorded in `../../docs/G1-G6-status.md`, `../../docs/A01-A24-status.md`, and `../../docs/plan-traceability.md`. The mapped local implementation is not a completed or published Site: mandatory runtime gates and acceptance scenarios remain open.

## Local development

Requires Node.js 22+ (the tests use built-in `node:sqlite`). From this directory:

```sh
npm test
npm run build
npm run validate
node --check worker/index.js
```

`npm test` runs the SQLite-backed local behavioral suite. It exercises schema triggers and atomic statement rollback, but it does not emulate Cloudflare D1 concurrency or Site identity middleware. `npm run build` creates `dist/`; `npm run validate` checks the Worker ESM artifact.

## Site runtime requirements and blockers

The Worker expects a Site D1 binding named `DB` and the authenticated-user headers `oai-authenticated-user-id` and optional `oai-authenticated-user-email`. The `.openai/hosting.json` contains the known Site project ID and declares MCP capability, but the D1 binding shape and migration-attachment workflow could not be confirmed from the available Sites tooling. The manifest therefore has `d1: null`; it is **not deploy-ready**. The GitHub chat connector does not provide this Worker with GitHub access. No GitHub token, OAuth grant, or secret has been created; private repository sync returns an explicit unavailable error until an approved Site runtime integration is configured.

The private Site exists but has no deployment. No public URL, live MCP endpoint, hosted D1 behavior, or real Site auth behavior has been verified. A local Chromium/Playwright preview exercised UI/API flows against SQLite and test identity headers; this does not establish hosted rendering or Sites behavior. Do not present this local prototype as a working published Site or connected skill.

Before any deployment, resolve the Site D1 binding/migration configuration and supported runtime GitHub integration, then run G1–G6 against the actual private Site and the full A01–A24 acceptance suite. Deployment/publication, credential creation, and permission changes are intentionally outside this local implementation.
