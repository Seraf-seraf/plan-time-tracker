# Экспорт JSON, формат 2

`GET /api/export` возвращает один согласованный снимок данных аутентифицированного владельца. Ответ имеет `formatVersion:2`, `exportedAt`, `timezone`, `summary` и `plans`. Чтение не создаёт записи владельца и не меняет таймер.

Summary содержит planCount, deletedPlanCount, measuredPlanCount, totalActiveMs и sumPlanActiveMs. Удалённые планы включены в plans и исключены из totals. totalActiveMs объединяет интервалы активных планов владельца; sumPlanActiveMs суммирует их отдельно. При отсутствии измерений итог null; измеренный ноль остаётся 0.

План включает идентификатор, название, описание, критерии, исходный planText при наличии, дату составления с её исходной точностью, registeredAt, status, deletedAt, firstStartedAt, finishedAt, sourceReference, completion, activeMs, calendarMs, pausedMs и intervals.

Интервал имеет `{intervalId,startMs,endMs}`; открытый endMs — null. Дата instant имеет value с явным UTC-смещением и timeZone, dateOnly — on и timeZone. Date history сохраняет предыдущую дату, changedAt и причину её исправления.

Steps содержат `{stepId,ordinal,title,content,status,version,createdAt,updatedAt,readyToFinish,assessments}`. Это текущие состояния. Плановые и поэтапные assessment revisions содержат исходную методику, scale, complexity, context, forecast, approach, requirements и needsRevision. Пользовательские ключи в context сохраняются без удаления по совпадению имени.

FinishExceptions содержат reason и recordedAt. Старые попытки, результаты и проверки отдельного механизма исполнения, журнал событий и история смены статусов в экспорт не входят. Формат 1 не поддерживается.

Коллекции читаются одним SQL snapshot. ExportedAt фиксируется после его чтения; параллельное изменение не смешивает строки из разных состояний. Экспорт — пользовательский отчёт, а не полный backup внутренних очередей и артефактов обучения.
