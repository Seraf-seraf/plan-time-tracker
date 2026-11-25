# Примеры плановой оценки ATLM

## Пример исходных признаков

Сверяйте поля и основания с правилами [заполнения признаков](features.md).

```json
{
  "schemaVersion": "agent-task-v4",
  "workUnits": [
    {
      "id": "feature",
      "kind": "MODIFY",
      "description": "Обновить обработчик разбора даты",
      "evidence": "Критерий приёмки parseDate: обработчик принимает YYYY-MM-DD"
    }
  ],
  "doneBoundary": "LOCAL_VERIFIED",
  "reuseLevel": 2,
  "components": [],
  "contracts": [],
  "migrationEntities": [],
  "dataVolumeBand": "NONE",
  "requirementsUncertainty": 0,
  "solutionUncertainty": 1,
  "diagnosisState": "NOT_APPLICABLE",
  "scopeChangeRisk": 0,
  "verificationKinds": [
    "UNIT"
  ],
  "verificationScenarios": [
    {
      "id": "check",
      "description": "Проверить разбор календарной даты",
      "evidence": "Критерий приёмки parseDate: обработчик принимает YYYY-MM-DD"
    }
  ],
  "verificationReadiness": "ADAPT",
  "requiredReviewPasses": 0,
  "environmentReadiness": "READY",
  "accessReadiness": "AVAILABLE",
  "deploymentTargets": [],
  "execution": {
    "mode": "AI_AGENT",
    "modelId": null,
    "reasoningEffort": null,
    "environmentId": "cloud_workspace",
    "plannedParallelAgents": 1,
    "codebaseFamiliarity": "MAPPED"
  },
  "evidence": {
    "doneBoundary": "План локальной проверки обработчика, раздел «Результат и исполнение».",
    "reuseLevel": "План локальной проверки обработчика, раздел «Результат и исполнение».",
    "dataVolumeBand": "План локальной проверки обработчика, раздел «Результат и исполнение».",
    "requirementsUncertainty": "План локальной проверки обработчика, раздел «Результат и исполнение».",
    "solutionUncertainty": "План локальной проверки обработчика, раздел «Результат и исполнение».",
    "diagnosisState": "План локальной проверки обработчика, раздел «Результат и исполнение».",
    "scopeChangeRisk": "План локальной проверки обработчика, раздел «Результат и исполнение».",
    "verificationReadiness": "План локальной проверки обработчика, раздел «Результат и исполнение».",
    "requiredReviewPasses": "План локальной проверки обработчика, раздел «Результат и исполнение».",
    "environmentReadiness": "План локальной проверки обработчика, раздел «Результат и исполнение».",
    "accessReadiness": "План локальной проверки обработчика, раздел «Результат и исполнение».",
    "execution.mode": "План локальной проверки обработчика, раздел «Результат и исполнение».",
    "execution.environmentId": "План локальной проверки обработчика, раздел «Результат и исполнение».",
    "execution.plannedParallelAgents": "План локальной проверки обработчика, раздел «Результат и исполнение».",
    "execution.codebaseFamiliarity": "План локальной проверки обработчика, раздел «Результат и исполнение».",
    "components": "Локальная проверка существующей функции, область работ ограничена её телом.",
    "contracts": "Локальная проверка существующей функции, область работ ограничена её телом.",
    "migrationEntities": "Локальная проверка существующей функции, область работ ограничена её телом.",
    "deploymentTargets": "Локальная проверка существующей функции, область работ ограничена её телом.",
    "systemBoundaries": "Локальная проверка существующей функции, область работ ограничена её телом.",
    "learningTargets": "Локальная проверка существующей функции, область работ ограничена её телом.",
    "verificationKinds.UNIT": "Приёмка требует модульного теста функции."
  },
  "unknownReasons": {
    "execution.modelId": {
      "reason": "Идентификатор не раскрыт",
      "checkedSource": "Метаданные текущего сеанса исполнителя"
    },
    "execution.reasoningEffort": {
      "reason": "Идентификатор не раскрыт",
      "checkedSource": "Метаданные текущего сеанса исполнителя"
    }
  },
  "systemBoundaries": [],
  "learningTargets": []
}
```

## Пример границы с операцией

Элемент для операции записи входит в `systemBoundaries`. В `verificationScenarioIds` укажите `id` существующего сценария из `verificationScenarios`. Для непустого `systemBoundaries` обоснования записывайте в самих элементах. [Границы и операции](features.md#границы-и-операции)

```json
{
  "id": "tracker-api",
  "name": "API трекера",
  "contractControl": "OWNED",
  "role": "API",
  "evidence": "Проект контролирует контракт собственного API трекера.",
  "operations": [
    {
      "id": "save",
      "description": "Сохранить оценку задачи",
      "evidence": "Приёмка требует сохранения и последующего чтения оценки.",
      "action": "WRITE",
      "work": "MODIFY",
      "contractState": "KNOWN",
      "retryPolicy": "EXISTING",
      "idempotency": "EXISTING",
      "recovery": "EXISTING",
      "authType": "NONE",
      "accessState": "NOT_REQUIRED",
      "verificationScenarioIds": ["check"]
    }
  ]
}
```

В примере показана форма записи. Авторизацию, повторы и остальные значения для своей задачи подтвердите по её источникам. Для неизвестных и частично известных полей заполните `unknownReasons` по полному пути.

## Запрос сохранения оценки

Для первого запуска передайте `SaveTaskAssessment` оценку всего плана. Подставьте новый UUID команды и серии, `planId` выбранного плана и `currentRequirementsDigest` из чтения его требований до анализа. В пустой `context` добавьте [пример `agentTask`](#пример-исходных-признаков) и заполните его по данным своей задачи.

```json
{
  "schemaVersion": 1,
  "commandId": "5368fca7-b77c-4cd0-8b2a-dba1325f3d9e",
  "expectedVersion": 0,
  "payload": {
    "assessmentId": "f513207e-8847-4266-bd47-01ae4d39cf0c",
    "planId": "0d37118e-0c7f-497e-afc4-b2dc6184b23a",
    "expectedRequirementsDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "phase": "planning",
    "context": {},
    "method": {"id": "qualitative", "version": "1", "scale": "Описательная оценка сложности"},
    "complexity": {"status": "UNKNOWN", "value": null, "rationale": "Числовая сложность отдельно не оценивалась."},
    "unknowns": [],
    "assumptions": [],
    "dependencies": [],
    "forecast": {
      "status": "UNKNOWN", "metric": "PLAN_ACTIVE", "lowerMs": null, "upperMs": null,
      "confidence": "UNKNOWN", "basis": "Прогноз рассчитывает сервер.", "sampleCount": 0
    },
    "sources": [],
    "approach": {
      "description": "Обновить обработчик разбора даты и выполнить модульную проверку.",
      "rationale": "Требуемое поведение меняется в существующем обработчике."
    },
    "predictionRequest": {"method": "ATLM", "methodVersion": 1}
  }
}
```

Сервер сохраняет рассчитанный результат в `assessment.serverEstimation`. Для ревизии используйте тот же `assessmentId`, укажите номер текущей ревизии в `expectedVersion` и добавьте `payload.reason`. Перед первым запуском проверьте готовность плана через `GetSavedEstimate`.
