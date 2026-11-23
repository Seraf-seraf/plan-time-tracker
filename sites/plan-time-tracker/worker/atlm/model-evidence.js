import {
  appError, checkTimeZone, dbAll, dbFirst, hashCommandInput, inclusiveDateRange, parseColumn,
} from '../shared/index.js';
import { summarizeAtlmV4Metrics } from './model.js';
import { readAtlmSampleRefreshStatus } from './sample-refresh.js';
import { readAtlmServingState } from './serving.js';
import { ATLM_TEACHER_MODES } from './teacher-dataset.js';

const MODEL_EVIDENCE_PAGE_MAX = 50;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_ROWS_BYTES = 80 * 1024;
const CURSOR_VERSION = 1;
const MS_PER_MINUTE = 60_000;
const METRIC_FIELDS = [
  'caseCount', 'pointCaseCount', 'intervalCaseCount', 'forecastRate', 'intervalAvailabilityRate',
  'maeMs', 'medaeMs', 'meanSignedErrorMs', 'sumAbsoluteErrorMs', 'sumSignedErrorMs',
  'totalActualMs', 'wapePercent', 'signedBiasPercent', 'coverageNumerator', 'coverageDenominator',
  'intervalCoverage', 'meanIntervalWidthMs', 'meanIntervalScore', 'nominalCoverage',
];
const FACT_EXCLUSIONS = [
  'PLAN_DELETED', 'PLAN_NOT_COMPLETED', 'RESULT_NOT_VERIFIED', 'INCOMPLETE_MEASUREMENT', 'SCOPE_CHANGED',
];
const INVALIDATED_SOURCES = ['SOURCE_CHANGED', 'HISTORY_RESET', 'MODEL_SOURCE_MISSING'];
const REVISIONS = `SELECT m.registry_sequence,m.model_revision_id,m.model_version,m.legacy_revision,
  m.dataset_revision_id,m.origin,m.method_version,m.feature_version,m.registered_at,m.trained_at,
  m.imported_at,coalesce((SELECT a.activated_at FROM estimation_model_activations a
    WHERE a.owner_id=m.owner_id AND a.model_revision_id=m.model_revision_id
    ORDER BY a.activation_version DESC LIMIT 1),s.activated_at) AS activated_at,
  m.fit_count,m.source_count,m.artifact_digest,m.dataset_digest,
  m.train_cutoff,m.legacy_activated_at,m.invalidated_reason,s.status,s.source_problem,
  json_extract(m.artifact_json,'$.selectedEngine') AS point_engine,
  json_extract(m.artifact_json,'$.intervalEngine') AS interval_engine,
  json_extract(m.provenance_json,'$.legacyStatus') AS legacy_status,
  json_extract(m.provenance_json,'$.legacyReason') AS legacy_reason
  FROM estimation_model_revisions m JOIN estimation_serving_models s
    ON s.owner_id=m.owner_id AND s.model_id=m.model_revision_id`;

function cursorError() {
  return appError('INVALID_CURSOR', 'Курсор недействителен. Начните просмотр заново.');
}

function pageSize(limit = DEFAULT_PAGE_SIZE) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MODEL_EVIDENCE_PAGE_MAX)
    throw appError('VALIDATION_ERROR', 'Размер страницы должен быть от 1 до 50.');
  return limit;
}

function nonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

async function seal(ownerId, selector, values) {
  return btoa(JSON.stringify([CURSOR_VERSION, values,
    await hashCommandInput([CURSOR_VERSION, ownerId, selector, values])]));
}

async function unseal(ownerId, selector, cursor, length) {
  if (typeof cursor !== 'string' || cursor.length > 512) throw cursorError();
  let decoded;
  try {
    decoded = JSON.parse(atob(cursor));
  } catch {
    throw cursorError();
  }
  const values = decoded?.[1];
  if (!Array.isArray(values) || values.length !== length || !values.every(nonnegative)
    || await seal(ownerId, selector, values) !== cursor) throw cursorError();
  return values;
}

function compactPage(rows, limit, project) {
  const items = [];
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    const item = project(row);
    bytes += encoder.encode(JSON.stringify(item)).length + 1;
    if (bytes > MAX_PAGE_ROWS_BYTES && items.length) break;
    items.push(item);
  }
  return { items, last: items.length ? rows[items.length - 1] : null, more: rows.length > items.length };
}

function revisionView(row) {
  return {
    modelRevisionId: row.model_revision_id, modelVersion: row.model_version, modelRevision: row.legacy_revision,
    registrySequence: row.registry_sequence, datasetRevisionId: row.dataset_revision_id, origin: row.origin,
    methodVersion: row.method_version, featureSchemaVersion: row.feature_version,
    registeredAt: row.registered_at, trainedAt: row.trained_at, activatedAt: row.activated_at,
    importedAt: row.imported_at, trainCutoff: row.train_cutoff, fitCount: row.fit_count,
    sourceCount: row.source_count, pointEngine: row.point_engine, intervalEngine: row.interval_engine,
    artifactDigest: row.artifact_digest, datasetDigest: row.dataset_digest,
    status: row.status, sourceProblem: row.source_problem,
    historicalDecision: row.legacy_status ? { status: row.legacy_status, reason: row.legacy_reason } : null,
  };
}

async function modelRevision(db, ownerId, modelRevisionId) {
  const row = await dbFirst(db, `${REVISIONS} WHERE m.owner_id=? AND m.model_revision_id=?`, ownerId, modelRevisionId);
  if (!row) throw appError('MODEL_REVISION_NOT_FOUND', 'Ревизия модели не найдена.', 404);
  return row;
}

async function readDataSummary(db, ownerId, revision, nowMs) {
  const id = revision?.modelRevisionId ?? null;
  const row = await dbFirst(db, `WITH
    model AS (SELECT * FROM estimation_model_revisions WHERE owner_id=?1 AND model_revision_id=?2),
    fit AS (SELECT DISTINCT CASE value.type WHEN 'object' THEN json_extract(value.value,'$.planId')
      WHEN 'text' THEN value.value END AS plan_id
      FROM model m, json_each(CASE json_type(m.manifest_json) WHEN 'array' THEN m.manifest_json
        ELSE json_extract(m.manifest_json,'$.trainingPlanIds') END) value),
    eligible AS (SELECT s.plan_id FROM estimation_samples s JOIN plans p USING(owner_id,plan_id)
      LEFT JOIN estimation_jobs j ON j.owner_id=s.owner_id AND j.job_key='refresh:'||s.plan_id
      WHERE s.owner_id=?1 AND p.status='COMPLETED' AND p.deleted_at IS NULL AND s.eligibility='ELIGIBLE'
        AND coalesce(j.generation,0)<=coalesce(j.processed_generation,0)
        AND s.sequence=(SELECT max(x.sequence) FROM estimation_samples x
          WHERE x.owner_id=s.owner_id AND x.plan_id=s.plan_id))
    SELECT (SELECT count(plan_id) FROM fit) AS manifest_count,
      (SELECT count(*) FROM eligible) AS eligible_count,
      (SELECT count(*) FROM eligible e WHERE NOT EXISTS(SELECT 1 FROM fit f WHERE f.plan_id=e.plan_id)) AS new_count,
      (SELECT count(*) FROM fit f JOIN estimation_model_revision_sources s ON s.owner_id=?1 AND
        s.model_revision_id=?2 AND s.plan_id=f.plan_id
        LEFT JOIN estimation_jobs j ON j.owner_id=s.owner_id AND j.job_key='refresh:'||s.plan_id
        WHERE s.source_generation<>coalesce(j.generation,0)) AS changed_count,
      (SELECT count(*) FROM fit f JOIN estimation_model_revision_sources s ON s.owner_id=?1
        AND s.model_revision_id=?2 AND s.plan_id=f.plan_id) AS matched_count,
      d.dataset_revision_id,d.snapshot_id,d.created_at,d.row_count,d.eligible_count AS dataset_eligible_count,
      h.captured_at
    FROM (SELECT 1)
    LEFT JOIN model m ON 1
    LEFT JOIN estimation_dataset_revisions d ON d.owner_id=m.owner_id AND d.dataset_revision_id=m.dataset_revision_id
    LEFT JOIN estimation_training_snapshots h ON h.owner_id=d.owner_id AND h.snapshot_id=d.snapshot_id`, ownerId, id);
  const refresh = await readAtlmSampleRefreshStatus(db, ownerId, nowMs);
  const manifestAvailable = Boolean(revision?.artifactDigest || revision?.fitCount)
    && revision.fitCount > 0 && row.manifest_count === revision.fitCount;
  return {
    fitCount: revision?.fitCount ?? null,
    manifestAvailable,
    currentEligibleCount: row.eligible_count,
    newEligibleCount: manifestAvailable ? row.new_count : null,
    changedSourceCount: manifestAvailable && row.matched_count === row.manifest_count ? row.changed_count : null,
    pendingRefreshCount: refresh.pendingCount, failedRefreshCount: refresh.failedCount,
    nextRefreshAttemptAt: refresh.nextAttemptAt,
    dataset: row.dataset_revision_id === null ? null : {
      datasetRevisionId: row.dataset_revision_id, snapshotId: row.snapshot_id,
      createdAt: row.created_at, capturedAt: row.captured_at,
      rowCount: row.row_count, eligibleCount: row.dataset_eligible_count,
      excludedCount: row.row_count - row.dataset_eligible_count,
    },
  };
}

function safeMetrics(metrics) {
  if (!metrics || metrics.status === 'UNAVAILABLE') return null;
  return Object.fromEntries(METRIC_FIELDS.map(key => [key, Number.isFinite(metrics[key]) ? metrics[key] : null]));
}

function availability(numerator, denominator) {
  return { numerator: nonnegative(numerator) ? numerator : null, denominator: nonnegative(denominator) ? denominator : null };
}

function metricsSummary(cases) {
  const comparable = cases.filter(item => item.scoringExclusionReason === null);
  const metrics = comparable.length ? safeMetrics(summarizeAtlmV4Metrics(comparable)) : null;
  if (metrics) metrics.nominalCoverage = commonNominalCoverage(comparable);
  return {
    rowCount: cases.length, groupCount: null,
    excludedFromScoringCount: cases.length - comparable.length,
    forecastAvailability: availability(cases.filter(item => item.pointMs !== null).length, cases.length),
    intervalAvailability: availability(cases.filter(item => item.interval.status === 'AVAILABLE').length, cases.length),
    metrics,
  };
}

function commonNominalCoverage(cases) {
  const intervals = cases.filter(item => item.interval?.status === 'AVAILABLE');
  const target = intervals[0]?.interval.nominalCoverage;
  return Number.isFinite(target) && target >= 0 && target <= 1
    && intervals.every(item => item.interval.nominalCoverage === target) ? target : null;
}

function evidenceCode(value, fallback) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : fallback;
}

function compactInterval(interval, pointMs, defaultReason = 'INTERVAL_NOT_RECORDED') {
  if (interval?.status === 'AVAILABLE' && pointMs !== null && nonnegative(interval.lowerMs)
    && nonnegative(interval.upperMs) && interval.lowerMs <= pointMs && pointMs <= interval.upperMs)
    return {
      status: 'AVAILABLE', lowerMs: interval.lowerMs, upperMs: interval.upperMs,
      nominalCoverage: Number.isFinite(interval.nominalCoverage) ? interval.nominalCoverage : null,
      engine: evidenceCode(interval.engine, null), unavailableReason: null,
    };
  return {
    status: 'UNAVAILABLE', lowerMs: null, upperMs: null, nominalCoverage: null,
    engine: evidenceCode(interval?.engine, null),
    unavailableReason: evidenceCode(interval?.unavailableReason, defaultReason),
  };
}

function caseView({ planId, title, finishedAt, actualMs, pointMs, interval, scoringExclusionReason,
  forecastIdentity, pointUnavailableReason, eligibility, reasons, scopeChanged, rowId }) {
  return {
    rowId, planId, title, finishedAt, actualMs, pointMs, interval,
    signedErrorMs: scoringExclusionReason === null && pointMs !== null && actualMs !== null ? pointMs - actualMs : null,
    ...forecastIdentity, pointUnavailableReason, eligibility, reasons, scopeChanged, scoringExclusionReason,
  };
}

async function readIssuedWatermark(db, ownerId, nowMs) {
  const row = await dbFirst(db, `SELECT
    coalesce((SELECT max(sequence) FROM estimation_samples WHERE owner_id=?1),0) AS samples,
    coalesce((SELECT max(rowid) FROM command_receipts WHERE owner_id=?1),0) AS receipts,
    coalesce((SELECT max(registry_sequence) FROM estimation_model_revisions WHERE owner_id=?1),0) AS registry,
    coalesce((SELECT dataset_revision FROM estimation_owner_state WHERE owner_id=?1),0) AS data_version`, ownerId);
  return [row.samples, row.receipts, row.registry, row.data_version, nowMs];
}

function issuedSelector(revisionId, period) {
  return ['issued-evidence', revisionId, period];
}

async function checkIssuedWatermark(db, ownerId, watermark, nowMs) {
  const current = await readIssuedWatermark(db, ownerId, nowMs);
  if (watermark.some((value, index) => value > current[index])) throw cursorError();
}

async function issuedCases(db, ownerId, revisionId, period, watermark) {
  const [sampleSequence, receiptSequence, registrySequence, , asOf] = watermark;
  const rows = await dbAll(db, `WITH finishes AS (
      SELECT plan_id,min(rowid) AS receipt_sequence,server_now_ms AS finished_at
      FROM command_receipts WHERE owner_id=?1 AND command_type='FinishPlan' AND outcome_code IN ('OK','PARTIAL')
      GROUP BY plan_id
    ), cohort AS (
      SELECT p.plan_id,coalesce(json_extract(i.requirements_json,'$.plan.title'),p.plan_id) AS title,
        coalesce(f.finished_at,p.finished_at) AS finished_at,i.first_started_at,
        json_type(i.requirements_json,'$.plan')='object' AS scope_known,i.forecast_json,s.sequence,
        s.eligibility,s.reasons_json,s.actual_ms,
        json_extract(i.forecast_json,'$.modelRevisionId') AS explicit_revision,
        json_extract(i.forecast_json,'$.modelId') AS old_model_id,
        json_extract(i.forecast_json,'$.modelRevision') AS old_revision_number,
        json_extract(i.forecast_json,'$.modelVersion') AS old_model_version
      FROM plan_estimation_inputs i JOIN plans p USING(owner_id,plan_id)
      LEFT JOIN finishes f USING(plan_id)
      LEFT JOIN estimation_samples s ON s.owner_id=i.owner_id AND s.plan_id=i.plan_id AND s.sequence=(
        SELECT max(x.sequence) FROM estimation_samples x
        WHERE x.owner_id=i.owner_id AND x.plan_id=i.plan_id AND x.sequence<=?2)
        AND s.source_available_at>=coalesce(f.finished_at,p.finished_at)
      WHERE i.owner_id=?1 AND (
        f.receipt_sequence<=?3 OR (f.receipt_sequence IS NULL AND s.sequence IS NOT NULL))
    ), identified AS (
      SELECT c.*,
        CASE WHEN c.explicit_revision IS NOT NULL THEN c.explicit_revision ELSE
          (SELECT CASE WHEN count(*)=1 THEN min(m.model_revision_id) END FROM estimation_model_revisions m
            WHERE m.owner_id=?1 AND m.registry_sequence<=?4 AND (
              (c.old_model_id IS NOT NULL AND m.model_revision_id=c.old_model_id AND
                (c.old_revision_number IS NULL OR c.old_revision_number=m.legacy_revision))
              OR (c.old_model_id IS NOT NULL AND c.old_revision_number=m.legacy_revision AND
                json_extract(m.provenance_json,'$.parentModelId')=c.old_model_id)
              OR (c.old_model_id IS NULL AND c.old_revision_number=m.legacy_revision AND
                c.old_model_version=m.model_version))) END AS model_revision_id
      FROM cohort c WHERE c.finished_at<=?5 AND (?6 IS NULL OR c.finished_at>=?6) AND (?7 IS NULL OR c.finished_at<?7)
    )
    SELECT plan_id,title,finished_at,first_started_at,scope_known,sequence,eligibility,reasons_json,actual_ms,model_revision_id,
      forecast_json IS NOT NULL AS forecast_recorded,
      json_extract(forecast_json,'$.pointMs') AS point_ms,json_extract(forecast_json,'$.interval') AS interval,
      json_extract(forecast_json,'$.method.id') AS method,
      json_extract(forecast_json,'$.status') AS forecast_status,
      json_extract(forecast_json,'$.calculatedAt') AS calculated_at,
      json_extract(forecast_json,'$.unavailableReason') AS unavailable_reason
    FROM identified WHERE (?8 IS NULL OR model_revision_id=?8) ORDER BY finished_at DESC,plan_id DESC`,
    ownerId, sampleSequence, receiptSequence, registrySequence, asOf,
    period?.startMs ?? null, period?.endMs ?? null, revisionId);
  return rows.map(row => {
    const reasons = parseColumn(row.reasons_json, []).filter(reason => evidenceCode(reason, null));
    const actualMs = nonnegative(row.actual_ms) ? row.actual_ms : null;
    let exclusion = FACT_EXCLUSIONS.find(reason => reasons.includes(reason)) ?? null;
    if (row.sequence === null) exclusion = 'SOURCE_NOT_MATERIALIZED';
    else if (actualMs === null) exclusion ??= 'INCOMPLETE_MEASUREMENT';
    else if (!row.scope_known && (exclusion === null || exclusion === 'SCOPE_CHANGED')) exclusion = 'SCOPE_UNKNOWN';
    const pointMs = row.forecast_status === 'AVAILABLE' && nonnegative(row.point_ms) ? row.point_ms : null;
    if (pointMs !== null && (!nonnegative(row.calculated_at) || !nonnegative(row.first_started_at)
      || row.calculated_at > row.first_started_at)) exclusion ??= 'ISSUED_TIME_UNVERIFIED';
    const pointUnavailableReason = pointMs === null
      ? evidenceCode(row.unavailable_reason, row.forecast_recorded ? 'FORECAST_UNAVAILABLE' : 'FORECAST_NOT_RECORDED') : null;
    const interval = compactInterval(parseColumn(row.interval, null), pointMs, pointUnavailableReason ?? undefined);
    return caseView({
      rowId: row.plan_id, planId: row.plan_id, title: row.title, finishedAt: row.finished_at,
      actualMs, pointMs, interval, scoringExclusionReason: exclusion,
      forecastIdentity: { modelRevisionId: row.model_revision_id, method: row.method },
      pointUnavailableReason, eligibility: row.eligibility,
      reasons: exclusion && !reasons.includes(exclusion) ? [...reasons, exclusion] : reasons,
      scopeChanged: row.scope_known && row.sequence !== null ? reasons.includes('SCOPE_CHANGED') : null,
    });
  });
}

async function issuedEvidence(ownerId, revisionId, period, watermark, cases) {
  const summary = metricsSummary(cases);
  return {
    evidenceId: await seal(ownerId, issuedSelector(revisionId, period), watermark),
    kind: 'ISSUED_FORECASTS', origin: 'ISSUED', source: 'issued', modelRevisionId: revisionId,
    status: summary.metrics?.pointCaseCount ? 'AVAILABLE' : 'UNAVAILABLE', asOf: watermark[4],
    sourceDataVersion: watermark[3], summary, limitations: [],
  };
}

async function evaluationEntries(db, ownerId, revision) {
  const row = await dbFirst(db, `SELECT m.evaluation_json,s.source_data_version
    FROM estimation_model_revisions m
    LEFT JOIN estimation_dataset_revisions d USING(owner_id,dataset_revision_id)
    LEFT JOIN estimation_training_snapshots s ON s.owner_id=d.owner_id AND s.snapshot_id=d.snapshot_id
    WHERE m.owner_id=? AND m.model_revision_id=?`, ownerId, revision.modelRevisionId);
  const raw = row?.evaluation_json;
  if (!raw) return { entries: [], trainingEvaluation: null };
  const report = JSON.parse(raw);
  const digest = await hashCommandInput(raw);
  const et = [];
  let trainingEvaluation = null;
  if (report.schemaVersion === 1 && report.modes && typeof report.modes === 'object') {
    for (const kind of ATLM_TEACHER_MODES) {
      const mode = report.modes[kind];
      if (!mode || !mode.summary) continue;
      const summary = {
        rowCount: mode.summary.rowCount, groupCount: mode.summary.groupCount,
        excludedFromScoringCount: mode.summary.excludedFromScoringCount,
        forecastAvailability: availability(mode.summary.forecastAvailability?.numerator, mode.summary.forecastAvailability?.denominator),
        intervalAvailability: availability(mode.summary.intervalAvailability?.numerator, mode.summary.intervalAvailability?.denominator),
        metrics: safeMetrics(mode.summary.metrics),
      };
      et.push({ kind, status: mode.status, reason: evidenceCode(mode.reason, null), summary, cases: mode.cases ?? [] });
    }
  } else if (report.all && Array.isArray(report.cases) && report.unit === 'minutes') {
    const cases = report.cases.map(item => ({ ...item, pointMs: item.revised?.pointMs ?? null }));
    const comparable = cases.filter(item => typeof item.planId === 'string' && nonnegative(item.actualMs));
    const computed = comparable.length ? safeMetrics(summarizeAtlmV4Metrics(comparable.map(item => ({
      planId: item.planId, actualMs: item.actualMs, pointMs: nonnegative(item.pointMs) ? item.pointMs : null,
      interval: compactInterval(item.revised?.interval, item.pointMs),
    })))) : null;
    const pointCount = cases.length ? cases.filter(item => nonnegative(item.pointMs)).length : report.all.own;
    const metrics = computed ?? safeMetrics(report.all.metrics ?? {
      caseCount: report.all.cases, pointCaseCount: pointCount,
      maeMs: Number.isFinite(report.all.revisedMAE) ? report.all.revisedMAE * MS_PER_MINUTE : null,
    });
    et.push({
      kind: 'ROLLING_GROUPED_ACTUAL', status: metrics?.pointCaseCount ? 'AVAILABLE' : 'UNAVAILABLE', reason: null,
      summary: {
        rowCount: report.all.cases, groupCount: report.all.groups, excludedFromScoringCount: null,
        forecastAvailability: availability(metrics?.pointCaseCount, report.all.cases),
        intervalAvailability: availability(metrics?.intervalCaseCount, report.all.cases), metrics,
      },
      cases,
    });
  } else if (report.metrics?.overall) {
    trainingEvaluation = {
      ...safeMetrics(report.metrics.overall), validationStatus: evidenceCode(report.validationStatus, null),
      origin: revision.origin, kind: 'TRAINING_VALIDATION',
      groupCount: report.profileGroupCount ?? null,
    };
  }
  const entries = await Promise.all(et.map(async entry => ({
    cases: entry.cases,
    evidence: {
      evidenceId: await hashCommandInput([ownerId, revision.modelRevisionId, entry.kind, digest]),
      kind: entry.kind, origin: revision.origin, source: 'evaluation', modelRevisionId: revision.modelRevisionId,
      status: entry.status, asOf: revision.trainedAt ?? revision.registeredAt,
      sourceDataVersion: row.source_data_version ?? null, summary: entry.summary,
      limitations: [entry.reason, !entry.cases.length && entry.summary.rowCount ? 'CASES_NOT_RECORDED' : null].filter(Boolean),
    },
  })));
  return { entries, trainingEvaluation };
}

function recordedText(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function evaluationIssuedIdentity(row, source) {
  const forecast = parseColumn(source?.issued_prediction, null);
  // Reports without frozen rows store both identity formats in one field with distinct types.
  const reportRevision = source ? null : row.issuedModelRevision;
  const revisionNumber = source ? forecast?.modelRevision : reportRevision;
  return {
    modelRevisionId: recordedText(forecast?.modelRevisionId ?? reportRevision),
    modelId: recordedText(source ? forecast?.modelId : row.issuedModelId),
    modelRevision: nonnegative(revisionNumber) ? revisionNumber : null,
    method: recordedText(forecast?.method?.id),
  };
}

async function evaluationCasePage(db, ownerId, revision, entry, position, limit) {
  const issued = entry.evidence.kind === 'ISSUED_FORECASTS';
  const rows = entry.cases.slice(position, position + limit + 1);
  const rowIds = rows.map(row => row.rowId).filter(id => typeof id === 'string');
  const sources = revision.origin === 'NATIVE' && rowIds.length ? await dbAll(db, `
    SELECT d.row_id,json_extract(s.evidence_json,'$.title') AS title,
      json_extract(d.source_json,'$.finishedAt') AS finished_at,
      CASE WHEN ?4 THEN json_extract(d.source_json,'$.issuedPrediction') END AS issued_prediction
    FROM estimation_dataset_revision_rows d JOIN estimation_training_snapshot_rows s
      ON s.owner_id=d.owner_id AND s.snapshot_id=d.snapshot_id AND s.row_id=d.snapshot_row_id
    WHERE d.owner_id=?1 AND d.dataset_revision_id=?2 AND d.row_id IN (SELECT value FROM json_each(?3))`,
    ownerId, revision.datasetRevisionId, JSON.stringify(rowIds), issued ? 1 : 0) : [];
  const byId = new Map(sources.map(row => [row.row_id, row]));
  return compactPage(rows, limit, row => {
    const source = byId.get(row.rowId);
    const actualMs = nonnegative(row.actualMs) ? row.actualMs : null;
    const pointMs = nonnegative(row.pointMs) ? row.pointMs : null;
    return caseView({
      rowId: row.rowId ?? row.planId, planId: row.planId, title: row.title ?? source?.title ?? row.planId,
      finishedAt: Object.hasOwn(row, 'finishedAt') ? row.finishedAt : source?.finished_at ?? null,
      actualMs, pointMs, interval: compactInterval(row.interval ?? row.revised?.interval, pointMs),
      forecastIdentity: issued ? evaluationIssuedIdentity(row, source)
        : { modelRevisionId: revision.modelRevisionId, method: 'ATLM' },
      pointUnavailableReason: pointMs === null ? evidenceCode(row.pointUnavailableReason ?? row.revised?.reason, 'FORECAST_UNAVAILABLE') : null,
      scoringExclusionReason: evidenceCode(row.scoringExclusionReason, null),
      eligibility: null, reasons: [], scopeChanged: null,
    });
  });
}

async function readAtlmModelEvidenceCases(db, ownerId, revisionId, args, nowMs) {
  const limit = pageSize(args.limit);
  const revision = revisionView(await modelRevision(db, ownerId, revisionId));
  const selector = ['evidence-page', revisionId, args.source, args.evidenceId];
  const [position] = args.cursor ? await unseal(ownerId, selector, args.cursor, 1) : [0];
  let evidence, page;
  if (args.source === 'issued') {
    const watermark = await unseal(ownerId, issuedSelector(revisionId, null), args.evidenceId, 5);
    await checkIssuedWatermark(db, ownerId, watermark, nowMs);
    const cases = await issuedCases(db, ownerId, revisionId, null, watermark);
    evidence = await issuedEvidence(ownerId, revisionId, null, watermark, cases);
    page = compactPage(cases.slice(position, position + limit + 1), limit, item => item);
  } else {
    const { entries } = await evaluationEntries(db, ownerId, revision);
    const entry = entries.find(item => item.evidence.evidenceId === args.evidenceId);
    if (!entry) throw cursorError();
    evidence = entry.evidence;
    page = await evaluationCasePage(db, ownerId, revision, entry, position, limit);
  }
  return { ...evidence, cases: page.items,
    nextCursor: page.more ? await seal(ownerId, selector, [position + page.items.length]) : null };
}

async function readAtlmIssuedHistory(db, ownerId, args, nowMs) {
  const limit = pageSize(args.limit);
  const timeZone = checkTimeZone(args.timeZone);
  const period = { ...inclusiveDateRange(args.from, args.to, timeZone), from: args.from, to: args.to, timeZone };
  const selector = ['issued-history-page', period];
  const values = args.cursor ? await unseal(ownerId, selector, args.cursor, 6) : null;
  const watermark = values ? values.slice(0, 5) : await readIssuedWatermark(db, ownerId, nowMs);
  if (values) await checkIssuedWatermark(db, ownerId, watermark, nowMs);
  const position = values?.[5] ?? 0;
  const cases = await issuedCases(db, ownerId, null, period, watermark);
  const evidence = await issuedEvidence(ownerId, null, period, watermark, cases);
  const page = compactPage(cases.slice(position, position + limit + 1), limit, item => item);
  return {
    ...evidence, period: { from: args.from, to: args.to, timeZone },
    watermark: { sampleSequence: watermark[0], receiptSequence: watermark[1], registrySequence: watermark[2] },
    cases: page.items,
    nextCursor: page.more ? await seal(ownerId, selector, [...watermark, position + page.items.length]) : null,
  };
}

async function readAtlmModelRevisions(db, ownerId, args, nowMs) {
  const state = await readAtlmServingState(db, ownerId);
  if (args.view === 'detail') {
    const revision = revisionView(await modelRevision(db, ownerId, args.modelRevisionId));
    const watermark = await readIssuedWatermark(db, ownerId, nowMs);
    const [cases, evaluation, dataSummary] = await Promise.all([
      issuedCases(db, ownerId, revision.modelRevisionId, null, watermark),
      evaluationEntries(db, ownerId, revision),
      readDataSummary(db, ownerId, revision, nowMs),
    ]);
    const issued = await issuedEvidence(ownerId, revision.modelRevisionId, null, watermark, cases);
    return { ...state, revision, dataSummary, evidence: [issued, ...evaluation.entries.map(entry => entry.evidence)],
      trainingEvaluation: evaluation.trainingEvaluation };
  }
  const limit = pageSize(args.limit);
  const selector = ['model-registry', args.view];
  if (args.view === 'activations') {
    const [watermark, before] = args.cursor ? await unseal(ownerId, selector, args.cursor, 2)
      : [state.activationVersion, state.activationVersion + 1];
    if (before > watermark + 1) throw cursorError();
    const rows = await dbAll(db, `SELECT * FROM estimation_model_activations
      WHERE owner_id=? AND activation_version<=? AND activation_version<? ORDER BY activation_version DESC LIMIT ?`,
      ownerId, watermark, before, limit + 1);
    const page = compactPage(rows, limit, row => ({
      from: row.previous_model_revision_id, to: row.model_revision_id, activatedAt: row.activated_at,
      reason: row.reason, decision: row.decision, commandId: row.command_id, activationVersion: row.activation_version,
    }));
    return { ...state, rows: page.items, watermark,
      nextCursor: page.more ? await seal(ownerId, selector, [watermark, page.last.activation_version]) : null };
  }
  const bound = await dbFirst(db, 'SELECT coalesce(max(registry_sequence),0) AS sequence FROM estimation_model_revisions WHERE owner_id=?', ownerId);
  const [watermark, activationWatermark, date, before] = args.cursor ? await unseal(ownerId, selector, args.cursor, 4)
    : [bound.sequence, state.activationVersion, Number.MAX_SAFE_INTEGER, bound.sequence + 1];
  if (watermark > bound.sequence || activationWatermark > state.activationVersion || before > watermark + 1)
    throw cursorError();
  const rows = await dbAll(db, `SELECT r.*,
    (SELECT max(a.activation_version) FROM estimation_model_activations a WHERE a.owner_id=?1
      AND a.model_revision_id=r.model_revision_id AND a.activation_version<=?3) AS last_activation,
    (SELECT a.activated_at FROM estimation_model_activations a WHERE a.owner_id=?1
      AND a.model_revision_id=r.model_revision_id AND a.activation_version<=?3
      ORDER BY a.activation_version DESC LIMIT 1) AS page_activated_at
    FROM (${REVISIONS} WHERE m.owner_id=?1 AND m.registry_sequence<=?2 AND
      (coalesce(m.registered_at,0)<?4 OR (coalesce(m.registered_at,0)=?4 AND m.registry_sequence<?5))
      ORDER BY coalesce(m.registered_at,0) DESC,m.registry_sequence DESC LIMIT ?6) r
    ORDER BY coalesce(r.registered_at,0) DESC,r.registry_sequence DESC`,
    ownerId, watermark, activationWatermark, date, before, limit + 1);
  const page = compactPage(rows, limit, row => revisionView({ ...row,
    activated_at: row.page_activated_at ?? row.legacy_activated_at,
    status: row.source_problem ? (INVALIDATED_SOURCES.includes(row.source_problem) || row.invalidated_reason ? 'INVALIDATED' : 'ARCHIVED')
      : row.last_activation === activationWatermark ? 'ACTIVE'
        : row.last_activation !== null || row.legacy_activated_at !== null ? 'RETIRED' : 'REGISTERED',
  }));
  const active = state.activeModelRevisionId ? revisionView(await modelRevision(db, ownerId, state.activeModelRevisionId)) : null;
  return { ...state, activeRevision: active, dataSummary: await readDataSummary(db, ownerId, active, nowMs),
    rows: page.items, watermark,
    nextCursor: page.more ? await seal(ownerId, selector, [watermark, activationWatermark,
      page.last.registered_at ?? 0, page.last.registry_sequence]) : null };
}

export { MODEL_EVIDENCE_PAGE_MAX, readAtlmIssuedHistory, readAtlmModelEvidenceCases, readAtlmModelRevisions };
