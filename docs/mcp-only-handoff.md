# MCP-only tracker: independent review handoff

Prepared entirely in the cloud Codex workspace. Base: `04e05b5d1f23c18027831c1c038aa51a435de50e`. HEAD is unchanged; all implementation is an unstaged working diff. No commit, push, publication, production-data command or remote synchronization was performed. The existing Site was not changed by this task.

## Requirement and boundary

Time is recorded by explicit authenticated Start/Pause/Resume/Finish commands and server work intervals. MCP transports intent and bounded observations; it is not a version-control system. The product can track time and verify result evidence without Git. The source Git repository and `.git` remain intact.

New checkpoint/result/check contracts have no repository management, external synchronization, commit links, commit/push policies, SHA fields or Git observations. Historical identities are retained internally. Snapshot evidence is optional for source-less reports and required to satisfy nonempty required-check lists; it is never a timer prerequisite. The UI remains a supported owner command client.

## Implementation map

- `sites/plan-time-tracker/worker/index.js`: removed GitHub adapter/sync execution and repository/cache/conflict routes, MCP Git tools, repository analytics/filtering and all Git UI controls. Removed fields are rejected before receipt replay/writes. Public responses omit Git fields and label old sources/events as historical; underlying rows remain unchanged. Latest-required-check readiness and legacy source matching remain server-owned. Old COMMIT results cannot receive new SHA checks through the public contract: rework uses a new result and v2 snapshot.
- `sites/plan-time-tracker/drizzle/0015_source_snapshots.sql`: additive `step_source_snapshots` and `step_source_checks`, immutable rows, source-kind conflicts, combined historical/new evidence views, and updated atomic result/check triggers. All previous migrations are unchanged. Existing tables, policies, repositories, commits, links, identities, observations, attempts, results, checks, receipts and intervals are retained. Legacy policy columns are filled with inert NEVER defaults for new checkpoints because the historical schema still contains them.
- `plugin/plan-time-tracker/scripts/source-snapshot.mjs`: new repository-free v2 deterministic file capture, before/after digest verification, explicit source root and exclusion policy, no child processes or version-control tools. Replaces the v1 Git-dependent helper. Format v2 is intentionally distinct from v1; old evidence is never reinterpreted.
- `plugin/plan-time-tracker/scripts/observation-queue.mjs`: only non-Git observations, opaque authenticated owner scope plus planContext. Plan-scoped files use a distinct hash namespace; existing repository-scoped files are untouched and are not auto-replayed. FIFO/idempotency/backoff/limits remain tested.
- Both bundled skills, plugin metadata (version 2.0.0), recovery fixtures and current READMEs describe the new contract. Old audit reports are marked historical. Original requirement documents are retained verbatim.
- Removed feature-specific sync/attribution tests were replaced by explicit public refusals, strict schema/field tests, repository-free evidence tests and populated-history migration tests. Existing timer/receipt/concurrency/calendar/owner/VM UI tests were retained and adapted. Historical schema tests remain intentionally.

## Contract examples

`RecordStepResult` uses its normal v1 command envelope and active attempt/fence, with `sourceSnapshot: {kind:"SOURCE_SNAPSHOT",formatVersion:2,digest:"sha256:<64 lowercase hex>"}`. Do not send the helper's diagnostic fileCount. A result returns its own resultRevision.

`RecordCheck` names stepId, resultRevision, checkKey, status, testedSnapshotDigest and actual exitCode (0 for PASSED, 1–255 for FAILED, omitted for NOT_RUN). Both the digest and revision must match. A new revision requires new checks even when its digest equals the previous one. Old-revision passes stay historical. Latest server sequence determines readiness, including equal timestamps. No waivers or automatic attestation are introduced.

The helper excludes version-control metadata, documented dependency/build/cache directories and `.env`/`.env.*`; custom exact relative output paths can be configured in `.tracker-snapshot.json`, which is itself attested. Keep logs/screenshots outside the source root. Excluded environment/dependency inputs remain separate evidence. The server trusts client evidence and does not execute tests, monitor local file changes or freeze writers. See `docs/worktree-evidence.md` for exact scope.

## Executed verification

All checks below ran locally against this working implementation; none is production QA.

| Check | Result |
| --- | --- |
| Baseline before changes: npm test | 171/171 passed |
| Final npm test (includes build + actual artifact import) | 111/111 passed, 0 skipped |
| Final npm run validate | valid ESM artifact with default.fetch |
| Plugin node --test plugin/plan-time-tracker/test/*.test.mjs | 11/11 passed |
| npm run test:ui | all three real Worker + in-memory SQLite Chromium suites passed |
| git diff --check | passed |

Browser run configuration: PLAYWRIGHT_MODULE=/opt/codex/cua_node/lib/node_modules/playwright/index.mjs, CHROMIUM_EXECUTABLE=/usr/bin/chromium, UI_ACCEPTANCE_ARTIFACT_DIR=/tmp/source-audit-ui-final. The general UI suite covers 360/390/768/1440 px; the result/check/finish suite covers 360/1440 px. Every request is intercepted on localhost and external traffic is forbidden; production requests: 0.

Coverage includes explicit interval timing, one active plan, pause/resume and finish closing, unknown-ack exact envelope replay, duplicate command/check deduplication, changed-payload ID refusal, owner isolation, required-check gates, malformed/wrong digest refusal, new/same-digest revision invalidation, late historical checks, added required keys, same-time FAILED/NOT_RUN, source-less reports, attempt expiration/recovery/fencing, snapshot insertion rollback and check/Finish concurrency. The populated 0014→0015 tests compare all old table rows and preserve completed COMMIT/v1 readiness, revoked-source protections, an open interval, active lease and unverified old prose.

Helper tests cover plain non-repository directories with empty PATH, bytes/paths/deletion/modes/symlink targets, deterministic capture, scope configuration and sanitized changed-source refusal. Queue tests cover exact FIFO replay, scope isolation, persistence, concurrency, retention/caps and retry limits.

Evidence retained outside the source checkout:

- `/workspace/scratch/plan-time-tracker-mcp-review/application-tests.log`
- `/workspace/scratch/plan-time-tracker-mcp-review/plugin-tests.log`
- `/workspace/scratch/plan-time-tracker-mcp-review/browser-tests.log`
- `/workspace/scratch/plan-time-tracker-mcp-review/browser/report.json`
- `/workspace/scratch/plan-time-tracker-mcp-review/browser/source/report.json`
- Screenshots alongside those browser reports.

## Review focus and release boundary

Review the public command guard/projection, combined source/check SQL views, atomic trigger ordering (especially SQLite changes() around step update and journal insertion), legacy row preservation, digest scope and active timer invariants. There are no known failing checks or local preparation blockers.

Publication is intentionally held for independent review. Hosted D1 migration execution/atomicity, private Site authentication, installed MCP tool refresh and post-deployment UI have not been tested by this change. The parent thread's separate live inventory is not counted as evidence for this implementation. Do not describe the prepared artifact as deployed.

After review, use the supported Sites source/release workflow for the existing project, publish the exact reviewed source together with migration 0015, and refresh installed tool schemas/plugin instructions. Do not reverse historical migrations or deploy the old Worker after v2 evidence has been created. Production migration/deploy and any runtime-secret cleanup need their own authorized release step; no runtime settings were read or changed here.

## Follow-up: historical receipts and interrupted checkpoint recovery

The independent review artifact `libfile_264f12b06c9881918b7ae56c98100668` (SHA-256 f9fba061e49542f83cb5211f731d28eae2d47a9483df26c2feb5eb99e662e85a) was materialized through Library and verified. Its P2 reproducer showed that a historical SyncRepository receipt retained fullName/ref after private access revocation. The current readCommandReceipt now uses a contextual allowlist projection for all retired Git commands: command ID/type, historical flag, pending/final status, outcome code, result version and server/audit times. Successful results contain only historical/detailsHidden markers; failed results contain a generic error code/message. Raw receipt payload/result strings remain byte-for-byte unchanged. API and MCP use the same projection, regardless of former repository visibility. No history deletion or migration was added.

The user PNG was materialized through Library and its pixels inspected. It showed a RUNNING checkpoint at version 2, no result and a CLOSED fence-1 attempt whose lease deadline had not passed. This matches the independently reported live pattern; no production writes or recovery commands were sent. CloseStepAttempt intentionally closes the executor, not the checkpoint or plan. The old UI only exposed recovery for expired OPEN attempts and omitted recovery for RUNNING with CLOSED/ABANDONED/no attempt; a claimed-but-unstarted RUNNING attempt also had no Start control. Client wall-clock comparisons and lack of in-page lease refresh added stale execution displays.

Execution snapshots now derive step.execution (state, planStatus, current attempt/fence/lease, canClaim/canStart/canRenew/canRecordResult and requiresOwnerRework) from server time and actual STEP_STARTED history. Stored checkpoint/attempt states and timer rows are not rewritten. The UI labels closed/expired/unstarted execution accurately, offers a fresh Claim+Start for interrupted work, starts an already assigned but unstarted attempt, and offers an explicit ResumePlan when paused. An expired/closed fence is never renewed or resurrected. A monotonic clock anchored to serverNow drives read-only lease-expiry refresh; a read-only manual refresh is also available. Recovery preflights current state and settles ambiguous Claim/Start envelopes exactly before another action. Buttons prevent duplicate clicks. Recovery itself never starts/stops plan time or records results/checks; ResumePlan is a separate explicit timer command.

New mandatory tracker-recovery.test.js covers retired success/partial/failure/pending receipts through API and MCP, immutable stored JSON, owner isolation, closed-before-deadline recovery with new fence, idempotency, stale executor refusal, exact lease boundary and pause/resume timing. New mandatory ui-recovery.mjs covers CLOSED, ABANDONED, already expired, expiry while open, claimed-but-unstarted and paused/closed scenarios at 390 px with deliberately skewed client clocks, duplicate clicks and lost Claim/Start acknowledgements. It proves two historical fences (old terminal, new OPEN), one actual new start, unchanged intervals during recovery, and no fabricated result/PASSED records. The original candidate fails its closed-attempt browser assertion before the fix.

Follow-up verification: 111/111 application tests, 11/11 plugin tests, all three shipped Chromium suites, build/artifact validation, 8/8 independent reviewer backend cases, the independent browser flow and historical receipt redaction probe pass locally. Reviewer scripts were adapted only for local import/output paths; the receipt probe's unconditional pre-fix fullName/ref assertions were removed when running --expect-redacted, since asserting both leaked and absent metadata in the same run is contradictory. The shipped regression separately verifies full redaction and original raw storage. A final UI test initially timed out because it began creating a checkpoint before the preceding metadata refresh had rendered; the test now waits for the persisted description and fresh form before continuing. No application assertion was weakened or test skipped.

The reviewer backend cases explicitly recheck >100-row current-check readiness, status/actor permissions, sequential populated upgrades from schemas 0010 through 0014, inert waivers, row retention, active leases and historical redaction over all timeline pages. These are external review evidence in addition to mandatory suites; they do not prove every former 171-test combination is equivalent. Baseline 171 → current 111 is 93 retained names, 78 removed names and 18 added names. All hosted D1/authentication/tool-refresh limits remain. Commit/push/deploy remain held for review.
