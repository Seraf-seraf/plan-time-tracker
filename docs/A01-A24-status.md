> Historical report. Git integration requirements and publication status below are superseded by the current [source/MCP contract](worktree-evidence.md). Retained for audit; this file does not authorize current Git tools or deployment.

# A01–A24 acceptance status (local implementation)

The complete normative Library file is preserved at [docs/originals/plan_time_tracker_requirements.txt](originals/plan_time_tracker_requirements.txt) (SHA-256 `36b96a84e6430629378d51cf77c660c37f7963c6033c7cd5d74984040994fa48`). “Local pass” means a local SQLite/Worker test only and never a hosted Site pass. The A01–A24 acceptance outcomes below are not 24 independent end-to-end tests: the local suite contains 44 regression tests that cover parts of several scenarios, while hosted acceptance remains unrun.

| Case | Local result | Evidence / remaining work |
|---|---|---|
| A01 owner isolation with public/private GitHub | PARTIAL | Owner identity, request spoofing, same client-supplied plan UUID across owners, and cross-owner plan denial are tested. No Site identity middleware or GitHub private runtime tested. |
| A02 create with past plan date | PASS (local) | Plan date, server registration, PLANNED state, and no interval tested. |
| A03 Start/Pause/Resume/Finish duration | PASS (local) | 2h + 2h30 active, 64h paused, 68h30 calendar tested. |
| A04 concurrent starts | PARTIAL | Concurrent calls against local SQLite serialize to one RUNNING plan. D1/multi-device race not tested. |
| A05 repeated Pause idempotency | PASS (local) | Repeated Pause with the same command ID returns one receipt/event/interval. |
| A06 lost Finish response and retry | PASS (local) | Receipt replay returns original Finish result without a second event. |
| A07 stale version Resume | PASS (local) | VERSION_CONFLICT leaves plan/event state unchanged. |
| A08 Friday to Monday analytics | PASS (local) | Period clipping and full completed median tested separately. |
| A09 midnight and DST ranges | PARTIAL | 23-hour and 25-hour DST days tested. Midnight boundary integration case not separately tested. |
| A10 two repositories do not double-count | PASS (local) | One plan linked to two repos contributes one interval duration. |
| A11 unrelated author yields candidate | PASS (mocked local importer) | Stable numeric author ID filter persists across syncs; author and committer identities are stored/displayed separately; Bot/unknown labels are explicit; time candidate remains unconfirmed; exclusions persist. No live GitHub source tested. |
| A12 full Plan-ID marker confirms link | PASS (mocked local importer) | Exact full UUID confirms only for the same selected repository/ref; invalid or unknown IDs, wrong repo/ref, and multiple distinct marker lines create visible conflicts. |
| A13 post-Finish commit does not change time | PASS (local/mock) | A post-Finish SHA can be linked explicitly; recorded active duration stays fixed and the finished-plan sample is counted with measured N. |
| A14 repeated SHA/ref import deduplicates | PARTIAL (mocked local importer) | Reimport deduplicates SHA; explicit membership from two refs remains one commit. New rebased SHA is not auto-linked by exact marker, but no dedicated rebase fixture or live GitHub test exists. |
| A15 closing browser leaves server timer running | PARTIAL (local model) | With no lifecycle command for 24 hours, server elapsed time continues. Browser-close/reopen with local clock shifted by an hour has no browser E2E test. |
| A16 offline Pause has no false success and safe retry | PARTIAL | UI only shows success after server response and command IDs persist while the page remains open; offline/browser retry E2E not run. |
| A17 later page/rate limit is partial | PASS (mocked local importer) | Later-page limit preserves prior page data/checkpoint, exposes partial progress and Retry-After; transient GET retries are bounded; full-ref reconciliation resumes and prunes stale membership only after completion. No live GitHub run. |
| A18 GitHub access revocation | PASS (mocked/local) | 401 marks the private repository revoked; subsequent reads are blocked; private commit metadata is hidden; explicit cache deletion preserves plans/intervals; explicit owner action enables a later access recheck. No live revocation test. |
| A19 spoofed owner, foreign plan, hostile commit text | PARTIAL | Owner spoof/foreign plan denial, safe `textContent`, and owner-scoped export tested. No imported hostile commit/browser test. |
| A20 keyboard and 360/768/1440 widths | PARTIAL (local Chromium preview) | Playwright/Chromium exercised keyboard create/details/Start/Pause/Resume/Finish/analytics, Finish confirmation, visible initial focus, author-ID settings input, and no horizontal overflow at all three widths. This used local SQLite and test identity headers, not the published Site; full visual/accessibility and hosted checks remain. |
| A21 empty analytics | PASS (local) | Empty period returns null median; completed plans count independently of measurement; median excludes unmeasured plans and returns measured N plus the small-sample flag. |
| A22 two clients run skill lifecycle | NOT RUN | MCP schema and common handler tested locally, but no connected client or deployed MCP. |
| A23 secrets, recovery, export | PARTIAL | Owner JSON export implemented/tested; no GitHub secret exists to leak or revoke, and restore drill not run. |
| A24 full profile; timer independent of GitHub errors | PARTIAL | Timer state is separate from GitHub adapter; no 10 repo / 1k plan / 10k interval / 50k commit load test. |

## Commands run

- `npm test`: 44 tests pass after the current local changes.
- `npm run build`: builds the Worker ESM artifact.
- `npm run validate`: checks artifact imports and `default.fetch` export.
- `node --check worker/index.js`: syntax check.

These commands do not satisfy the hosted G1–G6 gates or the remaining A cases.

See [review-findings.md](review-findings.md) for the independent review, fixes, and local browser preview scope.
