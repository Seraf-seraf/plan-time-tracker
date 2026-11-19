# Инструменты MCP

`tools/list` возвращает имена и схемы входов. `GetTrackerInfo` возвращает возможности, ограничения и полную схему признаков ATLM в `assessments.atlm.agentTaskSchema`. Сохранённые данные доступны только владельцу. Для изменяющей команды используйте UUID `commandId` и, если схема его требует, `expectedVersion` соответствующей сущности.

| Инструмент | Назначение |
| --- | --- |
| `GetTrackerInfo`, `GetCommandResult` | Прочитать возможности трекера или сохранённую квитанцию команды. |
| `CreatePlan`, `GetPlan`, `ListPlans`, `UpdatePlan` | Создать и прочитать план, изменить метаданные или обновить документ до первого запуска. |
| `StartPlan`, `PausePlan`, `ResumePlan`, `FinishPlan` | Управлять временем конкретного плана. Первый запуск требует готовой оценки. |
| `DeletePlan`, `RestorePlan` | Переместить план в удалённые или восстановить без запуска таймера. |
| `GetPlanProgress`, `SetStepStatus` | Читать и изменять текущее состояние этапов. |
| `SaveTaskAssessment`, `GetTaskAssessment` | Сохранить оценку или прочитать текущие требования и ревизии. |
| `EstimatePlanTime`, `GetSavedEstimate` | Рассчитать предпросмотр по переданным признакам или прочитать прогноз по сохранённой оценке. |
| `GetTrainingStatus`, `GetTrainingData`, `GetTrainingHistory` | Прочитать состояние, примеры или попытки обучения. |
| `StartTraining`, `ContinueTraining` | Запросить обучение или выполнить ограниченный проход текущей очереди. |
| `GetTimeReport`, `GetTimeHistory` | Прочитать измеренное время и ревизии оценок. |

Признаки и интервалы описаны в [ATLM](atlm.md), учёт времени — в [контракте плана](plan-documents.md).
