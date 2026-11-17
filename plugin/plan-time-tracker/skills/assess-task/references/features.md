# Исходные признаки ATLM

Перед первым StartPlan заполните все поля `context.agentTask` версии `agent-task-v4` по доступным до запуска требованиям. Допустимые ключи, enum и размеры публикует схема EstimatePlanTime. Оценка ограничена 65 536 байтами UTF-8 и глубиной JSON 12.

## Границы и операции

1. Выделите независимо управляемые контракты сервисов и хранилищ. Если таких контрактов нет, запишите `systemBoundaries=[]` и источник проверки в evidence. Для нескольких контуров одного провайдера обоснуйте независимость.
2. Массив `systemBoundaries` обязателен. Каждая граница содержит id, name, contractControl, role, evidence и непустой operations. OWNED означает право проекта изменить контракт. Своя схема PostgreSQL и свои ключи Redis относятся к OWNED и в облаке. Для чужой схемы или чужого API укажите FOREIGN. Основная роль принимает API, SERVICE, DATASTORE, QUEUE, SDK или PLATFORM.
3. Выделите отдельно проверяемое поведение. Тысяча страниц одного поиска даёт одну READ. Запрос GET с побочным эффектом даёт WRITE. Чтение внутри атомарного изменения входит в WRITE. Отдельное чтение статуса и создание отправления дают две операции.
4. Каждая операция имеет id, description, evidence, action READ/WRITE и work USE/MODIFY/ADD (использовать, изменить или реализовать поведение). Укажите contractState KNOWN/PARTIAL/UNKNOWN, retryPolicy и recovery NOT_REQUIRED/EXISTING/IMPLEMENT/UNKNOWN. Recovery относится к восстановлению или сверке после частичного отказа. Для idempotency доступны NOT_APPLICABLE/EXISTING/IMPLEMENT/UNKNOWN. Для READ требуется NOT_APPLICABLE. Для WRITE с NOT_APPLICABLE в evidence операции объясните отсутствие риска повторения.
5. Укажите authType NONE/API_KEY/OAUTH2/SERVICE_ACCOUNT/OTHER/UNKNOWN и accessState AVAILABLE/MISSING/UNKNOWN/NOT_REQUIRED. Только NONE сочетается с NOT_REQUIRED. Для OTHER в evidence опишите механизм. В verificationScenarioIds перечислите уникальные ID существующих сценариев проверки. Нужен хотя бы один.
6. Используйте устойчивые ID границ, операций и целей изучения из строчных ASCII букв, цифр и знаков `._:-`. Первый символ — буква или цифра. Максимальная длина ID 128, имени 160, описания и evidence 400 символов. Точные дубли сворачиваются, конфликт ID и повтор поведения под другим ID отклоняются.
7. Заполните `learningTargets` объектами {id,kind,evidence} для самостоятельного изучения TOOLING, RUNTIME, DATA_MODEL или OTHER. Исследование неизвестных деталей операции уже учитывает contractState.

## Основания

Для известного скаляра укажите источник в `evidence` по полному пути, для пустого списка — по имени списка, для элементов — в самом объекте. Для verificationKinds используйте путь вида `verificationKinds.UNIT`. Для UNKNOWN, PARTIAL у contractState и допустимого null используйте `unknownReasons`. Укажите `unknownReasons[path]={reason,checkedSource}`. Путь к операции использует ID в скобках, например `systemBoundaries[target].operations[op-0].contractState`. Для WRITE с NOT_APPLICABLE и для OTHER дополнительно укажите конкретное основание по пути поля в evidence. Пропуски, общие заглушки и лишние пути отклоняются. Для dataVolumeBand=NONE список migrationEntities пуст. DEPLOY_SMOKE требует deploymentTargets.

| Поле | Значение |
| --- | --- |
| `workUnits` | Непустой список `{id, kind, description, evidence}` проверяемых результатов. `kind`: CREATE, MODIFY, DEBUG, REFACTOR, MIGRATE, VERIFY, ANALYZE или OPERATE. |
| `doneBoundary` | ANALYSIS, LOCAL_VERIFIED, LOCAL_STAGED, PUBLISHED, DEPLOYED_VERIFIED. |
| `reuseLevel` | 0 — основы нет; 1 — есть части; 2 — рабочий путь требует изменения; 3 — достаточно выполнить готовый путь. |
| `components` | `{key, change, evidence}`, где change — CREATE, MODIFY или REMOVE. Компонент — самостоятельный модуль, сервис или приложение. |
| `contracts` | `{kind, key, change, evidence}`. kind — API, MCP, EVENT, STORAGE, UI или CONFIG; change — ADD, COMPATIBLE, BREAKING или REMOVE. |
| `migrationEntities` | `{key, evidence}` для каждой сущности, чьи сохранённые данные изменяются. |
| `dataVolumeBand` | NONE, LE_1K, LE_100K, LE_10M, GT_10M или UNKNOWN; границы включительны. |
| `requirementsUncertainty` | **Ясность требований**: какой результат нужен. 0 — правила определены; 1 — открыты локальные детали; 2 — открыт существенный сценарий; 3 — результат требует согласования. |
| `solutionUncertainty` | **Ясность решения**: как получить результат. 0 — способ проверен; 1 — выбран, но не проверен; 2 — открыт ключевой технический вопрос; 3 — способ не определён. |
| `diagnosisState` | Для DEBUG — PROVEN, HYPOTHESIS или UNKNOWN; иначе NOT_APPLICABLE. |
| `scopeChangeRisk` | **Риск расширения задачи** — вероятность дополнительной работы за известными границами. 0 — границы зафиксированы; 1 — возможны локальные уточнения; 2 — может потребоваться существенная дополнительная работа; 3 — несколько открытых внешних зависимостей или необходимо исследование. Это не оценка ясности требований или выбранного решения. |
| `verificationKinds` | Уникальные BUILD_STATIC, UNIT, INTEGRATION, UI_E2E и DEPLOY_SMOKE, если они требуются. |
| `verificationScenarios` | Независимые сценарии `{id, description, evidence}`, без повторных запусков. |
| `verificationReadiness` | READY, ADAPT, CREATE, NONE_REQUIRED или UNKNOWN. |
| `requiredReviewPasses` | Неотрицательное число обязательных независимых ревью. |
| `environmentReadiness` | **Готовность рабочей среды**: READY — готова; SETUP_KNOWN — требуется известная настройка; BLOCKED — начать работу в среде нельзя; UNKNOWN — готовность неизвестна. Готовность не определяет, локальная среда или облачная. |
| `accessReadiness` | **Доступы**: AVAILABLE — необходимые доступы есть; MISSING — хотя бы одного необходимого доступа нет; UNKNOWN — источник доступа проверен, ответ неизвестен. Это отдельно от настройки рабочей среды. |
| `deploymentTargets` | **Развёртывание** — уникальные окружения или сервисы `{key, evidence}`, куда требуется развернуть результат по условиям задачи. `[]` — развёртывание не требуется. Это не среда, в которой агент выполняет работу. |
| `execution` | Сведения об исполнителе и условиях работы; вложенные поля описаны ниже. Это не список целей развёртывания. |


### Исполнитель

| Поле | Значение |
| --- | --- |
| `execution.mode` | **Кто выполняет**: AI_AGENT — ИИ-агент; HUMAN — человек; HYBRID — человек и ИИ-агент. |
| `execution.modelId` | **Модель** — точный идентификатор, только если он известен. Иначе `null` с причиной. |
| `execution.reasoningEffort` | **Уровень рассуждения** модели, только если он известен. Иначе `null` с причиной. |
| `execution.environmentId` | **Среда выполнения**: `local` — локальная; `cloud_workspace` — облачное рабочее пространство. Описывает место работы исполнителя, а не готовность среды и не цель развёртывания. |
| `execution.plannedParallelAgents` | **Параллельные агенты** — планируемое положительное число одновременно работающих агентов. |
| `execution.codebaseFamiliarity` | **Знакомство с кодом** до оценки: NOT_READ — код не изучен; MAPPED — структура изучена; PRIOR_VERIFIED_WORK — ранее выполнена проверенная работа с кодом. |


Сервер вычисляет количества, долю WRITE и готовность. INCOMPLETE означает, что отсутствует обязательное поле, значение или основание. INVALID означает, что переданные данные нарушают тип, закрытый набор значений, связь или уникальность. OUTDATED означает прежнюю схему, STALE — расхождение digest. При отсутствии записи StartPlan возвращает ASSESSMENT_REQUIRED. Для первого StartPlan требуется READY. Допустимые UNKNOWN с проверенным источником, BLOCKED или MISSING сохраняют готовность оценки.

Пример исходных признаков

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
