# Исходные признаки ATLM

Контракт подключён к приёму оценок и регрессорам; переход полного цикла обучения ещё не завершён.

`context.agentTask` описывает задачу до первого запуска. Версия схемы — `agent-task-v3`. Все поля обязательны. Неизвестный список или число обозначается `null`, неизвестная категория — `UNKNOWN`. Пустой список и ноль означают проверенное отсутствие. Источники скалярных значений записываются в `evidence` по пути поля, причины неизвестных значений — в `unknownReasons`. Элементы списков содержат `evidence`; не передавайте секреты или исходный код.

| Поле | Значение |
| --- | --- |
| `workUnits` | Непустой список `{id, kind, description, evidence}` проверяемых результатов. `kind`: CREATE, MODIFY, DEBUG, REFACTOR, MIGRATE, VERIFY, ANALYZE или OPERATE. |
| `doneBoundary` | ANALYSIS, LOCAL_VERIFIED, LOCAL_STAGED, PUBLISHED, DEPLOYED_VERIFIED или UNKNOWN. |
| `reuseLevel` | 0 — основы нет; 1 — есть части; 2 — рабочий путь требует изменения; 3 — достаточно выполнить готовый путь. |
| `components` | `{key, change, evidence}`, где change — CREATE, MODIFY или REMOVE. Компонент — самостоятельный модуль, сервис или приложение. |
| `contracts` | `{kind, key, change, evidence}`. kind — API, MCP, EVENT, STORAGE, UI или CONFIG; change — ADD, COMPATIBLE, BREAKING или REMOVE. |
| `integrations` | `{key, change, evidence}` для внешней границы; change — USE, CHANGE или ADD. |
| `migrationEntities` | `{key, evidence}` для каждой сущности, чьи сохранённые данные изменяются. |
| `dataVolumeBand` | NONE, LE_1K, LE_100K, LE_10M, GT_10M или UNKNOWN; границы включительны. |
| `requirementsUncertainty` | 0 — правила определены; 1 — открыты локальные детали; 2 — открыт существенный сценарий; 3 — результат требует согласования. |
| `solutionUncertainty` | 0 — способ проверен; 1 — выбран, но не проверен; 2 — открыт ключевой технический вопрос; 3 — способ не определён. |
| `diagnosisState` | Для DEBUG — PROVEN, HYPOTHESIS или UNKNOWN; иначе NOT_APPLICABLE. |
| `unfamiliarTechnologies` | `{key, evidence}` для технологий, неизвестный контракт которых предстоит изучить. |
| `scopeChangeRisk` | От 0 до 3: от зафиксированных границ до нескольких открытых внешних зависимостей или необходимости исследования. |
| `verificationKinds` | Уникальные BUILD_STATIC, UNIT, INTEGRATION, UI_E2E и DEPLOY_SMOKE, если они требуются. |
| `verificationScenarios` | Независимые сценарии `{id, description, evidence}`, без повторных запусков. |
| `verificationReadiness` | READY, ADAPT, CREATE, NONE_REQUIRED или UNKNOWN. |
| `requiredReviewPasses` | Неотрицательное число обязательных независимых ревью либо null. |
| `environmentReadiness` | READY, SETUP_KNOWN, BLOCKED или UNKNOWN. |
| `accessReadiness` | AVAILABLE, MISSING или UNKNOWN. |
| `deploymentTargets` | Уникальные цели `{key, evidence}`, обязательные для задачи. |
| `execution` | `{mode, modelId, reasoningEffort, environmentId, plannedParallelAgents, codebaseFamiliarity}`. mode — AI_AGENT, HUMAN, HYBRID или UNKNOWN; environmentId — local, cloud_workspace или null; число агентов положительно либо null; familiarity — NOT_READ, MAPPED, PRIOR_VERIFIED_WORK или UNKNOWN. |

Точные дубли нормализуются; один ключ с разными значениями отклоняется. `dataVolumeBand=NONE` несовместим с непустой миграцией. DEPLOY_SMOKE выбирается только при требовании развёртывания. Для прогноза необходимы известные `workUnits` и `doneBoundary`; неизвестные дополнительные признаки остаются пропусками, а не нулями. Счётчики вычисляет сервер.
