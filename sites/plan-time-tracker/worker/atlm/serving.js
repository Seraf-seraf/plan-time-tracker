import { appError, dbFirst, messageFor, parseColumn } from '../shared/index.js';
import { ATLM_FEATURE_VERSION, ATLM_METHOD, predictAtlm } from './model.js';
import { readAtlmSampleRefreshStatus } from './sample-refresh.js';

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
    INSUFFICIENT_DATA: 'Недостаточно данных для расчёта коэффициентов модели.',
    RANK_DEFICIENT:
      'Не удаётся независимо оценить коэффициенты: признаки в обучающей выборке линейно зависимы.',
    MODEL_CAPACITY_LIMIT: 'Число коэффициентов превышает ресурсный предел модели.',
    MODEL_RESOURCE_LIMIT: 'Расчёт модели превышает установленный предел вычислений.',
    DATASET_LIMIT_REACHED: 'Число обучающих примеров превышает допустимый предел.',
    UNSUPPORTED_FORECAST_SCOPE:
      'Новый расчёт доступен только до первого запуска плана. Показана исходная сохранённая оценка.',
    PLAN_DELETED: 'План удалён. Новый расчёт недоступен.',
    COLLECTING_DATA: 'Модель прогноза ещё не назначена.',
    MODEL_INVALIDATED:
      'Источники назначенной модели изменились или недоступны.',
    UNSUPPORTED_CATEGORY:
      'В обученной модели отсутствует категория обязательного признака этой задачи. Параметры: ' +
      (parameters.unsupportedFields?.join(', ') || 'не сохранены') +
      '.',
    INVALID_FEATURES: 'Исходные параметры не соответствуют схеме задачи.',
    INVALID_PREDICTION: 'Модель не смогла получить конечное неотрицательное время.',
    INVALID_ARTIFACT: 'Сохранённая модель повреждена или не соответствует текущей версии.',
    SOURCES_PENDING: 'Трекер обновляет сведения о завершённых планах.',
    SOURCE_REFRESH_FAILED: 'Трекеру не удалось обновить часть исходных сведений.',
    SOURCE_UNAVAILABLE: 'Источник исходных данных или сохранённой модели недоступен.',
    LEASE_EXPIRED: 'Попытка обучения не завершилась в отведённое время.',
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

const ATLM_ACTIVE_MODEL_FROM = `FROM estimation_serving_models m
  WHERE m.owner_id=? AND m.status='ACTIVE'
    AND m.method_version='${ATLM_METHOD.version}' AND m.feature_version='${ATLM_FEATURE_VERSION}'`;

async function atlmReadActiveModel(db, ownerId) {
  return dbFirst(db, `SELECT m.* ${ATLM_ACTIVE_MODEL_FROM}`, ownerId);
}

async function readAtlmServingState(db, ownerId) {
  const row = await dbFirst(db,
    `SELECT a.model_revision_id,a.activation_version,m.status,m.source_problem
    FROM estimation_active_revisions a LEFT JOIN estimation_serving_models m
      ON m.owner_id=a.owner_id AND m.model_id=a.model_revision_id WHERE a.owner_id=?`,
    ownerId);
  return {
    activeModelRevisionId: row?.model_revision_id ?? null,
    servingModelRevisionId: row?.status === 'ACTIVE' ? row.model_revision_id : null,
    activationVersion: row?.activation_version ?? 0,
    sourceStatus: row?.status ?? 'UNASSIGNED',
    sourceProblem: row?.source_problem ?? null,
  };
}

function legacyForecastEvaluation(evaluation) {
  if (!evaluation || !evaluation.validationStatus) return null;
  const report = evaluation.metrics?.overall ?? {};
  return {
    validationStatus: evaluation.validationStatus,
    metricsScope: 'FULL_POLICY',
    ...Object.fromEntries(Object.entries(report).filter(([, value]) => Number.isFinite(value))),
    modelCaseCount: evaluation.paired?.caseCount ?? 0,
    medianBaselineMaeMs: evaluation.metrics?.median?.maeMs ?? null,
    profileGroupCount: evaluation.profileGroupCount ?? 0,
    excludedCaseCount: evaluation.excluded?.length ?? 0,
    cutoff: evaluation.cutoff ?? null,
    protocolVersion: evaluation.protocolVersion ?? 3,
  };
}

async function predictWithActiveModel(db, ownerId, features, nowMs) {
  const model = await atlmReadActiveModel(db, ownerId);
  if (!model) {
    const state = await readAtlmServingState(db, ownerId);
    const refresh = await readAtlmSampleRefreshStatus(db, ownerId, nowMs);
    const reason = state.activeModelRevisionId ? 'MODEL_INVALIDATED'
      : refresh.pendingCount ? 'SOURCES_PENDING'
        : refresh.failedCount ? 'SOURCE_REFRESH_FAILED' : 'COLLECTING_DATA';
    return {
      status: 'UNAVAILABLE', pointMs: null, modelId: null, modelVersion: null,
      sampleCount: 0, evaluation: null, unavailableReason: reason, accuracy: 'NOT_VALIDATED',
      diagnostics: atlmDiagnostics(reason),
    };
  }
  let artifact;
  let prediction;
  try {
    artifact = JSON.parse(model.artifact_json);
    prediction = predictAtlm(artifact, features);
  } catch {
    throw appError('SOURCE_UNAVAILABLE', 'Сохранённая модель ATLM повреждена.', 503, {
      reason: 'INVALID_ARTIFACT',
    });
  }
  if (prediction.reason === 'INVALID_ARTIFACT')
    throw appError('SOURCE_UNAVAILABLE', 'Сохранённая модель ATLM повреждена.', 503, {
      reason: 'INVALID_ARTIFACT',
    });
  const evaluation = legacyForecastEvaluation(parseColumn(model.metrics_json, null));
  const metadata = {
    modelId: model.model_id,
    modelRevisionId: model.model_id,
    modelVersion: model.model_version,
    ...(model.model_revision === null ? {} : { modelRevision: model.model_revision }),
    sampleCount: model.sample_count,
    evaluation,
    accuracy: evaluation?.validationStatus === 'HISTORICALLY_EVALUATED'
      ? 'HISTORICALLY_EVALUATED' : 'EXPERIMENTAL',
  };
  if (prediction.status !== 'AVAILABLE')
    return {
      ...metadata, status: 'UNAVAILABLE', pointMs: null, unavailableReason: prediction.reason,
      diagnostics: atlmDiagnostics(prediction.reason, prediction),
      ...(prediction.missingFields ? { missingFields: prediction.missingFields } : {}),
    };
  return {
    ...metadata, status: 'AVAILABLE', pointMs: prediction.pointMs, unavailableReason: null,
    method: artifact.method, pointEngine: prediction.pointEngine ?? null, interval: prediction.interval ?? null,
    ...(prediction.hybrid ? { hybrid: prediction.hybrid } : {}),
  };
}

export { atlmDiagnostics, atlmReadActiveModel, predictWithActiveModel, readAtlmServingState };
