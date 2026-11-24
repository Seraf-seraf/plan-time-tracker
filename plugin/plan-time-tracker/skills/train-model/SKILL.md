---
name: train-model
description: Подготовить преподавательский датасет ATLM, обучить модель локально или выполнить порученную операцию с ревизиями и публикацией прогноза.
---

# Обучить модель прогноза ATLM

Используйте этот навык для подготовки датасета, обучения, проверки ревизии, её публикации или отката. Обучение новой ревизии начинается со свежего снимка, если пользователь не указал готовый датасет или конкретный снимок. При продолжении того же запуска используйте сохранённые ID. Если поручена только подготовка датасета, завершите работу после сверки его экспорта. Регистрация и активация выполняются по поручению пользователя.

Прочитайте `GetTrackerInfo.assessments.atlm.registry` и `tools/list`. Для сводок, активации и отката достаточно подключённого MCP с правами владельца. Для выгрузки и загрузки файлов нужны Node.js 24, `sites/plan-time-tracker/scripts/atlm-transfer.mjs` и code-mode с прямой передачей `structuredContent` в локальные файлы. Для обучения нужен checkout с `scripts/train-atlm.mjs`, который поддерживает v4. Перед новой подготовкой сверьте `registry.teacherRecipeIds`, `registry.defaultTeacherRecipeId` и форматы из `registry.teacherDataset`. Перед регистрацией проверьте поддержку `recipeId` из пакета.

| Инструмент | Назначение |
| --- | --- |
| `CreateTrainingSnapshot` | Зафиксировать неизменяемый снимок в `mode:'create'`. В `mode:'read'` использовать `view:'list'` для списка или передать `snapshotId` для остальных видов. |
| `SaveDatasetRevision` | Сохранить решение по каждой строке снимка. Для `ELIGIBLE` учитель проверяет фактические признаки и время. У `EXCLUDED` нужна причина. |
| `GetDatasetRevision` | Найти ревизию через `view:'list'` с необязательным `snapshotId`. Для сводки, строк и выгрузки передать `datasetRevisionId`. |
| `RegisterModelRevision` | Сохранить пакет локального обучения с артефактом, отчётом и происхождением данных через `prepare`, `putPart` и `commit` с неизменными `datasetRevisionId`, `file` и `commandId`. |
| `ListModelRevisions` | Прочитать список и указатель через `view:'list'`, одну ревизию через `view:'detail'`, историю через `view:'activations'`. Выгрузка требует `modelRevisionId`. По умолчанию `fileKind:'BUNDLE'`, для одного артефакта используйте `'ARTIFACT'`. |
| `ActivateModelRevision` | Назначить ревизию по актуальному указателю и версии активации. Для допуска `REQUIRES_EXPERIMENTAL_ACK` требуется явное согласие пользователя. |

Для снимка и датасета `view:'rows'` возвращает компактный перечень. Полные строки, доказательства снимка и исходные байты экспорта доступны через `view:'download'` и `view:'filePart'`. Для следующей страницы списка или строк передавайте полученный `nextCursor` как `cursor` с теми же фильтрами.

## Снимок и преподавательская разметка

Учитель проверяет признаки и активное время по фактам выполнения, затем решает, войдёт ли план в датасет. Например, трекер записал 20 минут и `SCOPE_CHANGED`. Если код подтверждает фактический объём работы, а журнал — 42 минуты активной работы, исправьте признаки, запишите `actualMs:2520000` с подтверждением и включите план.

1. Для новой подготовки вызовите `CreateTrainingSnapshot` с `{schemaVersion:1,mode:'create',commandId}` и новым UUID. При `SOURCES_PENDING` повторите тот же запрос после `details.retryAfterMs`, если указан интервал. Используйте сохранённый `snapshotId` при продолжении того же запуска или по явному указанию пользователя. Если пользователь указал готовую ревизию датасета, начните с `GetDatasetRevision` по этому ID и проверьте, что формат подходит указанному рецепту. Для v4 нужен `atlm-teacher-dataset-v2`. Выгрузите полный снимок или указанную ревизию.
2. Проверьте каждую строку по `planId`. Для завершённого неудалённого плана откройте код или другой фактический результат, журнал работы и проверки. Перепроверьте **каждый признак** `agentTask`, включая вложенные поля. В `annotation.agentTask` запишите фактические значения и исправьте всё, что расходится с результатом. В `fieldEvidence` укажите основание каждого значения, в `codeEvidence` — где это проверить. Плановая оценка и прежняя разметка помогают найти нужные сведения. Переносите значения из них только после проверки. Проверьте модель, уровень рассуждения и `execution.plannedParallelAgents`. Для `ACTUAL` укажите подтверждённое число одновременно работавших агентов, включая основного. Сведения из исходной оценки подтверждают плановое число. Проверьте по материалам выполнения, сколько агентов работали одновременно. Неизвестные поля заполните по [схеме признаков](../assess-task/references/features.md). Если пользователь задал правила кодирования признаков для текущего датасета, примените их в указанной области и запишите основание в `fieldEvidence`. Настройки прежних запусков применяйте по явному указанию для этого датасета.
3. Проверьте фактическое активное время `PLAN_ACTIVE` по интервалам работы, журналу или явному сообщению пользователя о времени этой задачи. Если наблюдение `source.actualMs` подтверждается, можно использовать его без `annotation.actualTime`. Если наблюдения нет или найдено другое подтверждённое время, запишите целое число миллисекунд в `annotation.actualTime.actualMs` и укажите конкретное подтверждение в `annotation.actualTime.evidence`. Например, если пользователь подтвердил 22 минуты активной работы по этому плану, передайте `1320000` и ссылку на сообщение. Ноль подходит, когда источник подтверждает именно нулевое активное время. Если прежний замер оказался неверным и замена не подтверждена, используйте `EXCLUDED` с `ACTUAL_TIME_UNVERIFIED`.

   Если считаете время по интервалам, возьмите рабочие интервалы этого `planId` без пауз и посчитайте каждое пересечение один раз. Другой параллельный план и число агентов не сокращают и не суммируют это время. `source.actualMs` хранит исходное наблюдение трекера. Правка сохраняется в аннотации и используется при обучении. `evidence` принимает непустой текст, объект или массив со строковыми основаниями. Для ссылок на записи трекера передайте `{kind,id}` из доказательств этой строки. Восстановление наблюдений через `mode:'repair'` выполняется по отдельному поручению.
4. Примите решение по проверенным фактам. `rawEligibility` и `rawReasons` снимка подсказывают, что проверить. Например, при `SOURCE_NOT_OBSERVED`, `SOURCE_REFRESH_FAILED` или `INCOMPLETE_MEASUREMENT` включите строку, если подтвердили время и весь набор признаков. Для пригодной строки передайте `groupId:null`, `reasons:[]` и полную аннотацию с `scope:'ACTUAL'`. Исключите удалённые, незавершённые и явно пропущенные пользователем планы. Если фактическое время или обязательные признаки подтвердить не удалось, запишите `EXCLUDED`. Укажите применимые причины из списка ниже.
5. Сохраните явные пользовательские исключения по `planId` при смене цепочки датасетов. Через `GetDatasetRevision({schemaVersion:1,view:'list'})` без фильтра `snapshotId` пройдите историю нативных ревизий. Используйте `view:'rows'` с `nextCursor`, а при `additionalReasonCount` прочитайте полный экспорт. Примените последнее подтверждённое указание пользователя по этому `planId`, включая текущее поручение. В полном экспорте проверьте ссылку на явное снятие пропуска в `codeEvidence` пригодной строки или в `exclusionEvidence` исключённой. Сохраните `USER_REQUESTED_SKIP`, пока такого указания нет. При снятии запишите основание в итогах запуска и сохраните ссылку в соответствующем поле. Например, после снятия пропуска по плану без замера передайте `ACTUAL_TIME_UNVERIFIED` и укажите ссылку в `exclusionEvidence`.
6. Запишите UTF-8 JSON `{schemaVersion:1,contract:'atlm-teacher-annotations-v2',snapshotId,parentDatasetRevisionId,rows}` со всеми строками снимка. Если родителя нет, передайте `parentDatasetRevisionId:null`. После `SaveDatasetRevision` выгрузите сохранённый `atlm-teacher-dataset-v2` через `GetDatasetRevision` с `view:'download'` и полученным ID. Сверьте SHA-256 с `datasetDigest`, исправленные значения времени и набор всех `ELIGIBLE` строк. Для v4 передайте тренеру этот экспорт.

Укажите причину исключения по результату проверки.

- `PLAN_DELETED` для удалённого плана.
- `PLAN_NOT_COMPLETED` для незавершённого плана.
- `USER_REQUESTED_SKIP` для плана, который пользователь явно попросил пропустить.
- `ACTUAL_TIME_UNVERIFIED` когда фактическое время подтвердить не получилось. Если в снимке есть технически пригодный замер, но проверка выявила ошибку, укажите основание в `exclusionEvidence`.
- `ACTUAL_FEATURES_UNVERIFIED` когда обязательные признаки подтвердить не получилось. Передайте `annotation:null`.

В итогах подготовки укажите ID и дату снимка, ID датасета, число проверенных, пригодных и исключённых планов. Отдельно укажите, по каким планам поправили фактическое время и какие строки остались без подтверждения. Для нерешённой строки сохраните `planId` и причину.

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
      actualTime: {
        actualMs: 180000,
        evidence: 'Журнал работы по этому плану подтверждает 3 минуты активного времени.',
      },
    },
  },
  {
    rowId: 'row-unmeasured',
    groupId: null,
    eligibility: 'EXCLUDED',
    reasons: ['ACTUAL_TIME_UNVERIFIED'],
    annotation: null,
    exclusionEvidence: 'В рабочем интервале записано ожидание. Журнал не подтверждает, когда началась активная работа.',
  },
];
```

В примере подставьте ID строк, проверенные `agentTask` и `fieldEvidence`. Укажите конкретные записи, которыми подтвердили время. [Пример схемы признаков](../assess-task/references/features.md#пример-исходных-признаков).

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
  "recipeId": "atlm-teacher-hybrid-v4",
  "datasetRevisionId": "dataset-example",
  "datasetDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "selection": { "mode": "ALL_ELIGIBLE" }
}
```

```sh
node scripts/train-atlm.mjs --dataset /path/dataset.json --recipe /path/recipe.json --out /path/run
```

При коде выхода `0` откройте `run.json`, `manifest.json`, `evaluation.json` и артефакт. Сверьте `provenance.fitRowIds` со всеми `ELIGIBLE` строками датасета. Списки должны совпасть без дублей. Сверьте пары `planId` и `sampleId` в манифесте артефакта и его `n` с числом пригодных планов. При `2` прочитайте `run.json.reason` и диагностику. При `1` прочитайте код и сообщение ошибки. Для повтора полного запуска используйте те же байты входов и каталог. При `OUTPUT_DIR_CONFLICT` сохраните прежние файлы и укажите новый `--out`.

Рецепт v4 обучает финальную модель на всех подтверждённых строках. Даты и похожесть задач не делят этот набор. После активации качество показывает сводка прогнозов, зафиксированных при первом старте. Для сравнения с ними используется время, учтённое трекером по завершённым планам.

## Зарегистрировать и опубликовать

1. Если регистрация входит в поручение и тренер вернул `0`, передайте `registration.bundle.json` в `RegisterModelRevision` с `datasetRevisionId`. `REGISTERED` сохраняет модель и отчёт. Сообщите `modelRevisionId`, число обучающих планов и результат регистрации. Указатель для новых прогнозов меняется отдельной командой.
2. При порученной активации вызовите `ListModelRevisions({schemaVersion:1,view:'list'})`. Используйте `activeModelRevisionId` (включая `null`) и `activationVersion` как `expectedActiveModelRevisionId` и `expectedActivationVersion`. В `ActivateModelRevision` укажите `modelRevisionId`, новый `commandId` и причину. Если ответ потерян, проверьте `GetCommandResult` или повторите точный запрос с тем же `commandId`. При `MODEL_ACTIVATION_CONFLICT` перечитайте указатель и проверьте, остаётся ли выбранная ревизия нужной по поручению. Для новых значений CAS используйте новый `commandId`.
3. Для v4 достаточно порученной активации с актуальными значениями CAS. `ELIGIBLE` означает допуск к активации. Точность покажут выданные прогнозы после завершения сопоставимых планов. Если реестр требует `REQUIRES_EXPERIMENTAL_ACK` или `EXPERIMENTAL_CONFIRMATION_REQUIRED`, передайте `acceptExperimental:true` после явного согласия пользователя.
4. Для отката вызовите `ActivateModelRevision` с ID прежней пригодной ревизии и актуальным CAS. Для допуска и подтверждения примените то же правило. После активации или отката сверяйте назначение `activeModelRevisionId`, доступную для прогнозов ревизию `servingModelRevisionId` и историю через `view:'activations'`. Прогноз уже начатого плана остаётся зафиксированным. Проспективная проверка новой модели появится по прогнозам, выданным этой ревизией после активации.

`MODEL_SOURCES_CHANGED` при регистрации или активации означает, что нужен пакет из свежего снимка. Если поручено полное обновление модели, повторите подготовку и обучение. Если поручено действие с конкретной ревизией, сообщите её ID и причину отказа.
