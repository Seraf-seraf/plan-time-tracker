# Checkpoint result and check evidence

The server owns readiness. A recorded `DONE` result is an execution outcome, not proof that required checks passed. Step version, result revision, commit SHA and snapshot digest have different meanings. Plan lifecycle and timer intervals remain independent of checkpoint attempts.

Normal finish requires every step to be `DONE`, have a current `DONE` result, have no `OPEN` attempt, and have the latest server-sequence check for every required key `PASSED` for that exact result revision and source identity. A later `FAILED` or `NOT_RUN` invalidates an earlier pass even at the same timestamp. Rework, a new result, and requirement changes never inherit readiness. An empty required-check list adds no source requirement.

## Source identities

Existing commit inputs are preserved: `RecordStepResult.payload.repositoryId` and `revisionSha` are supplied together. `RecordCheck.payload.testedSha` must equal that result's full SHA. The server records client evidence; it does not execute tests, verify Git bytes, create commits or prove publication. Clients must check the actual source identity honestly.

For uncommitted source, supply this mutually exclusive result input:

```json
{
  "worktreeSnapshot": {
    "kind": "WORKTREE_SNAPSHOT",
    "repositoryId": "<attached repository ID>",
    "formatVersion": 1,
    "digest": "sha256:<64 lowercase hex characters>",
    "baseRevisionSha": "<optional full HEAD SHA; context only>"
  }
}
```

Record a check with `testedSnapshotDigest` equal to that digest, and no `testedSha`. Both check modes retain the existing status/exit-code rules: `PASSED` requires exit 0, `FAILED` requires 1–255, `NOT_RUN` has no exit code. Checks may be appended to historical results, but only checks for the current result affect readiness. Do not use a SHA-256 value in a commit-SHA field or use baseline SHA for dirty-tree checks.

A source-less result remains recordable as a truthful report. It cannot satisfy required checks. Migration 0014 does not infer source identities or passing checks from old summaries. Old result/check/approval/receipt history stays immutable. A new source requires a new result through an explicitly authorized attempt; a completed step needs owner-assigned rework. Never silently resume a paused plan or rewrite an old result to attach evidence after the fact.

## Capture and verify source contents

The plugin's `scripts/worktree-snapshot.mjs` runs locally without network access or Git mutations:

```sh
node /path/to/plugin/scripts/worktree-snapshot.mjs /path/to/repository
node /path/to/plugin/scripts/worktree-snapshot.mjs /path/to/repository --expect sha256:<digest>
```

V1 hashes the bytes of every tracked and non-ignored untracked regular file, executable mode, raw path bytes, and symlink target bytes, in byte-sorted path order with length-prefixed fields and the `plan-time-tracker.worktree.v1` domain prefix. Absent tracked files contribute no entry. HEAD and staging metadata are not hashed. Submodules, nested repositories represented as directories and special files are refused. Ignored dependencies, generated outputs, environment variables, databases and runtime state are outside this **source** identity; describe relevant environment and actual check commands in evidence. The digest does not assert that these external inputs are immutable.

The helper reads twice and refuses an unstable capture. Its output contains `kind`, `formatVersion`, `digest`, optional `baseRevisionSha`, and a local `fileCount`. Copy the first four fields into `worktreeSnapshot`, add the attached `repositoryId`, and omit `fileCount` from the API payload. It prints no source content, path manifest or Git stderr.

Stop source writers, capture before checks and verify the same digest immediately before and after each check. Record only actual outcomes for that unchanged source. If content changes, stop attribution, capture the new source and rerun affected checks; do not reuse a previous pass. The helper checks identity; it does not freeze the tree or execute tests. Concurrent writers or inability to capture reliably are explicit limitations, not permission to invent evidence.

Commit/push policy `NEVER` remains compatible with snapshot checks and never authorizes a commit. Snapshot checks do not establish commit creation, remote publication, ref membership or deployment. `commit_created` and `commit_pushed` observations remain separate from check evidence.

## Read and authorization contract

`GetPlan`, `GetActivePlan`, and HTTP plan summaries expose `completion.readyToFinish`, `incompleteStepCount`, and `trackerEnabled`. Snapshot steps expose authoritative `readyToFinish`, latest `currentChecks`, and `readinessBlockers`. Result `source_kind` is `COMMIT`, `WORKTREE_SNAPSHOT` or `NONE`; snapshot results expose `snapshot_digest`, `snapshot_format_version`, and optional `base_revision_sha`. Check `tested_snapshot_digest` and `tested_sha` are mutually exclusive. `matchesCurrentResult` is computed before redaction and must be respected even when protected identities are hidden.

Owner/private-repository protections apply to result history, checks and timeline events. Revoked private access hides repository IDs, digests, baseline/tested SHAs and evidence URLs, without changing authoritative readiness. UI completion controls lead to unmet conditions when blocked. Collapsed cards keep the readiness summary and blocker list visible. Check history labels result revision and current-versus-historical records.

API UI commands remain owner actions. MCP commands remain agent actions. Writing results requires a running plan and a valid started, fenced attempt. Agents record checks only while `RUNNING`; the owner UI can record actual check evidence on `PAUSED` or `COMPLETED` plans. Finishing is allowed from `RUNNING` or `PAUSED` only after separate explicit user intent. The owner exception needs `allowIncomplete: true` and a nonempty reason; it saves unmet conditions, not fictitious checks. Removed approval/waiver commands remain unsupported.

## Regression matrix

| Invariant | Verification |
| --- | --- |
| Four required checks, `NEVER`, no commit | Worker/SQLite snapshot evidence scenario and real browser flow |
| Wrong/missing/mixed source identity | Payload validation, SQL mismatch rejection, immutable snapshot/check constraints |
| Revision and requirement freshness | Rework/new digest/new revision/added required key; old checks retained but not current |
| Latest server order | Same-timestamp later `FAILED` and `NOT_RUN` invalidate earlier pass |
| Receipts and concurrency | Exact replay, changed-payload refusal, rollback on failure, simultaneous claims/start/finish, source result/check race tests |
| Attempts and leases | Started-attempt requirement, expired/fenced/closed denial; live attempt blocks finish |
| Pause/finish and exception | UI/MCP actor distinction, cancel sends no command, duplicate click writes once, owner reason required |
| Private access and owner isolation | Snapshot/check/timeline redaction, authoritative readiness after revocation, foreign-owner denial |
| Migration/history | Populated 0013→0014 upgrade preserves rows; no automatic conversion of old prose |
| Client capture | Staged/unstaged/untracked/deleted bytes, executable mode, symlinks, deterministic digest, changed-source refusal, no commit/index mutations |
| UI state and retries | Badge/count/source explanation, result revision labels, mobile layout, drafts/collapse, unknown outcomes, final receipts and cancellation |

Local SQLite and intercepted browser tests do not emulate hosted D1 scheduling or Sites identity middleware. Publication is followed by read-only live MCP/UI verification; real plans are never finished and old checks are never fabricated for a smoke test.

## Publication and rollback

Deploy schema-only migration 0014 with the reviewed Worker bundle. Before activation, compare the published Site source with the GitHub base and preserve any independent changes. A failed upload may still leave the additive migration applied; it does not attest old reports. Once new snapshot evidence exists, rollback code must understand the new evidence views and fields. Do not reverse the migration or publish an older UI that reads only commit checks. Prefer a reviewed forward repair if necessary.
