# G1–G6: проверка предпосылок Sites

Дата: 2026-10-12. Repo: `Seraf-seraf/plan-time-tracker` (private; GitHub REST metadata check succeeded). Полные входные файлы сохранены в `docs/originals/`: SHA-256 требований `36b96a84e6430629378d51cf77c660c37f7963c6033c7cd5d74984040994fa48`, плана `b251ba81fc4b6b6c9fb25ca3699973290d8ee8d743328ffbeae0e0a13623ab66`. `sites_list_sites(role=owner, limit=50)` первоначально вернул пустой список. Затем по запросу пользователя создан private unpublished Site; его ID сохранён в `sites/plan-time-tracker/.openai/hosting.json`.

| Gate | Result | Evidence / limitation |
|---|---|---|
| G1 Privacy | NOT RUN end-to-end | Sites identity guidance confirms signed-in Site visitors receive server identity headers and private Sites require authentication. Site exists but has no source deployment, so identity binding and cross-owner denial have not been exercised. |
| G2 D1 / concurrency | NOT RUN | Sites guidance documents D1 and schema migration workflow. The local D1-compatible SQL schema and Worker command layer now exist, and a Node SQLite adapter tests atomic statement rollback and concurrent starts. Read-only `sites_read_database_overview(project_id=appgprj_6acca329a8e881918fed6f2224538505)` returned `bindings: []`, `tables: []`; no Site D1 binding/schema migration is attached, and D1-specific concurrency has not been run. A browser-only lock would not satisfy the requirement. |
| G3 GitHub runtime | BLOCKED / NOT PROVEN | Current GitHub chat connector can read repository metadata and lists the private target. This proves only chat connector access. Sites app-integration guidance requires eligibility discovery and declared connector support; the native `sites_list_plugin_eligibility` tool is absent from this environment. No runtime credential, pagination test, or revocation test is authorized/proven. No new OAuth grant/secret was created. |
| G4 MCP / skill | NOT RUN | Sites documentation describes a Worker `POST /mcp` and platform authentication. A local MCP JSON-RPC endpoint exposes typed tools through the same command layer as the UI; local auth/idempotency tests pass. Site has no deployed MCP endpoint or connected Site MCP client, so no real tool call or platform-auth identity comparison has occurred. The repository skill is explicitly marked draft/unverified. |
| G5 secrets / revocation | NOT RUN end-to-end | Sites documentation has server-side runtime secrets and environment-variable management, but there is no deployment or GitHub runtime secret to inspect. No runtime secret or OAuth grant was created. The temporary Site-source write credential was retained in session memory only. |
| G6 operations | NOT RUN | No running/deployed Site to measure request limits, latency, logs, recovery or the 10 repo / 1k plan / 10k interval / 50k commit profile. |

## Supported facts checked

- `sites_list_sites` initially returned no owner Sites. `sites_create_site` later created a private, unpublished Site with ID `appgprj_6acca329a8e881918fed6f2224538505` and expected origin `https://plan-time-tracker.seraf-k.chatgpt.site`; this is not a live/deployed URL.
- `github_get_repo(Seraf-seraf/plan-time-tracker)` confirmed private repository, default branch `main`, current account has admin/push permissions. This is not runtime authorization from Sites.
- Sites skill references read: storage, identity-and-secrets, site-mcp-server, app-integrations, troubleshooting. The app-integrations reference requires `sites_list_plugin_eligibility` before choosing a connector; that tool is not exposed in `ALL_TOOLS`.
- Existing repository has only `README.md`; no `AGENTS.md` or `.agents/skills` files were found in the checkout.

## Decision and next step

The Site now exists, but its source cannot be prepared or deployed yet: the Sites skill specifies `project-setup.mjs`, `set-project-id.mjs`, `site-workflow.mjs`, and build helpers, while this executor exposes only the skill markdown. `skill_root` is null, and reads for those script resources fail. No equivalent native source-sync tool is exposed. Current task instructions prohibit push and deployment pending agreement; no credential was created, used, refreshed, or written to disk.

### Helper discovery trace

- `skills__list({authority:{kind:"executor"}})` → `skills: []`, `warnings: []`.
- Full pagination of `skills__list({authority:{kind:"cloud"}})` → 107 skills; the Sites entry is `sites:sites`, package `skill://plugin_connector_1p_689987207de08191979cf68eca2941c6/sites`; no `skill_root` is supplied by cloud reads.
- Checkout scan: `find .agents .codex -maxdepth 5 -type f -print 2>/dev/null || true` → no files.
- Standard root scan: `find /opt/codex/plugins /opt/codex/skills -maxdepth 3 -type d -print` showed `/opt/codex/plugins/unified-computer-use` and built-in document/pdf/presentation/spreadsheets trees only.
- Exact helper scan: `rg --files /opt/codex/plugins /opt/codex/skills 2>/dev/null | rg '(^|/)(project-setup|site-workflow|set-project-id|build-site)\.mjs$|/sites/SKILL\.md$' || true` → no matches.
- Runtime tools expose Site create/list/get/save/deploy and database actions, but no Site source opening/synchronization action.
- `skills__read` for `sites/scripts/project-setup.mjs`, `set-project-id.mjs`, `site-workflow.mjs`, and `build-site.mjs` each returned `failed to read skill resource`.
- Read Sites `references/troubleshooting.md`: it points to the plugin-root configure/build/package helpers and says to continue the shared workflow; it does not provide a helper recovery/download route. Read Library `references/materialization.md`: its helper flow is specifically for resolved Library file references and does not authorize materializing arbitrary Sites plugin assets.
- `project_id`: `appgprj_6acca329a8e881918fed6f2224538505`. No credential value is included in this report.

G1–G6 are not all PASS. If the current Sites plugin installation can expose its bundled helpers (or an approved execution environment is attached to this checkout), continue through the supported workflow and run real deployed checks. This helper-access blocker does not imply G3 eligibility is required for independent D1/auth/timer checks. G3 still requires plugin eligibility discovery or another officially supported in-Sites GitHub path. No external backend is acceptable.


## Local implementation update (2026-10-12)

Local files exist under `sites/plan-time-tracker/`: Worker source, D1 schema/triggers, package scripts, SQLite-backed tests, Site hosting manifest, UI, and a draft skill. Current local verification passed 44/44 tests, build, artifact validation, and Worker syntax check. A Playwright/Chromium localhost preview exercised keyboard create/details/Start/Pause/Resume/Finish/analytics, Finish confirmation, visible focus, settings author-ID filter visibility, and no horizontal overflow at 360/768/1440 px; it used a fresh local SQLite adapter and test identity headers, so it is not hosted evidence. These are not hosted G1–G6 passes. Sites storage guidance confirms logical D1 binding `DB` and says to declare it in `.openai/hosting.json`, but the available official reference does not give the JSON value shape; manifest remains `d1: null` rather than guessing. GitHub runtime sync requires `GITHUB_TOKEN`, but no credential/integration has been configured. No publish/deploy/push was performed.
