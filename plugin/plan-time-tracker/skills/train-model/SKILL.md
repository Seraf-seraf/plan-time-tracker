---
name: train-model
description: Подготовить преподавательский датасет ATLM, обучить модель локально или выполнить порученную операцию с ревизиями и публикацией прогноза.
---

# Обучить модель прогноза ATLM

Используйте этот навык, когда пользователь просит подготовить датасет, обучить модель, проверить ревизию, опубликовать её или откатить публикацию. Начинайте со стадии, которая нужна для порученного результата. Первый запуск и завершение плана, оценка задачи и просмотр реестра выполняются независимо от обучения.

Прочитайте `GetTrackerInfo.assessments.atlm.registry` и `tools/list` подключённого трекера. Сверьте `schemaVersion:1`, условные схемы и лимиты. Авторизацию предоставляет подключённый MCP. Для работы с файлами нужен checkout с `sites/plan-time-tracker/scripts/atlm-transfer.mjs` и `scripts/train-atlm.mjs`, Node.js 24 и code-mode, где скрипт вызывает MCP и передаёт `structuredContent` напрямую в локальные файлы. При отсутствии одной из этих возможностей назовите конкретный блокер. До подготовки датасета и перед регистрацией проверьте наличие `atlm-teacher-hybrid-v3` в `GetTrackerInfo.assessments.atlm.registry.teacherRecipeIds` и сверьте `registry.defaultTeacherRecipeId`, если поле доступно. Если рецепта нет, сообщите, что для нового обучения нужен обновлённый сервер. Чтение и аудит сохранённых ревизий доступны через MCP. Служебные токены, заголовки владельца и доступ к SQLite агенту не нужны.

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

1. Для новой подготовки датасета вызовите `CreateTrainingSnapshot` с `{schemaVersion:1,mode:'create',commandId}` и новым UUID. Снимок фиксирует актуальные наблюдения трекера. При `SOURCES_PENDING` повторите ту же команду после `details.retryAfterMs`, если указан интервал. Используйте сохранённый `snapshotId` только для продолжения того же запуска. Получите полный экспорт в `mode:'read'` по этому ID.
2. Сверьте каждую строку снимка по `planId`. Для `ELIGIBLE` нужны завершённый неудалённый план, проверенное наблюдение с `source.actualMs` и подтверждённые фактические признаки. Измеренный ноль допустим. Определяйте пригодность по `rawEligibility`, `rawReasons` и источнику текущего снимка. Прежние решения учителя, например старое `INCOMPLETE_MEASUREMENT`, перепроверяйте по текущей строке. `SCOPE_CHANGED`, `MISSING_FEATURES`, `MISSING_REQUIRED_FEATURES` и `INVALID_FEATURES` допускают разметку `ACTUAL`, если факт и фактические признаки подтверждены. При `SOURCE_NOT_OBSERVED`, `SOURCE_REFRESH_FAILED`, неполном измерении, удалении или незавершённом плане запишите `EXCLUDED` с конкретной причиной. Используйте сведения, доступные в снимке. Восстановление наблюдений через `mode:'repair'` выполняется по отдельному поручению.
3. Сохраните явные пользовательские исключения по `planId`, включая решения из другой цепочки датасетов. Запросите историю нативных ревизий через `GetDatasetRevision({schemaVersion:1,view:'list'})` без фильтра `snapshotId`. Проверьте `view:'rows'` с `nextCursor`. Если строка содержит `additionalReasonCount`, проверьте полный экспорт. Если за `USER_REQUESTED_SKIP` следует более позднее решение `ELIGIBLE`, прочитайте полную аннотацию из этой ревизии и проверьте, что `codeEvidence` ссылается на явное указание пользователя снять исключение с этого плана. Пока подтверждения нет, перенесите `USER_REQUESTED_SKIP` в `EXCLUDED`. При новом указании снять исключение сохраните основание в итогах запуска, а ссылку на подтверждение в `codeEvidence` новой аннотации.
4. Для пригодной строки передайте `groupId:null`, `reasons:[]` и полную аннотацию `ACTUAL` по [схеме признаков](../assess-task/references/features.md). В `fieldEvidence` укажите обоснование каждого значения, а в `codeEvidence` укажите итоговый код, журнал или другой материал выполнения плана. Переносите плановые признаки в фактические после подтверждения. Сохраняйте известные модель, уровень рассуждения и число агентов. Используйте допустимые неизвестные значения только при отсутствии подтверждения. Индивидуальные настройки прежней ревизии применяйте лишь по текущему поручению. Для `EXCLUDED` укажите хотя бы одну конкретную причину. Причины — строки печатного ASCII до 128 символов с непробельным символом. Аннотация может быть `null`.
5. Переиспользуйте проверенную аннотацию родительского датасета только при совпадении известных `planId`, `source.sourceGeneration` и `source.sourceDigest`. Проверьте полноту подтверждений. При изменении источника разметьте строку заново. Запишите UTF-8 JSON `{schemaVersion:1,contract:'atlm-teacher-annotations',snapshotId,parentDatasetRevisionId,rows}` и загрузите его через `SaveDatasetRevision`. Укажите `parentDatasetRevisionId:null`, если родителя нет.
6. Выгрузите сохранённую ревизию через `GetDatasetRevision` с полученным `datasetRevisionId` и `view:'download'`. Сверьте SHA-256 файла с `datasetDigest` и список строк с разметкой. Сохраните список всех пригодных ID. При `HISTORICAL_PROVENANCE_INCOMPLETE` используйте новый нативный снимок.

В итогах подготовки укажите `snapshotId`, дату снимка, `datasetRevisionId`, число планов и число пригодных и исключённых. Для нерешённых строк укажите `planId`, причину в снимке и решение учителя. Отметьте сохранённые пользовательские исключения.

```js
const rows = [
  {
    rowId: 'row-completed',
    groupId: null,
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

Подставьте ID строк снимка и передайте полный проверенный `agentTask` и обоснования `fieldEvidence`. [Пример схемы признаков](../assess-task/references/features.md#пример-исходных-признаков).

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

Из `sites/plan-time-tracker` запишите `recipe.json`, подставив ID ревизии и digest исходного экспорта. `ALL_ELIGIBLE` включает все проверенные планы.

```json
{
  "schemaVersion": 1,
  "recipeId": "atlm-teacher-hybrid-v3",
  "datasetRevisionId": "dataset-example",
  "datasetDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "selection": { "mode": "ALL_ELIGIBLE" }
}
```

```sh
node scripts/train-atlm.mjs --dataset /path/dataset.json --recipe /path/recipe.json --out /path/run
```

Exit `0` даёт `registration.bundle.json`, `2` даёт отчёт с причиной недоступности кандидата, `1` означает ошибку входа или исполнения. Откройте `run.json`, `manifest.json` и `evaluation.json` в локальном каталоге. Для повтора используйте те же байты входов и каталог. Частичный или чужой результат сохраняется.

Сверьте `provenance.fitRowIds` из `manifest.json` с ID всех `ELIGIBLE` строк сохранённого экспорта. Проверьте равенство списков как множеств и отсутствие дублей. Сверьте пары `planId` и `sampleId` в манифесте артефакта и его `n` с числом пригодных планов. При расхождении разберите пропущенные или лишние ID до регистрации.

Рецепт v3 обучает финальную модель на всём пригодном составе. Даты и сходство задач не делят его на части. Проверка точности на исторических срезах и отложенной выборке в v3 отсутствует. После активации качество отражает сводка фактически выданных прогнозов, зафиксированных до первого старта и сопоставленных с активным временем завершённых планов.

## Зарегистрировать и опубликовать

1. Если регистрация входит в поручение и тренер вернул `0`, передайте `registration.bundle.json` в `RegisterModelRevision` с `datasetRevisionId`. `REGISTERED` сохраняет модель и отчёт. Сообщите `modelRevisionId`, число обучающих планов и результат регистрации. Указатель для новых прогнозов меняется отдельной командой.
2. При порученной активации вызовите `ListModelRevisions({schemaVersion:1,view:'list'})`. Используйте `activeModelRevisionId` (включая `null`) и `activationVersion` как `expectedActiveModelRevisionId` и `expectedActivationVersion`. В `ActivateModelRevision` укажите `modelRevisionId`, новый `commandId` и причину. При `MODEL_ACTIVATION_CONFLICT` перечитайте актуальные значения CAS. Изменение источника даёт `MODEL_SOURCES_CHANGED` и требует проверенной ревизии.
3. Для v3 достаточно порученной активации с актуальными значениями CAS. Для прежних рецептов передавайте `acceptExperimental:true` при `REQUIRES_EXPERIMENTAL_ACK` или `EXPERIMENTAL_CONFIRMATION_REQUIRED` после явного согласия пользователя. Значение `serverEstimation.accuracy:'EXPERIMENTAL'` описывает состояние проверки точности.
4. Для отката вызовите `ActivateModelRevision` с ID прежней пригодной ревизии и актуальным CAS. Для допуска и подтверждения примените то же правило. После активации или отката сверяйте назначение `activeModelRevisionId`, доступную для прогнозов ревизию `servingModelRevisionId` и историю через `view:'activations'`. Прогноз уже начатого плана остаётся зафиксированным. Проспективная проверка новой модели появится по прогнозам, выданным этой ревизией после активации.
