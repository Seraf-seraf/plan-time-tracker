# Оценки и фактическое время

SaveTaskAssessment сохраняет неизменяемую оценку плана или этапа. Метод, шкалу, сложность, допущения и способ решения задаёт агент. Для первой записи используется expectedVersion=0; для ревизии нужны текущая версия серии и причина. Команды защищены квитанциями и CAS.

Перед анализом вызовите GetTaskAssessment без assessmentId и сохраните `currentRequirementsDigest` как `expectedRequirementsDigest`. При изменении требований сервер отклоняет запись; перечитайте контекст и пересмотрите оценку. GetTaskAssessment с assessmentId возвращает ревизию и признак needsRevision.

Для прогноза передайте `context.agentTask` по [справочнику признаков](../plugin/plan-time-tracker/skills/assess-task/references/features.md) и `predictionRequest:{method:"ATLM",methodVersion:1}`. Сервер рассчитывает `serverEstimation`; сложность остаётся отдельным описательным полем. Размер assessment вместе с прогнозом — не более 65 536 байт UTF-8, глубина JSON — 12. Секреты, исходники и полные журналы не записываются.

GetTimeHistory читает выбранные targets и период `from`, `to`, `timeZone`. PLAN_ACTIVE, CALENDAR и PAUSED измеряются в миллисекундах по интервалам родительского плана. Общий итог объединяет интервалы; готовность этапа отражает текущее состояние. Для пагинации оценок сохраняйте `asOf` и `throughSequence`. Прогноз и фактическое время не подменяют друг друга; правила фиксации и обучения описаны в [ATLM](atlm.md).

Перед первым StartPlan прочитайте assessmentReadiness из GetSavedEstimate. Только READY разрешает старт. Исправьте поля из missingPaths и invalidPaths, сохраните ревизию и отправьте новую команду запуска. При повторе прежнего commandId сервер возвращает исходную квитанцию.
