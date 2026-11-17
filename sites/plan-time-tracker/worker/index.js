import { UI_FONT_CSS } from "./fonts.js";

const TRACKER_VERSION = "0.6.1";
const BODY_LIMIT = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const isSnapshotDigest = value => typeof value === "string" && value.length === 71 && SNAPSHOT_DIGEST.test(value);
const WRITE_COMMANDS = new Set(["CreatePlan", "StartPlan", "PausePlan", "ResumePlan", "FinishPlan", "UpdatePlanMetadata", "DeletePlan", "RestorePlan"]);
const TRACKER_COMMANDS = new Set(["SetStepStatus", "RecordAssessment"]);
const TRACKER_VERSIONED_COMMANDS = new Set(["SetStepStatus"]);
const TRACKER_READ_TOOLS = new Set(["GetTrackerCapabilities", "GetPlanExecutionSnapshot", "GetCommandReceipt", "GetAssessment", "GetEstimationHistory", "CalculateAtlmEstimate", "GetPlanEstimate", "GetEstimationModelStatus", "GetAtlmDataset", "GetEstimationTrainingHistory"]);
const ENVIRONMENT_IDS = Object.freeze(["local", "cloud_workspace"]);
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

const V4_DONE_BOUNDARIES = ["ANALYSIS","LOCAL_VERIFIED","LOCAL_STAGED","PUBLISHED","DEPLOYED_VERIFIED","UNKNOWN"];
const ESTIMATE_ID = /^[\x20-\x7e]{1,128}$/;
function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}
function isNonnegativeSafeInteger(value) { return Number.isSafeInteger(value) && value>=0; }

const ATLM_METHOD = Object.freeze({ id: "atlm", version: "agent-v4-probabilistic" });
const ATLM_OLS_METHOD = ATLM_METHOD;
const ATLM_RIDGE_METHOD = Object.freeze({ id: "atlm-ridge", version: "1" });
const ATLM_RIDGE_LAMBDA = 1;
const ATLM_MS_PER_MINUTE = 60000;
const ATLM_HYBRID_METHOD = ATLM_METHOD;
const ATLM_POLICY_VERSION = 2;
const ATLM_MIN_COMPARISONS = 5;
const ATLM_MAE_TIE_MS = 1;
const ATLM_FEATURE_VERSION = "agent-task-v3";
const ATLM_MAX_ROWS = 5000;
const ATLM_MAX_EVALUATION_CASES = 20;

function atlmUnavailable(reason, details = {}) { return { status: "UNAVAILABLE", pointMs: null, reason, ...details }; }
function atlmCompareId(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function atlmValidId(value) { return typeof value === "string" && ESTIMATE_ID.test(value) && value.trim().length > 0; }
function atlmExactKeys(value, keys) {
  return isPlainRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function atlmFeatureProblem(features) {
  const problem = v4FeatureProblem(features);
  return problem ? atlmUnavailable(problem) : null;
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
  for (let k = 0; k < Math.min(n, p); k++) {
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

export async function fitAtlmOls(rows) { return fitAtlmV4Regression(rows, "OLS"); }
export function predictAtlmOls(artifact, features) { return artifact?.kind === "OLS" ? predictAtlmV4Regression(artifact, features) : atlmUnavailable("INVALID_ARTIFACT"); }
export async function fitAtlmRidge(rows) { return fitAtlmV4Regression(rows, "RIDGE"); }
export function predictAtlmRidge(artifact, features) { return artifact?.kind === "RIDGE" ? predictAtlmV4Regression(artifact, features) : atlmUnavailable("INVALID_ARTIFACT"); }

function atlmManifestValid(manifest, n) {
  if (!Array.isArray(manifest) || manifest.length !== n) return false;
  const samples = new Set(), plans = new Set();
  for (const item of manifest) {
    if (!atlmExactKeys(item, ["sampleId", "planId"]) || !atlmValidId(item.sampleId) || !atlmValidId(item.planId)
      || samples.has(item.sampleId) || plans.has(item.planId)) return false;
    samples.add(item.sampleId); plans.add(item.planId);
  }
  return true;
}

export async function fitAtlm(rows, options) { return fitHybridAtlm(rows, options); }
export function predictAtlm(artifact, features) { return predictHybridAtlm(artifact, features); }
function atlmArtifactValid(artifact) { return atlmHybridArtifactValid(artifact); }

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
function atlmTrainingRow(row) {
  return { sampleId: row.sampleId, planId: row.planId, capturedAt: row.capturedAt,
    sourceAvailableAt: row.sourceAvailableAt, features: row.features, actualMs: row.actualMs };
}

function atlmHybridJournalProblem(journal) {
  if (!Array.isArray(journal)) return atlmUnavailable("INVALID_DATASET");
  const ids = new Set();
  for (const row of journal) {
    if (!isPlainRecord(row) || !atlmValidId(row.planId) || typeof row.sampleId !== "string"
      || !Number.isSafeInteger(Number(row.sampleId)) || Number(row.sampleId) < 1 || String(Number(row.sampleId)) !== row.sampleId
      || ids.has(row.sampleId) || !["ELIGIBLE", "EXCLUDED"].includes(row.eligibility)
      || !isNonnegativeSafeInteger(row.observedAt) || !isNonnegativeSafeInteger(row.sourceAvailableAt)
      || row.observedAt < row.sourceAvailableAt) return atlmUnavailable("INVALID_DATASET");
    if (row.eligibility === "ELIGIBLE" && (atlmDatasetProblem([atlmTrainingRow(row)]) || atlmFeatureProblem(row.features))) return atlmUnavailable("INVALID_DATASET");
    ids.add(row.sampleId);
  }
  return null;
}

// Choose the last observed version BEFORE applying eligibility. A later exclusion
// must never resurrect an older eligible version; a future version is invisible.
export function selectHybridHistory(journal, cutoff, { inclusive = false, excludePlanId = null } = {}) {
  const latest = new Map(), before = value => inclusive ? value <= cutoff : value < cutoff;
  for (const row of journal) {
    if (!before(row.observedAt)) continue;
    const previous = latest.get(row.planId);
    if (!previous || Number(row.sampleId) > Number(previous.sampleId)) latest.set(row.planId, row);
  }
  return atlmSortedRows([...latest.values()].filter(row => row.planId !== excludePlanId && row.eligibility === "ELIGIBLE"
    && before(row.sourceAvailableAt)).map(atlmTrainingRow));
}

function atlmHybridTargets(rows) {
  return rows.slice().sort((a, b) => a.capturedAt - b.capturedAt || atlmCompareId(a.planId, b.planId)).slice(-ATLM_MAX_EVALUATION_CASES);
}

export function selectHybridEvaluationCases(journal, options = {}) {
  if (!isPlainRecord(options) || Object.keys(options).some(key => !["cutoff", "protocolVersion"].includes(key))
    || (options.protocolVersion !== undefined && options.protocolVersion !== 3)) return atlmUnavailable("INVALID_PROTOCOL");
  const cutoff = options.cutoff ?? Number.MAX_SAFE_INTEGER;
  const problem = atlmHybridJournalProblem(journal);
  if (problem) return problem;
  if (!isNonnegativeSafeInteger(cutoff)) return atlmUnavailable("INVALID_PROTOCOL");
  const rows = selectHybridHistory(journal, cutoff, { inclusive: true });
  if (rows.length > ATLM_MAX_ROWS) return atlmUnavailable("DATASET_LIMIT_REACHED", { sampleCount: rows.length, limit: ATLM_MAX_ROWS });
  return { status: "AVAILABLE", protocolVersion: 3, cutoff, inputCount: rows.length, eligibleCount: rows.length,
    journalVersionCount: journal.length, caseSampleIds: atlmHybridTargets(rows).map(row => row.sampleId), excluded: [] };
}

async function atlmFitCandidates(rows) {
  if (rows.length < 2) return { ols:atlmUnavailable("INSUFFICIENT_DATA",{sampleCount:rows.length}),
    ridge:atlmUnavailable("INSUFFICIENT_DATA",{sampleCount:rows.length}),bayesian:atlmUnavailable("INSUFFICIENT_DATA",{sampleCount:rows.length}) };
  return { ols: await fitAtlmV4Regression(rows, "OLS"), ridge: await fitAtlmV4Regression(rows, "RIDGE"), bayesian: await fitAtlmBayesian(rows) };
}

function atlmFitDiagnostic(fit) {
  const source = fit.artifact || fit;
  return { status: fit.status, reason: fit.reason ?? null,
    sampleCount: source.n ?? source.sampleCount ?? 0,
    ...(source.p === undefined ? {} : { p: source.p }), ...(source.rank === undefined ? {} : { rank: source.rank }) };
}

function atlmStrategyPrediction(base, engine) {
  const order = engine === "OLS" ? ["ols", "ridge"] : engine === "RIDGE" ? ["ridge"] : engine === "BAYESIAN" ? ["bayesian"] : [];
  for (const name of order) if (base[name].status === "AVAILABLE") return { ...base[name],
    hybrid: { policyVersion: ATLM_POLICY_VERSION, selectedEngine: engine, usedEngine: name.toUpperCase(),
      fallbackReason: name.toUpperCase() === engine ? null : base.ols.reason } };
  const failed = order.length ? base[order.at(-1)] : null;
  return { ...(failed || atlmUnavailable("MEDIAN_BASELINE_NOT_WORSE")),
    hybrid: { policyVersion: ATLM_POLICY_VERSION, selectedEngine: engine, usedEngine: null, fallbackReason: failed?.reason ?? null } };
}

export function selectHybridEngine(candidates, cases, { incumbent = null } = {}) {
  if (!isPlainRecord(candidates) || !Array.isArray(cases) || cases.some(c=>!isPlainRecord(c) || !atlmValidId(c.planId))
    || new Set(cases.map(c=>c.planId)).size!==cases.length) return atlmUnavailable("INVALID_EVALUATION");
  for (const item of cases) {
    if (!isNonnegativeSafeInteger(item.capturedAt) || !isNonnegativeSafeInteger(item.actualMs)) return atlmUnavailable("INVALID_EVALUATION");
    for (const name of ["median", "ridge", "bayesian", "ols"]) {
      const forecast = item[name];
      if (!isPlainRecord(forecast) || !["AVAILABLE", "UNAVAILABLE"].includes(forecast.status)
        || (forecast.status === "AVAILABLE" ? !isNonnegativeSafeInteger(forecast.pointMs) : forecast.pointMs !== null)) return atlmUnavailable("INVALID_EVALUATION");
    }
  }
  const engines = ["RIDGE", "BAYESIAN", "OLS"];
  const available = engines.filter(engine => candidates[engine.toLowerCase()]?.status === "AVAILABLE");
  const window = cases.filter(c => c.median?.status === "AVAILABLE" && isNonnegativeSafeInteger(c.actualMs))
    .sort((a,b) => a.capturedAt-b.capturedAt || atlmCompareId(a.planId,b.planId)).slice(-ATLM_MAX_EVALUATION_CASES);
  const ownPredictionCounts = Object.fromEntries(engines.map(engine => [engine.toLowerCase(),window.filter(c=>c[engine.toLowerCase()]?.status==="AVAILABLE").length]));
  const qualified = available.filter(engine => ownPredictionCounts[engine.toLowerCase()] >= ATLM_MIN_COMPARISONS);
  const comparable = qualified.length ? window.filter(c => qualified.every(engine => c[engine.toLowerCase()]?.status === "AVAILABLE")) : [];
  const scores = { median:null, ols:null, ridge:null, bayesian:null }, biases = { median:null, ols:null, ridge:null, bayesian:null };
  if (comparable.length) for (const name of ["median", ...qualified.map(engine=>engine.toLowerCase())]) {
    const errors = comparable.map(c=>c[name].pointMs-c.actualMs);
    scores[name]=atlmSum(errors.map(Math.abs))/errors.length;biases[name]=atlmSum(errors)/errors.length;
  }
  let selectedEngine, reason;
  if (comparable.length >= ATLM_MIN_COMPARISONS) {
    const choices=[...qualified,"MEDIAN"], minimum=Math.min(...choices.map(engine=>scores[engine.toLowerCase()]));
    const tied=choices.filter(engine=>scores[engine.toLowerCase()]<=minimum+ATLM_MAE_TIE_MS);
    const bestBias=Math.min(...tied.map(engine=>Math.abs(biases[engine.toLowerCase()])));
    const biasTied=tied.filter(engine=>Math.abs(Math.abs(biases[engine.toLowerCase()])-bestBias)<=1e-9);
    selectedEngine=biasTied.includes(incumbent)?incumbent:biasTied[0];
    reason=selectedEngine==="MEDIAN"?"MEDIAN_BASELINE_NOT_WORSE":"LOWEST_HISTORICAL_MAE";
  } else {
    selectedEngine=available.includes(incumbent)?incumbent:(available[0]??"MEDIAN");
    reason=selectedEngine==="MEDIAN"?"NO_MODEL_AVAILABLE":"EARLY_EXPERIMENTAL";
  }
  return { policyVersion: ATLM_POLICY_VERSION, selectedEngine, reason, caseCount:comparable.length,
    caseIds:comparable.map(c=>c.planId),ownPredictionCounts,scores,biases,
    qualified:comparable.length>=ATLM_MIN_COMPARISONS && qualified.includes(selectedEngine) };
}

export async function evaluateHybridBaseCase(train, target) {
  const candidates = await atlmFitCandidates(train);
  const prediction = (name, predict) => candidates[name].status === "AVAILABLE"
    ? predict(candidates[name].artifact, target.features) : atlmUnavailable(candidates[name].reason);
  const rawMedian = train.length > ATLM_MAX_ROWS ? null : median(train.map(row => row.actualMs));
  const pointMs = rawMedian === null ? null : Math.round(rawMedian);
  return { ...atlmTrainingRow(target), trainSampleCount: train.length,
    trainDatasetDigest: "sha256:" + await hashCommandInput(atlmSortedRows(train)),
    fits: { ols: atlmFitDiagnostic(candidates.ols), ridge: atlmFitDiagnostic(candidates.ridge), bayesian: atlmFitDiagnostic(candidates.bayesian) },
    ols: prediction("ols", predictAtlmV4Regression), ridge: prediction("ridge", predictAtlmV4Regression), bayesian: prediction("bayesian", predictAtlmBayesian),
    median: pointMs === null ? atlmUnavailable(train.length > ATLM_MAX_ROWS ? "DATASET_LIMIT_REACHED" : "INSUFFICIENT_DATA")
      : { status: "AVAILABLE", pointMs, reason: null } };
}

export function summarizeHybridCase(target, history, baseCases) {
  const base = baseCases[target.sampleId];
  const chronological = history.slice().sort((a,b)=>a.capturedAt-b.capturedAt || atlmCompareId(a.planId,b.planId));
  const allPrior = chronological.map(row => baseCases[row.sampleId]);
  if (!base || allPrior.some(c => !c)) return atlmUnavailable("INCOMPLETE_EVALUATION");
  let incumbent = null;
  for (const candidate of allPrior) {
    const earlier = allPrior.filter(item => item.planId !== candidate.planId && item.sourceAvailableAt < candidate.capturedAt);
    const replay = selectHybridEngine(candidate.fits, earlier, {incumbent});
    if (replay.status === "UNAVAILABLE") return replay;
    if (replay.selectedEngine !== "MEDIAN" && (incumbent === null || replay.qualified)) incumbent = replay.selectedEngine;
  }
  const prior = atlmHybridTargets(history).map(row => baseCases[row.sampleId]);
  const decision = selectHybridEngine(base.fits, prior, {incumbent});
  if (decision.status === "UNAVAILABLE") return decision;
  const atlm = atlmStrategyPrediction(base, decision.selectedEngine);
  return { ...base, decision, atlm, prediction: atlm.status === "AVAILABLE" ? atlm : base.median };
}

export function summarizeHybridAtlmEvaluation(cases, selection) {
  if (selection?.status !== "AVAILABLE") return selection || atlmUnavailable("INVALID_EVALUATION");
  if (!Array.isArray(cases) || cases.length !== selection.caseSampleIds.length || new Set(cases.map(c => c.sampleId)).size !== cases.length
    || cases.some(c => !selection.caseSampleIds.includes(c.sampleId) || !isNonnegativeSafeInteger(c.actualMs)
      || ["atlm", "median", "prediction", "ols", "ridge", "bayesian"].some(name => !c[name] || (c[name].pointMs !== null && !isNonnegativeSafeInteger(c[name].pointMs))))) return atlmUnavailable("INCOMPLETE_EVALUATION");
  const ordered = selection.caseSampleIds.map(id => cases.find(c => c.sampleId === id));
  const comparable = ordered.filter(c => c.median.status === "AVAILABLE");
  const pairedCases = comparable.filter(c => c.atlm.status === "AVAILABLE");
  const metrics = { atlm: atlmScore(ordered, "atlm"), median: atlmScore(comparable, "median"),
    operational: atlmScore(comparable, "prediction"), ols: atlmScore(ordered, "ols"), ridge: atlmScore(ordered, "ridge"), bayesian: atlmScore(ordered, "bayesian") };
  metrics.overall = summarizeAtlmV4Metrics(ordered.map(item=>({planId:item.planId,actualMs:item.actualMs,
    pointMs:item.prediction.status==="AVAILABLE"?item.prediction.pointMs:null,
    interval:item.prediction.interval ?? atlmUnavailableInterval("BAYESIAN_PREDICTIVE","INTERVAL_NOT_EVALUATED")})));
  if(metrics.overall.status==="UNAVAILABLE")return metrics.overall;
  const paired = { caseCount: pairedCases.length, caseSampleIds: pairedCases.map(c => c.sampleId),
    atlm: atlmScore(pairedCases, "atlm"), median: atlmScore(pairedCases, "median") };
  const profileGroupCount = new Set(comparable.map(c => canonical(c.features))).size;
  return { status: "AVAILABLE", formatVersion: 1, protocolVersion: 3, policyVersion: ATLM_POLICY_VERSION,
    method: { ...ATLM_HYBRID_METHOD }, metric: "PLAN_ACTIVE", metricsScope: "FULL_POLICY",
    cutoff: selection.cutoff, inputCount: selection.inputCount, eligibleCount: selection.eligibleCount,
    excluded: selection.excluded, caseCount: ordered.length, cases: ordered, metrics, paired, profileGroupCount,
    candidateReady: paired.caseCount >= ATLM_MIN_COMPARISONS && metrics.operational.maeMs !== null
      && metrics.operational.scoredCount === metrics.median.scoredCount && metrics.operational.maeMs <= metrics.median.maeMs };
}

// The callback returns exactly the observations visible before a case's start.
// Cache entries are keyed by immutable sample revision, not by mutable plan state.
async function atlmReplayPolicyCase(target, historyFor, baseCache, policyCache, checkpoint = async () => {}, beforeWork = async () => {}) {
  if (policyCache[target.sampleId]) return policyCache[target.sampleId];
  const history=await historyFor(target), prior=[];
  for(const row of history){
    const replayed=await atlmReplayPolicyCase(row,historyFor,baseCache,policyCache,checkpoint,beforeWork);
    if(replayed.status==="UNAVAILABLE" && replayed.reason==="INVALID_EVALUATION")return replayed;
    prior.push(replayed);
  }
  let base=baseCache[target.sampleId];
  if(!base){await beforeWork();base=await evaluateHybridBaseCase(history,target);baseCache[target.sampleId]=base;await checkpoint();}
  const chronological=prior.slice().sort((a,b)=>a.sourceAvailableAt-b.sourceAvailableAt || atlmCompareId(a.planId,b.planId));
  let pointIncumbent=null, intervalIncumbent=null;
  for(const item of chronological){
    if(item.decision?.selectedEngine && item.decision.selectedEngine!=="MEDIAN" && (pointIncumbent===null || item.decision.qualified)) pointIncumbent=item.decision.selectedEngine;
    if(item.intervalDecision?.selectedEngine && (intervalIncumbent===null || item.intervalDecision.validationStatus==="HISTORICALLY_EVALUATED")) intervalIncumbent=item.intervalDecision.selectedEngine;
  }
  const priorBases=prior.map(item=>baseCache[item.sampleId]);
  const decision=selectHybridEngine(base.fits,priorBases,{incumbent:pointIncumbent});
  if(decision.status==="UNAVAILABLE")return decision;
  const atlm=atlmStrategyPrediction(base,decision.selectedEngine), point=atlm.status==="AVAILABLE"?atlm:base.median;
  let intervalCandidates,intervalDecision,interval;
  if(point.status==="AVAILABLE"){
    await beforeWork();
    intervalCandidates=await evaluateAtlmIntervalCandidates(base,priorBases,point.pointMs);
    const comparable=prior.filter(item=>item.prediction?.status==="AVAILABLE").map(item=>({planId:item.planId,capturedAt:item.capturedAt,
      actualMs:item.actualMs,pointMs:item.prediction.pointMs,intervals:item.intervalCandidates}));
    intervalDecision=selectAtlmIntervalEngine(intervalCandidates,comparable,{incumbent:intervalIncumbent});
    if(intervalDecision.status==="UNAVAILABLE")return intervalDecision;
    const selected=intervalDecision.selectedEngine;
    interval=selected?{...intervalCandidates[selected],validationStatus:intervalDecision.validationStatus}
      :atlmUnavailableInterval("BAYESIAN_PREDICTIVE",intervalCandidates.BAYESIAN_PREDICTIVE.unavailableReason || "NO_INTERVAL_AVAILABLE");
  }else{
    intervalCandidates={BAYESIAN_PREDICTIVE:atlmUnavailableInterval("BAYESIAN_PREDICTIVE","POINT_UNAVAILABLE"),
      BAYES_QUANTILE:atlmUnavailableInterval("BAYES_QUANTILE","POINT_UNAVAILABLE")};
    intervalDecision={selectedEngine:null,reason:"NO_INTERVAL_AVAILABLE",caseCount:0,caseIds:[],metrics:{},validationStatus:"EXPERIMENTAL"};
    interval=intervalCandidates.BAYESIAN_PREDICTIVE;
  }
  const prediction={...point,pointEngine:point.status==="AVAILABLE"?(atlm.status==="AVAILABLE"?atlm.hybrid.usedEngine:"MEDIAN"):null,interval};
  const result={...base,decision,atlm,prediction,intervalCandidates,intervalDecision};
  policyCache[target.sampleId]=result;
  await checkpoint();
  return result;
}

export async function evaluateHybridAtlmChronologically(journal, options = {}) {
  const selection = selectHybridEvaluationCases(journal, options);
  if (selection.status !== "AVAILABLE") return selection;
  const current = selectHybridHistory(journal, selection.cutoff, { inclusive: true });
  const baseCases = {}, policyCases = {}, cases = [];
  const historyFor = async row => selectHybridHistory(journal,row.capturedAt,{excludePlanId:row.planId});
  for (const id of selection.caseSampleIds) {
    const target = current.find(row => row.sampleId === id);
    const result=await atlmReplayPolicyCase(target,historyFor,baseCases,policyCases);
    if(result.status==="UNAVAILABLE" && result.reason==="INVALID_EVALUATION")return result;
    cases.push(result);
  }
  return summarizeHybridAtlmEvaluation(cases, selection);
}

function atlmSelectionValid(selection) {
  if (!atlmExactKeys(selection, ["policyVersion", "selectedEngine", "reason", "caseCount", "caseIds", "ownPredictionCounts", "scores", "biases", "qualified"])
    || selection.policyVersion !== ATLM_POLICY_VERSION || !["OLS", "RIDGE", "BAYESIAN", "MEDIAN"].includes(selection.selectedEngine)
    || !["EARLY_EXPERIMENTAL", "LOWEST_HISTORICAL_MAE", "MEDIAN_BASELINE_NOT_WORSE", "NO_MODEL_AVAILABLE"].includes(selection.reason)
    || !Number.isInteger(selection.caseCount) || selection.caseCount < 0 || selection.caseCount > ATLM_MAX_EVALUATION_CASES
    || !atlmExactKeys(selection.ownPredictionCounts, ["ols", "ridge", "bayesian"]) || !atlmExactKeys(selection.scores, ["median", "ols", "ridge", "bayesian"])
    || !Object.values(selection.ownPredictionCounts).every(n => Number.isInteger(n) && n >= 0 && n <= ATLM_MAX_EVALUATION_CASES)
    || !Array.isArray(selection.caseIds) || selection.caseIds.length !== selection.caseCount || new Set(selection.caseIds).size !== selection.caseIds.length
    || !selection.caseIds.every(atlmValidId) || !atlmExactKeys(selection.biases, ["median", "ols", "ridge", "bayesian"])
    || !Object.values(selection.scores).every(value => value === null || Number.isFinite(value) && value >= 0)
    || !Object.values(selection.biases).every(value => value === null || Number.isFinite(value))
    || typeof selection.qualified !== "boolean") return false;
  return !selection.qualified || selection.ownPredictionCounts[selection.selectedEngine.toLowerCase()] >= ATLM_MIN_COMPARISONS;
}

function atlmHybridArtifactValid(a) {
  if (!isPlainRecord(a) || a.formatVersion !== 3 || a.kind !== "HYBRID" || a.method?.id !== ATLM_HYBRID_METHOD.id
    || a.method.version !== ATLM_HYBRID_METHOD.version || a.featureSchemaVersion !== ATLM_FEATURE_VERSION || a.metric !== "PLAN_ACTIVE"
    || a.policyVersion !== ATLM_POLICY_VERSION || !["OLS", "RIDGE", "BAYESIAN"].includes(a.selectedEngine)
    || !Number.isSafeInteger(a.n) || a.n < 1 || a.n > ATLM_MAX_ROWS || !atlmManifestValid(a.manifest, a.n)
    || !isSnapshotDigest(a.datasetDigest) || !isNonnegativeSafeInteger(a.trainCutoff)
    || !atlmExactKeys(a.candidates, ["ols", "ridge", "bayesian"]) || !atlmSelectionValid(a.selection)
    || !atlmIntervalSelectionValid(a.intervalSelection) || a.intervalEngine !== a.intervalSelection.selectedEngine
    || ![null,"BAYESIAN_PREDICTIVE","BAYES_QUANTILE"].includes(a.intervalEngine)
    || !["EXPERIMENTAL","HISTORICALLY_EVALUATED"].includes(a.intervalSelection.validationStatus)
    || (a.residualQuantiles !== null && !atlmResidualQuantilesValid(a.residualQuantiles))
    || (a.intervalEngine === "BAYES_QUANTILE" && a.residualQuantiles === null)
    || (a.intervalEngine !== null && a.candidates.bayesian?.status !== "AVAILABLE")
    || a.selection.policyVersion !== ATLM_POLICY_VERSION || a.selection.selectedEngine !== a.selectedEngine) return false;
  for (const [name, validate] of [["ols", atlmV4RegressionArtifactValid], ["ridge", atlmV4RegressionArtifactValid], ["bayesian", atlmBayesArtifactValid]]) {
    const fit = a.candidates[name];
    if (!isPlainRecord(fit) || !["AVAILABLE", "UNAVAILABLE"].includes(fit.status)) return false;
    if (fit.status === "UNAVAILABLE" && (typeof fit.reason !== "string" || !fit.reason || fit.reason.length > 128)) return false;
    if (fit.status === "AVAILABLE" && (fit.artifact?.kind !== name.toUpperCase() || !validate(fit.artifact) || fit.artifact.n !== a.n
      || fit.artifact.datasetDigest !== a.datasetDigest || canonical(fit.artifact.manifest) !== canonical(a.manifest))) return false;
  }
  const planIds = new Set(a.manifest.map(item=>item.planId));
  if (a.intervalSelection.caseIds.some(planId=>!planIds.has(planId))
    || (a.residualQuantiles && a.residualQuantiles.models[0].manifest.some(planId=>!planIds.has(planId)))) return false;
  const selected = a.candidates[a.selectedEngine.toLowerCase()];
  return selected.status === "AVAILABLE" && a.p === selected.artifact.p && a.rank === selected.artifact.rank;
}

function atlmIntervalSelectionValid(selection) {
  if (!atlmExactKeys(selection,["selectedEngine","reason","caseCount","caseIds","metrics","validationStatus"])
    || ![null,"BAYESIAN_PREDICTIVE","BAYES_QUANTILE"].includes(selection.selectedEngine)
    || !Number.isSafeInteger(selection.caseCount) || selection.caseCount<0 || selection.caseCount>ATLM_MAX_EVALUATION_CASES
    || !Array.isArray(selection.caseIds) || selection.caseIds.length!==selection.caseCount
    || new Set(selection.caseIds).size!==selection.caseCount || !selection.caseIds.every(atlmValidId)
    || !isPlainRecord(selection.metrics) || !["EXPERIMENTAL","HISTORICALLY_EVALUATED"].includes(selection.validationStatus)) return false;
  if(selection.validationStatus==="EXPERIMENTAL") return selection.caseCount<ATLM_MIN_COMPARISONS
    && (selection.selectedEngine===null ? selection.reason==="NO_INTERVAL_AVAILABLE" : selection.reason==="EARLY_EXPERIMENTAL");
  const chosen=selection.metrics[selection.selectedEngine];
  return selection.caseCount>=ATLM_MIN_COMPARISONS && selection.selectedEngine!==null && selection.reason==="LOWEST_INTERVAL_SCORE"
    && isPlainRecord(chosen) && chosen.intervalCaseCount===selection.caseCount && chosen.coverageDenominator===selection.caseCount
    && canonical(chosen.intervalCaseIds)===canonical(selection.caseIds)
    && Number.isFinite(chosen.meanIntervalScore) && chosen.meanIntervalScore>=0 && Number.isFinite(chosen.meanIntervalWidthMs) && chosen.meanIntervalWidthMs>=0
    && Number.isFinite(chosen.intervalCoverage) && chosen.intervalCoverage>=0 && chosen.intervalCoverage<=1;
}

const ATLM_INTERNAL_REPLAY = Symbol("validated training replay");
async function atlmReconstructResidual(target, history) {
  if (!Array.isArray(history) || history.length < 2 || atlmDatasetProblem(history)
    || history.some(row=>row.planId===target.planId || row.sourceAvailableAt>=target.capturedAt)) return null;
  const fit=await fitAtlmBayesian(history);
  if (fit.status!=="AVAILABLE") return null;
  const prediction=predictAtlmBayesian(fit.artifact,target.features);
  if (prediction.status!=="AVAILABLE" || !(prediction.predictive.scale>0)) return null;
  return {planId:target.planId,features:target.features,residual:(Math.log1p(target.actualMs/ATLM_MS_PER_MINUTE)-prediction.predictive.location)/prediction.predictive.scale};
}

export async function fitHybridAtlm(rows, { selection = null, candidates = null, cutoff = null, residualQuantiles = null, intervalSelection = null, calibrationHistory = null, calibrationProof = null, replayAuthority = null } = {}) {
  const problem = atlmDatasetProblem(rows);
  if (problem) return problem;
  const sorted = atlmSortedRows(rows);
  if (cutoff !== null && (!isNonnegativeSafeInteger(cutoff) || sorted.some(row=>row.sourceAvailableAt>cutoff))) return atlmUnavailable("INVALID_DATASET");
  if (sorted.length < 2) return atlmUnavailable("INSUFFICIENT_DATA", { sampleCount: sorted.length });
  candidates ||= await atlmFitCandidates(sorted);
  selection ||= selectHybridEngine(candidates, []);
  if (!atlmSelectionValid(selection)) return atlmUnavailable("INVALID_PROTOCOL");
  const diagnostics = { ols: atlmFitDiagnostic(candidates.ols), ridge: atlmFitDiagnostic(candidates.ridge), bayesian: atlmFitDiagnostic(candidates.bayesian) };
  if (selection.selectedEngine === "MEDIAN") {
    const reason = [candidates.ridge, candidates.bayesian, candidates.ols].some(candidate => candidate.status === "AVAILABLE") ? "MEDIAN_BASELINE_NOT_WORSE"
      : candidates.ridge.reason || candidates.bayesian.reason || candidates.ols.reason;
    return atlmUnavailable(reason, { sampleCount: rows.length, candidates: diagnostics, selection });
  }
  const chosen = candidates[selection.selectedEngine.toLowerCase()];
  if (chosen.status !== "AVAILABLE") return atlmUnavailable(chosen.reason, { candidates: diagnostics, selection });
  if (residualQuantiles !== null && !atlmResidualQuantilesValid(residualQuantiles)) return atlmUnavailable("INVALID_ARTIFACT");
  const trainingPlans = new Set(sorted.map(row=>row.planId));
  if (residualQuantiles !== null && residualQuantiles.models[0].manifest.some(planId=>!trainingPlans.has(planId))) return atlmUnavailable("INVALID_ARTIFACT");
  if (residualQuantiles !== null) {
    if (typeof calibrationHistory !== "function") return atlmUnavailable("INVALID_ARTIFACT");
    const reconstructed = [];
    for (const planId of residualQuantiles.models[0].manifest) {
      const target=sorted.find(row=>row.planId===planId);
      const residual = replayAuthority===ATLM_INTERNAL_REPLAY ? calibrationProof?.[planId]
        : await atlmReconstructResidual(target,await calibrationHistory(target));
      if (!residual || residual.planId!==planId || canonical(residual.features)!==canonical(target.features) || !Number.isFinite(residual.residual)) return atlmUnavailable("INVALID_ARTIFACT");
      reconstructed.push(residual);
    }
    reconstructed.sort((a,b)=>atlmCompareId(a.planId,b.planId));
    if ("sha256:"+await hashCommandInput(reconstructed)!==residualQuantiles.models[0].datasetDigest) return atlmUnavailable("INVALID_ARTIFACT");
  }
  intervalSelection ||= selectAtlmIntervalEngine({
    BAYESIAN_PREDICTIVE:candidates.bayesian,
    BAYES_QUANTILE:residualQuantiles?{status:"AVAILABLE"}:{status:"UNAVAILABLE"},
  }, []);
  if ((intervalSelection.validationStatus === "HISTORICALLY_EVALUATED" && replayAuthority !== ATLM_INTERNAL_REPLAY)
    || !atlmIntervalSelectionValid(intervalSelection) || intervalSelection.caseIds.some(planId=>!trainingPlans.has(planId))) return atlmUnavailable("INVALID_PROTOCOL");
  const artifact = atlmFreeze({ formatVersion: 3, kind: "HYBRID", method: { ...ATLM_HYBRID_METHOD },
    featureSchemaVersion: ATLM_FEATURE_VERSION, metric: "PLAN_ACTIVE", policyVersion: ATLM_POLICY_VERSION,
    selectedEngine: selection.selectedEngine, selection, n: sorted.length, p: chosen.artifact.p, rank: chosen.artifact.rank,
    manifest: sorted.map(({ sampleId, planId }) => ({ sampleId, planId })), datasetDigest: "sha256:" + await hashCommandInput(sorted),
    trainCutoff: cutoff ?? Math.max(0, ...sorted.map(row => row.sourceAvailableAt)), candidates,
    intervalEngine:intervalSelection.selectedEngine,intervalSelection,residualQuantiles });
  return atlmHybridArtifactValid(artifact) ? { status: "AVAILABLE", artifact, candidates: diagnostics, selection }
    : atlmUnavailable("INVALID_ARTIFACT");
}

export function predictHybridAtlm(artifact, features) {
  if (!atlmHybridArtifactValid(artifact)) return atlmUnavailable("INVALID_ARTIFACT");
  const problem = atlmFeatureProblem(features);
  if (problem) return problem;
  const base = {};
  for (const [name, predict] of [["ols", predictAtlmV4Regression], ["ridge", predictAtlmV4Regression], ["bayesian", predictAtlmBayesian]]) {
    const fit = artifact.candidates[name];
    base[name] = fit.status === "AVAILABLE" ? predict(fit.artifact, features) : atlmUnavailable(fit.reason);
  }
  const point=atlmStrategyPrediction(base, artifact.selectedEngine);
  if (point.status!=="AVAILABLE") return point;
  const validationStatus=artifact.intervalSelection.validationStatus;
  let interval;
  if (artifact.intervalEngine==="BAYES_QUANTILE") interval=predictAtlmResidualInterval(artifact.residualQuantiles,features,base.bayesian,point.pointMs,validationStatus);
  else if (artifact.intervalEngine==="BAYESIAN_PREDICTIVE" && base.bayesian?.status==="AVAILABLE" && base.bayesian.interval?.status==="AVAILABLE")
    interval={status:"AVAILABLE",lowerMs:Math.min(point.pointMs,base.bayesian.interval.lowerMs),upperMs:Math.max(point.pointMs,base.bayesian.interval.upperMs),
      nominalCoverage:ATLM_BAYES_NOMINAL_COVERAGE,engine:"BAYESIAN_PREDICTIVE",calibrationSampleCount:0,validationStatus,unavailableReason:null};
  else interval=atlmUnavailableInterval(artifact.intervalEngine??"BAYESIAN_PREDICTIVE",base.bayesian?.interval?.unavailableReason || base.bayesian?.reason || "BAYESIAN_UNAVAILABLE");
  return {...point,pointEngine:point.hybrid.usedEngine,interval};
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
async function bodyJson(request, acceptsLargeBody = null) {
  const length = Number(request.headers.get("content-length") || 0);
  if (!acceptsLargeBody && length > BODY_LIMIT) throw appError("VALIDATION_ERROR", "Размер запроса превышает лимит.", 413);
  const text = await request.text();
  const oversized = length > BODY_LIMIT || new TextEncoder().encode(text).length > BODY_LIMIT;
  if (!acceptsLargeBody && oversized) throw appError("VALIDATION_ERROR", "Размер запроса превышает лимит.", 413);
  let body;
  try { body = JSON.parse(text); } catch { throw appError("VALIDATION_ERROR", "Тело запроса должно быть JSON."); }
  if (oversized && !acceptsLargeBody(body)) throw appError("VALIDATION_ERROR", "Размер запроса превышает лимит.", 413);
  return body;
}
function isPlanDocumentCreation(envelope) {
  return envelope?.commandType === "CreatePlan" && typeof envelope.payload?.planText === "string";
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
    ATLM_MODEL_CHANGED: "Модель или исходная история изменились во время расчёта. Получите свежую оценку новой командой.",
    DATASET_CHANGED: "Набор обучающих данных изменился. Начните выгрузку заново.",
    ASSESSMENT_SOURCE_NOT_FOUND: "Исторический источник оценки недоступен.",
    ASSESSMENT_SCHEMA_RETIRED: "Исходная оценка удалена при переходе на новую схему ATLM; повтор команды не создаёт оценку.",
    ATLM_CLIENT_RETIRED: "Клиент использует прежний формат прогноза. Обновите приложение и повторите запуск плана.",
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
    throw appError(code, typeof snapshot.message === "string" ? snapshot.message : row.command_type==="StartPlan"&&code==="ASSESSMENT_CONTEXT_CHANGED"
      ? "Во время запуска изменились требования, исходные признаки или данные прогноза. Таймер не запущен. Повторите StartPlan новой командой." : messageFor(code), status, snapshot);
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
  if(message.includes("ATLM_CLIENT_RETIRED"))return appError("ATLM_CLIENT_RETIRED",messageFor("ATLM_CLIENT_RETIRED"),409);
  if(message.includes("ASSESSMENT_SCHEMA_RETIRED"))return appError("ASSESSMENT_SCHEMA_RETIRED",messageFor("ASSESSMENT_SCHEMA_RETIRED"),409);
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



const V4_TASK_TEXT = { type: "string", minLength: 1, maxLength: 400 };
const V4_TASK_KEY = { type: "string", minLength: 1, maxLength: 128 };
const V4_TASK_ITEM = (properties) => ({ type: "object", additionalProperties: false,
  required: Object.keys(properties), properties });
const V4_TASK_MAX_BYTES = 64 * 1024;
const V4_TASK_LIST = (items) => ({ type: ["array", "null"], maxItems: V4_TASK_MAX_BYTES, items });
const V4_WORK_KINDS = ["CREATE", "MODIFY", "DEBUG", "REFACTOR", "MIGRATE", "VERIFY", "ANALYZE", "OPERATE"];
const V4_VERIFICATION_KINDS = ["BUILD_STATIC", "UNIT", "INTEGRATION", "UI_E2E", "DEPLOY_SMOKE"];
const V4_TASK_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "workUnits", "doneBoundary", "reuseLevel", "components", "contracts", "integrations", "migrationEntities", "dataVolumeBand", "requirementsUncertainty", "solutionUncertainty", "diagnosisState", "unfamiliarTechnologies", "scopeChangeRisk", "verificationKinds", "verificationScenarios", "verificationReadiness", "requiredReviewPasses", "environmentReadiness", "accessReadiness", "deploymentTargets", "execution", "evidence", "unknownReasons"],
  properties: {
    schemaVersion: { enum: ["agent-task-v3"] },
    workUnits: V4_TASK_LIST(V4_TASK_ITEM({ id: V4_TASK_KEY, kind: { enum: V4_WORK_KINDS }, description: V4_TASK_TEXT, evidence: V4_TASK_TEXT })),
    doneBoundary: { enum: [...V4_DONE_BOUNDARIES] },
    reuseLevel: { type: ["integer", "null"], minimum: 0, maximum: 3 },
    components: V4_TASK_LIST(V4_TASK_ITEM({ key: V4_TASK_KEY, change: { enum: ["CREATE", "MODIFY", "REMOVE"] }, evidence: V4_TASK_TEXT })),
    contracts: V4_TASK_LIST(V4_TASK_ITEM({ kind: { enum: ["API", "MCP", "EVENT", "STORAGE", "UI", "CONFIG"] }, key: V4_TASK_KEY, change: { enum: ["ADD", "COMPATIBLE", "BREAKING", "REMOVE"] }, evidence: V4_TASK_TEXT })),
    integrations: V4_TASK_LIST(V4_TASK_ITEM({ key: V4_TASK_KEY, change: { enum: ["USE", "CHANGE", "ADD"] }, evidence: V4_TASK_TEXT })),
    migrationEntities: V4_TASK_LIST(V4_TASK_ITEM({ key: V4_TASK_KEY, evidence: V4_TASK_TEXT })),
    dataVolumeBand: { enum: ["NONE", "LE_1K", "LE_100K", "LE_10M", "GT_10M", "UNKNOWN"] },
    requirementsUncertainty: { type: ["integer", "null"], minimum: 0, maximum: 3 },
    solutionUncertainty: { type: ["integer", "null"], minimum: 0, maximum: 3 },
    diagnosisState: { enum: ["NOT_APPLICABLE", "PROVEN", "HYPOTHESIS", "UNKNOWN"] },
    unfamiliarTechnologies: V4_TASK_LIST(V4_TASK_ITEM({ key: V4_TASK_KEY, evidence: V4_TASK_TEXT })),
    scopeChangeRisk: { type: ["integer", "null"], minimum: 0, maximum: 3 },
    verificationKinds: V4_TASK_LIST({ enum: V4_VERIFICATION_KINDS }),
    verificationScenarios: V4_TASK_LIST(V4_TASK_ITEM({ id: V4_TASK_KEY, description: V4_TASK_TEXT, evidence: V4_TASK_TEXT })),
    verificationReadiness: { enum: ["READY", "ADAPT", "CREATE", "NONE_REQUIRED", "UNKNOWN"] },
    requiredReviewPasses: { type: ["integer", "null"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    environmentReadiness: { enum: ["READY", "SETUP_KNOWN", "BLOCKED", "UNKNOWN"] },
    accessReadiness: { enum: ["AVAILABLE", "MISSING", "UNKNOWN"] },
    deploymentTargets: V4_TASK_LIST(V4_TASK_ITEM({ key: V4_TASK_KEY, evidence: V4_TASK_TEXT })),
    execution: V4_TASK_ITEM({ mode: { enum: ["AI_AGENT", "HUMAN", "HYBRID", "UNKNOWN"] },
      modelId: { type: ["string", "null"], minLength: 1, maxLength: 128 }, reasoningEffort: { type: ["string", "null"], minLength: 1, maxLength: 128 },
      environmentId: { enum: ["local", "cloud_workspace", null] }, plannedParallelAgents: { type: ["integer", "null"], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      codebaseFamiliarity: { enum: ["NOT_READ", "MAPPED", "PRIOR_VERIFIED_WORK", "UNKNOWN"] } }),
    evidence: { type: "object" }, unknownReasons: { type: "object" },
  },
};

export function normalizeAgentTask(input) {
  if (new TextEncoder().encode(JSON.stringify(input)).length > V4_TASK_MAX_BYTES) throw appError("VALIDATION_ERROR", "agentTask exceeds 64 KiB UTF-8.");
  validateAssessmentValue(input, V4_TASK_SCHEMA, "agentTask");
  const task = JSON.parse(JSON.stringify(input));
  const scalarPaths = ["doneBoundary", "reuseLevel", "dataVolumeBand", "requirementsUncertainty", "solutionUncertainty", "diagnosisState", "scopeChangeRisk", "verificationReadiness", "requiredReviewPasses", "environmentReadiness", "accessReadiness", ...Object.keys(task.execution).map(key => "execution." + key)];
  const listPaths = ["workUnits", "components", "contracts", "integrations", "migrationEntities", "unfamiliarTechnologies", "verificationKinds", "verificationScenarios", "deploymentTargets"];
  const read = path => path.split(".").reduce((value, key) => value[key], task);
  for (const path of [...scalarPaths, ...listPaths]) {
    const value = read(path), openString = ["execution.modelId", "execution.reasoningEffort"].includes(path);
    const unknown = value === null || (!openString && value === "UNKNOWN");
    const text = unknown ? task.unknownReasons[path] : scalarPaths.includes(path) ? task.evidence[path] : null;
    if ((unknown || scalarPaths.includes(path)) && (typeof text !== "string" || !text.trim() || Array.from(text).length > 400)) throw appError("VALIDATION_ERROR", "Missing evidence or unknown reason: " + path);
  }
  for (const field of listPaths.filter(key => key !== "verificationKinds")) {
    if (task[field] === null) continue;
    const unique = new Map();
    for (const item of task[field]) {
      const key = item.id ?? (item.kind ? item.kind + ":" + item.key : item.key), previous = unique.get(key);
      if (previous && canonical(previous) !== canonical(item)) throw appError("VALIDATION_ERROR", "Conflicting duplicate agentTask key: " + key);
      unique.set(key, item);
    }
    task[field] = [...unique.entries()].sort(([a], [b]) => atlmCompareId(a, b)).map(([, item]) => item);
  }
  if (task.verificationKinds !== null) task.verificationKinds = V4_VERIFICATION_KINDS.filter(kind => task.verificationKinds.includes(kind));
  if (task.workUnits !== null && !task.workUnits.length) throw appError("VALIDATION_ERROR", "workUnits must be nonempty or unknown.");
  if (task.workUnits !== null && (task.workUnits.some(unit => unit.kind === "DEBUG") === (task.diagnosisState === "NOT_APPLICABLE"))) throw appError("VALIDATION_ERROR", "diagnosisState does not match workUnits.");
  if (task.dataVolumeBand === "NONE" && task.migrationEntities?.length) throw appError("VALIDATION_ERROR", "Migration cannot have zero affected data.");
  if (task.verificationKinds?.includes("DEPLOY_SMOKE") && !task.deploymentTargets?.length) throw appError("VALIDATION_ERROR", "DEPLOY_SMOKE requires a deployment target.");
  const missingFields = [];
  if (task.workUnits === null) missingFields.push("workUnits");
  if (task.doneBoundary === "UNKNOWN") missingFields.push("doneBoundary");
  const count = (items, predicate = () => true) => items === null ? null : items.filter(predicate).length;
  const features = {
    ...Object.fromEntries(V4_WORK_KINDS.map(kind => ["workUnits." + kind, count(task.workUnits, item => item.kind === kind)])),
    doneBoundary: task.doneBoundary, reuseLevel: task.reuseLevel,
    ...Object.fromEntries(["CREATE", "MODIFY", "REMOVE"].map(change => ["components." + change, count(task.components, item => item.change === change)])),
    ...Object.fromEntries(["API", "MCP", "EVENT", "STORAGE", "UI", "CONFIG"].map(kind => ["contracts." + kind, count(task.contracts, item => item.kind === kind)])),
    ...Object.fromEntries(["BREAKING", "REMOVE"].map(change => ["contracts." + change, count(task.contracts, item => item.change === change)])),
    ...Object.fromEntries(["USE", "CHANGE", "ADD"].map(change => ["integrations." + change, count(task.integrations, item => item.change === change)])),
    migrationEntities: count(task.migrationEntities), dataVolumeBand: task.dataVolumeBand,
    requirementsUncertainty: task.requirementsUncertainty, solutionUncertainty: task.solutionUncertainty,
    diagnosisState: task.diagnosisState, unfamiliarTechnologies: count(task.unfamiliarTechnologies), scopeChangeRisk: task.scopeChangeRisk,
    ...Object.fromEntries(V4_VERIFICATION_KINDS.map(kind => ["verificationKinds." + kind, task.verificationKinds === null ? null : Number(task.verificationKinds.includes(kind))])),
    verificationScenarios: count(task.verificationScenarios), verificationReadiness: task.verificationReadiness,
    requiredReviewPasses: task.requiredReviewPasses, environmentReadiness: task.environmentReadiness,
    accessReadiness: task.accessReadiness, deploymentTargets: count(task.deploymentTargets), ...task.execution,
  };
  return { agentTask: task, features, missingFields };
}

// The preprocessing manifest belongs to a training prefix, never to the full
// history. Keep all candidate columns in the manifest, including constants.
const V4_ORDINAL_FIELDS = ["reuseLevel", "requirementsUncertainty", "solutionUncertainty", "scopeChangeRisk"];
const V4_CATEGORY_FIELDS = {
  doneBoundary: [...V4_DONE_BOUNDARIES],
  dataVolumeBand: ["NONE", "LE_1K", "LE_100K", "LE_10M", "GT_10M", "UNKNOWN"],
  diagnosisState: ["NOT_APPLICABLE", "PROVEN", "HYPOTHESIS", "UNKNOWN"],
  verificationReadiness: ["READY", "ADAPT", "CREATE", "NONE_REQUIRED", "UNKNOWN"],
  environmentReadiness: ["READY", "SETUP_KNOWN", "BLOCKED", "UNKNOWN"],
  accessReadiness: ["AVAILABLE", "MISSING", "UNKNOWN"],
  mode: ["AI_AGENT", "HUMAN", "HYBRID", "UNKNOWN"],
  environmentId: ["local", "cloud_workspace", "UNKNOWN"],
  codebaseFamiliarity: ["NOT_READ", "MAPPED", "PRIOR_VERIFIED_WORK", "UNKNOWN"],
};
const V4_OPEN_CATEGORY_FIELDS = ["modelId", "reasoningEffort"];
const V4_COUNT_FIELDS = [
  ...V4_WORK_KINDS.map(kind => "workUnits." + kind),
  ...["CREATE", "MODIFY", "REMOVE"].map(change => "components." + change),
  ...["API", "MCP", "EVENT", "STORAGE", "UI", "CONFIG", "BREAKING", "REMOVE"].map(kind => "contracts." + kind),
  ...["USE", "CHANGE", "ADD"].map(change => "integrations." + change),
  "migrationEntities", "unfamiliarTechnologies", "verificationScenarios", "requiredReviewPasses", "deploymentTargets", "plannedParallelAgents",
];
const V4_FLAG_FIELDS = V4_VERIFICATION_KINDS.map(kind => "verificationKinds." + kind);
const V4_FEATURE_FIELDS = [...V4_ORDINAL_FIELDS, ...Object.keys(V4_CATEGORY_FIELDS), ...V4_OPEN_CATEGORY_FIELDS, ...V4_COUNT_FIELDS, ...V4_FLAG_FIELDS].sort(atlmCompareId);
const V4_MIN_CATEGORY_SAMPLES = 3;
const V4_MODEL_COLUMN_LIMIT = 512;
const ATLM_FIT_WORK_LIMIT = 5000000;

function v4FeatureProblem(features) {
  if (!isPlainRecord(features) || canonical(Object.keys(features).sort(atlmCompareId)) !== canonical(V4_FEATURE_FIELDS)) return "INVALID_FEATURES";
  for (const field of V4_COUNT_FIELDS) if (features[field] !== null && !isNonnegativeSafeInteger(features[field])) return "INVALID_FEATURES";
  if (features.plannedParallelAgents === 0) return "INVALID_FEATURES";
  for (const field of V4_ORDINAL_FIELDS) if (features[field] !== null && (!isNonnegativeSafeInteger(features[field]) || features[field] > 3)) return "INVALID_FEATURES";
  for (const field of V4_FLAG_FIELDS) if (![null, 0, 1].includes(features[field])) return "INVALID_FEATURES";
  for (const field of Object.keys(V4_CATEGORY_FIELDS)) {
    if (field === "environmentId") {
      if (![null, "local", "cloud_workspace"].includes(features[field])) return "INVALID_FEATURES";
      continue;
    }
    if (!V4_CATEGORY_FIELDS[field].includes(features[field])) return "INVALID_FEATURES";
  }
  for (const field of V4_OPEN_CATEGORY_FIELDS) if (features[field] !== null
    && (typeof features[field] !== "string" || !features[field].trim() || Array.from(features[field]).length > 128)) return "INVALID_FEATURES";
  const workCounts = V4_WORK_KINDS.map(kind => features["workUnits." + kind]);
  if (features.doneBoundary === "UNKNOWN" || workCounts.every(value => value === null)) return "MISSING_REQUIRED_FEATURES";
  if (workCounts.some(value => value === null) || workCounts.every(value => value === 0)) return "INVALID_FEATURES";
  return null;
}

function v4Median(values) {
  if (!values.length) return 0;
  const ordered = values.slice().sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function v4Category(value, field, manifest) {
  if (V4_OPEN_CATEGORY_FIELDS.includes(field)) {
    if (value === null || value === undefined) return "UNKNOWN";
    return manifest.openCategories[field].includes(value) ? "VALUE:" + value : "OTHER";
  }
  return value === null || value === undefined ? "UNKNOWN" : value;
}

function v4RawColumn(features, column, manifest) {
  const value = features[column.field];
  if (column.kind === "category") return Number(v4Category(value, column.field, manifest) === column.level);
  if (column.kind === "missing") return Number(value === null || value === undefined);
  if (value === null || value === undefined) return manifest.imputations[column.field];
  return column.kind === "count" ? Math.log1p(value) : value;
}

export function fitAtlmV4Preprocessor(featureRows) {
  if (!Array.isArray(featureRows) || !featureRows.length) return atlmUnavailable("INSUFFICIENT_DATA");
  if (featureRows.length > ATLM_MAX_ROWS || featureRows.some(row => !isPlainRecord(row))) return atlmUnavailable("INVALID_DATASET");
  for (const features of featureRows) { const problem = v4FeatureProblem(features); if (problem) return atlmUnavailable(problem); }
  const fields = Object.keys(featureRows[0]).sort(atlmCompareId);
  if (featureRows.some(row => canonical(Object.keys(row).sort(atlmCompareId)) !== canonical(fields))) return atlmUnavailable("INVALID_FEATURES");
  const manifest = { formatVersion: 1, fields, openCategories: {}, imputations: {}, columns: [], droppedColumns: [] };
  const candidates = [];
  for (const field of fields) {
    if (Object.hasOwn(V4_CATEGORY_FIELDS, field) || V4_OPEN_CATEGORY_FIELDS.includes(field)) {
      let levels = V4_CATEGORY_FIELDS[field];
      if (!levels) {
        const counts = new Map();
        for (const row of featureRows) if (row[field] !== null && row[field] !== undefined) counts.set(row[field], (counts.get(row[field]) || 0) + 1);
        manifest.openCategories[field] = [...counts.entries()].filter(([, n]) => n >= V4_MIN_CATEGORY_SAMPLES).map(([value]) => value).sort(atlmCompareId);
        levels = ["OTHER", "UNKNOWN", ...manifest.openCategories[field].map(value => "VALUE:" + value)];
      }
      for (const level of levels.slice(1)) candidates.push({ kind: "category", field, level });
      continue;
    }
    const isFlag = field.startsWith("verificationKinds."), isOrdinal = V4_ORDINAL_FIELDS.includes(field);
    const kind = isFlag || isOrdinal ? "ordinal" : "count";
    const known = featureRows.map(row => row[field]).filter(value => value !== null && value !== undefined);
    if (known.some(value => !Number.isFinite(value) || value < 0)) return atlmUnavailable("INVALID_FEATURES");
    manifest.imputations[field] = v4Median(known.map(value => kind === "count" ? Math.log1p(value) : value));
    candidates.push({ kind, field }, { kind: "missing", field });
  }
  if (candidates.length > V4_MODEL_COLUMN_LIMIT) return atlmUnavailable("MODEL_CAPACITY_LIMIT", { p: candidates.length, limit: V4_MODEL_COLUMN_LIMIT });
  for (const candidate of candidates) {
    const values = featureRows.map(row => v4RawColumn(row, candidate, manifest));
    if (values.some(value => !Number.isFinite(value))) return atlmUnavailable("INVALID_FEATURES");
    if (values.every(value => value === values[0])) { manifest.droppedColumns.push(candidate); continue; }
    // Store the origin separately: subtracting a rounded large mean from
    // nearby log values can otherwise destroy centering and conditioning.
    const origin = values[0], offsets = values.map(value => value - origin);
    const center = atlmSum(offsets) / values.length;
    const scale = Math.sqrt(atlmSum(offsets.map(value => (value - center) ** 2)) / values.length);
    manifest.columns.push({ ...candidate, origin, center, scale });
  }
  return { status: "AVAILABLE", manifest };
}

export function encodeAtlmV4Features(features, manifest) {
  if (!isPlainRecord(manifest) || manifest.formatVersion !== 1 || !Array.isArray(manifest.fields)
    || !manifest.fields.every(field => typeof field === "string") || !isPlainRecord(manifest.openCategories)
    || !isPlainRecord(manifest.imputations) || !Array.isArray(manifest.columns) || !Array.isArray(manifest.droppedColumns)
    || manifest.columns.length + manifest.droppedColumns.length > V4_MODEL_COLUMN_LIMIT) return atlmUnavailable("INVALID_ARTIFACT");
  if (canonical(manifest.fields) !== canonical(V4_FEATURE_FIELDS)) return atlmUnavailable("INVALID_ARTIFACT");
  if (!atlmExactKeys(manifest.openCategories, V4_OPEN_CATEGORY_FIELDS)
    || !atlmExactKeys(manifest.imputations, [...V4_COUNT_FIELDS, ...V4_ORDINAL_FIELDS, ...V4_FLAG_FIELDS])) return atlmUnavailable("INVALID_ARTIFACT");
  for (const field of V4_OPEN_CATEGORY_FIELDS.filter(field => manifest.fields.includes(field))) {
    const levels = manifest.openCategories[field];
    if (!Array.isArray(levels) || levels.some(value => typeof value !== "string" || !value.trim() || Array.from(value).length > 128)
      || new Set(levels).size !== levels.length || canonical(levels) !== canonical(levels.slice().sort(atlmCompareId))) return atlmUnavailable("INVALID_ARTIFACT");
  }
  const expectedColumns = [];
  for (const field of V4_FEATURE_FIELDS) {
    if (Object.hasOwn(V4_CATEGORY_FIELDS, field) || V4_OPEN_CATEGORY_FIELDS.includes(field)) {
      const levels = V4_CATEGORY_FIELDS[field] || ["OTHER", "UNKNOWN", ...manifest.openCategories[field].map(value => "VALUE:" + value)];
      for (const level of levels.slice(1)) expectedColumns.push(canonical({ kind: "category", field, level }));
    } else {
      const kind = V4_FLAG_FIELDS.includes(field) || V4_ORDINAL_FIELDS.includes(field) ? "ordinal" : "count";
      const imputed = manifest.imputations[field];
      const upper = V4_FLAG_FIELDS.includes(field) ? 1 : V4_ORDINAL_FIELDS.includes(field) ? 3 : Math.log1p(Number.MAX_SAFE_INTEGER);
      if (!Number.isFinite(imputed) || imputed < 0 || imputed > upper) return atlmUnavailable("INVALID_ARTIFACT");
      expectedColumns.push(canonical({ kind, field }), canonical({ kind: "missing", field }));
    }
  }
  const actualColumns = [...manifest.columns, ...manifest.droppedColumns].map(column => {
    if (!isPlainRecord(column)) return "invalid";
    return canonical(column.kind === "category" ? { kind: column.kind, field: column.field, level: column.level } : { kind: column.kind, field: column.field });
  });
  const canonicalIndex = new Map(expectedColumns.map((column, index) => [column, index]));
  const inOrder = columns => columns.every((column, index) => index === 0 || canonicalIndex.get(columns[index - 1]) < canonicalIndex.get(column));
  if (canonical(actualColumns.slice().sort()) !== canonical(expectedColumns.slice().sort())
    || !inOrder(actualColumns.slice(0, manifest.columns.length)) || !inOrder(actualColumns.slice(manifest.columns.length))) return atlmUnavailable("INVALID_ARTIFACT");
  for (const column of manifest.columns) {
    if (!isPlainRecord(column) || !manifest.fields.includes(column.field)
      || !["category", "missing", "ordinal", "count"].includes(column.kind)
      || !Number.isFinite(column.origin) || !Number.isFinite(column.center) || !Number.isFinite(column.scale) || column.scale <= 0
      || (column.kind === "category" && (typeof column.level !== "string"
        || (!Object.hasOwn(V4_CATEGORY_FIELDS, column.field) && !V4_OPEN_CATEGORY_FIELDS.includes(column.field))))
      || (["count", "ordinal"].includes(column.kind) && !Number.isFinite(manifest.imputations[column.field]))) return atlmUnavailable("INVALID_ARTIFACT");
    const binary = ["category", "missing"].includes(column.kind) || V4_FLAG_FIELDS.includes(column.field), mean = column.origin + column.center;
    if (binary && (!(mean > 0 && mean < 1) || ![0, 1].includes(column.origin)
      || Math.abs(column.scale - Math.sqrt(mean * (1 - mean))) > 1e-10)) return atlmUnavailable("INVALID_ARTIFACT");
    if (!binary && (column.origin < 0 || mean < 0 || (column.kind === "ordinal" && (mean > 3 || column.origin > 3))
      || (column.kind === "count" && (mean > Math.log1p(Number.MAX_SAFE_INTEGER) || column.origin > Math.log1p(Number.MAX_SAFE_INTEGER))))) return atlmUnavailable("INVALID_ARTIFACT");
  }
  const problem = v4FeatureProblem(features);
  if (problem) return atlmUnavailable(problem);
  const row = [1, ...manifest.columns.map(column => ((v4RawColumn(features, column, manifest) - column.origin) - column.center) / column.scale)];
  return row.every(Number.isFinite) ? { status: "AVAILABLE", row } : atlmUnavailable("INVALID_FEATURES");
}

export async function fitAtlmV4Regression(rows, engine) {
  if (!Array.isArray(rows) || !["OLS", "RIDGE"].includes(engine)) return atlmUnavailable("INVALID_DATASET");
  if (rows.length > ATLM_MAX_ROWS) return atlmUnavailable("DATASET_LIMIT_REACHED", { sampleCount: rows.length, limit: ATLM_MAX_ROWS });
  if (!rows.length) return atlmUnavailable("INSUFFICIENT_DATA");
  const ids = new Set(), plans = new Set();
  for (const row of rows) {
    if (!isPlainRecord(row) || !atlmValidId(row.sampleId) || !atlmValidId(row.planId) || ids.has(row.sampleId) || plans.has(row.planId)
      || ![row.capturedAt, row.sourceAvailableAt, row.actualMs].every(isNonnegativeSafeInteger)
      || row.sourceAvailableAt < row.capturedAt || !isPlainRecord(row.features)) return atlmUnavailable("INVALID_DATASET");
    ids.add(row.sampleId); plans.add(row.planId);
  }
  const sorted = atlmSortedRows(rows), n = sorted.length;
  const preprocessor = fitAtlmV4Preprocessor(sorted.map(row => row.features));
  if (preprocessor.status !== "AVAILABLE") return preprocessor;
  const plannedP=preprocessor.manifest.columns.length+1, work=n*plannedP*plannedP+plannedP*plannedP*plannedP;
  if (work>ATLM_FIT_WORK_LIMIT) return atlmUnavailable("MODEL_RESOURCE_LIMIT",{sampleCount:n,p:plannedP,work,limit:ATLM_FIT_WORK_LIMIT});
  const encoded = sorted.map(row => encodeAtlmV4Features(row.features, preprocessor.manifest));
  if (encoded.some(row => row.status !== "AVAILABLE")) return atlmUnavailable("INVALID_FEATURES");
  const matrix = encoded.map(row => row.row), p = matrix[0].length;
  const target = sorted.map(row => Math.log1p(row.actualMs / ATLM_MS_PER_MINUTE));
  if (engine === "OLS" && p > n) return atlmUnavailable("INSUFFICIENT_DATA", { sampleCount: n, p });
  const raw = atlmQr(matrix, target);
  if (engine === "OLS" && raw.rank !== p) return atlmUnavailable("RANK_DEFICIENT", { sampleCount: n, p, rank: raw.rank });
  let solved = raw;
  if (engine === "RIDGE") {
    const augmented = matrix.slice(), response = target.slice();
    for (let j = 1; j < p; j++) {
      const penalty = Array(p).fill(0); penalty[j] = Math.sqrt(n * ATLM_RIDGE_LAMBDA);
      augmented.push(penalty); response.push(0);
    }
    solved = atlmQr(augmented, response);
  }
  if (!solved.coefficients?.every(Number.isFinite)) return atlmUnavailable("NUMERICAL_FAILURE", { sampleCount: n, p });
  const artifact = atlmFreeze({ formatVersion: 3, kind: engine, featureSchemaVersion: "agent-task-v3", metric: "PLAN_ACTIVE",
    n, p, rank: raw.rank, preprocessor: preprocessor.manifest, coefficients: solved.coefficients,
    targetTransform: "log1p-minutes-v1", lambda: engine === "RIDGE" ? ATLM_RIDGE_LAMBDA : null,
    manifest: sorted.map(({ sampleId, planId }) => ({ sampleId, planId })), datasetDigest: "sha256:" + await hashCommandInput(sorted) });
  return { status: "AVAILABLE", artifact };
}

function atlmV4DefaultFeatures() {
  return Object.fromEntries(V4_FEATURE_FIELDS.map(field => {
    if (field === "doneBoundary") return [field, "ANALYSIS"];
    if (field === "environmentId" || V4_OPEN_CATEGORY_FIELDS.includes(field) || field === "plannedParallelAgents") return [field, null];
    if (Object.hasOwn(V4_CATEGORY_FIELDS, field)) return [field, V4_CATEGORY_FIELDS[field][0]];
    return [field, field === "workUnits.CREATE" ? 1 : 0];
  }));
}

function atlmV4RegressionArtifactValid(artifact) {
  if (!isPlainRecord(artifact) || artifact.formatVersion !== 3 || !["OLS", "RIDGE"].includes(artifact.kind)
    || artifact.featureSchemaVersion !== "agent-task-v3" || artifact.metric !== "PLAN_ACTIVE" || artifact.targetTransform !== "log1p-minutes-v1"
    || !Number.isSafeInteger(artifact.n) || artifact.n < 1 || artifact.n > ATLM_MAX_ROWS
    || !Number.isSafeInteger(artifact.p) || artifact.p < 1 || artifact.p > V4_MODEL_COLUMN_LIMIT + 1
    || !Number.isSafeInteger(artifact.rank) || artifact.rank < 1 || artifact.rank > Math.min(artifact.n, artifact.p)
    || (artifact.kind === "OLS" && (artifact.rank !== artifact.p || artifact.lambda !== null))
    || (artifact.kind === "RIDGE" && artifact.lambda !== ATLM_RIDGE_LAMBDA)
    || !atlmManifestValid(artifact.manifest, artifact.n) || !isSnapshotDigest(artifact.datasetDigest)
    || !Array.isArray(artifact.coefficients) || artifact.coefficients.length !== artifact.p
    || !artifact.coefficients.every(Number.isFinite)) return false;
  const encoded = encodeAtlmV4Features(atlmV4DefaultFeatures(), artifact.preprocessor);
  return encoded.status === "AVAILABLE" && encoded.row.length === artifact.p;
}

export function predictAtlmV4Regression(artifact, features) {
  if (!atlmV4RegressionArtifactValid(artifact)) return atlmUnavailable("INVALID_ARTIFACT");
  const encoded = encodeAtlmV4Features(features, artifact.preprocessor);
  if (encoded.status !== "AVAILABLE") return encoded;
  if (encoded.row.length !== artifact.p) return atlmUnavailable("INVALID_ARTIFACT");
  const z = atlmSum(encoded.row.map((value, i) => value * artifact.coefficients[i]));
  const ms = Math.max(0, ATLM_MS_PER_MINUTE * Math.expm1(z));
  return Number.isFinite(ms) && ms <= Number.MAX_SAFE_INTEGER
    ? { status: "AVAILABLE", pointMs: Math.round(ms), reason: null } : atlmUnavailable("INVALID_PREDICTION");
}

const ATLM_BAYES_INTERCEPT_PRECISION = 0.000001;
const ATLM_BAYES_COEFFICIENT_PRECISION = 1;
const ATLM_BAYES_PRIOR_SHAPE = 2;
const ATLM_BAYES_PRIOR_SCALE = 1;
const ATLM_BAYES_NOMINAL_COVERAGE = 0.8;

function atlmCholesky(matrix) {
  const p = matrix.length, lower = Array.from({ length: p }, () => Array(p).fill(0));
  for (let i = 0; i < p; i++) for (let j = 0; j <= i; j++) {
    let value = matrix[i][j];
    for (let k = 0; k < j; k++) value -= lower[i][k] * lower[j][k];
    if (i === j) {
      if (!(value > 0) || !Number.isFinite(value)) return null;
      lower[i][j] = Math.sqrt(value);
    } else lower[i][j] = value / lower[j][j];
  }
  return lower;
}

function atlmLowerSolve(lower, vector) {
  const solution = Array(vector.length).fill(0);
  for (let i = 0; i < vector.length; i++) {
    let value = vector[i];
    for (let j = 0; j < i; j++) value -= lower[i][j] * solution[j];
    solution[i] = value / lower[i][i];
  }
  return solution;
}

function atlmUpperTransposeSolve(lower, vector) {
  const solution = Array(vector.length).fill(0);
  for (let i = vector.length - 1; i >= 0; i--) {
    let value = vector[i];
    for (let j = i + 1; j < vector.length; j++) value -= lower[j][i] * solution[j];
    solution[i] = value / lower[i][i];
  }
  return solution;
}

// Lanczos log-gamma and a bounded continued fraction for the Student-t CDF.
function atlmLogGamma(z) {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
    12.507343278686905, -0.13857109526572012, 0.000009984369578019572, 0.00000015056327351493116];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - atlmLogGamma(1 - z);
  z -= 1;
  let sum = 0.9999999999998099;
  for (let i = 0; i < coefficients.length; i++) sum += coefficients[i] / (z + i + 1);
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

function atlmBetaFraction(a, b, x) {
  const tiny = 1e-300, tolerance = 3e-14, maxIterations = 1000;
  let c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let value = d;
  for (let m = 1; m <= maxIterations; m++) {
    const twice = 2 * m;
    let numerator = m * (b - m) * x / ((a + twice - 1) * (a + twice));
    d = 1 + numerator * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d; value *= d * c;
    numerator = -(a + m) * (a + b + m) * x / ((a + twice) * (a + twice + 1));
    d = 1 + numerator * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c; value *= delta;
    if (Math.abs(delta - 1) <= tolerance) return value;
  }
  return NaN;
}

function atlmRegularizedBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const factor = Math.exp(atlmLogGamma(a + b) - atlmLogGamma(a) - atlmLogGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2) ? factor * atlmBetaFraction(a, b, x) / a
    : 1 - factor * atlmBetaFraction(b, a, 1 - x) / b;
}

function atlmStudentT90(degreesOfFreedom) {
  const cdf = value => 1 - atlmRegularizedBeta(degreesOfFreedom / (degreesOfFreedom + value * value), degreesOfFreedom / 2, 0.5) / 2;
  let low = 0, high = 1;
  while (cdf(high) < 0.9 && high < 1e6) high *= 2;
  if (!Number.isFinite(cdf(high)) || cdf(high) < 0.9) return NaN;
  for (let i = 0; i < 80; i++) { const middle = (low + high) / 2; if (cdf(middle) < 0.9) low = middle; else high = middle; }
  return (low + high) / 2;
}

function atlmBayesArtifactValid(artifact) {
  if (!isPlainRecord(artifact) || artifact.formatVersion !== 3 || artifact.kind !== "BAYESIAN"
    || artifact.featureSchemaVersion !== "agent-task-v3" || artifact.metric !== "PLAN_ACTIVE" || artifact.priorVersion !== 1 || artifact.targetTransform !== "log1p-minutes-v1"
    || !Number.isSafeInteger(artifact.n) || artifact.n < 1 || artifact.n > ATLM_MAX_ROWS
    || !Number.isSafeInteger(artifact.p) || artifact.p < 1 || artifact.p > V4_MODEL_COLUMN_LIMIT + 1
    || !Number.isSafeInteger(artifact.rank) || artifact.rank < 1 || artifact.rank > Math.min(artifact.n, artifact.p)
    || !atlmManifestValid(artifact.manifest, artifact.n) || !isSnapshotDigest(artifact.datasetDigest)
    || !isPlainRecord(artifact.posterior) || artifact.posterior.shape !== ATLM_BAYES_PRIOR_SHAPE + artifact.n / 2
    || !Number.isFinite(artifact.posterior.scale) || artifact.posterior.scale < ATLM_BAYES_PRIOR_SCALE
    || !Array.isArray(artifact.posterior.coefficients) || artifact.posterior.coefficients.length !== artifact.p
    || !artifact.posterior.coefficients.every(Number.isFinite) || !Array.isArray(artifact.posterior.cholesky)
    || artifact.posterior.cholesky.length !== artifact.p) return false;
  for (let i = 0; i < artifact.p; i++) {
    const row = artifact.posterior.cholesky[i];
    if (!Array.isArray(row) || row.length !== artifact.p || !row.every(Number.isFinite) || row[i] <= 0
      || row.some((value, j) => j > i && value !== 0)) return false;
    const diagonal = atlmSum(row.map(value => value * value));
    const expected = artifact.n + (i === 0 ? ATLM_BAYES_INTERCEPT_PRECISION : ATLM_BAYES_COEFFICIENT_PRECISION);
    if (Math.abs(diagonal - expected) > 1e-8 * expected || (i > 0 && Math.abs(row[0]) > 1e-7 * Math.sqrt(artifact.n))) return false;
  }
  const encoded = encodeAtlmV4Features(atlmV4DefaultFeatures(), artifact.preprocessor);
  return encoded.status === "AVAILABLE" && encoded.row.length === artifact.p;
}

export async function fitAtlmBayesian(rows) {
  const problem = atlmDatasetProblem(rows);
  if (problem) return problem;
  if (!rows.length) return atlmUnavailable("INSUFFICIENT_DATA");
  const sorted = atlmSortedRows(rows);
  for (const row of sorted) { const missing = atlmFeatureProblem(row.features); if (missing) return missing; }
  const fitted = fitAtlmV4Preprocessor(sorted.map(row => row.features));
  if (fitted.status !== "AVAILABLE") return fitted;
  const plannedP=fitted.manifest.columns.length+1, work=sorted.length*plannedP*plannedP+plannedP*plannedP*plannedP;
  if (work>ATLM_FIT_WORK_LIMIT) return atlmUnavailable("MODEL_RESOURCE_LIMIT",{sampleCount:sorted.length,p:plannedP,work,limit:ATLM_FIT_WORK_LIMIT});
  const encoded = sorted.map(row => encodeAtlmV4Features(row.features, fitted.manifest));
  if (encoded.some(row => row.status !== "AVAILABLE")) return atlmUnavailable("INVALID_FEATURES");
  const matrix = encoded.map(row => row.row), n = matrix.length, p = matrix[0].length;
  const target = sorted.map(row => Math.log1p(row.actualMs / ATLM_MS_PER_MINUTE));
  const precision = Array.from({ length:p }, (_, i) => Array.from({ length:p }, (_, j) =>
    atlmSum(matrix.map(row => row[i] * row[j])) + (i === j ? (i === 0 ? ATLM_BAYES_INTERCEPT_PRECISION : ATLM_BAYES_COEFFICIENT_PRECISION) : 0)));
  const lower = atlmCholesky(precision);
  if (!lower) return atlmUnavailable("NUMERICAL_FAILURE", { sampleCount:n, p });
  const rhs = Array.from({ length:p }, (_, i) => atlmSum(matrix.map((row, j) => row[i] * target[j])));
  const coefficients = atlmUpperTransposeSolve(lower, atlmLowerSolve(lower, rhs));
  const residualSquares = atlmSum(matrix.map((row, i) => (target[i] - atlmSum(row.map((x, j) => x * coefficients[j]))) ** 2));
  const priorPenalty = coefficients.reduce((sum, value, i) => sum + value * value * (i === 0 ? ATLM_BAYES_INTERCEPT_PRECISION : ATLM_BAYES_COEFFICIENT_PRECISION), 0);
  const shape = ATLM_BAYES_PRIOR_SHAPE + n / 2, scale = ATLM_BAYES_PRIOR_SCALE + (residualSquares + priorPenalty) / 2;
  if (!coefficients.every(Number.isFinite) || !Number.isFinite(scale) || scale <= 0) return atlmUnavailable("NUMERICAL_FAILURE", { sampleCount:n, p });
  const rank = atlmQr(matrix, Array(n).fill(0)).rank;
  const artifact = atlmFreeze({ formatVersion:3, kind:"BAYESIAN", featureSchemaVersion:"agent-task-v3", metric:"PLAN_ACTIVE", n, p, rank,
    priorVersion:1, targetTransform:"log1p-minutes-v1", preprocessor:fitted.manifest,
    posterior:{ coefficients, cholesky:lower, shape, scale }, manifest:sorted.map(({ sampleId, planId }) => ({ sampleId, planId })),
    datasetDigest:"sha256:" + await hashCommandInput(sorted) });
  return { status:"AVAILABLE", artifact };
}

export function predictAtlmBayesian(artifact, features) {
  if (!atlmBayesArtifactValid(artifact) || artifact.priorVersion !== 1 || artifact.targetTransform !== "log1p-minutes-v1") return atlmUnavailable("INVALID_ARTIFACT");
  const encoded = encodeAtlmV4Features(features, artifact.preprocessor);
  if (encoded.status !== "AVAILABLE") return encoded;
  const posterior = artifact.posterior, x = encoded.row, transformed = atlmLowerSolve(posterior.cholesky, x);
  const location = atlmSum(x.map((value, i) => value * posterior.coefficients[i]));
  const scale = Math.sqrt(posterior.scale / posterior.shape * (1 + atlmSum(transformed.map(value => value * value))));
  const degreesOfFreedom = 2 * posterior.shape, quantile = atlmStudentT90(degreesOfFreedom);
  const ms = z => Math.max(0, ATLM_MS_PER_MINUTE * Math.expm1(z));
  const point = ms(location);
  if (!Number.isFinite(location) || !(scale > 0) || !Number.isFinite(scale) || !Number.isFinite(point) || point > Number.MAX_SAFE_INTEGER) return atlmUnavailable("INVALID_PREDICTION");
  const lower = ms(location - quantile * scale), upper = ms(location + quantile * scale);
  const available = Number.isFinite(quantile) && Number.isFinite(lower) && Number.isFinite(upper) && upper <= Number.MAX_SAFE_INTEGER;
  return { status:"AVAILABLE", pointMs:Math.round(point), reason:null,
    predictive:{ location, scale, degreesOfFreedom },
    interval:available ? { status:"AVAILABLE", lowerMs:Math.round(lower), upperMs:Math.round(upper), nominalCoverage:ATLM_BAYES_NOMINAL_COVERAGE, engine:"BAYESIAN_PREDICTIVE" }
      : { status:"UNAVAILABLE", lowerMs:null, upperMs:null, nominalCoverage:ATLM_BAYES_NOMINAL_COVERAGE, engine:"BAYESIAN_PREDICTIVE", unavailableReason:"NUMERICAL_FAILURE" } };
}

const ATLM_QUANTILE_LEVELS = [0.1, 0.5, 0.9];
const ATLM_QUANTILE_LAMBDA = 1;
const ATLM_QUANTILE_MAX_ITERATIONS = 2000;
const ATLM_QUANTILE_TOLERANCE = 0.000001;
const ATLM_QUANTILE_RESOLUTION_FACTOR = 16;
const ATLM_QUANTILE_WORK_LIMIT = 5000000;

export async function fitAtlmResidualQuantile(samples, quantile) {
  if (!Array.isArray(samples) || !ATLM_QUANTILE_LEVELS.includes(quantile)) return atlmUnavailable("INVALID_DATASET");
  if (samples.length < 5) return atlmUnavailable("INSUFFICIENT_RESIDUALS", { sampleCount:samples.length });
  if (samples.length > ATLM_MAX_ROWS) return atlmUnavailable("DATASET_LIMIT_REACHED", { sampleCount:samples.length, limit:ATLM_MAX_ROWS });
  const plans = new Set();
  for (const sample of samples) {
    if (!isPlainRecord(sample) || !atlmValidId(sample.planId) || plans.has(sample.planId) || !Number.isFinite(sample.residual) || v4FeatureProblem(sample.features)) return atlmUnavailable("INVALID_DATASET");
    if (Math.abs(sample.residual)*Number.EPSILON*ATLM_QUANTILE_RESOLUTION_FACTOR >= Math.min(quantile,1-quantile)*ATLM_QUANTILE_TOLERANCE)
      return atlmUnavailable("NUMERICAL_FAILURE", { sampleCount:samples.length });
    plans.add(sample.planId);
  }
  const ordered = samples.slice().sort((a,b) => atlmCompareId(a.planId,b.planId));
  const fitted = fitAtlmV4Preprocessor(ordered.map(sample => sample.features));
  if (fitted.status !== "AVAILABLE") return fitted;
  const encoded = ordered.map(sample => encodeAtlmV4Features(sample.features, fitted.manifest));
  if (encoded.some(row => row.status !== "AVAILABLE")) return atlmUnavailable("INVALID_FEATURES");
  const matrix = encoded.map(row => row.row), target = ordered.map(sample => sample.residual), n = matrix.length, p = matrix[0].length;
  const work = n*p*p + p*p*p + ATLM_QUANTILE_MAX_ITERATIONS*n*p;
  if (work > ATLM_QUANTILE_WORK_LIMIT) return atlmUnavailable("QUANTILE_RESOURCE_LIMIT", { sampleCount:n,p,work,limit:ATLM_QUANTILE_WORK_LIMIT });
  const precision = Array.from({length:p},(_,i)=>Array.from({length:p},(_,j)=>
    atlmSum(matrix.map(row=>row[i]*row[j])) + (i === j && i > 0 ? n * ATLM_QUANTILE_LAMBDA : 0)));
  const lower = atlmCholesky(precision);
  if (!lower) return atlmUnavailable("NUMERICAL_FAILURE", { sampleCount:n, p });
  let coefficients=Array(p).fill(0), residual=Array(n).fill(0), dual=Array(n).fill(0), iterations=0, converged=false;
  for (iterations=1; iterations<=ATLM_QUANTILE_MAX_ITERATIONS; iterations++) {
    const rhs=Array.from({length:p},(_,j)=>atlmSum(matrix.map((row,i)=>row[j]*(target[i]-residual[i]+dual[i]))));
    coefficients=atlmUpperTransposeSolve(lower,atlmLowerSolve(lower,rhs));
    if (!coefficients.every(Number.isFinite)) return atlmUnavailable("NUMERICAL_FAILURE", { sampleCount:n, p });
    const predicted=matrix.map(row=>atlmSum(row.map((value,j)=>value*coefficients[j]))), previous=residual;
    residual=predicted.map((value,i)=>{const z=target[i]-value+dual[i];return z>quantile?z-quantile:z<quantile-1?z+1-quantile:0;});
    const primal=target.map((value,i)=>value-predicted[i]-residual[i]);
    dual=dual.map((value,i)=>value+primal[i]);
    const norm=values=>Math.sqrt(atlmSum(values.map(value=>value*value)));
    const dualResidual=Array.from({length:p},(_,j)=>atlmSum(matrix.map((row,i)=>row[j]*(residual[i]-previous[i]))));
    const dualScale=Array.from({length:p},(_,j)=>atlmSum(matrix.map((row,i)=>row[j]*dual[i])));
    const primalLimit=ATLM_QUANTILE_TOLERANCE*(Math.sqrt(n)+Math.max(norm(target),norm(predicted),norm(residual)));
    const dualLimit=ATLM_QUANTILE_TOLERANCE*(Math.sqrt(p)+norm(dualScale));
    if (norm(primal)<=primalLimit && norm(dualResidual)<=dualLimit) { converged=true; break; }
  }
  if (!converged) return atlmUnavailable("QUANTILE_NOT_CONVERGED", { sampleCount:n, p, iterations:ATLM_QUANTILE_MAX_ITERATIONS });
  const artifact=atlmFreeze({formatVersion:1,kind:"RESIDUAL_QUANTILE",quantile,lambda:ATLM_QUANTILE_LAMBDA,
    solver:"admm-pinball-v1",tolerance:ATLM_QUANTILE_TOLERANCE,iterations,n,p,preprocessor:fitted.manifest,
    coefficients,manifest:ordered.map(row=>row.planId),datasetDigest:"sha256:"+await hashCommandInput(ordered)});
  return {status:"AVAILABLE",artifact};
}

export function predictAtlmResidualQuantile(artifact, features) {
  if (!isPlainRecord(artifact) || artifact.formatVersion!==1 || artifact.kind!=="RESIDUAL_QUANTILE"
    || !ATLM_QUANTILE_LEVELS.includes(artifact.quantile) || artifact.lambda!==ATLM_QUANTILE_LAMBDA || artifact.solver!=="admm-pinball-v1"
    || artifact.tolerance!==ATLM_QUANTILE_TOLERANCE || !Number.isSafeInteger(artifact.n) || artifact.n<5 || artifact.n>ATLM_MAX_ROWS
    || !Number.isSafeInteger(artifact.p) || artifact.p<1 || artifact.p>V4_MODEL_COLUMN_LIMIT+1
    || !Number.isSafeInteger(artifact.iterations) || artifact.iterations<1 || artifact.iterations>ATLM_QUANTILE_MAX_ITERATIONS
    || !Array.isArray(artifact.manifest) || artifact.manifest.length!==artifact.n || new Set(artifact.manifest).size!==artifact.n
    || !artifact.manifest.every(atlmValidId) || !isSnapshotDigest(artifact.datasetDigest)
    || !Array.isArray(artifact.coefficients) || artifact.coefficients.length!==artifact.p || !artifact.coefficients.every(Number.isFinite)) return atlmUnavailable("INVALID_ARTIFACT");
  const encoded=encodeAtlmV4Features(features,artifact.preprocessor);
  if (encoded.status!=="AVAILABLE") return encoded;
  if (encoded.row.length!==artifact.p) return atlmUnavailable("INVALID_ARTIFACT");
  const value=atlmSum(encoded.row.map((x,i)=>x*artifact.coefficients[i]));
  return Number.isFinite(value)?{status:"AVAILABLE",value}:{status:"UNAVAILABLE",value:null,reason:"INVALID_PREDICTION"};
}

export async function fitAtlmResidualQuantiles(samples) {
  if (!Array.isArray(samples) || samples.length < 5) return atlmUnavailable("INSUFFICIENT_RESIDUALS", { sampleCount:Array.isArray(samples)?samples.length:0 });
  const models = [];
  for (const quantile of ATLM_QUANTILE_LEVELS) {
    const fit = await fitAtlmResidualQuantile(samples, quantile);
    if (fit.status !== "AVAILABLE") return atlmUnavailable(fit.reason, { quantile, sampleCount:samples.length });
    models.push(fit.artifact);
  }
  return {status:"AVAILABLE",artifact:atlmFreeze({formatVersion:1,kind:"BAYES_QUANTILE",sampleCount:samples.length,models})};
}

function atlmResidualQuantilesValid(artifact) {
  if (!isPlainRecord(artifact) || artifact.formatVersion!==1 || artifact.kind!=="BAYES_QUANTILE"
    || !Number.isSafeInteger(artifact.sampleCount) || artifact.sampleCount<5 || !Array.isArray(artifact.models) || artifact.models.length!==3) return false;
  return artifact.models.every((model,i)=>isPlainRecord(model) && model.quantile===ATLM_QUANTILE_LEVELS[i] && model.n===artifact.sampleCount
    && model.datasetDigest===artifact.models[0].datasetDigest && canonical(model.manifest)===canonical(artifact.models[0].manifest)
    && canonical(model.preprocessor)===canonical(artifact.models[0].preprocessor)
    && predictAtlmResidualQuantile(model,atlmV4DefaultFeatures()).status==="AVAILABLE");
}

export function combineAtlmQuantileInterval(predictive, quantiles, pointMs, calibrationSampleCount, validationStatus="EXPERIMENTAL") {
  const unavailable = reason => ({status:"UNAVAILABLE",lowerMs:null,upperMs:null,nominalCoverage:ATLM_BAYES_NOMINAL_COVERAGE,
    engine:"BAYES_QUANTILE",calibrationSampleCount,validationStatus,unavailableReason:reason});
  if (!isPlainRecord(predictive) || !Number.isFinite(predictive.location) || !Number.isFinite(predictive.scale) || predictive.scale<=0
    || !Array.isArray(quantiles) || quantiles.length!==3 || !quantiles.every(Number.isFinite)
    || !isNonnegativeSafeInteger(pointMs) || !Number.isSafeInteger(calibrationSampleCount) || calibrationSampleCount<5
    || !["EXPERIMENTAL","HISTORICALLY_EVALUATED"].includes(validationStatus)) return unavailable("INVALID_PREDICTION");
  const ordered=quantiles.slice().sort((a,b)=>a-b);
  const converted=value=>Math.max(0,ATLM_MS_PER_MINUTE*Math.expm1(predictive.location+predictive.scale*value));
  const rawLower=converted(ordered[0]),rawUpper=converted(ordered[2]);
  if (!Number.isFinite(rawLower) || !Number.isFinite(rawUpper) || rawUpper>Number.MAX_SAFE_INTEGER) return unavailable("NUMERICAL_FAILURE");
  return {status:"AVAILABLE",lowerMs:Math.min(pointMs,Math.round(rawLower)),upperMs:Math.max(pointMs,Math.round(rawUpper)),
    nominalCoverage:ATLM_BAYES_NOMINAL_COVERAGE,engine:"BAYES_QUANTILE",calibrationSampleCount,validationStatus,unavailableReason:null};
}

export function predictAtlmResidualInterval(artifact, features, bayesianPrediction, pointMs, validationStatus="EXPERIMENTAL") {
  if (!atlmResidualQuantilesValid(artifact))
    return {status:"UNAVAILABLE",lowerMs:null,upperMs:null,nominalCoverage:ATLM_BAYES_NOMINAL_COVERAGE,engine:"BAYES_QUANTILE",calibrationSampleCount:0,validationStatus,unavailableReason:"INVALID_ARTIFACT"};
  const predictions=artifact.models.map(model=>predictAtlmResidualQuantile(model,features));
  if (predictions.some(prediction=>prediction.status!=="AVAILABLE")) return {status:"UNAVAILABLE",lowerMs:null,upperMs:null,
    nominalCoverage:ATLM_BAYES_NOMINAL_COVERAGE,engine:"BAYES_QUANTILE",calibrationSampleCount:artifact.sampleCount,validationStatus,unavailableReason:predictions.find(prediction=>prediction.status!=="AVAILABLE").reason};
  return combineAtlmQuantileInterval(bayesianPrediction?.predictive,predictions.map(prediction=>prediction.value),pointMs,artifact.sampleCount,validationStatus);
}

function atlmUnavailableInterval(engine, reason, calibrationSampleCount=0) {
  return {status:"UNAVAILABLE",lowerMs:null,upperMs:null,nominalCoverage:ATLM_BAYES_NOMINAL_COVERAGE,
    engine,calibrationSampleCount,validationStatus:"EXPERIMENTAL",unavailableReason:reason};
}

export async function evaluateAtlmIntervalCandidates(base, history, pointMs) {
  const bayesian=base?.bayesian;
  if (!isPlainRecord(base) || !isNonnegativeSafeInteger(base.capturedAt) || !Array.isArray(history)
    || history.some(prior=>!isPlainRecord(prior) || !atlmValidId(prior.planId) || prior.planId===base.planId
      || !isNonnegativeSafeInteger(prior.sourceAvailableAt) || prior.sourceAvailableAt>=base.capturedAt)
    || new Set(history.map(prior=>prior.planId)).size!==history.length) return {
      BAYESIAN_PREDICTIVE:atlmUnavailableInterval("BAYESIAN_PREDICTIVE","INVALID_HISTORY"),BAYES_QUANTILE:atlmUnavailableInterval("BAYES_QUANTILE","INVALID_HISTORY")};
  if (!isNonnegativeSafeInteger(pointMs) || bayesian?.status!=="AVAILABLE" || !bayesian.predictive) {
    const reason=bayesian?.reason || bayesian?.interval?.unavailableReason || "BAYESIAN_UNAVAILABLE";
    return {BAYESIAN_PREDICTIVE:atlmUnavailableInterval("BAYESIAN_PREDICTIVE",reason),BAYES_QUANTILE:atlmUnavailableInterval("BAYES_QUANTILE",reason)};
  }
  const predictive=bayesian.interval?.status==="AVAILABLE"
    ? {status:"AVAILABLE",lowerMs:Math.min(pointMs,bayesian.interval.lowerMs),upperMs:Math.max(pointMs,bayesian.interval.upperMs),
      nominalCoverage:ATLM_BAYES_NOMINAL_COVERAGE,engine:"BAYESIAN_PREDICTIVE",calibrationSampleCount:0,validationStatus:"EXPERIMENTAL",unavailableReason:null}
    : atlmUnavailableInterval("BAYESIAN_PREDICTIVE",bayesian.interval?.unavailableReason || "NUMERICAL_FAILURE");
  const residuals=[];
  for(const prior of history){
    if(prior.bayesian?.status!=="AVAILABLE" || !isNonnegativeSafeInteger(prior.actualMs))continue;
    const prediction=prior.bayesian.predictive;
    if(!prediction || !Number.isFinite(prediction.location) || !Number.isFinite(prediction.scale) || prediction.scale<=0) return {
      BAYESIAN_PREDICTIVE:predictive,BAYES_QUANTILE:atlmUnavailableInterval("BAYES_QUANTILE","INVALID_PREDICTION",residuals.length)};
    residuals.push({planId:prior.planId,features:prior.features,residual:(Math.log1p(prior.actualMs/ATLM_MS_PER_MINUTE)-prediction.location)/prediction.scale});
  }
  const fitted=await fitAtlmResidualQuantiles(residuals);
  return {BAYESIAN_PREDICTIVE:predictive,BAYES_QUANTILE:fitted.status==="AVAILABLE"
    ? predictAtlmResidualInterval(fitted.artifact,base.features,bayesian,pointMs)
    : atlmUnavailableInterval("BAYES_QUANTILE",fitted.reason,residuals.length)};
}

export function summarizeAtlmV4Metrics(cases) {
  if (!Array.isArray(cases)) return atlmUnavailable("INVALID_EVALUATION");
  const plans=new Set();
  for (const item of cases) {
    if (!isPlainRecord(item) || !atlmValidId(item.planId) || plans.has(item.planId) || !isNonnegativeSafeInteger(item.actualMs)
      || !(item.pointMs===null || isNonnegativeSafeInteger(item.pointMs)) || !isPlainRecord(item.interval)
      || !["AVAILABLE","UNAVAILABLE"].includes(item.interval.status)) return atlmUnavailable("INVALID_EVALUATION");
    if (item.interval.status==="AVAILABLE" && (!isNonnegativeSafeInteger(item.pointMs) || !isNonnegativeSafeInteger(item.interval.lowerMs)
      || !isNonnegativeSafeInteger(item.interval.upperMs) || item.interval.lowerMs>item.pointMs || item.pointMs>item.interval.upperMs)) return atlmUnavailable("INVALID_EVALUATION");
    if (item.interval.status==="UNAVAILABLE" && (item.interval.lowerMs!==null || item.interval.upperMs!==null
      || typeof item.interval.unavailableReason!=="string" || !item.interval.unavailableReason.trim())) return atlmUnavailable("INVALID_EVALUATION");
    plans.add(item.planId);
  }
  const valid=cases;
  const points=valid.filter(item=>isNonnegativeSafeInteger(item.pointMs));
  const intervals=points.filter(item=>item.interval?.status==="AVAILABLE" && isNonnegativeSafeInteger(item.interval.lowerMs)
    && isNonnegativeSafeInteger(item.interval.upperMs) && item.interval.lowerMs<=item.pointMs && item.pointMs<=item.interval.upperMs);
  const errors=points.map(item=>item.pointMs-item.actualMs), absolute=errors.map(Math.abs);
  const totalActual=atlmSum(points.map(item=>item.actualMs)), sumAbsoluteError=atlmSum(absolute), sumSignedError=atlmSum(errors);
  const hits=intervals.filter(item=>item.interval.lowerMs<=item.actualMs&&item.actualMs<=item.interval.upperMs).length;
  const widths=intervals.map(item=>item.interval.upperMs-item.interval.lowerMs);
  const scores=intervals.map((item,i)=>widths[i]+10*Math.max(0,item.interval.lowerMs-item.actualMs,item.actualMs-item.interval.upperMs));
  return {caseCount:valid.length,pointCaseCount:points.length,intervalCaseCount:intervals.length,
    caseIds:valid.map(item=>item.planId),pointCaseIds:points.map(item=>item.planId),intervalCaseIds:intervals.map(item=>item.planId),
    forecastRate:valid.length?points.length/valid.length:null,intervalAvailabilityRate:valid.length?intervals.length/valid.length:null,
    maeMs:points.length?sumAbsoluteError/points.length:null,medaeMs:points.length?median(absolute):null,
    meanSignedErrorMs:points.length?sumSignedError/points.length:null,sumAbsoluteErrorMs:sumAbsoluteError,sumSignedErrorMs:sumSignedError,totalActualMs:totalActual,
    wapePercent:totalActual?100*sumAbsoluteError/totalActual:null,signedBiasPercent:totalActual?100*sumSignedError/totalActual:null,
    coverageNumerator:hits,coverageDenominator:intervals.length,intervalCoverage:intervals.length?hits/intervals.length:null,
    meanIntervalWidthMs:intervals.length?atlmSum(widths)/intervals.length:null,meanIntervalScore:intervals.length?atlmSum(scores)/intervals.length:null};
}

export function selectAtlmIntervalEngine(candidates, cases, { incumbent=null } = {}) {
  if (!isPlainRecord(candidates) || !Array.isArray(cases) || cases.some(item=>!isPlainRecord(item) || !atlmValidId(item.planId)
    || !isNonnegativeSafeInteger(item.capturedAt) || !isNonnegativeSafeInteger(item.actualMs) || !isNonnegativeSafeInteger(item.pointMs)
    || !isPlainRecord(item.intervals)) || new Set(cases.map(item=>item.planId)).size!==cases.length) return atlmUnavailable("INVALID_EVALUATION");
  const engines=["BAYESIAN_PREDICTIVE","BAYES_QUANTILE"], available=engines.filter(engine=>candidates[engine]?.status==="AVAILABLE");
  const window=cases.slice().sort((a,b)=>a.capturedAt-b.capturedAt || atlmCompareId(a.planId,b.planId)).slice(-ATLM_MAX_EVALUATION_CASES);
  const validInterval=(item,engine)=>{const interval=item.intervals[engine];return isPlainRecord(interval) && interval.status==="AVAILABLE"
    && isNonnegativeSafeInteger(interval.lowerMs) && isNonnegativeSafeInteger(interval.upperMs)
    && interval.lowerMs<=item.pointMs && item.pointMs<=interval.upperMs;};
  for (const item of window) for (const engine of engines) {
    const interval=item.intervals[engine];
    if (!isPlainRecord(interval) || !["AVAILABLE","UNAVAILABLE"].includes(interval.status)
      || (interval.status==="AVAILABLE" && !validInterval(item,engine))
      || (interval.status==="UNAVAILABLE" && (interval.lowerMs!==null || interval.upperMs!==null || typeof interval.unavailableReason!=="string" || !interval.unavailableReason.trim()))) return atlmUnavailable("INVALID_EVALUATION");
  }
  const eligible=available.filter(engine=>window.filter(item=>validInterval(item,engine)).length>=ATLM_MIN_COMPARISONS);
  const common=eligible.length?window.filter(item=>eligible.every(engine=>validInterval(item,engine))):[];
  const metrics={};
  for(const engine of eligible){
    const values=common.map(item=>({planId:item.planId,actualMs:item.actualMs,pointMs:item.pointMs,interval:item.intervals[engine]}));
    metrics[engine]=summarizeAtlmV4Metrics(values);
  }
  let selectedEngine=null,reason="NO_INTERVAL_AVAILABLE";
  if(common.length>=ATLM_MIN_COMPARISONS){
    const best=Math.min(...eligible.map(engine=>metrics[engine].meanIntervalScore));
    let tied=eligible.filter(engine=>Math.abs(metrics[engine].meanIntervalScore-best)<=1e-9);
    const coverageDistance=Math.min(...tied.map(engine=>Math.abs(metrics[engine].intervalCoverage-ATLM_BAYES_NOMINAL_COVERAGE)));
    tied=tied.filter(engine=>Math.abs(Math.abs(metrics[engine].intervalCoverage-ATLM_BAYES_NOMINAL_COVERAGE)-coverageDistance)<=1e-12);
    const width=Math.min(...tied.map(engine=>metrics[engine].meanIntervalWidthMs));
    tied=tied.filter(engine=>Math.abs(metrics[engine].meanIntervalWidthMs-width)<=1e-9);
    selectedEngine=tied.includes(incumbent)?incumbent:tied[0];reason="LOWEST_INTERVAL_SCORE";
  } else if(available.length){selectedEngine=available.includes(incumbent)?incumbent:available[0];reason="EARLY_EXPERIMENTAL";}
  return {selectedEngine,reason,caseCount:common.length,caseIds:common.map(item=>item.planId),metrics,
    validationStatus:common.length>=ATLM_MIN_COMPARISONS?"HISTORICALLY_EVALUATED":"EXPERIMENTAL"};
}

export const AGENT_TASK_SCHEMA = V4_TASK_SCHEMA;

// Observe the current source in one SQLite read snapshot, not several independently timed reads.
export async function readAtlmSampleSource(db, ownerId, planId, nowMs) {
  if (!UUID.test(planId || "") || !Number.isSafeInteger(nowMs) || nowMs < 0) throw appError("VALIDATION_ERROR", "Invalid ATLM source arguments.");
  const row = await dbFirst(db, `SELECT p.*,
    i.assessment_sequence AS input_assessment_sequence,i.selection_status,i.requirements_json AS input_requirements_json,
    i.requirements_digest AS input_requirements_digest,i.captured_receipt_rowid,i.forecast_json,
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
      const normalized = normalizeAgentTask(JSON.parse(row.assessment_json).context.agentTask);
      if (normalized.missingFields.length) reasons.push("MISSING_REQUIRED_FEATURES"); else features = normalized.features;
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
  const originalPrediction = row.forecast_json !== null ? JSON.parse(row.forecast_json) : row.assessment_json ? JSON.parse(row.assessment_json).serverEstimation : null;
  const issuedPrediction = reasons.length === 0 && originalPrediction?.status === "AVAILABLE"
    && Number.isSafeInteger(originalPrediction.pointMs) && originalPrediction.pointMs >= 0
    ? { method: originalPrediction.method, modelId: originalPrediction.modelId ?? null, modelVersion: originalPrediction.modelVersion ?? null,
      calculatedAt: originalPrediction.calculatedAt, pointMs: originalPrediction.pointMs, pointEngine:originalPrediction.pointEngine ?? null,
      interval:originalPrediction.interval ?? atlmUnavailableInterval("BAYESIAN_PREDICTIVE","INTERVAL_NOT_RECORDED"), actualMs, errorMs: originalPrediction.pointMs - actualMs,
      ...(originalPrediction.hybrid ? { hybrid: originalPrediction.hybrid } : {}) } : null;
  const source = { planId, issuedPrediction, inputAssessmentSequence: row.input_assessment_sequence ?? null,
    eligibility: reasons.length ? "EXCLUDED" : "ELIGIBLE", reasons, features, actualMs,
    capturedAt: row.forecast_json !== null ? row.first_started_at : row.captured_at ?? null, sourceAvailableAt, observedAt: nowMs, sourceGeneration: row.source_generation };
  // Versions reflect source changes, not repeated observations or the current wall clock.
  source.sourceDigest = "sha256:" + await hashCommandInput({ ...source, observedAt: undefined, sourceGeneration: undefined,
    requirements: row.current_requirements_json, intervals: intervals.sort((a, b) => a.startMs - b.startMs || (a.endMs ?? Infinity) - (b.endMs ?? Infinity)),
    steps: steps.sort((a, b) => a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0),
    checks: checks.sort((a, b) => (a.stepId + a.key) < (b.stepId + b.key) ? -1 : (a.stepId + a.key) > (b.stepId + b.key) ? 1 : 0) });
  return source;
}

export async function claimAtlmJob(db, ownerId, jobKey, nowMs, leaseMs = 60000, { allowExpiredLease = true } = {}) {
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw appError("VALIDATION_ERROR", "Invalid ATLM lease.");
  return dbFirst(db, `UPDATE estimation_jobs SET status='RUNNING',lease_until=?,updated_at=?,fence=fence+1,executor_epoch=executor_epoch+1,attempts=attempts+CASE WHEN status='QUEUED' AND checkpoint_json IS NOT NULL THEN 0 ELSE 1 END
    WHERE owner_id=? AND job_key=? AND generation>processed_generation AND next_attempt_at<=?
      AND status<>'FAILED' AND (attempts<4 OR (status='QUEUED' AND checkpoint_json IS NOT NULL AND attempts<=4))
      AND (? OR status<>'RUNNING') AND (status<>'RUNNING' OR lease_until<=?) RETURNING *`, nowMs + leaseMs, nowMs, ownerId, jobKey, nowMs, allowExpiredLease ? 1 : 0, nowMs);
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
  GetEstimationTrainingHistory: { type: "object", additionalProperties: false, properties: {
    limit:{type:"integer",minimum:1,maximum:100,default:50},cursor:{type:"string",minLength:1,maxLength:1024},
  } },
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
  WHERE m.owner_id=? AND m.model_id=? AND m.status='ACTIVE' AND m.method_version IN ('${ATLM_OLS_METHOD.version}','${ATLM_METHOD.version}') AND m.feature_version='${ATLM_FEATURE_VERSION}'
    AND NOT EXISTS(SELECT 1 FROM json_each(m.manifest_json) item
      LEFT JOIN estimation_samples s ON s.owner_id=m.owner_id AND s.sequence=CAST(item.value AS INTEGER)
      WHERE s.sequence IS NULL OR s.eligibility<>'ELIGIBLE'
        OR s.sequence<>(SELECT MAX(latest.sequence) FROM estimation_samples latest WHERE latest.owner_id=s.owner_id AND latest.plan_id=s.plan_id)
        OR EXISTS(SELECT 1 FROM estimation_jobs dirty WHERE dirty.owner_id=s.owner_id AND dirty.plan_id=s.plan_id
          AND dirty.kind='REFRESH_SAMPLE' AND dirty.generation>dirty.processed_generation))`;

async function atlmPlanContext(db, ownerId, planId) {
  const row = await dbFirst(db, `SELECT p.status,p.first_started_at,p.deleted_at,t.requirements_json FROM plans p
    JOIN assessment_targets t ON t.owner_id=p.owner_id AND t.plan_id=p.plan_id AND t.step_id IS NULL
    WHERE p.owner_id=? AND p.plan_id=?`, ownerId, planId);
  if (!row || row.deleted_at !== null) throw appError("PLAN_NOT_FOUND", messageFor("PLAN_NOT_FOUND"), 404);
  return { ...row, requirementsDigest: "sha256:" + await hashCommandInput(JSON.parse(row.requirements_json)) };
}
const HISTORICAL_MEDIAN_METHOD=Object.freeze({id:"historical-median",version:"1"});
function canUseHistoricalMedian(prediction){
  const allowed=new Set(["COLLECTING_DATA","TRAINING_NOT_STARTED","TRAINING_IN_PROGRESS","INSUFFICIENT_DATA","RANK_DEFICIENT",
    "UNSUPPORTED_CATEGORY","MODEL_INVALIDATED","INSUFFICIENT_INCUMBENT_CASES","INSUFFICIENT_EVALUATION_CASES",
    "INVALID_PREDICTION","MEDIAN_BASELINE_NOT_WORSE","MODEL_RESOURCE_LIMIT","MODEL_CAPACITY_LIMIT","TRAINING_TIME_BUDGET"]);
  const diagnostic=prediction.diagnostics;
  return prediction.status==="UNAVAILABLE" && allowed.has(diagnostic?.code||prediction.unavailableReason)
    && (!diagnostic?.cause || allowed.has(diagnostic.cause.code));
}
async function historicalMedianForecast(db,ownerId,planId,nowMs){
  const snapshot=await dbFirst(db,`WITH selected AS(
    SELECT s.sequence,s.actual_ms FROM estimation_samples s
    WHERE s.owner_id=? AND s.plan_id<>? AND s.eligibility='ELIGIBLE' AND ${ATLM_LATEST_SAMPLE_SQL}
      AND s.source_available_at<=? ORDER BY s.sequence LIMIT ?
  ) SELECT COALESCE((SELECT dataset_revision FROM estimation_owner_state WHERE owner_id=?),0) AS revision,
    EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND kind='REFRESH_SAMPLE' AND generation>processed_generation) AS dirty,
    (SELECT json_group_array(json_object('sequence',sequence,'actualMs',actual_ms)) FROM selected) AS rows_json`,
    ownerId,planId,nowMs,ATLM_MAX_ROWS+1,ownerId,ownerId);
  if(snapshot.dirty)return null;
  const rows=JSON.parse(snapshot.rows_json||"[]");
  if(!rows.length||rows.length>ATLM_MAX_ROWS)return null;
  if(rows.some(row=>!isNonnegativeSafeInteger(row.actualMs)))throw appError("SOURCE_UNAVAILABLE","История содержит некорректное actualMs.",503);
  const pointMs=Math.round(median(rows.map(row=>row.actualMs)));
  if(!isNonnegativeSafeInteger(pointMs))throw appError("SOURCE_UNAVAILABLE","Не удалось рассчитать медиану истории.",503);
  return {status:"AVAILABLE",pointMs,method:{...HISTORICAL_MEDIAN_METHOD},modelId:null,modelVersion:null,sampleCount:rows.length,
    accuracy:"HISTORICAL_BASELINE",evaluation:null,unavailableReason:null,diagnostics:null,
    fallback:{kind:"HISTORICAL_MEDIAN",datasetRevision:snapshot.revision,throughSequence:rows.at(-1).sequence,
      sourceDigest:"sha256:"+await hashCommandInput(rows),sampleCount:rows.length}};
}
async function earlyForecast(db,ownerId,planId,prediction,nowMs){
  if(!canUseHistoricalMedian(prediction))return prediction;
  const baseline=await historicalMedianForecast(db,ownerId,planId,nowMs);
  return baseline?{...baseline,fallback:{...baseline.fallback,atlmUnavailableReason:prediction.unavailableReason,atlmDiagnostics:prediction.diagnostics??null}}:prediction;
}

async function calculateAtlmEstimate(db, ownerId, args, nowMs) {
  validateAssessmentValue(args, ATLM_TOOL_SCHEMAS.CalculateAtlmEstimate);
  if (!isSnapshotDigest(args.expectedRequirementsDigest)) throw appError("VALIDATION_ERROR", "Invalid requirements digest.");
  const target = await atlmPlanContext(db, ownerId, args.planId);
  if (target.requirementsDigest !== args.expectedRequirementsDigest) throw appError("ASSESSMENT_CONTEXT_CHANGED", messageFor("ASSESSMENT_CONTEXT_CHANGED"), 409);
  const normalized = normalizeAgentTask(args.agentTask);
  let prediction;
  if (target.status !== "PLANNED" || target.first_started_at !== null) prediction = { status: "UNAVAILABLE", unavailableReason: "UNSUPPORTED_FORECAST_SCOPE", diagnostics:atlmDiagnostics("UNSUPPORTED_FORECAST_SCOPE",{status:target.status,firstStartedAt:target.first_started_at}) };
  else if (normalized.missingFields.length) prediction = { status: "UNAVAILABLE", unavailableReason: "MISSING_REQUIRED_FEATURES", missingFields: normalized.missingFields, diagnostics:atlmDiagnostics("MISSING_REQUIRED_FEATURES",{missingFields:normalized.missingFields}) };
  else prediction = await earlyForecast(db,ownerId,args.planId,await predictWithActiveModel(db, ownerId, normalized.features, nowMs),nowMs);
  return { formatVersion: 2, metric: "PLAN_ACTIVE", forecastScope: "FULL_FROM_FIRST_START", method: prediction.method ?? { ...ATLM_METHOD },
    status: prediction.status, pointMs: prediction.pointMs ?? null, modelId: prediction.modelId ?? null, modelVersion: prediction.modelVersion ?? null,
    requirementsDigest: target.requirementsDigest, featureDigest: "sha256:" + await hashCommandInput(normalized.features), calculatedAt: nowMs,
    sampleCount: prediction.sampleCount ?? 0, evaluation: prediction.evaluation ?? null,
    accuracy: prediction.accuracy ?? "NOT_VALIDATED", pointEngine:prediction.pointEngine ?? (prediction.fallback ? "MEDIAN" : null),
    interval:prediction.interval ?? atlmUnavailableInterval("BAYESIAN_PREDICTIVE",prediction.unavailableReason ?? "HISTORICAL_BASELINE"),
    unavailableReason: prediction.unavailableReason ?? null, diagnostics:prediction.diagnostics ?? null, ...(prediction.fallback?{fallback:prediction.fallback}:{}), ...(prediction.hybrid?{hybrid:prediction.hybrid}:{}), ...(prediction.missingFields ? { missingFields: prediction.missingFields } : {}) };
}

// Read inputs and source generation together; optimistic retries keep a multi-read
// calculation from being returned as current after its inputs or plan status changed.
const CURRENT_FORECAST_MAX_READ_ATTEMPTS = 3;
const CURRENT_FORECAST_INPUT_SQL = `SELECT input.*,json_array(status,first_started_at,deleted_at,requirements_json,
  sequence,dataset_revision,active_model_id,model_status,last_training_diagnostics_json,training_generation,jobs_json) AS snapshot_key
  FROM (SELECT p.status,p.first_started_at,p.deleted_at,t.requirements_json,
    a.sequence,a.assessment_id,a.revision,a.requirements_digest,a.assessment_json,
    COALESCE(o.dataset_revision,0) AS dataset_revision,o.active_model_id,m.status AS model_status,
    o.last_training_diagnostics_json,o.training_generation,
    (SELECT json_group_array(json_array(j.job_key,j.generation,j.processed_generation,j.status))
      FROM estimation_jobs j WHERE j.owner_id=p.owner_id) AS jobs_json
    FROM plans p JOIN assessment_targets t ON t.owner_id=p.owner_id AND t.plan_id=p.plan_id AND t.step_id IS NULL
    LEFT JOIN assessment_revisions a ON a.sequence=(SELECT MAX(r.sequence) FROM assessment_revisions r
      WHERE r.owner_id=p.owner_id AND r.plan_id=p.plan_id AND r.step_id IS NULL)
    LEFT JOIN estimation_owner_state o ON o.owner_id=p.owner_id
    LEFT JOIN estimation_models m ON m.owner_id=o.owner_id AND m.model_id=o.active_model_id
    WHERE p.owner_id=? AND p.plan_id=?) input`;
async function currentForecastInput(db, ownerId, planId) {
  return dbFirst(db,CURRENT_FORECAST_INPUT_SQL,ownerId,planId);
}
async function currentPlanForecast(db, ownerId, planId, nowMs) {
  for(let attempt=0;attempt<CURRENT_FORECAST_MAX_READ_ATTEMPTS;attempt++){
    const input=await currentForecastInput(db,ownerId,planId);
    if(!input)throw appError("PLAN_NOT_FOUND",messageFor("PLAN_NOT_FOUND"),404);
    if(input.status!=="PLANNED"||input.first_started_at!==null||input.deleted_at!==null)return null;
    const assessment=input.assessment_json?JSON.parse(input.assessment_json):null;
    const digest="sha256:"+await hashCommandInput(JSON.parse(input.requirements_json));
    let estimation;
    const unavailable=code=>({formatVersion:2,metric:"PLAN_ACTIVE",forecastScope:"FULL_FROM_FIRST_START",
      method:{...ATLM_METHOD},status:"UNAVAILABLE",pointMs:null,modelId:null,modelVersion:null,requirementsDigest:digest,
      calculatedAt:nowMs,sampleCount:0,accuracy:"NOT_VALIDATED",evaluation:null,pointEngine:null,interval:atlmUnavailableInterval("BAYESIAN_PREDICTIVE",code),
      unavailableReason:code,diagnostics:atlmDiagnostics(code)});
    if(!assessment?.context?.agentTask)estimation=unavailable("MISSING_FEATURES");
    else if(input.requirements_digest!==digest)estimation=unavailable("SCOPE_CHANGED");
    else {
      try {
        estimation=await calculateAtlmEstimate(db,ownerId,{planId,agentTask:assessment.context.agentTask,expectedRequirementsDigest:digest},nowMs);
      }catch(error){
        if(error.code==="ASSESSMENT_CONTEXT_CHANGED")continue;
        throw error;
      }
    }
    const after=await currentForecastInput(db,ownerId,planId);
    if(canonical(input)!==canonical(after))continue;
    const diagnostics=estimation.fallback?.atlmDiagnostics??estimation.diagnostics;
    return {input, result:{formatVersion:1,planId,assessmentId:input.assessment_id??null,assessmentRevision:input.revision??null,
      source:"CURRENT_INPUT",serverEstimation:estimation,recordedEstimation:assessment?.serverEstimation??null,diagnostics,
      forecastAvailability:{planStatus:input.status,deleted:false,canCalculate:estimation.status==="AVAILABLE",canRefreshSaved:true,
        calculationMethod:estimation.status==="AVAILABLE"?estimation.method:null,reason:estimation.status==="AVAILABLE"?null:estimation.unavailableReason,
        diagnostics:estimation.status==="AVAILABLE"?null:diagnostics},
      isStale:false,staleReasons:[],serverNow:nowMs}};
  }
  throw appError("ASSESSMENT_CONTEXT_CHANGED","Исходные признаки, статус плана или история изменились во время расчёта. Повторите обновление прогноза.",409);
}

async function getPlanEstimate(db, ownerId, args, nowMs) {
  validateAssessmentValue(args, ATLM_TOOL_SCHEMAS.GetPlanEstimate);
  const current = await currentPlanForecast(db,ownerId,args.planId,nowMs);
  if(current)return current.result;
  const row = await dbFirst(db, `SELECT p.status,p.first_started_at,p.deleted_at,t.requirements_json AS current_requirements_json,
      a.assessment_id,a.revision,a.requirements_digest,a.assessment_json,i.forecast_json,i.requirements_json AS input_requirements_json,i.plan_id AS input_plan_id,o.data_reset_at
    FROM plans p JOIN assessment_targets t ON t.owner_id=p.owner_id AND t.plan_id=p.plan_id AND t.step_id IS NULL
    LEFT JOIN plan_estimation_inputs i ON i.owner_id=p.owner_id AND i.plan_id=p.plan_id
    LEFT JOIN estimation_owner_state o ON o.owner_id=p.owner_id
    LEFT JOIN assessment_revisions a ON a.owner_id=p.owner_id AND a.plan_id=p.plan_id AND a.sequence=CASE
      WHEN p.first_started_at IS NOT NULL THEN i.assessment_sequence
      ELSE (SELECT MAX(latest.sequence) FROM assessment_revisions latest WHERE latest.owner_id=p.owner_id AND latest.plan_id=p.plan_id
        AND latest.step_id IS NULL AND json_type(latest.assessment_json,'$.serverEstimation')='object') END
    WHERE p.owner_id=? AND p.plan_id=?`, ownerId, args.planId);
  if (!row) throw appError("PLAN_NOT_FOUND", messageFor("PLAN_NOT_FOUND"), 404);
  if(row.status==="PLANNED"&&row.first_started_at===null&&row.deleted_at===null)
    throw appError("ASSESSMENT_CONTEXT_CHANGED","Статус плана изменился. Повторите обновление прогноза.",409);
  if (row.first_started_at !== null && row.input_plan_id === null && row.data_reset_at !== null && row.first_started_at <= row.data_reset_at) {
    const diagnostics = atlmDiagnostics("HISTORY_RESET");
    return { formatVersion: 1, planId: args.planId, assessmentId: null, assessmentRevision: null, source: "HISTORY_RESET",
      serverEstimation: null, recordedEstimation: null, diagnostics,
      forecastAvailability: { planStatus: row.status, deleted: row.deleted_at !== null, canCalculate: false, canRefreshSaved: false,
        calculationMethod: null, reason: "HISTORY_RESET", diagnostics }, isStale: false, staleReasons: [], serverNow: nowMs };
  }
  const recordedEstimation = row.assessment_json ? JSON.parse(row.assessment_json).serverEstimation ?? null : null;
  const serverEstimation = row.forecast_json !== null ? JSON.parse(row.forecast_json) : recordedEstimation;
  const staleReasons = [];
  if (serverEstimation) {
    if (row.deleted_at !== null) staleReasons.push("PLAN_DELETED");
    const digest = "sha256:" + await hashCommandInput(JSON.parse(row.current_requirements_json));
    const frozenDigest = row.requirements_digest ?? (row.input_requirements_json ? "sha256:" + await hashCommandInput(JSON.parse(row.input_requirements_json)) : null);
    if (digest !== frozenDigest) staleReasons.push("SCOPE_CHANGED");
    else if (row.first_started_at !== null && (await readAtlmSampleSource(db, ownerId, args.planId, nowMs)).reasons.includes("SCOPE_CHANGED")) staleReasons.push("SCOPE_CHANGED");
    if(serverEstimation.fallback?.kind==="HISTORICAL_MEDIAN"){
      const current=await historicalMedianForecast(db,ownerId,args.planId,nowMs);
      if(!current||current.fallback.sourceDigest!==serverEstimation.fallback.sourceDigest)staleReasons.push("BASELINE_SOURCE_CHANGED");
    }
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
  const canRefreshSaved = row.deleted_at === null && row.status === "PLANNED" && row.first_started_at === null;
  const scopeDiagnostics = row.deleted_at !== null ? atlmDiagnostics("PLAN_DELETED") : !canRefreshSaved
    ? atlmDiagnostics("UNSUPPORTED_FORECAST_SCOPE",{status:row.status,firstStartedAt:row.first_started_at}) : null;
  let diagnostics = null;
  if(row.first_started_at!==null)diagnostics=serverEstimation?.fallback?.atlmDiagnostics??serverEstimation?.diagnostics??(!row.assessment_json?atlmDiagnostics("MISSING_FEATURES"):null);
  else if(!row.assessment_json) diagnostics = atlmDiagnostics("MISSING_FEATURES");
  else {
    const assessment = JSON.parse(row.assessment_json);
    if(assessment.context?.agentTask){
      const normalized = normalizeAgentTask(assessment.context.agentTask);
      if(normalized.missingFields.length) diagnostics = atlmDiagnostics("MISSING_REQUIRED_FEATURES",{missingFields:normalized.missingFields});
      else {
        const model=await atlmReadActiveModel(db,ownerId);
        if(model){
          const artifact=atlmTrainingJson(model.artifact_json);
          if(!atlmArtifactValid(artifact))throw appError("SOURCE_UNAVAILABLE","Сохранённая модель ATLM повреждена.",503,{reason:"INVALID_ARTIFACT"});
          const preview = predictAtlm(artifact, normalized.features);
          if (preview.status !== "AVAILABLE") diagnostics = atlmDiagnostics(preview.reason, preview);
        }
      }
    }else diagnostics=atlmDiagnostics("MISSING_FEATURES");
    if(!diagnostics) diagnostics = atlmStatusDiagnostics(await getEstimationModelStatus(db,ownerId,nowMs));
  }
  let calculationMethod=!diagnostics?{...ATLM_METHOD}:null;
  if(canRefreshSaved&&diagnostics&&canUseHistoricalMedian({status:"UNAVAILABLE",diagnostics})){
    const baseline=await historicalMedianForecast(db,ownerId,args.planId,nowMs);
    if(baseline)calculationMethod={...HISTORICAL_MEDIAN_METHOD};
  }
  const availabilityDiagnostics = scopeDiagnostics || (!calculationMethod?diagnostics:null);
  const forecastAvailability = {planStatus:row.status,deleted:row.deleted_at!==null,canCalculate:canRefreshSaved && !!calculationMethod,canRefreshSaved,
    calculationMethod:canRefreshSaved?calculationMethod:null,reason:availabilityDiagnostics?.code ?? null,diagnostics:availabilityDiagnostics};
  return { formatVersion: 1, planId: args.planId, assessmentId: row.assessment_id ?? null, assessmentRevision: row.revision ?? null,
    source: row.first_started_at !== null ? "FROZEN_INPUT" : row.assessment_id ? "LATEST_ASSESSMENT" : "NONE",
    serverEstimation, recordedEstimation, diagnostics, forecastAvailability, isStale: staleReasons.length > 0, staleReasons, serverNow: nowMs };
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
async function getEstimationTrainingHistory(db,ownerId,args,nowMs) {
  validateAssessmentValue(args,ATLM_TOOL_SCHEMAS.GetEstimationTrainingHistory);
  const limit=args.limit ?? 50, ownerScope=await hashCommandInput({purpose:"atlm-training-history-v1",ownerId});
  let cursor=null;
  if(args.cursor!==undefined){
    try{cursor=JSON.parse(args.cursor);}catch{throw appError("VALIDATION_ERROR","Invalid training history cursor.");}
    if(!isPlainRecord(cursor) || Object.keys(cursor).length!==5 || cursor.version!==1 || cursor.ownerScope!==ownerScope
      || ![cursor.after,cursor.through,cursor.completed].every(isNonnegativeSafeInteger) || cursor.after>cursor.through)
      throw appError("VALIDATION_ERROR","Invalid training history cursor.");
  }
  const result=await dbFirst(db,`WITH bounds AS (
      SELECT COALESCE(?,(SELECT COALESCE(MAX(rowid),0) FROM estimation_training_attempts WHERE owner_id=?)) AS high
    ), counts AS (
      SELECT high,(SELECT COUNT(*) FROM estimation_training_attempts WHERE owner_id=? AND rowid<=high AND completed_at IS NOT NULL) AS completed FROM bounds
    ), page AS (
      SELECT rowid AS seq,* FROM estimation_training_attempts WHERE owner_id=? AND rowid>? AND rowid<=(SELECT high FROM counts)
      ORDER BY rowid LIMIT ?
    ) SELECT high,completed,(SELECT json_group_array(json_object('seq',seq,'attemptId',attempt_id,'startedAt',started_at,'completedAt',completed_at,
       'methodVersion',method_version,'featureVersion',feature_version,'datasetRevision',dataset_revision,'manifest',manifest_json,
       'diagnostics',diagnostics_json,'cases',case_ids_json,'metrics',metrics_json,'selected',selected_json,'reason',reason)) FROM page) AS rows_json FROM counts`,
    cursor?.through ?? null,ownerId,ownerId,ownerId,cursor?.after ?? 0,limit+1);
  if(cursor && result.completed!==cursor.completed) throw appError("HISTORY_CHANGED","История обучения изменилась; начните просмотр заново.",409);
  const values=JSON.parse(result.rows_json),hasMore=values.length>limit;if(hasMore)values.pop();
  const rows=values.map(({seq,...row})=>({...row,manifest:JSON.parse(row.manifest),diagnostics:parseColumn(row.diagnostics),
    cases:parseColumn(row.cases),metrics:parseColumn(row.metrics),selected:parseColumn(row.selected)}));
  const nextCursor=hasMore?JSON.stringify({version:1,ownerScope,after:values.at(-1).seq,through:result.high,completed:result.completed}):null;
  return {formatVersion:1,rows,hasMore,nextCursor,serverNow:nowMs};
}
async function executeAtlmTool(db, ownerId, name, args, nowMs, clock) {
  validateAssessmentValue(args, ATLM_TOOL_SCHEMAS[name]);
  if (name === "CalculateAtlmEstimate") return calculateAtlmEstimate(db, ownerId, args, nowMs);
  if (name === "GetPlanEstimate") return getPlanEstimate(db, ownerId, args, nowMs);
  if (name === "GetAtlmDataset") return getAtlmDataset(db, ownerId, args, nowMs);
  if (name === "GetEstimationTrainingHistory") return getEstimationTrainingHistory(db,ownerId,args,nowMs);
  if (name === "GetEstimationModelStatus") return getEstimationModelStatus(db, ownerId, nowMs);
  if (name === "StartEstimationTraining") {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO estimation_owner_state(owner_id) SELECT owner_id FROM owners WHERE owner_id=?").bind(ownerId),
      db.prepare("UPDATE estimation_owner_state SET forced_retrain=1, manual_epoch=manual_epoch+1, updated_at=? WHERE owner_id=?").bind(nowMs, ownerId),
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
  if (depth > 12) throw appError("VALIDATION_ERROR", "JSON depth exceeds 12.");
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
  if (new TextEncoder().encode(JSON.stringify(envelope.payload)).length > V4_TASK_MAX_BYTES) throw appError("VALIDATION_ERROR", "Assessment exceeds 64 KiB UTF-8.");
  const p = envelope.payload, f = p.forecast, c = p.complexity;
  if (Object.hasOwn(p.context, "agentTask")) normalizeAgentTask(p.context.agentTask);
  if (p.predictionRequest && (p.stepId !== undefined || !Object.hasOwn(p.context, "agentTask"))) throw appError("VALIDATION_ERROR", "predictionRequest requires plan-level agentTask v3.");
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
  if (typeof text !== "string" || !text.trim()) throw appError("VALIDATION_ERROR", "Вставьте полный текст плана.");
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
  if (!stages.length) throw appError("VALIDATION_ERROR", "В плане нужны заголовки этапов, например «## Этап 1. Название» или «## DATA-001. Название».");
  const nextOffsets = new Map(), openHeadings = [];
  for (const heading of headings) {
    while (openHeadings.length && openHeadings.at(-1).level >= heading.level) nextOffsets.set(openHeadings.pop(), heading.offset);
    openHeadings.push(heading);
  }
  const ids = new Set();
  return stages.map((stage, index) => {
    const match = stage.title.match(stagePattern), id = match[1] || match[2];
    if (ids.has(id.toUpperCase()) || stage.level !== stages[0].level || stage.title.length > 200) throw appError("VALIDATION_ERROR", "У этапов должны быть разные номера, один уровень заголовков и названия до 200 символов.");
    ids.add(id.toUpperCase());
    return { stepId: crypto.randomUUID(), ordinal: index + 1, title: stage.title.replace(/^\*\*|\*\*$/g, ""), content: text.slice(stage.offset, nextOffsets.get(stage) ?? text.length) };
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
  // Retired receipts must be found before the new assessment schema rejects an
  // otherwise identical retry of an old command.
  if (envelope?.commandType === "RecordAssessment" && envelope.schemaVersion === 1 && UUID.test(envelope.commandId || "")
    && Number.isSafeInteger(envelope.expectedVersion) && envelope.expectedVersion >= 0 && isPlainRecord(envelope.payload)) {
    const retired = await dbFirst(db, "SELECT * FROM command_receipts WHERE owner_id=? AND command_id=? AND outcome_code='ASSESSMENT_SCHEMA_RETIRED'", identity.ownerId, envelope.commandId);
    if (retired) {
      validateAssessmentValue(envelope.payload, {}, "payload");
      const hash = await payloadHash(envelope);
      if (envelope.payloadHash !== undefined && envelope.payloadHash !== hash) throw appError("VALIDATION_ERROR", "payloadHash не совпадает с конвертом.");
      if (!await receiptMatchesCommand(retired, envelope, hash)) throw appError("IDEMPOTENCY_KEY_REUSED", messageFor("IDEMPOTENCY_KEY_REUSED"), 409);
      return resultFromReceipt(retired, true);
    }
  }
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
    let storedInput = Object.hasOwn(input.context, "agentTask") ? { ...input, context: { ...input.context, agentTask: normalizeAgentTask(input.context.agentTask).agentTask } } : input;
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
    if (new TextEncoder().encode(assessmentJson).length > V4_TASK_MAX_BYTES) throw appError("VALIDATION_ERROR", "Assessment with server estimation exceeds 64 KiB UTF-8.");
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
      const serverPrediction=JSON.parse(payload.assessmentJson).serverEstimation;
      const modelId = serverPrediction?.modelId ?? null;
      const baselineRevision=serverPrediction?.fallback?.kind==="HISTORICAL_MEDIAN"?serverPrediction.fallback.datasetRevision:null;
      write = await db.prepare(`INSERT OR IGNORE INTO command_receipts
        (owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,result_json,recorded_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,CASE
          WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=? AND plan_id=?) THEN 'PLAN_NOT_FOUND'
          WHEN EXISTS(SELECT 1 FROM plans WHERE owner_id=? AND plan_id=? AND deleted_at IS NOT NULL) THEN 'PLAN_DELETED'
          WHEN EXISTS(SELECT 1 FROM plans WHERE owner_id=? AND plan_id=? AND first_started_at IS NOT NULL) THEN 'ATLM_FORECAST_SCOPE_CHANGED'
          WHEN ? IS NOT NULL THEN ?
          WHEN ? IS NOT NULL AND NOT EXISTS(${ATLM_CURRENT_MODEL_SQL}) THEN 'ATLM_MODEL_CHANGED'
          WHEN ? IS NOT NULL AND (COALESCE((SELECT dataset_revision FROM estimation_owner_state WHERE owner_id=?),0)<>?
            OR EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND kind='REFRESH_SAMPLE' AND generation>processed_generation)) THEN 'ATLM_MODEL_CHANGED'
          ELSE 'PENDING' END,?,?`).bind(...values, identity.ownerId, planId, identity.ownerId, planId,
            identity.ownerId, planId, predictionPreparationError, predictionPreparationError, modelId, identity.ownerId, modelId, baselineRevision,identity.ownerId,baselineRevision,identity.ownerId, JSON.stringify({ serverNow: nowMs }), nowMs).run();
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
  if(Object.hasOwn(payload,"atlmStartForecast"))throw appError("VALIDATION_ERROR","atlmStartForecast — служебный параметр сервера.");
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
    payload.requirementsTargets = [{stepId:null,requirementsJson:JSON.stringify({plan:planRequirements,steps:payload.documentSteps.map(step=>({stepId:step.stepId,ordinal:step.ordinal,title:step.title,content:step.content}))})}];

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
        const current = await dbFirst(db, "SELECT first_started_at FROM plans WHERE owner_id=? AND plan_id=?", identity.ownerId, payload.planId);
        payload.dateAfterStart = planDateAfterStart(payload.planCreatedAt, current && current.first_started_at);
      }
      for (const key of ["description", "acceptanceCriteria"]) if (payload[key] !== undefined && payload[key] !== null && typeof payload[key] !== "string") throw appError("VALIDATION_ERROR", "Метаданные должны быть строками.");
    }
    if (envelope.commandType === "FinishPlan") {
      if (payload.allowIncomplete !== undefined && typeof payload.allowIncomplete !== "boolean") throw appError("VALIDATION_ERROR", "allowIncomplete должен быть boolean.");
      if (payload.reason !== undefined && (typeof payload.reason !== "string" || payload.reason.trim().length > 1000)) throw appError("VALIDATION_ERROR", "reason ограничен 1000 символами.");
      if (payload.allowIncomplete === true && (!payload.reason || !payload.reason.trim())) throw appError("VALIDATION_ERROR", "Для завершения с незавершёнными этапами требуется причина.");
      if (payload.reason !== undefined) payload.reason = payload.reason.trim();
      assertSafeMetadataText(payload.reason, "reason");

    }

  }

  let startInput = null;
  if(envelope.commandType==="StartPlan"){
    const initial=await currentForecastInput(db,identity.ownerId,planId);
    if(initial?.status==="PLANNED"&&initial.first_started_at===null&&initial.deleted_at===null){
      let current;
      try {current=await currentPlanForecast(db,identity.ownerId,planId,nowMs);}
      catch(error){
        if(error.code!=="SOURCE_UNAVAILABLE")throw error;
        const input=await currentForecastInput(db,identity.ownerId,planId);
        if(canonical(input)!==canonical(initial))throw appError("ASSESSMENT_CONTEXT_CHANGED",messageFor("ASSESSMENT_CONTEXT_CHANGED"),409);
        current={input,result:{serverEstimation:{formatVersion:2,metric:"PLAN_ACTIVE",forecastScope:"FULL_FROM_FIRST_START",
          status:"UNAVAILABLE",pointMs:null,method:{...ATLM_METHOD},modelId:null,modelVersion:null,calculatedAt:nowMs,
          requirementsDigest:"sha256:"+await hashCommandInput(JSON.parse(input.requirements_json)),
          sampleCount:0,accuracy:"NOT_VALIDATED",evaluation:null,pointEngine:null,interval:atlmUnavailableInterval("BAYESIAN_PREDICTIVE","SOURCE_UNAVAILABLE"),
          unavailableReason:"SOURCE_UNAVAILABLE",diagnostics:atlmDiagnostics("SOURCE_UNAVAILABLE")}}};
      }
      if(current){
        startInput=current.input;
        const assessment=startInput.assessment_json?JSON.parse(startInput.assessment_json):null;
        payload.atlmStartForecast={assessmentSequence:assessment?.context?.agentTask&&startInput.requirements_digest===current.result.serverEstimation.requirementsDigest?startInput.sequence:null,
          estimation:current.result.serverEstimation};
      }
    }
  }
  const actorType = channel === "mcp" ? "agent" : "user";
  let receiptInserted = false;
  try {
    const startGuard=startInput ? `CASE
      WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=? AND plan_id=? AND deleted_at IS NULL) THEN 'PLAN_NOT_FOUND'
      WHEN (SELECT version FROM plans WHERE owner_id=? AND plan_id=?)<>? THEN 'VERSION_CONFLICT'
      WHEN NOT EXISTS(SELECT 1 FROM (${CURRENT_FORECAST_INPUT_SQL}) source WHERE source.snapshot_key=?) THEN 'ASSESSMENT_CONTEXT_CHANGED'
      ELSE 'PENDING' END` : "'PENDING'";
    const guardArgs=startInput?[identity.ownerId,planId,identity.ownerId,planId,envelope.expectedVersion,
      identity.ownerId,planId,startInput.snapshot_key]:[];
    const write = await db.prepare(`INSERT OR IGNORE INTO command_receipts (owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,${startGuard},?)`)
      .bind(identity.ownerId, envelope.commandId, hash, envelope.commandType, planId, envelope.expectedVersion == null ? null : envelope.expectedVersion,
        nowMs, identity.ownerId, actorType, JSON.stringify(payload), ...guardArgs, nowMs).run();
    receiptInserted = Number(write.meta?.changes) > 0;
  } catch (error) { throw mapDbError(error); }
  receipt = await dbFirst(db, "SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?", identity.ownerId, envelope.commandId);
  if (!receipt) throw appError("INTERNAL_ERROR", "Не удалось сохранить результат команды.", 500);
  if (!await receiptMatchesCommand(receipt, envelope, hash)) throw appError("IDEMPOTENCY_KEY_REUSED", messageFor("IDEMPOTENCY_KEY_REUSED"), 409);
  return resultFromReceipt(receipt, !receiptInserted);
}

const PLAN_STATUSES = ["PLANNED", "RUNNING", "PAUSED", "COMPLETED"];
const MAX_PLAN_PAGE_SIZE = 100;
const PLAN_LIST_ORDER = "isCompleted ASC, registeredAt DESC, planId DESC";
const PLAN_COMPLETION_GROUP = "CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END";

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
    if (typeof filter.cursor !== "string" || filter.cursor.length > 200 || !Array.isArray(cursor) || cursor.length !== 3
      || !Number.isInteger(cursor[0]) || (cursor[0] !== 0 && cursor[0] !== 1)
      || !Number.isSafeInteger(cursor[1]) || cursor[1] < 0 || !UUID.test(cursor[2] || "")) {
      throw appError("VALIDATION_ERROR", "Некорректный cursor списка планов.");
    }
    clauses.push("(" + PLAN_COMPLETION_GROUP + " > ? OR (" + PLAN_COMPLETION_GROUP + " = ? AND (registered_at < ? OR (registered_at = ? AND plan_id < ?))))");
    values.push(cursor[0], cursor[0], cursor[1], cursor[1], cursor[2]);
  }
  const rows = await dbAll(db, "SELECT * FROM plans WHERE " + clauses.join(" AND ") + " ORDER BY " + PLAN_COMPLETION_GROUP + " ASC, registered_at DESC, plan_id DESC LIMIT ?", ...values, limit + 1);
  const page = rows.slice(0, limit), last = page.at(-1);
  return {
    plans: await Promise.all(page.map(row => planSummary(db, ownerId, row, nowMs))),
    nextCursor: rows.length > limit ? JSON.stringify([last.status === "COMPLETED" ? 1 : 0, last.registered_at, last.plan_id]) : null,
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

// Recorded execution windows are independent for each step. Overlapping steps
// may both be executing; their sum is not the plan's union of active time.
export async function buildStepAnalytics(db, ownerId, planId, filter, nowMs) {
  if (!UUID.test(planId || "")) throw appError("VALIDATION_ERROR", "planId должен быть UUID.");
  const timeZone = checkTimeZone(filter.timeZone || "UTC");
  const range = inclusiveDateRange(filter.from, filter.to, timeZone);
  if (typeof filter.asOf === "string" && !/^\d+$/.test(filter.asOf)) throw appError("VALIDATION_ERROR", "Некорректное время отчёта.");
  const asOf = filter.asOf == null ? nowMs : Number(filter.asOf);
  if (!Number.isSafeInteger(asOf) || asOf < 0 || asOf > nowMs) throw appError("VALIDATION_ERROR", "Некорректное время отчёта.");
  const row = await dbFirst(db, `SELECT p.plan_id,
    (SELECT json_group_array(json_object('stepId',step_id,'ordinal',ordinal,'title',title)) FROM
      (SELECT step_id,ordinal,title FROM plan_steps WHERE owner_id=?1 AND plan_id=?2 AND created_at<=?3 ORDER BY ordinal)) AS steps,
    (SELECT json_group_array(json_object('stepId',i.step_id,'startMs',i.start_ms,'endMs',i.end_ms))
      FROM step_work_intervals i JOIN plan_steps s ON s.owner_id=i.owner_id AND s.step_id=i.step_id
      WHERE s.owner_id=?1 AND s.plan_id=?2 AND i.start_ms<=?3) AS windows,
    (SELECT json_group_array(json_object('startMs',start_ms,'endMs',end_ms)) FROM work_intervals
      WHERE owner_id=?1 AND plan_id=?2 AND start_ms<=?3) AS intervals
    FROM plans p WHERE p.owner_id=?1 AND p.plan_id=?2 AND p.deleted_at IS NULL`, ownerId, planId, asOf);
  if (!row) throw appError("PLAN_NOT_FOUND", messageFor("PLAN_NOT_FOUND"), 404);
  const windows = JSON.parse(row.windows), intervals = JSON.parse(row.intervals);
  const endMs = Math.min(range.endMs, asOf);
  const steps = JSON.parse(row.steps).map(step => {
    const recorded = windows.filter(window => window.stepId === step.stepId);
    let activeMs = recorded.length ? 0 : null;
    for (const window of recorded) for (const interval of intervals) {
      activeMs += Math.max(0, Math.min(window.endMs ?? asOf, interval.endMs ?? asOf, endMs)
        - Math.max(window.startMs, interval.startMs, range.startMs));
    }
    return { ...step, activeMs, firstMeasuredAt: recorded.length ? Math.min(...recorded.map(window => window.startMs)) : null };
  });
  return { planId, period: { from: filter.from, to: filter.to, timeZone }, asOf, steps };
}

// All exported collections share one SQLite read snapshot.
const EXPORT_SOURCES={
 settings:["owners","timezone"],documents:["plan_documents","plan_id,markdown"],
 plans:["plans","plan_id,title,description,acceptance_criteria,plan_created_precision,plan_created_at_ms,plan_created_on,plan_created_timezone,registered_at,status,deleted_at,first_started_at,finished_at,source_reference"],
 steps:["plan_steps","step_id,plan_id,ordinal,title,content,status,version,created_at,updated_at"],
 stepIntervals:["step_work_intervals","step_id,start_ms,end_ms"],
 intervals:["work_intervals","interval_id,plan_id,start_ms,end_ms"],dates:["plan_date_history","history_id,plan_id,old_precision,old_at_ms,old_on,old_timezone,changed_at,reason"],
 assessments:["assessment_revisions","assessment_id,revision,plan_id,step_id,recorded_at,requirements_digest,requirements_json,assessment_json"],targets:["assessment_targets","plan_id,step_id,requirements_json"],
 exceptions:["tracker_finish_exceptions","plan_id,reason,created_at"],
 frozen:["plan_estimation_inputs","plan_id,selection_status,first_started_at,forecast_json"],
 samples:["estimation_samples","sequence,plan_id,input_assessment_sequence,source_digest,source_generation,eligibility,reasons_json,features_json,issued_prediction_json,actual_ms,captured_at,source_available_at,observed_at,is_first_eligible"],
 models:["estimation_models","model_id,model_version,status,method_version,feature_version,manifest_json,dataset_digest,train_cutoff,metrics_json,sample_count,reason,created_at,activated_at"],
 attempts:["estimation_training_attempts","attempt_id,started_at,completed_at,method_version,feature_version,dataset_revision,manifest_json,diagnostics_json,case_ids_json,metrics_json,selected_json,reason"]
};
function groupExportRows(rows,key){const groups=new Map();for(const row of rows){const value=groups.get(row[key])||[];value.push(row);groups.set(row[key],value);}return groups;}
function exportPlanDate(precision,at,on,timeZone){return precision==="instant"?{precision,value:new Date(at).toISOString(),timeZone}:{precision,on,timeZone};}
async function buildExportReport(db,ownerId,clock){
 const maxCompoundTerms=5; // D1 limits each compound SELECT to five terms.
 let terms=Object.entries(EXPORT_SOURCES).map(([kind,[table,columns]])=>`SELECT '${kind}' AS kind,json_object(${columns.split(",").map(column=>`'${column}',${column}`).join(",")}) AS record FROM ${table} WHERE owner_id=?1`);
 while(terms.length>maxCompoundTerms){
  const groups=[];
  for(let i=0;i<terms.length;i+=maxCompoundTerms)groups.push("SELECT kind,record FROM ("+terms.slice(i,i+maxCompoundTerms).join(" UNION ALL ")+")");
  terms=groups;
 }
 const sql=terms.join(" UNION ALL ");
 const snapshot=await db.prepare(sql).bind(ownerId).all(),nowMs=clock();
 if(snapshot.success===false||!Array.isArray(snapshot.results))throw appError("INTERNAL_ERROR","Не удалось прочитать полный отчёт.",500);
 const data=Object.fromEntries(Object.keys(EXPORT_SOURCES).map(key=>[key,[]]));for(const row of snapshot.results)data[row.kind].push(JSON.parse(row.record));
 const related=Object.fromEntries(["steps","intervals","dates","assessments","exceptions"].map(key=>[key,groupExportRows(data[key],"plan_id")]));
 const frozen=new Map(data.frozen.map(row=>[row.plan_id,row]));
 const documents=new Map(data.documents.map(d=>[d.plan_id,d.markdown])),digests=new Map();for(const t of data.targets)digests.set(t.plan_id+":"+(t.step_id||""),"sha256:"+await hashCommandInput(JSON.parse(t.requirements_json)));
 const assessments=rows=>rows.map(row=>{const {assessmentId,planId,stepId,expectedRequirementsDigest,...assessment}=JSON.parse(row.assessment_json);return {assessmentId:row.assessment_id,revision:row.revision,recordedAt:row.recorded_at,requirements:JSON.parse(row.requirements_json),needsRevision:row.requirements_digest!==digests.get(row.plan_id+":"+(row.step_id||"")),assessment:{formatVersion:1,...assessment}};});
 const plans=data.plans.sort((a,b)=>a.registered_at-b.registered_at||a.plan_id.localeCompare(b.plan_id)).map(row=>{
  const get=key=>related[key].get(row.plan_id)||[],intervals=get("intervals").sort((a,b)=>a.start_ms-b.start_ms),steps=get("steps").sort((a,b)=>a.ordinal-b.ordinal),measured=row.first_started_at!=null,end=row.finished_at??row.deleted_at??nowMs,activeMs=measured?calculateActiveMs(intervals,nowMs):null,calendarMs=measured?Math.max(0,end-row.first_started_at):null,incomplete=steps.filter(step=>step.status!=="DONE").length;
  return {planId:row.plan_id,title:row.title,description:row.description,acceptanceCriteria:row.acceptance_criteria,...(documents.has(row.plan_id)?{planText:documents.get(row.plan_id)}:{}),planCreatedAt:exportPlanDate(row.plan_created_precision,row.plan_created_at_ms,row.plan_created_on,row.plan_created_timezone),registeredAt:row.registered_at,status:row.status,deletedAt:row.deleted_at,firstStartedAt:row.first_started_at,finishedAt:row.finished_at,sourceReference:row.source_reference,
   completion:{trackerEnabled:steps.length>0,incompleteStepCount:incomplete,readyToFinish:row.deleted_at==null&&incomplete===0},activeMs,calendarMs,pausedMs:calendarMs==null?null:Math.max(0,calendarMs-activeMs),intervals:intervals.map(i=>({intervalId:i.interval_id,startMs:i.start_ms,endMs:i.end_ms})),
   dateHistory:get("dates").sort((a,b)=>a.changed_at-b.changed_at).map(d=>({previous:exportPlanDate(d.old_precision,d.old_at_ms,d.old_on,d.old_timezone),changedAt:d.changed_at,reason:d.reason})),
   assessments:assessments(get("assessments").filter(a=>a.step_id==null)),
   steps:steps.map(step=>({stepId:step.step_id,ordinal:step.ordinal,title:step.title,content:step.content,status:step.status,version:step.version,createdAt:step.created_at,updatedAt:step.updated_at,readyToFinish:step.status==="DONE",intervals:data.stepIntervals.filter(i=>i.step_id===step.step_id).sort((a,b)=>a.start_ms-b.start_ms).map(i=>({startMs:i.start_ms,endMs:i.end_ms})),assessments:assessments(get("assessments").filter(a=>a.step_id===step.step_id))})),
   frozenForecast:frozen.has(row.plan_id) ? parseColumn(frozen.get(row.plan_id).forecast_json) : null,
   finishExceptions:get("exceptions").map(e=>({reason:e.reason,recordedAt:e.created_at}))};
 });
 const included=plans.filter(p=>p.deletedAt==null),measured=included.filter(p=>p.activeMs!=null),union=unionIntervals(included.flatMap(p=>p.intervals.map(i=>[i.startMs,i.endMs??nowMs])));
 const training={samples:data.samples.map(atlmSampleView),models:data.models.filter(m=>m.method_version===ATLM_METHOD.version && m.feature_version===ATLM_FEATURE_VERSION).map(m=>({
   modelId:m.model_id,modelVersion:m.model_version,status:m.status,methodVersion:m.method_version,featureVersion:m.feature_version,
   manifest:parseColumn(m.manifest_json),datasetDigest:m.dataset_digest,trainCutoff:m.train_cutoff,evaluation:parseColumn(m.metrics_json),
   sampleCount:m.sample_count,reason:m.reason,createdAt:m.created_at,activatedAt:m.activated_at})),
   attempts:data.attempts.filter(a=>a.method_version===ATLM_METHOD.version && a.feature_version===ATLM_FEATURE_VERSION).map(a=>({
     attemptId:a.attempt_id,startedAt:a.started_at,completedAt:a.completed_at,methodVersion:a.method_version,featureVersion:a.feature_version,
     datasetRevision:a.dataset_revision,manifest:parseColumn(a.manifest_json),diagnostics:parseColumn(a.diagnostics_json),cases:parseColumn(a.case_ids_json),
     metrics:parseColumn(a.metrics_json),selected:parseColumn(a.selected_json),reason:a.reason}))};
 return {formatVersion:3,training,exportedAt:nowMs,timezone:data.settings[0]?.timezone||"UTC",summary:{planCount:included.length,deletedPlanCount:plans.length-included.length,measuredPlanCount:measured.length,totalActiveMs:measured.length?union.reduce((n,[a,b])=>n+Math.max(0,b-a),0):null,sumPlanActiveMs:measured.length?measured.reduce((n,p)=>n+p.activeMs,0):null},plans};
}

async function readTrackerCapabilities(db,ownerId){return {
 available:true,schemaVersion:2,version:TRACKER_VERSION,
    assessments: { formatVersion: 1, recordTool: "RecordAssessment", getTool: "GetAssessment", historyTool: "GetEstimationHistory",
      immutableRevisions: true, agentDefinedMethods: true, maxPayloadBytes: V4_TASK_MAX_BYTES, maxJsonDepth: 12,
      forecastUnits: "ms", forecastMetrics: FORECAST_METRICS, initialExpectedVersion: 0, requirementsDigest: true,
      contextRead: { tool: "GetAssessment", omitAssessmentId: true }, expectedRequirementsDigestRequired: true,
      historyMaxTargets: 20, historyMaxLimit: 100, methodologyControlsExecution: false,
      atlm: { formatVersion: 1, method: { ...ATLM_METHOD }, inputSchemaVersion: "agent-task-v3", featureSchemaVersion: ATLM_FEATURE_VERSION, metric: "PLAN_ACTIVE",
        policyVersion: ATLM_POLICY_VERSION, engines: ["OLS", "RIDGE", "BAYESIAN"], intervalEngines:["BAYESIAN_PREDICTIVE","BAYES_QUANTILE"],
        execution: { environmentId: { optional: true, type: ["string", "null"], closedSet: true,
          values: [...ENVIRONMENT_IDS], unknownValue: null,
          description: "Допустимые значения: local, cloud_workspace; null означает неизвестную среду." } },
        predictionScope: "FULL_FROM_FIRST_START", plannedForecastMode:"CURRENT_READ_ONLY", firstStartForecast:"FROZEN_SNAPSHOT", earlyForecastMethod:{...HISTORICAL_MEDIAN_METHOD}, retrainEveryNewPlans: ATLM_RETRAIN_EVERY_NEW_PLANS,
        calculateTool: "CalculateAtlmEstimate", planEstimateTool: "GetPlanEstimate", modelStatusTool: "GetEstimationModelStatus",
        processTool: "ProcessEstimationTraining", startTrainingTool: "StartEstimationTraining", datasetTool: "GetAtlmDataset", historyTool:"GetEstimationTrainingHistory", predictionRequest: { method: "ATLM", methodVersion: 1 },
        limits: { maxTrainingSamples: 5000, datasetDefaultLimit: 50, datasetMaxLimit: 100, historyDefaultLimit:50, historyMaxLimit:100 } },
      },

 planDocuments:{available:true,format:"markdown",createField:"planText",stageHeadings:"## Этап 1. Название",statusTool:"SetStepStatus",statuses:["PENDING","RUNNING","BLOCKED","FAILED","DONE"],preservesOriginal:true},
 steps:{model:"current-state",statusHistory:false,versionRequired:true,timing:{available:true,unit:"ms",startStatus:"RUNNING",excludesPlanPauses:true,historyBackfilled:false}},
 planDeletion:{softDelete:true,deleteTool:"DeletePlan",restoreTool:"RestorePlan",deletedFilter:"deleted",restoreStartsTimer:false},
 parallelPlans:true,planList:{tool:"ListPlans",statuses:PLAN_STATUSES,defaultLimit:50,maxLimit:MAX_PLAN_PAGE_SIZE,order:PLAN_LIST_ORDER,deletedDefault:false},
 analytics:{totalActiveMs:"union of owner intervals",activeByDay:"union by local day",sumPlanActiveMs:"sum of per-plan intervals"},exportFormatVersion:3
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
      const end = Math.min(interval.end_ms ?? nowMs, nowMs);
      let cursor = Math.max(interval.start_ms, range.startMs);
      const stop = Math.min(end, range.endMs);
      if (stop <= cursor) continue;
      clippedTotal += stop - cursor;
      clippedIntervals.push([cursor, stop]);
    }
    sumPlanActiveMs += clippedTotal;
    const fullActive = plan.first_started_at == null || intervals.length === 0 ? null : intervals.reduce((sum, interval) =>
      sum + Math.max(0, Math.min(interval.end_ms ?? nowMs, nowMs) - interval.start_ms), 0);
    const finishedInRange = plan.status === "COMPLETED" && plan.finished_at <= nowMs && plan.finished_at >= range.startMs && plan.finished_at < range.endMs;
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
.period-filter,.period-filter .toolbar,.period-filter .metrics,.period-filter .metric{min-width:0;max-width:100%}.period-filter .metric{overflow-wrap:anywhere}.period-filter .toolbar>button{min-width:0;max-width:100%;overflow-wrap:anywhere}
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
@media(max-width:600px){#view-detail{grid-template-columns:minmax(0,1fr)}#view-detail>.panel,#planDetail,.document-plan,.document-plan .tracker-list,.document-plan .tracker-card,.document-plan .tracker-card-body{min-width:0;max-width:100%}.plan-table-scroll{overflow:visible}.plan-prose table{table-layout:fixed}.plan-prose :is(th,td){padding:8px 4px;white-space:normal;overflow-wrap:anywhere;word-break:break-word}.plan-prose pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;overflow-x:visible}}
@media(max-width:600px){.document-plan .tracker-collapse-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.tracker-collapse-actions>button{min-width:0;white-space:normal;overflow-wrap:anywhere}}
`;

const UI_ANALYTICS_CSS = String.raw`
/* Hallmark · component: stage duration chart · genre: modern-minimal · theme: existing Console Paper · data: measured · v2.0.0 */
/* Critique: full stage names and exact times stay visible; one accent and a zero baseline make comparison direct. */
details.analytics-plan{padding:8px 12px}
.stage-chart-body{padding:8px 0 24px;min-width:0}.stage-chart-body h3{margin:8px 0 12px;font-size:var(--text-lg);font-weight:500}
.stage-chart-note,.stage-axis,.stage-value,.stage-axis-unit{font-size:var(--text-sm);color:var(--ink-2);font-variant-numeric:tabular-nums}
.stage-chart-note{max-width:75ch;margin:12px 0;overflow-wrap:anywhere}
.stage-rows{list-style:none;padding:0;margin:0}.stage-row,.stage-axis-row{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr) 110px;gap:16px;align-items:center}
.stage-row{padding:16px 0;border-top:1px solid var(--line)}.stage-row:last-child{border-bottom:1px solid var(--line)}
.stage-title{min-width:0;overflow-wrap:anywhere;font-size:var(--text-sm)}.stage-value,.stage-axis-unit{text-align:right;color:var(--ink);overflow-wrap:anywhere}
.stage-bar{display:block;width:100%;height:24px;color:var(--blue)}.stage-bar rect{fill:currentColor}.stage-bar line{stroke:var(--line-strong);stroke-width:1;vector-effect:non-scaling-stroke}
.stage-axis{grid-column:2;display:flex;justify-content:space-between;gap:8px;margin-bottom:8px}.stage-axis span{min-width:0}
.analytics-plan>summary{cursor:pointer;min-height:44px;gap:16px}.analytics-plan>summary:focus-visible,.stage-chart-body button:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
.analytics-plan>summary:hover .row-title{color:var(--ink-2)}.analytics-plan>summary:active{background:var(--paper-3)}
@media(max-width:600px){.stage-row,.stage-axis-row{grid-template-columns:minmax(0,1fr) 100px;gap:8px 12px}.stage-title{grid-column:1/-1}.stage-axis{grid-column:1}.stage-value,.stage-axis-unit{grid-column:2}.stage-row{padding:16px 0}.analytics-plan>summary{align-items:flex-start}}
`;

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
function stageDuration(ms){
 if(ms===null)return "Нет данных";
 const minutes=Math.floor(ms/60000),seconds=Math.floor(ms%60000/1000),millis=ms%1000;
 return minutes+" мин"+(seconds?" "+seconds+" с":"")+(millis?" "+millis+" мс":"");
}
function renderStageChart(body,data){
 const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
 if(!Array.isArray(data.steps)||!data.steps.every(s=>typeof s.title==="string"&&(s.activeMs===null||Number.isSafeInteger(s.activeMs)&&s.activeMs>=0)))throw new Error("Не удалось прочитать время этапов.");
 body.replaceChildren(make("h3","Записанное время этапов"));
 body.append(make("p","С "+data.period.from+" по "+data.period.to+" включительно, "+data.period.timeZone+".","stage-chart-note"));
 if(!data.steps.length){body.append(make("p","На момент отчёта в плане нет этапов.","stage-chart-note"));return;}
 const max=Math.max(60000,...data.steps.map(s=>s.activeMs||0)),axisRow=make("div",null,"stage-axis-row"),axis=make("div",null,"stage-axis");
 for(const value of [0,max/2,max])axis.append(make("span",new Intl.NumberFormat("ru-RU",{maximumFractionDigits:2}).format(value/60000)));
 const unit=make("span","Минуты","stage-axis-unit");axisRow.setAttribute("aria-hidden","true");axisRow.append(axis,unit);body.append(axisRow);
 const rows=make("ol",null,"stage-rows");rows.setAttribute("aria-label","Длительность выполнения этапов");
 for(const step of data.steps){
   const row=make("li",null,"stage-row"),title=make("span",step.title,"stage-title"),value=make("span",stageDuration(step.activeMs),"stage-value");
   const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox","0 0 1000 24");svg.setAttribute("preserveAspectRatio","none");svg.setAttribute("aria-hidden","true");svg.classList.add("stage-bar");
   for(const x of [0,500,1000]){const line=document.createElementNS(svg.namespaceURI,"line");line.setAttribute("x1",x);line.setAttribute("x2",x);line.setAttribute("y1",0);line.setAttribute("y2",24);svg.append(line);}
   if(step.activeMs>0){const rect=document.createElementNS(svg.namespaceURI,"rect");rect.setAttribute("width",1000*step.activeMs/max);rect.setAttribute("height",14);rect.setAttribute("y",5);rect.setAttribute("rx",2);svg.append(rect);}
   row.append(title,svg,value);rows.append(row);
 }
 body.append(rows,make("p","Учитывается время со статусом «Выполняется», за вычетом пауз плана. Параллельные этапы измеряются независимо: их сумма может превышать время плана. Старое время без измерений не восстанавливается; «Нет данных» отличается от измеренных 0 минут.","stage-chart-note"));
}
function renderAnalyticsPlanCards(list,report){
 const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
 for(const plan of report.plans){
   const card=make("details",null,"analytics-plan"),summary=make("summary",null,"row"),title=make("span",plan.title,"row-title"),value=make("span",duration(plan.activeInPeriodMs),"analytics-plan-meta"),body=make("div",null,"stage-chart-body");
   card.dataset.planId=plan.planId;summary.append(title,value);card.append(summary,body);list.append(card);
   let pending=false,loaded=false;
   async function load(){
     if(pending||loaded||!card.isConnected)return;pending=true;body.setAttribute("aria-busy","true");body.replaceChildren(make("p","Загружаем время этапов…","stage-chart-note"));
     try{
       const query=new URLSearchParams({from:report.period.from,to:report.period.to,timeZone:report.period.timeZone,asOf:String(report.asOf)});
       const data=await call("/api/analytics/plans/"+encodeURIComponent(plan.planId)+"/steps?"+query);
       if(!card.isConnected)return;if(data.planId!==plan.planId)throw new Error("Ответ относится к другому плану.");renderStageChart(body,data);loaded=true;
     }catch(error){
       if(!card.isConnected)return;const message=make("p","Не удалось загрузить график. "+error.message,"error"),retry=make("button","Повторить загрузку");message.setAttribute("role","alert");retry.type="button";retry.addEventListener("click",load);body.replaceChildren(message,retry);
     }finally{pending=false;body.removeAttribute("aria-busy");}
   }
   card.addEventListener("toggle",()=>{if(card.open)load();});
 }
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
  let pager=q("#"+kind+"Pager");
  if(!items.length){
    pager?.remove();
    if(emptyText){
      const empty=document.createElement("p");
      empty.className="muted";
      empty.textContent=emptyText;
      list.append(empty);
    }
    return;
  }
  items.slice(page*pageSize,(page+1)*pageSize).forEach(plan=>{
    const row=card(plan),period=kind==="plans"&&(periodPlans?.get(plan.planId)||(includeRunningNow&&plan.status==="RUNNING"?{activeInPeriodMs:0}:null));
    if(period){
      const meta=row.querySelector(".row-meta");
      meta.textContent+=" · за период: "+(period.activeInPeriodMs>0?duration(period.activeInPeriodMs):"без активности");
    }
    list.append(row);
  });
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
  pager.querySelector(".pager-summary").textContent=(page*pageSize+1)+"–"+Math.min((page+1)*pageSize,items.length)+" из "+items.length;
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
    const panel=make("article",null,"panel period-filter"),heading=make("h2",title),toolbar=make("div",null,"toolbar");
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
  const reasons={AVAILABLE:"Модель успешно обучена.",MISSING_REQUIRED_FEATURES:"Нужны признаки задачи.",HISTORY_RESET:"Нет нового прогноза для ранее начатого плана.",TRAINING_TIME_BUDGET:"Обучение не завершилось в отведённое время.",COLLECTING_DATA:"Пока недостаточно проверенных завершённых планов.",INCOMPLETE_FEATURES:"Для прогноза не хватает исходных сведений о задаче.",UNSUPPORTED_CATEGORY:"В накопленной истории ещё нет опыта для этого вида задачи.",MODEL_INVALIDATED:"Исходные данные модели изменились; требуется пересборка.",INVALID_PREDICTION:"Модель не смогла получить корректную оценку.",UNSUPPORTED_FORECAST_SCOPE:"Прогноз доступен для полного плана до первого запуска.",DATASET_LIMIT_REACHED:"Накопленные данные сохранены, но превышен текущий предел обучения.",RANK_DEFICIENT:"Данных пока недостаточно для независимой оценки влияния признаков.",MODEL_CAPACITY_LIMIT:"Превышен ресурсный предел числа коэффициентов модели. История сохранена.",INSUFFICIENT_DATA:"Пока недостаточно пригодных данных для обучения и проверки.",INSUFFICIENT_VALIDATION:"Пока недостаточно случаев для проверки новой модели.",INSUFFICIENT_EVALUATION_CASES:"В последней попытке не хватило проверочных сравнений. Новая версия допускает ранний прогноз с неподтверждённым качеством.",INSUFFICIENT_INCUMBENT_CASES:"Для замены действующей модели недостаточно независимых сравнений с ней.",MEDIAN_BASELINE_BETTER:"Новая модель ошибается сильнее обычной медианы прошлых длительностей.",MEDIAN_BASELINE_NOT_WORSE:"Медиана прошлых длительностей не хуже проверенных обучаемых способов. Новая обученная модель не активирована.",CANDIDATE_COVERAGE_WORSE:"Новая модель даёт прогноз для меньшей доли задач, чем действующая.",CANDIDATE_MAE_WORSE:"Средняя ошибка новой модели выше, чем у действующей.",SNAPSHOT_INVALIDATED:"Исходные данные изменились; подготовлена новая попытка обучения.",LEASE_EXPIRED:"Предыдущая обработка не завершилась вовремя; её состояние сохранено.",TRAINING_EXECUTION_FAILED:"Во время обучения произошёл технический сбой.",SOURCE_UNAVAILABLE:"Источник данных временно недоступен.",INVALID_ESTIMATION_SOURCE:"Сохранённый источник оценки не удалось проверить.",AVAILABLE:"Модель успешно обучена.",
    MISSING_FEATURES:"До первого запуска не сохранены исходные признаки.",INVALID_FEATURES:"Исходные признаки не соответствуют схеме.",PLAN_DELETED:"План удалён.",PLAN_NOT_COMPLETED:"План ещё не завершён.",RESULT_NOT_VERIFIED:"Результат и обязательные проверки не подтверждены.",SCOPE_CHANGED:"После начала изменился объём задачи.",INCOMPLETE_MEASUREMENT:"Нет полного подтверждённого измерения активного времени."};
  const statuses={IDLE:"Ожидание новых планов",QUEUED:"Обучение в очереди",RUNNING:"Модель обучается",RETRY_WAIT:"Ожидание повторной попытки",COLLECTING_DATA:"Накапливаем опыт",REJECTED:"Новая модель не прошла проверку",FAILED:"Не удалось завершить обучение"};
  const style=make("style");style.textContent=".atlm-panel{min-width:0;overflow-wrap:anywhere}.atlm-panel p{margin:9px 0}.atlm-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}.atlm-heading h2,.atlm-heading h3{margin:0}.atlm-panel button{min-height:44px;white-space:normal}.atlm-controls{display:flex;gap:8px;flex-wrap:wrap}.atlm-point{font-size:1.35rem;font-weight:700;color:var(--ink)}.atlm-plan-estimate{margin:18px 0;padding:16px;border:1px solid var(--line-strong,var(--line));border-radius:var(--radius,10px);background:var(--paper-3,var(--panel))}.atlm-note{color:var(--ink-2,var(--muted));font-size:.9rem}.atlm-stale{border-left:3px solid var(--amber,var(--amber));padding-left:10px}.atlm-range-text,.atlm-fact{font-variant-numeric:tabular-nums}.atlm-scale{height:14px;position:relative;margin:18px 6px;background:var(--paper-2);border-radius:8px}.atlm-band{position:absolute;height:8px;top:3px;background:var(--amber);border-radius:8px}.atlm-marker,.atlm-fact-marker{position:absolute;top:0;height:14px;border-left:3px solid var(--ink)}.atlm-fact-marker{border-color:var(--blue)}.atlm-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:1px;background:var(--line);border:1px solid var(--line)}.atlm-metric{display:grid;gap:8px;padding:12px;background:var(--paper-2)}.atlm-metric strong{font-variant-numeric:tabular-nums}.atlm-metrics-help{margin:16px 0}.atlm-attempts{margin-top:24px}.atlm-table-wrap{max-width:100%;overflow-x:auto}.atlm-table-wrap table{width:100%;border-collapse:collapse;text-align:left;font-size:.9rem}.atlm-table-wrap th,.atlm-table-wrap td{padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}.atlm-panel summary{min-height:44px;display:flex;align-items:center;cursor:pointer}.atlm-panel summary::before{content:'▸';margin-right:6px}.atlm-panel details[open]>summary::before{content:'▾'}.atlm-table-wrap:focus-visible{outline:3px solid var(--amber-text);outline-offset:2px}.atlm-features{margin-top:16px}.atlm-features dl{display:grid;grid-template-columns:minmax(8rem,1fr) minmax(0,2fr);gap:6px 12px}.atlm-features dd{margin:0}.atlm-features h4{margin:14px 0 4px}@media(max-width:390px){.atlm-heading{align-items:flex-start}.atlm-controls{width:100%}.atlm-controls button{flex:1 1 100%}}";document.head.append(style);
  let supported=false,capabilityPending=false,planToken=0,planAbort=null,statusPending=null,pollTimer=null,pollsLeft=0,autoBudget=8,processPending=false,startPending=false,lastProcessFailure=null,latestStatus=null,recoveryAction=null;
  const processed=new Set();
  const statusPanel=make("article",null,"panel atlm-panel");statusPanel.id="atlm-model-status";statusPanel.setAttribute("aria-labelledby","atlm-model-heading");
  const statusHeading=make("h2","Накопление опыта");statusHeading.id="atlm-model-heading";
  const statusBody=make("div");statusBody.setAttribute("role","status");statusBody.setAttribute("aria-live","polite");
  const startTraining=button("Начать обучение",trainingAction);
  const controls=make("div",null,"atlm-controls");controls.append(startTraining);
  const attemptsRegion=make("section",null,"atlm-attempts");attemptsRegion.append(make("h3","Попытки обучения"));
  const attemptsBody=make("div","Загружаем историю…");attemptsBody.setAttribute("aria-live","polite");attemptsRegion.append(attemptsBody);
  statusPanel.append(statusHeading,statusBody,controls,attemptsRegion);
  let attemptsToken=0,attemptsCursor=null,attemptsRows=[];
  async function loadAttempts(more=false){
    const token=++attemptsToken;if(!more){attemptsRows=[];attemptsCursor=null;attemptsBody.replaceChildren(make("p","Загружаем историю…","atlm-note"));}
    try{
      const query=attemptsCursor?"?limit=50&cursor="+encodeURIComponent(attemptsCursor):"?limit=50";
      const page=await api("/api/tracker/estimation-training-history"+query);
      if(token!==attemptsToken)return;
      if(!Array.isArray(page.rows))throw new Error("Неполная история обучения.");
      attemptsRows.push(...page.rows);attemptsCursor=page.nextCursor;attemptsBody.replaceChildren();
      if(!attemptsRows.length){attemptsBody.append(make("p","Попыток обучения пока нет.","atlm-note"));return;}
      const wrap=make("div",null,"atlm-table-wrap"),table=make("table"),head=make("thead"),headRow=make("tr");
      wrap.setAttribute("tabindex","0");wrap.setAttribute("role","region");wrap.setAttribute("aria-label","Таблица попыток обучения");
      for(const label of ["Дата","Примеры","Точка","Интервал","Результат","Причина"])headRow.append(make("th",label));head.append(headRow);table.append(head);
      const tbody=make("tbody");for(const item of attemptsRows.slice().reverse()){
        const row=make("tr"),date=Number.isSafeInteger(item.startedAt)?new Intl.DateTimeFormat("ru-RU",{dateStyle:"short",timeStyle:"short",timeZone:document.querySelector("#tz")?.value||"UTC"}).format(new Date(item.startedAt)):"—";
        const reason=item.reason?reasonText(item.reason):(item.completedAt===null?"Выполняется":"Модель обучена");
        const outcome=item.completedAt===null?"В работе":!item.reason?"Завершено":item.reason.startsWith("INSUFFICIENT_")?"Недостаточно данных":
          ["LEASE_EXPIRED","TRAINING_EXECUTION_FAILED","SOURCE_UNAVAILABLE","INVALID_ESTIMATION_SOURCE","TRAINING_TIME_BUDGET","DATASET_LIMIT_REACHED"].includes(item.reason)?"Обучение не завершилось":"Кандидат не заменил модель";
        for(const text of [date,Array.isArray(item.manifest)?String(item.manifest.length):"—",item.selected?.point?.selectedEngine??"—",item.selected?.interval?.selectedEngine??"—",outcome]){row.append(make("td",text));}
        const cell=make("td"),details=make("details");details.append(make("summary",reason));
        for(const [name,value] of Object.entries(item.diagnostics?.candidates||{}))details.append(make("p",name+": "+(value.status||"—")+(value.reason?", "+reasonText(value.reason):""),"atlm-note"));
        cell.append(details);row.append(cell);tbody.append(row);
      }table.append(tbody);wrap.append(table);attemptsBody.append(wrap);
      if(attemptsCursor)attemptsBody.append(button("Показать ещё",()=>loadAttempts(true)));
    }catch(error){if(token!==attemptsToken)return;attemptsBody.replaceChildren(make("p","Не удалось загрузить историю. "+error.message,"error"),button("Повторить загрузку истории",()=>loadAttempts()));}
  }
  function updateControls(){
    startTraining.disabled=startPending||processPending||statusPending!==null;
    const stalled=latestStatus?.training.due&&(autoBudget<=0||processed.has(queueKey(latestStatus)));
    startTraining.textContent=startPending?"Запускаем обучение…":statusPending!==null?"Проверяем состояние…":recoveryAction==="status"?"Проверить состояние":recoveryAction==="process"||stalled||latestStatus?.training.due?"Продолжить обработку":["QUEUED","RUNNING","RETRY_WAIT"].includes(latestStatus?.training.status)?"Проверить состояние":"Начать обучение";
  }
  function trainingAction(){
    if(startPending||processPending||statusPending)return;
    if(recoveryAction==="status")return loadStatus(false);
    if(recoveryAction==="process"||latestStatus?.training.due||["QUEUED","RUNNING","RETRY_WAIT"].includes(latestStatus?.training.status)){
      autoBudget=8;processed.clear();lastProcessFailure=null;recoveryAction=null;pollsLeft=3;return loadStatus(true);
    }
    return requestTraining();
  }
  async function requestTraining(){
    if(startPending||processPending||statusPending)return;
    statusBody.querySelectorAll(".atlm-start-feedback,.atlm-process-feedback").forEach(message=>message.remove());lastProcessFailure=null;
    startPending=true;clearTimeout(pollTimer);statusPanel.setAttribute("aria-busy","true");updateControls();
    startTraining.textContent="Запускаем обучение…";
    try{
      const data=await api("/api/tracker/estimation-model/start",{method:"POST",body:"{}"});
      lastProcessFailure=null;recoveryAction=null;processed.clear();autoBudget=8;pollsLeft=3;showStatus(data);loadAttempts();
      const pending=data.training.due||["QUEUED","RUNNING","RETRY_WAIT"].includes(data.training.status);
      statusBody.append(make("p",pending?"Запрос принят. Обработка ещё не завершена.":"Попытка обучения завершена. Результат показан выше.","atlm-note atlm-start-feedback"));
      schedulePoll();
    }catch(error){
      recoveryAction="status";lastProcessFailure="Не удалось подтвердить запуск обучения. "+error.message+" Обновите состояние перед повторным запуском.";
      statusBody.append(make("p",lastProcessFailure,"error atlm-start-feedback"));
    }finally{startPending=false;startTraining.textContent="Начать обучение";statusPanel.removeAttribute("aria-busy");updateControls();}
  }
  async function api(path,options={}){
    const response=await fetch(path,{cache:"no-store",...options,headers:{"content-type":"application/json",...options.headers}});
    const data=await response.json().catch(()=>null);
    if(!response.ok){const error=new Error(data?.error?.message||"Не удалось получить ответ сервера.");error.code=data?.error?.code;throw error;}
    if(!data||typeof data!=="object")throw new Error("Сервер вернул неполный ответ. Повторите загрузку.");return data;
  }
  function reasonText(reason){return reasons[reason]||"Расчёт недоступен. Причина: "+String(reason)+".";}
  function diagnosticText(value){return typeof value?.message==="string"?value.message:null;}
  function forecastMethodLabel(model){
    if(model.method?.id==="historical-median")return "Ориентир — медиана прошлых задач";
    const engine=model.hybrid?.usedEngine||model.hybrid?.selectedEngine;
    if(engine==="BAYESIAN")return "ATLM: Bayesian";
    if(engine==="RIDGE")return "ATLM — ridge";
    if(engine==="OLS"||model.method?.version==="agent-v2")return "ATLM — обычная регрессия";
    return "ATLM";
  }
  function intervalText(interval){return interval?.status==="AVAILABLE" ? minutes(interval.lowerMs)+" – "+minutes(interval.upperMs) : "Нет диапазона";}
  function addTimeline(target,estimate,actual){
    const interval=estimate.interval, point=estimate.pointMs;
    if(interval?.status!=="AVAILABLE") {target.append(make("p","Нет диапазона: "+reasonText(interval?.unavailableReason||"COLLECTING_DATA"),"atlm-note"));return;}
    target.append(make("p","Диапазон: "+intervalText(interval)+". Охват: цель 80%.","atlm-range-text"));
    target.append(make("p",interval.validationStatus==="HISTORICALLY_EVALUATED"?"Проверен на истории":"Экспериментальный","atlm-note"));
    const scale=make("div",null,"atlm-scale"),band=make("span",null,"atlm-band"),marker=make("span",null,"atlm-marker");
    const max=Math.max(1,point,interval.upperMs,Number.isSafeInteger(actual)?actual:0);
    band.style.left=(100*interval.lowerMs/max)+"%";band.style.width=(100*(interval.upperMs-interval.lowerMs)/max)+"%";
    marker.style.left=(100*point/max)+"%";scale.setAttribute("aria-hidden","true");scale.append(band,marker);
    if(Number.isSafeInteger(actual)){const fact=make("span",null,"atlm-fact-marker");fact.style.left=(100*actual/max)+"%";scale.append(fact);}
    target.append(scale);
  }
  function addTaskFeatures(target,task,failed,retry){
    const details=make("details",null,"atlm-features");details.append(make("summary","Признаки"));
    if(failed){details.append(make("p","Не удалось загрузить признаки.","error"),button("Повторить загрузку признаков",retry));target.append(details);return;}
    if(!task){details.append(make("p","Нужны признаки.","atlm-note"));target.append(details);return;}
    const groups=[["Работа",["workUnits","doneBoundary","reuseLevel"]],["Изменения",["components","contracts","integrations","migrationEntities","dataVolumeBand"]],
      ["Неопределённость",["requirementsUncertainty","solutionUncertainty","diagnosisState","unfamiliarTechnologies","scopeChangeRisk"]],
      ["Проверки",["verificationKinds","verificationScenarios","verificationReadiness","requiredReviewPasses"]],["Исполнение",["environmentReadiness","accessReadiness","deploymentTargets","execution"]]];
    const names={workUnits:"Результаты",doneBoundary:"Граница готовности",reuseLevel:"Основа",components:"Компоненты",contracts:"Контракты",integrations:"Интеграции",migrationEntities:"Миграция",dataVolumeBand:"Объём данных",requirementsUncertainty:"Неопределённость требований",solutionUncertainty:"Неопределённость решения",diagnosisState:"Диагностика",unfamiliarTechnologies:"Неизученные технологии",scopeChangeRisk:"Риск изменения границ",verificationKinds:"Виды проверок",verificationScenarios:"Сценарии",verificationReadiness:"Готовность проверок",requiredReviewPasses:"Независимые ревью",environmentReadiness:"Среда",accessReadiness:"Доступы",deploymentTargets:"Цели развёртывания",execution:"Исполнение"};
    const display=value=>value===null||value===undefined||value==="UNKNOWN"?"Неизвестно":Array.isArray(value)?(value.length?value.map(item=>typeof item==="object"?(item.description||item.key||item.id||item.kind):item).join(", "):"Нет"):typeof value==="object"?Object.entries(value).map(([key,item])=>key+": "+display(item)).join(", "):String(value);
    for(const [title,keys] of groups){details.append(make("h4",title));const list=make("dl");for(const key of keys){list.append(make("dt",names[key]),make("dd",display(task[key])));}details.append(list);}target.append(details);
  }
  function appendQuality(target,model){
    const evaluation=model.evaluation,n=model.sampleCount,k=evaluation?.pointCaseCount;
    target.append(make("p",Number.isSafeInteger(n)&&n>=1?"В обучении использовано планов: "+n+".":"Размер обучающей выборки не сохранён.","atlm-note"));
    target.append(make("p",Number.isSafeInteger(k)&&k>=0?"Проверено прогнозов: "+k+".":"Число проверенных прогнозов не сохранено.","atlm-note"));
    const fullPolicy=evaluation?.metricsScope==="FULL_POLICY";
    if(fullPolicy&&Number.isSafeInteger(evaluation.modelCaseCount)&&Number.isSafeInteger(k))target.append(make("p","В сравнениях обученная модель использована: "+evaluation.modelCaseCount+" из "+k+".","atlm-note"));
    const confirmed=model.accuracy==="HISTORICALLY_EVALUATED"&&Number.isSafeInteger(k)&&k>=5&&(!fullPolicy||evaluation.modelCaseCount>=5);
    const quality=make("p",null,"atlm-note atlm-quality");
    quality.append(make("strong",confirmed?"Проверен на истории":"Экспериментальный"));target.append(quality);
    if(Number.isSafeInteger(k)&&k>0&&Number.isFinite(evaluation?.maeMs)&&evaluation.maeMs>=0)target.append(make("p",(fullPolicy?"Средняя ошибка гибрида с запасным прогнозом: ":"Средняя ошибка прошлых проверок: ")+minutes(evaluation.maeMs)+". Это не гарантия длительности.","atlm-note"));
    else target.append(make("p","Ошибка пока не оценена.","atlm-note"));
    if(fullPolicy&&Number.isFinite(evaluation.medianBaselineMaeMs))target.append(make("p","Ошибка медианы на тех же задачах: "+minutes(evaluation.medianBaselineMaeMs)+".","atlm-note"));
    if(fullPolicy&&Number.isSafeInteger(evaluation.profileGroupCount))target.append(make("p","Разных профилей задач: "+evaluation.profileGroupCount+". Похожие задачи ограничивают выводы о качестве на другой работе.","atlm-note"));
  }
  function showStatus(data){
    if(!data.training||!statuses[data.training.status]||![data.newPlansSinceTraining,data.eligibleSampleCount,data.excludedSampleCount].every(value=>Number.isSafeInteger(value)&&value>=0)||!Number.isSafeInteger(data.retrainEveryNewPlans)||data.retrainEveryNewPlans<1||typeof data.training.due!=="boolean"||!Object.hasOwn(data,"activeModel")||(data.activeModel!==null&&(!Number.isSafeInteger(data.activeModel.sampleCount)||data.activeModel.sampleCount<1)))throw new Error("Не удалось прочитать состояние обучения.");
    const exclusionsOpen=statusBody.querySelector(".atlm-exclusions")?.open===true,methodOpen=statusBody.querySelector(".atlm-method")?.open===true;
    latestStatus=data;
    statusBody.replaceChildren();statusBody.append(make("p",statuses[data.training.status]));
    statusBody.append(make("p","Новых пригодных планов: "+count(data.newPlansSinceTraining)+". Начать обучение можно в любое время."));
    statusBody.append(make("p","Автоматическое обучение запускается после "+data.retrainEveryNewPlans+" новых пригодных планов. Для ручного запуска ждать не нужно.","atlm-note"));
    statusBody.append(make("p",data.training.due?"Новые планы ожидают обработки.":"До следующего автоматического обучения: "+Math.max(0,data.retrainEveryNewPlans-data.newPlansSinceTraining)+".","atlm-note"));
    statusBody.append(make("p","Всего пригодных планов: "+count(data.eligibleSampleCount)+". Исключено: "+count(data.excludedSampleCount)+".","atlm-note"));
    if(Array.isArray(data.exclusionReasons)&&data.exclusionReasons.length){
      const disclosure=make("details",null,"atlm-exclusions"),list=make("ul");disclosure.open=exclusionsOpen;disclosure.append(make("summary","Почему планы не учитываются"));
      for(const item of data.exclusionReasons)if(typeof item.reason==="string"&&Number.isSafeInteger(item.count)&&item.count>0)list.append(make("li",reasonText(item.reason)+" Планов: "+item.count+"."));
      disclosure.append(list,make("p","У одного плана может быть несколько причин.","atlm-note"));statusBody.append(disclosure);
    }
    if(data.activeModel){statusBody.append(make("p","Действующая модель: "+String(data.activeModel.modelVersion||data.activeModel.modelId)+".","atlm-note"),make("p","Точка: "+(data.activeModel.hybrid?.selectedEngine||"—")+". Интервал: "+(data.activeModel.hybrid?.intervalEngine||"—")+".","atlm-note"));appendQuality(statusBody,data.activeModel);}
    if(data.training.status==="REJECTED"&&data.activeModel)statusBody.append(make("p","Предыдущая пригодная модель продолжает давать прогнозы.","atlm-note"));
    if(data.training.progress&&Number.isSafeInteger(data.training.progress.totalCases)&&data.training.progress.totalCases>0)statusBody.append(make("p","Обработано примеров: "+count(data.training.progress.completedCases)+" из "+data.training.progress.totalCases+".","atlm-note"));
    if(data.training.status==="RETRY_WAIT"&&Number.isFinite(data.training.nextAttemptAt))statusBody.append(make("p","Повторная попытка не раньше "+new Intl.DateTimeFormat("ru-RU",{dateStyle:"short",timeStyle:"short",timeZone:document.querySelector("#tz")?.value||"UTC"}).format(new Date(data.training.nextAttemptAt))+".","atlm-note"));
    const reason=data.lastError||data.lastReason;
    if(data.lastAttempt){
      statusBody.append(make("p","Последняя завершённая попытка: "+reasonText(data.lastAttempt.code),"atlm-note"));
      const facts=data.lastAttempt;
      const technical=make("details",null,"atlm-candidates");technical.append(make("summary","Подробности последней попытки"));
      technical.append(make("p",reasonText(facts.code),"atlm-note"));
      for(const [name,label] of [["ols","Обычная регрессия"],["ridge","Ridge"],["bayesian","Bayesian"]]){
        const candidate=facts.candidates?.[name];if(!candidate)continue;
        technical.append(make("p",label+": "+(candidate.status==="AVAILABLE"?"рассчитана":reasonText(candidate.reason))+" Планов: "+candidate.sampleCount+".","atlm-note"));
      }
      statusBody.append(technical);
    }
    if(reason&&(!data.lastAttempt||data.lastAttempt.code!==reason))
      statusBody.append(make("p",reasonText(reason)+" Подробные параметры этой причины не сохранены.",data.lastError?"error":"atlm-note"));
    if(lastProcessFailure)statusBody.append(make("p",lastProcessFailure,"error atlm-process-feedback"));
    const method=make("details",null,"atlm-method");method.open=methodOpen;method.append(make("summary","Кто рассчитывает прогноз"),make("p","Сервер использует исходные признаки и активное время завершённых планов. При первом запуске прогноз фиксируется. Диапазон имеет целевой охват 80%, фактические попадания показаны в аналитике.","atlm-note"));statusBody.append(method);updateControls();
  }
  function queueKey(data){const t=data.training;return JSON.stringify([data.datasetRevision,t.generation,t.progressRevision,t.pendingRefreshCount,t.nextAttemptAt]);}
  function schedulePoll(){clearTimeout(pollTimer);if(pollsLeft>0){pollsLeft--;pollTimer=setTimeout(()=>loadStatus(true),750);}}
  function loadStatus(allowProcess=true){
    if(!supported||startPending)return Promise.resolve();if(statusPending)return statusPending;
    statusPanel.setAttribute("aria-busy","true");
    statusPending=(async()=>{
      try{
        const data=await api("/api/tracker/estimation-model");if(recoveryAction==="status"){recoveryAction=null;lastProcessFailure=null;}showStatus(data);
        const key=queueKey(data);
        if(allowProcess&&data.training.due&&!processPending&&autoBudget>0&&!processed.has(key)){
          processed.add(key);autoBudget--;processPending=true;updateControls();
          try{await api("/api/tracker/estimation-model/process",{method:"POST",body:"{}"});lastProcessFailure=null;pollsLeft=Math.max(pollsLeft,3);}
          catch(error){recoveryAction="process";lastProcessFailure="Не удалось продолжить обучение. "+error.message;statusBody.append(make("p",lastProcessFailure,"error atlm-process-feedback"));}
          finally{processPending=false;updateControls();}
          schedulePoll();
        }else if(allowProcess&&(data.training.status==="RUNNING"||data.training.due))schedulePoll();
      }catch(error){recoveryAction="status";statusBody.replaceChildren(make("p","Не удалось загрузить состояние обучения. "+error.message,"error"));}
      finally{statusPending=null;updateControls();statusPanel.removeAttribute("aria-busy");}
    })();updateControls();return statusPending;
  }
  async function loadPlan(planId,retry=0){
    if(!supported||!planId||planRoot.dataset.planId!==planId)return;
    const token=++planToken;planAbort?.abort();planAbort=new AbortController();
    planRoot.querySelector(".atlm-plan-estimate")?.remove();
    if(planRoot.dataset.deleted==="true")return;
    const panel=make("section",null,"atlm-panel atlm-plan-estimate");panel.dataset.planId=planId;panel.setAttribute("aria-labelledby","atlm-plan-heading");panel.setAttribute("aria-busy","true");
    const heading=make("h3","Прогноз активного времени");heading.id="atlm-plan-heading";
    const toolbar=make("div",null,"atlm-heading"),refresh=button("Обновить прогноз",()=>loadPlan(planId));toolbar.append(heading);
    if(planRoot.dataset.planStatus==="PLANNED")toolbar.append(refresh);
    const body=make("div","Рассчитываю прогноз…");body.setAttribute("role","status");body.setAttribute("aria-live","polite");panel.append(toolbar,body);planRoot.insertBefore(panel,planRoot.children[2]||null);
    refresh.disabled=true;
    try{
      const data=await api("/api/tracker/plans/"+encodeURIComponent(planId)+"/estimate",{signal:planAbort.signal});
      if(token!==planToken||planRoot.dataset.planId!==planId||!panel.isConnected)return;
      if(data.planId!==planId)throw new Error("Ответ относится к другому плану. Повторите загрузку.");
      if(!Object.hasOwn(data,"serverEstimation")||typeof data.isStale!=="boolean")throw new Error("Сервер вернул неполную оценку. Повторите загрузку.");
      body.replaceChildren();const estimate=data.serverEstimation;
      const forecastPlanStatus=data.forecastAvailability?.planStatus||planRoot.dataset.planStatus;
      if(data.forecastAvailability?.deleted===true){panel.remove();return;}
      if(data.forecastAvailability?.canRefreshSaved===false)refresh.remove();
      if(data.forecastAvailability?.canRefreshSaved===true&&planRoot.dataset.planStatus==="PLANNED"&&!refresh.isConnected)toolbar.append(refresh);
      let planData=null,task=null,planError=false,taskError=false;
      try {planData=(await api("/api/plans/"+encodeURIComponent(planId),{signal:planAbort.signal})).plan;}
      catch(error){if(error.name==="AbortError")throw error;planError=true;}
      if(data.assessmentId)try{const a=await api("/api/tracker/assessment",{method:"POST",signal:planAbort.signal,body:JSON.stringify({planId,assessmentId:data.assessmentId,...(data.assessmentRevision?{revision:data.assessmentRevision}:{})})});task=a.assessment?.context?.agentTask??null;}
      catch(error){if(error.name==="AbortError")throw error;taskError=true;}
      if(token!==planToken||planRoot.dataset.planId!==planId||!panel.isConnected)return;
      if(data.source==="CURRENT_INPUT" && planData?.firstStartedAt!=null){
        if(retry>=2)throw new Error("Статус плана изменился. Повторите загрузку прогноза.");
        return loadPlan(planId,retry+1);
      }
      const actual=planData?.status==="COMPLETED"&&Number.isSafeInteger(planData.activeMs)?planData.activeMs:null;
      if(data.source==="CURRENT_INPUT"&&Number.isSafeInteger(estimate?.calculatedAt))
        body.append(make("p","Рассчитано: "+new Intl.DateTimeFormat("ru-RU",{dateStyle:"short",timeStyle:"medium",timeZone:document.querySelector("#tz")?.value||"UTC"}).format(new Date(estimate.calculatedAt))+".","atlm-note"));
      if(estimate==null){body.append(make("p","Исходная оценка до запуска не сохранена.","atlm-note"));}
      else if(estimate.status==="AVAILABLE"&&Number.isFinite(estimate.pointMs)&&estimate.pointMs>=0){
        body.append(make("p","Около "+minutes(estimate.pointMs),"atlm-point"));
        addTimeline(body,estimate,actual);
        if(data.source==="FROZEN_INPUT")body.append(make("p","Зафиксировано при запуске","atlm-note"));

        body.append(make("p",forecastMethodLabel(estimate),"atlm-note atlm-method-label"));

        if(estimate.method?.id==="historical-median"){
          body.append(make("strong","Ранний ориентир по истории"));
          body.append(make("p","Учтено завершённых планов: "+count(estimate.sampleCount)+". Общая медиана активного времени; особенности новой задачи не учитываются. Качество не подтверждено.","atlm-note"));
          if(estimate.fallback?.atlmDiagnostics)body.append(make("p",(data.source==="CURRENT_INPUT"?"ATLM сейчас: ":"ATLM на момент оценки: ")+reasonText(estimate.fallback.atlmDiagnostics.code||estimate.fallback.atlmUnavailableReason),"atlm-note"));
        }
      }else if(estimate.status==="UNAVAILABLE"){
        body.append(make("p",reasonText(data.diagnostics?.code||estimate.diagnostics?.code||estimate.unavailableReason||"COLLECTING_DATA"),"atlm-note"));
        body.append(make("p",forecastPlanStatus==="PLANNED"?"Агент может дополнить исходные сведения до первого запуска плана.":"Исходная оценка зафиксирована при первом запуске плана. Отсутствие прогноза не блокирует работу.","atlm-note"));
      }else throw new Error("Сервер вернул некорректную оценку.");
      if(actual!==null)body.append(make("p","Факт: "+minutes(actual),"atlm-fact"));
      else if(planError)body.append(make("p","Не удалось загрузить факт.","error"),button("Повторить загрузку факта",()=>loadPlan(planId)));
      if(estimate==null&&data.diagnostics)body.append(make("p",diagnosticText(data.diagnostics)||reasonText(data.diagnostics.code),"atlm-note"));


      addTaskFeatures(body,task,taskError,()=>loadPlan(planId));
      if(data.isStale&&data.source!=="CURRENT_INPUT")body.append(make("p",data.staleReasons?.includes("BASELINE_SOURCE_CHANGED")?"История завершённых планов изменилась; сохранённая медиана показана как историческая оценка.":"Оценка устарела: изменился объём задачи или исходные данные модели. Сохранённое значение показано для истории.","atlm-stale"));
    }catch(error){if(token!==planToken||planRoot.dataset.planId!==planId||error.name==="AbortError")return;body.replaceChildren(make("p","Не удалось загрузить прогноз. "+error.message,"error"));}
    finally{if(token===planToken&&panel.isConnected){refresh.disabled=false;panel.removeAttribute("aria-busy");}}
  }
  const analyticsRoot=document.querySelector("#view-analytics"),qualityPanel=make("section",null,"panel atlm-panel atlm-analytics");
  const qualityHeading=make("h2","Качество прогнозов"),qualityBody=make("div","Загружаем…");qualityBody.setAttribute("aria-live","polite");qualityPanel.append(qualityHeading,qualityBody);analyticsRoot?.append(qualityPanel);
  let qualityToken=0,qualityRows=[],qualityPage=0;
  function renderQuality(){
    qualityBody.replaceChildren();const rows=qualityRows,points=rows.filter(row=>Number.isSafeInteger(row.issuedPrediction?.pointMs));
    const intervals=points.filter(row=>row.issuedPrediction.interval?.status==="AVAILABLE" && Number.isSafeInteger(row.issuedPrediction.interval.lowerMs) && Number.isSafeInteger(row.issuedPrediction.interval.upperMs));
    if(!rows.length){qualityBody.append(make("p","Нет наблюдений за выбранный период.","atlm-note"));return;}
    const errors=points.map(row=>row.issuedPrediction.pointMs-row.actualMs),absolute=errors.map(Math.abs).sort((a,b)=>a-b),sum=values=>values.reduce((a,b)=>a+b,0),actual=sum(points.map(row=>row.actualMs));
    const medianError=absolute.length?(absolute[Math.floor((absolute.length-1)/2)]+absolute[Math.floor(absolute.length/2)])/2:null;
    const rate=value=>Number.isFinite(value)?new Intl.NumberFormat("ru-RU",{maximumFractionDigits:1}).format(value)+"%":"—";
    const metric=(label,value)=>{const item=make("div",null,"atlm-metric");item.append(make("span",label),make("strong",value));return item;};
    const stats=make("div",null,"atlm-metrics");stats.append(metric("Средняя ошибка",points.length?minutes(sum(absolute)/points.length):"—"),metric("Медианная ошибка",medianError===null?"—":minutes(medianError)),
      metric("WAPE",actual?rate(100*sum(absolute)/actual):"—"),metric("Смещение",actual?rate(100*sum(errors)/actual):"—"),
      metric("Прогнозы",points.length+" / "+rows.length),metric("Попадания в диапазон",intervals.filter(row=>row.issuedPrediction.interval.lowerMs<=row.actualMs&&row.actualMs<=row.issuedPrediction.interval.upperMs).length+" / "+intervals.length),
      metric("Средняя ширина",intervals.length?minutes(sum(intervals.map(row=>row.issuedPrediction.interval.upperMs-row.issuedPrediction.interval.lowerMs))/intervals.length):"—"));qualityBody.append(stats);
    const help=make("details",null,"atlm-metrics-help");help.append(make("summary","Как читать показатели"),make("p","Ошибки сравнивают прогноз и фактическое активное время. WAPE и смещение не рассчитываются при нулевой сумме факта. Попадания считаются только для доступных диапазонов; цель 80% не является гарантией.","atlm-note"));qualityBody.append(help);
    const wrap=make("div",null,"atlm-table-wrap"),table=make("table"),head=make("thead"),hr=make("tr");wrap.setAttribute("tabindex","0");wrap.setAttribute("role","region");wrap.setAttribute("aria-label","Таблица прогнозов и фактического времени");
    for(const label of ["План","Прогноз","Диапазон","Факт","Ошибка"])hr.append(make("th",label));head.append(hr);table.append(head);const body=make("tbody");
    for(const row of rows.slice(qualityPage*10,qualityPage*10+10)){const tr=make("tr"),prediction=row.issuedPrediction;for(const value of [row.title||row.planId,prediction?.pointMs!=null?minutes(prediction.pointMs):"—",prediction?.interval?.status==="AVAILABLE"?intervalText(prediction.interval):"—",minutes(row.actualMs),prediction?.pointMs!=null?minutes(prediction.pointMs-row.actualMs):"—"])tr.append(make("td",value));body.append(tr);}table.append(body);wrap.append(table);qualityBody.append(wrap);
    const pages=Math.ceil(rows.length/10),nav=make("div",null,"atlm-controls");const previous=button("Назад",()=>{qualityPage--;renderQuality();}),next=button("Далее",()=>{qualityPage++;renderQuality();});previous.disabled=qualityPage===0;next.disabled=qualityPage+1>=pages;nav.append(previous,make("span","Страница "+(qualityPage+1)+" из "+pages),next);qualityBody.append(nav);
  }
  async function loadQuality(){
    const token=++qualityToken;qualityBody.replaceChildren(make("p","Загружаем данные…","atlm-note"));
    try{let cursor=null,all=[];do{const page=await api("/api/tracker/atlm-dataset",{method:"POST",body:JSON.stringify({limit:100,...(cursor?{cursor}:{})})});if(token!==qualityToken)return;all.push(...page.rows);cursor=page.nextCursor;}while(cursor);
      const latest=new Map();for(const row of all)latest.set(row.planId,row);
      const planFacts=new Map();let planCursor=null;do{const list=await api("/api/plans?limit=100"+(planCursor?"&cursor="+encodeURIComponent(planCursor):""));if(token!==qualityToken)return;
        for(const plan of list.plans)planFacts.set(plan.planId,{title:plan.title,finishedAt:plan.finishedAt});planCursor=list.nextCursor;}while(planCursor);
      const from=document.querySelector("#from")?.value,to=document.querySelector("#to")?.value,zone=document.querySelector("#tz")?.value||"UTC";
      const day=ms=>new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ms));
      qualityRows=[...latest.values()].map(row=>({...row,...planFacts.get(row.planId)})).filter(row=>row.eligibility==="ELIGIBLE"&&Number.isSafeInteger(row.actualMs)&&Number.isSafeInteger(row.finishedAt)&&(!from||day(row.finishedAt)>=from)&&(!to||day(row.finishedAt)<=to)).sort((a,b)=>b.finishedAt-a.finishedAt||a.planId.localeCompare(b.planId));qualityPage=0;renderQuality();
    }catch(error){if(token!==qualityToken)return;qualityBody.replaceChildren(make("p","Не удалось загрузить качество прогнозов. "+error.message,"error"),button("Повторить загрузку качества",loadQuality));}
  }
  document.querySelector('[data-view="analytics"]')?.addEventListener("click",loadQuality);
  document.querySelector("#apply")?.addEventListener("click",loadQuality);
  window.addEventListener("plan-time-zone-changed",loadQuality);
  async function discover(){
    if(capabilityPending)return;capabilityPending=true;
    try{const capabilities=await api("/api/tracker/capabilities");supported=!!capabilities.assessments?.atlm;if(!supported){statusPanel.remove();return;}if(!statusPanel.isConnected)settingsRoot.append(statusPanel);pollsLeft=0;await Promise.all([loadStatus(false),loadAttempts()]);if(planRoot.dataset.planId)await loadPlan(planRoot.dataset.planId);}
    catch(error){if(!statusPanel.isConnected)settingsRoot.append(statusPanel);statusBody.replaceChildren(make("p","Не удалось проверить поддержку прогноза. "+error.message,"error"),button("Повторить проверку прогноза",discover));controls.hidden=true;}
    finally{capabilityPending=false;if(supported)controls.hidden=false;}
  }
  window.addEventListener("plan-time-tracker:plan-will-render",()=>{planToken++;planAbort?.abort();});
  window.addEventListener("plan-time-tracker:plan-rendered",event=>{loadPlan(event.detail?.planId);loadStatus(false);});
  document.querySelector('[data-view="settings"]')?.addEventListener("click",()=>{pollsLeft=0;loadStatus(false);loadAttempts();});
  window.addEventListener("pagehide",()=>{clearTimeout(pollTimer);planAbort?.abort();});
  discover();
})();`;

const UI_EXPORT = String.raw`(()=>{
 const link=document.querySelector('.settings-export');if(!link)return;
 const status=document.createElement('p');status.className='muted';status.setAttribute('role','status');
 const error=document.createElement('p');error.className='form-error';error.setAttribute('role','alert');
 link.after(status,error);let pending=false;
 link.addEventListener('click',async event=>{
  event.preventDefault();if(pending)return;
  pending=true;link.setAttribute('aria-disabled','true');link.textContent='Подготовка экспорта…';status.textContent='';error.textContent='';
  try{
   const response=await fetch('/api/export',{credentials:'same-origin'});
   if(!response.ok)throw new Error('Не удалось подготовить экспорт. Попробуйте ещё раз.');
   const report=await response.json();
   if(report?.formatVersion!==3||!Array.isArray(report.plans))throw new Error('Сервер вернул некорректный отчёт. Попробуйте ещё раз.');
   const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
   const download=document.createElement('a');download.href=url;download.download='plan-time-tracker-export.json';document.body.append(download);
   try{download.click();}finally{download.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
   status.textContent='Экспорт подготовлен.';link.textContent='Скачать JSON отчет';
  }catch(failure){error.textContent=failure instanceof TypeError?'Не удалось скачать экспорт. Проверьте подключение к сети и повторите попытку.':failure instanceof SyntaxError?'Сервер вернул некорректный отчёт. Попробуйте ещё раз.':failure.message||'Не удалось скачать экспорт. Попробуйте ещё раз.';link.textContent='Повторить скачивание';}
  finally{pending=false;link.removeAttribute('aria-disabled');}
 });
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
    "<div id=\"modal\" class=\"modal hidden\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"modalTitle\"><div class=\"modalbox\"><div class=\"toolbar\"><h2 id=\"modalTitle\" style=\"flex:1\">Новый план</h2><button id=\"close\">Закрыть</button></div><form id=\"create\" class=\"form\"><div class=\"field\"><label for=\"title\">Название</label><input id=\"title\" maxlength=\"200\" required></div><div class=\"field\"><label for=\"description\">Текст плана</label><textarea id=\"description\" rows=\"14\" required placeholder=\"Вставьте план целиком. Заголовки этапов: ## Этап 1. Название\"></textarea></div><div class=\"field\"><label for=\"createdDate\">Дата составления</label><input id=\"createdDate\" type=\"date\" required></div><div class=\"actions\"><button type=\"button\" id=\"cancel\">Отмена</button><button class=\"primary\">Создать план</button></div></form></div></div><div id=\"toast\" class=\"toast hidden\" role=\"status\" aria-live=\"polite\"></div>",
    "</main>",
    "<script>(()=>{" + UI_ANALYTICS + "const q=s=>document.querySelector(s), all=s=>[...document.querySelectorAll(s)];const supportedZones=" + JSON.stringify(UI_TIME_ZONES.map((option) => option.value)) + ";const normalizeZone=value=>supportedZones.includes(value)?value:\"Asia/Omsk\";let plans=[],activePlans=[],deletedRequestId=0,currentDetailPlan=null,detailReturnView=\"plans\",receivedAt=Date.now(),todayActiveMs=0,todayDate=null,refreshRequestId=0,zone=\"Asia/Omsk\",serverNow=Date.now(),pending=new Map(),rejectedValidation=new Set(),rejectedVersion=new Map(),analyticsRequestId=0,detailRequestId=0,timer,modalReturnFocus=null;const uid=()=>crypto.randomUUID();const dateLocal=d=>{const value=Object.fromEntries(new Intl.DateTimeFormat(\"en-CA\",{timeZone:zone,year:\"numeric\",month:\"2-digit\",day:\"2-digit\"}).formatToParts(d).map(part=>[part.type,part.value]));return value.year+\"-\"+value.month+\"-\"+value.day};const duration=n=>{if(n==null)return\"—\";n=Math.max(0,Math.round(n/60000));const day=Math.floor(n/1440),h=Math.floor(n%1440/60),m=n%60;return day?day+\" д \"+h+\" ч \"+m+\" мин\":h?h+\" ч \"+m+\" мин\":m+\" мин\"};const formatPlanSample=n=>{const count=Number(n)||0,lastTwo=count%100;return\"по \"+count+\" \"+((lastTwo>=11&&lastTwo<=14)||count%10!==1?\"планам\":\"плану\")};const dateFmt=n=>n==null?\"—\":new Intl.DateTimeFormat(\"ru-RU\",{dateStyle:\"medium\",timeStyle:\"short\",timeZone:zone}).format(new Date(n));const statusText=status=>({PLANNED:\"Запланирован\",RUNNING:\"Выполняется\",PAUSED:\"На паузе\",COMPLETED:\"Завершён\"})[status]||status;function showToast(t,err){const x=q(\"#toast\");x.textContent=t;x.classList.toggle(\"error\",!!err);x.classList.remove(\"hidden\");clearTimeout(timer);timer=setTimeout(()=>x.classList.add(\"hidden\"),4500)}async function call(path,opt){const r=await fetch(path,{...opt,headers:{\"content-type\":\"application/json\",...(opt&&opt.headers||{})},cache:\"no-store\"});let v={};try{v=await r.json()}catch{}if(!r.ok){const e=new Error(v.error&&v.error.message||\"HTTP \"+r.status);e.status=r.status;e.code=v.error&&v.error.code;e.details=v.error&&v.error.details;throw e}return v}const rejectedTerminal=new Set();async function hasFinalPlanRejection(type,envelope,error){if(error.status!==409||!((type===\"FinishPlan\"&&error.code===\"CHECKPOINTS_INCOMPLETE\")||(type===\"DeletePlan\"&&error.code===\"PLAN_DELETED\")||(type===\"RestorePlan\"&&error.code===\"PLAN_NOT_DELETED\")))return false;try{const receipt=await call(\"/api/tracker/commands/\"+encodeURIComponent(envelope.commandId));return receipt.status===\"FINAL\"&&receipt.commandId===envelope.commandId&&receipt.commandType===envelope.commandType&&receipt.error?.code===error.code&&!receipt.result}catch{return false}}function makeCmd(type,plan,payload){const key=type+\":\"+(plan?plan.planId:\"new\"),nextPayload={...(plan?{planId:plan.planId}:{}),...(payload||{})};let c=pending.get(key);const newVersion=plan?plan.version:undefined;if(c&&rejectedTerminal.has(key)){c=null;pending.delete(key);rejectedTerminal.delete(key)}if(c&&rejectedValidation.has(key)&&JSON.stringify(c.payload)!==JSON.stringify(nextPayload)){c=null;pending.delete(key);rejectedValidation.delete(key)}if(c&&rejectedVersion.has(key)&&c.expectedVersion!==newVersion){c=null;pending.delete(key);rejectedVersion.delete(key)}if(c&&JSON.stringify(c.payload)!==JSON.stringify(nextPayload)){const e=new Error(\"Исход предыдущей команды неизвестен. Повторите её без изменения данных или обновите состояние перед новой командой.\");e.code=\"COMMAND_OUTCOME_UNKNOWN\";throw e}if(!c){c={schemaVersion:1,commandId:uid(),commandType:type,expectedVersion:newVersion,payload:nextPayload};pending.set(key,c)}return [key,c]}async function command(type,plan,payload){let prepared;try{prepared=makeCmd(type,plan,payload)}catch(e){showToast((e.code||\"ERROR\")+\": \"+e.message,true);throw e}const [key,c]=prepared;let r;try{r=await call(\"/api/commands\",{method:\"POST\",body:JSON.stringify(c)});if(r?.commandId!==c.commandId||r.outcome!==\"OK\"||typeof r.applied!==\"boolean\"||typeof r.replayed!==\"boolean\"||r.applied===r.replayed||!r.result||typeof r.result!==\"object\"||Array.isArray(r.result)||r.error){const e=new Error(\"Ответ команды не подтверждает её результат. Повторите запрос без изменения данных.\");e.code=\"COMMAND_OUTCOME_UNKNOWN\";throw e}}catch(e){if(e.code===\"VALIDATION_ERROR\")rejectedValidation.add(key);else if(await hasFinalPlanRejection(type,c,e))rejectedTerminal.add(key);if(e.code===\"VERSION_CONFLICT\"&&Number.isSafeInteger(e.details&&e.details.currentVersion)){rejectedVersion.set(key,e.details.currentVersion);if(plan)plan.version=e.details.currentVersion}showToast((e.code||\"ERROR\")+\": \"+e.message,true);if(e.code===\"VERSION_CONFLICT\")try{await refresh()}catch{}throw e}pending.delete(key);rejectedValidation.delete(key);rejectedVersion.delete(key);rejectedTerminal.delete(key);q(\"#toast\").classList.add(\"hidden\");q(\"#toast\").classList.remove(\"error\");try{await refresh()}catch{showToast(\"Изменение сохранено, но данные не обновились. Перезагрузите страницу.\",true)}return r}window.addEventListener(\"plan-time-tracker:command\",event=>{const detail=event.detail||{};command(detail.commandType,detail.plan,detail.payload).then(detail.resolve,detail.reject)});window.addEventListener(\"plan-time-tracker:refresh-plan\",event=>{const detail=event.detail||{},navigationToken=detailRequestId;(async()=>{await refresh();if(navigationToken===detailRequestId&&!q(\"#view-detail\").classList.contains(\"hidden\")&&q(\"#planDetail\").dataset.planId===detail.planId)await openPlan(detail.planId,detail.successMessage)})().then(detail.resolve,detail.reject)});function btn(text,fn,cls){const b=document.createElement(\"button\");b.textContent=text;if(cls)b.className=cls;b.onclick=async e=>{e.stopPropagation();if(b.disabled)return;b.disabled=true;try{await fn()}catch{}finally{b.disabled=false}};return b}function deletionButton(p){const restoring=p.deletedAt!=null;return btn(restoring?\"Восстановить\":\"Удалить\",async()=>{if(!window.confirm(restoring?\"Восстановить план «\"+p.title+\"»? Таймер останется остановленным.\":\"Удалить план «\"+p.title+\"»? Активное время и попытки будут остановлены. План можно восстановить в настройках, в разделе «Удалённые планы».\"))return;const navigationToken=detailRequestId;await command(restoring?\"RestorePlan\":\"DeletePlan\",p);if(navigationToken===detailRequestId&&q(\"#planDetail\").dataset.planId===p.planId&&!q(\"#view-detail\").classList.contains(\"hidden\"))await openPlan(p.planId)},restoring?\"\":\"danger\")}async function loadDeleted(){const requestId=++deletedRequestId,list=q(\"#deleted\");list.textContent=\"Загружаю удалённые планы…\";try{let page=await call(\"/api/plans?deleted=true&limit=100\"),collected=[...page.plans];while(page.nextCursor){page=await call(\"/api/plans?deleted=true&limit=100&cursor=\"+encodeURIComponent(page.nextCursor));if(requestId!==deletedRequestId)return;collected.push(...page.plans)}if(requestId!==deletedRequestId)return;list.replaceChildren();if(!collected.length)list.textContent=\"Удалённых планов нет.\";else collected.forEach(p=>list.append(card(p)))}catch(error){if(requestId!==deletedRequestId)return;list.textContent=\"Не удалось загрузить удалённые планы. \"+error.message;list.append(btn(\"Повторить\",loadDeleted));}}function finishButton(p,confirmation){let b;if(p.completion&&!p.completion.readyToFinish){b=btn(\"Условия завершения\",()=>openPlan(p.planId));b.title=\"Не выполнены условия этапов: \"+p.completion.incompleteStepCount}else b=btn(\"Завершить\",async()=>{if(!window.confirm(confirmation))return;try{await command(\"FinishPlan\",p)}finally{if(q(\"#planDetail\").dataset.planId===p.planId&&!q(\"#view-detail\").classList.contains(\"hidden\"))await openPlan(p.planId)}},\"danger\");b.dataset.finishPlan=p.planId;return b}window.addEventListener(\"plan-time-tracker:completion-updated\",event=>{const next=event.detail;if(!next?.completion)return;const summaries=[...plans,...activePlans,currentDetailPlan].filter(p=>p&&p.planId===next.planId);for(const p of summaries)p.completion=next.completion;const p=summaries[0];if(p)for(const button of all(\"[data-finish-plan]\"))if(button.dataset.finishPlan===p.planId)button.replaceWith(finishButton(p,\"Завершить план? Сервер остановит таймер.\"))});function card(p){const row=document.createElement(\"div\");row.className=\"row\";row.dataset.planId=p.planId;const left=document.createElement(\"button\"),title=document.createElement(\"span\"),meta=document.createElement(\"span\");left.type=\"button\";left.className=\"plan-open\";left.onclick=()=>openPlan(p.planId);left.setAttribute(\"aria-label\",p.title);title.className=\"row-title\";title.textContent=p.title;meta.className=\"row-meta\";meta.textContent=(p.status===\"RUNNING\"?\"Выполняется\":p.status===\"PAUSED\"?\"Пауза\":p.status===\"COMPLETED\"?\"Завершён\":\"Запланирован\")+\" · активно \"+duration(p.activeMs)+\" · создан \"+dateFmt(p.registeredAt);left.append(title,meta);const right=document.createElement(\"div\");right.className=\"row-right\";const badge=document.createElement(\"span\");badge.className=\"badge \"+p.status.toLowerCase();badge.textContent=statusText(p.status);right.append(badge);if(p.deletedAt!=null){badge.textContent=\"Удалён\";meta.textContent=\"Удалён \"+dateFmt(p.deletedAt)+\" · активно \"+duration(p.activeMs);right.append(deletionButton(p));row.append(left,right);return row}if(p.status===\"PLANNED\")right.append(btn(\"Запустить\",()=>command(\"StartPlan\",p),\"primary\"));if(p.status===\"RUNNING\")right.append(btn(\"Пауза\",()=>command(\"PausePlan\",p)));if(p.status===\"PAUSED\")right.append(btn(\"Продолжить\",()=>command(\"ResumePlan\",p),\"primary\"));if(p.status===\"RUNNING\"||p.status===\"PAUSED\")right.append(finishButton(p,\"Завершить план? Сервер остановит таймер.\"));right.append(deletionButton(p));row.append(left,right);return row}async function openPlan(planId,successMessage){const returnView=!q(\"#view-detail\").classList.contains(\"hidden\")?detailReturnView:!q(\"#view-deleted\").classList.contains(\"hidden\")?\"deleted\":\"plans\";const requestToken=++detailRequestId;try{const p=(await call(\"/api/plans/\"+encodeURIComponent(planId)+\"\")).plan;if(requestToken!==detailRequestId)return;detailReturnView=returnView;q(\"#backPlans\").textContent=returnView===\"deleted\"?\"← К удалённым планам\":\"← К планам\";currentDetailPlan=p;const box=q(\"#planDetail\");window.dispatchEvent(new CustomEvent(\"plan-time-tracker:plan-will-render\"));box.dataset.planId=planId;box.dataset.planStatus=p.status;box.dataset.deleted=String(p.deletedAt!=null);box.replaceChildren();const h=document.createElement(\"h2\");h.textContent=p.title;box.append(h);const m=document.createElement(\"p\");m.className=\"muted\";m.textContent=\"Дата плана: \"+(p.planCreatedAt.precision===\"dateOnly\"?p.planCreatedAt.on:dateFmt(Date.parse(p.planCreatedAt.value)))+\" · создан \"+dateFmt(p.registeredAt)+\" · \"+statusText(p.status);box.append(m);const deletionActions=document.createElement(\"div\");deletionActions.className=\"actions\";deletionActions.append(deletionButton(p));box.append(deletionActions);if(p.deletedAt!=null){const notice=document.createElement(\"p\");notice.className=\"notice\";notice.textContent=\"План удалён. История доступна только для чтения. Восстановление не запускает таймер.\";box.append(notice)}if(p.deletedAt==null&&(p.status===\"RUNNING\"||p.status===\"PAUSED\")){const actions=document.createElement(\"div\");actions.className=\"actions plan-completion-actions\";actions.append(finishButton(p,\"Завершить план? Сервер остановит таймер.\"));box.append(actions)}for(const label of [...(p.planText?[]:[p.description||\"Описание не задано.\",\"Критерии приёмки: \"+(p.acceptanceCriteria||\"не заданы\")]),\"Активно \"+duration(p.activeMs)+\"; календарное \"+duration(p.calendarMs)+\"; пауза \"+duration(p.pausedMs)]){const e=document.createElement(\"p\");e.textContent=label;box.append(e)}if(p.deletedAt==null){const edit=document.createElement(\"form\");edit.className=\"form\";edit.dataset.trackerForm=\"plan-metadata\";const title=document.createElement(\"input\");title.value=p.title;title.maxLength=200;title.setAttribute(\"aria-label\",\"Название плана\");const description=document.createElement(\"textarea\");description.value=p.description||\"\";description.maxLength=20000;description.setAttribute(\"aria-label\",\"Описание\");const criteria=document.createElement(\"textarea\");criteria.value=p.acceptanceCriteria||\"\";criteria.maxLength=20000;criteria.setAttribute(\"aria-label\",\"Критерии приёмки\");const date=document.createElement(\"input\");date.type=\"date\";date.value=p.planCreatedAt.precision===\"dateOnly\"?p.planCreatedAt.on:dateLocal(Date.parse(p.planCreatedAt.value));date.setAttribute(\"aria-label\",\"Дата составления\");const label=document.createElement(\"label\"),confirm=document.createElement(\"input\");confirm.type=\"checkbox\";confirm.dataset.draftField=\"confirmDateAnomaly\";label.className=\"checkbox-field\";const confirmText=document.createElement(\"span\");confirmText.textContent=\"Подтверждаю дату составления после первого старта\";label.append(confirm,confirmText);const save=document.createElement(\"button\");save.textContent=\"Сохранить изменения\";const labelled=(text,control)=>{const field=document.createElement(\"label\");field.className=\"field\";field.append(document.createTextNode(text),control);return field};edit.append(labelled(\"Название плана\",title),labelled(\"Описание\",description),labelled(\"Критерии приёмки\",criteria),labelled(\"Дата составления\",date),label,save);edit.onsubmit=async e=>{e.preventDefault();const draftSubmission={planId:p.planId,form:edit};window.dispatchEvent(new CustomEvent(\"plan-time-tracker:draft-submitted\",{detail:draftSubmission}));await command(\"UpdatePlanMetadata\",p,{title:title.value,description:description.value,acceptanceCriteria:criteria.value,planCreatedAt:p.planCreatedAt.precision===\"instant\"&&date.value===dateLocal(Date.parse(p.planCreatedAt.value))?p.planCreatedAt:{precision:\"dateOnly\",on:date.value,timeZone:zone},confirmDateAnomaly:confirm.checked});window.dispatchEvent(new CustomEvent(\"plan-time-tracker:draft-cleared\",{detail:{submission:draftSubmission.submission}}));await openPlan(p.planId)};if(p.planText){description.closest(\"label\").remove();criteria.closest(\"label\").remove();const metadata=document.createElement(\"details\"),summary=document.createElement(\"summary\");metadata.className=\"plan-metadata\";summary.textContent=\"Изменить название и дату\";metadata.append(summary,edit);box.append(metadata)}else box.append(edit);}const intervals=document.createElement(\"details\"),ih=document.createElement(\"summary\");ih.textContent=\"Интервалы работы\";intervals.append(ih);p.intervals.forEach(i=>{const e=document.createElement(\"p\");e.textContent=dateFmt(i.start_ms)+\" — \"+dateFmt(i.end_ms)+\" · \"+duration((i.end_ms||p.serverNow)-i.start_ms);intervals.append(e)});box.append(intervals);view(\"detail\");window.dispatchEvent(new CustomEvent(\"plan-time-tracker:plan-rendered\",{detail:{planId,successMessage}}))}catch(e){showToast((e.code||\"ERROR\")+\": \"+e.message,true)}}function renderActive(){const el=q(\"#active\");el.replaceChildren();q(\"#activeCount\").textContent=String(activePlans.length);if(!activePlans.length){if(plans.length){const p=document.createElement(\"p\");p.className=\"muted\";p.textContent=\"Активных планов нет. Создайте план и запустите, когда начнёте работу.\";el.append(p)}el.append(btn(\"Создать план\",openModal,\"primary\"));return}for(const plan of activePlans){const panel=document.createElement(\"section\");panel.className=\"active-plan\";panel.dataset.planId=plan.planId;panel.setAttribute(\"aria-label\",plan.title);const title=document.createElement(\"h3\");title.append(btn(plan.title,()=>openPlan(plan.planId),\"plan-open\"));const clock=document.createElement(\"div\");clock.className=\"timer\";clock.dataset.clockPlan=plan.planId;clock.setAttribute(\"aria-label\",\"Активное время: \"+plan.title);clock.textContent=duration(plan.activeMs+Math.max(0,Date.now()-receivedAt));const detail=document.createElement(\"div\");detail.className=\"muted\";detail.textContent=\"Начат \"+dateFmt(plan.firstStartedAt);const actions=document.createElement(\"div\");actions.className=\"actions\";actions.append(btn(\"Пауза\",()=>command(\"PausePlan\",plan)),finishButton(plan,\"Завершить план? Время будет остановлено сервером.\"),deletionButton(plan));panel.append(title,clock,detail,actions);el.append(panel)}}" + UI_PLAN_LISTS + "async function refresh(){const requestId=++refreshRequestId;const [first,w,settings]=await Promise.all([call(\"/api/plans?limit=100\"),call(\"/api/whoami\"),call(\"/api/settings\")]);let collected=[...first.plans],cursor=first.nextCursor;while(cursor){const page=await call(\"/api/plans?limit=100&cursor=\"+encodeURIComponent(cursor));if(requestId!==refreshRequestId)return;collected.push(...page.plans);cursor=page.nextCursor}const nextZone=normalizeZone(settings.timezone),dateParts=Object.fromEntries(new Intl.DateTimeFormat(\"en-CA\",{timeZone:nextZone,year:\"numeric\",month:\"2-digit\",day:\"2-digit\"}).formatToParts(first.serverNow).map(part=>[part.type,part.value])),today=dateParts.year+\"-\"+dateParts.month+\"-\"+dateParts.day;const daily=await call(\"/api/analytics?\"+new URLSearchParams({from:today,to:today,timeZone:nextZone}));if(requestId!==refreshRequestId)return;plans=collected.map(plan=>plan.status===\"RUNNING\"?{...plan,activeMs:plan.activeMs+Math.max(0,daily.serverNow-plan.serverNow),calendarMs:plan.calendarMs+Math.max(0,daily.serverNow-plan.serverNow),serverNow:daily.serverNow}:plan);activePlans=plans.filter(plan=>plan.status===\"RUNNING\");serverNow=daily.serverNow;receivedAt=Date.now();todayActiveMs=daily.totalActiveMs;todayDate=today;zone=nextZone;q(\"#who\").textContent=w.email||\"Личный аккаунт\";q(\"#tz\").value=zone;render();if(!q(\"#view-deleted\").classList.contains(\"hidden\"))await loadDeleted()}function openModal(){modalReturnFocus=document.activeElement;document.body.style.overflow=\"hidden\";q(\"#modal\").classList.remove(\"hidden\");q(\"#createdDate\").value=dateLocal(Date.now());q(\"#title\").focus();}function closeModal(){if(q(\"#create\").getAttribute(\"aria-busy\")===\"true\")return;q(\"#modal\").classList.add(\"hidden\");document.body.style.overflow=\"\";if(modalReturnFocus?.isConnected)modalReturnFocus.focus()}async function loadAnalytics(){const requestId=++analyticsRequestId;const d=new Date(),from=new Date(d);from.setDate(from.getDate()-29);if(!q(\"#from\").value)q(\"#from\").value=dateLocal(from);if(!q(\"#to\").value)q(\"#to\").value=dateLocal(d);const u=new URLSearchParams({from:q(\"#from\").value,to:q(\"#to\").value,timeZone:zone});let a;try{a=await call(\"/api/analytics?\"+u)}catch(error){if(requestId!==analyticsRequestId)return;throw error}if(requestId!==analyticsRequestId)return;const stats=q(\"#stats\");stats.replaceChildren();const medianText=duration(a.completedMedianActiveMs)+(a.completedMedianActiveMs==null?\"\":\" · \"+formatPlanSample(a.completedMeasuredN));[[\"Общее время за период\",duration(a.totalActiveMs)],[\"Завершено планов\",String(a.completedPlans)],[\"Медиана активного времени\",medianText],[\"Сумма времени планов\",duration(a.sumPlanActiveMs)]].forEach(([k,v],index)=>{const box=document.createElement(\"div\"),small=document.createElement(\"small\"),strong=document.createElement(\"strong\");box.className=\"metric\";small.textContent=k;strong.textContent=v;box.append(small,strong);if(index===2&&a.completedSmallSample){const note=document.createElement(\"small\");note.className=\"sample-note\";note.textContent=\"Малая выборка\";note.title=\"Медиана рассчитана по менее чем пяти завершённым планам.\";note.setAttribute(\"aria-label\",\"Малая выборка: менее пяти завершённых планов.\");box.append(note)}stats.append(box)});const chart=q(\"#chart\");chart.replaceChildren();const max=Math.max(1,...a.activeByDay.map(x=>x.activeMs));a.activeByDay.forEach(x=>{const row=document.createElement(\"div\"),date=document.createElement(\"span\"),bar=document.createElement(\"div\"),fill=document.createElement(\"span\"),v=document.createElement(\"span\");row.className=\"barrow\";bar.className=\"bar\";fill.style.width=(100*x.activeMs/max)+\"%\";bar.append(fill);date.textContent=x.date;v.textContent=duration(x.activeMs);row.append(date,bar,v);chart.append(row)});const list=q(\"#analyticPlans\");list.replaceChildren();if(!a.plans.length){const p=document.createElement(\"p\");p.className=\"muted\";p.textContent=\"За выбранный период данных нет.\";list.append(p)}else renderAnalyticsPlanCards(list,a)}function view(name){if(name!==\"detail\")detailRequestId++;all(\"[id^=view-]\").forEach(x=>x.classList.toggle(\"hidden\",x.id!==\"view-\"+name));all(\".nav button\").forEach(b=>b.setAttribute(\"aria-current\",b.dataset.view===(name===\"deleted\"||(name===\"detail\"&&detailReturnView===\"deleted\")?\"settings\":name===\"detail\"?\"plans\":name)?\"page\":\"false\"));if(name===\"deleted\")loadDeleted();if(name===\"analytics\")loadAnalytics().catch(e=>showToast(e.message,true));}all(\".nav button\").forEach(b=>b.onclick=()=>view(b.dataset.view));q(\"#backPlans\").onclick=()=>{view(detailReturnView);if(detailReturnView===\"deleted\")q(\"#deletedHeading\").focus()};q(\"#openDeleted\").onclick=()=>{view(\"deleted\");q(\"#deletedHeading\").focus()};q(\"#backSettings\").onclick=()=>{view(\"settings\");q(\"#openDeleted\").focus()};q(\"#newPlan\").onclick=openModal;q(\"#newPlan2\").onclick=openModal;q(\"#close\").onclick=closeModal;q(\"#cancel\").onclick=closeModal;q(\"#modal\").onclick=e=>{if(e.target.id===\"modal\")closeModal()};q(\"#create\").onsubmit=async e=>{e.preventDefault();const payload={title:q(\"#title\").value,planText:q(\"#description\").value,planCreatedAt:{precision:\"dateOnly\",on:q(\"#createdDate\").value,timeZone:zone}};try{await command(\"CreatePlan\",null,payload);e.target.removeAttribute(\"aria-busy\");closeModal();e.target.reset();showToast(\"План создан. Таймер не запущен.\")}catch(x){showToast((x.code||\"ERROR\")+\": \"+x.message,true)}};q(\"#apply\").onclick=()=>loadAnalytics().catch(e=>showToast(e.message,true));q(\"#settings\").onsubmit=async e=>{e.preventDefault();try{const r=await call(\"/api/settings\",{method:\"POST\",body:JSON.stringify({timezone:q(\"#tz\").value})});zone=normalizeZone(r.timezone);q(\"#tz\").value=zone;window.dispatchEvent(new CustomEvent(\"plan-time-zone-changed\",{detail:zone}));await refresh();showToast(\"Часовой пояс сохранён.\")}catch(x){showToast((x.code||\"ERROR\")+\": \"+x.message,true)}};setInterval(()=>{const elapsed=Math.max(0,Date.now()-receivedAt);for(const plan of activePlans){const clock=all(\"[data-clock-plan]\").find(node=>node.dataset.clockPlan===plan.planId);if(clock)clock.textContent=duration(plan.activeMs+elapsed)}if(todayDate&&dateLocal(serverNow+elapsed)!==todayDate){todayDate=null;refresh().catch(e=>showToast(e.message,true))}else if(q(\"#today\"))q(\"#today\").textContent=duration(todayActiveMs+(activePlans.length?elapsed:0))},1000);refresh().catch(e=>{q(\"#who\").textContent=\"Требуется вход\";showToast(e.message,true)})})();</script></body></html>"
  ].join("").replace("</head>", "<style>" + UI_FONT_CSS + UI_ANALYTICS_CSS + UI_PLAN_LISTS_CSS + "</style></head>").replace("</body></html>", "<script>" + UI_ENHANCEMENTS + "</script><script>" + UI_TRACKER + UI_ATLM + UI_EXPORT + "</script><script>" + UI_ACCESSIBILITY + "</script><style>" + UI_CONSOLE_PAPER_CSS + UI_TYPOGRAPHY_CSS + "</style></body></html>");
}

function validatePublicCommand(envelope){
 if(!WRITE_COMMANDS.has(envelope?.commandType)&&!TRACKER_COMMANDS.has(envelope?.commandType))throw appError("VALIDATION_ERROR","Неизвестная команда.");
 const payload=envelope?.payload;if(!isPlainRecord(payload))return;
 const fields={CreatePlan:["planId","title","description","acceptanceCriteria","planCreatedAt","planText","sourceReference"],UpdatePlanMetadata:["planId","title","description","acceptanceCriteria","planCreatedAt","reason","confirmDateAnomaly"],StartPlan:["planId"],PausePlan:["planId","reason"],ResumePlan:["planId"],FinishPlan:["planId","completionNote","allowIncomplete","reason"],DeletePlan:["planId","reason"],RestorePlan:["planId","reason"]}[envelope.commandType];
 if(fields)assertExactKeys(payload,new Set(fields),"payload");
}
// ATLM training state is durable in D1. A background promise only drains that state.
export const ATLM_RETRAIN_EVERY_NEW_PLANS = 2;
const ATLM_TRAINING_LEASE_MS = 60000;
const ATLM_TRAINING_BUDGET_MS = 10000;
const ATLM_TRAINING_LIMIT = 5000;
const ATLM_TRAINING_RETRY_MS = [60000, 300000, 900000];
const ATLM_LATEST_SAMPLE_SQL = "s.sequence=(SELECT MAX(current.sequence) FROM estimation_samples current WHERE current.owner_id=s.owner_id AND current.plan_id=s.plan_id)";
const ATLM_PENDING_REFRESH_SQL = "SELECT 1 FROM estimation_jobs r WHERE r.owner_id=estimation_owner_state.owner_id AND r.kind='REFRESH_SAMPLE' AND r.generation>r.processed_generation";
function atlmAttemptId(job) { return "g" + job.generation + "-a" + job.attempts; }

async function atlmEnsureAttempt(db, ownerId, job, nowMs) {
  await db.prepare(`INSERT OR IGNORE INTO estimation_training_attempts(owner_id,attempt_id,started_at,method_version,feature_version,dataset_revision,manifest_json)
    SELECT ?,?,?,?, ?,COALESCE((SELECT dataset_revision FROM estimation_owner_state WHERE owner_id=?),0),'[]'
    WHERE EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key='train' AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?)`)
    .bind(ownerId,atlmAttemptId(job),nowMs,ATLM_METHOD.version,ATLM_FEATURE_VERSION,ownerId,ownerId,job.generation,job.fence,nowMs).run();
}

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
// Public diagnostics contain only bounded, non-sensitive model facts.
function atlmDiagnostics(code, facts = {}) {
  const parameters = {};
  for (const key of ["sampleCount","p","residualDegreesOfFreedom","rank","limit","status","firstStartedAt"])
    if (facts[key] !== undefined && facts[key] !== null && (typeof facts[key] === "string" || Number.isFinite(facts[key]))) parameters[key] = facts[key];
  if (Array.isArray(facts.missingFields)) parameters.missingFields = facts.missingFields.filter(x => typeof x === "string").slice(0, 20);
  const messages = {
    AVAILABLE:"Модель успешно обучена.",
    MISSING_FEATURES:"До первого запуска не сохранены исходные признаки задачи.",
    HISTORY_RESET:"Исходная оценка удалена при переходе на новую историю ATLM. Для уже начатого плана прогноз задним числом не создаётся.",
    MISSING_REQUIRED_FEATURES:"Не заполнены обязательные параметры: " + (parameters.missingFields?.join(", ") || "workUnits, doneBoundary") + ".",
    SCOPE_CHANGED:"Требования плана изменились. Сохраните актуальную оценку исходных признаков: expectedRequirementsDigest не совпадает.",
    INCOMPLETE_FEATURES:"Не заполнены обязательные параметры: " + (parameters.missingFields?.join(", ") || "missingFields не сохранён") + ".",
    TRAINING_NOT_STARTED:"Обучение модели ещё не выполнялось. Активной модели нет.",
    INSUFFICIENT_DATA:"Недостаточно данных для расчёта коэффициентов модели.",
    RANK_DEFICIENT:"Не удаётся независимо оценить коэффициенты: признаки в обучающей выборке линейно зависимы.",
    MODEL_CAPACITY_LIMIT:"Число коэффициентов превышает ресурсный предел модели.",
    MODEL_RESOURCE_LIMIT:"Расчёт модели превышает установленный предел вычислений.",
    TRAINING_TIME_BUDGET:"Не удалось начать расчёт в пределах времени фоновой задачи.",
    DATASET_LIMIT_REACHED:"Число обучающих примеров превышает допустимый предел.",
    UNSUPPORTED_FORECAST_SCOPE:"Новый расчёт доступен только до первого запуска плана. Показана исходная сохранённая оценка.",
    PLAN_DELETED:"План удалён. Новый расчёт недоступен.",
    TRAINING_IN_PROGRESS:"Обучение или обновление исходных данных ещё не завершено.",
    COLLECTING_DATA:"Активной модели нет. Подробные параметры последней попытки не сохранены.",
    MODEL_INVALIDATED:"Исходные данные сохранённой модели изменились. Требуется повторное обучение.",
    UNSUPPORTED_CATEGORY:"В обученной модели отсутствует категория обязательного признака этой задачи. Параметры: "+(parameters.unsupportedFields?.join(", ")||"не сохранены")+".",
    INVALID_FEATURES:"Исходные параметры не соответствуют схеме задачи.",
    INVALID_PREDICTION:"Модель не смогла получить конечное неотрицательное время.",
    INVALID_ARTIFACT:"Сохранённая модель повреждена или не соответствует текущей версии.",
    NUMERICAL_FAILURE:"При расчёте коэффициентов получены некорректные числовые значения.",
    SOURCE_UNAVAILABLE:"Источник исходных данных или сохранённой модели недоступен.",
    TRAINING_EXECUTION_FAILED:"Во время обучения произошёл технический сбой.",
    LEASE_EXPIRED:"Попытка обучения не завершилась в отведённое время.",
    MEDIAN_BASELINE_BETTER:"Новая модель ошибается сильнее медианы прошлых длительностей.",
    MEDIAN_BASELINE_NOT_WORSE:"Медиана прошлых длительностей не хуже проверенных обучаемых способов. Новая обученная модель не активирована.",
    CANDIDATE_MAE_WORSE:"Средняя ошибка новой модели выше, чем у действующей.",
    CANDIDATE_COVERAGE_WORSE:"Новая модель оценивает меньшую долю задач, чем действующая.",
    INSUFFICIENT_INCUMBENT_CASES:"Недостаточно проверочных сравнений для замены действующей модели.",
    SNAPSHOT_INVALIDATED:"Исходные данные изменились во время обучения. Требуется новая попытка."
  };
  let message = messages[code] || "Расчёт недоступен. Причина: " + String(code) + ".";
  const values = Object.entries(parameters).filter(([key]) => key !== "missingFields" && key !== "unsupportedFields").map(([key,value]) => key+"="+String(value));
  if(values.length) message += " " + values.join(", ") + ".";
  if(code === "INSUFFICIENT_DATA" && parameters.p !== undefined) message += " Требуется sampleCount >= p и независимость признаков.";
  return {code,message,parameters};
}
function atlmAttemptDiagnostics(result, snapshot, job, nowMs) {
  const candidates = result.details?.candidates;
  return {...atlmDiagnostics(result.reason || "AVAILABLE", {...result.details?.artifact,...result.details,status:undefined}),
    ...(candidates ? { candidates: Object.fromEntries(["ols", "ridge", "bayesian"].map(name => [name, atlmFitDiagnostic(candidates[name])])) } : {}),
    ...(result.details?.selection ? { selection: result.details.selection } : {}),
    methodVersion:ATLM_METHOD.version,featureSchemaVersion:ATLM_FEATURE_VERSION,
    datasetRevision:snapshot?.datasetRevision ?? null,generation:job.generation,completedAt:nowMs};
}
function atlmStatusDiagnostics(status) {
  if(status.activeModel) return null;
  if(status.activeModelInvalidated){
    const diagnostic=atlmDiagnostics("MODEL_INVALIDATED");
    if(status.lastAttempt?.code===status.lastReason&&status.lastReason){diagnostic.cause=status.lastAttempt;diagnostic.message+=" Последняя попытка: "+status.lastAttempt.message;}
    return diagnostic;
  }
  if(status.training?.pendingRefreshCount || ["QUEUED","RUNNING","RETRY_WAIT"].includes(status.training?.status))
    return atlmDiagnostics("TRAINING_IN_PROGRESS",{status:status.training.status});
  if(status.lastAttempt?.code && status.lastAttempt.code === status.lastReason && status.lastAttempt.code !== "AVAILABLE") return status.lastAttempt;
  if(status.lastReason) return {...atlmDiagnostics(status.lastReason),
    message:atlmDiagnostics(status.lastReason).message+" Подробные параметры последней попытки не сохранены."};
  return atlmDiagnostics("TRAINING_NOT_STARTED");
}

function atlmPublicEvaluation(evaluation) {
  if (!evaluation) return null;
  return { validationStatus:evaluation.validationStatus ?? "EXPERIMENTAL", metricsScope:"FULL_POLICY",
    ...(evaluation.metrics?.overall ?? {}), modelCaseCount:evaluation.paired?.caseCount ?? 0,
    medianBaselineMaeMs:evaluation.metrics?.median?.maeMs ?? null,
    profileGroupCount:evaluation.profileGroupCount ?? 0, excludedCaseCount:evaluation.excluded?.length ?? 0,
    cutoff:evaluation.cutoff ?? null, protocolVersion:evaluation.protocolVersion ?? 3 };
}
function atlmPublicModel(row) {
  const artifact = row ? atlmTrainingJson(row.artifact_json) : null;
  return row ? { modelId: row.model_id, modelVersion: row.model_version, trainedAt: row.activated_at ?? row.created_at,
    method: artifact?.method ?? null,
    ...(artifact?.kind === "HYBRID" ? { hybrid: { policyVersion: artifact.policyVersion, selectedEngine: artifact.selectedEngine, intervalEngine:artifact.intervalEngine } } : {}),
    sampleCount: row.sample_count, accuracy: atlmTrainingJson(row.metrics_json)?.validationStatus === "HISTORICALLY_EVALUATED" ? "HISTORICALLY_EVALUATED" : "EXPERIMENTAL",
    evaluation: atlmPublicEvaluation(atlmTrainingJson(row.metrics_json)) } : null;
}

// An immutable artifact is readable only while every manifest source is still current and clean.
async function atlmReadActiveModel(db, ownerId) {
  return dbFirst(db, `SELECT m.* FROM estimation_models m JOIN estimation_owner_state o
    ON o.owner_id=m.owner_id AND o.active_model_id=m.model_id
    WHERE m.owner_id=? AND m.status='ACTIVE' AND m.method_version IN ('${ATLM_OLS_METHOD.version}','${ATLM_METHOD.version}') AND m.feature_version='${ATLM_FEATURE_VERSION}'
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
    const reason=state?.active_model_id ? "MODEL_INVALIDATED" : "COLLECTING_DATA";
    return {...unavailable(reason),diagnostics:atlmStatusDiagnostics(await getEstimationModelStatus(db,ownerId,nowMs))};
  }
  let prediction;
  try { prediction = predictAtlm(atlmTrainingJson(model.artifact_json), features); }
  catch { throw appError("SOURCE_UNAVAILABLE", "Сохранённая модель ATLM повреждена.", 503, { reason: "INVALID_ARTIFACT" }); }
  if (prediction.reason === "INVALID_ARTIFACT") throw appError("SOURCE_UNAVAILABLE", "Сохранённая модель ATLM повреждена.", 503, { reason: "INVALID_ARTIFACT" });
  const metadata = { modelId: model.model_id, modelVersion: model.model_version, sampleCount: model.sample_count,
    evaluation: atlmPublicEvaluation(atlmTrainingJson(model.metrics_json)),
    accuracy: atlmTrainingJson(model.metrics_json)?.validationStatus === "HISTORICALLY_EVALUATED" ? "HISTORICALLY_EVALUATED" : "EXPERIMENTAL" };
  if (prediction.status !== "AVAILABLE") return { ...unavailable(prediction.reason), ...metadata, diagnostics:atlmDiagnostics(prediction.reason,prediction),
    ...(prediction.missingFields ? { missingFields: prediction.missingFields } : {}) };
  return { status: "AVAILABLE", pointMs: prediction.pointMs, ...metadata, unavailableReason: null,
    method:atlmTrainingJson(model.artifact_json).method, pointEngine:prediction.pointEngine ?? null, interval:prediction.interval ?? null,...(prediction.hybrid?{hybrid:prediction.hybrid}:{}) };
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
  return { method: { ...ATLM_METHOD }, inputSchemaVersion: "agent-task-v3", featureSchemaVersion: ATLM_FEATURE_VERSION, metric: "PLAN_ACTIVE",
    forecastScope: "FULL_FROM_FIRST_START", retrainEveryNewPlans: ATLM_RETRAIN_EVERY_NEW_PLANS,
    datasetRevision: state?.dataset_revision ?? 0, eligibleSampleCount: counts?.eligible ?? 0,
    excludedSampleCount: (counts?.total ?? 0) - (counts?.eligible ?? 0), newPlansSinceTraining: newPlans,
    exclusionReasons: exclusions, activeModel: atlmPublicModel(active), activeModelInvalidated:Boolean(state?.active_model_id&&!active),
    training: { status, generation: train?.generation ?? state?.training_generation ?? 0, due,
      attempts: trainPending ? train.attempts : 0, nextAttemptAt: Number.isFinite(nextAttemptAt) ? nextAttemptAt : null,
      pendingRefreshCount: pending.length, progressRevision: checkpoint.progressRevision ?? 0,
      progress: { phase: checkpoint.phase ?? null, completedCases: checkpoint.cases?.length ?? 0,
        totalCases: snapshot.selection?.caseSampleIds?.length ?? 0 } },
    lastError: refreshFailed?.last_error ?? train?.last_error ?? null,
    lastReason: state?.last_training_reason ?? null, lastAttempt:atlmTrainingJson(state?.last_training_diagnostics_json) };
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
  await db.prepare(`UPDATE estimation_jobs SET status='QUEUED',executor_epoch=executor_epoch+1,lease_until=NULL,attempts=0,next_attempt_at=0,
    snapshot_json=NULL,checkpoint_json=NULL,last_error=NULL,updated_at=?
    WHERE owner_id=? AND job_key=? AND fence=? AND generation>? AND status='RUNNING' AND lease_until>?`)
    .bind(nowMs, ownerId, job.job_key, job.fence, job.generation, nowMs).run();
}
async function atlmCheckpoint(db, ownerId, job, checkpoint, nowMs, { snapshot, release = false } = {}) {
  const fields = ["checkpoint_json=?", "updated_at=?"], values = [JSON.stringify(checkpoint), nowMs];
  if (snapshot !== undefined) { fields.push("snapshot_json=?"); values.push(JSON.stringify(snapshot)); }
  if (release) fields.push("status='QUEUED'", "executor_epoch=executor_epoch+1", "lease_until=NULL");
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

async function atlmHistoricalRows(db, ownerId, snapshot, cutoff, excludePlanId) {
  const rows = await dbAll(db, `SELECT s.* FROM estimation_samples s WHERE s.owner_id=? AND s.sequence<=?
    AND s.observed_at<? AND s.sequence=(SELECT MAX(v.sequence) FROM estimation_samples v
      WHERE v.owner_id=s.owner_id AND v.plan_id=s.plan_id AND v.sequence<=? AND v.observed_at<?)
    AND s.eligibility='ELIGIBLE' AND s.source_available_at<? AND s.plan_id<>?
    ORDER BY s.plan_id,s.sequence LIMIT ?`, ownerId, snapshot.historyThroughSequence, cutoff,
    snapshot.historyThroughSequence, cutoff, cutoff, excludePlanId, ATLM_MAX_ROWS + 1);
  return rows.map(row => atlmTrainingRow(atlmSampleView(row)));
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
    db.prepare("SELECT COALESCE(MAX(sequence),0) AS through_sequence FROM estimation_samples WHERE owner_id=?").bind(ownerId),
  ]);
  const state = values[0].results[0], sampleRows = values[1].results, previous = values[2].results[0];
  const nowMs = clock();
  if (sampleRows.some(row => row.source_available_at > nowMs)) throw appError("INVALID_ESTIMATION_SOURCE", "ATLM source availability is in the future.", 500);
  const limited = sampleRows.length > ATLM_TRAINING_LIMIT;
  const manifest = limited ? [] : sampleRows.map(row => row.sequence);
  const rows = limited ? [] : sampleRows.map(row => ({ sampleId: String(row.sequence), planId: row.plan_id,
    capturedAt: row.captured_at, sourceAvailableAt: row.source_available_at, features: atlmTrainingJson(row.features_json), actualMs: row.actual_ms }));
  const snapshot = { formatVersion: 1, methodVersion: ATLM_METHOD.version, featureSchemaVersion: ATLM_FEATURE_VERSION, generation: job.generation, modelId: "atlm-" + job.generation,
    modelVersion: job.generation, trainCutoff: nowMs, datasetRevision: state.dataset_revision,
    historyThroughSequence: values[3].results[0].through_sequence,
    newSampleCount: state.new_sample_count, newSampleSequence: sampleRows.reduce((max, row) => Math.max(max, row.sequence), 0),
    activePointer: state.active_model_id, incumbentId: previous?.status === "ACTIVE" && [ATLM_METHOD.version, ATLM_OLS_METHOD.version].includes(previous.method_version)
      && previous.feature_version === ATLM_FEATURE_VERSION ? previous.model_id : null,
    forcedRetrain: Boolean(state.forced_retrain), manifest, resourceLimitReached: limited,
    selection: limited ? null : { status: "AVAILABLE", protocolVersion: 3, cutoff: nowMs, inputCount: rows.length,
      eligibleCount: rows.length, caseSampleIds: atlmHybridTargets(rows).map(row => row.sampleId), excluded: [] } };
  if (!limited && (snapshot.selection.status !== "AVAILABLE" || snapshot.selection.eligibleCount !== rows.length)) {
    throw appError("INVALID_ESTIMATION_SOURCE", "ATLM eligible snapshot contains invalid sources.", 500);
  }
  const checkpoint = { phase: limited ? "LIMIT" : "EVALUATE", cases: [], baseCases: {}, policyCases: {}, progressRevision: 1 };
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
  const pairs = cases.map(c => {
    const own = predictAtlm(artifact, c.features);
    if (own.reason === "INVALID_ARTIFACT") throw appError("SOURCE_UNAVAILABLE", "Сохранённая модель ATLM повреждена.", 503);
    const fallback = ["UNSUPPORTED_CATEGORY", "INVALID_PREDICTION"].includes(own.reason) ? c.median : own;
    return { candidate: c.prediction ?? c.atlm, incumbent: own.status === "AVAILABLE" ? own : fallback,
      candidateOwn: c.atlm.status === "AVAILABLE", incumbentOwn: own.status === "AVAILABLE", actualMs: c.actualMs };
  });
  const candidateCount = pairs.filter(p => p.candidateOwn).length;
  const incumbentCount = pairs.filter(p => p.incumbentOwn).length;
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
      train_cutoff,metrics_json,sample_count,reason,created_at,method_version,feature_version)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${finalGuard}`).bind(ownerId, snapshot.modelId, snapshot.modelVersion, modelStatus,
      result.artifact ? JSON.stringify(result.artifact) : null, JSON.stringify(snapshot.manifest), digest, snapshot.trainCutoff,
      result.evaluation ? JSON.stringify(result.evaluation) : null, snapshot.manifest.length, result.reason, nowMs, ATLM_METHOD.version, ATLM_FEATURE_VERSION, ...guardValues),
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
  const historyCases = result.evaluation?.cases?.map(item => ({planId:item.planId,sampleId:item.sampleId,capturedAt:item.capturedAt,sourceAvailableAt:item.sourceAvailableAt})) ?? [];
  statements.push(db.prepare(`UPDATE estimation_training_attempts SET completed_at=?,dataset_revision=?,manifest_json=?,diagnostics_json=?,case_ids_json=?,metrics_json=?,selected_json=?,reason=?
    WHERE owner_id=? AND attempt_id=? AND completed_at IS NULL AND ${completedGuard}`)
    .bind(nowMs,snapshot.datasetRevision,JSON.stringify(snapshot.manifest),JSON.stringify(atlmAttemptDiagnostics(result,snapshot,job,nowMs)),
      JSON.stringify(historyCases),result.evaluation?.metrics?JSON.stringify(result.evaluation.metrics):null,
      result.details?.selection?JSON.stringify({point:result.details.selection,interval:result.details.intervalSelection ?? null}):null,result.reason,ownerId,atlmAttemptId(job),...completedValues));
  statements.push(db.prepare(`UPDATE estimation_owner_state SET last_attempted_new_sample_count=MAX(last_attempted_new_sample_count,?),
    last_attempted_new_sample_sequence=MAX(last_attempted_new_sample_sequence,?),last_training_status=?,last_training_reason=?,last_training_diagnostics_json=?,updated_at=?,
    manual_epoch=manual_epoch+1,forced_retrain=CASE WHEN dataset_revision=? AND NOT EXISTS(${ATLM_PENDING_REFRESH_SQL}) THEN 0 ELSE forced_retrain END
    WHERE owner_id=? AND ${completedGuard}`)
    .bind(snapshot.newSampleCount, snapshot.newSampleSequence, result.status, result.reason, JSON.stringify(atlmAttemptDiagnostics(result,snapshot,job,nowMs)), nowMs, snapshot.datasetRevision, ownerId, ...completedValues));
  // Update the pointer last, after all guards which compare the old pointer.
  if (result.activate) statements.push(db.prepare(`UPDATE estimation_owner_state SET active_model_id=? WHERE owner_id=? AND ${completedGuard}`)
    .bind(snapshot.modelId, ownerId, ...completedValues));
  // Pointer now names the candidate on success; use the same fence and immutable model receipt.
  statements.push(db.prepare(`UPDATE estimation_jobs SET processed_generation=generation,status='IDLE',executor_epoch=executor_epoch+1,lease_until=NULL,next_attempt_at=0,last_error=?,
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
    db.prepare(`UPDATE estimation_training_attempts SET completed_at=?,dataset_revision=?,manifest_json=?,reason='SNAPSHOT_INVALIDATED',
      diagnostics_json=json_object('code','SNAPSHOT_INVALIDATED') WHERE owner_id=? AND attempt_id=? AND completed_at IS NULL AND ${guard}`)
      .bind(nowMs,snapshot.datasetRevision,JSON.stringify(snapshot.manifest),ownerId,atlmAttemptId(job),...values),
    db.prepare(`INSERT OR IGNORE INTO estimation_models(owner_id,model_id,model_version,status,manifest_json,dataset_digest,
      train_cutoff,sample_count,reason,created_at,method_version,feature_version)
      SELECT ?,?,?,'REJECTED',?,?,?,?, 'SNAPSHOT_INVALIDATED',?,?,? WHERE ${guard}`)
      .bind(ownerId, snapshot.modelId, snapshot.modelVersion, JSON.stringify(snapshot.manifest),
        "sha256:" + await hashCommandInput({ manifest: snapshot.manifest, datasetRevision: snapshot.datasetRevision }),
        snapshot.trainCutoff, snapshot.manifest.length, nowMs, ATLM_METHOD.version, ATLM_FEATURE_VERSION, ...values),
    db.prepare(`UPDATE estimation_jobs SET processed_generation=generation,generation=generation+1,status='QUEUED',executor_epoch=executor_epoch+1,
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
  if (job.kind === "TRAIN") statements.push(db.prepare(`INSERT OR IGNORE INTO estimation_training_attempts(owner_id,attempt_id,started_at,method_version,feature_version,dataset_revision,manifest_json)
    SELECT ?,?,?,?,?,COALESCE((SELECT dataset_revision FROM estimation_owner_state WHERE owner_id=?),0),'[]'
    WHERE EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key='train' AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?)`)
    .bind(ownerId,atlmAttemptId(job),job.updated_at,ATLM_METHOD.version,ATLM_FEATURE_VERSION,ownerId,ownerId,job.generation,job.fence,nowMs));
  if (job.kind === "TRAIN") statements.push(db.prepare(`UPDATE estimation_training_attempts SET completed_at=?,reason=?,diagnostics_json=?
    WHERE owner_id=? AND attempt_id=? AND completed_at IS NULL
      AND EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key='train' AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?)`)
    .bind(nowMs,code,JSON.stringify(atlmAttemptDiagnostics({reason:code},snapshot,job,nowMs)),ownerId,atlmAttemptId(job),ownerId,job.generation,job.fence,nowMs));
  if (exhausted && job.kind === "TRAIN") statements.push(db.prepare(`UPDATE estimation_owner_state SET
    last_attempted_new_sample_count=MAX(last_attempted_new_sample_count,COALESCE(?,new_sample_count)),
    last_attempted_new_sample_sequence=MAX(last_attempted_new_sample_sequence,COALESCE(?,(SELECT MAX(sequence) FROM estimation_samples WHERE owner_id=estimation_owner_state.owner_id),0)),
    last_training_status='FAILED',last_training_reason=?,last_training_diagnostics_json=?,
    manual_epoch=manual_epoch+1,forced_retrain=CASE WHEN NOT EXISTS(${ATLM_PENDING_REFRESH_SQL}) THEN 0 ELSE forced_retrain END,updated_at=?
    WHERE owner_id=? AND EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key=? AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?)`)
    .bind(snapshot?.newSampleCount ?? null, snapshot?.newSampleSequence ?? null, code, JSON.stringify(atlmAttemptDiagnostics({reason:code},snapshot,job,nowMs)), nowMs, ownerId, ownerId, job.job_key, job.generation, job.fence, nowMs));
  statements.push(db.prepare(`UPDATE estimation_jobs SET status=?,executor_epoch=executor_epoch+1,lease_until=NULL,next_attempt_at=?,last_error=?,updated_at=?
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
  const fitBudget = () => wallClock() - started < 2000;
  await db.prepare("INSERT OR IGNORE INTO estimation_owner_state(owner_id) SELECT owner_id FROM owners WHERE owner_id=?").bind(ownerId).run();
  // A crashed fourth attempt remains failed until new source data creates another generation.
  const expiredAt = clock();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO estimation_training_attempts(owner_id,attempt_id,started_at,method_version,feature_version,dataset_revision,manifest_json)
      SELECT j.owner_id,'g'||j.generation||'-a'||j.attempts,j.updated_at,?,?,
        COALESCE(json_extract(j.snapshot_json,'$.datasetRevision'),o.dataset_revision,0),COALESCE(json_extract(j.snapshot_json,'$.manifest'),'[]')
      FROM estimation_jobs j LEFT JOIN estimation_owner_state o ON o.owner_id=j.owner_id
      WHERE j.owner_id=? AND j.job_key='train' AND j.status='RUNNING' AND j.lease_until<=? AND j.attempts>0`)
      .bind(ATLM_METHOD.version,ATLM_FEATURE_VERSION,ownerId,expiredAt),
    db.prepare(`UPDATE estimation_training_attempts SET completed_at=?,reason='LEASE_EXPIRED',diagnostics_json=json_object('code','LEASE_EXPIRED')
      WHERE owner_id=? AND completed_at IS NULL AND attempt_id=(SELECT 'g'||generation||'-a'||attempts FROM estimation_jobs
        WHERE owner_id=? AND job_key='train' AND status='RUNNING' AND lease_until<=? AND attempts>0)`)
      .bind(expiredAt,ownerId,ownerId,expiredAt),
    db.prepare(`UPDATE estimation_owner_state SET last_attempted_new_sample_count=MAX(last_attempted_new_sample_count,
      COALESCE((SELECT json_extract(snapshot_json,'$.newSampleCount') FROM estimation_jobs WHERE owner_id=? AND job_key='train'),new_sample_count)),
      last_attempted_new_sample_sequence=MAX(last_attempted_new_sample_sequence,
        COALESCE((SELECT json_extract(snapshot_json,'$.newSampleSequence') FROM estimation_jobs WHERE owner_id=estimation_owner_state.owner_id AND job_key='train'),
          (SELECT MAX(sequence) FROM estimation_samples WHERE owner_id=estimation_owner_state.owner_id),0)),
      last_training_status='FAILED',last_training_reason='LEASE_EXPIRED',updated_at=?,
      manual_epoch=manual_epoch+1,forced_retrain=CASE WHEN NOT EXISTS(${ATLM_PENDING_REFRESH_SQL}) THEN 0 ELSE forced_retrain END
      WHERE owner_id=? AND EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key='train'
        AND status='RUNNING' AND lease_until<=? AND attempts>=4)`).bind(ownerId, expiredAt, ownerId, ownerId, expiredAt),
    db.prepare(`UPDATE estimation_jobs SET status=CASE WHEN attempts>=4 THEN 'FAILED' WHEN attempts=0 THEN 'QUEUED' ELSE 'RETRY_WAIT' END,executor_epoch=executor_epoch+1,
      next_attempt_at=CASE WHEN attempts>=4 OR attempts=0 THEN 0 ELSE lease_until+CASE attempts WHEN 1 THEN 60000 WHEN 2 THEN 300000 ELSE 900000 END END,
      lease_until=NULL,last_error=CASE WHEN attempts=0 THEN NULL ELSE 'LEASE_EXPIRED' END,updated_at=?
      WHERE owner_id=? AND status='RUNNING' AND lease_until<=?`).bind(expiredAt, ownerId, expiredAt),
  ]);
  if (!budget()) throw appError("SOURCE_UNAVAILABLE", "Подготовка обучения превысила бюджет времени.", 503,
    { retryable:true, reason:"TRAINING_TIME_BUDGET" });
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
        await db.prepare(`UPDATE estimation_jobs SET processed_generation=generation,status='IDLE',executor_epoch=executor_epoch+1,lease_until=NULL,next_attempt_at=0,last_error=NULL,updated_at=?
          WHERE owner_id=? AND job_key=? AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?`)
          .bind(clock(), ownerId, job.job_key, job.generation, job.fence, clock()).run();
        await atlmReleaseSuperseded(db, ownerId, job, clock());
        continue;
      }
      await atlmEnsureAttempt(db, ownerId, job, clock());
      let snapshot = atlmTrainingJson(job.snapshot_json), checkpoint = atlmTrainingJson(job.checkpoint_json), rows;
      if (!snapshot || snapshot.methodVersion !== ATLM_METHOD.version || snapshot.featureSchemaVersion !== ATLM_FEATURE_VERSION
        || snapshot.selection?.protocolVersion !== 3 || !checkpoint?.baseCases) {
        const initial = await atlmSnapshot(db, ownerId, job, clock);
        if (!initial) { await atlmCheckpoint(db, ownerId, job, { phase: "SNAPSHOT", cases: [], progressRevision: (checkpoint?.progressRevision ?? 0) + 1 }, clock(), { release: true }); break; }
        ({ snapshot, checkpoint, rows } = initial);
        job.snapshot_json = JSON.stringify(snapshot);
      }
      if (snapshot.resourceLimitReached) {
        await atlmFinalizeTraining(db, ownerId, job, snapshot, checkpoint,
          { activate: false, status: "FAILED", reason: "DATASET_LIMIT_REACHED", details:{sampleCount:snapshot.manifest.length,limit:ATLM_MAX_ROWS}, artifact: null, evaluation: null }, clock());
        continue;
      }
      rows ||= await atlmManifestRows(db, ownerId, snapshot.manifest);
      if (snapshot.selection?.status !== "AVAILABLE") {
        await atlmFinalizeTraining(db, ownerId, job, snapshot, checkpoint,
          { activate: false, status: "COLLECTING_DATA", reason: snapshot.selection?.reason || "INVALID_DATASET", details:{sampleCount:rows.length}, artifact: null, evaluation: null }, clock());
        continue;
      }
      let lostLease = false, yielded = false;
      checkpoint.policyCases ||= {};
      const historyFor = row => atlmHistoricalRows(db,ownerId,snapshot,row.capturedAt,row.planId);
      const replayYield = Symbol("ATLM_REPLAY_YIELD"), replayLost = Symbol("ATLM_REPLAY_LOST");
      const replayStartRevision=checkpoint.progressRevision;
      const beforeReplayWork = async () => { if (!fitBudget()) throw replayYield; };
      const saveReplay = async () => {
        checkpoint.progressRevision++;
        if(!await atlmCheckpoint(db,ownerId,job,checkpoint,clock()))throw replayLost;
        if(!budget())throw replayYield;
      };
      try {
        while (checkpoint.cases.length < snapshot.selection.caseSampleIds.length && budget()) {
          const target=rows.find(row=>row.sampleId===snapshot.selection.caseSampleIds[checkpoint.cases.length]);
          const result=await atlmReplayPolicyCase(target,historyFor,checkpoint.baseCases,checkpoint.policyCases,saveReplay,beforeReplayWork);
          if(result.status==="UNAVAILABLE" && result.reason==="INVALID_EVALUATION")throw appError("INVALID_ESTIMATION_SOURCE","Incomplete probabilistic evaluation.",500);
          checkpoint.cases.push(result);checkpoint.phase="EVALUATE";await saveReplay();
        }
        // Final calibration uses every eligible plan, not only the comparison window.
        if(checkpoint.cases.length===snapshot.selection.caseSampleIds.length) for(const row of rows){
          if(!budget())throw replayYield;
          await atlmReplayPolicyCase(row,historyFor,checkpoint.baseCases,checkpoint.policyCases,saveReplay,beforeReplayWork);
        }
      } catch(error) {
        if(error===replayLost)lostLease=true;
        else if(error===replayYield)yielded=true;
        else throw error;
      }
      if (lostLease) break;
      if (yielded) {
        checkpoint.replayDeferrals=checkpoint.progressRevision===replayStartRevision ? (checkpoint.replayDeferrals ?? 0)+1 : 0;
        if (checkpoint.replayDeferrals>=2) {
          await atlmFinalizeTraining(db,ownerId,job,snapshot,checkpoint,
            {activate:false,status:"FAILED",reason:"TRAINING_TIME_BUDGET",details:{sampleCount:rows.length},artifact:null,evaluation:null},clock());
          break;
        }
      }
      if (yielded || !budget() || checkpoint.cases.length < snapshot.selection.caseSampleIds.length
        || rows.some(row=>!checkpoint.policyCases[row.sampleId])) {
        await atlmCheckpoint(db, ownerId, job, checkpoint, clock(), { release: true });
        break;
      }
      const evaluation = summarizeHybridAtlmEvaluation(checkpoint.cases, snapshot.selection);
      if (evaluation.status !== "AVAILABLE") throw appError("INVALID_ESTIMATION_SOURCE", "Invalid hybrid evaluation.", 500);
      if (!checkpoint.fitCheckpointed) {
        checkpoint = { ...checkpoint, phase: "FIT", fitCheckpointed:true, progressRevision: checkpoint.progressRevision + 1 };
        if (!await atlmCheckpoint(db, ownerId, job, checkpoint, clock())) break;
        if (!budget()) { await atlmCheckpoint(db, ownerId, job, checkpoint, clock(), { release: true }); break; }
      }
      let candidates=checkpoint.finalCandidates;
      if (!candidates) {
        if (!fitBudget()) {
          checkpoint.fitDeferrals=(checkpoint.fitDeferrals ?? 0)+1;
          if (checkpoint.fitDeferrals>=2) await atlmFinalizeTraining(db,ownerId,job,snapshot,checkpoint,
            {activate:false,status:"FAILED",reason:"TRAINING_TIME_BUDGET",details:{sampleCount:rows.length},artifact:null,evaluation},clock());
          else await atlmCheckpoint(db,ownerId,job,checkpoint,clock(),{release:true});
          break;
        }
        checkpoint.fitDeferrals=0;
        candidates=await atlmFitCandidates(rows);
        checkpoint.finalCandidates=candidates;checkpoint.progressRevision++;
        if (!await atlmCheckpoint(db,ownerId,job,checkpoint,clock())) break;
        if (!budget()) { await atlmCheckpoint(db,ownerId,job,checkpoint,clock(),{release:true}); break; }
      }
      const incumbent = snapshot.incumbentId ? await dbFirst(db, `SELECT m.*,(SELECT MAX(s.source_available_at) FROM estimation_samples s
        WHERE s.owner_id=m.owner_id AND s.sequence IN (SELECT value FROM json_each(m.manifest_json))) AS latest_source_available_at
        FROM estimation_models m WHERE m.owner_id=? AND m.model_id=?`, ownerId, snapshot.incumbentId) : null;
      const incumbentEngine = incumbent ? atlmTrainingJson(incumbent.artifact_json)?.selectedEngine ?? null : null;
      const selection = selectHybridEngine(candidates, snapshot.selection.caseSampleIds.map(id => checkpoint.baseCases[id]), { incumbent:incumbentEngine });
      const residuals = rows.flatMap(row => {
        const base = checkpoint.baseCases[row.sampleId], predictive = base?.bayesian?.predictive;
        return base?.bayesian?.status === "AVAILABLE" && predictive && Number.isFinite(predictive.location)
          && Number.isFinite(predictive.scale) && predictive.scale > 0
          ? [{planId:row.planId,features:row.features,residual:(Math.log1p(row.actualMs/ATLM_MS_PER_MINUTE)-predictive.location)/predictive.scale}] : [];
      });
      let quantiles = checkpoint.quantileFit;
      if (!quantiles) {
        if (!fitBudget()) {
          checkpoint.quantileDeferrals=(checkpoint.quantileDeferrals ?? 0)+1;
          if (checkpoint.quantileDeferrals>=2) await atlmFinalizeTraining(db,ownerId,job,snapshot,checkpoint,
            {activate:false,status:"FAILED",reason:"TRAINING_TIME_BUDGET",details:{sampleCount:rows.length},artifact:null,evaluation},clock());
          else await atlmCheckpoint(db,ownerId,job,checkpoint,clock(),{release:true});
          break;
        }
        checkpoint.quantileDeferrals=0;
        quantiles = await fitAtlmResidualQuantiles(residuals);
        checkpoint.quantileFit=quantiles;checkpoint.phase="CALIBRATION";checkpoint.progressRevision++;
        if (!await atlmCheckpoint(db,ownerId,job,checkpoint,clock())) break;
        if (!budget()) { await atlmCheckpoint(db,ownerId,job,checkpoint,clock(),{release:true}); break; }
      }
      const priorCases = checkpoint.cases.filter(item=>item.prediction?.status === "AVAILABLE").map(item=>({
        planId:item.planId,capturedAt:item.capturedAt,actualMs:item.actualMs,pointMs:item.prediction.pointMs,intervals:item.intervalCandidates}));
      const intervalSelection = selectAtlmIntervalEngine({BAYESIAN_PREDICTIVE:candidates.bayesian,
        BAYES_QUANTILE:quantiles}, priorCases, {incumbent:incumbent ? atlmTrainingJson(incumbent.artifact_json)?.intervalEngine : null});
      checkpoint.calibrationProof ||= {};
      let proofYielded=false;
      const initialProofCount=Object.keys(checkpoint.calibrationProof).length;
      if (quantiles.status === "AVAILABLE") {
        for (const planId of quantiles.artifact.models[0].manifest) {
          if (checkpoint.calibrationProof[planId]) continue;
          if (!fitBudget()) { proofYielded=true; break; }
          const target=rows.find(row=>row.planId===planId);
          const reconstructed=await atlmReconstructResidual(target,await historyFor(target));
          if (!reconstructed) throw appError("INVALID_ESTIMATION_SOURCE","Invalid calibration history.",500);
          checkpoint.calibrationProof[planId]=reconstructed;
          checkpoint.phase="CALIBRATION";checkpoint.progressRevision++;
          if (!await atlmCheckpoint(db,ownerId,job,checkpoint,clock())) { lostLease=true; break; }
        }
      }
      if (lostLease) break;
      if (proofYielded) {
        checkpoint.proofDeferrals=Object.keys(checkpoint.calibrationProof).length===initialProofCount ? (checkpoint.proofDeferrals ?? 0)+1 : 0;
        if (checkpoint.proofDeferrals>=2) {
          await atlmFinalizeTraining(db,ownerId,job,snapshot,checkpoint,
            {activate:false,status:"FAILED",reason:"TRAINING_TIME_BUDGET",details:{sampleCount:rows.length},artifact:null,evaluation},clock());
          break;
        }
      }
      if (proofYielded || !budget()) { await atlmCheckpoint(db,ownerId,job,checkpoint,clock(),{release:true}); break; }
      const fitted = await fitAtlm(rows, { candidates, selection, cutoff: snapshot.trainCutoff,
        residualQuantiles:quantiles.status === "AVAILABLE" ? quantiles.artifact : null, intervalSelection, calibrationHistory:historyFor,
        calibrationProof:checkpoint.calibrationProof,replayAuthority:ATLM_INTERNAL_REPLAY });
      fitted.intervalSelection = intervalSelection;
      evaluation.selection = selection;
      evaluation.intervalSelection = intervalSelection;
      evaluation.calibration = {sampleCount:residuals.length,status:quantiles.status,reason:quantiles.reason ?? null};
      const initialReady = evaluation.paired.caseCount >= ATLM_MIN_COMPARISONS;
      let rejection = fitted.status !== "AVAILABLE" ? fitted.reason
        : initialReady && !evaluation.candidateReady ? "MEDIAN_BASELINE_BETTER" : null;
      evaluation.validationStatus = "EXPERIMENTAL";
      if (!rejection) {
        const comparison = atlmCompareIncumbent(evaluation, incumbent);
        evaluation.incumbentComparison = comparison.comparison;
        if (incumbent && !comparison.accepted) rejection = comparison.reason;
        else if (initialReady) evaluation.validationStatus = "HISTORICALLY_EVALUATED";
      }
      if (rejection) {
        await atlmFinalizeTraining(db, ownerId, job, snapshot, checkpoint, { activate: false,
          status: rejection.startsWith("INSUFFICIENT_") ? "COLLECTING_DATA" : "REJECTED", reason: rejection,
          details: { ...fitted, sampleCount: rows.length }, artifact: null, evaluation }, clock());
        continue;
      }
      const final = { activate: true, status: "IDLE", artifact: fitted.artifact,
        reason: null, details: { ...fitted, sampleCount: rows.length }, evaluation };
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
  if (request.method === "GET" && url.pathname === "/api/tracker/estimation-training-history") {
    const args={};for(const key of url.searchParams.keys()) if(!["limit","cursor"].includes(key)) throw appError("VALIDATION_ERROR","Неизвестный параметр истории обучения.");
    if(url.searchParams.has("limit"))args.limit=Number(url.searchParams.get("limit"));
    if(url.searchParams.has("cursor"))args.cursor=url.searchParams.get("cursor");
    return json(await getEstimationTrainingHistory(env.DB,identity.ownerId,args,now));
  }
  const readOnlyPost=new Set(["/api/tracker/assessment","/api/tracker/atlm-estimate","/api/tracker/atlm-dataset","/api/tracker/estimation-history"]);
  if (request.method!=="GET" && !readOnlyPost.has(url.pathname)) await ensureOwner(env.DB, identity, now);
  if (request.method === "GET" && url.pathname === "/api/whoami") return json({ userId: identity.ownerId, email: identity.email, serverNow: now });
  if (request.method === "GET" && url.pathname === "/api/settings") {
    const settings = await dbFirst(env.DB, "SELECT timezone,locale FROM owners WHERE owner_id=?", identity.ownerId);
    return json({ timezone: settings?.timezone ?? "UTC", locale: settings?.locale ?? "en" });
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
  const atlmPaths = { "/api/tracker/atlm-estimate": "CalculateAtlmEstimate", "/api/tracker/atlm-dataset": "GetAtlmDataset", "/api/tracker/estimation-model/process": "ProcessEstimationTraining", "/api/tracker/estimation-model/start": "StartEstimationTraining" };
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
  const stepAnalyticsMatch = url.pathname.match(/^\/api\/analytics\/plans\/([^/]+)\/steps$/);
  if (request.method === "GET" && stepAnalyticsMatch) return json(await buildStepAnalytics(env.DB, identity.ownerId, decodeURIComponent(stepAnalyticsMatch[1]), {
    from: url.searchParams.get("from"), to: url.searchParams.get("to"), timeZone: url.searchParams.get("timeZone"), asOf: url.searchParams.get("asOf") ?? undefined,
  }, now));
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
    const envelope=await bodyJson(request, isPlanDocumentCreation); validatePublicCommand(envelope);
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
  ProcessEstimationTraining: "ContinueTraining", GetAtlmDataset: "GetTrainingData", GetEstimationTrainingHistory:"GetTrainingHistory",
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
  CalculateAtlmEstimate: "Получить прогноз до первого запуска: ATLM либо явно обозначенный ранний ориентир historical-median по пригодной истории. Прогноз не сохраняется.",
  GetPlanEstimate: "Получить актуальный прогноз PLANNED по последним сохранённым признакам и текущим данным без записи и обучения; после первого запуска вернуть зафиксированную оценку.",
  GetEstimationModelStatus: "Посмотреть количество примеров, состояние обучения и причины исключения данных.",
  StartEstimationTraining: "По прямой просьбе пользователя запросить новую попытку обучения на доступных данных.",
  ProcessEstimationTraining: "Продолжить подготовку данных или уже запущенное обучение одним ограниченным проходом.",
  GetAtlmDataset: "Посмотреть сохранённые примеры обучения и причины исключения, с пагинацией.",
  GetEstimationTrainingHistory: "Прочитать историю попыток обучения с постраничным снимком.",
});
function mcpTools() {
  const writeNames = new Set([...WRITE_COMMANDS, ...TRACKER_COMMANDS]);
  const assessmentDescriptions = {
    RecordAssessment: "Записать оценку или неизменяемую ревизию. expectedVersion=0 создаёт серию; для новой ревизии передайте текущий номер ревизии в expectedVersion и причину в payload.reason. Метод и шкалу выбирает агент, прогноз отдельно в ms. Обязателен expectedRequirementsDigest из GetAssessment без assessmentId, прочитанный до анализа. Таймер не запускается.",
    GetAssessment: "Без assessmentId: прочитать текущие requirements/currentRequirementsDigest для анализа до первой оценки или пересмотра; stepId необязателен. С assessmentId: прочитать сохранённую ревизию (revision необязателен) и needsRevision; requirements в этом ответе относятся к сохранённому снимку.",
    GetEstimationHistory: "Факты и оценки по явным targets. Метрики ms раздельны, общий активный итог — объединение интервалов родителей. При пагинации сохраняйте asOf, throughSequence и nextAfterSequence как afterSequence. Окно дат относится к фактам времени, оценки читаются до asOf. Статистики относятся ко всей выборке фактов; readiness текущая. Время плана рассчитывается по рабочим интервалам.",
  };
  return TOOL_NAMES.map((name) => {
    let inputSchema = { type: "object", additionalProperties: false };
    if (Object.hasOwn(ATLM_TOOL_SCHEMAS, name)) return { name, description: ({
      CalculateAtlmEstimate: "Предпросмотр полного PLAN_ACTIVE до первого StartPlan: приоритет активной ATLM, при расчётной недоступности — явный historical-median по реальной истории. Факты agent-task-v3; без обучения и записи.",
      GetPlanEstimate: "Текущий read-only расчёт PLANNED (source=CURRENT_INPUT); recordedEstimation сохраняет исходную оценку для аудита. После первого запуска — frozen-снимок; legacy без снимка читает исходную assessment. История не переписывается.",
      GetEstimationModelStatus: "Состояние модели, накопление пригодных планов и очередь обучения владельца. Только чтение.",
      ProcessEstimationTraining: "Один ограниченный проход долговечной очереди владельца. Идемпотентная мутация без planId, с lease и fence; может потребоваться повторный проход.",
      StartEstimationTraining: "По явной просьбе пользователя запросить обучение на доступных данных независимо от порога двух планов. Возвращает состояние очереди; качество и достаточность данных проверяются сервером.",
      GetEstimationTrainingHistory: "История попыток обучения владельца, включая ошибки и отказанные модели; nextCursor фиксирует границу среза.",
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
          planText: { type: "string", minLength: 1, description: "Полный исходный Markdown плана. Этапы из заголовков сохраняются автоматически; не пересказывайте их в отдельных полях." },
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
    if (assessmentDescriptions[name]) return { name, description: assessmentDescriptions[name], inputSchema };
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
  const rpc = await bodyJson(request, body => body?.method === "tools/call" && (MCP_INTERNAL_NAMES[body.params?.name] || body.params?.name) === "CreatePlan" && typeof body.params?.arguments?.payload?.planText === "string");
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
    if(WRITE_COMMANDS.has(name)||TRACKER_COMMANDS.has(name)||["ProcessEstimationTraining","StartEstimationTraining"].includes(name)) await ensureOwner(env.DB, identity, now);
    let result;
    if (Object.hasOwn(ATLM_TOOL_SCHEMAS, name)) result = await executeAtlmTool(env.DB, identity.ownerId, name, rpc.params?.arguments === undefined ? {} : rpc.params.arguments, now, clock);
    else if (name === "GetPlan") result = await readPlan(env.DB, identity.ownerId, args.planId, now);
    else if (name === "GetAssessment") result = await readAssessment(env.DB, identity.ownerId, args, now);
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
