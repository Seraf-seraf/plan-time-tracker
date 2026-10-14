# Local UI acceptance fixture

`ui-acceptance.mjs` runs the actual Worker-generated HTML, CSS, and browser scripts in Chromium. Playwright is loaded from an existing installation; this project does not add a Playwright runtime dependency. The fixture API is intercepted in the page context, uses synthetic plans/repositories/attempts, and aborts every non-local origin. It never contacts the Site, GitHub, or a production API.

Run from `sites/plan-time-tracker` in an environment with Chromium and Playwright already installed:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROMIUM_EXECUTABLE=/usr/bin/chromium \
node test/ui-acceptance.mjs
```

If Playwright is already resolvable by Node, `PLAYWRIGHT_MODULE` may be omitted. `CHROMIUM_EXECUTABLE` may also be omitted when Playwright's bundled Chromium is available. The runner writes `results.json`, `summary.json`, and viewport screenshots under `work/ui-acceptance/` by default; set `UI_ACCEPTANCE_ARTIFACT_DIR` to choose another local output directory. These outputs are generated evidence, not source fixtures.

The companion `fixtures/ui-acceptance.mjs` contains synthetic, non-production data. The runner asserts DOM visibility, selected navigation, command bodies/replay IDs, mocked failure states, spacing, responsive overflow, and the 12 reviewed behavior groups plus follow-up blocker scenarios. The Worker+SQLite contract and migration checks run separately with:

```sh
node --test test/attach-plan-repository.test.js
```
