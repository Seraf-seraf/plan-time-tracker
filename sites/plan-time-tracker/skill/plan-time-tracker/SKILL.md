# Plan Time Tracker command protocol (draft)

This file describes the intended agent instructions for a future Site-connected skill. It is not evidence that a Site MCP client can currently connect. The skill must remain marked **unverified** until the private Site's deployed MCP endpoint is exercised end to end with real platform authentication.

## Rules for agents

- Use the authenticated Site MCP tools for reads and writes. Never put or accept `ownerId` in command payloads; Sites identity determines ownership.
- Plan registration does not start its timer. Ask for explicit intent before each Start, Pause, Resume, or Finish. Never infer a transition from conversation, elapsed time, calendar, night, or weekend.
- Do not treat commit count, commit timestamps, or repository activity as time spent or progress. Only server-created work intervals define active time.
- Preserve a command envelope's `commandId` when retrying after an ambiguous network result. A retry with the same ID must preserve the exact command type, expected version, and payload. If changing any value, create a new command ID after rereading current state.
- On `VERSION_CONFLICT`, reread the plan and ask the user to confirm a new action when needed. Never automatically replay a transition with a new version.
- A `SOURCE_UNAVAILABLE`, `RATE_LIMITED`, or partial-sync result must be described as incomplete. Do not imply that GitHub was synchronized.
- Attribute commits only through a full `Plan-ID: <UUID>` marker in a selected repository/ref or explicit user-reviewed attribution. Time overlap is a candidate only. Honor exclusions.

## Common write envelope

For lifecycle and metadata commands, call the MCP tool named by `commandType` with:

```json
{
  "schemaVersion": 1,
  "commandId": "<new UUID; retain it for a retry>",
  "expectedVersion": 3,
  "payload": { "planId": "<plan UUID>" }
}
```

`CreatePlan` omits `expectedVersion`. Its payload includes `title`, explicit `planCreatedAt` (`instant` with an offset timestamp or `dateOnly` with IANA `timeZone`), and optionally description, acceptance criteria, repository IDs and refs. Creating a plan leaves it `PLANNED`.

To bind another owned, currently available repository to an existing plan, call `AttachPlanRepository` with the normal write envelope, the plan's current `expectedVersion`, and `payload: { "planId": "<plan UUID>", "repositoryId": "<repository ID>" }`. A successful response returns the new plan version and a `REPOSITORY_ATTACHED` event is recorded atomically; the command does not start, pause, or finish the plan or change its timer, intervals, attempts, or leases. Retry an ambiguous result with the exact same envelope. On `VERSION_CONFLICT`, reread the plan before deciding whether to issue a new command ID and version. Foreign or unavailable repositories return `REPOSITORY_UNAVAILABLE`; an existing binding returns `REPOSITORY_ALREADY_ATTACHED`.

For `RecordStepResult`, a repository SHA can be recorded only after that repository is attached to the plan and the current fenced attempt has a `STEP_STARTED` event. `REPOSITORY_NOT_ATTACHED` and `STEP_NOT_STARTED` are distinct definitive failures. A recovery must use a new claim/attempt and start that attempt; never rewrite an earlier closed attempt or result. `RenewStepLease` accepts an optional `expectedVersion`; when supplied, the server enforces it and reports stale versions as `VERSION_CONFLICT`.

There is no separate checkpoint revision approval or check waiver workflow. Normal `FinishPlan` requires every checkpoint to be `DONE`, have a current result revision and no active attempt, and have the latest server-sequence record for every required check `PASSED` on that revision with the matching tested SHA. Use snapshot step fields `readyToFinish` and `currentChecks` (`server_sequence`, `matchesCurrentResult`), not check timestamps or display order, to choose the current check. A later failed/not-run check, rework, a new result, or an added required key invalidates earlier readiness. An empty required-check list adds no SHA requirement. Read the server-reported readiness before requesting an explicit Finish decision.

The existing exception path remains an explicit `FinishPlan` payload with `allowIncomplete: true` and a nonempty `reason`; it records why the user finished with unmet conditions and does not mark those checks as passed. Historical approval/waiver rows remain inert audit records. `AcceptStep` and `RejectStep` are removed commands, explicitly refused without mutation even when an old receipt exists; clients must refresh their tool schemas rather than call an alias or no-op.

Lifecycle tools: `StartPlan`, `PausePlan`, `ResumePlan`, `FinishPlan`. The Site server supplies all event/interval timestamps. Use `GetActivePlan` and `GetPlan` to obtain the latest plan version. Use `GetAnalytics` with inclusive `from`/`to` calendar dates and IANA timezone.

`SyncRepository` is a separate envelope with `payload.fullName` (`owner/repo`) and optional `cursor`, `ref`, `fullRescan`, and `authorGithubIds`. Candidate filtering uses stable numeric GitHub author IDs; an empty list allows all identified authors. Unknown authors are not time candidates, and author and committer identities remain separate. Bot labels remain visible for linked commits. Sync is only usable after Site runtime GitHub access is configured and verified. `ReviewCommitLink` requires `repositoryId`, full SHA, status (`confirmed`, `candidate`, `excluded`) and a nonempty reason.

## Verification gate

Before calling the skill operational, verify Site auth identity, owner isolation, D1 atomicity/idempotency, private GitHub reads and pagination, MCP/UI shared behavior, secret handling/revocation, and deployment operations. These G1–G6 checks are currently not all passed.
