# G1–G6: Sites deployment and verification status

Date: 2026-10-12. Repository: private `Seraf-seraf/plan-time-tracker`. The complete, unabridged requirements and plan are preserved in `docs/originals/`; SHA-256: requirements `36b96a84e6430629378d51cf77c660c37f7963c6033c7cd5d74984040994fa48`, plan `b251ba81fc4b6b6c9fb25ca3699973290d8ee8d743328ffbeae0e0a13623ab66`. The GitHub `main` base used for the Site source snapshot was `3943ff928a919cb8e035bd754f787eb200b0127d`.

## Published Site

- Existing project: `appgprj_6acca329a8e881918fed6f2224538505`, version 1.
- Live URL: https://plan-time-tracker.seraf-k.chatgpt.site
- Access policy confirmed by `sites_get_site`: `custom` with the owner as the only allowed user; zero external visitors and zero groups.
- Site source commit: `8d0639abf461cd9abc9145fd68fad923220d6d63`.
- Deployment: succeeded; MCP capability reported available.
- Manifest now declares `"d1": "DB"`. The live database overview confirms binding `DB` and 13 application tables created by the initial migration.

## G1–G6

| Gate | Result | Evidence and remaining work |
|---|---|---|
| G1 Privacy / identity | PARTIAL | Site access policy is owner-only. An unauthenticated browser visit was redirected to the ChatGPT sign-in screen. The browser sign-in flow then required the user's one-time authenticator code, so authenticated UI identity injection and cross-owner browser denial were not verified. |
| G2 D1 / concurrency | PARTIAL | Publish succeeded with logical D1 binding `DB`; live overview reports the expected 13 tables after migration. Local SQLite tests cover atomic constraints and concurrent starts, but D1-specific concurrency and multi-device race tests remain unrun. |
| G3 GitHub runtime | BLOCKED | The GitHub chat connector's read access is not Site runtime access. No GitHub runtime token, secret, or OAuth grant exists. The adapter reports an unavailable configuration and remains disabled when `GITHUB_TOKEN` is absent. Live pagination, private repository access, and revocation tests require a separately configured supported integration. |
| G4 MCP / skill | PARTIAL | Published deployment reports `has_mcp=true`. A live MCP smoke test exercised GetActivePlan, CreatePlan, StartPlan, idempotent replay of the same Start command, PausePlan, ResumePlan, FinishPlan, and analytics; expected versions advanced 1–4 and analytics showed one completed measured plan. The QA plan remains in the database. A second client, browser-to-MCP identity comparison, and complete A22 are unverified. |
| G5 secrets / revocation | PARTIAL | No GitHub runtime secret or OAuth grant was created. The temporary Site source-write credential was used only in session memory for the authorized source push and was not persisted. Runtime secret rotation/revocation and recovery drills remain untested. |
| G6 operations | NOT RUN | No scale, latency, recovery, or request-limit test was run for the 10 repository / 1k plan / 10k interval / 50k commit profile. |

## Local checks

The deployment workflow passed `npm test` (44/44), `npm run build`, `npm run validate`, and `node --check worker/index.js`. These checks do not establish the remaining hosted acceptance scenarios. The detailed A01–A24 matrix remains in `docs/A01-A24-status.md`; do not treat its local partial passes as full Site passes.

## Safe remaining work

1. Complete owner UI login when the user provides the one-time authenticator code; then verify UI identity and owner-scoped browser operations.
2. Run D1 concurrency and the remaining hosted acceptance scenarios.
3. Configure GitHub runtime access only after a supported Site integration is approved; do not reuse chat connector credentials or invent a raw/private URL.
4. Run operational load and recovery checks before claiming full production readiness.

## Source integrity and UI regression update (2026-10-13)

The repository's truncated Worker, tests, migration, traceability, and original input files were restored from Site source commit `64a02657669668c11764443387d2d4f4c2d77c6e`. Fresh local checks passed 47/47 tests (44 behavioral and 3 UI regressions), build, artifact validation, and Worker syntax validation. The UI regressions cover embedded script compilation, responsive forms, keyboard dialog safeguards, duplicate-submit prevention, and unavailable GitHub sync controls. These checks are local, not hosted acceptance or CI results. Existing deployment evidence above is retained; the GitHub source repair does not deploy or modify D1.
