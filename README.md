# plan-time-tracker

Version 3.0.0 tracks every user-authorized plan execution through authenticated MCP and server work intervals. Multiple plans can run independently. Owner-wide time counts the union of their intervals; per-plan totals and their sum remain available. Check evidence uses repository-free source snapshots. This release targets a fresh database; updating source on GitHub does not deploy the Worker or update the installed App.

Live private Site: [Трекер планов](https://plan-time-tracker-v3.seraf-k.chatgpt.site). The fresh v3 Site uses a new App connection; the GitHub package 3.0.1 points to it while retaining its marketplace package name. The Site-generated plugin is version 3.0.0 and must be installed/connected separately from the old Site.

Application source and development instructions: [sites/plan-time-tracker](sites/plan-time-tracker/README.md).

## Codex CLI

Requires a current Codex CLI with plugin marketplace support and a ChatGPT account. Sign in with `codex login`, then check with `codex login status`. Add the repository marketplace and install the plugin:

```sh
codex plugin marketplace add Seraf-seraf/plan-time-tracker
codex plugin add dev-9529b49da3708191b8f13f1e1e4b1e01@plan-time-tracker
```

Start a fresh Codex session after installation. For a read-only smoke check, confirm `GetTrackerCapabilities` is available, then call `ListPlans` with `statuses: ["RUNNING"]` and follow `nextCursor` to inspect every active plan. Require `parallelPlans: true`; refresh discovery after the matching Worker release. If either tool is unavailable or authentication fails, stop and report that; do not use another endpoint or supply an owner ID. This package references the existing private Site App. Local/private Site authentication was not verified here, and marketplace installation does not configure authentication or grant private Site access.
