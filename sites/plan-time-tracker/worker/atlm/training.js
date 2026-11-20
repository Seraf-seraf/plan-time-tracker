import {
  appError,
  canonical,
  dbAll,
  dbFirst,
  hashCommandInput,
  messageFor,
} from '../shared/index.js';
import {
  ATLM_FEATURE_VERSION,
  ATLM_INTERNAL_REPLAY,
  ATLM_MAX_ROWS,
  ATLM_METHOD,
  ATLM_MIN_COMPARISONS,
  ATLM_MS_PER_MINUTE,
  ATLM_OLS_METHOD,
  atlmFitCandidates,
  atlmFitDiagnostic,
  atlmHybridTargets,
  atlmReconstructResidual,
  atlmReplayPolicyCase,
  atlmTrainingRow,
  fitAtlm,
  fitAtlmResidualQuantiles,
  predictAtlm,
  selectAtlmIntervalEngine,
  selectHybridEngine,
  summarizeHybridAtlmEvaluation,
} from './model.js';
import { ATLM_ACTIVE_MODEL_FROM, atlmSampleView, claimAtlmJob, persistAtlmSample, readAtlmSampleSource } from './sample.js';

const ATLM_RETRAIN_EVERY_NEW_PLANS = 2;

const ATLM_TRAINING_LEASE_MS = 60000;

const ATLM_TRAINING_BUDGET_MS = 10000;
const ATLM_TRAINING_CHECKPOINT_RESERVE_MS = 1000;
const ATLM_TRAINING_MAX_STALLED_PASSES = 3;

const ATLM_TRAINING_LIMIT = 5000;

const ATLM_TRAINING_RETRY_MS = [60000, 300000, 900000];

const ATLM_LATEST_SAMPLE_SQL =
  's.sequence=(SELECT MAX(current.sequence) FROM estimation_samples current WHERE current.owner_id=s.owner_id AND current.plan_id=s.plan_id)';

const ATLM_PENDING_REFRESH_SQL =
  "SELECT 1 FROM estimation_jobs r WHERE r.owner_id=estimation_owner_state.owner_id AND r.kind='REFRESH_SAMPLE' AND r.generation>r.processed_generation";

function atlmAttemptId(job) {
  return 'g' + job.generation + '-a' + job.attempts;
}

async function atlmEnsureAttempt(db, ownerId, job, nowMs) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO estimation_training_attempts(owner_id,attempt_id,started_at,method_version,feature_version,dataset_revision,manifest_json)
    SELECT ?,?,?,?, ?,COALESCE(json_extract(j.snapshot_json,'$.datasetRevision'),
      (SELECT dataset_revision FROM estimation_owner_state WHERE owner_id=?),0),
      COALESCE(json_extract(j.snapshot_json,'$.manifest'),'[]')
    FROM estimation_jobs j WHERE owner_id=? AND job_key='train' AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?`,
    )
    .bind(
      ownerId,
      atlmAttemptId(job),
      nowMs,
      ATLM_METHOD.version,
      ATLM_FEATURE_VERSION,
      ownerId,
      ownerId,
      job.generation,
      job.fence,
      nowMs,
    )
    .run();
}

function atlmTrainingJson(value, fallback = null) {
  return value == null ? fallback : (JSON.parse(value) ?? fallback);
}

function atlmTrainingErrorCode(error) {
  return [
    'INVALID_ESTIMATION_SOURCE',
    'SOURCE_UNAVAILABLE',
    'INTERNAL_ERROR',
    'DATASET_LIMIT_REACHED',
  ].includes(error?.code)
    ? error.code
    : 'TRAINING_EXECUTION_FAILED';
}

function atlmJobDue(job, nowMs) {
  if (!job || job.generation <= job.processed_generation || job.status === 'FAILED') return false;
  if (job.status === 'RUNNING') return job.lease_until <= nowMs;
  return job.next_attempt_at <= nowMs;
}

function atlmDiagnostics(code, facts = {}) {
  const parameters = facts.sampleCountIsLowerBound ? { sampleCountIsLowerBound: true } : {};
  for (const key of [
    'sampleCount',
    'p',
    'residualDegreesOfFreedom',
    'rank',
    'limit',
    'status',
    'firstStartedAt',
    'phase',
    'completedCases',
    'stalledPasses',
    'passElapsedMs',
    'recoveredAt',
  ])
    if (
      facts[key] !== undefined &&
      facts[key] !== null &&
      (typeof facts[key] === 'string' || Number.isFinite(facts[key]))
    )
      parameters[key] = facts[key];
  if (Array.isArray(facts.missingFields))
    parameters.missingFields = facts.missingFields
      .filter((x) => typeof x === 'string')
      .slice(0, 20);
  const messages = {
    ...Object.fromEntries(
      [
        'ASSESSMENT_REQUIRED',
        'ASSESSMENT_INCOMPLETE',
        'ASSESSMENT_INVALID',
        'ASSESSMENT_SCHEMA_OUTDATED',
        'ASSESSMENT_CONTEXT_CHANGED',
      ].map((reason) => [reason, messageFor(reason)]),
    ),
    AVAILABLE: 'Модель успешно обучена.',
    MISSING_FEATURES: 'До первого запуска не сохранены исходные признаки задачи.',
    HISTORY_RESET:
      'Исходная оценка удалена при переходе на новую историю ATLM. Для уже начатого плана прогноз задним числом не создаётся.',
    MISSING_REQUIRED_FEATURES:
      'Не заполнены обязательные параметры: ' +
      (parameters.missingFields?.join(', ') || 'workUnits, doneBoundary') +
      '.',
    SCOPE_CHANGED:
      'Требования плана изменились. Сохраните актуальную оценку исходных признаков: expectedRequirementsDigest не совпадает.',
    INCOMPLETE_FEATURES:
      'Не заполнены обязательные параметры: ' +
      (parameters.missingFields?.join(', ') || 'missingFields не сохранён') +
      '.',
    TRAINING_NOT_STARTED: 'Обучение модели ещё не выполнялось. Активной модели нет.',
    INSUFFICIENT_DATA: 'Недостаточно данных для расчёта коэффициентов модели.',
    RANK_DEFICIENT:
      'Не удаётся независимо оценить коэффициенты: признаки в обучающей выборке линейно зависимы.',
    MODEL_CAPACITY_LIMIT: 'Число коэффициентов превышает ресурсный предел модели.',
    MODEL_RESOURCE_LIMIT: 'Расчёт модели превышает установленный предел вычислений.',
    TRAINING_TIME_BUDGET:
      'Обучение остановилось после нескольких проходов без прогресса в пределах бюджета времени.',
    DATASET_LIMIT_REACHED: 'Число обучающих примеров превышает допустимый предел.',
    UNSUPPORTED_FORECAST_SCOPE:
      'Новый расчёт доступен только до первого запуска плана. Показана исходная сохранённая оценка.',
    PLAN_DELETED: 'План удалён. Новый расчёт недоступен.',
    TRAINING_IN_PROGRESS: 'Обучение или обновление исходных данных ещё не завершено.',
    COLLECTING_DATA: 'Активной модели нет. Подробные параметры последней попытки не сохранены.',
    MODEL_INVALIDATED:
      'Исходные данные сохранённой модели изменились. Требуется повторное обучение.',
    UNSUPPORTED_CATEGORY:
      'В обученной модели отсутствует категория обязательного признака этой задачи. Параметры: ' +
      (parameters.unsupportedFields?.join(', ') || 'не сохранены') +
      '.',
    INVALID_FEATURES: 'Исходные параметры не соответствуют схеме задачи.',
    INVALID_PREDICTION: 'Модель не смогла получить конечное неотрицательное время.',
    INVALID_ARTIFACT: 'Сохранённая модель повреждена или не соответствует текущей версии.',
    NUMERICAL_FAILURE: 'При расчёте коэффициентов получены некорректные числовые значения.',
    SOURCE_UNAVAILABLE: 'Источник исходных данных или сохранённой модели недоступен.',
    TRAINING_EXECUTION_FAILED: 'Во время обучения произошёл технический сбой.',
    LEASE_EXPIRED: 'Попытка обучения не завершилась в отведённое время.',
    MEDIAN_BASELINE_BETTER: 'Новая модель ошибается сильнее медианы прошлых длительностей.',
    MEDIAN_BASELINE_NOT_WORSE:
      'Медиана прошлых длительностей не хуже проверенных обучаемых способов. Новая обученная модель не активирована.',
    CANDIDATE_MAE_WORSE: 'Средняя ошибка новой модели выше, чем у действующей.',
    CANDIDATE_COVERAGE_WORSE: 'Новая модель оценивает меньшую долю задач, чем действующая.',
    INSUFFICIENT_INCUMBENT_CASES:
      'Недостаточно проверочных сравнений для замены действующей модели.',
    SNAPSHOT_INVALIDATED: 'Исходные данные изменились во время обучения. Требуется новая попытка.',
  };
  let message = messages[code] || 'Расчёт недоступен. Причина: ' + String(code) + '.';
  const values = Object.entries(parameters)
    .filter(([key]) => key !== 'missingFields' && key !== 'unsupportedFields')
    .map(([key, value]) => key + '=' + String(value));
  if (values.length) message += ' ' + values.join(', ') + '.';
  if (code === 'INSUFFICIENT_DATA' && parameters.p !== undefined)
    message += ' Требуется sampleCount >= p и независимость признаков.';
  return { code, message, parameters };
}

function atlmAttemptDiagnostics(result, snapshot, job, nowMs) {
  const candidates = result.details?.candidates;
  return {
    ...atlmDiagnostics(result.reason || 'AVAILABLE', {
      sampleCount: snapshot?.observedSampleCount,
      ...result.details?.artifact,
      ...result.details,
      status: undefined,
    }),
    ...(candidates
      ? {
          candidates: Object.fromEntries(
            ['ols', 'ridge', 'bayesian'].map((name) => [name, atlmFitDiagnostic(candidates[name])]),
          ),
        }
      : {}),
    ...(result.details?.selection ? { selection: result.details.selection } : {}),
    ...(result.evaluation?.incumbentComparison
      ? { incumbentComparison: result.evaluation.incumbentComparison }
      : {}),
    methodVersion: ATLM_METHOD.version,
    featureSchemaVersion: ATLM_FEATURE_VERSION,
    datasetRevision: snapshot?.datasetRevision ?? null,
    generation: job.generation,
    completedAt: nowMs,
  };
}

function atlmStatusDiagnostics(status) {
  if (status.activeModel) return null;
  if (status.activeModelInvalidated) {
    const diagnostic = atlmDiagnostics('MODEL_INVALIDATED');
    if (status.lastAttempt?.code === status.lastReason && status.lastReason) {
      diagnostic.cause = status.lastAttempt;
      diagnostic.message += ' Последняя попытка: ' + status.lastAttempt.message;
    }
    return diagnostic;
  }
  if (
    status.training?.pendingRefreshCount ||
    ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(status.training?.status)
  )
    return atlmDiagnostics('TRAINING_IN_PROGRESS', { status: status.training.status });
  if (
    status.lastAttempt?.code &&
    status.lastAttempt.code === status.lastReason &&
    status.lastAttempt.code !== 'AVAILABLE'
  )
    return status.lastAttempt;
  if (status.lastReason)
    return {
      ...atlmDiagnostics(status.lastReason),
      message:
        atlmDiagnostics(status.lastReason).message +
        ' Подробные параметры последней попытки не сохранены.',
    };
  return atlmDiagnostics('TRAINING_NOT_STARTED');
}

function atlmPublicEvaluation(evaluation) {
  if (!evaluation) return null;
  return {
    validationStatus: evaluation.validationStatus ?? 'EXPERIMENTAL',
    metricsScope: 'FULL_POLICY',
    ...(evaluation.metrics?.overall ?? {}),
    modelCaseCount: evaluation.paired?.caseCount ?? 0,
    medianBaselineMaeMs: evaluation.metrics?.median?.maeMs ?? null,
    profileGroupCount: evaluation.profileGroupCount ?? 0,
    excludedCaseCount: evaluation.excluded?.length ?? 0,
    cutoff: evaluation.cutoff ?? null,
    protocolVersion: evaluation.protocolVersion ?? 3,
  };
}

function atlmPublicModel(row) {
  const artifact = row ? atlmTrainingJson(row.artifact_json) : null;
  return row
    ? {
        modelId: row.model_id,
        modelVersion: row.model_version,
        ...(row.model_revision ? { modelRevision: row.model_revision } : {}),
        trainedAt: row.activated_at ?? row.created_at,
        method: artifact?.method ?? null,
        ...(artifact?.kind === 'HYBRID'
          ? {
              hybrid: {
                policyVersion: artifact.policyVersion,
                selectedEngine: artifact.selectedEngine,
                intervalEngine: artifact.intervalEngine,
              },
            }
          : {}),
        sampleCount: row.sample_count,
        accuracy:
          atlmTrainingJson(row.metrics_json)?.validationStatus === 'HISTORICALLY_EVALUATED'
            ? 'HISTORICALLY_EVALUATED'
            : 'EXPERIMENTAL',
        evaluation: atlmPublicEvaluation(atlmTrainingJson(row.metrics_json)),
      }
    : null;
}

async function atlmReadActiveModel(db, ownerId) {
  return dbFirst(db, `SELECT m.* ${ATLM_ACTIVE_MODEL_FROM}`, ownerId);
}

async function predictWithActiveModel(db, ownerId, features, nowMs) {
  const model = await atlmReadActiveModel(db, ownerId);
  const unavailable = (reason) => ({
    status: 'UNAVAILABLE',
    pointMs: null,
    modelId: null,
    modelVersion: null,
    sampleCount: 0,
    evaluation: null,
    unavailableReason: reason,
    accuracy: 'NOT_VALIDATED',
  });
  if (!model) {
    const state = await dbFirst(
      db,
      'SELECT active_model_id FROM estimation_owner_state WHERE owner_id=?',
      ownerId,
    );
    const reason = state?.active_model_id ? 'MODEL_INVALIDATED' : 'COLLECTING_DATA';
    return {
      ...unavailable(reason),
      diagnostics: atlmStatusDiagnostics(await getEstimationModelStatus(db, ownerId, nowMs)),
    };
  }
  let prediction;
  try {
    prediction = predictAtlm(atlmTrainingJson(model.artifact_json), features);
  } catch {
    throw appError('SOURCE_UNAVAILABLE', 'Сохранённая модель ATLM повреждена.', 503, {
      reason: 'INVALID_ARTIFACT',
    });
  }
  if (prediction.reason === 'INVALID_ARTIFACT')
    throw appError('SOURCE_UNAVAILABLE', 'Сохранённая модель ATLM повреждена.', 503, {
      reason: 'INVALID_ARTIFACT',
    });
  const metadata = {
    modelId: model.model_id,
    modelVersion: model.model_version,
    ...(model.model_revision ? { modelRevision: model.model_revision } : {}),
    sampleCount: model.sample_count,
    evaluation: atlmPublicEvaluation(atlmTrainingJson(model.metrics_json)),
    accuracy:
      atlmTrainingJson(model.metrics_json)?.validationStatus === 'HISTORICALLY_EVALUATED'
        ? 'HISTORICALLY_EVALUATED'
        : 'EXPERIMENTAL',
  };
  if (prediction.status !== 'AVAILABLE')
    return {
      ...unavailable(prediction.reason),
      ...metadata,
      diagnostics: atlmDiagnostics(prediction.reason, prediction),
      ...(prediction.missingFields ? { missingFields: prediction.missingFields } : {}),
    };
  return {
    status: 'AVAILABLE',
    pointMs: prediction.pointMs,
    ...metadata,
    unavailableReason: null,
    method: atlmTrainingJson(model.artifact_json).method,
    pointEngine: prediction.pointEngine ?? null,
    interval: prediction.interval ?? null,
    ...(prediction.hybrid ? { hybrid: prediction.hybrid } : {}),
  };
}

async function getEstimationModelStatus(db, ownerId, nowMs) {
  const [state, train, pending, counts, exclusions, active] = await Promise.all([
    dbFirst(db, 'SELECT * FROM estimation_owner_state WHERE owner_id=?', ownerId),
    dbFirst(db, "SELECT * FROM estimation_jobs WHERE owner_id=? AND job_key='train'", ownerId),
    dbAll(
      db,
      "SELECT * FROM estimation_jobs WHERE owner_id=? AND kind='REFRESH_SAMPLE' AND generation>processed_generation ORDER BY job_key",
      ownerId,
    ),
    dbFirst(
      db,
      `SELECT COUNT(*) AS total,COALESCE(SUM(s.eligibility='ELIGIBLE'),0) AS eligible FROM estimation_samples s WHERE s.owner_id=? AND ${ATLM_LATEST_SAMPLE_SQL}`,
      ownerId,
    ),
    dbAll(
      db,
      `SELECT reason.value AS reason,COUNT(*) AS count FROM estimation_samples s,json_each(s.reasons_json) reason
      WHERE s.owner_id=? AND ${ATLM_LATEST_SAMPLE_SQL} GROUP BY reason.value ORDER BY reason.value`,
      ownerId,
    ),
    atlmReadActiveModel(db, ownerId),
  ]);
  const newPlans = Math.max(
    0,
    (state?.new_sample_count ?? 0) - (state?.last_attempted_new_sample_count ?? 0),
  );
  const trainPending = Boolean(train && train.generation > train.processed_generation);
  const checkpoint = atlmTrainingJson(train?.checkpoint_json, {});
  const snapshot = atlmTrainingJson(train?.snapshot_json, {});
  const refreshFailed = pending.find((job) => job.status === 'FAILED');
  const refreshRunning = pending.find((job) => job.status === 'RUNNING' && job.lease_until > nowMs);
  const refreshWaiting = pending.find(
    (job) => job.status === 'RETRY_WAIT' && job.next_attempt_at > nowMs,
  );
  const triggerDue = Boolean(
    (state?.forced_retrain || newPlans >= ATLM_RETRAIN_EVERY_NEW_PLANS) &&
    !trainPending &&
    !pending.length,
  );
  const due =
    pending.some((job) => atlmJobDue(job, nowMs)) ||
    (!pending.length && atlmJobDue(train, nowMs)) ||
    triggerDue;
  let status = trainPending
    ? train.status
    : state?.last_training_status || (active ? 'IDLE' : 'COLLECTING_DATA');
  if (!active && status === 'IDLE') status = 'COLLECTING_DATA';
  if (refreshFailed && !due) status = 'FAILED';
  else if (refreshRunning) status = 'RUNNING';
  else if (refreshWaiting && !due) status = 'RETRY_WAIT';
  else if (pending.length || triggerDue) status = 'QUEUED';
  const nextAttemptAt = Math.min(
    ...[
      ...(trainPending && train?.next_attempt_at > nowMs ? [train.next_attempt_at] : []),
      ...pending
        .filter((job) => job.status === 'RETRY_WAIT' && job.next_attempt_at > nowMs)
        .map((job) => job.next_attempt_at),
    ],
  );
  return {
    method: { ...ATLM_METHOD },
    inputSchemaVersion: 'agent-task-v4',
    featureSchemaVersion: ATLM_FEATURE_VERSION,
    metric: 'PLAN_ACTIVE',
    forecastScope: 'FULL_FROM_FIRST_START',
    retrainEveryNewPlans: ATLM_RETRAIN_EVERY_NEW_PLANS,
    datasetRevision: state?.dataset_revision ?? 0,
    eligibleSampleCount: counts?.eligible ?? 0,
    excludedSampleCount: (counts?.total ?? 0) - (counts?.eligible ?? 0),
    newPlansSinceTraining: newPlans,
    exclusionReasons: exclusions,
    activeModel: atlmPublicModel(active),
    activeModelInvalidated: Boolean(state?.active_model_id && !active),
    training: {
      status,
      generation: train?.generation ?? state?.training_generation ?? 0,
      due,
      attempts: trainPending ? train.attempts : 0,
      nextAttemptAt: Number.isFinite(nextAttemptAt) ? nextAttemptAt : null,
      pendingRefreshCount: pending.length,
      progressRevision: checkpoint.progressRevision ?? 0,
      progress: {
        phase: checkpoint.phase ?? null,
        completedCases: checkpoint.completedCases ?? checkpoint.cases?.length ?? 0,
        totalCases: snapshot.selection?.caseSampleIds?.length ?? 0,
      },
    },
    lastError: refreshFailed?.last_error ?? train?.last_error ?? null,
    lastReason: state?.last_training_reason ?? null,
    lastAttempt: atlmTrainingJson(state?.last_training_diagnostics_json),
  };
}

function atlmEnqueueTrainingStatements(db, ownerId, nowMs) {
  return [
    db
      .prepare(
        `INSERT INTO estimation_jobs(owner_id,job_key,kind,generation,status,created_at,updated_at)
      SELECT owner_id,'train','TRAIN',training_generation+1,'QUEUED',?,? FROM estimation_owner_state
      WHERE owner_id=? AND (forced_retrain=1 OR new_sample_count-last_attempted_new_sample_count>=?)
        AND NOT EXISTS(${ATLM_PENDING_REFRESH_SQL})
      ON CONFLICT(owner_id,job_key) DO UPDATE SET generation=estimation_jobs.generation+1,
        processed_generation=estimation_jobs.generation,status='QUEUED',lease_until=NULL,attempts=0,next_attempt_at=0,
        snapshot_json=NULL,checkpoint_json=NULL,last_error=NULL,updated_at=excluded.updated_at
      WHERE estimation_jobs.generation=estimation_jobs.processed_generation OR estimation_jobs.status='FAILED'`,
      )
      .bind(nowMs, nowMs, ownerId, ATLM_RETRAIN_EVERY_NEW_PLANS),
    db
      .prepare(
        `UPDATE estimation_owner_state SET training_generation=COALESCE((SELECT generation FROM estimation_jobs WHERE owner_id=? AND job_key='train'),training_generation)
      WHERE owner_id=?`,
      )
      .bind(ownerId, ownerId),
  ];
}

async function atlmEnqueueTraining(db, ownerId, nowMs) {
  await db.batch(atlmEnqueueTrainingStatements(db, ownerId, nowMs));
}

async function atlmReleaseSuperseded(db, ownerId, job, nowMs) {
  await db
    .prepare(
      `UPDATE estimation_jobs SET status='QUEUED',executor_epoch=executor_epoch+2,lease_until=NULL,attempts=0,next_attempt_at=0,
    snapshot_json=NULL,checkpoint_json=NULL,last_error=NULL,updated_at=?
    WHERE owner_id=? AND job_key=? AND fence=? AND generation>? AND status='RUNNING' AND lease_until>?`,
    )
    .bind(nowMs, ownerId, job.job_key, job.fence, job.generation, nowMs)
    .run();
}

const ATLM_CHECKPOINT_FIELDS = [
  'baseCases',
  'policyCases',
  'cases',
  'calibrationProof',
  'finalCandidates',
  'quantileFit',
];

const ATLM_CHECKPOINT_CHARS = 32000;

const ATLM_CHECKPOINT_PACKET_CHARS = 128000;

const checkpointStorage = new WeakMap();

async function readAtlmCheckpoint(db, ownerId, job) {
  const header = atlmTrainingJson(job.checkpoint_json);
  if (!header?.storageId) return header;
  const checkpoint = { ...header };
  const saved = new Map();
  let cursor = 0,
    currentKey,
    parts = [],
    current;
  function finishItem() {
    if (!current) return;
    const value = JSON.parse(parts.join(''));
    checkpoint[current.field][current.item] = value;
    saved.set(currentKey, value);
  }
  for (const field of header.fields) checkpoint[field] = field === 'cases' ? [] : {};
  do {
    const rows = await dbAll(
      db,
      `SELECT rowid,field,item,part,content FROM estimation_checkpoint_parts
      WHERE owner_id=? AND generation=? AND storage_id=? AND rowid>? ORDER BY rowid LIMIT 64`,
      ownerId,
      job.generation,
      header.storageId,
      cursor,
    );
    for (const row of rows) {
      const key = row.field + ':' + row.item;
      if (key !== currentKey) {
        finishItem();
        current = row;
        currentKey = key;
        parts = [];
      }
      if (row.part !== parts.length) throw new Error('Invalid training checkpoint');
      parts.push(row.content);
      cursor = row.rowid;
    }
    if (rows.length < 64) break;
  } while (true);
  finishItem();
  checkpointStorage.set(checkpoint, { id: header.storageId, saved });
  return checkpoint;
}

async function atlmCheckpoint(
  db,
  ownerId,
  job,
  checkpoint,
  nowMs,
  { snapshot, release = false } = {},
) {
  const storage = checkpointStorage.get(checkpoint) ?? {
    id: crypto.randomUUID(),
    saved: new Map(),
  };
  checkpointStorage.set(checkpoint, storage);
  const header = {
    ...checkpoint,
    storageId: storage.id,
    fields: [],
    completedCases: checkpoint.cases?.length ?? 0,
  };
  const guard =
    "owner_id=? AND job_key=? AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?";
  const guardArgs = [ownerId, job.job_key, job.generation, job.fence, nowMs];
  const statements = [],
    pending = [];
  let packet = [],
    packetChars = 0;
  function flushPacket() {
    if (!packet.length) return;
    statements.push(
      db
        .prepare(
          `INSERT INTO estimation_checkpoint_parts(owner_id,generation,storage_id,field,item,part,content)
      SELECT ?,?,?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]')
      FROM json_each(?) WHERE EXISTS(SELECT 1 FROM estimation_jobs WHERE ${guard}) ORDER BY CAST(key AS INTEGER)`,
        )
        .bind(ownerId, job.generation, storage.id, '[' + packet.join(',') + ']', ...guardArgs),
    );
    packet = [];
    packetChars = 0;
  }
  for (const field of ATLM_CHECKPOINT_FIELDS) {
    delete header[field];
    if (!checkpoint[field]) continue;
    header.fields.push(field);
    for (const [item, value] of Object.entries(checkpoint[field])) {
      const key = field + ':' + item;
      if (storage.saved.get(key) === value) continue;
      // Entries describe immutable results. Chunks for an item are inserted in order.
      if (storage.saved.has(key)) throw new Error('Training checkpoint item changed');
      const json = JSON.stringify(value);
      for (let offset = 0, part = 0; offset < json.length; part++) {
        let end = Math.min(json.length, offset + ATLM_CHECKPOINT_CHARS);
        if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1])) end--;
        const entry = JSON.stringify([field, item, part, json.slice(offset, end)]);
        if (packetChars + entry.length > ATLM_CHECKPOINT_PACKET_CHARS) flushPacket();
        packet.push(entry);
        packetChars += entry.length + 1;
        offset = end;
      }
      pending.push([key, value]);
    }
  }
  flushPacket();
  const fields = ['checkpoint_json=?', 'updated_at=?'],
    values = [JSON.stringify(header), nowMs];
  if (snapshot !== undefined) {
    fields.push('snapshot_json=?');
    values.push(JSON.stringify(snapshot));
  }
  if (release)
    fields.push("status='QUEUED'", 'executor_epoch=executor_epoch+2', 'lease_until=NULL');
  const head = db
    .prepare(`UPDATE estimation_jobs SET ${fields.join(',')} WHERE ${guard} RETURNING fence`)
    .bind(...values, ...guardArgs);
  const result = statements.length
    ? (await db.batch([...statements, head])).at(-1).results[0]
    : await head.first();
  if (result) {
    for (const [key, value] of pending) storage.saved.set(key, value);
    job.checkpoint_json = JSON.stringify(header);
  }
  return result;
}

async function atlmManifestRows(db, ownerId, manifest) {
  const rows = await dbAll(
    db,
    `SELECT s.* FROM estimation_samples s WHERE s.owner_id=?
    AND s.sequence IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) ORDER BY s.sequence`,
    ownerId,
    JSON.stringify(manifest),
  );
  if (rows.length !== manifest.length)
    throw appError('INVALID_ESTIMATION_SOURCE', 'ATLM snapshot sources are unavailable.', 500);
  return rows.map((row) => ({
    sampleId: String(row.sequence),
    planId: row.plan_id,
    capturedAt: row.captured_at,
    sourceAvailableAt: row.source_available_at,
    features: atlmTrainingJson(row.features_json),
    actualMs: row.actual_ms,
  }));
}

async function atlmHistoricalRows(db, ownerId, snapshot, cutoff, excludePlanId) {
  const rows = await dbAll(
    db,
    `SELECT s.* FROM estimation_samples s WHERE s.owner_id=? AND s.sequence<=?
    AND s.observed_at<? AND s.sequence=(SELECT MAX(v.sequence) FROM estimation_samples v
      WHERE v.owner_id=s.owner_id AND v.plan_id=s.plan_id AND v.sequence<=? AND v.observed_at<?)
    AND s.eligibility='ELIGIBLE' AND s.source_available_at<? AND s.plan_id<>?
    ORDER BY s.plan_id,s.sequence LIMIT ?`,
    ownerId,
    snapshot.historyThroughSequence,
    cutoff,
    snapshot.historyThroughSequence,
    cutoff,
    cutoff,
    excludePlanId,
    ATLM_MAX_ROWS + 1,
  );
  return rows.map((row) => atlmTrainingRow(atlmSampleView(row)));
}

function atlmSourceValiditySql(
  owner = 'j.owner_id',
  manifest = "json_extract(j.snapshot_json,'$.manifest')",
) {
  return `NOT EXISTS(SELECT 1 FROM json_each(${manifest}) member
    LEFT JOIN estimation_samples s ON s.owner_id=${owner} AND s.sequence=CAST(member.value AS INTEGER)
    WHERE s.sequence IS NULL OR s.eligibility<>'ELIGIBLE' OR s.sequence<>(SELECT MAX(latest.sequence) FROM estimation_samples latest
      WHERE latest.owner_id=s.owner_id AND latest.plan_id=s.plan_id)
      OR EXISTS(SELECT 1 FROM estimation_jobs source WHERE source.owner_id=s.owner_id AND source.kind='REFRESH_SAMPLE'
        AND source.plan_id=s.plan_id AND source.generation>source.processed_generation))`;
}

async function atlmSnapshot(db, ownerId, job, clock) {
  const values = await db.batch([
    db.prepare('SELECT * FROM estimation_owner_state WHERE owner_id=?').bind(ownerId),
    db
      .prepare(
        `SELECT s.* FROM estimation_samples s WHERE s.owner_id=? AND ${ATLM_LATEST_SAMPLE_SQL} AND s.eligibility='ELIGIBLE' ORDER BY s.sequence LIMIT ?`,
      )
      .bind(ownerId, ATLM_TRAINING_LIMIT + 1),
    db
      .prepare(
        'SELECT * FROM estimation_serving_models WHERE owner_id=? AND preferred=1 AND pointer_id=(SELECT active_model_id FROM estimation_owner_state WHERE owner_id=?)',
      )
      .bind(ownerId, ownerId),
    db
      .prepare(
        'SELECT COALESCE(MAX(sequence),0) AS through_sequence FROM estimation_samples WHERE owner_id=?',
      )
      .bind(ownerId),
  ]);
  const state = values[0].results[0],
    sampleRows = values[1].results,
    previous = values[2].results[0];
  const nowMs = clock();
  if (sampleRows.some((row) => row.source_available_at > nowMs))
    throw appError('INVALID_ESTIMATION_SOURCE', 'ATLM source availability is in the future.', 500);
  const limited = sampleRows.length > ATLM_TRAINING_LIMIT;
  const manifest = limited ? [] : sampleRows.map((row) => row.sequence);
  const rows = limited
    ? []
    : sampleRows.map((row) => ({
        sampleId: String(row.sequence),
        planId: row.plan_id,
        capturedAt: row.captured_at,
        sourceAvailableAt: row.source_available_at,
        features: atlmTrainingJson(row.features_json),
        actualMs: row.actual_ms,
      }));
  const snapshot = {
    formatVersion: 1,
    methodVersion: ATLM_METHOD.version,
    featureSchemaVersion: ATLM_FEATURE_VERSION,
    generation: job.generation,
    modelId: 'atlm-' + job.generation,
    modelVersion: job.generation,
    trainCutoff: nowMs,
    datasetRevision: state.dataset_revision,
    historyThroughSequence: values[3].results[0].through_sequence,
    newSampleCount: state.new_sample_count,
    newSampleSequence: sampleRows.reduce((max, row) => Math.max(max, row.sequence), 0),
    activePointer: state.active_model_id,
    incumbentId:
      previous?.status === 'ACTIVE' &&
      [ATLM_METHOD.version, ATLM_OLS_METHOD.version].includes(previous.method_version) &&
      previous.feature_version === ATLM_FEATURE_VERSION
        ? previous.model_id
        : null,
    forcedRetrain: Boolean(state.forced_retrain),
    manifest,
    observedSampleCount: sampleRows.length,
    resourceLimitReached: limited,
    selection: limited
      ? null
      : {
          status: 'AVAILABLE',
          protocolVersion: 3,
          cutoff: nowMs,
          inputCount: rows.length,
          eligibleCount: rows.length,
          caseSampleIds: atlmHybridTargets(rows).map((row) => row.sampleId),
          excluded: [],
        },
  };
  if (
    !limited &&
    (snapshot.selection.status !== 'AVAILABLE' || snapshot.selection.eligibleCount !== rows.length)
  ) {
    throw appError(
      'INVALID_ESTIMATION_SOURCE',
      'ATLM eligible snapshot contains invalid sources.',
      500,
    );
  }
  const checkpoint = {
    phase: limited ? 'LIMIT' : 'EVALUATE',
    cases: [],
    baseCases: {},
    policyCases: {},
    progressRevision: 1,
  };
  const snapshotJson = JSON.stringify(snapshot);
  const checkpointJson = JSON.stringify(checkpoint);
  const results = await db.batch([
    db.prepare(`UPDATE estimation_jobs SET snapshot_json=?,checkpoint_json=?,updated_at=?
    WHERE owner_id=? AND job_key='train' AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?
      AND EXISTS(SELECT 1 FROM estimation_owner_state WHERE owner_id=? AND dataset_revision=?)
      AND NOT EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND kind='REFRESH_SAMPLE' AND generation>processed_generation)
    RETURNING *`).bind(snapshotJson, checkpointJson, nowMs, ownerId, job.generation, job.fence,
      nowMs, ownerId, state.dataset_revision, ownerId),
    db.prepare(`UPDATE estimation_training_attempts SET dataset_revision=?,manifest_json=?
      WHERE owner_id=? AND attempt_id=? AND completed_at IS NULL
        AND EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key='train'
          AND generation=? AND fence=? AND status='RUNNING' AND lease_until>? AND snapshot_json=?)`)
      .bind(snapshot.datasetRevision, JSON.stringify(manifest), ownerId, atlmAttemptId(job),
        ownerId, job.generation, job.fence, nowMs, snapshotJson),
  ]);
  const saved = results[0].results[0];
  if (saved) job.checkpoint_json = checkpointJson;
  return saved ? { snapshot, checkpoint, rows } : null;
}

function atlmCompareIncumbent(evaluation, incumbent) {
  if (!incumbent) return { accepted: true, reason: null, comparison: null };
  const artifact = atlmTrainingJson(incumbent.artifact_json);
  const seenPlans = new Set((artifact.manifest || []).map((row) => row.planId));
  const cases = evaluation.cases.filter(
    (c) =>
      !seenPlans.has(c.planId) &&
      c.capturedAt >= incumbent.train_cutoff &&
      c.capturedAt > incumbent.latest_source_available_at,
  );
  const pairs = cases.map((c) => {
    const own = predictAtlm(artifact, c.features);
    if (own.reason === 'INVALID_ARTIFACT')
      throw appError('SOURCE_UNAVAILABLE', 'Сохранённая модель ATLM повреждена.', 503);
    const fallback = ['UNSUPPORTED_CATEGORY', 'INVALID_PREDICTION'].includes(own.reason)
      ? c.median
      : own;
    return {
      candidate: c.prediction ?? c.atlm,
      incumbent: own.status === 'AVAILABLE' ? own : fallback,
      candidateOwn: c.atlm.status === 'AVAILABLE',
      incumbentOwn: own.status === 'AVAILABLE',
      actualMs: c.actualMs,
    };
  });
  const candidateCount = pairs.filter((p) => p.candidateOwn).length;
  const incumbentCount = pairs.filter((p) => p.incumbentOwn).length;
  const common = pairs.filter(
    (p) => p.candidate.status === 'AVAILABLE' && p.incumbent.status === 'AVAILABLE',
  );
  const mae = (key) =>
    common.length
      ? common.reduce((sum, p) => sum + Math.abs(p[key].pointMs - p.actualMs), 0) / common.length
      : null;
  const comparison = {
    caseCount: cases.length,
    commonCaseCount: common.length,
    requiredCaseCount: ATLM_MIN_COMPARISONS,
    candidateCoverage: cases.length ? candidateCount / cases.length : 0,
    incumbentCoverage: cases.length ? incumbentCount / cases.length : 0,
    candidateMaeMs: mae('candidate'),
    incumbentMaeMs: mae('incumbent'),
  };
  if (common.length < ATLM_MIN_COMPARISONS)
    return { accepted: false, reason: 'INSUFFICIENT_INCUMBENT_CASES', comparison };
  return {
    accepted:
      candidateCount >= incumbentCount && comparison.candidateMaeMs <= comparison.incumbentMaeMs,
    reason:
      candidateCount < incumbentCount
        ? 'CANDIDATE_COVERAGE_WORSE'
        : comparison.candidateMaeMs > comparison.incumbentMaeMs
          ? 'CANDIDATE_MAE_WORSE'
          : null,
    comparison,
  };
}

async function atlmFinalizeTraining(db, ownerId, job, snapshot, checkpoint, result, nowMs) {
  const finalGuard = `EXISTS(SELECT 1 FROM estimation_jobs j JOIN estimation_owner_state o ON o.owner_id=j.owner_id
    WHERE j.owner_id=? AND j.job_key='train' AND j.generation=? AND j.fence=? AND j.status='RUNNING' AND j.lease_until>?
      AND o.active_model_id IS ? ${result.activate ? 'AND ' + atlmSourceValiditySql() : ''})`;
  const guardValues = [ownerId, job.generation, job.fence, nowMs, snapshot.activePointer];
  const modelStatus = result.activate ? 'CANDIDATE' : 'REJECTED';
  const digest =
    result.artifact?.datasetDigest ||
    'sha256:' +
      (await hashCommandInput({
        manifest: snapshot.manifest,
        datasetRevision: snapshot.datasetRevision,
      }));
  const statements = [
    db
      .prepare(
        `INSERT OR IGNORE INTO estimation_models(owner_id,model_id,model_version,status,artifact_json,manifest_json,dataset_digest,
      train_cutoff,metrics_json,sample_count,reason,created_at,method_version,feature_version)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${finalGuard}`,
      )
      .bind(
        ownerId,
        snapshot.modelId,
        snapshot.modelVersion,
        modelStatus,
        result.artifact ? JSON.stringify(result.artifact) : null,
        JSON.stringify(snapshot.manifest),
        digest,
        snapshot.trainCutoff,
        result.evaluation ? JSON.stringify(result.evaluation) : null,
        snapshot.manifest.length,
        result.reason,
        nowMs,
        ATLM_METHOD.version,
        ATLM_FEATURE_VERSION,
        ...guardValues,
      ),
  ];
  const candidateGuard = `${finalGuard} AND EXISTS(SELECT 1 FROM estimation_models WHERE owner_id=? AND model_id=? AND status=?)`;
  const candidateValues = [...guardValues, ownerId, snapshot.modelId, modelStatus];
  if (result.activate) {
    statements.push(
      db
        .prepare(
          `UPDATE estimation_models SET status='RETIRED' WHERE owner_id=? AND status='ACTIVE' AND ${candidateGuard}`,
        )
        .bind(ownerId, ...candidateValues),
    );
    statements.push(
      db
        .prepare(
          `UPDATE estimation_models SET status='ACTIVE',activated_at=? WHERE owner_id=? AND model_id=? AND status='CANDIDATE' AND ${finalGuard}`,
        )
        .bind(nowMs, ownerId, snapshot.modelId, ...guardValues),
    );
  }
  // Only an artifact successfully inserted by this fenced generation may acknowledge its experience.
  const completedGuard = `${finalGuard} AND EXISTS(SELECT 1 FROM estimation_models WHERE owner_id=? AND model_id=? AND status=?)`;
  const completedValues = [
    ...guardValues,
    ownerId,
    snapshot.modelId,
    result.activate ? 'ACTIVE' : 'REJECTED',
  ];
  const historyCases =
    result.evaluation?.cases?.map((item) => ({
      planId: item.planId,
      sampleId: item.sampleId,
      capturedAt: item.capturedAt,
      sourceAvailableAt: item.sourceAvailableAt,
    })) ?? [];
  statements.push(
    db
      .prepare(
        `UPDATE estimation_training_attempts SET completed_at=?,dataset_revision=?,manifest_json=?,diagnostics_json=?,case_ids_json=?,metrics_json=?,selected_json=?,reason=?
    WHERE owner_id=? AND attempt_id=? AND completed_at IS NULL AND ${completedGuard}`,
      )
      .bind(
        nowMs,
        snapshot.datasetRevision,
        JSON.stringify(snapshot.manifest),
        JSON.stringify(atlmAttemptDiagnostics(result, snapshot, job, nowMs)),
        JSON.stringify(historyCases),
        result.evaluation?.metrics ? JSON.stringify(result.evaluation.metrics) : null,
        result.details?.selection
          ? JSON.stringify({
              point: result.details.selection,
              interval: result.details.intervalSelection ?? null,
            })
          : null,
        result.reason,
        ownerId,
        atlmAttemptId(job),
        ...completedValues,
      ),
  );
  statements.push(
    db
      .prepare(
        `UPDATE estimation_owner_state SET last_attempted_new_sample_count=MAX(last_attempted_new_sample_count,?),
    last_attempted_new_sample_sequence=MAX(last_attempted_new_sample_sequence,?),last_training_status=?,last_training_reason=?,last_training_diagnostics_json=?,updated_at=?,
    manual_epoch=manual_epoch+1,forced_retrain=CASE WHEN dataset_revision=? AND NOT EXISTS(${ATLM_PENDING_REFRESH_SQL}) THEN 0 ELSE forced_retrain END
    WHERE owner_id=? AND ${completedGuard}`,
      )
      .bind(
        snapshot.newSampleCount,
        snapshot.newSampleSequence,
        result.status,
        result.reason,
        JSON.stringify(atlmAttemptDiagnostics(result, snapshot, job, nowMs)),
        nowMs,
        snapshot.datasetRevision,
        ownerId,
        ...completedValues,
      ),
  );
  // Update the pointer last, after all guards which compare the old pointer.
  if (result.activate)
    statements.push(
      db
        .prepare(
          `UPDATE estimation_owner_state SET active_model_id=? WHERE owner_id=? AND ${completedGuard}`,
        )
        .bind(snapshot.modelId, ownerId, ...completedValues),
    );
  // Pointer now names the candidate on success; use the same fence and immutable model receipt.
  statements.push(
    db
      .prepare(
        `UPDATE estimation_jobs SET processed_generation=generation,status='IDLE',executor_epoch=executor_epoch+2,lease_until=NULL,next_attempt_at=0,last_error=?,
    checkpoint_json=?,updated_at=? WHERE owner_id=? AND job_key='train' AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?
    AND EXISTS(SELECT 1 FROM estimation_models WHERE owner_id=? AND model_id=? AND status=?)`,
      )
      .bind(
        result.status === 'FAILED' ? result.reason : null,
        JSON.stringify({
          phase: 'DONE',
          completedCases: checkpoint.cases?.length ?? 0,
          progressRevision: checkpoint.progressRevision + 1,
        }),
        nowMs,
        ownerId,
        job.generation,
        job.fence,
        nowMs,
        ownerId,
        snapshot.modelId,
        result.activate ? 'ACTIVE' : 'REJECTED',
      ),
  );
  statements.push(...atlmEnqueueTrainingStatements(db, ownerId, nowMs));
  await db.batch(statements);
  const receipt = await dbFirst(
    db,
    'SELECT status FROM estimation_models WHERE owner_id=? AND model_id=?',
    ownerId,
    snapshot.modelId,
  );
  return Boolean(receipt && receipt.status === (result.activate ? 'ACTIVE' : 'REJECTED'));
}

async function atlmSupersedeSnapshot(db, ownerId, job, snapshot, nowMs) {
  const guard = `EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key='train' AND generation=?
    AND fence=? AND status='RUNNING' AND lease_until>?)`;
  const values = [ownerId, job.generation, job.fence, nowMs];
  // Keep the obsolete manifest as an immutable receipt, then allocate another generation.
  await db.batch([
    db
      .prepare(
        `UPDATE estimation_training_attempts SET completed_at=?,dataset_revision=?,manifest_json=?,reason='SNAPSHOT_INVALIDATED',
      diagnostics_json=json_object('code','SNAPSHOT_INVALIDATED') WHERE owner_id=? AND attempt_id=? AND completed_at IS NULL AND ${guard}`,
      )
      .bind(
        nowMs,
        snapshot.datasetRevision,
        JSON.stringify(snapshot.manifest),
        ownerId,
        atlmAttemptId(job),
        ...values,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO estimation_models(owner_id,model_id,model_version,status,manifest_json,dataset_digest,
      train_cutoff,sample_count,reason,created_at,method_version,feature_version)
      SELECT ?,?,?,'REJECTED',?,?,?,?, 'SNAPSHOT_INVALIDATED',?,?,? WHERE ${guard}`,
      )
      .bind(
        ownerId,
        snapshot.modelId,
        snapshot.modelVersion,
        JSON.stringify(snapshot.manifest),
        'sha256:' +
          (await hashCommandInput({
            manifest: snapshot.manifest,
            datasetRevision: snapshot.datasetRevision,
          })),
        snapshot.trainCutoff,
        snapshot.manifest.length,
        nowMs,
        ATLM_METHOD.version,
        ATLM_FEATURE_VERSION,
        ...values,
      ),
    db
      .prepare(
        `UPDATE estimation_jobs SET processed_generation=generation,generation=generation+1,status='QUEUED',executor_epoch=executor_epoch+2,
      lease_until=NULL,attempts=0,next_attempt_at=0,snapshot_json=NULL,checkpoint_json=NULL,last_error=NULL,updated_at=?
      WHERE owner_id=? AND job_key='train' AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?`,
      )
      .bind(nowMs, ...values),
    db
      .prepare(
        `UPDATE estimation_owner_state SET training_generation=(SELECT generation FROM estimation_jobs WHERE owner_id=? AND job_key='train'),
      last_training_status='QUEUED',last_training_reason='SNAPSHOT_INVALIDATED',updated_at=?
      WHERE owner_id=? AND EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key='train' AND generation=? AND fence=?)`,
      )
      .bind(ownerId, nowMs, ownerId, ownerId, job.generation + 1, job.fence),
  ]);
}

async function atlmRecordFailure(db, ownerId, job, error, nowMs, details) {
  const code = atlmTrainingErrorCode(error),
    exhausted = job.attempts >= 4;
  const snapshot = atlmTrainingJson(job.snapshot_json);
  const nextAttempt = exhausted ? 0 : nowMs + ATLM_TRAINING_RETRY_MS[Math.max(0, job.attempts - 1)];
  const statements = [];
  if (job.kind === 'TRAIN')
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO estimation_training_attempts(owner_id,attempt_id,started_at,method_version,feature_version,dataset_revision,manifest_json)
    SELECT ?,?,?,?,?,COALESCE((SELECT dataset_revision FROM estimation_owner_state WHERE owner_id=?),0),'[]'
    WHERE EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key='train' AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?)`,
        )
        .bind(
          ownerId,
          atlmAttemptId(job),
          job.updated_at,
          ATLM_METHOD.version,
          ATLM_FEATURE_VERSION,
          ownerId,
          ownerId,
          job.generation,
          job.fence,
          nowMs,
        ),
    );
  if (job.kind === 'TRAIN')
    statements.push(
      db
        .prepare(
          `UPDATE estimation_training_attempts SET completed_at=?,reason=?,diagnostics_json=?,
            dataset_revision=COALESCE(?,dataset_revision),manifest_json=COALESCE(?,manifest_json)
    WHERE owner_id=? AND attempt_id=? AND completed_at IS NULL
      AND EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key='train' AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?)`,
        )
        .bind(
          nowMs,
          code,
          JSON.stringify(atlmAttemptDiagnostics({ reason: code, details }, snapshot, job, nowMs)),
          snapshot?.datasetRevision ?? null,
          snapshot ? JSON.stringify(snapshot.manifest) : null,
          ownerId,
          atlmAttemptId(job),
          ownerId,
          job.generation,
          job.fence,
          nowMs,
        ),
    );
  if (exhausted && job.kind === 'TRAIN')
    statements.push(
      db
        .prepare(
          `UPDATE estimation_owner_state SET
    last_attempted_new_sample_count=MAX(last_attempted_new_sample_count,COALESCE(?,new_sample_count)),
    last_attempted_new_sample_sequence=MAX(last_attempted_new_sample_sequence,COALESCE(?,(SELECT MAX(sequence) FROM estimation_samples WHERE owner_id=estimation_owner_state.owner_id),0)),
    last_training_status='FAILED',last_training_reason=?,last_training_diagnostics_json=?,
    manual_epoch=manual_epoch+1,forced_retrain=CASE WHEN NOT EXISTS(${ATLM_PENDING_REFRESH_SQL}) THEN 0 ELSE forced_retrain END,updated_at=?
    WHERE owner_id=? AND EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key=? AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?)`,
        )
        .bind(
          snapshot?.newSampleCount ?? null,
          snapshot?.newSampleSequence ?? null,
          code,
          JSON.stringify(atlmAttemptDiagnostics({ reason: code, details }, snapshot, job, nowMs)),
          nowMs,
          ownerId,
          ownerId,
          job.job_key,
          job.generation,
          job.fence,
          nowMs,
        ),
    );
  statements.push(
    db
      .prepare(
        `UPDATE estimation_jobs SET status=?,executor_epoch=executor_epoch+2,lease_until=NULL,next_attempt_at=?,last_error=?,updated_at=?
    WHERE owner_id=? AND job_key=? AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?`,
      )
      .bind(
        exhausted ? 'FAILED' : 'RETRY_WAIT',
        nextAttempt,
        code,
        nowMs,
        ownerId,
        job.job_key,
        job.generation,
        job.fence,
        nowMs,
      ),
  );
  await db.batch(statements);
  await atlmReleaseSuperseded(db, ownerId, job, nowMs);
}

async function processEstimationTraining(db, ownerId, nowMs, options = {}) {
  const wallClock =
    typeof options.wallClock === 'function' ? options.wallClock : () => performance.now();
  const started = wallClock();
  const clock =
    typeof options.clock === 'function'
      ? options.clock
      : () => nowMs + Math.max(0, Math.floor(wallClock() - started));
  const elapsed = () => Math.max(0, Math.floor(wallClock() - started));
  const budget = () => elapsed() < ATLM_TRAINING_BUDGET_MS;
  const canStartWork = () =>
    elapsed() < ATLM_TRAINING_BUDGET_MS - ATLM_TRAINING_CHECKPOINT_RESERVE_MS;
  await db
    .prepare(
      'INSERT OR IGNORE INTO estimation_owner_state(owner_id) SELECT owner_id FROM owners WHERE owner_id=?',
    )
    .bind(ownerId)
    .run();
  // A crashed fourth attempt remains failed until new source data creates another generation.
  const expiredAt = clock();
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO estimation_training_attempts(owner_id,attempt_id,started_at,method_version,feature_version,dataset_revision,manifest_json)
      SELECT j.owner_id,'g'||j.generation||'-a'||j.attempts,j.updated_at,?,?,
        COALESCE(json_extract(j.snapshot_json,'$.datasetRevision'),o.dataset_revision,0),COALESCE(json_extract(j.snapshot_json,'$.manifest'),'[]')
      FROM estimation_jobs j LEFT JOIN estimation_owner_state o ON o.owner_id=j.owner_id
      WHERE j.owner_id=? AND j.job_key='train' AND j.status='RUNNING' AND j.lease_until<=? AND j.attempts>0`,
      )
      .bind(ATLM_METHOD.version, ATLM_FEATURE_VERSION, ownerId, expiredAt),
    db
      .prepare(
        `WITH expired AS (
          SELECT * FROM estimation_jobs WHERE owner_id=? AND job_key='train'
            AND status='RUNNING' AND lease_until<=? AND attempts>0
        ) UPDATE estimation_training_attempts SET
          completed_at=(SELECT lease_until FROM expired),reason='LEASE_EXPIRED',
          dataset_revision=COALESCE((SELECT json_extract(snapshot_json,'$.datasetRevision') FROM expired),dataset_revision),
          manifest_json=COALESCE((SELECT json_extract(snapshot_json,'$.manifest') FROM expired),manifest_json),
          diagnostics_json=(SELECT json_object('code','LEASE_EXPIRED',
            'message','Попытка обучения не завершилась в отведённое время.',
            'parameters',json_object('sampleCount',json_extract(snapshot_json,'$.observedSampleCount'),
              'phase',COALESCE(json_extract(checkpoint_json,'$.phase'),'SNAPSHOT'),
              'completedCases',COALESCE(json_extract(checkpoint_json,'$.completedCases'),json_array_length(checkpoint_json,'$.cases'),0),
              'recoveredAt',?),
            'datasetRevision',json_extract(snapshot_json,'$.datasetRevision'),
            'generation',generation,'completedAt',lease_until) FROM expired)
        WHERE owner_id=? AND completed_at IS NULL
          AND attempt_id=(SELECT 'g'||generation||'-a'||attempts FROM expired)`,
      )
      .bind(ownerId, expiredAt, expiredAt, ownerId),
    db
      .prepare(
        `UPDATE estimation_owner_state SET last_attempted_new_sample_count=MAX(last_attempted_new_sample_count,
      COALESCE((SELECT json_extract(snapshot_json,'$.newSampleCount') FROM estimation_jobs WHERE owner_id=? AND job_key='train'),new_sample_count)),
      last_attempted_new_sample_sequence=MAX(last_attempted_new_sample_sequence,
        COALESCE((SELECT json_extract(snapshot_json,'$.newSampleSequence') FROM estimation_jobs WHERE owner_id=estimation_owner_state.owner_id AND job_key='train'),
          (SELECT MAX(sequence) FROM estimation_samples WHERE owner_id=estimation_owner_state.owner_id),0)),
      last_training_status='FAILED',last_training_reason='LEASE_EXPIRED',
      last_training_diagnostics_json=(SELECT a.diagnostics_json FROM estimation_training_attempts a
        JOIN estimation_jobs j ON j.owner_id=a.owner_id AND a.attempt_id='g'||j.generation||'-a'||j.attempts
        WHERE a.owner_id=estimation_owner_state.owner_id AND j.job_key='train'),updated_at=?,
      manual_epoch=manual_epoch+1,forced_retrain=CASE WHEN NOT EXISTS(${ATLM_PENDING_REFRESH_SQL}) THEN 0 ELSE forced_retrain END
      WHERE owner_id=? AND EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key='train'
        AND status='RUNNING' AND lease_until<=? AND attempts>=4)`,
      )
      .bind(ownerId, expiredAt, ownerId, ownerId, expiredAt),
    db
      .prepare(
        `UPDATE estimation_jobs SET status=CASE WHEN attempts>=4 THEN 'FAILED' WHEN attempts=0 THEN 'QUEUED' ELSE 'RETRY_WAIT' END,executor_epoch=executor_epoch+2,
      next_attempt_at=CASE WHEN attempts>=4 OR attempts=0 THEN 0 ELSE lease_until+CASE attempts WHEN 1 THEN 60000 WHEN 2 THEN 300000 ELSE 900000 END END,
      lease_until=NULL,last_error=CASE WHEN attempts=0 THEN NULL ELSE 'LEASE_EXPIRED' END,updated_at=?
      WHERE owner_id=? AND status='RUNNING' AND lease_until<=?`,
      )
      .bind(expiredAt, ownerId, expiredAt),
  ]);
  if (!budget())
    throw appError('SOURCE_UNAVAILABLE', 'Подготовка обучения превысила бюджет времени.', 503, {
      retryable: true,
      reason: 'TRAINING_TIME_BUDGET',
    });
  for (let operations = 0; operations < 100 && budget(); operations += 1) {
    await atlmEnqueueTraining(db, ownerId, clock());
    const next = await dbFirst(
      db,
      `SELECT * FROM estimation_jobs j WHERE j.owner_id=? AND j.generation>j.processed_generation
      AND j.status IN ('QUEUED','RETRY_WAIT') AND j.next_attempt_at<=?
      AND (j.kind='REFRESH_SAMPLE' OR NOT EXISTS(SELECT 1 FROM estimation_jobs r WHERE r.owner_id=j.owner_id AND r.kind='REFRESH_SAMPLE' AND r.generation>r.processed_generation))
      ORDER BY CASE j.kind WHEN 'REFRESH_SAMPLE' THEN 0 ELSE 1 END,j.updated_at,j.job_key LIMIT 1`,
      ownerId,
      clock(),
    );
    if (!next) break;
    let job = await claimAtlmJob(db, ownerId, next.job_key, clock(), ATLM_TRAINING_LEASE_MS, {
      allowExpiredLease: false,
    });
    if (!job) continue;
    try {
      if (job.kind === 'REFRESH_SAMPLE') {
        const source = await readAtlmSampleSource(db, ownerId, job.plan_id, clock());
        await persistAtlmSample(db, ownerId, source, clock(), {
          generation: job.generation,
          fence: job.fence,
        });
        await db
          .prepare(
            `UPDATE estimation_jobs SET processed_generation=generation,status='IDLE',executor_epoch=executor_epoch+2,lease_until=NULL,next_attempt_at=0,last_error=NULL,updated_at=?
          WHERE owner_id=? AND job_key=? AND generation=? AND fence=? AND status='RUNNING' AND lease_until>?`,
          )
          .bind(clock(), ownerId, job.job_key, job.generation, job.fence, clock())
          .run();
        await atlmReleaseSuperseded(db, ownerId, job, clock());
        continue;
      }
      await atlmEnsureAttempt(db, ownerId, job, clock());
      let snapshot = atlmTrainingJson(job.snapshot_json),
        checkpoint = await readAtlmCheckpoint(db, ownerId, job),
        rows;
      const initialRevision = checkpoint?.progressRevision ?? 0;
      if (
        !snapshot ||
        snapshot.methodVersion !== ATLM_METHOD.version ||
        snapshot.featureSchemaVersion !== ATLM_FEATURE_VERSION ||
        snapshot.selection?.protocolVersion !== 3 ||
        !checkpoint?.baseCases
      ) {
        const initial = await atlmSnapshot(db, ownerId, job, clock);
        if (!initial) {
          await atlmCheckpoint(
            db,
            ownerId,
            job,
            {
              phase: 'SNAPSHOT',
              cases: [],
              progressRevision: (checkpoint?.progressRevision ?? 0) + 1,
            },
            clock(),
            { release: true },
          );
          break;
        }
        ({ snapshot, checkpoint, rows } = initial);
        job.snapshot_json = JSON.stringify(snapshot);
      }
      if (snapshot.resourceLimitReached) {
        await atlmFinalizeTraining(
          db,
          ownerId,
          job,
          snapshot,
          checkpoint,
          {
            activate: false,
            status: 'FAILED',
            reason: 'DATASET_LIMIT_REACHED',
            details: {
              sampleCount: snapshot.observedSampleCount ?? ATLM_MAX_ROWS + 1,
              limit: ATLM_MAX_ROWS,
              sampleCountIsLowerBound: true,
            },
            artifact: null,
            evaluation: null,
          },
          clock(),
        );
        continue;
      }
      rows ||= await atlmManifestRows(db, ownerId, snapshot.manifest);
      if (snapshot.selection?.status !== 'AVAILABLE') {
        await atlmFinalizeTraining(
          db,
          ownerId,
          job,
          snapshot,
          checkpoint,
          {
            activate: false,
            status: 'COLLECTING_DATA',
            reason: snapshot.selection?.reason || 'INVALID_DATASET',
            details: { sampleCount: rows.length },
            artifact: null,
            evaluation: null,
          },
          clock(),
        );
        continue;
      }
      async function deferTraining(phase, evaluation = null) {
        const previous = checkpoint.stall;
        const stalled = checkpoint.progressRevision === initialRevision;
        const previousPasses = previous?.phase === phase ? previous.passes : 0;
        const stalledPasses = stalled ? previousPasses + 1 : 0;
        checkpoint.stall = { phase, passes: stalledPasses };
        if (stalledPasses < ATLM_TRAINING_MAX_STALLED_PASSES) {
          await atlmCheckpoint(db, ownerId, job, checkpoint, clock(), { release: true });
          return;
        }
        await atlmFinalizeTraining(
          db,
          ownerId,
          job,
          snapshot,
          checkpoint,
          {
            activate: false,
            status: 'FAILED',
            reason: 'TRAINING_TIME_BUDGET',
            details: {
              phase,
              sampleCount: rows.length,
              completedCases: checkpoint.cases.length,
              stalledPasses,
              passElapsedMs: elapsed(),
            },
            artifact: null,
            evaluation,
          },
          clock(),
        );
      }
      let lostLease = false,
        yielded = false;
      checkpoint.policyCases ||= {};
      const historyFor = (row) =>
        atlmHistoricalRows(db, ownerId, snapshot, row.capturedAt, row.planId);
      const replayYield = Symbol('ATLM_REPLAY_YIELD'),
        replayLost = Symbol('ATLM_REPLAY_LOST');
      const beforeReplayWork = async () => {
        if (!canStartWork()) throw replayYield;
      };
      const saveReplay = async () => {
        checkpoint.progressRevision++;
        if (!(await atlmCheckpoint(db, ownerId, job, checkpoint, clock()))) throw replayLost;
        if (!budget()) throw replayYield;
      };
      try {
        while (checkpoint.cases.length < snapshot.selection.caseSampleIds.length && budget()) {
          const target = rows.find(
            (row) => row.sampleId === snapshot.selection.caseSampleIds[checkpoint.cases.length],
          );
          const result = await atlmReplayPolicyCase(
            target,
            historyFor,
            checkpoint.baseCases,
            checkpoint.policyCases,
            saveReplay,
            beforeReplayWork,
          );
          if (result.status === 'UNAVAILABLE' && result.reason === 'INVALID_EVALUATION')
            throw appError(
              'INVALID_ESTIMATION_SOURCE',
              'Incomplete probabilistic evaluation.',
              500,
            );
          checkpoint.cases.push(result);
          checkpoint.phase = 'EVALUATE';
          await saveReplay();
        }
        // Final calibration uses every eligible plan, not only the comparison window.
        if (checkpoint.cases.length === snapshot.selection.caseSampleIds.length)
          for (const row of rows) {
            if (!budget()) throw replayYield;
            await atlmReplayPolicyCase(
              row,
              historyFor,
              checkpoint.baseCases,
              checkpoint.policyCases,
              saveReplay,
              beforeReplayWork,
            );
          }
      } catch (error) {
        if (error === replayLost) lostLease = true;
        else if (error === replayYield) yielded = true;
        else throw error;
      }
      if (lostLease) break;
      if (
        yielded ||
        checkpoint.cases.length < snapshot.selection.caseSampleIds.length ||
        rows.some((row) => !checkpoint.policyCases[row.sampleId])
      ) {
        await deferTraining('EVALUATE');
        break;
      }
      const evaluation = summarizeHybridAtlmEvaluation(checkpoint.cases, snapshot.selection);
      if (evaluation.status !== 'AVAILABLE')
        throw appError('INVALID_ESTIMATION_SOURCE', 'Invalid hybrid evaluation.', 500);
      if (!checkpoint.fitCheckpointed) {
        checkpoint.phase = 'FIT';
        checkpoint.fitCheckpointed = true;
        checkpoint.progressRevision++;
        if (!(await atlmCheckpoint(db, ownerId, job, checkpoint, clock()))) break;
      }
      let candidates = checkpoint.finalCandidates;
      if (!candidates) {
        if (!canStartWork()) {
          await deferTraining('FIT', evaluation);
          break;
        }
        candidates = await atlmFitCandidates(rows);
        checkpoint.finalCandidates = candidates;
        checkpoint.progressRevision++;
        if (!(await atlmCheckpoint(db, ownerId, job, checkpoint, clock()))) break;
      }
      if (!canStartWork()) {
        await deferTraining('CALIBRATION', evaluation);
        break;
      }
      const incumbent = snapshot.incumbentId
        ? await dbFirst(
            db,
            `SELECT m.*,CASE WHEN m.model_revision IS NOT NULL THEN m.activated_at ELSE (SELECT MAX(s.source_available_at) FROM estimation_samples s
        WHERE s.owner_id=m.owner_id AND s.sequence IN (SELECT value FROM json_each(m.manifest_json))) END AS latest_source_available_at
        FROM estimation_serving_models m WHERE m.owner_id=? AND m.model_id=?`,
            ownerId,
            snapshot.incumbentId,
          )
        : null;
      const incumbentEngine = incumbent
        ? (atlmTrainingJson(incumbent.artifact_json)?.selectedEngine ?? null)
        : null;
      const selection = selectHybridEngine(
        candidates,
        snapshot.selection.caseSampleIds.map((id) => checkpoint.baseCases[id]),
        { incumbent: incumbentEngine },
      );
      const residuals = rows.flatMap((row) => {
        const base = checkpoint.baseCases[row.sampleId],
          predictive = base?.bayesian?.predictive;
        return base?.bayesian?.status === 'AVAILABLE' &&
          predictive &&
          Number.isFinite(predictive.location) &&
          Number.isFinite(predictive.scale) &&
          predictive.scale > 0
          ? [
              {
                planId: row.planId,
                features: row.features,
                residual:
                  (Math.log1p(row.actualMs / ATLM_MS_PER_MINUTE) - predictive.location) /
                  predictive.scale,
              },
            ]
          : [];
      });
      let quantiles = checkpoint.quantileFit;
      if (!quantiles) {
        if (!canStartWork()) {
          await deferTraining('CALIBRATION', evaluation);
          break;
        }
        quantiles = await fitAtlmResidualQuantiles(residuals);
        checkpoint.quantileFit = quantiles;
        checkpoint.phase = 'CALIBRATION';
        checkpoint.progressRevision++;
        if (!(await atlmCheckpoint(db, ownerId, job, checkpoint, clock()))) break;
      }
      const priorCases = checkpoint.cases
        .filter((item) => item.prediction?.status === 'AVAILABLE')
        .map((item) => ({
          planId: item.planId,
          capturedAt: item.capturedAt,
          actualMs: item.actualMs,
          pointMs: item.prediction.pointMs,
          intervals: item.intervalCandidates,
        }));
      const intervalSelection = selectAtlmIntervalEngine(
        { BAYESIAN_PREDICTIVE: candidates.bayesian, BAYES_QUANTILE: quantiles },
        priorCases,
        { incumbent: incumbent ? atlmTrainingJson(incumbent.artifact_json)?.intervalEngine : null },
      );
      checkpoint.calibrationProof ||= {};
      let proofYielded = false;
      if (quantiles.status === 'AVAILABLE') {
        for (const planId of quantiles.artifact.models[0].manifest) {
          if (checkpoint.calibrationProof[planId]) continue;
          if (!canStartWork()) {
            proofYielded = true;
            break;
          }
          const target = rows.find((row) => row.planId === planId);
          const history = await historyFor(target);
          if (!canStartWork()) {
            proofYielded = true;
            break;
          }
          const reconstructed = await atlmReconstructResidual(target, history);
          if (!reconstructed)
            throw appError('INVALID_ESTIMATION_SOURCE', 'Invalid calibration history.', 500);
          checkpoint.calibrationProof[planId] = reconstructed;
          checkpoint.phase = 'CALIBRATION';
          checkpoint.progressRevision++;
          if (!(await atlmCheckpoint(db, ownerId, job, checkpoint, clock()))) {
            lostLease = true;
            break;
          }
        }
      }
      if (lostLease) break;
      if (proofYielded || !canStartWork()) {
        await deferTraining('CALIBRATION', evaluation);
        break;
      }
      const fitted = await fitAtlm(rows, {
        candidates,
        selection,
        cutoff: snapshot.trainCutoff,
        residualQuantiles: quantiles.status === 'AVAILABLE' ? quantiles.artifact : null,
        intervalSelection,
        calibrationHistory: historyFor,
        calibrationProof: checkpoint.calibrationProof,
        replayAuthority: ATLM_INTERNAL_REPLAY,
      });
      fitted.intervalSelection = intervalSelection;
      evaluation.selection = selection;
      evaluation.intervalSelection = intervalSelection;
      evaluation.calibration = {
        sampleCount: residuals.length,
        status: quantiles.status,
        reason: quantiles.reason ?? null,
      };
      const initialReady = evaluation.paired.caseCount >= ATLM_MIN_COMPARISONS;
      let rejection =
        fitted.status !== 'AVAILABLE'
          ? fitted.reason
          : initialReady && !evaluation.candidateReady
            ? 'MEDIAN_BASELINE_BETTER'
            : null;
      evaluation.validationStatus = 'EXPERIMENTAL';
      if (!rejection) {
        const comparison = atlmCompareIncumbent(evaluation, incumbent);
        evaluation.incumbentComparison = comparison.comparison;
        if (incumbent && !comparison.accepted) rejection = comparison.reason;
        else if (initialReady) evaluation.validationStatus = 'HISTORICALLY_EVALUATED';
      }
      if (rejection) {
        await atlmFinalizeTraining(
          db,
          ownerId,
          job,
          snapshot,
          checkpoint,
          {
            activate: false,
            status: rejection.startsWith('INSUFFICIENT_') ? 'COLLECTING_DATA' : 'REJECTED',
            reason: rejection,
            details: { ...fitted, sampleCount: rows.length },
            artifact: null,
            evaluation,
          },
          clock(),
        );
        continue;
      }
      const final = {
        activate: true,
        status: 'IDLE',
        artifact: fitted.artifact,
        reason: null,
        details: { ...fitted, sampleCount: rows.length },
        evaluation,
      };
      if (!(await atlmFinalizeTraining(db, ownerId, job, snapshot, checkpoint, final, clock()))) {
        // A changed source invalidates this snapshot. A new generation captures current facts.
        await atlmSupersedeSnapshot(db, ownerId, job, snapshot, clock());
        break;
      }
    } catch (error) {
      const checkpoint = atlmTrainingJson(job.checkpoint_json, {});
      const details = {
        phase: checkpoint.phase ?? 'SNAPSHOT',
        completedCases: checkpoint.completedCases ?? checkpoint.cases?.length ?? 0,
        passElapsedMs: elapsed(),
      };
      await atlmRecordFailure(db, ownerId, job, error, clock(), details);
      throw appError(
        'SOURCE_UNAVAILABLE',
        'Не удалось завершить фоновое обучение. Задание сохранено для повтора.',
        503,
        { retryable: true, reason: atlmTrainingErrorCode(error), ...details,
          generation: job.generation, attemptId: atlmAttemptId(job) },
      );
    }
  }
  return getEstimationModelStatus(db, ownerId, clock());
}

function scheduleAtlmTraining(db, ownerId, nowMs, ctx, clock) {
  if (!ctx || typeof ctx.waitUntil !== 'function') return;
  try {
    const scheduledAt = performance.now();
    const trainingClock =
      typeof clock === 'function'
        ? clock
        : () => nowMs + Math.max(0, Math.floor(performance.now() - scheduledAt));
    const task = Promise.resolve()
      .then(async () => {
        // At most two bounded passes fit within the host's usual waitUntil lifetime.
        let previous = null;
        for (let pass = 0; pass < 2; pass += 1) {
          const status = await processEstimationTraining(db, ownerId, trainingClock(), {
            clock: trainingClock,
          });
          const progress = canonical([
            status.datasetRevision,
            status.training.generation,
            status.training.progressRevision,
            status.training.pendingRefreshCount,
          ]);
          if (!status.training.due || progress === previous) break;
          previous = progress;
        }
      })
      .catch((error) => {
        console.error(
          JSON.stringify({
            event: 'atlm_training_background_error',
            reason: error.details?.reason ?? atlmTrainingErrorCode(error),
            phase: error.details?.phase,
            completedCases: error.details?.completedCases,
            passElapsedMs: error.details?.passElapsedMs,
            generation: error.details?.generation,
            attemptId: error.details?.attemptId,
          }),
        );
      });
    ctx.waitUntil(task);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'atlm_training_schedule_error',
        reason: atlmTrainingErrorCode(error),
      }),
    );
  }
}

export {
  ATLM_LATEST_SAMPLE_SQL,
  ATLM_RETRAIN_EVERY_NEW_PLANS,
  atlmDiagnostics,
  atlmReadActiveModel,
  atlmStatusDiagnostics,
  atlmTrainingJson,
  getEstimationModelStatus,
  predictWithActiveModel,
  processEstimationTraining,
  scheduleAtlmTraining,
};
