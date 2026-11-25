# Передача файлов через MCP

Для работы с файлами нужны Node.js 24, `sites/plan-time-tracker/scripts/atlm-transfer.mjs` и code-mode с прямой передачей `structuredContent` в локальные файлы.

Для снимка и датасета `view:'rows'` возвращает компактный перечень. Полные строки, доказательства снимка и исходные байты экспорта доступны через `view:'download'` и `view:'filePart'`. Для следующей страницы списка или строк передавайте полученный `nextCursor` как `cursor` с теми же фильтрами.

Чтобы начать выгрузку, вызовите `view:'download'` с ID сохранённого объекта. Для модели передавайте один и тот же `fileKind` (`BUNDLE` или `ARTIFACT`) при подготовке выгрузки и чтении всех частей.

Для большого снимка подготовка файла может потребовать много вызовов `download`. Сохраните `snapshotId` и после прерывания продолжайте с ним в `mode:'read'`. Размер готового снимка может превышать 16 МиБ. Сообщайте пользователю состояние подготовки файла и число уже проверенных частей при скачивании.

Чтобы начать загрузку, получите `manifest --file PATH`. Для `SaveDatasetRevision` передавайте одни и те же `snapshotId` и `parentDatasetRevisionId` на фазах `prepare`, `putPart` и `commit`. Для `RegisterModelRevision` на всех трёх фазах передавайте один и тот же `datasetRevisionId`. Вызовите `phase:'prepare'` с этими аргументами, новым `commandId` и `file:{sha256,byteLength}`. Лимит берите из discovery. Сохраните в локальном checkpoint имя инструмента, аргументы подготовки и путь файла. По мере загрузки сохраняйте подтверждённые индексы.

- **Отправить недостающие части.** При `UPLOADING` пропустите диапазоны `receivedPartRanges` с включёнными `start` и `end`. Читайте остальные части через `read-part --file PATH --part-index N` и передавайте их в `phase:'putPart'` с `partIndex` и `contentBase64`. Аргументы из `prepare` берите из checkpoint. Когда все части приняты, вызовите `phase:'commit'`. При `UPLOAD_INCOMPLETE` или `UPLOAD_EXPIRED` повторите `prepare` с исходными аргументами. Отправьте части, отсутствующие в новом `receivedPartRanges`, и повторите `commit`.
- **Повторить запрос.** При `MATERIALIZING` повторите download с тем же ID и селектором. При `VALIDATING` повторите тот же commit. В обоих случаях выждите `retryAfterMs`. Если ответ на запись потерялся, вызовите `GetCommandResult` с исходным `commandId`. В квитанции `FINAL` читайте `result` или `error`. При `PENDING` или `NOT_FOUND` извлеките из checkpoint исходные аргументы и точно повторите запрос.
- **Забрать готовый результат.** При выгрузке `READY` содержит `file:{sha256,byteLength,partSize,partCount,mediaType,encoding}`. Прочитайте `view:'filePart'` по `partIndex` с нуля. Полная часть содержит 49 152 байта. Для каждой части сверьте индекс, длину и `fileSha256` с SHA-256 всего файла в ответе `READY`. Запишите часть по позиции в `PATH.partial`. Чтобы продолжить после прерывания, сохраните селектор, SHA-256 и длину файла, локальный путь и подтверждённые индексы. При изменении селектора, SHA-256 или длины начните запись в новый `.partial`. После `verify --file PATH.partial --sha256 VALUE --byte-length N` атомарно переименуйте файл. При загрузке сохраните ID из `SAVED` или `REGISTERED` и завершите обход частей. Финальный ответ может прийти на любой фазе при точном повторе завершённой загрузки с `replayed:true`.

После подтверждённого отклонения содержимого, например `INVALID_TEACHER_DATASET` или `INVALID_ARTIFACT`, для исправленного файла вычислите новый manifest и используйте новый `commandId`. Квитанция отклонённой загрузки может остаться в `PENDING`. При `IDEMPOTENCY_KEY_REUSED` сопоставьте аргументы и намерение с checkpoint. Сообщайте пользователю коды, ID и прогресс.

## Передача части файла

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
