# Plan Time Tracker for ChatGPT Sites

A private Site app for recording plan execution time. The browser UI, Worker API/MCP handler, and source-of-truth schema run inside ChatGPT Sites. GitHub is optional read-only source data; there is no separate backend.

## Current implementation

- Owner-scoped plans, immutable plan event history, server-timed half-open work intervals, idempotent commands, and a one-RUNNING-plan constraint.
- Explicit Start, Pause, Resume, Finish; time continues across nights and weekends until Pause or Finish.
- UI for plan creation, lifecycle controls, plan/date/repository filters, interval/event history, explicit Finish confirmation, branch/ref selection, commit status and conflict review, analytics sample details, timezone, private-cache controls, and owner JSON export.
- Shared API/MCP command processor. MCP schemas and calls use the same command types, receipts, owner identity, and D1 data model.
- Read-only GitHub REST adapter with bounded retries/Retry-After, durable page checkpoints/resume, full-ref reconciliation, commit de-duplication, exact Plan-ID conflict review, explicit owner exclusions, revoke/cache handling, and time-overlap candidates. It requires a Site runtime `GITHUB_TOKEN` and is disabled when absent.

## Checkpoint tracker source (local, not deployed)

The local source adds owner-scoped checkpoints, fenced attempts and leases, immutable result revisions, SHA-bound check evidence, separate owner acceptance/waivers, explicit incomplete-finish snapshots, and a sequenced metadata-only observation journal. The existing plan intervals remain the only timer. API and MCP reads share the same owner-scoped snapshot, receipt, and paginated timeline helpers; the existing Site UI includes checkpoint controls, the combined legacy/journal timeline, and counts for blocked events, repeat attempts, failed results, and server-recorded result-to-check delay. That delay is not test execution time.

The independent plugin package contains a local-only observation queue helper. It stores only `AppendObservation` envelopes outside the tracked repository, bounded to 1000 events, 5 MiB, and seven days, with at most five send attempts and `Retry-After` support. Web/cloud sessions remain ephemeral and no lifecycle command is queued or replayed.

Additive D1 migrations `0004_tracker.sql` through `0011_plan_repository_binding.sql` preserve the legacy plan tables and history. `0011` adds the versioned `AttachPlanRepository` command and refines result/lease domain errors without rewriting prior migrations. `npm test` builds the ignored `dist/` artifact before running the suite so `test/artifact.test.js` can import the actual Worker bundle. This local source has not been deployed to the private Site. The independent skill source is in `../../plugin/plan-time-tracker/`; it remains unverified until supported private MCP connection and installation flows are exercised.

## Published Site and verification

At the 2026-10-14 inspection, the existing Site at https://plan-time-tracker.seraf-k.chatgpt.site is live at version 6 with custom access for its owner only; the access record contains one allowed user and no groups. The live database overview reports binding `DB` and 13 existing application tables, with no tracker tables yet. Its current Site source commit is `55130f1da3127e8b402c02e855899665c10df8d7`; the local GitHub checkout is at `49cc794a132383e14e7eff7c4f5eb82bd07929c1`. Those are separate source repositories. The tracker implementation and migrations described above are a local release candidate and have not been deployed.

The original requirements, acceptance matrix, and traceability records remain under `../../docs/`. Earlier Site and local verification notes there are historical evidence; they do not cover the current tracker release candidate.

The current authenticated MCP connector returned `GetActivePlan: null`. That proves the existing read path in this client context only; it does not verify the new tracker tools, another client, the Site UI's authenticated flow, or hosted D1 concurrency.

## Local development

Requires Node.js 22+ (tests use built-in `node:sqlite`). From this directory:

```sh
npm test
npm run build
npm run validate
node --check worker/index.js
```

The local SQLite adapter exercises schema constraints and atomic statement rollback; it does not emulate Cloudflare D1 concurrency or Sites identity middleware. The plugin's local observation queue has a separate Node test suite.

The browser acceptance fixture uses the existing Chromium/Playwright installation, with no new project dependency. See [`test/README.md`](test/README.md) for the invocation. It runs the real Worker-generated UI against synthetic intercepted API responses only.

## Remaining gates

Local Node and artifact checks do not prove hosted D1 races, local and web/cloud client parity, owner-authenticated browser interaction, GitHub public/private sync, or the full A01–A24 acceptance suite. Those remain release gates. The independent plugin format and existing Site App binding are now represented in the local package; the account plugin and Site have not yet been updated.
