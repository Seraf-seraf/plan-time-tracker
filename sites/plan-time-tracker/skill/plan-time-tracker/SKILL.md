---
name: plan-time-tracker
description: Track explicitly assigned Plan Time Tracker work through authenticated MCP commands and source snapshot evidence.
---

# Track an explicitly assigned plan

Use this skill only for a plan or checkpoint explicitly assigned by the user. MCP is the command transport; the server's work intervals are the source of truth for time. File snapshots identify check inputs. Neither a tool call, observation, checkpoint attempt nor snapshot starts or stops the timer.

## Authenticate and inspect

1. Use only the authenticated Plan Time Tracker MCP tools. Call `GetTrackerCapabilities`, then `GetPlanExecutionSnapshot` for the supplied plan ID. Stop on missing tools or authentication failure; never accept `ownerId`, forge identity headers, or use an alternate endpoint.
2. Confirm the requested checkpoint, scope, expected result, required checks, current result revision, attempts and server readiness. Do not choose a plan merely because it is active.
3. Use current tool discovery. Removed repository/synchronization/commit/push tools and fields are unsupported, including replay of old commands. Historical evidence is retained internally and is never a prerequisite for a new result.

## Explicit time and checkpoint lifecycle

- `CreatePlan` only registers a plan. `StartPlan`, `PausePlan`, `ResumePlan` and `FinishPlan` each require direct user intent. Never infer intent from conversation, elapsed time, night, weekend, a turn ending or a tool event. Server timestamps define all interval boundaries.
- A plan must already be `RUNNING` before working on a checkpoint. `PLANNED` and `PAUSED` do not authorize starting or resuming time.
- `CreateStep` takes `planId`, `ordinal`, `title`, `expectedResult` and `requiredChecks`. Do not supply policy fields or repository context. Update only user-authorized checkpoint fields with `UpdateStep` and a reason.
- Claim an attempt only for the assigned checkpoint. Preserve its `attemptId`, `fence` and current step version. Start only that attempt with `StartStep`. Renew its lease about every three minutes. An expired lease cannot be revived; reread the snapshot before recovery. `BlockStep` records a reason without changing plan time.
- Closing an attempt or reaching its lease deadline does not finish the checkpoint or change plan time. Inspect `step.execution` (`state`, `canClaim`, `canStart`, `canRecordResult`) rather than raw RUNNING alone. For an assigned RUNNING plan, recover a closed/expired attempt with a new ClaimStepAttempt and its increased fence, then StartStep; never renew/reuse a closed or expired fence. If a live attempt was claimed but not started, start that attempt. Resolve ambiguous Claim/Start outcomes with the identical envelope or its receipt before any new action. A paused plan needs a separate explicit ResumePlan command.
- Completed checkpoint rework must be assigned by the owner through the web UI with a reason. Do not send `reworkReason` through MCP or treat a failed check as rework authorization.

## Source evidence without a repository

Stop source writers. Run `scripts/source-snapshot.mjs <source-directory>` before checks, then `--expect <digest>` immediately before and after every check. The helper uses no version-control command. Version 2 hashes relative UTF-8 paths, executable modes, symlink target bytes and file contents in deterministic order. It never follows symlinks. It excludes metadata/dependency/build directories and `.env`/`.env.*`; see the helper's default exclusions. Use `.tracker-snapshot.json` with `{ "exclude": ["relative/output-directory"] }` for additional generated outputs. The configuration itself and its policy affect the digest. Keep logs and captures outside the source tree, or explicitly exclude them before capture. Describe excluded environment/dependency inputs separately. The helper detects changes but does not freeze files or run tests.

Record actual execution results with `RecordStepResult`, using the active fenced attempt, `outcome`, a bounded `summary`, and optionally:

```json
{"sourceSnapshot":{"kind":"SOURCE_SNAPSHOT","formatVersion":2,"digest":"sha256:<64 lowercase hex>"}}
```

Omit the helper's local `fileCount`. A source-less result is a truthful report, not check evidence. A changed digest requires a new authorized result revision and rerunning affected checks; never rewrite an immutable result or carry old checks forward. A new result revision needs its own checks even if the digest is unchanged.

`RecordStepResult` returns `resultRevision`. Record each actual `RecordCheck` with that revision, `checkKey`, `status`, `testedSnapshotDigest` equal to the result digest, actual `exitCode` and optional bounded evidence summary/HTTPS URL. `PASSED` requires 0; `FAILED` requires 1–255; `NOT_RUN` omits the exit code. Do not invent passes or claim the server executed tests. Historical checks are audit records; only current-revision checks affect readiness.

## Completion and recovery

Normal finish requires every checkpoint to be `DONE`, have a current successful result, no open attempt, and a latest `PASSED` check for every required key matching that result's source. Use `readyToFinish`, `readinessBlockers` and `currentChecks` (`server_sequence`, `matchesCurrentResult`). A later FAILED/NOT_RUN, rework, a new result revision or an added required key invalidates earlier readiness. An empty required-check list requires no source snapshot. Historical source identities remain immutable and retain their prior check semantics internally; do not reinterpret a historical identity as a new snapshot.

There are no separate approval/waiver commands. Report unmet conditions. Only after separate explicit intent call `FinishPlan`. The owner may choose the existing exception with `allowIncomplete: true` and a nonempty `reason`; this records the exception without passing checks.

Use a version 1 command envelope with a UUID `commandId`, bounded `payload` and the required current `expectedVersion`. For MCP, select the tool by command type rather than sending `commandType`. After an ambiguous response, retry the identical envelope or call `GetCommandReceipt`. Keep command type, version and payload unchanged. PENDING means wait and reread the same receipt; FINAL means use the saved outcome; NOT_FOUND means reread the snapshot before a new user-authorized action. On `VERSION_CONFLICT`, reread and obtain renewed intent when consequential; never automatically replay lifecycle intent with a changed version. Reconnect only through the supported authenticated flow.

## Metadata-only observations and local queue

`AppendObservation` supports turn/tool started/finished, heartbeat, gap and correction events. Keep a stable `sourceId`, a new UUID `sessionId` per client session, monotonic `sourceSequence`, stable UUID `eventId` and exact retry envelopes. Observations are audit metadata and never change time or checkpoint status. Use server receipt sequence for ordering. Never include code, full logs, prompts, credentials or external response bodies.

The optional `scripts/observation-queue.mjs` stores only AppendObservation envelopes. Scope it by `localObservationQueue.ownerScope` returned by capabilities and `planContext` equal to the assigned plan ID. Do not derive owner scope. Enqueue the exact envelope, take the oldest ready event, mark it sent, then call the matching authenticated tool; acknowledge only after success. Preserve IDs on retry and honor `retryable` and `retryAfter` (seconds converted to milliseconds). After five sends, report PENDING; never discard it silently. A manual requeue preserves its original ID. Limits are 1000 events, 5 MiB, seven days, with bounded exponential backoff. The queue never sends requests or accepts lifecycle commands. Existing old-scope files remain untouched; do not automatically replay obsolete observations.

Queue durability is local-only. Cloud/web sessions are ephemeral; report unavailable persistence honestly.

## Report

Report plan/time state, checkpoint/result revision and source digest, actual check outcomes, authoritative readiness and unmet conditions separately. Do not claim hosted operation from local SQLite/browser tests or successful tool discovery. No publication, source-control operation or plan finish is implied by a completed checkpoint.
