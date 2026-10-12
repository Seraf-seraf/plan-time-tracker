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

Lifecycle tools: `StartPlan`, `PausePlan`, `ResumePlan`, `FinishPlan`. The Site server supplies all event/interval timestamps. Use `GetActivePlan` and `GetPlan` to obtain the latest plan version. Use `GetAnalytics` with inclusive `from`/`to` calendar dates and IANA timezone.

`SyncRepository` is a separate envelope with `payload.fullName` (`owner/repo`) and optional `cursor`, `ref`, `fullRescan`, and `authorGithubIds`. Candidate filtering uses stable numeric GitHub author IDs; an empty list allows all identified authors. Unknown authors are not time candidates, and author and committer identities remain separate. Bot labels remain visible for linked commits. Sync is only usable after Site runtime GitHub access is configured and verified. `ReviewCommitLink` requires `repositoryId`, full SHA, status (`confirmed`, `candidate`, `excluded`) and a nonempty reason.

## Verification gate

Before calling the skill operational, verify Site auth identity, owner isolation, D1 atomicity/idempotency, private GitHub reads and pagination, MCP/UI shared behavior, secret handling/revocation, and deployment operations. These G1–G6 checks are currently not all passed.
