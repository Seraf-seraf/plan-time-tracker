# Source snapshots and current-result evidence

This contract supersedes the earlier Git-dependent v1 workflow. Time is determined exclusively by explicit plan commands and server work intervals. MCP is the transport for intent and audit metadata; neither source activity nor observations drive lifecycle.

## Repository-free source v2

`RecordStepResult` accepts `sourceSnapshot: {kind:"SOURCE_SNAPSHOT",formatVersion:2,digest:"sha256:<64 lowercase hex>"}`. No repository identifier, baseline or commit field is accepted. Source-less reports remain possible, but cannot satisfy required checks.

Run `plugin/plan-time-tracker/scripts/source-snapshot.mjs <source-directory>` with source writers stopped. Repeat with `--expect <digest>` immediately before and after every check. A mismatch requires fresh result attribution and rerunning affected checks. The helper does not execute tests, freeze files or prove provenance; the client must report truthfully. It works in ordinary directories with no Git installation.

Version 2 hashes a domain separator, explicit exclusion policy, UTF-8 relative paths in byte order, regular/symlink file kind, executable mode and SHA-256 of bytes or symlink targets. Symlinks are never followed. Deletions, new/renamed paths, contents, executable changes and target changes affect the identity. Invalid UTF-8 names and special files are refused. Two captures must match. Missing/inaccessible files produce a sanitized failure rather than partial evidence.

Default excluded path segments at any depth: `.git`, `.hg`, `.svn`, `node_modules`, `.venv`, `venv`, `__pycache__`, `.next`, `dist`, `build`, `coverage`, `.cache`, `.wrangler`. `.env` and `.env.*` names are excluded. These environment, dependency and generated inputs are separate check context. Ignore files do not determine source scope. For custom outputs create `.tracker-snapshot.json` with only `{"exclude":["relative/output-directory"]}` (up to 100 exact relative paths). No absolute/parent paths, wildcard matching or excluding the configuration itself. The configuration bytes and policy are part of the identity. Keep test logs/screenshots/queue files outside the source root or exclude them before capture. Do not exclude relevant source inputs.

The local helper returns `fileCount` for diagnostics; omit it from the strict API source object. A format-v2 digest cannot be substituted for historical v1 evidence even if source bytes happen to match: the domain and source-scope rules differ.

## Checks and completion

Checks name `stepId`, `resultRevision`, `checkKey`, `status` and matching `testedSnapshotDigest`. PASSED requires exit 0; FAILED requires 1–255; NOT_RUN omits exitCode. Historical checks may be appended as audit, but only checks for the current result count. The latest server sequence wins at equal timestamps. Every new result revision needs new check records even if digest is unchanged. Rework/open attempts and newly required keys also invalidate finish readiness.

Use authoritative `readyToFinish`, `readinessBlockers`, `currentChecks.server_sequence` and `matchesCurrentResult`; never infer from display order, a result marked DONE or a prior pass. Required-check-free results need no source. Normal Finish requires all steps ready; the explicit allowIncomplete exception records a reason without changing checks. Plan Finish always requires separate user intent.

## Historical compatibility

Migration 0015 retains every historical row and receipt. Existing COMMIT and WORKTREE_SNAPSHOT v1 evidence keeps its internal exact-identity/readiness semantics and protected-source redaction. Public reads show a historical source label; permitted old snapshot digests remain available for their checks, while repository/SHA controls are removed. No old prose report is auto-attested. No new result can use the legacy Git fields. A historical COMMIT needing rework must get a new authorized attempt/result and v2 snapshot; existing passes are not copied.

Old Git commands and routes refuse before mutation, including receipt replay. The source repository and `.git` are not removed. Historical database tables remain for audit and compatibility, without synchronization or cache-deletion endpoints.

## Verification boundaries

Mandatory local suites exercise fresh and populated migrations, row preservation, exact replay, deduplication, stale digest/result refusal, same-timestamp invalidation, source-less gates, transaction rollback, timer concurrency, owner isolation and private historical redaction. Chromium suites use real Worker+SQLite through intercepted localhost routes and forbid production traffic. Helper tests run without Git or PATH executables. Passing these does not attest hosted D1, private Site authentication or installed MCP schemas.
