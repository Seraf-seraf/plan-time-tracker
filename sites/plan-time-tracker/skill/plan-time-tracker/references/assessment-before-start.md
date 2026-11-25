## Оценить задачу до первого запуска плана

Получите схему `agent-task-v4` из `GetTrackerInfo.assessments.atlm.agentTaskSchema`. Если доступен навык assess-task, используйте его справочник и пример запроса. Перед анализом вызовите `GetTaskAssessment` с одним `planId` и сохраните `currentRequirementsDigest`. В `SaveTaskAssessment` передайте его как `expectedRequirementsDigest`, заполните `context.agentTask` и добавьте `predictionRequest:{method:"ATLM",methodVersion:1}`. Сервер сохраняет прогноз в `serverEstimation`.

Перед первым `StartPlan` вызовите `GetSavedEstimate`. Статус `assessmentReadiness.status=READY` разрешает запуск независимо от доступности прогнозного числа. В остальных случаях исправьте оценку по коду и путям в `assessmentReadiness`. `GetSavedEstimate` до начала работы рассчитывает текущий прогноз по сохранённым признакам. Первый запуск фиксирует результат на весь план.
