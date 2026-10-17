# Plan Time Tracker

The tracker records work time through explicit authenticated MCP commands and the owner UI. `CreatePlan` registers a plan; only Start/Pause/Resume/Finish change server-timed intervals. Observations, tools, attempts and source changes never accrue or stop time on their own. One owner may run several plans at once. Start/Resume/Pause/Finish only affect the supplied planId. Calendar/active/paused durations remain per-plan. The connected skill requires tracking for every actual authorized plan execution; drafting alone does not register or start a plan.

The current contract removes repository management/filters, synchronization, commit attribution, commit/push policies and Git observations. It requires no external integration token. GitHub source publication does not deploy the Worker or update installed tools.

## Analytics by plan section

The «Трекер планов» Analytics page preserves the period metrics and day bars. Each plan expands to a section chart in ordinal order. Its read-only web endpoint is `GET /api/analytics/plans/:planId/steps?from=YYYY-MM-DD&to=YYYY-MM-DD&timeZone=...&asOf=...`; section details retain their per-plan semantics; owner-wide totals use the v3 union semantics below. Owner authorization and inclusive local-date boundaries use the existing Worker behavior. `asOf` limits counted time and section membership (`created_at <= asOf`) to the accepted period report; titles and ordinals use their current values, not reconstructed historical metadata. A snapshot before the first start remains unmeasured even if the plan starts later; the exact start timestamp can be measured zero.

Section values are intersections of real `work_intervals` with server-confirmed `STEP_STARTED` execution windows, ending at attempt closure or lease expiry. Claim timestamps are not execution starts. All attempts are considered, pauses excluded, and each active millisecond is counted once. Overlaps between different sections and time with no confirmed section remain unattributed; they are never divided between sections. Each section also exposes `ambiguousMs`: if all its active time overlaps another section, `activeMs` is `null` («—») with an uncertainty explanation; if only part overlaps, `activeMs` contains only the unambiguous portion, marked «*» and described as incomplete in the tooltip and accessible label. Per-section ambiguous values describe uncertainty and must not be summed as allocated time. An absent start or missing plan intervals also returns `null`, while a confirmed window with no active time and no overlap in the period returns measured zero. The chart shows minutes from zero, with exact milliseconds and complete section names available by hover, keyboard and touch. The existing median still uses full active durations of plans completed in the selected period.

## Checks and source identity

Create checkpoints with title, ordinal, expected result and required check keys. Claim/start a fenced attempt, record its result revision, then record actual required checks for that revision. New evidence uses `sourceSnapshot: {kind:"SOURCE_SNAPSHOT",formatVersion:2,digest:"sha256:<64 lowercase hex>"}` and `RecordCheck.testedSnapshotDigest` with actual exit status. See [the complete contract](../../docs/worktree-evidence.md) and [bundled agent instructions](skill/plan-time-tracker/SKILL.md).

Normal finish is guarded by current successful results, closed attempts and the latest server-sequence passed checks. A new result, rework, an added required key or a later failed/not-run check invalidates prior readiness. A result without source cannot satisfy required checks. Empty required-check lists add no source requirement. The explicit owner exception requires a reason and never fabricates passes.

## Parallel plans and analytics contract (3.0.0)

`ListPlans` and `GET /api/plans` return `{plans, nextCursor, serverNow}`. MCP accepts `statuses` (a nonempty unique array of PLANNED/RUNNING/PAUSED/COMPLETED), integer `limit` 1–100 (default 50), and an opaque `cursor` from `nextCursor`. HTTP uses comma-separated `statuses`, `limit` and URL-encoded `cursor`. Results order by registeredAt descending then planId descending. Pagination uses that stable key, not an offset; concurrent inserts ahead of the cursor do not displace later pages. Filters apply on every page; this is a live list, not an immutable snapshot. All reads remain owner-scoped. RUNNING may return any number of plans. The singular active-plan MCP tool and web endpoint are removed. `GetTrackerCapabilities` advertises `parallelPlans`, `planList` and analytics units/semantics. GetPlan and execution snapshots require an explicit planId.

`totalActiveMs` and `activeByDay` count the union of clipped owner intervals, split by inclusive local calendar days at one server `asOf`. `sumPlanActiveMs` separately sums the plan durations in that period, while `activeInPeriodMs`, `fullActiveMs`, checkpoint attribution and the median remain per-plan. Example: A 10:00–11:00 and B 10:30–11:30 each have 60 minutes; sum 120, unique total 90. The UI shows all active cards with independent actions/timers, unique time today, and both period metrics. Server time is aligned to client receipt time for display; a client clock offset never adds work time.

## Fresh installation and retained history

Version 3.0.0 targets a new empty database. Apply canonical migrations in order through `0015_source_snapshots.sql`; the revised `0001_initial.sql` permits parallel RUNNING plans from creation. One open interval and nonoverlapping intervals per plan remain enforced. There is no upgrade path from a deployed single-plan database in this patch and no extra migration for dropping the old constraint. Do not apply only the revised Worker to that database. A future release must provision an empty database and deploy the matching Worker/package deliberately; source publication does not reset existing data or deploy anything.

Other historical migrations/tables and historical documents under `docs/` are retained. Existing local historical-schema tests cover those structures on the revised fresh-install chain; they do not attest upgrade support for the old single-plan deployment. Historical evidence semantics and public redaction remain unchanged. Do not deploy an older Worker against v3 data.

## Local verification

```sh
npm test
npm run validate
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/usr/bin/chromium UI_ACCEPTANCE_ARTIFACT_DIR=/tmp/tracker-source-ui npm run test:ui
node --test ../../plugin/plan-time-tracker/test/*.test.mjs
```

`npm test` builds the ignored Worker artifact and runs mandatory timer, owner, idempotency, concurrency, migration, evidence and VM UI-contract tests. Browser suites intercept every localhost request and execute the actual Worker with migrated in-memory SQLite. External requests are forbidden. They cover responsive navigation, modal focus, exact replay after lost acknowledgement, source results/checks, completion conditions, cancelled and duplicate finish. These are local tests, not hosted D1/authentication or production-data QA. No dependencies are added by the tests.

Execution snapshots distinguish raw checkpoint state from executor availability through step.execution. A RUNNING checkpoint with a closed/expired attempt needs recovery; it is not actively executing. The owner UI exposes fresh-attempt recovery and pending-attempt Start, using server-aligned lease time and read-only refresh. Recovery leaves plan intervals intact; a paused plan requires an explicit ResumePlan. Historical retired-command receipts expose only safe audit identity/outcome/time and preserve raw stored data.
