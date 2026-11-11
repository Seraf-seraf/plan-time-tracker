> Историческая документация: CalculateEstimate удалён из MCP. Для нового прогноза используйте ATLM, как описано в [atlm.md](atlm.md). Старые записи оценок сохранены.

# Оценки задач — контракт 0.5.0

`assess-task` описывает исходные признаки, сложность и способ решения; при capability
`assessments.atlm` сервер вычисляет прогноз ATLM. `track-plan`
регистрирует планы, шаги, оценки, результаты и проверки. Worker хранит факты,
проверяет структуру и доступ, но не выбирает балл или реализацию. Навыки поставляются
в одном плагине и не зависят от backend-engineering или внешнего LLM-сервиса.

Планирование, включая `/plan`, регистрирует PLANNED-план минимум с одним
проверяемым шагом и оценкой; оно не запускает таймер или реализацию. Справочные
ответы и операции обслуживания самого трекера не создают рекурсивных планов.
Исполнение привязывается к существующим planId/stepId без дублей. Качество и
обязательные проверки важнее ориентира времени.

## Серверный прогноз ATLM

Канонический контракт признаков, численного метода, MCP/HTTP, пригодности данных и
автоматического переобучения находится в [atlm.md](atlm.md). В RecordAssessment
добавлены `context.agentTask` и необязательный
`predictionRequest:{method:"ATLM",methodVersion:1}`. Он разрешён для плана до первого
StartPlan. Сервер дописывает read-only `assessment.serverEstimation`; клиент не
задаёт это поле, веса модели, наблюдаемые длительности или candidates для ATLM.

Неполные признаки и COLLECTING_DATA сохраняются с понятной недоступностью прогноза.
Техническая ошибка остаётся ошибкой. Точечный прогноз не является интервалом: старый
forecast остаётся UNKNOWN с null границами и confidence UNKNOWN. Первый запуск
атомарно фиксирует исходную ревизию; поздняя оценка не становится обучающим примером.

Ниже сохраняется базовый assessment и отдельный legacy метод reference-class-median/1.
Его явный подбор аналогов не требуется при выборе ATLM. Изменение capability не
переписывает ранее сохранённые прогнозы.

## Запись и чтение

`RecordAssessment` использует обычный конверт schemaVersion=1, commandId UUID,
expectedVersion (0 для новой серии, затем текущая ревизия), payload:

- assessmentId UUID — стабильная серия; planId и необязательный stepId — цель;
- expectedRequirementsDigest — обязательный digest требований, прочитанных агентом
  до анализа задачи, в формате `sha256:<64 lowercase hex>`;
- context: ожидаемый результат, границы и проверки в свободном bounded JSON;
- method: id, version, scale (описание шкалы в JSON);
- complexity: status KNOWN/UNKNOWN, value (JSON либо null), rationale;
- unknowns, assumptions, dependencies — массивы строк;
- forecast: status KNOWN/UNKNOWN, metric, lowerMs/upperMs (null для UNKNOWN),
  confidence (HIGH/MEDIUM/LOW/UNKNOWN), basis и sampleCount;
- sources — до 20 ссылок {planId, stepId?};
- approach: description и rationale; phase; reason для последующих ревизий.

Метрики прогноза: PLAN_ACTIVE, CALENDAR, PAUSED, STEP_ATTRIBUTED, ATTEMPT,
TOOL. Это виды измерения времени, а не методики сложности. Фиксированного перевода
story points в часы нет. Диапазон KNOWN допускает настоящий измеренный ноль,
UNKNOWN требует null. Неизвестная сложность требует null, а не выдуманный балл.
Метод, его версия и шкала объявляются агентом без whitelist. JSON ограничен
глубиной, размером и количеством элементов. Автор и дата назначаются сервером.

Серия неизменно привязана к цели. Разные агенты/методики могут создавать отдельные
серии для одной цели; ревизия может менять методику с объяснением. Каждая ревизия
содержит previousRevision, снимок требований и его digest. CAS, запись и квитанция
атомарны внутри SQL-триггера. Повтор идентичной команды возвращает прежнюю квитанцию;
потерянный ответ восстанавливается GetCommandReceipt. Ревизии нельзя UPDATE/DELETE.

Перед первой оценкой и каждым пересмотром вызовите
`GetAssessment({planId, stepId?})` без assessmentId/revision. Это чтение контекста
без создания серии: ответ содержит contextOnly=true, текущие requirements и
currentRequirementsDigest. Анализируйте эти требования и передайте полученный
digest в expectedRequirementsDigest. При записи SQL атомарно проверяет и digest
клиента, и неизменность серверного снимка. Несовпадение даёт
ASSESSMENT_CONTEXT_CHANGED (409), не создавая ревизию. Отклонённая команда имеет
окончательную квитанцию; точный повтор не превращается в успешную запись.
После конфликта нужен новый анализ нового контекста и новый commandId. Нельзя
просто подставить свежий digest под оценку прежнего объёма. Запись без этого
поля отклоняется.

`GetAssessment({planId, assessmentId, revision?})` возвращает выбранную или
последнюю ревизию, количество ревизий и needsRevision. Изменение описания/критериев
плана, состава/ожидаемого результата/проверок шагов меняет digest. Статус, lease,
таймер и результаты проверок сами по себе его не меняют. Для шага учитываются также
требования родительского плана. Никакого запрета исполнения по баллу нет.
В этом режиме requirements и requirementsDigest относятся к сохранённой
ревизии; currentRequirementsDigest служит диагностикой актуальности. За текущим
контекстом для нового анализа используйте режим чтения без assessmentId.

## История и статистика

`GetEstimationHistory({targets, from, to, timeZone, asOf?, afterSequence?, throughSequence?, limit?})`
принимает явную выборку до 20 уникальных {planId, stepId?}. Агент обосновывает
сопоставимость. Даты включительны в указанной зоне. asOf — серверная граница чтения;
для продолжения страницы передаются прежние asOf, throughSequence и nextAfterSequence
как afterSequence. throughSequence ограничивает историю даже при новых записях с
той же миллисекундой. Окно дат относится к фактам времени; оценки включаются до asOf.
Страницы
содержат неизменяемые ревизии оценок в порядке sequence. Статистики фактов относятся
ко всей выбранной выборке в указанном окне, а не только текущей странице оценок.

В ответе отдельно представлены интервалы плана, календарная длительность и паузы,
время, однозначно отнесённое к шагам (через существующую аналитику), неоднозначное
и нераспределённое время, длительности попыток и наблюдавшихся вызовов инструментов.
Поздняя короткая попытка не обозначается как полная длительность шага. Незакрытые
наблюдения не дают длительности инструмента. Длительности попыток ограничены lease.
В статистику попыток входят окна исполнения, пересекающие период, с обрезкой по
границам периода/asOf. Этот отбор выполняется до ограничения в 100 записей.
Попытки, не начатые на asOf, выбираются по дате claim и имеют durationMs=null.
Подтверждённый нулевой интервал внутри периода остаётся измеренным нулём;
попытка, закончившаяся ровно на начале периода, не добавляет ложный ноль.
Отсутствие измерения обозначается null; неизвестные значения исключаются из
статистик с явным счётчиком. Статистики не смешивают разные метрики. Оценки разных
методик не усредняются. История оценок не фабрикуется для старых планов.

Общее активное время — объединение интервалов выбранных планов, включая родителей
выбранных шагов. Родитель и шаг повторно не суммируются. Для календарного времени
PLANNED-плана измерения ещё нет. Полнота результата и текущих проверок возвращается
через существующий execution snapshot: COMPLETED не гарантирует успешных проверок.
Это текущая готовность, а не восстановление состояния проверок на asOf.
Известность календарного времени определяется отметками начала/окончания отдельно
от активных интервалов. При отсутствии интервалов calendarMs остаётся известным,
а planActiveMs и pausedMs остаются null.

## Добавляемый метод v1: reference-class-median/1

Этот раздел фиксирует локально подготовленный метод и его контракты. Он ещё не
опубликован и не означает, что hosted MCP, установленный плагин или production
Worker уже обновлены. Расчёт — исторический ориентир по серверным полным
интервалам `PLAN_ACTIVE` завершённых планов, а не измеренная точность, вероятность
принятия результата или прогноз длительности любой будущей попытки. Его estimand —
`ACCEPTED_UNCHANGED_SCOPE`: принятые завершённые планы с неизменным объёмом и
подтверждённым измерением. Неудачные промежуточные попытки принятого плана остаются
в его полном времени.

### Чистый расчёт

`calculateComparableEstimate(snapshot)` не читает базу, файловую систему, часы,
случайные значения или сеть. Оно проверяет и детерминированно обрабатывает снимок;
порядок кандидатов не меняет числовой результат или отсортированные включения и
исключения. Сопоставимость — формальная проверка трёх полей профиля, не доказанная
сервером истинность классификации агента. Профиль содержит `workKind`
(`CREATE_MECHANISM`, `MODIFY_MECHANISM`, `RUN_EXISTING_PROCESS`, `VERIFY_EXISTING`,
`MIGRATE_DATA`, `INVESTIGATE`, `MIXED`, `UNKNOWN`), `reuseState`
(`ABSENT`, `PARTIAL`, `READY`, `UNKNOWN`) и `doneBoundary` (`ANALYSIS`,
`LOCAL_VERIFIED`, `LOCAL_STAGED`, `PUBLISHED`, `DEPLOYED_VERIFIED`, `UNKNOWN`).
Любое `UNKNOWN` исключает кандидата из формально сопоставимой выборки; известные
различия отмечаются отдельно.

Вход имеет только поля `methodVersion: 1`, `metric: "PLAN_ACTIVE"`,
`referenceCutoffMs` (неотрицательный safe integer), `sourceAuthority`, `target` и
`candidates`. `target` содержит `planId`, текущий `expectedRequirementsDigest` и
профиль. Каждый кандидат задаёт `planId`, `requirementsDigest`, профиль, решение
`INCLUDE | DESCRIPTIVE | EXCLUDE`, `scopeStability`, `timeCoverage`, непустое
обоснование до 128 символов и источник фактов: `deleted`, `planStatus`, границы
запуска/завершения, доступность источника, `checksConfirmed`, `measurement`,
`activeMs`, число интервалов и их digest. Удалённый кандидат содержит только
`planId` и `deleted: true`. Неизвестные поля, повторяющиеся/целевой IDs, небезопасные
числа, входные длительности от вызывающего агента, risk multiplier, raw point,
число rounds и другие коэффициенты не принимаются.
Чистое ядро сохраняет регистр общих ASCII ID, используемых evaluator; MCP-адаптер
нормализует UUID к lowercase до проверки повторов и утечки целевого planId.

Для серверных фактов `sourceAuthority` равен `SERVER_PLAN_INTERVALS`; только
авторизованный адаптер может установить его. Он читает данные владельца, требования
и интервалы выбранных планов. Клиентские «фактические часы» не принимаются.
`measurement` различает `COMPLETE`, `MISSING` и `INCOMPLETE`; отсутствие измерения
не равно нулю, а подтверждённый закрытый нулевой интервал допустим. Невалидные
измеренные границы или ошибка источника завершают запрос ошибкой, не маскируются
исключением кандидата или пустой выборкой. `EXTERNAL_FIXTURE` используется только
локальным оценочным runner и не является источником живого MCP.

Коды исключения перечисляются в фиксированном порядке: `DELETED_SOURCE`,
`AGENT_EXCLUDED` либо `DESCRIPTIVE_ONLY`, `UNKNOWN_PROFILE`, `PROFILE_MISMATCH`,
`SCOPE_CHANGED` либо `SCOPE_UNCONFIRMED`, `TIME_COVERAGE_UNCONFIRMED`,
`NOT_COMPLETED`, `CHECKS_UNCONFIRMED`, `NO_MEASUREMENT` либо
`INCOMPLETE_INTERVALS`, `AFTER_CUTOFF`. Последний код применяется, если
`sourceAvailableAtMs >= referenceCutoffMs`; cutoff не восстанавливает старые
требования. Не отбрасываются большие подходящие длительности, неудачные попытки
внутри полного плана и случаи только из-за размера времени.

Для `n = 0` метод возвращает `INSUFFICIENT_DATA`, `pointMs: null` и
`observedRange: null`. Иначе `pointMs` — обычная арифметическая медиана: центральное
значение при нечётном `n`, среднее центральных значений с округлением половины вверх
до миллисекунды при чётном `n`. Диапазон `{minMs, maxMs, kind: "OBSERVED_SAMPLE"}`
описывает наблюдавшиеся крайние значения и не является прогнозным интервалом.
Переход `n=4` → `n=5` не меняет метод или точность. Результат фиксирует
`method: {id: "reference-class-median", version: "1"}`, метрику,
`estimand: "ACCEPTED_UNCHANGED_SCOPE"`, статус, `referenceKind`, точку, наблюдавшийся
диапазон, `sampleCount`, `accuracy: "NOT_VALIDATED"`, `intervalCoverage: null`,
отсортированные `includedPlanIds`/`excluded` и `selectionAuthority: "agent"`.

`scoreEstimateCases(cases)` — отдельная чистая функция для локального evaluator.
Для пар известных факта и точки считает `MAE = Σ|prediction − actual| / n`,
`WAPE = 100 × Σ|prediction − actual| / Σactual` и
`signedBias = 100 × Σ(prediction − actual) / Σactual`. Она возвращает числа случаев,
известных фактов и точек, scored и пропущенные количества, долю точек относительно
всех допустимых случаев и метрики. Если пар нет, метрики ошибок равны null; при
нулевой сумме факта WAPE и bias равны null, MAE сохраняется. Эпсилон и скрытая
подстановка знаменателя запрещены. Дубли ID, некорректные значения и небезопасные
целочисленные суммы отклоняются.

### Воспроизводимый снимок и сохранение оценки

Адаптер строит `inputSnapshot` с отсортированными кандидатами и серверным
`sourceAuthority: "SERVER_PLAN_INTERVALS"`. Удалённые кандидаты представлены только
как `{planId, deleted: true}`. Остальные содержат профиль, агентские причины,
статус, подтверждение проверок и агрегаты полных закрытых интервалов; сырые
интервалы, требования, результаты, события и журналы в снимок не входят. Digest
требований проверяется до расчёта. Digest результата — SHA-256 существующей
канонизации `{inputSnapshot, calculation}`; `readAtMs` и ID транспортного запроса в
него не входят. Тот же снимок даёт те же числа и digest, но cutoff не замораживает
изменения базы и digest не подтверждает истинность агентской классификации.

`CalculateEstimate` только читает и ничего не записывает в планы, таймеры, результаты
или оценки. Агент может сохранить ответ обычным `RecordAssessment` в bounded
`context.estimation`: исходные `baseline`, `inputSnapshot`, `calculationDigest`,
`expertAdjustment` отдельно и `forecastScope: "FULL"`. `baseline.pointMs` не
подменяется экспертной поправкой. Наблюдавшийся min/max не записывается как
предсказательный интервал; при наличии только точки штатный `forecast` остаётся
`UNKNOWN` с null границами и confidence. Предыдущие ревизии не меняются. Оставшаяся
работа не вычисляется вычитанием уже затраченного времени из полной медианы.

Короткий пример формирования контекста из проверенного ответа инструмента
(`calculated`):

```js
const estimation = {
  formatVersion: 1,
  baseline: {
    method: calculated.method,
    metric: calculated.metric,
    estimand: calculated.estimand,
    status: calculated.status,
    referenceKind: calculated.referenceKind,
    pointMs: calculated.pointMs,
    observedRange: calculated.observedRange,
    sampleCount: calculated.sampleCount,
    accuracy: calculated.accuracy,
    intervalCoverage: calculated.intervalCoverage,
  },
  inputSnapshot: calculated.inputSnapshot,
  calculationDigest: calculated.calculationDigest,
  expertAdjustment: null,
  forecastScope: "FULL",
};
const context = { ...assessmentContext, estimation };
const forecast = {
  status: "UNKNOWN",
  metric: "PLAN_ACTIVE",
  lowerMs: null,
  upperMs: null,
  confidence: "UNKNOWN",
  basis: "Точка хранится в context.estimation.baseline.pointMs; интервальная оценка не установлена.",
  sampleCount: estimation.baseline.sampleCount,
};
```

После этого `RecordAssessment` получает `context` и `forecast` обычными отдельными
полями. Добавочный экспертный вывод записывается только в `expertAdjustment` с
непустой причиной и не заменяет `baseline.pointMs`; самостоятельный интервальный
прогноз получает `forecast.status: "KNOWN"` и явно экспертное `basis`, если его
границы действительно обоснованы. Тест E2 проверяет чтение/запись ответа
`CalculateEstimate` и его снимка через `RecordAssessment`/`GetAssessment`; сам факт
сохранения не подтверждает точность метода.

Локальный `scripts/evaluate-estimates.mjs` принимает один внешний JSON, не работает
с базой, сетью или командами и выводит JSON либо ошибку с ненулевым exit code.
Training и test разделяются целыми `planGroupId`; факты test не участвуют в точках.
Runner сравнивает общий baseline, профильную медиану и заранее записанную экспертную
точку на их доступных и общих выборках. Он показывает paired metrics, пропуски и
неизвестные факты; синтетические или внешние примеры не становятся историей
владельца и не доказывают прогностическую точность.

### Происхождение переиспользованного кода и тестов

По сообщению пользователя от 2026-11-07, переиспользование кода было согласовано с
разработчиками. Содержание переписки не предоставлено и здесь не утверждается.

| Источник | Переиспользованные части | Получатели и изменения |
|---|---|---|
| `HoboStank/agent-eta`, `agent_eta/forecast.py`, Git blob `b6022b3ffb4f4e16ba1ba467cd607cea5c99f91e` | Проверка допустимых чисел, отбор рядов, сборка результата с явной неизвестной точкой и наблюдавшимися границами | `calculateComparableEstimate` в Worker. Секунды заменены safe integer миллисекундами; выбраны целые планы и формальные причины исключения; известный ноль разрешён; используется обычная существующая медиана. Не перенесены log-медиана, порог 5, raw forecast, shrinkage, коэффициенты или Store. |
| `HoboStank/agent-eta`, `tests/test_agent_eta.py`, Git blob `33a9817b257994100064f9bec2b4094de09dd813` | Сценарии фильтрации, cold start, отсутствующей raw поправки, большого наблюдения, некорректных чисел и numeric overflow; инварианты неизменности исходной оценки, отсутствия сети и сохранения неполных/непринятых случаев | `test/estimation-calculator.test.js`, MCP roundtrip и evaluator. Сценарии перенесены на `node:test` и адаптированы к нашему контракту; не перенесены Python Store, SQLite схема, lifecycle, process hooks или исходные пользовательские данные. |

Source-комментарий рядом с адаптированными функциями ссылается на этот раздел.
Исходное уведомление upstream сохраняется ниже; код не копирует приложение целиком.

```text
MIT License

Copyright (c) 2026 HoboStank

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Проверка выпуска

Нужны чистая установка всех миграций и обновление заполненной 0016-базы, две
методики, ревизии и изменение требований, CAS/повторы/потерянный ответ, права,
удаление, холодный старт, неполные измерения, пересечения и сквозной протокол
планирование → передача контекста → исполнение → результат → пересмотр.
Текстовые проверки навыков и запуск протокола через API не доказывают поведение
произвольного LLM-агента. Проверка обновления репозиторного пакета до 0.5.0 и отдельного hosted-плагина
требует фактической установки; успех упаковки её не заменяет. Версия hosted-плагина
может отличаться от runtime и репозиторного пакета.
