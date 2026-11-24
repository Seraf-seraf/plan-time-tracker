# Инструменты MCP

`tools/list` возвращает имена и схемы входов. `GetTrackerInfo` возвращает возможности, ограничения и полную схему признаков ATLM в `assessments.atlm.agentTaskSchema`. Условные схемы и пределы реестра моделей находятся в `assessments.atlm.registry`. Сохранённые данные доступны только владельцу. Для изменяющей команды используйте UUID `commandId` и, если схема его требует, `expectedVersion` соответствующей сущности.

| Инструмент | Назначение |
| --- | --- |
| `GetTrackerInfo`, `GetCommandResult` | Прочитать возможности трекера или квитанцию команды по `commandId`. При `FINAL` поле `result` содержит успех, поле `error` содержит отказ. |
| `CreatePlan`, `GetPlan`, `ListPlans`, `UpdatePlan` | Создать и прочитать план, изменить метаданные или обновить документ до первого запуска. |
| `StartPlan`, `PausePlan`, `ResumePlan`, `FinishPlan` | Управлять временем конкретного плана. Первый запуск требует готовой оценки. При паузе после подтверждённого BLOCKED передайте причину в `PausePlan.payload.reason`. |
| `DeletePlan`, `RestorePlan` | Переместить план в удалённые или восстановить без запуска таймера. |
| `GetPlanProgress`, `SetStepStatus` | Читать и изменять текущее состояние этапов. `SetStepStatus.payload` принимает `stepId` и `status`. |
| `SaveTaskAssessment`, `GetTaskAssessment` | Сохранить оценку или прочитать текущие требования и ревизии. |
| `EstimatePlanTime`, `GetSavedEstimate` | Рассчитать предпросмотр по переданным признакам или прочитать прогноз по сохранённой оценке. |
| `CreateTrainingSnapshot` | Создать неизменяемый снимок с `mode:'create'`. В `mode:'read'` использовать `view:'list'` для списка или `snapshotId` для остальных видов. |
| `SaveDatasetRevision` | Для каждой строки сохранить решение `ELIGIBLE` с признаками `ACTUAL`, проверенными по результатам этого плана, или `EXCLUDED` с причиной. Итог `SAVED` содержит ID и digest датасета. |
| `GetDatasetRevision` | Использовать `view:'list'` с необязательным `snapshotId` для поиска. Для `summary`, `rows`, `download` и `filePart` использовать `datasetRevisionId`. |
| `RegisterModelRevision` | Сохранить пакет локального обучения по `datasetRevisionId` с артефактом, происхождением данных и отчётом. Итог `REGISTERED` содержит ID модели и допуск к активации. |
| `ListModelRevisions` | Через `view:'list'` прочитать список и указатель для CAS, через `detail` — конкретную ревизию, через `activations` — историю. Для `download` и `filePart` использовать один `modelRevisionId` и `fileKind`. По умолчанию `BUNDLE`, для выгрузки только артефакта укажите `ARTIFACT`. |
| `ActivateModelRevision` | Передать `modelRevisionId`, `expectedActiveModelRevisionId`, `expectedActivationVersion` и причину. При допуске `REQUIRES_EXPERIMENTAL_ACK` или отказе `EXPERIMENTAL_CONFIRMATION_REQUIRED` использовать `acceptExperimental:true` с явного согласия пользователя, в том числе при откате. |
| `GetTimeReport`, `GetTimeHistory` | Прочитать измеренное время и ревизии оценок. |

Для шести операций реестра передавайте `schemaVersion:1`. Для следующей страницы передавайте `nextCursor` как `cursor`. `view:'rows'` для снимка и датасета возвращает компактный перечень. Чтобы получить полные строки, доказательства снимка или исходные байты экспорта, дождитесь `READY` через `view:'download'` и читайте части по `partIndex` из `structuredContent` режима `filePart`.

На фазах `prepare`, `putPart` и `commit` сохраняйте исходные `commandId` и `file`. Для `SaveDatasetRevision` также сохраняйте `snapshotId` и `parentDatasetRevisionId`, для `RegisterModelRevision` — `datasetRevisionId`. [Передача файлов и восстановление после потери ответа](atlm.md#файлы-и-восстановление).

Для CAS прочитайте `ListModelRevisions({schemaVersion:1,view:'list'})`. Используйте `activeModelRevisionId` и `activationVersion` как ожидаемые значения. `servingModelRevisionId` показывает модель, фактически доступную для новых прогнозов.

`StartTraining`, `ContinueTraining`, `GetTrainingStatus`, `GetTrainingData`, `GetTrainingHistory` и их прежние внутренние имена возвращают `FEATURE_REMOVED`. Локальное обучение использует выгруженную ревизию набора. После регистрации артефакта публикацию выполняет отдельный вызов `ActivateModelRevision`.

Признаки и интервалы описаны в [ATLM](atlm.md), учёт времени — в [контракте плана](plan-documents.md).
