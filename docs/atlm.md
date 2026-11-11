# Прогноз времени агентов по ATLM

ATLM прогнозирует полное активное время плана от первого `StartPlan` до принятого результата. Агент описывает задачу до исполнения; сервер вычисляет прогноз и накапливает пригодные завершённые планы. После каждых пяти новых пригодных планов он проверяет новую модель на всей накопленной истории.

Метод: `atlm/agent-v1`, схема признаков: `agent-task-v1`, метрика: `PLAN_ACTIVE`, область: `FULL_FROM_FIRST_START`. Подготовка оценки до запуска не входит во время. Ожидание инструментов при RUNNING входит, пользовательские паузы исключены только при записанном `PausePlan`. Параллельные попытки и вызовы инструментов не прибавляются отдельно к интервалам плана. Ошибочные попытки и исправления внутри принятого плана остаются в его времени.

Это условный прогноз по принятым задачам с неизменным объёмом. Он не оценивает вероятность успеха, человеко-часы, расход токенов или остаток работы. Вычитание затраченного времени из первоначальной точки не даёт прогноз остатка.

## Какие сведения задаёт агент

`RecordAssessment.payload.context.agentTask` содержит следующие обязательные поля. Неизвестность разрешена при сохранении: категория `UNKNOWN`, список `null`, неизвестные метаданные `null`. Известное отсутствие записывается как пустой список `[]`.

| Поле | Смысл |
| --- | --- |
| `schemaVersion` | `agent-task-v1` |
| `profile.workKind` | CREATE_MECHANISM, MODIFY_MECHANISM, RUN_EXISTING_PROCESS, VERIFY_EXISTING, MIGRATE_DATA, INVESTIGATE, MIXED или UNKNOWN |
| `profile.reuseState` | ABSENT, PARTIAL, READY или UNKNOWN |
| `profile.doneBoundary` | ANALYSIS, LOCAL_VERIFIED, LOCAL_STAGED, PUBLISHED, DEPLOYED_VERIFIED или UNKNOWN |
| `outcomes` | До 20 самостоятельных требуемых результатов: `{id,description,evidence}` |
| `changedContracts` | До 20 меняющихся операций/форматов/схем: `{kind,key,description,evidence}`, kind — API, MCP, EVENT, STORAGE или OTHER |
| `verificationKinds` | Уникальные требуемые виды проверок: BUILD_STATIC, UNIT, INTEGRATION, UI_E2E, DEPLOY_SMOKE |
| `profileEvidence` | Краткие основания для workKind, reuseState и doneBoundary |
| `runtimeContext` | `{modelId,reasoningEffort,environmentId,plannedParallelAgents,provenance}`; provenance — CLIENT_REPORTED или UNKNOWN |

id/key — 1–128 символов; description/evidence и каждое основание профиля — 1–400; строки runtimeContext — до 128. plannedParallelAgents — положительное целое или null. Общий assessment, включая результат сервера, ограничен 24 000 UTF-8 байтами и глубиной JSON 10. Переполнение отклоняется без обрезания.

Сервер сортирует списки и объединяет точные дубли. Разные описания одного ключа отклоняются. Из разных ключей сервер не угадывает, что агент дважды описал один результат: это предотвращает инструкция assess-task. Число шагов, файлов или запусков одного теста не заменяет число результатов и видов проверки. Клиентские outcomeCount/contractCount/verificationKindCount не принимаются: три числа сервер получает из списков. С тремя категориями профиля они образуют шесть признаков.

Сведения о модели исполнителя, effort, среде и параллельности сохраняются как заявленные метаданные; они не входят в регрессоры v1 и не удостоверяют равную скорость разных моделей. Эти шесть признаков — гипотеза для задач агентов. Публикация ATLM не доказывает полезность именно такого набора или точность на этой базе.

## Сохранение исходной оценки

1. Зарегистрировать PLANNED-план и необходимые шаги обычным track-plan.
2. Обнаружить `assessments.atlm` через GetTrackerCapabilities. Прочитать `GetAssessment({planId})` без assessmentId и сохранить currentRequirementsDigest до анализа.
3. Записать обычный RecordAssessment с context.agentTask и `predictionRequest:{method:"ATLM",methodVersion:1}`. Все прежние обязательные поля assessment сохраняются. predictionRequest разрешён только для целого плана до первого запуска.
4. Сервер сохраняет прогноз в `assessment.serverEstimation`. Это поле нельзя прислать клиентом. Недостаток данных сохраняет признаки и явную причину UNAVAILABLE; ошибка БД остаётся ошибкой протокола.
5. При первом StartPlan триггер в той же транзакции фиксирует последнюю уже записанную подходящую ревизию с совпадающими текущими требованиями. Отсутствие такой ревизии не блокирует запуск, но план не становится обучающим примером.

Поздняя запись, ResumePlan, восстановление и новая ревизия не заменяют исходный снимок. Старые планы без проверяемого исходного снимка не размечаются задним числом. При ASSESSMENT_CONTEXT_CHANGED нужно прочитать требования и пересмотреть описание; нельзя механически подставить свежий digest. Неопределённый результат записи восстанавливается точным повтором commandId или GetCommandReceipt.

Когда ATLM даёт только точку, старый `forecast` остаётся `status:UNKNOWN`, `lowerMs:null`, `upperMs:null`, `confidence:UNKNOWN`. Точка находится в serverEstimation и не превращается в гарантированный интервал. Сложность и выбранный способ решения остаются отдельными полями агента.

## MCP и HTTP

Инструменты объявляются в `assessments.atlm`; поддержка определяется discovery, а не одним номером приложения. Обычные командные конверты сохраняют schemaVersion=1.

| Инструмент | Назначение и HTTP |
| --- | --- |
| CalculateAtlmEstimate | Предпросмотр по активной модели: `{planId,expectedRequirementsDigest,agentTask}`. POST `/api/tracker/atlm-estimate` |
| GetPlanEstimate | Сохранённый прогноз `{planId}`; после запуска возвращается исходный снимок, без создания прогноза задним числом. GET `/api/tracker/plans/:planId/estimate` |
| GetEstimationModelStatus | `{}`: накопление опыта, действующая модель, очередь и причины недоступности. GET `/api/tracker/estimation-model` |
| ProcessEstimationTraining | `{}`: один ограниченный идемпотентный проход очереди владельца. POST `/api/tracker/estimation-model/process` |
| GetAtlmDataset | Приватная выгрузка frozen sample-версий `{limit?,cursor?}`, default 50, max 100. POST `/api/tracker/atlm-dataset` |

Только ProcessEstimationTraining является мутацией среди этих пяти инструментов. Чтение не обучает модель. Все пути используют аутентифицированного владельца, не принимают чужие owner/model/sample IDs, заданные клиентом веса, длительности или список предпочитаемых аналогов.

serverEstimation содержит formatVersion=1, metric/forecastScope, status AVAILABLE/UNAVAILABLE, nullable pointMs, method, nullable modelId/modelVersion, серверные requirementsDigest/featureDigest/calculatedAt, sampleCount, evaluation либо null, accuracy HISTORICALLY_EVALUATED/NOT_VALIDATED, interval=null и confidence=UNKNOWN. Точка не обозначается P50/P80. evaluation включает caseCount, coverage, maeMs, medianBaselineMaeMs, cutoff и protocolVersion.

GetPlanEstimate возвращает `{formatVersion:1,planId,assessmentId,assessmentRevision,source,serverEstimation,isStale,staleReasons,serverNow}`. source — FROZEN_INPUT после старта, LATEST_ASSESSMENT до старта либо NONE; отсутствующая оценка явно равна null. Состояние обучения отдельно от сохранённого прогноза: отклонение нового кандидата не скрывает доступную прежнюю оценку. Неполные признаки и отсутствие модели различаются с ошибками авторизации, устаревшим digest, БД и ресурсными отказами; у последних остаётся обычный ошибочный ответ с requestId/retryable.

GetEstimationModelStatus возвращает datasetRevision, eligibleSampleCount, excludedSampleCount, newPlansSinceTraining, retrainEveryNewPlans, причины исключений, activeModel или null, lastReason/lastError и training. В training находятся status, generation, due, attempts, nextAttemptAt, pendingRefreshCount, progressRevision и progress. Статусы: IDLE, QUEUED, RUNNING, RETRY_WAIT, COLLECTING_DATA, REJECTED, FAILED. `due` означает возможность ограниченного прохода сейчас, включая восстановление примеров; ожидание nextAttemptAt не считается due.

GetAtlmDataset возвращает formatVersion=1, datasetRevision, asOf, rows, hasMore, nextCursor и serverNow. rows содержат неизменяемые версии примеров в порядке sequence. sampleId — строковое представление числового sequence; eligibility — ELIGIBLE либо EXCLUDED, reasons — список причин. features содержит шесть вычисленных признаков; actualMs, capturedAt, sourceAvailableAt и observedAt находятся на верхнем уровне строки. Также возвращаются inputAssessmentSequence, sourceDigest/sourceGeneration, issuedPrediction и firstEligible. Каждая ревизия не считается новым опытом. Первая страница фиксирует datasetRevision/asOf. Изменение набора между страницами возвращает DATASET_CHANGED; выгрузку нужно начать заново. Данные владельца не должны попадать в Git или постоянные синтетические фикстуры. Аналитический [JSON-отчёт](json-report.md) сохраняет context.agentTask и serverEstimation в истории assessment, но не является архивом очереди и всех моделей.

## Локальная проверка выгрузки

CLI `scripts/evaluate-atlm.mjs` — отдельный инструмент разработчика; для обычной работы MCP он не нужен. Он принимает нормализованный JSON, а не сырой ответ GetAtlmDataset. Сначала запросите все страницы, каждый раз передавая nextCursor предыдущей страницы; datasetRevision и asOf должны совпадать. При DATASET_CHANGED начните выгрузку заново. Затем выберите последнюю числовую sampleId **среди всех версий** каждого planId и только после этого разделите ELIGIBLE и EXCLUDED. Если сначала убрать EXCLUDED, можно ошибочно вернуть удалённый или изменённый источник в обучение.

Пример преобразования массива `pages` из полных ответов одной выгрузки:

```js
const first = pages[0];
if (!first || pages.some(p => p.datasetRevision !== first.datasetRevision || p.asOf !== first.asOf)
    || pages.at(-1).hasMore || pages.at(-1).nextCursor !== null) {
  throw new Error("Нужны все страницы одного снимка");
}
const latest = new Map();
for (const row of pages.flatMap(p => p.rows)) {
  const previous = latest.get(row.planId);
  if (!previous || Number(row.sampleId) > Number(previous.sampleId)) latest.set(row.planId, row);
}
const samples = [...latest.values()];
const normalized = {
  formatVersion: 1, sourceAuthority: "OWNER_EXPORT", asOf: first.asOf, nextCursor: null,
  rows: samples.filter(r => r.eligibility === "ELIGIBLE").map(r => ({
    sampleId: r.sampleId, planId: r.planId, capturedAt: r.capturedAt,
    sourceAvailableAt: r.sourceAvailableAt, features: r.features, actualMs: r.actualMs,
  })),
  excluded: samples.filter(r => r.eligibility === "EXCLUDED").map(r => ({
    sampleId: r.sampleId, planId: r.planId, reasons: r.reasons,
  })),
};
```

Сохраните normalized как UTF-8 JSON вне Git и выполните `node scripts/evaluate-atlm.mjs <normalized-dataset.json>` из sites/plan-time-tracker. Предел CLI — 8 МиБ; входы SYNTHETIC остаются явно синтетическими. Хронологические cutoff проверяются ядром; отдельный sourceExcludedCount в результате сохраняет число исключённых источников. При пустой пригодной выборке MAE остаётся null и candidateReady=false; ноль не подставляется. CLI не обучает активную модель сервера и не меняет историю владельца.

## Накопление опыта и обновление модели

Пригоден только завершённый принятый план с полными исходными признаками, результатами и обязательными проверками, полными серверными интервалами, неизменным объёмом и без удаления. Изменение требований A→B→A также меняет объём; запись того же значения без изменения — нет. Долгие планы не отбрасываются из-за длительности. Один план даёт не более одной единицы нового опыта за всё время; повтор Finish, восстановление и ревизии не создают новые планы.

Через каждые **5 новых пригодных уникальных планов** ставится TRAIN-задание. Это частота попытки, а не достаточный размер первой модели. Неудачная проверка или нехватка данных фиксирует рассмотренную пятёрку: следующая автоматическая попытка ждёт следующие пять новых примеров. История, исходные прогнозы и версии сохраняются. Обучение использует все пригодные данные текущей версии; при превышении предела v1 в 5000 строк возвращается DATASET_LIMIT_REACHED без скрытого усечения или удаления истории.

Изменение использованного источника делает зависящую модель непригодной для свежих прогнозов и ставит пересборку независимо от пятёрки. Изменения источника и постановка задания атомарны. Задания и поколения хранятся в D1; lease 60 секунд и fencing token не позволяют старому исполнителю активировать результат после передачи работы другому. Проход ограничен 10 секундами wall time; это не заменяет фактический CPU-лимит платформы.

Worker запускает обработку после успешной команды через ctx.waitUntil. Ошибка обучения не отменяет уже подтверждённый FinishPlan. После аварии очередь сохраняется, а следующий сеанс навыка или открытие интерфейса продолжает due-работу. Без новых обращений гарантированного повторного запуска после аварии нет. Периодический cron или LLM-задача не устанавливаются.

Временный сбой допускает первую попытку и ещё три повтора с задержками 1/5/15 минут. До nextAttemptAt обработка не запускается. После исчерпания попыток состояние FAILED остаётся видимым; пригодная текущая модель сохраняется. Пять новых планов могут создать следующее поколение.

## Математика и проверка качества

Основа — [Whigham, Owen, MacDonell: A Baseline Model for Software Effort Estimation](https://arxiv.org/abs/2102.02933): обычная линейная регрессия с автоматическим выбором identity/log/sqrt и dummy-кодированием категорий. В адаптации agent-v1 целевая величина внутри расчёта — минуты, наружу выдаются ms. Выбор преобразования минимизирует абсолютную b1-асимметрию на обучающей части; log допустим только для строго положительных значений, sqrt — для неотрицательных. Скрытого +1 нет. В agent-v1 константные предикторы удаляются, расчёт использует QR с pivoting; недостаток ранга — явная причина отказа, а не скрытое переключение на ridge. Минимум `n-p>=5` — эксплуатационная граница, не гарантия точности.

Историческая проверка выбирает последние не более 20 пригодных случаев до проверки того, удалось ли предсказать каждый из них. Для случая используются только примеры, все факты которых уже были доступны строго до времени его исходной оценки; текущий план и его ревизии исключаются. Все преобразования вычисляются заново на этой обучающей части. Учитываются пропуски и coverage, а не только удачные прогнозы.

Первая модель требует минимум пяти общих внеобучающих случаев и MAE не хуже медианы на тех же случаях. Обновление дополнительно сравнивается с прежней замороженной моделью минимум на пяти общих новых случаях вне её обучающего manifest, без ухудшения MAE/coverage. После проверки финальные коэффициенты пересчитываются по всему допустимому снимку. Проверка описывает процедуру обучения; она не является проверкой этих окончательных коэффициентов на неизвестном будущем.

Кандидат активируется атомарно только после всех проверок. Отклонённый кандидат не заменяет прежнюю пригодную модель. Ошибки реально выданных до исполнения прогнозов учитываются отдельно и не переписываются задним числом. MAE, размер проверки и доля доступных прогнозов помогают оценить опыт; ни in-sample R², ни пять наблюдений не дают права обещать HIGH confidence или гарантированную длительность.

## Интерфейс и проверки реализации

В карточке плана показана сохранённая оценка полного активного времени, версия модели и историческая ошибка при наличии. Устаревшая оценка помечена; отсутствие оценки не превращается в ноль. Настройки показывают число новых пригодных планов до следующей попытки, накопленные данные, очередь и её последнюю причину отказа. Раскрываемое пояснение показывает причины исключения планов, в том числе отсутствие исходных признаков до первого запуска. При due-работе интерфейс запускает ограниченное обслуживание; обновление статуса само по себе остаётся чтением. Автоматически допускается не более восьми проходов за сеанс и один проход для неизменного ключа datasetRevision/generation/progressRevision/pendingRefreshCount/nextAttemptAt. После прохода выполняются не более трёх контрольных чтений; ручное «Продолжить обработку» начинает новый ограниченный цикл. Ошибка обработки остаётся видимой при контрольном чтении. Поздний ответ плана не попадает в уже открытый другой план.

Целевые проверки: `node --test test/atlm-*.test.js`, `node test/ui-atlm.mjs` из sites/plan-time-tracker, `node --test test/atlm-instructions.test.mjs` из plugin/plan-time-tracker. CLI проверки истории: `node scripts/evaluate-atlm.mjs <dataset.json>`. Общая проверка сайта — `npm test`, `npm run validate`, `npm run test:ui`. Синтетические примеры проверяют реализацию; реальная точность требует отдельной накопленной выборки. Результаты конкретного выпуска фиксируются в release readiness, а не выводятся из наличия этих команд.

Новая GitHub-миграция — `0019_atlm.sql`. Для существующего Sites источника сохраняется отдельный ledger и добавляется эквивалентная `0004_atlm.sql`; старые миграции не переписываются. Обновление GitHub само по себе не подтверждает публикацию Sites или установку нового пакета навыков. Старые CalculateEstimate, GetEstimationHistory и схемы оценки сохраняют свой смысл; ATLM не принимает candidates.
