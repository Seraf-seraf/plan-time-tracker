# Инструменты MCP

Актуальный список, схемы входов и ограничения возвращает GetTrackerInfo и `tools/list`. Чтение доступно только в области владельца. Изменяющие команды используют UUID commandId; версионируемые команды требуют expectedVersion. GetCommandResult позволяет проверить исход команды после потери ответа.

| Инструмент | Назначение |
| --- | --- |
| CreatePlan, GetPlan, ListPlans, UpdatePlan | Сохранить и прочитать план, изменить метаданные или обновить документ до первого запуска. |
| StartPlan, PausePlan, ResumePlan, FinishPlan | Управлять временем конкретного плана. |
| DeletePlan, RestorePlan | Удалить план или восстановить без запуска таймера. |
| GetPlanProgress, SetStepStatus | Читать и изменять текущее состояние этапов. |
| SaveTaskAssessment, GetTaskAssessment | Сохранить оценку или прочитать исходные требования и ревизии. |
| EstimatePlanTime, GetSavedEstimate | Рассчитать текущий прогноз или прочитать текущий либо зафиксированный снимок. |
| GetTrainingStatus, GetTrainingData, GetTrainingHistory | Прочитать состояние, примеры или попытки обучения. |
| StartTraining, ContinueTraining | Запросить обучение или продолжить ограниченную обработку. |
| GetTimeReport, GetTimeHistory | Прочитать измеренное время и оценки. |

Признаки и интервалы описаны в [ATLM](atlm.md), учёт времени — в [контракте плана](plan-documents.md).
