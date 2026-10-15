# Plan Time Tracker

The tracker records work time through explicit authenticated MCP commands and the owner UI. `CreatePlan` registers a plan; only Start/Pause/Resume/Finish change server-timed intervals. Observations, tools, attempts and source changes never accrue or stop time on their own. One owner can run one plan at a time. Calendar/active/paused time and inclusive-date analytics use the existing server interval model.

The current contract removes repository management/filters, synchronization, commit attribution, commit/push policies and Git observations. It requires no external integration token. This change is local and pending review; it has not been pushed or deployed.

## Analytics by plan section

The «Трекер планов» Analytics page preserves the period metrics and day bars. Each plan expands to a section chart in ordinal order. Its read-only web endpoint is `GET /api/analytics/plans/:planId/steps?from=YYYY-MM-DD&to=YYYY-MM-DD&timeZone=...&asOf=...`; the existing analytics response and MCP contract are unchanged. Owner authorization and inclusive local-date boundaries use the existing Worker behavior. `asOf` limits counted time and section membership (`created_at <= asOf`) to the accepted period report; titles and ordinals use their current values, not reconstructed historical metadata. A snapshot before the first start remains unmeasured even if the plan starts later; the exact start timestamp can be measured zero.

Section values are intersections of real `work_intervals` with server-confirmed `STEP_STARTED` execution windows, ending at attempt closure or lease expiry. Claim timestamps are not execution starts. All attempts are considered, pauses excluded, and each active millisecond is counted once. Overlaps between different sections and time with no confirmed section remain unattributed; they are never divided between sections. Each section also exposes `ambiguousMs`: if all its active time overlaps another section, `activeMs` is `null` («—») with an uncertainty explanation; if only part overlaps, `activeMs` contains only the unambiguous portion, marked «*» and described as incomplete in the tooltip and accessible label. Per-section ambiguous values describe uncertainty and must not be summed as allocated time. An absent start or missing plan intervals also returns `null`, while a confirmed window with no active time and no overlap in the period returns measured zero. The chart shows minutes from zero, with exact milliseconds and complete section names available by hover, keyboard and touch. The existing median still uses full active durations of plans completed in the selected period.

## Checks and source identity

Create checkpoints with title, ordinal, expected result and required check keys. Claim/start a fenced attempt, record its result revision, then record actual required checks for that revision. New evidence uses `sourceSnapshot: {kind:"SOURCE_SNAPSHOT",formatVersion:2,digest:"sha256:<64 lowercase hex>"}` and `RecordCheck.testedSnapshotDigest` with actual exit status. See [the complete contract](../../docs/worktree-evidence.md) and [bundled agent instructions](skill/plan-time-tracker/SKILL.md).

Normal finish is guarded by current successful results, closed attempts and the latest server-sequence passed checks. A new result, rework, an added required key or a later failed/not-run check invalidates prior readiness. A result without source cannot satisfy required checks. Empty required-check lists add no source requirement. The explicit owner exception requires a reason and never fabricates passes.

## Migration and history

Apply canonical migrations in order, through `0015_source_snapshots.sql`. 0015 only adds source-snapshot/check tables and replaces evidence/readiness views and result/check triggers. It does not delete or update existing application rows. Historical COMMIT and WORKTREE_SNAPSHOT identities and checks retain internal semantics, including protected-source redaction and finish readiness. The public UI/API shows their history without repository/SHA controls. New work uses v2 snapshots; it does not convert old evidence automatically. Removed commands refuse even cached old receipts; receipts remain readable as audit records.

Do not reverse migrations or deploy the old Worker after creating v2 evidence. Publication requires the reviewed Worker and migration together. Existing historical documents under `docs/` describe earlier requirements/publications, not the current contract. The source Git repository and its metadata are retained.

## Local verification

```sh
npm test
npm run validate
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/usr/bin/chromium UI_ACCEPTANCE_ARTIFACT_DIR=/tmp/tracker-source-ui npm run test:ui
node --test ../../plugin/plan-time-tracker/test/*.test.mjs
```

`npm test` builds the ignored Worker artifact and runs mandatory timer, owner, idempotency, concurrency, migration, evidence and VM UI-contract tests. Browser suites intercept every localhost request and execute the actual Worker with migrated in-memory SQLite. External requests are forbidden. They cover responsive navigation, modal focus, exact replay after lost acknowledgement, source results/checks, completion conditions, cancelled and duplicate finish. These are local tests, not hosted D1/authentication or production-data QA. No dependencies are added by the tests.

Execution snapshots distinguish raw checkpoint state from executor availability through step.execution. A RUNNING checkpoint with a closed/expired attempt needs recovery; it is not actively executing. The owner UI exposes fresh-attempt recovery and pending-attempt Start, using server-aligned lease time and read-only refresh. Recovery leaves plan intervals intact; a paused plan requires an explicit ResumePlan. Historical retired-command receipts expose only safe audit identity/outcome/time and preserve raw stored data.
