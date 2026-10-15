# Local UI acceptance fixture

`ui-acceptance.mjs` runs the actual Worker-generated HTML, CSS, and browser scripts in Chromium. Playwright is loaded from an existing installation; this project does not add a Playwright runtime dependency. The fixture API is intercepted in the page context, uses synthetic plans/repositories/attempts, and aborts every non-local origin. It never contacts the Site, GitHub, or a production API.

Run from `sites/plan-time-tracker` in an environment with Chromium and Playwright already installed:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROMIUM_EXECUTABLE=/usr/bin/chromium \
node test/ui-acceptance.mjs
```

If Playwright is already resolvable by Node, `PLAYWRIGHT_MODULE` may be omitted. `CHROMIUM_EXECUTABLE` may also be omitted when Playwright's bundled Chromium is available. The runner writes `results.json`, `summary.json`, and viewport screenshots under `work/ui-acceptance/` by default; set `UI_ACCEPTANCE_ARTIFACT_DIR` to choose another local output directory. These outputs are generated evidence, not source fixtures.

The companion `fixtures/ui-acceptance.mjs` contains synthetic, non-production data. The runner asserts DOM visibility, selected navigation, command bodies/replay IDs, mocked failure states, spacing, responsive overflow, and the 12 reviewed behavior groups plus follow-up blocker scenarios. It also exercises checkpoint keyboard/touch disclosures, authoritative check summaries, and drafts across a command on another card and replacement of the outer detail DOM. Check drafts are scoped to their result revision; toggles never send commands.

All mandatory unit, VM client-contract, and actual Worker+SQLite tests run with:

```sh
npm test
```

The focused Worker+SQLite contract and migration checks can also be run separately with:

```sh
node --test test/attach-plan-repository.test.js test/tracker-evidence.test.js test/commit-attribution.test.js
```

These database tests apply canonical migrations to isolated temporary SQLite, including populated upgrades that retain historical decision receipts and rows as inert audit data. Normal finish is verified against current results and the latest required checks by server sequence. Removed owner-decision commands must fail without mutations. Browser API responses remain synthetic: a passing DOM runner does not establish hosted D1 behavior or private Site authentication.

For worktree evidence, also run `node test/ui-worktree.mjs` with the same Playwright and Chromium environment. `npm run test:ui` runs both suites. This suite uses the real Worker and migrated in-memory SQLite through intercepted localhost requests. It writes evidence under `UI_ACCEPTANCE_ARTIFACT_DIR/worktree` (or `/tmp/tracker-worktree-browser/worktree`) and never contacts production. Run the plugin capture/queue tests separately with `node --test plugin/plan-time-tracker/test/*.test.mjs` from the repository root.
