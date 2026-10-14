---
name: track-plan
description: Work on explicitly assigned Plan Time Tracker checkpoints using its authenticated owner-scoped MCP tools.
---

# Track an explicitly assigned plan

Use this skill only when the user names the plan or checkpoint to work on. The timer belongs to the plan. Checkpoint progress, attempts, test results, owner acceptance, and commit publication are separate records.

## Before acting

1. Confirm that the current client exposes the authenticated Plan Time Tracker MCP tools. If a tool is absent or authentication fails, stop and report that limitation. Never call an unauthenticated endpoint, accept an `ownerId`, create a grant, or work around platform authorization.
2. Call `GetTrackerCapabilities`, then `GetPlanExecutionSnapshot` for the plan ID explicitly supplied by the user. Do not select a plan just because it is active. Use only the returned `localObservationQueue.ownerScope` for the local queue; never derive a scope from an email, username, or user-supplied owner ID.
3. Confirm the plan, checkpoint, repository, requested scope, status, expected result, required checks, commit policy, push policy, current result revision, attempts, and acceptance state. Ask the user when a required decision is missing.
4. A plan must already be `RUNNING` before starting a checkpoint. `PLANNED` or `PAUSED` never implies permission to start or resume it.

## Explicit lifecycle and checkpoint flow

- `CreatePlan` only registers a plan. Before `StartPlan`, `PausePlan`, `ResumePlan`, or `FinishPlan`, require a direct user instruction for that transition. Conversation context, elapsed time, calendar, hooks, turn completion, tool calls, and commits are not lifecycle intent.
- Create or update checkpoints only in the scope the user approved. Checkpoint status moves through explicit `StartStep`, `BlockStep`, or `RecordStepResult` commands. `DONE` means the agent reported completion; it does not mean the owner accepted it.
- Claim an attempt only after the plan and checkpoint are confirmed. Preserve the returned `attemptId` and `fence`; use the current checkpoint version for versioned commands. Start only the attempt just claimed. Renew the lease about every three minutes while connected; a lease that expired cannot be revived. After interruption, reread the snapshot and receipt before deciding what the user should authorize next.
- A completed checkpoint cannot be reopened by an agent claim. The owner must assign rework through the owner UI with a reason. Do not send `reworkReason` through MCP or infer permission from a rejection.
- Run requested checks before reporting the result. Record the actual exit status and full tested SHA. Then call `RecordStepResult` to obtain a result revision and `RecordCheck` for each check against that revision. A check passes only when its exit code is zero and its tested SHA matches the result revision SHA. Never invent a SHA when it is unavailable.
- `AcceptStep` and `RejectStep` are explicit owner decisions tied to the current result revision. Call either only after a direct user instruction. A required check can be waived only by an explicit owner waiver with a reason; preserve the waiver in the report.
- Finish the plan only after a separate direct instruction. If checkpoints remain incomplete, report that the owner must either complete them or explicitly finish with a reason. Do not call `FinishPlan` merely because all agents reported `DONE`.

## Reliable commands and recovery

- Use the shared command envelope: `schemaVersion: 1`, a UUID `commandId`, the exact tool name as `commandType` for API calls, optional required `expectedVersion`, and a bounded `payload`. For MCP, select the tool named by `commandType` and pass the same fields except `commandType`; tool selection supplies it. Never provide `ownerId`.
- If a write has an ambiguous network result, retry with the same `commandId`, command type, expected version, and byte-for-byte equivalent payload. Alternatively call `GetCommandReceipt` with that ID. For `PENDING`, wait and check the same receipt again. For `FINAL`, use the saved result. For `NOT_FOUND`, reread the snapshot before deciding whether a new user-authorized action is appropriate. Never automatically replace a stale expected version and replay a lifecycle command.
- On `VERSION_CONFLICT`, reread the snapshot and ask for renewed intent if the action is consequential. On revoked authentication, stop writes and reconnect only through the supported client flow.
- Append observations only as bounded metadata. Keep one stable `sourceId`, a new UUID `sessionId` per client session, monotonic per-session `sourceSequence`, and stable UUID `eventId`. Retry the exact envelope after a lost acknowledgement. Gaps, late delivery, stale executors, and corrections remain audit events; they do not change checkpoint status, plan status, or timer intervals.
- The durable observation queue is local-client-only and scoped by the returned opaque owner scope plus a repository ID or `owner/name` context. Use `scripts/observation-queue.mjs` from the installed plugin package when it is available. It stores only `AppendObservation` envelopes outside the tracked repository, up to 1000 events, 5 MiB, and 7 days; it rejects lifecycle commands and metadata outside the event allowlist. Never pass a Git remote URL as repository context.
- For local delivery, enqueue the exact envelope, ask the queue for its oldest ready item, mark that item sent, then call the matching authenticated MCP tool with the same payload and `commandId`. Acknowledge only after a successful response. After a transient failure, record the MCP `retryable` value and `retryAfter` (convert seconds to milliseconds); the helper schedules exponential backoff with jitter, capped at 30 seconds, while honoring a longer `Retry-After`. Process observations in FIFO order. After five send attempts, the item is visibly `PENDING`; report it and do not silently discard it. A manual requeue preserves the original envelope and `commandId`.
- The helper stores files only on the local machine. Web/cloud sessions are ephemeral and must not be described as durably queued. If the local helper or writable local state is unavailable, say that persistence is unavailable and keep retry status explicit. Never automatically replay queued lifecycle actions; the queue accepts observations only.
- Do not include source code, full logs, prompts, credentials, tokens, authorization headers, or full external responses in observation data. Do not treat `occurredAt` as authoritative time. Server `receivedAt` and `serverSequence` determine audit order.
- `commit_created` is local evidence. `commit_pushed` is an observation, not proof of remote publication. Report a push as verified only when an owner-authorized read/sync confirms repository ID, full SHA, and ref. Unknown or partial synchronization stays unknown/partial. A failed push is not publication.

## Report and stop

Report checkpoint status, result revision and SHA, each check with its actual result, current acceptance, commit state, and publication state separately. State any missing tool, auth, repository, or verification evidence. Do not claim hosted operation from local tests or from a successful tools list.

Example command envelopes and recovery states are in [`fixtures/recovery-cases.json`](fixtures/recovery-cases.json).
