# Полная трассировка плана на код и проверки

Это индекс трассировки, а не пересказ нормативных формулировок. Полный исправленный план и практическое приложение сохранены без сокращений в originals/serafim_gpt6_project_plan_full.txt; нормативное ТЗ и полные R01–R10/A01–A24 сохранены в originals/plan_time_tracker_requirements.txt. Проверенные SHA-256 обоих файлов приведены в G1-G6-status.md. Номера строк ниже относятся к полным пунктам в оригинале: критерии и подпункты сохранены именно там.

Ниже приведены результаты на код и evidence. Это не публикационный PASS: G1–G6 остаются непроверенными или заблокированными в Sites runtime. SQLite-local тесты не доказывают Sites D1, identity middleware, GitHub runtime, MCP-клиенты или производительность.

## Полные этапы G1–G6

| Пункт оригинала | Код / артефакт | Проверка и результат |
|---|---|---|
| G1: цель, входы, G1-T1–T4, артефакты и PASS/FAIL (строки 121–170) | Owner берётся только из заголовка Sites в sites/plan-time-tracker/worker/index.js (requireOwner, apiRoute, mcpRoute); API запросы ограничиваются owner. | Локально запрещены spoofed owner и доступ к чужому plan. Sites identity, прямой доступ, чужие read/write и сравнение identity UI/MCP не проверены. G1 NOT RUN end-to-end. |
| G2: цель, входы, G2-T1–T4, артефакты и PASS/FAIL (строки 172–221) | drizzle/0001_initial.sql: уникальный RUNNING-owner индекс, один открытый интервал, запрет пересечений, lifecycle triggers и receipt/event updates. | SQLite-local concurrency/rollback проверены. Sites D1 migration/binding и два параллельных Site запроса не выполнялись. G2 NOT RUN. |
| G3: цель, входы, G3-T1–T4, артефакты и PASS/FAIL (строки 223–282) | GitHubRestAdapter, syncRepository и executeSyncCommand в worker/index.js; без GITHUB_TOKEN внешний importer недоступен. | Runtime Sites public/private access, revoke и pagination не подтверждены. GitHub чат-коннектор не считается доказательством. G3 BLOCKED / NOT PROVEN; GitHub часть обязательна. |
| G4: цель, G4-T1–T4, артефакты и PASS/FAIL (строки 284–331) | /mcp, mcpTools и mcpRoute вызывают тот же executeCommand; skill/plan-time-tracker/SKILL.md явно draft/unverified. | Локальный MCP JSON-RPC и общий service тестируются. Нет Site MCP endpoint и двух независимых runtime clients. G4 NOT RUN, skill не работающий. |
| G5: цель, G5-T1–T4, артефакты и PASS/FAIL (строки 333–373) | Токен читается только через env.GITHUB_TOKEN; UI его не получает. Export/API реализованы в worker/index.js. | Локальные API/UI/export проверки есть. Нет собранного Site secret scan, проверки логов, реального секрета, revoke/recovery. G5 NOT RUN end-to-end. |
| G6: цель, G6-T1–T4, артефакты и PASS/FAIL (строки 375–424); объём/порог уточнён строками 1571–1610 | Есть локальные Worker/SQL и экспорт. | Нет профиля 10 repos / 1k plans / 10k intervals / 50k commits, p95, Site recovery, logging/diagnostics или restore drill. G6 NOT RUN. |

Полные формулировки действий при FAIL и обязательных артефактов остаются в исходнике по указанным диапазонам. Публикация блокируется до PASS G1–G6 (строки 105–108).

## Основной план: каждый этап и его задачи

| Пункт плана и исходные строки | Трассировка на код / проверки |
|---|---|
| Границы MVP и схема зависимостей, 22–109 | Site UI/API/MCP и D1 schema описаны в sites/plan-time-tracker/README.md; внешний backend отсутствует. G3/G4 не доказаны, поэтому обязательные private GitHub/agent режимы не считаются закрытыми или снятыми; публикация запрещена до G1–G6. |
| ARCH: ARCH-T1 (UI, Command Layer, Storage, GitHub Sync, Analytics), ARCH-T2, ARCH-T3; артефакты и DoD, 426–473 | UI, executeCommand, schema, syncRepository/buildAnalytics находятся в Worker; backend не вынесен. Архитектурная схема, ADR и отдельная граница безопасности ещё не оформлены; Site-слой не проверен. |
| DATA: DATA-T1 со всеми Owner/Plan/PlanRepository/WorkInterval/PlanEvent/CommandReceipt/Repository/SyncState/Commit/PlanCommitLink; DATA-T2 с каждым инвариантом, 475–526 | drizzle/0001_initial.sql содержит composite owner FKs, owner-scoped commits, ref membership, partial unique confirmed owner/repo/SHA и exclusion precedence. SQLite tests проверяют локальные пути; Sites migration/binding не запускалась. |
| CMD: CMD-T1 со всеми 11 командами; CMD-T2 envelope; CMD-T3 ошибки; полный порядок replay; DoD, 528–593 | UI/API/MCP используют executeCommand. Receipt contract включает commandId/applied/snapshot/serverOccurredAt/serverNow/resultingVersion; errors включают requestId/retryable/retryAfter. Локальные Worker tests проходят; Site contract не проверен. |
| TIME: TIME-T1 все переходы; TIME-T2 Start/Pause/Resume/Finish; TIME-T3 Active/Calendar/Paused, 595–649 | SQL lifecycle triggers и серверные интервалы в worker/index.js. Local tests покрывают интервалы, replay, DST и weekend clipping. D1/server-clock end-to-end не проверены. |
| GITHUB: GITHUB-T1 repository; T2 sync; T3 attribution и полный UUID/exclusion/rebase правила, 651–693 | GitHubRestAdapter/syncRepository поддерживает bounded retry/Retry-After, page checkpoint/resume, ref reconciliation, marker conflict review, explicit exclusion, unique confirmed link и revoke/cache policy. Mock tests pass; live runtime/rebase E2E не проверены, G3 blocked. |
| ANALYTICS: AN-T1–T4, метрики/интерпретация и DoD, 695–732 | Completed count отдельно от measured sample; N/small-sample/asOf, inactive PLANNED/PAUSED и repo/date filters реализованы. Локальные Worker tests проходят; Sites runtime не проверен. |
| UI: UI-T1–T4, artifacts/accessibility/DoD, 734–777 | Responsive UI, filters, Finish confirmation, commit tabs/conflict review, ref selection и private-cache actions реализованы. Локальный Chromium preview прошёл keyboard lifecycle на 360/768/1440 без overflow; это не Sites runtime и не полный A20. |
| SKILL: SKILL-T1–T3, protocol/client/errors/DoD, 779–819 | Draft skill и MCP schemas/route есть. Нет двух клиентов, live Sites MCP или доказательства r