const BODY_LIMIT = 128 * 1024;
const TRACKER_LEASE_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;
const SNAPSHOT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const isSnapshotDigest = value => typeof value === "string" && value.length === 71 && SNAPSHOT_DIGEST.test(value);
const WRITE_COMMANDS = new Set(["CreatePlan", "StartPlan", "PausePlan", "ResumePlan", "FinishPlan", "UpdatePlanMetadata"]);
const TRACKER_COMMANDS = new Set(["CreateStep", "UpdateStep", "ClaimStepAttempt", "RenewStepLease", "CloseStepAttempt", "StartStep", "BlockStep", "RecordStepResult", "RecordCheck", "AppendObservation"]);
const TRACKER_VERSIONED_COMMANDS = new Set(["UpdateStep", "ClaimStepAttempt", "StartStep", "BlockStep", "RecordStepResult"]);
const TRACKER_READ_TOOLS = new Set(["GetTrackerCapabilities", "GetPlanExecutionSnapshot", "GetTimeline", "GetCommandReceipt"]);
const OBSERVATION_TYPES = new Set(["turn_started", "turn_finished", "tool_started", "tool_finished", "heartbeat", "gap", "correction"]);
const UI_TIME_ZONES = [{ value: "Europe/Moscow", label: "Москва (UTC+3)" }, { value: "Asia/Omsk", label: "Омск (UTC+6)" }];
export function resolveUiTimeZone(value) { return UI_TIME_ZONES.some((option) => option.value === value) ? value : "Asia/Omsk"; }

export class AppError extends Error {
  constructor(code, message, status, details) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status || 400;
    this.details = details;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
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
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function payloadHash(envelope) {
  const value = commandHashInput(envelope);
  if (envelope.commandType === "CreatePlan" && envelope.sourceReference !== undefined) value.sourceReference = envelope.sourceReference;
  return hashCommandInput(value);
}

async function receiptMatchesCommand(receipt, envelope, hash) {
  if (envelope.commandType === "CreatePlan") {
    const storedPayload = parseColumn(receipt.payload_json, {});
    const sourceReference = envelope.sourceReference === undefined ? envelope.payload.sourceReference : envelope.sourceReference;
    if (storedPayload.sourceReference !== sourceReference) return false;
  }
  if (receipt.payload_hash === hash) return true;
  if (envelope.commandType !== "CreatePlan" || receipt.payload_hash !== await hashCommandInput(commandHashInput(envelope))) return false;
  return true;
}

export function checkTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length > 100) throw new AppError("VALIDATION_ERROR", "Выберите часовой пояс.");
  try { new Intl.DateTimeFormat("en", { timeZone: timeZone }).format(0); }
  catch { throw new AppError("VALIDATION_ERROR", "Неизвестный часовой пояс."); }
  return timeZone;
}

function calendarDateUtcMs(dateString, invalidMessage) {
  if (typeof dateString !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) throw new AppError("VALIDATION_ERROR", "Дата должна иметь формат YYYY-MM-DD.");
  const [year, month, day] = dateString.split("-").map(Number);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (year < 1 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw new AppError("VALIDATION_ERROR", invalidMessage);
  return parsed.getTime();
}

export function parsePlanCreatedAt(value) {
  if (!value || typeof value !== "object") throw new AppError("VALIDATION_ERROR", "Укажите дату составления плана.");
  const timeZone = checkTimeZone(value.timeZone);
  if (value.precision === "instant") {
    if (typeof value.value !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/i.test(value.value)) {
      throw new AppError("VALIDATION_ERROR", "Точный момент должен содержать Z или UTC offset.");
    }
    const atMs = Date.parse(value.value);
    if (!Number.isFinite(atMs)) throw new AppError("VALIDATION_ERROR", "Некорректный точный момент.");
    return { precision: "instant", atMs: atMs, on: null, timeZone: timeZone };
  }
  if (value.precision === "dateOnly") {
    calendarDateUtcMs(value.on, "Некорректная календарная дата.");
    return { precision: "dateOnly", atMs: null, on: value.on, timeZone: timeZone };
  }
  throw new AppError("VALIDATION_ERROR", "precision должна быть instant или dateOnly.");
}

function dateInZone(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(epochMs);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

function planDateAfterStart(createdAt, firstStartedAt) {
  if (firstStartedAt == null) return false;
  if (createdAt.precision === "instant") return createdAt.atMs > firstStartedAt;
  return createdAt.on > dateInZone(firstStartedAt, createdAt.timeZone);
}

function offsetAt(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone, timeZoneName: "longOffset", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(epochMs);
  const raw = (parts.find((part) => part.type === "timeZoneName") || {}).value || "GMT+00:00";
  const match = raw.match(/GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === "+" ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60000 + sign * Number(match[4] || 0) * 1000;
}

function zonedCalendarStartMs(utcGuess, timeZone) {
  let result = utcGuess;
  for (let i = 0; i < 4; i += 1) result = utcGuess - offsetAt(result, timeZone);
  return result;
}

export function zonedDateStartMs(dateString, timeZone) {
  checkTimeZone(timeZone);
  return zonedCalendarStartMs(calendarDateUtcMs(dateString, "Некорректная дата периода."), timeZone);
}

export function inclusiveDateRange(from, to, timeZone) {
  checkTimeZone(timeZone);
  if (!from || !to || from > to) throw new AppError("VALIDATION_ERROR", "Укажите корректный включительный диапазон дат.");
  const fromUtc = calendarDateUtcMs(from, "Некорректная дата периода.");
  const toUtc = calendarDateUtcMs(to, "Некорректная дата периода.");
  return { startMs: zonedCalendarStartMs(fromUtc, timeZone), endMs: zonedCalendarStartMs(toUtc + 86400000, timeZone) };
}

export function calculateActiveMs(intervals, nowMs) {
  return intervals.reduce((sum, interval) => sum + Math.max(0, (interval.end_ms == null ? nowMs : interval.end_ms) - interval.start_ms), 0);
}

export function calculateCalendarMs(plan, nowMs) {
  if (plan.first_started_at == null) return null;
  return Math.max(0, (plan.finished_at == null ? nowMs : plan.finished_at) - plan.first_started_at);
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function dbFirst(db, sql, ...args) { return db.prepare(sql).bind(...args).first(); }
async function dbAll(db, sql, ...args) { const result = await db.prepare(sql).bind(...args).all(); return result.results || []; }
function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", ...(headers || {}) } });
}
function parseColumn(value, fallback) { if (value == null) return fallback == null ? null : fallback; try { return JSON.parse(value); } catch { return fallback == null ? null : fallback; } }

function appError(code, message, status, details) { return new AppError(code, message, status, details); }
function requireOwner(request) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId || ownerId.length > 256) throw appError("NOT_AUTHENTICATED", "Войдите в ChatGPT, чтобы продолжить.", 401);
  return { ownerId: ownerId, email: request.headers.get("oai-authenticated-user-email") || null };
}
async function ensureOwner(db, identity, nowMs) {
  await db.prepare("INSERT INTO owners(owner_id,email,created_at) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET email=excluded.email")
    .bind(identity.ownerId, identity.email || null, nowMs).run();
}
function validateOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw appError("FORBIDDEN", "Запрос с другого origin запрещён.", 403);
}
async function bodyJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > BODY_LIMIT) throw appError("VALIDATION_ERROR", "Размер запроса превышает лимит.", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > BODY_LIMIT) throw appError("VALIDATION_ERROR", "Размер запроса превышает лимит.", 413);
  try { return JSON.parse(text); } catch { throw appError("VALIDATION_ERROR", "Тело запроса должно быть JSON."); }
}

function validateEnvelope(envelope) {
  if (!envelope || envelope.schemaVersion !== 1) throw appError("VALIDATION_ERROR", "Неподдерживаемая schemaVersion.");
  if (!UUID.test(envelope.commandId || "")) throw appError("VALIDATION_ERROR", "commandId должен быть UUID.");
  if (!WRITE_COMMANDS.has(envelope.commandType)) throw appError("VALIDATION_ERROR", "Неизвестная команда.");
  if (!envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) throw appError("VALIDATION_ERROR", "payload должен быть объектом.");
  if (envelope.commandType !== "CreatePlan" && (!Number.isSafeInteger(envelope.expectedVersion) || envelope.expectedVersion < 0)) {
    throw appError("VALIDATION_ERROR", "expectedVersion обязателен.");
  }
  if (envelope.commandType !== "CreatePlan" && !UUID.test(envelope.payload.planId || "")) throw appError("VALIDATION_ERROR", "planId должен быть UUID.");
  return envelope;
}

function messageFor(code) {
  return ({
    VALIDATION_ERROR: "Проверьте введённые данные.",
    NOT_AUTHENTICATED: "Войдите в ChatGPT.",
    FORBIDDEN: "Недостаточно прав.",
    PLAN_NOT_FOUND: "План не найден.",
    STEP_NOT_FOUND: "Этап не найден.",
    STEP_ALREADY_EXISTS: "Этап с таким порядком уже существует.",
    REWORK_REQUIRED: "Для повторной работы по завершённому этапу укажите явное разрешение и причину.",
    CHECKPOINTS_INCOMPLETE: "Завершите этапы и обязательные проверки текущих результатов либо укажите причину завершения с исключением.",
    RESULT_REVISION_STALE: "Основание проверки не совпадает с указанной ревизией результата.",
    ACTIVE_ATTEMPT_EXISTS: "У этапа уже есть активная попытка.",
    LEASE_CONFLICT: "Попытка больше не владеет действующей арендой.",
    ATTEMPT_CLOSED: "Попытка уже закрыта.",
    PLAN_PAUSED: "План на паузе. Сначала явно возобновите его.",
    PLAN_COMPLETED: "Завершённый план не принимает новые этапы.",
    FEATURE_UNAVAILABLE: "Tracker-функции для этого плана недоступны.",
    INVALID_TRANSITION: "Команда недоступна в текущем состоянии плана.",
    ACTIVE_PLAN_EXISTS: "У владельца уже выполняется другой план.",
    VERSION_CONFLICT: "План изменился. Обновите данные и повторите команду с новой версией.",
    REPOSITORY_NOT_ATTACHED: "Сначала привяжите репозиторий к плану.",
    REPOSITORY_UNAVAILABLE: "Репозиторий недоступен или не подключён к вашему аккаунту.",
    STEP_NOT_STARTED: "Для этой попытки ещё не записано начало этапа.",
    LEASE_EXPIRED: "Срок аренды попытки истёк. Запросите новую попытку.",
    LEASE_FENCED: "Эта попытка устарела: её номер ограждения больше не действителен.",
    REPOSITORY_ALREADY_ATTACHED: "Этот репозиторий уже привязан к плану.",
    IDEMPOTENCY_KEY_REUSED: "commandId уже использован с другим содержимым.",
    OBSERVATION_CONFLICT: "sourceSequence или eventId уже использованы с другим событием.",
    ATTEMPT_NOT_FOUND: "Попытка не найдена.",
    SESSION_NOT_FOUND: "Сессия источника не зарегистрирована.",
    EVENT_NOT_FOUND: "Исправляемое событие не найдено в этом плане.",
    COMMIT_ALREADY_CONFIRMED: "Коммит уже подтверждён для другого плана.",
    COMMIT_EXCLUDED: "Коммит исключён явным решением владельца.",
    SOURCE_UNAVAILABLE: "Доступ к GitHub не настроен.",
    RATE_LIMITED: "GitHub ограничил частоту запросов.",
    INTERNAL_ERROR: "Внутренняя ошибка. Повторите запрос позже.",
  })[code] || "Команда отклонена.";
}

function resultFromReceipt(row, replayed) {
  const snapshot = parseColumn(row.result_json, {});
  if (row.outcome_code !== "OK" && row.outcome_code !== "PARTIAL") {
    const code = row.outcome_code || "INTERNAL_ERROR";
    if (snapshot && typeof snapshot === "object") {
      snapshot.error = code;
      if (code === "VERSION_CONFLICT" && Number.isSafeInteger(row.result_version) && snapshot.currentVersion === undefined) snapshot.currentVersion = row.result_version;
    }
    const status = ["VERSION_CONFLICT", "ACTIVE_PLAN_EXISTS", "STEP_ALREADY_EXISTS", "ACTIVE_ATTEMPT_EXISTS", "LEASE_CONFLICT", "ATTEMPT_CLOSED", "RESULT_REVISION_STALE", "REPOSITORY_NOT_ATTACHED", "REPOSITORY_UNAVAILABLE", "STEP_NOT_STARTED", "LEASE_EXPIRED", "LEASE_FENCED", "REPOSITORY_ALREADY_ATTACHED", "CHECKPOINTS_INCOMPLETE", "REWORK_REQUIRED", "OBSERVATION_CONFLICT", "IDEMPOTENCY_KEY_REUSED", "COMMIT_EXCLUDED"].includes(code) ? 409 :
      ["PLAN_NOT_FOUND", "STEP_NOT_FOUND", "ATTEMPT_NOT_FOUND", "SESSION_NOT_FOUND", "EVENT_NOT_FOUND", "GITHUB_REPOSITORY_UNAVAILABLE"].includes(code) ? 404 :
          code === "PLAN_PAUSED" || code === "PLAN_COMPLETED" ? 409 :
        code === "GITHUB_AUTH_INVALID" ? 401 : code === "GITHUB_ACCESS_DENIED" ? 403 :
          code === "GITHUB_REQUEST_INVALID" ? 422 : code === "SOURCE_UNAVAILABLE" ? 503 : code === "RATE_LIMITED" ? 429 :
        code === "INTERNAL_ERROR" ? 500 : 422;
    throw appError(code, typeof snapshot.message === "string" ? snapshot.message : messageFor(code), status, snapshot);
  }
  const wasReplayed = replayed || snapshot.replayed === true || snapshot.replayed === 1;
  if (snapshot.replayed !== undefined) snapshot.replayed = snapshot.replayed === true || snapshot.replayed === 1;
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
  const message = String(error && error.message || "");
  if (message.includes("STEP_FENCE_CONFLICT")) return appError("LEASE_CONFLICT", "Токен попытки устарел.", 409);
  if (message.includes("STEP_RESULT_REVISION_CONFLICT")) return appError("RESULT_REVISION_STALE", messageFor("RESULT_REVISION_STALE"), 409);
  if (message.includes("plan_commit_links_one_confirmed_owner_repo_sha") || message.includes("UNIQUE constraint failed: plan_commit_links.owner_id, plan_commit_links.repository_id, plan_commit_links.sha")) {
    return appError("COMMIT_ALREADY_CONFIRMED", "У этого коммита уже есть подтверждённая связь с планом.", 409);
  }
  if (message.includes("WORK_INTERVAL_OVERLAP")) return appError("VALIDATION_ERROR", "Рабочие интервалы не могут пересекаться.");
  if (message.includes("plans.owner_id")) return appError("ACTIVE_PLAN_EXISTS", messageFor("ACTIVE_PLAN_EXISTS"), 409);
  if (message.includes("CHECK constraint failed")) return appError("VALIDATION_ERROR", "Данные нарушают ограничения модели.");
  return error;
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw appError("VALIDATION_ERROR", label + " содержит неизвестное поле.");
}

function assertSafeMetadataText(value, label) {
  if (typeof value !== "string") return;
  const secretLike = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/-]{16,})/i;
  if (secretLike.test(value) || /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/i.test(value)) {
    throw appError("VALIDATION_ERROR", label + " не должен содержать credentials.");
  }
}

function validateObservationPayload(payload) {
  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw appError("VALIDATION_ERROR", "data должен быть объектом metadata.");
  if (canonical(data).length > 4000) throw appError("VALIDATION_ERROR", "Observation metadata ограничены 4000 символами.");
  const schemas = {
    turn_started: { keys: ["turnId"], required: ["turnId"] },
    turn_finished: { keys: ["turnId", "status"], required: ["turnId", "status"] },
    tool_started: { keys: ["operationId", "toolName"], required: ["operationId", "toolName"] },
    tool_finished: { keys: ["operationId", "toolName", "status", "durationMs"], required: ["operationId", "toolName", "status"] },
    heartbeat: { keys: [], required: [] },
    gap: { keys: [], required: [] },
    correction: { keys: ["reason"], required: ["reason"] },
  };
  const schema = schemas[payload.eventType];
  if (!schema) throw appError("VALIDATION_ERROR", "eventType не поддерживается.");
  assertExactKeys(data, new Set(schema.keys), "Observation data");
  for (const key of schema.required) if (!Object.prototype.hasOwnProperty.call(data, key)) throw appError("VALIDATION_ERROR", "Для eventType не хватает поля " + key + ".");
  if (payload.eventType === "turn_started" || payload.eventType === "turn_finished") {
    if (!UUID.test(data.turnId || "")) throw appError("VALIDATION_ERROR", "turnId должен быть UUID.");
    if (payload.eventType === "turn_finished" && !["OK", "FAILED", "CANCELLED"].includes(data.status)) throw appError("VALIDATION_ERROR", "Некорректный статус turn_finished.");
  }
  if (payload.eventType === "tool_started" || payload.eventType === "tool_finished") {
    if (!UUID.test(data.operationId || "") || typeof data.toolName !== "string" || !data.toolName.trim() || data.toolName.length > 80) throw appError("VALIDATION_ERROR", "operationId или toolName некорректны.");
    if (payload.eventType === "tool_finished" && (!(["OK", "FAILED", "CANCELLED"].includes(data.status)) || (data.durationMs !== undefined && (!Number.isSafeInteger(data.durationMs) || data.durationMs < 0 || data.durationMs > 604800000)))) throw appError("VALIDATION_ERROR", "Некорректный результат tool_finished.");
  }
  if (payload.eventType === "correction" && (typeof data.reason !== "string" || !data.reason.trim() || data.reason.trim().length > 1000)) throw appError("VALIDATION_ERROR", "correction требует краткую причину (до 1000 символов).");
  assertSafeMetadataText(canonical(data), "data");
}

function validateTrackerCommand(envelope) {
  if (!envelope || envelope.schemaVersion !== 1) throw appError("VALIDATION_ERROR", "Неподдерживаемая schemaVersion.");
  if (!UUID.test(envelope.commandId || "")) throw appError("VALIDATION_ERROR", "commandId должен быть UUID.");
  if (!TRACKER_COMMANDS.has(envelope.commandType)) throw appError("VALIDATION_ERROR", "Неизвестная tracker-команда.");
  assertExactKeys(envelope, new Set(["schemaVersion", "commandId", "commandType", "expectedVersion", "payloadHash", "payload"]), "Конверт tracker-команды");
  if (envelope.payloadHash !== undefined && !/^[a-f0-9]{64}$/i.test(envelope.payloadHash)) throw appError("VALIDATION_ERROR", "payloadHash должен быть SHA-256.");
  if (!envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) throw appError("VALIDATION_ERROR", "payload должен быть объектом.");

  if (TRACKER_VERSIONED_COMMANDS.has(envelope.commandType) && (!Number.isSafeInteger(envelope.expectedVersion) || envelope.expectedVersion < 1)) {
    throw appError("VALIDATION_ERROR", "expectedVersion должен быть целым числом не меньше 1.");
  }
  if (envelope.commandType === "RenewStepLease" && envelope.expectedVersion !== undefined && (!Number.isSafeInteger(envelope.expectedVersion) || envelope.expectedVersion < 1)) throw appError("VALIDATION_ERROR", "expectedVersion должен быть целым числом не меньше 1.");
  if (!TRACKER_VERSIONED_COMMANDS.has(envelope.commandType) && envelope.commandType !== "RenewStepLease" && envelope.expectedVersion !== undefined) throw appError("VALIDATION_ERROR", "Эта tracker-команда не принимает expectedVersion.");

  if (envelope.commandType === "CreateStep") {
    const payload = envelope.payload;
    assertExactKeys(payload, new Set(["planId", "ordinal", "title", "expectedResult", "requiredChecks"]), "CreateStep payload");
    if (!UUID.test(payload.planId || "")) throw appError("VALIDATION_ERROR", "planId должен быть UUID.");
    if (!Number.isSafeInteger(payload.ordinal) || payload.ordinal < 0) throw appError("VALIDATION_ERROR", "ordinal должен быть целым числом не меньше 0.");
    if (typeof payload.title !== "string" || !payload.title.trim() || payload.title.trim().length > 200) throw appError("VALIDATION_ERROR", "Название этапа обязательно (до 200 символов).");
    if (typeof payload.expectedResult !== "string" || !payload.expectedResult.trim() || payload.expectedResult.length > 4000) throw appError("VALIDATION_ERROR", "Ожидаемый результат обязателен (до 4000 символов).");
    assertSafeMetadataText(payload.title, "title");
    assertSafeMetadataText(payload.expectedResult, "expectedResult");
    if (!Array.isArray(payload.requiredChecks) || payload.requiredChecks.length > 20 || payload.requiredChecks.some((key) => typeof key !== "string" || !key.trim() || key.length > 100) || new Set(payload.requiredChecks.map((key) => key.trim())).size !== payload.requiredChecks.length) {
      throw appError("VALIDATION_ERROR", "requiredChecks должен содержать до 20 уникальных ключей длиной до 100 символов.");
    }
    for (const key of payload.requiredChecks) assertSafeMetadataText(key, "checkKey");
  } else if (envelope.commandType === "UpdateStep") {
    const payload = envelope.payload;
    assertExactKeys(payload, new Set(["stepId", "changes", "reason"]), "UpdateStep payload");
    if (!UUID.test(payload.stepId || "")) throw appError("VALIDATION_ERROR", "stepId должен быть UUID.");
    if (!payload.changes || typeof payload.changes !== "object" || Array.isArray(payload.changes)) throw appError("VALIDATION_ERROR", "changes должен быть объектом.");
    assertExactKeys(payload.changes, new Set(["title", "expectedResult", "requiredChecks"]), "changes");
    if (Object.keys(payload.changes).length === 0) throw appError("VALIDATION_ERROR", "Укажите хотя бы одно изменение checkpoint.");
    if (payload.changes.title !== undefined && (typeof payload.changes.title !== "string" || !payload.changes.title.trim() || payload.changes.title.trim().length > 200)) throw appError("VALIDATION_ERROR", "Название этапа обязательно (до 200 символов).");
    if (payload.changes.expectedResult !== undefined && (typeof payload.changes.expectedResult !== "string" || !payload.changes.expectedResult.trim() || payload.changes.expectedResult.length > 4000)) throw appError("VALIDATION_ERROR", "Ожидаемый результат обязателен (до 4000 символов).");
    assertSafeMetadataText(payload.changes.title, "title");
    assertSafeMetadataText(payload.changes.expectedResult, "expectedResult");
    if (payload.changes.requiredChecks !== undefined && (!Array.isArray(payload.changes.requiredChecks) || payload.changes.requiredChecks.length > 20 || payload.changes.requiredChecks.some((key) => typeof key !== "string" || !key.trim() || key.length > 100) || new Set(payload.changes.requiredChecks.map((key) => key.trim())).size !== payload.changes.requiredChecks.length)) throw appError("VALIDATION_ERROR", "requiredChecks должен содержать до 20 уникальных ключей длиной до 100 символов.");
    if (payload.changes.requiredChecks) for (const key of payload.changes.requiredChecks) assertSafeMetadataText(key, "checkKey");
    if (typeof payload.reason !== "string" || !payload.reason.trim() || payload.reason.trim().length > 1000) throw appError("VALIDATION_ERROR", "Укажите причину изменения checkpoint (до 1000 символов).");
    assertSafeMetadataText(payload.reason, "reason");
  } else if (envelope.commandType === "ClaimStepAttempt") {
    const payload = envelope.payload;
    assertExactKeys(payload, new Set(["stepId", "sessionId", "sourceId", "clientType", "executorLabel", "recoveryReason", "reworkReason"]), "ClaimStepAttempt payload");
    if (!UUID.test(payload.stepId || "") || !UUID.test(payload.sessionId || "")) throw appError("VALIDATION_ERROR", "stepId и sessionId должны быть UUID.");
    if (typeof payload.sourceId !== "string" || !payload.sourceId.trim() || payload.sourceId.length > 128) throw appError("VALIDATION_ERROR", "sourceId обязателен и ограничен 128 символами.");
    if (payload.clientType !== undefined && !["LOCAL", "WEB", "CLOUD", "UNKNOWN"].includes(payload.clientType)) throw appError("VALIDATION_ERROR", "clientType должен быть LOCAL, WEB, CLOUD или UNKNOWN.");
    if (payload.executorLabel !== undefined && (typeof payload.executorLabel !== "string" || payload.executorLabel.length > 128)) throw appError("VALIDATION_ERROR", "executorLabel ограничен 128 символами.");
    assertSafeMetadataText(payload.sourceId, "sourceId");
    assertSafeMetadataText(payload.executorLabel, "executorLabel");
    for (const key of ["recoveryReason", "reworkReason"]) if (payload[key] !== undefined && (typeof payload[key] !== "string" || !payload[key].trim() || payload[key].trim().length > 1000)) throw appError("VALIDATION_ERROR", key + " ограничен 1000 символами.");
    for (const key of ["recoveryReason", "reworkReason"]) assertSafeMetadataText(payload[key], key);
  } else if (["RenewStepLease", "CloseStepAttempt", "StartStep", "BlockStep", "RecordStepResult"].includes(envelope.commandType)) {
    const payload = envelope.payload;
    const fields = {
      RenewStepLease: ["stepId", "attemptId", "fence"],
      CloseStepAttempt: ["stepId", "attemptId", "fence", "disposition", "reason"],
      StartStep: ["stepId", "attemptId", "fence", "rework", "reason"],
      BlockStep: ["stepId", "attemptId", "fence", "reason"],
      RecordStepResult: ["stepId", "attemptId", "fence", "outcome", "summary", "repositoryId", "revisionSha", "worktreeSnapshot", "sourceSnapshot"],
    }[envelope.commandType];
    assertExactKeys(payload, new Set(fields), envelope.commandType + " payload");
    if (!UUID.test(payload.stepId || "") || !UUID.test(payload.attemptId || "")) throw appError("VALIDATION_ERROR", "stepId и attemptId должны быть UUID.");
    if (!Number.isSafeInteger(payload.fence) || payload.fence < 1) throw appError("VALIDATION_ERROR", "fence должен быть целым числом не меньше 1.");
    if (envelope.commandType === "CloseStepAttempt") {
      if (!["CLOSED", "ABANDONED"].includes(payload.disposition)) throw appError("VALIDATION_ERROR", "disposition должен быть CLOSED или ABANDONED.");
      if (typeof payload.reason !== "string" || !payload.reason.trim() || payload.reason.trim().length > 1000) throw appError("VALIDATION_ERROR", "Укажите причину закрытия попытки (до 1000 символов).");
      assertSafeMetadataText(payload.reason, "reason");
    } else if (envelope.commandType === "StartStep") {
      if (payload.rework !== undefined && typeof payload.rework !== "boolean") throw appError("VALIDATION_ERROR", "rework должен быть boolean.");
      if (payload.reason !== undefined && (typeof payload.reason !== "string" || payload.reason.length > 1000)) throw appError("VALIDATION_ERROR", "reason ограничен 1000 символами.");
      if (payload.rework === true && (!payload.reason || !payload.reason.trim())) throw appError("VALIDATION_ERROR", "Повторная работа требует причины.");
      assertSafeMetadataText(payload.reason, "reason");
    } else if (envelope.commandType === "BlockStep") {
      if (typeof payload.reason !== "string" || !payload.reason.trim() || payload.reason.trim().length > 1000) throw appError("VALIDATION_ERROR", "Укажите причину блокировки (до 1000 символов).");
      assertSafeMetadataText(payload.reason, "reason");
    } else if (envelope.commandType === "RecordStepResult") {
      if (!["DONE", "FAILED"].includes(payload.outcome)) throw appError("VALIDATION_ERROR", "outcome должен быть DONE или FAILED.");
      if (typeof payload.summary !== "string" || !payload.summary.trim() || payload.summary.length > 4000) throw appError("VALIDATION_ERROR", "Краткий результат обязателен (до 4000 символов).");
      assertSafeMetadataText(payload.summary, "summary");
      if (payload.sourceSnapshot !== undefined) {
        const source = payload.sourceSnapshot;
        if (!source || typeof source !== "object" || Array.isArray(source)) throw appError("VALIDATION_ERROR", "sourceSnapshot должен быть объектом.");
        assertExactKeys(source, new Set(["kind", "digest", "formatVersion"]), "sourceSnapshot");
        if(source.kind!=="SOURCE_SNAPSHOT" || source.formatVersion!==2 || !isSnapshotDigest(source.digest)) throw appError("VALIDATION_ERROR","Укажите SOURCE_SNAPSHOT v2 с digest sha256.");
        if(payload.worktreeSnapshot!==undefined || payload.repositoryId!==undefined || payload.revisionSha!==undefined) throw appError("VALIDATION_ERROR","Нельзя смешивать основания результата.");
      }
      if (payload.worktreeSnapshot !== undefined) {
        const snapshot = payload.worktreeSnapshot;
        if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw appError("VALIDATION_ERROR", "worktreeSnapshot должен быть объектом.");
        assertExactKeys(snapshot, new Set(["kind", "repositoryId", "digest", "formatVersion", "baseRevisionSha"]), "worktreeSnapshot");
        if (snapshot.kind !== "WORKTREE_SNAPSHOT" || snapshot.formatVersion !== 1 || !isSnapshotDigest(snapshot.digest)) throw appError("VALIDATION_ERROR", "Укажите WORKTREE_SNAPSHOT v1 с digest sha256 (64 hex символа).");
        if (typeof snapshot.repositoryId !== "string" || !snapshot.repositoryId.trim() || snapshot.repositoryId.length > 40) throw appError("VALIDATION_ERROR", "Для снимка нужен repositoryId (до 40 символов).");
        if (snapshot.baseRevisionSha !== undefined && (typeof snapshot.baseRevisionSha !== "string" || snapshot.baseRevisionSha.length !== 40 || !SHA.test(snapshot.baseRevisionSha))) throw appError("VALIDATION_ERROR", "baseRevisionSha должен быть полным SHA-1; это контекст, не основание проверки.");
        if (payload.repositoryId !== undefined || payload.revisionSha !== undefined) throw appError("VALIDATION_ERROR", "Снимок рабочего дерева и commit SHA — взаимоисключающие основания результата.");
      }
      if ((payload.repositoryId == null) !== (payload.revisionSha == null)) throw appError("VALIDATION_ERROR", "repositoryId и revisionSha нужно передать вместе.");
      if (payload.repositoryId !== undefined && (typeof payload.repositoryId !== "string" || !payload.repositoryId.trim() || payload.repositoryId.length > 40)) throw appError("VALIDATION_ERROR", "repositoryId ограничен 40 символами.");
      if (payload.revisionSha !== undefined && (typeof payload.revisionSha !== "string" || payload.revisionSha.length !== 40 || !SHA.test(payload.revisionSha))) throw appError("VALIDATION_ERROR", "revisionSha должен быть полным SHA-1.");
    }
  } else if (envelope.commandType === "RecordCheck") {
    const payload = envelope.payload;
      assertExactKeys(payload, new Set(["stepId", "resultRevision", "checkKey", "status", "testedSha", "testedSnapshotDigest", "exitCode", "evidenceSummary", "evidenceUrl"]), "RecordCheck payload");
      if (!UUID.test(payload.stepId || "") || !Number.isSafeInteger(payload.resultRevision) || payload.resultRevision < 1) throw appError("VALIDATION_ERROR", "stepId или resultRevision некорректны.");
      if (typeof payload.checkKey !== "string" || !payload.checkKey.trim() || payload.checkKey.trim().length > 100) throw appError("VALIDATION_ERROR", "checkKey обязателен и ограничен 100 символами.");
      if (!["PASSED", "FAILED", "NOT_RUN"].includes(payload.status)) throw appError("VALIDATION_ERROR", "Укажите статус проверки.");
      if ((payload.testedSha !== undefined) === (payload.testedSnapshotDigest !== undefined)) throw appError("VALIDATION_ERROR", "Укажите ровно одно основание: testedSha или testedSnapshotDigest.");
      if (payload.testedSha !== undefined && (typeof payload.testedSha !== "string" || payload.testedSha.length !== 40 || !SHA.test(payload.testedSha))) throw appError("VALIDATION_ERROR", "testedSha должен быть полным SHA-1.");
      if (payload.testedSnapshotDigest !== undefined && !isSnapshotDigest(payload.testedSnapshotDigest)) throw appError("VALIDATION_ERROR", "testedSnapshotDigest должен иметь формат sha256:64hex.");
      if (payload.status === "PASSED" && payload.exitCode !== 0) throw appError("VALIDATION_ERROR", "PASSED требует exitCode=0.");
      if (payload.status === "FAILED" && (!Number.isSafeInteger(payload.exitCode) || payload.exitCode < 1 || payload.exitCode > 255)) throw appError("VALIDATION_ERROR", "FAILED требует exitCode от 1 до 255.");
      if (payload.status === "NOT_RUN" && payload.exitCode !== undefined && payload.exitCode !== null) throw appError("VALIDATION_ERROR", "NOT_RUN не принимает exitCode.");
      if (payload.evidenceSummary !== undefined && (typeof payload.evidenceSummary !== "string" || payload.evidenceSummary.length > 2000)) throw appError("VALIDATION_ERROR", "evidenceSummary ограничен 2000 символами.");
      if (payload.evidenceUrl !== undefined && (typeof payload.evidenceUrl !== "string" || payload.evidenceUrl.length > 2048 || !payload.evidenceUrl.startsWith("https://"))) throw appError("VALIDATION_ERROR", "evidenceUrl должен быть HTTPS URL не длиннее 2048 символов.");
      assertSafeMetadataText(payload.checkKey, "checkKey");
      assertSafeMetadataText(payload.evidenceSummary, "evidenceSummary");
      if (payload.evidenceUrl !== undefined) {
        let url;
        try { url = new URL(payload.evidenceUrl); } catch { throw appError("VALIDATION_ERROR", "evidenceUrl должен быть корректным HTTPS URL."); }
        if (url.protocol !== "https:" || !url.hostname || url.username || url.password || Array.from(url.searchParams.keys()).some((key) => /token|secret|password|authorization|api[_-]?key/i.test(key))) throw appError("VALIDATION_ERROR", "evidenceUrl не должен содержать credentials.");
      }
  } else if (envelope.commandType === "AppendObservation") {
    const payload = envelope.payload;
    assertExactKeys(payload, new Set(["eventId", "planId", "stepId", "attemptId", "sourceId", "sessionId", "sourceSequence", "occurredAt", "eventType", "data", "correctionOfEventId"]), "AppendObservation payload");
    if (!UUID.test(payload.eventId || "") || !UUID.test(payload.planId || "") || !UUID.test(payload.sessionId || "")) throw appError("VALIDATION_ERROR", "eventId, planId и sessionId должны быть UUID.");
    if (payload.stepId !== undefined && !UUID.test(payload.stepId || "")) throw appError("VALIDATION_ERROR", "stepId должен быть UUID.");
    if (payload.attemptId !== undefined && (!UUID.test(payload.attemptId || "") || !payload.stepId)) throw appError("VALIDATION_ERROR", "attemptId требует UUID stepId.");
    if (typeof payload.sourceId !== "string" || !payload.sourceId.trim() || payload.sourceId.length > 128) throw appError("VALIDATION_ERROR", "sourceId обязателен и ограничен 128 символами.");
    if (!Number.isSafeInteger(payload.sourceSequence) || payload.sourceSequence < 1) throw appError("VALIDATION_ERROR", "sourceSequence должен быть положительным целым числом.");
    if (!Number.isSafeInteger(payload.occurredAt) || payload.occurredAt < 0) throw appError("VALIDATION_ERROR", "occurredAt должен быть UTC timestamp в миллисекундах.");
    if (!OBSERVATION_TYPES.has(payload.eventType)) throw appError("VALIDATION_ERROR", "eventType не поддерживается.");
    if (payload.correctionOfEventId !== undefined && !UUID.test(payload.correctionOfEventId || "")) throw appError("VALIDATION_ERROR", "correctionOfEventId должен быть UUID.");
    if ((payload.eventType === "correction") !== (payload.correctionOfEventId !== undefined)) throw appError("VALIDATION_ERROR", "correctionOfEventId обязателен только для correction.");
    assertSafeMetadataText(payload.sourceId, "sourceId");
    validateObservationPayload(payload);
  }
  return envelope;
}

async function executeTrackerCommand(db, identity, envelope, channel, nowMs) {
  validateTrackerCommand(envelope);
  const hash = await payloadHash(envelope);
  let receipt = await dbFirst(db, "SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?", identity.ownerId, envelope.commandId);
  const matchesReceipt = receipt && await receiptMatchesCommand(receipt, envelope, hash);
  if (envelope.payloadHash && envelope.payloadHash !== hash && !(matchesReceipt && envelope.payloadHash === receipt.payload_hash)) throw appError("VALIDATION_ERROR", "payloadHash не совпадает с конвертом.");
  if (receipt) {
    if (!matchesReceipt) throw appError("IDEMPOTENCY_KEY_REUSED", messageFor("IDEMPOTENCY_KEY_REUSED"), 409);
    return resultFromReceipt(receipt, true);
  }

  const input = envelope.payload;
  if (envelope.commandType === "ClaimStepAttempt" && input.reworkReason && channel !== "ui") {
    throw appError("FORBIDDEN", "Повторную работу по завершённому этапу должен явно назначить владелец через интерфейс.", 403);
  }
  let planId = input.planId || null;
  if (!planId && input.stepId) {
    const step = await dbFirst(db, "SELECT plan_id FROM plan_steps WHERE owner_id=? AND step_id=?", identity.ownerId, input.stepId);
    planId = step ? step.plan_id : null;
  }
  let payload = { ...input };
  const addEvent = async (event, eventId = crypto.randomUUID()) => ({
    eventId: eventId,
    eventPayloadJson: canonical(event),
    eventPayloadHash: await hashCommandInput(event),
  });

  if (envelope.commandType === "CreateStep") {
    payload.commitPolicy = "NEVER";
    payload.pushPolicy = "NEVER";
    const stepId = crypto.randomUUID();
    Object.assign(payload, {
      title: input.title.trim(),
      expectedResult: input.expectedResult.trim(),
      requiredChecksJson: JSON.stringify(input.requiredChecks.map((key) => key.trim())),
      stepId: stepId,
      ...await addEvent({ planId: input.planId, stepId: stepId, ordinal: input.ordinal }),
    });
  } else if (envelope.commandType === "UpdateStep") {
    const changes = { ...input.changes };
    if (changes.title !== undefined) changes.title = changes.title.trim();
    if (changes.expectedResult !== undefined) changes.expectedResult = changes.expectedResult.trim();
    if (changes.requiredChecks !== undefined) changes.requiredChecksJson = JSON.stringify(changes.requiredChecks.map((key) => key.trim()));
    Object.assign(payload, { changes, ...await addEvent({
      stepId: input.stepId,
      changedFields: Object.keys(input.changes).sort(),
      reason: input.reason.trim(),
    }) });
  } else if (envelope.commandType === "ClaimStepAttempt") {
    const step = await dbFirst(db, "SELECT current_fence FROM plan_steps WHERE owner_id=? AND step_id=?", identity.ownerId, input.stepId);
    const candidateFence = (step ? step.current_fence : 0) + 1;
    const attemptId = crypto.randomUUID();
    Object.assign(payload, {
      clientType: input.clientType || "UNKNOWN",
      executorLabel: input.executorLabel == null ? null : input.executorLabel,
      candidateFence: candidateFence,
      attemptId: attemptId,
      ...await addEvent({ stepId: input.stepId, attemptId: attemptId, fence: candidateFence, sessionId: input.sessionId }),
    });
    Object.assign(payload, await addEvent({ stepId: input.stepId, classification: "STALE_EXECUTOR", reason: input.recoveryReason || "lease_expired" }, crypto.randomUUID()).then((event) => ({
      recoveryEventId: event.eventId,
      recoveryEventPayloadJson: event.eventPayloadJson,
      recoveryEventPayloadHash: event.eventPayloadHash,
    })));
  } else if (envelope.commandType === "RenewStepLease") {
    Object.assign(payload, {
      ...input,
      leaseUntil: nowMs + TRACKER_LEASE_MS,
      ...await addEvent({ stepId: input.stepId, attemptId: input.attemptId, fence: input.fence, leaseUntil: nowMs + TRACKER_LEASE_MS }),
    });
  } else if (envelope.commandType === "CloseStepAttempt") {
    Object.assign(payload, await addEvent({
      stepId: input.stepId,
      attemptId: input.attemptId,
      disposition: input.disposition,
      reason: input.reason.trim(),
    }));
  } else if (envelope.commandType === "StartStep") {
    Object.assign(payload, await addEvent({
      stepId: input.stepId,
      attemptId: input.attemptId,
      fence: input.fence,
      rework: input.rework === true,
      reason: input.reason || "",
    }));
  } else if (envelope.commandType === "BlockStep") {
    Object.assign(payload, await addEvent({ stepId: input.stepId, attemptId: input.attemptId, fence: input.fence, reason: input.reason.trim() }));
  } else if (envelope.commandType === "RecordStepResult") {
    const resultId = crypto.randomUUID();
    const event = {
      stepId: input.stepId,
      attemptId: input.attemptId,
      outcome: input.outcome,
      summary: input.summary.trim(),
      repositoryId: input.repositoryId || null,
      revisionSha: input.revisionSha ? input.revisionSha.toLowerCase() : null,
      ...(input.sourceSnapshot ? {sourceSnapshot:input.sourceSnapshot} : {}),
      ...(input.worktreeSnapshot ? { worktreeSnapshot: { ...input.worktreeSnapshot, ...(input.worktreeSnapshot.baseRevisionSha ? { baseRevisionSha: input.worktreeSnapshot.baseRevisionSha.toLowerCase() } : {}) } } : {}),
    };
    const eventData = await addEvent(event);
    Object.assign(payload, {
      summary: input.summary.trim(),
      revisionSha: input.revisionSha ? input.revisionSha.toLowerCase() : null,
      repositoryId: input.repositoryId || null,
      ...(event.worktreeSnapshot ? { worktreeSnapshot: event.worktreeSnapshot } : {}),
      resultId: resultId,
      resultPayloadHash: eventData.eventPayloadHash,
      ...eventData,
    });
  } else if (envelope.commandType === "RecordCheck") {
    const checkId = crypto.randomUUID();
    const eventData = await addEvent({
      stepId: input.stepId, resultRevision: input.resultRevision, checkKey: input.checkKey.trim(),
      status: input.status, testedSha: input.testedSha ? input.testedSha.toLowerCase() : null,
      ...(input.testedSnapshotDigest ? { testedSnapshotDigest: input.testedSnapshotDigest } : {}), exitCode: input.exitCode ?? null,
      evidenceSummary: input.evidenceSummary ? input.evidenceSummary.trim() : null,
      evidenceUrl: input.evidenceUrl ? input.evidenceUrl.trim() : null,
    });
    Object.assign(payload, {
      checkId: checkId, checkKey: input.checkKey.trim(), testedSha: input.testedSha ? input.testedSha.toLowerCase() : null,
      exitCode: input.exitCode ?? null, evidenceSummary: input.evidenceSummary ? input.evidenceSummary.trim() : null,
      evidenceUrl: input.evidenceUrl ? input.evidenceUrl.trim() : null, ...eventData,
    });
  } else if (envelope.commandType === "AppendObservation") {
    const event = {
      eventId: input.eventId, planId: input.planId, stepId: input.stepId || null, attemptId: input.attemptId || null,
      sourceId: input.sourceId.trim(), sessionId: input.sessionId, sourceSequence: input.sourceSequence,
      occurredAt: input.occurredAt, eventType: input.eventType, data: input.data,
      correctionOfEventId: input.correctionOfEventId || null,
    };
    Object.assign(payload, {
      ...event,
      ...await addEvent(event, input.eventId),
    });
  }
  const actorType = channel === "mcp" ? "agent" : "user";
  let receiptInserted = false;
  try {
    const write = await db.prepare("INSERT OR IGNORE INTO command_receipts (owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING',?)")
      .bind(identity.ownerId, envelope.commandId, hash, envelope.commandType, planId, envelope.expectedVersion == null ? null : envelope.expectedVersion, nowMs,
        identity.ownerId, actorType, JSON.stringify(payload), nowMs).run();
    receiptInserted = Number(write.meta?.changes) > 0;
  } catch (error) { throw mapDbError(error); }
  receipt = await dbFirst(db, "SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?", identity.ownerId, envelope.commandId);
  if (!receipt) throw appError("INTERNAL_ERROR", "Не удалось сохранить результат tracker-команды.", 500);
  if (!await receiptMatchesCommand(receipt, envelope, hash)) throw appError("IDEMPOTENCY_KEY_REUSED", messageFor("IDEMPOTENCY_KEY_REUSED"), 409);
  return resultFromReceipt(receipt, !receiptInserted);
}

export async function executeCommand(db, identity, envelope, channel, nowMs) {
  if (envelope && TRACKER_COMMANDS.has(envelope.commandType)) return executeTrackerCommand(db, identity, envelope, channel, nowMs);
  validateEnvelope(envelope);
  const hash = await payloadHash(envelope);
  let receipt = await dbFirst(db, "SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?", identity.ownerId, envelope.commandId);
  const matchesReceipt = receipt && await receiptMatchesCommand(receipt, envelope, hash);
  if (envelope.payloadHash && envelope.payloadHash !== hash && !(matchesReceipt && envelope.payloadHash === receipt.payload_hash)) throw appError("VALIDATION_ERROR", "payloadHash не совпадает с конвертом.");
  if (receipt) {
    if (!matchesReceipt) throw appError("IDEMPOTENCY_KEY_REUSED", messageFor("IDEMPOTENCY_KEY_REUSED"), 409);
    return resultFromReceipt(receipt, true);
  }

  const payload = { ...envelope.payload };
  let planId = payload.planId || null;
  if (envelope.commandType === "CreatePlan") {
    if (typeof payload.title !== "string" || !payload.title.trim() || payload.title.trim().length > 200) throw appError("VALIDATION_ERROR", "Название плана обязательно (до 200 символов).");
    payload.title = payload.title.trim();
    payload.description = typeof payload.description === "string" ? payload.description.slice(0, 20000) : "";
    payload.acceptanceCriteria = typeof payload.acceptanceCriteria === "string" ? payload.acceptanceCriteria.slice(0, 20000) : "";
    payload.planCreatedAt = parsePlanCreatedAt(payload.planCreatedAt);
    const sourceReference = envelope.sourceReference === undefined ? payload.sourceReference : envelope.sourceReference;
    if (sourceReference !== undefined && (typeof sourceReference !== "string" || sourceReference.length > 2048)) {
      throw appError("VALIDATION_ERROR", "sourceReference должен быть строкой не длиннее 2048 символов.");
    }
    if (sourceReference !== undefined) payload.sourceReference = sourceReference;
    planId = payload.planId || crypto.randomUUID();
    if (!UUID.test(planId)) throw appError("VALIDATION_ERROR", "planId должен быть UUID.");
    payload.planId = planId;
  } else {
    if (typeof payload.reason === "string") payload.reason = payload.reason.slice(0, 1000);
    if (envelope.commandType === "UpdatePlanMetadata") {
      const fields = ["title", "description", "acceptanceCriteria", "planCreatedAt"];
      if (!fields.some((field) => Object.prototype.hasOwnProperty.call(payload, field) && payload[field] !== undefined)) {
        throw appError("VALIDATION_ERROR", "Укажите хотя бы одно изменяемое поле плана.");
      }
      if (payload.title !== undefined && (typeof payload.title !== "string" || !payload.title.trim() || payload.title.trim().length > 200)) throw appError("VALIDATION_ERROR", "Название плана обязательно (до 200 символов).");
      if (payload.planCreatedAt !== undefined) payload.planCreatedAt = parsePlanCreatedAt(payload.planCreatedAt);
      if (payload.planCreatedAt !== undefined) {
        if (typeof payload.reason !== "string" || !payload.reason.trim()) throw appError("VALIDATION_ERROR", "Изменение даты составления требует причины.");
        const current = await dbFirst(db, "SELECT first_started_at FROM plans WHERE owner_id=? AND plan_id=?", identity.ownerId, payload.planId);
        payload.dateAfterStart = planDateAfterStart(payload.planCreatedAt, current && current.first_started_at);
      }
      for (const key of ["description", "acceptanceCriteria"]) if (payload[key] !== undefined && payload[key] !== null && typeof payload[key] !== "string") throw appError("VALIDATION_ERROR", "Метаданные должны быть строками.");
    }
    if (envelope.commandType === "FinishPlan") {
      if (payload.allowIncomplete !== undefined && typeof payload.allowIncomplete !== "boolean") throw appError("VALIDATION_ERROR", "allowIncomplete должен быть boolean.");
      if (payload.reason !== undefined && (typeof payload.reason !== "string" || payload.reason.trim().length > 1000)) throw appError("VALIDATION_ERROR", "reason ограничен 1000 символами.");
      if (payload.allowIncomplete === true && (!payload.reason || !payload.reason.trim())) throw appError("VALIDATION_ERROR", "Для завершения с незакрытыми checkpoints требуется причина.");
      if (payload.reason !== undefined) payload.reason = payload.reason.trim();
      assertSafeMetadataText(payload.reason, "reason");
      const eventPayload = { planId: payload.planId, allowIncomplete: payload.allowIncomplete === true, reason: payload.reason || "" };
      payload.finishEventId = crypto.randomUUID();
      payload.finishEventPayloadJson = canonical(eventPayload);
      payload.finishEventPayloadHash = await hashCommandInput(eventPayload);
    }

  }

  const actorType = channel === "mcp" ? "agent" : "user";
  let receiptInserted = false;
  try {
    const write = await db.prepare("INSERT OR IGNORE INTO command_receipts (owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING',?)")
      .bind(identity.ownerId, envelope.commandId, hash, envelope.commandType, planId, envelope.expectedVersion == null ? null : envelope.expectedVersion,
        nowMs, identity.ownerId, actorType, JSON.stringify(payload), nowMs).run();
    receiptInserted = Number(write.meta?.changes) > 0;
  } catch (error) { throw mapDbError(error); }
  receipt = await dbFirst(db, "SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?", identity.ownerId, envelope.commandId);
  if (!receipt) throw appError("INTERNAL_ERROR", "Не удалось сохранить результат команды.", 500);
  if (!await receiptMatchesCommand(receipt, envelope, hash)) throw appError("IDEMPOTENCY_KEY_REUSED", messageFor("IDEMPOTENCY_KEY_REUSED"), 409);
  return resultFromReceipt(receipt, !receiptInserted);
}

async function listPlans(db, ownerId, nowMs) {
  const rows = await dbAll(db, "SELECT * FROM plans WHERE owner_id=? ORDER BY registered_at DESC", ownerId);
  return Promise.all(rows.map((row) => planSummary(db, ownerId, row, nowMs)));
}

async function planSummary(db, ownerId, row, nowMs) {
  const intervals = await dbAll(db, "SELECT interval_id,start_ms,end_ms,opened_by,closed_by FROM work_intervals WHERE owner_id=? AND plan_id=? ORDER BY start_ms", ownerId, row.plan_id);
  const activeMs = row.first_started_at == null ? null : intervals.reduce((sum, interval) =>
    sum + Math.max(0, (interval.end_ms == null ? nowMs : interval.end_ms) - interval.start_ms), 0);
  const end = row.finished_at == null ? nowMs : row.finished_at;
  const calendarMs = row.first_started_at == null ? null : Math.max(0, end - row.first_started_at);
  const completion = await dbFirst(db, "SELECT (SELECT COUNT(*) FROM tracker_incomplete_steps WHERE owner_id=? AND plan_id=?) AS incompleteStepCount,(SELECT COUNT(*) FROM tracker_plan_config WHERE owner_id=? AND plan_id=? AND enabled=1) AS enabled", ownerId, row.plan_id, ownerId, row.plan_id);
  return {
    completion: { readyToFinish: !completion.enabled || completion.incompleteStepCount === 0, incompleteStepCount: completion.incompleteStepCount, trackerEnabled: Boolean(completion.enabled) },
    planId: row.plan_id, title: row.title, description: row.description, acceptanceCriteria: row.acceptance_criteria,
    planCreatedAt: row.plan_created_precision === "instant"
      ? { precision: "instant", value: new Date(row.plan_created_at_ms).toISOString(), timeZone: row.plan_created_timezone }
      : { precision: "dateOnly", on: row.plan_created_on, timeZone: row.plan_created_timezone },
    registeredAt: row.registered_at, status: row.status, firstStartedAt: row.first_started_at,
    finishedAt: row.finished_at, version: row.version, createdBy: row.created_by, sourceReference: row.source_reference,
    intervals: intervals, activeMs: activeMs, calendarMs: calendarMs,
    pausedMs: calendarMs == null ? null : Math.max(0, calendarMs - activeMs), serverNow: nowMs,
  };
}

async function readPlan(db, ownerId, planId, nowMs) {
  const row = await dbFirst(db, "SELECT * FROM plans WHERE owner_id=? AND plan_id=?", ownerId, planId);
  if (!row) throw appError("PLAN_NOT_FOUND", "План не найден.", 404);
  const plan = await planSummary(db, ownerId, row, nowMs);
  plan.events = await dbAll(db, "SELECT event_id,command_id,actor_id,actor_type,event_type,server_occurred_at,version_before,version_after,reason FROM plan_events WHERE owner_id=? AND plan_id=? ORDER BY server_occurred_at,event_id", ownerId, planId);
  plan.dateHistory = await dbAll(db, "SELECT old_precision,old_at_ms,old_on,old_timezone,changed_at,changed_by,reason FROM plan_date_history WHERE owner_id=? AND plan_id=? ORDER BY changed_at", ownerId, planId);
  return plan;
}

async function readTrackerCapabilities(db, ownerId) {
  const row = await dbFirst(db, "SELECT COUNT(*) AS enabled_plan_count FROM tracker_plan_config WHERE owner_id=? AND enabled=1", ownerId);
  const ownerScope = await hashCommandInput({ purpose: "plan-time-tracker-local-observation-queue-v1", ownerId: ownerId });
  return {
    available: true, schemaVersion: 1, enabledPlanCount: row.enabled_plan_count,
    planOptIn: "first CreateStep", leaseMs: TRACKER_LEASE_MS, recommendedRenewAfterMs: 180000,
    maxRequiredChecks: 20, maxCheckKeyLength: 100, maxSummaryLength: 4000,
    resultSourceKinds: ["SOURCE_SNAPSHOT", "NONE"], sourceSnapshot: { formatVersion: 2, digest: "sha256:64 lowercase hex", attestation: "source contents; checks bind to the current result revision" },
    maxObservationPayloadLength: 4000, maxTimelinePageSize: 100,
    localObservationQueue: {
      ownerScope: ownerScope, maxEvents: 1000, maxBytes: 5 * 1024 * 1024, retentionMs: 7 * 24 * 60 * 60 * 1000,
      maxSendAttempts: 5, backoffCapMs: 30000, durable: "local-only", cloudDurability: "ephemeral-session",
    },
    observationClassifications: ["NORMAL", "LATE", "GAP", "STALE_EXECUTOR", "CORRECTION"],
  };
}

async function readPlanExecutionSnapshot(db, ownerId, planId, nowMs) {
  if (!UUID.test(planId || "")) throw appError("VALIDATION_ERROR", "planId должен быть UUID.");
  const planRow = await dbFirst(db, "SELECT * FROM plans WHERE owner_id=? AND plan_id=?", ownerId, planId);
  if (!planRow) throw appError("PLAN_NOT_FOUND", messageFor("PLAN_NOT_FOUND"), 404);
  const plan = await planSummary(db, ownerId, planRow, nowMs);
  const allowedRepositories = new Set((await dbAll(db, "SELECT repository_id FROM repositories WHERE owner_id=? AND (is_private=0 OR access_state='available')", ownerId)).map((row) => row.repository_id));
  const steps = await dbAll(db, "SELECT owner_id,plan_id,step_id,ordinal,title,expected_result,required_checks_json,status,version,current_result_revision,current_fence,created_at,updated_at FROM plan_steps WHERE owner_id=? AND plan_id=? ORDER BY ordinal,step_id", ownerId, planId);
  const incomplete = new Set((await dbAll(db, "SELECT step_id FROM tracker_incomplete_steps WHERE owner_id=? AND plan_id=?", ownerId, planId)).map((row) => row.step_id));
  for (const step of steps) {
    const results = await dbAll(db, "SELECT result_id,attempt_id,revision,outcome,summary,source_repository_id AS repository_id,revision_sha,source_kind,snapshot_digest,snapshot_format_version,base_revision_sha,created_at FROM tracker_result_sources WHERE owner_id=? AND step_id=? ORDER BY revision DESC LIMIT 10", ownerId, step.step_id);
    for (const result of results) {
      if (result.repository_id && !allowedRepositories.has(result.repository_id)) {
        result.repository_id = null;
        result.revision_sha = null;
        result.snapshot_digest = null;
        result.base_revision_sha = null;
        result.protectedRevisionHidden = true;
      }
    }
    const attempts = await dbAll(db, "SELECT a.attempt_id,a.session_id,a.status,a.fence,a.lease_until,a.rework_reason,a.started_at,a.closed_at,EXISTS(SELECT 1 FROM tracker_journal j WHERE j.owner_id=a.owner_id AND j.step_id=a.step_id AND j.attempt_id=a.attempt_id AND j.event_type='STEP_STARTED') AS step_started FROM step_attempts a WHERE a.owner_id=? AND a.step_id=? ORDER BY a.fence DESC LIMIT 50", ownerId, step.step_id);
    for (const attempt of attempts) { attempt.stepStarted = Boolean(attempt.step_started); delete attempt.step_started; }
    const checks = await dbAll(db, "SELECT *,CASE WHEN result_revision=? THEN matches_result ELSE 0 END AS matches_current_result FROM tracker_checks_with_source WHERE owner_id=? AND step_id=? ORDER BY server_sequence DESC LIMIT 100", step.current_result_revision, ownerId, step.step_id);
    // Latest required checks are independent of bounded history and client-visible redaction.
    const currentChecks = await dbAll(db, "SELECT *,matches_result AS matches_current_result FROM tracker_latest_checks WHERE owner_id=? AND step_id=? AND result_revision=? ORDER BY server_sequence DESC", ownerId, step.step_id, step.current_result_revision);
    for (const check of [...checks, ...currentChecks]) {
      check.matchesCurrentResult = Boolean(check.matches_current_result);
      delete check.matches_current_result;
      delete check.matches_result;
      delete check.owner_id;
      if (check.result_repository_id && !allowedRepositories.has(check.result_repository_id)) {
        check.tested_sha = null;
        check.tested_snapshot_digest = null;
        check.evidence_url = null;
        check.protectedEvidenceHidden = true;
      }
      delete check.result_repository_id;
    }
    step.requiredChecks = parseColumn(step.required_checks_json, []);
    delete step.required_checks_json;
    step.currentResult = results.find((result) => result.revision === step.current_result_revision) || null;
    step.resultHistory = results;
    step.attempts = attempts;
    const currentAttempt = attempts.find(attempt => attempt.fence === step.current_fence);
    const liveAttempt = currentAttempt?.status === "OPEN" && currentAttempt.lease_until > nowMs;
    const attemptState = currentAttempt?.status === "OPEN"
      ? (liveAttempt ? (currentAttempt.stepStarted ? "RUNNING" : "AWAITING_START") : "LEASE_EXPIRED")
      : step.status === "RUNNING" ? (currentAttempt ? "ATTEMPT_CLOSED" : "ATTEMPT_MISSING") : "IDLE";
    step.execution = {
      state: attemptState, planStatus: plan.status, serverNow: nowMs,
      attemptId: currentAttempt?.attempt_id || null, fence: step.current_fence,
      leaseUntil: currentAttempt?.lease_until || null,
      canClaim: plan.status === "RUNNING" && !liveAttempt && step.status !== "DONE",
      requiresOwnerRework: step.status === "DONE",
      canStart: plan.status === "RUNNING" && liveAttempt && !currentAttempt.stepStarted,
      canRenew: plan.status === "RUNNING" && Boolean(liveAttempt),
      canRecordResult: plan.status === "RUNNING" && step.status === "RUNNING" && liveAttempt && currentAttempt.stepStarted,
    };
    step.checks = checks;
    step.currentChecks = currentChecks;
    step.readyToFinish = !incomplete.has(step.step_id);
    step.readinessBlockers = [];
    if (step.status !== "DONE") step.readinessBlockers.push({ code: "STEP_NOT_DONE" });
    if (!step.currentResult || step.currentResult.outcome !== "DONE") step.readinessBlockers.push({ code: "RESULT_NOT_DONE" });
    if (step.attempts.some(attempt => attempt.status === "OPEN")) step.readinessBlockers.push({ code: "OPEN_ATTEMPT" });
    if (step.requiredChecks.length && step.currentResult?.source_kind === "NONE") step.readinessBlockers.push({ code: "RESULT_SOURCE_MISSING" });
    for (const key of step.requiredChecks) {
      const check = currentChecks.find(check => check.check_key === key);
      if (!check || check.status !== "PASSED" || !check.matchesCurrentResult) step.readinessBlockers.push({ code: "CHECK_NOT_PASSED", checkKey: key, status: check?.status || "MISSING" });
    }
  }
  const blockedEvents = await dbFirst(db, "SELECT COUNT(*) AS count FROM tracker_journal WHERE owner_id=? AND plan_id=? AND event_type='STEP_BLOCKED'", ownerId, planId);
  const retries = await dbFirst(db, "SELECT COUNT(*) AS count FROM step_attempts a JOIN plan_steps s ON s.owner_id=a.owner_id AND s.step_id=a.step_id WHERE a.owner_id=? AND s.plan_id=? AND a.fence>1", ownerId, planId);
  const failedResults = await dbFirst(db, "SELECT COUNT(*) AS count FROM step_results r JOIN plan_steps s ON s.owner_id=r.owner_id AND s.step_id=r.step_id WHERE r.owner_id=? AND s.plan_id=? AND r.outcome='FAILED'", ownerId, planId);
  const checkRows = await dbAll(db, "SELECT r.created_at AS result_at,MIN(c.created_at) AS first_check_at FROM step_results r JOIN plan_steps s ON s.owner_id=r.owner_id AND s.step_id=r.step_id JOIN tracker_check_evidence c ON c.owner_id=r.owner_id AND c.step_id=r.step_id AND c.result_revision=r.revision WHERE r.owner_id=? AND s.plan_id=? GROUP BY r.step_id,r.revision,r.created_at", ownerId, planId);
  const checkDelays = checkRows.map((row) => Math.max(0, row.first_check_at - row.result_at)).sort((left, right) => left - right);
  const middle = Math.floor(checkDelays.length / 2);
  const medianCheckDelayMs = checkDelays.length === 0 ? null : checkDelays.length % 2 === 1
    ? checkDelays[middle]
    : Math.floor((checkDelays[middle - 1] + checkDelays[middle]) / 2);
  const cursor = await dbFirst(db, "SELECT COALESCE(MAX(server_sequence),0) AS sequence FROM tracker_journal WHERE owner_id=? AND plan_id=?", ownerId, planId);
  return {
    plan: plan, enabled: Boolean(await dbFirst(db, "SELECT 1 AS enabled FROM tracker_plan_config WHERE owner_id=? AND plan_id=? AND enabled=1", ownerId, planId)),
    steps: steps, bottlenecks: {
      blockedSteps: steps.filter((step) => step.status === "BLOCKED").length, blockedEvents: blockedEvents.count,
      retries: retries.count, retryMeasurement: "attempts with fence greater than 1; includes lease recovery and owner-assigned rework",
      failedResults: failedResults.count,
      checkDelay: { sampleCount: checkDelays.length, medianMs: medianCheckDelayMs, maxMs: checkDelays.length ? checkDelays[checkDelays.length - 1] : null,
        measurement: "server time from result recording to first check recording; not test execution time" },
    },
    timelineCursor: cursor.sequence, serverNow: nowMs,
  };
}

async function enrichTimelineEvent(db, ownerId, planId, row) {
  const event = {
    eventId: row.event_id, planId: row.plan_id, stepId: row.step_id, attemptId: row.attempt_id,
    commandId: row.command_id, sourceId: row.source_id, sessionId: row.session_id,
    sourceSequence: row.source_sequence, serverSequence: row.server_sequence, eventType: row.event_type,
    payload: parseColumn(row.payload_json, {}), payloadHash: row.payload_hash,
    occurredAt: row.occurred_at, receivedAt: row.received_at, classification: row.classification,
    correctionOfEventId: row.correction_of_event_id,
  };
  if (["STEP_RESULT_RECORDED", "CHECK_RECORDED"].includes(row.event_type)) {
    const source = row.event_type === "CHECK_RECORDED"
      ? await dbFirst(db, "SELECT source_repository_id FROM tracker_result_sources WHERE owner_id=? AND step_id=? AND revision=?", ownerId, row.step_id, event.payload.resultRevision)
      : await dbFirst(db, "SELECT source_repository_id FROM tracker_result_sources WHERE owner_id=? AND step_id=? AND attempt_id=?", ownerId, row.step_id, row.attempt_id);
    if (source?.source_repository_id) {
      const repo = await dbFirst(db, "SELECT is_private,access_state FROM repositories WHERE owner_id=? AND repository_id=?", ownerId, source.source_repository_id);
      if (!repo || (repo.is_private && repo.access_state !== "available")) {
        event.payload = { eventType: row.event_type, redacted: true };
        return event;
      }
    }
  }
  const data = event.payload && event.payload.data;
  if (data && ["commit_created", "commit_pushed", "push_failed"].includes(row.event_type) && data.repositoryId && data.revisionSha) {
    const repo = await dbFirst(db, "SELECT is_private,access_state FROM repositories WHERE owner_id=? AND repository_id=?", ownerId, data.repositoryId);
    if (!repo || (repo.is_private && repo.access_state !== "available")) {
      event.payload = { eventId: event.eventId, eventType: row.event_type, redacted: true };
      event.gitEvidence = { protectedDetailsHidden: true, localObserved: row.event_type === "commit_created", remoteVerified: null, refMembership: "unknown", attributionStatus: null };
      return event;
    }

  }
  return event;
}

async function readTrackerTimeline(db, ownerId, planId, afterSequence, limit) {
  if (!UUID.test(planId || "")) throw appError("VALIDATION_ERROR", "planId должен быть UUID.");
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw appError("VALIDATION_ERROR", "afterSequence должен быть неотрицательным целым числом.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw appError("VALIDATION_ERROR", "limit должен быть от 1 до 100.");
  const plan = await dbFirst(db, "SELECT 1 AS found FROM plans WHERE owner_id=? AND plan_id=?", ownerId, planId);
  if (!plan) throw appError("PLAN_NOT_FOUND", messageFor("PLAN_NOT_FOUND"), 404);
  const rows = await dbAll(db, "SELECT * FROM tracker_journal WHERE owner_id=? AND plan_id=? AND server_sequence>? ORDER BY server_sequence LIMIT ?", ownerId, planId, afterSequence, limit + 1);
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const events = [];
  for (const row of rows) events.push(await enrichTimelineEvent(db, ownerId, planId, row));
  return { events: events, nextCursor: events.length ? events[events.length - 1].serverSequence : afterSequence, hasMore: hasMore };
}

async function readCommandReceipt(db, ownerId, commandId) {
  if (!UUID.test(commandId || "")) throw appError("VALIDATION_ERROR", "commandId должен быть UUID.");
  const row = await dbFirst(db, "SELECT command_id,command_type,outcome_code,result_version,result_json,server_now_ms,recorded_at,execution_lease_until FROM command_receipts WHERE owner_id=? AND command_id=?", ownerId, commandId);
  if (!row) return { status: "NOT_FOUND", commandId: commandId };
  // Retired operations are immutable audit records, never a route back to Git/private metadata.
  if (RETIRED_COMMANDS.has(row.command_type)) {
    const audit = { status: row.outcome_code === "PENDING" ? "PENDING" : "FINAL", commandId: row.command_id,
      commandType: row.command_type, historical: true, serverNow: row.server_now_ms };
    if (row.outcome_code === "PENDING") return audit;
    Object.assign(audit, { outcomeCode: row.outcome_code, resultVersion: row.result_version, recordedAt: row.recorded_at });
    if (["OK", "PARTIAL"].includes(row.outcome_code)) audit.result = { historical: true, detailsHidden: true };
    else audit.error = { code: row.outcome_code, message: "Подробности исторической команды скрыты." };
    return audit;
  }
  if (row.outcome_code === "PENDING") return { status: "PENDING", commandId: row.command_id, commandType: row.command_type, executionLeaseUntil: row.execution_lease_until, serverNow: row.server_now_ms };
  const result = parseColumn(row.result_json, {});
  if (row.outcome_code !== "OK" && row.outcome_code !== "PARTIAL") return {
    status: "FINAL", commandId: row.command_id, commandType: row.command_type,
    error: { code: row.outcome_code, message: messageFor(row.outcome_code), details: result },
    resultVersion: row.result_version, recordedAt: row.recorded_at, serverNow: row.server_now_ms,
  };
  return { status: "FINAL", commandId: row.command_id, commandType: row.command_type,
    result: result, resultVersion: row.result_version, recordedAt: row.recorded_at, serverNow: row.server_now_ms };
}

// Read-only detail for the web chart; the MCP analytics contract stays unchanged.
export async function buildStepAnalytics(db, ownerId, planId, filter, nowMs) {
  if (!UUID.test(planId || "")) throw appError("VALIDATION_ERROR", "planId должен быть UUID.");
  const plan = await dbFirst(db, "SELECT first_started_at FROM plans WHERE owner_id=? AND plan_id=?", ownerId, planId);
  if (!plan) throw appError("PLAN_NOT_FOUND", messageFor("PLAN_NOT_FOUND"), 404);
  const timeZone = checkTimeZone(filter.timeZone || "UTC");
  const range = inclusiveDateRange(filter.from, filter.to, timeZone);
  const asOf = filter.asOf == null ? nowMs : Number(filter.asOf);
  if (!Number.isSafeInteger(asOf) || asOf < 0 || asOf > nowMs) throw appError("VALIDATION_ERROR", "Некорректное время отчёта.");
  const steps = await dbAll(db, "SELECT step_id,ordinal,title FROM plan_steps WHERE owner_id=? AND plan_id=? AND created_at<=? ORDER BY ordinal", ownerId, planId, asOf);
  const intervals = await dbAll(db, "SELECT start_ms,end_ms FROM work_intervals WHERE owner_id=? AND plan_id=? AND start_ms<=? ORDER BY start_ms", ownerId, planId, asOf);
  // started_at is the claim time, not StartStep. Only server command events prove execution.
  const attempts = await dbAll(db, `SELECT a.step_id,a.lease_until,a.closed_at,MIN(j.occurred_at) AS execution_started_at
    FROM step_attempts a JOIN plan_steps s ON s.owner_id=a.owner_id AND s.step_id=a.step_id
    JOIN tracker_journal j ON j.owner_id=a.owner_id AND j.step_id=a.step_id AND j.attempt_id=a.attempt_id
      AND j.event_type='STEP_STARTED' AND j.command_id IS NOT NULL
    WHERE s.owner_id=? AND s.plan_id=? GROUP BY a.attempt_id`, ownerId, planId);
  const measured = plan.first_started_at != null && plan.first_started_at <= asOf && intervals.length > 0;
  const started = new Set(attempts.filter(a => a.execution_started_at <= asOf).map(a => a.step_id));
  const totals = new Map(steps.map(s => [s.step_id, 0]));
  const ambiguousTotals = new Map(steps.map(s => [s.step_id, 0]));
  const events = [];
  const addWindow = (start, end, stepId) => {
    start = Math.max(start, range.startMs);
    end = Math.min(end, range.endMs, asOf);
    if (end > start) events.push({ at: start, delta: 1, stepId }, { at: end, delta: -1, stepId });
  };
  for (const i of intervals) addWindow(i.start_ms, i.end_ms ?? asOf, null);
  for (const a of attempts) addWindow(a.execution_started_at, Math.min(a.closed_at ?? asOf, a.lease_until), a.step_id);
  events.sort((a, b) => a.at - b.at);
  let work = 0, previous = events[0]?.at, totalActiveMs = 0, unattributedMs = 0, ambiguousMs = 0;
  const executing = new Map();
  // Sweep a union of actual work intervals. Overlapping steps never receive the same millisecond.
  for (let index = 0; index < events.length;) {
    const at = events[index].at, elapsed = at - previous;
    if (work > 0 && elapsed > 0) {
      totalActiveMs += elapsed;
      if (executing.size === 1) {
        const stepId = executing.keys().next().value;
        totals.set(stepId, totals.get(stepId) + elapsed);
      } else {
        unattributedMs += elapsed;
        if (executing.size > 1) {
          ambiguousMs += elapsed;
          for (const stepId of executing.keys()) ambiguousTotals.set(stepId, ambiguousTotals.get(stepId) + elapsed);
        }
      }
    }
    while (index < events.length && events[index].at === at) {
      const event = events[index++];
      if (event.stepId == null) work += event.delta;
      else {
        const count = (executing.get(event.stepId) || 0) + event.delta;
        if (count) executing.set(event.stepId, count); else executing.delete(event.stepId);
      }
    }
    previous = at;
  }
  return {
    period: { from: filter.from, to: filter.to, timeZone, startMs: range.startMs, endMs: range.endMs }, asOf,
    totalActiveMs: measured ? totalActiveMs : null,
    unattributedMs: measured ? unattributedMs : null, ambiguousMs: measured ? ambiguousMs : null,
    steps: steps.map(s => {
      const known = measured && started.has(s.step_id), active = totals.get(s.step_id), ambiguous = ambiguousTotals.get(s.step_id);
      return { stepId: s.step_id, ordinal: s.ordinal, title: s.title,
        activeMs: known && (active > 0 || ambiguous === 0) ? active : null,
        ambiguousMs: known ? ambiguous : null };
    }),
  };
}

export async function buildAnalytics(db, ownerId, filter, nowMs) {
  const timeZone = checkTimeZone(filter.timeZone || "UTC");
  const range = inclusiveDateRange(filter.from, filter.to, timeZone);
  const plans = await dbAll(db, "SELECT p.* FROM plans p WHERE p.owner_id=? ORDER BY p.registered_at DESC", ownerId);
  const days = new Map();
  const completedDurations = [];
  const inactivePlans = [];
  let completedPlans = 0;
  const included = [];
  for (const plan of plans) {
    const intervals = await dbAll(db, "SELECT start_ms,end_ms FROM work_intervals WHERE owner_id=? AND plan_id=? ORDER BY start_ms", ownerId, plan.plan_id);
    let clippedTotal = 0;
    for (const interval of intervals) {
      const end = interval.end_ms == null ? nowMs : interval.end_ms;
      let cursor = Math.max(interval.start_ms, range.startMs);
      const stop = Math.min(end, range.endMs);
      if (stop <= cursor) continue;
      clippedTotal += stop - cursor;
      while (cursor < stop) {
        const dayParts = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(cursor);
        const dayData = Object.fromEntries(dayParts.map((part) => [part.type, part.value]));
        const day = dayData.year + "-" + dayData.month + "-" + dayData.day;
        const dayRange = inclusiveDateRange(day, day, timeZone);
        const pieceEnd = Math.min(stop, dayRange.endMs);
        days.set(day, (days.get(day) || 0) + pieceEnd - cursor);
        cursor = pieceEnd;
      }
    }
    const fullActive = plan.first_started_at == null || intervals.length === 0 ? null : intervals.reduce((sum, interval) =>
      sum + Math.max(0, (interval.end_ms == null ? nowMs : interval.end_ms) - interval.start_ms), 0);
    const finishedInRange = plan.status === "COMPLETED" && plan.finished_at >= range.startMs && plan.finished_at < range.endMs;
    if (finishedInRange) {
      completedPlans += 1;
      if (fullActive != null) completedDurations.push(fullActive);
    }
    if (clippedTotal > 0 || finishedInRange) {
      included.push({ planId: plan.plan_id, title: plan.title, status: plan.status, activeInPeriodMs: clippedTotal, fullActiveMs: fullActive, measured: fullActive != null, finishedAt: plan.finished_at });
    }
    if ((plan.status === "PLANNED" || plan.status === "PAUSED") && clippedTotal === 0) {
      inactivePlans.push({ planId: plan.plan_id, title: plan.title, status: plan.status, version: plan.version, activeInPeriodMs: 0, finishedAt: null });
    }
  }
  return {
    period: { from: filter.from, to: filter.to, timeZone: timeZone, startMs: range.startMs, endMs: range.endMs },
    activeByDay: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, activeMs]) => ({ date: date, activeMs: activeMs })),
    totalActiveMs: [...days.values()].reduce((sum, value) => sum + value, 0),
    completedPlans: completedPlans,
    completedMedianActiveMs: median(completedDurations),
    completedMeasuredN: completedDurations.length,
    completedSmallSample: completedDurations.length > 0 && completedDurations.length < 5,
    asOf: nowMs,
    plans: included,
    inactivePlans: inactivePlans,
    serverNow: nowMs,
  };
}

const UI_ANALYTICS_CSS = String.raw`
.analytics-plan{min-width:0;border:1px solid var(--line);border-radius:11px;background:white}
.analytics-plan>summary{border:0;border-radius:11px;cursor:pointer;list-style:none;font-weight:400}
.analytics-plan>summary::-webkit-details-marker{display:none}
.analytics-plan>summary::after{content:"";width:9px;height:9px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(45deg);flex-shrink:0;margin:0 4px 4px 8px}
.analytics-plan[open]>summary::after{transform:rotate(225deg);margin-bottom:0}
.analytics-plan>summary:focus-visible{outline:3px solid #579ce0;outline-offset:2px}
.analytics-plan-name{flex:1;overflow-wrap:anywhere}.analytics-plan-meta{font-size:.82rem;color:var(--muted)}
.step-chart-body{margin:0 13px 13px;padding-top:13px;border-top:1px solid var(--line);min-width:0}
.step-chart-body p{font-size:.82rem;overflow-wrap:anywhere}.step-chart-body h3{font-size:.9rem;font-weight:500;color:var(--muted);margin:0 0 12px}
.step-chart{position:relative;min-width:0;margin-top:16px}.step-chart-frame{display:grid;grid-template-columns:38px minmax(0,1fr)}
.step-y-axis{position:relative;height:190px;margin-top:4px;color:var(--muted);font-size:.75rem}.step-y-axis span{position:absolute;right:9px;transform:translateY(50%)}
.step-chart-scroll{min-width:0;max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;padding:4px 3px 3px}
.step-chart-scroll:focus-visible{outline:3px solid #579ce0;outline-offset:-3px}.step-columns{display:grid}
.step-column{display:grid;grid-template-rows:190px 44px;gap:0;min-width:0;padding:0;background:transparent;font-weight:400;border-radius:3px;color:var(--muted);-webkit-tap-highlight-color:transparent}
.step-column:focus-visible{outline-offset:-3px}.step-plot-slot{height:190px;display:flex;align-items:flex-end;justify-content:center;background:linear-gradient(to top,var(--line) 1px,transparent 1px) 0 0/100% 20%;border-bottom:1px solid var(--line)}
.step-bar{display:block;width:48px;max-width:60%;background:#319578;border-radius:4px 4px 0 0}.step-column:hover .step-bar,.step-column:focus .step-bar{background:var(--green)}
.step-x-label{display:block;align-self:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 6px;font-size:.75rem}
.step-missing{align-self:flex-end;margin-bottom:6px;color:var(--muted)}
.step-tooltip{position:absolute;z-index:2;top:25px;left:38px;max-width:calc(100% - 38px);width:max-content;background:#253440;color:white;padding:10px 13px;border-radius:9px;font-size:.82rem;overflow-wrap:anywhere;box-shadow:0 3px 10px #18212b22}
.step-tooltip strong,.step-tooltip span{display:block}.step-tooltip span{margin-top:5px;color:#d6e8e2}
.step-axis-caption{text-align:center;color:var(--muted);font-size:.75rem;margin:7px 0}.step-minutes{color:var(--muted);font-size:.75rem;margin-bottom:7px}
.step-method{font-size:.82rem;color:var(--muted);margin-top:12px}.step-method>summary{cursor:pointer}.step-method>summary:focus-visible{outline:3px solid #579ce0;outline-offset:2px}
@media(max-width:600px){.analytics-plan>summary{flex-wrap:wrap}.analytics-plan-name{flex:1 1 calc(100% - 40px)}.analytics-plan-meta{order:2;flex:1 1 100%}.analytics-plan>summary::after{order:1}.step-tooltip{position:relative;top:auto;left:auto;margin:8px 0 0 38px}}
`;

// Inserted into the base client so metrics, day bars and disclosures share its accepted response.
const UI_ANALYTICS = String.raw`
let dismissActiveStepTooltip=null,activeStepTooltipChart=null;
document.addEventListener("keydown",event=>{if(event.key==="Escape")dismissActiveStepTooltip?.();});
// Dismiss in-flow mobile hints after the tap, so blur cannot move the tap target.
document.addEventListener("click",event=>{if(activeStepTooltipChart&&event.target.closest?.(".step-chart")!==activeStepTooltipChart)dismissActiveStepTooltip?.();});
document.addEventListener("focusin",event=>{if(activeStepTooltipChart&&event.target.matches?.(":focus-visible")&&event.target.closest?.(".step-chart")!==activeStepTooltipChart)dismissActiveStepTooltip?.();});
function exactStepTime(ms) {
  if(ms==null)return "Нет данных о привязке времени";
  const minutes=Math.floor(ms/60000),seconds=Math.floor(ms%60000/1000),millis=ms%1000;
  return minutes+" мин"+(seconds?" "+seconds+" с":"")+(millis?" "+millis+" мс":"");
}
function stepTimeLabel(step) {
  if(step.ambiguousMs>0){
    if(step.activeMs==null)return "Время не определено: "+exactStepTime(step.ambiguousMs)+" активности пересекается с другими пунктами";
    return exactStepTime(step.activeMs)+" · неполное время: только однозначная часть; пересечения с другими пунктами — "+exactStepTime(step.ambiguousMs);
  }
  return exactStepTime(step.activeMs);
}
function renderStepChart(body,data) {
  const make=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
  body.replaceChildren(make("h3","Время по пунктам за выбранный период"));
  body.append(make("p",data.period.from+" — "+data.period.to+" включительно · "+data.period.timeZone+". Срез на "+dateFmt(data.asOf)+".","muted"));
  if(!data.steps.length){body.append(make("p","На момент отчёта в плане нет пунктов. График недоступен.","muted"));return;}
  if(data.unattributedMs!=null)body.append(make("p","Без однозначной привязки: "+exactStepTime(data.unattributedMs)+(data.ambiguousMs?" (из них пересечения пунктов: "+exactStepTime(data.ambiguousMs)+")":"")+".","muted"));
  const measured=data.steps.filter(s=>s.activeMs!=null);
  const hasAmbiguity=data.steps.some(s=>s.ambiguousMs>0);
  if(hasAmbiguity)body.append(make("p","Пересечения пунктов: «—» — время не определено; «*» — неполное время, только однозначно отнесённая часть. Пересечения не распределяются.","muted"));
  if(!measured.length&&!hasAmbiguity)body.append(make("p","Данные о привязке времени к пунктам отсутствуют. Знак «—» означает отсутствие данных.","muted"));
  else if(!hasAmbiguity&&measured.length!==data.steps.length)body.append(make("p","«—» — нет данных о привязке времени.","muted"));
  const chart=make("div",null,"step-chart"),frame=make("div",null,"step-chart-frame"),axis=make("div",null,"step-y-axis"),scroll=make("div",null,"step-chart-scroll"),columns=make("div",null,"step-columns");
  chart.append(make("div","Минуты","step-minutes"));
  const maxMinutes=measured.reduce((max,s)=>Math.max(max,s.activeMs/60000),0),rawTick=maxMinutes/5,magnitude=Math.pow(10,Math.floor(Math.log10(rawTick||0.2))),normalized=rawTick/magnitude,tick=(normalized<=1?1:normalized<=2?2:normalized<=5?5:10)*magnitude,ceiling=Math.max(1,tick*5);
  axis.setAttribute("aria-hidden","true");
  for(let i=0;i<=5;i++){const tick=make("span",new Intl.NumberFormat("ru-RU",{maximumFractionDigits:3}).format(ceiling*i/5));tick.style.bottom=(100*i/5)+"%";axis.append(tick);}
  scroll.tabIndex=0;scroll.setAttribute("role","region");scroll.setAttribute("aria-label","График времени по пунктам, прокручивается горизонтально");
  columns.style.gridTemplateColumns="repeat("+data.steps.length+",minmax(104px,1fr))";columns.style.minWidth=(data.steps.length*104)+"px";
  const tooltip=make("div",null,"step-tooltip hidden");tooltip.id="step-tooltip-"+uid();tooltip.setAttribute("role","tooltip");
  let selected=null,hideTimer;
  const hide=()=>{clearTimeout(hideTimer);tooltip.classList.add("hidden");if(selected)selected.removeAttribute("aria-describedby");selected=null;if(dismissActiveStepTooltip===hide){dismissActiveStepTooltip=null;activeStepTooltipChart=null;}};
  const show=(button,step)=>{dismissActiveStepTooltip?.();hide();selected=button;tooltip.replaceChildren(make("strong",step.title),make("span",stepTimeLabel(step)));tooltip.classList.remove("hidden");button.setAttribute("aria-describedby",tooltip.id);dismissActiveStepTooltip=hide;activeStepTooltipChart=chart;};
  const leave=()=>{clearTimeout(hideTimer);hideTimer=setTimeout(()=>{if(selected!==document.activeElement&&!tooltip.matches(":hover"))hide();},120);};
  tooltip.addEventListener("pointerenter",()=>clearTimeout(hideTimer));tooltip.addEventListener("pointerleave",leave);
  data.steps.forEach((step,index)=>{
    const button=make("button",null,"step-column"),slot=make("span",null,"step-plot-slot"),bar=make("span",null,"step-bar"),label=make("span",(index+1)+(step.activeMs!=null&&step.ambiguousMs>0?"*":"")+" · "+step.title,"step-x-label");
    button.type="button";button.setAttribute("aria-label",(index+1)+". "+step.title+" — "+stepTimeLabel(step));
    if(step.activeMs==null)slot.append(make("span","—","step-missing"));else{bar.style.height=(100*(step.activeMs/60000)/ceiling)+"%";slot.append(bar);}
    button.append(slot,label);columns.append(button);
    button.addEventListener("pointerenter",event=>{if(event.pointerType!=="touch")show(button,step);});
    button.addEventListener("pointerleave",leave);
    button.addEventListener("focus",()=>show(button,step));button.addEventListener("blur",()=>{if(!window.matchMedia("(max-width:600px)").matches)hide();});
    button.addEventListener("click",()=>show(button,step));
  });
  scroll.append(columns);frame.append(axis,scroll);chart.append(frame,tooltip,make("p","Пункты плана","step-axis-caption"));body.append(chart);
  body.append(make("p","Полное название и точное время: наведите на столбик или подпись, выберите клавишей Tab или нажмите на телефоне. Escape скрывает подсказку.","muted"));
  const method=make("details",null,"step-method");method.append(make("summary","Как считается время"),make("p","Учитываются только интервалы активности плана в выбранные даты включительно, в указанном часовом поясе. Выполнение пункта подтверждается запуском и ограничено закрытием попытки или истечением её срока. Паузы исключены, все попытки суммируются. Время без однозначной привязки, в том числе пересечения разных пунктов, не распределяется. При полном перекрытии время пункта не определено («—»); при частичном отмечено «*» и показана только однозначная часть. 0 мин означает подтверждённое выполнение без учтённого времени и без пересечений в периоде. Срез ограничивает состав пунктов и учтённое время; названия и порядок показаны в текущей редакции. Медиана выше по-прежнему использует полное активное время планов, завершённых в периоде."));body.append(method);
}
function renderAnalyticsPlanCards(list,report) {
  report.plans.forEach(plan=>{
    const card=document.createElement("details"),summary=document.createElement("summary"),name=document.createElement("span"),value=document.createElement("span"),body=document.createElement("div");
    card.className="analytics-plan";card.dataset.planId=plan.planId;summary.className="row";name.className="analytics-plan-name";name.textContent=plan.title;
    value.className="analytics-plan-meta";value.textContent=duration(plan.activeInPeriodMs)+(plan.finishedAt?" · завершён "+dateFmt(plan.finishedAt):"");summary.append(name,value);body.className="step-chart-body";card.append(summary,body);list.append(card);
    let loaded=false,loading=false;
    const load=async()=>{
      if(loaded||loading||!card.open)return;loading=true;body.textContent="Загрузка графика…";body.setAttribute("aria-busy","true");
      try{
        const query=new URLSearchParams({from:report.period.from,to:report.period.to,timeZone:report.period.timeZone,asOf:String(report.asOf)});
        const data=await call("/api/analytics/plans/"+encodeURIComponent(plan.planId)+"/steps?"+query);
        if(!card.isConnected)return;
        renderStepChart(body,data);loaded=true;
      }catch(error){
        if(!card.isConnected)return;body.replaceChildren();const message=document.createElement("p"),retry=document.createElement("button");message.textContent="Не удалось загрузить график. "+error.message;message.setAttribute("role","status");retry.type="button";retry.textContent="Повторить";retry.onclick=load;body.append(message,retry);
      }finally{loading=false;body.removeAttribute("aria-busy");}
    };
    card.addEventListener("toggle",()=>{if(card.open)load();});
  });
}
`;

const UI_ENHANCEMENTS = String.raw`(()=> {
  const q = (s) => document.querySelector(s);
  const make = (tag, text, cls) => { const x=document.createElement(tag); if(text!=null)x.textContent=text; if(cls)x.className=cls; return x; };
  const supportedZones = ${JSON.stringify(UI_TIME_ZONES.map((option) => option.value))};
  const normalizeZone = (value) => supportedZones.includes(value) ? value : "Asia/Omsk";
  const state = { zone: "Asia/Omsk", analytics: null };
  const localDate = (d) => { const value=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:state.zone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(d)).map(part=>[part.type,part.value])); return value.year+"-"+value.month+"-"+value.day; };
  const duration = (n) => { if(n==null)return "—"; n=Math.max(0,Math.round(n/60000)); const d=Math.floor(n/1440),h=Math.floor(n%1440/60),m=n%60; return d?d+" д "+h+" ч "+m+" мин":h?h+" ч "+m+" мин":m+" мин"; };
  async function api(path, options) {
    const response=await fetch(path,{...options,headers:{"content-type":"application/json",...(options&&options.headers||{})},cache:"no-store"});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){const err=new Error(data.error&&data.error.message||"HTTP "+response.status);err.code=data.error&&data.error.code;err.retryAfter=data.error&&data.error.retryAfter;throw err;}
    return data;
  }
  function addFilterPanel(target, id, title) {
    const panel=make("article",null,"panel"),heading=make("h2",title),toolbar=make("div",null,"toolbar");
    const fromWrap=make("div",null,"field"),fromLabel=make("label","С");fromLabel.htmlFor=id+"From";
    const from=make("input");from.type="date";from.id=id+"From";from.setAttribute("aria-label","Дата начала периода");fromWrap.append(fromLabel,from);
    const toWrap=make("div",null,"field"),toLabel=make("label","По");toLabel.htmlFor=id+"To";
    const to=make("input");to.type="date";to.id=id+"To";to.setAttribute("aria-label","Дата конца периода");toWrap.append(toLabel,to);
    const apply=make("button","Применить","primary");apply.type="button";
    const modeWrap=make("div",null,"field"),modeLabel=make("label","Показать");modeLabel.htmlFor=id+"Mode";
    const mode=make("select");mode.id=id+"Mode";mode.append(new Option("Активность за период","activity"),new Option("Завершённые за период","finished"));modeWrap.append(modeLabel,mode);
    toolbar.append(fromWrap,toWrap,modeWrap,apply);
    const stats=make("div",null,"metrics"),list=make("div",null,"list");
    panel.append(heading,toolbar,stats,list);
    target.prepend(panel);
    return {panel,from,to,mode,apply,stats,list};
  }
  const overview=q("#view-overview");
  const overviewFilter=addFilterPanel(overview,"overview","Фильтр периода");
  overviewFilter.mode.closest(".field").remove();
  overviewFilter.list.id="overviewPeriodPlans";
  const oldMetrics=q("#today")&&q("#today").closest(".metrics");
  if(oldMetrics)oldMetrics.remove();
  const overviewHeading=overviewFilter.panel.querySelector("h2");
  overviewHeading.textContent="Показатели периода";
  const planFilter=addFilterPanel(q("#view-plans"),"plan","Планы за период");
  planFilter.panel.classList.add("plan-period-panel");
  planFilter.list.id="planPeriodPlans";
  const inactive=make("div",null,"list");inactive.id="inactivePeriodPlans";
  const inactiveHeading=make("h3","Планы без активности");
  planFilter.panel.append(inactiveHeading,inactive);
  function rangeQuery(filter) {
    const params=new URLSearchParams({from:filter.from.value,to:filter.to.value,timeZone:state.zone});
    return params.toString();
  }
  const filterRequestIds=new WeakMap();
  function executePlanCommand(commandType,plan) {
    return new Promise((resolve,reject)=>window.dispatchEvent(new CustomEvent("plan-time-tracker:command",{detail:{commandType,plan,payload:{},resolve,reject}})));
  }
  function formatPlanSample(count) {
    const n=Number(count)||0,lastTwo=n%100;
    return "по "+n+" "+((lastTwo>=11&&lastTwo<=14)||n%10!==1?"планам":"плану");
  }
  function renderMetrics(target,data) {
    target.replaceChildren();
    const values=[
      ["Активное время",duration(data.totalActiveMs)],
      ["Завершено планов",String(data.completedPlans)],
      ["Медиана активного времени",duration(data.completedMedianActiveMs)+(data.completedMedianActiveMs==null?"":" · "+formatPlanSample(data.completedMeasuredN))]
    ];
    values.forEach(([label,value],index)=>{
      const box=make("div",null,"metric"),small=make("small",label),strong=make("strong",value);
      box.append(small,strong);
      if(index===2&&data.completedSmallSample){const note=make("small","Малая выборка","sample-note");note.title="Медиана рассчитана по менее чем пяти завершённым планам.";note.setAttribute("aria-label","Малая выборка: менее пяти завершённых планов.");box.append(note);}
      target.append(box);
    });
  }
  function renderPeriodList(target,rows,withInactive) {
    target.replaceChildren();
    if(!rows.length){target.append(make("p","За выбранный период данных нет.","muted"));return;}
    rows.forEach(p=>{
      const row=make("div",null,"row"),left=make("span",p.title),right=make("span",duration(p.activeInPeriodMs)+(p.finishedAt?" · завершён "+new Intl.DateTimeFormat("ru-RU",{dateStyle:"medium",timeZone:state.zone}).format(new Date(p.finishedAt)):""));
      row.append(left,right);target.append(row);
    });
  }
  async function loadFilter(filter, overviewMode) {
    const requestId=(filterRequestIds.get(filter)||0)+1;
    filterRequestIds.set(filter,requestId);
    if(!filter.from.value||!filter.to.value)return;
    let data;
    try{data=await api("/api/analytics?"+rangeQuery(filter));}
    catch(error){if(filterRequestIds.get(filter)!==requestId)return null;throw error;}
    if(filterRequestIds.get(filter)!==requestId)return null;
    renderMetrics(filter.stats,data);
    if(overviewMode) {
      renderPeriodList(filter.list,data.plans.filter(p=>p.activeInPeriodMs>0||p.finishedAt!=null),false);
      return data;
    }
    if(filter.analyticsOnly) {
      renderPeriodList(filter.list,data.plans.filter(p=>p.activeInPeriodMs>0||p.finishedAt!=null),false);
      return data;
    }
    const rows=filter.mode.value==="finished"
      ? data.plans.filter(p=>p.status==="COMPLETED"&&p.finishedAt!=null)
      : data.plans.filter(p=>p.activeInPeriodMs>0);
    renderPeriodList(filter.list,rows,false);
    const allPlanRows=[...q("#plans").querySelectorAll("[data-plan-id]")];
    const visibleIds=new Set(filter.mode.value==="finished"?rows.map(p=>p.planId):rows.map(p=>p.planId));
    allPlanRows.forEach(row=>row.classList.toggle("hidden",!visibleIds.has(row.dataset.planId)));
    const inactiveRows=filter.mode.value==="activity"?data.inactivePlans||[]:[];
    const inactiveIds=new Set(inactiveRows.map(p=>p.planId));
    allPlanRows.forEach(row=>{if(inactiveIds.has(row.dataset.planId))row.classList.add("hidden");});
    inactive.replaceChildren();
    if(!inactiveRows.length){inactive.append(make("p","Нет планов без активности.","muted"));}
    else {
      inactiveRows.forEach(p=>{
        const row=make("div",null,"row");
        row.append(make("span",p.title+" · "+(p.status==="PAUSED"?"на паузе":"запланирован")));
        const action=make("button",p.status==="PAUSED"?"Продолжить":"Запустить","primary");
        action.onclick=async()=>{
          if(action.disabled)return;
          action.disabled=true;
          try {
            const commandType=p.status==="PAUSED"?"ResumePlan":"StartPlan";
            await executePlanCommand(commandType,p);
            await loadFilter(filter,false);
          } catch(e){window.alert(e.message);}
          finally{action.disabled=false;}
        };
        row.append(action);inactive.append(row);
      });
    }
    return data;
  }
  window.addEventListener("plan-time-zone-changed",event=>{
    state.zone=normalizeZone(event.detail);
    loadFilter(overviewFilter,true).catch(e=>window.alert(e.message));
    loadFilter(planFilter,false).catch(e=>window.alert(e.message));
    if(!q("#view-analytics").classList.contains("hidden"))q("#apply").click();
  });
  function defaults(filter) {
    const today=localDate(Date.now()),fromDate=new Date(today+"T12:00:00Z");fromDate.setUTCDate(fromDate.getUTCDate()-29);
    if(!filter.from.value)filter.from.value=localDate(fromDate);
    if(!filter.to.value)filter.to.value=today;
  }
  defaults(overviewFilter);defaults(planFilter);
  overviewFilter.apply.onclick=()=>loadFilter(overviewFilter,true).catch(e=>window.alert(e.message));
  planFilter.apply.onclick=()=>loadFilter(planFilter,false).catch(e=>window.alert(e.message));
  planFilter.mode.onchange=()=>loadFilter(planFilter,false).catch(e=>window.alert(e.message));
  // Analytics uses the base loader so one accepted response updates metrics, chart and list together.
  async function init() {
    const settings=await api("/api/settings");state.zone=normalizeZone(settings.timezone);
    defaults(overviewFilter);defaults(planFilter);
    await loadFilter(overviewFilter,true);
    if(q("#plans").dataset.loaded!=="true")await new Promise(resolve=>window.addEventListener("plan-time-tracker:plans-rendered",resolve,{once:true}));
    await loadFilter(planFilter,false);
  }
  const detail=q("#planDetail");
  let detailEnhancementToken=0;
  async function enhancePlanDetail(id){
    if(!detail||!id)return;
    const token=++detailEnhancementToken;
    detail.dataset.extraReady="true";detail.dataset.extraReadyPlanId=id;
    try{
      const {plan}=await api("/api/plans/"+encodeURIComponent(id));
      if(token!==detailEnhancementToken||detail.dataset.planId!==id)return;
      const time=make("p",plan.finishedAt!=null?"От первого запуска до завершения: "+duration(plan.calendarMs):"");if(time.textContent)detail.append(time);
      if(plan.planCreatedAt.precision==="instant"&&plan.firstStartedAt!=null){
        const wait=plan.firstStartedAt-Date.parse(plan.planCreatedAt.value);
        detail.append(make("p","От указанной даты до первого запуска: "+duration(wait)));
      }
    }catch{}
  }
  window.addEventListener("plan-time-tracker:plan-rendered",event=>enhancePlanDetail(event.detail?.planId));
  init().catch(e=>{const notice=q("#notice");if(notice){notice.textContent=e.message;notice.classList.remove("hidden","error");}});
})();`;

const UI_TRACKER = String.raw`(()=> {
  const root=document.querySelector("#planDetail");
  if(!root)return;
  const style=document.createElement("style");
  style.textContent=".tracker-section{display:grid;gap:14px;margin-top:22px;padding-top:18px;border-top:1px solid #e2e7ec}.tracker-list,.tracker-timeline{display:grid;gap:10px}.tracker-card,.timeline-card{min-width:0;border:1px solid #e2e7ec;border-radius:11px;padding:14px;background:#fff}.tracker-card h4,.timeline-card h4{margin:0 0 8px}.tracker-card h4{min-width:0;overflow-wrap:anywhere}.tracker-card p,.timeline-card p{margin:7px 0;overflow-wrap:anywhere}.tracker-meta{font-size:.88rem;color:#657180}.tracker-form{display:grid;gap:10px}.tracker-form .field{min-width:0}.tracker-card-body>.tracker-form+.tracker-form{margin-top:10px}.tracker-card-body>details{display:block}.tracker-card-body>details[open]{display:grid;gap:10px}.tracker-actions{display:flex;gap:8px;flex-wrap:wrap}.tracker-card-body>.tracker-actions{margin-top:10px}.plan-period-panel>.metrics{margin-top:16px}.plan-period-panel>#planPeriodPlans{margin-top:16px}.tracker-timeline time{display:block;font-size:.82rem;color:#657180;overflow-wrap:anywhere}.tracker-marker{display:inline-block;margin:0 6px 0 0;padding:3px 7px;border-radius:99px;background:#edf0f3;font-size:.76rem;font-weight:700}.tracker-marker.GAP,.tracker-marker.LATE,.tracker-marker.STALE_EXECUTOR{background:#fff3dd;color:#805500}.tracker-marker.CORRECTION{background:#eaf0ff;color:#31538a}.tracker-revision{overflow-wrap:anywhere;word-break:break-word}.tracker-timeline-actions{display:flex;gap:8px;flex-wrap:wrap}.tracker-card button,.tracker-section button{min-height:42px}.tracker-card-toggle{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;width:100%;padding:0;background:transparent;color:inherit;text-align:left;border:0;border-radius:0;white-space:normal}.tracker-card-toggle>strong{flex:1;min-width:0;overflow-wrap:anywhere}.tracker-card-toggle[aria-expanded=false]>strong{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.tracker-card-status{flex:none;font-size:.85rem;color:#657180}.tracker-card-summary{margin-bottom:0!important}.tracker-card-body{min-width:0;padding-top:10px}.tracker-card-error:empty{display:none}.tracker-collapse-actions{display:flex;gap:8px;flex-wrap:wrap}@media(max-width:600px){.tracker-form{grid-template-columns:minmax(0,1fr)}.tracker-actions button,.tracker-timeline-actions button{flex:1 1 100%}.tracker-card,.timeline-card{padding:12px}}";
  document.head.append(style);
  const make=(tag,text,cls)=>{const element=document.createElement(tag);if(text!==undefined&&text!==null)element.textContent=text;if(cls)element.className=cls;return element;};
  const duration=(value)=>{if(value==null)return "—";let minutes=Math.max(0,Math.round(value/60000));const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),rest=minutes%60;return days?days+" д "+hours+" ч "+rest+" мин":hours?hours+" ч "+rest+" мин":rest+" мин";};
  const date=(value)=>value==null?"—":new Intl.DateTimeFormat("ru-RU",{dateStyle:"medium",timeStyle:"short",timeZone:document.querySelector("#tz")?.value||Intl.DateTimeFormat().resolvedOptions().timeZone}).format(new Date(value));
  const statusNames={PENDING:"Ожидает",RUNNING:"Выполняется",BLOCKED:"Заблокирован",FAILED:"Не пройден",DONE:"Результат записан",OPEN:"Активная попытка",CLOSED:"Закрыта",ABANDONED:"Прервана",PASSED:"Пройдена",NOT_RUN:"Не запускалась"};
  const eventNames={PLAN_STARTED:"План запущен",PLAN_PAUSED:"План приостановлен",PLAN_RESUMED:"План возобновлён",PLAN_FINISHED:"План завершён",STEP_CREATED:"Checkpoint создан",STEP_UPDATED:"Checkpoint изменён",ATTEMPT_CLAIMED:"Попытка назначена",ATTEMPT_ABANDONED:"Попытка прервана",ATTEMPT_CLOSED:"Попытка закрыта",STEP_STARTED:"Checkpoint запущен",STEP_BLOCKED:"Checkpoint заблокирован",STEP_RESULT_RECORDED:"Результат записан",CHECK_RECORDED:"Проверка записана",LEASE_RENEWED:"Lease продлён",turn_started:"Ход начат",turn_finished:"Ход завершён",tool_started:"Инструмент запущен",tool_finished:"Инструмент завершён",HISTORICAL_EVENT:"Историческое событие",heartbeat:"Heartbeat",gap:"Разрыв последовательности",correction:"Коррекция наблюдения"};
  const uuid=()=>crypto.randomUUID();
  const getSessionId=()=>{let value=sessionStorage.getItem("plan-time-tracker-session");if(!value){value=uuid();sessionStorage.setItem("plan-time-tracker-session",value);}return value;};
  async function api(path,options){const response=await fetch(path,{...options,headers:{"content-type":"application/json",...(options&&options.headers||{})},cache:"no-store"});const data=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(data.error&&data.error.message||"HTTP "+response.status);error.status=response.status;error.code=data.error&&data.error.code;error.details=data.error&&data.error.details;throw error;}return data;}
  const pendingCommands=new Map(),rejectedCommands=new Set(),terminalRejectedCommands=new Set(),rejectedVersions=new Map(),retryVersions=new Map();
  const terminalDomainRejections=new Set(["RESULT_REVISION_STALE","LEASE_EXPIRED","STEP_NOT_STARTED","STEP_ALREADY_EXISTS","REWORK_REQUIRED","ATTEMPT_CLOSED","LEASE_FENCED","ACTIVE_ATTEMPT_EXISTS"]);
  async function hasMatchingFinalDomainRejection(envelope,error){if(error.status!==409||!terminalDomainRejections.has(error.code))return false;try{const receipt=await api("/api/tracker/commands/"+encodeURIComponent(envelope.commandId));return receipt.status==="FINAL"&&receipt.commandId===envelope.commandId&&receipt.commandType===envelope.commandType&&receipt.error?.code===error.code&&!receipt.result;}catch{return false;}}
  async function readCurrentVersion(payload){const stepId=payload.stepId;if(stepId){const planId=payload.planId||root.dataset.planId;if(!planId)return null;const snapshot=await api("/api/tracker/plans/"+encodeURIComponent(planId)+"/execution");const step=(snapshot.steps||[]).find(item=>item.step_id===stepId);return step&&Number.isSafeInteger(step.version)?step.version:null;}const planId=payload.planId;if(!planId)return null;const snapshot=await api("/api/plans/"+encodeURIComponent(planId));return Number.isSafeInteger(snapshot.plan&&snapshot.plan.version)?snapshot.plan.version:null;}
  async function command(type,payload,expectedVersion){const key=type+":"+(payload.planId||payload.stepId||payload.attemptId||"new"),scope=payload.stepId||payload.planId||null,retryVersion=expectedVersion!==undefined?retryVersions.get(key):undefined,effectiveVersion=Number.isSafeInteger(retryVersion)?Math.max(expectedVersion,retryVersion):expectedVersion,identity={payload,expectedVersion:effectiveVersion};let envelope=pendingCommands.get(key);if(envelope&&!rejectedCommands.has(key)&&!rejectedVersions.has(key)&&!terminalRejectedCommands.has(key)&&JSON.stringify(envelope.payload)===JSON.stringify(payload))identity.expectedVersion=envelope.expectedVersion;if(envelope&&terminalRejectedCommands.has(key)){envelope=null;pendingCommands.delete(key);terminalRejectedCommands.delete(key)}if(envelope&&rejectedCommands.has(key)&&JSON.stringify({payload:envelope.payload,expectedVersion:envelope.expectedVersion})!==JSON.stringify(identity)){envelope=null;pendingCommands.delete(key);rejectedCommands.delete(key)}if(envelope&&rejectedVersions.has(key)){envelope=null;pendingCommands.delete(key);rejectedVersions.delete(key)}if(envelope&&!rejectedCommands.has(key)&&JSON.stringify({payload:envelope.payload,expectedVersion:envelope.expectedVersion})!==JSON.stringify(identity)){const error=new Error("Исход предыдущей команды неизвестен. Сначала повторите её без изменения данных.");error.code="COMMAND_OUTCOME_UNKNOWN";throw error}if(!envelope){envelope={schemaVersion:1,commandId:uuid(),commandType:type,payload};if(identity.expectedVersion!==undefined)envelope.expectedVersion=identity.expectedVersion;pendingCommands.set(key,envelope)}try{const response=await api("/api/commands",{method:"POST",body:JSON.stringify(envelope)});if(response?.commandId!==envelope.commandId||response.outcome!=="OK"||typeof response.applied!=="boolean"||typeof response.replayed!=="boolean"||response.applied===response.replayed||!response.result||typeof response.result!=="object"||Array.isArray(response.result)||response.error){const error=new Error("Ответ команды не подтверждает её результат. Повторите запрос без изменения данных.");error.code="COMMAND_OUTCOME_UNKNOWN";throw error}pendingCommands.delete(key);rejectedCommands.delete(key);terminalRejectedCommands.delete(key);rejectedVersions.delete(key);retryVersions.delete(key);return response.result}catch(error){if(error.code==="VALIDATION_ERROR")rejectedCommands.add(key);else if(await hasMatchingFinalDomainRejection(envelope,error))terminalRejectedCommands.add(key);if(error.code==="VERSION_CONFLICT"&&scope){try{const currentVersion=await readCurrentVersion(payload);if(Number.isSafeInteger(currentVersion)){rejectedVersions.set(key,currentVersion);retryVersions.set(key,currentVersion);}}catch{}}throw error;}}
  async function settleAttemptCommands(stepId){for(const type of ["ClaimStepAttempt","StartStep"]){const key=type+":"+stepId,pending=pendingCommands.get(key);if(!pending)continue;if(rejectedCommands.has(key)||rejectedVersions.has(key)||terminalRejectedCommands.has(key)){pendingCommands.delete(key);rejectedCommands.delete(key);rejectedVersions.delete(key);terminalRejectedCommands.delete(key);retryVersions.delete(key);continue;}await command(type,pending.payload,pending.expectedVersion);}}
  function refreshAcceptedPlan(planId,successMessage){return new Promise((resolve,reject)=>window.dispatchEvent(new CustomEvent("plan-time-tracker:refresh-plan",{detail:{planId,successMessage,resolve,reject}})));}
  function inputField(labelText,options){const wrap=make("div",null,"field"),label=make("label",labelText),control=make(options&&options.tag||"input");control.type=options&&options.type||"text";if(options&&options.maxLength)control.maxLength=options.maxLength;if(options&&options.required)control.required=true;if(options&&options.placeholder)control.placeholder=options.placeholder;if(options&&options.value!==undefined)control.value=options.value;if(options&&options.rows)control.rows=options.rows;control.dataset.draftField=options&&options.key||labelText;const id="tracker-"+uuid();control.id=id;label.htmlFor=id;wrap.append(label,control);return {wrap,control};}
  function selectField(labelText,values,selected){const wrap=make("div",null,"field"),label=make("label",labelText),control=make("select"),id="tracker-"+uuid();control.dataset.draftField=labelText;control.id=id;label.htmlFor=id;values.forEach((value)=>{const option=make("option",value);option.value=value;option.selected=value===selected;control.append(option);});wrap.append(label,control);return {wrap,control};}
  const viewState=new Map();
  function stateFor(planId){if(!viewState.has(planId))viewState.set(planId,{drafts:new Map(),cards:new Map(),details:new Map(),errors:new Map(),sequence:0});return viewState.get(planId);}
  function fieldKey(control){return control.dataset.draftField||control.getAttribute("aria-label")||control.name;}
  function captureDrafts(container){const planId=container.dataset.planId||root.dataset.planId;if(!planId)return;const state=stateFor(planId);for(const form of container.querySelectorAll("[data-tracker-form]")){const values={};for(const control of form.querySelectorAll("input,textarea,select")){const key=fieldKey(control);if(key&&control.dataset.draftDirty==="true")values[key]={value:control.value,checked:control.checked,sequence:Number(control.dataset.draftSequence)||0};}if(Object.keys(values).length)state.drafts.set(form.dataset.trackerForm,values);else state.drafts.delete(form.dataset.trackerForm);}for(const disclosure of container.querySelectorAll("details[data-tracker-disclosure]"))state.details.set(disclosure.dataset.trackerDisclosure,disclosure.open);}
  function restoreDrafts(container){const planId=container.dataset.planId||root.dataset.planId;if(!planId||planId!==root.dataset.planId)return;const state=stateFor(planId);for(const form of container.querySelectorAll("[data-tracker-form]")){const values=state.drafts.get(form.dataset.trackerForm);if(!values)continue;for(const control of form.querySelectorAll("input,textarea,select")){const saved=values[fieldKey(control)];if(!saved)continue;control.dataset.draftDirty="true";control.dataset.draftSequence=String(saved.sequence||0);control.value=saved.value;if(control.type==="checkbox"||control.type==="radio")control.checked=saved.checked;control.dispatchEvent(new Event("change",{bubbles:false}));}}for(const disclosure of container.querySelectorAll("details[data-tracker-disclosure]")){if(state.details.has(disclosure.dataset.trackerDisclosure))disclosure.open=state.details.get(disclosure.dataset.trackerDisclosure);}}
  function draftForm(form,key){form.dataset.trackerForm=key;return form;}
  function snapshotDraft(form,planId){const fields={};for(const control of form.querySelectorAll("input,textarea,select")){const key=fieldKey(control);if(key)fields[key]={value:control.value,checked:control.checked,sequence:Number(control.dataset.draftSequence)||0};}return {planId,formKey:form.dataset.trackerForm,fields};}
  function sameDraftField(value,submitted){return value&&submitted&&value.sequence===submitted.sequence&&value.value===submitted.value&&value.checked===submitted.checked;}
  function clearDraft(submission){if(!submission?.planId||!submission.formKey)return;const state=stateFor(submission.planId),values=state.drafts.get(submission.formKey);if(values){for(const [key,submitted] of Object.entries(submission.fields))if(sameDraftField(values[key],submitted))delete values[key];if(!Object.keys(values).length)state.drafts.delete(submission.formKey);}if(root.dataset.planId!==submission.planId)return;for(const form of root.querySelectorAll("[data-tracker-form]")){if(form.dataset.trackerForm!==submission.formKey)continue;for(const control of form.querySelectorAll("input,textarea,select")){const value={value:control.value,checked:control.checked,sequence:Number(control.dataset.draftSequence)||0};if(sameDraftField(value,submission.fields[fieldKey(control)])){delete control.dataset.draftDirty;delete control.dataset.draftSequence;}}}}
  function markDraft(event){if(event.target.matches("input,textarea,select")&&event.target.closest("[data-tracker-form]")){event.target.dataset.draftDirty="true";event.target.dataset.draftSequence=String(++stateFor(root.dataset.planId).sequence);captureDrafts(root);}}root.addEventListener("input",markDraft);root.addEventListener("change",markDraft);
  window.addEventListener("plan-time-tracker:plan-will-render",()=>captureDrafts(root));
  window.addEventListener("plan-time-tracker:draft-submitted",event=>{const detail=event.detail||{};if(detail.form&&detail.planId)detail.submission=snapshotDraft(detail.form,detail.planId);});
  window.addEventListener("plan-time-tracker:draft-cleared",event=>clearDraft(event.detail?.submission));
  function setMessage(target,text,error){target.textContent=text||"";target.classList.toggle("error",Boolean(error));}
  function status(value){return statusNames[value]||value||"Неизвестно";}
  let leaseRefreshTimer=null,observedServerNow=0,observedMonotonicNow=0;
  const serverTime=()=>observedServerNow+Math.max(0,performance.now()-observedMonotonicNow);
  function watchLeaseExpiry(snapshot){clearTimeout(leaseRefreshTimer);const remaining=(snapshot.steps||[]).flatMap(step=>step.attempts||[]).filter(attempt=>attempt.status==="OPEN"&&attempt.lease_until>snapshot.serverNow).map(attempt=>attempt.lease_until-snapshot.serverNow);if(remaining.length)leaseRefreshTimer=setTimeout(()=>{if(root.dataset.planId===snapshot.plan.planId)renderTracker(true).catch(()=>{});},Math.max(1,Math.min(...remaining)+10));}
  function stepStatus(step){if(step.status==="RUNNING"){if(step.execution?.planStatus==="PAUSED")return "План на паузе";const labels={LEASE_EXPIRED:"Срок попытки истёк",ATTEMPT_CLOSED:"Нужна новая попытка",ATTEMPT_MISSING:"Нужна новая попытка",AWAITING_START:"Попытка ожидает запуска"};if(labels[step.execution?.state])return labels[step.execution.state];}return step.status==="DONE"?(step.readyToFinish?"Готов к завершению":"Не готов к завершению"):status(step.status);}
  function resultSource(result){if(result.protectedRevisionHidden)return "Основание исторического результата скрыто.";if(result.snapshot_digest)return "Снимок файлов · "+result.snapshot_digest+" · формат "+result.snapshot_format_version;if(result.source_kind==="HISTORICAL")return "Историческое основание результата сохранено. Новая работа требует нового снимка.";return "Основание проверок отсутствует. Для обязательных проверок нужен снимок файлов. Текст результата не заменяет запись проверок.";}
  function readinessText(step){const names={STEP_NOT_DONE:"Этап ещё не завершён",RESULT_NOT_DONE:"Нет текущего успешного результата",OPEN_ATTEMPT:"Есть открытая попытка",RESULT_SOURCE_MISSING:"Не задано основание обязательных проверок"};return (step.readinessBlockers||[]).map(item=>item.code==="CHECK_NOT_PASSED"?item.checkKey+": "+(item.status==="MISSING"?"не записана":status(item.status)):names[item.code]||item.code).join("; ");}
  function sectionFor(id){const section=make("section",null,"tracker-section");section.dataset.trackerPanel="true";section.dataset.planId=id;section.setAttribute("aria-labelledby","tracker-heading");return section;}
  function renderLegacyEvent(event){return {legacy:true,eventId:event.event_id,eventType:event.event_type,receivedAt:event.server_occurred_at,actorType:event.actor_type,reason:event.reason,version:event.version_after};}
  function renderTimeline(list,events){list.replaceChildren();if(!events.length){list.append(make("p","История пока пуста.","muted"));return;}const ordered=[...events].sort((a,b)=>Number(a.receivedAt||0)-Number(b.receivedAt||0)||(a.serverSequence||0)-(b.serverSequence||0)||String(a.eventId).localeCompare(String(b.eventId)));for(const event of ordered){const card=make("article",null,"timeline-card");card.id="tracker-event-"+event.eventId;const heading=make("h4",eventNames[event.eventType]||event.eventType);if(event.classification&&event.classification!=="NORMAL")heading.prepend(make("span",event.classification,"tracker-marker "+event.classification));card.append(heading);card.append(make("time","Получено сервером: "+date(event.receivedAt)));if(!event.legacy&&event.occurredAt!=null)card.append(make("time","Время клиента: "+date(event.occurredAt)));if(event.serverSequence!=null)card.append(make("p","Серверная последовательность: "+event.serverSequence,"tracker-meta"));if(event.legacy){card.append(make("p","Автор: "+(event.actorType||"не указан")+(event.version!=null?" · версия плана "+event.version:""),"tracker-meta"));if(event.reason)card.append(make("p","Причина: "+event.reason));}else if(event.payload&&event.payload.data&&Object.keys(event.payload.data).length){card.append(make("p",JSON.stringify(event.payload.data),"tracker-meta"));}if(event.correctionOfEventId){const link=make("a","Исправляет событие "+event.correctionOfEventId);link.href="#tracker-event-"+event.correctionOfEventId;card.append(link);}list.append(card);}}
  let renderToken=0,loadingPlanId=null,pendingSuccessFeedback="",pendingSuccessPlanId=null;
  async function renderTracker(force){const planId=root.dataset.planId;if(!planId)return;if(pendingSuccessPlanId!==planId){pendingSuccessFeedback="";pendingSuccessPlanId=planId;}const current=root.querySelector("[data-tracker-panel]");if(!force&&current&&current.dataset.planId===planId)return;if(!force&&loadingPlanId===planId)return;const token=++renderToken;loadingPlanId=planId;if(current){captureDrafts(current);const prior=current.querySelector('[role="status"][aria-live="polite"]');if(current.dataset.planId===planId&&prior&&prior.textContent.trim()&&prior.textContent!=="Загружаю состояние checkpoint…"&&!prior.classList.contains("error"))pendingSuccessFeedback=prior.textContent;current.remove();}const panel=sectionFor(planId),heading=make("h3","Контрольные этапы"),refresh=make("button","Обновить состояние этапов");refresh.type="button";refresh.addEventListener("click",()=>renderTracker(true));heading.id="tracker-heading";panel.append(heading,refresh);const message=make("p","Загружаю состояние checkpoint…","muted");message.setAttribute("role","status");message.setAttribute("aria-live","polite");panel.append(message);root.append(panel);
    try{const [snapshot,legacy]=await Promise.all([api("/api/tracker/plans/"+encodeURIComponent(planId)+"/execution"),api("/api/plans/"+encodeURIComponent(planId))]);if(token!==renderToken||root.dataset.planId!==planId)return;observedServerNow=snapshot.serverNow;observedMonotonicNow=performance.now();watchLeaseExpiry(snapshot);panel.replaceChildren(heading,refresh);panel.append(message);setMessage(message,"");if(pendingSuccessFeedback){setMessage(message,pendingSuccessFeedback);pendingSuccessFeedback="";}window.dispatchEvent(new CustomEvent("plan-time-tracker:completion-updated",{detail:snapshot.plan}));const steps=snapshot.steps||[];const incompletes=steps.filter((step)=>!step.readyToFinish);if(!snapshot.enabled)panel.append(make("p","Трекер включится при создании первого checkpoint. Таймер плана не меняется.","tracker-meta"));panel.append(make("p","Активное время определяется только интервалами плана: "+duration(snapshot.plan.activeMs)+". Попытки не складываются с таймером.","tracker-meta"));const bottlenecks=snapshot.bottlenecks||{},checkDelay=bottlenecks.checkDelay||{};const checkDelayText=checkDelay.sampleCount?duration(checkDelay.medianMs)+" медиана, выборка "+checkDelay.sampleCount:"нет данных";panel.append(make("p","Сводка: блокировок "+(bottlenecks.blockedEvents||0)+" · попыток после первой "+(bottlenecks.retries||0)+" (включая восстановление и доработку) · неуспешных результатов "+(bottlenecks.failedResults||0)+" · задержка до первой проверки "+checkDelayText+". Задержка показывает время между записью результата и первой записью проверки на сервере, а не длительность выполнения теста.","tracker-meta"));
      if(["PLANNED","RUNNING"].includes(snapshot.plan.status)){const form=make("form",null,"tracker-form"),ordinal=inputField("Порядок",{type:"number",required:true,value:String(Math.max(0,...steps.map(step=>Number(step.ordinal)||0))+1)}),title=inputField("Название checkpoint",{required:true,maxLength:200}),expected=inputField("Ожидаемый результат",{tag:"textarea",required:true,maxLength:4000,rows:3}),checks=inputField("Обязательные проверки · через запятую",{maxLength:2100,placeholder:"unit, build"}),submit=make("button","Добавить checkpoint","primary");submit.type="submit";draftForm(form,"create-step");form.append(ordinal.wrap,title.wrap,expected.wrap,checks.wrap,submit);form.addEventListener("submit",async(event)=>{event.preventDefault();const submittedDraft=snapshotDraft(form,planId);submit.disabled=true;try{await command("CreateStep",{planId:planId,ordinal:Number(ordinal.control.value),title:title.control.value,expectedResult:expected.control.value,requiredChecks:checks.control.value.split(",").map((value)=>value.trim()).filter(Boolean)});clearDraft(submittedDraft);setMessage(message,"Checkpoint добавлен. Таймер плана не запускался.");await renderTracker(true);}catch(error){setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{submit.disabled=false;}});panel.append(form);}
      const stepList=make("div",null,"tracker-list");if(!steps.length)stepList.append(make("p","В этом плане пока нет checkpoint.","muted"));for(const step of steps)stepList.append(renderStep(step,snapshot.plan,planId,message,()=>renderTracker(true)));panel.append(stepList);if(steps.length){const collapseActions=make("div",null,"tracker-collapse-actions");for(const [label,expanded] of [["Свернуть все",false],["Развернуть все",true]]){const button=make("button",label);button.type="button";button.addEventListener("click",()=>stepList.querySelectorAll("[data-checkpoint-toggle]").forEach(toggle=>toggle.setExpanded(expanded)));collapseActions.append(button);}stepList.before(collapseActions);}restoreDrafts(panel);
      if(incompletes.length&&["RUNNING","PAUSED"].includes(snapshot.plan.status)){const finishForm=make("form",null,"tracker-form"),finishReason=inputField("Причина явного завершения с незакрытыми checkpoint",{tag:"textarea",required:true,maxLength:1000,rows:2}),finish=make("button","Завершить план с исключением","danger");finish.type="submit";draftForm(finishForm,"finish-exception");finishForm.append(make("p","Условия завершения не выполнены: "+incompletes.map((step)=>step.title+(readinessText(step)?" — "+readinessText(step):"")).join("; ")),finishReason.wrap,finish);finishForm.addEventListener("submit",async(event)=>{event.preventDefault();if(!window.confirm("Завершить план с зафиксированным исключением? Таймер будет остановлен."))return;let accepted=false;const submittedDraft=snapshotDraft(finishForm,planId);finish.disabled=true;try{await command("FinishPlan",{planId:planId,allowIncomplete:true,reason:finishReason.control.value},snapshot.plan.version);accepted=true;clearDraft(submittedDraft);setMessage(message,"План завершён с сохранённым исключением.");await renderTracker(true);try{await refreshAcceptedPlan(planId,"План завершён с сохранённым исключением.");}catch{if(root.dataset.planId===planId)setMessage(root.querySelector("[data-tracker-panel] [role=status]")||message,"План завершён, но данные не обновились. Перезагрузите страницу.",true);}}catch(error){setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{finish.disabled=accepted;}});panel.append(finishForm);restoreDrafts(finishForm.parentElement);}
      const timelineHeading=make("h4","История плана и observations"),timelineList=make("div",null,"tracker-timeline"),timelineActions=make("div",null,"tracker-timeline-actions"),more=make("button","Загрузить следующие события");more.type="button";more.hidden=true;const timelineMessage=make("p","Загружаю историю…","muted");timelineMessage.setAttribute("role","status");timelineMessage.setAttribute("aria-live","polite");panel.append(timelineHeading,timelineMessage,timelineList,timelineActions);const trackerEvents=[],legacyEvents=(legacy.plan.events||[]).map(renderLegacyEvent).map((event)=>({...event,legacy:true}));let cursor=0,hasMore=false,timelineBusy=false;
      async function loadTimeline(reset){if(timelineBusy)return;timelineBusy=true;more.disabled=true;try{const page=await api("/api/tracker/plans/"+encodeURIComponent(planId)+"/timeline?afterSequence="+(reset?0:cursor)+"&limit=50");if(reset)trackerEvents.length=0;trackerEvents.push(...page.events);cursor=page.nextCursor;hasMore=page.hasMore;renderTimeline(timelineList,[...legacyEvents,...trackerEvents]);more.hidden=!hasMore;setMessage(timelineMessage,hasMore?"Показаны события до серверной последовательности "+cursor+".":"История загружена.");}catch(error){setMessage(timelineMessage,(error.code||"ERROR")+": "+error.message,true);}finally{timelineBusy=false;more.disabled=false;}}
      more.addEventListener("click",()=>loadTimeline(false));timelineActions.append(more);await loadTimeline(true);
    }catch(error){if(token===renderToken)setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{if(token===renderToken)loadingPlanId=null;}}
  function renderStep(step,plan,planId,message,reload){const card=make("article",null,"tracker-card"),heading=make("h4"),toggle=make("button",null,"tracker-card-toggle"),title=make("strong",step.title),statusLabel=make("span",stepStatus(step),"tracker-card-status"),indicator=make("span"),summary=make("p",null,"tracker-meta tracker-card-summary"),body=make("div",null,"tracker-card-body"),cardError=make("p",null,"error tracker-card-error");card.dataset.stepId=step.step_id;body.id="tracker-card-"+encodeURIComponent(planId)+"-"+encodeURIComponent(step.step_id);toggle.type="button";toggle.dataset.checkpointToggle=step.step_id;toggle.setAttribute("aria-controls",body.id);toggle.setAttribute("aria-label",step.title+" · "+stepStatus(step));indicator.setAttribute("aria-hidden","true");toggle.append(title,statusLabel,indicator);heading.append(toggle);cardError.setAttribute("role","alert");const state=stateFor(planId),setExpanded=(expanded)=>{state.cards.set(step.step_id,expanded);toggle.setAttribute("aria-expanded",String(expanded));body.hidden=!expanded;indicator.textContent=expanded?"▾":"▸";};toggle.setExpanded=setExpanded;setExpanded(state.cards.has(step.step_id)?state.cards.get(step.step_id):(["RUNNING","BLOCKED","FAILED"].includes(step.status)||(step.status==="DONE"&&!step.readyToFinish)));toggle.addEventListener("click",()=>setExpanded(toggle.getAttribute("aria-expanded")!=="true"));const currentChecks=step.currentChecks||[],passed=step.requiredChecks.filter(key=>currentChecks.some(check=>check.check_key===key&&check.status==="PASSED"&&check.matchesCurrentResult)).length;summary.textContent=(step.requiredChecks.length?"Проверки: "+passed+"/"+step.requiredChecks.length:"Обязательные проверки не заданы")+" · "+(step.readyToFinish?"Готов к завершению":"Не готов к завершению");card.append(heading,summary,cardError,body);if(!step.readyToFinish&&readinessText(step))card.insertBefore(make("p",readinessText(step),"tracker-meta tracker-blockers"),body);const reportCardError=(error)=>{const text=(error.code||"ERROR")+": "+error.message;setMessage(message,text,true);state.errors.set(step.step_id,text);setMessage(cardError,text,true);setExpanded(true);};const clearCardError=()=>{state.errors.delete(step.step_id);setMessage(cardError,"");};if(state.errors.has(step.step_id))setMessage(cardError,state.errors.get(step.step_id),true);card.addEventListener("invalid",event=>reportCardError({code:"VALIDATION_ERROR",message:event.target.validationMessage||"Проверьте заполнение полей."}),true);body.append(make("p","№"+step.ordinal+" · версия "+step.version,"tracker-meta"),make("p","Ожидаемый результат: "+step.expected_result));body.append(make("p","Обязательные проверки: "+(step.requiredChecks.length?step.requiredChecks.join(", "):"не заданы"),"tracker-meta"));
    const result=step.currentResult;if(result){body.append(make("p","Результат r"+result.revision+": "+status(result.outcome)+" · "+result.summary));body.append(make("p",resultSource(result),"tracker-meta tracker-revision"));}
    if(step.resultHistory.length>1){const history=make("details"),summary=make("summary","История результатов ("+step.resultHistory.length+")");history.dataset.trackerDisclosure=step.step_id+":result-history";history.append(summary);step.resultHistory.forEach((item)=>history.append(make("p","r"+item.revision+" · "+status(item.outcome)+" · "+item.summary+" · "+resultSource(item)+" · "+date(item.created_at))));body.append(history);}
    const checks=make("div",null,"tracker-meta");checks.append(make("strong","Записанные проверки"));if(!step.checks.length)checks.append(make("p","Проверки по этой ревизии ещё не записаны."));step.checks.forEach((check)=>checks.append(make("p","r"+check.result_revision+" · "+check.check_key+" · "+status(check.status)+" · "+(check.tested_snapshot_digest?"снимок "+check.tested_snapshot_digest:"историческое основание")+" · "+(currentChecks.some(item=>item.check_id===check.check_id)?"текущая запись":"история")+(check.exit_code==null?"":" · exit "+check.exit_code)+(check.evidence_summary?" · "+check.evidence_summary:""))));body.append(checks);
    const attempts=make("details"),attemptHeading=make("summary","Попытки ("+step.attempts.length+")");attempts.dataset.trackerDisclosure=step.step_id+":attempts";attempts.append(attemptHeading);step.attempts.forEach((attempt)=>{const reworkText=attempt.rework_reason?" · доработка владельца: "+attempt.rework_reason:"";attempts.append(make("p",(attempt.status==="OPEN"&&attempt.lease_until<=serverTime()?"Срок истёк":status(attempt.status))+" · fence "+attempt.fence+" · lease до "+date(attempt.lease_until)+reworkText));});body.append(attempts);
    if(["PLANNED","RUNNING"].includes(plan.status)&&step.status!=="RUNNING"&&!step.attempts.some((attempt)=>attempt.status==="OPEN")){const edit=make("details"),editSummary=make("summary","Изменить checkpoint и требования");edit.dataset.trackerDisclosure=step.step_id+":edit";edit.append(editSummary);const form=make("form",null,"tracker-form"),title=inputField("Название checkpoint",{required:true,maxLength:200,value:step.title}),expected=inputField("Ожидаемый результат",{tag:"textarea",required:true,maxLength:4000,rows:3,value:step.expected_result}),checks=inputField("Обязательные проверки · через запятую",{maxLength:2100,value:step.requiredChecks.join(", ")}),reason=inputField("Причина изменения checkpoint",{required:true,maxLength:1000}),save=make("button","Сохранить новую редакцию checkpoint","primary");save.type="submit";draftForm(form,"edit:"+step.step_id);form.append(title.wrap,expected.wrap,checks.wrap,reason.wrap,save);form.addEventListener("submit",async(event)=>{event.preventDefault();const submittedDraft=snapshotDraft(form,planId);save.disabled=true;try{await command("UpdateStep",{stepId:step.step_id,changes:{title:title.control.value,expectedResult:expected.control.value,requiredChecks:checks.control.value.split(",").map((value)=>value.trim()).filter(Boolean)},reason:reason.control.value},step.version);clearCardError();clearDraft(submittedDraft);setMessage(message,"Checkpoint обновлён; предыдущие результаты остаются в истории.");await reload();}catch(error){reportCardError(error);}finally{save.disabled=false;}});edit.append(form);body.append(edit);}
    const actions=make("div",null,"tracker-actions");const candidateAttempt=step.attempts.find((attempt)=>attempt.status==="OPEN"&&attempt.fence===step.current_fence),openAttempt=candidateAttempt&&candidateAttempt.lease_until>serverTime()?candidateAttempt:null,expiredAttempt=candidateAttempt&&!openAttempt?candidateAttempt:null;
    if(step.status==="RUNNING"&&!openAttempt)body.append(make("p",expiredAttempt?"Срок попытки истёк. Для продолжения нужна новая попытка.":"Предыдущая попытка закрыта. Для продолжения начните новую попытку.","tracker-meta"),make("p",plan.status==="PAUSED"?"План на паузе. Продолжите план явной командой перед восстановлением этапа.":"Таймер плана продолжает идти до явной паузы или завершения. Восстановление попытки не меняет интервалы.","tracker-meta"));
    if(plan.status==="PAUSED"&&step.status==="RUNNING"){const resume=make("button","Продолжить план");resume.type="button";resume.addEventListener("click",async()=>{resume.disabled=true;try{await command("ResumePlan",{planId:planId},plan.version);clearCardError();await reload();await refreshAcceptedPlan(planId,"План продолжен явной командой. При необходимости начните новую попытку.");}catch(error){reportCardError(error);}finally{resume.disabled=false;}});actions.append(resume);}
    if(plan.status==="RUNNING"&&openAttempt){const renew=make("button","Продлить lease на 10 минут");renew.type="button";renew.addEventListener("click",async()=>{renew.disabled=true;try{await command("RenewStepLease",{stepId:step.step_id,attemptId:openAttempt.attempt_id,fence:openAttempt.fence});clearCardError();setMessage(message,"Lease продлён сервером; таймер плана не менялся.");await reload();}catch(error){reportCardError(error);}finally{renew.disabled=false;}});actions.append(renew);}
    if(plan.status==="RUNNING"&&(!openAttempt||!openAttempt.stepStarted)&&["PENDING","BLOCKED","FAILED","DONE","RUNNING"].includes(step.status)){
      const rework=inputField("Причина доработки от владельца (обязательна для DONE)",{maxLength:1000,value:expiredAttempt&&expiredAttempt.rework_reason||""});rework.wrap.hidden=step.status!=="DONE";if(step.status==="DONE"){draftForm(rework.wrap,"rework:"+step.step_id);body.append(rework.wrap);}const start=make("button",expiredAttempt?"Начать новую попытку после истечения срока":step.status==="RUNNING"&&!openAttempt?"Начать новую попытку":openAttempt&&!openAttempt.stepStarted?"Запустить назначенную попытку":step.status==="DONE"?"Назначить и начать доработку":"Захватить попытку и начать");start.type="button";start.className="primary";start.addEventListener("click",async()=>{start.disabled=true;try{await settleAttemptCommands(step.step_id);const latest=await api("/api/tracker/plans/"+encodeURIComponent(planId)+"/execution"),current=latest.steps.find(item=>item.step_id===step.step_id);if(!current||latest.plan.status!=="RUNNING")throw new Error("Обновите план: работа сейчас не запущена.");const live=current.attempts.find(item=>item.fence===current.current_fence&&item.status==="OPEN"&&item.lease_until>latest.serverNow);if(live?.stepStarted){clearCardError();setMessage(message,"Попытка уже запущена; состояние обновлено.");await reload();return;}let attempt=live;if(!attempt){const payload={stepId:step.step_id,sessionId:getSessionId(),sourceId:"sites-owner-ui",clientType:"UNKNOWN"};if(current.status==="RUNNING")payload.recoveryReason="Владелец явно продолжил этап новой попыткой.";if(step.status==="DONE"){if(!rework.control.value.trim())throw new Error("Для DONE укажите явную причину доработки владельца.");payload.reworkReason=rework.control.value.trim();}const claimed=await command("ClaimStepAttempt",payload,current.version);attempt={attempt_id:claimed.attemptId,fence:claimed.fence,rework_reason:step.status==="DONE"?rework.control.value.trim():null};}const startPayload={stepId:step.step_id,attemptId:attempt.attempt_id,fence:attempt.fence};if(attempt.rework_reason){startPayload.rework=true;startPayload.reason=attempt.rework_reason;}await command("StartStep",startPayload,current.version);clearCardError();setMessage(message,"Checkpoint запущен отдельной явной командой.");await reload();}catch(error){reportCardError(error);}finally{start.disabled=false;}});actions.append(start);}
    if(plan.status==="RUNNING"&&step.status==="RUNNING"&&openAttempt&&openAttempt.stepStarted){const blockReason=inputField("Причина блокировки",{required:true,maxLength:1000});const block=make("button","Заблокировать");block.type="button";block.addEventListener("click",async()=>{if(!blockReason.control.reportValidity())return;block.disabled=true;try{await command("BlockStep",{stepId:step.step_id,attemptId:openAttempt.attempt_id,fence:openAttempt.fence,reason:blockReason.control.value},step.version);clearCardError();setMessage(message,"Checkpoint заблокирован с указанной причиной.");await reload();}catch(error){reportCardError(error);}finally{block.disabled=false;}});draftForm(blockReason.wrap,"block:"+step.step_id);body.append(blockReason.wrap);actions.append(block);}
    if(plan.status==="RUNNING"&&step.status==="RUNNING"&&openAttempt&&openAttempt.stepStarted){const resultForm=make("form",null,"tracker-form"),outcome=selectField("Результат попытки",["DONE","FAILED"],"DONE"),summary=inputField("Краткий результат",{tag:"textarea",required:true,maxLength:4000,rows:2}),snapshotDigest=inputField("Digest снимка файлов",{maxLength:71,placeholder:"sha256:64 hex символа"}),save=make("button","Записать результат");save.type="submit";draftForm(resultForm,"result:"+step.step_id);resultForm.append(outcome.wrap,summary.wrap,make("p","Обязательные проверки относятся к снимку файлов v2. Получите digest штатным helper до и после каждой проверки.","tracker-meta"),snapshotDigest.wrap,save);resultForm.addEventListener("submit",async(event)=>{event.preventDefault();const submittedDraft=snapshotDraft(resultForm,planId);save.disabled=true;try{const payload={stepId:step.step_id,attemptId:openAttempt.attempt_id,fence:openAttempt.fence,outcome:outcome.control.value,summary:summary.control.value};if(snapshotDigest.control.value)payload.sourceSnapshot={kind:"SOURCE_SNAPSHOT",formatVersion:2,digest:snapshotDigest.control.value};await command("RecordStepResult",payload,step.version);clearCardError();clearDraft(submittedDraft);setMessage(message,"Результат записан. Готовность определяется проверками текущей ревизии и её снимка.");await reload();}catch(error){reportCardError(error);}finally{save.disabled=false;}});body.append(resultForm);}

    if(result&&result.snapshot_digest&&!result.protectedRevisionHidden){const currentChecks=step.currentChecks||[];for(const checkKey of step.requiredChecks){const previousCheck=currentChecks.find((check)=>check.check_key===checkKey);const form=make("form",null,"tracker-form"),title=make("strong","Записать check: "+checkKey),statusSelect=selectField("Статус проверки",["PASSED","FAILED","NOT_RUN"],previousCheck?previousCheck.status:"PASSED"),shaField=inputField("Digest проверенного снимка",{required:true,maxLength:71,value:previousCheck?previousCheck.tested_snapshot_digest:result.snapshot_digest}),exit=inputField("Код завершения",{type:"number",value:previousCheck&&previousCheck.exit_code!=null?String(previousCheck.exit_code):"0"}),evidence=inputField("Краткая evidence summary",{tag:"textarea",maxLength:2000,rows:2,value:previousCheck&&previousCheck.evidence_summary||""}),save=make("button",previousCheck?"Записать новую ревизию check":"Сохранить check");save.type="submit";draftForm(form,"check:"+step.step_id+":"+result.revision+":"+checkKey);form.append(title,statusSelect.wrap,shaField.wrap,exit.wrap,evidence.wrap,save);statusSelect.control.addEventListener("change",()=>{exit.control.disabled=statusSelect.control.value==="NOT_RUN";if(statusSelect.control.value==="PASSED")exit.control.value="0";if(statusSelect.control.value==="FAILED"&&Number(exit.control.value)<1)exit.control.value="1";});exit.control.disabled=statusSelect.control.value==="NOT_RUN";form.addEventListener("submit",async(event)=>{event.preventDefault();const submittedDraft=snapshotDraft(form,planId);save.disabled=true;try{const checkStatus=statusSelect.control.value,payload={stepId:step.step_id,resultRevision:result.revision,checkKey:checkKey,status:checkStatus,evidenceSummary:evidence.control.value};payload.testedSnapshotDigest=shaField.control.value;if(checkStatus!=="NOT_RUN")payload.exitCode=Number(exit.control.value);await command("RecordCheck",payload);clearCardError();clearDraft(submittedDraft);setMessage(message,"Результат проверки сохранён для текущей ревизии.");await reload();}catch(error){reportCardError(error);}finally{save.disabled=false;}});body.append(form);}}
    body.append(actions);for(const disclosure of body.querySelectorAll("details[data-tracker-disclosure]"))disclosure.addEventListener("toggle",()=>state.details.set(disclosure.dataset.trackerDisclosure,disclosure.open));restoreDrafts(card);return card;}
  window.addEventListener("plan-time-tracker:plan-rendered",event=>{if(event.detail?.planId===root.dataset.planId)restoreDrafts(root);if(event.detail?.planId===root.dataset.planId&&event.detail.successMessage){pendingSuccessPlanId=event.detail.planId;pendingSuccessFeedback=event.detail.successMessage;}});
  const observer=new MutationObserver(()=>{renderTracker(false).catch(()=>{});});observer.observe(root,{childList:true});
})();`;

const UI_ACCESSIBILITY = String.raw`(()=>{
 const modal=document.querySelector('#modal');
 document.addEventListener('keydown',event=>{
  if(modal.classList.contains('hidden'))return;
  if(event.key==='Escape'){event.preventDefault();document.querySelector('#cancel').click();return;}
  if(event.key!=='Tab')return;
  const nodes=[...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')].filter(x=>x.getClientRects().length);
  const first=nodes[0],last=nodes[nodes.length-1];
  if(!first){event.preventDefault();return;}
  if(event.shiftKey&&(document.activeElement===first||!modal.contains(document.activeElement))){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&(document.activeElement===last||!modal.contains(document.activeElement))){event.preventDefault();first.focus();}
 });
 const wrapped=new WeakMap();
 function protectForms(){document.querySelectorAll('form').forEach(form=>{
  if(!form.onsubmit||wrapped.get(form)===form.onsubmit)return;
  const original=form.onsubmit;
  const handler=async function(event){
   event.preventDefault();if(form.getAttribute('aria-busy')==='true')return;
   form.setAttribute('aria-busy','true');
   const controls=[...form.querySelectorAll('button')].map(x=>[x,x.disabled]);controls.forEach(([x])=>x.disabled=true);
   let error=form.querySelector('.form-error');if(!error){error=document.createElement('div');error.className='form-error';error.setAttribute('role','alert');form.append(error);}error.textContent='';
   try{await original.call(form,event);}catch(e){error.textContent=e.message||'Не удалось сохранить. Попробуйте ещё раз.';}
   finally{form.removeAttribute('aria-busy');controls.forEach(([x,disabled])=>x.disabled=disabled||(form.id==='sync'&&form.dataset.githubAvailable!=='true'));}
  };form.onsubmit=handler;wrapped.set(form,handler);
 });}
 protectForms();new MutationObserver(protectForms).observe(document.body,{childList:true,subtree:true});
})();`;

function uiHtml() {
  return [
    "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light\"><title>Трекер планов</title>",
    "<style>:root{font-family:Inter,system-ui,sans-serif;color:#18212b;background:#f5f7fa;--muted:#657180;--line:#e2e7ec;--green:#14775e;--panel:#fff}*{box-sizing:border-box}body{margin:0}.shell{max-width:1100px;margin:auto;padding:34px 22px 70px}.top{display:flex;justify-content:space-between;gap:20px;margin-bottom:25px}.eyebrow{font-size:.75rem;letter-spacing:.14em;color:var(--green);font-weight:800;text-transform:uppercase}h1{letter-spacing:-.04em;font-size:clamp(1.7rem,4vw,2.3rem);margin:.35rem 0}.muted{color:var(--muted)}button,input,textarea,select{font:inherit}button{border:0;border-radius:9px;padding:.65rem .9rem;font-weight:700;cursor:pointer;background:#e8edf1;color:#18212b}button:focus-visible,.row[role=button]:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #579ce0;outline-offset:2px}.primary{background:var(--green);color:white}.danger{color:#a43830;background:#fae9e7}.nav{display:flex;gap:7px;border-bottom:1px solid var(--line);margin-bottom:21px;overflow:auto}.nav button{background:none;color:var(--muted);white-space:nowrap;border-radius:0;border-bottom:2px solid transparent}.nav button[aria-current=page]{color:#18212b;border-color:var(--green)}.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:16px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:20px;margin-bottom:16px}h2{font-size:1.1rem;margin:0 0 14px}.current{min-height:210px}.timer{font-size:clamp(2rem,6vw,3rem);font-weight:780;letter-spacing:-.06em;font-variant-numeric:tabular-nums;margin:15px 0}.badge{display:inline-block;border-radius:99px;padding:.3rem .58rem;background:#e6f3ed;color:#176b54;font-size:.78rem;font-weight:750}.badge.paused{background:#fff3dd;color:#8d6015}.badge.completed{background:#edf0f3;color:#5f6973}.actions,.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.metric{border:1px solid var(--line);border-radius:11px;padding:13px}.metric small{display:block;color:var(--muted);margin-bottom:7px}.metric strong{font-variant-numeric:tabular-nums}.list{display:grid;gap:8px}.row{display:flex;justify-content:space-between;align-items:center;gap:12px;border:1px solid var(--line);background:white;border-radius:11px;padding:13px}.row-title{font-weight:720}.plan-open{background:transparent;color:inherit;padding:0;border-radius:0;text-align:left;font-weight:inherit;flex:1;min-width:0}.row-meta{display:block;font-size:.82rem;color:var(--muted);margin-top:4px;font-weight:400}.row-right{display:flex;gap:8px;align-items:center}.field{display:grid;gap:6px;min-width:130px;flex:1}.field label{font-weight:700;font-size:.85rem}.field input,.field textarea,.field select{border:1px solid #cbd3dc;border-radius:8px;padding:.65rem;background:white;color:#18212b}.field textarea{min-height:75px}.form{display:grid;gap:12px}.hidden{display:none!important}.notice{padding:11px 13px;border:1px solid #efd8ac;background:#fff8e9;border-radius:9px;margin:12px 0;color:#705115}.error{color:#8f332b;background:#fff0ee;border-color:#ebc5c1}.chart{display:grid;gap:8px;margin-top:16px}.barrow{display:grid;grid-template-columns:95px 1fr 75px;align-items:center;gap:9px;font-size:.82rem}.bar{height:10px;background:#edf0f3;border-radius:20px;overflow:hidden}.bar span{height:100%;display:block;background:#319578}.modal{position:fixed;inset:0;background:#17212b66;display:grid;place-items:center;padding:18px}.modalbox{background:white;border-radius:14px;padding:20px;width:min(620px,100%);max-height:90vh;overflow:auto}.toast{position:fixed;bottom:18px;right:18px;background:#253440;color:white;border-radius:9px;padding:12px 16px;max-width:min(450px,calc(100% - 36px))}.toast.error{background:#913a31;color:white}@media(max-width:720px){.shell{padding:22px 14px 55px}.grid{grid-template-columns:1fr}.panel{padding:16px}.row{align-items:flex-start}.row-right{align-items:flex-end;flex-direction:column}.barrow{grid-template-columns:75px 1fr 65px}}@media(max-width:390px){.actions button{flex:1}.top{gap:8px}}@media(max-width:600px){.metrics{grid-template-columns:1fr}} .grid>*{min-width:0}.field{min-width:0}.field input,.field select,.field textarea,.form>input,.form>textarea{width:100%;min-width:0;max-width:100%}.form>input,.form>textarea{border:1px solid #cbd3dc;border-radius:8px;padding:.65rem}.toolbar:has(.field){display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));align-items:end}.toolbar:has(.field)>button{min-height:44px}#view-overview>.panel:has(#overviewFrom)>.metrics{margin-top:16px}#view-overview>.panel:has(#overviewFrom)>.list{margin-top:16px}.row>*{min-width:0}.row-title,.row-meta,.row a,.row>span,#planDetail p,h2,h3,#who{overflow-wrap:anywhere}.nav{padding:4px}.nav button:focus-visible,a:focus-visible{outline:3px solid #579ce0;outline-offset:2px}.modal{z-index:20}.modalbox{max-height:calc(100dvh - 36px);overscroll-behavior:contain}.toast{z-index:30}button:disabled{cursor:not-allowed;opacity:.55}.form-error{color:#8f332b;background:#fff0ee;border:1px solid #ebc5c1;padding:10px;border-radius:8px}.form-error:empty{display:none}@media(max-width:600px){.top{flex-direction:column}.row{flex-wrap:wrap}.row>.plan-open{flex:1 1 100%}.row>.row-right{width:100%;justify-content:flex-start;flex-direction:row;flex-wrap:wrap}.modal{padding:10px}.modalbox{padding:16px;max-height:calc(100dvh - 20px)}.toolbar:has(.field){grid-template-columns:minmax(0,1fr)}.actions>button{min-height:44px}}#view-plans>.toolbar{margin-bottom:16px}#view-detail{display:grid;gap:16px}#view-detail>#backPlans{justify-self:start}</style></head><body><main class=\"shell\">",
    "<header class=\"top\"><div><h1>Трекер планов</h1></div><div class=\"muted\" id=\"who\">Проверка входа…</div></header>",
    "<nav class=\"nav\" aria-label=\"Разделы\"><button data-view=\"overview\" aria-current=\"page\">Обзор</button><button data-view=\"plans\">Планы</button><button data-view=\"analytics\">Аналитика</button><button data-view=\"settings\">Настройки</button></nav><div id=\"notice\" class=\"notice hidden\" role=\"status\"></div>",
    "<section id=\"view-overview\"><div class=\"grid\"><article class=\"panel current\"><h2>Текущий план</h2><div id=\"active\" class=\"muted\">Загрузка…</div></article><aside class=\"panel\"><h2>Учёт времени</h2><div class=\"metrics\"><div class=\"metric\"><small>Активно сегодня</small><strong id=\"today\">—</strong></div><div class=\"metric\"><small>Завершено за 30 дней</small><strong id=\"count\">—</strong></div></div><p class=\"muted\">Таймер считает время ночью и в выходные, пока вы не поставите его на паузу.</p><button class=\"primary\" id=\"newPlan\">Новый план</button></aside></div><article class=\"panel\"><h2>Последние планы</h2><div id=\"recent\" class=\"list\"></div></article></section>",
    "<section id=\"view-plans\" class=\"hidden\"><div class=\"toolbar\"><h2 style=\"flex:1\">Все планы</h2><button class=\"primary\" id=\"newPlan2\">Создать план</button></div><div id=\"plans\" class=\"list\"></div></section>",
    "<section id=\"view-detail\" class=\"hidden\"><button id=\"backPlans\">← К планам</button><article id=\"planDetail\" class=\"panel\"></article></section>",
    "<section id=\"view-analytics\" class=\"hidden\"><article class=\"panel\"><h2>Отчёт за период</h2><div class=\"toolbar\"><div class=\"field\"><label for=\"from\">С</label><input id=\"from\" type=\"date\" aria-label=\"Дата начала периода\"></div><div class=\"field\"><label for=\"to\">По</label><input id=\"to\" type=\"date\" aria-label=\"Дата конца периода\"></div><button class=\"primary\" id=\"apply\">Применить</button></div><div id=\"stats\" class=\"metrics\" style=\"margin-top:16px\"></div><div id=\"chart\" class=\"chart\"></div><div id=\"analyticPlans\" class=\"list\" style=\"margin-top:15px\"></div></article></section>",
    "<section id=\"view-settings\" class=\"hidden\"><div class=\"grid\"><article class=\"panel\"><h2>Настройки времени</h2><form id=\"settings\" class=\"form\"><div class=\"field\"><label for=\"tz\">Часовой пояс</label><select id=\"tz\" required>" + UI_TIME_ZONES.map((option) => "<option value=\"" + option.value + "\"" + (option.value === "Asia/Omsk" ? " selected" : "") + ">" + option.label + "</option>").join("") + "</select></div><button class=\"primary\">Сохранить</button></form><p class=\"muted\">Все отметки времени хранятся в UTC. <a href=\"/api/export\">Скачать JSON отчет</a>.</p></article></div></section>",
    "<div id=\"modal\" class=\"modal hidden\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"modalTitle\"><div class=\"modalbox\"><div class=\"toolbar\"><h2 id=\"modalTitle\" style=\"flex:1\">Новый план</h2><button id=\"close\">Закрыть</button></div><form id=\"create\" class=\"form\"><div class=\"field\"><label for=\"title\">Название</label><input id=\"title\" maxlength=\"200\" required></div><div class=\"field\"><label for=\"description\">Описание</label><textarea id=\"description\"></textarea></div><div class=\"field\"><label for=\"criteria\">Критерии приёмки</label><textarea id=\"criteria\"></textarea></div><div class=\"field\"><label for=\"createdDate\">Дата составления</label><input id=\"createdDate\" type=\"date\" required></div><div class=\"actions\"><button type=\"button\" id=\"cancel\">Отмена</button><button class=\"primary\">Создать план</button></div></form></div></div><div id=\"toast\" class=\"toast hidden\" role=\"status\" aria-live=\"polite\"></div>",
    "</main>",
    "<script>(()=>{" + UI_ANALYTICS + "const q=s=>document.querySelector(s), all=s=>[...document.querySelectorAll(s)];const supportedZones=" + JSON.stringify(UI_TIME_ZONES.map((option) => option.value)) + ";const normalizeZone=value=>supportedZones.includes(value)?value:\"Asia/Omsk\";let plans=[],active=null,currentDetailPlan=null,zone=\"Asia/Omsk\",serverNow=Date.now(),pending=new Map(),rejectedValidation=new Set(),rejectedVersion=new Map(),analyticsRequestId=0,detailRequestId=0,timer,modalReturnFocus=null;const uid=()=>crypto.randomUUID();const dateLocal=d=>{const value=Object.fromEntries(new Intl.DateTimeFormat(\"en-CA\",{timeZone:zone,year:\"numeric\",month:\"2-digit\",day:\"2-digit\"}).formatToParts(d).map(part=>[part.type,part.value]));return value.year+\"-\"+value.month+\"-\"+value.day};const duration=n=>{if(n==null)return\"—\";n=Math.max(0,Math.round(n/60000));const day=Math.floor(n/1440),h=Math.floor(n%1440/60),m=n%60;return day?day+\" д \"+h+\" ч \"+m+\" мин\":h?h+\" ч \"+m+\" мин\":m+\" мин\"};const formatPlanSample=n=>{const count=Number(n)||0,lastTwo=count%100;return\"по \"+count+\" \"+((lastTwo>=11&&lastTwo<=14)||count%10!==1?\"планам\":\"плану\")};const dateFmt=n=>n==null?\"—\":new Intl.DateTimeFormat(\"ru-RU\",{dateStyle:\"medium\",timeStyle:\"short\",timeZone:zone}).format(new Date(n));const statusText=status=>({PLANNED:\"Запланирован\",RUNNING:\"Выполняется\",PAUSED:\"На паузе\",COMPLETED:\"Завершён\"})[status]||status;function showToast(t,err){const x=q(\"#toast\");x.textContent=t;x.classList.toggle(\"error\",!!err);x.classList.remove(\"hidden\");clearTimeout(timer);timer=setTimeout(()=>x.classList.add(\"hidden\"),4500)}async function call(path,opt){const r=await fetch(path,{...opt,headers:{\"content-type\":\"application/json\",...(opt&&opt.headers||{})},cache:\"no-store\"});let v={};try{v=await r.json()}catch{}if(!r.ok){const e=new Error(v.error&&v.error.message||\"HTTP \"+r.status);e.status=r.status;e.code=v.error&&v.error.code;e.details=v.error&&v.error.details;throw e}return v}const rejectedTerminal=new Set();async function hasFinalPlanRejection(type,envelope,error){if(error.status!==409||!((type===\"FinishPlan\"&&error.code===\"CHECKPOINTS_INCOMPLETE\")))return false;try{const receipt=await call(\"/api/tracker/commands/\"+encodeURIComponent(envelope.commandId));return receipt.status===\"FINAL\"&&receipt.commandId===envelope.commandId&&receipt.commandType===envelope.commandType&&receipt.error?.code===error.code&&!receipt.result}catch{return false}}function makeCmd(type,plan,payload){const key=type+\":\"+(plan?plan.planId:\"new\"),nextPayload={...(plan?{planId:plan.planId}:{}),...(payload||{})};let c=pending.get(key);const newVersion=plan?plan.version:undefined;if(c&&rejectedTerminal.has(key)){c=null;pending.delete(key);rejectedTerminal.delete(key)}if(c&&rejectedValidation.has(key)&&JSON.stringify(c.payload)!==JSON.stringify(nextPayload)){c=null;pending.delete(key);rejectedValidation.delete(key)}if(c&&rejectedVersion.has(key)&&c.expectedVersion!==newVersion){c=null;pending.delete(key);rejectedVersion.delete(key)}if(c&&JSON.stringify(c.payload)!==JSON.stringify(nextPayload)){const e=new Error(\"Исход предыдущей команды неизвестен. Повторите её без изменения данных или обновите состояние перед новой командой.\");e.code=\"COMMAND_OUTCOME_UNKNOWN\";throw e}if(!c){c={schemaVersion:1,commandId:uid(),commandType:type,expectedVersion:newVersion,payload:nextPayload};pending.set(key,c)}return [key,c]}async function command(type,plan,payload){let prepared;try{prepared=makeCmd(type,plan,payload)}catch(e){showToast((e.code||\"ERROR\")+\": \"+e.message,true);throw e}const [key,c]=prepared;let r;try{r=await call(\"/api/commands\",{method:\"POST\",body:JSON.stringify(c)});if(r?.commandId!==c.commandId||r.outcome!==\"OK\"||typeof r.applied!==\"boolean\"||typeof r.replayed!==\"boolean\"||r.applied===r.replayed||!r.result||typeof r.result!==\"object\"||Array.isArray(r.result)||r.error){const e=new Error(\"Ответ команды не подтверждает её результат. Повторите запрос без изменения данных.\");e.code=\"COMMAND_OUTCOME_UNKNOWN\";throw e}}catch(e){if(e.code===\"VALIDATION_ERROR\")rejectedValidation.add(key);else if(await hasFinalPlanRejection(type,c,e))rejectedTerminal.add(key);if(e.code===\"VERSION_CONFLICT\"&&Number.isSafeInteger(e.details&&e.details.currentVersion)){rejectedVersion.set(key,e.details.currentVersion);if(plan)plan.version=e.details.currentVersion}showToast((e.code||\"ERROR\")+\": \"+e.message,true);if(e.code===\"VERSION_CONFLICT\")try{await refresh()}catch{}throw e}pending.delete(key);rejectedValidation.delete(key);rejectedVersion.delete(key);rejectedTerminal.delete(key);showToast(r.replayed?\"Повторный запрос обработан по сохранённому результату.\":\"Изменение сохранено.\");try{await refresh()}catch{showToast(\"Изменение сохранено, но данные не обновились. Перезагрузите страницу.\",true)}return r}window.addEventListener(\"plan-time-tracker:command\",event=>{const detail=event.detail||{};command(detail.commandType,detail.plan,detail.payload).then(detail.resolve,detail.reject)});window.addEventListener(\"plan-time-tracker:refresh-plan\",event=>{const detail=event.detail||{},navigationToken=detailRequestId;(async()=>{await refresh();if(navigationToken===detailRequestId&&!q(\"#view-detail\").classList.contains(\"hidden\")&&q(\"#planDetail\").dataset.planId===detail.planId)await openPlan(detail.planId,detail.successMessage)})().then(detail.resolve,detail.reject)});function btn(text,fn,cls){const b=document.createElement(\"button\");b.textContent=text;if(cls)b.className=cls;b.onclick=async e=>{e.stopPropagation();if(b.disabled)return;b.disabled=true;try{await fn()}catch{}finally{b.disabled=false}};return b}function finishButton(p,confirmation){let b;if(p.completion&&!p.completion.readyToFinish){b=btn(\"Условия завершения\",()=>openPlan(p.planId));b.title=\"Не выполнены условия этапов: \"+p.completion.incompleteStepCount}else b=btn(\"Завершить\",async()=>{if(!window.confirm(confirmation))return;try{await command(\"FinishPlan\",p)}finally{if(q(\"#planDetail\").dataset.planId===p.planId&&!q(\"#view-detail\").classList.contains(\"hidden\"))await openPlan(p.planId)}},\"danger\");b.dataset.finishPlan=p.planId;return b}window.addEventListener(\"plan-time-tracker:completion-updated\",event=>{const next=event.detail;if(!next?.completion)return;const summaries=[...plans,active,currentDetailPlan].filter(p=>p&&p.planId===next.planId);for(const p of summaries)p.completion=next.completion;const p=summaries[0];if(p)for(const button of all(\"[data-finish-plan]\"))if(button.dataset.finishPlan===p.planId)button.replaceWith(finishButton(p,\"Завершить план? Сервер остановит таймер.\"))});function card(p){const row=document.createElement(\"div\");row.className=\"row\";row.dataset.planId=p.planId;const left=document.createElement(\"button\"),title=document.createElement(\"span\"),meta=document.createElement(\"span\");left.type=\"button\";left.className=\"plan-open\";left.onclick=()=>openPlan(p.planId);title.className=\"row-title\";title.textContent=p.title;meta.className=\"row-meta\";meta.textContent=(p.status===\"RUNNING\"?\"Выполняется\":p.status===\"PAUSED\"?\"Пауза\":p.status===\"COMPLETED\"?\"Завершён\":\"Запланирован\")+\" · активно \"+duration(p.activeMs)+\" · создан \"+dateFmt(p.registeredAt);left.append(title,meta);const right=document.createElement(\"div\");right.className=\"row-right\";const badge=document.createElement(\"span\");badge.className=\"badge \"+p.status.toLowerCase();badge.textContent=statusText(p.status);right.append(badge);if(p.status===\"PLANNED\")right.append(btn(\"Запустить\",()=>command(\"StartPlan\",p),\"primary\"));if(p.status===\"RUNNING\")right.append(btn(\"Пауза\",()=>command(\"PausePlan\",p)));if(p.status===\"PAUSED\")right.append(btn(\"Продолжить\",()=>command(\"ResumePlan\",p),\"primary\"));if(p.status===\"RUNNING\"||p.status===\"PAUSED\")right.append(finishButton(p,\"Завершить план? Сервер остановит таймер.\"));row.append(left,right);return row}async function openPlan(planId,successMessage){const requestToken=++detailRequestId;try{const p=(await call(\"/api/plans/\"+encodeURIComponent(planId))).plan;if(requestToken!==detailRequestId)return;currentDetailPlan=p;const box=q(\"#planDetail\");window.dispatchEvent(new CustomEvent(\"plan-time-tracker:plan-will-render\"));box.dataset.planId=planId;box.replaceChildren();const h=document.createElement(\"h2\");h.textContent=p.title;box.append(h);const m=document.createElement(\"p\");m.className=\"muted\";m.textContent=\"Дата плана: \"+(p.planCreatedAt.precision===\"dateOnly\"?p.planCreatedAt.on:dateFmt(Date.parse(p.planCreatedAt.value)))+\" · создан \"+dateFmt(p.registeredAt)+\" · \"+statusText(p.status);box.append(m);if(p.status===\"RUNNING\"||p.status===\"PAUSED\"){const actions=document.createElement(\"div\");actions.className=\"actions plan-completion-actions\";actions.append(finishButton(p,\"Завершить план? Сервер остановит таймер.\"));box.append(actions)}for(const label of [p.description||\"Описание не задано.\",\"Критерии приёмки: \"+(p.acceptanceCriteria||\"не заданы\"),\"Активно \"+duration(p.activeMs)+\" · календарное \"+duration(p.calendarMs)+\" · пауза \"+duration(p.pausedMs)]){const e=document.createElement(\"p\");e.textContent=label;box.append(e)}const edit=document.createElement(\"form\");edit.className=\"form\";edit.dataset.trackerForm=\"plan-metadata\";const title=document.createElement(\"input\");title.value=p.title;title.maxLength=200;title.setAttribute(\"aria-label\",\"Название плана\");const description=document.createElement(\"textarea\");description.value=p.description||\"\";description.maxLength=20000;description.setAttribute(\"aria-label\",\"Описание\");const criteria=document.createElement(\"textarea\");criteria.value=p.acceptanceCriteria||\"\";criteria.maxLength=20000;criteria.setAttribute(\"aria-label\",\"Критерии приёмки\");const date=document.createElement(\"input\");date.type=\"date\";date.value=p.planCreatedAt.precision===\"dateOnly\"?p.planCreatedAt.on:dateLocal(Date.parse(p.planCreatedAt.value));date.setAttribute(\"aria-label\",\"Дата составления\");const reason=document.createElement(\"input\");reason.placeholder=\"Причина правки даты\";reason.setAttribute(\"aria-label\",\"Причина правки даты\");const label=document.createElement(\"label\"),confirm=document.createElement(\"input\");confirm.type=\"checkbox\";confirm.dataset.draftField=\"confirmDateAnomaly\";label.append(confirm,document.createTextNode(\"Подтверждаю дату составления после первого старта\"));const save=document.createElement(\"button\");save.textContent=\"Сохранить изменения\";edit.append(title,description,criteria,date,reason,label,save);edit.onsubmit=async e=>{e.preventDefault();const draftSubmission={planId:p.planId,form:edit};window.dispatchEvent(new CustomEvent(\"plan-time-tracker:draft-submitted\",{detail:draftSubmission}));await command(\"UpdatePlanMetadata\",p,{title:title.value,description:description.value,acceptanceCriteria:criteria.value,planCreatedAt:p.planCreatedAt.precision===\"instant\"&&date.value===dateLocal(Date.parse(p.planCreatedAt.value))?p.planCreatedAt:{precision:\"dateOnly\",on:date.value,timeZone:zone},reason:reason.value,confirmDateAnomaly:confirm.checked});window.dispatchEvent(new CustomEvent(\"plan-time-tracker:draft-cleared\",{detail:{submission:draftSubmission.submission}}));await openPlan(p.planId)};box.append(edit);const intervals=document.createElement(\"div\"),ih=document.createElement(\"h3\");ih.textContent=\"Интервалы\";intervals.append(ih);p.intervals.forEach(i=>{const e=document.createElement(\"p\");e.textContent=dateFmt(i.start_ms)+\" — \"+dateFmt(i.end_ms)+\" · \"+duration((i.end_ms||p.serverNow)-i.start_ms);intervals.append(e)});box.append(intervals);const events=document.createElement(\"div\"),eh=document.createElement(\"h3\");eh.textContent=\"История команд\";events.append(eh);p.events.forEach(x=>{const e=document.createElement(\"p\");e.textContent=x.event_type+\" · \"+dateFmt(x.server_occurred_at)+\" · \"+x.actor_type;events.append(e)});box.append(events);view(\"detail\");window.dispatchEvent(new CustomEvent(\"plan-time-tracker:plan-rendered\",{detail:{planId,successMessage}}))}catch(e){showToast((e.code||\"ERROR\")+\": \"+e.message,true)}}function renderActive(){const el=q(\"#active\");el.replaceChildren();if(!active){const p=document.createElement(\"p\");p.className=\"muted\";p.textContent=\"Активного плана нет. Создайте его и запустите, когда начнёте работу.\";el.append(p,btn(\"Создать план\",openModal,\"primary\"));return}const title=document.createElement(\"h3\");title.textContent=active.title;const clock=document.createElement(\"div\");clock.className=\"timer\";clock.id=\"clock\";clock.textContent=duration(active.activeMs+Math.max(0,Date.now()-serverNow));const detail=document.createElement(\"div\");detail.className=\"muted\";detail.textContent=\"Начат \"+dateFmt(active.firstStartedAt)+\" · всего \"+duration(active.calendarMs+Math.max(0,Date.now()-serverNow));const actions=document.createElement(\"div\");actions.className=\"actions\";actions.append(btn(\"Пауза\",()=>command(\"PausePlan\",active)),finishButton(active,\"Завершить план? Время будет остановлено сервером.\"));el.append(title,clock,detail,actions)}function render(){const list=q(\"#plans\"),recent=q(\"#recent\");list.replaceChildren();recent.replaceChildren();if(!plans.length){const p=document.createElement(\"p\");p.className=\"muted\";p.textContent=\"Планов пока нет.\";list.append(p);recent.append(p.cloneNode(true))}else{plans.forEach(p=>list.append(card(p)));plans.slice(0,4).forEach(p=>recent.append(card(p)))}renderActive();q(\"#plans\").dataset.loaded=\"true\";window.dispatchEvent(new Event(\"plan-time-tracker:plans-rendered\"));if(q(\"#count\"))q(\"#count\").textContent=String(plans.filter(p=>p.status===\"COMPLETED\"&&p.finishedAt>Date.now()-30*86400000).length);const today=dateLocal(Date.now()),start=new Date(today+\"T00:00:00\").getTime();const activeToday=plans.flatMap(p=>p.intervals||[]).reduce((sum,i)=>sum+Math.max(0,(i.end_ms==null?Date.now():i.end_ms)-Math.max(start,i.start_ms)),0);if(q(\"#today\"))q(\"#today\").textContent=duration(activeToday)}async function refresh(){const [p,a,w,s]=await Promise.all([call(\"/api/plans\"),call(\"/api/active\"),call(\"/api/whoami\"),call(\"/api/settings\")]);plans=p.plans;active=a.plan;serverNow=p.serverNow;zone=normalizeZone(s.timezone);q(\"#who\").textContent=w.email||\"Личный аккаунт\";q(\"#tz\").value=zone;render()}function openModal(){modalReturnFocus=document.activeElement;document.body.style.overflow=\"hidden\";q(\"#modal\").classList.remove(\"hidden\");q(\"#createdDate\").value=dateLocal(Date.now());q(\"#title\").focus();}function closeModal(){if(q(\"#create\").getAttribute(\"aria-busy\")===\"true\")return;q(\"#modal\").classList.add(\"hidden\");document.body.style.overflow=\"\";if(modalReturnFocus?.isConnected)modalReturnFocus.focus()}async function loadAnalytics(){const requestId=++analyticsRequestId;const d=new Date(),from=new Date(d);from.setDate(from.getDate()-29);if(!q(\"#from\").value)q(\"#from\").value=dateLocal(from);if(!q(\"#to\").value)q(\"#to\").value=dateLocal(d);const u=new URLSearchParams({from:q(\"#from\").value,to:q(\"#to\").value,timeZone:zone});let a;try{a=await call(\"/api/analytics?\"+u)}catch(error){if(requestId!==analyticsRequestId)return;throw error}if(requestId!==analyticsRequestId)return;const stats=q(\"#stats\");stats.replaceChildren();const medianText=duration(a.completedMedianActiveMs)+(a.completedMedianActiveMs==null?\"\":\" · \"+formatPlanSample(a.completedMeasuredN));[[\"Активное время за период\",duration(a.totalActiveMs)],[\"Завершено планов\",String(a.completedPlans)],[\"Медиана активного времени\",medianText]].forEach(([k,v],index)=>{const box=document.createElement(\"div\"),small=document.createElement(\"small\"),strong=document.createElement(\"strong\");box.className=\"metric\";small.textContent=k;strong.textContent=v;box.append(small,strong);if(index===2&&a.completedSmallSample){const note=document.createElement(\"small\");note.className=\"sample-note\";note.textContent=\"Малая выборка\";note.title=\"Медиана рассчитана по менее чем пяти завершённым планам.\";note.setAttribute(\"aria-label\",\"Малая выборка: менее пяти завершённых планов.\");box.append(note)}stats.append(box)});const chart=q(\"#chart\");chart.replaceChildren();const max=Math.max(1,...a.activeByDay.map(x=>x.activeMs));a.activeByDay.forEach(x=>{const row=document.createElement(\"div\"),date=document.createElement(\"span\"),bar=document.createElement(\"div\"),fill=document.createElement(\"span\"),v=document.createElement(\"span\");row.className=\"barrow\";bar.className=\"bar\";fill.style.width=(100*x.activeMs/max)+\"%\";bar.append(fill);date.textContent=x.date;v.textContent=duration(x.activeMs);row.append(date,bar,v);chart.append(row)});const list=q(\"#analyticPlans\");list.replaceChildren();if(!a.plans.length){const p=document.createElement(\"p\");p.className=\"muted\";p.textContent=\"За выбранный период данных нет.\";list.append(p)}else renderAnalyticsPlanCards(list,a)}function view(name){if(name!==\"detail\")detailRequestId++;all(\"[id^=view-]\").forEach(x=>x.classList.toggle(\"hidden\",x.id!==\"view-\"+name));all(\".nav button\").forEach(b=>b.setAttribute(\"aria-current\",b.dataset.view===name?\"page\":\"false\"));if(name===\"analytics\")loadAnalytics().catch(e=>showToast(e.message,true));}all(\".nav button\").forEach(b=>b.onclick=()=>view(b.dataset.view));q(\"#backPlans\").onclick=()=>view(\"plans\");q(\"#newPlan\").onclick=openModal;q(\"#newPlan2\").onclick=openModal;q(\"#close\").onclick=closeModal;q(\"#cancel\").onclick=closeModal;q(\"#modal\").onclick=e=>{if(e.target.id===\"modal\")closeModal()};q(\"#create\").onsubmit=async e=>{e.preventDefault();const payload={title:q(\"#title\").value,description:q(\"#description\").value,acceptanceCriteria:q(\"#criteria\").value,planCreatedAt:{precision:\"dateOnly\",on:q(\"#createdDate\").value,timeZone:zone}};try{await command(\"CreatePlan\",null,payload);e.target.removeAttribute(\"aria-busy\");closeModal();e.target.reset();showToast(\"План создан. Таймер не запущен.\")}catch(x){showToast((x.code||\"ERROR\")+\": \"+x.message,true)}};q(\"#apply\").onclick=()=>loadAnalytics().catch(e=>showToast(e.message,true));q(\"#settings\").onsubmit=async e=>{e.preventDefault();try{const r=await call(\"/api/settings\",{method:\"POST\",body:JSON.stringify({timezone:q(\"#tz\").value})});zone=normalizeZone(r.timezone);q(\"#tz\").value=zone;window.dispatchEvent(new CustomEvent(\"plan-time-zone-changed\",{detail:zone}));await refresh();showToast(\"Часовой пояс сохранён.\")}catch(x){showToast((x.code||\"ERROR\")+\": \"+x.message,true)}};setInterval(()=>{const c=q(\"#clock\");if(c&&active)c.textContent=duration(active.activeMs+Math.max(0,Date.now()-serverNow))},1000);refresh().catch(e=>{q(\"#who\").textContent=\"Требуется вход\";showToast(e.message,true)})})();</script></body></html>"
  ].join("").replace("</head>", "<style>" + UI_ANALYTICS_CSS + "</style></head>").replace("</body></html>", "<script>" + UI_ENHANCEMENTS + "</script><script>" + UI_TRACKER + "</script><script>" + UI_ACCESSIBILITY + "</script></body></html>");
}

const RETIRED_COMMANDS = new Set(["SyncRepository","AttachPlanRepository","ReviewCommitLink"]);
const PUBLIC_OBSERVATIONS = [...OBSERVATION_TYPES];
function validatePublicCommand(envelope) {
  if (RETIRED_COMMANDS.has(envelope?.commandType)) throw appError("FEATURE_REMOVED","Интеграция контроля версий удалена.",410);
  const payload=envelope?.payload;
  if(!payload || typeof payload!=="object") return;
  const forbidden=["repositoryId","repositoryIds","repositoryRefs","revisionSha","testedSha","worktreeSnapshot","commitPolicy","pushPolicy"];
  for(const fields of [payload,payload.changes]) if(fields && forbidden.some(key=>Object.hasOwn(fields,key))) throw appError("VALIDATION_ERROR","Поле удалено из текущего контракта.");
  if(envelope.commandType==="AppendObservation" && !PUBLIC_OBSERVATIONS.includes(payload.eventType)) throw appError("VALIDATION_ERROR","Неподдерживаемое наблюдение.");
}
// Historical source identities remain in immutable storage and the readiness views.
// Public clients see their status, revision and permitted snapshot digests, without a Git interface.
function publicView(value) {
  if(Array.isArray(value)) return value.map(publicView);
  if(!value || typeof value!=="object") return value;
  const hidden=new Set(["repositories","commits","commitConflicts","repositoryId","repositoryIds","repositoryRefs","repository_id","revisionSha","revision_sha","testedSha","tested_sha","baseRevisionSha","base_revision_sha","commitPolicy","pushPolicy","commit_policy","push_policy","gitEvidence"]);
  const result={};
  for(const [key,item] of Object.entries(value)) if(!hidden.has(key)) result[key]=publicView(item);
  if(["COMMIT","WORKTREE_SNAPSHOT"].includes(result.source_kind)) result.source_kind="HISTORICAL";
  if(["commit_created","commit_pushed","push_failed"].includes(result.eventType)) {result.eventType="HISTORICAL_EVENT";result.payload={historical:true};}
  return result;
}

async function apiRoute(request, env, url, channel, now) {
  validateOrigin(request);
  const identity = requireOwner(request);
  if (!env.DB) throw appError("INTERNAL_ERROR", "D1 binding DB не настроен.", 503);
  await ensureOwner(env.DB, identity, now);
  if (request.method === "GET" && url.pathname === "/api/whoami") return json({ userId: identity.ownerId, email: identity.email, serverNow: now });
  if (request.method === "GET" && url.pathname === "/api/settings") {
    const settings = await dbFirst(env.DB, "SELECT timezone,locale FROM owners WHERE owner_id=?", identity.ownerId);
    return json({ timezone: settings.timezone, locale: settings.locale });
  }
  if (request.method === "POST" && url.pathname === "/api/settings") {
    const body = await bodyJson(request);
    const zone = checkTimeZone(body.timezone);
    await env.DB.prepare("UPDATE owners SET timezone=? WHERE owner_id=?").bind(zone, identity.ownerId).run();
    return json({ timezone: zone });
  }
  if (request.method === "GET" && url.pathname === "/api/plans") return json({ plans: await listPlans(env.DB, identity.ownerId, now), serverNow: now });
  if (request.method === "GET" && url.pathname === "/api/export") {
    const rows = await dbAll(env.DB, "SELECT * FROM plans WHERE owner_id=? ORDER BY registered_at", identity.ownerId);
    const plans = await Promise.all(rows.map(async (row) => {
      const plan = await readPlan(env.DB, identity.ownerId, row.plan_id, now);
      return plan;
    }));
    const settings = await dbFirst(env.DB, "SELECT timezone,locale FROM owners WHERE owner_id=?", identity.ownerId);
    return json({ exportedAt: now, timezone: settings.timezone, plans }, 200, { "content-disposition": "attachment; filename=plan-time-tracker-export.json" });
  }
  if (request.method === "GET" && url.pathname === "/api/active") {
    const plan = await dbFirst(env.DB, "SELECT * FROM plans WHERE owner_id=? AND status='RUNNING'", identity.ownerId);
    return json({ plan: plan ? await planSummary(env.DB, identity.ownerId, plan, now) : null, serverNow: now });
  }
  if (request.method === "GET" && url.pathname === "/api/tracker/capabilities") return json(await readTrackerCapabilities(env.DB, identity.ownerId));
  const trackerReceiptMatch = url.pathname.match(/^\/api\/tracker\/commands\/([^/]+)$/);
  if (request.method === "GET" && trackerReceiptMatch) return json(await readCommandReceipt(env.DB, identity.ownerId, decodeURIComponent(trackerReceiptMatch[1])));
  const executionMatch = url.pathname.match(/^\/api\/tracker\/plans\/([^/]+)\/execution$/);
  if (request.method === "GET" && executionMatch) return json(await readPlanExecutionSnapshot(env.DB, identity.ownerId, decodeURIComponent(executionMatch[1]), now));
  const timelineMatch = url.pathname.match(/^\/api\/tracker\/plans\/([^/]+)\/timeline$/);
  if (request.method === "GET" && timelineMatch) {
    const afterSequence = url.searchParams.has("afterSequence") ? Number(url.searchParams.get("afterSequence")) : 0;
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
    return json({ ...await readTrackerTimeline(env.DB, identity.ownerId, decodeURIComponent(timelineMatch[1]), afterSequence, limit), serverNow: now });
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/plans/")) {
    const planId = decodeURIComponent(url.pathname.slice("/api/plans/".length));
    return json({ plan: await readPlan(env.DB, identity.ownerId, planId, now), serverNow: now });
  }
  if (request.method === "POST" && url.pathname === "/api/commands") {
    const envelope=await bodyJson(request); validatePublicCommand(envelope);
    return json(await executeCommand(env.DB, identity, envelope, channel, now));
  }
  const stepAnalyticsMatch = url.pathname.match(/^\/api\/analytics\/plans\/([^/]+)\/steps$/);
  if (request.method === "GET" && stepAnalyticsMatch) {
    return json(await buildStepAnalytics(env.DB, identity.ownerId, decodeURIComponent(stepAnalyticsMatch[1]), {
      from: url.searchParams.get("from"), to: url.searchParams.get("to"),
      timeZone: url.searchParams.get("timeZone") || (await dbFirst(env.DB, "SELECT timezone FROM owners WHERE owner_id=?", identity.ownerId)).timezone,
      asOf: url.searchParams.get("asOf"),
    }, now));
  }
  if (request.method === "GET" && url.pathname === "/api/analytics") {
    if(url.searchParams.has("repositoryId")) throw appError("VALIDATION_ERROR","Фильтр удален из текущего контракта.");
    return json(await buildAnalytics(env.DB, identity.ownerId, {
      from: url.searchParams.get("from"), to: url.searchParams.get("to"),
      timeZone: url.searchParams.get("timeZone") || (await dbFirst(env.DB, "SELECT timezone FROM owners WHERE owner_id=?", identity.ownerId)).timezone,

    }, now));
  }
  throw appError("NOT_FOUND", "Маршрут не найден.", 404);
}

const TOOL_NAMES = ["CreatePlan", "GetPlan", "GetActivePlan", "StartPlan", "PausePlan", "ResumePlan", "FinishPlan", "UpdatePlanMetadata", "GetAnalytics", ...TRACKER_READ_TOOLS, ...TRACKER_COMMANDS];
function mcpTools() {
  const writeNames = new Set([...WRITE_COMMANDS, ...TRACKER_COMMANDS]);
  return TOOL_NAMES.map((name) => {
    let inputSchema = { type: "object", additionalProperties: false };
    if (name === "GetPlan") inputSchema = { type: "object", required: ["planId"], properties: { planId: { type: "string", format: "uuid" } }, additionalProperties: false };
    else if (name === "GetActivePlan") inputSchema = { type: "object", properties: {}, additionalProperties: false };
    else if (name === "GetTrackerCapabilities") inputSchema = { type: "object", properties: {}, additionalProperties: false };
    else if (name === "GetPlanExecutionSnapshot") inputSchema = { type: "object", required: ["planId"], properties: { planId: { type: "string", format: "uuid" } }, additionalProperties: false };
    else if (name === "GetTimeline") inputSchema = { type: "object", required: ["planId"], properties: { planId: { type: "string", format: "uuid" }, afterSequence: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false };
    else if (name === "GetCommandReceipt") inputSchema = { type: "object", required: ["commandId"], properties: { commandId: { type: "string", format: "uuid" } }, additionalProperties: false };
    else if (name === "GetAnalytics") inputSchema = { type: "object", required: ["from", "to", "timeZone"], properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" }, timeZone: { type: "string" } }, additionalProperties: false };
    else if (writeNames.has(name)) {
      const required = ["schemaVersion", "commandId", "payload"];
      if ((WRITE_COMMANDS.has(name) && name !== "CreatePlan") || TRACKER_VERSIONED_COMMANDS.has(name)) required.push("expectedVersion");
      let payloadProperties = { planId: { type: "string", format: "uuid" } };
      let payloadRequired = ["planId"];
      let payloadAnyOf;
      if (name === "CreateStep") {
        payloadProperties = {
          planId: { type: "string", format: "uuid" }, ordinal: { type: "integer", minimum: 0 },
          title: { type: "string", minLength: 1, maxLength: 200 },
          expectedResult: { type: "string", minLength: 1, maxLength: 4000 },
          requiredChecks: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 } },
        };
        payloadRequired = ["planId", "ordinal", "title", "expectedResult", "requiredChecks"];
      } else if (name === "UpdateStep") {
        payloadProperties = {
          stepId: { type: "string", format: "uuid" },
          changes: { type: "object", properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
            expectedResult: { type: "string", minLength: 1, maxLength: 4000 },
            requiredChecks: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 } },
          }, additionalProperties: false },
          reason: { type: "string", minLength: 1, maxLength: 1000 },
        };
        payloadRequired = ["stepId", "changes", "reason"];
      } else if (name === "ClaimStepAttempt") {
        payloadProperties = {
          stepId: { type: "string", format: "uuid" }, sessionId: { type: "string", format: "uuid" },
          sourceId: { type: "string", minLength: 1, maxLength: 128 },
          clientType: { enum: ["LOCAL", "WEB", "CLOUD", "UNKNOWN"] },
          executorLabel: { type: "string", maxLength: 128 },
          recoveryReason: { type: "string", minLength: 1, maxLength: 1000 },
          reworkReason: { type: "string", minLength: 1, maxLength: 1000 },
        };
        payloadRequired = ["stepId", "sessionId", "sourceId"];
      } else if (name === "RenewStepLease") {
        payloadProperties = { stepId: { type: "string", format: "uuid" }, attemptId: { type: "string", format: "uuid" }, fence: { type: "integer", minimum: 1 } };
        payloadRequired = ["stepId", "attemptId", "fence"];
      } else if (name === "CloseStepAttempt") {
        payloadProperties = { stepId: { type: "string", format: "uuid" }, attemptId: { type: "string", format: "uuid" }, fence: { type: "integer", minimum: 1 }, disposition: { enum: ["CLOSED", "ABANDONED"] }, reason: { type: "string", minLength: 1, maxLength: 1000 } };
        payloadRequired = ["stepId", "attemptId", "fence", "disposition", "reason"];
      } else if (name === "StartStep") {
        payloadProperties = { stepId: { type: "string", format: "uuid" }, attemptId: { type: "string", format: "uuid" }, fence: { type: "integer", minimum: 1 }, rework: { type: "boolean" }, reason: { type: "string", maxLength: 1000 } };
        payloadRequired = ["stepId", "attemptId", "fence"];
      } else if (name === "BlockStep") {
        payloadProperties = { stepId: { type: "string", format: "uuid" }, attemptId: { type: "string", format: "uuid" }, fence: { type: "integer", minimum: 1 }, reason: { type: "string", minLength: 1, maxLength: 1000 } };
        payloadRequired = ["stepId", "attemptId", "fence", "reason"];
      } else if (name === "RecordStepResult") {
        payloadProperties = {stepId:{type:"string",format:"uuid"},attemptId:{type:"string",format:"uuid"},fence:{type:"integer",minimum:1},outcome:{enum:["DONE","FAILED"]},summary:{type:"string",minLength:1,maxLength:4000},sourceSnapshot:{type:"object",additionalProperties:false,required:["kind","digest","formatVersion"],properties:{kind:{const:"SOURCE_SNAPSHOT"},digest:{type:"string",minLength:71,maxLength:71,pattern:"^sha256:[a-f0-9]{64}$"},formatVersion:{const:2}}}};
        payloadRequired=["stepId","attemptId","fence","outcome","summary"];
      } else if (name === "RecordCheck") {
        payloadProperties={stepId:{type:"string",format:"uuid"},resultRevision:{type:"integer",minimum:1},checkKey:{type:"string",minLength:1,maxLength:100},status:{enum:["PASSED","FAILED","NOT_RUN"]},testedSnapshotDigest:{type:"string",minLength:71,maxLength:71,pattern:"^sha256:[a-f0-9]{64}$"},exitCode:{type:"integer",minimum:0,maximum:255},evidenceSummary:{type:"string",maxLength:2000},evidenceUrl:{type:"string",pattern:"^https://",maxLength:2048}};
        payloadRequired=["stepId","resultRevision","checkKey","status","testedSnapshotDigest"];
      } else if (name === "AppendObservation") {
        payloadProperties = {
          eventId: { type: "string", format: "uuid" }, planId: { type: "string", format: "uuid" },
          stepId: { type: "string", format: "uuid" }, attemptId: { type: "string", format: "uuid" },
          sourceId: { type: "string", minLength: 1, maxLength: 128 }, sessionId: { type: "string", format: "uuid" },
          sourceSequence: { type: "integer", minimum: 1 }, occurredAt: { type: "integer", minimum: 0 },
          eventType: { enum: PUBLIC_OBSERVATIONS }, correctionOfEventId: { type: "string", format: "uuid" },
          data: { type: "object", properties: {
            turnId: { type: "string", format: "uuid" }, operationId: { type: "string", format: "uuid" },
            toolName: { type: "string", maxLength: 80 }, status: { enum: ["OK", "FAILED", "CANCELLED"] },
            durationMs: { type: "integer", minimum: 0, maximum: 604800000 },

            reason: { type: "string", maxLength: 1000 },
          }, additionalProperties: false },
        };
        payloadRequired = ["eventId", "planId", "sourceId", "sessionId", "sourceSequence", "occurredAt", "eventType", "data"];
      } else if (name === "CreatePlan") {
        payloadProperties = {
          title: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string", maxLength: 20000 },
          acceptanceCriteria: { type: "string", maxLength: 20000 },
          planCreatedAt: { oneOf: [
            { type: "object", required: ["precision", "value", "timeZone"], properties: { precision: { const: "instant" }, value: { type: "string", format: "date-time" }, timeZone: { type: "string" } }, additionalProperties: false },
            { type: "object", required: ["precision", "on", "timeZone"], properties: { precision: { const: "dateOnly" }, on: { type: "string", format: "date" }, timeZone: { type: "string" } }, additionalProperties: false },
          ] },

        };
        payloadRequired = ["title", "planCreatedAt"];
      } else if (name === "UpdatePlanMetadata") {
        payloadProperties = {
          planId: { type: "string", format: "uuid" },
          title: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string", maxLength: 20000 },
          acceptanceCriteria: { type: "string", maxLength: 20000 },
          planCreatedAt: { oneOf: [
            { type: "object", required: ["precision", "value", "timeZone"], properties: { precision: { const: "instant" }, value: { type: "string", format: "date-time" }, timeZone: { type: "string" } }, additionalProperties: false },
            { type: "object", required: ["precision", "on", "timeZone"], properties: { precision: { const: "dateOnly" }, on: { type: "string", format: "date" }, timeZone: { type: "string" } }, additionalProperties: false },
          ] },
          reason: { type: "string", maxLength: 1000 }, confirmDateAnomaly: { type: "boolean" },
        };
        payloadAnyOf = ["title", "description", "acceptanceCriteria", "planCreatedAt"].map((field) => ({ required: [field] }));
      } else if (name === "PausePlan") {
        payloadProperties.reason = { type: "string", maxLength: 1000 };
      } else if (name === "FinishPlan") {
        payloadProperties.completionNote = { type: "string", maxLength: 2000 };
        payloadProperties.allowIncomplete = { type: "boolean" };
        payloadProperties.reason = { type: "string", minLength: 1, maxLength: 1000 };
      }
      inputSchema = {
        type: "object", required: required,
        properties: {
          schemaVersion: { const: 1 }, commandId: { type: "string", format: "uuid" },
          expectedVersion: { type: "integer", minimum: TRACKER_VERSIONED_COMMANDS.has(name) || name === "RenewStepLease" ? 1 : 0 }, payloadHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          sourceReference: { type: "string", maxLength: 2048 },
          payload: { type: "object", required: payloadRequired, properties: payloadProperties, ...(payloadAnyOf ? { anyOf: payloadAnyOf } : {}), additionalProperties: false },
        }, additionalProperties: false,
      };
    }
    return { name: name, description: name === "CreatePlan" ? "Создать план и дату составления; таймер не запускается." : name === "CreateStep" ? "Создать checkpoint в плане; таймер плана не меняется." : name === "AppendObservation" ? "Добавить bounded metadata observation; не меняет состояние шага или таймер." : name + " через общий командный/API слой Sites.", inputSchema: inputSchema };
  });
}

async function mcpRoute(request, env, now) {
  if (request.method !== "POST") return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "POST required" } }, 405);
  validateOrigin(request);
  const rpc = await bodyJson(request);
  if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return json({ jsonrpc: "2.0", id: rpc && rpc.id || null, error: { code: -32600, message: "Invalid JSON-RPC request" } }, 400);
  const id = rpc.id == null ? null : rpc.id;
  if (rpc.method === "initialize") return json({ jsonrpc: "2.0", id: id, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "plan-time-tracker", version: "1.0.0" } } });
  if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (rpc.method === "ping") return json({ jsonrpc: "2.0", id: id, result: {} });
  if (rpc.method === "tools/list") return json({ jsonrpc: "2.0", id: id, result: { tools: mcpTools() } });
  if (rpc.method !== "tools/call") return json({ jsonrpc: "2.0", id: id, error: { code: -32601, message: "Method not found" } });
  const identity = requireOwner(request);
  if (!env.DB) return json({ jsonrpc: "2.0", id: id, result: { isError: true, content: [{ type: "text", text: "D1 binding DB не настроен." }] } });
  const name = rpc.params && rpc.params.name;
  const args = rpc.params && rpc.params.arguments || {};
  try {
    if(!TOOL_NAMES.includes(name)) throw appError("FEATURE_REMOVED","Инструмент недоступен в текущем контракте.",410);
    if(name==="GetAnalytics" && Object.hasOwn(args,"repositoryIds")) throw appError("VALIDATION_ERROR","Фильтр удален из текущего контракта.");
    if(WRITE_COMMANDS.has(name)||TRACKER_COMMANDS.has(name)) validatePublicCommand({...args,commandType:name});
    await ensureOwner(env.DB, identity, now);
    let result;
    if (name === "GetPlan") result = await readPlan(env.DB, identity.ownerId, args.planId, now);
    else if (name === "GetActivePlan") {
      const plan = await dbFirst(env.DB, "SELECT * FROM plans WHERE owner_id=? AND status='RUNNING'", identity.ownerId);
      result = plan ? await planSummary(env.DB, identity.ownerId, plan, now) : null;
    } else if (name === "GetAnalytics") result = await buildAnalytics(env.DB, identity.ownerId, args, now);
    else if (name === "GetTrackerCapabilities") result = await readTrackerCapabilities(env.DB, identity.ownerId);
    else if (name === "GetPlanExecutionSnapshot") result = await readPlanExecutionSnapshot(env.DB, identity.ownerId, args.planId, now);
    else if (name === "GetTimeline") result = await readTrackerTimeline(env.DB, identity.ownerId, args.planId, args.afterSequence === undefined ? 0 : args.afterSequence, args.limit === undefined ? 50 : args.limit);
    else if (name === "GetCommandReceipt") result = await readCommandReceipt(env.DB, identity.ownerId, args.commandId);
    else if (WRITE_COMMANDS.has(name) || TRACKER_COMMANDS.has(name)) {
      const envelope = { ...args, schemaVersion: args.schemaVersion || 1, commandType: name };
      result = await executeCommand(env.DB, identity, envelope, "mcp", now);
    } else throw appError("VALIDATION_ERROR", "Неизвестный MCP tool.");
    return json({ jsonrpc: "2.0", id: id, result: { content: [{ type: "text", text: JSON.stringify(publicView(result)) }], structuredContent: publicView(result) } });
  } catch (error) {
    const e = error instanceof AppError ? error : appError("INTERNAL_ERROR", "Внутренняя ошибка.", 500);
    const body = {
      code: e.code, message: e.message, details: e.details || null,
      requestId: crypto.randomUUID(),
      retryable: e.details && typeof e.details.retryable === "boolean" ? e.details.retryable : ["RATE_LIMITED", "SOURCE_UNAVAILABLE", "INTERNAL_ERROR"].includes(e.code),
      retryAfter: e.details && e.details.retryAfter != null ? e.details.retryAfter : null,
    };
    return json({ jsonrpc: "2.0", id: id, result: { isError: true, structuredContent: body, content: [{ type: "text", text: JSON.stringify(body) }] } });
  }
}

function workerError(error) {
  const mapped = error instanceof AppError ? error : mapDbError(error);
  const e = mapped instanceof AppError ? mapped : appError("INTERNAL_ERROR", messageFor("INTERNAL_ERROR"), 500);
  const code = e.code || "INTERNAL_ERROR";
  const requestId = crypto.randomUUID();
  const retryable = e.details && typeof e.details.retryable === "boolean" ? e.details.retryable : ["RATE_LIMITED", "SOURCE_UNAVAILABLE", "INTERNAL_ERROR"].includes(code);
  const retryAfter = e.details && e.details.retryAfter != null ? e.details.retryAfter : null;
  return json({ error: { code: code, message: e.message || messageFor("INTERNAL_ERROR"), details: e.details || null, requestId: requestId, retryable: retryable, retryAfter: retryAfter } }, e.status || 500);
}

export function createWorker(clock) {
  const getNow = typeof clock === "function" ? clock : () => Date.now();
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      try {
        const now = getNow();
        if (url.pathname === "/mcp") return await mcpRoute(request, env, now);
        if (url.pathname.startsWith("/api/")) {
          const response=await apiRoute(request,env,url,"ui",now);
          return new Response(JSON.stringify(publicView(await response.json())),{status:response.status,headers:response.headers});
        }
        if (request.method !== "GET" && request.method !== "HEAD") throw appError("NOT_FOUND", "Маршрут не найден.", 404);
        requireOwner(request);
        return new Response(uiHtml(), { headers: {
          "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
        } });
      } catch (error) { return workerError(error); }
    },
  };
}

export default createWorker();
