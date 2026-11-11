import { UI_FONT_CSS } from "./fonts.js";

const TRACKER_VERSION = "0.6.0";
const BODY_LIMIT = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const isSnapshotDigest = value => typeof value === "string" && value.length === 71 && SNAPSHOT_DIGEST.test(value);
const WRITE_COMMANDS = new Set(["CreatePlan", "StartPlan", "PausePlan", "ResumePlan", "FinishPlan", "UpdatePlanMetadata", "DeletePlan", "RestorePlan"]);
const TRACKER_COMMANDS = new Set(["SetStepStatus", "RecordAssessment"]);
const TRACKER_VERSIONED_COMMANDS = new Set(["SetStepStatus"]);
const TRACKER_READ_TOOLS = new Set(["GetTrackerCapabilities", "GetPlanExecutionSnapshot", "GetCommandReceipt", "GetAssessment", "GetEstimationHistory", "CalculateAtlmEstimate", "GetPlanEstimate", "GetEstimationModelStatus", "GetAtlmDataset"]);
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
  return receipt.payload_hash === hash;
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
  return sorted.length % 2 ? sorted[middle] : sorted[middle - 1] + Math.round((sorted[middle] - sorted[middle - 1]) / 2);
}

const ESTIMATE_METHOD = Object.freeze({ id: "reference-class-median", version: "1" });
const ESTIMATE_PROFILE_FIELDS = Object.freeze(["workKind", "reuseState", "doneBoundary"]);
const ESTIMATE_WORK_KINDS = new Set(["CREATE_MECHANISM", "MODIFY_MECHANISM", "RUN_EXISTING_PROCESS", "VERIFY_EXISTING", "MIGRATE_DATA", "INVESTIGATE", "MIXED", "UNKNOWN"]);
const ESTIMATE_REUSE_STATES = new Set(["ABSENT", "PARTIAL", "READY", "UNKNOWN"]);
const ESTIMATE_DONE_BOUNDARIES = new Set(["ANALYSIS", "LOCAL_VERIFIED", "LOCAL_STAGED", "PUBLISHED", "DEPLOYED_VERIFIED", "UNKNOWN"]);
const ESTIMATE_DECISIONS = new Set(["INCLUDE", "DESCRIPTIVE", "EXCLUDE"]);
const ESTIMATE_STATUSES = new Set(["PLANNED", "RUNNING", "PAUSED", "COMPLETED"]);
const ESTIMATE_AUTHORITIES = new Set(["SERVER_PLAN_INTERVALS", "EXTERNAL_FIXTURE"]);
const ESTIMATE_MAX_CANDIDATES = 1000;
const ESTIMATE_MAX_CASES = 1000;
const ESTIMATE_ID = /^[\x20-\x7e]{1,128}$/;

function estimateValidation(message) {
  throw new AppError("VALIDATION_ERROR", message);
}

function invalidEstimateSource(message) {
  throw new AppError("INVALID_ESTIMATION_SOURCE", message);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys, message) {
  if (!isPlainRecord(value)) estimateValidation(message);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) estimateValidation(message);
}

function isNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateEstimateId(value, message) {
  if (typeof value !== "string" || !ESTIMATE_ID.test(value)) estimateValidation(message);
}

function validateEstimateDigest(value, nullable, message) {
  if (nullable && value === null) return;
  if (!isSnapshotDigest(value)) estimateValidation(message);
}

function validateEstimateProfile(profile) {
  hasExactKeys(profile, ESTIMATE_PROFILE_FIELDS, "profile должен содержать ровно три поля.");
  if (!ESTIMATE_WORK_KINDS.has(profile.workKind) || !ESTIMATE_REUSE_STATES.has(profile.reuseState)
    || !ESTIMATE_DONE_BOUNDARIES.has(profile.doneBoundary)) {
    estimateValidation("profile содержит неизвестное значение.");
  }
}

function validateEstimateCandidate(candidate, sourceAuthority) {
  if (!isPlainRecord(candidate)) estimateValidation("candidate должен быть объектом.");
  validateEstimateId(candidate.planId, "planId кандидата должен быть непустым ASCII ID до 128 символов.");
  if (candidate.deleted === true) {
    hasExactKeys(candidate, ["planId", "deleted"], "Удалённый кандидат содержит только planId и deleted=true.");
    return;
  }

  hasExactKeys(candidate, [
    "planId", "requirementsDigest", "profile", "decision", "scopeStability", "timeCoverage", "rationale", "deleted",
    "planStatus", "firstStartedAtMs", "finishedAtMs", "sourceAvailableAtMs", "checksConfirmed", "measurement", "activeMs",
    "intervalCount", "intervalsDigest",
  ], "candidate содержит отсутствующие или неизвестные поля.");
  if (candidate.deleted !== false) estimateValidation("deleted должен быть boolean.");
  validateEstimateDigest(candidate.requirementsDigest, sourceAuthority === "EXTERNAL_FIXTURE", "requirementsDigest некорректен.");
  validateEstimateProfile(candidate.profile);
  if (!ESTIMATE_DECISIONS.has(candidate.decision)) estimateValidation("decision кандидата некорректен.");
  if (!["STABLE", "CHANGED", "UNKNOWN"].includes(candidate.scopeStability)) estimateValidation("scopeStability некорректен.");
  if (!["COMPLETE", "PARTIAL", "UNKNOWN"].includes(candidate.timeCoverage)) estimateValidation("timeCoverage некорректен.");
  if (typeof candidate.rationale !== "string" || candidate.rationale.trim().length === 0 || Array.from(candidate.rationale).length > 128) {
    estimateValidation("rationale должен содержать от 1 до 128 символов.");
  }
  if (!ESTIMATE_STATUSES.has(candidate.planStatus)) estimateValidation("planStatus некорректен.");
  for (const field of ["firstStartedAtMs", "finishedAtMs", "activeMs"]) {
    if (candidate[field] !== null && !isNonnegativeSafeInteger(candidate[field])) estimateValidation(`${field} должен быть null или неотрицательным safe integer.`);
  }
  if (!isNonnegativeSafeInteger(candidate.sourceAvailableAtMs) || !isNonnegativeSafeInteger(candidate.intervalCount)) {
    estimateValidation("sourceAvailableAtMs и intervalCount должны быть неотрицательными safe integer.");
  }
  if (typeof candidate.checksConfirmed !== "boolean") estimateValidation("checksConfirmed должен быть boolean.");
  if (!["COMPLETE", "MISSING", "INCOMPLETE"].includes(candidate.measurement)) estimateValidation("measurement некорректен.");
  validateEstimateDigest(candidate.intervalsDigest, true, "intervalsDigest некорректен.");

  if (sourceAuthority === "SERVER_PLAN_INTERVALS") {
    if (candidate.requirementsDigest === null) estimateValidation("Серверный источник требует requirementsDigest.");
    if (candidate.firstStartedAtMs !== null && candidate.sourceAvailableAtMs < candidate.firstStartedAtMs) {
      invalidEstimateSource("sourceAvailableAtMs предшествует первому запуску.");
    }
    if (candidate.finishedAtMs !== null && candidate.sourceAvailableAtMs < candidate.finishedAtMs) {
      invalidEstimateSource("sourceAvailableAtMs предшествует завершению.");
    }
    if (candidate.firstStartedAtMs !== null && candidate.finishedAtMs !== null && candidate.finishedAtMs < candidate.firstStartedAtMs) {
      invalidEstimateSource("Граница завершения предшествует первому запуску.");
    }
    if (candidate.intervalCount === 0 ? candidate.intervalsDigest !== null : candidate.intervalsDigest === null) {
      invalidEstimateSource("intervalCount не согласован с intervalsDigest.");
    }
    if (candidate.measurement === "MISSING" && candidate.intervalCount > 0) {
      invalidEstimateSource("MISSING измерение не может содержать интервалы.");
    }
    if (candidate.measurement === "INCOMPLETE" && (candidate.firstStartedAtMs === null || candidate.intervalCount === 0)) {
      invalidEstimateSource("INCOMPLETE измерение требует первого запуска и хотя бы одного интервала.");
    }
    if (candidate.measurement === "COMPLETE") {
      if (candidate.planStatus !== "COMPLETED" || candidate.firstStartedAtMs === null || candidate.finishedAtMs === null
        || candidate.intervalCount === 0 || candidate.activeMs === null) {
        invalidEstimateSource("Полное серверное измерение требует завершённый план, границы и закрытые интервалы.");
      }
      if (candidate.activeMs > candidate.finishedAtMs - candidate.firstStartedAtMs) {
        invalidEstimateSource("PLAN_ACTIVE превышает интервал между запуском и завершением.");
      }
    } else if (candidate.activeMs !== null) {
      invalidEstimateSource("Неполное измерение не может содержать activeMs.");
    }
    if (candidate.planStatus !== "COMPLETED" && candidate.finishedAtMs !== null) {
      invalidEstimateSource("Незавершённый план не может содержать finishedAtMs.");
    }
  } else {
    if (candidate.firstStartedAtMs !== null || candidate.finishedAtMs !== null || candidate.intervalCount !== 0 || candidate.intervalsDigest !== null) {
      estimateValidation("EXTERNAL_FIXTURE не должен заявлять серверные границы или интервалы.");
    }
    if (candidate.measurement === "COMPLETE" ? candidate.activeMs === null : candidate.activeMs !== null) {
      estimateValidation("activeMs не согласован с внешним measurement.");
    }
  }
}

function validateEstimateSnapshot(snapshot) {
  hasExactKeys(snapshot, ["methodVersion", "metric", "referenceCutoffMs", "sourceAuthority", "target", "candidates"], "snapshot содержит отсутствующие или неизвестные поля.");
  if (snapshot.methodVersion !== 1 || snapshot.metric !== "PLAN_ACTIVE") estimateValidation("Неподдерживаемые methodVersion или metric.");
  if (!isNonnegativeSafeInteger(snapshot.referenceCutoffMs)) estimateValidation("referenceCutoffMs должен быть неотрицательным safe integer.");
  if (!ESTIMATE_AUTHORITIES.has(snapshot.sourceAuthority)) estimateValidation("sourceAuthority некорректен.");
  hasExactKeys(snapshot.target, ["planId", "expectedRequirementsDigest", "profile"], "target содержит отсутствующие или неизвестные поля.");
  validateEstimateId(snapshot.target.planId, "planId цели должен быть непустым ASCII ID до 128 символов.");
  validateEstimateDigest(snapshot.target.expectedRequirementsDigest, snapshot.sourceAuthority === "EXTERNAL_FIXTURE", "expectedRequirementsDigest некорректен.");
  validateEstimateProfile(snapshot.target.profile);
  if (!Array.isArray(snapshot.candidates) || snapshot.candidates.length > ESTIMATE_MAX_CANDIDATES) {
    estimateValidation(`candidates должен быть массивом не более ${ESTIMATE_MAX_CANDIDATES} записей.`);
  }
  const ids = new Set();
  for (const candidate of snapshot.candidates) {
    validateEstimateCandidate(candidate, snapshot.sourceAuthority);
    if (candidate.planId === snapshot.target.planId) estimateValidation("target нельзя включать в candidates.");
    if (ids.has(candidate.planId)) estimateValidation("planId кандидата повторяется.");
    ids.add(candidate.planId);
  }
}

function profileMatchReasons(target, source) {
  const hasUnknown = ESTIMATE_PROFILE_FIELDS.some((field) => target[field] === "UNKNOWN" || source[field] === "UNKNOWN");
  const hasMismatch = ESTIMATE_PROFILE_FIELDS.some((field) => target[field] !== "UNKNOWN" && source[field] !== "UNKNOWN" && target[field] !== source[field]);
  return { hasUnknown, hasMismatch };
}

// Adapted from HoboStank/agent-eta forecast.py blob b6022b3ffb4f4e16ba1ba467cd607cea5c99f91e; see docs/assessments.md for scope and semantic changes.
export function calculateComparableEstimate(snapshot) {
  validateEstimateSnapshot(snapshot);
  const candidates = snapshot.candidates.slice().sort((left, right) => left.planId < right.planId ? -1 : left.planId > right.planId ? 1 : 0);
  const included = [];
  const excluded = [];
  for (const candidate of candidates) {
    const reasons = [];
    if (candidate.deleted === true) {
      reasons.push("DELETED_SOURCE");
    } else {
      if (candidate.decision === "EXCLUDE") reasons.push("AGENT_EXCLUDED");
      else if (candidate.decision === "DESCRIPTIVE") reasons.push("DESCRIPTIVE_ONLY");
      const profile = profileMatchReasons(snapshot.target.profile, candidate.profile);
      if (profile.hasUnknown) reasons.push("UNKNOWN_PROFILE");
      if (profile.hasMismatch) reasons.push("PROFILE_MISMATCH");
      if (candidate.scopeStability === "CHANGED") reasons.push("SCOPE_CHANGED");
      else if (candidate.scopeStability === "UNKNOWN") reasons.push("SCOPE_UNCONFIRMED");
      if (candidate.timeCoverage !== "COMPLETE") reasons.push("TIME_COVERAGE_UNCONFIRMED");
      if (candidate.planStatus !== "COMPLETED" || (snapshot.sourceAuthority === "SERVER_PLAN_INTERVALS" && candidate.finishedAtMs === null)) {
        reasons.push("NOT_COMPLETED");
      }
      if (!candidate.checksConfirmed) reasons.push("CHECKS_UNCONFIRMED");
      if (candidate.measurement === "MISSING") reasons.push("NO_MEASUREMENT");
      else if (candidate.measurement === "INCOMPLETE") reasons.push("INCOMPLETE_INTERVALS");
      if (candidate.sourceAvailableAtMs >= snapshot.referenceCutoffMs) reasons.push("AFTER_CUTOFF");
    }
    if (reasons.length > 0) excluded.push({ planId: candidate.planId, reasons });
    else included.push({ planId: candidate.planId, activeMs: candidate.activeMs });
  }

  const pointMs = median(included.map((candidate) => candidate.activeMs));
  return {
    formatVersion: 1,
    method: ESTIMATE_METHOD,
    metric: "PLAN_ACTIVE",
    estimand: "ACCEPTED_UNCHANGED_SCOPE",
    status: included.length === 0 ? "INSUFFICIENT_DATA" : "AVAILABLE",
    referenceKind: included.length === 0 ? "NONE" : included.length === 1 ? "SINGLE_REFERENCE" : "HISTORICAL_REFERENCE",
    pointMs,
    observedRange: included.length === 0 ? null : {
      minMs: Math.min(...included.map((candidate) => candidate.activeMs)),
      maxMs: Math.max(...included.map((candidate) => candidate.activeMs)),
      kind: "OBSERVED_SAMPLE",
    },
    sampleCount: included.length,
    accuracy: "NOT_VALIDATED",
    intervalCoverage: null,
    includedPlanIds: included.map((candidate) => candidate.planId),
    excluded,
    selectionAuthority: "agent",
  };
}

function addSafeInteger(total, value) {
  const result = total + value;
  if (!Number.isSafeInteger(result)) estimateValidation("Сумма ошибок или фактов превышает safe integer.");
  return result;
}

// Adapted from the selected Agent ETA test invariants; no Store, clock, or source lifecycle is included.
export function scoreEstimateCases(cases) {
  if (!Array.isArray(cases) || cases.length > ESTIMATE_MAX_CASES) estimateValidation(`cases должен быть массивом не более ${ESTIMATE_MAX_CASES} записей.`);
  const ids = new Set();
  let actualKnownCount = 0;
  let predictionCount = 0;
  let scoredCount = 0;
  let missingActualCount = 0;
  let missingPredictionCount = 0;
  let actualSumMs = 0;
  let absoluteErrorSumMs = 0;
  let signedErrorSumMs = 0;

  for (const item of cases) {
    hasExactKeys(item, ["caseId", "actualMs", "predictedMs"], "Оценочный случай содержит отсутствующие или неизвестные поля.");
    validateEstimateId(item.caseId, "caseId должен быть непустым ASCII ID до 128 символов.");
    if (ids.has(item.caseId)) estimateValidation("caseId повторяется.");
    ids.add(item.caseId);
    for (const field of ["actualMs", "predictedMs"]) {
      if (item[field] !== null && !isNonnegativeSafeInteger(item[field])) estimateValidation(`${field} должен быть null или неотрицательным safe integer.`);
    }
    if (item.actualMs === null) missingActualCount += 1;
    else {
      actualKnownCount += 1;
      if (item.predictedMs !== null) actualSumMs = addSafeInteger(actualSumMs, item.actualMs);
    }
    if (item.predictedMs === null) missingPredictionCount += 1;
    else predictionCount += 1;
    if (item.actualMs !== null && item.predictedMs !== null) {
      scoredCount += 1;
      const difference = item.predictedMs - item.actualMs;
      absoluteErrorSumMs = addSafeInteger(absoluteErrorSumMs, Math.abs(difference));
      signedErrorSumMs = addSafeInteger(signedErrorSumMs, difference);
    }
  }

  return {
    caseCount: cases.length,
    actualKnownCount,
    predictionCount,
    scoredCount,
    missingActualCount,
    missingPredictionCount,
    forecastRate: cases.length === 0 ? null : predictionCount / cases.length,
    maeMs: scoredCount === 0 ? null : absoluteErrorSumMs / scoredCount,
    wapePercent: scoredCount === 0 || actualSumMs === 0 ? null : 100 * absoluteErrorSumMs / actualSumMs,
    signedBiasPercent: scoredCount === 0 || actualSumMs === 0 ? null : 100 * signedErrorSumMs / actualSumMs,
  };
}

// ATLM agent-v1: automatic identity/log/sqrt transformations and ordinary least
// squares. Runtime has no ML service or random state. All preprocessing belongs
// to the training prefix; callers supply server-validated frozen observations.
const ATLM_METHOD = Object.freeze({ id: "atlm", version: "agent-v1" });
const ATLM_FEATURE_VERSION = "agent-task-v1";
const ATLM_NUMERIC_FIELDS = Object.freeze(["outcomeCount", "contractCount", "verificationKindCount"]);
const ATLM_CATEGORY_LEVELS = Object.freeze({
  workKind: Object.freeze([...ESTIMATE_WORK_KINDS].filter(value => value !== "UNKNOWN")),
  reuseState: Object.freeze([...ESTIMATE_REUSE_STATES].filter(value => value !== "UNKNOWN")),
  doneBoundary: Object.freeze([...ESTIMATE_DONE_BOUNDARIES].filter(value => value !== "UNKNOWN")),
});
const ATLM_MAX_ROWS = 5000;
const ATLM_MAX_EVALUATION_CASES = 20;
const ATLM_TRANSFORMS = Object.freeze(["identity", "log", "sqrt"]);

function atlmUnavailable(reason, details = {}) { return { status: "UNAVAILABLE", pointMs: null, reason, ...details }; }
function atlmCompareId(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function atlmValidId(value) { return typeof value === "string" && ESTIMATE_ID.test(value) && value.trim().length > 0; }
function atlmExactKeys(value, keys) {
  return isPlainRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function atlmFeatureProblem(features) {
  const fields = [...ESTIMATE_PROFILE_FIELDS, ...ATLM_NUMERIC_FIELDS];
  if (!atlmExactKeys(features, fields)) return atlmUnavailable("INVALID_FEATURES");
  const missingFields = [];
  for (const field of ESTIMATE_PROFILE_FIELDS) {
    if (features[field] === "UNKNOWN" || features[field] === null) missingFields.push(field);
    else if (!ATLM_CATEGORY_LEVELS[field].includes(features[field])) return atlmUnavailable("INVALID_FEATURES");
  }
  for (const field of ATLM_NUMERIC_FIELDS) {
    if (features[field] === null) missingFields.push(field);
    else if (!isNonnegativeSafeInteger(features[field]) || features[field] > (field === "verificationKindCount" ? 5 : 20)) return atlmUnavailable("INVALID_FEATURES");
  }
  return missingFields.length ? atlmUnavailable("INCOMPLETE_FEATURES", { missingFields }) : null;
}
function atlmDatasetProblem(rows) {
  if (!Array.isArray(rows)) return atlmUnavailable("INVALID_DATASET");
  if (rows.length > ATLM_MAX_ROWS) return atlmUnavailable("DATASET_LIMIT_REACHED", { sampleCount: rows.length, limit: ATLM_MAX_ROWS });
  const samples = new Set(), plans = new Set();
  for (const row of rows) {
    if (!atlmExactKeys(row, ["sampleId", "planId", "capturedAt", "sourceAvailableAt", "features", "actualMs"])
      || !atlmValidId(row.sampleId) || !atlmValidId(row.planId) || samples.has(row.sampleId) || plans.has(row.planId)
      || ![row.capturedAt, row.sourceAvailableAt, row.actualMs].every(isNonnegativeSafeInteger)
      || row.sourceAvailableAt < row.capturedAt) return atlmUnavailable("INVALID_DATASET");
    if (atlmFeatureProblem(row.features)?.reason === "INVALID_FEATURES") return atlmUnavailable("INVALID_DATASET");
    samples.add(row.sampleId); plans.add(row.planId);
  }
  return null;
}
function atlmSortedRows(rows) { return rows.slice().sort((a, b) => atlmCompareId(a.planId, b.planId) || atlmCompareId(a.sampleId, b.sampleId)); }
function atlmSum(values) {
  let sum = 0, correction = 0;
  for (const value of values) { const adjusted = value - correction, next = sum + adjusted; correction = (next - sum) - adjusted; sum = next; }
  return sum;
}
function atlmTransform(name, value) {
  if (name === "identity") return value;
  if (name === "log") return value > 0 ? Math.log(value) : NaN;
  if (name === "sqrt") return value >= 0 ? Math.sqrt(value) : NaN;
  return NaN;
}
function atlmChooseTransform(values) {
  if (values.every(value => value === values[0])) return "identity";
  let best = "identity", bestScore = Infinity;
  for (const name of ATLM_TRANSFORMS) {
    const transformed = values.map(value => atlmTransform(name, value));
    if (!transformed.every(Number.isFinite)) continue;
    const mean = atlmSum(transformed) / transformed.length;
    const deviations = transformed.map(value => value - mean);
    const scale = Math.max(...deviations.map(Math.abs));
    if (!(scale > 0)) continue;
    // Scaling cancels from b1 and prevents overflow in the second/third moments.
    const scaled = deviations.map(value => value / scale);
    const m3 = atlmSum(scaled.map(value => value ** 3)) / values.length;
    const variance = atlmSum(scaled.map(value => value ** 2)) / (values.length - 1);
    const score = Math.abs(m3 / variance ** 1.5);
    if (Number.isFinite(score) && score < bestScore - 1e-12) { best = name; bestScore = score; }
  }
  return best;
}
function atlmDesignRow(features, columns, transforms) {
  return columns.map(column => column.kind === "intercept" ? 1
    : column.kind === "category" ? Number(features[column.field] === column.level)
      : atlmTransform(transforms[column.field], features[column.field]));
}

// Column-equilibrated Householder QR with deterministic column pivoting. Rank
// uses eps * max(n,p) * max(abs(diag(R))) on the equilibrated matrix. Column
// scaling changes only numerical conditioning, not the OLS objective.
function atlmQr(matrix, target) {
  const n = matrix.length, p = matrix[0].length;
  const a = matrix.map(row => Float64Array.from(row)), y = Float64Array.from(target);
  const permutation = Array.from({ length: p }, (_, i) => i), scales = [];
  for (let j = 0; j < p; j++) {
    let norm = 0;
    for (let i = 0; i < n; i++) norm = Math.hypot(norm, a[i][j]);
    scales.push(norm);
    if (norm > 0) for (let i = 0; i < n; i++) a[i][j] /= norm;
  }
  for (let k = 0; k < p; k++) {
    let pivot = k, largest = -1;
    for (let j = k; j < p; j++) {
      let norm = 0;
      for (let i = k; i < n; i++) norm = Math.hypot(norm, a[i][j]);
      if (norm > largest || (norm === largest && permutation[j] < permutation[pivot])) { largest = norm; pivot = j; }
    }
    if (pivot !== k) {
      for (let i = 0; i < n; i++) [a[i][k], a[i][pivot]] = [a[i][pivot], a[i][k]];
      [permutation[k], permutation[pivot]] = [permutation[pivot], permutation[k]];
    }
    if (largest === 0) continue;
    const alpha = a[k][k] >= 0 ? -largest : largest;
    const vector = new Float64Array(n - k);
    vector[0] = a[k][k] - alpha;
    for (let i = k + 1; i < n; i++) vector[i - k] = a[i][k];
    let norm = 0;
    for (const value of vector) norm = Math.hypot(norm, value);
    for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    for (let j = k; j < p; j++) {
      let dot = 0;
      for (let i = k; i < n; i++) dot += vector[i - k] * a[i][j];
      for (let i = k; i < n; i++) a[i][j] -= 2 * vector[i - k] * dot;
    }
    let dot = 0;
    for (let i = k; i < n; i++) dot += vector[i - k] * y[i];
    for (let i = k; i < n; i++) y[i] -= 2 * vector[i - k] * dot;
    a[k][k] = alpha;
    for (let i = k + 1; i < n; i++) a[i][k] = 0;
  }
  const rankTolerance = Number.EPSILON * Math.max(n, p) * Math.max(...a.slice(0, p).map((row, i) => Math.abs(row[i])));
  const rank = a.slice(0, p).filter((row, i) => Math.abs(row[i]) > rankTolerance).length;
  if (rank !== p) return { rank, rankTolerance, coefficients: null };
  const pivoted = new Float64Array(p), coefficients = Array(p);
  for (let i = p - 1; i >= 0; i--) {
    let residual = y[i];
    for (let j = i + 1; j < p; j++) residual -= a[i][j] * pivoted[j];
    pivoted[i] = residual / a[i][i];
  }
  for (let i = 0; i < p; i++) coefficients[permutation[i]] = pivoted[i] / scales[permutation[i]];
  return { rank, rankTolerance, coefficients };
}
function atlmFreeze(value) {
  if (value && typeof value === "object") { for (const nested of Object.values(value)) atlmFreeze(nested); Object.freeze(value); }
  return value;
}

export async function fitAtlm(rows) {
  const problem = atlmDatasetProblem(rows);
  if (problem) return problem;
  const sorted = atlmSortedRows(rows), n = sorted.length;
  if (!n) return atlmUnavailable("INSUFFICIENT_DATA", { sampleCount: 0 });
  for (const row of sorted) { const missing = atlmFeatureProblem(row.features); if (missing) return missing; }
  const levels = {}, transforms = {}, columns = [{ kind: "intercept" }], constantPredictors = [];
  for (const field of ESTIMATE_PROFILE_FIELDS) {
    const observed = new Set(sorted.map(row => row.features[field]));
    levels[field] = ATLM_CATEGORY_LEVELS[field].filter(value => observed.has(value));
    for (const level of levels[field].slice(1)) columns.push({ kind: "category", field, level });
  }
  for (const field of ATLM_NUMERIC_FIELDS) {
    const values = sorted.map(row => row.features[field]);
    transforms[field] = atlmChooseTransform(values);
    if (values.every(value => value === values[0])) constantPredictors.push(field);
    else columns.push({ kind: "numeric", field });
  }
  const p = columns.length, residualDegreesOfFreedom = n - p;
  if (residualDegreesOfFreedom < 5) return atlmUnavailable("INSUFFICIENT_DATA", { sampleCount: n, p, residualDegreesOfFreedom });
  const target = sorted.map(row => row.actualMs / 60000);
  transforms.target = atlmChooseTransform(target);
  const matrix = sorted.map(row => atlmDesignRow(row.features, columns, transforms));
  const solved = atlmQr(matrix, target.map(value => atlmTransform(transforms.target, value)));
  if (solved.rank !== p) return atlmUnavailable("RANK_DEFICIENT", { sampleCount: n, p, rank: solved.rank });
  if (!solved.coefficients.every(Number.isFinite)) return atlmUnavailable("NUMERICAL_FAILURE", { sampleCount: n });
  const artifact = atlmFreeze({
    formatVersion: 1, method: { ...ATLM_METHOD }, featureSchemaVersion: ATLM_FEATURE_VERSION, metric: "PLAN_ACTIVE",
    n, p, rank: solved.rank, residualDegreesOfFreedom, levels, transforms, columns, coefficients: solved.coefficients,
    constantPredictors, manifest: sorted.map(({ sampleId, planId }) => ({ sampleId, planId })),
    datasetDigest: "sha256:" + await hashCommandInput(sorted),
    engine: { id: "ECMAScript-binary64", version: "householder-qr-pivot-v1", rankTolerance: solved.rankTolerance },
  });
  return { status: "AVAILABLE", artifact };
}

function atlmArtifactValid(artifact) {
  if (!isPlainRecord(artifact) || artifact.formatVersion !== 1 || artifact.method?.id !== ATLM_METHOD.id
    || artifact.method?.version !== ATLM_METHOD.version || artifact.featureSchemaVersion !== ATLM_FEATURE_VERSION
    || artifact.metric !== "PLAN_ACTIVE" || !isNonnegativeSafeInteger(artifact.n) || artifact.n > ATLM_MAX_ROWS
    || !Number.isInteger(artifact.p) || artifact.p < 1 || artifact.n - artifact.p < 5 || artifact.rank !== artifact.p
    || artifact.residualDegreesOfFreedom !== artifact.n - artifact.p || !isSnapshotDigest(artifact.datasetDigest)
    || !atlmExactKeys(artifact.levels, ESTIMATE_PROFILE_FIELDS)
    || !atlmExactKeys(artifact.transforms, [...ATLM_NUMERIC_FIELDS, "target"])
    || !Object.values(artifact.transforms).every(value => ATLM_TRANSFORMS.includes(value))
    || !Array.isArray(artifact.constantPredictors) || !artifact.constantPredictors.every(field => ATLM_NUMERIC_FIELDS.includes(field))
    || new Set(artifact.constantPredictors).size !== artifact.constantPredictors.length) return false;
  const columns = [{ kind: "intercept" }];
  for (const field of ESTIMATE_PROFILE_FIELDS) {
    const levels = artifact.levels[field];
    if (!Array.isArray(levels) || !levels.length || new Set(levels).size !== levels.length
      || levels.some(level => !ATLM_CATEGORY_LEVELS[field].includes(level))
      || canonical(levels) !== canonical(ATLM_CATEGORY_LEVELS[field].filter(level => levels.includes(level)))) return false;
    for (const level of levels.slice(1)) columns.push({ kind: "category", field, level });
  }
  for (const field of ATLM_NUMERIC_FIELDS) {
    if (artifact.constantPredictors.includes(field)) { if (artifact.transforms[field] !== "identity") return false; }
    else columns.push({ kind: "numeric", field });
  }
  if (!Array.isArray(artifact.columns) || canonical(columns) !== canonical(artifact.columns)
    || artifact.p !== columns.length || !Array.isArray(artifact.coefficients) || artifact.coefficients.length !== columns.length
    || !artifact.coefficients.every(Number.isFinite) || !Array.isArray(artifact.manifest) || artifact.manifest.length !== artifact.n) return false;
  const samples = new Set(), plans = new Set();
  for (const item of artifact.manifest) {
    if (!atlmExactKeys(item, ["sampleId", "planId"]) || !atlmValidId(item.sampleId) || !atlmValidId(item.planId)
      || samples.has(item.sampleId) || plans.has(item.planId)) return false;
    samples.add(item.sampleId); plans.add(item.planId);
  }
  return true;
}

export function predictAtlm(artifact, features) {
  if (!atlmArtifactValid(artifact)) return atlmUnavailable("INVALID_ARTIFACT");
  const problem = atlmFeatureProblem(features);
  if (problem) return problem;
  if (ESTIMATE_PROFILE_FIELDS.some(field => !artifact.levels[field].includes(features[field]))) return atlmUnavailable("UNSUPPORTED_CATEGORY");
  const design = atlmDesignRow(features, artifact.columns, artifact.transforms);
  if (!design.every(Number.isFinite)) return atlmUnavailable("INVALID_PREDICTION");
  const transformed = atlmSum(design.map((value, i) => value * artifact.coefficients[i]));
  const minutes = artifact.transforms.target === "identity" ? transformed
    : artifact.transforms.target === "log" ? Math.exp(transformed) : transformed < 0 ? NaN : transformed ** 2;
  if (!Number.isFinite(minutes) || minutes < 0) return atlmUnavailable("INVALID_PREDICTION");
  const pointMs = Math.round(minutes * 60000);
  return isNonnegativeSafeInteger(pointMs) ? { status: "AVAILABLE", pointMs, reason: null } : atlmUnavailable("INVALID_PREDICTION");
}

function atlmEvaluationOptions(options) {
  if (!isPlainRecord(options) || Object.keys(options).some(key => !["protocolVersion", "cutoff"].includes(key))
    || (options.protocolVersion !== undefined && options.protocolVersion !== 1)
    || (options.cutoff !== undefined && !isNonnegativeSafeInteger(options.cutoff))) return atlmUnavailable("INVALID_PROTOCOL");
  return null;
}
export function selectAtlmEvaluationCases(rows, options = {}) {
  const problem = atlmEvaluationOptions(options) || atlmDatasetProblem(rows);
  if (problem) return problem;
  const cutoff = options.cutoff ?? Number.MAX_SAFE_INTEGER, excluded = [], eligible = [];
  for (const row of atlmSortedRows(rows)) {
    const missing = atlmFeatureProblem(row.features);
    const reason = row.sourceAvailableAt > cutoff ? "AFTER_CUTOFF" : missing?.reason;
    if (reason) excluded.push({ sampleId: row.sampleId, planId: row.planId, reason });
    else eligible.push(row);
  }
  eligible.sort((a, b) => a.capturedAt - b.capturedAt || atlmCompareId(a.planId, b.planId));
  return { status: "AVAILABLE", protocolVersion: 1, cutoff, inputCount: rows.length, eligibleCount: eligible.length,
    caseSampleIds: eligible.slice(-ATLM_MAX_EVALUATION_CASES).map(row => row.sampleId), excluded };
}
export async function evaluateAtlmCase(rows, sampleId, options = {}) {
  const selection = selectAtlmEvaluationCases(rows, options);
  if (selection.status !== "AVAILABLE") return selection;
  if (!selection.caseSampleIds.includes(sampleId)) return atlmUnavailable("INVALID_EVALUATION_CASE");
  const target = rows.find(row => row.sampleId === sampleId);
  const train = atlmSortedRows(rows.filter(row => row.planId !== target.planId
    && row.sourceAvailableAt < target.capturedAt && !atlmFeatureProblem(row.features)));
  const fit = await fitAtlm(train);
  const atlm = fit.status === "AVAILABLE" ? predictAtlm(fit.artifact, target.features) : atlmUnavailable(fit.reason);
  const pointMs = median(train.map(row => row.actualMs));
  return { sampleId: target.sampleId, planId: target.planId, capturedAt: target.capturedAt,
    sourceAvailableAt: target.sourceAvailableAt, features: { ...target.features }, actualMs: target.actualMs,
    trainSampleCount: train.length, trainDatasetDigest: fit.status === "AVAILABLE" ? fit.artifact.datasetDigest : "sha256:" + await hashCommandInput(train),
    atlm, median: pointMs === null ? atlmUnavailable("INSUFFICIENT_DATA") : { status: "AVAILABLE", pointMs, reason: null } };
}
function atlmScore(cases, method) {
  const scored = cases.filter(item => item[method].pointMs !== null);
  const errors = scored.map(item => item[method].pointMs - item.actualMs);
  const actualSum = atlmSum(scored.map(item => item.actualMs)), absoluteSum = atlmSum(errors.map(Math.abs));
  return { caseCount: cases.length, predictionCount: scored.length, scoredCount: scored.length,
    forecastRate: cases.length ? scored.length / cases.length : null,
    maeMs: scored.length ? absoluteSum / scored.length : null,
    wapePercent: actualSum > 0 ? 100 * absoluteSum / actualSum : null,
    signedBiasPercent: actualSum > 0 ? 100 * atlmSum(errors) / actualSum : null };
}
export function summarizeAtlmEvaluation(cases, selection) {
  if (selection?.status !== "AVAILABLE") return selection || atlmUnavailable("INVALID_EVALUATION");
  if (!Array.isArray(cases) || cases.length !== selection.caseSampleIds.length || new Set(cases.map(item => item.sampleId)).size !== cases.length
    || cases.some(item => !selection.caseSampleIds.includes(item.sampleId) || !isNonnegativeSafeInteger(item.actualMs)
      || ["atlm", "median"].some(method => !item[method] || (item[method].pointMs !== null && !isNonnegativeSafeInteger(item[method].pointMs))))) return atlmUnavailable("INCOMPLETE_EVALUATION");
  const ordered = selection.caseSampleIds.map(id => cases.find(item => item.sampleId === id));
  const pairedCases = ordered.filter(item => item.atlm.pointMs !== null && item.median.pointMs !== null);
  const metrics = { atlm: atlmScore(ordered, "atlm"), median: atlmScore(ordered, "median") };
  const paired = { caseCount: pairedCases.length, caseSampleIds: pairedCases.map(item => item.sampleId),
    atlm: atlmScore(pairedCases, "atlm"), median: atlmScore(pairedCases, "median") };
  return { status: "AVAILABLE", formatVersion: 1, protocolVersion: 1, method: { ...ATLM_METHOD }, metric: "PLAN_ACTIVE",
    cutoff: selection.cutoff, inputCount: selection.inputCount, eligibleCount: selection.eligibleCount, excluded: selection.excluded,
    caseCount: ordered.length, cases: ordered, metrics, paired,
    candidateReady: paired.caseCount >= 5 && paired.atlm.maeMs <= paired.median.maeMs };
}
export async function evaluateAtlmChronologically(rows, options = {}) {
  const selection = selectAtlmEvaluationCases(rows, options);
  if (selection.status !== "AVAILABLE") return selection;
  const cases = [];
  for (const sampleId of selection.caseSampleIds) cases.push(await evaluateAtlmCase(rows, sampleId, options));
  return summarizeAtlmEvaluation(cases, selection);
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
    PLAN_DELETED: "План удалён. Сначала восстановите его в разделе «Удалённые».",
    PLAN_NOT_DELETED: "План не находится в разделе «Удалённые».",
    STEP_NOT_FOUND: "Этап не найден.",
    CHECKPOINTS_INCOMPLETE: "Завершите этапы либо укажите причину завершения с исключением.",
    ASSESSMENT_TARGET_CONFLICT: "Серия оценки уже привязана к другой цели.",
    ASSESSMENT_CONTEXT_CHANGED: "Требования изменились после анализа задачи. Перечитайте контекст и пересмотрите оценку.",
    ATLM_FORECAST_SCOPE_CHANGED: "План уже запущен. Новый исходный прогноз сохранять нельзя.",
    ATLM_MODEL_CHANGED: "Модель изменилась во время расчёта. Получите свежую оценку новой командой.",
    DATASET_CHANGED: "Набор обучающих данных изменился. Начните выгрузку заново.",
    ASSESSMENT_SOURCE_NOT_FOUND: "Исторический источник оценки недоступен.",
    PLAN_PAUSED: "План на паузе. Сначала явно возобновите его.",
    PLAN_COMPLETED: "Завершённый план не принимает новые этапы.",
    INVALID_TRANSITION: "Команда недоступна в текущем состоянии плана.",
    VERSION_CONFLICT: "План изменился. Обновите данные и повторите команду с новой версией.",
    IDEMPOTENCY_KEY_REUSED: "commandId уже использован с другим содержимым.",
    SOURCE_UNAVAILABLE: "Источник данных временно недоступен.",
    RATE_LIMITED: "Превышена частота запросов.",
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
    const status=["ATLM_FORECAST_SCOPE_CHANGED","ATLM_MODEL_CHANGED","ASSESSMENT_TARGET_CONFLICT","ASSESSMENT_CONTEXT_CHANGED","VERSION_CONFLICT","CHECKPOINTS_INCOMPLETE","IDEMPOTENCY_KEY_REUSED","PLAN_DELETED","PLAN_NOT_DELETED","PLAN_PAUSED","PLAN_COMPLETED","INVALID_TRANSITION"].includes(code)?409:["PLAN_NOT_FOUND","STEP_NOT_FOUND"].includes(code)?404:code==="SOURCE_UNAVAILABLE"?503:code==="RATE_LIMITED"?429:code==="INTERNAL_ERROR"?500:422;
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
  const message=String(error?.message||"");
  if(message.includes("WORK_INTERVAL_OVERLAP"))return appError("VALIDATION_ERROR","Рабочие интервалы не могут пересекаться.");
  if(message.includes("CHECK constraint failed"))return appError("VALIDATION_ERROR","Данные нарушают ограничения модели.");
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



export const AGENT_TASK_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "profile", "outcomes", "changedContracts", "verificationKinds", "profileEvidence", "runtimeContext"],
  properties: {
    schemaVersion: { enum: ["agent-task-v1"] },
    profile: { type: "object", additionalProperties: false, required: [...ESTIMATE_PROFILE_FIELDS], properties: {
      workKind: { enum: [...ESTIMATE_WORK_KINDS] }, reuseState: { enum: [...ESTIMATE_REUSE_STATES] }, doneBoundary: { enum: [...ESTIMATE_DONE_BOUNDARIES] },
    } },
    outcomes: { type: ["array", "null"], maxItems: 20, items: { type: "object", additionalProperties: false,
      required: ["id", "description", "evidence"], properties: {
        id: { type: "string", minLength: 1, maxLength: 128 }, description: { type: "string", minLength: 1, maxLength: 400 }, evidence: { type: "string", minLength: 1, maxLength: 400 },
      } } },
    changedContracts: { type: ["array", "null"], maxItems: 20, items: { type: "object", additionalProperties: false,
      required: ["kind", "key", "description", "evidence"], properties: {
        kind: { enum: ["API", "MCP", "EVENT", "STORAGE", "OTHER"] }, key: { type: "string", minLength: 1, maxLength: 128 },
        description: { type: "string", minLength: 1, maxLength: 400 }, evidence: { type: "string", minLength: 1, maxLength: 400 },
      } } },
    verificationKinds: { type: ["array", "null"], maxItems: 20, items: { enum: ["BUILD_STATIC", "UNIT", "INTEGRATION", "UI_E2E", "DEPLOY_SMOKE"] } },
    profileEvidence: { type: "object", additionalProperties: false, required: [...ESTIMATE_PROFILE_FIELDS], properties: Object.fromEntries(ESTIMATE_PROFILE_FIELDS.map(key => [key, { type: "string", minLength: 1, maxLength: 400 }])) },
    runtimeContext: { type: "object", additionalProperties: false, required: ["modelId", "reasoningEffort", "environmentId", "plannedParallelAgents", "provenance"], properties: {
      ...Object.fromEntries(["modelId", "reasoningEffort", "environmentId"].map(key => [key, { type: ["string", "null"], minLength: 1, maxLength: 128 }])),
      plannedParallelAgents: { type: ["integer", "null"], minimum: 1 }, provenance: { enum: ["CLIENT_REPORTED", "UNKNOWN"] },
    } },
  },
};
export function normalizeAgentTaskV1(input) {
  validateAssessmentValue(input, AGENT_TASK_SCHEMA, "agentTask");
  const agentTask = JSON.parse(JSON.stringify(input));
  const dedupe = (items, key) => {
    if (items === null) return null;
    const seen = new Map();
    for (const item of items) {
      const id = key(item), previous = seen.get(id);
      if (previous && canonical(previous) !== canonical(item)) throw appError("VALIDATION_ERROR", "Conflicting duplicate agentTask key: " + id);
      seen.set(id, item);
    }
    return [...seen.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, item]) => item);
  };
  agentTask.outcomes = dedupe(agentTask.outcomes, item => item.id);
  agentTask.changedContracts = dedupe(agentTask.changedContracts, item => item.kind + ":" + item.key);
  if (agentTask.verificationKinds !== null) {
    const order = AGENT_TASK_SCHEMA.properties.verificationKinds.items.enum;
    agentTask.verificationKinds = [...new Set(agentTask.verificationKinds)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }
  const missingFields = ESTIMATE_PROFILE_FIELDS.filter(key => agentTask.profile[key] === "UNKNOWN").map(key => "profile." + key);
  for (const key of ["outcomes", "changedContracts", "verificationKinds"]) if (agentTask[key] === null) missingFields.push(key);
  const features = { ...agentTask.profile, outcomeCount: agentTask.outcomes?.length ?? null,
    contractCount: agentTask.changedContracts?.length ?? null, verificationKindCount: agentTask.verificationKinds?.length ?? null };
  return { agentTask, features, missingFields };
}

// Observe the current source in one SQLite read snapshot, not several independently timed reads.
export async function readAtlmSampleSource(db, ownerId, planId, nowMs) {
  if (!UUID.test(planId || "") || !Number.isSafeInteger(nowMs) || nowMs < 0) throw appError("VALIDATION_ERROR", "Invalid ATLM source arguments.");
  const row = await dbFirst(db, `SELECT p.*,
    i.assessment_sequence AS input_assessment_sequence,i.selection_status,i.requirements_json AS input_requirements_json,
    i.requirements_digest AS input_requirements_digest,i.captured_receipt_rowid,
    a.assessment_json,a.recorded_at AS captured_at,t.requirements_json AS current_requirements_json,
    COALESCE(j.generation,0) AS source_generation,COALESCE(j.source_changed_at,p.registered_at) AS source_changed_at,
    EXISTS(SELECT 1 FROM plan_steps cfg WHERE cfg.owner_id=p.owner_id AND cfg.plan_id=p.plan_id) AS tracker_enabled,
    (SELECT COUNT(*) FROM tracker_incomplete_steps s WHERE s.owner_id=p.owner_id AND s.plan_id=p.plan_id) AS incomplete_step_count,
    (SELECT json_group_array(json_object('startMs',w.start_ms,'endMs',w.end_ms)) FROM work_intervals w WHERE w.owner_id=p.owner_id AND w.plan_id=p.plan_id) AS intervals_json,
    (SELECT json_group_array(json_object('rowid',r.rowid,'type',r.command_type,'at',r.server_now_ms)) FROM command_receipts r
      WHERE r.owner_id=p.owner_id AND r.plan_id=p.plan_id AND r.outcome_code='OK'
        AND r.command_type IN ('StartPlan','ResumePlan','PausePlan','FinishPlan','DeletePlan')) AS timer_commands_json,
    (SELECT json_group_array(json_object('stepId',s.step_id,'ordinal',s.ordinal,'title',s.title,'content',s.content,'status',s.status)) FROM plan_steps s WHERE s.owner_id=p.owner_id AND s.plan_id=p.plan_id) AS steps_json,
    '[]' AS checks_json,
    (SELECT json_group_array(json_object('rowid',r.rowid,'type',r.command_type,'payload',json(r.payload_json))) FROM command_receipts r
      WHERE r.owner_id=p.owner_id AND r.plan_id=p.plan_id AND r.outcome_code='OK' AND r.rowid>i.captured_receipt_rowid
       AND r.command_type='UpdatePlanMetadata') AS scope_commands_json
    FROM plans p LEFT JOIN plan_estimation_inputs i ON i.owner_id=p.owner_id AND i.plan_id=p.plan_id
    LEFT JOIN assessment_revisions a ON a.owner_id=p.owner_id AND a.plan_id=p.plan_id AND a.sequence=i.assessment_sequence
    LEFT JOIN assessment_targets t ON t.owner_id=p.owner_id AND t.plan_id=p.plan_id AND t.step_id IS NULL
    LEFT JOIN estimation_jobs j ON j.owner_id=p.owner_id AND j.job_key='refresh:'||p.plan_id
    WHERE p.owner_id=? AND p.plan_id=?`, ownerId, planId);
  if (!row) throw appError("PLAN_NOT_FOUND", messageFor("PLAN_NOT_FOUND"), 404);
  const reasons = [], intervals = JSON.parse(row.intervals_json), steps = JSON.parse(row.steps_json), checks = JSON.parse(row.checks_json);
  let features = null;
  if (row.selection_status !== "CAPTURED") reasons.push("MISSING_FEATURES");
  else {
    try {
      const normalized = normalizeAgentTaskV1(JSON.parse(row.assessment_json).context.agentTask);
      if (normalized.missingFields.length) reasons.push("INCOMPLETE_FEATURES"); else features = normalized.features;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "VALIDATION_ERROR") throw error;
      reasons.push("INVALID_FEATURES");
    }
  }
  if (row.deleted_at !== null) reasons.push("PLAN_DELETED");
  if (row.status !== "COMPLETED") reasons.push("PLAN_NOT_COMPLETED");
  if (!row.tracker_enabled || !steps.length || row.incomplete_step_count !== 0) reasons.push("RESULT_NOT_VERIFIED");
  let scopeChanged = Boolean(row.input_requirements_json && row.input_requirements_json !== row.current_requirements_json);
  if (row.input_requirements_json) {
    const original=JSON.parse(row.input_requirements_json);
    for(const change of JSON.parse(row.scope_commands_json))for(const key of ["title","description","acceptanceCriteria"])if(Object.hasOwn(original.plan,key)&&Object.hasOwn(change.payload,key)&&(change.payload[key]??"")!==original.plan[key])scopeChanged=true;
  }
  if (scopeChanged) reasons.push("SCOPE_CHANGED");
  let actualMs = null;
  const safeTime = value => Number.isSafeInteger(value) && value >= 0 && value <= nowMs;
  // Receipts prove that no opening/closing interval disappeared from the full lifecycle.
  const expectedIntervals = [];
  let openAt = null, timerHistoryValid = true, finishedAt = null;
  for (const event of JSON.parse(row.timer_commands_json).sort((a, b) => a.rowid - b.rowid)) {
    if (!safeTime(event.at) || (finishedAt !== null && event.type !== "DeletePlan")) { timerHistoryValid = false; break; }
    if (["StartPlan", "ResumePlan"].includes(event.type)) {
      if (openAt !== null) { timerHistoryValid = false; break; }
      openAt = event.at;
    } else {
      if (openAt !== null) { expectedIntervals.push([openAt, event.type === "DeletePlan" ? Math.max(openAt, event.at) : event.at]); openAt = null; }
      else if (!["FinishPlan", "DeletePlan"].includes(event.type)) { timerHistoryValid = false; break; }
      if (event.type === "FinishPlan") finishedAt = event.at;
    }
  }
  const intervalOrder = (a, b) => a[0] - b[0] || a[1] - b[1];
  timerHistoryValid &&= openAt === null && finishedAt === row.finished_at
    && expectedIntervals.length > 0 && expectedIntervals[0][0] === row.first_started_at
    && canonical(expectedIntervals.sort(intervalOrder)) === canonical(intervals.map(i => [i.startMs, i.endMs]).sort(intervalOrder));
  const complete = timerHistoryValid && row.status === "COMPLETED" && safeTime(row.first_started_at) && safeTime(row.finished_at)
    && row.finished_at >= row.first_started_at && intervals.length > 0
    && intervals.every(i => safeTime(i.startMs) && safeTime(i.endMs) && i.startMs >= row.first_started_at && i.endMs >= i.startMs && i.endMs <= row.finished_at);
  if (complete) {
    actualMs = unionIntervals(intervals.map(i => [i.startMs, i.endMs])).reduce((total, [start, end]) => total + end - start, 0);
    if (!Number.isSafeInteger(actualMs)) throw appError("INVALID_ESTIMATION_SOURCE", "ATLM source duration exceeds safe integer.", 500);
  } else reasons.push("INCOMPLETE_MEASUREMENT");
  const sourceAvailableAt = Math.max(row.registered_at, row.finished_at ?? 0, row.source_changed_at,
    ...steps.map(s => s.updatedAt ?? 0));
  if (!safeTime(sourceAvailableAt)) throw appError("INVALID_ESTIMATION_SOURCE", "ATLM source timestamps are invalid.", 500);
  const originalPrediction = row.assessment_json ? JSON.parse(row.assessment_json).serverEstimation : null;
  const issuedPrediction = reasons.length === 0 && originalPrediction?.status === "AVAILABLE"
    && typeof originalPrediction.modelId === "string" && Number.isSafeInteger(originalPrediction.pointMs) && originalPrediction.pointMs >= 0
    ? { modelId: originalPrediction.modelId, pointMs: originalPrediction.pointMs, actualMs, errorMs: originalPrediction.pointMs - actualMs } : null;
  const source = { planId, issuedPrediction, inputAssessmentSequence: row.input_assessment_sequence ?? null,
    eligibility: reasons.length ? "EXCLUDED" : "ELIGIBLE", reasons, features, actualMs,
    capturedAt: row.captured_at ?? null, sourceAvailableAt, observedAt: nowMs, sourceGeneration: row.source_generation };
  // Versions reflect source changes, not repeated observations or the current wall clock.
  source.sourceDigest = "sha256:" + await hashCommandInput({ ...source, observedAt: undefined, sourceGeneration: undefined,
    requirements: row.current_requirements_json, intervals: intervals.sort((a, b) => a.startMs - b.startMs || (a.endMs ?? Infinity) - (b.endMs ?? Infinity)),
    steps: steps.sort((a, b) => a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0),
    checks: checks.sort((a, b) => (a.stepId + a.key) < (b.stepId + b.key) ? -1 : (a.stepId + a.key) > (b.stepId + b.key) ? 1 : 0) });
  return source;
}

export async function claimAtlmJob(db, ownerId, jobKey, nowMs, leaseMs = 60000, { allowExpiredLease = true } = {}) {
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw appError("VALIDATION_ERROR", "Invalid ATLM lease.");
  return dbFirst(db, `UPDATE estimation_jobs SET status='RUNNING',lease_until=?,fence=fence+1,attempts=attempts+CASE WHEN status='QUEUED' AND checkpoint_json IS NOT NULL THEN 0 ELSE 1 END
    WHERE owner_id=? AND job_key=? AND generation>processed_generation AND next_attempt_at<=?
      AND status<>'FAILED' AND (attempts<4 OR (status='QUEUED' AND checkpoint_json IS NOT NULL AND attempts<=4))
      AND (? OR status<>'RUNNING') AND (status<>'RUNNING' OR lease_until<=?) RETURNING *`, nowMs + leaseMs, ownerId, jobKey, nowMs, allowExpiredLease ? 1 : 0, nowMs);
}

export async function persistAtlmSample(db, ownerId, source, nowMs, guard) {
  if (!guard || !Number.isSafeInteger(guard.generation) || !Number.isSafeInteger(guard.fence)) throw appError("VALIDATION_ERROR", "ATLM sample requires a leased job guard.");
  const params = [ownerId, source.planId, source.inputAssessmentSequence, source.sourceDigest, source.sourceGeneration,
    source.eligibility, JSON.stringify(source.reasons), source.features === null ? null : JSON.stringify(source.features),
    source.issuedPrediction == null ? null : JSON.stringify(source.issuedPrediction),
    source.actualMs, source.capturedAt, source.sourceAvailableAt, nowMs, source.eligibility, ownerId, source.planId,
    ownerId, 'refresh:' + source.planId, guard.generation, guard.fence, nowMs, source.sourceGeneration,
    ownerId, source.planId, source.sourceDigest];
  const inserted = await dbFirst(db, `INSERT INTO estimation_samples(owner_id,plan_id,input_assessment_sequence,source_digest,source_generation,
    eligibility,reasons_json,features_json,issued_prediction_json,actual_ms,captured_at,source_available_at,observed_at,is_first_eligible)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ?='ELIGIBLE' AND NOT EXISTS(SELECT 1 FROM estimation_samples WHERE owner_id=? AND plan_id=? AND is_first_eligible=1) THEN 1 ELSE 0 END
    WHERE EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key=? AND generation=? AND fence=? AND lease_until>?
      AND generation=? AND status='RUNNING')
      AND NOT EXISTS(SELECT 1 FROM estimation_samples WHERE sequence=(SELECT MAX(sequence) FROM estimation_samples WHERE owner_id=? AND plan_id=?) AND source_digest=?)
    RETURNING *`, ...params);
  return inserted ? { inserted: true, sample: atlmSampleView(inserted) } : { inserted: false, sample: null };
}

export function atlmSampleView(row) {
  return { sampleId: String(row.sequence), planId: row.plan_id, inputAssessmentSequence: row.input_assessment_sequence,
    sourceDigest: row.source_digest, sourceGeneration: row.source_generation, eligibility: row.eligibility,
    reasons: JSON.parse(row.reasons_json), features: row.features_json ? JSON.parse(row.features_json) : null,
    issuedPrediction: row.issued_prediction_json ? JSON.parse(row.issued_prediction_json) : null,
    actualMs: row.actual_ms, capturedAt: row.captured_at, sourceAvailableAt: row.source_available_at,
    observedAt: row.observed_at, firstEligible: Boolean(row.is_first_eligible) };
}

export async function readAtlmSamples(db, ownerId, { latestOnly = true, afterSequence = 0, limit = 100 } = {}) {
  if (typeof latestOnly !== "boolean" || !Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5001) throw appError("VALIDATION_ERROR", "Invalid ATLM sample page.");
  const rows = await dbAll(db, `SELECT s.* FROM estimation_samples s WHERE s.owner_id=? AND s.sequence>? ${latestOnly ? "AND s.sequence=(SELECT MAX(current.sequence) FROM estimation_samples current WHERE current.owner_id=s.owner_id AND current.plan_id=s.plan_id)" : ""} ORDER BY s.sequence LIMIT ?`, ownerId, afterSequence, limit);
  return rows.map(atlmSampleView);
}

const ATLM_TOOL_SCHEMAS = Object.freeze({
  CalculateAtlmEstimate: { type: "object", additionalProperties: false, required: ["planId", "expectedRequirementsDigest", "agentTask"], properties: {
    planId: { type: "string", format: "uuid" }, expectedRequirementsDigest: { type: "string", minLength: 71, maxLength: 71, pattern: "^sha256:[a-f0-9]{64}$" }, agentTask: AGENT_TASK_SCHEMA,
  } },
  GetPlanEstimate: { type: "object", additionalProperties: false, required: ["planId"], properties: { planId: { type: "string", format: "uuid" } } },
  GetEstimationModelStatus: { type: "object", additionalProperties: false, properties: {} },
  ProcessEstimationTraining: { type: "object", additionalProperties: false, properties: {} },
  StartEstimationTraining: { type: "object", additionalProperties: false, properties: {} },
  GetAtlmDataset: { type: "object", additionalProperties: false, properties: {
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 }, cursor: { type: "string", minLength: 1, maxLength: 1024 },
  } },
});
// This predicate is evaluated inside the receipt INSERT, after asynchronous inference.
// It checks the current owner pointer and manifest, not just the immutable artifact ID.
const ATLM_CURRENT_MODEL_SQL = `SELECT 1 FROM estimation_models m JOIN estimation_owner_state o
  ON o.owner_id=m.owner_id AND o.active_model_id=m.model_id
  WHERE m.owner_id=? AND m.model_id=? AND m.status='ACTIVE' AND m.method_version='agent-v1' AND m.feature_version='agent-task-v1'
    AND NOT EXISTS(SELECT 1 FROM json_each(m.manifest_json) item
      LEFT JOIN estimation_samples s ON s.owner_id=m.owner_id AND s.sequence=CAST(item.value AS INTEGER)
      WHERE s.sequence IS NULL OR s.eligibility<>'ELIGIBLE'
        OR s.sequence<>(SELECT MAX(latest.sequence) FROM estimation_samples latest WHERE latest.owner_id=s.owner_id AND latest.plan_id=s.plan_id)
        OR EXISTS(SELECT 1 FROM estimation_jobs dirty WHERE dirty.owner_id=s.owner_id AND dirty.plan_id=s.plan_id
          AND dirty.kind='REFRESH_SAMPLE' AND dirty.generation>dirty.processed_generation))`;

async function atlmPlanContext(db, ownerId, planId) {
  const row = await dbFirst(db, `SELECT p.first_started_at,p.deleted_at,t.requirements_json FROM plans p
    JOIN assessment_targets t ON t.owner_id=p.owner_id AND t.plan_id=p.plan_id AND t.step_id IS NULL
    WHERE p.owner_id=? AND p.plan_id=?`, ownerId, planId);
  if (!row || row.deleted_at !== null) throw appError("PLAN_NOT_FOUND", messageFor("PLAN_NOT_FOUND"), 404);
  return { ...row, requirementsDigest: "sha256:" + await hashCommandInput(JSON.parse(row.requirements_json)) };
}
async function calculateAtlmEstimate(db, ownerId, args, nowMs) {
  validateAssessmentValue(args, ATLM_TOOL_SCHEMAS.CalculateAtlmEstimate);
  if (!isSnapshotDigest(args.expectedRequirementsDigest)) throw appError("VALIDATION_ERROR", "Invalid requirements digest.");
  const target = await atlmPlanContext(db, ownerId, args.planId);
  if (target.requirementsDigest !== args.expectedRequirementsDigest) throw appError("ASSESSMENT_CONTEXT_CHANGED", messageFor("ASSESSMENT_CONTEXT_CHANGED"), 409);
  const normalized = normalizeAgentTaskV1(args.agentTask);
  let prediction;
  if (target.first_started_at !== null) prediction = { status: "UNAVAILABLE", unavailableReason: "UNSUPPORTED_FORECAST_SCOPE" };
  else if (normalized.missingFields.length) prediction = { status: "UNAVAILABLE", unavailableReason: "INCOMPLETE_FEATURES", missingFields: normalized.missingFields };
  else prediction = await predictWithActiveModel(db, ownerId, normalized.features, nowMs);
  return { formatVersion: 1, metric: "PLAN_ACTIVE", forecastScope: "FULL_FROM_FIRST_START", method: { ...ATLM_METHOD },
    status: prediction.status, pointMs: prediction.pointMs ?? null, modelId: prediction.modelId ?? null, modelVersion: prediction.modelVersion ?? null,
    requirementsDigest: target.requirementsDigest, featureDigest: "sha256:" + await hashCommandInput(normalized.features), calculatedAt: nowMs,
    sampleCount: prediction.sampleCount ?? 0, evaluation: prediction.evaluation ?? null,
    accuracy: prediction.accuracy ?? "NOT_VALIDATED", interval: null, confidence: "UNKNOWN",
    unavailableReason: prediction.unavailableReason ?? null, ...(prediction.missingFields ? { missingFields: prediction.missingFields } : {}) };
}

async function getPlanEstimate(db, ownerId, args, nowMs) {
  validateAssessmentValue(args, ATLM_TOOL_SCHEMAS.GetPlanEstimate);
  const row = await dbFirst(db, `SELECT p.first_started_at,p.deleted_at,t.requirements_json AS current_requirements_json,
      a.assessment_id,a.revision,a.requirements_digest,a.assessment_json
    FROM plans p JOIN assessment_targets t ON t.owner_id=p.owner_id AND t.plan_id=p.plan_id AND t.step_id IS NULL
    LEFT JOIN plan_estimation_inputs i ON i.owner_id=p.owner_id AND i.plan_id=p.plan_id
    LEFT JOIN assessment_revisions a ON a.owner_id=p.owner_id AND a.plan_id=p.plan_id AND a.sequence=CASE
      WHEN p.first_started_at IS NOT NULL THEN i.assessment_sequence
      ELSE (SELECT MAX(latest.sequence) FROM assessment_revisions latest WHERE latest.owner_id=p.owner_id AND latest.plan_id=p.plan_id
        AND latest.step_id IS NULL AND json_type(latest.assessment_json,'$.serverEstimation')='object') END
    WHERE p.owner_id=? AND p.plan_id=?`, ownerId, args.planId);
  if (!row) throw appError("PLAN_NOT_FOUND", messageFor("PLAN_NOT_FOUND"), 404);
  const serverEstimation = row.assessment_json ? JSON.parse(row.assessment_json).serverEstimation ?? null : null;
  const staleReasons = [];
  if (serverEstimation) {
    if (row.deleted_at !== null) staleReasons.push("PLAN_DELETED");
    const digest = "sha256:" + await hashCommandInput(JSON.parse(row.current_requirements_json));
    if (digest !== row.requirements_digest) staleReasons.push("SCOPE_CHANGED");
    else if (row.first_started_at !== null && (await readAtlmSampleSource(db, ownerId, args.planId, nowMs)).reasons.includes("SCOPE_CHANGED")) staleReasons.push("SCOPE_CHANGED");
    if (serverEstimation.modelId) {
      const model = await dbFirst(db, `SELECT m.status,
        EXISTS(SELECT 1 FROM json_each(m.manifest_json) item LEFT JOIN estimation_samples s
          ON s.owner_id=m.owner_id AND s.sequence=CAST(item.value AS INTEGER)
          LEFT JOIN estimation_jobs j ON j.owner_id=s.owner_id AND j.job_key='refresh:'||s.plan_id
          WHERE s.sequence IS NULL OR j.generation<>s.source_generation
            OR s.sequence<>(SELECT MAX(latest.sequence) FROM estimation_samples latest WHERE latest.owner_id=s.owner_id AND latest.plan_id=s.plan_id)) AS source_changed
        FROM estimation_models m WHERE m.owner_id=? AND m.model_id=?`, ownerId, serverEstimation.modelId);
      if (!model || model.status === "INVALIDATED" || model.source_changed) staleReasons.push("MODEL_INVALIDATED");
    }
  }
  return { formatVersion: 1, planId: args.planId, assessmentId: row.assessment_id ?? null, assessmentRevision: row.revision ?? null,
    source: row.first_started_at !== null ? "FROZEN_INPUT" : row.assessment_id ? "LATEST_ASSESSMENT" : "NONE",
    serverEstimation, isStale: staleReasons.length > 0, staleReasons, serverNow: nowMs };
}

async function getAtlmDataset(db, ownerId, args, nowMs) {
  validateAssessmentValue(args, ATLM_TOOL_SCHEMAS.GetAtlmDataset);
  const limit = args.limit ?? 50, ownerScope = await hashCommandInput({ purpose: "atlm-dataset-cursor-v1", ownerId });
  let cursor = null;
  if (args.cursor !== undefined) {
    try { cursor = JSON.parse(args.cursor); } catch { throw appError("VALIDATION_ERROR", "Invalid dataset cursor."); }
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) || Object.keys(cursor).length !== 6
      || cursor.version !== 1 || cursor.ownerScope !== ownerScope
      || !["datasetRevision", "asOf", "afterSequence", "throughSequence"].every(key => Number.isSafeInteger(cursor[key]) && cursor[key] >= 0)
      || cursor.asOf > nowMs || cursor.afterSequence > cursor.throughSequence) throw appError("VALIDATION_ERROR", "Invalid dataset cursor.");
  }
  const asOf = cursor?.asOf ?? nowMs;
  // Revision, high-water mark and page share one SQLite read snapshot.
  const snapshot = await dbFirst(db, `WITH snapshot AS (
      SELECT COALESCE((SELECT dataset_revision FROM estimation_owner_state WHERE owner_id=?),0) AS revision,
        COALESCE((SELECT MAX(sequence) FROM estimation_samples WHERE owner_id=? AND observed_at<=?),0) AS through_sequence
    ), page AS (
      SELECT s.* FROM estimation_samples s WHERE s.owner_id=? AND s.sequence>? AND s.observed_at<=?
        AND s.sequence<=COALESCE(?,(SELECT through_sequence FROM snapshot)) ORDER BY s.sequence LIMIT ?
    ) SELECT revision,through_sequence,
      (SELECT json_group_array(json_object('sequence',sequence,'plan_id',plan_id,'input_assessment_sequence',input_assessment_sequence,
        'source_digest',source_digest,'source_generation',source_generation,'eligibility',eligibility,'reasons_json',reasons_json,
        'features_json',features_json,'issued_prediction_json',issued_prediction_json,'actual_ms',actual_ms,'captured_at',captured_at,
        'source_available_at',source_available_at,'observed_at',observed_at,'is_first_eligible',is_first_eligible)) FROM page) AS rows_json
    FROM snapshot`, ownerId, ownerId, asOf, ownerId, cursor?.afterSequence ?? 0, asOf, cursor?.throughSequence ?? null, limit + 1);
  if (cursor && cursor.datasetRevision !== snapshot.revision) throw appError("DATASET_CHANGED", messageFor("DATASET_CHANGED"), 409);
  const rows = JSON.parse(snapshot.rows_json).map(atlmSampleView), hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const nextCursor = hasMore ? JSON.stringify({ version: 1, ownerScope, datasetRevision: snapshot.revision, asOf,
    afterSequence: Number(rows.at(-1).sampleId), throughSequence: cursor?.throughSequence ?? snapshot.through_sequence }) : null;
  return { formatVersion: 1, datasetRevision: snapshot.revision, asOf, rows, hasMore, nextCursor, serverNow: nowMs };
}
async function executeAtlmTool(db, ownerId, name, args, nowMs, clock) {
  validateAssessmentValue(args, ATLM_TOOL_SCHEMAS[name]);
  if (name === "CalculateAtlmEstimate") return calculateAtlmEstimate(db, ownerId, args, nowMs);
  if (name === "GetPlanEstimate") return getPlanEstimate(db, ownerId, args, nowMs);
  if (name === "GetAtlmDataset") return getAtlmDataset(db, ownerId, args, nowMs);
  if (name === "GetEstimationModelStatus") return getEstimationModelStatus(db, ownerId, nowMs);
  if (name === "StartEstimationTraining") {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO estimation_owner_state(owner_id) SELECT owner_id FROM owners WHERE owner_id=?").bind(ownerId),
      db.prepare("UPDATE estimation_owner_state SET forced_retrain=1, updated_at=? WHERE owner_id=?").bind(nowMs, ownerId),
    ]);
  }
  return processEstimationTraining(db, ownerId, nowMs, { clock });
}

const FORECAST_METRICS = ["PLAN_ACTIVE", "CALENDAR", "PAUSED"];
const assessmentPayloadSchema = {
  type: "object", additionalProperties: false,
  required: ["assessmentId", "planId", "expectedRequirementsDigest", "context", "method", "complexity", "unknowns", "assumptions", "dependencies", "forecast", "sources", "approach", "phase"],
  properties: {
    assessmentId: { type: "string", format: "uuid" }, planId: { type: "string", format: "uuid" }, stepId: { type: "string", format: "uuid" },
    expectedRequirementsDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$", description: "Digest of the requirements read by the agent before assessing; never refresh it just to retry a write" },
    context: { type: "object", properties: { agentTask: AGENT_TASK_SCHEMA }, description: "Bounded JSON: expected result, scope and checks" },
    predictionRequest: { type: "object", additionalProperties: false, required: ["method", "methodVersion"], properties: { method: { enum: ["ATLM"] }, methodVersion: { enum: [1] } } },
    method: { type: "object", additionalProperties: false, required: ["id", "version", "scale"], properties: {
      id: { type: "string", minLength: 1, maxLength: 128 }, version: { type: "string", minLength: 1, maxLength: 128 }, scale: { description: "Agent-declared scale, bounded JSON" },
    } },
    complexity: { type: "object", additionalProperties: false, required: ["status", "value", "rationale"], properties: {
      status: { enum: ["KNOWN", "UNKNOWN"] }, value: { description: "Bounded JSON; null when UNKNOWN" }, rationale: { type: "string", minLength: 1, maxLength: 4000 },
    } },
    ...Object.fromEntries(["unknowns", "assumptions", "dependencies"].map(key => [key, { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1000 } }])),
    forecast: { type: "object", additionalProperties: false, required: ["status", "metric", "lowerMs", "upperMs", "confidence", "basis", "sampleCount"], properties: {
      status: { enum: ["KNOWN", "UNKNOWN"] }, metric: { enum: FORECAST_METRICS },
      lowerMs: { type: ["integer", "null"], minimum: 0 }, upperMs: { type: ["integer", "null"], minimum: 0 },
      confidence: { enum: ["HIGH", "MEDIUM", "LOW", "UNKNOWN"] }, basis: { type: "string", minLength: 1, maxLength: 4000 }, sampleCount: { type: "integer", minimum: 0 },
    } },
    sources: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["planId"], properties: { planId: { type: "string", format: "uuid" }, stepId: { type: "string", format: "uuid" } } } },
    approach: { type: "object", additionalProperties: false, required: ["description", "rationale"], properties: {
      description: { type: "string", minLength: 1, maxLength: 4000 }, rationale: { type: "string", minLength: 1, maxLength: 4000 },
    } },
    phase: { type: "string", minLength: 1, maxLength: 100 }, reason: { type: "string", minLength: 1, maxLength: 1000 },
  },
};
// Used by these new tools at runtime as well as discovery; free JSON remains neutral.
function validateAssessmentValue(value, schema, path = "input", depth = 0) {
  if (depth > 10) throw appError("VALIDATION_ERROR", "JSON depth exceeds 10.");
  if (schema.enum && !schema.enum.includes(value)) throw appError("VALIDATION_ERROR", path + ": invalid enum.");
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types = schema.type ? [].concat(schema.type) : null;
  if (types && !types.includes(type) && !(type === "number" && types.includes("integer") && Number.isSafeInteger(value))) throw appError("VALIDATION_ERROR", path + ": invalid type.");
  if (typeof value === "number" && (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) throw appError("VALIDATION_ERROR", path + ": invalid number.");
  if (typeof value === "string") {
    if (Array.from(value).length > (schema.maxLength ?? 4000) || Array.from(value.trim()).length < (schema.minLength ?? 0)
      || (schema.format === "uuid" && !UUID.test(value))) throw appError("VALIDATION_ERROR", path + ": invalid string.");
    assertSafeMetadataText(value, path);
  }
  if (Array.isArray(value)) {
    if (value.length > (schema.maxItems ?? 100) || value.length < (schema.minItems ?? 0)) throw appError("VALIDATION_ERROR", path + ": invalid array.");
    value.forEach(item => validateAssessmentValue(item, schema.items || {}, path, depth + 1));
  } else if (value && typeof value === "object") {
    if (Object.keys(value).length > 100) throw appError("VALIDATION_ERROR", path + ": too many keys.");
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw appError("VALIDATION_ERROR", path + ": missing " + key);
    if (schema.additionalProperties === false) assertExactKeys(value, new Set(Object.keys(schema.properties || {})), path);
    for (const [key, item] of Object.entries(value)) {
      if (key.length > 128) throw appError("VALIDATION_ERROR", path + ": key too long.");
      validateAssessmentValue(item, schema.properties?.[key] || {}, path + "." + key, depth + 1);
    }
  }
}
function validateAssessmentCommand(envelope) {
  assertExactKeys(envelope, new Set(["schemaVersion", "commandId", "commandType", "expectedVersion", "payloadHash", "payload"]), "RecordAssessment");
  if (envelope.schemaVersion !== 1 || !UUID.test(envelope.commandId || "") || !Number.isSafeInteger(envelope.expectedVersion) || envelope.expectedVersion < 0) throw appError("VALIDATION_ERROR", "Invalid assessment envelope.");
  if (envelope.payloadHash !== undefined && !/^[a-f0-9]{64}$/i.test(envelope.payloadHash)) throw appError("VALIDATION_ERROR", "Invalid payloadHash.");
  validateAssessmentValue(envelope.payload, assessmentPayloadSchema);
  if (new TextEncoder().encode(JSON.stringify(envelope.payload)).length > 24000) throw appError("VALIDATION_ERROR", "Assessment exceeds 24000 UTF-8 bytes.");
  const p = envelope.payload, f = p.forecast, c = p.complexity;
  if (Object.hasOwn(p.context, "agentTask")) normalizeAgentTaskV1(p.context.agentTask);
  if (p.predictionRequest && (p.stepId !== undefined || !Object.hasOwn(p.context, "agentTask"))) throw appError("VALIDATION_ERROR", "predictionRequest requires plan-level agentTask v1.");
  if (!isSnapshotDigest(p.expectedRequirementsDigest)) throw appError("VALIDATION_ERROR", "expectedRequirementsDigest must identify the requirements assessed by the agent.");
  if (p.method.scale === null || p.method.scale === "") throw appError("VALIDATION_ERROR", "Declare the assessment scale.");
  if ((c.status === "UNKNOWN") !== (c.value === null)) throw appError("VALIDATION_ERROR", "Unknown complexity requires null; known complexity requires a value.");
  if (f.status === "UNKNOWN" ? f.lowerMs !== null || f.upperMs !== null : !Number.isSafeInteger(f.lowerMs) || !Number.isSafeInteger(f.upperMs) || f.lowerMs < 0 || f.upperMs < f.lowerMs) throw appError("VALIDATION_ERROR", "Invalid duration range in milliseconds.");
  if (envelope.expectedVersion > 0 && !p.reason?.trim()) throw appError("VALIDATION_ERROR", "Revision reason required.");
}
async function assessmentTarget(db, ownerId, planId, stepId) {
  return dbFirst(db, "SELECT * FROM assessment_targets WHERE owner_id=? AND plan_id=? AND step_id IS ?", ownerId, planId, stepId ?? null);
}
async function assessmentView(db, ownerId, row) {
  const target = await assessmentTarget(db, ownerId, row.plan_id, row.step_id);
  const digest = target ? "sha256:" + await hashCommandInput(JSON.parse(target.requirements_json)) : null;
  return { sequence: row.sequence, assessmentId: row.assessment_id, revision: row.revision, previousRevision: row.previous_revision,
    planId: row.plan_id, stepId: row.step_id, authorId: row.author_id, recordedAt: row.recorded_at,
    requirementsDigest: row.requirements_digest, currentRequirementsDigest: digest, needsRevision: digest !== row.requirements_digest,
    requirements: JSON.parse(row.requirements_json), assessment: { formatVersion: 1, ...JSON.parse(row.assessment_json) } };
}
const getAssessmentSchema = { type: "object", additionalProperties: false, required: ["planId"], properties: {
  planId: { type: "string", format: "uuid" }, stepId: { type: "string", format: "uuid", description: "Context-only read; omit assessmentId and revision" },
  assessmentId: { type: "string", format: "uuid" }, revision: { type: "integer", minimum: 1 },
} };
const estimateWorkProfileSchema = { type: "object", additionalProperties: false, required: ESTIMATE_PROFILE_FIELDS, properties: {
  workKind: { enum: [...ESTIMATE_WORK_KINDS] },
  reuseState: { enum: [...ESTIMATE_REUSE_STATES] },
  doneBoundary: { enum: [...ESTIMATE_DONE_BOUNDARIES] },
} };
const estimateCandidateInputSchema = { type: "object", additionalProperties: false,
  required: ["planId", "expectedRequirementsDigest", "profile", "decision", "scopeStability", "timeCoverage", "rationale"],
  properties: {
    planId: { type: "string", format: "uuid" },
    expectedRequirementsDigest: { type: "string", minLength: 71, maxLength: 71, pattern: "^sha256:[a-f0-9]{64}$" },
    profile: estimateWorkProfileSchema,
    decision: { enum: [...ESTIMATE_DECISIONS] },
    scopeStability: { enum: ["STABLE", "CHANGED", "UNKNOWN"] },
    timeCoverage: { enum: ["COMPLETE", "PARTIAL", "UNKNOWN"] },
    rationale: { type: "string", minLength: 1, maxLength: 128 },
  },
};
const estimateCalculatorSchema = { type: "object", additionalProperties: false,
  required: ["methodVersion", "metric", "referenceCutoffMs", "target", "candidates"],
  properties: {
    methodVersion: { enum: [1] }, metric: { enum: ["PLAN_ACTIVE"] },
    referenceCutoffMs: { type: "integer", minimum: 0 },
    target: { type: "object", additionalProperties: false, required: ["planId", "expectedRequirementsDigest", "profile"], properties: {
      planId: { type: "string", format: "uuid" },
      expectedRequirementsDigest: { type: "string", minLength: 71, maxLength: 71, pattern: "^sha256:[a-f0-9]{64}$" },
      profile: estimateWorkProfileSchema,
    } },
    candidates: { type: "array", maxItems: 20, items: estimateCandidateInputSchema },
  },
};
async function readAssessment(db, ownerId, args, nowMs) {
  validateAssessmentValue(args, getAssessmentSchema);
  if (args.assessmentId === undefined) {
    if (args.revision !== undefined) throw appError("VALIDATION_ERROR", "revision requires assessmentId.");
    const plan = await dbFirst(db, "SELECT plan_id FROM plans WHERE owner_id=? AND plan_id=?", ownerId, args.planId);
    if (!plan) throw appError("PLAN_NOT_FOUND", messageFor("PLAN_NOT_FOUND"), 404);
    const target = await assessmentTarget(db, ownerId, args.planId, args.stepId);
    if (!target) throw appError("STEP_NOT_FOUND", messageFor("STEP_NOT_FOUND"), 404);
    const requirements = JSON.parse(target.requirements_json);
    return { contextOnly: true, planId: args.planId, stepId: args.stepId ?? null, requirements,
      currentRequirementsDigest: "sha256:" + await hashCommandInput(requirements), serverNow: nowMs };
  }
  if (args.stepId !== undefined) throw appError("VALIDATION_ERROR", "stepId is only used for a context-only read.");
  const rows = await dbAll(db, "SELECT * FROM assessment_revisions WHERE owner_id=? AND plan_id=? AND assessment_id=? ORDER BY revision DESC LIMIT 1", ownerId, args.planId, args.assessmentId);
  if (!rows.length) throw appError("ASSESSMENT_NOT_FOUND", "Assessment not found.", 404);
  const row = args.revision === undefined ? rows[0] : await dbFirst(db, "SELECT * FROM assessment_revisions WHERE owner_id=? AND plan_id=? AND assessment_id=? AND revision=?", ownerId, args.planId, args.assessmentId, args.revision);
  if (!row) throw appError("ASSESSMENT_NOT_FOUND", "Assessment revision not found.", 404);
  return { ...await assessmentView(db, ownerId, row), revisionCount: rows[0].revision, serverNow: nowMs };
}

function estimateTimestamp(value, label, nowMs, nullable = false) {
  if (nullable && value === null) return null;
  if (!isNonnegativeSafeInteger(value) || value > nowMs) invalidEstimateSource(`${label} должен быть безопасным timestamp не позднее серверного времени.`);
  return value;
}

function estimateSourceSnapshotSql(requestCount) {
  const requestedValues = Array.from({ length: requestCount }, (_, index) => index === 0 ? "(?,1)" : "(?,0)").join(",");
  return `WITH owner_scope(owner_id) AS (VALUES (?)),
    requested(plan_id,is_target) AS (VALUES ${requestedValues})
    SELECT r.plan_id AS requested_plan_id,r.is_target,
      (SELECT COUNT(*) FROM plans matching WHERE matching.owner_id=(SELECT owner_id FROM owner_scope)
        AND lower(matching.plan_id)=r.plan_id) AS matching_plan_count,
      p.plan_id,p.owner_id,
      CASE WHEN p.deleted_at IS NULL THEN p.status ELSE NULL END AS status,p.deleted_at,
      CASE WHEN p.deleted_at IS NULL THEN p.first_started_at ELSE NULL END AS first_started_at,
      CASE WHEN p.deleted_at IS NULL THEN p.finished_at ELSE NULL END AS finished_at,
      CASE WHEN p.deleted_at IS NULL THEN p.registered_at ELSE NULL END AS registered_at,
      CASE WHEN p.deleted_at IS NULL THEN target.requirements_json ELSE NULL END AS requirements_json,
      CASE WHEN p.deleted_at IS NULL AND EXISTS(SELECT 1 FROM plan_steps config WHERE config.owner_id=p.owner_id AND config.plan_id=p.plan_id) THEN 1 ELSE 0 END AS tracker_enabled,
      CASE WHEN p.deleted_at IS NULL THEN (SELECT COUNT(*) FROM plan_steps step
        WHERE step.owner_id=p.owner_id AND step.plan_id=p.plan_id) ELSE 0 END AS step_count,
      CASE WHEN p.deleted_at IS NULL THEN (SELECT COUNT(*) FROM tracker_incomplete_steps incomplete
        WHERE incomplete.owner_id=p.owner_id AND incomplete.plan_id=p.plan_id) ELSE 0 END AS incomplete_step_count,
      CASE WHEN p.deleted_at IS NULL THEN MAX(
        p.registered_at,COALESCE(p.finished_at,p.registered_at),
        COALESCE((SELECT MAX(r.server_now_ms) FROM command_receipts r WHERE r.owner_id=p.owner_id AND r.plan_id=p.plan_id AND r.outcome_code='OK' AND r.command_type IN ('StartPlan','ResumePlan','PausePlan','FinishPlan','UpdatePlanMetadata','DeletePlan','RestorePlan')),p.registered_at),
        COALESCE((SELECT MAX(step.created_at) FROM plan_steps step WHERE step.owner_id=p.owner_id AND step.plan_id=p.plan_id),p.registered_at),
        COALESCE((SELECT MAX(step.updated_at) FROM plan_steps step WHERE step.owner_id=p.owner_id AND step.plan_id=p.plan_id),p.registered_at),
        COALESCE((SELECT source_changed_at FROM estimation_jobs j WHERE j.owner_id=p.owner_id AND j.job_key='refresh:'||p.plan_id),p.registered_at)
      ) ELSE NULL END AS source_available_at,
      intervals.interval_id,intervals.start_ms,intervals.end_ms
    FROM requested r
    LEFT JOIN plans p ON p.owner_id=(SELECT owner_id FROM owner_scope) AND lower(p.plan_id)=r.plan_id
    LEFT JOIN assessment_targets target ON target.owner_id=p.owner_id AND target.plan_id=p.plan_id AND target.step_id IS NULL AND p.deleted_at IS NULL
    LEFT JOIN work_intervals intervals ON intervals.owner_id=p.owner_id AND intervals.plan_id=p.plan_id AND p.deleted_at IS NULL
    ORDER BY r.is_target DESC,r.plan_id,intervals.start_ms,intervals.end_ms`;
}

async function readCalculatedEstimate(db, ownerId, args, nowMs) {
  validateAssessmentValue(args, estimateCalculatorSchema);
  if (!Number.isSafeInteger(args.methodVersion) || args.methodVersion !== 1 || args.metric !== "PLAN_ACTIVE") {
    estimateValidation("Неподдерживаемые methodVersion или metric.");
  }
  if (!isSnapshotDigest(args.target.expectedRequirementsDigest)
    || args.candidates.some(candidate => !isSnapshotDigest(candidate.expectedRequirementsDigest))) {
    estimateValidation("expectedRequirementsDigest должен иметь формат sha256:64 lowercase hex.");
  }
  if (args.candidates.some(candidate => Array.from(candidate.rationale).length > 128)) {
    estimateValidation("rationale не должен превышать 128 символов.");
  }
  if (args.referenceCutoffMs > nowMs) estimateValidation("referenceCutoffMs не может быть позже серверного времени.");

  const targetId = args.target.planId.toLowerCase();
  const candidates = args.candidates.map(candidate => ({ ...candidate, planId: candidate.planId.toLowerCase() }));
  if (candidates.some(candidate => candidate.planId === targetId)) estimateValidation("target нельзя включать в candidates.");
  if (new Set(candidates.map(candidate => candidate.planId)).size !== candidates.length) estimateValidation("planId кандидата повторяется.");
  candidates.sort((left, right) => left.planId < right.planId ? -1 : left.planId > right.planId ? 1 : 0);

  const requested = [{ planId: targetId, isTarget: true }, ...candidates.map(candidate => ({ planId: candidate.planId, isTarget: false }))];
  const queryResult = await db.prepare(estimateSourceSnapshotSql(requested.length))
    .bind(ownerId, ...requested.map(item => item.planId)).all();
  const sources = new Map();
  for (const row of queryResult.results || []) {
    if (!sources.has(row.requested_plan_id)) {
      sources.set(row.requested_plan_id, {
        matchingPlanCount: row.matching_plan_count, planId: row.plan_id, ownerId: row.owner_id,
        status: row.status, deletedAt: row.deleted_at, firstStartedAtMs: row.first_started_at,
        finishedAtMs: row.finished_at, registeredAtMs: row.registered_at, requirementsJson: row.requirements_json,
        trackerEnabled: row.tracker_enabled, stepCount: row.step_count, incompleteStepCount: row.incomplete_step_count,
        sourceAvailableAtMs: row.source_available_at, intervals: [],
      });
    }
    const source = sources.get(row.requested_plan_id);
    if (!Number.isSafeInteger(source.matchingPlanCount) || source.matchingPlanCount > 1) {
      invalidEstimateSource("Владелец содержит неоднозначные UUID плана без учёта регистра.");
    }
    if (row.interval_id !== null) source.intervals.push({ startMs: row.start_ms, endMs: row.end_ms });
  }

  for (const item of requested) {
    const source = sources.get(item.planId);
    if (!source || source.matchingPlanCount !== 1 || source.planId === null || source.ownerId !== ownerId) {
      throw appError("PLAN_NOT_FOUND", messageFor("PLAN_NOT_FOUND"), 404);
    }
    source.deletedAt = estimateTimestamp(source.deletedAt, "deleted_at", nowMs, true);
    if (item.isTarget && source.deletedAt !== null) throw appError("PLAN_DELETED", messageFor("PLAN_DELETED"), 409);
    if (source.deletedAt === null) {
      source.registeredAtMs = estimateTimestamp(source.registeredAtMs, "registered_at", nowMs);
      source.firstStartedAtMs = estimateTimestamp(source.firstStartedAtMs, "first_started_at", nowMs, true);
      source.finishedAtMs = estimateTimestamp(source.finishedAtMs, "finished_at", nowMs, true);
      source.sourceAvailableAtMs = estimateTimestamp(source.sourceAvailableAtMs, "sourceAvailableAtMs", nowMs);
      if (source.sourceAvailableAtMs < source.registeredAtMs) invalidEstimateSource("sourceAvailableAtMs предшествует registered_at.");
      if (source.finishedAtMs !== null && source.sourceAvailableAtMs < source.finishedAtMs) invalidEstimateSource("sourceAvailableAtMs предшествует finished_at.");
      if (source.firstStartedAtMs !== null && source.sourceAvailableAtMs < source.firstStartedAtMs) invalidEstimateSource("sourceAvailableAtMs предшествует first_started_at.");
      if (source.finishedAtMs !== null && source.firstStartedAtMs !== null && source.finishedAtMs < source.firstStartedAtMs) {
        invalidEstimateSource("finished_at предшествует first_started_at.");
      }
      if (!isNonnegativeSafeInteger(source.stepCount) || !isNonnegativeSafeInteger(source.incompleteStepCount)
        || source.incompleteStepCount > source.stepCount) invalidEstimateSource("Счётчики подтверждения результата повреждены.");
    }
  }

  const targetSource = sources.get(targetId);
  if (typeof targetSource.requirementsJson !== "string") invalidEstimateSource("Не найден snapshot requirements целевого плана.");
  const targetDigest = "sha256:" + await hashCommandInput(JSON.parse(targetSource.requirementsJson));
  if (targetDigest !== args.target.expectedRequirementsDigest) {
    throw appError("ASSESSMENT_CONTEXT_CHANGED", messageFor("ASSESSMENT_CONTEXT_CHANGED"), 409);
  }

  const inputCandidates = [];
  for (const input of candidates) {
    const source = sources.get(input.planId);
    if (source.deletedAt !== null) {
      inputCandidates.push({ planId: input.planId, deleted: true });
      continue;
    }
    if (typeof source.requirementsJson !== "string") invalidEstimateSource("Не найден snapshot requirements исходного плана.");
    const requirementsDigest = "sha256:" + await hashCommandInput(JSON.parse(source.requirementsJson));
    if (requirementsDigest !== input.expectedRequirementsDigest) {
      throw appError("ASSESSMENT_CONTEXT_CHANGED", messageFor("ASSESSMENT_CONTEXT_CHANGED"), 409);
    }

    const firstStartedAtMs = source.firstStartedAtMs;
    const finishedAtMs = source.finishedAtMs;
    const sourceAvailableAtMs = source.sourceAvailableAtMs;

    const intervalPairs = source.intervals.map(interval => {
      const startMs = estimateTimestamp(interval.startMs, "work_intervals.start_ms", nowMs);
      const endMs = estimateTimestamp(interval.endMs, "work_intervals.end_ms", nowMs, true);
      if (endMs !== null && endMs < startMs) invalidEstimateSource("work_intervals.end_ms предшествует start_ms.");
      if (firstStartedAtMs === null || startMs < firstStartedAtMs) invalidEstimateSource("Интервал предшествует первому запуску плана.");
      if (finishedAtMs !== null && endMs !== null && endMs > finishedAtMs) invalidEstimateSource("Интервал позже завершения плана.");
      if (source.status === "COMPLETED" && endMs === null) invalidEstimateSource("Завершённый план содержит открытый work interval.");
      return [startMs, endMs];
    }).sort((left, right) => {
      if (left[0] !== right[0]) return left[0] - right[0];
      if (left[1] === null || right[1] === null) return left[1] === right[1] ? 0 : left[1] === null ? 1 : -1;
      return left[1] - right[1];
    });
    const intervalsDigest = intervalPairs.length === 0 ? null : "sha256:" + await hashCommandInput(intervalPairs);
    let measurement = "MISSING";
    let activeMs = null;
    if (firstStartedAtMs !== null && intervalPairs.length > 0) {
      if (source.status === "COMPLETED" && finishedAtMs !== null && intervalPairs.every(pair => pair[1] !== null)) {
        measurement = "COMPLETE";
        const merged = unionIntervals(intervalPairs.map(([startMs, endMs]) => [startMs, endMs]));
        activeMs = 0;
        for (const [startMs, endMs] of merged) {
          const duration = endMs - startMs;
          if (!isNonnegativeSafeInteger(duration) || !Number.isSafeInteger(activeMs + duration)) {
            invalidEstimateSource("Объединённое время превышает safe integer.");
          }
          activeMs += duration;
        }
      } else {
        measurement = "INCOMPLETE";
      }
    }
    inputCandidates.push({
      planId: input.planId, requirementsDigest, profile: input.profile, decision: input.decision,
      scopeStability: input.scopeStability, timeCoverage: input.timeCoverage, rationale: input.rationale,
      deleted: false, planStatus: source.status, firstStartedAtMs, finishedAtMs, sourceAvailableAtMs,
      checksConfirmed: Boolean(source.trackerEnabled) && source.stepCount > 0 && source.incompleteStepCount === 0,
      measurement, activeMs, intervalCount: intervalPairs.length, intervalsDigest,
    });
  }

  const inputSnapshot = {
    methodVersion: args.methodVersion, metric: args.metric, referenceCutoffMs: args.referenceCutoffMs,
    sourceAuthority: "SERVER_PLAN_INTERVALS",
    target: { planId: targetId, expectedRequirementsDigest: targetDigest, profile: args.target.profile },
    candidates: inputCandidates,
  };
  const calculation = calculateComparableEstimate(inputSnapshot);
  const calculationDigest = "sha256:" + await hashCommandInput({ inputSnapshot, calculation });
  return { ...calculation, inputSnapshot, calculationDigest, readAtMs: nowMs };
}

const estimationHistorySchema = { type: "object", additionalProperties: false, required: ["targets", "from", "to", "timeZone"], properties: {
  targets: { type: "array", minItems: 1, maxItems: 20, items: assessmentPayloadSchema.properties.sources.items },
  from: { type: "string", format: "date" }, to: { type: "string", format: "date" }, timeZone: { type: "string" },
  asOf: { type: "integer", minimum: 0 }, afterSequence: { type: "integer", minimum: 0 }, throughSequence: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 },
} };
function durationStatistics(values) {
  const measured = values.filter(value => value !== null);
  return { sampleCount: measured.length, unknownCount: values.length - measured.length,
    minMs: measured.length ? Math.min(...measured) : null, medianMs: median(measured),
    maxMs: measured.length ? Math.max(...measured) : null, status: measured.length ? "AVAILABLE" : "INSUFFICIENT_DATA" };
}
async function readEstimationHistory(db,ownerId,args,nowMs){
 validateAssessmentValue(args,estimationHistorySchema);
 const timeZone=checkTimeZone(args.timeZone),range=inclusiveDateRange(args.from,args.to,timeZone),asOf=args.asOf??nowMs,limit=args.limit??50;
 if(asOf>nowMs)throw appError("VALIDATION_ERROR","asOf exceeds server time.");
 const keys=args.targets.map(t=>t.planId+":"+(t.stepId||""));if(new Set(keys).size!==keys.length)throw appError("VALIDATION_ERROR","Duplicate targets.");
 const throughSequence=args.throughSequence??(await dbFirst(db,"SELECT COALESCE(MAX(sequence),0) AS seq FROM assessment_revisions WHERE owner_id=?",ownerId)).seq;
 const facts=[],allIntervals=[],cache=new Map(),elapsed=windows=>unionIntervals(windows.filter(([a,b])=>b>a)).reduce((n,[a,b])=>n+b-a,0),clip=(a,b)=>[Math.max(a,range.startMs),Math.min(b,range.endMs,asOf)];
 for(const target of args.targets){let info=cache.get(target.planId);if(!info){const plan=await dbFirst(db,"SELECT * FROM plans WHERE owner_id=? AND plan_id=? AND deleted_at IS NULL",ownerId,target.planId);if(!plan)throw appError("PLAN_NOT_FOUND",messageFor("PLAN_NOT_FOUND"),404);const intervals=await dbAll(db,"SELECT interval_id,start_ms,end_ms FROM work_intervals WHERE owner_id=? AND plan_id=? AND start_ms<=? ORDER BY start_ms",ownerId,target.planId,asOf);info={plan,intervals,windows:intervals.map(i=>clip(i.start_ms,i.end_ms??asOf)),snapshot:await readPlanExecutionSnapshot(db,ownerId,target.planId,nowMs)};cache.set(target.planId,info);allIntervals.push(...info.windows);}
  const {plan,intervals,windows,snapshot}=info,step=target.stepId?snapshot.steps.find(s=>s.step_id===target.stepId):null;if(target.stepId&&!step)throw appError("STEP_NOT_FOUND",messageFor("STEP_NOT_FOUND"),404);
  const measured=plan.first_started_at!=null&&plan.first_started_at<=asOf,active=measured&&intervals.length>0,planActiveMs=active?elapsed(windows):null,calendarMs=measured?elapsed([clip(plan.first_started_at,plan.finished_at??asOf)]):null;
  facts.push({...target,source:"server work_intervals",units:"ms",planStatus:plan.status,planActiveMs,calendarMs,pausedMs:active?Math.max(0,calendarMs-planActiveMs):null,intervals,currentReadiness:step?step.readyToFinish:snapshot.plan.completion.readyToFinish,limitations:["readiness is current, not historical asOf","time is measured for the parent plan"]});
 }
 const selection=args.targets.map(()=>"(plan_id=? AND step_id IS ?)").join(" OR "),history=await dbAll(db,`SELECT * FROM assessment_revisions WHERE owner_id=? AND (${selection}) AND sequence>? AND sequence<=? AND recorded_at<=? ORDER BY sequence LIMIT ?`,ownerId,...args.targets.flatMap(t=>[t.planId,t.stepId??null]),args.afterSequence??0,throughSequence,asOf,limit+1);
 const selected=facts.filter(f=>!f.stepId),statistics=[["PLAN_ACTIVE","planActiveMs"],["CALENDAR","calendarMs"],["PAUSED","pausedMs"]].map(([metric,field])=>({scope:"plan",metric,units:"ms",...durationStatistics(selected.map(f=>f[field]))}));
 return {asOf,throughSequence,serverNow:nowMs,period:{from:args.from,to:args.to,timeZone,...range},targets:args.targets,facts,statistics,totalActiveMs:[...cache.values()].some(p=>p.plan.first_started_at!=null&&p.plan.first_started_at<=asOf&&p.intervals.length)?elapsed(allIntervals):null,totalActiveMeasurement:"union of selected parent plan intervals",assessments:await Promise.all(history.slice(0,limit).map(row=>assessmentView(db,ownerId,row))),nextAfterSequence:history.length>limit?history[limit-1].sequence:null,assessmentStatistics:"not aggregated across methods, scales or metrics",selectionResponsibility:"agent"};
}

export function parsePlanDocument(text) {
  if (typeof text !== "string" || !text.trim() || text.length > 60000) throw appError("VALIDATION_ERROR", "Вставьте полный текст плана (до 60 000 символов).");
  const headings = [];
  let fence = null;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const value = line[0].replace(/\r?\n$/, "");
    const code = value.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (code) {
      if (!fence) fence = { character: code[1][0], length: code[1].length };
      else if (code[1][0] === fence.character && code[1].length >= fence.length && !code[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = value.match(/^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
    if (heading) headings.push({ level: heading[1].length, title: heading[2], offset: line.index });
  }
  const stagePattern = /^(?:\*\*)?(?:(?:Этап|Шаг|Stage|Step)[ \t]+([A-ZА-Я]*[0-9]+(?:[-_.][A-ZА-Я0-9]+)*|[A-ZА-Я]+-[0-9]+)|([A-ZА-Я]+[-_]?[0-9]+(?:[-_][A-ZА-Я0-9]+)*))(?=[ \t.:)—–*-]|$)/iu;
  const stages = headings.filter(h => stagePattern.test(h.title));
  if (!stages.length || stages.length > 100) throw appError("VALIDATION_ERROR", "В плане нужны заголовки этапов, например «## Этап 1. Название» или «## DATA-001. Название» (до 100 этапов).");
  const ids = new Set();
  return stages.map((stage, index) => {
    const match = stage.title.match(stagePattern), id = match[1] || match[2];
    if (ids.has(id.toUpperCase()) || stage.level !== stages[0].level || stage.title.length > 200) throw appError("VALIDATION_ERROR", "У этапов должны быть разные номера, один уровень заголовков и названия до 200 символов.");
    ids.add(id.toUpperCase());
    const next = headings.find(h => h.offset > stage.offset && h.level <= stage.level);
    return { stepId: crypto.randomUUID(), ordinal: index + 1, title: stage.title.replace(/^\*\*|\*\*$/g, ""), content: text.slice(stage.offset, next?.offset ?? text.length) };
  });
}

function validateTrackerCommand(envelope) {
  if (envelope?.commandType === "RecordAssessment") return validateAssessmentCommand(envelope);
  if (!envelope || envelope.schemaVersion !== 1 || !UUID.test(envelope.commandId || "") || envelope.commandType !== "SetStepStatus") throw appError("VALIDATION_ERROR", "Неизвестная команда или неверный конверт.");
  assertExactKeys(envelope, new Set(["schemaVersion","commandId","commandType","expectedVersion","payloadHash","payload"]), "Конверт команды");
  if (!Number.isSafeInteger(envelope.expectedVersion) || envelope.expectedVersion < 1) throw appError("VALIDATION_ERROR", "expectedVersion должен быть целым числом не меньше 1.");
  if (!isPlainRecord(envelope.payload)) throw appError("VALIDATION_ERROR", "payload должен быть объектом.");
  assertExactKeys(envelope.payload, new Set(["stepId","status"]), "payload");
  if (!UUID.test(envelope.payload.stepId || "") || !["PENDING","RUNNING","BLOCKED","FAILED","DONE"].includes(envelope.payload.status)) throw appError("VALIDATION_ERROR", "Укажите этап и его статус.");
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
  let planId = input.planId || null;
  if (!planId && input.stepId) {
    const step = await dbFirst(db, "SELECT plan_id FROM plan_steps WHERE owner_id=? AND step_id=?", identity.ownerId, input.stepId);
    planId = step ? step.plan_id : null;
  }
  let payload = { ...input };
  let predictionPreparationError = null;
  if (envelope.commandType === "RecordAssessment") {
    const target = await assessmentTarget(db, identity.ownerId, input.planId, input.stepId);
    const requirementsJson = target?.requirements_json || "{}";
    let storedInput = Object.hasOwn(input.context, "agentTask") ? { ...input, context: { ...input.context, agentTask: normalizeAgentTaskV1(input.context.agentTask).agentTask } } : input;
    if (input.predictionRequest) {
      try {
        const serverEstimation = await calculateAtlmEstimate(db, identity.ownerId, { planId: input.planId,
          expectedRequirementsDigest: input.expectedRequirementsDigest, agentTask: storedInput.context.agentTask }, nowMs);
        if (serverEstimation.unavailableReason === "UNSUPPORTED_FORECAST_SCOPE") predictionPreparationError = "ATLM_FORECAST_SCOPE_CHANGED";
        else storedInput = { ...storedInput, serverEstimation };
      } catch (error) {
        // Domain rejection must be receipted, so a later context change cannot turn
        // the same command into a successful write. Genuine source failures still throw.
        if (error instanceof AppError && ["ASSESSMENT_CONTEXT_CHANGED", "PLAN_NOT_FOUND"].includes(error.code)) predictionPreparationError = error.code;
        else throw error;
      }
    }
    const assessmentJson = JSON.stringify(storedInput);
    if (new TextEncoder().encode(assessmentJson).length > 24000) throw appError("VALIDATION_ERROR", "Assessment with server estimation exceeds 24000 UTF-8 bytes.");
    Object.assign(payload, { assessmentJson, requirementsJson,
      requirementsDigest: "sha256:" + await hashCommandInput(JSON.parse(requirementsJson)),
    });
  }
  const actorType = channel === "mcp" ? "agent" : "user";
  let receiptInserted = false;
  try {
    const values = [identity.ownerId, envelope.commandId, hash, envelope.commandType, planId,
      envelope.expectedVersion == null ? null : envelope.expectedVersion, nowMs, identity.ownerId, actorType, JSON.stringify(payload)];
    let write;
    if (envelope.commandType === "RecordAssessment" && input.predictionRequest) {
      const modelId = JSON.parse(payload.assessmentJson).serverEstimation?.modelId ?? null;
      write = await db.prepare(`INSERT OR IGNORE INTO command_receipts
        (owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,result_json,recorded_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,CASE
          WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=? AND plan_id=?) THEN 'PLAN_NOT_FOUND'
          WHEN EXISTS(SELECT 1 FROM plans WHERE owner_id=? AND plan_id=? AND deleted_at IS NOT NULL) THEN 'PLAN_DELETED'
          WHEN EXISTS(SELECT 1 FROM plans WHERE owner_id=? AND plan_id=? AND first_started_at IS NOT NULL) THEN 'ATLM_FORECAST_SCOPE_CHANGED'
          WHEN ? IS NOT NULL THEN ?
          WHEN ? IS NOT NULL AND NOT EXISTS(${ATLM_CURRENT_MODEL_SQL}) THEN 'ATLM_MODEL_CHANGED'
          ELSE 'PENDING' END,?,?`).bind(...values, identity.ownerId, planId, identity.ownerId, planId,
            identity.ownerId, planId, predictionPreparationError, predictionPreparationError, modelId, identity.ownerId, modelId, JSON.stringify({ serverNow: nowMs }), nowMs).run();
    } else {
      write = await db.prepare("INSERT OR IGNORE INTO command_receipts (owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING',?)")
        .bind(...values, nowMs).run();
    }
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
  if (["DeletePlan", "RestorePlan"].includes(envelope.commandType)) {
    assertExactKeys(envelope, new Set(["schemaVersion", "commandId", "commandType", "expectedVersion", "payloadHash", "payload"]), "Конверт команды");
    assertExactKeys(payload, new Set(["planId", "reason"]), "payload");
    if (payload.reason !== undefined && (typeof payload.reason !== "string" || payload.reason.length > 1000)) throw appError("VALIDATION_ERROR", "reason ограничен 1000 символами.");
    if (payload.reason !== undefined) payload.reason = payload.reason.trim();
    assertSafeMetadataText(payload.reason, "reason");

  }
  let planId = payload.planId || null;
  if (envelope.commandType === "CreatePlan") {
    for (const field of ["documentSteps", "requirementsTargets"]) if (Object.hasOwn(payload, field)) throw appError("VALIDATION_ERROR", "Служебные поля плана не принимаются.");
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
    payload.documentSteps = payload.planText === undefined ? [] : parsePlanDocument(payload.planText);
    const planRequirements = payload.planText === undefined ? {title:payload.title,description:payload.description,acceptanceCriteria:payload.acceptanceCriteria} : {title:payload.title,planText:payload.planText};
    payload.requirementsTargets = [{stepId:null,requirementsJson:JSON.stringify({plan:planRequirements,steps:payload.documentSteps.map(step=>({stepId:step.stepId,ordinal:step.ordinal,title:step.title,content:step.content}))})},...payload.documentSteps.map(step=>({stepId:step.stepId,requirementsJson:JSON.stringify({plan:planRequirements,step:{stepId:step.stepId,title:step.title,content:step.content}})}))];

  } else {
    if (typeof payload.reason === "string") payload.reason = payload.reason.slice(0, 1000);
    if (envelope.commandType === "UpdatePlanMetadata") {
      if (payload.planText !== undefined) throw appError("VALIDATION_ERROR", "Исходный текст уже сохранён. Эта команда меняет только название и дату плана.");
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
      const targets=await dbAll(db,"SELECT step_id,requirements_json FROM assessment_targets WHERE owner_id=? AND plan_id=?",identity.ownerId,payload.planId);
      payload.requirementsTargets=targets.map(target=>{const requirements=JSON.parse(target.requirements_json);for(const key of ["title","description","acceptanceCriteria"])if(Object.hasOwn(requirements.plan,key)&&payload[key]!==undefined)requirements.plan[key]=payload[key]??"";return {stepId:target.step_id,requirementsJson:JSON.stringify(requirements)};});
    }
    if (envelope.commandType === "FinishPlan") {
      if (payload.allowIncomplete !== undefined && typeof payload.allowIncomplete !== "boolean") throw appError("VALIDATION_ERROR", "allowIncomplete должен быть boolean.");
      if (payload.reason !== undefined && (typeof payload.reason !== "string" || payload.reason.trim().length > 1000)) throw appError("VALIDATION_ERROR", "reason ограничен 1000 символами.");
      if (payload.allowIncomplete === true && (!payload.reason || !payload.reason.trim())) throw appError("VALIDATION_ERROR", "Для завершения с незавершёнными этапами требуется причина.");
      if (payload.reason !== undefined) payload.reason = payload.reason.trim();
      assertSafeMetadataText(payload.reason, "reason");

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

const PLAN_STATUSES = ["PLANNED", "RUNNING", "PAUSED", "COMPLETED"];
const MAX_PLAN_PAGE_SIZE = 100;

async function listPlans(db, ownerId, nowMs, filter = {}) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter) || Object.keys(filter).some(key => !["statuses", "limit", "cursor", "deleted"].includes(key))) {
    throw appError("VALIDATION_ERROR", "Допустимы только statuses, limit, cursor и deleted.");
  }
  if (filter.deleted !== undefined && typeof filter.deleted !== "boolean") throw appError("VALIDATION_ERROR", "deleted должен быть boolean.");
  const limit = filter.limit === undefined ? 50 : filter.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PLAN_PAGE_SIZE) throw appError("VALIDATION_ERROR", "limit должен быть целым числом от 1 до 100.");
  const statuses = filter.statuses === undefined ? PLAN_STATUSES : filter.statuses;
  if (!Array.isArray(statuses) || statuses.length < 1 || statuses.length > PLAN_STATUSES.length || new Set(statuses).size !== statuses.length || statuses.some(status => !PLAN_STATUSES.includes(status))) {
    throw appError("VALIDATION_ERROR", "statuses должен содержать уникальные состояния планов.");
  }
  const clauses = ["owner_id=?", filter.deleted === true ? "deleted_at IS NOT NULL" : "deleted_at IS NULL", "status IN (" + statuses.map(() => "?").join(",") + ")"];
  const values = [ownerId, ...statuses];
  if (filter.cursor !== undefined) {
    let cursor;
    try { cursor = JSON.parse(filter.cursor); } catch {}
    if (typeof filter.cursor !== "string" || filter.cursor.length > 200 || !Array.isArray(cursor) || cursor.length !== 2 || !Number.isSafeInteger(cursor[0]) || cursor[0] < 0 || !UUID.test(cursor[1] || "")) {
      throw appError("VALIDATION_ERROR", "Некорректный cursor списка планов.");
    }
    clauses.push("(registered_at < ? OR (registered_at = ? AND plan_id < ?))");
    values.push(cursor[0], cursor[0], cursor[1]);
  }
  const rows = await dbAll(db, "SELECT * FROM plans WHERE " + clauses.join(" AND ") + " ORDER BY registered_at DESC, plan_id DESC LIMIT ?", ...values, limit + 1);
  const page = rows.slice(0, limit), last = page.at(-1);
  return {
    plans: await Promise.all(page.map(row => planSummary(db, ownerId, row, nowMs))),
    nextCursor: rows.length > limit ? JSON.stringify([last.registered_at, last.plan_id]) : null,
    serverNow: nowMs,
  };
}

async function planSummary(db, ownerId, row, nowMs) {
  const intervals = await dbAll(db, "SELECT interval_id,start_ms,end_ms,opened_by,closed_by FROM work_intervals WHERE owner_id=? AND plan_id=? ORDER BY start_ms", ownerId, row.plan_id);
  const activeMs = row.first_started_at == null ? null : intervals.reduce((sum, interval) =>
    sum + Math.max(0, (interval.end_ms == null ? nowMs : interval.end_ms) - interval.start_ms), 0);
  const end = row.finished_at ?? row.deleted_at ?? nowMs;
  const calendarMs = row.first_started_at == null ? null : Math.max(0, end - row.first_started_at);
  const completion = await dbFirst(db, "SELECT (SELECT COUNT(*) FROM tracker_incomplete_steps WHERE owner_id=? AND plan_id=?) AS incompleteStepCount,(SELECT COUNT(*) FROM plan_steps WHERE owner_id=? AND plan_id=?) AS enabled", ownerId, row.plan_id, ownerId, row.plan_id);
  return {
    completion: { readyToFinish: row.deleted_at == null && (!completion.enabled || completion.incompleteStepCount === 0), incompleteStepCount: completion.incompleteStepCount, trackerEnabled: Boolean(completion.enabled) },
    planId: row.plan_id, title: row.title, description: row.description, acceptanceCriteria: row.acceptance_criteria,
    planCreatedAt: row.plan_created_precision === "instant"
      ? { precision: "instant", value: new Date(row.plan_created_at_ms).toISOString(), timeZone: row.plan_created_timezone }
      : { precision: "dateOnly", on: row.plan_created_on, timeZone: row.plan_created_timezone },
    registeredAt: row.registered_at, status: row.status, deletedAt: row.deleted_at ?? null, firstStartedAt: row.first_started_at,
    finishedAt: row.finished_at, version: row.version, createdBy: row.created_by, sourceReference: row.source_reference,
    intervals: intervals, activeMs: activeMs, calendarMs: calendarMs,
    pausedMs: calendarMs == null ? null : Math.max(0, calendarMs - activeMs), serverNow: nowMs,
  };
}

async function readPlan(db, ownerId, planId, nowMs) {
  const row=await dbFirst(db,"SELECT * FROM plans WHERE owner_id=? AND plan_id=?",ownerId,planId);
  if(!row)throw appError("PLAN_NOT_FOUND",messageFor("PLAN_NOT_FOUND"),404);
  const plan=await planSummary(db,ownerId,row,nowMs),document=await dbFirst(db,"SELECT markdown FROM plan_documents WHERE owner_id=? AND plan_id=?",ownerId,planId);
  if(document)plan.planText=document.markdown;
  plan.dateHistory=await dbAll(db,"SELECT old_precision,old_at_ms,old_on,old_timezone,changed_at,changed_by,reason FROM plan_date_history WHERE owner_id=? AND plan_id=? ORDER BY changed_at",ownerId,planId);
  return plan;
}

// All exported collections share one SQLite read snapshot.
const EXPORT_SOURCES={
 settings:["owners","timezone"],documents:["plan_documents","plan_id,markdown"],
 plans:["plans","plan_id,title,description,acceptance_criteria,plan_created_precision,plan_created_at_ms,plan_created_on,plan_created_timezone,registered_at,status,deleted_at,first_started_at,finished_at,source_reference"],
 steps:["plan_steps","step_id,plan_id,ordinal,title,content,status,version,created_at,updated_at"],
 intervals:["work_intervals","interval_id,plan_id,start_ms,end_ms"],dates:["plan_date_history","history_id,plan_id,old_precision,old_at_ms,old_on,old_timezone,changed_at,reason"],
 assessments:["assessment_revisions","assessment_id,revision,plan_id,step_id,recorded_at,requirements_digest,requirements_json,assessment_json"],targets:["assessment_targets","plan_id,step_id,requirements_json"],
 exceptions:["tracker_finish_exceptions","plan_id,reason,created_at"]
};
function groupExportRows(rows,key){const groups=new Map();for(const row of rows){const value=groups.get(row[key])||[];value.push(row);groups.set(row[key],value);}return groups;}
function exportPlanDate(precision,at,on,timeZone){return precision==="instant"?{precision,value:new Date(at).toISOString(),timeZone}:{precision,on,timeZone};}
async function buildExportReport(db,ownerId,clock){
 const sql=Object.entries(EXPORT_SOURCES).map(([kind,[table,columns]])=>`SELECT '${kind}' AS kind,json_object(${columns.split(",").map(column=>`'${column}',${column}`).join(",")}) AS record FROM ${table} WHERE owner_id=?1`).join(" UNION ALL ");
 const snapshot=await db.prepare(sql).bind(ownerId).all(),nowMs=clock();
 if(snapshot.success===false||!Array.isArray(snapshot.results))throw appError("INTERNAL_ERROR","Не удалось прочитать полный отчёт.",500);
 const data=Object.fromEntries(Object.keys(EXPORT_SOURCES).map(key=>[key,[]]));for(const row of snapshot.results)data[row.kind].push(JSON.parse(row.record));
 const related=Object.fromEntries(["steps","intervals","dates","assessments","exceptions"].map(key=>[key,groupExportRows(data[key],"plan_id")]));
 const documents=new Map(data.documents.map(d=>[d.plan_id,d.markdown])),digests=new Map();for(const t of data.targets)digests.set(t.plan_id+":"+(t.step_id||""),"sha256:"+await hashCommandInput(JSON.parse(t.requirements_json)));
 const assessments=rows=>rows.map(row=>{const {assessmentId,planId,stepId,expectedRequirementsDigest,...assessment}=JSON.parse(row.assessment_json);return {assessmentId:row.assessment_id,revision:row.revision,recordedAt:row.recorded_at,requirements:JSON.parse(row.requirements_json),needsRevision:row.requirements_digest!==digests.get(row.plan_id+":"+(row.step_id||"")),assessment:{formatVersion:1,...assessment}};});
 const plans=data.plans.sort((a,b)=>a.registered_at-b.registered_at||a.plan_id.localeCompare(b.plan_id)).map(row=>{
  const get=key=>related[key].get(row.plan_id)||[],intervals=get("intervals").sort((a,b)=>a.start_ms-b.start_ms),steps=get("steps").sort((a,b)=>a.ordinal-b.ordinal),measured=row.first_started_at!=null,end=row.finished_at??row.deleted_at??nowMs,activeMs=measured?calculateActiveMs(intervals,nowMs):null,calendarMs=measured?Math.max(0,end-row.first_started_at):null,incomplete=steps.filter(step=>step.status!=="DONE").length;
  return {planId:row.plan_id,title:row.title,description:row.description,acceptanceCriteria:row.acceptance_criteria,...(documents.has(row.plan_id)?{planText:documents.get(row.plan_id)}:{}),planCreatedAt:exportPlanDate(row.plan_created_precision,row.plan_created_at_ms,row.plan_created_on,row.plan_created_timezone),registeredAt:row.registered_at,status:row.status,deletedAt:row.deleted_at,firstStartedAt:row.first_started_at,finishedAt:row.finished_at,sourceReference:row.source_reference,
   completion:{trackerEnabled:steps.length>0,incompleteStepCount:incomplete,readyToFinish:row.deleted_at==null&&incomplete===0},activeMs,calendarMs,pausedMs:calendarMs==null?null:Math.max(0,calendarMs-activeMs),intervals:intervals.map(i=>({intervalId:i.interval_id,startMs:i.start_ms,endMs:i.end_ms})),
   dateHistory:get("dates").sort((a,b)=>a.changed_at-b.changed_at).map(d=>({previous:exportPlanDate(d.old_precision,d.old_at_ms,d.old_on,d.old_timezone),changedAt:d.changed_at,reason:d.reason})),
   assessments:assessments(get("assessments").filter(a=>a.step_id==null)),
   steps:steps.map(step=>({stepId:step.step_id,ordinal:step.ordinal,title:step.title,content:step.content,status:step.status,version:step.version,createdAt:step.created_at,updatedAt:step.updated_at,readyToFinish:step.status==="DONE",assessments:assessments(get("assessments").filter(a=>a.step_id===step.step_id))})),
   finishExceptions:get("exceptions").map(e=>({reason:e.reason,recordedAt:e.created_at}))};
 });
 const included=plans.filter(p=>p.deletedAt==null),measured=included.filter(p=>p.activeMs!=null),union=unionIntervals(included.flatMap(p=>p.intervals.map(i=>[i.startMs,i.endMs??nowMs])));
 return {formatVersion:2,exportedAt:nowMs,timezone:data.settings[0]?.timezone||"UTC",summary:{planCount:included.length,deletedPlanCount:plans.length-included.length,measuredPlanCount:measured.length,totalActiveMs:measured.length?union.reduce((n,[a,b])=>n+Math.max(0,b-a),0):null,sumPlanActiveMs:measured.length?measured.reduce((n,p)=>n+p.activeMs,0):null},plans};
}

async function readTrackerCapabilities(db,ownerId){return {
 available:true,schemaVersion:2,version:TRACKER_VERSION,
    assessments: { formatVersion: 1, recordTool: "RecordAssessment", getTool: "GetAssessment", historyTool: "GetEstimationHistory",
      immutableRevisions: true, agentDefinedMethods: true, maxPayloadBytes: 24000, maxJsonDepth: 10,
      forecastUnits: "ms", forecastMetrics: FORECAST_METRICS, initialExpectedVersion: 0, requirementsDigest: true,
      contextRead: { tool: "GetAssessment", omitAssessmentId: true }, expectedRequirementsDigestRequired: true,
      historyMaxTargets: 20, historyMaxLimit: 100, methodologyControlsExecution: false,
      atlm: { formatVersion: 1, method: { ...ATLM_METHOD }, featureSchemaVersion: "agent-task-v1", metric: "PLAN_ACTIVE",
        predictionScope: "FULL_FROM_FIRST_START", retrainEveryNewPlans: 5,
        calculateTool: "CalculateAtlmEstimate", planEstimateTool: "GetPlanEstimate", modelStatusTool: "GetEstimationModelStatus",
        processTool: "ProcessEstimationTraining", startTrainingTool: "StartEstimationTraining", datasetTool: "GetAtlmDataset", predictionRequest: { method: "ATLM", methodVersion: 1 },
        limits: { maxTrainingSamples: 5000, datasetDefaultLimit: 50, datasetMaxLimit: 100, maxOutcomes: 20, maxChangedContracts: 20, maxVerificationKinds: 5 } },
      },

 planDocuments:{available:true,format:"markdown",createField:"planText",maxLength:60000,stageHeadings:"## Этап 1. Название",statusTool:"SetStepStatus",statuses:["PENDING","RUNNING","BLOCKED","FAILED","DONE"],preservesOriginal:true},
 steps:{model:"current-state",statusHistory:false,versionRequired:true},
 planDeletion:{softDelete:true,deleteTool:"DeletePlan",restoreTool:"RestorePlan",deletedFilter:"deleted",restoreStartsTimer:false},
 parallelPlans:true,planList:{tool:"ListPlans",statuses:PLAN_STATUSES,defaultLimit:50,maxLimit:MAX_PLAN_PAGE_SIZE,order:"registeredAt DESC, planId DESC",deletedDefault:false},
 analytics:{totalActiveMs:"union of owner intervals",activeByDay:"union by local day",sumPlanActiveMs:"sum of per-plan intervals"},exportFormatVersion:2
};}
async function readPlanExecutionSnapshot(db,ownerId,planId,nowMs){
 if(!UUID.test(planId||""))throw appError("VALIDATION_ERROR","planId должен быть UUID.");
 const plan=await readPlan(db,ownerId,planId,nowMs),steps=await dbAll(db,"SELECT step_id,ordinal,title,content,status,version,created_at,updated_at FROM plan_steps WHERE owner_id=? AND plan_id=? ORDER BY ordinal,step_id",ownerId,planId);
 for(const step of steps){step.readyToFinish=step.status==="DONE";step.readinessBlockers=step.readyToFinish?[]:[{code:"STEP_NOT_DONE"}];}
 return {plan,steps,serverNow:nowMs};
}
async function readCommandReceipt(db,ownerId,commandId){
 if(!UUID.test(commandId||""))throw appError("VALIDATION_ERROR","commandId должен быть UUID.");
 const row=await dbFirst(db,"SELECT command_id,command_type,outcome_code,result_version,result_json,server_now_ms,recorded_at FROM command_receipts WHERE owner_id=? AND command_id=?",ownerId,commandId);
 if(!row)return {status:"NOT_FOUND",commandId};
 if(row.outcome_code==="PENDING")return {status:"PENDING",commandId,commandType:row.command_type,serverNow:row.server_now_ms};
 const result=parseColumn(row.result_json,{});
 return {status:"FINAL",commandId,commandType:row.command_type,...(row.outcome_code==="OK"?{result}:{error:{code:row.outcome_code,message:messageFor(row.outcome_code),details:result}}),resultVersion:row.result_version,recordedAt:row.recorded_at,serverNow:row.server_now_ms};
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

export async function buildAnalytics(db, ownerId, filter, nowMs) {
  const timeZone = checkTimeZone(filter.timeZone || "UTC");
  const range = inclusiveDateRange(filter.from, filter.to, timeZone);
  const plans = await dbAll(db, "SELECT p.* FROM plans p WHERE p.owner_id=? AND p.deleted_at IS NULL ORDER BY p.registered_at DESC", ownerId);
  const days = new Map(), clippedIntervals = [];
  let sumPlanActiveMs = 0;
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
      clippedIntervals.push([cursor, stop]);
    }
    sumPlanActiveMs += clippedTotal;
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
  for (const [start, stop] of unionIntervals(clippedIntervals)) {
    let cursor = start;
    while (cursor < stop) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(cursor).map(part => [part.type, part.value]));
      const day = parts.year + "-" + parts.month + "-" + parts.day;
      const pieceEnd = Math.min(stop, inclusiveDateRange(day, day, timeZone).endMs);
      days.set(day, (days.get(day) || 0) + pieceEnd - cursor);
      cursor = pieceEnd;
    }
  }
  return {
    period: { from: filter.from, to: filter.to, timeZone: timeZone, startMs: range.startMs, endMs: range.endMs },
    activeByDay: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, activeMs]) => ({ date: date, activeMs: activeMs })),
    totalActiveMs: [...days.values()].reduce((sum, value) => sum + value, 0),
    sumPlanActiveMs: sumPlanActiveMs,
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

const UI_CONSOLE_PAPER_CSS = String.raw`
/* Hallmark v2 · theme: console (by request) · console: paper · scope: app */
/* Critique: a working record, with measured time prominent and controls kept close to their context. */
:root{background:var(--paper);--paper:oklch(98% .006 85);--paper-2:oklch(99.5% .003 85);--paper-3:oklch(95.5% .009 85);--ink:oklch(19% .01 60);--ink-2:oklch(33% .012 60);--muted:oklch(44% .012 60);--line:oklch(85% .012 80);--line-strong:oklch(60% .018 80);--amber:oklch(54% .14 70);--amber-text:oklch(44% .12 70);--amber-ink:oklch(99% .003 85);--amber-soft:oklch(94% .035 80);--blue:oklch(46% .12 250);--blue-soft:oklch(94% .025 250);--red:oklch(44% .14 25);--red-soft:oklch(95% .025 25);--green:var(--amber);--panel:var(--paper-2);--font-body:'Host Grotesk',system-ui,sans-serif;--font-measured:'Atkinson Hyperlegible Mono',ui-monospace,monospace;--overlay:oklch(19% .01 60 / .48)}
html,body{overflow-x:clip;background:var(--paper)}body{background:var(--paper);color:var(--ink);font-family:var(--font-body);line-height:1.5}.shell{max-width:1200px;padding:32px 28px 80px}.top{align-items:end;margin-bottom:24px;padding-bottom:22px;border-bottom:1px solid var(--line-strong)}h1,h2,h3,h4{color:var(--ink);font-weight:500;letter-spacing:-.025em;min-width:0;overflow-wrap:break-word}h1{font-size:clamp(2rem,4vw,3rem);line-height:1.05;margin:0}h2{font-size:1.2rem;margin:0 0 16px}h3{font-size:1.05rem}p{line-height:1.55}.muted{color:var(--muted)}#who{font-size:.875rem;text-align:right}.nav{gap:0;margin-bottom:28px;padding:0;border-bottom:1px solid var(--line-strong)}.nav button{border:0;padding:12px 18px;color:var(--muted);font-weight:500;border-bottom:2px solid transparent}.nav button:hover:not([aria-current=page]):not(:disabled){border-color:transparent}.nav button[aria-current=page]{color:var(--ink);border-color:var(--amber)}
button,input,textarea,select{font-family:var(--font-body)}button{background:var(--paper-2);color:var(--ink);border:1px solid var(--line-strong);border-radius:6px;font-weight:500;padding:.65rem .9rem;min-height:42px;transition:background-color .15s ease,border-color .15s ease}button:hover:not(:disabled){background:var(--paper-3);border-color:var(--amber)}button:active:not(:disabled){background:var(--amber-soft)}button.primary,.primary{background:var(--amber);border-color:var(--amber);color:var(--amber-ink)}button.primary:hover:not(:disabled){background:var(--ink-2);border-color:var(--ink-2);color:var(--paper-2)}button.primary:active:not(:disabled){background:var(--ink);border-color:var(--ink)}button.danger{color:var(--red);background:var(--paper-2);border-color:var(--line-strong)}button.danger:hover:not(:disabled){background:var(--red-soft);border-color:var(--red)}button.danger:active:not(:disabled){background:var(--red);color:var(--paper-2);border-color:var(--red)}:is(button,a,input,textarea,select,summary,[role=button]):focus-visible{outline:3px solid var(--amber);outline-offset:2px}a{color:var(--ink-2);text-decoration-color:var(--line-strong);text-underline-offset:3px}a:hover{color:var(--amber)}
.grid{grid-template-columns:minmax(0,1.3fr) minmax(0,.7fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:20px}.grid>.panel{border:0;border-radius:0;margin:0}.panel{background:var(--paper-2);border:1px solid var(--line);border-radius:10px;box-shadow:none;padding:24px;margin-bottom:20px}.current{min-height:240px}.metrics{gap:1px;background:var(--paper-3);border:1px solid var(--line);border-radius:6px;overflow:hidden}#view-overview .grid .metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.metric{background:var(--paper-3);border:0;border-right:1px solid var(--line);border-bottom:1px solid var(--line);border-radius:0;padding:14px}.metric small{font-size:.8rem;color:var(--muted);margin-bottom:10px}.metric strong{font-family:var(--font-measured);font-size:1.15rem;font-weight:400;color:var(--blue);font-variant-numeric:tabular-nums}.timer,#active>.active-plan .timer{font-family:var(--font-measured);font-size:clamp(2rem,4vw,3rem);font-weight:400;letter-spacing:-.04em;line-height:1.1;color:var(--blue);font-variant-numeric:tabular-nums;margin:15px 0}.active-plan .timer{color:var(--blue)}#active{gap:0}#active>.active-plan{border:0;border-top:1px solid var(--line);border-radius:0;padding:16px 0;margin:0;color:var(--ink)}#active>.active-plan:first-child{border-top:0;padding-top:0}#active>.active-plan:last-child{padding-bottom:0}.active-plan .plan-open{font-size:1.08rem;font-weight:500}.plan-open{background:transparent;border:0;min-height:0}.plan-open:hover:not(:disabled){background:transparent;color:var(--amber)}
.list{gap:0}.row,.analytics-plan{background:var(--paper-2);border:0;border-bottom:1px solid var(--line);border-radius:0;padding:16px 0}.row:first-child,.analytics-plan:first-child{border-top:1px solid var(--line)}.row-title{font-weight:500}.row-meta,.analytics-plan-meta{color:var(--muted);line-height:1.45}.row-right{gap:8px}.badge{border:1px solid var(--line);border-radius:4px;background:var(--blue-soft);color:var(--blue);font-size:.78rem;font-weight:500;padding:.25rem .5rem}.badge.paused{background:var(--amber-soft);color:var(--amber-text)}.badge.completed{background:var(--paper-3);color:var(--muted)}.pager-arrow{background:var(--paper-2);color:var(--ink);border-color:var(--line-strong)}.pager-page{font-family:var(--font-measured)}
.checkbox-field{display:flex;align-items:flex-start;gap:8px;min-height:44px;cursor:pointer}.checkbox-field input{flex:0 0 16px;width:16px;height:16px;min-height:0;margin:4px 0 0;padding:0}.checkbox-field>span{min-width:0}.field label{font-size:.875rem;font-weight:500;color:var(--ink-2)}.field input,.field textarea,.field select,.form>input,.form>textarea,.tracker-form input,.tracker-form textarea,.tracker-form select{background:var(--paper-3);color:var(--ink);border:1px solid var(--line-strong);border-radius:6px;padding:.65rem}.field textarea{min-height:90px}input::placeholder,textarea::placeholder{color:var(--muted);opacity:1}.notice{color:var(--ink-2);background:var(--amber-soft);border-color:var(--line-strong);border-radius:6px}.error,.form-error{color:var(--red);background:var(--red-soft);border-color:var(--red);border-radius:6px}.form-error:empty{display:none}.bar{background:var(--paper-3);border-radius:2px}.bar span,.step-bar{background:var(--blue)}.step-column{border:0;min-height:0}.step-column:hover:not(:disabled){background:transparent;border:0}.step-column:hover .step-bar,.step-column:focus .step-bar{background:var(--ink-2)}.barrow>span,.step-y-axis,.step-x-label{font-variant-numeric:tabular-nums}.step-tooltip{background:var(--ink);color:var(--paper-2);border-radius:6px;box-shadow:none}.step-tooltip span{color:var(--paper)}.analytics-plan{padding:0}.analytics-plan>summary.row,.analytics-plan>summary.row:first-child{border:0;border-radius:0;padding:16px 0}.step-chart-body{margin:0;padding:16px 0}.settings-export{color:var(--amber);font-weight:500}.modal{background:var(--overlay)}.modalbox{background:var(--paper-2);border:1px solid var(--line-strong);border-radius:10px;box-shadow:none;padding:24px}.toast{background:var(--ink);color:var(--paper-2);border-radius:6px}.toast.error{background:var(--red);color:var(--paper-2)}
.tracker-section{border-color:var(--line)}.tracker-list{gap:0}.tracker-card{background:var(--paper-2);border:0;border-top:1px solid var(--line);border-radius:0;padding:16px 0}.tracker-card:last-child{border-bottom:1px solid var(--line)}.tracker-card-toggle{min-height:42px}.tracker-card-toggle:hover:not(:disabled){background:transparent;color:var(--amber)}.tracker-meta,.tracker-card-status{color:var(--muted)}.tracker-marker{border-radius:4px;background:var(--paper-3);font-weight:500}.tracker-marker.GAP,.tracker-marker.LATE,.tracker-marker.STALE_EXECUTOR{background:var(--amber-soft);color:var(--amber-text)}.tracker-marker.CORRECTION{background:var(--blue-soft);color:var(--blue)}
@media(max-width:720px){.shell{padding:24px 16px 60px}.grid{grid-template-columns:minmax(0,1fr)}.panel{padding:18px}.top{align-items:start}#who{text-align:left}}@media(max-width:600px){.tracker-card-toggle{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px}.tracker-card-toggle>strong{grid-column:1;grid-row:1}.tracker-card-toggle>.tracker-card-status{grid-column:1;grid-row:2}.tracker-card-toggle>span:last-child{grid-column:2;grid-row:1}.nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));overflow:visible}.nav button{padding:12px;text-align:center}.tracker-card{padding:14px 0}.modalbox{padding:18px}.metrics,#view-overview .grid .metrics{grid-template-columns:1fr}.row{padding:14px 0}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important;animation-iteration-count:1!important}}
`;

const UI_TYPOGRAPHY_CSS = String.raw`
/* Hallmark v2 · theme: console · console: paper · scope: app · redesign: polish */
/* Critique: the plan is the reading surface; headings have distinct sizes and technical evidence is absent from the UI. */
/* Hallmark · finish-review: subagent · 2 findings · 2 resolved · gap: none */
/* Hallmark · dropped #criteria · the user requested the original plan as one document. */
:root{--text-xs:.75rem;--text-sm:.875rem;--text-md:1rem;--text-lg:1.2rem;--text-xl:1.44rem;--text-2xl:1.728rem;--text-3xl:2.074rem}
html,body{overflow-x:clip}body{font-size:var(--text-md)}
h1,h2,h3,h4,h5,h6{font-family:var(--font-body);font-weight:500;color:var(--ink);letter-spacing:normal;line-height:1.3;min-width:0;overflow-wrap:anywhere;text-wrap:balance}
h1{font-size:var(--text-3xl)}h2{font-size:var(--text-2xl)}h3{font-size:var(--text-xl)}h4,h5,h6{font-size:var(--text-lg)}
button,input,textarea,select{font-size:var(--text-md);line-height:1.5}input:not([type=checkbox]):not([type=radio]),select{min-height:44px}button{min-height:44px}
:is(.field>label,label.field,.tracker-meta,.row-meta,.analytics-plan-meta,.tracker-card-status,.tracker-timeline time,.pager,.step-method,.step-axis-caption,.step-minutes,.step-x-label,.step-y-axis,.step-chart-body p,.step-tooltip,.sample-note,.muted#who){font-size:var(--text-sm)}
.field>label,label.field{font-weight:500}.field>label{display:block;margin-bottom:6px}.field input,.field textarea,.field select{width:100%;max-width:100%}
.metric small,.badge,.tracker-marker{font-size:var(--text-sm)}.metric strong{font-size:var(--text-lg)}
.plan-open{min-height:44px}.active-plan .plan-open,.row-title,.analytics-plan-name{font-size:var(--text-lg)}.step-chart-body h3{font-size:var(--text-lg);color:var(--ink)}
.tracker-card-toggle{align-items:center;min-height:44px;gap:12px}.tracker-card-toggle>strong{font-size:var(--text-lg);font-weight:500;line-height:1.35}.document-step .tracker-card-toggle>strong{font-size:var(--text-xl)}
.tracker-card-status{font-size:var(--text-sm);font-weight:400}.tracker-card-body{padding-top:16px}.tracker-card-body[hidden]{display:none!important}
.tracker-form>strong,.tracker-meta>strong{display:block;font-size:var(--text-lg);font-weight:500;color:var(--ink);margin:16px 0 8px}.tracker-form>strong:first-child{margin-top:0}
.step-description{max-width:75ch}.step-description h5{margin:20px 0 10px}.step-description h5:first-child{margin-top:0}
.plan-source>summary,.plan-metadata>summary{cursor:pointer;min-height:44px;padding-block:10px}

.tracker-section>p[role=status]:empty{display:none}.document-plan{gap:20px}.document-plan>h3{margin:0}.document-plan>.tracker-list{display:block}.document-plan .tracker-card{padding:24px 0}.document-plan .tracker-card h3{margin:0}
.plan-prose{max-width:75ch;min-width:0;font-size:var(--text-md);line-height:1.65;overflow-wrap:anywhere}.plan-prose>h2,.plan-prose>h3,.plan-prose>h4{margin:28px 0 12px}.plan-prose>:first-child{margin-top:0}.plan-prose>p{white-space:pre-wrap;margin:12px 0}.plan-prose li{margin:6px 0}.plan-prose ul,.plan-prose ol{padding-left:1.5rem}
.plan-prose p>strong:first-child:last-child{display:block;font-size:var(--text-lg);font-weight:500;margin-top:20px}.plan-prose code{font-family:var(--font-measured);font-size:var(--text-sm);background:var(--paper-3);border-radius:4px;padding:2px 4px}.plan-prose pre{max-width:100%;overflow-x:auto;background:var(--paper-3);padding:16px;border-radius:6px}.plan-prose pre code{padding:0}.plan-prose hr{border:0;border-top:1px solid var(--line);margin:24px 0}
.plan-table-scroll{overflow-x:auto;max-width:100%;margin-block:16px}.plan-prose table{border-collapse:collapse;width:100%;font-size:var(--text-md)}.plan-prose :is(th,td){padding:10px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}.plan-prose td{overflow-wrap:normal;word-break:normal}.plan-prose th{font-size:var(--text-sm);font-weight:500;white-space:nowrap;overflow-wrap:normal}.plan-table-scroll:focus-visible{outline:3px solid var(--amber);outline-offset:2px}
.step-status-form{grid-template-columns:minmax(160px,240px) auto;align-items:end;justify-content:start;margin:0 0 24px}.step-status-form .form-error{grid-column:1/-1}.plan-source textarea{width:100%;max-width:100%;font-family:var(--font-measured);font-size:var(--text-sm);padding:12px;background:var(--paper-3);color:var(--ink);border:1px solid var(--line-strong);border-radius:6px}
.document-plan+.plan-metadata{margin-top:24px}.plan-metadata .form{margin-top:16px}.modalbox{max-width:760px}.modalbox textarea#description{min-height:260px}
@media(max-width:600px){.step-status-form{grid-template-columns:minmax(0,1fr)}.tracker-card-toggle{display:grid;grid-template-columns:minmax(0,1fr) auto}.tracker-card-toggle>.tracker-card-status{grid-column:1;grid-row:2}.document-plan .tracker-card{padding:20px 0}.tracker-actions button{min-height:44px}}
`;

const UI_ANALYTICS_CSS = "";

const UI_PLAN_LISTS_CSS = String.raw`
#active{display:grid;gap:10px}
#active>.active-plan{border:1px solid var(--line);border-radius:11px;padding:14px;margin:0;color:var(--ink)}
#active>.active-plan .timer{font-size:1.7rem;letter-spacing:-.04em;margin:9px 0}
#active>.active-plan .actions{margin-top:12px}
.pager{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:12px;margin-top:16px;color:var(--muted);font-size:.85rem}
.pager-summary{min-width:0;overflow-wrap:anywhere}
.pager-controls{grid-column:2;display:flex;align-items:center;gap:9px}
.pager-page{min-width:3.5em;text-align:center;font-variant-numeric:tabular-nums}
.pager-arrow{width:44px;height:44px;display:grid;place-items:center;padding:0;border:1px solid var(--line);background:var(--paper-2);color:var(--ink)}
.pager-arrow svg{display:block;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.pager-arrow:hover:not(:disabled){border-color:var(--green);color:var(--green)}
.pager-arrow:disabled{opacity:.55;background:var(--paper-3);color:var(--muted);cursor:not-allowed}
@media(max-width:600px){.pager{grid-template-columns:minmax(0,1fr);gap:8px}.pager-summary{grid-row:2;text-align:center}.pager-controls{grid-column:1;grid-row:1;justify-self:center}}
`;

// Inserted into the base client so metrics, day bars and disclosures share its accepted response.
const UI_ANALYTICS = String.raw`
function renderAnalyticsPlanCards(list,report){
 const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
 for(const plan of report.plans){const row=make("article",null,"row"),title=make("span",plan.title,"row-title"),value=make("span",duration(plan.activeInPeriodMs),"analytics-plan-meta");row.append(title,value);list.append(row);}
}
`;


const UI_PLAN_LISTS = String.raw`
const PLAN_PAGE_SIZE=8, RECENT_PAGE_SIZE=4;
let planPage=0,recentPage=0,periodPlans=null,includeRunningNow=false;
function renderPagedList(list,items,pageSize,page,kind,emptyText) {
  const lastPage=Math.max(0,Math.ceil(items.length/pageSize)-1);
  page=Math.min(Math.max(0,page),lastPage);
  if(kind==="plans")planPage=page;else recentPage=page;
  list.replaceChildren();
  if(!items.length){const empty=document.createElement("p");empty.className="muted";empty.textContent=emptyText;list.append(empty);}
  else items.slice(page*pageSize,(page+1)*pageSize).forEach(plan=>{
    const row=card(plan),period=kind==="plans"&&(periodPlans?.get(plan.planId)||(includeRunningNow&&plan.status==="RUNNING"?{activeInPeriodMs:0}:null));
    if(period){
      const meta=row.querySelector(".row-meta");
      meta.textContent+=" · за период: "+(period.activeInPeriodMs>0?duration(period.activeInPeriodMs):"без активности");
    }
    list.append(row);
  });
  let pager=q("#"+kind+"Pager");
  if(!pager){
    pager=document.createElement("nav");pager.id=kind+"Pager";pager.className="pager";
    pager.setAttribute("aria-label",kind==="plans"?"Страницы списка планов":"Страницы остальных планов");
    const summary=document.createElement("span"),controls=document.createElement("div"),previous=document.createElement("button"),indicator=document.createElement("span"),next=document.createElement("button");
    summary.className="pager-summary";controls.className="pager-controls";indicator.className="pager-page";indicator.setAttribute("aria-live","polite");
    previous.type=next.type="button";previous.className=next.className="pager-arrow";
    const icon=pathData=>{const svg=document.createElementNS("http://www.w3.org/2000/svg","svg"),path=document.createElementNS("http://www.w3.org/2000/svg","path");svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("aria-hidden","true");svg.setAttribute("focusable","false");path.setAttribute("d",pathData);svg.append(path);return svg;};
    previous.append(icon("M15 18 9 12 15 6"));next.append(icon("M9 18 15 12 9 6"));previous.setAttribute("aria-label","Предыдущая страница");next.setAttribute("aria-label","Следующая страница");
    previous.onclick=()=>{if(kind==="plans"){planPage--;renderPlanList();}else{recentPage--;renderRecentList();}};
    next.onclick=()=>{if(kind==="plans"){planPage++;renderPlanList();}else{recentPage++;renderRecentList();}};
    controls.append(previous,indicator,next);pager.append(summary,controls);list.after(pager);
  }
  pager.querySelector(".pager-summary").textContent=items.length?(page*pageSize+1)+"–"+Math.min((page+1)*pageSize,items.length)+" из "+items.length:"Нет планов";
  pager.querySelector(".pager-page").textContent=(page+1)+" / "+(lastPage+1);
  const arrows=pager.querySelectorAll("button");arrows[0].disabled=page===0;arrows[1].disabled=page===lastPage;
}
function renderPlanList(){
  const visible=periodPlans===null?plans:plans.filter(plan=>periodPlans.has(plan.planId)||(includeRunningNow&&plan.status==="RUNNING"));
  renderPagedList(q("#plans"),visible,PLAN_PAGE_SIZE,planPage,"plans",plans.length?"За выбранный период планов нет.":"Планов пока нет.");
}
function renderRecentList(){
  const otherPlans=plans.filter(plan=>plan.status!=="RUNNING");
  renderPagedList(q("#recent"),otherPlans,RECENT_PAGE_SIZE,recentPage,"recent",plans.length?"Остальные планы появятся здесь.":"Планов пока нет.");
}
window.addEventListener("plan-time-tracker:period-plans",event=>{
  periodPlans=new Map(event.detail.rows.map(plan=>[plan.planId,plan]));
  includeRunningNow=event.detail.includeRunningNow;
  if(event.detail.resetPage)planPage=0;
  q("#plans").dataset.filtered="true";
  renderPlanList();
});
function render(){
  renderPlanList();renderRecentList();renderActive();
  q("#plans").dataset.loaded="true";window.dispatchEvent(new Event("plan-time-tracker:plans-rendered"));
  if(q("#count"))q("#count").textContent=String(plans.filter(p=>p.status==="COMPLETED"&&p.finishedAt>Date.now()-30*86400000).length);
  if(q("#today"))q("#today").textContent=duration(todayActiveMs);
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
    const stats=make("div",null,"metrics");
    panel.append(heading,toolbar,stats);
    target.prepend(panel);
    return {panel,from,to,mode,apply,stats};
  }
  const overview=q("#view-overview");
  const overviewFilter=addFilterPanel(overview,"overview","Фильтр периода");
  overviewFilter.mode.closest(".field").remove();
  const overviewHeading=overviewFilter.panel.querySelector("h2");
  overviewHeading.textContent="Показатели периода";
  const planFilter=addFilterPanel(q("#view-plans"),"plan","Планы за период");
  planFilter.panel.classList.add("plan-period-panel");
  const filterRequestIds=new WeakMap();
  function formatPlanSample(count) {
    const n=Number(count)||0,lastTwo=n%100;
    return "по "+n+" "+((lastTwo>=11&&lastTwo<=14)||n%10!==1?"планам":"плану");
  }
  function renderMetrics(target,data) {
    target.replaceChildren();
    const values=[
      ["Общее время",duration(data.totalActiveMs)],
      ["Завершено планов",String(data.completedPlans)],
      ["Медиана активного времени",duration(data.completedMedianActiveMs)+(data.completedMedianActiveMs==null?"":" · "+formatPlanSample(data.completedMeasuredN))],
      ["Сумма времени планов",duration(data.sumPlanActiveMs)]
    ];
    values.forEach(([label,value],index)=>{
      const box=make("div",null,"metric"),small=make("small",label),strong=make("strong",value);
      box.append(small,strong);
      if(index===2&&data.completedSmallSample){const note=make("small","Малая выборка","sample-note");note.title="Медиана рассчитана по менее чем пяти завершённым планам.";note.setAttribute("aria-label","Малая выборка: менее пяти завершённых планов.");box.append(note);}
      target.append(box);
    });
  }
  async function loadFilter(filter, overviewMode, preservePage=false) {
    const requestId=(filterRequestIds.get(filter)||0)+1;
    filterRequestIds.set(filter,requestId);
    const selection=preservePage&&filter.requested
      ? {...filter.requested,timeZone:state.zone}
      : {from:filter.from.value,to:filter.to.value,timeZone:state.zone,mode:filter.mode.value};
    if(!selection.from||!selection.to)return;
    filter.requested=selection;
    if(!preservePage)filter.resetPagePending=true;
    const query=new URLSearchParams({from:selection.from,to:selection.to,timeZone:selection.timeZone});
    let data;
    try{data=await api("/api/analytics?"+query);}
    catch(error){
      if(filterRequestIds.get(filter)!==requestId)return null;
      filter.requested=filter.applied;filter.resetPagePending=false;throw error;
    }
    if(filterRequestIds.get(filter)!==requestId)return null;
    filter.applied=selection;
    renderMetrics(filter.stats,data);
    if(overviewMode)return data;
    const rows=selection.mode==="finished"
      ? data.plans.filter(p=>p.status==="COMPLETED"&&p.finishedAt>=data.period.startMs&&p.finishedAt<data.period.endMs)
      : data.plans.filter(p=>p.activeInPeriodMs>0);
    const inactiveRows=selection.mode==="activity"?data.inactivePlans||[]:[];
    window.dispatchEvent(new CustomEvent("plan-time-tracker:period-plans",{
      detail:{rows:[...rows,...inactiveRows],resetPage:filter.resetPagePending,
        includeRunningNow:selection.mode==="activity"&&data.period.startMs<=data.asOf&&data.asOf<data.period.endMs}
    }));
    filter.resetPagePending=false;
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
  let planFilterReady=false;
  window.addEventListener("plan-time-tracker:plans-rendered",()=>{
    if(!planFilterReady)return;
    loadFilter(overviewFilter,true,true).catch(e=>window.alert(e.message));
    loadFilter(planFilter,false,true).catch(e=>window.alert(e.message));
  });
  // Analytics uses the base loader so one accepted response updates metrics, chart and list together.
  async function init() {
    const settings=await api("/api/settings");state.zone=normalizeZone(settings.timezone);
    defaults(overviewFilter);defaults(planFilter);
    await loadFilter(overviewFilter,true);
    if(q("#plans").dataset.loaded!=="true")await new Promise(resolve=>window.addEventListener("plan-time-tracker:plans-rendered",resolve,{once:true}));
    planFilterReady=true;
    await loadFilter(planFilter,false);
  }
  const detail=q("#planDetail");
  let detailEnhancementToken=0;
  async function enhancePlanDetail(id){
    if(!detail||!id)return;
    const token=++detailEnhancementToken;
    detail.dataset.extraReady="true";detail.dataset.extraReadyPlanId=id;
    try{
      const {plan}=await api("/api/plans/"+encodeURIComponent(id)+"");
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
  style.textContent=".tracker-section{display:grid;gap:14px;margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}.tracker-list{display:grid;gap:0}.tracker-card{min-width:0;border-top:1px solid var(--line);padding:16px 0;background:var(--paper-2)}.tracker-card h4{margin:0 0 8px}.tracker-card h4{min-width:0;overflow-wrap:anywhere}.tracker-card p{margin:8px 0;overflow-wrap:anywhere}.tracker-meta{font-size:var(--text-sm);color:var(--muted)}.tracker-form{display:grid;gap:12px}.tracker-form .field{min-width:0}.plan-period-panel>.metrics{margin-top:16px}.tracker-card-toggle{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;width:100%;padding:0;background:transparent;color:inherit;text-align:left;border:0;border-radius:0;white-space:normal}.tracker-card-toggle>strong{flex:1;min-width:0;overflow-wrap:anywhere}.tracker-card-toggle[aria-expanded=false]>strong{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.tracker-card-status{flex:none;font-size:var(--text-sm);color:var(--muted)}.tracker-card-summary{margin-bottom:0!important}.tracker-card-body{min-width:0;padding-top:12px}.tracker-collapse-actions{display:flex;gap:8px;flex-wrap:wrap}.tracker-timeline-actions{display:flex;gap:8px;flex-wrap:wrap}@media(max-width:600px){.tracker-form{grid-template-columns:minmax(0,1fr)}.tracker-timeline-actions button{flex:1 1 100%}}";
  document.head.append(style);
  const make=(tag,text,cls)=>{const element=document.createElement(tag);if(text!==undefined&&text!==null)element.textContent=text;if(cls)element.className=cls;return element;};
  const duration=(value)=>{if(value==null)return "—";let minutes=Math.max(0,Math.round(value/60000));const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),rest=minutes%60;return days?days+" д "+hours+" ч "+rest+" мин":hours?hours+" ч "+rest+" мин":rest+" мин";};
  const date=(value)=>value==null?"—":new Intl.DateTimeFormat("ru-RU",{dateStyle:"medium",timeStyle:"short",timeZone:document.querySelector("#tz")?.value||Intl.DateTimeFormat().resolvedOptions().timeZone}).format(new Date(value));
  const statusNames={PENDING:"Ожидает",RUNNING:"Выполняется",BLOCKED:"Заблокирован",FAILED:"Не выполнен",DONE:"Завершён",OPEN:"Активная попытка",CLOSED:"Закрыта",ABANDONED:"Прервана",PASSED:"Пройдена",NOT_RUN:"Не запускалась"};
  const uuid=()=>crypto.randomUUID();
  async function api(path,options){const response=await fetch(path,{...options,headers:{"content-type":"application/json",...(options&&options.headers||{})},cache:"no-store"});const data=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(data.error&&data.error.message||"HTTP "+response.status);error.status=response.status;error.code=data.error&&data.error.code;error.details=data.error&&data.error.details;throw error;}return data;}
  const pendingCommands=new Map(),rejectedCommands=new Set(),terminalRejectedCommands=new Set(),rejectedVersions=new Map(),retryVersions=new Map();
  const terminalDomainRejections=new Set(["RESULT_REVISION_STALE","LEASE_EXPIRED","STEP_NOT_STARTED","STEP_ALREADY_EXISTS","REWORK_REQUIRED","ATTEMPT_CLOSED","LEASE_FENCED","ACTIVE_ATTEMPT_EXISTS"]);
  async function hasMatchingFinalDomainRejection(envelope,error){if(error.status!==409||!terminalDomainRejections.has(error.code))return false;try{const receipt=await api("/api/tracker/commands/"+encodeURIComponent(envelope.commandId));return receipt.status==="FINAL"&&receipt.commandId===envelope.commandId&&receipt.commandType===envelope.commandType&&receipt.error?.code===error.code&&!receipt.result;}catch{return false;}}
  async function readCurrentVersion(payload){const stepId=payload.stepId;if(stepId){const planId=payload.planId||root.dataset.planId;if(!planId)return null;const snapshot=await api("/api/tracker/plans/"+encodeURIComponent(planId)+"/execution");const step=(snapshot.steps||[]).find(item=>item.step_id===stepId);return step&&Number.isSafeInteger(step.version)?step.version:null;}const planId=payload.planId;if(!planId)return null;const snapshot=await api("/api/plans/"+encodeURIComponent(planId)+"");return Number.isSafeInteger(snapshot.plan&&snapshot.plan.version)?snapshot.plan.version:null;}
  async function command(type,payload,expectedVersion){const key=type+":"+(payload.planId||payload.stepId||payload.attemptId||"new"),scope=payload.stepId||payload.planId||null,retryVersion=expectedVersion!==undefined?retryVersions.get(key):undefined,effectiveVersion=Number.isSafeInteger(retryVersion)?Math.max(expectedVersion,retryVersion):expectedVersion,identity={payload,expectedVersion:effectiveVersion};let envelope=pendingCommands.get(key);if(envelope&&!rejectedCommands.has(key)&&!rejectedVersions.has(key)&&!terminalRejectedCommands.has(key)&&JSON.stringify(envelope.payload)===JSON.stringify(payload))identity.expectedVersion=envelope.expectedVersion;if(envelope&&terminalRejectedCommands.has(key)){envelope=null;pendingCommands.delete(key);terminalRejectedCommands.delete(key)}if(envelope&&rejectedCommands.has(key)&&JSON.stringify({payload:envelope.payload,expectedVersion:envelope.expectedVersion})!==JSON.stringify(identity)){envelope=null;pendingCommands.delete(key);rejectedCommands.delete(key)}if(envelope&&rejectedVersions.has(key)){envelope=null;pendingCommands.delete(key);rejectedVersions.delete(key)}if(envelope&&!rejectedCommands.has(key)&&JSON.stringify({payload:envelope.payload,expectedVersion:envelope.expectedVersion})!==JSON.stringify(identity)){const error=new Error("Исход предыдущей команды неизвестен. Сначала повторите её без изменения данных.");error.code="COMMAND_OUTCOME_UNKNOWN";throw error}if(!envelope){envelope={schemaVersion:1,commandId:uuid(),commandType:type,payload};if(identity.expectedVersion!==undefined)envelope.expectedVersion=identity.expectedVersion;pendingCommands.set(key,envelope)}try{const response=await api("/api/commands",{method:"POST",body:JSON.stringify(envelope)});if(response?.commandId!==envelope.commandId||response.outcome!=="OK"||typeof response.applied!=="boolean"||typeof response.replayed!=="boolean"||response.applied===response.replayed||!response.result||typeof response.result!=="object"||Array.isArray(response.result)||response.error){const error=new Error("Ответ команды не подтверждает её результат. Повторите запрос без изменения данных.");error.code="COMMAND_OUTCOME_UNKNOWN";throw error}pendingCommands.delete(key);rejectedCommands.delete(key);terminalRejectedCommands.delete(key);rejectedVersions.delete(key);retryVersions.delete(key);return response.result}catch(error){if(error.code==="VALIDATION_ERROR")rejectedCommands.add(key);else if(await hasMatchingFinalDomainRejection(envelope,error))terminalRejectedCommands.add(key);if(error.code==="VERSION_CONFLICT"&&scope){try{const currentVersion=await readCurrentVersion(payload);if(Number.isSafeInteger(currentVersion)){rejectedVersions.set(key,currentVersion);retryVersions.set(key,currentVersion);}}catch{}}throw error;}}
  function refreshAcceptedPlan(planId,successMessage){return new Promise((resolve,reject)=>window.dispatchEvent(new CustomEvent("plan-time-tracker:refresh-plan",{detail:{planId,successMessage,resolve,reject}})));}
  function inputField(labelText,options){const wrap=make("div",null,"field"),label=make("label",labelText),control=make(options&&options.tag||"input");control.type=options&&options.type||"text";if(options&&options.maxLength)control.maxLength=options.maxLength;if(options&&options.required)control.required=true;if(options&&options.placeholder)control.placeholder=options.placeholder;if(options&&options.value!==undefined)control.value=options.value;if(options&&options.rows)control.rows=options.rows;control.dataset.draftField=options&&options.key||labelText;const id="tracker-"+uuid();control.id=id;label.htmlFor=id;wrap.append(label,control);return {wrap,control};}
  function selectField(labelText,values,selected){const wrap=make("div",null,"field"),label=make("label",labelText),control=make("select"),id="tracker-"+uuid();control.dataset.draftField=labelText;control.id=id;label.htmlFor=id;values.forEach((value)=>{const option=make("option",statusNames[value]||value);option.value=value;option.selected=value===selected;control.append(option);});wrap.append(label,control);return {wrap,control};}
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
  function readinessText(step){return step.status==="DONE"?"":"Этап ещё не завершён";}
  function sectionFor(id){const section=make("section",null,"tracker-section");section.dataset.trackerPanel="true";section.dataset.planId=id;section.setAttribute("aria-labelledby","tracker-heading");return section;}
  let renderToken=0,loadingPlanId=null,pendingSuccessFeedback="",pendingSuccessPlanId=null;
  async function renderTracker(force){const planId=root.dataset.planId;if(!planId)return;if(pendingSuccessPlanId!==planId){pendingSuccessFeedback="";pendingSuccessPlanId=planId;}const current=root.querySelector("[data-tracker-panel]");if(!force&&current&&current.dataset.planId===planId)return;if(!force&&loadingPlanId===planId)return;const token=++renderToken;loadingPlanId=planId;if(current){captureDrafts(current);const prior=current.querySelector('[role="status"][aria-live="polite"]');if(current.dataset.planId===planId&&prior&&prior.textContent.trim()&&prior.textContent!=="Загружаю этапы…"&&!prior.classList.contains("error"))pendingSuccessFeedback=prior.textContent;current.remove();}const panel=sectionFor(planId),heading=make("h3","Этапы плана"),refresh=make("button","Обновить этапы");refresh.type="button";refresh.addEventListener("click",()=>renderTracker(true));heading.id="tracker-heading";panel.append(heading,refresh);const message=make("p","Загружаю этапы…","muted");message.setAttribute("role","status");message.setAttribute("aria-live","polite");panel.append(message);if(root.querySelector(".plan-metadata"))root.insertBefore(panel,root.querySelector(".plan-metadata"));else root.append(panel);
    try{const snapshot=await api("/api/tracker/plans/"+encodeURIComponent(planId)+"/execution");if(token!==renderToken||root.dataset.planId!==planId)return;panel.replaceChildren(heading,refresh);panel.append(message);setMessage(message,snapshot.plan.deletedAt!=null?"План удалён. Этапы доступны только для чтения.":"");if(pendingSuccessFeedback){setMessage(message,pendingSuccessFeedback);pendingSuccessFeedback="";}window.dispatchEvent(new CustomEvent("plan-time-tracker:completion-updated",{detail:snapshot.plan}));const documentPlan=typeof snapshot.plan.planText==="string";panel.classList.add("document-plan");heading.textContent=documentPlan?"План":"Этапы плана";const steps=snapshot.steps||[];const incompletes=steps.filter((step)=>!step.readyToFinish);      const stepList=make("div",null,"tracker-list");if(!steps.length)stepList.append(make("p","В этом плане пока нет этапов.","muted"));if(documentPlan)renderDocumentContent(stepList,steps,snapshot.plan,planId,message,()=>renderTracker(true));else for(const step of steps)stepList.append(renderDocumentStep(step,snapshot.plan,planId,message,()=>renderTracker(true)));panel.append(stepList);if(documentPlan){const source=make("details",null,"plan-source"),sourceTitle=make("summary","Исходный текст"),text=make("textarea");text.readOnly=true;text.value=snapshot.plan.planText;text.setAttribute("aria-label","Исходный текст плана");text.rows=12;source.append(sourceTitle,text);panel.append(source);}if(steps.length){const collapseActions=make("div",null,"tracker-collapse-actions");for(const [label,expanded] of [["Свернуть все",false],["Развернуть все",true]]){const button=make("button",label);button.type="button";button.addEventListener("click",()=>stepList.querySelectorAll("[data-checkpoint-toggle]").forEach(toggle=>toggle.setExpanded(expanded)));collapseActions.append(button);}stepList.before(collapseActions);}restoreDrafts(panel);
      if(snapshot.plan.deletedAt==null&&incompletes.length&&["RUNNING","PAUSED"].includes(snapshot.plan.status)){const finishForm=make("form",null,"tracker-form"),finishReason=inputField("Почему завершаем с незавершёнными этапами",{tag:"textarea",required:true,maxLength:1000,rows:2}),finish=make("button","Завершить досрочно","danger");finish.type="submit";draftForm(finishForm,"finish-exception");finishForm.append(make("p","Условия завершения не выполнены: "+incompletes.map((step)=>step.title+(readinessText(step)?" — "+readinessText(step):"")).join("; ")),finishReason.wrap,finish);finishForm.addEventListener("submit",async(event)=>{event.preventDefault();if(!window.confirm("Завершить план с зафиксированным исключением? Таймер будет остановлен."))return;let accepted=false;const submittedDraft=snapshotDraft(finishForm,planId);finish.disabled=true;try{await command("FinishPlan",{planId:planId,allowIncomplete:true,reason:finishReason.control.value},snapshot.plan.version);accepted=true;clearDraft(submittedDraft);setMessage(message,"План завершён с сохранённым исключением.");await renderTracker(true);try{await refreshAcceptedPlan(planId,"План завершён с сохранённым исключением.");}catch{if(root.dataset.planId===planId)setMessage(root.querySelector("[data-tracker-panel] [role=status]")||message,"План завершён, но данные не обновились. Перезагрузите страницу.",true);}}catch(error){setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{finish.disabled=accepted;}});const exception=make("details",null,"finish-exception");exception.dataset.trackerDisclosure="finish-exception";exception.append(make("summary","Завершить с незавершёнными этапами"),finishForm);panel.append(exception);restoreDrafts(exception.parentElement);}
    }catch(error){if(token===renderToken)setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{if(token===renderToken)loadingPlanId=null;}}
  // Render Markdown with DOM nodes: raw HTML and executable URLs stay text.
  function inlineMarkdown(target,text){
    const pattern=/(\x60+)([^\x60]+)\1|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^\s)]+)\)/g;let cursor=0;
    for(const match of text.matchAll(pattern)){
      target.append(document.createTextNode(text.slice(cursor,match.index)));
      if(match[1])target.append(make("code",match[2]));
      else if(match[3])target.append(make("strong",match[3]));
      else {let url;try{url=new URL(match[5],location.href);}catch{}if(url&&["http:","https:"].includes(url.protocol)){const link=make("a",match[4]);link.href=url.href;target.append(link);}else target.append(document.createTextNode(match[0]));}
      cursor=match.index+match[0].length;
    }
    target.append(document.createTextNode(text.slice(cursor)));
  }
  function markdown(text){
    const container=make("div",null,"plan-prose"),lines=text.replace(/\r\n/g,"\n").split("\n");let paragraph=[],listStack=[],fence=null,codeLines=[];
    const flush=()=>{if(paragraph.length){const p=make("p");inlineMarkdown(p,paragraph.join("\n"));container.append(p);paragraph=[];}};
    const endLists=()=>{listStack=[];};
    const cells=line=>line.trim().replace(/^\||\|$/g,"").split(/(?<!\\)\|/).map(x=>x.trim().replace(/\\\|/g,"|"));
    for(let i=0;i<lines.length;i++){
      const line=lines[i],code=line.match(/^ {0,3}(\x60{3,}|~{3,})(.*)$/);
      if(fence){if(code&&code[1][0]===fence[0]&&code[1].length>=fence.length&&!code[2].trim()){const pre=make("pre");pre.append(make("code",codeLines.join("\n")));container.append(pre);fence=null;codeLines=[];}else codeLines.push(line);continue;}
      if(code){flush();endLists();fence=code[1];continue;}
      if(!line.trim()){flush();endLists();continue;}
      const heading=line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
      if(heading){flush();endLists();const h=make("h"+Math.min(4,heading[1].length+1));inlineMarkdown(h,heading[2]);container.append(h);continue;}
      if(i+1<lines.length&&line.includes("|")&&/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i+1])){
        flush();endLists();const wrap=make("div",null,"plan-table-scroll"),table=make("table"),head=make("thead"),row=make("tr"),body=make("tbody");wrap.tabIndex=0;wrap.setAttribute("role","region");wrap.setAttribute("aria-label","Таблица плана");for(const text of cells(line)){const th=make("th");th.scope="col";inlineMarkdown(th,text);row.append(th);}head.append(row);i+=2;for(;i<lines.length&&lines[i].trim()&&lines[i].includes("|");i++){const tr=make("tr");for(const text of cells(lines[i])){const td=make("td");inlineMarkdown(td,text);tr.append(td);}body.append(tr);}i--;table.append(head,body);wrap.append(table);container.append(wrap);continue;
      }
      const item=line.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
      if(item){flush();const depth=item[1].length,tag=/\d/.test(item[2])?"ol":"ul";while(listStack.length&&(listStack.at(-1).depth>depth||listStack.at(-1).depth===depth&&listStack.at(-1).tag!==tag))listStack.pop();if(!listStack.length||listStack.at(-1).depth<depth){const list=make(tag);if(tag==="ol")list.start=parseInt(item[2],10);const parent=listStack.at(-1)?.last||container;parent.append(list);listStack.push({depth,tag,list,last:null});}const li=make("li");inlineMarkdown(li,item[3]);listStack.at(-1).list.append(li);listStack.at(-1).last=li;continue;}
      if(/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)){flush();endLists();container.append(make("hr"));continue;}
      if(listStack.length&&/^\s{2,}\S/.test(line)){inlineMarkdown(listStack.at(-1).last,"\n"+line.trim());continue;}
      endLists();paragraph.push(line);
    }
    flush();if(fence){const pre=make("pre");pre.append(make("code",codeLines.join("\n")));container.append(pre);}return container;
  }
  function renderDocumentStep(step,plan,planId,message,reload){
    const card=make("article",null,"tracker-card document-step"),heading=make("h3"),toggle=make("button",null,"tracker-card-toggle"),title=make("strong",step.title),statusLabel=make("span",statusNames[step.status],"tracker-card-status"),indicator=make("span"),body=make("div",null,"tracker-card-body");
    card.dataset.stepId=step.step_id;body.id="tracker-card-"+step.step_id;toggle.type="button";toggle.dataset.checkpointToggle=step.step_id;toggle.setAttribute("aria-controls",body.id);indicator.setAttribute("aria-hidden","true");toggle.append(title,statusLabel,indicator);heading.append(toggle);card.append(heading,body);
    const state=stateFor(planId),setExpanded=expanded=>{state.cards.set(step.step_id,expanded);toggle.setAttribute("aria-expanded",String(expanded));body.hidden=!expanded;indicator.textContent=expanded?"▾":"▸";};toggle.setExpanded=setExpanded;setExpanded(state.cards.get(step.step_id)??true);toggle.addEventListener("click",()=>setExpanded(toggle.getAttribute("aria-expanded")!=="true"));
    if(plan.deletedAt==null&&plan.status==="RUNNING"){
      const form=draftForm(make("form",null,"tracker-form step-status-form"),"status:"+step.step_id),field=selectField("Статус этапа",["PENDING","RUNNING","BLOCKED","FAILED","DONE"],step.status),save=make("button","Сохранить статус"),errorText=make("p",null,"form-error");for(const option of field.control.options)option.textContent=statusNames[option.value];save.type="submit";errorText.setAttribute("role","alert");form.append(field.wrap,save,errorText);form.addEventListener("submit",async event=>{event.preventDefault();const submission=snapshotDraft(form,planId);save.disabled=true;try{await command("SetStepStatus",{stepId:step.step_id,status:field.control.value},step.version);clearDraft(submission);pendingSuccessFeedback="Статус этапа сохранён.";pendingSuccessPlanId=planId;await reload();}catch(error){setMessage(errorText,(error.code||"ERROR")+": "+error.message,true);}finally{save.disabled=false;}});body.append(form);
    }
    // Skip the original stage heading because the disclosure already carries it.
    body.append(markdown(typeof plan.planText==="string"?step.content.replace(/^.*(?:\r?\n|$)/,""):step.content));restoreDrafts(card);return card;
  }
  function renderDocumentContent(list,steps,plan,planId,message,reload){let cursor=0;for(const step of steps){const start=plan.planText.indexOf(step.content,cursor);if(start>cursor)list.append(markdown(plan.planText.slice(cursor,start)));list.append(renderDocumentStep(step,plan,planId,message,reload));cursor=start+step.content.length;}if(cursor<plan.planText.length)list.append(markdown(plan.planText.slice(cursor)));}

  window.addEventListener("plan-time-tracker:plan-rendered",event=>{if(event.detail?.planId===root.dataset.planId)restoreDrafts(root);if(event.detail?.planId===root.dataset.planId&&event.detail.successMessage){pendingSuccessPlanId=event.detail.planId;pendingSuccessFeedback=event.detail.successMessage;}});
  const observer=new MutationObserver(()=>{renderTracker(false).catch(()=>{});});observer.observe(root,{childList:true});
})();`;

const UI_ATLM = String.raw`(()=>{
  const planRoot=document.querySelector("#planDetail"),settingsRoot=document.querySelector("#view-settings .settings-grid");
  if(!planRoot||!settingsRoot)return;
  const make=(tag,text,cls)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;};
  const button=(text,action)=>{const el=make("button",text);el.type="button";el.addEventListener("click",action);return el;};
  const minutes=value=>new Intl.NumberFormat("ru-RU",{maximumFractionDigits:1}).format(value/60000)+" мин";
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
  const reasons={COLLECTING_DATA:"Пока недостаточно проверенных завершённых планов.",INCOMPLETE_FEATURES:"Для прогноза не хватает исходных сведений о задаче.",UNSUPPORTED_CATEGORY:"В накопленной истории ещё нет опыта для этого вида задачи.",MODEL_INVALIDATED:"Исходные данные модели изменились; требуется пересборка.",INVALID_PREDICTION:"Модель не смогла получить корректную оценку.",UNSUPPORTED_FORECAST_SCOPE:"Прогноз доступен для полного плана до первого запуска.",DATASET_LIMIT_REACHED:"Накопленные данные сохранены, но превышен текущий предел обучения.",RANK_DEFICIENT:"Данных пока недостаточно для независимой оценки влияния признаков.",INSUFFICIENT_DATA:"Пока недостаточно пригодных данных для обучения и проверки.",INSUFFICIENT_VALIDATION:"Пока недостаточно случаев для проверки новой модели.",INSUFFICIENT_EVALUATION_CASES:"Нужно не менее пяти случаев с прогнозами, проверенными на более поздних результатах.",INSUFFICIENT_INCUMBENT_CASES:"Нужно не менее пяти новых случаев для сравнения с действующей моделью.",MEDIAN_BASELINE_BETTER:"Новая модель ошибается сильнее обычной медианы прошлых длительностей.",CANDIDATE_COVERAGE_WORSE:"Новая модель даёт прогноз для меньшей доли задач, чем действующая.",CANDIDATE_MAE_WORSE:"Средняя ошибка новой модели выше, чем у действующей.",SNAPSHOT_INVALIDATED:"Исходные данные изменились; подготовлена новая попытка обучения.",LEASE_EXPIRED:"Предыдущая обработка не завершилась вовремя; её состояние сохранено.",TRAINING_EXECUTION_FAILED:"Во время обучения произошёл технический сбой.",SOURCE_UNAVAILABLE:"Источник данных временно недоступен.",INVALID_ESTIMATION_SOURCE:"Сохранённый источник оценки не удалось проверить.",MISSING_FEATURES:"До первого запуска не сохранены исходные признаки.",INVALID_FEATURES:"Исходные признаки не соответствуют схеме.",PLAN_DELETED:"План удалён.",PLAN_NOT_COMPLETED:"План ещё не завершён.",RESULT_NOT_VERIFIED:"Результат и обязательные проверки не подтверждены.",SCOPE_CHANGED:"После начала изменился объём задачи.",INCOMPLETE_MEASUREMENT:"Нет полного подтверждённого измерения активного времени."};
  const statuses={IDLE:"Ожидание новых планов",QUEUED:"Обучение в очереди",RUNNING:"Модель обучается",RETRY_WAIT:"Ожидание повторной попытки",COLLECTING_DATA:"Накапливаем опыт",REJECTED:"Новая модель не прошла проверку",FAILED:"Не удалось завершить обучение"};
  const style=make("style");style.textContent=".atlm-panel{min-width:0;overflow-wrap:anywhere}.atlm-panel p{margin:9px 0}.atlm-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}.atlm-heading h2,.atlm-heading h3{margin:0}.atlm-panel button{min-height:42px;white-space:normal}.atlm-controls{display:flex;gap:8px;flex-wrap:wrap}.atlm-point{font-size:1.35rem;font-weight:700;color:var(--ink)}.atlm-plan-estimate{margin:18px 0;padding:16px;border:1px solid var(--line-strong,var(--line));border-radius:var(--radius,10px);background:var(--paper-3,var(--panel))}.atlm-note{color:var(--ink-2,var(--muted));font-size:.9rem}.atlm-stale{border-left:3px solid var(--amber,var(--amber));padding-left:10px}@media(max-width:390px){.atlm-heading{align-items:flex-start}.atlm-controls{width:100%}.atlm-controls button{flex:1 1 100%}}";document.head.append(style);
  let supported=false,capabilityPending=false,planToken=0,planAbort=null,statusPending=null,pollTimer=null,pollsLeft=0,autoBudget=8,processPending=false,lastProcessFailure=null;
  const processed=new Set();
  const statusPanel=make("article",null,"panel atlm-panel");statusPanel.id="atlm-model-status";statusPanel.setAttribute("aria-labelledby","atlm-model-heading");
  const statusHeading=make("h2","Накопление опыта");statusHeading.id="atlm-model-heading";
  const statusBody=make("div");statusBody.setAttribute("role","status");statusBody.setAttribute("aria-live","polite");
  const refreshStatus=button("Обновить состояние обучения",()=>loadStatus(false));
  const resume=button("Продолжить обработку",()=>{autoBudget=8;processed.clear();lastProcessFailure=null;pollsLeft=3;loadStatus(true);});resume.hidden=true;
  const controls=make("div",null,"atlm-controls");controls.append(refreshStatus,resume);statusPanel.append(statusHeading,statusBody,controls);
  async function api(path,options={}){
    const response=await fetch(path,{cache:"no-store",...options,headers:{"content-type":"application/json",...options.headers}});
    const data=await response.json().catch(()=>null);
    if(!response.ok){const error=new Error(data?.error?.message||"Не удалось получить ответ сервера.");error.code=data?.error?.code;throw error;}
    if(!data||typeof data!=="object")throw new Error("Сервер вернул неполный ответ. Повторите загрузку.");return data;
  }
  function reasonText(reason){return reasons[reason]||"Причина: "+String(reason)+".";}
  function showStatus(data){
    if(!data.training||!statuses[data.training.status]||![data.newPlansSinceTraining,data.eligibleSampleCount,data.excludedSampleCount].every(value=>Number.isSafeInteger(value)&&value>=0)||!Number.isSafeInteger(data.retrainEveryNewPlans)||data.retrainEveryNewPlans<1||typeof data.training.due!=="boolean"||!Object.hasOwn(data,"activeModel")||(data.activeModel!==null&&(!Number.isSafeInteger(data.activeModel.sampleCount)||data.activeModel.sampleCount<1)))throw new Error("Не удалось прочитать состояние обучения.");
    const exclusionsOpen=statusBody.querySelector("details")?.open===true;
    statusBody.replaceChildren();statusBody.append(make("p",statuses[data.training.status]));
    statusBody.append(make("p",count(data.newPlansSinceTraining)+" новых пригодных планов из "+data.retrainEveryNewPlans+" до следующей попытки обучения."));
    statusBody.append(make("p","Всего пригодных планов: "+count(data.eligibleSampleCount)+". Исключено: "+count(data.excludedSampleCount)+".","atlm-note"));
    if(Array.isArray(data.exclusionReasons)&&data.exclusionReasons.length){
      const disclosure=make("details"),list=make("ul");disclosure.open=exclusionsOpen;disclosure.append(make("summary","Почему планы не учитываются"));
      for(const item of data.exclusionReasons)if(typeof item.reason==="string"&&Number.isSafeInteger(item.count)&&item.count>0)list.append(make("li",reasonText(item.reason)+" Планов: "+item.count+"."));
      disclosure.append(list,make("p","У одного плана может быть несколько причин.","atlm-note"));statusBody.append(disclosure);
    }
    if(data.activeModel)statusBody.append(make("p","Действующая модель: "+String(data.activeModel.modelVersion||data.activeModel.modelId)+". В обучении использовано планов: "+count(data.activeModel.sampleCount)+".","atlm-note"));
    else statusBody.append(make("p","Первой модели может понадобиться больше пяти планов: нужны данные для обучения и отдельной проверки.","atlm-note"));
    if(data.training.status==="REJECTED"&&data.activeModel)statusBody.append(make("p","Предыдущая пригодная модель продолжает давать прогнозы.","atlm-note"));
    if(data.training.progress&&Number.isSafeInteger(data.training.progress.totalCases)&&data.training.progress.totalCases>0)statusBody.append(make("p","Проверено случаев: "+count(data.training.progress.completedCases)+" из "+data.training.progress.totalCases+".","atlm-note"));
    if(data.training.status==="RETRY_WAIT"&&Number.isFinite(data.training.nextAttemptAt))statusBody.append(make("p","Повторная попытка не раньше "+new Intl.DateTimeFormat("ru-RU",{dateStyle:"short",timeStyle:"short",timeZone:document.querySelector("#tz")?.value||"UTC"}).format(new Date(data.training.nextAttemptAt))+".","atlm-note"));
    const reason=data.lastError||data.lastReason;if(reason)statusBody.append(make("p",reasonText(reason),data.lastError?"error":"atlm-note"));
    if(lastProcessFailure)statusBody.append(make("p",lastProcessFailure,"error"));
    resume.hidden=!data.training.due||(autoBudget>0&&!processed.has(queueKey(data)));resume.disabled=processPending;
  }
  function queueKey(data){const t=data.training;return JSON.stringify([data.datasetRevision,t.generation,t.progressRevision,t.pendingRefreshCount,t.nextAttemptAt]);}
  function schedulePoll(){clearTimeout(pollTimer);if(pollsLeft>0){pollsLeft--;pollTimer=setTimeout(()=>loadStatus(true),750);}}
  function loadStatus(allowProcess=true){
    if(!supported)return Promise.resolve();if(statusPending)return statusPending;
    statusPanel.setAttribute("aria-busy","true");refreshStatus.disabled=true;
    statusPending=(async()=>{
      try{
        const data=await api("/api/tracker/estimation-model");showStatus(data);
        const key=queueKey(data);
        if(allowProcess&&data.training.due&&!processPending&&autoBudget>0&&!processed.has(key)){
          processed.add(key);autoBudget--;processPending=true;resume.disabled=true;
          try{await api("/api/tracker/estimation-model/process",{method:"POST",body:"{}"});lastProcessFailure=null;pollsLeft=Math.max(pollsLeft,3);}
          catch(error){lastProcessFailure="Не удалось продолжить обучение. "+error.message;statusBody.append(make("p",lastProcessFailure,"error"));resume.hidden=false;}
          finally{processPending=false;resume.disabled=false;}
          schedulePoll();
        }else if(allowProcess&&(data.training.status==="RUNNING"||data.training.due))schedulePoll();
      }catch(error){statusBody.replaceChildren(make("p","Не удалось загрузить состояние обучения. "+error.message,"error"));resume.hidden=true;}
      finally{statusPending=null;refreshStatus.disabled=false;statusPanel.removeAttribute("aria-busy");}
    })();return statusPending;
  }
  async function loadPlan(planId){
    if(!supported||!planId||planRoot.dataset.planId!==planId)return;
    const token=++planToken;planAbort?.abort();planAbort=new AbortController();
    planRoot.querySelector(".atlm-plan-estimate")?.remove();
    const panel=make("section",null,"atlm-panel atlm-plan-estimate");panel.dataset.planId=planId;panel.setAttribute("aria-labelledby","atlm-plan-heading");panel.setAttribute("aria-busy","true");
    const heading=make("h3","Прогноз активного времени");heading.id="atlm-plan-heading";
    const toolbar=make("div",null,"atlm-heading"),refresh=button("Обновить прогноз",()=>loadPlan(planId));toolbar.append(heading,refresh);
    const body=make("div","Загружаю сохранённую оценку…");body.setAttribute("role","status");body.setAttribute("aria-live","polite");panel.append(toolbar,body);planRoot.insertBefore(panel,planRoot.children[2]||null);
    refresh.disabled=true;
    try{
      const data=await api("/api/tracker/plans/"+encodeURIComponent(planId)+"/estimate",{signal:planAbort.signal});
      if(token!==planToken||planRoot.dataset.planId!==planId||!panel.isConnected)return;
      if(data.planId!==planId)throw new Error("Ответ относится к другому плану. Повторите загрузку.");
      if(!Object.hasOwn(data,"serverEstimation")||typeof data.isStale!=="boolean")throw new Error("Сервер вернул неполную оценку. Повторите загрузку.");
      body.replaceChildren();const estimate=data.serverEstimation;
      if(estimate==null){body.append(make("p","Исходная оценка до запуска не сохранена.","atlm-note"));}
      else if(estimate.status==="AVAILABLE"&&Number.isFinite(estimate.pointMs)&&estimate.pointMs>=0){
        body.append(make("p","Около "+minutes(estimate.pointMs),"atlm-point"));
        body.append(make("p","Полное активное время от первого запуска. Паузы исключены; подготовка оценки до запуска не входит.","atlm-note"));
        if(estimate.modelVersion||estimate.modelId)body.append(make("p","Модель: "+String(estimate.modelVersion||estimate.modelId)+".","atlm-note"));
        const evaluation=estimate.evaluation;
        if(evaluation&&Number.isFinite(evaluation.maeMs)&&evaluation.maeMs>=0&&Number.isSafeInteger(evaluation.caseCount)&&evaluation.caseCount>0)body.append(make("p","Средняя ошибка прошлых проверок: "+minutes(evaluation.maeMs)+". Проверено случаев: "+count(evaluation.caseCount)+". Это не гарантия длительности.","atlm-note"));
      }else if(estimate.status==="UNAVAILABLE"){
        body.append(make("p",reasonText(estimate.unavailableReason||"COLLECTING_DATA"),"atlm-note"));
        body.append(make("p","Исходные признаки сохраняются; разрешённую работу можно продолжать.","atlm-note"));
      }else throw new Error("Сервер вернул некорректную оценку.");
      if(data.isStale)body.append(make("p","Оценка устарела: изменился объём задачи или исходные данные модели. Сохранённое значение показано для истории.","atlm-stale"));
    }catch(error){if(token!==planToken||planRoot.dataset.planId!==planId||error.name==="AbortError")return;body.replaceChildren(make("p","Не удалось загрузить прогноз. "+error.message,"error"));}
    finally{if(token===planToken&&panel.isConnected){refresh.disabled=false;panel.removeAttribute("aria-busy");}}
  }
  async function discover(){
    if(capabilityPending)return;capabilityPending=true;
    try{const capabilities=await api("/api/tracker/capabilities");supported=!!capabilities.assessments?.atlm;if(!supported){statusPanel.remove();return;}if(!statusPanel.isConnected)settingsRoot.append(statusPanel);pollsLeft=3;await loadStatus(true);if(planRoot.dataset.planId)await loadPlan(planRoot.dataset.planId);}
    catch(error){if(!statusPanel.isConnected)settingsRoot.append(statusPanel);statusBody.replaceChildren(make("p","Не удалось проверить поддержку прогноза. "+error.message,"error"),button("Повторить проверку прогноза",discover));controls.hidden=true;}
    finally{capabilityPending=false;if(supported)controls.hidden=false;}
  }
  window.addEventListener("plan-time-tracker:plan-will-render",()=>{planToken++;planAbort?.abort();});
  window.addEventListener("plan-time-tracker:plan-rendered",event=>{loadPlan(event.detail?.planId);loadStatus(true);});
  document.querySelector('[data-view="settings"]')?.addEventListener("click",()=>{pollsLeft=3;loadStatus(true);});
  window.addEventListener("pagehide",()=>{clearTimeout(pollTimer);planAbort?.abort();});
  discover();
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
    "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"description\" content=\"Планы, этапы и время работы. Сохраните план целиком и отмечайте ход выполнения.\"><meta name=\"color-scheme\" content=\"light\"><title>Трекер планов</title>",
    "<style>/* Hallmark v2 · theme: console · console: paper · scope: app · redesign: polish */\n/* Hallmark · pre-emit critique: P4 H4 E4 S4 R4 V3 · weakest: V, preserve the existing shell and use the original plan as the reading surface. */\n/* Existing shell and chart spacing stays within the established app layout; this change fixes typography and plan content. */\n/* Hallmark · dismissed F6 · Heading/status selectors contain digits but carry text, not measured figures. */\n/* Hallmark · answered F7 · Inputs share a surface because they are the same form-control role; plan prose is unboxed. */\n:root{font-family:Inter,system-ui,sans-serif;color:var(--ink);background:var(--paper);--muted:var(--muted);--line:var(--line);--green:var(--amber);--panel:var(--paper-2)}*{box-sizing:border-box}body{margin:0}.shell{max-width:1100px;margin:auto;padding:34px 22px 70px}.top{display:flex;justify-content:space-between;gap:20px;margin-bottom:25px}h1{letter-spacing:-.04em;font-size:clamp(1.7rem,4vw,2.3rem);margin:.35rem 0}.muted{color:var(--muted)}button,input,textarea,select{font:inherit}button{border:0;border-radius:9px;padding:.65rem .9rem;font-weight:700;cursor:pointer;background:var(--paper-3);color:var(--ink)}button:focus-visible,.row[role=button]:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid var(--amber-text);outline-offset:2px}.primary{background:var(--green);color:var(--paper-2)}.danger{color:var(--red);background:var(--red-soft)}.nav{display:flex;gap:7px;border-bottom:1px solid var(--line);margin-bottom:21px;overflow:auto}.nav button{background:none;color:var(--muted);white-space:nowrap;border-radius:0;border-bottom:2px solid transparent}.nav button[aria-current=page]{color:var(--ink);border-color:var(--green)}.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:16px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:20px;margin-bottom:16px}h2{font-size:1.1rem;margin:0 0 14px}.current{min-height:210px}.active-plan+.active-plan{border-top:1px solid var(--line);margin-top:20px;padding-top:16px}.active-plan h3{margin:0}.active-plan .plan-open{font-weight:700;overflow-wrap:anywhere}.active-plan .timer{color:var(--ink)}.timer{font-size:clamp(2rem,6vw,3rem);font-weight:780;letter-spacing:-.06em;font-variant-numeric:tabular-nums;margin:15px 0}.badge{display:inline-block;border-radius:99px;padding:.3rem .58rem;background:var(--blue-soft);color:var(--blue);font-size:.78rem;font-weight:750}.badge.paused{background:var(--amber-soft);color:var(--amber-text)}.badge.completed{background:var(--paper-3);color:var(--muted)}.actions,.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.metric{border:1px solid var(--line);border-radius:11px;padding:13px}.metric small{display:block;color:var(--muted);margin-bottom:7px}.metric strong{font-variant-numeric:tabular-nums}.list{display:grid;gap:8px}.row{display:flex;justify-content:space-between;align-items:center;gap:12px;border:1px solid var(--line);background:var(--paper-2);border-radius:11px;padding:13px}.row-title{font-weight:720}.plan-open{background:transparent;color:inherit;padding:0;border-radius:0;text-align:left;font-weight:inherit;flex:1;min-width:0}.row-meta{display:block;font-size:.82rem;color:var(--muted);margin-top:4px;font-weight:400}.row-right{display:flex;gap:8px;align-items:center}.field{display:grid;gap:6px;min-width:130px;flex:1}.field label{font-weight:700;font-size:.85rem}.field input,.field textarea,.field select{border:1px solid var(--line);border-radius:8px;padding:.65rem;background:var(--paper-2);color:var(--ink)}.field textarea{min-height:75px}.form{display:grid;gap:12px}.hidden{display:none!important}.notice{padding:11px 13px;border:1px solid var(--amber-soft);background:var(--amber-soft);border-radius:9px;margin:12px 0;color:var(--amber-text)}.error{color:var(--red);background:var(--red-soft);border-color:var(--red-soft)}.chart{display:grid;gap:8px;margin-top:16px}.barrow{display:grid;grid-template-columns:95px 1fr 75px;align-items:center;gap:9px;font-size:.82rem}.bar{height:10px;background:var(--paper-3);border-radius:20px;overflow:hidden}.bar span{height:100%;display:block;background:var(--amber)}.modal{position:fixed;inset:0;background:var(--overlay);display:grid;place-items:center;padding:18px}.modalbox{background:var(--paper-2);border-radius:14px;padding:20px;width:min(620px,100%);max-height:90vh;overflow:auto}.toast{position:fixed;bottom:18px;right:18px;background:var(--ink);color:var(--paper-2);border-radius:9px;padding:12px 16px;max-width:min(450px,calc(100% - 36px))}.toast.error{background:var(--red);color:var(--paper-2)}@media(max-width:720px){.shell{padding:22px 14px 55px}.grid{grid-template-columns:1fr}.panel{padding:16px}.row{align-items:flex-start}.row-right{align-items:flex-end;flex-direction:column}.barrow{grid-template-columns:75px 1fr 65px}}@media(max-width:390px){.actions button{flex:1}.top{gap:8px}}@media(max-width:600px){.metrics{grid-template-columns:1fr}} .grid>*{min-width:0}.field{min-width:0}.field input,.field select,.field textarea,.form>input,.form>textarea{width:100%;min-width:0;max-width:100%}.form>input,.form>textarea{border:1px solid var(--line);border-radius:8px;padding:.65rem}.toolbar:has(.field){display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));align-items:end}.toolbar:has(.field)>button{min-height:44px}#view-overview>.panel:has(#overviewFrom)>.metrics{margin-top:16px}#view-overview>.panel:has(#overviewFrom)>.list{margin-top:16px}.row>*{min-width:0}.row-title,.row-meta,.row a,.row>span,#planDetail p,h2,h3,#who{overflow-wrap:anywhere}.nav{padding:4px}.nav button:focus-visible,a:focus-visible{outline:3px solid var(--amber-text);outline-offset:2px}.modal{z-index:20}.modalbox{max-height:calc(100dvh - 36px);overscroll-behavior:contain}.toast{z-index:30}button:disabled{cursor:not-allowed;opacity:.55}.form-error{color:var(--red);background:var(--red-soft);border:1px solid var(--red-soft);padding:10px;border-radius:8px}.form-error:empty{display:none}@media(max-width:600px){.top{flex-direction:column}.row{flex-wrap:wrap}.row>.plan-open{flex:1 1 100%}.row>.row-right{width:100%;justify-content:flex-start;flex-direction:row;flex-wrap:wrap}.modal{padding:10px}.modalbox{padding:16px;max-height:calc(100dvh - 20px)}.toolbar:has(.field){grid-template-columns:minmax(0,1fr)}.actions>button{min-height:44px}}@media(max-width:600px){.row>.row-right{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:stretch;gap:8px}.row>.row-right>.badge{grid-column:1/-1;justify-self:start}.row>.row-right>button{min-width:0;min-height:44px;overflow-wrap:anywhere}.row>.row-right>button:last-child:nth-child(even){grid-column:1/-1}.active-plan>.actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.active-plan>.actions>button{min-width:0;min-height:44px;overflow-wrap:anywhere}.active-plan>.actions>button:last-child:nth-child(odd){grid-column:1/-1}}@media(max-width:360px){.row>.row-right,.active-plan>.actions{grid-template-columns:minmax(0,1fr)}}#view-plans>.toolbar{margin-bottom:16px}#view-detail{display:grid;gap:16px}#view-detail>#backPlans{justify-self:start}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.settings-grid>.panel{margin-bottom:0;min-width:0}.settings-grid .form>button{justify-self:start;min-height:44px}.settings-grid p{line-height:1.6}.settings-deleted{grid-column:1/-1}.settings-export{display:block;color:var(--green);font-weight:700;padding:10px 0;overflow-wrap:anywhere}#view-deleted{display:grid;gap:16px}#backSettings{justify-self:start;min-height:44px}#openDeleted{min-height:44px}@media(max-width:720px){.settings-grid{grid-template-columns:minmax(0,1fr)}}</style></head><body><main class=\"shell\">",
    "<header class=\"top\"><div><h1>Трекер планов</h1></div><div class=\"muted\" id=\"who\">Проверка входа…</div></header>",
    "<nav class=\"nav\" aria-label=\"Разделы\"><button data-view=\"overview\" aria-current=\"page\">Обзор</button><button data-view=\"plans\">Планы</button><button data-view=\"analytics\">Аналитика</button><button data-view=\"settings\">Настройки</button></nav><div id=\"notice\" class=\"notice hidden\" role=\"status\"></div>",
    "<section id=\"view-overview\"><div class=\"grid\"><article class=\"panel current\"><h2>Активные планы: <span id=\"activeCount\">0</span></h2><div id=\"active\" class=\"muted\">Загрузка…</div></article><aside class=\"panel\"><h2>Учёт времени</h2><div class=\"metrics\"><div class=\"metric\"><small>Общее время сегодня</small><strong id=\"today\">—</strong></div><div class=\"metric\"><small>Завершено за 30 дней</small><strong id=\"count\">—</strong></div></div><p class=\"muted\">Таймер считает время ночью и в выходные, пока вы не поставите его на паузу.</p><button class=\"primary\" id=\"newPlan\">Новый план</button></aside></div><article class=\"panel\"><h2>Другие планы</h2><div id=\"recent\" class=\"list\"></div></article></section>",
    "<section id=\"view-plans\" class=\"hidden\"><div class=\"toolbar\"><h2 style=\"flex:1\">Планы</h2><button class=\"primary\" id=\"newPlan2\">Создать план</button></div><div id=\"plans\" class=\"list\"></div></section>",
    "<section id=\"view-deleted\" class=\"hidden\"><button id=\"backSettings\" type=\"button\">← К настройкам</button><article class=\"panel\"><h2 tabindex=\"-1\" id=\"deletedHeading\">Удалённые планы</h2><p class=\"muted\">История сохранена. Восстановление не запускает таймер.</p><div id=\"deleted\" class=\"list\" aria-live=\"polite\"></div></article></section><section id=\"view-detail\" class=\"hidden\"><button id=\"backPlans\">← К планам</button><article id=\"planDetail\" class=\"panel\"></article></section>",
    "<section id=\"view-analytics\" class=\"hidden\"><article class=\"panel\"><h2>Отчёт за период</h2><div class=\"toolbar\"><div class=\"field\"><label for=\"from\">С</label><input id=\"from\" type=\"date\" aria-label=\"Дата начала периода\"></div><div class=\"field\"><label for=\"to\">По</label><input id=\"to\" type=\"date\" aria-label=\"Дата конца периода\"></div><button class=\"primary\" id=\"apply\">Применить</button></div><div id=\"stats\" class=\"metrics\" style=\"margin-top:16px\"></div><div id=\"chart\" class=\"chart\"></div><div id=\"analyticPlans\" class=\"list\" style=\"margin-top:15px\"></div></article></section>",
    "<section id=\"view-settings\" class=\"hidden\"><h2>Настройки</h2><div class=\"settings-grid\"><article class=\"panel\"><h2>Настройки времени</h2><form id=\"settings\" class=\"form\"><div class=\"field\"><label for=\"tz\">Часовой пояс</label><select id=\"tz\" required>" + UI_TIME_ZONES.map((option) => "<option value=\"" + option.value + "\"" + (option.value === "Asia/Omsk" ? " selected" : "") + ">" + option.label + "</option>").join("") + "</select></div><button class=\"primary\">Сохранить</button></form><p class=\"muted\">Все отметки времени хранятся в UTC. Часовой пояс используется для отображения дат и отчётов.</p></article><article class=\"panel\"><h2>Экспорт данных</h2><p class=\"muted\">Скачайте аналитический JSON-отчёт: планы, этапы, оценки, результаты, проверки и история работы. Удалённые планы включены.</p><a class=\"settings-export\" href=\"/api/export\">Скачать JSON отчет</a></article><article class=\"panel settings-deleted\"><h2>Удалённые планы</h2><p class=\"muted\">Просматривайте сохранённую историю и восстанавливайте планы. Восстановление не запускает таймер.</p><button id=\"openDeleted\" type=\"button\">Открыть удалённые планы</button></article></div></section>",
    "<div id=\"modal\" class=\"modal hidden\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"modalTitle\"><div class=\"modalbox\"><div class=\"toolbar\"><h2 id=\"modalTitle\" style=\"flex:1\">Новый план</h2><button id=\"close\">Закрыть</button></div><form id=\"create\" class=\"form\"><div class=\"field\"><label for=\"title\">Название</label><input id=\"title\" maxlength=\"200\" required></div><div class=\"field\"><label for=\"description\">Текст плана</label><textarea id=\"description\" maxlength=\"60000\" rows=\"14\" required placeholder=\"Вставьте план целиком. Заголовки этапов: ## Этап 1. Название\"></textarea></div><div class=\"field\"><label for=\"createdDate\">Дата составления</label><input id=\"createdDate\" type=\"date\" required></div><div class=\"actions\"><button type=\"button\" id=\"cancel\">Отмена</button><button class=\"primary\">Создать план</button></div></form></div></div><div id=\"toast\" class=\"toast hidden\" role=\"status\" aria-live=\"polite\"></div>",
    "</main>",
    "<script>(()=>{" + UI_ANALYTICS + "const q=s=>document.querySelector(s), all=s=>[...document.querySelectorAll(s)];const supportedZones=" + JSON.stringify(UI_TIME_ZONES.map((option) => option.value)) + ";const normalizeZone=value=>supportedZones.includes(value)?value:\"Asia/Omsk\";let plans=[],activePlans=[],deletedRequestId=0,currentDetailPlan=null,detailReturnView=\"plans\",receivedAt=Date.now(),todayActiveMs=0,todayDate=null,refreshRequestId=0,zone=\"Asia/Omsk\",serverNow=Date.now(),pending=new Map(),rejectedValidation=new Set(),rejectedVersion=new Map(),analyticsRequestId=0,detailRequestId=0,timer,modalReturnFocus=null;const uid=()=>crypto.randomUUID();const dateLocal=d=>{const value=Object.fromEntries(new Intl.DateTimeFormat(\"en-CA\",{timeZone:zone,year:\"numeric\",month:\"2-digit\",day:\"2-digit\"}).formatToParts(d).map(part=>[part.type,part.value]));return value.year+\"-\"+value.month+\"-\"+value.day};const duration=n=>{if(n==null)return\"—\";n=Math.max(0,Math.round(n/60000));const day=Math.floor(n/1440),h=Math.floor(n%1440/60),m=n%60;return day?day+\" д \"+h+\" ч \"+m+\" мин\":h?h+\" ч \"+m+\" мин\":m+\" мин\"};const formatPlanSample=n=>{const count=Number(n)||0,lastTwo=count%100;return\"по \"+count+\" \"+((lastTwo>=11&&lastTwo<=14)||count%10!==1?\"планам\":\"плану\")};const dateFmt=n=>n==null?\"—\":new Intl.DateTimeFormat(\"ru-RU\",{dateStyle:\"medium\",timeStyle:\"short\",timeZone:zone}).format(new Date(n));const statusText=status=>({PLANNED:\"Запланирован\",RUNNING:\"Выполняется\",PAUSED:\"На паузе\",COMPLETED:\"Завершён\"})[status]||status;function showToast(t,err){const x=q(\"#toast\");x.textContent=t;x.classList.toggle(\"error\",!!err);x.classList.remove(\"hidden\");clearTimeout(timer);timer=setTimeout(()=>x.classList.add(\"hidden\"),4500)}async function call(path,opt){const r=await fetch(path,{...opt,headers:{\"content-type\":\"application/json\",...(opt&&opt.headers||{})},cache:\"no-store\"});let v={};try{v=await r.json()}catch{}if(!r.ok){const e=new Error(v.error&&v.error.message||\"HTTP \"+r.status);e.status=r.status;e.code=v.error&&v.error.code;e.details=v.error&&v.error.details;throw e}return v}const rejectedTerminal=new Set();async function hasFinalPlanRejection(type,envelope,error){if(error.status!==409||!((type===\"FinishPlan\"&&error.code===\"CHECKPOINTS_INCOMPLETE\")||(type===\"DeletePlan\"&&error.code===\"PLAN_DELETED\")||(type===\"RestorePlan\"&&error.code===\"PLAN_NOT_DELETED\")))return false;try{const receipt=await call(\"/api/tracker/commands/\"+encodeURIComponent(envelope.commandId));return receipt.status===\"FINAL\"&&receipt.commandId===envelope.commandId&&receipt.commandType===envelope.commandType&&receipt.error?.code===error.code&&!receipt.result}catch{return false}}function makeCmd(type,plan,payload){const key=type+\":\"+(plan?plan.planId:\"new\"),nextPayload={...(plan?{planId:plan.planId}:{}),...(payload||{})};let c=pending.get(key);const newVersion=plan?plan.version:undefined;if(c&&rejectedTerminal.has(key)){c=null;pending.delete(key);rejectedTerminal.delete(key)}if(c&&rejectedValidation.has(key)&&JSON.stringify(c.payload)!==JSON.stringify(nextPayload)){c=null;pending.delete(key);rejectedValidation.delete(key)}if(c&&rejectedVersion.has(key)&&c.expectedVersion!==newVersion){c=null;pending.delete(key);rejectedVersion.delete(key)}if(c&&JSON.stringify(c.payload)!==JSON.stringify(nextPayload)){const e=new Error(\"Исход предыдущей команды неизвестен. Повторите её без изменения данных или обновите состояние перед новой командой.\");e.code=\"COMMAND_OUTCOME_UNKNOWN\";throw e}if(!c){c={schemaVersion:1,commandId:uid(),commandType:type,expectedVersion:newVersion,payload:nextPayload};pending.set(key,c)}return [key,c]}async function command(type,plan,payload){let prepared;try{prepared=makeCmd(type,plan,payload)}catch(e){showToast((e.code||\"ERROR\")+\": \"+e.message,true);throw e}const [key,c]=prepared;let r;try{r=await call(\"/api/commands\",{method:\"POST\",body:JSON.stringify(c)});if(r?.commandId!==c.commandId||r.outcome!==\"OK\"||typeof r.applied!==\"boolean\"||typeof r.replayed!==\"boolean\"||r.applied===r.replayed||!r.result||typeof r.result!==\"object\"||Array.isArray(r.result)||r.error){const e=new Error(\"Ответ команды не подтверждает её результат. Повторите запрос без изменения данных.\");e.code=\"COMMAND_OUTCOME_UNKNOWN\";throw e}}catch(e){if(e.code===\"VALIDATION_ERROR\")rejectedValidation.add(key);else if(await hasFinalPlanRejection(type,c,e))rejectedTerminal.add(key);if(e.code===\"VERSION_CONFLICT\"&&Number.isSafeInteger(e.details&&e.details.currentVersion)){rejectedVersion.set(key,e.details.currentVersion);if(plan)plan.version=e.details.currentVersion}showToast((e.code||\"ERROR\")+\": \"+e.message,true);if(e.code===\"VERSION_CONFLICT\")try{await refresh()}catch{}throw e}pending.delete(key);rejectedValidation.delete(key);rejectedVersion.delete(key);rejectedTerminal.delete(key);q(\"#toast\").classList.add(\"hidden\");q(\"#toast\").classList.remove(\"error\");try{await refresh()}catch{showToast(\"Изменение сохранено, но данные не обновились. Перезагрузите страницу.\",true)}return r}window.addEventListener(\"plan-time-tracker:command\",event=>{const detail=event.detail||{};command(detail.commandType,detail.plan,detail.payload).then(detail.resolve,detail.reject)});window.addEventListener(\"plan-time-tracker:refresh-plan\",event=>{const detail=event.detail||{},navigationToken=detailRequestId;(async()=>{await refresh();if(navigationToken===detailRequestId&&!q(\"#view-detail\").classList.contains(\"hidden\")&&q(\"#planDetail\").dataset.planId===detail.planId)await openPlan(detail.planId,detail.successMessage)})().then(detail.resolve,detail.reject)});function btn(text,fn,cls){const b=document.createElement(\"button\");b.textContent=text;if(cls)b.className=cls;b.onclick=async e=>{e.stopPropagation();if(b.disabled)return;b.disabled=true;try{await fn()}catch{}finally{b.disabled=false}};return b}function deletionButton(p){const restoring=p.deletedAt!=null;return btn(restoring?\"Восстановить\":\"Удалить\",async()=>{if(!window.confirm(restoring?\"Восстановить план «\"+p.title+\"»? Таймер останется остановленным.\":\"Удалить план «\"+p.title+\"»? Активное время и попытки будут остановлены. План можно восстановить в настройках, в разделе «Удалённые планы».\"))return;const navigationToken=detailRequestId;await command(restoring?\"RestorePlan\":\"DeletePlan\",p);if(navigationToken===detailRequestId&&q(\"#planDetail\").dataset.planId===p.planId&&!q(\"#view-detail\").classList.contains(\"hidden\"))await openPlan(p.planId)},restoring?\"\":\"danger\")}async function loadDeleted(){const requestId=++deletedRequestId,list=q(\"#deleted\");list.textContent=\"Загружаю удалённые планы…\";try{let page=await call(\"/api/plans?deleted=true&limit=100\"),collected=[...page.plans];while(page.nextCursor){page=await call(\"/api/plans?deleted=true&limit=100&cursor=\"+encodeURIComponent(page.nextCursor));if(requestId!==deletedRequestId)return;collected.push(...page.plans)}if(requestId!==deletedRequestId)return;list.replaceChildren();if(!collected.length)list.textContent=\"Удалённых планов нет.\";else collected.forEach(p=>list.append(card(p)))}catch(error){if(requestId!==deletedRequestId)return;list.textContent=\"Не удалось загрузить удалённые планы. \"+error.message;list.append(btn(\"Повторить\",loadDeleted));}}function finishButton(p,confirmation){let b;if(p.completion&&!p.completion.readyToFinish){b=btn(\"Условия завершения\",()=>openPlan(p.planId));b.title=\"Не выполнены условия этапов: \"+p.completion.incompleteStepCount}else b=btn(\"Завершить\",async()=>{if(!window.confirm(confirmation))return;try{await command(\"FinishPlan\",p)}finally{if(q(\"#planDetail\").dataset.planId===p.planId&&!q(\"#view-detail\").classList.contains(\"hidden\"))await openPlan(p.planId)}},\"danger\");b.dataset.finishPlan=p.planId;return b}window.addEventListener(\"plan-time-tracker:completion-updated\",event=>{const next=event.detail;if(!next?.completion)return;const summaries=[...plans,...activePlans,currentDetailPlan].filter(p=>p&&p.planId===next.planId);for(const p of summaries)p.completion=next.completion;const p=summaries[0];if(p)for(const button of all(\"[data-finish-plan]\"))if(button.dataset.finishPlan===p.planId)button.replaceWith(finishButton(p,\"Завершить план? Сервер остановит таймер.\"))});function card(p){const row=document.createElement(\"div\");row.className=\"row\";row.dataset.planId=p.planId;const left=document.createElement(\"button\"),title=document.createElement(\"span\"),meta=document.createElement(\"span\");left.type=\"button\";left.className=\"plan-open\";left.onclick=()=>openPlan(p.planId);left.setAttribute(\"aria-label\",p.title);title.className=\"row-title\";title.textContent=p.title;meta.className=\"row-meta\";meta.textContent=(p.status===\"RUNNING\"?\"Выполняется\":p.status===\"PAUSED\"?\"Пауза\":p.status===\"COMPLETED\"?\"Завершён\":\"Запланирован\")+\" · активно \"+duration(p.activeMs)+\" · создан \"+dateFmt(p.registeredAt);left.append(title,meta);const right=document.createElement(\"div\");right.className=\"row-right\";const badge=document.createElement(\"span\");badge.className=\"badge \"+p.status.toLowerCase();badge.textContent=statusText(p.status);right.append(badge);if(p.deletedAt!=null){badge.textContent=\"Удалён\";meta.textContent=\"Удалён \"+dateFmt(p.deletedAt)+\" · активно \"+duration(p.activeMs);right.append(deletionButton(p));row.append(left,right);return row}if(p.status===\"PLANNED\")right.append(btn(\"Запустить\",()=>command(\"StartPlan\",p),\"primary\"));if(p.status===\"RUNNING\")right.append(btn(\"Пауза\",()=>command(\"PausePlan\",p)));if(p.status===\"PAUSED\")right.append(btn(\"Продолжить\",()=>command(\"ResumePlan\",p),\"primary\"));if(p.status===\"RUNNING\"||p.status===\"PAUSED\")right.append(finishButton(p,\"Завершить план? Сервер остановит таймер.\"));right.append(deletionButton(p));row.append(left,right);return row}async function openPlan(planId,successMessage){const returnView=!q(\"#view-detail\").classList.contains(\"hidden\")?detailReturnView:!q(\"#view-deleted\").classList.contains(\"hidden\")?\"deleted\":\"plans\";const requestToken=++detailRequestId;try{const p=(await call(\"/api/plans/\"+encodeURIComponent(planId)+\"\")).plan;if(requestToken!==detailRequestId)return;detailReturnView=returnView;q(\"#backPlans\").textContent=returnView===\"deleted\"?\"← К удалённым планам\":\"← К планам\";currentDetailPlan=p;const box=q(\"#planDetail\");window.dispatchEvent(new CustomEvent(\"plan-time-tracker:plan-will-render\"));box.dataset.planId=planId;box.replaceChildren();const h=document.createElement(\"h2\");h.textContent=p.title;box.append(h);const m=document.createElement(\"p\");m.className=\"muted\";m.textContent=\"Дата плана: \"+(p.planCreatedAt.precision===\"dateOnly\"?p.planCreatedAt.on:dateFmt(Date.parse(p.planCreatedAt.value)))+\" · создан \"+dateFmt(p.registeredAt)+\" · \"+statusText(p.status);box.append(m);const deletionActions=document.createElement(\"div\");deletionActions.className=\"actions\";deletionActions.append(deletionButton(p));box.append(deletionActions);if(p.deletedAt!=null){const notice=document.createElement(\"p\");notice.className=\"notice\";notice.textContent=\"План удалён. История доступна только для чтения. Восстановление не запускает таймер.\";box.append(notice)}if(p.deletedAt==null&&(p.status===\"RUNNING\"||p.status===\"PAUSED\")){const actions=document.createElement(\"div\");actions.className=\"actions plan-completion-actions\";actions.append(finishButton(p,\"Завершить план? Сервер остановит таймер.\"));box.append(actions)}for(const label of [...(p.planText?[]:[p.description||\"Описание не задано.\",\"Критерии приёмки: \"+(p.acceptanceCriteria||\"не заданы\")]),\"Активно \"+duration(p.activeMs)+\"; календарное \"+duration(p.calendarMs)+\"; пауза \"+duration(p.pausedMs)]){const e=document.createElement(\"p\");e.textContent=label;box.append(e)}if(p.deletedAt==null){const edit=document.createElement(\"form\");edit.className=\"form\";edit.dataset.trackerForm=\"plan-metadata\";const title=document.createElement(\"input\");title.value=p.title;title.maxLength=200;title.setAttribute(\"aria-label\",\"Название плана\");const description=document.createElement(\"textarea\");description.value=p.description||\"\";description.maxLength=20000;description.setAttribute(\"aria-label\",\"Описание\");const criteria=document.createElement(\"textarea\");criteria.value=p.acceptanceCriteria||\"\";criteria.maxLength=20000;criteria.setAttribute(\"aria-label\",\"Критерии приёмки\");const date=document.createElement(\"input\");date.type=\"date\";date.value=p.planCreatedAt.precision===\"dateOnly\"?p.planCreatedAt.on:dateLocal(Date.parse(p.planCreatedAt.value));date.setAttribute(\"aria-label\",\"Дата составления\");const reason=document.createElement(\"input\");reason.placeholder=\"Причина правки даты\";reason.setAttribute(\"aria-label\",\"Причина правки даты\");const label=document.createElement(\"label\"),confirm=document.createElement(\"input\");confirm.type=\"checkbox\";confirm.dataset.draftField=\"confirmDateAnomaly\";label.className=\"checkbox-field\";const confirmText=document.createElement(\"span\");confirmText.textContent=\"Подтверждаю дату составления после первого старта\";label.append(confirm,confirmText);const save=document.createElement(\"button\");save.textContent=\"Сохранить изменения\";const labelled=(text,control)=>{const field=document.createElement(\"label\");field.className=\"field\";field.append(document.createTextNode(text),control);return field};edit.append(labelled(\"Название плана\",title),labelled(\"Описание\",description),labelled(\"Критерии приёмки\",criteria),labelled(\"Дата составления\",date),labelled(\"Причина правки даты\",reason),label,save);edit.onsubmit=async e=>{e.preventDefault();const draftSubmission={planId:p.planId,form:edit};window.dispatchEvent(new CustomEvent(\"plan-time-tracker:draft-submitted\",{detail:draftSubmission}));await command(\"UpdatePlanMetadata\",p,{title:title.value,description:description.value,acceptanceCriteria:criteria.value,planCreatedAt:p.planCreatedAt.precision===\"instant\"&&date.value===dateLocal(Date.parse(p.planCreatedAt.value))?p.planCreatedAt:{precision:\"dateOnly\",on:date.value,timeZone:zone},reason:reason.value,confirmDateAnomaly:confirm.checked});window.dispatchEvent(new CustomEvent(\"plan-time-tracker:draft-cleared\",{detail:{submission:draftSubmission.submission}}));await openPlan(p.planId)};if(p.planText){description.closest(\"label\").remove();criteria.closest(\"label\").remove();const metadata=document.createElement(\"details\"),summary=document.createElement(\"summary\");metadata.className=\"plan-metadata\";summary.textContent=\"Изменить название и дату\";metadata.append(summary,edit);box.append(metadata)}else box.append(edit);}const intervals=document.createElement(\"details\"),ih=document.createElement(\"summary\");ih.textContent=\"Интервалы работы\";intervals.append(ih);p.intervals.forEach(i=>{const e=document.createElement(\"p\");e.textContent=dateFmt(i.start_ms)+\" — \"+dateFmt(i.end_ms)+\" · \"+duration((i.end_ms||p.serverNow)-i.start_ms);intervals.append(e)});box.append(intervals);view(\"detail\");window.dispatchEvent(new CustomEvent(\"plan-time-tracker:plan-rendered\",{detail:{planId,successMessage}}))}catch(e){showToast((e.code||\"ERROR\")+\": \"+e.message,true)}}function renderActive(){const el=q(\"#active\");el.replaceChildren();q(\"#activeCount\").textContent=String(activePlans.length);if(!activePlans.length){const p=document.createElement(\"p\");p.className=\"muted\";p.textContent=\"Активных планов нет. Создайте план и запустите, когда начнёте работу.\";el.append(p,btn(\"Создать план\",openModal,\"primary\"));return}for(const plan of activePlans){const panel=document.createElement(\"section\");panel.className=\"active-plan\";panel.dataset.planId=plan.planId;panel.setAttribute(\"aria-label\",plan.title);const title=document.createElement(\"h3\");title.append(btn(plan.title,()=>openPlan(plan.planId),\"plan-open\"));const clock=document.createElement(\"div\");clock.className=\"timer\";clock.dataset.clockPlan=plan.planId;clock.setAttribute(\"aria-label\",\"Активное время: \"+plan.title);clock.textContent=duration(plan.activeMs+Math.max(0,Date.now()-receivedAt));const detail=document.createElement(\"div\");detail.className=\"muted\";detail.textContent=\"Начат \"+dateFmt(plan.firstStartedAt);const actions=document.createElement(\"div\");actions.className=\"actions\";actions.append(btn(\"Пауза\",()=>command(\"PausePlan\",plan)),finishButton(plan,\"Завершить план? Время будет остановлено сервером.\"),deletionButton(plan));panel.append(title,clock,detail,actions);el.append(panel)}}" + UI_PLAN_LISTS + "async function refresh(){const requestId=++refreshRequestId;const [first,w,settings]=await Promise.all([call(\"/api/plans?limit=100\"),call(\"/api/whoami\"),call(\"/api/settings\")]);let collected=[...first.plans],cursor=first.nextCursor;while(cursor){const page=await call(\"/api/plans?limit=100&cursor=\"+encodeURIComponent(cursor));if(requestId!==refreshRequestId)return;collected.push(...page.plans);cursor=page.nextCursor}const nextZone=normalizeZone(settings.timezone),dateParts=Object.fromEntries(new Intl.DateTimeFormat(\"en-CA\",{timeZone:nextZone,year:\"numeric\",month:\"2-digit\",day:\"2-digit\"}).formatToParts(first.serverNow).map(part=>[part.type,part.value])),today=dateParts.year+\"-\"+dateParts.month+\"-\"+dateParts.day;const daily=await call(\"/api/analytics?\"+new URLSearchParams({from:today,to:today,timeZone:nextZone}));if(requestId!==refreshRequestId)return;plans=collected.map(plan=>plan.status===\"RUNNING\"?{...plan,activeMs:plan.activeMs+Math.max(0,daily.serverNow-plan.serverNow),calendarMs:plan.calendarMs+Math.max(0,daily.serverNow-plan.serverNow),serverNow:daily.serverNow}:plan);activePlans=plans.filter(plan=>plan.status===\"RUNNING\");serverNow=daily.serverNow;receivedAt=Date.now();todayActiveMs=daily.totalActiveMs;todayDate=today;zone=nextZone;q(\"#who\").textContent=w.email||\"Личный аккаунт\";q(\"#tz\").value=zone;render();if(!q(\"#view-deleted\").classList.contains(\"hidden\"))await loadDeleted()}function openModal(){modalReturnFocus=document.activeElement;document.body.style.overflow=\"hidden\";q(\"#modal\").classList.remove(\"hidden\");q(\"#createdDate\").value=dateLocal(Date.now());q(\"#title\").focus();}function closeModal(){if(q(\"#create\").getAttribute(\"aria-busy\")===\"true\")return;q(\"#modal\").classList.add(\"hidden\");document.body.style.overflow=\"\";if(modalReturnFocus?.isConnected)modalReturnFocus.focus()}async function loadAnalytics(){const requestId=++analyticsRequestId;const d=new Date(),from=new Date(d);from.setDate(from.getDate()-29);if(!q(\"#from\").value)q(\"#from\").value=dateLocal(from);if(!q(\"#to\").value)q(\"#to\").value=dateLocal(d);const u=new URLSearchParams({from:q(\"#from\").value,to:q(\"#to\").value,timeZone:zone});let a;try{a=await call(\"/api/analytics?\"+u)}catch(error){if(requestId!==analyticsRequestId)return;throw error}if(requestId!==analyticsRequestId)return;const stats=q(\"#stats\");stats.replaceChildren();const medianText=duration(a.completedMedianActiveMs)+(a.completedMedianActiveMs==null?\"\":\" · \"+formatPlanSample(a.completedMeasuredN));[[\"Общее время за период\",duration(a.totalActiveMs)],[\"Завершено планов\",String(a.completedPlans)],[\"Медиана активного времени\",medianText],[\"Сумма времени планов\",duration(a.sumPlanActiveMs)]].forEach(([k,v],index)=>{const box=document.createElement(\"div\"),small=document.createElement(\"small\"),strong=document.createElement(\"strong\");box.className=\"metric\";small.textContent=k;strong.textContent=v;box.append(small,strong);if(index===2&&a.completedSmallSample){const note=document.createElement(\"small\");note.className=\"sample-note\";note.textContent=\"Малая выборка\";note.title=\"Медиана рассчитана по менее чем пяти завершённым планам.\";note.setAttribute(\"aria-label\",\"Малая выборка: менее пяти завершённых планов.\");box.append(note)}stats.append(box)});const chart=q(\"#chart\");chart.replaceChildren();const max=Math.max(1,...a.activeByDay.map(x=>x.activeMs));a.activeByDay.forEach(x=>{const row=document.createElement(\"div\"),date=document.createElement(\"span\"),bar=document.createElement(\"div\"),fill=document.createElement(\"span\"),v=document.createElement(\"span\");row.className=\"barrow\";bar.className=\"bar\";fill.style.width=(100*x.activeMs/max)+\"%\";bar.append(fill);date.textContent=x.date;v.textContent=duration(x.activeMs);row.append(date,bar,v);chart.append(row)});const list=q(\"#analyticPlans\");list.replaceChildren();if(!a.plans.length){const p=document.createElement(\"p\");p.className=\"muted\";p.textContent=\"За выбранный период данных нет.\";list.append(p)}else renderAnalyticsPlanCards(list,a)}function view(name){if(name!==\"detail\")detailRequestId++;all(\"[id^=view-]\").forEach(x=>x.classList.toggle(\"hidden\",x.id!==\"view-\"+name));all(\".nav button\").forEach(b=>b.setAttribute(\"aria-current\",b.dataset.view===(name===\"deleted\"||(name===\"detail\"&&detailReturnView===\"deleted\")?\"settings\":name===\"detail\"?\"plans\":name)?\"page\":\"false\"));if(name===\"deleted\")loadDeleted();if(name===\"analytics\")loadAnalytics().catch(e=>showToast(e.message,true));}all(\".nav button\").forEach(b=>b.onclick=()=>view(b.dataset.view));q(\"#backPlans\").onclick=()=>{view(detailReturnView);if(detailReturnView===\"deleted\")q(\"#deletedHeading\").focus()};q(\"#openDeleted\").onclick=()=>{view(\"deleted\");q(\"#deletedHeading\").focus()};q(\"#backSettings\").onclick=()=>{view(\"settings\");q(\"#openDeleted\").focus()};q(\"#newPlan\").onclick=openModal;q(\"#newPlan2\").onclick=openModal;q(\"#close\").onclick=closeModal;q(\"#cancel\").onclick=closeModal;q(\"#modal\").onclick=e=>{if(e.target.id===\"modal\")closeModal()};q(\"#create\").onsubmit=async e=>{e.preventDefault();const payload={title:q(\"#title\").value,planText:q(\"#description\").value,planCreatedAt:{precision:\"dateOnly\",on:q(\"#createdDate\").value,timeZone:zone}};try{await command(\"CreatePlan\",null,payload);e.target.removeAttribute(\"aria-busy\");closeModal();e.target.reset();showToast(\"План создан. Таймер не запущен.\")}catch(x){showToast((x.code||\"ERROR\")+\": \"+x.message,true)}};q(\"#apply\").onclick=()=>loadAnalytics().catch(e=>showToast(e.message,true));q(\"#settings\").onsubmit=async e=>{e.preventDefault();try{const r=await call(\"/api/settings\",{method:\"POST\",body:JSON.stringify({timezone:q(\"#tz\").value})});zone=normalizeZone(r.timezone);q(\"#tz\").value=zone;window.dispatchEvent(new CustomEvent(\"plan-time-zone-changed\",{detail:zone}));await refresh();showToast(\"Часовой пояс сохранён.\")}catch(x){showToast((x.code||\"ERROR\")+\": \"+x.message,true)}};setInterval(()=>{const elapsed=Math.max(0,Date.now()-receivedAt);for(const plan of activePlans){const clock=all(\"[data-clock-plan]\").find(node=>node.dataset.clockPlan===plan.planId);if(clock)clock.textContent=duration(plan.activeMs+elapsed)}if(todayDate&&dateLocal(serverNow+elapsed)!==todayDate){todayDate=null;refresh().catch(e=>showToast(e.message,true))}else if(q(\"#today\"))q(\"#today\").textContent=duration(todayActiveMs+(activePlans.length?elapsed:0))},1000);refresh().catch(e=>{q(\"#who\").textContent=\"Требуется вход\";showToast(e.message,true)})})();</script></body></html>"
  ].join("").replace("</head>", "<style>" + UI_FONT_CSS + UI_ANALYTICS_CSS + UI_PLAN_LISTS_CSS + "</style></head>").replace("</body></html>", "<script>" + UI_ENHANCEMENTS + "</script><script>" + UI_TRACKER + UI_ATLM + "</script><script>" + UI_ACCESSIBILITY + "</script><style>" + UI_CONSOLE_PAPER_CSS + UI_TYPOGRAPHY_CSS + "</style></body></html>");
}

function validatePublicCommand(envelope){
 if(!WRITE_COMMANDS.has(envelope?.commandType)&&!TRACKER_COMMANDS.has(envelope?.commandType))throw appError("VALIDATION_ERROR","Неизвестная команда.");
 const payload=envelope?.payload;if(!isPlainRecord(payload))return;
 const fields={CreatePlan:["planId","title","description","acceptanceCriteria","planCreatedAt","planText","sourceReference"],UpdatePlanMetadata:["planId","title","description","acceptanceCriteria","planCreatedAt","reason","confirmDateAnomaly"],StartPlan:["planId"],PausePlan:["planId","reason"],ResumePlan:["planId"],FinishPlan:["planId","completionNote","allowIncomplete","reason"],DeletePlan:["planId","reason"],RestorePlan:["planId","reason"]}[envelope.commandType];
 if(fields)assertExactKeys(payload,new Set(fields),"payload");
}
// ATLM training state is durable in D1. A background promise only drains that state.
export const ATLM_RETRAIN_EVERY_NEW_PLANS = 5;
const ATLM_TRAINING_LEASE_MS = 60000;
const ATLM_TRAINING_BUDGET_MS = 10000;
const ATLM_TRAINING_LIMIT = 5000;
const ATLM_TRAINING_RETRY_MS = [60000, 300000, 900000];
const ATLM_LATEST_SAMPLE_SQL = "s.sequence=(SELECT MAX(current.sequence) FROM estimation_samples current WHERE current.owner_id=s.owner_id AND current.plan_id=s.plan_id)";
const ATLM_PENDING_REFRESH_SQL = "SELECT 1 FROM estimation_jobs r WHERE r.owner_id=estimation_owner_state.owner_id AND r.kind='REFRESH_SAMPLE' AND r.generation>r.processed_generation";

function atlmTrainingJson(value, fallback = null) {
  return value == null ? fallback : JSON.parse(value) ?? fallback;
}
function atlmTrainingErrorCode(error) {
  return ["INVALID_ESTIMATION_SOURCE", "SOURCE_UNAVAILABLE", "INTERNAL_ERROR", "DATASET_LIMIT_REACHED"].includes(error?.code) ? error.code : "TRAINING_EXECUTION_FAILED";
}
function atlmJobDue(job, nowMs) {
  if (!job || job.generation <= job.processed_generation || job.status === "FAILED") return false;
  if (job.status === "RUNNING") return job.lease_until <= nowMs;
  return job.next_attempt_at <= nowMs;
}
function atlmPublicEvaluation(evaluation) {
  if (!evaluation) return null;
  return { caseCount: evaluation.paired?.caseCount ?? 0, coverage: evaluation.metrics?.atlm?.forecastRate ?? 0,
    maeMs: evaluation.paired?.atlm?.maeMs ?? null, medianBaselineMaeMs: evaluation.paired?.median?.maeMs ?? null,
    wapePercent: evaluation.paired?.atlm?.wapePercent ?? null, signedBiasPercent: evaluation.paired?.atlm?.signedBiasPercent ?? null,
    excludedCaseCount: evaluation.excluded?.length ?? 0, selectedCaseCount: evaluation.caseCount ?? 0,
    cutoff: evaluation.cutoff ?? null, protocolVersion: evaluation.protocolVersion ?? 1 };
}
function atlmPublicModel(row) {
  return row ? { modelId: row.model_id, modelVersion: row.model_version, trainedAt: row.activated_at ?? row.created_at,
    sampleCount: row.sample_count, evaluation: atlmPublicEvaluation(atlmTrainingJson(row.metrics_json)) } : null;
}

// An immutable artifact is readable only while every manifest source is still current and clean.
async function atlmReadActiveModel(db, ownerId) {
  return dbFirst(db, `SELECT m.* FROM estimation_models m JOIN estimation_owner_state o
    ON o.owner_id=m.owner_id AND o.active_model_id=m.model_id
    WHERE m.owner_id=? AND m.status='ACTIVE' AND m.method_version='agent-v1' AND m.feature_version='agent-task-v1'
    AND NOT EXISTS(SELECT 1 FROM json_each(m.manifest_json) item
      LEFT JOIN estimation_samples s ON s.owner_id=m.owner_id AND s.sequence=CAST(item.value AS INTEGER)
      WHERE s.sequence IS NULL OR s.eligibility<>'ELIGIBLE'
        OR s.sequence<>(SELECT MAX(latest.sequence) FROM estimation_samples latest WHERE latest.owner_id=s.owner_id AND latest.plan_id=s.plan_id)
        OR EXISTS(SELECT 1 FROM estimation_jobs dirty WHERE dirty.owner_id=s.owner_id AND dirty.plan_id=s.plan_id
          AND dirty.kind='REFRESH_SAMPLE' AND dirty.generation>dirty.processed_generation))`, ownerId);
}

export async function predictWithActiveModel(db, ownerId, features, nowMs) {
  const model = await atlmReadActiveModel(db, ownerId);
  const unavailable = reason => ({ status: "UNAVAILABLE", pointMs: null, modelId: null, modelVersion: null,
    sampleCount: 0, evaluation: null, unavailableReason: reason, accuracy: "NOT_VALIDATED" });
  if (!model) {
    const state = await dbFirst(db, "SELECT active_model_id FROM estimation_owner_state WHERE owner_id=?", ownerId);
    return unavailable(state?.active_model_id ? "MODEL_INVALIDATED" : "COLLECTING_DATA");
  }
  let prediction;
  try { prediction = predictAtlm(atlmTrainingJson(model.artifact_json), features); }
  catch { throw appError("SOURCE_UNAVAILABLE", "Сохранённая модель ATLM повреждена.", 503, { reason: "INVALID_ARTIFACT" }); }
  if (prediction.reason === "INVALID_ARTIFACT") throw appError("SOURCE_UNAVAILABLE", "Сохранённая модель ATLM повреждена.", 503, { reason: "INVALID_ARTIFACT" });
  const metadata = { modelId: model.model_id, modelVersion: model.model_version, sampleCount: model.sample_count,
    evaluation: atlmPublicEvaluation(atlmTrainingJson(model.metrics_json)), accuracy: "HISTORICALLY_EVALUATED" };
  if (prediction.status !== "AVAILABLE") return { ...unavailable(prediction.reason), ...metadata,
    ...(prediction.missingFields ? { missingFields: prediction.missingFields } : {}) };
  return { status: "AVAILABLE", pointMs: prediction.pointMs, ...metadata, unavailableReason: null };
}

export async function getEstimationModelStatus(db, ownerId, nowMs) {
  const [state, train, pending, counts, exclusions, active] = await Promise.all([
    dbFirst(db, "SELECT * FROM estimation_owner_state WHERE owner_id=?", ownerId),
    dbFirst(db, "SELECT * FROM estimation_jobs WHERE owner_id=? AND job_key='train'", ownerId),
    dbAll(db, "SELECT * FROM estimation_jobs WHERE owner_id=? AND kind='REFRESH_SAMPLE' AND generation>processed_generation ORDER BY job_key", ownerId),
    dbFirst(db, `SELECT COUNT(*) AS total,COALESCE(SUM(s.eligibility='ELIGIBLE'),0) AS eligible FROM estimation_samples s WHERE s.owner_id=? AND ${ATLM_LATEST_SAMPLE_SQL}`, ownerId),
    dbAll(db, `SELECT reason.value AS reason,COUNT(*) AS count FROM estimation_samples s,json_each(s.reasons_json) reason
      WHERE s.owner_id=? AND ${ATLM_LATEST_SAMPLE_SQL} GROUP BY reason.value ORDER BY reason.value`, ownerId),
    atlmReadActiveModel(db, ownerId),
  ]);
  const newPlans = Math.max(0, (state?.new_sample_count ?? 0) - (state?.last_attempted_new_sample_count ?? 0));
  const trainPending = Boolean(train && train.generation > train.processed_generation);
  const checkpoint = atlmTrainingJson(train?.checkpoint_json, {});
  const snapshot = atlmTrainingJson(train?.snapshot_json, {});
  const refreshFailed = pending.find(job => job.status === "FAILED");
  const refreshRunning = pending.find(job => job.status === "RUNNING" && job.lease_until > nowMs);
  const refreshWaiting = pending.find(job => job.status === "RETRY_WAIT" && job.next_attempt_at > nowMs);
  const triggerDue = Boolean((state?.forced_retrain || newPlans >= ATLM_RETRAIN_EVERY_NEW_PLANS) && !trainPending && !pending.length);
  const due = pending.some(job => atlmJobDue(job, nowMs)) || (!pending.length && atlmJobDue(train, nowMs)) || triggerDue;
  let status = trainPending ? train.status : (state?.last_training_status || (active ? "IDLE" : "COLLECTING_DATA"));
  if (!active && status === "IDLE") status = "COLLECTING_DATA";
  if (refreshFailed && !due) status = "FAILED";
  else if (refreshRunning) status = "RUNNING";
  else if (refreshWaiting && !due) status = "RETRY_WAIT";
  else if (pending.length || triggerDue) status = "QUEUED";
  const nextAttemptAt = Math.min(...[...(trainPending && train?.next_attempt_at > nowMs ? [train.next_attempt_at] : []),
    ...pending.filter(job => job.status === "RETRY_WAIT" && job.next_attempt_at > nowMs).map(job => job.next_attempt_at)]);
  return { method: { id: "atlm", version: "agent-v1" }, featureSchemaVersion: "agent-task-v1", metric: "PLAN_ACTIVE",
    forecastScope: "FULL_FROM_FIRST_START", retrainEveryNewPlans: ATLM_RETRAIN_EVERY_NEW_PLANS,
    datasetRevision: state?.dataset_revision ?? 0, eligibleSampleCount: counts?.eligible ?? 0,
    excludedSampleCount: (counts?.total ?? 0) - (counts?.eligible ?? 0), newPlansSinceTraining: newPlans,
    exclusionReasons: exclusions, activeModel: atlmPublicModel(active),
    training: { status, generation: train?.generation ?? state?.training_generation ?? 0, due,
      attempts: trainPending ? train.attempts : 0, nextAttemptAt: Number.isFinite(nextAttemptAt) ? nextAttemptAt : null,
      pendingRefreshCount: pending.length, progressRevision: checkpoint.progressRevision ?? 0,
      progress: { phase: checkpoint.phase ?? null, completedCases: checkpoint.cases?.length ?? 0,
        totalCases: snapshot.selection?.caseSampleIds?.length ?? 0 } },
    lastError: refreshFailed?.last_error ?? train?.last_error ?? null,
    lastReason: state?.last_training_reason ?? null };
}

function atlmEnqueueTrainingStatements(db, ownerId, nowMs) {
  return [
    db.prepare(`INSERT INTO estimation_jobs(owner_id,job_key,kind,generation,status,created_at,updated_at)
      SELECT owner_id,'train','TRAIN',training_generation+1,'QUEUED',?,? FROM estimation_owner_state
      WHERE owner_id=? AND (forced_retrain=1 OR new_sample_count-last_attempted_new_sample_count>=?)
        AND NOT EXISTS(${ATLM_PENDING_REFRESH_SQL})
      ON CONFLICT(owner_id,job_key) DO UPDATE SET generation=estimation_jobs.generation+1,
        processed_generation=estimation_jobs.generation,status='QUEUED',lease_until=NULL,attempts=0,next_attempt_at=0,
        snapshot_json=NULL,checkpoint_json=NULL,last_error=NULL,updated_at=excluded.updated_at
      WHERE estimation_jobs.generation=estimation_jobs.processed_generation OR estimation_jobs.status='FAILED'`)
      .bind(nowMs, nowMs, ownerId, ATLM_RETRAIN_EVERY_NEW_PLANS),
    db.prepare(`UPDATE estimation_owner_state SET training_generation=COALESCE((SELECT generation FROM estimation_jobs WHERE owner_id=? AND job_key='train'),training_generation)
      WHERE owner_id=?`).bind(ownerId, ownerId),
  ];
}
async function atlmEnqueueTraining(db, ownerId, nowMs) {
  await db.batch(atlmEnqueueTrainingStatements(db, ownerId, nowMs));
}
async function atlmReleaseSuperseded(db, ownerId, job, nowMs) {
  await db.prepare(`UPDATE estimation_jobs SET status='QUEUED',lease_until=NULL,attempts=0,next_attempt_at=0,
    snapshot_json=NULL,checkpoint_json=NULL,last_error=NULL,updated_at=?
    WHERE owner_id=? AND job_key=? AND fence=? AND generation>? AND status='RUNNING' AND lease_until>?`)
    .bind(nowMs, ownerId, job.job_key, job.fence, job.generation, nowMs).run();
}
async function atlmCheckpoint(db, ownerId, job, checkpoint, nowMs, { snapshot, release = false } = {}) {
  const fields = ["checkpoint_json=?", "updated_at=?"], values = [JSON.stringify(checkpoint), nowMs];
  if (snapshot !== undefined) { fields.push("snapshot_json=?"); values.push(JSON.stringify(snapshot)); }
  if (release) fields.push("status='QUEUED'", "lease_until=NULL");
  return dbFirst(db, `UPDATE estimation_jobs SET ${fields.join(",")}
    WHERE owner_id=? AND job_key=? AND generation=? AND fence=? AND status='RUNNING' AND lease_until>? RETURNING *`,
    ...values, ownerId, job.job_key, job.generation, job.fence, nowMs);
}
async function atlmManifestRows(db, ownerId, manifest) {
  const rows = await dbAll(db, `SELECT s.* FROM estimation_samples s WHERE s.owner_id=?
    AND s.sequence IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) ORDER BY s.sequence`, ownerId, JSON.stringify(manifest));
  if (rows.length !== manifest.length) throw appError("INVALID_ESTIMATION_SOURCE", "ATLM snapshot sources are unavailable.", 500);
  return rows.map(row => ({ sampleId: String(row.sequence), planId: row.plan_id, capturedAt: row.captured_at,
    sourceAvailableAt: row.source_available_at, features: atlmTrainingJson(row.features_json), actualMs: row.actual_ms }));
}
function atlmSourceValiditySql(owner = "j.owner_id", manifest = "json_extract(j.snapshot_json,'$.manifest')") {
  return `NOT EXISTS(SELECT 1 FROM json_each(${manifest}) member
    LEFT JOIN estimation_samples s ON s.owner_id=${owner} AND s.sequence=CAST(member.value AS INTEGER)
    WHERE s.sequence IS NULL OR s.eligibility<>'ELIGIBLE' OR s.sequence<>(SELECT MAX(latest.sequence) FROM estimation_samples latest
      WHERE latest.owner_id=s.owner_id AND latest.plan_id=s.plan_id)
      OR EXISTS(SELECT 1 FROM estimation_jobs source WHERE source.owner_id=s.owner_id AND source.kind='REFRESH_SAMPLE'
        AND source.plan_id=s.plan_id AND source.generation>source.processed_generation))`;
}
async function atlmSnapshot(db, ownerId, job, clock) {
  const values = await db.batch([
    db.prepare("SELECT * FROM estimation_owner_state WHERE owner_id=?").bind(ownerId),
    db.prepare(`SELECT s.* FROM estimation_samples s WHERE s.owner_id=? AND ${ATLM_LATEST_SAMPLE_SQL} AND s.eligibility='ELIGIBLE' ORDER BY s.sequence LIMIT ?`).bind(ownerId, ATLM_TRAINING_LIMIT + 1),
    db.prepare("SELECT * FROM estimation_models WHERE owner_id=? AND model_id=(SELECT active_model_id FROM estimation_owner_state WHERE owner_id=?)").bind(ownerId, ownerId),
  ]);
  const state = values[0].results[0], sampleRows = values[1].results, previous = values[2].results[0];
  const nowMs = clock();
  if (sampleRows.some(row => row.source_available_at > nowMs)) throw appError("INVALID_ESTIMATION_SOURCE", "ATLM source availability is in the future.", 500);
  const limited = sampleRows.length > ATLM_TRAINING_LIMIT;
  const manifest = limited ? [] : sampleRows.map(row => row.sequence);
  const rows = limited ? [] : sampleRows.map(row => ({ sampleId: String(row.sequence), planId: row.plan_id,
    capturedAt: row.captured_at, sourceAvailableAt: row.source_available_at, features: atlmTrainingJson(row.features_json), actualMs: row.actual_ms }));
  const snapshot = { formatVersion: 1, generation: job.generation, modelId: "atlm-" + job.generation,
    modelVersion: job.generation, trainCutoff: nowMs, datasetRevision: state.dataset_revision,
    newSampleCount: state.new_sample_count, newSampleSequence: sampleRows.reduce((max, row) => Math.max(max, row.sequence), 0),
    activePointer: state.active_model_id, incumbentId: previous?.status === "ACTIVE" ? previous.model_id : null,
    forcedRetrain: Boolean(state.forced_retrain), manifest, resourceLimitReached: limited,
    selection: limited ? null : selectAtlmEvaluationCases(rows, { protocolVersion: 1, cutoff: nowMs }) };
  if (!limited && (snapshot.selection.status !== "AVAILABLE" || snapshot.selection.eligibleCount !== rows.length)) {
    throw appError("INVALID_ESTIMATION_SOURCE", "ATLM eligible snapshot contains invalid sources.", 500);
  }
  const checkpoint = { phase: limited ? "LIMIT" : "EVALUATE", cases: [], progressRevision: 1 };
  const saved = await dbFirst(db, `UPDATE estimation_jobs SET snapshot_json=?,checkpoint_json=?,updated_at=?
    WHERE owner_id=? AND job_key='train' AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?
      AND EXISTS(SELECT 1 FROM estimation_owner_state WHERE owner_id=? AND dataset_revision=?)
      AND NOT EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND kind='REFRESH_SAMPLE' AND generation>processed_generation)
    RETURNING *`, JSON.stringify(snapshot), JSON.stringify(checkpoint), nowMs, ownerId, job.generation, job.fence,
    nowMs, ownerId, state.dataset_revision, ownerId);
  return saved ? { snapshot, checkpoint, rows } : null;
}

function atlmCompareIncumbent(evaluation, incumbent) {
  if (!incumbent) return { accepted: true, reason: null, comparison: null };
  const artifact = atlmTrainingJson(incumbent.artifact_json);
  const seenPlans = new Set((artifact.manifest || []).map(row => row.planId));
  const cases = evaluation.cases.filter(c => !seenPlans.has(c.planId) && c.capturedAt >= incumbent.train_cutoff
    && c.capturedAt > incumbent.latest_source_available_at);
  const pairs = cases.map(c => ({ candidate: c.atlm, incumbent: predictAtlm(artifact, c.features), actualMs: c.actualMs }));
  const candidateCount = pairs.filter(p => p.candidate.status === "AVAILABLE").length;
  const incumbentCount = pairs.filter(p => p.incumbent.status === "AVAILABLE").length;
  const common = pairs.filter(p => p.candidate.status === "AVAILABLE" && p.incumbent.status === "AVAILABLE");
  const mae = key => common.length ? common.reduce((sum, p) => sum + Math.abs(p[key].pointMs - p.actualMs), 0) / common.length : null;
  const comparison = { caseCount: cases.length, commonCaseCount: common.length,
    candidateCoverage: cases.length ? candidateCount / cases.length : 0, incumbentCoverage: cases.length ? incumbentCount / cases.length : 0,
    candidateMaeMs: mae("candidate"), incumbentMaeMs: mae("incumbent") };
  if (common.length < 5) return { accepted: false, reason: "INSUFFICIENT_INCUMBENT_CASES", comparison };
  return { accepted: candidateCount >= incumbentCount && comparison.candidateMaeMs <= comparison.incumbentMaeMs,
    reason: candidateCount < incumbentCount ? "CANDIDATE_COVERAGE_WORSE" : comparison.candidateMaeMs > comparison.incumbentMaeMs ? "CANDIDATE_MAE_WORSE" : null, comparison };
}

async function atlmFinalizeTraining(db, ownerId, job, snapshot, checkpoint, result, nowMs) {
  const finalGuard = `EXISTS(SELECT 1 FROM estimation_jobs j JOIN estimation_owner_state o ON o.owner_id=j.owner_id
    WHERE j.owner_id=? AND j.job_key='train' AND j.generation=? AND j.fence=? AND j.status='RUNNING' AND j.lease_until>?
      AND o.active_model_id IS ? ${result.activate ? "AND " + atlmSourceValiditySql() : ""})`;
  const guardValues = [ownerId, job.generation, job.fence, nowMs, snapshot.activePointer];
  const modelStatus = result.activate ? "CANDIDATE" : "REJECTED";
  const digest = result.artifact?.datasetDigest || "sha256:" + await hashCommandInput({ manifest: snapshot.manifest, datasetRevision: snapshot.datasetRevision });
  const statements = [
    db.prepare(`INSERT OR IGNORE INTO estimation_models(owner_id,model_id,model_version,status,artifact_json,manifest_json,dataset_digest,
      train_cutoff,metrics_json,sample_count,reason,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${finalGuard}`).bind(ownerId, snapshot.modelId, snapshot.modelVersion, modelStatus,
      result.artifact ? JSON.stringify(result.artifact) : null, JSON.stringify(snapshot.manifest), digest, snapshot.trainCutoff,
      result.evaluation ? JSON.stringify(result.evaluation) : null, snapshot.manifest.length, result.reason, nowMs, ...guardValues),
  ];
  const candidateGuard = `${finalGuard} AND EXISTS(SELECT 1 FROM estimation_models WHERE owner_id=? AND model_id=? AND status=?)`;
  const candidateValues = [...guardValues, ownerId, snapshot.modelId, modelStatus];
  if (result.activate) {
    statements.push(db.prepare(`UPDATE estimation_models SET status='RETIRED' WHERE owner_id=? AND status='ACTIVE' AND ${candidateGuard}`)
      .bind(ownerId, ...candidateValues));
    statements.push(db.prepare(`UPDATE estimation_models SET status='ACTIVE',activated_at=? WHERE owner_id=? AND model_id=? AND status='CANDIDATE' AND ${finalGuard}`)
      .bind(nowMs, ownerId, snapshot.modelId, ...guardValues));
  }
  // Only an artifact successfully inserted by this fenced generation may acknowledge its experience.
  const completedGuard = `${finalGuard} AND EXISTS(SELECT 1 FROM estimation_models WHERE owner_id=? AND model_id=? AND status=?)`;
  const completedValues = [...guardValues, ownerId, snapshot.modelId, result.activate ? "ACTIVE" : "REJECTED"];
  statements.push(db.prepare(`UPDATE estimation_owner_state SET last_attempted_new_sample_count=MAX(last_attempted_new_sample_count,?),
    last_attempted_new_sample_sequence=MAX(last_attempted_new_sample_sequence,?),last_training_status=?,last_training_reason=?,updated_at=?,
    forced_retrain=CASE WHEN dataset_revision=? AND NOT EXISTS(${ATLM_PENDING_REFRESH_SQL}) THEN 0 ELSE forced_retrain END
    WHERE owner_id=? AND ${completedGuard}`)
    .bind(snapshot.newSampleCount, snapshot.newSampleSequence, result.status, result.reason, nowMs, snapshot.datasetRevision, ownerId, ...completedValues));
  // Update the pointer last, after all guards which compare the old pointer.
  if (result.activate) statements.push(db.prepare(`UPDATE estimation_owner_state SET active_model_id=? WHERE owner_id=? AND ${completedGuard}`)
    .bind(snapshot.modelId, ownerId, ...completedValues));
  // Pointer now names the candidate on success; use the same fence and immutable model receipt.
  statements.push(db.prepare(`UPDATE estimation_jobs SET processed_generation=generation,status='IDLE',lease_until=NULL,next_attempt_at=0,last_error=?,
    checkpoint_json=?,updated_at=? WHERE owner_id=? AND job_key='train' AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?
    AND EXISTS(SELECT 1 FROM estimation_models WHERE owner_id=? AND model_id=? AND status=?)`)
    .bind(result.status === "FAILED" ? result.reason : null,
      JSON.stringify({ ...checkpoint, phase: "DONE", progressRevision: checkpoint.progressRevision + 1 }), nowMs,
      ownerId, job.generation, job.fence, nowMs, ownerId, snapshot.modelId, result.activate ? "ACTIVE" : "REJECTED"));
  statements.push(...atlmEnqueueTrainingStatements(db, ownerId, nowMs));
  await db.batch(statements);
  const receipt = await dbFirst(db, "SELECT status FROM estimation_models WHERE owner_id=? AND model_id=?", ownerId, snapshot.modelId);
  return Boolean(receipt && receipt.status === (result.activate ? "ACTIVE" : "REJECTED"));
}

async function atlmSupersedeSnapshot(db, ownerId, job, snapshot, nowMs) {
  const guard = `EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key='train' AND generation=?
    AND fence=? AND status='RUNNING' AND lease_until>?)`;
  const values = [ownerId, job.generation, job.fence, nowMs];
  // Keep the obsolete manifest as an immutable receipt, then allocate another generation.
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO estimation_models(owner_id,model_id,model_version,status,manifest_json,dataset_digest,
      train_cutoff,sample_count,reason,created_at)
      SELECT ?,?,?,'REJECTED',?,?,?,?, 'SNAPSHOT_INVALIDATED',? WHERE ${guard}`)
      .bind(ownerId, snapshot.modelId, snapshot.modelVersion, JSON.stringify(snapshot.manifest),
        "sha256:" + await hashCommandInput({ manifest: snapshot.manifest, datasetRevision: snapshot.datasetRevision }),
        snapshot.trainCutoff, snapshot.manifest.length, nowMs, ...values),
    db.prepare(`UPDATE estimation_jobs SET processed_generation=generation,generation=generation+1,status='QUEUED',
      lease_until=NULL,attempts=0,next_attempt_at=0,snapshot_json=NULL,checkpoint_json=NULL,last_error=NULL,updated_at=?
      WHERE owner_id=? AND job_key='train' AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?`)
      .bind(nowMs, ...values),
    db.prepare(`UPDATE estimation_owner_state SET training_generation=(SELECT generation FROM estimation_jobs WHERE owner_id=? AND job_key='train'),
      last_training_status='QUEUED',last_training_reason='SNAPSHOT_INVALIDATED',updated_at=?
      WHERE owner_id=? AND EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key='train' AND generation=? AND fence=?)`)
      .bind(ownerId, nowMs, ownerId, ownerId, job.generation + 1, job.fence),
  ]);
}

async function atlmRecordFailure(db, ownerId, job, error, nowMs) {
  const code = atlmTrainingErrorCode(error), exhausted = job.attempts >= 4;
  const snapshot = atlmTrainingJson(job.snapshot_json);
  const nextAttempt = exhausted ? 0 : nowMs + ATLM_TRAINING_RETRY_MS[Math.max(0, job.attempts - 1)];
  const statements = [];
  if (exhausted && job.kind === "TRAIN") statements.push(db.prepare(`UPDATE estimation_owner_state SET
    last_attempted_new_sample_count=MAX(last_attempted_new_sample_count,COALESCE(?,new_sample_count)),
    last_attempted_new_sample_sequence=MAX(last_attempted_new_sample_sequence,COALESCE(?,(SELECT MAX(sequence) FROM estimation_samples WHERE owner_id=estimation_owner_state.owner_id),0)),
    last_training_status='FAILED',last_training_reason=?,
    forced_retrain=CASE WHEN NOT EXISTS(${ATLM_PENDING_REFRESH_SQL}) THEN 0 ELSE forced_retrain END,updated_at=?
    WHERE owner_id=? AND EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key=? AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?)`)
    .bind(snapshot?.newSampleCount ?? null, snapshot?.newSampleSequence ?? null, code, nowMs, ownerId, ownerId, job.job_key, job.generation, job.fence, nowMs));
  statements.push(db.prepare(`UPDATE estimation_jobs SET status=?,lease_until=NULL,next_attempt_at=?,last_error=?,updated_at=?
    WHERE owner_id=? AND job_key=? AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?`)
    .bind(exhausted ? "FAILED" : "RETRY_WAIT", nextAttempt, code, nowMs, ownerId, job.job_key, job.generation, job.fence, nowMs));
  await db.batch(statements);
  await atlmReleaseSuperseded(db, ownerId, job, nowMs);
}

export async function processEstimationTraining(db, ownerId, nowMs, options = {}) {
  const wallClock = typeof options.wallClock === "function" ? options.wallClock : () => performance.now();
  const started = wallClock();
  const clock = typeof options.clock === "function" ? options.clock : () => nowMs + Math.max(0, Math.floor(wallClock() - started));
  const budget = () => wallClock() - started < ATLM_TRAINING_BUDGET_MS;
  await db.prepare("INSERT OR IGNORE INTO estimation_owner_state(owner_id) SELECT owner_id FROM owners WHERE owner_id=?").bind(ownerId).run();
  // A crashed fourth attempt remains failed until new source data creates another generation.
  const expiredAt = clock();
  await db.batch([
    db.prepare(`UPDATE estimation_owner_state SET last_attempted_new_sample_count=MAX(last_attempted_new_sample_count,
      COALESCE((SELECT json_extract(snapshot_json,'$.newSampleCount') FROM estimation_jobs WHERE owner_id=? AND job_key='train'),new_sample_count)),
      last_attempted_new_sample_sequence=MAX(last_attempted_new_sample_sequence,
        COALESCE((SELECT json_extract(snapshot_json,'$.newSampleSequence') FROM estimation_jobs WHERE owner_id=estimation_owner_state.owner_id AND job_key='train'),
          (SELECT MAX(sequence) FROM estimation_samples WHERE owner_id=estimation_owner_state.owner_id),0)),
      last_training_status='FAILED',last_training_reason='LEASE_EXPIRED',updated_at=?,
      forced_retrain=CASE WHEN NOT EXISTS(${ATLM_PENDING_REFRESH_SQL}) THEN 0 ELSE forced_retrain END
      WHERE owner_id=? AND EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key='train'
        AND status='RUNNING' AND lease_until<=? AND attempts>=4)`).bind(ownerId, expiredAt, ownerId, ownerId, expiredAt),
    db.prepare(`UPDATE estimation_jobs SET status=CASE WHEN attempts>=4 THEN 'FAILED' WHEN attempts=0 THEN 'QUEUED' ELSE 'RETRY_WAIT' END,
      next_attempt_at=CASE WHEN attempts>=4 OR attempts=0 THEN 0 ELSE lease_until+CASE attempts WHEN 1 THEN 60000 WHEN 2 THEN 300000 ELSE 900000 END END,
      lease_until=NULL,last_error=CASE WHEN attempts=0 THEN NULL ELSE 'LEASE_EXPIRED' END,updated_at=?
      WHERE owner_id=? AND status='RUNNING' AND lease_until<=?`).bind(expiredAt, ownerId, expiredAt),
  ]);
  for (let operations = 0; operations < 100 && budget(); operations += 1) {
    await atlmEnqueueTraining(db, ownerId, clock());
    const next = await dbFirst(db, `SELECT * FROM estimation_jobs j WHERE j.owner_id=? AND j.generation>j.processed_generation
      AND j.status IN ('QUEUED','RETRY_WAIT') AND j.next_attempt_at<=?
      AND (j.kind='REFRESH_SAMPLE' OR NOT EXISTS(SELECT 1 FROM estimation_jobs r WHERE r.owner_id=j.owner_id AND r.kind='REFRESH_SAMPLE' AND r.generation>r.processed_generation))
      ORDER BY CASE j.kind WHEN 'REFRESH_SAMPLE' THEN 0 ELSE 1 END,j.updated_at,j.job_key LIMIT 1`, ownerId, clock());
    if (!next) break;
    let job = await claimAtlmJob(db, ownerId, next.job_key, clock(), ATLM_TRAINING_LEASE_MS, { allowExpiredLease: false });
    if (!job) continue;
    try {
      if (job.kind === "REFRESH_SAMPLE") {
        const source = await readAtlmSampleSource(db, ownerId, job.plan_id, clock());
        await persistAtlmSample(db, ownerId, source, clock(), { generation: job.generation, fence: job.fence });
        await db.prepare(`UPDATE estimation_jobs SET processed_generation=generation,status='IDLE',lease_until=NULL,next_attempt_at=0,last_error=NULL,updated_at=?
          WHERE owner_id=? AND job_key=? AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?`)
          .bind(clock(), ownerId, job.job_key, job.generation, job.fence, clock()).run();
        await atlmReleaseSuperseded(db, ownerId, job, clock());
        continue;
      }
      let snapshot = atlmTrainingJson(job.snapshot_json), checkpoint = atlmTrainingJson(job.checkpoint_json), rows;
      if (!snapshot) {
        const initial = await atlmSnapshot(db, ownerId, job, clock);
        if (!initial) { await atlmCheckpoint(db, ownerId, job, { phase: "SNAPSHOT", cases: [], progressRevision: (checkpoint?.progressRevision ?? 0) + 1 }, clock(), { release: true }); break; }
        ({ snapshot, checkpoint, rows } = initial);
        job.snapshot_json = JSON.stringify(snapshot);
      }
      if (snapshot.resourceLimitReached) {
        await atlmFinalizeTraining(db, ownerId, job, snapshot, checkpoint,
          { activate: false, status: "FAILED", reason: "DATASET_LIMIT_REACHED", artifact: null, evaluation: null }, clock());
        continue;
      }
      rows ||= await atlmManifestRows(db, ownerId, snapshot.manifest);
      if (snapshot.selection?.status !== "AVAILABLE") {
        await atlmFinalizeTraining(db, ownerId, job, snapshot, checkpoint,
          { activate: false, status: "COLLECTING_DATA", reason: snapshot.selection?.reason || "INVALID_DATASET", artifact: null, evaluation: null }, clock());
        continue;
      }
      let lostLease = false;
      while (checkpoint.cases.length < snapshot.selection.caseSampleIds.length && budget()) {
        const result = await evaluateAtlmCase(rows, snapshot.selection.caseSampleIds[checkpoint.cases.length], { protocolVersion: 1, cutoff: snapshot.trainCutoff });
        checkpoint = { ...checkpoint, phase: "EVALUATE", cases: [...checkpoint.cases, result], progressRevision: checkpoint.progressRevision + 1 };
        const saved = await atlmCheckpoint(db, ownerId, job, checkpoint, clock());
        if (!saved) { lostLease = true; break; }
      }
      if (lostLease) break;
      if (!budget() || checkpoint.cases.length < snapshot.selection.caseSampleIds.length) {
        await atlmCheckpoint(db, ownerId, job, checkpoint, clock(), { release: true });
        break;
      }
      const evaluation = summarizeAtlmEvaluation(checkpoint.cases, snapshot.selection);
      const initialReady = evaluation.paired?.caseCount >= 5;
      const initialGood = initialReady && evaluation.paired.atlm.maeMs <= evaluation.paired.median.maeMs;
      let rejection = !initialReady ? "INSUFFICIENT_EVALUATION_CASES" : !initialGood ? "MEDIAN_BASELINE_BETTER" : null;
      const incumbent = snapshot.incumbentId ? await dbFirst(db, `SELECT m.*,(SELECT MAX(s.source_available_at) FROM estimation_samples s
        WHERE s.owner_id=m.owner_id AND s.sequence IN (SELECT value FROM json_each(m.manifest_json))) AS latest_source_available_at
        FROM estimation_models m WHERE m.owner_id=? AND m.model_id=?`, ownerId, snapshot.incumbentId) : null;
      if (!rejection) {
        const comparison = atlmCompareIncumbent(evaluation, incumbent);
        evaluation.incumbentComparison = comparison.comparison;
        if (!comparison.accepted) rejection = comparison.reason;
      }
      if (rejection) {
        await atlmFinalizeTraining(db, ownerId, job, snapshot, checkpoint, { activate: false,
          status: rejection.startsWith("INSUFFICIENT_") ? "COLLECTING_DATA" : "REJECTED", reason: rejection, artifact: null, evaluation }, clock());
        continue;
      }
      checkpoint = { ...checkpoint, phase: "FIT", progressRevision: checkpoint.progressRevision + 1 };
      if (!await atlmCheckpoint(db, ownerId, job, checkpoint, clock())) break;
      if (!budget()) { await atlmCheckpoint(db, ownerId, job, checkpoint, clock(), { release: true }); break; }
      const fitted = await fitAtlm(rows);
      const final = { activate: fitted.status === "AVAILABLE", status: fitted.status === "AVAILABLE" ? "IDLE" : "COLLECTING_DATA",
        artifact: fitted.artifact || null, reason: fitted.reason || null, evaluation };
      if (!await atlmFinalizeTraining(db, ownerId, job, snapshot, checkpoint, final, clock())) {
        // A changed source invalidates this snapshot. A new generation captures current facts.
        await atlmSupersedeSnapshot(db, ownerId, job, snapshot, clock());
        break;
      }
    } catch (error) {
      await atlmRecordFailure(db, ownerId, job, error, clock());
      throw appError("SOURCE_UNAVAILABLE", "Не удалось завершить фоновое обучение. Задание сохранено для повтора.", 503,
        { retryable: true, reason: atlmTrainingErrorCode(error) });
    }
  }
  return getEstimationModelStatus(db, ownerId, clock());
}

export function scheduleAtlmTraining(db, ownerId, nowMs, ctx, clock) {
  if (!ctx || typeof ctx.waitUntil !== "function") return;
  try {
    const scheduledAt = performance.now();
    const trainingClock = typeof clock === "function" ? clock : () => nowMs + Math.max(0, Math.floor(performance.now() - scheduledAt));
    const task = Promise.resolve().then(async () => {
      // At most two bounded passes fit within the host's usual waitUntil lifetime.
      let previous = null;
      for (let pass = 0; pass < 2; pass += 1) {
        const status = await processEstimationTraining(db, ownerId, trainingClock(), { clock: trainingClock });
        const progress = canonical([status.datasetRevision, status.training.generation, status.training.progressRevision, status.training.pendingRefreshCount]);
        if (!status.training.due || progress === previous) break;
        previous = progress;
      }
    }).catch(error => { console.error(JSON.stringify({ event: "atlm_training_background_error", reason: atlmTrainingErrorCode(error) })); });
    ctx.waitUntil(task);
  } catch (error) {
    console.error(JSON.stringify({ event: "atlm_training_schedule_error", reason: atlmTrainingErrorCode(error) }));
  }
}

function publicView(value) {
  if(Array.isArray(value)) return value.map(publicView);
  if(!value || typeof value!=="object") return value;
  const hidden=new Set(["repositories","commits","commitConflicts","repositoryId","repositoryIds","repositoryRefs","repository_id","revisionSha","revision_sha","testedSha","tested_sha","baseRevisionSha","base_revision_sha","commitPolicy","pushPolicy","commit_policy","push_policy","gitEvidence"]);
  const result={};
  for(const [key,item] of Object.entries(value)) if(!hidden.has(key)) result[key]=key === "assessment" && item?.formatVersion === 1 ? item : publicView(item);
  return result;
}

async function apiRoute(request, env, url, channel, now, clock = () => now, ctx) {
  validateOrigin(request);
  const identity = requireOwner(request);
  if (!env.DB) throw appError("INTERNAL_ERROR", "D1 binding DB не настроен.", 503);
  if (request.method === "GET" && url.pathname === "/api/export") {
    return json(await buildExportReport(env.DB, identity.ownerId, clock), 200,
      { "content-disposition": "attachment; filename=plan-time-tracker-export.json" });
  }
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
  if (request.method === "GET" && url.pathname === "/api/plans") {
    const filter = {};
    for (const key of url.searchParams.keys()) if (!["statuses", "limit", "cursor", "deleted"].includes(key)) throw appError("VALIDATION_ERROR", "Неизвестный фильтр списка планов.");
    if (url.searchParams.has("statuses")) filter.statuses = url.searchParams.get("statuses").split(",");
    if (url.searchParams.has("limit")) filter.limit = Number(url.searchParams.get("limit"));
    if (url.searchParams.has("cursor")) filter.cursor = url.searchParams.get("cursor");
    if (url.searchParams.has("deleted")) {
      if (!["true", "false"].includes(url.searchParams.get("deleted"))) throw appError("VALIDATION_ERROR", "deleted должен быть true или false.");
      filter.deleted = url.searchParams.get("deleted") === "true";
    }
    return json(await listPlans(env.DB, identity.ownerId, now, filter));
  }

  if (request.method === "GET" && url.pathname === "/api/tracker/capabilities") return json(publicToolReferences(await readTrackerCapabilities(env.DB, identity.ownerId)));
  if (request.method === "POST" && url.pathname === "/api/tracker/assessment") return json(await readAssessment(env.DB, identity.ownerId, await bodyJson(request), now));
  const atlmPaths = { "/api/tracker/atlm-estimate": "CalculateAtlmEstimate", "/api/tracker/atlm-dataset": "GetAtlmDataset", "/api/tracker/estimation-model/process": "ProcessEstimationTraining" };
  if (request.method === "POST" && atlmPaths[url.pathname]) return json(await executeAtlmTool(env.DB, identity.ownerId, atlmPaths[url.pathname], await bodyJson(request), now, clock));
  if (request.method === "GET" && url.pathname === "/api/tracker/estimation-model") {
    if (url.search) throw appError("VALIDATION_ERROR", "Model status accepts no query parameters.");
    return json(await executeAtlmTool(env.DB, identity.ownerId, "GetEstimationModelStatus", {}, now, clock));
  }
  const atlmPlanMatch = url.pathname.match(/^\/api\/tracker\/plans\/([^/]+)\/estimate$/);
  if (request.method === "GET" && atlmPlanMatch) {
    if (url.search) throw appError("VALIDATION_ERROR", "Plan estimate accepts only planId.");
    return json(await executeAtlmTool(env.DB, identity.ownerId, "GetPlanEstimate", { planId: decodeURIComponent(atlmPlanMatch[1]) }, now, clock));
  }
  if (request.method === "POST" && url.pathname === "/api/tracker/estimation-history") return json(await readEstimationHistory(env.DB, identity.ownerId, await bodyJson(request), now));
  const trackerReceiptMatch = url.pathname.match(/^\/api\/tracker\/commands\/([^/]+)$/);
  if (request.method === "GET" && trackerReceiptMatch) return json(await readCommandReceipt(env.DB, identity.ownerId, decodeURIComponent(trackerReceiptMatch[1])));
  const executionMatch = url.pathname.match(/^\/api\/tracker\/plans\/([^/]+)\/execution$/);
  if (request.method === "GET" && executionMatch) return json(await readPlanExecutionSnapshot(env.DB, identity.ownerId, decodeURIComponent(executionMatch[1]), now));
  if (request.method === "GET" && url.pathname.startsWith("/api/plans/")) {
    const planId = decodeURIComponent(url.pathname.slice("/api/plans/".length));
    return json({ plan: await readPlan(env.DB, identity.ownerId, planId, now, url.searchParams.get("includeEvents") !== "false"), serverNow: now });
  }
  if (request.method === "POST" && url.pathname === "/api/commands") {
    const envelope=await bodyJson(request); validatePublicCommand(envelope);
    const result = await executeCommand(env.DB, identity, envelope, channel, now);
    scheduleAtlmTraining(env.DB, identity.ownerId, now, ctx, clock);
    return json(result);
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

const TOOL_NAMES = ["CreatePlan", "GetPlan", "ListPlans", "StartPlan", "PausePlan", "ResumePlan", "FinishPlan", "DeletePlan", "RestorePlan", "UpdatePlanMetadata", "GetTimeReport", ...TRACKER_READ_TOOLS, ...TRACKER_COMMANDS, "ProcessEstimationTraining", "StartEstimationTraining"];
// Public MCP names are independent from persisted command types and receipts.
const MCP_PUBLIC_NAMES = Object.freeze({
  UpdatePlanMetadata: "UpdatePlan", GetTrackerCapabilities: "GetTrackerInfo",
  GetPlanExecutionSnapshot: "GetPlanProgress", GetCommandReceipt: "GetCommandResult",
  CalculateAtlmEstimate: "EstimatePlanTime", GetPlanEstimate: "GetSavedEstimate",
  GetEstimationModelStatus: "GetTrainingStatus", StartEstimationTraining: "StartTraining",
  ProcessEstimationTraining: "ContinueTraining", GetAtlmDataset: "GetTrainingData",
  RecordAssessment: "SaveTaskAssessment", GetAssessment: "GetTaskAssessment",
  GetEstimationHistory: "GetTimeHistory",
});
const MCP_INTERNAL_NAMES = Object.freeze(Object.fromEntries(Object.entries(MCP_PUBLIC_NAMES).map(([oldName, newName]) => [newName, oldName])));
function publicToolReferences(value) {
  if (typeof value === "string") return MCP_PUBLIC_NAMES[value] || value;
  if (Array.isArray(value)) return value.map(publicToolReferences);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicToolReferences(item)]));
  return value;
}
const MCP_DESCRIPTIONS = Object.freeze({
  GetPlan: "Прочитать исходный текст, метаданные и текущее состояние плана по planId.",
  UpdatePlanMetadata: "Изменить название, описание или критерии плана, проверив текущую версию.",
  GetTrackerCapabilities: "Показать доступные функции трекера и их ограничения.",
  GetPlanExecutionSnapshot: "Показать текст и текущее состояние плана и этапов.",
  GetCommandReceipt: "Проверить результат ранее отправленной команды по её идентификатору.",
  SetStepStatus: "Изменить статус этапа исходного плана. Нужна текущая версия этапа; текст плана и таймер не меняются.",
  CalculateAtlmEstimate: "Получить прогноз полного активного времени плана по ATLM до первого запуска; прогноз не сохраняется.",
  GetPlanEstimate: "Прочитать сохранённый прогноз плана и узнать, не устарел ли он; новая оценка не рассчитывается.",
  GetEstimationModelStatus: "Посмотреть количество примеров, состояние обучения и причины исключения данных.",
  StartEstimationTraining: "По прямой просьбе пользователя запросить новую попытку обучения на доступных данных.",
  ProcessEstimationTraining: "Продолжить подготовку данных или уже запущенное обучение одним ограниченным проходом.",
  GetAtlmDataset: "Посмотреть сохранённые примеры обучения и причины исключения, с пагинацией.",
});
function mcpTools() {
  const writeNames = new Set([...WRITE_COMMANDS, ...TRACKER_COMMANDS]);
  const assessmentDescriptions = {
    RecordAssessment: "Записать оценку или неизменяемую ревизию. expectedVersion=0 создаёт серию; для новой ревизии передайте текущий номер ревизии в expectedVersion и причину в payload.reason. Метод и шкалу выбирает агент, прогноз отдельно в ms. Обязателен expectedRequirementsDigest из GetAssessment без assessmentId, прочитанный до анализа. Таймер не запускается.",
    GetAssessment: "Без assessmentId: прочитать текущие requirements/currentRequirementsDigest для анализа до первой оценки или пересмотра; stepId необязателен. С assessmentId: прочитать сохранённую ревизию (revision необязателен) и needsRevision; requirements в этом ответе относятся к сохранённому снимку.",
    GetEstimationHistory: "Факты и оценки по явным targets. Метрики ms раздельны, общий активный итог — объединение интервалов родителей. При пагинации сохраняйте asOf, throughSequence и nextAfterSequence как afterSequence. Окно дат относится к фактам времени, оценки читаются до asOf. Статистики относятся ко всей выборке фактов; readiness текущая. Время плана рассчитывается по рабочим интервалам.",
    CalculateEstimate: "Рассчитать медиану явных сопоставимых завершённых планов по серверным интервалам PLAN_ACTIVE. Профиль, отбор и покрытие являются утверждениями агента; текущие requirements и полное содержимое исходников проверяются на сервере. Read-only.",
  };
  return TOOL_NAMES.map((name) => {
    let inputSchema = { type: "object", additionalProperties: false };
    if (Object.hasOwn(ATLM_TOOL_SCHEMAS, name)) return { name, description: ({
      CalculateAtlmEstimate: "Предпросмотр полного PLAN_ACTIVE по активной ATLM-модели владельца до первого StartPlan. Только факты AgentTaskV1; ничего не обучает и не сохраняет.",
      GetPlanEstimate: "Сохранённый прогноз плана; после первого запуска только исходная frozen-оценка. isStale отмечает изменение требований или исходных данных модели.",
      GetEstimationModelStatus: "Состояние модели, накопление пригодных планов и очередь обучения владельца. Только чтение.",
      ProcessEstimationTraining: "Один ограниченный проход долговечной очереди владельца. Идемпотентная мутация без planId, с lease и fence; может потребоваться повторный проход.",
      StartEstimationTraining: "По явной просьбе пользователя запросить обучение на доступных данных независимо от порога пяти планов. Возвращает состояние очереди; качество и достаточность данных проверяются сервером.",
      GetAtlmDataset: "Приватная постраничная выгрузка неизменяемых sample-версий. Сохраняйте nextCursor; DATASET_CHANGED требует начать заново. Используется последняя версия каждого плана, только если она пригодна.",
    })[name], inputSchema: ATLM_TOOL_SCHEMAS[name], annotations: { readOnlyHint: !["ProcessEstimationTraining", "StartEstimationTraining"].includes(name), destructiveHint: false, idempotentHint: name !== "StartEstimationTraining", openWorldHint: false } };
    if (name === "GetPlan") inputSchema = { type: "object", required: ["planId"], properties: { planId: { type: "string", format: "uuid" } }, additionalProperties: false };
    else if (name === "ListPlans") inputSchema = { type: "object", properties: {
      statuses: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { enum: PLAN_STATUSES } },
      limit: { type: "integer", minimum: 1, maximum: MAX_PLAN_PAGE_SIZE, default: 50 },
      cursor: { type: "string", maxLength: 200 },
      deleted: { type: "boolean", default: false, description: "true — только удалённые планы; false — только обычные" },
    }, additionalProperties: false };
    else if (name === "GetTrackerCapabilities") inputSchema = { type: "object", properties: {}, additionalProperties: false };
    else if (name === "GetPlanExecutionSnapshot") inputSchema = { type: "object", required: ["planId"], properties: { planId: { type: "string", format: "uuid" } }, additionalProperties: false };
    else if (name === "GetCommandReceipt") inputSchema = { type: "object", required: ["commandId"], properties: { commandId: { type: "string", format: "uuid" } }, additionalProperties: false };
    else if (name === "GetTimeReport") inputSchema = { type: "object", required: ["from", "to", "timeZone"], properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" }, timeZone: { type: "string" } }, additionalProperties: false };
    else if (name === "GetAssessment") inputSchema = getAssessmentSchema;
    else if (name === "GetEstimationHistory") inputSchema = estimationHistorySchema;
    else if (name === "CalculateEstimate") inputSchema = estimateCalculatorSchema;
    else if (name === "RecordAssessment") inputSchema = { type: "object", additionalProperties: false,
      required: ["schemaVersion", "commandId", "expectedVersion", "payload"], properties: {
        schemaVersion: { const: 1 }, commandId: { type: "string", format: "uuid" }, expectedVersion: { type: "integer", minimum: 0 },
        payloadHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, payload: assessmentPayloadSchema,
      } };
    else if (writeNames.has(name)) {
      const required = ["schemaVersion", "commandId", "payload"];
      if ((WRITE_COMMANDS.has(name) && name !== "CreatePlan") || TRACKER_VERSIONED_COMMANDS.has(name)) required.push("expectedVersion");
      let payloadProperties = { planId: { type: "string", format: "uuid" } };
      let payloadRequired = ["planId"];
      let payloadAnyOf;
      if (name === "SetStepStatus") {
        payloadProperties = { stepId: { type: "string", format: "uuid" }, status: { enum: ["PENDING", "RUNNING", "BLOCKED", "FAILED", "DONE"] } };
        payloadRequired = ["stepId", "status"];
      } else if (name === "CreatePlan") {
        payloadProperties = {
          title: { type: "string", minLength: 1, maxLength: 200 },
          planText: { type: "string", minLength: 1, maxLength: 60000, description: "Полный исходный Markdown плана. Этапы из заголовков сохраняются автоматически; не пересказывайте их в отдельных полях." },
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
      } else if (["DeletePlan", "RestorePlan"].includes(name)) {
        payloadProperties.reason = { type: "string", maxLength: 1000 };
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
          expectedVersion: { type: "integer", minimum: TRACKER_VERSIONED_COMMANDS.has(name) ? 1 : 0 }, payloadHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          sourceReference: { type: "string", maxLength: 2048 },
          payload: { type: "object", required: payloadRequired, properties: payloadProperties, ...(payloadAnyOf ? { anyOf: payloadAnyOf } : {}), additionalProperties: false },
        }, additionalProperties: false,
      };
    }
    if (assessmentDescriptions[name]) return { name, description: assessmentDescriptions[name], inputSchema,
      ...(name === "CalculateEstimate" ? { annotations: { readOnlyHint: true, destructiveHint: false } } : {}) };
    return { name: name, description: name === "DeletePlan" ? "Переместить план в удалённые: остановить его таймер, сохранить план. Требует явной просьбы пользователя и текущей версии." : name === "RestorePlan" ? "Восстановить удалённый план без запуска таймера. Требует явной просьбы пользователя и текущей версии." : name === "ListPlans" ? "Список планов владельца с фильтрами statuses, deleted (по умолчанию false) и стабильной пагинацией nextCursor; RUNNING возвращает все активные планы. Не выбирает план для исполнителя." : name === "GetTimeReport" ? "Отчёт о фактически затраченном времени за период: totalActiveMs и activeByDay объединяют пересекающиеся интервалы, sumPlanActiveMs суммирует время планов. Это не прогноз. Значения в миллисекундах." : ["StartPlan", "ResumePlan", "PausePlan", "FinishPlan"].includes(name) ? name + ": меняет только указанный planId; другие планы продолжаются независимо." : name === "CreatePlan" ? "Сохранить готовый план целиком в planText и создать его этапы из заголовков. Таймер не запускается." : name + " через общий командный/API слой Sites.", inputSchema: inputSchema };
  }).map(tool => ({ ...tool, name: MCP_PUBLIC_NAMES[tool.name] || tool.name, description: Object.entries(MCP_PUBLIC_NAMES).reduce((text, [oldName, newName]) => text.replaceAll(oldName, newName), MCP_DESCRIPTIONS[tool.name] || tool.description) }));
}

function unexpectedMcpErrorReason(error) {
  for (let current = error, depth = 0; current && depth < 3; current = current.cause, depth++) {
    const message = typeof current.message === "string" ? current.message : "";
    if (message.includes("too many terms in compound SELECT")) return "D1_COMPOUND_SELECT_LIMIT";
    if (message.includes("D1 DB is overloaded.")) return "D1_RESOURCE_LIMIT";
  }
  return "UNEXPECTED_ERROR";
}

async function mcpRoute(request, env, now, ctx, clock = () => now) {
  if (request.method !== "POST") return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "POST required" } }, 405);
  validateOrigin(request);
  const rpc = await bodyJson(request);
  if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return json({ jsonrpc: "2.0", id: rpc && rpc.id || null, error: { code: -32600, message: "Invalid JSON-RPC request" } }, 400);
  const id = rpc.id == null ? null : rpc.id;
  if (rpc.method === "initialize") return json({ jsonrpc: "2.0", id: id, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "plan-time-tracker", version: TRACKER_VERSION } } });
  if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (rpc.method === "ping") return json({ jsonrpc: "2.0", id: id, result: {} });
  if (rpc.method === "tools/list") return json({ jsonrpc: "2.0", id: id, result: { tools: mcpTools() } });
  if (rpc.method !== "tools/call") return json({ jsonrpc: "2.0", id: id, error: { code: -32601, message: "Method not found" } });
  const identity = requireOwner(request);
  if (!env.DB) return json({ jsonrpc: "2.0", id: id, result: { isError: true, content: [{ type: "text", text: "D1 binding DB не настроен." }] } });
  const publicName = rpc.params && rpc.params.name;
  const name = MCP_INTERNAL_NAMES[publicName] || publicName;
  const args = rpc.params && rpc.params.arguments || {};
  try {
    if(!TOOL_NAMES.includes(name)) throw appError("FEATURE_REMOVED","Инструмент недоступен в текущем контракте.",410);
    if(name==="GetTimeReport" && Object.hasOwn(args,"repositoryIds")) throw appError("VALIDATION_ERROR","Фильтр удален из текущего контракта.");
    if(WRITE_COMMANDS.has(name)||TRACKER_COMMANDS.has(name)) validatePublicCommand({...args,commandType:name});
    await ensureOwner(env.DB, identity, now);
    let result;
    if (Object.hasOwn(ATLM_TOOL_SCHEMAS, name)) result = await executeAtlmTool(env.DB, identity.ownerId, name, rpc.params?.arguments === undefined ? {} : rpc.params.arguments, now, clock);
    else if (name === "GetPlan") result = await readPlan(env.DB, identity.ownerId, args.planId, now);
    else if (name === "GetAssessment") result = await readAssessment(env.DB, identity.ownerId, args, now);
    else if (name === "CalculateEstimate") result = await readCalculatedEstimate(env.DB, identity.ownerId, args, now);
    else if (name === "GetEstimationHistory") result = await readEstimationHistory(env.DB, identity.ownerId, args, now);
    else if (name === "ListPlans") result = await listPlans(env.DB, identity.ownerId, now, args);
    else if (name === "GetTimeReport") result = await buildAnalytics(env.DB, identity.ownerId, args, now);
    else if (name === "GetTrackerCapabilities") result = publicToolReferences(await readTrackerCapabilities(env.DB, identity.ownerId));
    else if (name === "GetPlanExecutionSnapshot") result = await readPlanExecutionSnapshot(env.DB, identity.ownerId, args.planId, now);
    else if (name === "GetCommandReceipt") result = await readCommandReceipt(env.DB, identity.ownerId, args.commandId);
    else if (WRITE_COMMANDS.has(name) || TRACKER_COMMANDS.has(name)) {
      const envelope = { ...args, schemaVersion: args.schemaVersion || 1, commandType: name };
      result = await executeCommand(env.DB, identity, envelope, "mcp", now);
      scheduleAtlmTraining(env.DB, identity.ownerId, now, ctx, clock);
    } else throw appError("VALIDATION_ERROR", "Неизвестный MCP tool.");
    return json({ jsonrpc: "2.0", id: id, result: { content: [{ type: "text", text: JSON.stringify(publicView(result)) }], structuredContent: publicView(result) } });
  } catch (error) {
    const e = error instanceof AppError ? error : appError("INTERNAL_ERROR", "Внутренняя ошибка.", 500);
    const requestId = crypto.randomUUID();
    if (!(error instanceof AppError)) {
      console.error(JSON.stringify({ event: "mcp_unexpected_error", tool: TOOL_NAMES.includes(name) ? name : "UNKNOWN",
        requestId, reason: unexpectedMcpErrorReason(error) }));
    }
    const body = {
      code: e.code, message: e.message, details: e.details || null,
      requestId,
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
        if (url.pathname === "/mcp") return await mcpRoute(request, env, now, ctx, getNow);
        if (url.pathname.startsWith("/api/")) {
          const response=await apiRoute(request,env,url,"ui",now,getNow,ctx);
          return new Response(JSON.stringify(publicView(await response.json())),{status:response.status,headers:response.headers});
        }
        if (request.method !== "GET" && request.method !== "HEAD") throw appError("NOT_FOUND", "Маршрут не найден.", 404);
        requireOwner(request);
        return new Response(uiHtml(), { headers: {
          "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store",
          "content-security-policy": "default-src 'none'; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
        } });
      } catch (error) { return workerError(error); }
    },
  };
}

export default createWorker();
