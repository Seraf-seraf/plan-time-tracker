---
name: train-model
description: Подготовить преподавательский датасет ATLM, обучить модель локально или выполнить порученную операцию с ревизиями и публикацией прогноза.
---

# Обучить модель прогноза ATLM

Используйте этот навык, когда пользователь просит подготовить датасет, обучить модель, проверить ревизию, опубликовать её или откатить публикацию. Начинайте со стадии, которая нужна для порученного результата. Первый запуск и завершение плана, оценка задачи и просмотр реестра выполняются независимо от обучения.

Прочитайте `GetTrackerInfo.assessments.atlm.registry` и `tools/list` подключённого трекера. Сверьте `schemaVersion:1`, условные схемы и лимиты. Авторизацию предоставляет подключённый MCP. Для работы с файлами нужен checkout с `sites/plan-time-tracker/scripts/atlm-transfer.mjs` и `scripts/train-atlm.mjs`, Node.js 24 и code-mode, где скрипт вызывает MCP и передаёт `structuredContent` напрямую в локальные файлы. При отсутствии одной из этих возможностей назовите конкретный блокер. Используйте доступные сводки через MCP, если пользователь просит только чтение. Служебные токены, заголовки владельца и доступ к SQLite агенту не нужны.

| Инструмент | Назначение |
| --- | --- |
| `CreateTrainingSnapshot` | Зафиксировать неизменяемый снимок в `mode:'create'`. В `mode:'read'` использовать `view:'list'` для списка или передать `snapshotId` для остальных видов. |
| `SaveDatasetRevision` | Для каждой строки снимка сохранить решение `ELIGIBLE` с проверенными признаками `ACTUAL` или `EXCLUDED` с причиной исключения. |
| `GetDatasetRevision` | Найти ревизию через `view:'list'` с необязательным `snapshotId`. Для сводки, строк и выгрузки передать `datasetRevisionId`. |
| `RegisterModelRevision` | Сохранить пакет локального обучения с артефактом, отчётом и происхождением данных через `prepare`, `putPart` и `commit` с неизменными `datasetRevisionId`, `file` и `commandId`. |
| `ListModelRevisions` | Прочитать список и указатель через `view:'list'`, одну ревизию через `view:'detail'`, историю через `view:'activations'`. Выгрузка требует `modelRevisionId`. По умолчанию `fileKind:'BUNDLE'`, для одного артефакта используйте `'ARTIFACT'`. |
| `ActivateModelRevision` | Назначить ревизию по актуальному указателю и версии активации. Для допуска `REQUIRES_EXPERIMENTAL_ACK` требуется явное согласие пользователя. |

Для снимка и датасета `view:'rows'` возвращает компактный перечень. Полные строки, доказательства снимка и исходные байты экспорта доступны через `view:'download'` и `view:'filePart'`. Для следующей страницы списка или строк передавайте полученный `nextCursor` как `cursor` с теми же фильтрами.

## Снимок и преподавательская разметка

1. Продолжайте с известного `snapshotId` или вызовите `CreateTrainingSnapshot` с `{schemaVersion:1,mode:'create',commandId}`. Сохраните UUID команды. При `SOURCES_PENDING` ограниченно повторяйте ту же команду, выжидая `details.retryAfterMs`, если задано число. Сводка считает отдельно источники со сбоем. Получите полный экспорт в `mode:'read'` по `snapshotId`.
2. Разметьте каждую строку `atlm-training-snapshot`, включая удаления, незавершённые задачи и сбои источника. Для `ACTUAL` откройте итоговый код или другой результат именно этого плана. Сверьте **каждый признак** `agentTask`, включая вложенные поля, с изменениями, журналом и результатами проверок. Условия до первого старта проверяйте по сведениям, доступным на тот момент.

   В `fieldEvidence` укажите, какой факт подтверждает значение каждого признака, в том числе ноль или пустой список. В `codeEvidence` укажите, где проверить результат, например файл и символ в итоговой ревизии. Переносите значение из `PLANNED` в `ACTUAL` только после подтверждения. При расхождении запишите фактическое значение в `annotation.agentTask`. Для допустимого неизвестного значения заполните `unknownReasons` по схеме. Если обязательный признак подтвердить не удалось и схема не допускает неизвестного значения, укажите `EXCLUDED` и причину.

   Например, статус `DONE` подтверждает завершение этапа. Запись журнала о получении ревизии через `GET /healthz` подтверждает одну операцию чтения существующего API (`action: READ`, `work: USE`). [Правило учёта операций](../assess-task/references/features.md#границы-и-операции).

   Исходные признаки `PLANNED`, измеренный `actualMs` и выданные прогнозы берите из снимка. Для ссылок на трекер используйте ID из доказательств этой строки.
3. Для `ELIGIBLE` нужны группа, `reasons:[]`, полная разметка `ACTUAL` и проверенный источник. План завершён, доступен, не удалён и имеет подтверждённое активное время, в том числе измеренный ноль. `SCOPE_CHANGED`, `MISSING_FEATURES`, `MISSING_REQUIRED_FEATURES` и `INVALID_FEATURES` допускают пригодную фактическую разметку при проверенном источнике. Другие исходные исключения, включая `RESULT_NOT_VERIFIED`, `INCOMPLETE_MEASUREMENT` и `SOURCE_REFRESH_FAILED`, сохраняют строку вне обучения. Связанные задачи и повторные итерации одной работы объединяйте в одну группу.
4. Для `EXCLUDED` укажите хотя бы одну конкретную причину. Поля `groupId` и `annotation` могут быть явно `null`. `reasons` — массив строк из печатного ASCII длиной до 128 символов каждая, с хотя бы одним непробельным символом. Если передаёте аннотацию, заполните `agentTask` по [полной схеме признаков](../assess-task/references/features.md), `fieldEvidence` как непустой объект доказательств по полям, а `codeEvidence` как содержательную непустую строку, массив или объект. Вложенные массивы и объекты должны быть непустыми. Все конечные значения доказательств должны быть строками с хотя бы одним непробельным символом.
5. Для переноса ранее проверенной аннотации сравните `planId`, `source.sourceGeneration` и `source.sourceDigest` в полных строках родительского датасета и текущего снимка. Перенос допустим, только если все три значения известны в обеих строках и попарно совпадают. Если значение отсутствует, равно `null` или отличается, заново проверьте признаки по материалам плана и запишите актуальные доказательства, даже если значения признаков совпали. Так же поступите, если в прежней разметке нет подтверждения по каждому признаку.
6. Запишите UTF-8 JSON `{schemaVersion:1,contract:'atlm-teacher-annotations',snapshotId,parentDatasetRevisionId,rows}`. Укажите `null`, если родителя нет. Передайте файл через `SaveDatasetRevision` с этими же `snapshotId` и `parentDatasetRevisionId`. На `SAVED` сохраните `datasetRevisionId` и `datasetDigest`.
7. Выгрузите сохранённую ревизию через `GetDatasetRevision` с этим `datasetRevisionId` и `view:'download'`. Сверьте SHA-256 готового файла с `datasetDigest`. После успешной сверки запустите [локальное обучение](#локальный-рецепт-и-проверка) на оригинальных байтах `atlm-teacher-dataset`. При `HISTORICAL_PROVENANCE_INCOMPLETE` подготовьте новый нативный снимок и проверьте разметку для обучения.

Подставьте ID строк своего снимка. Переменные `agentTask` и `fieldEvidence` содержат полный набор проверенных значений и их обоснования для этой строки. Форму `agentTask` показывает [пример agent-task-v4](../assess-task/references/features.md#пример-исходных-признаков).

```js
const rows = [
  {
    rowId: 'row-completed',
    groupId: 'date-parser',
    eligibility: 'ELIGIBLE',
    reasons: [],
    annotation: {
      scope: 'ACTUAL',
      agentTask,
      fieldEvidence,
      codeEvidence: 'Тест parseDate принимает YYYY-MM-DD и отклоняет неверную дату.',
    },
  },
  {
    rowId: 'row-unmeasured',
    groupId: null,
    eligibility: 'EXCLUDED',
    reasons: ['INCOMPLETE_MEASUREMENT'],
    annotation: null,
  },
];
```

## Передача файлов

Чтобы начать выгрузку, вызовите `view:'download'` с ID сохранённого объекта. Для модели передавайте один и тот же `fileKind` (`BUNDLE` или `ARTIFACT`) при подготовке выгрузки и чтении всех частей.

Для большого снимка подготовка файла может потребовать много вызовов `download`. Сохраните `snapshotId` и после прерывания продолжайте с ним в `mode:'read'`. Размер готового снимка может превышать 16 МиБ. Сообщайте пользователю состояние подготовки файла и число уже проверенных частей при скачивании.

Чтобы начать загрузку, получите `manifest --file PATH`. Для `SaveDatasetRevision` передавайте одни и те же `snapshotId` и `parentDatasetRevisionId` на фазах `prepare`, `putPart` и `commit`. Для `RegisterModelRevision` на всех трёх фазах передавайте один и тот же `datasetRevisionId`. Вызовите `phase:'prepare'` с этими аргументами, новым `commandId` и `file:{sha256,byteLength}`. Лимит берите из discovery. Сохраните в локальном checkpoint имя инструмента, аргументы подготовки и путь файла. По мере загрузки сохраняйте подтверждённые индексы.

- **Отправить недостающие части.** При `UPLOADING` пропустите диапазоны `receivedPartRanges` с включёнными `start` и `end`. Читайте остальные части через `read-part --file PATH --part-index N` и передавайте их в `phase:'putPart'` с `partIndex` и `contentBase64`. Аргументы из `prepare` берите из checkpoint. Когда все части приняты, вызовите `phase:'commit'`. При `UPLOAD_INCOMPLETE` или `UPLOAD_EXPIRED` повторите `prepare` с исходными аргументами. Отправьте части, отсутствующие в новом `receivedPartRanges`, и повторите `commit`.
- **Повторить запрос.** При `MATERIALIZING` повторите download с тем же ID и селектором. При `VALIDATING` повторите тот же commit. В обоих случаях выждите `retryAfterMs`. Если ответ на запись потерялся, вызовите `GetCommandResult` с исходным `commandId`. В квитанции `FINAL` читайте `result` или `error`. При `PENDING` или `NOT_FOUND` извлеките из checkpoint исходные аргументы и точно повторите запрос.
- **Забрать готовый результат.** При выгрузке `READY` содержит `file:{sha256,byteLength,partSize,partCount,mediaType,encoding}`. Прочитайте `view:'filePart'` по `partIndex` с нуля. Полная часть содержит 49 152 байта. Сверьте индекс, digest и длину каждой части и запишите её по позиции в `PATH.partial`. После `verify --file PATH.partial --sha256 VALUE --byte-length N` атомарно переименуйте файл. При загрузке сохраните ID из `SAVED` или `REGISTERED` и завершите обход частей. Финальный ответ может прийти на любой фазе при точном повторе завершённой загрузки с `replayed:true`.

После подтверждённого отклонения содержимого, например `INVALID_TEACHER_DATASET` или `INVALID_ARTIFACT`, для исправленного файла вычислите новый manifest и используйте новый `commandId`. Квитанция отклонённой загрузки может остаться в `PENDING`. При `IDEMPOTENCY_KEY_REUSED` сопоставьте аргументы и намерение с checkpoint. Сообщайте пользователю коды, ID и прогресс.

Подставьте `site` с абсолютным путём каталога сайта и `callTool`, который вызывает найденный подключённый инструмент по публичному имени. Выполняйте функции переноса внутри code-mode по одной части за вызов.

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
  const finalState = name === 'SaveDatasetRevision' ? 'SAVED' : 'REGISTERED';
  if (accepted.state === finalState && accepted.replayed === true) return accepted;
  if (accepted.state !== 'UPLOADING' || accepted.partIndex !== partIndex)
    throw new Error('FILE_PART_RECEIPT_MISMATCH');
  return { partIndex, byteLength };
}
```

Для `preparedArgs` возьмите сохранённые аргументы подготовки. В `manifest` оставьте также `partSize` и `partCount`. Сохраняйте индекс, только если `sendPart` вернул подтверждение части. Если получен финальный результат, завершите загрузку и сохраните ревизию. Проверяйте полный digest до запуска обучения и перед prepare. Держите base64 и полный набор данных внутри code-mode и локальных файлов. По частям выводите только подтверждённый индекс и длину. Усечённый вывод helper отклоняйте до putPart.

## Локальный рецепт и проверка

Из `sites/plan-time-tracker` запишите `recipe.json` с `schemaVersion:1`, `recipeId:'atlm-teacher-hybrid-v1'`, `datasetRevisionId`, `datasetDigest` и `selection:{mode:'ALL_ELIGIBLE'}`. Если задана конкретная выборка, передайте `selection:{mode:'EXPLICIT',rowIds:[...]}` со всеми пригодными строками включённых групп. Укажите `holdoutUse` и краткое `holdoutUseNote`. Используйте `UNKNOWN` при неполной истории, `FIRST_REPORTED` при известной первой проверке и `REUSED_AFTER_REVIEW` после просмотра результатов тех же групп. Идентичный повтор — воспроизведение отчёта.

```sh
node scripts/train-atlm.mjs --dataset /path/dataset.json --recipe /path/recipe.json --out /path/run
```

Exit `0` даёт `registration.bundle.json`, `2` даёт отчёт с причиной недоступности кандидата, `1` означает ошибку входа или исполнения. Откройте `run.json`, `manifest.json` и `evaluation.json` в локальном каталоге. Для повтора используйте те же байты входов и каталог. Частичный или чужой результат сохраняется.

Development использует целые группы и факты, готовые строго до старта проверяемой группы. Финальные веса и калибровка используют только development. Holdout проверяет этот артефакт с `ACTUAL` признаками и отдельно с исходными `PLANNED` признаками для сопоставимого объёма. `ISSUED_FORECASTS` в отчёте локального обучения показывает зафиксированные при первом старте прогнозы из снимка. В нём возможны выдачи прежних ревизий, историческая медиана и планы без доступного прогноза. Смотрите на записанную идентичность, доступность и сопоставимость. Небольшая выборка, участие учителя после завершения работ, повторный просмотр holdout и широкие интервалы ограничивают выводы о будущей точности. Сравнивайте MAE кандидата и медианы на одинаковых парах, смотрите раздельные знаменатели доступности точки, интервала и охвата.

## Зарегистрировать и опубликовать

1. Если регистрация входит в поручение и тренер вернул `0`, передайте `registration.bundle.json` в `RegisterModelRevision` с `datasetRevisionId`. `REGISTERED` сохраняет модель и отчёт. Сообщите `modelRevisionId`, причину допуска и сопоставимые метрики. Указатель для новых прогнозов меняется отдельной командой.
2. При порученной активации вызовите `ListModelRevisions({schemaVersion:1,view:'list'})`. Используйте `activeModelRevisionId` (включая `null`) и `activationVersion` как `expectedActiveModelRevisionId` и `expectedActivationVersion`. В `ActivateModelRevision` укажите `modelRevisionId`, новый `commandId` и причину. При `MODEL_ACTIVATION_CONFLICT` перечитайте актуальные значения CAS. Изменение источника даёт `MODEL_SOURCES_CHANGED` и требует проверенной ревизии.
3. Передавайте `acceptExperimental:true` при `activationEligibility.status:'REQUIRES_EXPERIMENTAL_ACK'` в результате регистрации или отказе `EXPERIMENTAL_CONFIRMATION_REQUIRED` и только при явном согласии пользователя на такую активацию. Значение `serverEstimation.accuracy:'EXPERIMENTAL'` в `GetSavedEstimate` относится к исторической проверке прогноза и возможно при допуске `ELIGIBLE`. Заранее согласованные условия активации применяйте сразу, когда они выполнены.
4. Для отката вызовите `ActivateModelRevision` с ID прежней пригодной ревизии и актуальным CAS. Для допуска и подтверждения примените то же правило. После активации или отката сверяйте назначение `activeModelRevisionId`, доступную для прогнозов ревизию `servingModelRevisionId` и историю через `view:'activations'`. Прогноз уже начатого плана остаётся зафиксированным. Проспективная проверка новой модели появится по прогнозам, выданным этой ревизией после активации.
