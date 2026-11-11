import { UI_FONT_CSS } from "./fonts.js";

const TRACKER_VERSION = "0.5.0";
const BODY_LIMIT = 128 * 1024;
const TRACKER_LEASE_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;
const SNAPSHOT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const isSnapshotDigest = value => typeof value === "string" && value.length === 71 && SNAPSHOT_DIGEST.test(value);
const WRITE_COMMANDS = new Set(["CreatePlan", "StartPlan", "PausePlan", "ResumePlan", "FinishPlan", "UpdatePlanMetadata", "DeletePlan", "RestorePlan"]);
const TRACKER_COMMANDS = new Set(["CreateStep", "UpdateStep", "ClaimStepAttempt", "RenewStepLease", "CloseStepAttempt", "StartStep", "BlockStep", "RecordStepResult", "RecordCheck", "AppendObservation", "RecordAssessment"]);
const TRACKER_VERSIONED_COMMANDS = new Set(["UpdateStep", "ClaimStepAttempt", "StartStep", "BlockStep", "RecordStepResult"]);
const TRACKER_READ_TOOLS = new Set(["GetTrackerCapabilities", "GetPlanExecutionSnapshot", "GetTimeline", "GetCommandReceipt", "GetAssessment", "GetEstimationHistory", "CalculateEstimate", "CalculateAtlmEstimate", "GetPlanEstimate", "GetEstimationModelStatus", "GetAtlmDataset"]);
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
    STEP_ALREADY_EXISTS: "Этап с таким порядком уже существует.",
    REWORK_REQUIRED: "Для повторной работы по завершённому этапу укажите явное разрешение и причину.",
    CHECKPOINTS_INCOMPLETE: "Завершите этапы и обязательные проверки текущих результатов либо укажите причину завершения с исключением.",
    RESULT_REVISION_STALE: "Основание проверки не совпадает с указанной ревизией результата.",
    ASSESSMENT_TARGET_CONFLICT: "Серия оценки уже привязана к другой цели.",
    ASSESSMENT_CONTEXT_CHANGED: "Требования изменились после анализа задачи. Перечитайте контекст и пересмотрите оценку.",
    ATLM_FORECAST_SCOPE_CHANGED: "План уже запущен. Новый исходный прогноз сохранять нельзя.",
    ATLM_MODEL_CHANGED: "Модель изменилась во время расчёта. Получите свежую оценку новой командой.",
    DATASET_CHANGED: "Набор обучающих данных изменился. Начните выгрузку заново.",
    ASSESSMENT_SOURCE_NOT_FOUND: "Исторический источник оценки недоступен.",
    ACTIVE_ATTEMPT_EXISTS: "У этапа уже есть активная попытка.",
    LEASE_CONFLICT: "Попытка больше не владеет действующей арендой.",
    ATTEMPT_CLOSED: "Попытка уже закрыта.",
    PLAN_PAUSED: "План на паузе. Сначала явно возобновите его.",
    PLAN_COMPLETED: "Завершённый план не принимает новые этапы.",
    FEATURE_UNAVAILABLE: "Tracker-функции для этого плана недоступны.",
    INVALID_TRANSITION: "Команда недоступна в текущем состоянии плана.",
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
    const status = ["ATLM_FORECAST_SCOPE_CHANGED", "ATLM_MODEL_CHANGED", "ASSESSMENT_TARGET_CONFLICT", "ASSESSMENT_CONTEXT_CHANGED", "VERSION_CONFLICT", "STEP_ALREADY_EXISTS", "ACTIVE_ATTEMPT_EXISTS", "LEASE_CONFLICT", "ATTEMPT_CLOSED", "RESULT_REVISION_STALE", "REPOSITORY_NOT_ATTACHED", "REPOSITORY_UNAVAILABLE", "STEP_NOT_STARTED", "LEASE_EXPIRED", "LEASE_FENCED", "REPOSITORY_ALREADY_ATTACHED", "CHECKPOINTS_INCOMPLETE", "REWORK_REQUIRED", "OBSERVATION_CONFLICT", "IDEMPOTENCY_KEY_REUSED", "COMMIT_EXCLUDED", "PLAN_DELETED", "PLAN_NOT_DELETED"].includes(code) ? 409 :
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

// Shared schema is used by assessment discovery and by the server normalizer.
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
    EXISTS(SELECT 1 FROM tracker_plan_config cfg WHERE cfg.owner_id=p.owner_id AND cfg.plan_id=p.plan_id AND cfg.enabled=1) AS tracker_enabled,
    (SELECT COUNT(*) FROM tracker_incomplete_steps s WHERE s.owner_id=p.owner_id AND s.plan_id=p.plan_id) AS incomplete_step_count,
    (SELECT json_group_array(json_object('startMs',w.start_ms,'endMs',w.end_ms)) FROM work_intervals w WHERE w.owner_id=p.owner_id AND w.plan_id=p.plan_id) AS intervals_json,
    (SELECT json_group_array(json_object('rowid',r.rowid,'type',r.command_type,'at',r.server_now_ms)) FROM command_receipts r
      WHERE r.owner_id=p.owner_id AND r.plan_id=p.plan_id AND r.outcome_code='OK'
        AND r.command_type IN ('StartPlan','ResumePlan','PausePlan','FinishPlan','DeletePlan')) AS timer_commands_json,
    (SELECT json_group_array(json_object('stepId',s.step_id,'ordinal',s.ordinal,'title',s.title,'expectedResult',s.expected_result,
      'requiredChecks',json(s.required_checks_json),'status',s.status,'resultRevision',s.current_result_revision,'resultOutcome',r.outcome,'resultCreatedAt',r.created_at))
      FROM plan_steps s LEFT JOIN step_results r ON r.owner_id=s.owner_id AND r.step_id=s.step_id AND r.revision=s.current_result_revision
      WHERE s.owner_id=p.owner_id AND s.plan_id=p.plan_id) AS steps_json,
    (SELECT json_group_array(json_object('stepId',c.step_id,'resultRevision',c.result_revision,'key',c.check_key,'status',c.status,'exitCode',c.exit_code,'matchesResult',c.matches_result,'createdAt',c.created_at))
      FROM tracker_latest_checks c JOIN plan_steps s ON s.owner_id=c.owner_id AND s.step_id=c.step_id AND s.current_result_revision=c.result_revision
      WHERE s.owner_id=p.owner_id AND s.plan_id=p.plan_id AND EXISTS(SELECT 1 FROM json_each(s.required_checks_json) k WHERE k.value=c.check_key)) AS checks_json,
    (SELECT json_group_array(json_object('rowid',r.rowid,'type',r.command_type,'payload',json(r.payload_json))) FROM command_receipts r
      WHERE r.owner_id=p.owner_id AND r.plan_id=p.plan_id AND r.outcome_code='OK' AND r.rowid>i.captured_receipt_rowid
       AND r.command_type IN ('UpdatePlanMetadata','UpdateStep','CreateStep')) AS scope_commands_json
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
    const original = JSON.parse(row.input_requirements_json), initialSteps = new Map((original.steps || []).map(step => [step.stepId, step]));
    for (const change of JSON.parse(row.scope_commands_json).sort((a, b) => a.rowid - b.rowid)) {
      const p = change.payload;
      if (change.type === "CreateStep") scopeChanged = true;
      if (change.type === "UpdatePlanMetadata") for (const key of ["title", "description", "acceptanceCriteria"]) {
        if (Object.hasOwn(p, key) && (p[key] ?? "") !== original.plan[key]) scopeChanged = true;
      }
      if (change.type === "UpdateStep") {
        const originalStep = initialSteps.get(p.stepId), fields = p.changes || {};
        if (!originalStep) { scopeChanged = true; continue; }
        for (const key of ["ordinal", "title", "expectedResult"]) if (Object.hasOwn(fields, key) && fields[key] !== originalStep[key]) scopeChanged = true;
        if (Object.hasOwn(fields, "requiredChecksJson") && canonical(JSON.parse(fields.requiredChecksJson)) !== canonical(originalStep.requiredChecks)) scopeChanged = true;
      }
    }
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
    ...steps.map(s => s.resultCreatedAt ?? 0), ...checks.map(c => c.createdAt));
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
  return processEstimationTraining(db, ownerId, nowMs, { clock });
}

const FORECAST_METRICS = ["PLAN_ACTIVE", "CALENDAR", "PAUSED", "STEP_ATTRIBUTED", "ATTEMPT", "TOOL"];
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
      CASE WHEN p.deleted_at IS NULL AND EXISTS(SELECT 1 FROM tracker_plan_config config
        WHERE config.owner_id=p.owner_id AND config.plan_id=p.plan_id AND config.enabled=1) THEN 1 ELSE 0 END AS tracker_enabled,
      CASE WHEN p.deleted_at IS NULL THEN (SELECT COUNT(*) FROM plan_steps step
        WHERE step.owner_id=p.owner_id AND step.plan_id=p.plan_id) ELSE 0 END AS step_count,
      CASE WHEN p.deleted_at IS NULL THEN (SELECT COUNT(*) FROM tracker_incomplete_steps incomplete
        WHERE incomplete.owner_id=p.owner_id AND incomplete.plan_id=p.plan_id) ELSE 0 END AS incomplete_step_count,
      CASE WHEN p.deleted_at IS NULL THEN MAX(
        p.registered_at,COALESCE(p.finished_at,p.registered_at),
        COALESCE((SELECT MAX(event.server_occurred_at) FROM plan_events event WHERE event.owner_id=p.owner_id AND event.plan_id=p.plan_id),p.registered_at),
        COALESCE((SELECT MAX(step.created_at) FROM plan_steps step WHERE step.owner_id=p.owner_id AND step.plan_id=p.plan_id),p.registered_at),
        COALESCE((SELECT MAX(step.updated_at) FROM plan_steps step WHERE step.owner_id=p.owner_id AND step.plan_id=p.plan_id),p.registered_at),
        COALESCE((SELECT MAX(result.created_at) FROM step_results result JOIN plan_steps step
          ON step.owner_id=result.owner_id AND step.step_id=result.step_id
          WHERE step.owner_id=p.owner_id AND step.plan_id=p.plan_id),p.registered_at),
        COALESCE((SELECT MAX(evidence.created_at) FROM tracker_check_evidence evidence JOIN plan_steps step
          ON step.owner_id=evidence.owner_id AND step.step_id=evidence.step_id
          WHERE step.owner_id=p.owner_id AND step.plan_id=p.plan_id),p.registered_at)
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
async function readEstimationHistory(db, ownerId, args, nowMs) {
  validateAssessmentValue(args, estimationHistorySchema);
  const timeZone = checkTimeZone(args.timeZone), range = inclusiveDateRange(args.from, args.to, timeZone);
  const asOf = args.asOf ?? nowMs, limit = args.limit ?? 50;
  const throughSequence = args.throughSequence ?? (await dbFirst(db, "SELECT COALESCE(MAX(sequence),0) AS seq FROM assessment_revisions WHERE owner_id=?", ownerId)).seq;
  if (asOf > nowMs) throw appError("VALIDATION_ERROR", "asOf exceeds server time.");
  const targetKeys = args.targets.map(t => t.planId + ":" + (t.stepId || ""));
  if (new Set(targetKeys).size !== targetKeys.length) throw appError("VALIDATION_ERROR", "Duplicate targets.");
  const facts = [], allIntervals = [], planCache = new Map();
  const clip = (start, end) => [Math.max(start, range.startMs), Math.min(end, range.endMs, asOf)];
  const elapsed = intervals => unionIntervals(intervals.filter(([s, e]) => e > s)).reduce((n, [s, e]) => n + e - s, 0);
  for (const target of args.targets) {
    let cached = planCache.get(target.planId);
    if (!cached) {
      const plan = await dbFirst(db, "SELECT * FROM plans WHERE owner_id=? AND plan_id=? AND deleted_at IS NULL", ownerId, target.planId);
      if (!plan) throw appError("PLAN_NOT_FOUND", messageFor("PLAN_NOT_FOUND"), 404);
      const intervals = await dbAll(db, "SELECT interval_id,start_ms,end_ms FROM work_intervals WHERE owner_id=? AND plan_id=? AND start_ms<=? ORDER BY start_ms", ownerId, target.planId, asOf);
      const windows = intervals.map(i => clip(i.start_ms, i.end_ms ?? asOf));
      allIntervals.push(...windows);
      const stepReport = await buildStepAnalytics(db, ownerId, target.planId, { ...args, timeZone, asOf }, nowMs);
      cached = { plan, intervals, windows, stepReport }; planCache.set(target.planId, cached);
    }
    const { plan, intervals, windows, stepReport } = cached;
    const step = target.stepId ? stepReport.steps.find(s => s.stepId === target.stepId) : null;
    if (target.stepId && !step) throw appError("STEP_NOT_FOUND", messageFor("STEP_NOT_FOUND"), 404);
    const calendarMeasured = plan.first_started_at !== null && plan.first_started_at <= asOf;
    const activeMeasured = calendarMeasured && intervals.length > 0;
    const planActiveMs = activeMeasured ? elapsed(windows) : null;
    const calendarMs = calendarMeasured ? elapsed([clip(plan.first_started_at, plan.finished_at ?? asOf)]) : null;
    const attempts = await dbAll(db, `WITH attempts AS (
      SELECT a.attempt_id,a.step_id,a.started_at AS claimed_at,a.closed_at,a.lease_until,
      (SELECT MIN(j.occurred_at) FROM tracker_journal j WHERE j.owner_id=a.owner_id AND j.attempt_id=a.attempt_id AND j.event_type='STEP_STARTED' AND j.command_id IS NOT NULL AND j.occurred_at<=?) AS execution_started_at
      FROM step_attempts a JOIN plan_steps s ON s.owner_id=a.owner_id AND s.step_id=a.step_id
      WHERE s.owner_id=? AND s.plan_id=? AND (? IS NULL OR s.step_id=?) AND a.started_at<=?
    ), windows AS (
      SELECT attempts.*,MIN(COALESCE(closed_at,?),lease_until,?) AS execution_ended_at FROM attempts
    ) SELECT * FROM windows
      WHERE (execution_started_at IS NULL AND claimed_at>=? AND claimed_at<?)
        OR (execution_started_at<=? AND execution_started_at<? AND
          (execution_ended_at>? OR (execution_ended_at=execution_started_at AND execution_started_at>=?)))
      ORDER BY claimed_at,attempt_id LIMIT 101`, asOf, ownerId, target.planId, target.stepId ?? null, target.stepId ?? null, asOf,
      asOf, asOf, range.startMs, range.endMs, asOf, range.endMs, range.startMs, range.startMs);
    const observations = await dbAll(db, `WITH selected_tools AS MATERIALIZED (
      SELECT owner_id,plan_id,event_id,step_id,source_id,session_id,occurred_at,classification,payload_json,server_sequence
      FROM tracker_journal WHERE owner_id=? AND plan_id=? AND (? IS NULL OR step_id=?)
        AND event_type='tool_finished' AND received_at<=? AND occurred_at>=? AND occurred_at<? AND occurred_at<=?
      ORDER BY server_sequence LIMIT 101
    ) SELECT j.event_id,j.step_id,j.source_id,j.session_id,j.occurred_at,j.classification,j.payload_json,
      (SELECT COUNT(*) FROM tracker_journal start WHERE start.owner_id=j.owner_id AND start.plan_id=j.plan_id
        AND start.source_id=j.source_id AND start.session_id=j.session_id AND start.event_type='tool_started'
        AND json_extract(start.payload_json,'$.data.operationId')=json_extract(j.payload_json,'$.data.operationId')
        AND start.step_id IS j.step_id AND start.classification='NORMAL'
        AND NOT EXISTS(SELECT 1 FROM tracker_journal correction WHERE correction.owner_id=start.owner_id
          AND correction.correction_of_event_id=start.event_id AND correction.received_at<=?)
        AND start.occurred_at<=j.occurred_at AND start.received_at<=?) AS matching_starts,
      (SELECT COUNT(*) FROM tracker_journal finish WHERE finish.owner_id=j.owner_id AND finish.plan_id=j.plan_id
        AND finish.source_id=j.source_id AND finish.session_id=j.session_id AND finish.event_type='tool_finished'
        AND json_extract(finish.payload_json,'$.data.operationId')=json_extract(j.payload_json,'$.data.operationId') AND finish.received_at<=?) AS matching_finishes,
      EXISTS(SELECT 1 FROM tracker_journal correction WHERE correction.owner_id=j.owner_id AND correction.correction_of_event_id=j.event_id AND correction.received_at<=?) AS corrected
      FROM selected_tools j ORDER BY j.server_sequence`, ownerId, target.planId, target.stepId ?? null, target.stepId ?? null,
      asOf, range.startMs, range.endMs, asOf, asOf, asOf, asOf, asOf);
    const tools = observations.slice(0, 100).map(o => {
      const data = JSON.parse(o.payload_json).data;
      return { eventId: o.event_id, stepId: o.step_id, sourceId: o.source_id, sessionId: o.session_id,
        operationId: data.operationId, toolName: data.toolName, status: data.status, classification: o.classification,
        reportedDurationMs: data.durationMs ?? null, matchedStart: o.matching_starts === 1,
        durationMs: o.matching_starts === 1 && o.matching_finishes === 1 && !o.corrected && o.classification === "NORMAL" ? data.durationMs ?? null : null,
        measurement: "client-reported duration of a finished call; selected by finish time, not clipped or treated as task time" };
    });
    const snapshot = await readPlanExecutionSnapshot(db, ownerId, target.planId, nowMs);
    facts.push({ ...target, source: "server work_intervals and STEP_STARTED; client tool observations", units: "ms",
      planStatus: plan.status, planActiveMs, calendarMs, pausedMs: activeMeasured ? Math.max(0, calendarMs - planActiveMs) : null,
      stepAttributedMs: step?.activeMs ?? null, ambiguousMs: step ? step.ambiguousMs : stepReport.ambiguousMs,
      unattributedMs: stepReport.unattributedMs, intervals,
      attempts: attempts.slice(0, 100).map(a => ({ ...a, durationMs: a.execution_started_at === null ? null : elapsed([clip(a.execution_started_at, a.execution_ended_at)]),
        measurement: "execution window bounded by lease; not full task duration" })),
      tools, truncation: { attempts: attempts.length > 100, tools: observations.length > 100, sampleLimit: 100 },
      currentReadiness: target.stepId ? snapshot.steps.find(s => s.step_id === target.stepId)?.readyToFinish ?? false : snapshot.plan.completion.readyToFinish,
      limitations: ["readiness is current, not historical asOf", "step attribution may be partial or ambiguous", "attempt and tool windows are not task duration", "tool measurements are client reported; missing, corrected, duplicate or non-normal observations are not trusted"] });
  }
  const selection = args.targets.map(() => "(plan_id=? AND step_id IS ?)").join(" OR ");
  const history = await dbAll(db, `SELECT * FROM assessment_revisions WHERE owner_id=? AND (${selection}) AND sequence>? AND sequence<=? AND recorded_at<=? ORDER BY sequence LIMIT ?`,
    ownerId, ...args.targets.flatMap(t => [t.planId, t.stepId ?? null]), args.afterSequence ?? 0, throughSequence, asOf, limit + 1);
  const statistics = [];
  for (const scope of ["plan", "step"]) {
    const selected = facts.filter(f => scope === "step" ? f.stepId : !f.stepId);
    for (const [metric, field] of scope === "plan" ? [["PLAN_ACTIVE", "planActiveMs"], ["CALENDAR", "calendarMs"], ["PAUSED", "pausedMs"]] : [["STEP_ATTRIBUTED", "stepAttributedMs"]]) {
      statistics.push({ scope, metric, units: "ms", ...durationStatistics(selected.map(f => f[field])) });
    }
    for (const [metric, field] of [["ATTEMPT", "attempts"], ["TOOL", "tools"]]) {
      statistics.push({ scope, metric, units: "ms", ...durationStatistics(selected.flatMap(f => f[field].map(item => item.durationMs))),
        truncated: selected.some(f => f.truncation[field]), source: metric === "TOOL" ? "matched client-reported call durations" : "lease-bounded execution windows",
        limitations: "bounded samples, not complete task durations; TOOL calls selected by finish time" });
    }
  }
  return { asOf, throughSequence, serverNow: nowMs, period: { from: args.from, to: args.to, timeZone, ...range }, targets: args.targets,
    facts, statistics, totalActiveMs: [...planCache.values()].some(p => p.plan.first_started_at !== null && p.plan.first_started_at <= asOf && p.intervals.length) ? elapsed(allIntervals) : null,
    totalActiveMeasurement: "union of selected parent plan intervals; never add step or attempt durations",
    assessments: await Promise.all(history.slice(0, limit).map(row => assessmentView(db, ownerId, row))),
    nextAfterSequence: history.length > limit ? history[limit - 1].sequence : null,
    assessmentStatistics: "not aggregated across methods, scales or metrics", selectionResponsibility: "agent" };
}

function validateTrackerCommand(envelope) {
  if (envelope?.commandType === "RecordAssessment") return validateAssessmentCommand(envelope);
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
    if (typeof payload.sourceId !== "string" || !payload.sourceId.trim() || payload.sourceId !== payload.sourceId.trim() || payload.sourceId.length > 128) throw appError("VALIDATION_ERROR", "sourceId обязателен, не должен иметь пробелов по краям и ограничен 128 символами.");
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
    if (typeof payload.sourceId !== "string" || !payload.sourceId.trim() || payload.sourceId !== payload.sourceId.trim() || payload.sourceId.length > 128) throw appError("VALIDATION_ERROR", "sourceId обязателен, не должен иметь пробелов по краям и ограничен 128 символами.");
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
  let predictionPreparationError = null;
  const addEvent = async (event, eventId = crypto.randomUUID()) => ({
    eventId: eventId,
    eventPayloadJson: canonical(event),
    eventPayloadHash: await hashCommandInput(event),
  });

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
      ...await addEvent({ assessmentId: input.assessmentId, revision: envelope.expectedVersion + 1 }),
    });
  } else if (envelope.commandType === "CreateStep") {
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
    payload.lifecycleEventId = crypto.randomUUID();
    const event = { planId: payload.planId, reason: payload.reason || "" };
    payload.lifecycleEventPayloadJson = canonical(event);
    payload.lifecycleEventPayloadHash = await hashCommandInput(event);
  }
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
  const completion = await dbFirst(db, "SELECT (SELECT COUNT(*) FROM tracker_incomplete_steps WHERE owner_id=? AND plan_id=?) AS incompleteStepCount,(SELECT COUNT(*) FROM tracker_plan_config WHERE owner_id=? AND plan_id=? AND enabled=1) AS enabled", ownerId, row.plan_id, ownerId, row.plan_id);
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

async function readPlan(db, ownerId, planId, nowMs, includeEvents = true) {
  const row = await dbFirst(db, "SELECT * FROM plans WHERE owner_id=? AND plan_id=?", ownerId, planId);
  if (!row) throw appError("PLAN_NOT_FOUND", "План не найден.", 404);
  const plan = await planSummary(db, ownerId, row, nowMs);
  if (includeEvents) plan.events = await dbAll(db, "SELECT event_id,command_id,actor_id,actor_type,event_type,server_occurred_at,version_before,version_after,reason FROM plan_events WHERE owner_id=? AND plan_id=? ORDER BY server_occurred_at,event_id", ownerId, planId);
  plan.dateHistory = await dbAll(db, "SELECT old_precision,old_at_ms,old_on,old_timezone,changed_at,changed_by,reason FROM plan_date_history WHERE owner_id=? AND plan_id=? ORDER BY changed_at", ownerId, planId);
  return plan;
}

// One statement gives every exported collection the same SQLite/D1 read snapshot.
// Return one JSON record per row rather than one unbounded JSON aggregate cell.
const EXPORT_SOURCES = {
  settings: ["owners", "timezone"],
  plans: ["plans", "plan_id,title,description,acceptance_criteria,plan_created_precision,plan_created_at_ms,plan_created_on,plan_created_timezone,registered_at,status,deleted_at,first_started_at,finished_at,source_reference"],
  intervals: ["work_intervals", "interval_id,plan_id,start_ms,end_ms"],
  events: ["plan_events", "event_id,plan_id,command_id,actor_type,event_type,server_occurred_at,reason,version_after"],
  dates: ["plan_date_history", "history_id,plan_id,old_precision,old_at_ms,old_on,old_timezone,changed_at,reason"],
  config: ["tracker_plan_config", "plan_id,enabled"],
  steps: ["plan_steps", "step_id,plan_id,ordinal,title,status,expected_result,required_checks_json,current_result_revision,created_at,updated_at"],
  attempts: ["step_attempts", "attempt_id,step_id,session_id,status,lease_until,rework_reason,started_at,closed_at"],
  sessions: ["tracker_sessions", "session_id,client_type,executor_label"],
  results: ["tracker_result_sources", "step_id,result_id,attempt_id,revision,outcome,summary,source_repository_id,source_kind,snapshot_digest,snapshot_format_version,payload_hash,created_at"],
  checks: ["tracker_checks_with_source", "step_id,check_id,result_revision,event_id,check_key,status,exit_code,evidence_summary,evidence_url,tested_snapshot_digest,result_repository_id,matches_result,created_at,server_sequence"],
  journal: ["tracker_journal", "event_id,plan_id,step_id,attempt_id,command_id,server_sequence,event_type,payload_json,occurred_at,received_at,classification,correction_of_event_id,payload_hash"],
  assessments: ["assessment_revisions", "assessment_id,revision,plan_id,step_id,recorded_at,requirements_digest,requirements_json,assessment_json"],
  targets: ["assessment_targets", "plan_id,step_id,requirements_json"],
  exceptions: ["tracker_finish_exceptions", "plan_id,reason,snapshot_json,created_at"],
  incomplete: ["tracker_incomplete_steps", "plan_id,step_id"],
  repositories: ["repositories", "repository_id,is_private,access_state"],
};

function groupExportRows(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}

function exportPlanDate(precision, at, on, timeZone) {
  return precision === "instant" ? { precision, value: new Date(at).toISOString(), timeZone } : { precision, on, timeZone };
}

function exportTimeline(journal, legacy, results, checks, assessments, protectedResult) {
  const referenced = new Set(journal.map(e => e.correction_of_event_id).filter(Boolean));
  const byCommand = new Map();
  const resultEvents = new Map(results.map(r => [r.step_id + ":" + r.attempt_id + ":" + r.created_at + ":" + r.payload_hash, r]));
  const checkEvents = new Map(checks.map(c => [c.event_id, c]));
  const events = [];
  const legacyOrder = [];
  for (const row of journal) {
    if (["heartbeat", "LEASE_RENEWED"].includes(row.event_type) && row.classification === "NORMAL" && !referenced.has(row.event_id)) continue;
    const payload = JSON.parse(row.payload_json), check = checkEvents.get(row.event_id);
    const result = row.event_type === "CHECK_RECORDED"
      ? results.find(r => r.step_id === row.step_id && r.revision === payload.resultRevision)
      : row.event_type === "STEP_RESULT_RECORDED" ? resultEvents.get(row.step_id + ":" + row.attempt_id + ":" + row.occurred_at + ":" + row.payload_hash) : null;
    const event = {
      eventId: row.event_id, eventType: row.event_type, stepId: row.step_id, attemptId: row.attempt_id,
      occurredAt: row.occurred_at, recordedAt: row.received_at, classification: row.classification,
    };
    if (row.correction_of_event_id) event.correctionOfEventId = row.correction_of_event_id;
    if (["commit_created", "commit_pushed", "push_failed"].includes(row.event_type)) {
      event.eventType = "HISTORICAL_EVENT";event.details = { historical: true };
    } else if (result && protectedResult(result.source_repository_id)) {
      event.details = { protectedDetailsHidden: true };
    } else if (OBSERVATION_TYPES.has(row.event_type)) {
      event.details = publicView(payload.data || {});
    } else {
      // Event envelopes have an explicit projection; arbitrary assessment data is handled separately.
      event.details = Object.fromEntries(["reason", "changedFields", "ordinal", "resultRevision", "checkKey", "status", "outcome", "assessmentId", "revision", "allowIncomplete", "rework", "disposition"]
        .filter(key => Object.hasOwn(payload, key)).map(key => [key, payload[key]]));
      if (row.event_type === "STEP_RESULT_RECORDED" && result) event.details.resultId = result.result_id;
      if (check) event.details.checkId = check.check_id;
    }
    if (row.command_id) byCommand.set(row.command_id + ":" + event.eventType, event);
    events.push({ event, order: row.server_sequence });
  }
  for (const row of legacy) {
    const eventType = "PLAN_" + row.event_type;
    const duplicate = byCommand.get(row.command_id + ":" + eventType);
    if (duplicate) {
      duplicate.actorType = row.actor_type;
      if (row.reason) duplicate.details.reason = row.reason;
      legacyOrder.push({ event: duplicate, version: row.version_after });
    } else {
      const event = {
      eventId: row.event_id, eventType, actorType: row.actor_type,
      occurredAt: row.server_occurred_at, recordedAt: row.server_occurred_at,
      details: row.reason ? { reason: row.reason } : {},
      };
      legacyOrder.push({ event, version: row.version_after });
      events.push({ event, order: -1 });
    }
  }
  const recordedAssessments = new Set(events.filter(({ event }) => event.eventType === "ASSESSMENT_RECORDED")
    .map(({ event }) => event.details.assessmentId + ":" + event.details.revision));
  for (const row of assessments) {
    if (recordedAssessments.has(row.assessment_id + ":" + row.revision)) continue;
    events.push({ event: {
      eventId: "assessment:" + row.assessment_id + ":" + row.revision,
      eventType: "ASSESSMENT_RECORDED", stepId: row.step_id,
      occurredAt: row.recorded_at, recordedAt: row.recorded_at,
      details: { assessmentId: row.assessment_id, revision: row.revision },
    }, order: 0 });
  }
  const ordered = events.sort((a, b) => a.event.recordedAt - b.event.recordedAt || a.order - b.order || a.event.eventId.localeCompare(b.event.eventId));
  const output = [];
  // Equal timestamps do not establish causality. Merge the two known chains
  // (plan versions and journal sequence), sharing their deduplicated anchors.
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].event.recordedAt === ordered[start].event.recordedAt) end++;
    const group = ordered.slice(start, end), members = new Set(group.map(i => i.event));
    const edges = new Map(group.map(i => [i.event, new Set()]));
    const chain = items => items.forEach((event, i) => { if (i) edges.get(items[i - 1]).add(event); });
    chain(group.filter(i => i.order > 0).map(i => i.event));
    chain(legacyOrder.filter(i => members.has(i.event)).sort((a, b) => a.version - b.version).map(i => i.event));
    const series = groupExportRows(group.filter(i => i.event.eventType === "ASSESSMENT_RECORDED").map(i => i.event.details), "assessmentId");
    for (const revisions of series.values()) chain(revisions.sort((a, b) => a.revision - b.revision)
      .map(details => group.find(i => i.event.details === details).event));
    const created = group.find(i => i.event.eventType === "PLAN_CREATED");
    if (created) for (const item of group) if (item !== created) edges.get(created.event).add(item.event);
    const ranks = new Map(group.map((item, index) => [item.event, index]));
    const indegree = new Map(group.map(item => [item.event, 0]));
    for (const targets of edges.values()) for (const target of targets) indegree.set(target, indegree.get(target) + 1);
    const ready = group.filter(item => indegree.get(item.event) === 0).map(item => item.event);
    while (ready.length) {
      const next = ready.shift();output.push(next);members.delete(next);
      for (const target of edges.get(next)) {
        indegree.set(target, indegree.get(target) - 1);
        if (indegree.get(target) === 0) {
          const index = ready.findIndex(event => ranks.get(event) > ranks.get(target));
          ready.splice(index < 0 ? ready.length : index, 0, target);
        }
      }
    }
    if (members.size) throw appError("INTERNAL_ERROR", "Противоречивый порядок истории отчёта.", 500);
    start = end;
  }
  return output;
}

async function buildExportReport(db, ownerId, clock) {
  const sql = Object.entries(EXPORT_SOURCES).map(([kind, [table, columns]]) =>
    `SELECT '${kind}' AS kind,json_object(${columns.split(",").map(column => `'${column}',${column}`).join(",")}) AS record FROM ${table} WHERE owner_id=?1`).join(" UNION ALL ");
  const data = Object.fromEntries(Object.keys(EXPORT_SOURCES).map(key => [key, []]));
  const snapshot = await db.prepare(sql).bind(ownerId).all();
  const nowMs = clock();
  if (snapshot.success === false || !Array.isArray(snapshot.results)) throw appError("INTERNAL_ERROR", "Не удалось прочитать полный отчёт.", 500);
  for (const row of snapshot.results) data[row.kind].push(JSON.parse(row.record));
  const sort = (rows, time, id) => rows.sort((a, b) => a[time] - b[time] || String(a[id]).localeCompare(String(b[id])));
  const byPlan = Object.fromEntries(["intervals", "events", "dates", "steps", "journal", "assessments", "exceptions", "incomplete"].map(key => [key, groupExportRows(data[key], "plan_id")]));
  const byStep = Object.fromEntries(["attempts", "results", "checks"].map(key => [key, groupExportRows(data[key], "step_id")]));
  const allowedRepositories = new Set(data.repositories.filter(r => !r.is_private || r.access_state === "available").map(r => r.repository_id));
  const protectedResult = repositoryId => Boolean(repositoryId && !allowedRepositories.has(repositoryId));
  const sessions = new Map(data.sessions.map(s => [s.session_id, s]));
  const configs = new Map(data.config.map(c => [c.plan_id, c.enabled]));
  const targetDigests = new Map();
  for (const target of data.targets) targetDigests.set(target.plan_id + ":" + (target.step_id || ""), "sha256:" + await hashCommandInput(JSON.parse(target.requirements_json)));
  const assessmentViewForExport = row => {
    const payload = JSON.parse(row.assessment_json);
    // Only remove known envelope fields. Preserve every key in user-defined context, scale, etc.
    const { assessmentId, planId, stepId, expectedRequirementsDigest, ...assessment } = payload;
    return { assessmentId: row.assessment_id, revision: row.revision, recordedAt: row.recorded_at,
      requirements: JSON.parse(row.requirements_json), needsRevision: row.requirements_digest !== targetDigests.get(row.plan_id + ":" + (row.step_id || "")),
      assessment: { formatVersion: 1, ...assessment } };
  };
  const plans = sort(data.plans, "registered_at", "plan_id").map(row => {
    const related = key => byPlan[key].get(row.plan_id) || [];
    const intervals = sort(related("intervals"), "start_ms", "interval_id");
    const journal = related("journal");
    const steps = sort(related("steps"), "ordinal", "step_id");
    const results = steps.flatMap(s => byStep.results.get(s.step_id) || []);
    const checks = steps.flatMap(s => byStep.checks.get(s.step_id) || []);
    const attempts = steps.flatMap(s => byStep.attempts.get(s.step_id) || []);
    const starts = new Map();
    for (const event of journal) if (event.event_type === "STEP_STARTED" && event.command_id) {
      const previous = starts.get(event.attempt_id);
      starts.set(event.attempt_id, Math.min(previous ?? Infinity, event.occurred_at));
    }
    const startedAttempts = attempts.filter(a => starts.has(a.attempt_id)).map(a => ({ ...a, execution_started_at: starts.get(a.attempt_id) }));
    const end = row.finished_at ?? row.deleted_at ?? nowMs;
    const measured = row.first_started_at != null;
    const activeMs = measured ? calculateActiveMs(intervals, nowMs) : null;
    const calendarMs = measured ? Math.max(0, end - row.first_started_at) : null;
    const timing = attributeStepTime(row, steps, intervals, startedAttempts, { startMs: 0, endMs: end }, Math.min(nowMs, end));
    const stepTiming = new Map(timing.steps.map(s => [s.stepId, s]));
    const incomplete = new Set(related("incomplete").map(s => s.step_id));
    const assessments = related("assessments").sort((a, b) => a.recorded_at - b.recorded_at || a.assessment_id.localeCompare(b.assessment_id) || a.revision - b.revision);
    return {
      planId: row.plan_id, title: row.title, description: row.description, acceptanceCriteria: row.acceptance_criteria,
      planCreatedAt: exportPlanDate(row.plan_created_precision, row.plan_created_at_ms, row.plan_created_on, row.plan_created_timezone),
      registeredAt: row.registered_at, status: row.status, deletedAt: row.deleted_at, firstStartedAt: row.first_started_at, finishedAt: row.finished_at,
      sourceReference: row.source_reference,
      completion: { trackerEnabled: Boolean(configs.get(row.plan_id)), incompleteStepCount: incomplete.size,
        readyToFinish: row.deleted_at == null && (!configs.get(row.plan_id) || incomplete.size === 0) },
      activeMs, calendarMs, pausedMs: measured ? Math.max(0, calendarMs - activeMs) : null,
      unattributedMs: timing.unattributedMs, ambiguousMs: timing.ambiguousMs,
      intervals: intervals.map(i => ({ intervalId: i.interval_id, startMs: i.start_ms, endMs: i.end_ms })),
      dateHistory: sort(related("dates"), "changed_at", "history_id").map(d => ({
        previous: exportPlanDate(d.old_precision, d.old_at_ms, d.old_on, d.old_timezone), changedAt: d.changed_at, reason: d.reason,
      })),
      assessments: assessments.filter(a => a.step_id == null).map(assessmentViewForExport),
      steps: steps.map(step => ({
        stepId: step.step_id, ordinal: step.ordinal, title: step.title, expectedResult: step.expected_result,
        requiredChecks: JSON.parse(step.required_checks_json), status: step.status, createdAt: step.created_at, updatedAt: step.updated_at,
        currentResultRevision: step.current_result_revision, readyToFinish: !incomplete.has(step.step_id),
        activeMs: stepTiming.get(step.step_id).activeMs, ambiguousMs: stepTiming.get(step.step_id).ambiguousMs,
        attempts: sort(byStep.attempts.get(step.step_id) || [], "started_at", "attempt_id").map(a => {
          const start = starts.get(a.attempt_id) ?? null, session = sessions.get(a.session_id);
          return { attemptId: a.attempt_id, status: a.status,
            executionState: a.status !== "OPEN" ? a.status : a.lease_until <= nowMs ? "LEASE_EXPIRED" : start == null ? "AWAITING_START" : "RUNNING",
            claimedAt: a.started_at, startedAt: start, closedAt: a.closed_at,
            executionEndAt: start == null ? null : Math.min(a.closed_at ?? nowMs, a.lease_until, nowMs),
            reworkReason: a.rework_reason, executor: { clientType: session?.client_type ?? "UNKNOWN", label: session?.executor_label ?? null } };
        }),
        results: sort(byStep.results.get(step.step_id) || [], "revision", "result_id").map(r => ({
          resultId: r.result_id, attemptId: r.attempt_id, revision: r.revision, outcome: r.outcome, summary: r.summary, recordedAt: r.created_at,
          source: { kind: ["COMMIT", "WORKTREE_SNAPSHOT"].includes(r.source_kind) ? "HISTORICAL" : r.source_kind,
            snapshotDigest: protectedResult(r.source_repository_id) ? null : r.snapshot_digest,
            formatVersion: r.snapshot_format_version, protectedDetailsHidden: protectedResult(r.source_repository_id) },
        })),
        checks: sort(byStep.checks.get(step.step_id) || [], "server_sequence", "check_id").map(c => ({
          checkId: c.check_id, resultRevision: c.result_revision, checkKey: c.check_key, status: c.status, exitCode: c.exit_code,
          evidenceSummary: c.evidence_summary, evidenceUrl: protectedResult(c.result_repository_id) ? null : c.evidence_url,
          testedSnapshotDigest: protectedResult(c.result_repository_id) ? null : c.tested_snapshot_digest,
          matchesResult: Boolean(c.matches_result), recordedAt: c.created_at, protectedEvidenceHidden: protectedResult(c.result_repository_id),
        })),
        assessments: assessments.filter(a => a.step_id === step.step_id).map(assessmentViewForExport),
      })),
      finishExceptions: sort(related("exceptions"), "created_at", "reason").map(e => ({
        reason: e.reason, recordedAt: e.created_at,
        incompleteSteps: JSON.parse(e.snapshot_json).map(s => ({ stepId: s.stepId, ordinal: s.ordinal, status: s.status, currentResultRevision: s.currentResultRevision })),
      })),
      timeline: exportTimeline(journal, related("events"), results, checks, assessments, protectedResult),
    };
  });
  const included = plans.filter(p => p.deletedAt == null);
  const measured = included.filter(p => p.activeMs != null);
  const union = unionIntervals(included.flatMap(p => p.intervals.map(i => [i.startMs, i.endMs ?? nowMs])));
  return {
    formatVersion: 1, exportedAt: nowMs, timezone: data.settings[0]?.timezone || "UTC",
    summary: { planCount: included.length, deletedPlanCount: plans.length - included.length,
      measuredPlanCount: measured.length, totalActiveMs: measured.length ? union.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0) : null,
      sumPlanActiveMs: measured.length ? measured.reduce((sum, p) => sum + p.activeMs, 0) : null },
    plans,
  };
}

async function readTrackerCapabilities(db, ownerId) {
  const row = await dbFirst(db, "SELECT COUNT(*) AS enabled_plan_count FROM tracker_plan_config c JOIN plans p ON p.owner_id=c.owner_id AND p.plan_id=c.plan_id WHERE c.owner_id=? AND c.enabled=1 AND p.deleted_at IS NULL", ownerId);
  const ownerScope = await hashCommandInput({ purpose: "plan-time-tracker-local-observation-queue-v1", ownerId: ownerId });
  return {
    available: true, schemaVersion: 1, version: TRACKER_VERSION,
    assessments: { formatVersion: 1, recordTool: "RecordAssessment", getTool: "GetAssessment", historyTool: "GetEstimationHistory",
      immutableRevisions: true, agentDefinedMethods: true, maxPayloadBytes: 24000, maxJsonDepth: 10,
      forecastUnits: "ms", forecastMetrics: FORECAST_METRICS, initialExpectedVersion: 0, requirementsDigest: true,
      contextRead: { tool: "GetAssessment", omitAssessmentId: true }, expectedRequirementsDigestRequired: true,
      historyMaxTargets: 20, historyMaxLimit: 100, methodologyControlsExecution: false,
      atlm: { formatVersion: 1, method: { ...ATLM_METHOD }, featureSchemaVersion: "agent-task-v1", metric: "PLAN_ACTIVE",
        predictionScope: "FULL_FROM_FIRST_START", retrainEveryNewPlans: 5,
        calculateTool: "CalculateAtlmEstimate", planEstimateTool: "GetPlanEstimate", modelStatusTool: "GetEstimationModelStatus",
        processTool: "ProcessEstimationTraining", datasetTool: "GetAtlmDataset", predictionRequest: { method: "ATLM", methodVersion: 1 },
        limits: { maxTrainingSamples: 5000, datasetDefaultLimit: 50, datasetMaxLimit: 100, maxOutcomes: 20, maxChangedContracts: 20, maxVerificationKinds: 5 } },
      calculator: { tool: "CalculateEstimate", formatVersion: 1,
        method: { id: "reference-class-median", version: "1" }, metrics: ["PLAN_ACTIVE"],
        maxCandidates: 20, readOnly: true, accuracy: "NOT_VALIDATED" } },
    planDeletion: { softDelete: true, deleteTool: "DeletePlan", restoreTool: "RestorePlan", deletedFilter: "deleted", restoreStartsTimer: false }, enabledPlanCount: row.enabled_plan_count,
    parallelPlans: true, planList: { tool: "ListPlans", statuses: PLAN_STATUSES, defaultLimit: 50, maxLimit: MAX_PLAN_PAGE_SIZE, order: "registeredAt DESC, planId DESC", deletedDefault: false },
    analytics: { totalActiveMs: "union of owner intervals", activeByDay: "union by local day", sumPlanActiveMs: "sum of per-plan intervals" },
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


// The UI reads a bounded, stable page only after the history is opened.
// Keep GetTimeline and GetPlan's existing MCP contracts unchanged.
async function readStatusHistory(db, ownerId, planId, options) {
  const { page = 0, limit = 8, throughSequence, throughEventRowid } = options;
  if (!UUID.test(planId || "") || !Number.isSafeInteger(page) || page < 0 || page > 1_000_000
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || (throughSequence === undefined) !== (throughEventRowid === undefined)
    || [throughSequence, throughEventRowid].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
    throw appError("VALIDATION_ERROR", "Некорректные параметры страницы истории.");
  }
  const plan = await dbFirst(db, "SELECT 1 AS found FROM plans WHERE owner_id=? AND plan_id=?", ownerId, planId);
  if (!plan) throw appError("PLAN_NOT_FOUND", messageFor("PLAN_NOT_FOUND"), 404);
  const bounds = throughSequence === undefined ? await dbFirst(db, `SELECT
    COALESCE((SELECT MAX(server_sequence) FROM tracker_journal WHERE owner_id=? AND plan_id=?),0) AS throughSequence,
    COALESCE((SELECT MAX(rowid) FROM plan_events WHERE owner_id=? AND plan_id=?),0) AS throughEventRowid`, ownerId, planId, ownerId, planId)
    : { throughSequence, throughEventRowid };
  const params = [ownerId, planId, bounds.throughEventRowid, ownerId, planId, bounds.throughSequence];
  const selection = `SELECT 'legacy' AS kind,event_id,server_occurred_at AS received_at,0 AS sequence
    FROM plan_events WHERE owner_id=? AND plan_id=? AND rowid<=?
    UNION ALL SELECT 'tracker' AS kind,event_id,received_at,server_sequence AS sequence
    FROM tracker_journal WHERE owner_id=? AND plan_id=? AND server_sequence<=?`;
  const { total } = await dbFirst(db, `SELECT COUNT(*) AS total FROM (${selection})`, ...params);
  const pageCount = Math.max(1, Math.ceil(total / limit)), currentPage = Math.min(page, pageCount - 1);
  const rows = await dbAll(db, `SELECT * FROM (${selection}) ORDER BY received_at,sequence,event_id,kind LIMIT ? OFFSET ?`,
    ...params, limit, currentPage * limit);
  const events = [];
  for (const item of rows) {
    if (item.kind === "legacy") {
      const row = await dbFirst(db, "SELECT event_id,event_type,server_occurred_at,actor_type,reason,version_after FROM plan_events WHERE owner_id=? AND plan_id=? AND event_id=?", ownerId, planId, item.event_id);
      events.push({ legacy: true, eventId: row.event_id, eventType: row.event_type, receivedAt: row.server_occurred_at,
        actorType: row.actor_type, reason: row.reason, version: row.version_after });
    } else {
      const row = await dbFirst(db, "SELECT * FROM tracker_journal WHERE owner_id=? AND plan_id=? AND event_id=?", ownerId, planId, item.event_id);
      events.push(await enrichTimelineEvent(db, ownerId, planId, row));
    }
  }
  return { events, page: currentPage, pageSize: limit, total, pageCount, ...bounds };
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
  const plan = await dbFirst(db, "SELECT first_started_at FROM plans WHERE owner_id=? AND plan_id=? AND deleted_at IS NULL", ownerId, planId);
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
  return {
    period: { from: filter.from, to: filter.to, timeZone, startMs: range.startMs, endMs: range.endMs }, asOf,
    ...attributeStepTime(plan, steps, intervals, attempts, range, asOf),
  };
}

// Shared by period analytics and the complete export; claim time is never execution time.
function attributeStepTime(plan, steps, intervals, attempts, range, asOf) {
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
:root{background:var(--paper);--paper:oklch(98% .006 85);--paper-2:oklch(99.5% .003 85);--paper-3:oklch(95.5% .009 85);--ink:oklch(19% .01 60);--ink-2:oklch(33% .012 60);--muted:oklch(44% .012 60);--line:oklch(85% .012 80);--line-strong:oklch(60% .018 80);--amber:oklch(54% .14 70);--amber-text:oklch(46% .12 70);--amber-ink:oklch(99% .003 85);--amber-soft:oklch(94% .035 80);--blue:oklch(48% .12 250);--blue-soft:oklch(94% .025 250);--red:oklch(44% .14 25);--red-soft:oklch(95% .025 25);--green:var(--amber);--panel:var(--paper-2);--font-body:'Host Grotesk',system-ui,sans-serif;--font-measured:'Atkinson Hyperlegible Mono',ui-monospace,monospace;--overlay:oklch(19% .01 60 / .48)}
html,body{overflow-x:clip;background:var(--paper)}body{background:var(--paper);color:var(--ink);font-family:var(--font-body);line-height:1.5}.shell{max-width:1200px;padding:32px 28px 80px}.top{align-items:end;margin-bottom:24px;padding-bottom:22px;border-bottom:1px solid var(--line-strong)}h1,h2,h3,h4{color:var(--ink);font-weight:500;letter-spacing:-.025em;min-width:0;overflow-wrap:break-word}h1{font-size:clamp(2rem,4vw,3rem);line-height:1.05;margin:0}h2{font-size:1.2rem;margin:0 0 16px}h3{font-size:1.05rem}p{line-height:1.55}.muted{color:var(--muted)}#who{font-size:.875rem;text-align:right}.nav{gap:0;margin-bottom:28px;padding:0;border-bottom:1px solid var(--line-strong)}.nav button{border:0;padding:12px 18px;color:var(--muted);font-weight:500;border-bottom:2px solid transparent}.nav button:hover:not([aria-current=page]):not(:disabled){border-color:transparent}.nav button[aria-current=page]{color:var(--ink);border-color:var(--amber)}
button,input,textarea,select{font-family:var(--font-body)}button{background:var(--paper-2);color:var(--ink);border:1px solid var(--line-strong);border-radius:6px;font-weight:500;padding:.65rem .9rem;min-height:42px;transition:background-color .15s ease,border-color .15s ease}button:hover:not(:disabled){background:var(--paper-3);border-color:var(--amber)}button:active:not(:disabled){background:var(--amber-soft)}button.primary,.primary{background:var(--amber);border-color:var(--amber);color:var(--amber-ink)}button.primary:hover:not(:disabled){background:var(--ink-2);border-color:var(--ink-2);color:var(--paper-2)}button.primary:active:not(:disabled){background:var(--ink);border-color:var(--ink)}button.danger{color:var(--red);background:var(--paper-2);border-color:var(--line-strong)}button.danger:hover:not(:disabled){background:var(--red-soft);border-color:var(--red)}button.danger:active:not(:disabled){background:var(--red);color:var(--paper-2);border-color:var(--red)}:is(button,a,input,textarea,select,summary,[role=button]):focus-visible{outline:3px solid var(--amber);outline-offset:2px}a{color:var(--ink-2);text-decoration-color:var(--line-strong);text-underline-offset:3px}a:hover{color:var(--amber)}
.grid{grid-template-columns:minmax(0,1.3fr) minmax(0,.7fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:20px}.grid>.panel{border:0;border-radius:0;margin:0}.panel{background:var(--paper-2);border:1px solid var(--line);border-radius:10px;box-shadow:none;padding:24px;margin-bottom:20px}.current{min-height:240px}.metrics{gap:1px;background:var(--paper-3);border:1px solid var(--line);border-radius:6px;overflow:hidden}#view-overview .grid .metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.metric{background:var(--paper-3);border:0;border-right:1px solid var(--line);border-bottom:1px solid var(--line);border-radius:0;padding:14px}.metric small{font-size:.8rem;color:var(--muted);margin-bottom:10px}.metric strong{font-family:var(--font-measured);font-size:1.15rem;font-weight:400;color:var(--blue);font-variant-numeric:tabular-nums}.current h2 span{color:var(--blue);font-family:var(--font-measured);font-weight:400}.timer,#active>.active-plan .timer{font-family:var(--font-measured);font-size:clamp(2rem,4vw,3rem);font-weight:400;letter-spacing:-.04em;line-height:1.1;color:var(--blue);font-variant-numeric:tabular-nums;margin:15px 0}.active-plan .timer{color:var(--blue)}#active{gap:0}#active>.active-plan{border:0;border-top:1px solid var(--line);border-radius:0;padding:16px 0;margin:0;color:var(--ink)}#active>.active-plan:first-child{border-top:0;padding-top:0}#active>.active-plan:last-child{padding-bottom:0}.active-plan .plan-open{font-size:1.08rem;font-weight:500}.plan-open{background:transparent;border:0;min-height:0}.plan-open:hover:not(:disabled){background:transparent;color:var(--amber)}
.list{gap:0}.row,.analytics-plan{background:var(--paper-2);border:0;border-bottom:1px solid var(--line);border-radius:0;padding:16px 0}.row:first-child,.analytics-plan:first-child{border-top:1px solid var(--line)}.row-title{font-weight:500}.row-meta,.analytics-plan-meta{color:var(--muted);line-height:1.45}.row-right{gap:8px}.badge{border:1px solid var(--line);border-radius:4px;background:var(--blue-soft);color:var(--blue);font-size:.78rem;font-weight:500;padding:.25rem .5rem}.badge.paused{background:var(--amber-soft);color:var(--amber-text)}.badge.completed{background:var(--paper-3);color:var(--muted)}.pager-arrow{background:var(--paper-2);color:var(--ink);border-color:var(--line-strong)}.pager-page{font-family:var(--font-measured)}
.checkbox-field{display:flex;align-items:flex-start;gap:8px}.checkbox-field input{flex:none;margin:5px 0 0}.field label{font-size:.875rem;font-weight:500;color:var(--ink-2)}.field input,.field textarea,.field select,.form>input,.form>textarea,.tracker-form input,.tracker-form textarea,.tracker-form select{background:var(--paper-3);color:var(--ink);border:1px solid var(--line-strong);border-radius:6px;padding:.65rem}.field textarea{min-height:90px}input::placeholder,textarea::placeholder{color:var(--muted);opacity:1}.notice{color:var(--ink-2);background:var(--amber-soft);border-color:var(--line-strong);border-radius:6px}.error,.form-error{color:var(--red);background:var(--red-soft);border-color:var(--red);border-radius:6px}.form-error:empty{display:none}.bar{background:var(--paper-3);border-radius:2px}.bar span,.step-bar{background:var(--blue)}.step-column{border:0;min-height:0}.step-column:hover:not(:disabled){background:transparent;border:0}.step-column:hover .step-bar,.step-column:focus .step-bar{background:var(--ink-2)}.barrow>span,.step-y-axis,.step-x-label{font-variant-numeric:tabular-nums}.step-tooltip{background:var(--ink);color:var(--paper-2);border-radius:6px;box-shadow:none}.step-tooltip span{color:var(--paper)}.analytics-plan{padding:0}.analytics-plan>summary.row,.analytics-plan>summary.row:first-child{border:0;border-radius:0;padding:16px 0}.step-chart-body{margin:0;padding:16px 0}.settings-export{color:var(--amber);font-weight:500}.modal{background:var(--overlay)}.modalbox{background:var(--paper-2);border:1px solid var(--line-strong);border-radius:10px;box-shadow:none;padding:24px}.toast{background:var(--ink);color:var(--paper-2);border-radius:6px}.toast.error{background:var(--red);color:var(--paper-2)}
.tracker-section{border-color:var(--line)}.tracker-list,.tracker-timeline{gap:0}.tracker-card,.timeline-card{background:var(--paper-2);border:0;border-top:1px solid var(--line);border-radius:0;padding:16px 0}.tracker-card:last-child,.timeline-card:last-child{border-bottom:1px solid var(--line)}.tracker-card-toggle{min-height:42px}.tracker-card-toggle:hover:not(:disabled){background:transparent;color:var(--amber)}.tracker-meta,.tracker-card-status{color:var(--muted)}.tracker-timeline time{color:var(--blue);font-family:var(--font-measured);font-variant-numeric:tabular-nums}.tracker-marker{border-radius:4px;background:var(--paper-3);font-weight:500}.tracker-marker.GAP,.tracker-marker.LATE,.tracker-marker.STALE_EXECUTOR{background:var(--amber-soft);color:var(--amber-text)}.tracker-marker.CORRECTION{background:var(--blue-soft);color:var(--blue)}
@media(max-width:720px){.shell{padding:24px 16px 60px}.grid{grid-template-columns:minmax(0,1fr)}.panel{padding:18px}.top{align-items:start}#who{text-align:left}}@media(max-width:600px){.tracker-card-toggle{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px}.tracker-card-toggle>strong{grid-column:1;grid-row:1}.tracker-card-toggle>.tracker-card-status{grid-column:1;grid-row:2}.tracker-card-toggle>span:last-child{grid-column:2;grid-row:1}.nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));overflow:visible}.nav button{padding:12px;text-align:center}.tracker-card,.timeline-card{padding:14px 0}.modalbox{padding:18px}.metrics,#view-overview .grid .metrics{grid-template-columns:1fr}.row{padding:14px 0}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important;animation-iteration-count:1!important}}
`;

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

const UI_PLAN_LISTS_CSS = String.raw`
#active{display:grid;gap:10px}
#active>.active-plan{border:1px solid var(--line);border-radius:11px;padding:14px;margin:0;color:#18212b}
#active>.active-plan .timer{font-size:1.7rem;letter-spacing:-.04em;margin:9px 0}
#active>.active-plan .actions{margin-top:12px}
.pager{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:12px;margin-top:16px;color:var(--muted);font-size:.85rem}
.pager-summary{min-width:0;overflow-wrap:anywhere}
.pager-controls{grid-column:2;display:flex;align-items:center;gap:9px}
.pager-page{min-width:3.5em;text-align:center;font-variant-numeric:tabular-nums}
.pager-arrow{width:44px;height:44px;display:grid;place-items:center;padding:0;border:1px solid var(--line);background:white;color:#18212b}
.pager-arrow svg{display:block;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.pager-arrow:hover:not(:disabled){border-color:var(--green);color:var(--green)}
.pager-arrow:disabled{opacity:.4}
@media(max-width:600px){.pager{grid-template-columns:minmax(0,1fr);gap:8px}.pager-summary{grid-row:2;text-align:center}.pager-controls{grid-column:1;grid-row:1;justify-self:center}}
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

// Both views use the same actionable plan rows; pagination is applied after filtering.
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
      const {plan}=await api("/api/plans/"+encodeURIComponent(id)+"?includeEvents=false");
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
  style.textContent=".status-history [hidden]{display:none!important}.status-history{display:grid;gap:12px}.tracker-section{display:grid;gap:14px;margin-top:22px;padding-top:18px;border-top:1px solid #e2e7ec}.tracker-list,.tracker-timeline{display:grid;gap:10px}.tracker-card,.timeline-card{min-width:0;border:1px solid #e2e7ec;border-radius:11px;padding:14px;background:#fff}.tracker-card h4,.timeline-card h4{margin:0 0 8px}.tracker-card h4{min-width:0;overflow-wrap:anywhere}.tracker-card p,.timeline-card p{margin:7px 0;overflow-wrap:anywhere}.tracker-meta{font-size:.88rem;color:#657180}.tracker-form{display:grid;gap:10px}.tracker-form .field{min-width:0}.tracker-card-body>.tracker-form+.tracker-form{margin-top:10px}.tracker-card-body>details{display:block}.tracker-card-body>details[open]{display:grid;gap:10px}.tracker-actions{display:flex;gap:8px;flex-wrap:wrap}.tracker-card-body>.tracker-actions{margin-top:10px}.plan-period-panel>.metrics{margin-top:16px}.tracker-timeline time{display:block;font-size:.82rem;color:#657180;overflow-wrap:anywhere}.tracker-marker{display:inline-block;margin:0 6px 0 0;padding:3px 7px;border-radius:99px;background:#edf0f3;font-size:.76rem;font-weight:700}.tracker-marker.GAP,.tracker-marker.LATE,.tracker-marker.STALE_EXECUTOR{background:#fff3dd;color:#805500}.tracker-marker.CORRECTION{background:#eaf0ff;color:#31538a}.tracker-revision{overflow-wrap:anywhere;word-break:break-word}.tracker-timeline-actions{display:flex;gap:8px;flex-wrap:wrap}.tracker-card button,.tracker-section button{min-height:42px}.tracker-card-toggle{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;width:100%;padding:0;background:transparent;color:inherit;text-align:left;border:0;border-radius:0;white-space:normal}.tracker-card-toggle>strong{flex:1;min-width:0;overflow-wrap:anywhere}.tracker-card-toggle[aria-expanded=false]>strong{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.tracker-card-status{flex:none;font-size:.85rem;color:#657180}.tracker-card-summary{margin-bottom:0!important}.tracker-card-body{min-width:0;padding-top:10px}.tracker-card-error:empty{display:none}.tracker-collapse-actions{display:flex;gap:8px;flex-wrap:wrap}@media(max-width:600px){.tracker-form{grid-template-columns:minmax(0,1fr)}.tracker-actions button,.tracker-timeline-actions button{flex:1 1 100%}.tracker-card,.timeline-card{padding:12px}}";
  document.head.append(style);
  const make=(tag,text,cls)=>{const element=document.createElement(tag);if(text!==undefined&&text!==null)element.textContent=text;if(cls)element.className=cls;return element;};
  const duration=(value)=>{if(value==null)return "—";let minutes=Math.max(0,Math.round(value/60000));const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),rest=minutes%60;return days?days+" д "+hours+" ч "+rest+" мин":hours?hours+" ч "+rest+" мин":rest+" мин";};
  const date=(value)=>value==null?"—":new Intl.DateTimeFormat("ru-RU",{dateStyle:"medium",timeStyle:"short",timeZone:document.querySelector("#tz")?.value||Intl.DateTimeFormat().resolvedOptions().timeZone}).format(new Date(value));
  const statusNames={PENDING:"Ожидает",RUNNING:"Выполняется",BLOCKED:"Заблокирован",FAILED:"Не пройден",DONE:"Результат записан",OPEN:"Активная попытка",CLOSED:"Закрыта",ABANDONED:"Прервана",PASSED:"Пройдена",NOT_RUN:"Не запускалась"};
  const eventNames={CREATED:"План создан",STARTED:"План запущен",PAUSED:"План приостановлен",RESUMED:"План возобновлён",FINISHED:"План завершён",DELETED:"План удалён",RESTORED:"План восстановлен",METADATA_UPDATED:"План изменён",PLAN_STARTED:"План запущен",PLAN_PAUSED:"План приостановлен",PLAN_RESUMED:"План возобновлён",PLAN_FINISHED:"План завершён",PLAN_DELETED:"План удалён",PLAN_RESTORED:"План восстановлен",STEP_CREATED:"Checkpoint создан",STEP_UPDATED:"Checkpoint изменён",ATTEMPT_CLAIMED:"Попытка назначена",ATTEMPT_ABANDONED:"Попытка прервана",ATTEMPT_CLOSED:"Попытка закрыта",STEP_STARTED:"Checkpoint запущен",STEP_BLOCKED:"Checkpoint заблокирован",STEP_RESULT_RECORDED:"Результат записан",CHECK_RECORDED:"Проверка записана",LEASE_RENEWED:"Lease продлён",turn_started:"Ход начат",turn_finished:"Ход завершён",tool_started:"Инструмент запущен",tool_finished:"Инструмент завершён",HISTORICAL_EVENT:"Историческое событие",heartbeat:"Heartbeat",gap:"Разрыв последовательности",correction:"Коррекция наблюдения"};
  const uuid=()=>crypto.randomUUID();
  const getSessionId=()=>{let value=sessionStorage.getItem("plan-time-tracker-session");if(!value){value=uuid();sessionStorage.setItem("plan-time-tracker-session",value);}return value;};
  async function api(path,options){const response=await fetch(path,{...options,headers:{"content-type":"application/json",...(options&&options.headers||{})},cache:"no-store"});const data=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(data.error&&data.error.message||"HTTP "+response.status);error.status=response.status;error.code=data.error&&data.error.code;error.details=data.error&&data.error.details;throw error;}return data;}
  const pendingCommands=new Map(),rejectedCommands=new Set(),terminalRejectedCommands=new Set(),rejectedVersions=new Map(),retryVersions=new Map();
  const terminalDomainRejections=new Set(["RESULT_REVISION_STALE","LEASE_EXPIRED","STEP_NOT_STARTED","STEP_ALREADY_EXISTS","REWORK_REQUIRED","ATTEMPT_CLOSED","LEASE_FENCED","ACTIVE_ATTEMPT_EXISTS"]);
  async function hasMatchingFinalDomainRejection(envelope,error){if(error.status!==409||!terminalDomainRejections.has(error.code))return false;try{const receipt=await api("/api/tracker/commands/"+encodeURIComponent(envelope.commandId));return receipt.status==="FINAL"&&receipt.commandId===envelope.commandId&&receipt.commandType===envelope.commandType&&receipt.error?.code===error.code&&!receipt.result;}catch{return false;}}
  async function readCurrentVersion(payload){const stepId=payload.stepId;if(stepId){const planId=payload.planId||root.dataset.planId;if(!planId)return null;const snapshot=await api("/api/tracker/plans/"+encodeURIComponent(planId)+"/execution");const step=(snapshot.steps||[]).find(item=>item.step_id===stepId);return step&&Number.isSafeInteger(step.version)?step.version:null;}const planId=payload.planId;if(!planId)return null;const snapshot=await api("/api/plans/"+encodeURIComponent(planId)+"?includeEvents=false");return Number.isSafeInteger(snapshot.plan&&snapshot.plan.version)?snapshot.plan.version:null;}
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
  function renderTimeline(list,events){list.replaceChildren();if(!events.length){list.append(make("p","История пока пуста.","muted"));return;}const ordered=[...events].sort((a,b)=>Number(a.receivedAt||0)-Number(b.receivedAt||0)||(a.serverSequence||0)-(b.serverSequence||0)||String(a.eventId).localeCompare(String(b.eventId)));for(const event of ordered){const card=make("article",null,"timeline-card");card.id="tracker-event-"+event.eventId;const heading=make("h4",eventNames[event.eventType]||event.eventType);if(event.classification&&event.classification!=="NORMAL")heading.prepend(make("span",event.classification,"tracker-marker "+event.classification));card.append(heading);card.append(make("time","Получено сервером: "+date(event.receivedAt)));if(!event.legacy&&event.occurredAt!=null)card.append(make("time","Время клиента: "+date(event.occurredAt)));if(event.serverSequence!=null)card.append(make("p","Серверная последовательность: "+event.serverSequence,"tracker-meta"));if(event.legacy){card.append(make("p","Автор: "+(event.actorType||"не указан")+(event.version!=null?" · версия плана "+event.version:""),"tracker-meta"));if(event.reason)card.append(make("p","Причина: "+event.reason));}else if(event.payload&&event.payload.data&&Object.keys(event.payload.data).length){card.append(make("p",JSON.stringify(event.payload.data),"tracker-meta"));}if(event.correctionOfEventId){const link=make("a","Исправляет событие "+event.correctionOfEventId);link.href="#tracker-event-"+event.correctionOfEventId;card.append(link);}list.append(card);}}
  let renderToken=0,loadingPlanId=null,pendingSuccessFeedback="",pendingSuccessPlanId=null;
  async function renderTracker(force){const planId=root.dataset.planId;if(!planId)return;if(pendingSuccessPlanId!==planId){pendingSuccessFeedback="";pendingSuccessPlanId=planId;}const current=root.querySelector("[data-tracker-panel]");if(!force&&current&&current.dataset.planId===planId)return;if(!force&&loadingPlanId===planId)return;const token=++renderToken;loadingPlanId=planId;if(current){captureDrafts(current);const prior=current.querySelector('[role="status"][aria-live="polite"]');if(current.dataset.planId===planId&&prior&&prior.textContent.trim()&&prior.textContent!=="Загружаю состояние checkpoint…"&&!prior.classList.contains("error"))pendingSuccessFeedback=prior.textContent;current.remove();}const panel=sectionFor(planId),heading=make("h3","Контрольные этапы"),refresh=make("button","Обновить состояние этапов");refresh.type="button";refresh.addEventListener("click",()=>renderTracker(true));heading.id="tracker-heading";panel.append(heading,refresh);const message=make("p","Загружаю состояние checkpoint…","muted");message.setAttribute("role","status");message.setAttribute("aria-live","polite");panel.append(message);root.append(panel);
    try{const snapshot=await api("/api/tracker/plans/"+encodeURIComponent(planId)+"/execution");if(token!==renderToken||root.dataset.planId!==planId)return;observedServerNow=snapshot.serverNow;observedMonotonicNow=performance.now();watchLeaseExpiry(snapshot);panel.replaceChildren(heading,refresh);panel.append(message);setMessage(message,snapshot.plan.deletedAt!=null?"План удалён. Этапы и история доступны только для чтения.":"");if(pendingSuccessFeedback){setMessage(message,pendingSuccessFeedback);pendingSuccessFeedback="";}window.dispatchEvent(new CustomEvent("plan-time-tracker:completion-updated",{detail:snapshot.plan}));const steps=snapshot.steps||[];const incompletes=steps.filter((step)=>!step.readyToFinish);if(!snapshot.enabled)panel.append(make("p","Трекер включится при создании первого checkpoint. Таймер плана не меняется.","tracker-meta"));panel.append(make("p","Активное время определяется только интервалами плана: "+duration(snapshot.plan.activeMs)+". Попытки не складываются с таймером.","tracker-meta"));const bottlenecks=snapshot.bottlenecks||{},checkDelay=bottlenecks.checkDelay||{};const checkDelayText=checkDelay.sampleCount?duration(checkDelay.medianMs)+" медиана, выборка "+checkDelay.sampleCount:"нет данных";panel.append(make("p","Сводка: блокировок "+(bottlenecks.blockedEvents||0)+" · попыток после первой "+(bottlenecks.retries||0)+" (включая восстановление и доработку) · неуспешных результатов "+(bottlenecks.failedResults||0)+" · задержка до первой проверки "+checkDelayText+". Задержка показывает время между записью результата и первой записью проверки на сервере, а не длительность выполнения теста.","tracker-meta"));
      if(snapshot.plan.deletedAt==null&&["PLANNED","RUNNING"].includes(snapshot.plan.status)){const form=make("form",null,"tracker-form"),ordinal=inputField("Порядок",{type:"number",required:true,value:String(Math.max(0,...steps.map(step=>Number(step.ordinal)||0))+1)}),title=inputField("Название checkpoint",{required:true,maxLength:200}),expected=inputField("Ожидаемый результат",{tag:"textarea",required:true,maxLength:4000,rows:3}),checks=inputField("Обязательные проверки · через запятую",{maxLength:2100,placeholder:"unit, build"}),submit=make("button","Добавить checkpoint","primary");submit.type="submit";draftForm(form,"create-step");form.append(ordinal.wrap,title.wrap,expected.wrap,checks.wrap,submit);form.addEventListener("submit",async(event)=>{event.preventDefault();const submittedDraft=snapshotDraft(form,planId);submit.disabled=true;try{await command("CreateStep",{planId:planId,ordinal:Number(ordinal.control.value),title:title.control.value,expectedResult:expected.control.value,requiredChecks:checks.control.value.split(",").map((value)=>value.trim()).filter(Boolean)});clearDraft(submittedDraft);setMessage(message,"Checkpoint добавлен. Таймер плана не запускался.");await renderTracker(true);}catch(error){setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{submit.disabled=false;}});panel.append(form);}
      const stepList=make("div",null,"tracker-list");if(!steps.length)stepList.append(make("p","В этом плане пока нет checkpoint.","muted"));for(const step of steps)stepList.append(renderStep(step,snapshot.plan,planId,message,()=>renderTracker(true)));panel.append(stepList);if(steps.length){const collapseActions=make("div",null,"tracker-collapse-actions");for(const [label,expanded] of [["Свернуть все",false],["Развернуть все",true]]){const button=make("button",label);button.type="button";button.addEventListener("click",()=>stepList.querySelectorAll("[data-checkpoint-toggle]").forEach(toggle=>toggle.setExpanded(expanded)));collapseActions.append(button);}stepList.before(collapseActions);}restoreDrafts(panel);
      if(snapshot.plan.deletedAt==null&&incompletes.length&&["RUNNING","PAUSED"].includes(snapshot.plan.status)){const finishForm=make("form",null,"tracker-form"),finishReason=inputField("Причина явного завершения с незакрытыми checkpoint",{tag:"textarea",required:true,maxLength:1000,rows:2}),finish=make("button","Завершить план с исключением","danger");finish.type="submit";draftForm(finishForm,"finish-exception");finishForm.append(make("p","Условия завершения не выполнены: "+incompletes.map((step)=>step.title+(readinessText(step)?" — "+readinessText(step):"")).join("; ")),finishReason.wrap,finish);finishForm.addEventListener("submit",async(event)=>{event.preventDefault();if(!window.confirm("Завершить план с зафиксированным исключением? Таймер будет остановлен."))return;let accepted=false;const submittedDraft=snapshotDraft(finishForm,planId);finish.disabled=true;try{await command("FinishPlan",{planId:planId,allowIncomplete:true,reason:finishReason.control.value},snapshot.plan.version);accepted=true;clearDraft(submittedDraft);setMessage(message,"План завершён с сохранённым исключением.");await renderTracker(true);try{await refreshAcceptedPlan(planId,"План завершён с сохранённым исключением.");}catch{if(root.dataset.planId===planId)setMessage(root.querySelector("[data-tracker-panel] [role=status]")||message,"План завершён, но данные не обновились. Перезагрузите страницу.",true);}}catch(error){setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{finish.disabled=accepted;}});panel.append(finishForm);restoreDrafts(finishForm.parentElement);}
      const history=make("section",null,"status-history"),timelineHeading=make("h4","История статусов"),toggle=make("button","Показать историю статусов"),body=make("div"),timelineList=make("div",null,"tracker-timeline"),timelineMessage=make("p","","muted");
      body.id="status-history-"+planId;body.hidden=true;toggle.type="button";toggle.setAttribute("aria-expanded","false");toggle.setAttribute("aria-controls",body.id);
      timelineMessage.setAttribute("role","status");timelineMessage.setAttribute("aria-live","polite");
      const pager=make("nav",null,"pager"),summary=make("span","","pager-summary"),controls=make("div",null,"pager-controls"),indicator=make("span","","pager-page"),previous=make("button",null,"pager-arrow"),next=make("button",null,"pager-arrow");
      pager.setAttribute("aria-label","Страницы истории статусов");pager.hidden=true;indicator.setAttribute("aria-live","polite");
      const icon=pathData=>{const svg=document.createElementNS("http://www.w3.org/2000/svg","svg"),path=document.createElementNS("http://www.w3.org/2000/svg","path");svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("aria-hidden","true");svg.setAttribute("focusable","false");path.setAttribute("d",pathData);svg.append(path);return svg;};
      previous.type=next.type="button";previous.setAttribute("aria-label","Предыдущая страница");next.setAttribute("aria-label","Следующая страница");previous.append(icon("M15 18 9 12 15 6"));next.append(icon("M9 18 15 12 9 6"));
      const retry=make("button","Повторить загрузку"),reload=make("button","Обновить историю");retry.type=reload.type="button";retry.hidden=true;
      controls.append(previous,indicator,next);pager.append(summary,controls);body.append(timelineMessage,timelineList,pager,retry,reload);history.append(timelineHeading,toggle,body);panel.append(history);
      const pages=new Map();let currentPage=0,bounds=null,total=0,pageCount=1,busy=false,failedPage=0;
      const isCurrent=()=>token===renderToken&&root.dataset.planId===planId&&panel.isConnected;
      function updateControls(){previous.disabled=busy||currentPage===0;next.disabled=busy||currentPage>=pageCount-1;reload.disabled=retry.disabled=busy;}
      function showPage(page){currentPage=page.page;total=page.total;pageCount=page.pageCount;renderTimeline(timelineList,page.events);pager.hidden=false;summary.textContent=total?(currentPage*8+1)+"–"+Math.min((currentPage+1)*8,total)+" из "+total:"Нет событий";indicator.textContent=(currentPage+1)+" / "+pageCount;setMessage(timelineMessage,"");retry.hidden=true;updateControls();}
      async function loadPage(page,reset=false){
        if(busy)return;if(!reset&&pages.has(page)){showPage(pages.get(page));return;}
        busy=true;failedPage=page;updateControls();body.setAttribute("aria-busy","true");setMessage(timelineMessage,"Загружаю историю…");retry.hidden=true;
        const params=new URLSearchParams({page:String(page),limit:"8"});if(bounds&&!reset){params.set("throughSequence",bounds.throughSequence);params.set("throughEventRowid",bounds.throughEventRowid);}
        try{const result=await api("/api/tracker/plans/"+encodeURIComponent(planId)+"/status-history?"+params);if(!isCurrent())return;if(reset)pages.clear();bounds={throughSequence:result.throughSequence,throughEventRowid:result.throughEventRowid};pages.set(result.page,result);showPage(result);}
        catch(error){if(isCurrent()){setMessage(timelineMessage,"Не удалось загрузить историю: "+error.message,true);retry.hidden=false;retry.onclick=()=>loadPage(failedPage,reset);}}
        finally{busy=false;if(isCurrent()){body.removeAttribute("aria-busy");updateControls();}}
      }
      toggle.addEventListener("click",()=>{const expanded=toggle.getAttribute("aria-expanded")!=="true";toggle.setAttribute("aria-expanded",String(expanded));toggle.textContent=expanded?"Скрыть историю статусов":"Показать историю статусов";body.hidden=!expanded;if(expanded&&!pages.size)loadPage(0);});
      previous.addEventListener("click",()=>loadPage(currentPage-1));next.addEventListener("click",()=>loadPage(currentPage+1));reload.addEventListener("click",()=>loadPage(0,true));
    }catch(error){if(token===renderToken)setMessage(message,(error.code||"ERROR")+": "+error.message,true);}finally{if(token===renderToken)loadingPlanId=null;}}
  function renderStep(step,plan,planId,message,reload){const card=make("article",null,"tracker-card"),heading=make("h4"),toggle=make("button",null,"tracker-card-toggle"),title=make("strong",step.title),statusLabel=make("span",stepStatus(step),"tracker-card-status"),indicator=make("span"),summary=make("p",null,"tracker-meta tracker-card-summary"),body=make("div",null,"tracker-card-body"),cardError=make("p",null,"error tracker-card-error");card.dataset.stepId=step.step_id;body.id="tracker-card-"+encodeURIComponent(planId)+"-"+encodeURIComponent(step.step_id);toggle.type="button";toggle.dataset.checkpointToggle=step.step_id;toggle.setAttribute("aria-controls",body.id);toggle.setAttribute("aria-label",step.title+" · "+stepStatus(step));indicator.setAttribute("aria-hidden","true");toggle.append(title,statusLabel,indicator);heading.append(toggle);cardError.setAttribute("role","alert");const state=stateFor(planId),setExpanded=(expanded)=>{state.cards.set(step.step_id,expanded);toggle.setAttribute("aria-expanded",String(expanded));body.hidden=!expanded;indicator.textContent=expanded?"▾":"▸";};toggle.setExpanded=setExpanded;setExpanded(state.cards.has(step.step_id)?state.cards.get(step.step_id):(["RUNNING","BLOCKED","FAILED"].includes(step.status)||(step.status==="DONE"&&!step.readyToFinish)));toggle.addEventListener("click",()=>setExpanded(toggle.getAttribute("aria-expanded")!=="true"));const currentChecks=step.currentChecks||[],passed=step.requiredChecks.filter(key=>currentChecks.some(check=>check.check_key===key&&check.status==="PASSED"&&check.matchesCurrentResult)).length;summary.textContent=(step.requiredChecks.length?"Проверки: "+passed+"/"+step.requiredChecks.length:"Обязательные проверки не заданы")+" · "+(step.readyToFinish?"Готов к завершению":"Не готов к завершению");card.append(heading,summary,cardError,body);if(!step.readyToFinish&&readinessText(step))card.insertBefore(make("p",readinessText(step),"tracker-meta tracker-blockers"),body);const reportCardError=(error)=>{const text=(error.code||"ERROR")+": "+error.message;setMessage(message,text,true);state.errors.set(step.step_id,text);setMessage(cardError,text,true);setExpanded(true);};const clearCardError=()=>{state.errors.delete(step.step_id);setMessage(cardError,"");};if(state.errors.has(step.step_id))setMessage(cardError,state.errors.get(step.step_id),true);card.addEventListener("invalid",event=>reportCardError({code:"VALIDATION_ERROR",message:event.target.validationMessage||"Проверьте заполнение полей."}),true);body.append(make("p","№"+step.ordinal+" · версия "+step.version,"tracker-meta"),make("p","Ожидаемый результат: "+step.expected_result));body.append(make("p","Обязательные проверки: "+(step.requiredChecks.length?step.requiredChecks.join(", "):"не заданы"),"tracker-meta"));
    const result=step.currentResult;if(result){body.append(make("p","Результат r"+result.revision+": "+status(result.outcome)+" · "+result.summary));body.append(make("p",resultSource(result),"tracker-meta tracker-revision"));}
    if(step.resultHistory.length>1){const history=make("details"),summary=make("summary","История результатов ("+step.resultHistory.length+")");history.dataset.trackerDisclosure=step.step_id+":result-history";history.append(summary);step.resultHistory.forEach((item)=>history.append(make("p","r"+item.revision+" · "+status(item.outcome)+" · "+item.summary+" · "+resultSource(item)+" · "+date(item.created_at))));body.append(history);}
    const checks=make("div",null,"tracker-meta");checks.append(make("strong","Записанные проверки"));if(!step.checks.length)checks.append(make("p","Проверки по этой ревизии ещё не записаны."));step.checks.forEach((check)=>checks.append(make("p","r"+check.result_revision+" · "+check.check_key+" · "+status(check.status)+" · "+(check.tested_snapshot_digest?"снимок "+check.tested_snapshot_digest:"историческое основание")+" · "+(currentChecks.some(item=>item.check_id===check.check_id)?"текущая запись":"история")+(check.exit_code==null?"":" · exit "+check.exit_code)+(check.evidence_summary?" · "+check.evidence_summary:""))));body.append(checks);
    const attempts=make("details"),attemptHeading=make("summary","Попытки ("+step.attempts.length+")");attempts.dataset.trackerDisclosure=step.step_id+":attempts";attempts.append(attemptHeading);step.attempts.forEach((attempt)=>{const reworkText=attempt.rework_reason?" · доработка владельца: "+attempt.rework_reason:"";attempts.append(make("p",(attempt.status==="OPEN"&&attempt.lease_until<=serverTime()?"Срок истёк":status(attempt.status))+" · fence "+attempt.fence+" · lease до "+date(attempt.lease_until)+reworkText));});body.append(attempts);
    if(plan.deletedAt!=null)return card;
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

const UI_ATLM = String.raw`(()=>{
  const planRoot=document.querySelector("#planDetail"),settingsRoot=document.querySelector("#view-settings .settings-grid");
  if(!planRoot||!settingsRoot)return;
  const make=(tag,text,cls)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;};
  const button=(text,action)=>{const el=make("button",text);el.type="button";el.addEventListener("click",action);return el;};
  const minutes=value=>new Intl.NumberFormat("ru-RU",{maximumFractionDigits:1}).format(value/60000)+" мин";
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
  const reasons={COLLECTING_DATA:"Пока недостаточно проверенных завершённых планов.",INCOMPLETE_FEATURES:"Для прогноза не хватает исходных сведений о задаче.",UNSUPPORTED_CATEGORY:"В накопленной истории ещё нет опыта для этого вида задачи.",MODEL_INVALIDATED:"Исходные данные модели изменились; требуется пересборка.",INVALID_PREDICTION:"Модель не смогла получить корректную оценку.",UNSUPPORTED_FORECAST_SCOPE:"Прогноз доступен для полного плана до первого запуска.",DATASET_LIMIT_REACHED:"Накопленные данные сохранены, но превышен текущий предел обучения.",RANK_DEFICIENT:"Данных пока недостаточно для независимой оценки влияния признаков.",INSUFFICIENT_DATA:"Пока недостаточно пригодных данных для обучения и проверки.",INSUFFICIENT_VALIDATION:"Пока недостаточно случаев для проверки новой модели.",INSUFFICIENT_EVALUATION_CASES:"Нужно не менее пяти случаев с прогнозами, проверенными на более поздних результатах.",INSUFFICIENT_INCUMBENT_CASES:"Нужно не менее пяти новых случаев для сравнения с действующей моделью.",MEDIAN_BASELINE_BETTER:"Новая модель ошибается сильнее обычной медианы прошлых длительностей.",CANDIDATE_COVERAGE_WORSE:"Новая модель даёт прогноз для меньшей доли задач, чем действующая.",CANDIDATE_MAE_WORSE:"Средняя ошибка новой модели выше, чем у действующей.",SNAPSHOT_INVALIDATED:"Исходные данные изменились; подготовлена новая попытка обучения.",LEASE_EXPIRED:"Предыдущая обработка не завершилась вовремя; её состояние сохранено.",TRAINING_EXECUTION_FAILED:"Во время обучения произошёл технический сбой.",SOURCE_UNAVAILABLE:"Источник данных временно недоступен.",INVALID_ESTIMATION_SOURCE:"Сохранённый источник оценки не удалось проверить.",MISSING_FEATURES:"До первого запуска не сохранены исходные признаки.",INVALID_FEATURES:"Исходные признаки не соответствуют схеме.",PLAN_DELETED:"План удалён.",PLAN_NOT_COMPLETED:"План ещё не завершён.",RESULT_NOT_VERIFIED:"Результат и обязательные проверки не подтверждены.",SCOPE_CHANGED:"После начала изменился объём задачи.",INCOMPLETE_MEASUREMENT:"Нет полного подтверждённого измерения активного времени."};
  const statuses={IDLE:"Ожидание новых планов",QUEUED:"Обучение в очереди",RUNNING:"Модель обучается",RETRY_WAIT:"Ожидание повторной попытки",COLLECTING_DATA:"Накапливаем опыт",REJECTED:"Новая модель не прошла проверку",FAILED:"Не удалось завершить обучение"};
  const style=make("style");style.textContent=".atlm-panel{min-width:0;overflow-wrap:anywhere}.atlm-panel p{margin:9px 0}.atlm-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}.atlm-heading h2,.atlm-heading h3{margin:0}.atlm-panel button{min-height:42px;white-space:normal}.atlm-controls{display:flex;gap:8px;flex-wrap:wrap}.atlm-point{font-size:1.35rem;font-weight:700;color:var(--ink)}.atlm-plan-estimate{margin:18px 0;padding:16px;border:1px solid var(--line-strong,var(--line));border-radius:var(--radius,10px);background:var(--paper-3,var(--panel))}.atlm-note{color:var(--ink-2,var(--muted));font-size:.9rem}.atlm-stale{border-left:3px solid var(--amber,#a56a16);padding-left:10px}@media(max-width:390px){.atlm-heading{align-items:flex-start}.atlm-controls{width:100%}.atlm-controls button{flex:1 1 100%}}";document.head.append(style);
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
    "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light\"><title>Трекер планов</title>",
    "<style>:root{font-family:Inter,system-ui,sans-serif;color:#18212b;background:#f5f7fa;--muted:#657180;--line:#e2e7ec;--green:#14775e;--panel:#fff}*{box-sizing:border-box}body{margin:0}.shell{max-width:1100px;margin:auto;padding:34px 22px 70px}.top{display:flex;justify-content:space-between;gap:20px;margin-bottom:25px}.eyebrow{font-size:.75rem;letter-spacing:.14em;color:var(--green);font-weight:800;text-transform:uppercase}h1{letter-spacing:-.04em;font-size:clamp(1.7rem,4vw,2.3rem);margin:.35rem 0}.muted{color:var(--muted)}button,input,textarea,select{font:inherit}button{border:0;border-radius:9px;padding:.65rem .9rem;font-weight:700;cursor:pointer;background:#e8edf1;color:#18212b}button:focus-visible,.row[role=button]:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #579ce0;outline-offset:2px}.primary{background:var(--green);color:white}.danger{color:#a43830;background:#fae9e7}.nav{display:flex;gap:7px;border-bottom:1px solid var(--line);margin-bottom:21px;overflow:auto}.nav button{background:none;color:var(--muted);white-space:nowrap;border-radius:0;border-bottom:2px solid transparent}.nav button[aria-current=page]{color:#18212b;border-color:var(--green)}.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:16px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:20px;margin-bottom:16px}h2{font-size:1.1rem;margin:0 0 14px}.current{min-height:210px}.active-plan+.active-plan{border-top:1px solid var(--line);margin-top:20px;padding-top:16px}.active-plan h3{margin:0}.active-plan .plan-open{font-weight:700;overflow-wrap:anywhere}.active-plan .timer{color:#18212b}.timer{font-size:clamp(2rem,6vw,3rem);font-weight:780;letter-spacing:-.06em;font-variant-numeric:tabular-nums;margin:15px 0}.badge{display:inline-block;border-radius:99px;padding:.3rem .58rem;background:#e6f3ed;color:#176b54;font-size:.78rem;font-weight:750}.badge.paused{background:#fff3dd;color:#8d6015}.badge.completed{background:#edf0f3;color:#5f6973}.actions,.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.metric{border:1px solid var(--line);border-radius:11px;padding:13px}.metric small{display:block;color:var(--muted);margin-bottom:7px}.metric strong{font-variant-numeric:tabular-nums}.list{display:grid;gap:8px}.row{display:flex;justify-content:space-between;align-items:center;gap:12px;border:1px solid var(--line);background:white;border-radius:11px;padding:13px}.row-title{font-weight:720}.plan-open{background:transparent;color:inherit;padding:0;border-radius:0;text-align:left;font-weight:inherit;flex:1;min-width:0}.row-meta{display:block;font-size:.82rem;color:var(--muted);margin-top:4px;font-weight:400}.row-right{display:flex;gap:8px;align-items:center}.field{display:grid;gap:6px;min-width:130px;flex:1}.field label{font-weight:700;font-size:.85rem}.field input,.field textarea,.field select{border:1px solid #cbd3dc;border-radius:8px;padding:.65rem;background:white;color:#18212b}.field textarea{min-height:75px}.form{display:grid;gap:12px}.hidden{display:none!important}.notice{padding:11px 13px;border:1px solid #efd8ac;background:#fff8e9;border-radius:9px;margin:12px 0;color:#705115}.error{color:#8f332b;background:#fff0ee;border-color:#ebc5c1}.chart{display:grid;gap:8px;margin-top:16px}.barrow{display:grid;grid-template-columns:95px 1fr 75px;align-items:center;gap:9px;font-size:.82rem}.bar{height:10px;background:#edf0f3;border-radius:20px;overflow:hidden}.bar span{height:100%;display:block;background:#319578}.modal{position:fixed;inset:0;background:#17212b66;display:grid;place-items:center;padding:18px}.modalbox{background:white;border-radius:14px;padding:20px;width:min(620px,100%);max-height:90vh;overflow:auto}.toast{position:fixed;bottom:18px;right:18px;background:#253440;color:white;border-radius:9px;padding:12px 16px;max-width:min(450px,calc(100% - 36px))}.toast.error{background:#913a31;color:white}@media(max-width:720px){.shell{padding:22px 14px 55px}.grid{grid-template-columns:1fr}.panel{padding:16px}.row{align-items:flex-start}.row-right{align-items:flex-end;flex-direction:column}.barrow{grid-template-columns:75px 1fr 65px}}@media(max-width:390px){.actions button{flex:1}.top{gap:8px}}@media(max-width:600px){.metrics{grid-template-columns:1fr}} .grid>*{min-width:0}.field{min-width:0}.field input,.field select,.field textarea,.form>input,.form>textarea{width:100%;min-width:0;max-width:100%}.form>input,.form>textarea{border:1px solid #cbd3dc;border-radius:8px;padding:.65rem}.toolbar:has(.field){display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));align-items:end}.toolbar:has(.field)>button{min-height:44px}#view-overview>.panel:has(#overviewFrom)>.metrics{margin-top:16px}#view-overview>.panel:has(#overviewFrom)>.list{margin-top:16px}.row>*{min-width:0}.row-title,.row-meta,.row a,.row>span,#planDetail p,h2,h3,#who{overflow-wrap:anywhere}.nav{padding:4px}.nav button:focus-visible,a:focus-visible{outline:3px solid #579ce0;outline-offset:2px}.modal{z-index:20}.modalbox{max-height:calc(100dvh - 36px);overscroll-behavior:contain}.toast{z-index:30}button:disabled{cursor:not-allowed;opacity:.55}.form-error{color:#8f332b;background:#fff0ee;border:1px solid #ebc5c1;padding:10px;border-radius:8px}.form-error:empty{display:none}@media(max-width:600px){.top{flex-direction:column}.row{flex-wrap:wrap}.row>.plan-open{flex:1 1 100%}.row>.row-right{width:100%;justify-content:flex-start;flex-direction:row;flex-wrap:wrap}.modal{padding:10px}.modalbox{padding:16px;max-height:calc(100dvh - 20px)}.toolbar:has(.field){grid-template-columns:minmax(0,1fr)}.actions>button{min-height:44px}}@media(max-width:600px){.row>.row-right{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:stretch;gap:8px}.row>.row-right>.badge{grid-column:1/-1;justify-self:start}.row>.row-right>button{min-width:0;min-height:44px;overflow-wrap:anywhere}.row>.row-right>button:last-child:nth-child(even){grid-column:1/-1}.active-plan>.actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.active-plan>.actions>button{min-width:0;min-height:44px;overflow-wrap:anywhere}.active-plan>.actions>button:last-child:nth-child(odd){grid-column:1/-1}}@media(max-width:360px){.row>.row-right,.active-plan>.actions{grid-template-columns:minmax(0,1fr)}}#view-plans>.toolbar{margin-bottom:16px}#view-detail{display:grid;gap:16px}#view-detail>#backPlans{justify-self:start}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.settings-grid>.panel{margin-bottom:0;min-width:0}.settings-grid .form>button{justify-self:start;min-height:44px}.settings-grid p{line-height:1.6}.settings-deleted{grid-column:1/-1}.settings-export{display:block;color:var(--green);font-weight:700;padding:10px 0;overflow-wrap:anywhere}#view-deleted{display:grid;gap:16px}#backSettings{justify-self:start;min-height:44px}#openDeleted{min-height:44px}@media(max-width:720px){.settings-grid{grid-template-columns:minmax(0,1fr)}}</style></head><body><main class=\"shell\">",
    "<header class=\"top\"><div><h1>Трекер планов</h1></div><div class=\"muted\" id=\"who\">Проверка входа…</div></header>",
    "<nav class=\"nav\" aria-label=\"Разделы\"><button data-view=\"overview\" aria-current=\"page\">Обзор</button><button data-view=\"plans\">Планы</button><button data-view=\"analytics\">Аналитика</button><button data-view=\"settings\">Настройки</button></nav><div id=\"notice\" class=\"notice hidden\" role=\"status\"></div>",
    "<section id=\"view-overview\"><div class=\"grid\"><article class=\"panel current\"><h2>Активные планы · <span id=\"activeCount\">0</span></h2><div id=\"active\" class=\"muted\">Загрузка…</div></article><aside class=\"panel\"><h2>Учёт времени</h2><div class=\"metrics\"><div class=\"metric\"><small>Общее время сегодня</small><strong id=\"today\">—</strong></div><div class=\"metric\"><small>Завершено за 30 дней</small><strong id=\"count\">—</strong></div></div><p class=\"muted\">Таймер считает время ночью и в выходные, пока вы не поставите его на паузу.</p><button class=\"primary\" id=\"newPlan\">Новый план</button></aside></div><article class=\"panel\"><h2>Другие планы</h2><div id=\"recent\" class=\"list\"></div></article></section>",
    "<section id=\"view-plans\" class=\"hidden\"><div class=\"toolbar\"><h2 style=\"flex:1\">Планы</h2><button class=\"primary\" id=\"newPlan2\">Создать план</button></div><div id=\"plans\" class=\"list\"></div></section>",
    "<section id=\"view-deleted\" class=\"hidden\"><button id=\"backSettings\" type=\"button\">← К настройкам</button><article class=\"panel\"><h2 tabindex=\"-1\" id=\"deletedHeading\">Удалённые планы</h2><p class=\"muted\">История сохранена. Восстановление не запускает таймер.</p><div id=\"deleted\" class=\"list\" aria-live=\"polite\"></div></article></section><section id=\"view-detail\" class=\"hidden\"><button id=\"backPlans\">← К планам</button><article id=\"planDetail\" class=\"panel\"></article></section>",
    "<section id=\"view-analytics\" class=\"hidden\"><article class=\"panel\"><h2>Отчёт за период</h2><div class=\"toolbar\"><div class=\"field\"><label for=\"from\">С</label><input id=\"from\" type=\"date\" aria-label=\"Дата начала периода\"></div><div class=\"field\"><label for=\"to\">По</label><input id=\"to\" type=\"date\" aria-label=\"Дата конца периода\"></div><button class=\"primary\" id=\"apply\">Применить</button></div><div id=\"stats\" class=\"metrics\" style=\"margin-top:16px\"></div><div id=\"chart\" class=\"chart\"></div><div id=\"analyticPlans\" class=\"list\" style=\"margin-top:15px\"></div></article></section>",
    "<section id=\"view-settings\" class=\"hidden\"><h2>Настройки</h2><div class=\"settings-grid\"><article class=\"panel\"><h2>Настройки времени</h2><form id=\"settings\" class=\"form\"><div class=\"field\"><label for=\"tz\">Часовой пояс</label><select id=\"tz\" required>" + UI_TIME_ZONES.map((option) => "<option value=\"" + option.value + "\"" + (option.value === "Asia/Omsk" ? " selected" : "") + ">" + option.label + "</option>").join("") + "</select></div><button class=\"primary\">Сохранить</button></form><p class=\"muted\">Все отметки времени хранятся в UTC. Часовой пояс используется для отображения дат и отчётов.</p></article><article class=\"panel\"><h2>Экспорт данных</h2><p class=\"muted\">Скачайте аналитический JSON-отчёт: планы, этапы, оценки, результаты, проверки и история работы. Удалённые планы включены.</p><a class=\"settings-export\" href=\"/api/export\">Скачать JSON отчет</a></article><article class=\"panel settings-deleted\"><h2>Удалённые планы</h2><p class=\"muted\">Просматривайте сохранённую историю и восстанавливайте планы. Восстановление не запускает таймер.</p><button id=\"openDeleted\" type=\"button\">Открыть удалённые планы</button></article></div></section>",
    "<div id=\"modal\" class=\"modal hidden\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"modalTitle\"><div class=\"modalbox\"><div class=\"toolbar\"><h2 id=\"modalTitle\" style=\"flex:1\">Новый план</h2><button id=\"close\">Закрыть</button></div><form id=\"create\" class=\"form\"><div class=\"field\"><label for=\"title\">Название</label><input id=\"title\" maxlength=\"200\" required></div><div class=\"field\"><label for=\"description\">Описание</label><textarea id=\"description\"></textarea></div><div class=\"field\"><label for=\"criteria\">Критерии приёмки</label><textarea id=\"criteria\"></textarea></div><div class=\"field\"><label for=\"createdDate\">Дата составления</label><input id=\"createdDate\" type=\"date\" required></div><div class=\"actions\"><button type=\"button\" id=\"cancel\">Отмена</button><button class=\"primary\">Создать план</button></div></form></div></div><div id=\"toast\" class=\"toast hidden\" role=\"status\" aria-live=\"polite\"></div>",
    "</main>",
    "<script>(()=>{" + UI_ANALYTICS + "const q=s=>document.querySelector(s), all=s=>[...document.querySelectorAll(s)];const supportedZones=" + JSON.stringify(UI_TIME_ZONES.map((option) => option.value)) + ";const normalizeZone=value=>supportedZones.includes(value)?value:\"Asia/Omsk\";let plans=[],activePlans=[],deletedRequestId=0,currentDetailPlan=null,detailReturnView=\"plans\",receivedAt=Date.now(),todayActiveMs=0,todayDate=null,refreshRequestId=0,zone=\"Asia/Omsk\",serverNow=Date.now(),pending=new Map(),rejectedValidation=new Set(),rejectedVersion=new Map(),analyticsRequestId=0,detailRequestId=0,timer,modalReturnFocus=null;const uid=()=>crypto.randomUUID();const dateLocal=d=>{const value=Object.fromEntries(new Intl.DateTimeFormat(\"en-CA\",{timeZone:zone,year:\"numeric\",month:\"2-digit\",day:\"2-digit\"}).formatToParts(d).map(part=>[part.type,part.value]));return value.year+\"-\"+value.month+\"-\"+value.day};const duration=n=>{if(n==null)return\"—\";n=Math.max(0,Math.round(n/60000));const day=Math.floor(n/1440),h=Math.floor(n%1440/60),m=n%60;return day?day+\" д \"+h+\" ч \"+m+\" мин\":h?h+\" ч \"+m+\" мин\":m+\" мин\"};const formatPlanSample=n=>{const count=Number(n)||0,lastTwo=count%100;return\"по \"+count+\" \"+((lastTwo>=11&&lastTwo<=14)||count%10!==1?\"планам\":\"плану\")};const dateFmt=n=>n==null?\"—\":new Intl.DateTimeFormat(\"ru-RU\",{dateStyle:\"medium\",timeStyle:\"short\",timeZone:zone}).format(new Date(n));const statusText=status=>({PLANNED:\"Запланирован\",RUNNING:\"Выполняется\",PAUSED:\"На паузе\",COMPLETED:\"Завершён\"})[status]||status;function showToast(t,err){const x=q(\"#toast\");x.textContent=t;x.classList.toggle(\"error\",!!err);x.classList.remove(\"hidden\");clearTimeout(timer);timer=setTimeout(()=>x.classList.add(\"hidden\"),4500)}async function call(path,opt){const r=await fetch(path,{...opt,headers:{\"content-type\":\"application/json\",...(opt&&opt.headers||{})},cache:\"no-store\"});let v={};try{v=await r.json()}catch{}if(!r.ok){const e=new Error(v.error&&v.error.message||\"HTTP \"+r.status);e.status=r.status;e.code=v.error&&v.error.code;e.details=v.error&&v.error.details;throw e}return v}const rejectedTerminal=new Set();async function hasFinalPlanRejection(type,envelope,error){if(error.status!==409||!((type===\"FinishPlan\"&&error.code===\"CHECKPOINTS_INCOMPLETE\")||(type===\"DeletePlan\"&&error.code===\"PLAN_DELETED\")||(type===\"RestorePlan\"&&error.code===\"PLAN_NOT_DELETED\")))return false;try{const receipt=await call(\"/api/tracker/commands/\"+encodeURIComponent(envelope.commandId));return receipt.status===\"FINAL\"&&receipt.commandId===envelope.commandId&&receipt.commandType===envelope.commandType&&receipt.error?.code===error.code&&!receipt.result}catch{return false}}function makeCmd(type,plan,payload){const key=type+\":\"+(plan?plan.planId:\"new\"),nextPayload={...(plan?{planId:plan.planId}:{}),...(payload||{})};let c=pending.get(key);const newVersion=plan?plan.version:undefined;if(c&&rejectedTerminal.has(key)){c=null;pending.delete(key);rejectedTerminal.delete(key)}if(c&&rejectedValidation.has(key)&&JSON.stringify(c.payload)!==JSON.stringify(nextPayload)){c=null;pending.delete(key);rejectedValidation.delete(key)}if(c&&rejectedVersion.has(key)&&c.expectedVersion!==newVersion){c=null;pending.delete(key);rejectedVersion.delete(key)}if(c&&JSON.stringify(c.payload)!==JSON.stringify(nextPayload)){const e=new Error(\"Исход предыдущей команды неизвестен. Повторите её без изменения данных или обновите состояние перед новой командой.\");e.code=\"COMMAND_OUTCOME_UNKNOWN\";throw e}if(!c){c={schemaVersion:1,commandId:uid(),commandType:type,expectedVersion:newVersion,payload:nextPayload};pending.set(key,c)}return [key,c]}async function command(type,plan,payload){let prepared;try{prepared=makeCmd(type,plan,payload)}catch(e){showToast((e.code||\"ERROR\")+\": \"+e.message,true);throw e}const [key,c]=prepared;let r;try{r=await call(\"/api/commands\",{method:\"POST\",body:JSON.stringify(c)});if(r?.commandId!==c.commandId||r.outcome!==\"OK\"||typeof r.applied!==\"boolean\"||typeof r.replayed!==\"boolean\"||r.applied===r.replayed||!r.result||typeof r.result!==\"object\"||Array.isArray(r.result)||r.error){const e=new Error(\"Ответ команды не подтверждает её результат. Повторите запрос без изменения данных.\");e.code=\"COMMAND_OUTCOME_UNKNOWN\";throw e}}catch(e){if(e.code===\"VALIDATION_ERROR\")rejectedValidation.add(key);else if(await hasFinalPlanRejection(type,c,e))rejectedTerminal.add(key);if(e.code===\"VERSION_CONFLICT\"&&Number.isSafeInteger(e.details&&e.details.currentVersion)){rejectedVersion.set(key,e.details.currentVersion);if(plan)plan.version=e.details.currentVersion}showToast((e.code||\"ERROR\")+\": \"+e.message,true);if(e.code===\"VERSION_CONFLICT\")try{await refresh()}catch{}throw e}pending.delete(key);rejectedValidation.delete(key);rejectedVersion.delete(key);rejectedTerminal.delete(key);showToast(r.replayed?\"Повторный запрос обработан по сохранённому результату.\":\"Изменение сохранено.\");try{await refresh()}catch{showToast(\"Изменение сохранено, но данные не обновились. Перезагрузите страницу.\",true)}return r}window.addEventListener(\"plan-time-tracker:command\",event=>{const detail=event.detail||{};command(detail.commandType,detail.plan,detail.payload).then(detail.resolve,detail.reject)});window.addEventListener(\"plan-time-tracker:refresh-plan\",event=>{const detail=event.detail||{},navigationToken=detailRequestId;(async()=>{await refresh();if(navigationToken===detailRequestId&&!q(\"#view-detail\").classList.contains(\"hidden\")&&q(\"#planDetail\").dataset.planId===detail.planId)await openPlan(detail.planId,detail.successMessage)})().then(detail.resolve,detail.reject)});function btn(text,fn,cls){const b=document.createElement(\"button\");b.textContent=text;if(cls)b.className=cls;b.onclick=async e=>{e.stopPropagation();if(b.disabled)return;b.disabled=true;try{await fn()}catch{}finally{b.disabled=false}};return b}function deletionButton(p){const restoring=p.deletedAt!=null;return btn(restoring?\"Восстановить\":\"Удалить\",async()=>{if(!window.confirm(restoring?\"Восстановить план «\"+p.title+\"»? Таймер останется остановленным.\":\"Удалить план «\"+p.title+\"»? Активное время и попытки будут остановлены. План можно восстановить в настройках, в разделе «Удалённые планы».\"))return;const navigationToken=detailRequestId;await command(restoring?\"RestorePlan\":\"DeletePlan\",p);if(navigationToken===detailRequestId&&q(\"#planDetail\").dataset.planId===p.planId&&!q(\"#view-detail\").classList.contains(\"hidden\"))await openPlan(p.planId)},restoring?\"\":\"danger\")}async function loadDeleted(){const requestId=++deletedRequestId,list=q(\"#deleted\");list.textContent=\"Загружаю удалённые планы…\";try{let page=await call(\"/api/plans?deleted=true&limit=100\"),collected=[...page.plans];while(page.nextCursor){page=await call(\"/api/plans?deleted=true&limit=100&cursor=\"+encodeURIComponent(page.nextCursor));if(requestId!==deletedRequestId)return;collected.push(...page.plans)}if(requestId!==deletedRequestId)return;list.replaceChildren();if(!collected.length)list.textContent=\"Удалённых планов нет.\";else collected.forEach(p=>list.append(card(p)))}catch(error){if(requestId!==deletedRequestId)return;list.textContent=\"Не удалось загрузить удалённые планы. \"+error.message;list.append(btn(\"Повторить\",loadDeleted));}}function finishButton(p,confirmation){let b;if(p.completion&&!p.completion.readyToFinish){b=btn(\"Условия завершения\",()=>openPlan(p.planId));b.title=\"Не выполнены условия этапов: \"+p.completion.incompleteStepCount}else b=btn(\"Завершить\",async()=>{if(!window.confirm(confirmation))return;try{await command(\"FinishPlan\",p)}finally{if(q(\"#planDetail\").dataset.planId===p.planId&&!q(\"#view-detail\").classList.contains(\"hidden\"))await openPlan(p.planId)}},\"danger\");b.dataset.finishPlan=p.planId;return b}window.addEventListener(\"plan-time-tracker:completion-updated\",event=>{const next=event.detail;if(!next?.completion)return;const summaries=[...plans,...activePlans,currentDetailPlan].filter(p=>p&&p.planId===next.planId);for(const p of summaries)p.completion=next.completion;const p=summaries[0];if(p)for(const button of all(\"[data-finish-plan]\"))if(button.dataset.finishPlan===p.planId)button.replaceWith(finishButton(p,\"Завершить план? Сервер остановит таймер.\"))});function card(p){const row=document.createElement(\"div\");row.className=\"row\";row.dataset.planId=p.planId;const left=document.createElement(\"button\"),title=document.createElement(\"span\"),meta=document.createElement(\"span\");left.type=\"button\";left.className=\"plan-open\";left.onclick=()=>openPlan(p.planId);left.setAttribute(\"aria-label\",p.title);title.className=\"row-title\";title.textContent=p.title;meta.className=\"row-meta\";meta.textContent=(p.status===\"RUNNING\"?\"Выполняется\":p.status===\"PAUSED\"?\"Пауза\":p.status===\"COMPLETED\"?\"Завершён\":\"Запланирован\")+\" · активно \"+duration(p.activeMs)+\" · создан \"+dateFmt(p.registeredAt);left.append(title,meta);const right=document.createElement(\"div\");right.className=\"row-right\";const badge=document.createElement(\"span\");badge.className=\"badge \"+p.status.toLowerCase();badge.textContent=statusText(p.status);right.append(badge);if(p.deletedAt!=null){badge.textContent=\"Удалён\";meta.textContent=\"Удалён \"+dateFmt(p.deletedAt)+\" · активно \"+duration(p.activeMs);right.append(deletionButton(p));row.append(left,right);return row}if(p.status===\"PLANNED\")right.append(btn(\"Запустить\",()=>command(\"StartPlan\",p),\"primary\"));if(p.status===\"RUNNING\")right.append(btn(\"Пауза\",()=>command(\"PausePlan\",p)));if(p.status===\"PAUSED\")right.append(btn(\"Продолжить\",()=>command(\"ResumePlan\",p),\"primary\"));if(p.status===\"RUNNING\"||p.status===\"PAUSED\")right.append(finishButton(p,\"Завершить план? Сервер остановит таймер.\"));right.append(deletionButton(p));row.append(left,right);return row}async function openPlan(planId,successMessage){const returnView=!q(\"#view-detail\").classList.contains(\"hidden\")?detailReturnView:!q(\"#view-deleted\").classList.contains(\"hidden\")?\"deleted\":\"plans\";const requestToken=++detailRequestId;try{const p=(await call(\"/api/plans/\"+encodeURIComponent(planId)+\"?includeEvents=false\")).plan;if(requestToken!==detailRequestId)return;detailReturnView=returnView;q(\"#backPlans\").textContent=returnView===\"deleted\"?\"← К удалённым планам\":\"← К планам\";currentDetailPlan=p;const box=q(\"#planDetail\");window.dispatchEvent(new CustomEvent(\"plan-time-tracker:plan-will-render\"));box.dataset.planId=planId;box.replaceChildren();const h=document.createElement(\"h2\");h.textContent=p.title;box.append(h);const m=document.createElement(\"p\");m.className=\"muted\";m.textContent=\"Дата плана: \"+(p.planCreatedAt.precision===\"dateOnly\"?p.planCreatedAt.on:dateFmt(Date.parse(p.planCreatedAt.value)))+\" · создан \"+dateFmt(p.registeredAt)+\" · \"+statusText(p.status);box.append(m);const deletionActions=document.createElement(\"div\");deletionActions.className=\"actions\";deletionActions.append(deletionButton(p));box.append(deletionActions);if(p.deletedAt!=null){const notice=document.createElement(\"p\");notice.className=\"notice\";notice.textContent=\"План удалён. История доступна только для чтения. Восстановление не запускает таймер.\";box.append(notice)}if(p.deletedAt==null&&(p.status===\"RUNNING\"||p.status===\"PAUSED\")){const actions=document.createElement(\"div\");actions.className=\"actions plan-completion-actions\";actions.append(finishButton(p,\"Завершить план? Сервер остановит таймер.\"));box.append(actions)}for(const label of [p.description||\"Описание не задано.\",\"Критерии приёмки: \"+(p.acceptanceCriteria||\"не заданы\"),\"Активно \"+duration(p.activeMs)+\" · календарное \"+duration(p.calendarMs)+\" · пауза \"+duration(p.pausedMs)]){const e=document.createElement(\"p\");e.textContent=label;box.append(e)}if(p.deletedAt==null){const edit=document.createElement(\"form\");edit.className=\"form\";edit.dataset.trackerForm=\"plan-metadata\";const title=document.createElement(\"input\");title.value=p.title;title.maxLength=200;title.setAttribute(\"aria-label\",\"Название плана\");const description=document.createElement(\"textarea\");description.value=p.description||\"\";description.maxLength=20000;description.setAttribute(\"aria-label\",\"Описание\");const criteria=document.createElement(\"textarea\");criteria.value=p.acceptanceCriteria||\"\";criteria.maxLength=20000;criteria.setAttribute(\"aria-label\",\"Критерии приёмки\");const date=document.createElement(\"input\");date.type=\"date\";date.value=p.planCreatedAt.precision===\"dateOnly\"?p.planCreatedAt.on:dateLocal(Date.parse(p.planCreatedAt.value));date.setAttribute(\"aria-label\",\"Дата составления\");const reason=document.createElement(\"input\");reason.placeholder=\"Причина правки даты\";reason.setAttribute(\"aria-label\",\"Причина правки даты\");const label=document.createElement(\"label\"),confirm=document.createElement(\"input\");confirm.type=\"checkbox\";confirm.dataset.draftField=\"confirmDateAnomaly\";label.className=\"checkbox-field\";const confirmText=document.createElement(\"span\");confirmText.textContent=\"Подтверждаю дату составления после первого старта\";label.append(confirm,confirmText);const save=document.createElement(\"button\");save.textContent=\"Сохранить изменения\";const labelled=(text,control)=>{const field=document.createElement(\"label\");field.className=\"field\";field.append(document.createTextNode(text),control);return field};edit.append(labelled(\"Название плана\",title),labelled(\"Описание\",description),labelled(\"Критерии приёмки\",criteria),labelled(\"Дата составления\",date),labelled(\"Причина правки даты\",reason),label,save);edit.onsubmit=async e=>{e.preventDefault();const draftSubmission={planId:p.planId,form:edit};window.dispatchEvent(new CustomEvent(\"plan-time-tracker:draft-submitted\",{detail:draftSubmission}));await command(\"UpdatePlanMetadata\",p,{title:title.value,description:description.value,acceptanceCriteria:criteria.value,planCreatedAt:p.planCreatedAt.precision===\"instant\"&&date.value===dateLocal(Date.parse(p.planCreatedAt.value))?p.planCreatedAt:{precision:\"dateOnly\",on:date.value,timeZone:zone},reason:reason.value,confirmDateAnomaly:confirm.checked});window.dispatchEvent(new CustomEvent(\"plan-time-tracker:draft-cleared\",{detail:{submission:draftSubmission.submission}}));await openPlan(p.planId)};box.append(edit);}const intervals=document.createElement(\"div\"),ih=document.createElement(\"h3\");ih.textContent=\"Интервалы\";intervals.append(ih);p.intervals.forEach(i=>{const e=document.createElement(\"p\");e.textContent=dateFmt(i.start_ms)+\" — \"+dateFmt(i.end_ms)+\" · \"+duration((i.end_ms||p.serverNow)-i.start_ms);intervals.append(e)});box.append(intervals);view(\"detail\");window.dispatchEvent(new CustomEvent(\"plan-time-tracker:plan-rendered\",{detail:{planId,successMessage}}))}catch(e){showToast((e.code||\"ERROR\")+\": \"+e.message,true)}}function renderActive(){const el=q(\"#active\");el.replaceChildren();q(\"#activeCount\").textContent=String(activePlans.length);if(!activePlans.length){const p=document.createElement(\"p\");p.className=\"muted\";p.textContent=\"Активных планов нет. Создайте план и запустите, когда начнёте работу.\";el.append(p,btn(\"Создать план\",openModal,\"primary\"));return}for(const plan of activePlans){const panel=document.createElement(\"section\");panel.className=\"active-plan\";panel.dataset.planId=plan.planId;panel.setAttribute(\"aria-label\",plan.title);const title=document.createElement(\"h3\");title.append(btn(plan.title,()=>openPlan(plan.planId),\"plan-open\"));const clock=document.createElement(\"div\");clock.className=\"timer\";clock.dataset.clockPlan=plan.planId;clock.setAttribute(\"aria-label\",\"Активное время: \"+plan.title);clock.textContent=duration(plan.activeMs+Math.max(0,Date.now()-receivedAt));const detail=document.createElement(\"div\");detail.className=\"muted\";detail.textContent=\"Начат \"+dateFmt(plan.firstStartedAt);const actions=document.createElement(\"div\");actions.className=\"actions\";actions.append(btn(\"Пауза\",()=>command(\"PausePlan\",plan)),finishButton(plan,\"Завершить план? Время будет остановлено сервером.\"),deletionButton(plan));panel.append(title,clock,detail,actions);el.append(panel)}}" + UI_PLAN_LISTS + "async function refresh(){const requestId=++refreshRequestId;const [first,w,settings]=await Promise.all([call(\"/api/plans?limit=100\"),call(\"/api/whoami\"),call(\"/api/settings\")]);let collected=[...first.plans],cursor=first.nextCursor;while(cursor){const page=await call(\"/api/plans?limit=100&cursor=\"+encodeURIComponent(cursor));if(requestId!==refreshRequestId)return;collected.push(...page.plans);cursor=page.nextCursor}const nextZone=normalizeZone(settings.timezone),dateParts=Object.fromEntries(new Intl.DateTimeFormat(\"en-CA\",{timeZone:nextZone,year:\"numeric\",month:\"2-digit\",day:\"2-digit\"}).formatToParts(first.serverNow).map(part=>[part.type,part.value])),today=dateParts.year+\"-\"+dateParts.month+\"-\"+dateParts.day;const daily=await call(\"/api/analytics?\"+new URLSearchParams({from:today,to:today,timeZone:nextZone}));if(requestId!==refreshRequestId)return;plans=collected.map(plan=>plan.status===\"RUNNING\"?{...plan,activeMs:plan.activeMs+Math.max(0,daily.serverNow-plan.serverNow),calendarMs:plan.calendarMs+Math.max(0,daily.serverNow-plan.serverNow),serverNow:daily.serverNow}:plan);activePlans=plans.filter(plan=>plan.status===\"RUNNING\");serverNow=daily.serverNow;receivedAt=Date.now();todayActiveMs=daily.totalActiveMs;todayDate=today;zone=nextZone;q(\"#who\").textContent=w.email||\"Личный аккаунт\";q(\"#tz\").value=zone;render();if(!q(\"#view-deleted\").classList.contains(\"hidden\"))await loadDeleted()}function openModal(){modalReturnFocus=document.activeElement;document.body.style.overflow=\"hidden\";q(\"#modal\").classList.remove(\"hidden\");q(\"#createdDate\").value=dateLocal(Date.now());q(\"#title\").focus();}function closeModal(){if(q(\"#create\").getAttribute(\"aria-busy\")===\"true\")return;q(\"#modal\").classList.add(\"hidden\");document.body.style.overflow=\"\";if(modalReturnFocus?.isConnected)modalReturnFocus.focus()}async function loadAnalytics(){const requestId=++analyticsRequestId;const d=new Date(),from=new Date(d);from.setDate(from.getDate()-29);if(!q(\"#from\").value)q(\"#from\").value=dateLocal(from);if(!q(\"#to\").value)q(\"#to\").value=dateLocal(d);const u=new URLSearchParams({from:q(\"#from\").value,to:q(\"#to\").value,timeZone:zone});let a;try{a=await call(\"/api/analytics?\"+u)}catch(error){if(requestId!==analyticsRequestId)return;throw error}if(requestId!==analyticsRequestId)return;const stats=q(\"#stats\");stats.replaceChildren();const medianText=duration(a.completedMedianActiveMs)+(a.completedMedianActiveMs==null?\"\":\" · \"+formatPlanSample(a.completedMeasuredN));[[\"Общее время за период\",duration(a.totalActiveMs)],[\"Завершено планов\",String(a.completedPlans)],[\"Медиана активного времени\",medianText],[\"Сумма времени планов\",duration(a.sumPlanActiveMs)]].forEach(([k,v],index)=>{const box=document.createElement(\"div\"),small=document.createElement(\"small\"),strong=document.createElement(\"strong\");box.className=\"metric\";small.textContent=k;strong.textContent=v;box.append(small,strong);if(index===2&&a.completedSmallSample){const note=document.createElement(\"small\");note.className=\"sample-note\";note.textContent=\"Малая выборка\";note.title=\"Медиана рассчитана по менее чем пяти завершённым планам.\";note.setAttribute(\"aria-label\",\"Малая выборка: менее пяти завершённых планов.\");box.append(note)}stats.append(box)});const chart=q(\"#chart\");chart.replaceChildren();const max=Math.max(1,...a.activeByDay.map(x=>x.activeMs));a.activeByDay.forEach(x=>{const row=document.createElement(\"div\"),date=document.createElement(\"span\"),bar=document.createElement(\"div\"),fill=document.createElement(\"span\"),v=document.createElement(\"span\");row.className=\"barrow\";bar.className=\"bar\";fill.style.width=(100*x.activeMs/max)+\"%\";bar.append(fill);date.textContent=x.date;v.textContent=duration(x.activeMs);row.append(date,bar,v);chart.append(row)});const list=q(\"#analyticPlans\");list.replaceChildren();if(!a.plans.length){const p=document.createElement(\"p\");p.className=\"muted\";p.textContent=\"За выбранный период данных нет.\";list.append(p)}else renderAnalyticsPlanCards(list,a)}function view(name){if(name!==\"detail\")detailRequestId++;all(\"[id^=view-]\").forEach(x=>x.classList.toggle(\"hidden\",x.id!==\"view-\"+name));all(\".nav button\").forEach(b=>b.setAttribute(\"aria-current\",b.dataset.view===(name===\"deleted\"||(name===\"detail\"&&detailReturnView===\"deleted\")?\"settings\":name===\"detail\"?\"plans\":name)?\"page\":\"false\"));if(name===\"deleted\")loadDeleted();if(name===\"analytics\")loadAnalytics().catch(e=>showToast(e.message,true));}all(\".nav button\").forEach(b=>b.onclick=()=>view(b.dataset.view));q(\"#backPlans\").onclick=()=>{view(detailReturnView);if(detailReturnView===\"deleted\")q(\"#deletedHeading\").focus()};q(\"#openDeleted\").onclick=()=>{view(\"deleted\");q(\"#deletedHeading\").focus()};q(\"#backSettings\").onclick=()=>{view(\"settings\");q(\"#openDeleted\").focus()};q(\"#newPlan\").onclick=openModal;q(\"#newPlan2\").onclick=openModal;q(\"#close\").onclick=closeModal;q(\"#cancel\").onclick=closeModal;q(\"#modal\").onclick=e=>{if(e.target.id===\"modal\")closeModal()};q(\"#create\").onsubmit=async e=>{e.preventDefault();const payload={title:q(\"#title\").value,description:q(\"#description\").value,acceptanceCriteria:q(\"#criteria\").value,planCreatedAt:{precision:\"dateOnly\",on:q(\"#createdDate\").value,timeZone:zone}};try{await command(\"CreatePlan\",null,payload);e.target.removeAttribute(\"aria-busy\");closeModal();e.target.reset();showToast(\"План создан. Таймер не запущен.\")}catch(x){showToast((x.code||\"ERROR\")+\": \"+x.message,true)}};q(\"#apply\").onclick=()=>loadAnalytics().catch(e=>showToast(e.message,true));q(\"#settings\").onsubmit=async e=>{e.preventDefault();try{const r=await call(\"/api/settings\",{method:\"POST\",body:JSON.stringify({timezone:q(\"#tz\").value})});zone=normalizeZone(r.timezone);q(\"#tz\").value=zone;window.dispatchEvent(new CustomEvent(\"plan-time-zone-changed\",{detail:zone}));await refresh();showToast(\"Часовой пояс сохранён.\")}catch(x){showToast((x.code||\"ERROR\")+\": \"+x.message,true)}};setInterval(()=>{const elapsed=Math.max(0,Date.now()-receivedAt);for(const plan of activePlans){const clock=all(\"[data-clock-plan]\").find(node=>node.dataset.clockPlan===plan.planId);if(clock)clock.textContent=duration(plan.activeMs+elapsed)}if(todayDate&&dateLocal(serverNow+elapsed)!==todayDate){todayDate=null;refresh().catch(e=>showToast(e.message,true))}else if(q(\"#today\"))q(\"#today\").textContent=duration(todayActiveMs+(activePlans.length?elapsed:0))},1000);refresh().catch(e=>{q(\"#who\").textContent=\"Требуется вход\";showToast(e.message,true)})})();</script></body></html>"
  ].join("").replace("</head>", "<style>" + UI_FONT_CSS + UI_ANALYTICS_CSS + UI_PLAN_LISTS_CSS + "</style></head>").replace("</body></html>", "<script>" + UI_ENHANCEMENTS + "</script><script>" + UI_TRACKER + UI_ATLM + "</script><script>" + UI_ACCESSIBILITY + "</script><style>" + UI_CONSOLE_PAPER_CSS + "</style></body></html>");
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
  if(["COMMIT","WORKTREE_SNAPSHOT"].includes(result.source_kind)) result.source_kind="HISTORICAL";
  if(["commit_created","commit_pushed","push_failed"].includes(result.eventType)) {result.eventType="HISTORICAL_EVENT";result.payload={historical:true};}
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

  if (request.method === "GET" && url.pathname === "/api/tracker/capabilities") return json(await readTrackerCapabilities(env.DB, identity.ownerId));
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
  const statusHistoryMatch = url.pathname.match(/^\/api\/tracker\/plans\/([^/]+)\/status-history$/);
  if (request.method === "GET" && statusHistoryMatch) {
    const options = Object.fromEntries(["page", "limit", "throughSequence", "throughEventRowid"]
      .filter(key => url.searchParams.has(key)).map(key => [key, Number(url.searchParams.get(key))]));
    return json({ ...await readStatusHistory(env.DB, identity.ownerId, decodeURIComponent(statusHistoryMatch[1]), options), serverNow: now });
  }
  const timelineMatch = url.pathname.match(/^\/api\/tracker\/plans\/([^/]+)\/timeline$/);
  if (request.method === "GET" && timelineMatch) {
    const afterSequence = url.searchParams.has("afterSequence") ? Number(url.searchParams.get("afterSequence")) : 0;
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
    return json({ ...await readTrackerTimeline(env.DB, identity.ownerId, decodeURIComponent(timelineMatch[1]), afterSequence, limit), serverNow: now });
  }
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

const TOOL_NAMES = ["CreatePlan", "GetPlan", "ListPlans", "StartPlan", "PausePlan", "ResumePlan", "FinishPlan", "DeletePlan", "RestorePlan", "UpdatePlanMetadata", "GetAnalytics", ...TRACKER_READ_TOOLS, ...TRACKER_COMMANDS, "ProcessEstimationTraining"];
function mcpTools() {
  const writeNames = new Set([...WRITE_COMMANDS, ...TRACKER_COMMANDS]);
  const assessmentDescriptions = {
    RecordAssessment: "Записать оценку или неизменяемую ревизию. expectedVersion=0 создаёт серию; затем укажите revision и reason. Метод и шкалу выбирает агент, прогноз отдельно в ms. Обязателен expectedRequirementsDigest из GetAssessment без assessmentId, прочитанный до анализа. Таймер не запускается.",
    GetAssessment: "Без assessmentId: прочитать текущие requirements/currentRequirementsDigest для анализа до первой оценки или пересмотра; stepId необязателен. С assessmentId: прочитать сохранённую ревизию (revision необязателен) и needsRevision; requirements в этом ответе относятся к сохранённому снимку.",
    GetEstimationHistory: "Факты и оценки по явным targets. Метрики ms раздельны, общий активный итог — объединение интервалов родителей. При пагинации сохраняйте asOf, throughSequence и nextAfterSequence как afterSequence. Окно дат относится к фактам времени, оценки читаются до asOf. Статистики относятся ко всей выборке фактов; readiness текущая. Попытки и вызовы не равны длительности задачи.",
    CalculateEstimate: "Рассчитать медиану явных сопоставимых завершённых планов по серверным интервалам PLAN_ACTIVE. Профиль, отбор и покрытие являются утверждениями агента; текущие requirements и полное содержимое исходников проверяются на сервере. Read-only.",
  };
  return TOOL_NAMES.map((name) => {
    let inputSchema = { type: "object", additionalProperties: false };
    if (Object.hasOwn(ATLM_TOOL_SCHEMAS, name)) return { name, description: ({
      CalculateAtlmEstimate: "Предпросмотр полного PLAN_ACTIVE по активной ATLM-модели владельца до первого StartPlan. Только факты AgentTaskV1; ничего не обучает и не сохраняет.",
      GetPlanEstimate: "Сохранённый прогноз плана; после первого запуска только исходная frozen-оценка. isStale отмечает изменение требований или исходных данных модели.",
      GetEstimationModelStatus: "Состояние модели, накопление пригодных планов и очередь обучения владельца. Только чтение.",
      ProcessEstimationTraining: "Один ограниченный проход долговечной очереди владельца. Идемпотентная мутация без planId, с lease и fence; может потребоваться повторный проход.",
      GetAtlmDataset: "Приватная постраничная выгрузка неизменяемых sample-версий. Сохраняйте nextCursor; DATASET_CHANGED требует начать заново. Используется последняя версия каждого плана, только если она пригодна.",
    })[name], inputSchema: ATLM_TOOL_SCHEMAS[name], annotations: { readOnlyHint: name !== "ProcessEstimationTraining", destructiveHint: false, idempotentHint: true, openWorldHint: false } };
    if (name === "GetPlan") inputSchema = { type: "object", required: ["planId"], properties: { planId: { type: "string", format: "uuid" } }, additionalProperties: false };
    else if (name === "ListPlans") inputSchema = { type: "object", properties: {
      statuses: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { enum: PLAN_STATUSES } },
      limit: { type: "integer", minimum: 1, maximum: MAX_PLAN_PAGE_SIZE, default: 50 },
      cursor: { type: "string", maxLength: 200 },
      deleted: { type: "boolean", default: false, description: "true — только удалённые планы; false — только обычные" },
    }, additionalProperties: false };
    else if (name === "GetTrackerCapabilities") inputSchema = { type: "object", properties: {}, additionalProperties: false };
    else if (name === "GetPlanExecutionSnapshot") inputSchema = { type: "object", required: ["planId"], properties: { planId: { type: "string", format: "uuid" } }, additionalProperties: false };
    else if (name === "GetTimeline") inputSchema = { type: "object", required: ["planId"], properties: { planId: { type: "string", format: "uuid" }, afterSequence: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false };
    else if (name === "GetCommandReceipt") inputSchema = { type: "object", required: ["commandId"], properties: { commandId: { type: "string", format: "uuid" } }, additionalProperties: false };
    else if (name === "GetAnalytics") inputSchema = { type: "object", required: ["from", "to", "timeZone"], properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" }, timeZone: { type: "string" } }, additionalProperties: false };
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
          sourceId: { type: "string", minLength: 1, maxLength: 128, pattern: "^\\S(?:[\\s\\S]*\\S)?$" },
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
          sourceId: { type: "string", minLength: 1, maxLength: 128, pattern: "^\\S(?:[\\s\\S]*\\S)?$" }, sessionId: { type: "string", format: "uuid" },
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
          expectedVersion: { type: "integer", minimum: TRACKER_VERSIONED_COMMANDS.has(name) || name === "RenewStepLease" ? 1 : 0 }, payloadHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          sourceReference: { type: "string", maxLength: 2048 },
          payload: { type: "object", required: payloadRequired, properties: payloadProperties, ...(payloadAnyOf ? { anyOf: payloadAnyOf } : {}), additionalProperties: false },
        }, additionalProperties: false,
      };
    }
    if (assessmentDescriptions[name]) return { name, description: assessmentDescriptions[name], inputSchema,
      ...(name === "CalculateEstimate" ? { annotations: { readOnlyHint: true, destructiveHint: false } } : {}) };
    return { name: name, description: name === "DeletePlan" ? "Переместить план в удалённые: остановить его таймер и попытки, сохранить историю. Требует явной просьбы пользователя и текущей версии." : name === "RestorePlan" ? "Восстановить удалённый план без запуска таймера. Требует явной просьбы пользователя и текущей версии." : name === "ListPlans" ? "Список планов владельца с фильтрами statuses, deleted (по умолчанию false) и стабильной пагинацией nextCursor; RUNNING возвращает все активные планы. Не выбирает план для исполнителя." : name === "GetAnalytics" ? "Общее totalActiveMs и activeByDay — объединение интервалов; sumPlanActiveMs — сумма времени планов. Все значения времени в миллисекундах." : ["StartPlan", "ResumePlan", "PausePlan", "FinishPlan"].includes(name) ? name + ": меняет только указанный planId; другие планы продолжаются независимо." : name === "CreatePlan" ? "Создать план и дату составления; таймер не запускается." : name === "CreateStep" ? "Создать checkpoint в плане; таймер плана не меняется." : name === "AppendObservation" ? "Добавить bounded metadata observation; не меняет состояние шага или таймер." : name + " через общий командный/API слой Sites.", inputSchema: inputSchema };
  });
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
  const name = rpc.params && rpc.params.name;
  const args = rpc.params && rpc.params.arguments || {};
  try {
    if(!TOOL_NAMES.includes(name)) throw appError("FEATURE_REMOVED","Инструмент недоступен в текущем контракте.",410);
    if(name==="GetAnalytics" && Object.hasOwn(args,"repositoryIds")) throw appError("VALIDATION_ERROR","Фильтр удален из текущего контракта.");
    if(WRITE_COMMANDS.has(name)||TRACKER_COMMANDS.has(name)) validatePublicCommand({...args,commandType:name});
    await ensureOwner(env.DB, identity, now);
    let result;
    if (Object.hasOwn(ATLM_TOOL_SCHEMAS, name)) result = await executeAtlmTool(env.DB, identity.ownerId, name, rpc.params?.arguments === undefined ? {} : rpc.params.arguments, now, clock);
    else if (name === "GetPlan") result = await readPlan(env.DB, identity.ownerId, args.planId, now);
    else if (name === "GetAssessment") result = await readAssessment(env.DB, identity.ownerId, args, now);
    else if (name === "CalculateEstimate") result = await readCalculatedEstimate(env.DB, identity.ownerId, args, now);
    else if (name === "GetEstimationHistory") result = await readEstimationHistory(env.DB, identity.ownerId, args, now);
    else if (name === "ListPlans") result = await listPlans(env.DB, identity.ownerId, now, args);
    else if (name === "GetAnalytics") result = await buildAnalytics(env.DB, identity.ownerId, args, now);
    else if (name === "GetTrackerCapabilities") result = await readTrackerCapabilities(env.DB, identity.ownerId);
    else if (name === "GetPlanExecutionSnapshot") result = await readPlanExecutionSnapshot(env.DB, identity.ownerId, args.planId, now);
    else if (name === "GetTimeline") result = await readTrackerTimeline(env.DB, identity.ownerId, args.planId, args.afterSequence === undefined ? 0 : args.afterSequence, args.limit === undefined ? 50 : args.limit);
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
