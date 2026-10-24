---
name: plan-time-tracker
description: Register plans, steps and assessments during planning; track authorized execution, continuation, results and checks through authenticated MCP.
---

# Track every authorized plan execution

Use this skill for `/plan`, ordinary planning, assessment, execution and continuation of an authorized task even without a tracking request. Register or update the plan, substantial checkpoints and assessments during planning using the independent `assess-task` skill supplied in this plugin. A single task needs at least one verifiable checkpoint. Future implementation stays PLANNED: planning never calls StartPlan/StartStep, implements the task or starts time. Reference answers and tracker maintenance do not create recursive plans. A request to execute a specific plan authorizes registration when needed and StartPlan; a request to continue a known paused plan authorizes ResumePlan. No separate tracker opt-in or start confirmation is required. MCP is the command transport; the server's work intervals are the source of truth for time. File snapshots identify check inputs. Neither a tool call, observation, checkpoint attempt nor snapshot starts or stops the timer.

## Authenticate and inspect

1. Use only authenticated Plan Time Tracker MCP tools. Call `GetTrackerCapabilities`; require `parallelPlans`, the `ListPlans` contract and `assessments` for assessment. Discover support from capabilities and tools, not product version comparisons. Missing tools, incompatible capabilities or authentication failure block required accounting: report the blocker, do not claim recorded time or invent records, and pause dependent work until access is restored while honoring the user's existing exceptions. Never accept `ownerId`, forge identity headers or use an alternate endpoint.
2. Bind the user's intended work to an explicit `planId`. For a supplied ID, read `GetPlanExecutionSnapshot`. Otherwise use read-only `ListPlans` with `statuses` and follow every `nextCursor` needed to identify the intended plan; use RUNNING, PAUSED and PLANNED as appropriate. Match the user's known identity, scope or reference, never the first active plan or title alone when ambiguous. If identity is ambiguous, clarify before a write. Continue a known plan without creating a duplicate. If this is new authorized planning, assessment or execution, register it once with `CreatePlan` using its real title/scope/date, preserve the returned ID (recover an unknown response via its exact command receipt), then read its snapshot.
3. Confirm the requested checkpoint, scope, expected result, required checks, current result revision, attempts and server readiness. `GetPlan` and `GetPlanExecutionSnapshot` always take the bound `planId`.
4. Use current tool discovery. Removed repository/synchronization/commit/push tools and fields are unsupported, including replay of old commands. Historical evidence is retained internally and is never a prerequisite for a new result.

## Explicit time and checkpoint lifecycle

- `CreatePlan` only registers a plan. On the user's request to execute that specific plan, call `StartPlan` when PLANNED; on their request to continue that specific paused plan, call `ResumePlan`. These requests already provide the required lifecycle intent. An already RUNNING plan needs neither registration nor another start. A completed plan is not silently duplicated or reopened.
- `PausePlan` and `FinishPlan` still require the user's corresponding intent. A completed answer, silence, observations, elapsed time, night, weekend, a tool event or an expired attempt lease never changes intervals. Server timestamps define all interval boundaries.
- Confirm the bound plan is `RUNNING` before working on its checkpoint. Never pause or finish another plan to free a global slot: several plans may be RUNNING together.
- `CreateStep` takes `planId`, `ordinal`, `title`, `expectedResult` and `requiredChecks`. Do not supply policy fields or repository context. Record substantial new steps and scope changes before work. Update fields within the authorized scope with `UpdateStep` and a reason. Confirm writes before execution; promptly record results, blockers and checks before moving on. An unconfirmed write is not success.
- Claim an attempt only for the assigned checkpoint. Preserve its `attemptId`, `fence` and current step version. Start only that attempt with `StartStep`. Renew its lease about every three minutes. An expired lease cannot be revived; reread the snapshot before recovery. `BlockStep` records a reason without changing plan time.
- Closing an attempt or reaching its lease deadline does not finish the checkpoint or change plan time. Inspect `step.execution` (`state`, `canClaim`, `canStart`, `canRecordResult`) rather than raw RUNNING alone. For an assigned RUNNING plan, recover a closed/expired attempt with a new ClaimStepAttempt and its increased fence, then StartStep; never renew/reuse a closed or expired fence. If a live attempt was claimed but not started, start that attempt. Resolve ambiguous Claim/Start outcomes with the identical envelope or its receipt before any new action. A paused plan needs ResumePlan authorized by the user’s request to continue that plan.
- Completed checkpoint rework must be assigned by the owner through the web UI with a reason. Do not send `reworkReason` through MCP or treat a failed check as rework authorization.

## Удаление и восстановление

Вызывайте `DeletePlan` или `RestorePlan` только по отдельной явной просьбе пользователя для конкретного `planId`. Требуйте `planDeletion.softDelete` в `GetTrackerCapabilities`, перечитайте `GetPlan` и передайте текущую `expectedVersion` в стандартном конверте версии 1 с новым UUID `commandId` и `payload: {planId, reason?}`. Не удаляйте план вместо паузы или завершения и не восстанавливайте его автоматически. При неизвестном результате сохраняйте точный конверт и используйте прежний `commandId` или `GetCommandReceipt`; при конфликте версии сначала перечитайте состояние и уточните намерение.

`DeletePlan` закрывает активный интервал и OPEN-попытки, не удаляя историю. RUNNING переходит в PAUSED, исполнявшиеся этапы — в BLOCKED, старые fence становятся недействительны. `RestorePlan` не запускает таймер и не возобновляет попытки: продолжение требует отдельного намерения и новой попытки. Сохраняйте контексты остальных планов без изменений.

`ListPlans` по умолчанию скрывает удалённые планы; `deleted: true` показывает только их с обычной пагинацией. Удалённый план можно читать по явному ID, но нельзя изменять до восстановления. Если `deletedAt` не null или команда вернула PLAN_DELETED, сообщите об удалении и остановите работу по этому плану. Не создавайте дубликат и не пытайтесь оживить прежнюю аренду. Наблюдения из локальной очереди для удалённого плана не воспроизводите автоматически. Аналитика не включает удалённые планы; восстановление возвращает их сохранённые интервалы в отчёты.

## Independent parallel contexts

For handoff include planId/stepId, assessmentId/revision, result criteria/checks, method/scale, chosen approach, assumptions, measured time with metric and limitations, and remaining forecast. Continue existing context without duplicates. The executor may revise an assessment with a reason while retaining baseline. Use assess-task for neutral RecordAssessment/GetAssessment/GetEstimationHistory; complexity, duration and implementation choice belong to the agent. No other plugin or local executor is needed for assessment.

Maintain a separate execution context per `planId`: assigned checkpoint/step ID, plan version and step version, attempt ID/fence, current result revision/digest, session/source sequencing, pending exact command envelopes and observation queue. Every executor, including a subagent, receives an explicit plan/checkpoint binding; never choose a “current” plan globally. A command, recovery, completion or check for A must not alter or borrow B's state, attempt, result, checks or readiness.

Use isolated source directories for concurrent writers, or coordinate writes and stop all writers while capturing snapshots and running checks. Verify the same digest before and after every check. A changed shared-source snapshot cannot attest a passed check for either context; record truthful outcomes, capture a new authorized result revision and rerun affected checks. Do not reuse another plan's evidence merely because its check key or digest matches.

`ListPlans` returns `{plans, nextCursor, serverNow}` with optional nonempty unique `statuses`, `limit` 1–100 (default 50), and opaque `cursor` from `nextCursor`. Order is registeredAt descending then planId descending; continue until `nextCursor` is null. Filter RUNNING to discover all active plans, PAUSED/PLANNED to find known work for continuation. Listing is read-only and never changes time.

Analytics count each plan's own intervals normally. Owner-wide `totalActiveMs` and `activeByDay` are unique elapsed work time (the union of intervals across plans); `sumPlanActiveMs` is the separate sum of plan durations and may be larger. All durations are milliseconds.

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

Report each bound plan/time state separately, checkpoint/result revision and source digest, actual check outcomes, authoritative readiness and unmet conditions separately. Do not claim hosted operation from local SQLite/browser tests or successful tool discovery. No publication, source-control operation or plan finish is implied by a completed checkpoint.

MCP cannot discover local client plans unless that client calls it. Mandatory tracking is a connected-client instruction, not a platform-wide interception guarantee.
