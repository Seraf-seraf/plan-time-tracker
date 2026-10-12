const BODY_LIMIT = 128 * 1024;
const PAGE_LIMIT = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;
const WRITE_COMMANDS = new Set(["CreatePlan", "StartPlan", "PausePlan", "ResumePlan", "FinishPlan", "UpdatePlanMetadata", "ReviewCommitLink"]);

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

export async function payloadHash(envelope) {
  const value = canonical({
    schemaVersion: envelope.schemaVersion,
    commandType: envelope.commandType,
    expectedVersion: envelope.expectedVersion == null ? null : envelope.expectedVersion,
    payload: envelope.payload,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function checkTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length > 100) throw new AppError("VALIDATION_ERROR", "Укажите IANA timezone.");
  try { new Intl.DateTimeFormat("en", { timeZone: timeZone }).format(0); }
  catch { throw new AppError("VALIDATION_ERROR", "Некорректная IANA timezone."); }
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
function validateOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw appError("FORBIDDEN", "Запрос с другого origin запрещён.", 403);
}
async function bodyJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > BODY_LIMIT) throw appError("VALIDATION_ERROR", "Размер запроса превышает лимит.", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > BODY_LIMIT) throw appError("VALIDATION_ERROR", "Размер запроса превышает лимит.", 413);
  try { return JSON.parse(text); } catch { throw appError("VALIDATION_ERROR", "Тело з�