# Экспорт JSON, формат 2

`GET /api/export` возвращает один согласованный снимок данных аутентифицированного владельца. Ответ имеет `formatVersion:2`, `exportedAt`, `timezone`, `summary` и `plans`. Чтение не создаёт записи владельца и не меняет таймер.

Summary содержит planCount, deletedPlanCount, measuredPlanCount, totalActiveMs и sumPlanActiveMs. Удалённые планы включены в plans и исключены из totals. totalActiveMs объединяет интервалы активных планов владельца; sumPlanActiveMs суммирует их отдельно. При отсутствии измерений итог null; измеренный ноль остаётся 0.

План включает идентификатор, название, описание, критерии, исходный planText при наличии, дату составления с её исходной точностью, registeredAt, status, deletedAt, firstStartedAt, finishedAt, sourceReference, completion, activeMs, calendarMs, pausedMs и intervals.

Интервал имеет `{intervalId,startMs,endMs}`; открытый endMs — null. Дата instant имеет value с явным UTC-смещением и timeZone, dateOnly — on и timeZone. Date history сохраняет предыдущую дату, changedAt и причину её исправления.

Steps содержат `{stepId,ordinal,title,content,status,version,createdAt,updatedAt,readyToFinish,intervals,assessments}`. Это текущие состояния. `steps[].intervals` содержит записанные интервалы этапа `{startMs,endMs}`; открытый endMs — null. Паузы плана исключаются при пересечении с интервалами плана; до начала измерений массив пуст. Плановые и поэтапные assessment revisions содержат исходную методику, scale, complexity, context, forecast, approach, requirements и needsRevision. Пользовательские ключи в context сохраняются без удаления по совпадению имени.

FinishExceptions содержат reason и recordedAt. Старые попытки, результаты и проверки отдельного механизма исполнения, журнал событий и история смены статусов в экспорт не входят. Формат 1 не поддерживается.

Коллекции читаются одним SQL snapshot. ExportedAt фиксируется после его чтения; параллельное изменение не смешивает строки из разных состояний. Экспорт — пользовательский отчёт, а не полный backup внутренних очередей и артефактов обучения.

В assessment.serverEstimation сохраняются исходный method и необязательные поля гибрида: hybrid={policyVersion,selectedEngine,usedEngine,fallbackReason}, evaluation.metricsScope=FULL_POLICY, caseCount/modelCaseCount, coverage/operationalCoverage и сопоставимые ошибки. Исторические оценки agent-v2 и historical-median не пересчитываются новым алгоритмом. Добавление необязательных полей не меняет formatVersion=2 отчёта.

Отчёт не является архивом estimation_samples, очереди и артефактов моделей. Для проверки протокола 2 нужен полный журнал GetTrainingData, описанный в [ATLM](atlm.md#локальная-проверка-экспорта). Новые issuedPrediction этого журнала допускают modelId=null у медианы и не подменяют measured actualMs.
