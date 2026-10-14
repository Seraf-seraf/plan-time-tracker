const BODY_LIMIT = 128 * 1024;
const PAGE_LIMIT = 10;
const GITHUB_REQUEST_TIMEOUT_MS = 15000;
const TRACKER_LEASE_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;
const WRITE_COMMANDS = new Set(["CreatePlan", "StartPlan", "PausePlan", "ResumePlan", "FinishPlan", "UpdatePlanMetadata", "ReviewCommitLink"]);
const TRACKER_COMMANDS = new Set(["CreateStep", "UpdateStep", "ClaimStepAttempt", "RenewStepLease", "CloseStepAttempt", "StartStep", "BlockStep", "RecordStepResult", "RecordCheck", "AcceptStep", "RejectStep", "AppendObservation"]);
const TRACKER_VERSIONED_COMMANDS = new Set(["UpdateStep", "ClaimStepAttempt", "StartStep", "BlockStep", "RecordStepResult", "AcceptStep", "RejectStep"]);
const TRACKER_READ_TOOLS = new Set(["GetTrackerCapabilities", "GetPlanExecutionSnapshot", "GetTimeline", "GetCommandReceipt"]);
const OBSERVATION_TYPES = new Set(["turn_started", "turn_finished", "tool_started", "tool_finished", "commit_created", "commit_pushed", "push_failed", "heartbeat", "gap", "correction"]);
const CHECKPOINT_POLICIES = ["NEVER", "ON_EXPLICIT_REQUEST", "REQUIRED_BY_APPROVED_CHECKPOINT"];
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
    if (typeof value.on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.on)) throw new AppError("VALIDATION_ERROR", "Дата должна иметь формат YYYY-MM-DD.");
    const parsed = new Date(value.on + "T00:00:00Z");
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.on) throw new AppError("VALIDATION_ERROR", "Некорректная календарная дата.");
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

export function zonedDateStartMs(dateString, timeZone) {
  checkTimeZone(timeZone);
  if (typeof dateString !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) throw new AppError("VALIDATION_ERROR", "Дата должна иметь формат YYYY-MM-DD.");
  const parts = dateString.split("-").map(Number);
  const utcGuess = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  if (new Date(utcGuess).toISOString().slice(0, 10) !== dateString) throw new AppError("VALIDATION_ERROR", "Некорректная дата периода.");
  let result = utcGuess;
  for (let i = 0; i < 4; i += 1) result = utcGuess - offsetAt(result, timeZone);
  return result;
}

export function inclusiveDateRange(from, to, timeZone) {
  checkTimeZone(timeZone);
  if (!from || !to || from > to) throw new AppError("VALIDATION_ERROR", "Укажите корректный включительный диапазон дат.");
  const parts = to.split("-").map(Number);
  const nextDay = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 1)).toISOString().slice(0, 10);
  return { startMs: zonedDateStartMs(from, timeZone), endMs: zonedDateStartMs(nextDay, timeZone) };
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
    CHECKPOINTS_INCOMPLETE: "Сначала примите все checkpoints либо завершите план с явным исключением и причиной.",
    RESULT_REVISION_STALE: "Результат относится к устаревшей редакции этапа.",
    CHECKS_INCOMPLETE: "Обязательные проверки ещё не пройдены.",
    ACTIVE_ATTEMPT_EXISTS: "У этапа уже есть активная попытка.",
    LEASE_CONFLICT: "Попытка больше не владеет действующей арендой.",
    ATTEMPT_CLOSED: "Попытка уже закрыта.",
    PLAN_PAUSED: "План на паузе. Сначала явно возобновите его.",
    PLAN_COMPLETED: "Завершённый план не принимает новые этапы.",
    FEATURE_UNAVAILABLE: "Tracker-функции для этого плана недоступны.",
    INVALID_TRANSITION: "Команда недоступна в текущем состоянии плана.",
    ACTIVE_PLAN_EXISTS: "У владельца уже выполняется другой план.",
    VERSION_CONFLICT: "План изменился. Обновите его и проверьте действие.",
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
    if (snapshot && typeof snapshot === "object") snapshot.error = code;
    const status = ["VERSION_CONFLICT", "ACTIVE_PLAN_EXISTS", "STEP_ALREADY_EXISTS", "ACTIVE_ATTEMPT_EXISTS", "LEASE_CONFLICT", "ATTEMPT_CLOSED", "RESULT_REVISION_STALE", "CHECKS_INCOMPLETE", "CHECKPOINTS_INCOMPLETE", "REWORK_REQUIRED", "OBSERVATION_CONFLICT", "IDEMPOTENCY_KEY_REUSED"].includes(code) ? 409 :
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
    commit_created: { keys: ["repositoryId", "revisionSha", "ref", "resultRevision"], required: ["repositoryId", "revisionSha", "resultRevision"] },
    commit_pushed: { keys: ["repositoryId", "revisionSha", "ref"], required: ["repositoryId", "revisionSha"] },
    push_failed: { keys: ["repositoryId", "revisionSha", "ref", "reason"], required: ["repositoryId", "revisionSha", "reason"] },
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
  if (["commit_created", "commit_pushed", "push_failed"].includes(payload.eventType)) {
    if (typeof data.repositoryId !== "string" || !data.repositoryId.trim() || data.repositoryId.length > 40 || !SHA.test(data.revisionSha || "")) throw appError("VALIDATION_ERROR", "Git observation требует repositoryId и полный revisionSha.");
    if (data.ref !== undefined && (typeof data.ref !== "string" || !data.ref.trim() || data.ref.length > 255)) throw appError("VALIDATION_ERROR", "ref ограничен 255 символами.");
    if (data.resultRevision !== undefined && (!Number.isSafeInteger(data.resultRevision) || data.resultRevision < 1)) throw appError("VALIDATION_ERROR", "resultRevision должен быть положительным целым числом.");
    if (payload.eventType === "commit_created" && (!payload.stepId || data.resultRevision === undefined)) throw appError("VALIDATION_ERROR", "commit_created должен ссылаться на checkpoint и resultRevision.");
    if (payload.eventType === "push_failed" && (typeof data.reason !== "string" || !data.reason.trim() || data.reason.trim().length > 1000)) throw appError("VALIDATION_ERROR", "push_failed требует краткую причину (до 1000 символов).");
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
  if (!TRACKER_VERSIONED_COMMANDS.has(envelope.commandType) && envelope.expectedVersion !== undefined) throw appError("VALIDATION_ERROR", "Эта tracker-команда не принимает expectedVersion.");

  if (envelope.commandType === "CreateStep") {
    const payload = envelope.payload;
    assertExactKeys(payload, new Set(["planId", "ordinal", "title", "expectedResult", "requiredChecks", "commitPolicy", "pushPolicy"]), "CreateStep payload");
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
    if (!CHECKPOINT_POLICIES.includes(payload.commitPolicy) || !CHECKPOINT_POLICIES.includes(payload.pushPolicy)) throw appError("VALIDATION_ERROR", "Некорректная commitPolicy или pushPolicy.");
  } else if (envelope.commandType === "UpdateStep") {
    const payload = envelope.payload;
    assertExactKeys(payload, new Set(["stepId", "changes", "reason"]), "UpdateStep payload");
    if (!UUID.test(payload.stepId || "")) throw appError("VALIDATION_ERROR", "stepId должен быть UUID.");
    if (!payload.changes || typeof payload.changes !== "object" || Array.isArray(payload.changes)) throw appError("VALIDATION_ERROR", "changes должен быть объектом.");
    assertExactKeys(payload.changes, new Set(["title", "expectedResult", "requiredChecks", "commitPolicy", "pushPolicy"]), "changes");
    if (Object.keys(payload.changes).length === 0) throw appError("VALIDATION_ERROR", "Укажите хотя бы одно изменение checkpoint.");
    if (payload.changes.title !== undefined && (typeof payload.changes.title !== "string" || !payload.changes.title.trim() || payload.changes.title.trim().length > 200)) throw appError("VALIDATION_ERROR", "Название этапа обязательно (до 200 символов).");
    if (payload.changes.expectedResult !== undefined && (typeof payload.changes.expectedResult !== "string" || !payload.changes.expectedResult.trim() || payload.changes.expectedResult.length > 4000)) throw appError("VALIDATION_ERROR", "Ожидаемый результат обязателен (до 4000 символов).");
    assertSafeMetadataText(payload.changes.title, "title");
    assertSafeMetadataText(payload.changes.expectedResult, "expectedResult");
    if (payload.changes.requiredChecks !== undefined && (!Array.isArray(payload.changes.requiredChecks) || payload.changes.requiredChecks.length > 20 || payload.changes.requiredChecks.some((key) => typeof key !== "string" || !key.trim() || key.length > 100) || new Set(payload.changes.requiredChecks.map((key) => key.trim())).size !== payload.changes.requiredChecks.length)) throw appError("VALIDATION_ERROR", "requiredChecks должен содержать до 20 уникальных ключей длиной до 100 символов.");
    if (payload.changes.requiredChecks) for (const key of payload.changes.requiredChecks) assertSafeMetadataText(key, "checkKey");
    if (payload.changes.commitPolicy !== undefined && !CHECKPOINT_POLICIES.includes(payload.changes.commitPolicy)) throw appError("VALIDATION_ERROR", "Некорректная commitPolicy.");
    if (payload.changes.pushPolicy !== undefined && !CHECKPOINT_POLICIES.includes(payload.changes.pushPolicy)) throw appError("VALIDATION_ERROR", "Некорректная pushPolicy.");
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
      RecordStepResult: ["stepId", "attemptId", "fence", "outcome", "summary", "repositoryId", "revisionSha"],
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
      if ((payload.repositoryId == null) !== (payload.revisionSha == null)) throw appError("VALIDATION_ERROR", "repositoryId и revisionSha нужно передать вместе.");
      if (payload.repositoryId !== undefined && (typeof payload.repositoryId !== "string" || !payload.repositoryId.trim() || payload.repositoryId.length > 40)) throw appError("VALIDATION_ERROR", "repositoryId ограничен 40 символами.");
      if (payload.revisionSha !== undefined && !SHA.test(payload.revisionSha || "")) throw appError("VALIDATION_ERROR", "revisionSha должен быть полным SHA-1.");
    }
  } else if (envelope.commandType === "RecordCheck") {
    const payload = envelope.payload;
      assertExactKeys(payload, new Set(["stepId", "resultRevision", "checkKey", "status", "testedSha", "exitCode", "evidenceSummary", "evidenceUrl"]), "RecordCheck payload");
      if (!UUID.test(payload.stepId || "") || !Number.isSafeInteger(payload.resultRevision) || payload.resultRevision < 1) throw appError("VALIDATION_ERROR", "stepId или resultRevision некорректны.");
      if (typeof payload.checkKey !== "string" || !payload.checkKey.trim() || payload.checkKey.trim().length > 100) throw appError("VALIDATION_ERROR", "checkKey обязателен и ограничен 100 символами.");
      if (!["PASSED", "FAILED", "NOT_RUN"].includes(payload.status) || !SHA.test(payload.testedSha || "")) throw appError("VALIDATION_ERROR", "Укажите статус проверки и полный testedSha.");
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
  } else if (["AcceptStep", "RejectStep"].includes(envelope.commandType)) {
    const payload = envelope.payload;
      const fields = envelope.commandType === "AcceptStep" ? ["stepId", "resultRevision", "reason", "waivers"] : ["stepId", "resultRevision", "reason"];
      assertExactKeys(payload, new Set(fields), envelope.commandType + " payload");
      if (!UUID.test(payload.stepId || "") || !Number.isSafeInteger(payload.resultRevision) || payload.resultRevision < 1) throw appError("VALIDATION_ERROR", "stepId или resultRevision некорректны.");
      if (typeof payload.reason !== "string" || !payload.reason.trim() || payload.reason.trim().length > 1000) throw appError("VALIDATION_ERROR", "Укажите причину решения (до 1000 символов).");
      assertSafeMetadataText(payload.reason, "reason");
      if (envelope.commandType === "AcceptStep") {
        const waivers = payload.waivers === undefined ? [] : payload.waivers;
        if (!Array.isArray(waivers) || waivers.length > 20) throw appError("VALIDATION_ERROR", "waivers должен содержать до 20 записей.");
        const keys = new Set();
        for (const waiver of waivers) {
          if (!waiver || typeof waiver !== "object" || Array.isArray(waiver)) throw appError("VALIDATION_ERROR", "Каждая waiver должна быть объектом.");
          assertExactKeys(waiver, new Set(["checkKey", "reason"]), "waiver");
          if (typeof waiver.checkKey !== "string" || !waiver.checkKey.trim() || waiver.checkKey.trim().length > 100 || typeof waiver.reason !== "string" || !waiver.reason.trim() || waiver.reason.trim().length > 1000 || keys.has(waiver.checkKey.trim())) throw appError("VALIDATION_ERROR", "Каждая waiver должна содержать уникальный checkKey и причину.");
          keys.add(waiver.checkKey.trim());
          assertSafeMetadataText(waiver.checkKey, "checkKey");
          assertSafeMetadataText(waiver.reason, "waiver reason");
        }
        if (canonical(waivers).length > 6000) throw appError("VALIDATION_ERROR", "Суммарный размер waivers превышает 6000 символов.");
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
    };
    const eventData = await addEvent(event);
    Object.assign(payload, {
      summary: input.summary.trim(),
      revisionSha: input.revisionSha ? input.revisionSha.toLowerCase() : null,
      repositoryId: input.repositoryId || null,
      resultId: resultId,
      resultPayloadHash: eventData.eventPayloadHash,
      ...eventData,
    });
  } else if (envelope.commandType === "RecordCheck") {
    const checkId = crypto.randomUUID();
    const eventData = await addEvent({
      stepId: input.stepId, resultRevision: input.resultRevision, checkKey: input.checkKey.trim(),
      status: input.status, testedSha: input.testedSha.toLowerCase(), exitCode: input.exitCode ?? null,
      evidenceSummary: input.evidenceSummary ? input.evidenceSummary.trim() : null,
      evidenceUrl: input.evidenceUrl ? input.evidenceUrl.trim() : null,
    });
    Object.assign(payload, {
      checkId: checkId, checkKey: input.checkKey.trim(), testedSha: input.testedSha.toLowerCase(),
      exitCode: input.exitCode ?? null, evidenceSummary: input.evidenceSummary ? input.evidenceSummary.trim() : null,
      evidenceUrl: input.evidenceUrl ? input.evidenceUrl.trim() : null, ...eventData,
    });
  } else if (["AcceptStep", "RejectStep"].includes(envelope.commandType)) {
    const acceptanceId = crypto.randomUUID();
    const waivers = (input.waivers || []).map((waiver) => ({ checkKey: waiver.checkKey.trim(), reason: waiver.reason.trim() }));
    const eventData = await addEvent({
      stepId: input.stepId, resultRevision: input.resultRevision,
      decision: envelope.commandType === "AcceptStep" ? "ACCEPTED" : "REJECTED",
      reason: input.reason.trim(), waivers: waivers,
    });
    Object.assign(payload, {
      acceptanceId: acceptanceId, decision: envelope.commandType === "AcceptStep" ? "ACCEPTED" : "REJECTED",
      reason: input.reason.trim(), waiversJson: JSON.stringify(waivers), ...eventData,
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
  try {
    await db.prepare("INSERT OR IGNORE INTO command_receipts (owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING',?)")
      .bind(identity.ownerId, envelope.commandId, hash, envelope.commandType, planId, envelope.expectedVersion == null ? null : envelope.expectedVersion, nowMs,
        identity.ownerId, actorType, JSON.stringify(payload), nowMs).run();
  } catch (error) { throw mapDbError(error); }
  receipt = await dbFirst(db, "SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?", identity.ownerId, envelope.commandId);
  if (!receipt) throw appError("INTERNAL_ERROR", "Не удалось сохранить результат tracker-команды.", 500);
  if (!await receiptMatchesCommand(receipt, envelope, hash)) throw appError("IDEMPOTENCY_KEY_REUSED", messageFor("IDEMPOTENCY_KEY_REUSED"), 409);
  return resultFromReceipt(receipt, false);
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
    payload.repositoryIds = Array.isArray(payload.repositoryIds) ? [...new Set(payload.repositoryIds)] : [];
    if (payload.repositoryIds.length > 10 || payload.repositoryIds.some((id) => typeof id !== "string" || id.length > 40)) {
      throw appError("VALIDATION_ERROR", "План может содержать до 10 доступных репозиториев.");
    }
    payload.repositoryRefs = payload.repositoryRefs && typeof payload.repositoryRefs === "object" && !Array.isArray(payload.repositoryRefs)
      ? payload.repositoryRefs : {};
    for (const [repositoryId, ref] of Object.entries(payload.repositoryRefs)) {
      if (!payload.repositoryIds.includes(repositoryId) || typeof ref !== "string" || !ref.trim() || ref.length > 255) {
        throw appError("VALIDATION_ERROR", "Каждая branch/ref должна относиться к выбранному репозиторию.");
      }
      payload.repositoryRefs[repositoryId] = ref.trim();
    }
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
    if (envelope.commandType === "ReviewCommitLink") {
      if (typeof payload.repositoryId !== "string" || !SHA.test(payload.sha || "")) throw appError("VALIDATION_ERROR", "Нужны repositoryId и полный SHA.");
      if (!["confirmed", "candidate", "excluded"].includes(payload.status)) throw appError("VALIDATION_ERROR", "Некорректный статус связи.");
      if (typeof payload.reason !== "string" || !payload.reason.trim()) throw appError("VALIDATION_ERROR", "Укажите основание ручной атрибуции.");
      if (payload.status === "confirmed") {
        const excluded = await dbFirst(db, "SELECT plan_id FROM plan_commit_links WHERE owner_id=? AND repository_id=? AND sha=? AND status='excluded' AND plan_id<>? LIMIT 1", identity.ownerId, payload.repositoryId, payload.sha, payload.planId);
        if (excluded) throw appError("COMMIT_EXCLUDED", "Сначала снимите явное исключение для этого коммита.", 409);
        const confirmed = await dbFirst(db, "SELECT plan_id FROM plan_commit_links WHERE owner_id=? AND repository_id=? AND sha=? AND status='confirmed' AND plan_id<>? LIMIT 1", identity.ownerId, payload.repositoryId, payload.sha, payload.planId);
        if (confirmed) throw appError("COMMIT_ALREADY_CONFIRMED", "Коммит уже подтверждён для другого плана.", 409);
      }
    }
  }

  const actorType = channel === "mcp" ? "agent" : "user";
  try {
    await db.prepare("INSERT OR IGNORE INTO command_receipts (owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING',?)")
      .bind(identity.ownerId, envelope.commandId, hash, envelope.commandType, planId, envelope.expectedVersion == null ? null : envelope.expectedVersion,
        nowMs, identity.ownerId, actorType, JSON.stringify(payload), nowMs).run();
  } catch (error) { throw mapDbError(error); }
  receipt = await dbFirst(db, "SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?", identity.ownerId, envelope.commandId);
  if (!receipt) throw appError("INTERNAL_ERROR", "Не удалось сохранить результат команды.", 500);
  if (!await receiptMatchesCommand(receipt, envelope, hash)) throw appError("IDEMPOTENCY_KEY_REUSED", messageFor("IDEMPOTENCY_KEY_REUSED"), 409);
  return resultFromReceipt(receipt, false);
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
  return {
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
  plan.repositories = await dbAll(db, "SELECT r.repository_id,r.full_name,r.is_private,r.default_branch,r.access_state,pr.selected_ref FROM plan_repositories pr JOIN repositories r ON r.owner_id=pr.owner_id AND r.repository_id=pr.repository_id WHERE pr.owner_id=? AND pr.plan_id=? AND (r.is_private=0 OR r.access_state='available') ORDER BY r.full_name", ownerId, planId);
  plan.commits = await dbAll(db, "SELECT c.repository_id,c.sha,c.author_at,c.committer_at,c.author_github_id,c.committer_github_id,c.author_login,c.committer_login,c.author_type,c.committer_type,c.author_name,c.committer_name,c.message,c.url,l.status AS link_status,l.basis AS link_basis,l.reason AS link_reason FROM plan_commit_links l JOIN commits c ON c.owner_id=l.owner_id AND c.repository_id=l.repository_id AND c.sha=l.sha JOIN repositories r ON r.owner_id=l.owner_id AND r.repository_id=l.repository_id WHERE l.owner_id=? AND l.plan_id=? AND (r.is_private=0 OR r.access_state='available') ORDER BY COALESCE(c.committer_at,c.author_at) DESC LIMIT 500", ownerId, planId);
  plan.commitConflicts = await dbAll(db, "SELECT c.repository_id,c.sha,c.marker_plan_ids_json,c.reason,c.detected_at,c.status FROM commit_attribution_conflicts c JOIN repositories r ON r.owner_id=c.owner_id AND r.repository_id=c.repository_id WHERE c.owner_id=? AND c.status='unresolved' AND (r.is_private=0 OR r.access_state='available') AND c.repository_id IN (SELECT repository_id FROM plan_repositories WHERE owner_id=? AND plan_id=?) ORDER BY c.detected_at DESC", ownerId, ownerId, planId);
  return plan;
}

async function readTrackerCapabilities(db, ownerId) {
  const row = await dbFirst(db, "SELECT COUNT(*) AS enabled_plan_count FROM tracker_plan_config WHERE owner_id=? AND enabled=1", ownerId);
  const ownerScope = await hashCommandInput({ purpose: "plan-time-tracker-local-observation-queue-v1", ownerId: ownerId });
  return {
    available: true, schemaVersion: 1, enabledPlanCount: row.enabled_plan_count,
    planOptIn: "first CreateStep", leaseMs: TRACKER_LEASE_MS, recommendedRenewAfterMs: 180000,
    maxRequiredChecks: 20, maxCheckKeyLength: 100, maxSummaryLength: 4000,
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
  const steps = await dbAll(db, "SELECT * FROM plan_steps WHERE owner_id=? AND plan_id=? ORDER BY ordinal,step_id", ownerId, planId);
  const incomplete = new Set((await dbAll(db, "SELECT step_id FROM tracker_incomplete_steps WHERE owner_id=? AND plan_id=?", ownerId, planId)).map((row) => row.step_id));
  for (const step of steps) {
    const results = await dbAll(db, "SELECT result_id,attempt_id,revision,outcome,summary,repository_id,revision_sha,created_at FROM step_results WHERE owner_id=? AND step_id=? ORDER BY revision DESC LIMIT 10", ownerId, step.step_id);
    for (const result of results) {
      if (result.repository_id && !allowedRepositories.has(result.repository_id)) {
        result.repository_id = null;
        result.revision_sha = null;
        result.protectedRevisionHidden = true;
      }
    }
    const attempts = await dbAll(db, "SELECT attempt_id,session_id,status,fence,lease_until,rework_reason,started_at,closed_at FROM step_attempts WHERE owner_id=? AND step_id=? ORDER BY fence DESC LIMIT 50", ownerId, step.step_id);
    const checks = await dbAll(db, "SELECT c.check_id,c.result_revision,c.event_id,c.check_key,c.status,c.tested_sha,c.exit_code,c.evidence_summary,c.evidence_url,c.created_at,r.repository_id AS result_repository_id FROM step_checks c JOIN step_results r ON r.owner_id=c.owner_id AND r.step_id=c.step_id AND r.revision=c.result_revision WHERE c.owner_id=? AND c.step_id=? ORDER BY c.created_at DESC,c.check_id DESC LIMIT 100", ownerId, step.step_id);
    for (const check of checks) {
      if (check.result_repository_id && !allowedRepositories.has(check.result_repository_id)) {
        check.tested_sha = null;
        check.evidence_url = null;
        check.protectedEvidenceHidden = true;
      }
      delete check.result_repository_id;
    }
    const acceptances = await dbAll(db, "SELECT acceptance_id,result_revision,decision,actor_id,reason,waivers_json,created_at FROM step_acceptances WHERE owner_id=? AND step_id=? ORDER BY created_at DESC,acceptance_id DESC LIMIT 20", ownerId, step.step_id);
    step.requiredChecks = parseColumn(step.required_checks_json, []);
    delete step.required_checks_json;
    step.currentResult = results.find((result) => result.revision === step.current_result_revision) || null;
    step.resultHistory = results;
    step.attempts = attempts;
    step.checks = checks;
    step.acceptances = acceptances.map((acceptance) => ({ ...acceptance, waivers: parseColumn(acceptance.waivers_json, []) }));
    for (const acceptance of step.acceptances) delete acceptance.waivers_json;
    step.currentAcceptance = step.current_acceptance_id ? step.acceptances.find((acceptance) => acceptance.acceptance_id === step.current_acceptance_id) || null : null;
    step.acceptanceCurrent = step.acceptance_decision === "ACCEPTED" && !incomplete.has(step.step_id);
  }
  const blockedEvents = await dbFirst(db, "SELECT COUNT(*) AS count FROM tracker_journal WHERE owner_id=? AND plan_id=? AND event_type='STEP_BLOCKED'", ownerId, planId);
  const retries = await dbFirst(db, "SELECT COUNT(*) AS count FROM step_attempts a JOIN plan_steps s ON s.owner_id=a.owner_id AND s.step_id=a.step_id WHERE a.owner_id=? AND s.plan_id=? AND a.fence>1", ownerId, planId);
  const failedResults = await dbFirst(db, "SELECT COUNT(*) AS count FROM step_results r JOIN plan_steps s ON s.owner_id=r.owner_id AND s.step_id=r.step_id WHERE r.owner_id=? AND s.plan_id=? AND r.outcome='FAILED'", ownerId, planId);
  const checkRows = await dbAll(db, "SELECT r.created_at AS result_at,MIN(c.created_at) AS first_check_at FROM step_results r JOIN plan_steps s ON s.owner_id=r.owner_id AND s.step_id=r.step_id JOIN step_checks c ON c.owner_id=r.owner_id AND c.step_id=r.step_id AND c.result_revision=r.revision WHERE r.owner_id=? AND s.plan_id=? GROUP BY r.step_id,r.revision,r.created_at", ownerId, planId);
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
  const data = event.payload && event.payload.data;
  if (data && ["commit_created", "commit_pushed", "push_failed"].includes(row.event_type) && data.repositoryId && data.revisionSha) {
    const repo = await dbFirst(db, "SELECT is_private,access_state FROM repositories WHERE owner_id=? AND repository_id=?", ownerId, data.repositoryId);
    if (!repo || (repo.is_private && repo.access_state !== "available")) {
      event.payload = { eventId: event.eventId, eventType: row.event_type, redacted: true };
      event.gitEvidence = { protectedDetailsHidden: true, localObserved: row.event_type === "commit_created", remoteVerified: null, refMembership: "unknown", attributionStatus: null };
      return event;
    }
    const commit = await dbFirst(db, "SELECT 1 AS present FROM commits WHERE owner_id=? AND repository_id=? AND sha=?", ownerId, data.repositoryId, data.revisionSha);
    let refMembership = "unknown";
    if (data.ref) {
      const membership = await dbFirst(db, "SELECT 1 AS present FROM repository_ref_commits WHERE owner_id=? AND repository_id=? AND ref=? AND sha=?", ownerId, data.repositoryId, data.ref, data.revisionSha);
      const state = await dbFirst(db, "SELECT completeness FROM repository_sync_state WHERE owner_id=? AND repository_id=? AND ref=?", ownerId, data.repositoryId, data.ref);
      refMembership = membership ? "present" : state && state.completeness === "complete" ? "absent_after_complete_sync" : "unknown";
    }
    const attribution = await dbFirst(db, "SELECT status FROM plan_commit_links WHERE owner_id=? AND plan_id=? AND repository_id=? AND sha=?", ownerId, planId, data.repositoryId, data.revisionSha);
    event.gitEvidence = {
      protectedDetailsHidden: false, localObserved: row.event_type === "commit_created",
      remoteVerified: Boolean(commit), refMembership: refMembership,
      attributionStatus: attribution ? attribution.status : null,
      pushFailed: row.event_type === "push_failed",
    };
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

export async function buildAnalytics(db, ownerId, filter, nowMs) {
  const timeZone = checkTimeZone(filter.timeZone || "UTC");
  const range = inclusiveDateRange(filter.from, filter.to, timeZone);
  const repoIds = [...new Set((filter.repositoryIds || []).filter((id) => typeof id === "string"))].slice(0, 10);
  const repoClause = repoIds.length ? " AND EXISTS (SELECT 1 FROM plan_repositories pr WHERE pr.owner_id=p.owner_id AND pr.plan_id=p.plan_id AND pr.repository_id IN (" + repoIds.map(() => "?").join(",") + "))" : "";
  const plans = await dbAll(db, "SELECT p.* FROM plans p WHERE p.owner_id=? " + repoClause + " ORDER BY p.registered_at DESC", ownerId, ...repoIds);
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
    repositories: await dbAll(db, "SELECT repository_id,full_name,is_private,access_state FROM repositories WHERE owner_id=? AND selected=1 ORDER BY full_name", ownerId),
    serverNow: nowMs,
  };
}

function parseLinks(value) {
  const output = {};
  for (const part of (value || "").split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) output[match[2]] = match[1];
  }
  return output;
}

export class GitHubRestAdapter {
  constructor(token, fetchImpl, options) {
    this.token = typeof token === "string" && token.trim() ? token.trim() : null;
    this.authenticated = Boolean(this.token);
    this.fetchImpl = fetchImpl || globalThis.fetch.bind(globalThis);
    this.maxAttempts = Math.max(1, Math.min(4, options && options.maxAttempts || 3));
    this.now = options && options.now || (() => Date.now());
    this.sleep = options && options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxInlineWaitMs = options && options.maxInlineWaitMs != null ? options.maxInlineWaitMs : 1500;
    this.requestTimeoutMs = options && Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0 ? options.requestTimeoutMs : GITHUB_REQUEST_TIMEOUT_MS;
  }
  retryAfterMs(response) {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) return Math.max(0, date - this.now());
    }
    const reset = Number(response.headers.get("x-ratelimit-reset") || 0) * 1000;
    return reset > 0 ? Math.max(0, reset - this.now()) : null;
  }
  async request(url) {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        let response;
        let fetchPromise;
        try {
          const headers = {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28", "user-agent": "plan-time-tracker-site",
          };
          if (this.token) headers.authorization = "Bearer " + this.token;
          fetchPromise = this.fetchImpl(url, { headers, signal: controller.signal });
        } catch {
          throw appError("SOURCE_UNAVAILABLE", "Не удалось запустить запрос к GitHub.", 502,
            { retryable: false, attempts: attempt, failureKind: "invocation" });
        }
        try {
          response = await fetchPromise;
        } catch {
          if (attempt >= this.maxAttempts) throw appError("SOURCE_UNAVAILABLE", "GitHub network request failed after bounded retries.", 502,
            { retryable: true, attempts: attempt, failureKind: "network" });
          await this.sleep(Math.min(400, 100 * 2 ** (attempt - 1)));
          continue;
        }
        let errorBody = null;
        if (!response.ok && [401, 403, 404, 422].includes(response.status)) {
          try { errorBody = await response.clone().json(); } catch { errorBody = null; }
        }
        const rateLimited = response.status === 429 || response.status === 403 && (
          response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after") ||
          /rate limit/i.test(String(errorBody && errorBody.message || ""))
        );
        const transient = [500, 502, 503, 504].includes(response.status);
        if (rateLimited || transient) {
          const waitMs = this.retryAfterMs(response);
          if (attempt < this.maxAttempts && (waitMs == null || waitMs <= this.maxInlineWaitMs)) {
            await this.sleep(waitMs == null ? Math.min(400, 100 * 2 ** (attempt - 1)) : waitMs);
            continue;
          }
          if (rateLimited) {
            throw appError("RATE_LIMITED", this.authenticated
              ? "GitHub временно ограничил запросы. Повторите позже."
              : "GitHub ограничил запросы; без входа лимит ниже. Повторите позже.", 429,
              { retryAfter: waitMs == null ? null : Math.ceil(waitMs / 1000), retryAt: waitMs == null ? null : this.now() + waitMs, attempts: attempt });
          }
          throw appError("SOURCE_UNAVAILABLE", "GitHub временно недоступен.", 502,
            { retryable: true, retryAfter: waitMs == null ? null : Math.ceil(waitMs / 1000), attempts: attempt });
        }
        if (response.status === 401) throw appError("GITHUB_AUTH_INVALID", "GitHub отклонил настроенный токен. Проверьте runtime-доступ.", 401, { status: 401, retryable: false });
        if (response.status === 404) throw appError("GITHUB_REPOSITORY_UNAVAILABLE", this.authenticated
          ? "Репозиторий не найден или токену недоступен."
          : "Репозиторий не найден или закрыт. Без GitHub-доступа доступны только открытые репозитории.", 404,
        { status: 404, retryable: false });
        if (response.status === 403) throw appError("GITHUB_ACCESS_DENIED", "GitHub отказал в доступе. Проверьте права токена или доступность открытого репозитория.", 403, { status: 403, retryable: false });
        if (response.status === 422) throw appError("GITHUB_REQUEST_INVALID", "GitHub не принял запрос. Проверьте название репозитория и ветки.", 422, { status: 422, retryable: false });
        if (!response.ok) throw appError("SOURCE_UNAVAILABLE", "GitHub временно недоступен.", 502, { status: response.status, retryable: true });
        return { data: await response.json(), links: parseLinks(response.headers.get("link")) };
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        if (attempt >= this.maxAttempts) throw appError("SOURCE_UNAVAILABLE", "GitHub не ответил за отведённое время.", 502,
          { retryable: true, attempts: attempt, failureKind: "timeout" });
        await this.sleep(Math.min(400, 100 * 2 ** (attempt - 1)));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw appError("SOURCE_UNAVAILABLE", "GitHub request exhausted bounded retries.", 502, { retryable: true });
  }
  async repository(owner, repo) { return (await this.request("https://api.github.com/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo))).data; }
  async commitPage(fullName, page, ref) {
    const parts = fullName.split("/");
    return this.request("https://api.github.com/repos/" + encodeURIComponent(parts[0]) + "/" + encodeURIComponent(parts[1]) +
      "/commits?per_page=100&page=" + page + "&sha=" + encodeURIComponent(ref));
  }
}

export async function syncRepository(db, ownerId, fullName, cursor, requestedRef, adapter, nowMs, options = {}) {
  if (typeof fullName !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw appError("VALIDATION_ERROR", "Укажите владельца и название репозитория.");
  const parts = fullName.split("/");
  const cachedRepo = await dbFirst(db, "SELECT repository_id,is_private,access_state FROM repositories WHERE owner_id=? AND full_name=?", ownerId, fullName);
  if (cachedRepo && cachedRepo.is_private && cachedRepo.access_state === "revoked" && !options.allowRecheck) {
    throw appError("SOURCE_UNAVAILABLE", "Доступ к приватному репозиторию отозван; чтение заблокировано до явного восстановления доступа.", 503, { retryable: false });
  }
  let info;
  try { info = await adapter.repository(parts[0], parts[1]); }
  catch (error) {
    if (cachedRepo && cachedRepo.is_private && adapter.authenticated !== false && error.code !== "GITHUB_AUTH_INVALID" && error.details && [401, 404].includes(error.details.status)) {
      await db.prepare("UPDATE repositories SET access_state='revoked',updated_at=? WHERE owner_id=? AND repository_id=?")
        .bind(nowMs, ownerId, cachedRepo.repository_id).run();
    }
    throw error;
  }
  if (adapter.authenticated === false && info.private) {
    throw appError("GITHUB_REPOSITORY_UNAVAILABLE", "Репозиторий закрыт. Без GitHub-доступа доступны только открытые репозитории.", 404, { status: 404, retryable: false });
  }
  const repositoryId = String(info.id);
  const ref = typeof requestedRef === "string" && requestedRef.trim() ? requestedRef.trim() : info.default_branch || "main";
  if (ref.length > 255) throw appError("VALIDATION_ERROR", "Название ветки или ref слишком длинное.");
  await db.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,?,?,'available',1,?) ON CONFLICT(owner_id,repository_id) DO UPDATE SET full_name=excluded.full_name,is_private=excluded.is_private,default_branch=excluded.default_branch,access_state='available',selected=1,updated_at=excluded.updated_at")
    .bind(ownerId, repositoryId, info.full_name, info.private ? 1 : 0, info.default_branch || "main", nowMs).run();

  const saved = await dbFirst(db, "SELECT cursor,completeness,reconciliation_id,author_filter_json FROM repository_sync_state WHERE owner_id=? AND repository_id=? AND ref=?", ownerId, repositoryId, ref);
  const authorFilter = Array.isArray(options.authorGithubIds)
    ? [...new Set(options.authorGithubIds)]
    : parseColumn(saved && saved.author_filter_json, null);
  const resumeReconciliation = Boolean(saved && saved.completeness === "partial" && saved.reconciliation_id);
  const fullRescan = Boolean(options.fullRescan) || resumeReconciliation;
  const reconciliationId = fullRescan ? (resumeReconciliation ? saved.reconciliation_id : crypto.randomUUID()) : null;
  let page = fullRescan
    ? resumeReconciliation ? Math.max(1, Number(saved.cursor) || 1) : 1
    : Math.max(1, Number.parseInt(cursor || saved && saved.cursor || "1", 10) || 1);
  let complete = false;
  let imported = 0;
  let lastError = null;
  let lastErrorDetails = null;
  let lastErrorMessage = null;
  const startingPage = page;

  const saveState = async (nextPage, isComplete, errorCode) => {
    await db.prepare("INSERT INTO repository_sync_state(owner_id,repository_id,ref,last_successful_sync_at,cursor,completeness,last_error_code,reconciliation_id,author_filter_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,repository_id,ref) DO UPDATE SET last_successful_sync_at=CASE WHEN excluded.completeness='complete' THEN excluded.last_successful_sync_at ELSE repository_sync_state.last_successful_sync_at END,cursor=excluded.cursor,completeness=excluded.completeness,last_error_code=excluded.last_error_code,reconciliation_id=excluded.reconciliation_id,author_filter_json=COALESCE(excluded.author_filter_json,repository_sync_state.author_filter_json)")
      .bind(ownerId, repositoryId, ref, isComplete ? nowMs : null, isComplete ? null : String(nextPage), isComplete ? "complete" : "partial", errorCode, isComplete ? null : reconciliationId || saved && saved.reconciliation_id || null, Array.isArray(options.authorGithubIds) ? JSON.stringify(authorFilter) : null).run();
  };

  await saveState(page, false, null);
  for (let count = 0; count < PAGE_LIMIT; count += 1) {
    const currentPage = page;
    let response;
    try { response = await adapter.commitPage(info.full_name, currentPage, ref); }
    catch (error) {
      lastError = error.code || "SOURCE_UNAVAILABLE";
      lastErrorDetails = error.details || null;
      lastErrorMessage = error.message || "Не удалось загрузить коммиты из GitHub.";
      if (info.private && adapter.authenticated !== false && lastError !== "GITHUB_AUTH_INVALID" && lastErrorDetails && [401, 404].includes(lastErrorDetails.status)) {
        await db.prepare("UPDATE repositories SET access_state='revoked',updated_at=? WHERE owner_id=? AND repository_id=?")
          .bind(nowMs, ownerId, repositoryId).run();
      }
      await saveState(currentPage, false, lastError);
      break;
    }
    const items = Array.isArray(response.data) ? response.data : [];
    const valid = items.filter((item) => SHA.test(String(item.sha || "")));
    const writes = [];
    for (const item of valid) {
      const commit = item.commit || {};
      const sha = String(item.sha);
      const authorAt = Date.parse(commit.author && commit.author.date || "") || null;
      const committerAt = Date.parse(commit.committer && commit.committer.date || "") || null;
      writes.push(db.prepare("INSERT INTO commits(owner_id,repository_id,sha,author_at,committer_at,observed_at,author_github_id,committer_github_id,author_login,committer_login,author_type,committer_type,author_name,committer_name,message,url,parents_json,refs_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,repository_id,sha) DO UPDATE SET author_at=excluded.author_at,committer_at=excluded.committer_at,observed_at=excluded.observed_at,author_github_id=excluded.author_github_id,committer_github_id=excluded.committer_github_id,author_login=excluded.author_login,committer_login=excluded.committer_login,author_type=excluded.author_type,committer_type=excluded.committer_type,author_name=excluded.author_name,committer_name=excluded.committer_name,message=excluded.message,url=excluded.url,parents_json=excluded.parents_json")
        .bind(ownerId, repositoryId, sha, authorAt, committerAt, nowMs, item.author && item.author.id != null ? String(item.author.id) : null,
          item.committer && item.committer.id != null ? String(item.committer.id) : null,
          String(item.author && item.author.login || "").slice(0, 255), String(item.committer && item.committer.login || "").slice(0, 255),
          String(item.author && item.author.type || "Unknown").slice(0, 50), String(item.committer && item.committer.type || "Unknown").slice(0, 50),
          String(commit.author && commit.author.name || "").slice(0, 500), String(commit.committer && commit.committer.name || "").slice(0, 500), String(commit.message || "").slice(0, 20000),
          "https://github.com/" + info.full_name + "/commit/" + sha,
          JSON.stringify((item.parents || []).map((parent) => parent.sha)), "[]"));
      writes.push(db.prepare("INSERT INTO repository_ref_commits(owner_id,repository_id,ref,sha,last_seen_sync_id) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,repository_id,ref,sha) DO UPDATE SET last_seen_sync_id=excluded.last_seen_sync_id")
        .bind(ownerId, repositoryId, ref, sha, reconciliationId || "incremental"));
    }
    for (let offset = 0; offset < writes.length; offset += 90) await db.batch(writes.slice(offset, offset + 90));
    await db.prepare("UPDATE commits SET refs_json=COALESCE((SELECT json_group_array(r.ref) FROM repository_ref_commits r WHERE r.owner_id=commits.owner_id AND r.repository_id=commits.repository_id AND r.sha=commits.sha),'[]') WHERE owner_id=? AND repository_id=?")
      .bind(ownerId, repositoryId).run();
    for (const item of valid) await applyCommitAttribution(db, ownerId, repositoryId, ref, item, nowMs, authorFilter);
    imported += valid.length;
    const hasNext = Boolean(response.links && response.links.next) && items.length > 0;
    if (!hasNext) {
      complete = true;
      page = null;
      if (fullRescan) {
        await db.prepare("DELETE FROM repository_ref_commits WHERE owner_id=? AND repository_id=? AND ref=? AND last_seen_sync_id<>?")
          .bind(ownerId, repositoryId, ref, reconciliationId).run();
        await db.prepare("UPDATE commits SET refs_json=COALESCE((SELECT json_group_array(r.ref) FROM repository_ref_commits r WHERE r.owner_id=commits.owner_id AND r.repository_id=commits.repository_id AND r.sha=commits.sha),'[]') WHERE owner_id=? AND repository_id=?")
          .bind(ownerId, repositoryId).run();
      }
      await saveState(null, true, null);
      break;
    }
    page = currentPage + 1;
    // Page data is durable before the cursor advances. A failure on the next page resumes here.
    await saveState(page, false, null);
  }
  return {
    repositoryId: repositoryId, fullName: info.full_name, ref: ref, imported: imported,
    completeness: complete ? "complete" : "partial", nextPage: complete ? null : page,
    error: lastError, errorMessage: lastErrorMessage,
    failureKind: lastErrorDetails && lastErrorDetails.failureKind || null,
    retryAfter: lastErrorDetails && lastErrorDetails.retryAfter != null ? lastErrorDetails.retryAfter : null,
    retryAt: lastErrorDetails && lastErrorDetails.retryAt != null ? lastErrorDetails.retryAt : null,
    reconciliation: fullRescan ? "full" : "incremental",
    resumedFromPage: startingPage,
  };
}

async function applyCommitAttribution(db, ownerId, repositoryId, ref, item, nowMs, authorFilter) {
  const sha = String(item.sha);
  const message = String(item.commit && item.commit.message || "");
  const markerValues = [...new Set([...message.matchAll(/^[ \t]*Plan-ID:[ \t]*(.*?)[ \t]*$/gim)].map((match) => match[1].trim()))];
  const markerIds = markerValues.map((value) => UUID.test(value) ? value.toLowerCase() : "invalid:" + value.slice(0, 200));
  const excluded = await dbFirst(db, "SELECT plan_id FROM plan_commit_links WHERE owner_id=? AND repository_id=? AND sha=? AND status='excluded' LIMIT 1", ownerId, repositoryId, sha);
  if (markerIds.length) {
    const target = markerIds.length === 1 ? await dbFirst(db,
      "SELECT p.plan_id FROM plans p JOIN plan_repositories pr ON pr.owner_id=p.owner_id AND pr.plan_id=p.plan_id WHERE p.owner_id=? AND lower(p.plan_id)=? AND pr.repository_id=? AND pr.selected_ref=?",
      ownerId, markerIds[0], repositoryId, ref) : null;
    if (markerIds.length !== 1 || !target) {
      await db.prepare("INSERT INTO commit_attribution_conflicts(owner_id,repository_id,sha,marker_plan_ids_json,reason,detected_at,status) VALUES(?,?,?,?,?,?,'unresolved') ON CONFLICT(owner_id,repository_id,sha) DO UPDATE SET marker_plan_ids_json=excluded.marker_plan_ids_json,reason=excluded.reason,detected_at=excluded.detected_at,status='unresolved',resolved_by=NULL,resolved_at=NULL")
      .bind(ownerId, repositoryId, sha, JSON.stringify(markerIds), markerIds.length > 1 ? "multiple_plan_markers" : "unknown_or_unselected_plan_or_ref", nowMs).run();
      return;
    }
    if (excluded) return;
    const alreadyConfirmed = await dbFirst(db, "SELECT plan_id FROM plan_commit_links WHERE owner_id=? AND repository_id=? AND sha=? AND status='confirmed' AND plan_id<>? LIMIT 1", ownerId, repositoryId, sha, target.plan_id);
    if (alreadyConfirmed) {
      await db.prepare("INSERT INTO commit_attribution_conflicts(owner_id,repository_id,sha,marker_plan_ids_json,reason,detected_at,status) VALUES(?,?,?,?,?,?,'unresolved') ON CONFLICT(owner_id,repository_id,sha) DO UPDATE SET marker_plan_ids_json=excluded.marker_plan_ids_json,reason=excluded.reason,detected_at=excluded.detected_at,status='unresolved'")
        .bind(ownerId, repositoryId, sha, JSON.stringify(markerIds), "commit_already_confirmed_to_another_plan", nowMs).run();
      return;
    }
    await db.prepare("INSERT OR IGNORE INTO plan_commit_links(owner_id,plan_id,repository_id,sha,status,basis,reason,reviewed_by,reviewed_at,history_json) VALUES(?,?,?,?,'confirmed','marker','Exact Plan-ID marker',?,?, '[]')")
      .bind(ownerId, target.plan_id, repositoryId, sha, ownerId, nowMs).run();
    return;
  }
  if (excluded) return;
  const authorId = item.author && item.author.id != null ? String(item.author.id) : null;
  const committerAt = Date.parse(item.commit && item.commit.committer && item.commit.committer.date || "") || null;
  if (!authorId || committerAt == null) return;
  if (Array.isArray(authorFilter) && authorFilter.length && !authorFilter.includes(authorId)) return;
  await db.prepare("INSERT OR IGNORE INTO plan_commit_links(owner_id,plan_id,repository_id,sha,status,basis,reason,reviewed_by,reviewed_at,history_json) SELECT ?,p.plan_id,?,?, 'candidate','time','Committer timestamp overlaps a work interval; review attribution',?,?,'[]' FROM plans p JOIN plan_repositories pr ON pr.plan_id=p.plan_id AND pr.owner_id=p.owner_id JOIN work_intervals wi ON wi.owner_id=p.owner_id AND wi.plan_id=p.plan_id WHERE p.owner_id=? AND pr.repository_id=? AND pr.selected_ref=? AND wi.start_ms<=? AND COALESCE(wi.end_ms,?)>? AND NOT EXISTS(SELECT 1 FROM plan_commit_links l WHERE l.owner_id=p.owner_id AND l.repository_id=? AND l.sha=? AND l.status='confirmed')")
    .bind(ownerId, repositoryId, sha, ownerId, nowMs, ownerId, repositoryId, ref, committerAt, nowMs, committerAt, repositoryId, sha).run();
}

const SYNC_EXECUTION_LEASE_MS = 5 * 60 * 1000;

class SyncLeaseLostError extends Error {}

function syncExecutionDatabase(db, ownerId, commandId, leaseUntil) {
  const fencedBatch = async (statements) => {
    try {
      // The guard and all writes share one atomic D1 batch; a separate read would race with recovery.
      const results = await db.batch([
        db.prepare("INSERT INTO sync_execution_guards(owner_id,command_id,lease_until) VALUES(?,?,?)").bind(ownerId, commandId, leaseUntil),
        ...statements,
        db.prepare("DELETE FROM sync_execution_guards WHERE owner_id=? AND command_id=?").bind(ownerId, commandId),
      ]);
      return results.slice(1, -1);
    } catch (error) {
      if (String(error && error.message || "").includes("SYNC_LEASE_LOST")) throw new SyncLeaseLostError();
      throw error;
    }
  };
  const wrap = (statement) => ({
    statement,
    bind(...args) { return wrap(statement.bind(...args)); },
    async run() { return (await fencedBatch([statement]))[0]; },
    first() { return statement.first(); },
    all() { return statement.all(); },
  });
  return {
    prepare(sql) { return wrap(db.prepare(sql)); },
    batch(statements) { return fencedBatch(statements.map((statement) => statement.statement)); },
  };
}

async function claimPendingSyncReceipt(db, ownerId, commandId, nowMs) {
  const leaseUntil = nowMs + SYNC_EXECUTION_LEASE_MS;
  const updated = await db.prepare("UPDATE command_receipts SET execution_lease_until=? WHERE owner_id=? AND command_id=? AND outcome_code='PENDING' AND COALESCE(execution_lease_until,recorded_at+?)<=?")
    .bind(leaseUntil, ownerId, commandId, SYNC_EXECUTION_LEASE_MS, nowMs).run();
  return Boolean(updated.meta && updated.meta.changes === 1);
}

async function pendingSyncError(db, ownerId, commandId, nowMs) {
  const receipt = await dbFirst(db, "SELECT execution_lease_until,recorded_at FROM command_receipts WHERE owner_id=? AND command_id=?", ownerId, commandId);
  const leaseUntil = receipt && (receipt.execution_lease_until || receipt.recorded_at + SYNC_EXECUTION_LEASE_MS);
  const retryAfter = Math.max(1, Math.ceil(((leaseUntil || nowMs + 1) - nowMs) / 1000));
  return appError("INTERNAL_ERROR", "Синхронизация с этим commandId ещё обрабатывается; повторите позже.", 409, { retryable: true, retryAfter });
}

export async function executeSyncCommand(db, identity, envelope, channel, token, nowMs, adapterOverride) {
  if (!envelope || envelope.schemaVersion !== 1 || envelope.commandType !== "SyncRepository" || !UUID.test(envelope.commandId || "")) {
    throw appError("VALIDATION_ERROR", "SyncRepository требует schemaVersion=1 и UUID commandId.");
  }
  if (!envelope.payload || typeof envelope.payload !== "object" || typeof envelope.payload.fullName !== "string") {
    throw appError("VALIDATION_ERROR", "Укажите payload.fullName.");
  }
  if (envelope.payload.authorGithubIds !== undefined && (!Array.isArray(envelope.payload.authorGithubIds) || envelope.payload.authorGithubIds.length > 100 || envelope.payload.authorGithubIds.some((id) => typeof id !== "string" || !/^\d{1,30}$/.test(id)))) {
    throw appError("VALIDATION_ERROR", "authorGithubIds должен содержать не более 100 числовых GitHub ID.");
  }
  const hash = await payloadHash(envelope);
  if (envelope.payloadHash && envelope.payloadHash !== hash) throw appError("VALIDATION_ERROR", "payloadHash не совпадает с конвертом.");
  const payload = {
    fullName: envelope.payload.fullName,
    cursor: envelope.payload.cursor || null,
    ref: typeof envelope.payload.ref === "string" ? envelope.payload.ref : null,
    fullRescan: envelope.payload.fullRescan === true,
    ...(Array.isArray(envelope.payload.authorGithubIds) ? { authorGithubIds: [...new Set(envelope.payload.authorGithubIds)] } : {}),
  };
  let receipt = await dbFirst(db, "SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?", identity.ownerId, envelope.commandId);
  if (receipt) {
    if (receipt.payload_hash !== hash) throw appError("IDEMPOTENCY_KEY_REUSED", messageFor("IDEMPOTENCY_KEY_REUSED"), 409);
    if (receipt.outcome_code !== "PENDING") return resultFromReceipt(receipt, true);
    if (!await claimPendingSyncReceipt(db, identity.ownerId, envelope.commandId, nowMs)) {
      throw await pendingSyncError(db, identity.ownerId, envelope.commandId, nowMs);
    }
  } else {
    const actorType = channel === "mcp" ? "agent" : "user";
    const inserted = await db.prepare("INSERT OR IGNORE INTO command_receipts (owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,execution_lease_until,recorded_at) VALUES(?,?,?,'SyncRepository',NULL,NULL,?,?,?,?,'PENDING',?,?)")
      .bind(identity.ownerId, envelope.commandId, hash, nowMs, identity.ownerId, actorType, JSON.stringify(payload), nowMs + SYNC_EXECUTION_LEASE_MS, nowMs).run();
    receipt = await dbFirst(db, "SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?", identity.ownerId, envelope.commandId);
    if (!receipt) throw appError("INTERNAL_ERROR", "Не удалось сохранить квитанцию синхронизации.", 500);
    if (receipt.payload_hash !== hash) throw appError("IDEMPOTENCY_KEY_REUSED", messageFor("IDEMPOTENCY_KEY_REUSED"), 409);
    if (receipt.outcome_code !== "PENDING") return resultFromReceipt(receipt, true);
    if (!inserted.meta || inserted.meta.changes !== 1) {
      if (!await claimPendingSyncReceipt(db, identity.ownerId, envelope.commandId, nowMs)) {
        throw await pendingSyncError(db, identity.ownerId, envelope.commandId, nowMs);
      }
    }
  }
  const executionDb = syncExecutionDatabase(db, identity.ownerId, envelope.commandId, nowMs + SYNC_EXECUTION_LEASE_MS);
  try {
    let result;
    let outcome = "OK";
    try {
      result = await syncRepository(executionDb, identity.ownerId, payload.fullName, payload.cursor, payload.ref, adapterOverride || new GitHubRestAdapter(token), nowMs, { fullRescan: payload.fullRescan, authorGithubIds: payload.authorGithubIds });
      if (result.error || result.completeness === "partial") outcome = "PARTIAL";
    } catch (error) {
      if (error instanceof SyncLeaseLostError) throw error;
      const errorCode = error.code || "SOURCE_UNAVAILABLE";
      if (["SOURCE_UNAVAILABLE", "RATE_LIMITED"].includes(errorCode)) {
        outcome = "PARTIAL";
        const saved = await dbFirst(db, "SELECT r.repository_id,r.default_branch,s.cursor FROM repositories r LEFT JOIN repository_sync_state s ON s.owner_id=r.owner_id AND s.repository_id=r.repository_id AND s.ref=COALESCE(NULLIF(?,''),r.default_branch) WHERE r.owner_id=? AND r.full_name=?",
          payload.ref || "", identity.ownerId, payload.fullName);
        if (saved) {
          const ref = payload.ref || saved.default_branch;
          await executionDb.prepare("INSERT INTO repository_sync_state(owner_id,repository_id,ref,last_successful_sync_at,cursor,completeness,last_error_code,reconciliation_id) VALUES(?,?,?,NULL,?,'partial',?,NULL) ON CONFLICT(owner_id,repository_id,ref) DO UPDATE SET cursor=COALESCE(repository_sync_state.cursor,excluded.cursor),completeness='partial',last_error_code=excluded.last_error_code")
            .bind(identity.ownerId, saved.repository_id, ref, saved.cursor || "1", errorCode).run();
        }
        result = { repositoryId: saved && saved.repository_id || null, fullName: payload.fullName, ref: payload.ref || saved && saved.default_branch || null, completeness: "partial", nextPage: saved && saved.cursor || "1", error: errorCode, errorMessage: error.message || "Не удалось загрузить данные из GitHub.", failureKind: error.details && error.details.failureKind || null, retryAfter: error.details && error.details.retryAfter != null ? error.details.retryAfter : null, retryAt: error.details && error.details.retryAt || null };
      } else {
        outcome = errorCode;
        result = { error: outcome, message: error.message, details: error.details || null };
      }
    }
    await executionDb.prepare("UPDATE command_receipts SET outcome_code=?,result_json=?,execution_lease_until=NULL WHERE owner_id=? AND command_id=? AND outcome_code='PENDING'")
      .bind(outcome, JSON.stringify(result), identity.ownerId, envelope.commandId).run();
    receipt = await dbFirst(db, "SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?", identity.ownerId, envelope.commandId);
    return resultFromReceipt(receipt, false);
  } catch (error) {
    if (!(error instanceof SyncLeaseLostError)) throw error;
    receipt = await dbFirst(db, "SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?", identity.ownerId, envelope.commandId);
    if (receipt && receipt.outcome_code !== "PENDING") return resultFromReceipt(receipt, true);
    throw await pendingSyncError(db, identity.ownerId, envelope.commandId, nowMs);
  }
}

const UI_ENHANCEMENTS = String.raw`(()=> {
  const q = (s) => document.querySelector(s);
  const make = (tag, text, cls) => { const x=document.createElement(tag); if(text!=null)x.textContent=text; if(cls)x.className=cls; return x; };
  const supportedZones = ${JSON.stringify(UI_TIME_ZONES.map((option) => option.value))};
  const normalizeZone = (value) => supportedZones.includes(value) ? value : "Asia/Omsk";
  const state = { zone: "Asia/Omsk", repositories: [], analytics: null };
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
    const repoWrap=make("div",null,"field"),repoLabel=make("label","Репозиторий");repoLabel.htmlFor=id+"Repo";
    const repo=make("select");repo.id=id+"Repo";repo.append(new Option("Все репозитории",""));repoWrap.append(repoLabel,repo);
    const apply=make("button","Применить","primary");apply.type="button";
    const modeWrap=make("div",null,"field"),modeLabel=make("label","Показать");modeLabel.htmlFor=id+"Mode";
    const mode=make("select");mode.id=id+"Mode";mode.append(new Option("Активность за период","activity"),new Option("Завершённые за период","finished"));modeWrap.append(modeLabel,mode);
    toolbar.append(fromWrap,toWrap,repoWrap,modeWrap,apply);
    const stats=make("div",null,"metrics"),list=make("div",null,"list");
    panel.append(heading,toolbar,stats,list);
    target.prepend(panel);
    return {panel,from,to,repo,mode,apply,stats,list};
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
  planFilter.list.id="planPeriodPlans";
  const inactive=make("div",null,"list");inactive.id="inactivePeriodPlans";
  const inactiveHeading=make("h3","Планы без активности");
  planFilter.panel.append(inactiveHeading,inactive);
  const analyticsToolbar=q("#view-analytics .toolbar");
  const analyticsRepoWrap=make("div",null,"field"),analyticsRepoLabel=make("label","Репозиторий");analyticsRepoLabel.htmlFor="analyticsRepo";
  const analyticsRepo=make("select");analyticsRepo.id="analyticsRepo";analyticsRepo.append(new Option("Все репозитории",""));
  analyticsRepoWrap.append(analyticsRepoLabel,analyticsRepo);analyticsToolbar.insertBefore(analyticsRepoWrap,q("#apply"));
  async function loadRepositories() {
    const data=await api("/api/repositories");
    state.repositories=data.repositories||[];
    for(const select of [overviewFilter.repo,planFilter.repo,analyticsRepo]) {
      const value=select.value;select.replaceChildren(new Option("Все репозитории",""));
      state.repositories.filter(r=>r.accessState!=="revoked").forEach(r=>select.append(new Option(r.fullName+(r.isPrivate?" · закрытый":" · открытый"),r.repositoryId)));
      if([...select.options].some(o=>o.value===value))select.value=value;
    }
    const list=q("#repos");
    if(list) {
      state.repositories.forEach(r=>{
        const row=[...list.children].find(x=>x.dataset.repositoryId===r.repositoryId);
        if(row){row.dataset.accessState=r.accessState;row.dataset.private=r.isPrivate?"true":"false";const status=row.children[1];if(status){status.classList.add("repo-sync-status");status.textContent=repositorySyncStatus(r);}}
      });
    }
    return data;
  }
  function rangeQuery(filter) {
    const params=new URLSearchParams({from:filter.from.value,to:filter.to.value,timeZone:state.zone});
    if(filter.repo.value)params.set("repositoryId",filter.repo.value);
    return params.toString();
  }
  function formatPlanSample(count) {
    const n=Number(count)||0,lastTwo=n%100;
    return "по "+n+" "+((lastTwo>=11&&lastTwo<=14)||n%10!==1?"планам":"плану");
  }
  function repositorySyncStatus(repository) {
    if(repository.syncStatusUnavailable)return "Состояние скрыто · нет доступа к GitHub";
    const states=repository.syncStates||[];
    if(!states.length)return "Ещё не синхронизирована · "+(repository.defaultBranch||"main");
    return states.map(sync=>{
      const ref=sync.ref||repository.defaultBranch||"main";
      const formatted=sync.lastSuccessfulSyncAt==null?"":new Intl.DateTimeFormat("ru-RU",{dateStyle:"medium",timeStyle:"short",timeZone:state.zone}).format(new Date(sync.lastSuccessfulSyncAt));
      if(sync.completeness==="complete")return "Синхронизирована · "+ref+(formatted?" · "+formatted:"");
      if(sync.completeness==="partial")return "Частично синхронизирована · "+ref+(formatted?" · последняя полная "+formatted:"")+(sync.lastErrorCode?" · есть ошибка":"");
      return "Ещё не синхронизирована · "+ref;
    }).join("; ");
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
    if(!filter.from.value||!filter.to.value)return;
    const data=await api("/api/analytics?"+rangeQuery(filter));
    state.analytics=data;
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
    allPlanRows.forEach(row=>row.hidden=!visibleIds.has(row.dataset.planId));
    const inactiveRows=filter.mode.value==="activity"?data.inactivePlans||[]:[];
    const inactiveIds=new Set(inactiveRows.map(p=>p.planId));
    allPlanRows.forEach(row=>{if(inactiveIds.has(row.dataset.planId))row.hidden=true;});
    inactive.replaceChildren();
    if(!inactiveRows.length){inactive.append(make("p","Нет планов без активности.","muted"));}
    else {
      inactiveRows.forEach(p=>{
        const row=make("div",null,"row");
        row.append(make("span",p.title+" · "+(p.status==="PAUSED"?"на паузе":"запланирован")));
        const action=make("button",p.status==="PAUSED"?"Продолжить":"Запустить","primary");
        action.onclick=async()=>{
          try {
            const commandType=p.status==="PAUSED"?"ResumePlan":"StartPlan";
            const response=await api("/api/commands",{method:"POST",body:JSON.stringify({schemaVersion:1,commandId:crypto.randomUUID(),commandType,expectedVersion:p.version,payload:{planId:p.planId}})});
            if(response.applied)window.alert("Изменение сохранено.");
            await loadFilter(filter,false);
          } catch(e){window.alert(e.message);}
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
  q("#apply").onclick=async ()=>{
    try {
      const filter={from:q("#from"),to:q("#to"),repo:analyticsRepo,stats:q("#stats"),list:q("#analyticPlans"),mode:make("select"),analyticsOnly:true};
      await loadFilter(filter,false);
      const data=state.analytics;
      if(data) {
        renderPeriodList(q("#analyticPlans"),data.plans.filter(p=>p.activeInPeriodMs>0||p.finishedAt!=null),false);
      }
    } catch(e){window.alert(e.message);}
  };
  async function renderSettingsExtras() {
    const data=await loadRepositories();
    const list=q("#repos");
    state.repositories.forEach(r=>{
      const row=[...list.children].find(x=>x.dataset.repositoryId===r.repositoryId);
      if(!row)return;
      row.dataset.repositoryId=r.repositoryId;
      if(r.accessState==="revoked"&&r.isPrivate&&!row.dataset.cacheActions) {
        row.dataset.cacheActions="true";
        const clear=make("button","Очистить кэш GitHub");
        clear.onclick=async()=>{if(!window.confirm("Удалить сохранённые коммиты и данные GitHub? Планы и интервалы останутся."))return;try{await api("/api/repositories/"+encodeURIComponent(r.repositoryId)+"/cache",{method:"DELETE"});window.alert("Кэш очищен. Планы и интервалы сохранены.");await renderSettingsExtras();}catch(e){window.alert(e.message);}};
        const restore=make("button","Проверить доступ к GitHub");
        restore.onclick=async()=>{if(!window.confirm("Подтвердите, что доступ к GitHub восстановлен. Синхронизация запустится только по отдельной команде."))return;try{await api("/api/repositories/"+encodeURIComponent(r.repositoryId)+"/recheck-access",{method:"POST"});await renderSettingsExtras();}catch(e){window.alert(e.message);}};
        row.append(clear,restore);
      }
    });
    let conflictBox=q("#commitConflictList");
    if(!conflictBox){conflictBox=make("div",null,"list");conflictBox.id="commitConflictList";list.after(make("h3","Связи коммитов на проверку"),conflictBox);}
    const conflicts=await api("/api/commit-conflicts");
    conflictBox.replaceChildren();
    (conflicts.conflicts||[]).forEach(c=>{
      const row=make("div",null,"row");
      row.append(make("span","Конфликт · "+c.full_name+" · "+c.sha.slice(0,10)+" · "+c.reason));
      const select=make("select");select.setAttribute("aria-label","План для ручного разрешения конфликта");
      select.append(new Option("Выберите план",""));
      (c.eligiblePlans||[]).forEach(p=>select.append(new Option(p.title+" · "+p.selected_ref,p.plan_id)));
      const confirm=make("button","Подтвердить связь","primary");
      confirm.onclick=async()=>{
        const plan=(c.eligiblePlans||[]).find(p=>p.plan_id===select.value);if(!plan)return;
        try {
          await api("/api/commands",{method:"POST",body:JSON.stringify({schemaVersion:1,commandId:crypto.randomUUID(),commandType:"ReviewCommitLink",expectedVersion:plan.version,payload:{planId:plan.plan_id,repositoryId:c.repository_id,sha:c.sha,status:"confirmed",reason:"Owner resolved marker conflict manually"}})});
          await renderSettingsExtras();
        } catch(e){window.alert(e.message);}
      };
      const exclude=make("button","Исключить коммит","danger");
      exclude.onclick=async()=>{
        const plan=(c.eligiblePlans||[]).find(p=>p.plan_id===select.value);if(!plan)return;
        try {
          await api("/api/commands",{method:"POST",body:JSON.stringify({schemaVersion:1,commandId:crypto.randomUUID(),commandType:"ReviewCommitLink",expectedVersion:plan.version,payload:{planId:plan.plan_id,repositoryId:c.repository_id,sha:c.sha,status:"excluded",reason:"Owner excluded commit after marker conflict review"}})});
          await renderSettingsExtras();
        } catch(e){window.alert(e.message);}
      };
      row.append(select,confirm,exclude);conflictBox.append(row);
    });
    if(!conflicts.conflicts||!conflicts.conflicts.length)conflictBox.append(make("p","Нет неразрешённых конфликтов.","muted"));
  }
  async function init() {
    const settings=await api("/api/settings");state.zone=normalizeZone(settings.timezone);
    const repoData=await loadRepositories();
    defaults(overviewFilter);defaults(planFilter);
    await loadFilter(overviewFilter,true);
    if(repoData.githubAvailable) {
      const refs=make("div",null,"list");refs.id="repoRefs";
      const selected=q("#repoIds");
      function renderRefInputs(){
        refs.replaceChildren();
        [...selected.selectedOptions].forEach(option=>{
          const repo=state.repositories.find(x=>x.repositoryId===option.value);if(!repo)return;
          const wrap=make("div",null,"field"),label=make("label","Ветка: "+repo.fullName);label.htmlFor="ref-"+repo.repositoryId;
          const input=make("input");input.id="ref-"+repo.repositoryId;input.dataset.refrepo=repo.repositoryId;input.value=repo.defaultBranch;
          wrap.append(label,input);refs.append(wrap);
        });
      }
      selected.addEventListener("change",renderRefInputs);
      q("#repoIds").parentElement.append(refs);
      renderRefInputs();
    }
    const sync=q("#sync");
    if(sync&&!q("#syncRef")) {
      const refWrap=make("div",null,"field"),refLabel=make("label","Ветка");refLabel.htmlFor="syncRef";
      const refInput=make("input");refInput.id="syncRef";refInput.placeholder="ветка по умолчанию";
      refWrap.append(refLabel,refInput);sync.insertBefore(refWrap,sync.querySelector("button"));
      const authorWrap=make("div",null,"field"),authorLabel=make("label","ID авторов GitHub");authorLabel.htmlFor="authorIds";
      const authors=make("input");authors.id="authorIds";authors.placeholder="через запятую";
      authorWrap.append(authorLabel,authors);sync.insertBefore(authorWrap,sync.querySelector("button"));
      const fullWrap=make("label","Проверить всю историю коммитов");const full=make("input");full.type="checkbox";full.id="fullRescan";fullWrap.prepend(full);sync.insertBefore(fullWrap,sync.querySelector("button"));
    }
    const list=q("#repos");
    if(list){new MutationObserver(()=>{renderSettingsExtras().catch(()=>{});}).observe(list,{childList:true});if(list.children.length)renderSettingsExtras().catch(()=>{});}
  }
  const detail=q("#planDetail");
  if(detail)new MutationObserver(()=>{
    const id=detail.dataset.planId;if(!id||detail.dataset.extraReady)return;detail.dataset.extraReady="true";
    api("/api/plans/"+encodeURIComponent(id)).then(({plan})=>{
      const time=make("p",plan.finishedAt!=null?"От первого запуска до завершения: "+duration(plan.calendarMs):"");if(time.textContent)detail.append(time);
      if(plan.planCreatedAt.precision==="instant"&&plan.firstStartedAt!=null){
        const wait=plan.firstStartedAt-Date.parse(plan.planCreatedAt.value);
        detail.append(make("p","От указанной даты до первого запуска: "+duration(wait)));
      }
      const section=[...detail.querySelectorAll("div")].find(x=>x.querySelector("h3")&&x.querySelector("h3").textContent==="Коммиты и связь с планами");
      if(section&&!section.dataset.tabsReady){
        section.dataset.tabsReady="true";
        const tabs=make("div",null,"toolbar");
        [["Все","all"],["Подтверждённые","confirmed"],["Кандидаты","candidate"],["Исключённые","excluded"]].forEach(([label,status])=>{
          const b=make("button",label);b.onclick=()=>section.querySelectorAll(".row").forEach(row=>{const link=row.querySelector("a"),parts=link?link.textContent.split(" · "):[];row.hidden=status!=="all"&&parts[1]!==status;});tabs.append(b);
        });
        section.insertBefore(tabs,section.children[1]||null);
      }
      if(plan.commitConflicts&&plan.commitConflicts.length){
        const conflictList=make("div",null,"notice");conflictList.append(make("strong","Неоднозначные отметки в коммитах"));
        plan.commitConflicts.forEach(c=>conflictList.append(make("p",c.sha.slice(0,10)+" · "+c.reason+" · "+c.marker_plan_ids_json)));
        detail.append(conflictList);
      }
    }).catch(()=>{});
  }).observe(detail,{childList:true});
  const nav=q(".nav");
  if(nav)nav.addEventListener("click",(event)=>{
    const button=event.target.closest("button[data-view]");
    if(button&&button.dataset.view==="analytics")setTimeout(()=>q("#apply").click(),0);
    if(button&&button.dataset.view==="settings")setTimeout(()=>renderSettingsExtras().catch(()=>{}),0);
  });
  init().catch(e=>{const notice=q("#notice");if(notice){notice.textContent=e.message;notice.classList.remove("hidden","error");}});
})();`;

const UI_TRACKER = String.raw`(()=> {
  const root=document.querySelector("#planDetail");
  if(!root)return;
  const style=document.createElement("style");
  style.textContent=".tracker-section{display:grid;gap:14px;margin-top:22px;padding-top:18px;border-top:1px solid #e2e7ec}.tracker-list,.tracker-timeline{display:grid;gap:10px}.tracker-card,.timeline-card{min-width:0;border:1px solid #e2e7ec;border-radius:11px;padding:14px;background:#fff}.tracker-card h4,.timeline-card h4{margin:0 0 8px}.tracker-card p,.timeline-card p{margin:7px 0;overflow-wrap:anywhere}.tracker-meta{font-size:.88rem;color:#657180}.tracker-form{display:grid;gap:10px}.tracker-form .field{min-width:0}.tracker-actions{display:flex;gap:8px;flex-wrap:wrap}.tracker-timeline time{display:block;font-size:.82rem;color:#657180;overflow-wrap:anywhere}.tracker-marker{display:inline-block;margin:0 6px 0 0;padding:3px 7px;border-radius:99px;background:#edf0f3;font-size:.76rem;font-weight:700}.tracker-marker.GAP,.tracker-marker.LATE,.tracker-marker.STALE_EXECUTOR{background:#fff3dd;color:#805500}.tracker-marker.CORRECTION{background:#eaf0ff;color:#31538a}.tracker-revision{overflow-wrap:anywhere;word-break:break-word}.tracker-timeline-actions{display:flex;gap:8px;flex-wrap:wrap}.tracker-card button,.tracker-section button{min-height:42px}@media(max-width:600px){.tracker-form{grid-template-columns:minmax(0,1fr)}.tracker-actions button,.tracker-timeline-actions button{flex:1 1 100%}.tracker-card,.timeline-card{padding:12px}}";
  document.head.append(style);
  const make=(tag,text,cls)=>{const element=document.createElement(tag);if(text!==undefined&&text!==null)element.textContent=text;if(cls)element.className=cls;return element;};
  const duration=(value)=>{if(value==null)return "—";let minutes=Math.max(0,Math.round(value/60000));const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),rest=minutes%60;return days?days+" д "+hours+" ч "+rest+" мин":hours?hours+" ч "+rest+" мин":rest+" мин";};
  const date=(value)=>value==null?"—":new Intl.DateTimeFormat("ru-RU",{dateStyle:"medium",timeStyle:"short",timeZone:document.querySelector("#tz")?.value||Intl.DateTimeFormat().resolvedOptions().timeZone}).format(new Date(value));
  const statusNames={PENDING:"Ожидает",RUNNING:"Выполняется",BLOCKED:"Заблокирован",FAILED:"Не пройден",DONE:"Готово",OPEN:"Активная попытка",CLOSED:"Закрыта",ABANDONED:"Прервана",ACCEPTED:"Принято владельцем",REJECTED:"Возвращено владельцем",NONE:"Нет решения",PASSED:"Пройдена",NOT_RUN:"Не запускалась"};
  const eventNames={PLAN_STARTED:"План запущен",PLAN_PAUSED:"План приостановлен",PLAN_RESUMED:"План возобновлён",PLAN_FINISHED:"План завершён",STEP_CREATED:"Checkpoint создан",STEP_UPDATED:"Checkpoint изменён",ATTEMPT_CLAIMED:"Попытка назначена",ATTEMPT_ABANDONED:"Попытка прервана",ATTEMPT_CLOSED:"Попытка закрыта",STEP_STARTED:"Checkpoint запущен",STEP_BLOCKED:"Checkpoint заблокирован",STEP_RESULT_RECORDED:"Результат записан",CHECK_RECORDED:"Проверка записана",STEP_ACCEPTED:"Результат принят",STEP_REJECTED:"Результат возвращён",LEASE_RENEWED:"Lease продлён",turn_started:"Ход начат",turn_finished:"Ход завершён",tool_started:"Инструмент запущен",tool_finished:"Инструмент завершён",commit_created:"Коммит создан локально",commit_pushed:"Отмечена отправка коммита",push_failed:"Отправка коммита не удалась",heartbeat:"Heartbeat",gap:"Разрыв последовательности",correction:"Коррекция наблюдения"};
  const uuid=()=>crypto.randomUUID();
  const getSessionId=()=>{let value=sessionStorage.getItem("plan-time-tracker-session");if(!value){value=uuid();sessionStorage.setItem("plan-time-tracker-session",value);}return value;};
  async function api(path,options){const response=await fetch(path,{...options,headers:{"content-type":"application/json",...(options&&options.headers||{})},cache:"no-store"});const data=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(data.error&&data.error.message||"HTTP "+response.status);error.code=data.error&&data.error.code;throw error;}return data;}
  async function command(type,payload,expectedVersion){const envelope={schemaVersion:1,commandId:uuid(),commandType:type,payload:payload};if(expectedVersion!==undefined)envelope.expectedVersion=expectedVersion;const response=await api("/api/commands",{method:"POST",body:JSON.stringify(envelope)});return response.result;}
  function inputField(labelText,options){const wrap=make("div",null,"field"),label=make("label",labelText),control=make(options&&options.tag||"input");control.type=options&&options.type||"text";if(options&&options.maxLength)control.maxLength=options.maxLength;if(options&&options.required)control.required=true;if(options&&options.placeholder)control.placeholder=options.placeholder;if(options&&options.value!==undefined)control.value=options.value;if(options&&options.rows)control.rows=options.rows;const id="tracker-"+uuid();control.id=id;label.htmlFor=id;wrap.append(label,control);return {wrap,control};}
  function selectField(labelText,values,selected){const wrap=make("div",null,"field"),label=make("label",labelText),control=make("select"),id="tracker-"+uuid();control.id=id;label.htmlFor=id;values.forEach((value)=>{const option=make("option",value);option.value=value;option.selected=value===selected;control.append(option);});wrap.append(label,control);return {wrap,control};}
  function setMessage(target,text,error){target.textContent=text||"";target.classList.toggle("error",Boolean(error));}
  function status(value){return statusNames[value]||value||"Неизвестно";}
  function sectionFor(id){const section=make("section",null,"tracker-section");section.dataset.trackerPanel="true";section.dataset.planId=id;section.setAttribute("aria-labelledby","tracker-heading");return section;}
  function renderLegacyEvent(event){return {legacy:true,eventId:event.event_id,eventType:event.event_type,receivedAt:event.server_occurred_at,actorType:event.actor_type,reason:event.reason,version:event.version_after};}
  function renderGitProof(event,card){if(!event.gitEvidence)return;const proof=event.gitEvidence;let text="Проверка удалённой публикации: неизвестно.";if(proof.protectedDetailsHidden)text="Детали закрытого репозитория скрыты; публикация неизвестна.";else if(proof.pushFailed)text="Отправка завершилась ошибкой; публикация не подтверждена.";else if(event.eventType==="commit_created")text="Локально созданный коммит; это не подтверждает отправку.";else if(proof.refMembership==="present")text="Полный SHA найден в синхронизированной ветке.";else if(proof.refMembership==="absent_after_complete_sync")text="SHA отсутствует в последней полной синхронизации ветки.";card.append(make("p",text,"tracker-meta"));}
  function renderTimeline(list,events){list.replaceChildren();if(!events.length){list.append(make("p","История пока пуста.","muted"));return;}const ordered=[...events].sort((a,b)=>Number(a.receivedAt||0)-Number(b.receivedAt||0)||(a.serverSequence||0)-(b.serverSequence||0)||String(a.eventId).localeCompare(String(b.eventId)));for(const event of ordered){const card=make("article",null,"timeline-card");card.id="tracker-event-"+event.eventId;const heading=make("h4",eventNames[event.eventType]||event.eventType);if(event.classification&&event.classification!=="NORMAL")heading.prepend(make("span",event.classification,"tracker-marker "+event.classification));card.append(heading);card.append(make("time","Получено сервером: "+date(event.receivedAt)));if(!event.legacy&&event.occurredAt!=null)card.append(make("time","Время клиента: "+date(event.occurredAt)));if(event.serverSequence!=null)card.append(make("p","Серверная последовательность: "+event.serverSequence,"tracker-meta"));if(event.legacy){card.append(make("p","Автор: "+(event.actorType||"не указан")+(event.version!=null?" · версия плана "+event.version:""),"tracker-meta"));if(event.reason)card.append(make("p","Причина: "+event.reason));}else if(event.payload&&event.payload.data&&Object.keys(event.payload.data).length){card.append(make("p",JSON.stringify(event.payload.data),"tracker-meta"));}if(event.correctionOfEventId){const link=make("a","Исправляет событие "+event.correctionOfEventId);link.href="#tracker-event-"+event.correctionOfEventId;card.append(link);}renderGitProof(event,card);list.append(card);}}
  let renderToken=0,loadingPlanId=null;
  async function renderTracker(force){const planId=root.dataset.planId;if(!planId)return;const current=root.querySelector("[data-tracker-panel]");if(!force&&current&&current.dataset.planId===planId)return;if(!force&&loadingPlanId===planId)return;const token=++renderToken;loadingPlanId=planId;if(current)current.remove();const panel=sectionFor(planId),heading=make("h3","Контрольные этапы");heading.id="tracker-heading";panel.append(heading);const message=make("p","Загружаю состояние checkpoint…","muted");message.setAttribute("role","status");message.setAttribute("aria-live","polite");panel.append(message);root.append(panel);
    try{const [snapshot,legacy]=await Promise.all([api("/api/tracker/plans/"+encodeURIComponent(planId)+"/execution"),api("/api/plans/"+encodeURIComponent(planId))]);if(token!==renderToken||root.dataset.planId!==planId)return;panel.replaceChildren(heading);panel.append(message);setMessage(message,"");const steps=snapshot.steps||[];const incompletes=steps.filter((step)=>!step.acceptanceCurrent||step.status!=="DONE");if(!snapshot.enabled)panel.append(make("p","Трекер включится при создании первого checkpoint. Таймер плана не меняется.","tracker-meta"));panel.append(make("p","Активное время определяется только интервалами плана: "+duration(snapshot.plan.activeMs)+". Попытки не складываются с таймером.","tracker-meta"));const bottlenecks=snapshot.bottlenecks||{},checkDelay=bottlenecks.checkDelay||{};const checkDelayText=checkDelay.sampleCount?duration(checkDelay.medianMs)+" медиана, выборка "+checkDelay.sampleCount:"нет данных";panel.append(make("p","Сводка: блокировок "+(bottlenecks.blockedEvents||0)+" · попыток после первой "+(bottlenecks.retries||0)+" (включая восстановление и доработку) · неуспешных результатов "+(bottlenecks.failedResults||0)+" · задержка до первой проверки "+checkDelayText+". Задержка показывает время между записью результата и первой записью проверки на сервере, а не длительность выполнения теста.","tracker-meta"));
      if(["PLANNED","RUNNING"].includes(snapshot.plan.status)){const form=make("form",null,"tracker-form"),ordinal=inputField("Порядок",{type:"number",required:true,value:String(steps.length)}),title=inputField("Название checkpoint",{required:true,maxLength:200}),expected=inputField("Ожидаемый результат",{tag:"textarea",required:true,maxLength:4000,rows:3}),checks=inputField("Обязательные проверки · через запятую",{maxLength:2100,placeholder:"unit, build"}),commit=selectField("Политика commit",["NEVER","ON_EXPLICIT_REQUEST","REQUIRED_BY_APPROVED_CHECKPOINT"],"NEVER"),push=selectField("Политика push",["NEVER","ON_EXPLICIT_REQUEST","REQUIRED_BY_APPROVED_CHECKPOINT"],"NEVER"),submit=make("button","Добавить checkpoint","primary");submit.type="submit";form.append(ordinal.wrap,title.wrap,expected.wrap,checks.wrap,commit.wrap,push.wrap,submit);form.addEventListener("submit",async(event)=>{event.preventDefault();submit.disabled=true;try{await command("CreateStep",{planId:planId,ordinal:Number(ordinal.control.value),title:title.control.value,expectedResult:expected.control.value,requiredChecks:checks.control.value.split(",").map((value)=>value.trim()).filter(Boolean),commitPolicy:commit.control.value,pushPolicy:push.control.value});setMessage(message,"Checkpoint добавлен. Таймер плана не запускался.");await renderTracker(true);}catch(error){setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{submit.disabled=false;}});panel.append(form);}
      const stepList=make("div",null,"tracker-list");if(!steps.length)stepList.append(make("p","В этом плане пока нет checkpoint.","muted"));for(const step of steps)stepList.append(renderStep(step,snapshot.plan,planId,message,()=>renderTracker(true)));panel.append(stepList);
      if(incompletes.length&&["RUNNING","PAUSED"].includes(snapshot.plan.status)){const finishForm=make("form",null,"tracker-form"),finishReason=inputField("Причина явного завершения с незакрытыми checkpoint",{tag:"textarea",required:true,maxLength:1000,rows:2}),finish=make("button","Завершить план с исключением","danger");finish.type="submit";finishForm.append(make("p","Останутся незакрытыми: "+incompletes.map((step)=>step.title).join("; ")),finishReason.wrap,finish);finishForm.addEventListener("submit",async(event)=>{event.preventDefault();if(!window.confirm("Завершить план с зафиксированным исключением? Таймер будет остановлен."))return;finish.disabled=true;try{await command("FinishPlan",{planId:planId,allowIncomplete:true,reason:finishReason.control.value},snapshot.plan.version);setMessage(message,"План завершён с сохранённым исключением.");await renderTracker(true);}catch(error){setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{finish.disabled=false;}});panel.append(finishForm);}
      const timelineHeading=make("h4","История плана и observations"),timelineList=make("div",null,"tracker-timeline"),timelineActions=make("div",null,"tracker-timeline-actions"),more=make("button","Загрузить следующие события");more.type="button";more.hidden=true;const timelineMessage=make("p","Загружаю историю…","muted");timelineMessage.setAttribute("role","status");timelineMessage.setAttribute("aria-live","polite");panel.append(timelineHeading,timelineMessage,timelineList,timelineActions);const trackerEvents=[],legacyEvents=(legacy.plan.events||[]).map(renderLegacyEvent).map((event)=>({...event,legacy:true}));let cursor=0,hasMore=false,timelineBusy=false;
      async function loadTimeline(reset){if(timelineBusy)return;timelineBusy=true;more.disabled=true;try{const page=await api("/api/tracker/plans/"+encodeURIComponent(planId)+"/timeline?afterSequence="+(reset?0:cursor)+"&limit=50");if(reset)trackerEvents.length=0;trackerEvents.push(...page.events);cursor=page.nextCursor;hasMore=page.hasMore;renderTimeline(timelineList,[...legacyEvents,...trackerEvents]);more.hidden=!hasMore;setMessage(timelineMessage,hasMore?"Показаны события до серверной последовательности "+cursor+".":"История загружена.");}catch(error){setMessage(timelineMessage,(error.code||"ERROR")+": "+error.message,true);}finally{timelineBusy=false;more.disabled=false;}}
      more.addEventListener("click",()=>loadTimeline(false));timelineActions.append(more);await loadTimeline(true);
    }catch(error){if(token===renderToken)setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{if(token===renderToken)loadingPlanId=null;}}
  function renderStep(step,plan,planId,message,reload){const card=make("article",null,"tracker-card"),heading=make("h4",step.title+" · "+status(step.status)),meta=make("p","№"+step.ordinal+" · версия "+step.version+" · acceptance: "+status(step.acceptance_decision)+(step.acceptanceCurrent?" (текущая ревизия)":" (не принято для текущей ревизии)"),"tracker-meta");card.append(heading,meta,make("p","Ожидаемый результат: "+step.expected_result));card.append(make("p","Обязательные проверки: "+(step.requiredChecks.length?step.requiredChecks.join(", "):"не заданы"),"tracker-meta"));card.append(make("p","Commit: "+step.commit_policy+" · push: "+step.push_policy,"tracker-meta"));if(step.currentAcceptance)card.append(make("p","Решение владельца по ревизии "+step.currentAcceptance.result_revision+": "+status(step.currentAcceptance.decision)+" · "+step.currentAcceptance.reason));
    const result=step.currentResult;if(result){card.append(make("p","Результат r"+result.revision+": "+status(result.outcome)+" · "+result.summary));if(result.protectedRevisionHidden)card.append(make("p","SHA закрытого репозитория скрыт из-за отсутствия доступа.","tracker-meta"));else if(result.revision_sha)card.append(make("p","Репозиторий "+result.repository_id+" · SHA "+result.revision_sha,"tracker-meta tracker-revision"));}
    if(step.resultHistory.length>1){const history=make("details"),summary=make("summary","История результатов ("+step.resultHistory.length+")");history.append(summary);step.resultHistory.forEach((item)=>history.append(make("p","r"+item.revision+" · "+status(item.outcome)+" · "+item.summary+" · "+date(item.created_at))));card.append(history);}
    const checks=make("div",null,"tracker-meta");checks.append(make("strong","Записанные проверки"));if(!step.checks.length)checks.append(make("p","Проверки по этой ревизии ещё не записаны."));step.checks.forEach((check)=>checks.append(make("p",check.check_key+" · "+status(check.status)+" · SHA "+(check.tested_sha||"скрыт")+(check.exit_code==null?"":" · exit "+check.exit_code)+(check.evidence_summary?" · "+check.evidence_summary:""))));card.append(checks);
    const attempts=make("details"),attemptHeading=make("summary","Попытки ("+step.attempts.length+")");attempts.append(attemptHeading);step.attempts.forEach((attempt)=>{const reworkText=attempt.rework_reason?" · доработка владельца: "+attempt.rework_reason:"";attempts.append(make("p",status(attempt.status)+" · fence "+attempt.fence+" · lease до "+date(attempt.lease_until)+reworkText));});card.append(attempts);
    if(["PLANNED","RUNNING"].includes(plan.status)&&step.status!=="RUNNING"&&!step.attempts.some((attempt)=>attempt.status==="OPEN")){const edit=make("details"),editSummary=make("summary","Изменить checkpoint и требования");edit.append(editSummary);const form=make("form",null,"tracker-form"),title=inputField("Название checkpoint",{required:true,maxLength:200,value:step.title}),expected=inputField("Ожидаемый результат",{tag:"textarea",required:true,maxLength:4000,rows:3,value:step.expected_result}),checks=inputField("Обязательные проверки · через запятую",{maxLength:2100,value:step.requiredChecks.join(", ")}),commit=selectField("Политика commit",["NEVER","ON_EXPLICIT_REQUEST","REQUIRED_BY_APPROVED_CHECKPOINT"],step.commit_policy),push=selectField("Политика push",["NEVER","ON_EXPLICIT_REQUEST","REQUIRED_BY_APPROVED_CHECKPOINT"],step.push_policy),reason=inputField("Причина изменения checkpoint",{required:true,maxLength:1000}),save=make("button","Сохранить новую редакцию checkpoint","primary");save.type="submit";form.append(title.wrap,expected.wrap,checks.wrap,commit.wrap,push.wrap,reason.wrap,save);form.addEventListener("submit",async(event)=>{event.preventDefault();save.disabled=true;try{await command("UpdateStep",{stepId:step.step_id,changes:{title:title.control.value,expectedResult:expected.control.value,requiredChecks:checks.control.value.split(",").map((value)=>value.trim()).filter(Boolean),commitPolicy:commit.control.value,pushPolicy:push.control.value},reason:reason.control.value},step.version);setMessage(message,"Checkpoint обновлён; предыдущие результаты и решения остаются в истории.");await reload();}catch(error){setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{save.disabled=false;}});edit.append(form);card.append(edit);}
    const actions=make("div",null,"tracker-actions");const candidateAttempt=step.attempts.find((attempt)=>attempt.status==="OPEN"&&attempt.fence===step.current_fence),openAttempt=candidateAttempt&&candidateAttempt.lease_until>Date.now()?candidateAttempt:null,expiredAttempt=candidateAttempt&&!openAttempt?candidateAttempt:null;
    if(plan.status==="RUNNING"&&openAttempt&&openAttempt.lease_until>Date.now()){const renew=make("button","Продлить lease на 10 минут");renew.type="button";renew.addEventListener("click",async()=>{renew.disabled=true;try{await command("RenewStepLease",{stepId:step.step_id,attemptId:openAttempt.attempt_id,fence:openAttempt.fence});setMessage(message,"Lease продлён сервером; таймер плана не менялся.");await reload();}catch(error){setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{renew.disabled=false;}});actions.append(renew);}
    if(plan.status==="RUNNING"&&((step.status!=="RUNNING"&&["PENDING","BLOCKED","FAILED","DONE"].includes(step.status))||(step.status==="RUNNING"&&expiredAttempt))){
      const rework=inputField("Причина доработки от владельца (обязательна для DONE)",{maxLength:1000,value:expiredAttempt&&expiredAttempt.rework_reason||""});rework.wrap.hidden=step.status!=="DONE";if(step.status==="DONE")card.append(rework.wrap);const start=make("button",expiredAttempt?"Захватить новую попытку после истечения lease":step.status==="DONE"?"Назначить и начать доработку":"Захватить попытку и начать");start.type="button";start.className="primary";start.addEventListener("click",async()=>{start.disabled=true;try{let attempt=openAttempt;if(!attempt){const payload={stepId:step.step_id,sessionId:getSessionId(),sourceId:"sites-owner-ui",clientType:"UNKNOWN"};if(expiredAttempt)payload.recoveryReason="Владелец подтвердил восстановление после истечения lease.";if(step.status==="DONE"){if(!rework.control.value.trim())throw new Error("Для DONE укажите явную причину доработки владельца.");payload.reworkReason=rework.control.value.trim();}const claimed=await command("ClaimStepAttempt",payload,step.version);attempt={attempt_id:claimed.attemptId,fence:claimed.fence,rework_reason:step.status==="DONE"?rework.control.value.trim():null};}const startPayload={stepId:step.step_id,attemptId:attempt.attempt_id,fence:attempt.fence};if(attempt.rework_reason){startPayload.rework=true;startPayload.reason=attempt.rework_reason;}await command("StartStep",startPayload,step.version);setMessage(message,"Checkpoint запущен отдельной явной командой.");await reload();}catch(error){setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{start.disabled=false;}});actions.append(start);}
    if(plan.status==="RUNNING"&&step.status==="RUNNING"&&openAttempt){const blockReason=inputField("Причина блокировки",{required:true,maxLength:1000});const block=make("button","Заблокировать");block.type="button";block.addEventListener("click",async()=>{if(!blockReason.control.reportValidity())return;block.disabled=true;try{await command("BlockStep",{stepId:step.step_id,attemptId:openAttempt.attempt_id,fence:openAttempt.fence,reason:blockReason.control.value},step.version);setMessage(message,"Checkpoint заблокирован с указанной причиной.");await reload();}catch(error){setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{block.disabled=false;}});card.append(blockReason.wrap);actions.append(block);}
    if(plan.status==="RUNNING"&&step.status==="RUNNING"&&openAttempt){const resultForm=make("form",null,"tracker-form"),outcome=selectField("Результат попытки",["DONE","FAILED"],"DONE"),summary=inputField("Краткий результат",{tag:"textarea",required:true,maxLength:4000,rows:2}),repo=inputField("Repository ID результата (если есть)",{maxLength:40}),sha=inputField("Полный SHA результата (если есть)",{maxLength:40,placeholder:"40 hex символов"}),save=make("button","Записать результат");save.type="submit";resultForm.append(outcome.wrap,summary.wrap,repo.wrap,sha.wrap,save);resultForm.addEventListener("submit",async(event)=>{event.preventDefault();save.disabled=true;try{const payload={stepId:step.step_id,attemptId:openAttempt.attempt_id,fence:openAttempt.fence,outcome:outcome.control.value,summary:summary.control.value};if(repo.control.value||sha.control.value){payload.repositoryId=repo.control.value;payload.revisionSha=sha.control.value;}await command("RecordStepResult",payload,step.version);setMessage(message,"Результат записан. Checks и acceptance остаются отдельными.");await reload();}catch(error){setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{save.disabled=false;}});card.append(resultForm);}
    if(result&&result.revision_sha&&!result.protectedRevisionHidden){const currentChecks=step.checks.filter((check)=>check.result_revision===result.revision);for(const checkKey of step.requiredChecks){const previousCheck=currentChecks.find((check)=>check.check_key===checkKey);const form=make("form",null,"tracker-form"),title=make("strong","Записать check: "+checkKey),statusSelect=selectField("Статус проверки",["PASSED","FAILED","NOT_RUN"],previousCheck?previousCheck.status:"PASSED"),shaField=inputField("SHA, на котором выполнена проверка",{required:true,maxLength:40,value:previousCheck?previousCheck.tested_sha:result.revision_sha}),exit=inputField("Код завершения",{type:"number",value:previousCheck&&previousCheck.exit_code!=null?String(previousCheck.exit_code):"0"}),evidence=inputField("Краткая evidence summary",{tag:"textarea",maxLength:2000,rows:2,value:previousCheck&&previousCheck.evidence_summary||""}),save=make("button",previousCheck?"Записать новую ревизию check":"Сохранить check");save.type="submit";form.append(title,statusSelect.wrap,shaField.wrap,exit.wrap,evidence.wrap,save);statusSelect.control.addEventListener("change",()=>{exit.control.disabled=statusSelect.control.value==="NOT_RUN";if(statusSelect.control.value==="PASSED")exit.control.value="0";if(statusSelect.control.value==="FAILED"&&Number(exit.control.value)<1)exit.control.value="1";});form.addEventListener("submit",async(event)=>{event.preventDefault();save.disabled=true;try{const checkStatus=statusSelect.control.value,payload={stepId:step.step_id,resultRevision:result.revision,checkKey:checkKey,status:checkStatus,testedSha:shaField.control.value,evidenceSummary:evidence.control.value};if(checkStatus!=="NOT_RUN")payload.exitCode=Number(exit.control.value);await command("RecordCheck",payload);setMessage(message,"Результат проверки сохранён отдельно от agent_done и acceptance.");await reload();}catch(error){setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{save.disabled=false;}});card.append(form);}}
    if(result){const decision=make("form",null,"tracker-form"),reason=inputField("Причина решения владельца",{required:true,maxLength:1000}),waivers=inputField("Waivers JSON (необязательно)",{tag:"textarea",maxLength:6000,rows:2,value:"[]",placeholder:'[{"checkKey":"build","reason":"Причина waiver"}]'}),accept=make("button","Принять текущую ревизию","primary"),reject=make("button","Вернуть результат");accept.type="submit";accept.disabled=result.outcome!=="DONE";reject.type="button";decision.append(reason.wrap,waivers.wrap,accept,reject);decision.addEventListener("submit",async(event)=>{event.preventDefault();accept.disabled=true;try{const parsed=JSON.parse(waivers.control.value||"[]");if(!Array.isArray(parsed))throw new Error("Waivers должны быть JSON-массивом.");await command("AcceptStep",{stepId:step.step_id,resultRevision:result.revision,reason:reason.control.value,waivers:parsed},step.version);setMessage(message,"Решение ACCEPTED записано для конкретной ревизии.");await reload();}catch(error){setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{accept.disabled=false;}});reject.addEventListener("click",async()=>{if(!reason.control.reportValidity())return;reject.disabled=true;try{await command("RejectStep",{stepId:step.step_id,resultRevision:result.revision,reason:reason.control.value},step.version);setMessage(message,"Решение REJECTED записано; статус DONE не изменён.");await reload();}catch(error){setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{reject.disabled=false;}});card.append(decision);}
    card.append(actions);return card;}
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
    "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light\"><title>Время планов</title>",
    "<style>:root{font-family:Inter,system-ui,sans-serif;color:#18212b;background:#f5f7fa;--muted:#657180;--line:#e2e7ec;--green:#14775e;--panel:#fff}*{box-sizing:border-box}body{margin:0}.shell{max-width:1100px;margin:auto;padding:34px 22px 70px}.top{display:flex;justify-content:space-between;gap:20px;margin-bottom:25px}.eyebrow{font-size:.75rem;letter-spacing:.14em;color:var(--green);font-weight:800;text-transform:uppercase}h1{letter-spacing:-.04em;font-size:clamp(1.7rem,4vw,2.3rem);margin:.35rem 0}.muted{color:var(--muted)}button,input,textarea,select{font:inherit}button{border:0;border-radius:9px;padding:.65rem .9rem;font-weight:700;cursor:pointer;background:#e8edf1;color:#18212b}button:focus-visible,.row[role=button]:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #579ce0;outline-offset:2px}.primary{background:var(--green);color:white}.danger{color:#a43830;background:#fae9e7}.nav{display:flex;gap:7px;border-bottom:1px solid var(--line);margin-bottom:21px;overflow:auto}.nav button{background:none;color:var(--muted);white-space:nowrap;border-radius:0;border-bottom:2px solid transparent}.nav button[aria-current=page]{color:#18212b;border-color:var(--green)}.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:16px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:20px;margin-bottom:16px}h2{font-size:1.1rem;margin:0 0 14px}.current{min-height:210px}.timer{font-size:clamp(2rem,6vw,3rem);font-weight:780;letter-spacing:-.06em;font-variant-numeric:tabular-nums;margin:15px 0}.badge{display:inline-block;border-radius:99px;padding:.3rem .58rem;background:#e6f3ed;color:#176b54;font-size:.78rem;font-weight:750}.badge.paused{background:#fff3dd;color:#8d6015}.badge.completed{background:#edf0f3;color:#5f6973}.actions,.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.metric{border:1px solid var(--line);border-radius:11px;padding:13px}.metric small{display:block;color:var(--muted);margin-bottom:7px}.metric strong{font-variant-numeric:tabular-nums}.list{display:grid;gap:8px}.row{display:flex;justify-content:space-between;align-items:center;gap:12px;border:1px solid var(--line);background:white;border-radius:11px;padding:13px}.row-title{font-weight:720}.plan-open{background:transparent;color:inherit;padding:0;border-radius:0;text-align:left;font-weight:inherit;flex:1;min-width:0}.row-meta{display:block;font-size:.82rem;color:var(--muted);margin-top:4px;font-weight:400}.row-right{display:flex;gap:8px;align-items:center}.field{display:grid;gap:6px;min-width:130px;flex:1}.field label{font-weight:700;font-size:.85rem}.field input,.field textarea,.field select{border:1px solid #cbd3dc;border-radius:8px;padding:.65rem;background:white;color:#18212b}.field textarea{min-height:75px}.form{display:grid;gap:12px}.hidden{display:none!important}.notice{padding:11px 13px;border:1px solid #efd8ac;background:#fff8e9;border-radius:9px;margin:12px 0;color:#705115}.error{color:#8f332b;background:#fff0ee;border-color:#ebc5c1}.chart{display:grid;gap:8px;margin-top:16px}.barrow{display:grid;grid-template-columns:95px 1fr 75px;align-items:center;gap:9px;font-size:.82rem}.bar{height:10px;background:#edf0f3;border-radius:20px;overflow:hidden}.bar span{height:100%;display:block;background:#319578}.modal{position:fixed;inset:0;background:#17212b66;display:grid;place-items:center;padding:18px}.modalbox{background:white;border-radius:14px;padding:20px;width:min(620px,100%);max-height:90vh;overflow:auto}.toast{position:fixed;bottom:18px;right:18px;background:#253440;color:white;border-radius:9px;padding:12px 16px;max-width:min(450px,calc(100% - 36px))}.toast.error{background:#913a31;color:white}@media(max-width:720px){.shell{padding:22px 14px 55px}.grid{grid-template-columns:1fr}.panel{padding:16px}.row{align-items:flex-start}.row-right{align-items:flex-end;flex-direction:column}.barrow{grid-template-columns:75px 1fr 65px}}@media(max-width:390px){.actions button{flex:1}.top{gap:8px}}@media(max-width:600px){.metrics{grid-template-columns:1fr}} .grid>*{min-width:0}.field{min-width:0}.field input,.field select,.field textarea,.form>input,.form>textarea{width:100%;min-width:0;max-width:100%}.form>input,.form>textarea{border:1px solid #cbd3dc;border-radius:8px;padding:.65rem}.toolbar:has(.field){display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));align-items:end}.toolbar:has(.field)>button{min-height:44px}#view-overview>.panel:has(#overviewFrom)>.metrics{margin-top:16px}#view-overview>.panel:has(#overviewFrom)>.list{margin-top:16px}#githubStatus{margin:0 0 14px;min-height:1.35em}#sync{grid-template-columns:minmax(0,1fr)}#sync>label{display:flex;align-items:flex-start;gap:8px}#sync>label input{flex:none}.row>*{min-width:0}.row-title,.row-meta,.row a,.row>span,#planDetail p,h2,h3,#who{overflow-wrap:anywhere}.nav{padding:4px}.nav button:focus-visible,a:focus-visible{outline:3px solid #579ce0;outline-offset:2px}.modal{z-index:20}.modalbox{max-height:calc(100dvh - 36px);overscroll-behavior:contain}.toast{z-index:30}button:disabled{cursor:not-allowed;opacity:.55}.form-error{color:#8f332b;background:#fff0ee;border:1px solid #ebc5c1;padding:10px;border-radius:8px}.form-error:empty{display:none}@media(max-width:600px){.top{flex-direction:column}.row{flex-wrap:wrap}.row>.plan-open{flex:1 1 100%}.row>.row-right{width:100%;justify-content:flex-start;flex-direction:row;flex-wrap:wrap}.modal{padding:10px}.modalbox{padding:16px;max-height:calc(100dvh - 20px)}.toolbar:has(.field){grid-template-columns:minmax(0,1fr)}.actions>button{min-height:44px}}</style></head><body><main class=\"shell\">",
    "<header class=\"top\"><div><h1>Время планов</h1></div><div class=\"muted\" id=\"who\">Проверка входа…</div></header>",
    "<nav class=\"nav\" aria-label=\"Разделы\"><button data-view=\"overview\" aria-current=\"page\">Обзор</button><button data-view=\"plans\">Планы</button><button data-view=\"analytics\">Аналитика</button><button data-view=\"settings\">Репозитории</button></nav><div id=\"notice\" class=\"notice hidden\" role=\"status\"></div>",
    "<section id=\"view-overview\"><div class=\"grid\"><article class=\"panel current\"><h2>Текущий план</h2><div id=\"active\" class=\"muted\">Загрузка…</div></article><aside class=\"panel\"><h2>Учёт времени</h2><div class=\"metrics\"><div class=\"metric\"><small>Активно сегодня</small><strong id=\"today\">—</strong></div><div class=\"metric\"><small>Завершено за 30 дней</small><strong id=\"count\">—</strong></div></div><p class=\"muted\">Таймер считает время ночью и в выходные, пока вы не поставите его на паузу.</p><button class=\"primary\" id=\"newPlan\">Новый план</button></aside></div><article class=\"panel\"><h2>Последние планы</h2><div id=\"recent\" class=\"list\"></div></article></section>",
    "<section id=\"view-plans\" class=\"hidden\"><div class=\"toolbar\"><h2 style=\"flex:1\">Все планы</h2><button class=\"primary\" id=\"newPlan2\">Создать план</button></div><div id=\"plans\" class=\"list\"></div></section>",
    "<section id=\"view-detail\" class=\"hidden\"><button id=\"backPlans\">← К планам</button><article id=\"planDetail\" class=\"panel\"></article></section>",
    "<section id=\"view-analytics\" class=\"hidden\"><article class=\"panel\"><h2>Отчёт за период</h2><div class=\"toolbar\"><div class=\"field\"><label for=\"from\">С</label><input id=\"from\" type=\"date\" aria-label=\"Дата начала периода\"></div><div class=\"field\"><label for=\"to\">По</label><input id=\"to\" type=\"date\" aria-label=\"Дата конца периода\"></div><button class=\"primary\" id=\"apply\">Применить</button></div><div id=\"stats\" class=\"metrics\" style=\"margin-top:16px\"></div><div id=\"chart\" class=\"chart\"></div><div id=\"analyticPlans\" class=\"list\" style=\"margin-top:15px\"></div></article></section>",
    "<section id=\"view-settings\" class=\"hidden\"><div class=\"grid\"><article class=\"panel\"><h2>GitHub</h2><p id=\"githubStatus\" class=\"muted\" role=\"status\"></p><form id=\"sync\" class=\"toolbar\"><div class=\"field\"><label for=\"repo\">Репозиторий GitHub</label><input id=\"repo\" placeholder=\"owner/repository\"></div><button class=\"primary\">Синхронизировать</button></form><div id=\"repos\" class=\"list\" style=\"margin-top:14px\"></div></article><article class=\"panel\"><h2>Настройки времени</h2><form id=\"settings\" class=\"form\"><div class=\"field\"><label for=\"tz\">Часовой пояс</label><select id=\"tz\" required>" + UI_TIME_ZONES.map((option) => "<option value=\"" + option.value + "\"" + (option.value === "Asia/Omsk" ? " selected" : "") + ">" + option.label + "</option>").join("") + "</select></div><button class=\"primary\">Сохранить</button></form><p class=\"muted\">Все отметки времени хранятся в UTC. <a href=\"/api/export\">Скачать личный экспорт JSON</a>.</p></article></div></section>",
    "<div id=\"modal\" class=\"modal hidden\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"modalTitle\"><div class=\"modalbox\"><div class=\"toolbar\"><h2 id=\"modalTitle\" style=\"flex:1\">Новый план</h2><button id=\"close\">Закрыть</button></div><form id=\"create\" class=\"form\"><div class=\"field\"><label for=\"title\">Название</label><input id=\"title\" maxlength=\"200\" required></div><div class=\"field\"><label for=\"description\">Описание</label><textarea id=\"description\"></textarea></div><div class=\"field\"><label for=\"criteria\">Критерии приёмки</label><textarea id=\"criteria\"></textarea></div><div class=\"field\"><label for=\"createdDate\">Дата составления</label><input id=\"createdDate\" type=\"date\" required></div><div class=\"field\"><label for=\"repoIds\">Репозитории</label><select id=\"repoIds\" multiple size=\"4\"></select></div><div class=\"actions\"><button type=\"button\" id=\"cancel\">Отмена</button><button class=\"primary\">Создать план</button></div></form></div></div><div id=\"toast\" class=\"toast hidden\" role=\"status\" aria-live=\"polite\"></div>",
    "</main>",
    "<script>(()=>{const q=s=>document.querySelector(s), all=s=>[...document.querySelectorAll(s)];const supportedZones=" + JSON.stringify(UI_TIME_ZONES.map((option) => option.value)) + ";const normalizeZone=value=>supportedZones.includes(value)?value:\"Asia/Omsk\";let plans=[],active=null,repos=[],zone=\"Asia/Omsk\",serverNow=Date.now(),pending=new Map(),timer,modalReturnFocus=null;const uid=()=>crypto.randomUUID();const dateLocal=d=>{const value=Object.fromEntries(new Intl.DateTimeFormat(\"en-CA\",{timeZone:zone,year:\"numeric\",month:\"2-digit\",day:\"2-digit\"}).formatToParts(d).map(part=>[part.type,part.value]));return value.year+\"-\"+value.month+\"-\"+value.day};const duration=n=>{if(n==null)return\"—\";n=Math.max(0,Math.round(n/60000));const day=Math.floor(n/1440),h=Math.floor(n%1440/60),m=n%60;return day?day+\" д \"+h+\" ч \"+m+\" мин\":h?h+\" ч \"+m+\" мин\":m+\" мин\"};const formatPlanSample=n=>{const count=Number(n)||0,lastTwo=count%100;return\"по \"+count+\" \"+((lastTwo>=11&&lastTwo<=14)||count%10!==1?\"планам\":\"плану\")};const dateFmt=n=>n==null?\"—\":new Intl.DateTimeFormat(\"ru-RU\",{dateStyle:\"medium\",timeStyle:\"short\",timeZone:zone}).format(new Date(n));const statusText=status=>({PLANNED:\"Запланирован\",RUNNING:\"Выполняется\",PAUSED:\"На паузе\",COMPLETED:\"Завершён\"})[status]||status;function showToast(t,err){const x=q(\"#toast\");x.textContent=t;x.classList.toggle(\"error\",!!err);x.classList.remove(\"hidden\");clearTimeout(timer);timer=setTimeout(()=>x.classList.add(\"hidden\"),4500)}async function call(path,opt){const r=await fetch(path,{...opt,headers:{\"content-type\":\"application/json\",...(opt&&opt.headers||{})},cache:\"no-store\"});let v={};try{v=await r.json()}catch{}if(!r.ok){const e=new Error(v.error&&v.error.message||\"HTTP \"+r.status);e.code=v.error&&v.error.code;e.details=v.error&&v.error.details;throw e}return v}function makeCmd(type,plan,payload){const key=type+\":\"+(plan?plan.planId:\"new\");let c=pending.get(key);if(!c){c={schemaVersion:1,commandId:uid(),commandType:type,expectedVersion:plan?plan.version:undefined,payload:{...(plan?{planId:plan.planId}:{}),...(payload||{})}};pending.set(key,c)}return [key,c]}async function command(type,plan,payload){const [key,c]=makeCmd(type,plan,payload);try{const r=await call(\"/api/commands\",{method:\"POST\",body:JSON.stringify(c)});pending.delete(key);showToast(r.replayed?\"Повторный запрос обработан по сохранённому результату.\":\"Изменение сохранено.\");await refresh();return r}catch(e){showToast((e.code||\"ERROR\")+\": \"+e.message,true);if(e.code===\"VERSION_CONFLICT\")await refresh();throw e}}function btn(text,fn,cls){const b=document.createElement(\"button\");b.textContent=text;if(cls)b.className=cls;b.onclick=async e=>{e.stopPropagation();if(b.disabled)return;b.disabled=true;try{await fn()}catch{}finally{b.disabled=false}};return b}function card(p){const row=document.createElement(\"div\");row.className=\"row\";row.dataset.planId=p.planId;const left=document.createElement(\"button\"),title=document.createElement(\"span\"),meta=document.createElement(\"span\");left.type=\"button\";left.className=\"plan-open\";left.onclick=()=>openPlan(p.planId);title.className=\"row-title\";title.textContent=p.title;meta.className=\"row-meta\";meta.textContent=(p.status===\"RUNNING\"?\"Выполняется\":p.status===\"PAUSED\"?\"Пауза\":p.status===\"COMPLETED\"?\"Завершён\":\"Запланирован\")+\" · активно \"+duration(p.activeMs)+\" · создан \"+dateFmt(p.registeredAt);left.append(title,meta);const right=document.createElement(\"div\");right.className=\"row-right\";const badge=document.createElement(\"span\");badge.className=\"badge \"+p.status.toLowerCase();badge.textContent=statusText(p.status);right.append(badge);if(p.status===\"PLANNED\")right.append(btn(\"Запустить\",()=>command(\"StartPlan\",p),\"primary\"));if(p.status===\"RUNNING\")right.append(btn(\"Пауза\",()=>command(\"PausePlan\",p)));if(p.status===\"PAUSED\")right.append(btn(\"Продолжить\",()=>command(\"ResumePlan\",p),\"primary\"));if(p.status===\"RUNNING\"||p.status===\"PAUSED\")right.append(btn(\"Завершить\",()=>window.confirm(\"Завершить план? Сервер остановит таймер.\")?command(\"FinishPlan\",p):Promise.resolve(),\"danger\"));row.append(left,right);return row}async function openPlan(planId){try{const p=(await call(\"/api/plans/\"+encodeURIComponent(planId))).plan,box=q(\"#planDetail\");box.dataset.planId=planId;box.replaceChildren();const h=document.createElement(\"h2\");h.textContent=p.title;box.append(h);const m=document.createElement(\"p\");m.className=\"muted\";m.textContent=\"Дата плана: \"+(p.planCreatedAt.precision===\"dateOnly\"?p.planCreatedAt.on:dateFmt(Date.parse(p.planCreatedAt.value)))+\" · создан \"+dateFmt(p.registeredAt)+\" · \"+statusText(p.status);box.append(m);for(const label of [p.description||\"Описание не задано.\",\"Критерии приёмки: \"+(p.acceptanceCriteria||\"не заданы\"),\"Активно \"+duration(p.activeMs)+\" · календарное \"+duration(p.calendarMs)+\" · пауза \"+duration(p.pausedMs)]){const e=document.createElement(\"p\");e.textContent=label;box.append(e)}const edit=document.createElement(\"form\");edit.className=\"form\";const title=document.createElement(\"input\");title.value=p.title;title.maxLength=200;title.setAttribute(\"aria-label\",\"Название плана\");const description=document.createElement(\"textarea\");description.value=p.description||\"\";description.maxLength=20000;description.setAttribute(\"aria-label\",\"Описание\");const criteria=document.createElement(\"textarea\");criteria.value=p.acceptanceCriteria||\"\";criteria.maxLength=20000;criteria.setAttribute(\"aria-label\",\"Критерии приёмки\");const date=document.createElement(\"input\");date.type=\"date\";date.value=p.planCreatedAt.precision===\"dateOnly\"?p.planCreatedAt.on:dateLocal(Date.parse(p.planCreatedAt.value));date.setAttribute(\"aria-label\",\"Дата составления\");const reason=document.createElement(\"input\");reason.placeholder=\"Причина правки даты\";reason.setAttribute(\"aria-label\",\"Причина правки даты\");const label=document.createElement(\"label\"),confirm=document.createElement(\"input\");confirm.type=\"checkbox\";label.append(confirm,document.createTextNode(\"Подтверждаю дату составления после первого старта\"));const save=document.createElement(\"button\");save.textContent=\"Сохранить изменения\";edit.append(title,description,criteria,date,reason,label,save);edit.onsubmit=async e=>{e.preventDefault();await command(\"UpdatePlanMetadata\",p,{title:title.value,description:description.value,acceptanceCriteria:criteria.value,planCreatedAt:p.planCreatedAt.precision===\"instant\"&&date.value===dateLocal(Date.parse(p.planCreatedAt.value))?p.planCreatedAt:{precision:\"dateOnly\",on:date.value,timeZone:zone},reason:reason.value,confirmDateAnomaly:confirm.checked});await openPlan(p.planId)};box.append(edit);const intervals=document.createElement(\"div\"),ih=document.createElement(\"h3\");ih.textContent=\"Интервалы\";intervals.append(ih);p.intervals.forEach(i=>{const e=document.createElement(\"p\");e.textContent=dateFmt(i.start_ms)+\" — \"+dateFmt(i.end_ms)+\" · \"+duration((i.end_ms||p.serverNow)-i.start_ms);intervals.append(e)});box.append(intervals);const events=document.createElement(\"div\"),eh=document.createElement(\"h3\");eh.textContent=\"История команд\";events.append(eh);p.events.forEach(x=>{const e=document.createElement(\"p\");e.textContent=x.event_type+\" · \"+dateFmt(x.server_occurred_at)+\" · \"+x.actor_type;events.append(e)});box.append(events);const commits=document.createElement(\"div\"),ch=document.createElement(\"h3\");ch.textContent=\"Коммиты и связь с планами\";commits.append(ch);p.commits.forEach(c=>{const row=document.createElement(\"div\");row.className=\"row\";const a=document.createElement(\"a\");a.href=c.url;a.target=\"_blank\";a.rel=\"noopener noreferrer\";const author=(c.author_name||c.author_login||\"Неизвестен\")+(c.author_type===\"Bot\"?\" · бот\":c.author_github_id?\" · GitHub ID \"+c.author_github_id:\" · неизвестный GitHub-аккаунт\"),committer=(c.committer_name||c.committer_login||\"Неизвестен\")+(c.committer_type===\"Bot\"?\" · бот\":c.committer_github_id?\" · GitHub ID \"+c.committer_github_id:\" · неизвестный GitHub-аккаунт\");a.textContent=c.sha.slice(0,10)+\" · \"+c.link_status+\" · \"+c.link_basis+\" · автор: \"+author+\" · коммитер: \"+committer+\" · \"+(c.link_reason||\"\")+\" · \"+(c.message||\"\").slice(0,100);row.append(a);const actions=document.createElement(\"div\");actions.className=\"row-right\";[\"confirmed\",\"candidate\",\"excluded\"].forEach(status=>actions.append(btn(status,async()=>{await command(\"ReviewCommitLink\",p,{repositoryId:c.repository_id,sha:c.sha,status,reason:\"Reviewed manually in plan details\"});await openPlan(p.planId)})));row.append(actions);commits.append(row)});if(!p.commits.length){const e=document.createElement(\"p\");e.className=\"muted\";e.textContent=\"Связанных коммитов пока нет.\";commits.append(e)}box.append(commits);view(\"detail\")}catch(e){showToast((e.code||\"ERROR\")+\": \"+e.message,true)}}function renderActive(){const el=q(\"#active\");el.replaceChildren();if(!active){const p=document.createElement(\"p\");p.className=\"muted\";p.textContent=\"Активного плана нет. Создайте его и запустите, когда начнёте работу.\";el.append(p,btn(\"Создать план\",openModal,\"primary\"));return}const title=document.createElement(\"h3\");title.textContent=active.title;const clock=document.createElement(\"div\");clock.className=\"timer\";clock.id=\"clock\";clock.textContent=duration(active.activeMs+Math.max(0,Date.now()-serverNow));const detail=document.createElement(\"div\");detail.className=\"muted\";detail.textContent=\"Начат \"+dateFmt(active.firstStartedAt)+\" · всего \"+duration(active.calendarMs+Math.max(0,Date.now()-serverNow));const actions=document.createElement(\"div\");actions.className=\"actions\";actions.append(btn(\"Пауза\",()=>command(\"PausePlan\",active)),btn(\"Завершить\",()=>window.confirm(\"Завершить план? Время будет остановлено сервером.\")?command(\"FinishPlan\",active):Promise.resolve(),\"danger\"));el.append(title,clock,detail,actions)}function render(){const list=q(\"#plans\"),recent=q(\"#recent\");list.replaceChildren();recent.replaceChildren();if(!plans.length){const p=document.createElement(\"p\");p.className=\"muted\";p.textContent=\"Планов пока нет.\";list.append(p);recent.append(p.cloneNode(true))}else{plans.forEach(p=>list.append(card(p)));plans.slice(0,4).forEach(p=>recent.append(card(p)))}renderActive();if(q(\"#count\"))q(\"#count\").textContent=String(plans.filter(p=>p.status===\"COMPLETED\"&&p.finishedAt>Date.now()-30*86400000).length);const today=dateLocal(Date.now()),start=new Date(today+\"T00:00:00\").getTime();const activeToday=plans.flatMap(p=>p.intervals||[]).reduce((sum,i)=>sum+Math.max(0,(i.end_ms==null?Date.now():i.end_ms)-Math.max(start,i.start_ms)),0);if(q(\"#today\"))q(\"#today\").textContent=duration(activeToday)}async function refresh(){const [p,a,w,s]=await Promise.all([call(\"/api/plans\"),call(\"/api/active\"),call(\"/api/whoami\"),call(\"/api/settings\")]);plans=p.plans;active=a.plan;serverNow=p.serverNow;zone=normalizeZone(s.timezone);q(\"#who\").textContent=w.email||\"Личный аккаунт\";q(\"#tz\").value=zone;render()}async function loadRepos(){const data=await call(\"/api/repositories\");repos=data.repositories||[];const sync=q(\"#sync\");sync.dataset.githubAvailable=String(data.githubAvailable===true);sync.querySelector(\"button\").disabled=data.githubAvailable!==true;const status=q(\"#githubStatus\");status.textContent=data.message||\"Синхронизация открытых репозиториев доступна.\";sync.setAttribute(\"aria-describedby\",\"githubStatus\");const options=q(\"#repoIds\"),list=q(\"#repos\");options.replaceChildren();list.replaceChildren();repos.forEach(r=>{const o=document.createElement(\"option\");o.value=r.repositoryId;o.textContent=r.fullName+(r.isPrivate?\" · закрытый\":\" · открытый\");options.append(o);const line=document.createElement(\"div\");line.className=\"row\";line.dataset.repositoryId=r.repositoryId;const name=document.createElement(\"span\");name.textContent=r.fullName+(r.isPrivate?\" · закрытый\":\" · открытый\");const state=document.createElement(\"span\");state.className=\"muted\";state.textContent=r.completeness===\"partial\"?\"Частично загружен\":r.lastSuccessfulSyncAt?dateFmt(r.lastSuccessfulSyncAt):\"Ещё не синхронизирован\";line.append(name,state);list.append(line)});}function openModal(){modalReturnFocus=document.activeElement;document.body.style.overflow=\"hidden\";q(\"#modal\").classList.remove(\"hidden\");q(\"#createdDate\").value=dateLocal(Date.now());q(\"#title\").focus();loadRepos().catch(e=>showToast(e.message,true))}function closeModal(){if(q(\"#create\").getAttribute(\"aria-busy\")===\"true\")return;q(\"#modal\").classList.add(\"hidden\");document.body.style.overflow=\"\";if(modalReturnFocus?.isConnected)modalReturnFocus.focus()}async function loadAnalytics(){const d=new Date(),from=new Date(d);from.setDate(from.getDate()-29);if(!q(\"#from\").value)q(\"#from\").value=dateLocal(from);if(!q(\"#to\").value)q(\"#to\").value=dateLocal(d);const u=new URLSearchParams({from:q(\"#from\").value,to:q(\"#to\").value,timeZone:zone});const a=await call(\"/api/analytics?\"+u);const stats=q(\"#stats\");stats.replaceChildren();const medianText=duration(a.completedMedianActiveMs)+(a.completedMedianActiveMs==null?\"\":\" · \"+formatPlanSample(a.completedMeasuredN));[[\"Активное время за период\",duration(a.totalActiveMs)],[\"Завершено планов\",String(a.completedPlans)],[\"Медиана активного времени\",medianText]].forEach(([k,v],index)=>{const box=document.createElement(\"div\"),small=document.createElement(\"small\"),strong=document.createElement(\"strong\");box.className=\"metric\";small.textContent=k;strong.textContent=v;box.append(small,strong);if(index===2&&a.completedSmallSample){const note=document.createElement(\"small\");note.className=\"sample-note\";note.textContent=\"Малая выборка\";note.title=\"Медиана рассчитана по менее чем пяти завершённым планам.\";note.setAttribute(\"aria-label\",\"Малая выборка: менее пяти завершённых планов.\");box.append(note)}stats.append(box)});const chart=q(\"#chart\");chart.replaceChildren();const max=Math.max(1,...a.activeByDay.map(x=>x.activeMs));a.activeByDay.forEach(x=>{const row=document.createElement(\"div\"),date=document.createElement(\"span\"),bar=document.createElement(\"div\"),fill=document.createElement(\"span\"),v=document.createElement(\"span\");row.className=\"barrow\";bar.className=\"bar\";fill.style.width=(100*x.activeMs/max)+\"%\";bar.append(fill);date.textContent=x.date;v.textContent=duration(x.activeMs);row.append(date,bar,v);chart.append(row)});const list=q(\"#analyticPlans\");list.replaceChildren();if(!a.plans.length){const p=document.createElement(\"p\");p.className=\"muted\";p.textContent=\"За выбранный период данных нет.\";list.append(p)}else a.plans.forEach(x=>{const row=document.createElement(\"div\"),name=document.createElement(\"span\"),value=document.createElement(\"span\");row.className=\"row\";name.textContent=x.title;value.className=\"muted\";value.textContent=duration(x.activeInPeriodMs)+(x.finishedAt?\" · завершён \"+dateFmt(x.finishedAt):\"\");row.append(name,value);list.append(row)})}function view(name){all(\"[id^=view-]\").forEach(x=>x.classList.toggle(\"hidden\",x.id!==\"view-\"+name));all(\".nav button\").forEach(b=>b.setAttribute(\"aria-current\",b.dataset.view===name?\"page\":\"false\"));if(name===\"analytics\")loadAnalytics().catch(e=>showToast(e.message,true));if(name===\"settings\")loadRepos().catch(e=>showToast(e.message,true))}all(\".nav button\").forEach(b=>b.onclick=()=>view(b.dataset.view));q(\"#backPlans\").onclick=()=>view(\"plans\");q(\"#newPlan\").onclick=openModal;q(\"#newPlan2\").onclick=openModal;q(\"#close\").onclick=closeModal;q(\"#cancel\").onclick=closeModal;q(\"#modal\").onclick=e=>{if(e.target.id===\"modal\")closeModal()};q(\"#create\").onsubmit=async e=>{e.preventDefault();const ids=[...q(\"#repoIds\").selectedOptions].map(o=>o.value);const env={schemaVersion:1,commandId:uid(),commandType:\"CreatePlan\",payload:{title:q(\"#title\").value,description:q(\"#description\").value,acceptanceCriteria:q(\"#criteria\").value,planCreatedAt:{precision:\"dateOnly\",on:q(\"#createdDate\").value,timeZone:zone},repositoryIds:ids,repositoryRefs:Object.fromEntries(repos.filter(r=>ids.includes(r.repositoryId)).map(r=>[r.repositoryId,q(\"[data-refrepo=\\\"\"+r.repositoryId+\"\\\"]\")?.value.trim()||r.defaultBranch]))}};try{await call(\"/api/commands\",{method:\"POST\",body:JSON.stringify(env)});e.target.removeAttribute(\"aria-busy\");closeModal();e.target.reset();showToast(\"План создан. Таймер не запущен.\");await refresh()}catch(x){showToast((x.code||\"ERROR\")+\": \"+x.message,true)}};q(\"#apply\").onclick=()=>loadAnalytics().catch(e=>showToast(e.message,true));q(\"#sync\").onsubmit=async e=>{e.preventDefault();if(q(\"#sync\").dataset.githubAvailable!==\"true\")return;try{const r=await call(\"/api/repositories/sync\",{method:\"POST\",body:JSON.stringify({schemaVersion:1,commandId:uid(),commandType:\"SyncRepository\",payload:{fullName:q(\"#repo\").value.trim(),ref:q(\"#syncRef\")?.value.trim()||undefined,fullRescan:q(\"#fullRescan\")?.checked||false,authorGithubIds:(q(\"#authorIds\")?.value.trim()||\"\").split(\",\").map(x=>x.trim()).filter(Boolean)}})});if(r.result.error)showToast(r.result.errorMessage||r.result.message||\"Синхронизация не удалась.\",true);else showToast(r.result.completeness===\"complete\"?\"Синхронизация завершена.\":\"Загружены частичные данные; следующая страница \"+r.result.nextPage);await loadRepos()}catch(x){showToast((x.code||\"ERROR\")+\": \"+x.message,true)}};q(\"#settings\").onsubmit=async e=>{e.preventDefault();try{const r=await call(\"/api/settings\",{method:\"POST\",body:JSON.stringify({timezone:q(\"#tz\").value})});zone=normalizeZone(r.timezone);q(\"#tz\").value=zone;window.dispatchEvent(new CustomEvent(\"plan-time-zone-changed\",{detail:zone}));await refresh();showToast(\"Часовой пояс сохранён.\")}catch(x){showToast((x.code||\"ERROR\")+\": \"+x.message,true)}};setInterval(()=>{const c=q(\"#clock\");if(c&&active)c.textContent=duration(active.activeMs+Math.max(0,Date.now()-serverNow))},1000);refresh().catch(e=>{q(\"#who\").textContent=\"Требуется вход\";showToast(e.message,true)})})();</script></body></html>"
  ].join("").replace("</body></html>", "<script>" + UI_ENHANCEMENTS + "</script><script>" + UI_TRACKER + "</script><script>" + UI_ACCESSIBILITY + "</script></body></html>");
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
      // GitHub metadata can include private repository content; export it only with explicit opt-in.
      if (url.searchParams.get("includeGitHub") !== "true") {
        delete plan.repositories;
        delete plan.commits;
        delete plan.commitConflicts;
      }
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
    return json(await executeCommand(env.DB, identity, await bodyJson(request), channel, now));
  }
  if (request.method === "GET" && url.pathname === "/api/analytics") {
    return json(await buildAnalytics(env.DB, identity.ownerId, {
      from: url.searchParams.get("from"), to: url.searchParams.get("to"),
      timeZone: url.searchParams.get("timeZone") || (await dbFirst(env.DB, "SELECT timezone FROM owners WHERE owner_id=?", identity.ownerId)).timezone,
      repositoryIds: url.searchParams.getAll("repositoryId"),
    }, now));
  }
  if (request.method === "GET" && url.pathname === "/api/repositories") {
    const repositories = await dbAll(env.DB, "SELECT r.repository_id,r.full_name,r.is_private,r.default_branch,r.access_state,r.selected,s.last_successful_sync_at,s.completeness,s.cursor,s.last_error_code,s.author_filter_json FROM repositories r LEFT JOIN repository_sync_state s ON s.owner_id=r.owner_id AND s.repository_id=r.repository_id AND s.ref=r.default_branch WHERE r.owner_id=? ORDER BY r.full_name", identity.ownerId);
    const syncStates = await dbAll(env.DB, "SELECT repository_id,ref,last_successful_sync_at,completeness,cursor,last_error_code FROM repository_sync_state WHERE owner_id=? ORDER BY repository_id,ref", identity.ownerId);
    const syncStatesByRepository = new Map();
    for (const syncState of syncStates) {
      if (!syncStatesByRepository.has(syncState.repository_id)) syncStatesByRepository.set(syncState.repository_id, []);
      syncStatesByRepository.get(syncState.repository_id).push(syncState);
    }
    const hasGitHubToken = typeof env.GITHUB_TOKEN === "string" && Boolean(env.GITHUB_TOKEN.trim());
    return json({
      githubAvailable: true,
      githubMode: hasGitHubToken ? "authenticated" : "public",
      message: hasGitHubToken
        ? "Синхронизация доступна. Закрытые репозитории требуют прав у токена."
        : "Открытые доступны без входа, лимит ниже. Закрытым нужен GitHub-доступ.",
      repositories: repositories.map((r) => ({
        repositoryId: r.repository_id, fullName: r.is_private && r.access_state === "revoked" ? "Приватный репозиторий (доступ отозван)" : r.full_name, isPrivate: Boolean(r.is_private),
        defaultBranch: r.default_branch, accessState: r.access_state, selected: Boolean(r.selected),
        lastSuccessfulSyncAt: r.last_successful_sync_at, completeness: r.completeness,
        syncStatusUnavailable: Boolean(r.is_private && r.access_state !== "available"),
        syncStates: (r.is_private && r.access_state !== "available" ? [] : syncStatesByRepository.get(r.repository_id) || []).map((sync) => ({
          ref: sync.ref, lastSuccessfulSyncAt: sync.last_successful_sync_at, completeness: sync.completeness,
          cursor: sync.cursor, lastErrorCode: sync.last_error_code,
        })),
        cursor: r.cursor, lastErrorCode: r.last_error_code, authorFilterGithubIds: parseColumn(r.author_filter_json, null),
      })),
    });
  }
  if (request.method === "GET" && url.pathname === "/api/commit-conflicts") {
    const conflicts = await dbAll(env.DB, "SELECT c.repository_id,c.sha,c.marker_plan_ids_json,c.reason,c.detected_at,c.status,r.full_name FROM commit_attribution_conflicts c JOIN repositories r ON r.owner_id=c.owner_id AND r.repository_id=c.repository_id WHERE c.owner_id=? AND c.status='unresolved' AND (r.is_private=0 OR r.access_state='available') ORDER BY c.detected_at DESC LIMIT 500", identity.ownerId);
    for (const conflict of conflicts) {
      conflict.eligiblePlans = await dbAll(env.DB, "SELECT p.plan_id,p.title,p.status,p.version,pr.selected_ref FROM plans p JOIN plan_repositories pr ON pr.owner_id=p.owner_id AND pr.plan_id=p.plan_id WHERE p.owner_id=? AND pr.repository_id=? ORDER BY p.registered_at DESC LIMIT 200", identity.ownerId, conflict.repository_id);
    }
    return json({ conflicts: conflicts });
  }
  const cacheMatch = url.pathname.match(/^\/api\/repositories\/([^/]+)\/cache$/);
  if (request.method === "DELETE" && cacheMatch) {
    const repositoryId = decodeURIComponent(cacheMatch[1]);
    const repo = await dbFirst(env.DB, "SELECT is_private,access_state FROM repositories WHERE owner_id=? AND repository_id=?", identity.ownerId, repositoryId);
    if (!repo) throw appError("PLAN_NOT_FOUND", "Репозиторий не найден.", 404);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM plan_commit_links WHERE owner_id=? AND repository_id=?").bind(identity.ownerId, repositoryId),
      env.DB.prepare("DELETE FROM commit_attribution_conflicts WHERE owner_id=? AND repository_id=?").bind(identity.ownerId, repositoryId),
      env.DB.prepare("DELETE FROM repository_ref_commits WHERE owner_id=? AND repository_id=?").bind(identity.ownerId, repositoryId),
      env.DB.prepare("DELETE FROM repository_sync_state WHERE owner_id=? AND repository_id=?").bind(identity.ownerId, repositoryId),
      env.DB.prepare("DELETE FROM commits WHERE owner_id=? AND repository_id=?").bind(identity.ownerId, repositoryId),
      env.DB.prepare("UPDATE repositories SET access_state=?,updated_at=? WHERE owner_id=? AND repository_id=?")
        .bind(repo.is_private ? "revoked" : "unavailable", now, identity.ownerId, repositoryId),
    ]);
    return json({ repositoryId: repositoryId, cacheDeleted: true, plansAndIntervalsPreserved: true, serverNow: now });
  }
  if (request.method === "POST" && url.pathname === "/api/repositories/sync") {
    const body = await bodyJson(request);
    return json(await executeSyncCommand(env.DB, identity, body, channel, env.GITHUB_TOKEN, now));
  }
  const accessMatch = url.pathname.match(/^\/api\/repositories\/([^/]+)\/recheck-access$/);
  if (request.method === "POST" && accessMatch) {
    const repositoryId = decodeURIComponent(accessMatch[1]);
    const result = await env.DB.prepare("UPDATE repositories SET access_state='unavailable',updated_at=? WHERE owner_id=? AND repository_id=? AND is_private=1 AND access_state='revoked'")
      .bind(now, identity.ownerId, repositoryId).run();
    if (!result.meta || result.meta.changes !== 1) throw appError("VALIDATION_ERROR", "Приватный репозиторий не находится в состоянии отозванного доступа.");
    return json({ repositoryId: repositoryId, accessState: "unavailable", nextSyncRequiresExplicitCommand: true, serverNow: now });
  }
  throw appError("NOT_FOUND", "Маршрут не найден.", 404);
}

const TOOL_NAMES = ["CreatePlan", "GetPlan", "GetActivePlan", "StartPlan", "PausePlan", "ResumePlan", "FinishPlan", "UpdatePlanMetadata", "ReviewCommitLink", "SyncRepository", "GetAnalytics", ...TRACKER_READ_TOOLS, ...TRACKER_COMMANDS];
function mcpTools() {
  const writeNames = new Set([...WRITE_COMMANDS, ...TRACKER_COMMANDS, "SyncRepository"]);
  return TOOL_NAMES.map((name) => {
    let inputSchema = { type: "object", additionalProperties: false };
    if (name === "GetPlan") inputSchema = { type: "object", required: ["planId"], properties: { planId: { type: "string", format: "uuid" } }, additionalProperties: false };
    else if (name === "GetActivePlan") inputSchema = { type: "object", properties: {}, additionalProperties: false };
    else if (name === "GetTrackerCapabilities") inputSchema = { type: "object", properties: {}, additionalProperties: false };
    else if (name === "GetPlanExecutionSnapshot") inputSchema = { type: "object", required: ["planId"], properties: { planId: { type: "string", format: "uuid" } }, additionalProperties: false };
    else if (name === "GetTimeline") inputSchema = { type: "object", required: ["planId"], properties: { planId: { type: "string", format: "uuid" }, afterSequence: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false };
    else if (name === "GetCommandReceipt") inputSchema = { type: "object", required: ["commandId"], properties: { commandId: { type: "string", format: "uuid" } }, additionalProperties: false };
    else if (name === "GetAnalytics") inputSchema = { type: "object", required: ["from", "to", "timeZone"], properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" }, timeZone: { type: "string" }, repositoryIds: { type: "array", items: { type: "string" }, maxItems: 10 } }, additionalProperties: false };
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
          commitPolicy: { enum: CHECKPOINT_POLICIES }, pushPolicy: { enum: CHECKPOINT_POLICIES },
        };
        payloadRequired = ["planId", "ordinal", "title", "expectedResult", "requiredChecks", "commitPolicy", "pushPolicy"];
      } else if (name === "UpdateStep") {
        payloadProperties = {
          stepId: { type: "string", format: "uuid" },
          changes: { type: "object", properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
            expectedResult: { type: "string", minLength: 1, maxLength: 4000 },
            requiredChecks: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 } },
            commitPolicy: { enum: CHECKPOINT_POLICIES }, pushPolicy: { enum: CHECKPOINT_POLICIES },
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
        payloadProperties = { stepId: { type: "string", format: "uuid" }, attemptId: { type: "string", format: "uuid" }, fence: { type: "integer", minimum: 1 }, outcome: { enum: ["DONE", "FAILED"] }, summary: { type: "string", minLength: 1, maxLength: 4000 }, repositoryId: { type: "string", maxLength: 40 }, revisionSha: { type: "string", pattern: "^[a-fA-F0-9]{40}$" } };
        payloadRequired = ["stepId", "attemptId", "fence", "outcome", "summary"];
      } else if (name === "RecordCheck") {
        payloadProperties = {
          stepId: { type: "string", format: "uuid" }, resultRevision: { type: "integer", minimum: 1 },
          checkKey: { type: "string", minLength: 1, maxLength: 100 }, status: { enum: ["PASSED", "FAILED", "NOT_RUN"] },
          testedSha: { type: "string", pattern: "^[a-fA-F0-9]{40}$" }, exitCode: { type: "integer", minimum: 0, maximum: 255 },
          evidenceSummary: { type: "string", maxLength: 2000 }, evidenceUrl: { type: "string", pattern: "^https://", maxLength: 2048 },
        };
        payloadRequired = ["stepId", "resultRevision", "checkKey", "status", "testedSha"];
      } else if (name === "AcceptStep" || name === "RejectStep") {
        payloadProperties = {
          stepId: { type: "string", format: "uuid" }, resultRevision: { type: "integer", minimum: 1 },
          reason: { type: "string", minLength: 1, maxLength: 1000 },
        };
        payloadRequired = ["stepId", "resultRevision", "reason"];
        if (name === "AcceptStep") payloadProperties.waivers = {
          type: "array", maxItems: 20, items: { type: "object", required: ["checkKey", "reason"],
            properties: { checkKey: { type: "string", minLength: 1, maxLength: 100 }, reason: { type: "string", minLength: 1, maxLength: 1000 } }, additionalProperties: false },
        };
      } else if (name === "AppendObservation") {
        payloadProperties = {
          eventId: { type: "string", format: "uuid" }, planId: { type: "string", format: "uuid" },
          stepId: { type: "string", format: "uuid" }, attemptId: { type: "string", format: "uuid" },
          sourceId: { type: "string", minLength: 1, maxLength: 128 }, sessionId: { type: "string", format: "uuid" },
          sourceSequence: { type: "integer", minimum: 1 }, occurredAt: { type: "integer", minimum: 0 },
          eventType: { enum: [...OBSERVATION_TYPES] }, correctionOfEventId: { type: "string", format: "uuid" },
          data: { type: "object", properties: {
            turnId: { type: "string", format: "uuid" }, operationId: { type: "string", format: "uuid" },
            toolName: { type: "string", maxLength: 80 }, status: { enum: ["OK", "FAILED", "CANCELLED"] },
            durationMs: { type: "integer", minimum: 0, maximum: 604800000 },
            repositoryId: { type: "string", maxLength: 40 }, revisionSha: { type: "string", pattern: "^[a-fA-F0-9]{40}$" },
            ref: { type: "string", maxLength: 255 }, resultRevision: { type: "integer", minimum: 1 },
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
          repositoryIds: { type: "array", items: { type: "string" }, maxItems: 10 },
          repositoryRefs: { type: "object", additionalProperties: { type: "string", minLength: 1, maxLength: 255 } },
        };
        payloadRequired = ["title", "planCreatedAt"];
      } else if (name === "ReviewCommitLink") {
        payloadProperties = { planId: { type: "string", format: "uuid" }, repositoryId: { type: "string" }, sha: { type: "string", pattern: "^[a-fA-F0-9]{40}$" }, status: { enum: ["confirmed", "candidate", "excluded"] }, reason: { type: "string", minLength: 1, maxLength: 1000 } };
        payloadRequired = ["planId", "repositoryId", "sha", "status", "reason"];
      } else if (name === "SyncRepository") {
        payloadProperties = { fullName: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }, cursor: { type: "string" }, ref: { type: "string", maxLength: 255 }, fullRescan: { type: "boolean" }, authorGithubIds: { type: "array", items: { type: "string", pattern: "^\\d{1,30}$" }, maxItems: 100 } };
        payloadRequired = ["fullName"];
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
          expectedVersion: { type: "integer", minimum: 0 }, payloadHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
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
    } else if (name === "SyncRepository") {
      result = await executeSyncCommand(env.DB, identity, { ...args, schemaVersion: args.schemaVersion || 1, commandType: "SyncRepository" }, "mcp", env.GITHUB_TOKEN, now);
    } else throw appError("VALIDATION_ERROR", "Неизвестный MCP tool.");
    return json({ jsonrpc: "2.0", id: id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
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
        if (url.pathname.startsWith("/api/")) return await apiRoute(request, env, url, "ui", now);
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
