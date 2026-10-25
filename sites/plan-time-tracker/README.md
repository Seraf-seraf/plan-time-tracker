# Plan Time Tracker

The tracker records work time through explicit authenticated MCP commands and the owner UI. `CreatePlan` registers a plan; only Start/Pause/Resume/Finish change server-timed intervals. Observations, tools, attempts and source changes never accrue or stop time on their own. One owner may run several plans at once. Start/Resume/Pause/Finish only affect the supplied planId. Calendar/active/paused durations remain per-plan. The connected skills register plans, substantial steps and assessments during planning, including /plan, without implementation or a timer; they also track authorized execution and continuation.

The current contract removes repository management/filters, synchronization, commit attribution, commit/push policies and Git observations. It requires no external integration token. GitHub source publication does not deploy the Worker or update installed tools.

## Аналитический JSON-отчёт

Аналитический JSON-экспорт: [состав, полнота, единицы времени и исключённый шум](../../docs/json-report.md).
`GET /api/export` возвращает формат 1 с полной содержательной историей;
это отчёт для анализа, не формат восстановления базы.

## Оценки задач (0.4.0)

Нейтральные RecordAssessment/GetAssessment/GetEstimationHistory и независимые
assess-task/track-plan описаны в [контракте](../../docs/assessments.md).
Версии package.json, plugin.json, serverInfo и capabilities согласованы на 0.4.0;
schemaVersion команд остаётся 1, версия методики задаётся агентом отдельно.
Для HTTP запись использует POST /api/commands, чтение — POST
/api/tracker/assessment и /api/tracker/estimation-history с теми же JSON-полями,
что MCP. GetTrackerCapabilities сообщает assessments; ни балл, ни методика не
служат условием исполнения. Перед оценкой GetAssessment({planId, stepId?}) без assessmentId возвращает текущий контекст и digest; запись требует expectedRequirementsDigest этого контекста. Изменение требований после анализа отклоняет запись с ASSESSMENT_CONTEXT_CHANGED, без создания ревизии.

На заполненной базе после 0016 применяется только новая 0017_assessments.sql.
Тесты проверяют сохранность всех старых строк и отсутствие выдуманных baseline.
Новой базе нужна полная цепочка 0001–0017. Ревизии оценок нельзя менять/удалять;
откат приложения не должен удалять эту таблицу или повторять миграцию. Миграция
добавляет таблицу, индексы, view и триггеры без переписывания существующих таблиц;
локальная SQLite-проверка не измеряет production-блокировки или объём D1.

Исходники ещё не развёрнуты. Секция ниже документирует сохранённый контракт удаления,
введённый в 3.1.0; его историческая миграция не изменялась.

## Удаление и восстановление планов (3.1.0)

`DeletePlan` выполняет мягкое удаление атомарно: записывает `plans.deleted_at`, увеличивает версию плана, закрывает его открытый рабочий интервал и все OPEN-попытки как ABANDONED. RUNNING-план становится PAUSED. Этапы RUNNING становятся BLOCKED; версии и `current_fence` этапов увеличиваются, поэтому прежние исполнители не могут продолжить работу после восстановления. Результаты, проверки, интервалы, квитанции и события не удаляются. Новые события — DELETED/RESTORED в истории плана и PLAN_DELETED/PLAN_RESTORED в tracker timeline, если учёт этапов включён.

`RestorePlan` снимает отметку удаления и увеличивает версию. PLANNED, PAUSED и COMPLETED сохраняются; прежний RUNNING остаётся PAUSED. Интервал и попытка не открываются. Исторические результаты и текущие проверки сохраняют силу, если их ревизия и исходники по-прежнему совпадают. Календарная длительность заморожена на удалённом плане, после восстановления снова учитывает прошедшие паузы; активное время за удалённый период не добавляется.

Обе команды требуют аутентифицированного владельца и текущую `expectedVersion`. MCP выбирает имя инструмента, HTTP использует `POST /api/commands` с `commandType`. Пример HTTP-конверта (подставьте ID плана и его версию):

```json
{"schemaVersion":1,"commandId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","commandType":"DeletePlan","expectedVersion":1,"payload":{"planId":"11111111-1111-4111-8111-111111111111","reason":"План больше не нужен"}}
```

Для MCP передайте этот объект без `commandType` в `DeletePlan`; для восстановления выберите `RestorePlan`, новый `commandId` и актуальную версию. `reason` необязателен, до 1000 символов. Успешный результат содержит `planId`, `status`, `deletedAt`, `version`, `serverNow` внутри стандартной квитанции. Один `commandId` с тем же конвертом возвращает сохранённый результат, даже если план впоследствии восстановлен; повтор не применяет действие заново. Изменение конверта с тем же ID даёт IDEMPOTENCY_KEY_REUSED. Квитанции отказов также сохраняются.

`ListPlans({deleted:true,...})` и `GET /api/plans?deleted=true` возвращают только удалённые планы. По умолчанию `deleted:false`; значения статусов, размер и порядок страниц, `nextCursor` не меняются. `GetPlan` и execution snapshot доступны по явному ID владельца и содержат `deletedAt`; изменения удалённого плана запрещены. Обычная аналитика целиком исключает удалённые планы, в том числе completion median и inactivePlans; аналитика этапов такого плана возвращает 404. Восстановление возвращает сохранённые интервалы в отчёты. Экспорт включает удалённые планы для сохранности истории.

Ошибки: PLAN_NOT_FOUND (404, в том числе чужой план), VERSION_CONFLICT (409), PLAN_DELETED (409: повторное удаление с новой командой либо запись в удалённый план), PLAN_NOT_DELETED (409: восстановление обычного плана), VALIDATION_ERROR (400 для некорректного конверта/фильтра). MCP возвращает те же коды в `isError`/`structuredContent`. Не повторяйте конфликтную команду автоматически с новой версией: сначала перечитайте план и получите новое явное намерение. Все записи и конкурентные команды проверяются в одной SQL-операции; частичный отказ откатывает отметку, интервалы, попытки, события и квитанцию вместе.

`GetTrackerCapabilities` сообщает `version: "0.4.0"`, `planDeletion: {softDelete:true, deleteTool:"DeletePlan", restoreTool:"RestorePlan", deletedFilter:"deleted", restoreStartsTimer:false}` и `planList.deletedDefault:false`. MCP initialize также возвращает 0.4.0 в подготовленном Worker. Команды удаления/восстановления требуют отдельного намерения пользователя; они не следуют из окончания этапа или ответа.

Обновление существующей параллельной v3-базы: примените только `drizzle/0016_plan_deletion.sql` после 0015, затем опубликуйте Worker 3.1.0 и обновите пакет/обнаружение MCP-инструментов. Для новой базы нужна вся цепочка 0001–0016. Миграция добавляет nullable-поле и триггеры, сохраняя строки и активные интервалы до явного удаления. Это не путь обновления старой single-plan-базы. Не возвращайте старый Worker после появления удалённых планов: он не фильтрует их в чтении. Build сохраняет неизменённые migration sidecars в `dist/.openai/drizzle/` по [официальному контракту упаковки Sites](https://github.com/openai/sites/blob/7eb9d4b9cf93ad7e64aebc8a5ca70e29ec2cfb94/packages/sites-vite-plugin/README.md). Sites применяет hosted-миграции до загрузки Worker; отдельной shell-команды hosted SQL здесь нет. Перед публикацией существующей базы подтвердите историю применения 0001–0015 и выбор только новой 0016. Не создавайте фиктивный journal и не запускайте старую цепочку заново. Локальные тесты упакованной миграции не подтверждают состояние hosted migration ledger.

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

Version 3.0.0 targets a new empty database. For a fresh 0.4.0 installation apply canonical migrations in order through `0017_assessments.sql`; the revised `0001_initial.sql` permits parallel RUNNING plans from creation. One open interval and nonoverlapping intervals per plan remain enforced. There is no upgrade path from a deployed single-plan database in this patch and no extra migration for dropping the old constraint. Do not apply only the revised Worker to that database. A future release must provision an empty database and deploy the matching Worker/package deliberately; source publication does not reset existing data or deploy anything.

Other historical migrations/tables and historical documents under `docs/` are retained. Existing local historical-schema tests cover those structures on the revised fresh-install chain; they do not attest upgrade support for the old single-plan deployment. Historical evidence semantics and public redaction remain unchanged. Do not deploy an older Worker against v3 data.

## Historical hosted installation (3.0.0)

The fresh private v3 Site is https://plan-time-tracker-v3.seraf-k.chatgpt.site (`appgprj_6ad342fe722481919f98177e1c447931`). Its first published version uses Site source commit `b3f392358e73e3881113ed611aff5c5194dabc74`, built from GitHub `74a86a25d98f5965e9ce7801f06e4d15889c003e` with the new project identity. Deployment `appgdep_6ad3434ca4848191b36fcaf34371485e` succeeded with MCP enabled; database overview confirmed the full schema and empty plans/work intervals. Archive checksum: `sha256:ff5e6f46149c12aadfa542d90d568ce93961c6a97774543687ee3bbeb695a135`.

The new Site plugin `plugin_asdk_app_sites_ae77444ef43481919c2588ef24f70c84` was updated to 3.0.0 with the mandatory tracking skill, fixtures and local helpers. GitHub's retained marketplace package is 3.0.1 because its App binding changed. Installed clients need the new connection. The old Site was not deleted by deployment; deleting an entire Site is unavailable through the current Sites connector and must be done in Sites settings. This report does not claim an authenticated end-to-end execution against the new App.

## Local verification

```sh
npm test
npm run validate
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/usr/bin/chromium UI_ACCEPTANCE_ARTIFACT_DIR=/tmp/tracker-source-ui npm run test:ui
node --test ../../plugin/plan-time-tracker/test/*.test.mjs
```

`npm test` builds the ignored Worker artifact and runs mandatory timer, owner, idempotency, concurrency, migration, evidence and VM UI-contract tests. Browser suites intercept every localhost request and execute the actual Worker with migrated in-memory SQLite. External requests are forbidden. They cover responsive navigation, modal focus, exact replay after lost acknowledgement, source results/checks, completion conditions, cancelled and duplicate finish. These are local tests, not hosted D1/authentication or production-data QA. No dependencies are added by the tests.

Execution snapshots distinguish raw checkpoint state from executor availability through step.execution. A RUNNING checkpoint with a closed/expired attempt needs recovery; it is not actively executing. The owner UI exposes fresh-attempt recovery and pending-attempt Start, using server-aligned lease time and read-only refresh. Recovery leaves plan intervals intact; a paused plan requires an explicit ResumePlan. Historical retired-command receipts expose only safe audit identity/outcome/time and preserve raw stored data.
