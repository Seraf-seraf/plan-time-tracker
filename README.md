# plan-time-tracker

Application source and development instructions: [sites/plan-time-tracker](sites/plan-time-tracker/README.md).

## Codex CLI

Requires a current Codex CLI with plugin marketplace support and a ChatGPT account. Sign in with `codex login`, then check with `codex login status`. Add the repository marketplace and install the plugin:

```sh
codex plugin marketplace add Seraf-seraf/plan-time-tracker
codex plugin add dev-9529b49da3708191b8f13f1e1e4b1e01@plan-time-tracker
```

Start a fresh Codex session after installation. For a read-only smoke check, confirm `GetTrackerCapabilities` is available, then call `GetActivePlan` if the connected app exposes it. If either tool is unavailable or authentication fails, stop and report that; do not use another endpoint or supply an owner ID. This package references the existing private Site App. Local/private Site authentication was not verified here, and marketplace installation does not configure authentication or grant private Site access.
