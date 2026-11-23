import { assessmentReadiness } from './readiness.js';
import {
  appError,
  canonical,
  dbFirst,
  hashCommandInput,
  isSnapshotDigest,
  median,
  messageFor,
  parseColumn,
} from '../shared/index.js';
import {
  ATLM_FEATURE_VERSION,
  ATLM_MAX_ROWS,
  ATLM_METHOD,
  atlmArtifactValid,
  atlmUnavailableInterval,
  isNonnegativeSafeInteger,
  normalizeAgentTask,
  predictAtlm,
  validateAssessmentValue,
} from './model.js';
import { ATLM_LATEST_SAMPLE_SQL, ATLM_TOOL_SCHEMAS, readAtlmSampleSource } from './sample.js';
import { atlmDiagnostics, atlmReadActiveModel, predictWithActiveModel, readAtlmServingState } from './serving.js';
import { readAtlmSampleRefreshStatus } from './sample-refresh.js';

async function atlmPlanContext(db, ownerId, planId) {
  const row = await dbFirst(
    db,
    `SELECT p.status,p.first_started_at,p.deleted_at,t.requirements_json FROM plans p
    JOIN assessment_targets t ON t.owner_id=p.owner_id AND t.plan_id=p.plan_id AND t.step_id IS NULL
    WHERE p.owner_id=? AND p.plan_id=?`,
    ownerId,
    planId,
  );
  if (!row || row.deleted_at !== null)
    throw appError('PLAN_NOT_FOUND', messageFor('PLAN_NOT_FOUND'), 404);
  return {
    ...row,
    requirementsDigest: 'sha256:' + (await hashCommandInput(JSON.parse(row.requirements_json))),
  };
}

const HISTORICAL_MEDIAN_METHOD = Object.freeze({ id: 'historical-median', version: '1' });

function canUseHistoricalMedian(prediction) {
  const allowed = new Set([
    'COLLECTING_DATA',
    'SOURCES_PENDING',
    'SOURCE_REFRESH_FAILED',
    'INSUFFICIENT_DATA',
    'RANK_DEFICIENT',
    'UNSUPPORTED_CATEGORY',
    'MODEL_INVALIDATED',
    'INVALID_PREDICTION',
    'MODEL_RESOURCE_LIMIT',
    'MODEL_CAPACITY_LIMIT',
  ]);
  const diagnostic = prediction.diagnostics;
  return (
    prediction.status === 'UNAVAILABLE' &&
    allowed.has(diagnostic?.code || prediction.unavailableReason) &&
    (!diagnostic?.cause || allowed.has(diagnostic.cause.code))
  );
}

async function historicalMedianForecast(db, ownerId, planId, nowMs) {
  const snapshot = await dbFirst(
    db,
    `WITH selected AS(
    SELECT s.sequence,s.actual_ms FROM estimation_samples s
    WHERE s.owner_id=? AND s.plan_id<>? AND s.eligibility='ELIGIBLE' AND ${ATLM_LATEST_SAMPLE_SQL}
      AND s.source_available_at<=? AND NOT EXISTS(SELECT 1 FROM estimation_jobs j
        WHERE j.owner_id=s.owner_id AND j.job_key='refresh:'||s.plan_id AND j.status='FAILED'
          AND j.generation>j.processed_generation)
    ORDER BY s.sequence LIMIT ?
  ) SELECT COALESCE((SELECT dataset_revision FROM estimation_owner_state WHERE owner_id=?),0) AS revision,
    EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND kind='REFRESH_SAMPLE' AND generation>processed_generation AND status<>'FAILED') AS dirty,
    (SELECT json_group_array(json_object('sequence',sequence,'actualMs',actual_ms)) FROM selected) AS rows_json`,
    ownerId,
    planId,
    nowMs,
    ATLM_MAX_ROWS + 1,
    ownerId,
    ownerId,
  );
  if (snapshot.dirty) return null;
  const rows = JSON.parse(snapshot.rows_json || '[]');
  if (!rows.length || rows.length > ATLM_MAX_ROWS) return null;
  if (rows.some((row) => !isNonnegativeSafeInteger(row.actualMs)))
    throw appError('SOURCE_UNAVAILABLE', 'История содержит некорректное actualMs.', 503);
  const pointMs = Math.round(median(rows.map((row) => row.actualMs)));
  if (!isNonnegativeSafeInteger(pointMs))
    throw appError('SOURCE_UNAVAILABLE', 'Не удалось рассчитать медиану истории.', 503);
  return {
    status: 'AVAILABLE',
    pointMs,
    method: { ...HISTORICAL_MEDIAN_METHOD },
    modelId: null,
    modelVersion: null,
    sampleCount: rows.length,
    accuracy: 'HISTORICAL_BASELINE',
    evaluation: null,
    unavailableReason: null,
    diagnostics: null,
    fallback: {
      kind: 'HISTORICAL_MEDIAN',
      datasetRevision: snapshot.revision,
      throughSequence: rows.at(-1).sequence,
      sourceDigest: 'sha256:' + (await hashCommandInput(rows)),
      sampleCount: rows.length,
    },
  };
}

async function earlyForecast(db, ownerId, planId, prediction, nowMs) {
  if (!canUseHistoricalMedian(prediction)) return prediction;
  const baseline = await historicalMedianForecast(db, ownerId, planId, nowMs);
  return baseline
    ? {
        ...baseline,
        fallback: {
          ...baseline.fallback,
          atlmUnavailableReason: prediction.unavailableReason,
          atlmDiagnostics: prediction.diagnostics ?? null,
        },
      }
    : prediction;
}

async function calculateAtlmEstimate(db, ownerId, args, nowMs) {
  validateAssessmentValue(args, ATLM_TOOL_SCHEMAS.CalculateAtlmEstimate);
  if (!isSnapshotDigest(args.expectedRequirementsDigest))
    throw appError('VALIDATION_ERROR', 'Invalid requirements digest.');
  const target = await atlmPlanContext(db, ownerId, args.planId);
  if (target.requirementsDigest !== args.expectedRequirementsDigest)
    throw appError('ASSESSMENT_CONTEXT_CHANGED', messageFor('ASSESSMENT_CONTEXT_CHANGED'), 409);
  const normalized = normalizeAgentTask(args.agentTask);
  let prediction;
  if (target.status !== 'PLANNED' || target.first_started_at !== null)
    prediction = {
      status: 'UNAVAILABLE',
      unavailableReason: 'UNSUPPORTED_FORECAST_SCOPE',
      diagnostics: atlmDiagnostics('UNSUPPORTED_FORECAST_SCOPE', {
        status: target.status,
        firstStartedAt: target.first_started_at,
      }),
    };
  else if (normalized.missingFields.length)
    prediction = {
      status: 'UNAVAILABLE',
      unavailableReason: 'MISSING_REQUIRED_FEATURES',
      missingFields: normalized.missingFields,
      diagnostics: atlmDiagnostics('MISSING_REQUIRED_FEATURES', {
        missingFields: normalized.missingFields,
      }),
    };
  else
    prediction = await earlyForecast(
      db,
      ownerId,
      args.planId,
      await predictWithActiveModel(db, ownerId, normalized.features, nowMs),
      nowMs,
    );
  return {
    formatVersion: 2,
    metric: 'PLAN_ACTIVE',
    forecastScope: 'FULL_FROM_FIRST_START',
    method: prediction.method ?? { ...ATLM_METHOD },
    status: prediction.status,
    pointMs: prediction.pointMs ?? null,
    modelId: prediction.modelId ?? null,
    ...(prediction.modelRevisionId ? { modelRevisionId: prediction.modelRevisionId } : {}),
    modelVersion: prediction.modelVersion ?? null,
    ...(prediction.modelRevision ? { modelRevision: prediction.modelRevision } : {}),
    requirementsDigest: target.requirementsDigest,
    featureDigest: 'sha256:' + (await hashCommandInput(normalized.features)),
    calculatedAt: nowMs,
    sampleCount: prediction.sampleCount ?? 0,
    evaluation: prediction.evaluation ?? null,
    accuracy: prediction.accuracy ?? 'NOT_VALIDATED',
    pointEngine: prediction.pointEngine ?? (prediction.fallback ? 'MEDIAN' : null),
    interval:
      prediction.interval ??
      atlmUnavailableInterval(
        'BAYESIAN_PREDICTIVE',
        prediction.unavailableReason ?? 'HISTORICAL_BASELINE',
      ),
    unavailableReason: prediction.unavailableReason ?? null,
    diagnostics: prediction.diagnostics ?? null,
    ...(prediction.fallback ? { fallback: prediction.fallback } : {}),
    ...(prediction.hybrid ? { hybrid: prediction.hybrid } : {}),
    ...(prediction.missingFields ? { missingFields: prediction.missingFields } : {}),
  };
}

const CURRENT_FORECAST_MAX_READ_ATTEMPTS = 3;

const CURRENT_FORECAST_INPUT_SQL = `SELECT input.*,
  json_array(status,first_started_at,deleted_at,requirements_json,sequence,dataset_revision,
    active_model_id,activation_version,model_status,source_problem,history_jobs_json) AS start_key,
  json_array(status,first_started_at,deleted_at,requirements_json,sequence,dataset_revision,
    active_model_id,activation_version,model_status,source_problem,jobs_json) AS snapshot_key
  FROM (SELECT p.status,p.first_started_at,p.deleted_at,t.requirements_json,
    a.sequence,a.assessment_id,a.revision,a.requirements_digest,a.assessment_json,
    COALESCE(o.dataset_revision,0) AS dataset_revision,active.model_revision_id AS active_model_id,
    COALESCE(active.activation_version,0) AS activation_version,m.status AS model_status,m.source_problem,
    (SELECT json_group_array(json_array(job_key,generation,processed_generation,status))
      FROM (SELECT j.job_key,j.generation,j.processed_generation,j.status
      FROM estimation_jobs j WHERE j.owner_id=p.owner_id AND
        (EXISTS(SELECT 1 FROM estimation_samples s WHERE s.owner_id=j.owner_id AND s.plan_id=j.plan_id)
        OR EXISTS(SELECT 1 FROM plans h WHERE h.owner_id=j.owner_id AND h.plan_id=j.plan_id AND h.status='COMPLETED'))
      ORDER BY j.job_key)) AS history_jobs_json,
    (SELECT json_group_array(json_array(job_key,generation,processed_generation,status))
      FROM (SELECT j.job_key,j.generation,j.processed_generation,j.status
      FROM estimation_jobs j WHERE j.owner_id=p.owner_id ORDER BY j.job_key)) AS jobs_json
    FROM plans p JOIN assessment_targets t ON t.owner_id=p.owner_id AND t.plan_id=p.plan_id AND t.step_id IS NULL
    LEFT JOIN assessment_revisions a ON a.sequence=(SELECT MAX(r.sequence) FROM assessment_revisions r
      WHERE r.owner_id=p.owner_id AND r.plan_id=p.plan_id AND r.step_id IS NULL)
    LEFT JOIN estimation_owner_state o ON o.owner_id=p.owner_id
    LEFT JOIN estimation_active_revisions active ON active.owner_id=p.owner_id
    LEFT JOIN estimation_serving_models m ON m.owner_id=active.owner_id AND m.model_id=active.model_revision_id
    WHERE p.owner_id=? AND p.plan_id=?) input`;

async function currentForecastInput(db, ownerId, planId) {
  return dbFirst(db, CURRENT_FORECAST_INPUT_SQL, ownerId, planId);
}

async function currentPlanForecast(db, ownerId, planId, nowMs) {
  for (let attempt = 0; attempt < CURRENT_FORECAST_MAX_READ_ATTEMPTS; attempt++) {
    const input = await currentForecastInput(db, ownerId, planId);
    if (!input) throw appError('PLAN_NOT_FOUND', messageFor('PLAN_NOT_FOUND'), 404);
    if (input.status !== 'PLANNED' || input.first_started_at !== null || input.deleted_at !== null)
      return null;
    const assessment = input.assessment_json ? JSON.parse(input.assessment_json) : null;
    const digest = 'sha256:' + (await hashCommandInput(JSON.parse(input.requirements_json)));
    const readiness = await assessmentReadiness(assessment, input.requirements_digest, digest);
    let estimation;
    const unavailable = (code) => ({
      formatVersion: 2,
      metric: 'PLAN_ACTIVE',
      forecastScope: 'FULL_FROM_FIRST_START',
      method: { ...ATLM_METHOD },
      status: 'UNAVAILABLE',
      pointMs: null,
      modelId: null,
      modelVersion: null,
      requirementsDigest: digest,
      calculatedAt: nowMs,
      sampleCount: 0,
      accuracy: 'NOT_VALIDATED',
      evaluation: null,
      pointEngine: null,
      interval: atlmUnavailableInterval('BAYESIAN_PREDICTIVE', code),
      unavailableReason: code,
      diagnostics: atlmDiagnostics(code),
    });
    if (readiness.status !== 'READY') estimation = unavailable(readiness.code);
    else {
      try {
        estimation = await calculateAtlmEstimate(
          db,
          ownerId,
          { planId, agentTask: assessment.context.agentTask, expectedRequirementsDigest: digest },
          nowMs,
        );
      } catch (error) {
        if (error.code === 'ASSESSMENT_CONTEXT_CHANGED') continue;
        throw error;
      }
    }
    const after = await currentForecastInput(db, ownerId, planId);
    if (canonical(input) !== canonical(after)) continue;
    const diagnostics = estimation.fallback?.atlmDiagnostics ?? estimation.diagnostics;
    return {
      input,
      result: {
        formatVersion: 1,
        planId,
        assessmentId: input.assessment_id ?? null,
        assessmentRevision: input.revision ?? null,
        source: 'CURRENT_INPUT',
        assessmentReadiness: readiness,
        serverEstimation: estimation,
        recordedEstimation: assessment?.serverEstimation ?? null,
        diagnostics,
        forecastAvailability: {
          planStatus: input.status,
          deleted: false,
          canCalculate: estimation.status === 'AVAILABLE',
          canRefreshSaved: true,
          calculationMethod: estimation.status === 'AVAILABLE' ? estimation.method : null,
          reason: estimation.status === 'AVAILABLE' ? null : estimation.unavailableReason,
          diagnostics: estimation.status === 'AVAILABLE' ? null : diagnostics,
        },
        isStale: false,
        staleReasons: [],
        serverNow: nowMs,
      },
    };
  }
  throw appError(
    'ASSESSMENT_CONTEXT_CHANGED',
    'Исходные признаки, статус плана или история изменились во время расчёта. Повторите обновление прогноза.',
    409,
  );
}

async function getPlanEstimate(db, ownerId, args, nowMs) {
  validateAssessmentValue(args, ATLM_TOOL_SCHEMAS.GetPlanEstimate);
  const current = await currentPlanForecast(db, ownerId, args.planId, nowMs);
  if (current) return current.result;
  const row = await dbFirst(
    db,
    `SELECT p.status,p.first_started_at,p.deleted_at,t.requirements_json AS current_requirements_json,
      a.assessment_id,a.revision,a.requirements_digest,a.assessment_json,i.forecast_json,i.requirements_json AS input_requirements_json,i.plan_id AS input_plan_id,o.data_reset_at
    FROM plans p JOIN assessment_targets t ON t.owner_id=p.owner_id AND t.plan_id=p.plan_id AND t.step_id IS NULL
    LEFT JOIN plan_estimation_inputs i ON i.owner_id=p.owner_id AND i.plan_id=p.plan_id
    LEFT JOIN estimation_owner_state o ON o.owner_id=p.owner_id
    LEFT JOIN assessment_revisions a ON a.owner_id=p.owner_id AND a.plan_id=p.plan_id AND a.sequence=CASE
      WHEN p.first_started_at IS NOT NULL THEN i.assessment_sequence
      ELSE (SELECT MAX(latest.sequence) FROM assessment_revisions latest WHERE latest.owner_id=p.owner_id AND latest.plan_id=p.plan_id
        AND latest.step_id IS NULL AND json_type(latest.assessment_json,'$.serverEstimation')='object') END
    WHERE p.owner_id=? AND p.plan_id=?`,
    ownerId,
    args.planId,
  );
  if (!row) throw appError('PLAN_NOT_FOUND', messageFor('PLAN_NOT_FOUND'), 404);
  if (row.status === 'PLANNED' && row.first_started_at === null && row.deleted_at === null)
    throw appError(
      'ASSESSMENT_CONTEXT_CHANGED',
      'Статус плана изменился. Повторите обновление прогноза.',
      409,
    );
  if (
    row.first_started_at !== null &&
    row.input_plan_id === null &&
    row.data_reset_at !== null &&
    row.first_started_at <= row.data_reset_at
  ) {
    const diagnostics = atlmDiagnostics('HISTORY_RESET');
    return {
      formatVersion: 1,
      planId: args.planId,
      assessmentId: null,
      assessmentRevision: null,
      source: 'HISTORY_RESET',
      assessmentReadiness: null,
      serverEstimation: null,
      recordedEstimation: null,
      diagnostics,
      forecastAvailability: {
        planStatus: row.status,
        deleted: row.deleted_at !== null,
        canCalculate: false,
        canRefreshSaved: false,
        calculationMethod: null,
        reason: 'HISTORY_RESET',
        diagnostics,
      },
      isStale: false,
      staleReasons: [],
      serverNow: nowMs,
    };
  }
  const recordedEstimation = row.assessment_json
    ? (JSON.parse(row.assessment_json).serverEstimation ?? null)
    : null;
  const serverEstimation =
    row.forecast_json !== null ? JSON.parse(row.forecast_json) : recordedEstimation;
  const staleReasons = [];
  if (serverEstimation) {
    if (row.deleted_at !== null) staleReasons.push('PLAN_DELETED');
    const digest = 'sha256:' + (await hashCommandInput(JSON.parse(row.current_requirements_json)));
    const frozenDigest =
      row.requirements_digest ??
      (row.input_requirements_json
        ? 'sha256:' + (await hashCommandInput(JSON.parse(row.input_requirements_json)))
        : null);
    if (digest !== frozenDigest) staleReasons.push('SCOPE_CHANGED');
    else if (
      row.first_started_at !== null &&
      (await readAtlmSampleSource(db, ownerId, args.planId, nowMs)).reasons.includes(
        'SCOPE_CHANGED',
      )
    )
      staleReasons.push('SCOPE_CHANGED');
    if (serverEstimation.fallback?.kind === 'HISTORICAL_MEDIAN') {
      const current = await historicalMedianForecast(db, ownerId, args.planId, nowMs);
      if (!current || current.fallback.sourceDigest !== serverEstimation.fallback.sourceDigest)
        staleReasons.push('BASELINE_SOURCE_CHANGED');
    }
    const revisionId = serverEstimation.modelRevisionId ?? serverEstimation.modelId;
    if (revisionId) {
      const model = await dbFirst(db,
        'SELECT status FROM estimation_serving_models WHERE owner_id=? AND model_id=?',
        ownerId, revisionId);
      if (!model || ['INVALIDATED', 'ARCHIVED'].includes(model.status)) staleReasons.push('MODEL_INVALIDATED');
    }
  }
  const canRefreshSaved =
    row.deleted_at === null && row.status === 'PLANNED' && row.first_started_at === null;
  const scopeDiagnostics =
    row.deleted_at !== null
      ? atlmDiagnostics('PLAN_DELETED')
      : !canRefreshSaved
        ? atlmDiagnostics('UNSUPPORTED_FORECAST_SCOPE', {
            status: row.status,
            firstStartedAt: row.first_started_at,
          })
        : null;
  let diagnostics = null;
  if (row.first_started_at !== null)
    diagnostics =
      serverEstimation?.fallback?.atlmDiagnostics ??
      serverEstimation?.diagnostics ??
      (!row.assessment_json ? atlmDiagnostics('MISSING_FEATURES') : null);
  else if (!row.assessment_json) diagnostics = atlmDiagnostics('MISSING_FEATURES');
  else {
    const assessment = JSON.parse(row.assessment_json);
    if (
      assessment.context?.agentTask?.schemaVersion === ATLM_FEATURE_VERSION &&
      row.deleted_at === null
    ) {
      const normalized = normalizeAgentTask(assessment.context.agentTask);
      if (normalized.missingFields.length)
        diagnostics = atlmDiagnostics('MISSING_REQUIRED_FEATURES', {
          missingFields: normalized.missingFields,
        });
      else {
        const model = await atlmReadActiveModel(db, ownerId);
        if (model) {
          const artifact = JSON.parse(model.artifact_json);
          if (!atlmArtifactValid(artifact))
            throw appError('SOURCE_UNAVAILABLE', 'Сохранённая модель ATLM повреждена.', 503, {
              reason: 'INVALID_ARTIFACT',
            });
          const preview = predictAtlm(artifact, normalized.features);
          if (preview.status !== 'AVAILABLE')
            diagnostics = atlmDiagnostics(preview.reason, preview);
        }
      }
    } else diagnostics = atlmDiagnostics('MISSING_FEATURES');
    if (!diagnostics) {
      const state = await readAtlmServingState(db, ownerId);
      if (!state.servingModelRevisionId) {
        const refresh = await readAtlmSampleRefreshStatus(db, ownerId, nowMs);
        diagnostics = atlmDiagnostics(state.activeModelRevisionId ? 'MODEL_INVALIDATED'
          : refresh.pendingCount ? 'SOURCES_PENDING'
            : refresh.failedCount ? 'SOURCE_REFRESH_FAILED' : 'COLLECTING_DATA');
      }
    }
  }
  let calculationMethod = !diagnostics ? { ...ATLM_METHOD } : null;
  if (
    canRefreshSaved &&
    diagnostics &&
    canUseHistoricalMedian({ status: 'UNAVAILABLE', diagnostics })
  ) {
    const baseline = await historicalMedianForecast(db, ownerId, args.planId, nowMs);
    if (baseline) calculationMethod = { ...HISTORICAL_MEDIAN_METHOD };
  }
  const availabilityDiagnostics = scopeDiagnostics || (!calculationMethod ? diagnostics : null);
  const forecastAvailability = {
    planStatus: row.status,
    deleted: row.deleted_at !== null,
    canCalculate: canRefreshSaved && !!calculationMethod,
    canRefreshSaved,
    calculationMethod: canRefreshSaved ? calculationMethod : null,
    reason: availabilityDiagnostics?.code ?? null,
    diagnostics: availabilityDiagnostics,
  };
  return {
    formatVersion: 1,
    planId: args.planId,
    assessmentId: row.assessment_id ?? null,
    assessmentRevision: row.revision ?? null,
    assessmentReadiness: await assessmentReadiness(
      row.assessment_json ? JSON.parse(row.assessment_json) : null,
      row.requirements_digest,
      'sha256:' + (await hashCommandInput(JSON.parse(row.current_requirements_json))),
    ),
    source:
      row.first_started_at !== null
        ? 'FROZEN_INPUT'
        : row.assessment_id
          ? 'LATEST_ASSESSMENT'
          : 'NONE',
    serverEstimation,
    recordedEstimation,
    diagnostics,
    forecastAvailability,
    isStale: staleReasons.length > 0,
    staleReasons,
    serverNow: nowMs,
  };
}

async function executeAtlmTool(db, ownerId, name, args, nowMs) {
  if (name === 'CalculateAtlmEstimate') return calculateAtlmEstimate(db, ownerId, args, nowMs);
  if (name === 'GetPlanEstimate') return getPlanEstimate(db, ownerId, args, nowMs);
  throw appError('FEATURE_REMOVED', messageFor('FEATURE_REMOVED'), 404);
}

export {
  CURRENT_FORECAST_INPUT_SQL,
  CURRENT_FORECAST_MAX_READ_ATTEMPTS,
  HISTORICAL_MEDIAN_METHOD,
  calculateAtlmEstimate,
  currentForecastInput,
  currentPlanForecast,
  executeAtlmTool,
};
