const TRACKER_VERSION = '0.10.1';

const BODY_LIMIT = 128 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SNAPSHOT_DIGEST = /^sha256:[0-9a-f]{64}$/;

const isSnapshotDigest = (value) =>
  typeof value === 'string' && value.length === 71 && SNAPSHOT_DIGEST.test(value);

const WRITE_COMMANDS = new Set([
  'CreatePlan',
  'StartPlan',
  'PausePlan',
  'ResumePlan',
  'FinishPlan',
  'UpdatePlanMetadata',
  'DeletePlan',
  'RestorePlan',
]);

const TRACKER_COMMANDS = new Set(['SetStepStatus', 'RecordAssessment']);

const TRACKER_VERSIONED_COMMANDS = new Set(['SetStepStatus']);

const STEP_STATUSES = Object.freeze(['PENDING', 'RUNNING', 'BLOCKED', 'DONE']);

const TRACKER_READ_TOOLS = new Set([
  'GetTrackerCapabilities',
  'GetPlanExecutionSnapshot',
  'GetCommandReceipt',
  'GetAssessment',
  'GetEstimationHistory',
  'CalculateAtlmEstimate',
  'GetPlanEstimate',
]);

const ENVIRONMENT_IDS = Object.freeze(['local', 'cloud_workspace']);

class AppError extends Error {
  constructor(code, message, status, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status || 400;
    this.details = details;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function commandHashInput(envelope) {
  return {
    schemaVersion: envelope.schemaVersion,
    commandType: envelope.commandType,
    expectedVersion: envelope.expectedVersion == null ? null : envelope.expectedVersion,
    payload: envelope.payload,
  };
}

async function hashCommandInput(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function payloadHash(envelope) {
  const value = commandHashInput(envelope);
  if (envelope.commandType === 'CreatePlan' && envelope.sourceReference !== undefined)
    value.sourceReference = envelope.sourceReference;
  return hashCommandInput(value);
}

async function receiptMatchesCommand(receipt, envelope, hash) {
  if (envelope.commandType !== 'CreatePlan') return receipt.payload_hash === hash;
  const saved = parseColumn(receipt.payload_json, {});
  if (saved.sourceReference !== (envelope.sourceReference ?? envelope.payload.sourceReference))
    return false;
  return (
    receipt.payload_hash === hash ||
    receipt.payload_hash === (await hashCommandInput(commandHashInput(envelope)))
  );
}

function checkTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length > 100)
    throw new AppError('VALIDATION_ERROR', 'Выберите часовой пояс.');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timeZone }).format(0);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Неизвестный часовой пояс.');
  }
  return timeZone;
}

function calendarDateUtcMs(dateString, invalidMessage) {
  if (typeof dateString !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateString))
    throw new AppError('VALIDATION_ERROR', 'Дата должна иметь формат YYYY-MM-DD.');
  const [year, month, day] = dateString.split('-').map(Number);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  )
    throw new AppError('VALIDATION_ERROR', invalidMessage);
  return parsed.getTime();
}

function parsePlanCreatedAt(value) {
  if (!value || typeof value !== 'object')
    throw new AppError('VALIDATION_ERROR', 'Укажите дату составления плана.');
  const timeZone = checkTimeZone(value.timeZone);
  if (value.precision === 'instant') {
    if (typeof value.value !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/i.test(value.value)) {
      throw new AppError('VALIDATION_ERROR', 'Точный момент должен содержать Z или UTC offset.');
    }
    const atMs = Date.parse(value.value);
    if (!Number.isFinite(atMs))
      throw new AppError('VALIDATION_ERROR', 'Некорректный точный момент.');
    return { precision: 'instant', atMs: atMs, on: null, timeZone: timeZone };
  }
  if (value.precision === 'dateOnly') {
    calendarDateUtcMs(value.on, 'Некорректная календарная дата.');
    return { precision: 'dateOnly', atMs: null, on: value.on, timeZone: timeZone };
  }
  throw new AppError('VALIDATION_ERROR', 'precision должна быть instant или dateOnly.');
}

function dateInZone(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(epochMs);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year.padStart(4, '0') + '-' + values.month + '-' + values.day;
}

function planDateAfterStart(createdAt, firstStartedAt) {
  if (firstStartedAt == null) return false;
  if (createdAt.precision === 'instant') return createdAt.atMs > firstStartedAt;
  return createdAt.on > dateInZone(firstStartedAt, createdAt.timeZone);
}

function offsetAt(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone,
    timeZoneName: 'longOffset',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(epochMs);
  const raw = (parts.find((part) => part.type === 'timeZoneName') || {}).value || 'GMT+00:00';
  const match = raw.match(/GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === '+' ? 1 : -1;
  return (
    sign * (Number(match[2]) * 60 + Number(match[3])) * 60000 + sign * Number(match[4] || 0) * 1000
  );
}

function zonedCalendarStartMs(utcGuess, timeZone) {
  const localDay = (instant) => Math.floor((instant + offsetAt(instant, timeZone)) / 86400000);
  const targetDay = Math.floor(utcGuess / 86400000);
  const firstGuess = utcGuess - offsetAt(utcGuess, timeZone);
  const candidate = utcGuess - offsetAt(firstGuess, timeZone);
  if (localDay(candidate) === targetDay && localDay(candidate - 1) < targetDay) return candidate;
  // Midnight can be skipped, repeated, or an entire civil date can disappear.
  const searchRadiusMs = 36 * 60 * 60 * 1000;
  let low = utcGuess - searchRadiusMs,
    high = utcGuess + searchRadiusMs;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDay(middle) < targetDay) low = middle;
    else high = middle;
  }
  return high;
}

function zonedDateStartMs(dateString, timeZone) {
  checkTimeZone(timeZone);
  return zonedCalendarStartMs(
    calendarDateUtcMs(dateString, 'Некорректная дата периода.'),
    timeZone,
  );
}

function inclusiveDateRange(from, to, timeZone) {
  checkTimeZone(timeZone);
  if (!from || !to || from > to)
    throw new AppError('VALIDATION_ERROR', 'Укажите корректный включительный диапазон дат.');
  const fromUtc = calendarDateUtcMs(from, 'Некорректная дата периода.');
  const toUtc = calendarDateUtcMs(to, 'Некорректная дата периода.');
  return {
    startMs: zonedCalendarStartMs(fromUtc, timeZone),
    endMs: zonedCalendarStartMs(toUtc + 86400000, timeZone),
  };
}

function calculateActiveMs(intervals, nowMs) {
  return intervals.reduce(
    (sum, interval) =>
      sum + Math.max(0, (interval.end_ms == null ? nowMs : interval.end_ms) - interval.start_ms),
    0,
  );
}

function calculateCalendarMs(plan, nowMs) {
  if (plan.first_started_at == null) return null;
  return Math.max(0, (plan.finished_at == null ? nowMs : plan.finished_at) - plan.first_started_at);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : sorted[middle - 1] + Math.round((sorted[middle] - sorted[middle - 1]) / 2);
}

const V4_DONE_BOUNDARIES = [
  'ANALYSIS',
  'LOCAL_VERIFIED',
  'LOCAL_STAGED',
  'PUBLISHED',
  'DEPLOYED_VERIFIED',
];

const ESTIMATE_ID = /^[\x20-\x7e]{1,128}$/;

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dbFirst(db, sql, ...args) {
  return db
    .prepare(sql)
    .bind(...args)
    .first();
}

async function dbAll(db, sql, ...args) {
  const result = await db
    .prepare(sql)
    .bind(...args)
    .all();
  return result.results || [];
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      ...(headers || {}),
    },
  });
}

function parseColumn(value, fallback) {
  if (value == null) return fallback == null ? null : fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback == null ? null : fallback;
  }
}

function appError(code, message, status, details) {
  return new AppError(code, message, status, details);
}

function requireOwner(request) {
  const ownerId = request.headers.get('oai-authenticated-user-id');
  if (!ownerId || ownerId.length > 256)
    throw appError('NOT_AUTHENTICATED', 'Войдите в ChatGPT, чтобы продолжить.', 401);
  return { ownerId: ownerId, email: request.headers.get('oai-authenticated-user-email') || null };
}

async function ensureOwner(db, identity, nowMs) {
  await db
    .prepare(
      'INSERT INTO owners(owner_id,email,created_at) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET email=excluded.email',
    )
    .bind(identity.ownerId, identity.email || null, nowMs)
    .run();
}

function validateOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    throw appError('FORBIDDEN', 'Запрос с другого origin запрещён.', 403);
}

async function bodyJson(request, acceptsLargeBody = null) {
  const length = Number(request.headers.get('content-length') || 0);
  if (!acceptsLargeBody && length > BODY_LIMIT)
    throw appError('VALIDATION_ERROR', 'Размер запроса превышает лимит.', 413);
  const text = await request.text();
  const oversized = length > BODY_LIMIT || new TextEncoder().encode(text).length > BODY_LIMIT;
  if (!acceptsLargeBody && oversized)
    throw appError('VALIDATION_ERROR', 'Размер запроса превышает лимит.', 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw appError('VALIDATION_ERROR', 'Тело запроса должно быть JSON.');
  }
  if (oversized && !acceptsLargeBody(body))
    throw appError('VALIDATION_ERROR', 'Размер запроса превышает лимит.', 413);
  return body;
}

function isPlanDocumentCommand(envelope) {
  const { commandType, payload } = envelope ?? {};
  if (commandType === 'CreatePlan') return typeof payload?.planText === 'string';
  return commandType === 'UpdatePlanMetadata'
    && (typeof payload?.planText === 'string' || Array.isArray(payload?.stepEdits));
}

function validateEnvelope(envelope) {
  if (!envelope || envelope.schemaVersion !== 1)
    throw appError('VALIDATION_ERROR', 'Неподдерживаемая schemaVersion.');
  if (!UUID.test(envelope.commandId || ''))
    throw appError('VALIDATION_ERROR', 'commandId должен быть UUID.');
  if (!WRITE_COMMANDS.has(envelope.commandType))
    throw appError('VALIDATION_ERROR', 'Неизвестная команда.');
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload))
    throw appError('VALIDATION_ERROR', 'payload должен быть объектом.');
  if (
    envelope.commandType !== 'CreatePlan' &&
    (!Number.isSafeInteger(envelope.expectedVersion) || envelope.expectedVersion < 0)
  ) {
    throw appError('VALIDATION_ERROR', 'expectedVersion обязателен.');
  }
  if (envelope.commandType !== 'CreatePlan' && !UUID.test(envelope.payload.planId || ''))
    throw appError('VALIDATION_ERROR', 'planId должен быть UUID.');
  return envelope;
}

function messageFor(code) {
  return (
    {
      VALIDATION_ERROR: 'Проверьте введённые данные.',
      NOT_AUTHENTICATED: 'Войдите в ChatGPT.',
      FORBIDDEN: 'Недостаточно прав.',
      PLAN_NOT_FOUND: 'План не найден.',
      PLAN_DELETED: 'План удалён. Сначала восстановите его в разделе «Удалённые».',
      PLAN_NOT_DELETED: 'План не находится в разделе «Удалённые».',
      STEP_NOT_FOUND: 'Этап не найден.',
      STEP_HISTORY_EXISTS: 'Нельзя удалить этап с сохранённой оценкой или учтённым временем.',
      CHECKPOINTS_INCOMPLETE: 'Завершите этапы либо укажите причину завершения с исключением.',
      ASSESSMENT_TARGET_CONFLICT: 'Серия оценки уже привязана к другой цели.',
      ASSESSMENT_CONTEXT_CHANGED:
        'Требования изменились после анализа задачи. Перечитайте контекст и пересмотрите оценку.',
      ATLM_FORECAST_SCOPE_CHANGED: 'План уже запущен. Новый исходный прогноз сохранять нельзя.',
      ATLM_MODEL_CHANGED:
        'Модель или исходная история изменились во время расчёта. Получите свежую оценку новой командой.',
      DATASET_CHANGED: 'Набор обучающих данных изменился. Начните выгрузку заново.',
      SOURCE_REFRESH_FAILED: 'Часть исходных наблюдений недоступна после повторных попыток обновления.',
      SOURCES_PENDING: 'Трекер обновляет исходные наблюдения. Повторите после завершения обновления.',
      INVALID_CURSOR: 'Курсор не подходит к этой выборке. Начните просмотр заново.',
      SNAPSHOT_NOT_FOUND: 'Снимок обучения не найден.',
      DATASET_REVISION_NOT_FOUND: 'Ревизия датасета не найдена.',
      MODEL_REVISION_NOT_FOUND: 'Ревизия модели не найдена.',
      MODEL_ARTIFACT_NOT_FOUND: 'Артефакт этой ревизии недоступен.',
      LINEAGE_MISMATCH: 'Связь со снимком или исходная разметка изменились. Проверьте источники.',
      INVALID_TEACHER_DATASET: 'Проверьте состав снимка, решения и источники разметки.',
      INVALID_ARTIFACT: 'Пакет модели или его доказательства не прошли проверку.',
      MODEL_SOURCES_CHANGED: 'Источники модели изменились. Подготовьте ревизию из проверенного снимка.',
      MODEL_ACTIVATION_CONFLICT: 'Назначение модели изменилось. Прочитайте текущую версию перед повтором.',
      EXPERIMENTAL_CONFIRMATION_REQUIRED: 'Условия допуска не выполнены. Требуется явное принятие эксперимента.',
      UPLOAD_NOT_PREPARED: 'Сначала подготовьте передачу файла той же командой.',
      UPLOAD_INCOMPLETE: 'Передайте недостающие части файла той же командой.',
      UPLOAD_EXPIRED: 'Срок хранения частей истёк. Повторите prepare с тем же commandId.',
      UPLOAD_CHECKSUM_MISMATCH: 'SHA-256 переданного файла отличается от заявленного.',
      INVALID_UPLOAD: 'Проверьте размер и кодировку файла.',
      UPLOAD_PART_CONFLICT: 'По этой позиции уже сохранена другая часть файла.',
      FILE_NOT_READY: 'Сначала получите готовый дескриптор файла через download.',
      ASSESSMENT_SOURCE_NOT_FOUND: 'Исторический источник оценки недоступен.',
      ASSESSMENT_REQUIRED: 'Перед первым запуском сохраните плановую оценку ATLM.',
      ASSESSMENT_INCOMPLETE: 'Заполните обязательные поля и основания оценки.',
      ASSESSMENT_INVALID: 'Исправьте указанные поля оценки.',
      ASSESSMENT_SCHEMA_OUTDATED: 'Сохраните новую оценку по текущей схеме.',
      ASSESSMENT_SCHEMA_RETIRED:
        'Исходная оценка удалена при переходе на новую схему ATLM; повтор команды не создаёт оценку.',
      ATLM_CLIENT_RETIRED:
        'Клиент использует прежний формат прогноза. Обновите приложение и повторите запуск плана.',
      PLAN_PAUSED: 'План на паузе. Сначала явно возобновите его.',
      PLAN_COMPLETED: 'Завершённый план не принимает новые этапы.',
      INVALID_TRANSITION: 'Команда недоступна в текущем состоянии плана.',
      VERSION_CONFLICT: 'План изменился. Обновите данные и повторите команду с новой версией.',
      IDEMPOTENCY_KEY_REUSED: 'commandId уже использован с другим содержимым.',
      SOURCE_UNAVAILABLE: 'Источник данных временно недоступен.',
      RATE_LIMITED: 'Превышена частота запросов.',
      INTERNAL_ERROR: 'Внутренняя ошибка. Повторите запрос позже.',
    }[code] || 'Команда отклонена.'
  );
}

function resultFromReceipt(row, replayed) {
  const snapshot = parseColumn(row.result_json, {});
  if (row.outcome_code !== 'OK' && row.outcome_code !== 'PARTIAL') {
    const code = row.outcome_code || 'INTERNAL_ERROR';
    if (snapshot && typeof snapshot === 'object') {
      snapshot.error = code;
      if (
        code === 'VERSION_CONFLICT' &&
        Number.isSafeInteger(row.result_version) &&
        snapshot.currentVersion === undefined
      )
        snapshot.currentVersion = row.result_version;
    }
    const status = [
      'ATLM_FORECAST_SCOPE_CHANGED',
      'ATLM_MODEL_CHANGED',
      'ASSESSMENT_TARGET_CONFLICT',
      'ASSESSMENT_CONTEXT_CHANGED',
      'VERSION_CONFLICT',
      'CHECKPOINTS_INCOMPLETE',
      'STEP_HISTORY_EXISTS',
      'IDEMPOTENCY_KEY_REUSED',
      'PLAN_DELETED',
      'PLAN_NOT_DELETED',
      'PLAN_PAUSED',
      'PLAN_COMPLETED',
      'INVALID_TRANSITION',
    ].includes(code)
      ? 409
      : ['PLAN_NOT_FOUND', 'STEP_NOT_FOUND'].includes(code)
        ? 404
        : code === 'SOURCE_UNAVAILABLE'
          ? 503
          : code === 'RATE_LIMITED'
            ? 429
            : code === 'INTERNAL_ERROR'
              ? 500
              : 422;
    throw appError(
      code,
      typeof snapshot.message === 'string'
        ? snapshot.message
        : row.command_type === 'StartPlan' && code === 'ASSESSMENT_CONTEXT_CHANGED'
          ? 'Во время запуска изменились требования, исходные признаки или данные прогноза. Таймер не запущен. Повторите StartPlan новой командой.'
          : messageFor(code),
      status,
      snapshot,
    );
  }
  const wasReplayed = replayed || snapshot.replayed === true || snapshot.replayed === 1;
  if (snapshot.replayed !== undefined)
    snapshot.replayed = snapshot.replayed === true || snapshot.replayed === 1;
  return {
    commandId: row.command_id,
    applied: !wasReplayed,
    outcome: row.outcome_code,
    snapshot: snapshot,
    serverOccurredAt: row.recorded_at,
    serverNow: row.server_now_ms,
    resultingVersion: row.result_version,
    replayed: wasReplayed,
    payloadHash: row.payload_hash,
    resultVersion: row.result_version,
    result: snapshot,
  };
}

function mapDbError(error) {
  const message = String(error?.message || '');
  if (message.includes('ATLM_CLIENT_RETIRED'))
    return appError('ATLM_CLIENT_RETIRED', messageFor('ATLM_CLIENT_RETIRED'), 409);
  if (message.includes('ASSESSMENT_SCHEMA_RETIRED'))
    return appError('ASSESSMENT_SCHEMA_RETIRED', messageFor('ASSESSMENT_SCHEMA_RETIRED'), 409);
  if (message.includes('WORK_INTERVAL_OVERLAP'))
    return appError('VALIDATION_ERROR', 'Рабочие интервалы не могут пересекаться.');
  if (message.includes('CHECK constraint failed'))
    return appError('VALIDATION_ERROR', 'Данные нарушают ограничения модели.');
  return error;
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value))
    if (!allowed.has(key))
      throw appError('VALIDATION_ERROR', label + ' содержит неизвестное поле.');
}

function assertSafeMetadataText(value, label) {
  if (typeof value !== 'string') return;
  const secretLike =
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/-]{16,})/i;
  if (
    secretLike.test(value) ||
    /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/i.test(value)
  ) {
    throw appError('VALIDATION_ERROR', label + ' не должен содержать credentials.');
  }
}

function unionIntervals(intervals) {
  const merged = [];
  for (const interval of intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

export {
  AppError,
  ENVIRONMENT_IDS,
  ESTIMATE_ID,
  STEP_STATUSES,
  TRACKER_COMMANDS,
  TRACKER_READ_TOOLS,
  TRACKER_VERSION,
  TRACKER_VERSIONED_COMMANDS,
  UUID,
  V4_DONE_BOUNDARIES,
  WRITE_COMMANDS,
  appError,
  assertExactKeys,
  assertSafeMetadataText,
  bodyJson,
  calculateActiveMs,
  calculateCalendarMs,
  canonical,
  checkTimeZone,
  dbAll,
  dbFirst,
  ensureOwner,
  hashCommandInput,
  inclusiveDateRange,
  isPlainRecord,
  isPlanDocumentCommand,
  isSnapshotDigest,
  json,
  mapDbError,
  median,
  messageFor,
  parseColumn,
  parsePlanCreatedAt,
  payloadHash,
  planDateAfterStart,
  receiptMatchesCommand,
  requireOwner,
  resultFromReceipt,
  unionIntervals,
  validateEnvelope,
  validateOrigin,
  zonedDateStartMs,
};
