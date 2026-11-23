---
name: train-model
description: Подготовить преподавательский датасет ATLM, обучить модель локально или выполнить порученную операцию с ревизиями и публикацией прогноза.
---

# Обучить модель прогноза ATLM

Используйте этот навык, когда пользователь просит подготовить датасет, обучить модель, проверить ревизию, опубликовать её или откатить публикацию. Начинайте со стадии, которая нужна для порученного результата. Первый запуск и завершение плана, оценка задачи и просмотр реестра выполняются независимо от обучения.

Прочитайте `GetTrackerInfo.assessments.atlm.registry` и `tools/list` подключённого трекера. Сверьте `schemaVersion:1`, условные схемы и лимиты. Авторизацию предоставляет подключённый MCP. Для работы с файлами нужен checkout с `sites/plan-time-tracker/scripts/atlm-transfer.mjs` и `scripts/train-atlm.mjs`, Node.js 24 и code-mode, где скрипт вызывает MCP и передаёт `structuredContent` напрямую в локальные файлы. При отсутствии одной из этих возможностей назовите конкретный блокер. Используйте доступные сводки через MCP, если пользователь просит только чтение. Служебные токены, заголовки владельца и доступ к SQLite агенту не нужны.

| Инструмент | Назначение |
| --- | --- |
| `CreateTrainingSnapshot` | Создать неизменяемый снимок или прочитать список, сводку, строки и файл снимка. |
| `SaveDatasetRevision` | Передать разметку всех строк одного снимка и сохранить новую ревизию. |
| `GetDatasetRevision` | Найти ревизию и прочитать её сводку, строки или исходные байты экспорта. |
| `RegisterModelRevision` | Передать артефакт, проверку и происхождение данных для сохранения в реестре. |
| `ListModelRevisions` | Прочитать указатель, список ревизий, детали, файлы или историю активаций. |
| `ActivateModelRevision` | Назначить конкретную ревизию по ожидаемому указателю и версии активации. |

## Снимок и преподавательская разметка

1. Продолжайте с известного `snapshotId` или вызовите `CreateTrainingSnapshot` с `{schemaVersion:1,mode:'create',commandId}`. Сохраните UUID команды. При `SOURCES_PENDING` дождитесь указанного времени и ограниченно повторите ту же команду. Сводка считает отдельно источники со сбоем. Читайте снимок в `mode:'read'`. Используйте `view:'list'` для поиска или `snapshotId` с `view:'download'` для полного замороженного экспорта. Если нужно уточнить состав, обходите `view:'rows'` по `nextCursor`.
2. Для каждой строки `atlm-training-snapshot` найдите исходные требования, измерение, фактически выполненный объём и доказательства. Разграничьте исходный прогноз и признаки первого старта от признаков фактической работы. Для пригодной строки укажите `groupId`, `eligibility:'ELIGIBLE'`, `reasons:[]` и `annotation:{scope:'ACTUAL',agentTask,fieldEvidence,codeEvidence}`. Заполняйте `agentTask` по [контракту признаков](../assess-task/references/features.md). Изучите относящийся код, укажите доказательства по полям, для ссылок на трекер используйте IDs из источников снимка. Связанные задачи и повторные итерации одной работы объединяйте в одну группу.
3. Для `EXCLUDED` сохраните конкретные причины. `groupId` и `annotation` могут быть `null`. Учитывайте все строки снимка, включая неудобные примеры, удаления, незавершённые задачи и сбои источника. Изменившийся объём допускает новую разметку только при проверенном факте и достаточных доказательствах. Недостаточное или неподтверждённое измерение оставляйте исключённым. Измеренный `actualMs` и исходные прогнозы читает сервер из замороженных источников. Передавайте в разметке только `rowId,groupId,eligibility,reasons,annotation`.
4. Запишите UTF-8 JSON `{schemaVersion:1,contract:'atlm-teacher-annotations',snapshotId,parentDatasetRevisionId,rows}`. Укажите `null`, если родителя нет. При переносе разметки подтвердите тот же план и поколение источника. Для изменившихся фактов заново проверьте доказательства и сформулируйте решение. Передайте файл через `SaveDatasetRevision` с `snapshotId` и, если указан, `parentDatasetRevisionId`. На `SAVED` сохраните `datasetRevisionId` и `datasetDigest`.
5. Выгрузите `GetDatasetRevision` с `datasetRevisionId` и `view:'download'`. Сверьте `datasetDigest` с SHA-256 готового файла. Тренер читает полные оригинальные байты `atlm-teacher-dataset`, включая исключения и зафиксированные источники. При `HISTORICAL_PROVENANCE_INCOMPLETE` создайте новый снимок и проверьте перенос разметки.

## Передача файлов

- Вызовите `view:'download'` для сохранённого ID. При `MATERIALIZING` повторяйте тот же селектор с учётом `retryAfterMs`, пока `READY` не вернёт `file:{sha256,byteLength,partSize,partCount,mediaType,encoding}`. Для модели укажите `fileKind:'BUNDLE'` или `'ARTIFACT'`. Части читаются через `view:'filePart'`, `partIndex` отсчитывается с нуля, полный кусок содержит 49 152 байта. Сверяйте индекс, digest и длину каждой части. Пишите по позиции в `PATH.partial`. После `verify --file PATH.partial --sha256 VALUE --byte-length N` атомарно переименуйте файл в окончательный путь.
- Для загрузки получите `manifest --file PATH` и передайте только `file:{sha256,byteLength}` в `phase:'prepare'` с новым `commandId` и ID источника. Лимит upload берите из discovery. `UPLOADING` возвращает `receivedPartRanges` с включёнными `start` и `end`. Читайте недостающие части через `read-part --file PATH --part-index N` и передавайте `phase:'putPart',partIndex,contentBase64` с теми же остальными аргументами. Затем выполните `phase:'commit'`. При `VALIDATING` повторяйте этот commit с учётом `retryAfterMs`. При `UPLOAD_INCOMPLETE` повторите prepare и дополните parts. При `UPLOAD_EXPIRED` возобновите prepare с теми же `commandId` и descriptor, затем повторите отсутствующие части.
- В локальном checkpoint храните неизменяемый селектор, digest и длину, временный путь, принятые индексы и UUID семантической команды. В случае потерянного ответа сначала проверьте `GetCommandResult`. Повторяйте точную операцию, пока её исход не установлен. Prepare с прежними аргументами возвращает состояние загрузки, commit возвращает тот же ID после успеха. При конфликте `IDEMPOTENCY_KEY_REUSED` сверяйте исходное намерение по квитанции. Для изменившегося запроса используйте новый UUID. Сообщайте пользователю коды, ID и прогресс.

Ниже функции для code-mode. Подставьте `site` с абсолютным путём каталога сайта и `callTool`, который вызывает найденный подключённый инструмент по публичному имени. Выполняйте блок внутри code-mode. Он передаёт один кусок за раз, и вызывающий код сохраняет только подтверждённый индекс.

```js
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const shellArg = (arg) => "'" + String(arg).replaceAll("'", "'\"'\"'") + "'";

async function transfer(argv, maxOutputTokens = 1000) {
  const result = await tools.exec_command({
    cmd: ['node', 'scripts/atlm-transfer.mjs', ...argv].map(shellArg).join(' '),
    workdir: site,
    max_output_tokens: maxOutputTokens,
  });
  if (result.exit_code !== 0) throw new Error('Локальная операция с частью не завершилась');
  return JSON.parse(result.output);
}

async function structured(name, args) {
  const response = await callTool(name, { schemaVersion: 1, ...args });
  const result = response.result ?? response;
  if (result.isError || !result.structuredContent)
    throw new Error(result.structuredContent?.code ?? 'MCP_RESPONSE_UNAVAILABLE');
  return result.structuredContent;
}

function checkPart(content, index, file) {
  const length = Math.min(file.partSize, file.byteLength - index * file.partSize);
  const pad = typeof content === 'string' && content.endsWith('==') ? 2
    : typeof content === 'string' && content.endsWith('=') ? 1 : 0;
  if (!Number.isSafeInteger(index) || index < 0 || index >= file.partCount || length <= 0
    || typeof content !== 'string' || content.length !== Math.ceil(length / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)
    || content.length / 4 * 3 - pad !== length
    || alphabet.indexOf(content.at(-1 - pad)) % 4 ** pad !== 0) {
    throw new Error('INVALID_FILE_PART');
  }
  return length;
}

async function receivePart(name, selector, file, partIndex, partialPath) {
  const part = await structured(name, { ...selector, view: 'filePart', partIndex });
  if (part.fileSha256 !== file.sha256 || part.partIndex !== partIndex)
    throw new Error('FILE_PART_SELECTOR_MISMATCH');
  const byteLength = checkPart(part.contentBase64, partIndex, file);
  const written = await transfer(['write-part', '--file', partialPath, '--part-index', partIndex,
    '--content-base64', part.contentBase64]);
  if (written.partIndex !== partIndex || written.byteLength !== byteLength)
    throw new Error('FILE_PART_WRITE_MISMATCH');
  return { partIndex, byteLength };
}

async function sendPart(name, preparedArgs, localPath, manifest, partIndex) {
  const part = await transfer(['read-part', '--file', localPath, '--part-index', partIndex], 80000);
  const byteLength = checkPart(part.contentBase64, partIndex, manifest);
  if (part.partIndex !== partIndex || part.byteLength !== byteLength)
    throw new Error('FILE_PART_READ_MISMATCH');
  const accepted = await structured(name, { ...preparedArgs, phase: 'putPart', partIndex,
    contentBase64: part.contentBase64 });
  if (accepted.state !== 'UPLOADING' || accepted.partIndex !== partIndex)
    throw new Error('FILE_PART_RECEIPT_MISMATCH');
  return { partIndex, byteLength };
}
```

Передавайте `preparedArgs` с неизменяемыми ID, `commandId` и `file:{sha256,byteLength}`. В `manifest` оставьте также `partSize` и `partCount`. Проверяйте полный digest до запуска обучения и перед prepare. Держите base64 и полный набор данных внутри code-mode и локальных файлов. По частям выводите только подтверждённый индекс и длину. Усечённый вывод helper отклоняйте до putPart.

## Локальный рецепт и проверка

Из `sites/plan-time-tracker` запишите `recipe.json` с `schemaVersion:1`, `recipeId:'atlm-teacher-hybrid-v1'`, `datasetRevisionId`, `datasetDigest` и `selection:{mode:'ALL_ELIGIBLE'}`. Если задана конкретная выборка, передайте `selection:{mode:'EXPLICIT',rowIds:[...]}` со всеми пригодными строками включённых групп. Укажите `holdoutUse` и краткое `holdoutUseNote`. Используйте `UNKNOWN` при неполной истории, `FIRST_REPORTED` при известной первой проверке и `REUSED_AFTER_REVIEW` после просмотра результатов тех же групп. Идентичный повтор — воспроизведение отчёта.

```sh
node scripts/train-atlm.mjs --dataset /path/dataset.json --recipe /path/recipe.json --out /path/run
```

Exit `0` даёт `registration.bundle.json`, `2` даёт отчёт с причиной недоступности кандидата, `1` означает ошибку входа или исполнения. Откройте `run.json`, `manifest.json` и `evaluation.json` в локальном каталоге. Для повтора используйте те же байты входов и каталог. Частичный или чужой результат сохраняется.

Development использует целые группы и факты, готовые строго до старта проверяемой группы. Финальные веса и калибровка используют только development. Holdout проверяет этот артефакт с `ACTUAL` признаками и отдельно с исходными `PLANNED` признаками для сопоставимого объёма. `ISSUED_FORECASTS` показывает фактически выданные прогнозы прежних версий. Рассматривайте их по записанной идентичности, доступности и сопоставимости. Небольшая выборка, участие учителя после завершения работ, повторный просмотр holdout и широкие интервалы ограничивают выводы о будущей точности. Сравнивайте MAE кандидата и медианы на одинаковых парах, смотрите раздельные знаменатели доступности точки, интервала и охвата.

## Зарегистрировать и опубликовать

1. Если регистрация входит в поручение и тренер вернул `0`, передайте `registration.bundle.json` в `RegisterModelRevision` с `datasetRevisionId`. `REGISTERED` сохраняет модель и отчёт. Сообщите `modelRevisionId`, причину допуска и сопоставимые метрики. Указатель для новых прогнозов меняется отдельной командой.
2. При порученной активации прочитайте `ListModelRevisions`. Передайте `modelRevisionId`, новый `commandId`, `expectedActiveModelRevisionId` (включая `null`), `expectedActivationVersion` и причину. Добавьте `acceptExperimental:true` только при явно принятом пользователем экспериментальном результате. Заранее согласованные условия активации применяйте сразу, когда выполнены. При `MODEL_ACTIVATION_CONFLICT` перечитайте указатель и версию перед новым намерением. Изменение источника даёт `MODEL_SOURCES_CHANGED` и требует проверенной ревизии.
3. Для отката используйте `ActivateModelRevision` с ID прежней пригодной модели и актуальным CAS. Сверьте `activeModelRevisionId`, `servingModelRevisionId` и историю активаций. Прогноз уже начатого плана остаётся зафиксированным. Проспективная проверка новой модели появится по прогнозам, выданным этой ревизией после активации.
