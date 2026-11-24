# Исходные признаки ATLM

Перед первым `StartPlan` заполните все поля `context.agentTask` версии `agent-task-v4` по сведениям, доступным до запуска. Полную схему возвращает `GetTrackerInfo` в `assessments.atlm.agentTaskSchema`. Её также публикует `tools/list` для `EstimatePlanTime.agentTask` и `SaveTaskAssessment.payload.context.agentTask`. Если клиент сокращает объявление инструмента, читайте ответ `GetTrackerInfo` или используйте этот справочник.

## Границы и операции

1. Выделите независимо управляемые контракты сервисов и хранилищ. Если таких контрактов нет, запишите `systemBoundaries=[]` и источник проверки в evidence. Для нескольких контуров одного провайдера обоснуйте независимость.
2. Массив `systemBoundaries` обязателен. Каждая граница содержит id, name, contractControl, role, evidence и непустой operations. OWNED означает право проекта изменить контракт. Своя схема PostgreSQL и свои ключи Redis относятся к OWNED и в облаке. Для чужой схемы или чужого API укажите FOREIGN. Основная роль принимает API, SERVICE, DATASTORE, QUEUE, SDK или PLATFORM.
3. Выделите отдельно проверяемое поведение. Тысяча страниц одного поиска даёт одну READ. Запрос GET с побочным эффектом даёт WRITE. Чтение внутри атомарного изменения входит в WRITE. Отдельное чтение статуса и создание отправления дают две операции.
4. Каждая операция имеет `id`, `description`, `evidence`, `action` (`READ`, `WRITE`) и `work` (`USE`, `MODIFY`, `ADD`). `contractState` принимает `KNOWN`, `PARTIAL`, `UNKNOWN`. `retryPolicy` описывает повторы операции, `recovery` — восстановление или сверку результата после отказа. Оба поля принимают `NOT_REQUIRED`, `EXISTING`, `IMPLEMENT`, `UNKNOWN`. Для `idempotency` допустимы `NOT_APPLICABLE`, `EXISTING`, `IMPLEMENT`, `UNKNOWN`. Для `READ` требуется `NOT_APPLICABLE`. Для `WRITE` с `NOT_APPLICABLE` добавьте обоснование в `evidence` по полному пути `idempotency`.
5. Укажите authType NONE/API_KEY/OAUTH2/SERVICE_ACCOUNT/OTHER/UNKNOWN и accessState AVAILABLE/MISSING/UNKNOWN/NOT_REQUIRED. Только NONE сочетается с NOT_REQUIRED. Для OTHER в evidence опишите механизм. В verificationScenarioIds перечислите уникальные ID существующих сценариев проверки. Нужен хотя бы один.
6. Используйте устойчивые ID границ, операций и целей изучения из строчных ASCII букв, цифр и знаков `._:-`. Первый символ — буква или цифра. Максимальная длина ID 128, имени 160, описания и evidence 400 символов. Точные дубли сворачиваются, конфликт ID и повтор поведения под другим ID отклоняются.
7. Заполните `learningTargets` объектами {id,kind,evidence} для самостоятельного изучения TOOLING, RUNTIME, DATA_MODEL или OTHER. Исследование неизвестных деталей операции уже учитывает contractState.

## Основания

Для известного скаляра верхнего уровня и полей `execution` укажите источник в `evidence` по полному пути. Для пустого списка укажите основание по имени списка, а для элементов заполните `evidence` внутри объекта. Для каждого вида проверки используйте путь вида `verificationKinds.UNIT`.

При допустимом `UNKNOWN`, `contractState: "PARTIAL"` или `null` заполните `unknownReasons[path] = {reason, checkedSource}`. В пути к операции указывайте её ID и ID границы, например `systemBoundaries[target].operations[op-0].contractState`. Для `authType: "OTHER"` добавьте конкретное основание в `evidence` по полному пути `authType`. Числовые поля принимают целые числа, массивы содержат элементы заданной формы. Записывайте `0` или `[]`, когда проверили отсутствие того, что считает поле. Пропуски обоснований, общие заглушки и лишние пути отклоняются. При `dataVolumeBand: "NONE"` список `migrationEntities` должен быть пустым. Для `DEPLOY_SMOKE` требуется хотя бы одна цель развёртывания.

| Поле | Значение |
| --- | --- |
| `schemaVersion` | `agent-task-v4`. |
| `workUnits` | Непустой список `{id, kind, description, evidence}` проверяемых результатов. `kind`: CREATE, MODIFY, DEBUG, REFACTOR, MIGRATE, VERIFY, ANALYZE или OPERATE. |
| `doneBoundary` | ANALYSIS, LOCAL_VERIFIED, LOCAL_STAGED, PUBLISHED, DEPLOYED_VERIFIED. |
| `reuseLevel` | 0 — основы нет; 1 — есть части; 2 — рабочий путь требует изменения; 3 — достаточно выполнить готовый путь. |
| `components` | `{key, change, evidence}`, где `change` — `CREATE`, `MODIFY` или `REMOVE`. Компонент — самостоятельный модуль, сервис или приложение. |
| `contracts` | `{kind, key, change, evidence}`. `kind` — `API`, `MCP`, `EVENT`, `STORAGE`, `UI` или `CONFIG`. `change` — `ADD`, `COMPATIBLE`, `BREAKING` или `REMOVE`. |
| `systemBoundaries` | Список границ и их операций. Структура описана в разделе «Границы и операции». |
| `migrationEntities` | `{key, evidence}` для каждой сущности, чьи сохранённые данные изменяются. |
| `dataVolumeBand` | NONE, LE_1K, LE_100K, LE_10M, GT_10M или UNKNOWN; границы включительны. |
| `requirementsUncertainty` | **Ясность требований**: какой результат нужен. 0 — правила определены; 1 — открыты локальные детали; 2 — открыт существенный сценарий; 3 — результат требует согласования. |
| `solutionUncertainty` | **Ясность решения**: как получить результат. 0 — способ проверен; 1 — выбран, но не проверен; 2 — открыт ключевой технический вопрос; 3 — способ не определён. |
| `diagnosisState` | Для DEBUG — PROVEN, HYPOTHESIS или UNKNOWN; иначе NOT_APPLICABLE. |
| `scopeChangeRisk` | **Риск расширения задачи** — вероятность дополнительной работы за известными границами. 0 — границы зафиксированы; 1 — возможны локальные уточнения; 2 — может потребоваться существенная дополнительная работа; 3 — несколько открытых внешних зависимостей или необходимо исследование. Это не оценка ясности требований или выбранного решения. |
| `learningTargets` | Цели самостоятельного изучения в форме `{id, kind, evidence}`. Допустимые `kind` перечислены в разделе «Границы и операции». |
| `verificationKinds` | Уникальные BUILD_STATIC, UNIT, INTEGRATION, UI_E2E и DEPLOY_SMOKE, если они требуются. |
| `verificationScenarios` | Независимые сценарии `{id, description, evidence}`, без повторных запусков. |
| `verificationReadiness` | READY, ADAPT, CREATE, NONE_REQUIRED или UNKNOWN. |
| `requiredReviewPasses` | Неотрицательное число обязательных независимых ревью. |
| `environmentReadiness` | **Готовность рабочей среды**: READY — готова; SETUP_KNOWN — требуется известная настройка; BLOCKED — начать работу в среде нельзя; UNKNOWN — готовность неизвестна. Готовность не определяет, локальная среда или облачная. |
| `accessReadiness` | **Доступы**: AVAILABLE — необходимые доступы есть; MISSING — хотя бы одного необходимого доступа нет; UNKNOWN — источник доступа проверен, ответ неизвестен. Это отдельно от настройки рабочей среды. |
| `deploymentTargets` | **Развёртывание** — уникальные окружения или сервисы `{key, evidence}`, куда требуется развернуть результат по условиям задачи. `[]` — развёртывание не требуется. Это не среда, в которой агент выполняет работу. |
| `execution` | Сведения об исполнителе и условиях работы; вложенные поля описаны ниже. Это не список целей развёртывания. |
| `evidence`, `unknownReasons` | Основания значений и причины неизвестности по путям из раздела «Основания». |


### Исполнитель

| Поле | Значение |
| --- | --- |
| `execution.mode` | **Кто выполняет**: AI_AGENT — ИИ-агент; HUMAN — человек; HYBRID — человек и ИИ-агент. |
| `execution.modelId` | **Модель** — точное известное значение. Если его сообщил пользователь, укажите это в `evidence`. При отсутствии сведений передайте `null` с причиной. |
| `execution.reasoningEffort` | **Уровень рассуждения** — точное известное значение. Если его сообщил пользователь, укажите это в `evidence`. При отсутствии сведений передайте `null` с причиной. |
| `execution.environmentId` | **Среда выполнения**: `local` — локальная; `cloud_workspace` — облачное рабочее пространство. Описывает место работы исполнителя, а не готовность среды и не цель развёртывания. |
| `execution.plannedParallelAgents` | **Параллельные агенты.** До первого запуска запишите, сколько агентов по плану будут одновременно работать над задачей на пике, включая основного. Поле принимает целое число от 1. |
| `execution.codebaseFamiliarity` | **Знакомство с кодом** до оценки: NOT_READ — код не изучен; MAPPED — структура изучена; PRIOR_VERIFIED_WORK — ранее выполнена проверенная работа с кодом. |


При подготовке учительской строки `ACTUAL` в этом же поле укажите подтверждённое число одновременно работавших агентов, включая основного. Если точное число неизвестно, запишите `1`. В `annotation.agentTask.evidence["execution.plannedParallelAgents"]` укажите проверенный источник и пометьте единицу как подстановку нижней границы по правилу датасета (`LOWER_BOUND`). Укажите это основание и в `annotation.fieldEvidence`. Этой подстановки достаточно для заполнения поля. Явные правила пользователя для выбранного датасета имеют приоритет в указанной им области. [Подготовка учительской строки](../../train-model/SKILL.md#снимок-и-преподавательская-разметка).

Сервер вычисляет количества, долю WRITE и готовность. INCOMPLETE означает, что отсутствует обязательное поле, значение или основание. INVALID означает, что переданные данные нарушают тип, закрытый набор значений, связь или уникальность. OUTDATED означает прежнюю схему, STALE — расхождение digest. При отсутствии записи StartPlan возвращает ASSESSMENT_REQUIRED. Для первого StartPlan требуется READY. Допустимые UNKNOWN с проверенным источником, BLOCKED или MISSING сохраняют готовность оценки.

### Пример исходных признаков

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

Пример системной границы для операции записи. Это элемент `systemBoundaries`; `verificationScenarioIds` ссылается на `id` существующего сценария из `verificationScenarios`. Если массив не пуст, не добавляйте в `evidence` основание для пустого `systemBoundaries`.

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

Это иллюстрация формы, а не утверждение о реальной авторизации или механизмах повторов трекера. Для фактической задачи выбирайте значения по её источникам; неизвестные и частично известные поля указывайте с `unknownReasons` по полному пути.

## Запрос сохранения оценки

Для первого запуска передайте `SaveTaskAssessment` оценку всего плана. Подставьте новый UUID команды и серии, `planId` выбранного плана и `currentRequirementsDigest` из чтения его требований до анализа. В пустой `context` добавьте `agentTask` из примера выше и заполните его по данным своей задачи.

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
