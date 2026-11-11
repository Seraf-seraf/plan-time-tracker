# Названия инструментов MCP

Имена команд — короткие глаголы на английском, описания — на русском. Для совместимости старые имена переименованных инструментов ещё принимаются, но в списке показываются новые. Удалённые CalculateEstimate и BlockStep не работают.

## Прогноз и время

| Раньше | Теперь | Что делает |
| --- | --- | --- |
| CalculateAtlmEstimate | EstimatePlanTime | Вычисляет прогноз полного активного времени до первого запуска. |
| GetPlanEstimate | GetSavedEstimate | Читает ранее сохранённый прогноз, не рассчитывает новый. |
| CalculateEstimate | удалить | Старый отдельный расчёт медианы больше не нужен в основном сценарии. |
| GetAnalytics | GetTimeReport | Показывает уже затраченное время за период. |
| GetEstimationModelStatus | GetTrainingStatus | Показывает состояние обучения и количество пригодных примеров. |
| StartEstimationTraining | StartTraining | По прямой просьбе пользователя запрашивает попытку обучения. |
| ProcessEstimationTraining | ContinueTraining | Продолжает уже начатую подготовку данных и обучение. |
| GetAtlmDataset | GetTrainingData | Показывает примеры обучения и причины исключения. |
| RecordAssessment | SaveTaskAssessment | Сохраняет признаки задачи и запрашивает сохранение прогноза. |
| GetAssessment | GetTaskAssessment | Читает сохранённую оценку или исходные требования. |
| GetEstimationHistory | GetTimeHistory | Читает историю фактов времени и оценок. |

## Планы, шаги и события

Понятные названия CreatePlan, GetPlan, ListPlans, StartPlan, PausePlan, ResumePlan, FinishPlan, DeletePlan, RestorePlan, CreateStep, UpdateStep и StartStep оставить. Для остальных команд используются следующие названия:

| Раньше | Теперь | Что делает |
| --- | --- | --- |
| UpdatePlanMetadata | UpdatePlan | Изменяет название, описание или критерии плана. |
| GetTrackerCapabilities | GetTrackerInfo | Возвращает поддерживаемые возможности и ограничения. |
| GetPlanExecutionSnapshot | GetPlanProgress | Показывает шаги, попытки и проверки плана. |
| GetTimeline | GetPlanHistory | Показывает события плана по порядку. |
| GetCommandReceipt | GetCommandResult | Проверяет результат ранее отправленной команды. |
| ClaimStepAttempt | AssignStepAttempt | Закрепляет попытку шага за исполнителем. |
| RenewStepLease | ExtendStepAssignment | Продлевает право исполнителя на попытку. |
| CloseStepAttempt | CloseStepAttempt | Закрывает попытку без подмены результата шага. |
| RecordStepResult | SaveStepResult | Записывает результат шага. |
| RecordCheck | SaveCheckResult | Записывает результат проверки. |
| AppendObservation | RecordActivityEvent | Записывает служебное событие агента для истории и диагностики. |
| BlockStep | удалить | Новые блокировки не создаются; ранее сохранённая история остаётся. |

После обновления открой новую сессию, чтобы клиент получил актуальный список инструментов.
