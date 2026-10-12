# Independent local review — 2026-10-12

The review compared the implementation with both complete inputs in `docs/originals/`. A separate GPT-6 Luna low reviewer inspected data ownership, SQL constraints, command receipts, GitHub sync and attribution, UI, analytics, MCP, and skill behavior. Findings were checked against local SQLite/Worker code and browser preview. Missing hosted Sites services were kept out of the code-defect list.

## Findings fixed

1. **A crashed sync could leave a permanent `PENDING` receipt.** A same-ID retry returned an error forever. Sync receipts now use a five-minute execution lease claimed with a conditional update. A duplicate during a live lease receives retry guidance; a retry after an expired lease resumes from the saved sync checkpoint. Completed receipts still replay their saved result. Negative tests cover live-lease rejection and recovery/replay.
2. **Plan IDs were globally unique in the database.** `plans`, repository links, commit links, and open-interval constraints now scope plan identity by `(owner_id, plan_id)`. A regression test creates the same client-supplied UUID for two owners, starts both plans, and reads each owner's distinct record.
3. **Commit identities were not surfaced separately.** Imported commit records now preserve author and committer GitHub IDs, logins, GitHub account types, and Git author/committer names without storing email addresses. Plan details render the two identities separately and label unknown identities and Bot accounts. Time candidates can be restricted to stable numeric `authorGithubIds`, saved per repository/ref, carried through API/MCP sync envelopes, and resumed across pages. A mocked test checks filtering, persistence, and clearing the filter.
4. **MCP write schemas omitted required command-specific fields.** Tool schemas now define CreatePlan dates and required fields, ReviewCommitLink arguments, SyncRepository fields and author IDs, and metadata update constraints. A schema regression test checks the declarations.
5. **Keyboard Start was intercepted by a card also exposed as a button.** The card now has a separate focusable “open plan” button beside lifecycle controls. A local Chromium regression check exercised Enter activation through Create, details, Start, Pause, Resume, Finish, and analytics navigation.

## Local browser QA

Chromium and Playwright were already installed in the executor; nothing was installed. A temporary localhost preview harness ran the actual Worker HTML/API against the repository's SQLite adapter and a fixed local test owner header. In headless Chromium, the keyboard lifecycle completed and reached `COMPLETED`; Finish confirmation appeared; analytics navigation worked; first keyboard focus had a visible outline; no page errors occurred; and `documentElement.scrollWidth` equaled the viewport at 360, 768, and 1440 px.

This preview does **not** emulate Sites authentication, D1, runtime secrets, browser clock manipulation, production hosting, or multiple real MCP clients. It is local UI evidence only, not G1–G6 or published A20 acceptance.

## Remaining review limits

- The GitHub author-ID filter is local and explicit, but has no real Site GitHub runtime identity to discover/filter from; runtime credential behavior remains G3-blocked.
- A rebase/removal fixture, browser clock shift/reopen, offline lost-response scenario, and full A01–A24 hosted suite remain unverified.
- SQLite's `BEGIN IMMEDIATE` adapter does not establish D1 concurrency semantics.

## Verification after fixes

See `docs/A01-A24-status.md` for the final local test count and `docs/G1-G6-status.md` for hosted gates. The final project archive includes this review report.
