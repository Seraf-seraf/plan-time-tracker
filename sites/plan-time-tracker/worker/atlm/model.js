import {
  ESTIMATE_ID,
  UUID,
  V4_DONE_BOUNDARIES,
  appError,
  assertExactKeys,
  assertSafeMetadataText,
  canonical,
  hashCommandInput,
  isPlainRecord,
  isSnapshotDigest,
  median,
} from '../shared/index.js';

function isNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

const ATLM_METHOD = Object.freeze({ id: 'atlm', version: 'agent-v5-operations' });

const ATLM_OLS_METHOD = ATLM_METHOD;

const ATLM_RIDGE_METHOD = Object.freeze({ id: 'atlm-ridge', version: '1' });

const ATLM_RIDGE_LAMBDA = 1;

const ATLM_MS_PER_MINUTE = 60000;

const ATLM_HYBRID_METHOD = ATLM_METHOD;

const ATLM_POLICY_VERSION = 2;

const ATLM_MIN_COMPARISONS = 5;

const ATLM_MAE_TIE_MS = 1;

const ATLM_FEATURE_VERSION = 'agent-task-v4';

const ATLM_MAX_ROWS = 5000;

const ATLM_MAX_EVALUATION_CASES = 20;

function atlmUnavailable(reason, details = {}) {
  return { status: 'UNAVAILABLE', pointMs: null, reason, ...details };
}

function atlmCompareId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function atlmValidId(value) {
  return typeof value === 'string' && ESTIMATE_ID.test(value) && value.trim().length > 0;
}

function atlmExactKeys(value, keys) {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function atlmFeatureProblem(features) {
  const problem = v4FeatureProblem(features);
  return problem ? atlmUnavailable(problem) : null;
}

function atlmDatasetProblem(rows) {
  if (!Array.isArray(rows)) return atlmUnavailable('INVALID_DATASET');
  if (rows.length > ATLM_MAX_ROWS)
    return atlmUnavailable('DATASET_LIMIT_REACHED', {
      sampleCount: rows.length,
      limit: ATLM_MAX_ROWS,
    });
  const samples = new Set(),
    plans = new Set();
  for (const row of rows) {
    if (
      !atlmExactKeys(row, [
        'sampleId',
        'planId',
        'capturedAt',
        'sourceAvailableAt',
        'features',
        'actualMs',
      ]) ||
      !atlmValidId(row.sampleId) ||
      !atlmValidId(row.planId) ||
      samples.has(row.sampleId) ||
      plans.has(row.planId) ||
      ![row.capturedAt, row.sourceAvailableAt, row.actualMs].every(isNonnegativeSafeInteger) ||
      row.sourceAvailableAt < row.capturedAt
    )
      return atlmUnavailable('INVALID_DATASET');
    if (atlmFeatureProblem(row.features)?.reason === 'INVALID_FEATURES')
      return atlmUnavailable('INVALID_DATASET');
    samples.add(row.sampleId);
    plans.add(row.planId);
  }
  return null;
}

function atlmSortedRows(rows) {
  return rows
    .slice()
    .sort((a, b) => atlmCompareId(a.planId, b.planId) || atlmCompareId(a.sampleId, b.sampleId));
}

function atlmSum(values) {
  let sum = 0,
    correction = 0;
  for (const value of values) {
    const adjusted = value - correction,
      next = sum + adjusted;
    correction = next - sum - adjusted;
    sum = next;
  }
  return sum;
}

function atlmQr(matrix, target) {
  const n = matrix.length,
    p = matrix[0].length;
  const a = matrix.map((row) => Float64Array.from(row)),
    y = Float64Array.from(target);
  const permutation = Array.from({ length: p }, (_, i) => i),
    scales = [];
  for (let j = 0; j < p; j++) {
    let norm = 0;
    for (let i = 0; i < n; i++) norm = Math.hypot(norm, a[i][j]);
    scales.push(norm);
    if (norm > 0) for (let i = 0; i < n; i++) a[i][j] /= norm;
  }
  for (let k = 0; k < Math.min(n, p); k++) {
    let pivot = k,
      largest = -1;
    for (let j = k; j < p; j++) {
      let norm = 0;
      for (let i = k; i < n; i++) norm = Math.hypot(norm, a[i][j]);
      if (norm > largest || (norm === largest && permutation[j] < permutation[pivot])) {
        largest = norm;
        pivot = j;
      }
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
  const rankTolerance =
    Number.EPSILON * Math.max(n, p) * Math.max(...a.slice(0, p).map((row, i) => Math.abs(row[i])));
  const rank = a.slice(0, p).filter((row, i) => Math.abs(row[i]) > rankTolerance).length;
  if (rank !== p) return { rank, rankTolerance, coefficients: null };
  const pivoted = new Float64Array(p),
    coefficients = Array(p);
  for (let i = p - 1; i >= 0; i--) {
    let residual = y[i];
    for (let j = i + 1; j < p; j++) residual -= a[i][j] * pivoted[j];
    pivoted[i] = residual / a[i][i];
  }
  for (let i = 0; i < p; i++) coefficients[permutation[i]] = pivoted[i] / scales[permutation[i]];
  return { rank, rankTolerance, coefficients };
}

function atlmFreeze(value) {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) atlmFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

async function fitAtlmOls(rows) {
  return fitAtlmV4Regression(rows, 'OLS');
}

function predictAtlmOls(artifact, features) {
  return artifact?.kind === 'OLS'
    ? predictAtlmV4Regression(artifact, features)
    : atlmUnavailable('INVALID_ARTIFACT');
}

async function fitAtlmRidge(rows) {
  return fitAtlmV4Regression(rows, 'RIDGE');
}

function predictAtlmRidge(artifact, features) {
  return artifact?.kind === 'RIDGE'
    ? predictAtlmV4Regression(artifact, features)
    : atlmUnavailable('INVALID_ARTIFACT');
}

function atlmManifestValid(manifest, n) {
  if (!Array.isArray(manifest) || manifest.length !== n) return false;
  const samples = new Set(),
    plans = new Set();
  for (const item of manifest) {
    if (
      !atlmExactKeys(item, ['sampleId', 'planId']) ||
      !atlmValidId(item.sampleId) ||
      !atlmValidId(item.planId) ||
      samples.has(item.sampleId) ||
      plans.has(item.planId)
    )
      return false;
    samples.add(item.sampleId);
    plans.add(item.planId);
  }
  return true;
}

async function fitAtlm(rows, options) {
  return fitHybridAtlm(rows, options);
}

function predictAtlm(artifact, features) {
  return predictHybridAtlm(artifact, features);
}

function atlmArtifactValid(artifact) {
  return atlmHybridArtifactValid(artifact);
}

function atlmScore(cases, method) {
  const scored = cases.filter((item) => item[method].pointMs !== null);
  const errors = scored.map((item) => item[method].pointMs - item.actualMs);
  const actualSum = atlmSum(scored.map((item) => item.actualMs)),
    absoluteSum = atlmSum(errors.map(Math.abs));
  return {
    caseCount: cases.length,
    predictionCount: scored.length,
    scoredCount: scored.length,
    forecastRate: cases.length ? scored.length / cases.length : null,
    maeMs: scored.length ? absoluteSum / scored.length : null,
    wapePercent: actualSum > 0 ? (100 * absoluteSum) / actualSum : null,
    signedBiasPercent: actualSum > 0 ? (100 * atlmSum(errors)) / actualSum : null,
  };
}

function atlmTrainingRow(row) {
  return {
    sampleId: row.sampleId,
    planId: row.planId,
    capturedAt: row.capturedAt,
    sourceAvailableAt: row.sourceAvailableAt,
    features: row.features,
    actualMs: row.actualMs,
  };
}

function atlmHybridJournalProblem(journal) {
  if (!Array.isArray(journal)) return atlmUnavailable('INVALID_DATASET');
  const ids = new Set();
  for (const row of journal) {
    if (
      !isPlainRecord(row) ||
      !atlmValidId(row.planId) ||
      typeof row.sampleId !== 'string' ||
      !Number.isSafeInteger(Number(row.sampleId)) ||
      Number(row.sampleId) < 1 ||
      String(Number(row.sampleId)) !== row.sampleId ||
      ids.has(row.sampleId) ||
      !['ELIGIBLE', 'EXCLUDED'].includes(row.eligibility) ||
      !isNonnegativeSafeInteger(row.observedAt) ||
      !isNonnegativeSafeInteger(row.sourceAvailableAt) ||
      row.observedAt < row.sourceAvailableAt
    )
      return atlmUnavailable('INVALID_DATASET');
    if (
      row.eligibility === 'ELIGIBLE' &&
      (atlmDatasetProblem([atlmTrainingRow(row)]) || atlmFeatureProblem(row.features))
    )
      return atlmUnavailable('INVALID_DATASET');
    ids.add(row.sampleId);
  }
  return null;
}

function selectHybridHistory(journal, cutoff, { inclusive = false, excludePlanId = null } = {}) {
  const latest = new Map(),
    before = (value) => (inclusive ? value <= cutoff : value < cutoff);
  for (const row of journal) {
    if (!before(row.observedAt)) continue;
    const previous = latest.get(row.planId);
    if (!previous || Number(row.sampleId) > Number(previous.sampleId)) latest.set(row.planId, row);
  }
  return atlmSortedRows(
    [...latest.values()]
      .filter(
        (row) =>
          row.planId !== excludePlanId &&
          row.eligibility === 'ELIGIBLE' &&
          before(row.sourceAvailableAt),
      )
      .map(atlmTrainingRow),
  );
}

function atlmHybridTargets(rows) {
  return rows
    .slice()
    .sort((a, b) => a.capturedAt - b.capturedAt || atlmCompareId(a.planId, b.planId))
    .slice(-ATLM_MAX_EVALUATION_CASES);
}

function selectHybridEvaluationCases(journal, options = {}) {
  if (
    !isPlainRecord(options) ||
    Object.keys(options).some((key) => !['cutoff', 'protocolVersion'].includes(key)) ||
    (options.protocolVersion !== undefined && options.protocolVersion !== 3)
  )
    return atlmUnavailable('INVALID_PROTOCOL');
  const cutoff = options.cutoff ?? Number.MAX_SAFE_INTEGER;
  const problem = atlmHybridJournalProblem(journal);
  if (problem) return problem;
  if (!isNonnegativeSafeInteger(cutoff)) return atlmUnavailable('INVALID_PROTOCOL');
  const rows = selectHybridHistory(journal, cutoff, { inclusive: true });
  if (rows.length > ATLM_MAX_ROWS)
    return atlmUnavailable('DATASET_LIMIT_REACHED', {
      sampleCount: rows.length,
      limit: ATLM_MAX_ROWS,
    });
  return {
    status: 'AVAILABLE',
    protocolVersion: 3,
    cutoff,
    inputCount: rows.length,
    eligibleCount: rows.length,
    journalVersionCount: journal.length,
    caseSampleIds: atlmHybridTargets(rows).map((row) => row.sampleId),
    excluded: [],
  };
}

async function atlmFitCandidates(rows) {
  if (rows.length < 2)
    return {
      ols: atlmUnavailable('INSUFFICIENT_DATA', { sampleCount: rows.length }),
      ridge: atlmUnavailable('INSUFFICIENT_DATA', { sampleCount: rows.length }),
      bayesian: atlmUnavailable('INSUFFICIENT_DATA', { sampleCount: rows.length }),
    };
  return {
    ols: await fitAtlmV4Regression(rows, 'OLS'),
    ridge: await fitAtlmV4Regression(rows, 'RIDGE'),
    bayesian: await fitAtlmBayesian(rows),
  };
}

function atlmFitDiagnostic(fit) {
  const source = fit.artifact || fit;
  return {
    status: fit.status,
    reason: fit.reason ?? null,
    sampleCount: source.n ?? source.sampleCount ?? 0,
    ...(source.p === undefined ? {} : { p: source.p }),
    ...(source.rank === undefined ? {} : { rank: source.rank }),
  };
}

function atlmStrategyPrediction(base, engine) {
  const order =
    engine === 'OLS'
      ? ['ols', 'ridge']
      : engine === 'RIDGE'
        ? ['ridge']
        : engine === 'BAYESIAN'
          ? ['bayesian']
          : [];
  for (const name of order)
    if (base[name].status === 'AVAILABLE')
      return {
        ...base[name],
        hybrid: {
          policyVersion: ATLM_POLICY_VERSION,
          selectedEngine: engine,
          usedEngine: name.toUpperCase(),
          fallbackReason: name.toUpperCase() === engine ? null : base.ols.reason,
        },
      };
  const failed = order.length ? base[order.at(-1)] : null;
  return {
    ...(failed || atlmUnavailable('MEDIAN_BASELINE_NOT_WORSE')),
    hybrid: {
      policyVersion: ATLM_POLICY_VERSION,
      selectedEngine: engine,
      usedEngine: null,
      fallbackReason: failed?.reason ?? null,
    },
  };
}

function selectHybridEngine(candidates, cases, { incumbent = null } = {}) {
  if (
    !isPlainRecord(candidates) ||
    !Array.isArray(cases) ||
    cases.some((c) => !isPlainRecord(c) || !atlmValidId(c.planId)) ||
    new Set(cases.map((c) => c.planId)).size !== cases.length
  )
    return atlmUnavailable('INVALID_EVALUATION');
  for (const item of cases) {
    if (!isNonnegativeSafeInteger(item.capturedAt) || !isNonnegativeSafeInteger(item.actualMs))
      return atlmUnavailable('INVALID_EVALUATION');
    for (const name of ['median', 'ridge', 'bayesian', 'ols']) {
      const forecast = item[name];
      if (
        !isPlainRecord(forecast) ||
        !['AVAILABLE', 'UNAVAILABLE'].includes(forecast.status) ||
        (forecast.status === 'AVAILABLE'
          ? !isNonnegativeSafeInteger(forecast.pointMs)
          : forecast.pointMs !== null)
      )
        return atlmUnavailable('INVALID_EVALUATION');
    }
  }
  const engines = ['RIDGE', 'BAYESIAN', 'OLS'];
  const available = engines.filter(
    (engine) => candidates[engine.toLowerCase()]?.status === 'AVAILABLE',
  );
  const window = cases
    .filter((c) => c.median?.status === 'AVAILABLE' && isNonnegativeSafeInteger(c.actualMs))
    .sort((a, b) => a.capturedAt - b.capturedAt || atlmCompareId(a.planId, b.planId))
    .slice(-ATLM_MAX_EVALUATION_CASES);
  const ownPredictionCounts = Object.fromEntries(
    engines.map((engine) => [
      engine.toLowerCase(),
      window.filter((c) => c[engine.toLowerCase()]?.status === 'AVAILABLE').length,
    ]),
  );
  const qualified = available.filter(
    (engine) => ownPredictionCounts[engine.toLowerCase()] >= ATLM_MIN_COMPARISONS,
  );
  const comparable = qualified.length
    ? window.filter((c) =>
        qualified.every((engine) => c[engine.toLowerCase()]?.status === 'AVAILABLE'),
      )
    : [];
  const scores = { median: null, ols: null, ridge: null, bayesian: null },
    biases = { median: null, ols: null, ridge: null, bayesian: null };
  if (comparable.length)
    for (const name of ['median', ...qualified.map((engine) => engine.toLowerCase())]) {
      const errors = comparable.map((c) => c[name].pointMs - c.actualMs);
      scores[name] = atlmSum(errors.map(Math.abs)) / errors.length;
      biases[name] = atlmSum(errors) / errors.length;
    }
  let selectedEngine, reason;
  if (comparable.length >= ATLM_MIN_COMPARISONS) {
    const choices = [...qualified, 'MEDIAN'],
      minimum = Math.min(...choices.map((engine) => scores[engine.toLowerCase()]));
    const tied = choices.filter(
      (engine) => scores[engine.toLowerCase()] <= minimum + ATLM_MAE_TIE_MS,
    );
    const bestBias = Math.min(...tied.map((engine) => Math.abs(biases[engine.toLowerCase()])));
    const biasTied = tied.filter(
      (engine) => Math.abs(Math.abs(biases[engine.toLowerCase()]) - bestBias) <= 1e-9,
    );
    selectedEngine = biasTied.includes(incumbent) ? incumbent : biasTied[0];
    reason = selectedEngine === 'MEDIAN' ? 'MEDIAN_BASELINE_NOT_WORSE' : 'LOWEST_HISTORICAL_MAE';
  } else {
    selectedEngine = available.includes(incumbent) ? incumbent : (available[0] ?? 'MEDIAN');
    reason = selectedEngine === 'MEDIAN' ? 'NO_MODEL_AVAILABLE' : 'EARLY_EXPERIMENTAL';
  }
  return {
    policyVersion: ATLM_POLICY_VERSION,
    selectedEngine,
    reason,
    caseCount: comparable.length,
    caseIds: comparable.map((c) => c.planId),
    ownPredictionCounts,
    scores,
    biases,
    qualified: comparable.length >= ATLM_MIN_COMPARISONS && qualified.includes(selectedEngine),
  };
}

async function evaluateHybridBaseCase(train, target) {
  const candidates = await atlmFitCandidates(train);
  const prediction = (name, predict) =>
    candidates[name].status === 'AVAILABLE'
      ? predict(candidates[name].artifact, target.features)
      : atlmUnavailable(candidates[name].reason);
  const rawMedian = train.length > ATLM_MAX_ROWS ? null : median(train.map((row) => row.actualMs));
  const pointMs = rawMedian === null ? null : Math.round(rawMedian);
  return {
    ...atlmTrainingRow(target),
    trainSampleCount: train.length,
    trainDatasetDigest: 'sha256:' + (await hashCommandInput(atlmSortedRows(train))),
    fits: {
      ols: atlmFitDiagnostic(candidates.ols),
      ridge: atlmFitDiagnostic(candidates.ridge),
      bayesian: atlmFitDiagnostic(candidates.bayesian),
    },
    ols: prediction('ols', predictAtlmV4Regression),
    ridge: prediction('ridge', predictAtlmV4Regression),
    bayesian: prediction('bayesian', predictAtlmBayesian),
    median:
      pointMs === null
        ? atlmUnavailable(
            train.length > ATLM_MAX_ROWS ? 'DATASET_LIMIT_REACHED' : 'INSUFFICIENT_DATA',
          )
        : { status: 'AVAILABLE', pointMs, reason: null },
  };
}

function summarizeHybridCase(target, history, baseCases) {
  const base = baseCases[target.sampleId];
  const chronological = history
    .slice()
    .sort((a, b) => a.capturedAt - b.capturedAt || atlmCompareId(a.planId, b.planId));
  const allPrior = chronological.map((row) => baseCases[row.sampleId]);
  if (!base || allPrior.some((c) => !c)) return atlmUnavailable('INCOMPLETE_EVALUATION');
  let incumbent = null;
  for (const candidate of allPrior) {
    const earlier = allPrior.filter(
      (item) => item.planId !== candidate.planId && item.sourceAvailableAt < candidate.capturedAt,
    );
    const replay = selectHybridEngine(candidate.fits, earlier, { incumbent });
    if (replay.status === 'UNAVAILABLE') return replay;
    if (replay.selectedEngine !== 'MEDIAN' && (incumbent === null || replay.qualified))
      incumbent = replay.selectedEngine;
  }
  const prior = atlmHybridTargets(history).map((row) => baseCases[row.sampleId]);
  const decision = selectHybridEngine(base.fits, prior, { incumbent });
  if (decision.status === 'UNAVAILABLE') return decision;
  const atlm = atlmStrategyPrediction(base, decision.selectedEngine);
  return { ...base, decision, atlm, prediction: atlm.status === 'AVAILABLE' ? atlm : base.median };
}

function summarizeHybridAtlmEvaluation(cases, selection) {
  if (selection?.status !== 'AVAILABLE') return selection || atlmUnavailable('INVALID_EVALUATION');
  if (
    !Array.isArray(cases) ||
    cases.length !== selection.caseSampleIds.length ||
    new Set(cases.map((c) => c.sampleId)).size !== cases.length ||
    cases.some(
      (c) =>
        !selection.caseSampleIds.includes(c.sampleId) ||
        !isNonnegativeSafeInteger(c.actualMs) ||
        ['atlm', 'median', 'prediction', 'ols', 'ridge', 'bayesian'].some(
          (name) =>
            !c[name] || (c[name].pointMs !== null && !isNonnegativeSafeInteger(c[name].pointMs)),
        ),
    )
  )
    return atlmUnavailable('INCOMPLETE_EVALUATION');
  const ordered = selection.caseSampleIds.map((id) => cases.find((c) => c.sampleId === id));
  const comparable = ordered.filter((c) => c.median.status === 'AVAILABLE');
  const pairedCases = comparable.filter((c) => c.atlm.status === 'AVAILABLE');
  const metrics = {
    atlm: atlmScore(ordered, 'atlm'),
    median: atlmScore(comparable, 'median'),
    operational: atlmScore(comparable, 'prediction'),
    ols: atlmScore(ordered, 'ols'),
    ridge: atlmScore(ordered, 'ridge'),
    bayesian: atlmScore(ordered, 'bayesian'),
  };
  metrics.overall = summarizeAtlmV4Metrics(
    ordered.map((item) => ({
      planId: item.planId,
      actualMs: item.actualMs,
      pointMs: item.prediction.status === 'AVAILABLE' ? item.prediction.pointMs : null,
      interval:
        item.prediction.interval ??
        atlmUnavailableInterval('BAYESIAN_PREDICTIVE', 'INTERVAL_NOT_EVALUATED'),
    })),
  );
  if (metrics.overall.status === 'UNAVAILABLE') return metrics.overall;
  const paired = {
    caseCount: pairedCases.length,
    caseSampleIds: pairedCases.map((c) => c.sampleId),
    atlm: atlmScore(pairedCases, 'atlm'),
    median: atlmScore(pairedCases, 'median'),
  };
  const profileGroupCount = new Set(comparable.map((c) => canonical(c.features))).size;
  return {
    status: 'AVAILABLE',
    formatVersion: 1,
    protocolVersion: 3,
    policyVersion: ATLM_POLICY_VERSION,
    method: { ...ATLM_HYBRID_METHOD },
    metric: 'PLAN_ACTIVE',
    metricsScope: 'FULL_POLICY',
    cutoff: selection.cutoff,
    inputCount: selection.inputCount,
    eligibleCount: selection.eligibleCount,
    excluded: selection.excluded,
    caseCount: ordered.length,
    cases: ordered,
    metrics,
    paired,
    profileGroupCount,
    candidateReady:
      paired.caseCount >= ATLM_MIN_COMPARISONS &&
      metrics.operational.maeMs !== null &&
      metrics.operational.scoredCount === metrics.median.scoredCount &&
      metrics.operational.maeMs <= metrics.median.maeMs,
  };
}

async function atlmReplayPolicyCase(
  target,
  historyFor,
  baseCache,
  policyCache,
  checkpoint = async () => {},
  beforeWork = async () => {},
) {
  if (policyCache[target.sampleId]) return policyCache[target.sampleId];
  const history = await historyFor(target),
    prior = [];
  for (const row of history) {
    const replayed = await atlmReplayPolicyCase(
      row,
      historyFor,
      baseCache,
      policyCache,
      checkpoint,
      beforeWork,
    );
    if (replayed.status === 'UNAVAILABLE' && replayed.reason === 'INVALID_EVALUATION')
      return replayed;
    prior.push(replayed);
  }
  let base = baseCache[target.sampleId];
  if (!base) {
    await beforeWork();
    base = await evaluateHybridBaseCase(history, target);
    baseCache[target.sampleId] = base;
    await checkpoint();
  }
  const chronological = prior
    .slice()
    .sort((a, b) => a.sourceAvailableAt - b.sourceAvailableAt || atlmCompareId(a.planId, b.planId));
  let pointIncumbent = null,
    intervalIncumbent = null;
  for (const item of chronological) {
    if (
      item.decision?.selectedEngine &&
      item.decision.selectedEngine !== 'MEDIAN' &&
      (pointIncumbent === null || item.decision.qualified)
    )
      pointIncumbent = item.decision.selectedEngine;
    if (
      item.intervalDecision?.selectedEngine &&
      (intervalIncumbent === null ||
        item.intervalDecision.validationStatus === 'HISTORICALLY_EVALUATED')
    )
      intervalIncumbent = item.intervalDecision.selectedEngine;
  }
  const priorBases = prior.map((item) => baseCache[item.sampleId]);
  const decision = selectHybridEngine(base.fits, priorBases, { incumbent: pointIncumbent });
  if (decision.status === 'UNAVAILABLE') return decision;
  const atlm = atlmStrategyPrediction(base, decision.selectedEngine),
    point = atlm.status === 'AVAILABLE' ? atlm : base.median;
  let intervalCandidates, intervalDecision, interval;
  if (point.status === 'AVAILABLE') {
    await beforeWork();
    intervalCandidates = await evaluateAtlmIntervalCandidates(base, priorBases, point.pointMs);
    const comparable = prior
      .filter((item) => item.prediction?.status === 'AVAILABLE')
      .map((item) => ({
        planId: item.planId,
        capturedAt: item.capturedAt,
        actualMs: item.actualMs,
        pointMs: item.prediction.pointMs,
        intervals: item.intervalCandidates,
      }));
    intervalDecision = selectAtlmIntervalEngine(intervalCandidates, comparable, {
      incumbent: intervalIncumbent,
    });
    if (intervalDecision.status === 'UNAVAILABLE') return intervalDecision;
    const selected = intervalDecision.selectedEngine;
    interval = selected
      ? { ...intervalCandidates[selected], validationStatus: intervalDecision.validationStatus }
      : atlmUnavailableInterval(
          'BAYESIAN_PREDICTIVE',
          intervalCandidates.BAYESIAN_PREDICTIVE.unavailableReason || 'NO_INTERVAL_AVAILABLE',
        );
  } else {
    intervalCandidates = {
      BAYESIAN_PREDICTIVE: atlmUnavailableInterval('BAYESIAN_PREDICTIVE', 'POINT_UNAVAILABLE'),
      BAYES_QUANTILE: atlmUnavailableInterval('BAYES_QUANTILE', 'POINT_UNAVAILABLE'),
    };
    intervalDecision = {
      selectedEngine: null,
      reason: 'NO_INTERVAL_AVAILABLE',
      caseCount: 0,
      caseIds: [],
      metrics: {},
      validationStatus: 'EXPERIMENTAL',
    };
    interval = intervalCandidates.BAYESIAN_PREDICTIVE;
  }
  const prediction = {
    ...point,
    pointEngine:
      point.status === 'AVAILABLE'
        ? atlm.status === 'AVAILABLE'
          ? atlm.hybrid.usedEngine
          : 'MEDIAN'
        : null,
    interval,
  };
  const result = { ...base, decision, atlm, prediction, intervalCandidates, intervalDecision };
  policyCache[target.sampleId] = result;
  await checkpoint();
  return result;
}

async function evaluateHybridAtlmChronologically(journal, options = {}) {
  const selection = selectHybridEvaluationCases(journal, options);
  if (selection.status !== 'AVAILABLE') return selection;
  const current = selectHybridHistory(journal, selection.cutoff, { inclusive: true });
  const baseCases = {},
    policyCases = {},
    cases = [];
  const historyFor = async (row) =>
    selectHybridHistory(journal, row.capturedAt, { excludePlanId: row.planId });
  for (const id of selection.caseSampleIds) {
    const target = current.find((row) => row.sampleId === id);
    const result = await atlmReplayPolicyCase(target, historyFor, baseCases, policyCases);
    if (result.status === 'UNAVAILABLE' && result.reason === 'INVALID_EVALUATION') return result;
    cases.push(result);
  }
  return summarizeHybridAtlmEvaluation(cases, selection);
}

function atlmSelectionValid(selection) {
  if (
    !atlmExactKeys(selection, [
      'policyVersion',
      'selectedEngine',
      'reason',
      'caseCount',
      'caseIds',
      'ownPredictionCounts',
      'scores',
      'biases',
      'qualified',
    ]) ||
    selection.policyVersion !== ATLM_POLICY_VERSION ||
    !['OLS', 'RIDGE', 'BAYESIAN', 'MEDIAN'].includes(selection.selectedEngine) ||
    ![
      'EARLY_EXPERIMENTAL',
      'LOWEST_HISTORICAL_MAE',
      'MEDIAN_BASELINE_NOT_WORSE',
      'NO_MODEL_AVAILABLE',
    ].includes(selection.reason) ||
    !Number.isInteger(selection.caseCount) ||
    selection.caseCount < 0 ||
    selection.caseCount > ATLM_MAX_EVALUATION_CASES ||
    !atlmExactKeys(selection.ownPredictionCounts, ['ols', 'ridge', 'bayesian']) ||
    !atlmExactKeys(selection.scores, ['median', 'ols', 'ridge', 'bayesian']) ||
    !Object.values(selection.ownPredictionCounts).every(
      (n) => Number.isInteger(n) && n >= 0 && n <= ATLM_MAX_EVALUATION_CASES,
    ) ||
    !Array.isArray(selection.caseIds) ||
    selection.caseIds.length !== selection.caseCount ||
    new Set(selection.caseIds).size !== selection.caseIds.length ||
    !selection.caseIds.every(atlmValidId) ||
    !atlmExactKeys(selection.biases, ['median', 'ols', 'ridge', 'bayesian']) ||
    !Object.values(selection.scores).every(
      (value) => value === null || (Number.isFinite(value) && value >= 0),
    ) ||
    !Object.values(selection.biases).every((value) => value === null || Number.isFinite(value)) ||
    typeof selection.qualified !== 'boolean'
  )
    return false;
  return (
    !selection.qualified ||
    selection.ownPredictionCounts[selection.selectedEngine.toLowerCase()] >= ATLM_MIN_COMPARISONS
  );
}

function atlmHybridArtifactValid(a) {
  if (
    !isPlainRecord(a) ||
    a.formatVersion !== 3 ||
    a.kind !== 'HYBRID' ||
    a.method?.id !== ATLM_HYBRID_METHOD.id ||
    a.method.version !== ATLM_HYBRID_METHOD.version ||
    a.featureSchemaVersion !== ATLM_FEATURE_VERSION ||
    a.metric !== 'PLAN_ACTIVE' ||
    a.policyVersion !== ATLM_POLICY_VERSION ||
    !['OLS', 'RIDGE', 'BAYESIAN'].includes(a.selectedEngine) ||
    !Number.isSafeInteger(a.n) ||
    a.n < 1 ||
    a.n > ATLM_MAX_ROWS ||
    !atlmManifestValid(a.manifest, a.n) ||
    !isSnapshotDigest(a.datasetDigest) ||
    !isNonnegativeSafeInteger(a.trainCutoff) ||
    !atlmExactKeys(a.candidates, ['ols', 'ridge', 'bayesian']) ||
    !atlmSelectionValid(a.selection) ||
    !atlmIntervalSelectionValid(a.intervalSelection) ||
    a.intervalEngine !== a.intervalSelection.selectedEngine ||
    ![null, 'BAYESIAN_PREDICTIVE', 'BAYES_QUANTILE'].includes(a.intervalEngine) ||
    !['EXPERIMENTAL', 'HISTORICALLY_EVALUATED'].includes(a.intervalSelection.validationStatus) ||
    (a.residualQuantiles !== null && !atlmResidualQuantilesValid(a.residualQuantiles)) ||
    (a.intervalEngine === 'BAYES_QUANTILE' && a.residualQuantiles === null) ||
    (a.intervalEngine !== null && a.candidates.bayesian?.status !== 'AVAILABLE') ||
    a.selection.policyVersion !== ATLM_POLICY_VERSION ||
    a.selection.selectedEngine !== a.selectedEngine
  )
    return false;
  for (const [name, validate] of [
    ['ols', atlmV4RegressionArtifactValid],
    ['ridge', atlmV4RegressionArtifactValid],
    ['bayesian', atlmBayesArtifactValid],
  ]) {
    const fit = a.candidates[name];
    if (!isPlainRecord(fit) || !['AVAILABLE', 'UNAVAILABLE'].includes(fit.status)) return false;
    if (
      fit.status === 'UNAVAILABLE' &&
      (typeof fit.reason !== 'string' || !fit.reason || fit.reason.length > 128)
    )
      return false;
    if (
      fit.status === 'AVAILABLE' &&
      (fit.artifact?.kind !== name.toUpperCase() ||
        !validate(fit.artifact) ||
        fit.artifact.n !== a.n ||
        fit.artifact.datasetDigest !== a.datasetDigest ||
        canonical(fit.artifact.manifest) !== canonical(a.manifest))
    )
      return false;
  }
  const planIds = new Set(a.manifest.map((item) => item.planId));
  if (
    a.intervalSelection.caseIds.some((planId) => !planIds.has(planId)) ||
    (a.residualQuantiles &&
      a.residualQuantiles.models[0].manifest.some((planId) => !planIds.has(planId)))
  )
    return false;
  const selected = a.candidates[a.selectedEngine.toLowerCase()];
  return (
    selected.status === 'AVAILABLE' &&
    a.p === selected.artifact.p &&
    a.rank === selected.artifact.rank
  );
}

function atlmIntervalSelectionValid(selection) {
  if (
    !atlmExactKeys(selection, [
      'selectedEngine',
      'reason',
      'caseCount',
      'caseIds',
      'metrics',
      'validationStatus',
    ]) ||
    ![null, 'BAYESIAN_PREDICTIVE', 'BAYES_QUANTILE'].includes(selection.selectedEngine) ||
    !Number.isSafeInteger(selection.caseCount) ||
    selection.caseCount < 0 ||
    selection.caseCount > ATLM_MAX_EVALUATION_CASES ||
    !Array.isArray(selection.caseIds) ||
    selection.caseIds.length !== selection.caseCount ||
    new Set(selection.caseIds).size !== selection.caseCount ||
    !selection.caseIds.every(atlmValidId) ||
    !isPlainRecord(selection.metrics) ||
    !['EXPERIMENTAL', 'HISTORICALLY_EVALUATED'].includes(selection.validationStatus)
  )
    return false;
  if (selection.validationStatus === 'EXPERIMENTAL')
    return (
      selection.caseCount < ATLM_MIN_COMPARISONS &&
      (selection.selectedEngine === null
        ? selection.reason === 'NO_INTERVAL_AVAILABLE'
        : selection.reason === 'EARLY_EXPERIMENTAL')
    );
  const chosen = selection.metrics[selection.selectedEngine];
  return (
    selection.caseCount >= ATLM_MIN_COMPARISONS &&
    selection.selectedEngine !== null &&
    selection.reason === 'LOWEST_INTERVAL_SCORE' &&
    isPlainRecord(chosen) &&
    chosen.intervalCaseCount === selection.caseCount &&
    chosen.coverageDenominator === selection.caseCount &&
    canonical(chosen.intervalCaseIds) === canonical(selection.caseIds) &&
    Number.isFinite(chosen.meanIntervalScore) &&
    chosen.meanIntervalScore >= 0 &&
    Number.isFinite(chosen.meanIntervalWidthMs) &&
    chosen.meanIntervalWidthMs >= 0 &&
    Number.isFinite(chosen.intervalCoverage) &&
    chosen.intervalCoverage >= 0 &&
    chosen.intervalCoverage <= 1
  );
}

const ATLM_INTERNAL_REPLAY = Symbol('validated training replay');

async function atlmReconstructResidual(target, history) {
  if (
    !Array.isArray(history) ||
    history.length < 2 ||
    atlmDatasetProblem(history) ||
    history.some(
      (row) => row.planId === target.planId || row.sourceAvailableAt >= target.capturedAt,
    )
  )
    return null;
  const fit = await fitAtlmBayesian(history);
  if (fit.status !== 'AVAILABLE') return null;
  const prediction = predictAtlmBayesian(fit.artifact, target.features);
  if (prediction.status !== 'AVAILABLE' || !(prediction.predictive.scale > 0)) return null;
  return {
    planId: target.planId,
    features: target.features,
    residual:
      (Math.log1p(target.actualMs / ATLM_MS_PER_MINUTE) - prediction.predictive.location) /
      prediction.predictive.scale,
  };
}

async function fitHybridAtlm(
  rows,
  {
    selection = null,
    candidates = null,
    cutoff = null,
    residualQuantiles = null,
    intervalSelection = null,
    calibrationHistory = null,
    calibrationProof = null,
    replayAuthority = null,
  } = {},
) {
  const problem = atlmDatasetProblem(rows);
  if (problem) return problem;
  const sorted = atlmSortedRows(rows);
  if (
    cutoff !== null &&
    (!isNonnegativeSafeInteger(cutoff) || sorted.some((row) => row.sourceAvailableAt > cutoff))
  )
    return atlmUnavailable('INVALID_DATASET');
  if (sorted.length < 2)
    return atlmUnavailable('INSUFFICIENT_DATA', { sampleCount: sorted.length });
  candidates ||= await atlmFitCandidates(sorted);
  selection ||= selectHybridEngine(candidates, []);
  if (!atlmSelectionValid(selection)) return atlmUnavailable('INVALID_PROTOCOL');
  const diagnostics = {
    ols: atlmFitDiagnostic(candidates.ols),
    ridge: atlmFitDiagnostic(candidates.ridge),
    bayesian: atlmFitDiagnostic(candidates.bayesian),
  };
  if (selection.selectedEngine === 'MEDIAN') {
    const reason = [candidates.ridge, candidates.bayesian, candidates.ols].some(
      (candidate) => candidate.status === 'AVAILABLE',
    )
      ? 'MEDIAN_BASELINE_NOT_WORSE'
      : candidates.ridge.reason || candidates.bayesian.reason || candidates.ols.reason;
    return atlmUnavailable(reason, {
      sampleCount: rows.length,
      candidates: diagnostics,
      selection,
    });
  }
  const chosen = candidates[selection.selectedEngine.toLowerCase()];
  if (chosen.status !== 'AVAILABLE')
    return atlmUnavailable(chosen.reason, { candidates: diagnostics, selection });
  if (residualQuantiles !== null && !atlmResidualQuantilesValid(residualQuantiles))
    return atlmUnavailable('INVALID_ARTIFACT');
  const trainingPlans = new Set(sorted.map((row) => row.planId));
  if (
    residualQuantiles !== null &&
    residualQuantiles.models[0].manifest.some((planId) => !trainingPlans.has(planId))
  )
    return atlmUnavailable('INVALID_ARTIFACT');
  if (residualQuantiles !== null) {
    if (typeof calibrationHistory !== 'function') return atlmUnavailable('INVALID_ARTIFACT');
    const reconstructed = [];
    for (const planId of residualQuantiles.models[0].manifest) {
      const target = sorted.find((row) => row.planId === planId);
      const residual =
        replayAuthority === ATLM_INTERNAL_REPLAY
          ? calibrationProof?.[planId]
          : await atlmReconstructResidual(target, await calibrationHistory(target));
      if (
        !residual ||
        residual.planId !== planId ||
        canonical(residual.features) !== canonical(target.features) ||
        !Number.isFinite(residual.residual)
      )
        return atlmUnavailable('INVALID_ARTIFACT');
      reconstructed.push(residual);
    }
    reconstructed.sort((a, b) => atlmCompareId(a.planId, b.planId));
    if (
      'sha256:' + (await hashCommandInput(reconstructed)) !==
      residualQuantiles.models[0].datasetDigest
    )
      return atlmUnavailable('INVALID_ARTIFACT');
  }
  intervalSelection ||= selectAtlmIntervalEngine(
    {
      BAYESIAN_PREDICTIVE: candidates.bayesian,
      BAYES_QUANTILE: residualQuantiles ? { status: 'AVAILABLE' } : { status: 'UNAVAILABLE' },
    },
    [],
  );
  if (
    (intervalSelection.validationStatus === 'HISTORICALLY_EVALUATED' &&
      replayAuthority !== ATLM_INTERNAL_REPLAY) ||
    !atlmIntervalSelectionValid(intervalSelection) ||
    intervalSelection.caseIds.some((planId) => !trainingPlans.has(planId))
  )
    return atlmUnavailable('INVALID_PROTOCOL');
  const artifact = atlmFreeze({
    formatVersion: 3,
    kind: 'HYBRID',
    method: { ...ATLM_HYBRID_METHOD },
    featureSchemaVersion: ATLM_FEATURE_VERSION,
    metric: 'PLAN_ACTIVE',
    policyVersion: ATLM_POLICY_VERSION,
    selectedEngine: selection.selectedEngine,
    selection,
    n: sorted.length,
    p: chosen.artifact.p,
    rank: chosen.artifact.rank,
    manifest: sorted.map(({ sampleId, planId }) => ({ sampleId, planId })),
    datasetDigest: 'sha256:' + (await hashCommandInput(sorted)),
    trainCutoff: cutoff ?? Math.max(0, ...sorted.map((row) => row.sourceAvailableAt)),
    candidates,
    intervalEngine: intervalSelection.selectedEngine,
    intervalSelection,
    residualQuantiles,
  });
  return atlmHybridArtifactValid(artifact)
    ? { status: 'AVAILABLE', artifact, candidates: diagnostics, selection }
    : atlmUnavailable('INVALID_ARTIFACT');
}

function predictHybridAtlm(artifact, features) {
  if (!atlmHybridArtifactValid(artifact)) return atlmUnavailable('INVALID_ARTIFACT');
  const problem = atlmFeatureProblem(features);
  if (problem) return problem;
  const base = {};
  for (const [name, predict] of [
    ['ols', predictAtlmV4Regression],
    ['ridge', predictAtlmV4Regression],
    ['bayesian', predictAtlmBayesian],
  ]) {
    const fit = artifact.candidates[name];
    base[name] =
      fit.status === 'AVAILABLE' ? predict(fit.artifact, features) : atlmUnavailable(fit.reason);
  }
  const point = atlmStrategyPrediction(base, artifact.selectedEngine);
  if (point.status !== 'AVAILABLE') return point;
  const validationStatus = artifact.intervalSelection.validationStatus;
  let interval;
  if (artifact.intervalEngine === 'BAYES_QUANTILE')
    interval = predictAtlmResidualInterval(
      artifact.residualQuantiles,
      features,
      base.bayesian,
      point.pointMs,
      validationStatus,
    );
  else if (
    artifact.intervalEngine === 'BAYESIAN_PREDICTIVE' &&
    base.bayesian?.status === 'AVAILABLE' &&
    base.bayesian.interval?.status === 'AVAILABLE'
  )
    interval = {
      status: 'AVAILABLE',
      lowerMs: Math.min(point.pointMs, base.bayesian.interval.lowerMs),
      upperMs: Math.max(point.pointMs, base.bayesian.interval.upperMs),
      nominalCoverage: ATLM_BAYES_NOMINAL_COVERAGE,
      engine: 'BAYESIAN_PREDICTIVE',
      calibrationSampleCount: 0,
      validationStatus,
      unavailableReason: null,
    };
  else
    interval = atlmUnavailableInterval(
      artifact.intervalEngine ?? 'BAYESIAN_PREDICTIVE',
      base.bayesian?.interval?.unavailableReason || base.bayesian?.reason || 'BAYESIAN_UNAVAILABLE',
    );
  return { ...point, pointEngine: point.hybrid.usedEngine, interval };
}

const V4_TASK_TEXT = { type: 'string', minLength: 1, maxLength: 400 };

const V4_TASK_KEY = { type: 'string', minLength: 1, maxLength: 128 };

const V4_TASK_ITEM = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const V4_TASK_MAX_BYTES = 64 * 1024;

const V4_TASK_LIST = (items) => ({ type: 'array', maxItems: V4_TASK_MAX_BYTES, items });

const V4_WORK_KINDS = [
  'CREATE',
  'MODIFY',
  'DEBUG',
  'REFACTOR',
  'MIGRATE',
  'VERIFY',
  'ANALYZE',
  'OPERATE',
];

const V4_VERIFICATION_KINDS = ['BUILD_STATIC', 'UNIT', 'INTEGRATION', 'UI_E2E', 'DEPLOY_SMOKE'];

const V4_SLUG = { ...V4_TASK_KEY, pattern: '^[a-z0-9][a-z0-9._:-]*$' };

const V4_LEARNING_KINDS = ['TOOLING', 'RUNTIME', 'DATA_MODEL', 'OTHER'];

const V4_OPERATION_ENUMS = {
  action: ['READ', 'WRITE'],
  work: ['USE', 'MODIFY', 'ADD'],
  contractState: ['KNOWN', 'PARTIAL', 'UNKNOWN'],
  retryPolicy: ['NOT_REQUIRED', 'EXISTING', 'IMPLEMENT', 'UNKNOWN'],
  idempotency: ['NOT_APPLICABLE', 'EXISTING', 'IMPLEMENT', 'UNKNOWN'],
  recovery: ['NOT_REQUIRED', 'EXISTING', 'IMPLEMENT', 'UNKNOWN'],
  authType: ['NONE', 'API_KEY', 'OAUTH2', 'SERVICE_ACCOUNT', 'OTHER', 'UNKNOWN'],
  accessState: ['AVAILABLE', 'MISSING', 'UNKNOWN', 'NOT_REQUIRED'],
};

const V4_OPERATION = V4_TASK_ITEM({
  id: V4_SLUG,
  description: V4_TASK_TEXT,
  evidence: V4_TASK_TEXT,
  ...Object.fromEntries(
    Object.entries(V4_OPERATION_ENUMS).map(([key, values]) => [key, { enum: values }]),
  ),
  verificationScenarioIds: { ...V4_TASK_LIST(V4_TASK_KEY), minItems: 1, uniqueItems: true },
});

const V4_BOUNDARY = V4_TASK_ITEM({
  id: V4_SLUG,
  name: { type: 'string', minLength: 1, maxLength: 160 },
  contractControl: { enum: ['OWNED', 'FOREIGN'] },
  role: { enum: ['API', 'SERVICE', 'DATASTORE', 'QUEUE', 'SDK', 'PLATFORM'] },
  evidence: V4_TASK_TEXT,
  operations: { ...V4_TASK_LIST(V4_OPERATION), minItems: 1 },
});

const V4_TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'agent-task-v4. См. assess-task/references/features.md.',
  required: [
    'schemaVersion',
    'workUnits',
    'doneBoundary',
    'reuseLevel',
    'components',
    'contracts',
    'systemBoundaries',
    'migrationEntities',
    'dataVolumeBand',
    'requirementsUncertainty',
    'solutionUncertainty',
    'diagnosisState',
    'learningTargets',
    'scopeChangeRisk',
    'verificationKinds',
    'verificationScenarios',
    'verificationReadiness',
    'requiredReviewPasses',
    'environmentReadiness',
    'accessReadiness',
    'deploymentTargets',
    'execution',
    'evidence',
    'unknownReasons',
  ],
  properties: {
    schemaVersion: { enum: ['agent-task-v4'] },
    workUnits: {
      ...V4_TASK_LIST(
        V4_TASK_ITEM({
          id: V4_TASK_KEY,
          kind: { enum: V4_WORK_KINDS },
          description: V4_TASK_TEXT,
          evidence: V4_TASK_TEXT,
        }),
      ),
      minItems: 1,
    },
    doneBoundary: { enum: [...V4_DONE_BOUNDARIES] },
    reuseLevel: { type: 'integer', minimum: 0, maximum: 3 },
    components: V4_TASK_LIST(
      V4_TASK_ITEM({
        key: V4_TASK_KEY,
        change: { enum: ['CREATE', 'MODIFY', 'REMOVE'] },
        evidence: V4_TASK_TEXT,
      }),
    ),
    contracts: V4_TASK_LIST(
      V4_TASK_ITEM({
        kind: { enum: ['API', 'MCP', 'EVENT', 'STORAGE', 'UI', 'CONFIG'] },
        key: V4_TASK_KEY,
        change: { enum: ['ADD', 'COMPATIBLE', 'BREAKING', 'REMOVE'] },
        evidence: V4_TASK_TEXT,
      }),
    ),
    systemBoundaries: V4_TASK_LIST(V4_BOUNDARY),
    migrationEntities: V4_TASK_LIST(V4_TASK_ITEM({ key: V4_TASK_KEY, evidence: V4_TASK_TEXT })),
    dataVolumeBand: { enum: ['NONE', 'LE_1K', 'LE_100K', 'LE_10M', 'GT_10M', 'UNKNOWN'] },
    requirementsUncertainty: { type: 'integer', minimum: 0, maximum: 3 },
    solutionUncertainty: { type: 'integer', minimum: 0, maximum: 3 },
    diagnosisState: { enum: ['NOT_APPLICABLE', 'PROVEN', 'HYPOTHESIS', 'UNKNOWN'] },
    learningTargets: V4_TASK_LIST(
      V4_TASK_ITEM({ id: V4_SLUG, kind: { enum: V4_LEARNING_KINDS }, evidence: V4_TASK_TEXT }),
    ),
    scopeChangeRisk: { type: 'integer', minimum: 0, maximum: 3 },
    verificationKinds: V4_TASK_LIST({ enum: V4_VERIFICATION_KINDS }),
    verificationScenarios: V4_TASK_LIST(
      V4_TASK_ITEM({ id: V4_TASK_KEY, description: V4_TASK_TEXT, evidence: V4_TASK_TEXT }),
    ),
    verificationReadiness: { enum: ['READY', 'ADAPT', 'CREATE', 'NONE_REQUIRED', 'UNKNOWN'] },
    requiredReviewPasses: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    environmentReadiness: { enum: ['READY', 'SETUP_KNOWN', 'BLOCKED', 'UNKNOWN'] },
    accessReadiness: { enum: ['AVAILABLE', 'MISSING', 'UNKNOWN'] },
    deploymentTargets: V4_TASK_LIST(V4_TASK_ITEM({ key: V4_TASK_KEY, evidence: V4_TASK_TEXT })),
    execution: V4_TASK_ITEM({
      mode: { enum: ['AI_AGENT', 'HUMAN', 'HYBRID'] },
      modelId: { type: ['string', 'null'], minLength: 1, maxLength: 128 },
      reasoningEffort: { type: ['string', 'null'], minLength: 1, maxLength: 128 },
      environmentId: { enum: ['local', 'cloud_workspace'] },
      plannedParallelAgents: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      codebaseFamiliarity: { enum: ['NOT_READ', 'MAPPED', 'PRIOR_VERIFIED_WORK'] },
    }),
    evidence: { type: 'object', additionalProperties: V4_TASK_TEXT },
    unknownReasons: {
      type: 'object',
      additionalProperties: V4_TASK_ITEM({ reason: V4_TASK_TEXT, checkedSource: V4_TASK_TEXT }),
    },
  },
};

function taskFieldError(path, incomplete = false, reason = 'INVALID_FIELD') {
  return appError('VALIDATION_ERROR', 'Некорректная оценка (' + reason + '): ' + path, 400, {
    readiness: incomplete ? 'INCOMPLETE' : 'INVALID',
    path,
    reason,
  });
}

function canonicalTaskItems(items, field) {
  const unique = new Map();
  for (const item of items) {
    const key = item.id ?? (item.kind ? item.kind + ':' + item.key : item.key);
    if (unique.has(key) && canonical(unique.get(key)) !== canonical(item))
      throw taskFieldError(field, false, 'CONFLICTING_ID');
    unique.set(key, item);
  }
  return [...unique.entries()].sort(([a], [b]) => atlmCompareId(a, b)).map(([, item]) => item);
}

const EMPTY_TASK_PROOF =
  /^(из задачи|проверено|неизвестно|основание|нет данных|unknown|checked|from task|todo|tbd|n\/a|none|evidence|placeholder|[-?.…]+)[.!]?$/iu;

function taskProof(value, path) {
  if (typeof value !== 'string' || !value.trim() || EMPTY_TASK_PROOF.test(value.trim()))
    throw taskFieldError(path, true, 'MISSING_EVIDENCE');
}

function normalizeAgentTask(input) {
  if (new TextEncoder().encode(JSON.stringify(input)).length > V4_TASK_MAX_BYTES)
    throw taskFieldError('agentTask');
  validateAssessmentValue(input, V4_TASK_SCHEMA, 'agentTask');
  const task = structuredClone(input);
  const evidencePaths = new Set(),
    unknownPaths = new Set();
  function requireEvidence(path) {
    evidencePaths.add(path);
    taskProof(task.evidence[path], path);
  }
  function requireReason(path) {
    unknownPaths.add(path);
    const explanation = task.unknownReasons[path];
    taskProof(explanation?.reason, path);
    taskProof(explanation?.checkedSource, path);
  }
  function scalar(path, value) {
    if (
      value === null ||
      (value === 'UNKNOWN' && !['execution.modelId', 'execution.reasoningEffort'].includes(path))
    )
      requireReason(path);
    else requireEvidence(path);
  }

  const scenarioIds = new Set(task.verificationScenarios.map((item) => item.id));
  for (const boundary of task.systemBoundaries) {
    const prefix = 'systemBoundaries[' + boundary.id + '].operations';
    for (const op of boundary.operations) {
      const path = prefix + '[' + op.id + '].';
      taskProof(op.evidence, path + 'evidence');
      if (op.action === 'READ' && op.idempotency !== 'NOT_APPLICABLE')
        throw taskFieldError(path + 'idempotency');
      if ((op.authType === 'NONE') !== (op.accessState === 'NOT_REQUIRED'))
        throw taskFieldError(path + 'accessState');
      if (
        op.verificationScenarioIds.some((id) => !scenarioIds.has(id)) ||
        new Set(op.verificationScenarioIds).size !== op.verificationScenarioIds.length
      )
        throw taskFieldError(path + 'verificationScenarioIds');
      op.verificationScenarioIds.sort(atlmCompareId);
      for (const field of Object.keys(V4_OPERATION_ENUMS)) {
        if (op[field] === 'UNKNOWN' || op[field] === 'PARTIAL') requireReason(path + field);
      }
      if (op.action === 'WRITE' && op.idempotency === 'NOT_APPLICABLE')
        requireEvidence(path + 'idempotency');
      if (op.authType === 'OTHER') requireEvidence(path + 'authType');
    }
    boundary.operations = canonicalTaskItems(boundary.operations, prefix);
    const semantics = boundary.operations.map((op) =>
      canonical([
        op.action,
        op.description.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase(),
      ]),
    );
    if (new Set(semantics).size !== semantics.length)
      throw taskFieldError(prefix, false, 'DUPLICATE_OPERATION');
  }

  for (const [field, value] of Object.entries(task)) {
    if (['schemaVersion', 'evidence', 'unknownReasons'].includes(field)) continue;
    if (field === 'execution') {
      for (const [key, item] of Object.entries(value)) scalar('execution.' + key, item);
    } else if (Array.isArray(value)) {
      if (!value.length) requireEvidence(field);
      if (field === 'verificationKinds') {
        task[field] = [...new Set(value)].sort(atlmCompareId);
        for (const kind of task[field]) requireEvidence(field + '.' + kind);
      } else {
        for (const item of value) taskProof(item.evidence, field + '.evidence');
        task[field] = canonicalTaskItems(value, field);
      }
    } else scalar(field, value);
  }
  if (Object.keys(task.evidence).some((key) => !evidencePaths.has(key)))
    throw taskFieldError('evidence');
  if (Object.keys(task.unknownReasons).some((key) => !unknownPaths.has(key)))
    throw taskFieldError('unknownReasons');
  if (
    task.workUnits.some((unit) => unit.kind === 'DEBUG') ===
    (task.diagnosisState === 'NOT_APPLICABLE')
  )
    throw taskFieldError('diagnosisState');
  if (task.dataVolumeBand === 'NONE' && task.migrationEntities.length)
    throw taskFieldError('dataVolumeBand');
  if (task.verificationKinds.includes('DEPLOY_SMOKE') && !task.deploymentTargets.length)
    throw taskFieldError('deploymentTargets');

  const count = (items, predicate = () => true) => items.filter(predicate).length;
  const operations = task.systemBoundaries.flatMap((b) => b.operations);
  const writeCount = count(operations, (op) => op.action === 'WRITE');
  const readCount = operations.length - writeCount;
  const byEnum = (items, field, values) =>
    Object.fromEntries(
      values.map((value) => [field + '.' + value, count(items, (item) => item[field] === value)]),
    );
  const features = {
    ...Object.fromEntries(
      V4_WORK_KINDS.map((kind) => [
        'workUnits.' + kind,
        count(task.workUnits, (item) => item.kind === kind),
      ]),
    ),
    doneBoundary: task.doneBoundary,
    reuseLevel: task.reuseLevel,
    ...Object.fromEntries(
      ['CREATE', 'MODIFY', 'REMOVE'].map((change) => [
        'components.' + change,
        count(task.components, (item) => item.change === change),
      ]),
    ),
    ...Object.fromEntries(
      ['API', 'MCP', 'EVENT', 'STORAGE', 'UI', 'CONFIG'].map((kind) => [
        'contracts.' + kind,
        count(task.contracts, (item) => item.kind === kind),
      ]),
    ),
    ...Object.fromEntries(
      ['BREAKING', 'REMOVE'].map((change) => [
        'contracts.' + change,
        count(task.contracts, (item) => item.change === change),
      ]),
    ),
    readCount,
    writeCount,
    operationCount: operations.length,
    writeRatio: operations.length ? writeCount / operations.length : 0,
    hasMixedOperations: Number(readCount > 0 && writeCount > 0),
    ownedBoundaryCount: count(task.systemBoundaries, (b) => b.contractControl === 'OWNED'),
    foreignBoundaryCount: count(task.systemBoundaries, (b) => b.contractControl === 'FOREIGN'),
    foreignWriteCount: count(
      task.systemBoundaries
        .filter((b) => b.contractControl === 'FOREIGN')
        .flatMap((b) => b.operations),
      (op) => op.action === 'WRITE',
    ),
    unknownContractOperationCount: count(operations, (op) => op.contractState === 'UNKNOWN'),
    ...byEnum(task.systemBoundaries, 'role', V4_BOUNDARY.properties.role.enum),
    ...Object.assign(
      {},
      ...Object.entries(V4_OPERATION_ENUMS)
        .filter(([field]) => field !== 'action')
        .map(([field, values]) => byEnum(operations, field, values)),
    ),
    ...Object.fromEntries(
      V4_LEARNING_KINDS.map((kind) => [
        'learningTargets.' + kind,
        count(task.learningTargets, (t) => t.kind === kind),
      ]),
    ),
    migrationEntities: count(task.migrationEntities),
    dataVolumeBand: task.dataVolumeBand,
    requirementsUncertainty: task.requirementsUncertainty,
    solutionUncertainty: task.solutionUncertainty,
    diagnosisState: task.diagnosisState,
    scopeChangeRisk: task.scopeChangeRisk,
    ...Object.fromEntries(
      V4_VERIFICATION_KINDS.map((kind) => [
        'verificationKinds.' + kind,
        Number(task.verificationKinds.includes(kind)),
      ]),
    ),
    verificationScenarios: count(task.verificationScenarios),
    verificationReadiness: task.verificationReadiness,
    requiredReviewPasses: task.requiredReviewPasses,
    environmentReadiness: task.environmentReadiness,
    accessReadiness: task.accessReadiness,
    deploymentTargets: count(task.deploymentTargets),
    ...task.execution,
  };
  return {
    agentTask: task,
    features,
    missingFields: [],
    unknownPaths: [...unknownPaths].sort(atlmCompareId),
  };
}

const V4_RATIO_FIELD = 'writeRatio';

const V4_ORDINAL_FIELDS = [
  'reuseLevel',
  'requirementsUncertainty',
  'solutionUncertainty',
  'scopeChangeRisk',
];

const V4_CATEGORY_FIELDS = {
  doneBoundary: [...V4_DONE_BOUNDARIES],
  dataVolumeBand: ['NONE', 'LE_1K', 'LE_100K', 'LE_10M', 'GT_10M', 'UNKNOWN'],
  diagnosisState: ['NOT_APPLICABLE', 'PROVEN', 'HYPOTHESIS', 'UNKNOWN'],
  verificationReadiness: ['READY', 'ADAPT', 'CREATE', 'NONE_REQUIRED', 'UNKNOWN'],
  environmentReadiness: ['READY', 'SETUP_KNOWN', 'BLOCKED', 'UNKNOWN'],
  accessReadiness: ['AVAILABLE', 'MISSING', 'UNKNOWN'],
  mode: ['AI_AGENT', 'HUMAN', 'HYBRID'],
  environmentId: ['local', 'cloud_workspace'],
  codebaseFamiliarity: ['NOT_READ', 'MAPPED', 'PRIOR_VERIFIED_WORK'],
};

const V4_OPEN_CATEGORY_FIELDS = ['modelId', 'reasoningEffort'];

const V4_COUNT_FIELDS = [
  ...V4_WORK_KINDS.map((kind) => 'workUnits.' + kind),
  ...['CREATE', 'MODIFY', 'REMOVE'].map((change) => 'components.' + change),
  ...['API', 'MCP', 'EVENT', 'STORAGE', 'UI', 'CONFIG', 'BREAKING', 'REMOVE'].map(
    (kind) => 'contracts.' + kind,
  ),
  'readCount',
  'writeCount',
  'operationCount',
  'ownedBoundaryCount',
  'foreignBoundaryCount',
  'foreignWriteCount',
  'unknownContractOperationCount',
  ...V4_BOUNDARY.properties.role.enum.map((role) => 'role.' + role),
  ...Object.entries(V4_OPERATION_ENUMS)
    .filter(([field]) => field !== 'action')
    .flatMap(([field, values]) => values.map((value) => field + '.' + value)),
  ...V4_LEARNING_KINDS.map((kind) => 'learningTargets.' + kind),
  'migrationEntities',
  'verificationScenarios',
  'requiredReviewPasses',
  'deploymentTargets',
  'plannedParallelAgents',
];

const V4_FLAG_FIELDS = [
  'hasMixedOperations',
  ...V4_VERIFICATION_KINDS.map((kind) => 'verificationKinds.' + kind),
];

const V4_FEATURE_FIELDS = [
  V4_RATIO_FIELD,
  ...V4_ORDINAL_FIELDS,
  ...Object.keys(V4_CATEGORY_FIELDS),
  ...V4_OPEN_CATEGORY_FIELDS,
  ...V4_COUNT_FIELDS,
  ...V4_FLAG_FIELDS,
].sort(atlmCompareId);

const V4_MIN_CATEGORY_SAMPLES = 3;

const V4_MODEL_COLUMN_LIMIT = 512;

const ATLM_FIT_WORK_LIMIT = 5000000;

function v4FeatureProblem(features) {
  if (
    !isPlainRecord(features) ||
    canonical(Object.keys(features).sort(atlmCompareId)) !== canonical(V4_FEATURE_FIELDS)
  )
    return 'INVALID_FEATURES';
  if (!Number.isFinite(features.writeRatio) || features.writeRatio < 0 || features.writeRatio > 1)
    return 'INVALID_FEATURES';
  if (features.doneBoundary === 'UNKNOWN') return 'MISSING_REQUIRED_FEATURES';
  for (const field of V4_COUNT_FIELDS)
    if (!isNonnegativeSafeInteger(features[field])) return 'INVALID_FEATURES';
  if (features.plannedParallelAgents === 0) return 'INVALID_FEATURES';
  for (const field of V4_ORDINAL_FIELDS)
    if (!isNonnegativeSafeInteger(features[field]) || features[field] > 3)
      return 'INVALID_FEATURES';
  for (const field of V4_FLAG_FIELDS)
    if (![0, 1].includes(features[field])) return 'INVALID_FEATURES';
  for (const field of Object.keys(V4_CATEGORY_FIELDS)) {
    if (!V4_CATEGORY_FIELDS[field].includes(features[field])) return 'INVALID_FEATURES';
  }
  for (const field of V4_OPEN_CATEGORY_FIELDS)
    if (
      features[field] !== null &&
      (typeof features[field] !== 'string' ||
        !features[field].trim() ||
        Array.from(features[field]).length > 128)
    )
      return 'INVALID_FEATURES';
  const { readCount, writeCount, operationCount, ownedBoundaryCount, foreignBoundaryCount } =
    features;
  if (
    operationCount !== readCount + writeCount ||
    features.writeRatio !== (operationCount ? writeCount / operationCount : 0) ||
    features.hasMixedOperations !== Number(readCount > 0 && writeCount > 0) ||
    features.foreignWriteCount > writeCount ||
    (!foreignBoundaryCount && features.foreignWriteCount !== 0) ||
    (!ownedBoundaryCount && features.foreignWriteCount !== writeCount) ||
    ownedBoundaryCount + foreignBoundaryCount > operationCount ||
    (operationCount > 0 && ownedBoundaryCount + foreignBoundaryCount === 0) ||
    features.unknownContractOperationCount !== features['contractState.UNKNOWN']
  )
    return 'INVALID_FEATURES';
  for (const [field, levels] of Object.entries(V4_OPERATION_ENUMS)) {
    if (
      field !== 'action' &&
      levels.reduce((sum, level) => sum + features[field + '.' + level], 0) !== operationCount
    )
      return 'INVALID_FEATURES';
  }
  if (
    V4_BOUNDARY.properties.role.enum.reduce((sum, role) => sum + features['role.' + role], 0) !==
    ownedBoundaryCount + foreignBoundaryCount
  )
    return 'INVALID_FEATURES';
  const workCounts = V4_WORK_KINDS.map((kind) => features['workUnits.' + kind]);
  if (features.doneBoundary === 'UNKNOWN' || workCounts.every((value) => value === null))
    return 'MISSING_REQUIRED_FEATURES';
  if (workCounts.some((value) => value === null) || workCounts.every((value) => value === 0))
    return 'INVALID_FEATURES';
  return null;
}

function v4Median(values) {
  if (!values.length) return 0;
  const ordered = values.slice().sort((a, b) => a - b),
    middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function v4Category(value, field, manifest) {
  if (V4_OPEN_CATEGORY_FIELDS.includes(field)) {
    if (value === null || value === undefined) return 'UNKNOWN';
    return manifest.openCategories[field].includes(value) ? 'VALUE:' + value : 'OTHER';
  }
  return value === null || value === undefined ? 'UNKNOWN' : value;
}

function v4RawColumn(features, column, manifest) {
  const value = features[column.field];
  if (column.kind === 'category')
    return Number(v4Category(value, column.field, manifest) === column.level);
  if (column.kind === 'missing') return Number(value === null || value === undefined);
  if (value === null || value === undefined) return manifest.imputations[column.field];
  return column.kind === 'count' ? Math.log1p(value) : value;
}

function fitAtlmV4Preprocessor(featureRows) {
  if (!Array.isArray(featureRows) || !featureRows.length)
    return atlmUnavailable('INSUFFICIENT_DATA');
  if (featureRows.length > ATLM_MAX_ROWS || featureRows.some((row) => !isPlainRecord(row)))
    return atlmUnavailable('INVALID_DATASET');
  for (const features of featureRows) {
    const problem = v4FeatureProblem(features);
    if (problem) return atlmUnavailable(problem);
  }
  const fields = Object.keys(featureRows[0]).sort(atlmCompareId);
  if (
    featureRows.some((row) => canonical(Object.keys(row).sort(atlmCompareId)) !== canonical(fields))
  )
    return atlmUnavailable('INVALID_FEATURES');
  const manifest = {
    formatVersion: 2,
    fields,
    openCategories: {},
    imputations: {},
    columns: [],
    droppedColumns: [],
  };
  const candidates = [];
  for (const field of fields) {
    if (Object.hasOwn(V4_CATEGORY_FIELDS, field) || V4_OPEN_CATEGORY_FIELDS.includes(field)) {
      let levels = V4_CATEGORY_FIELDS[field];
      if (!levels) {
        const counts = new Map();
        for (const row of featureRows)
          if (row[field] !== null && row[field] !== undefined)
            counts.set(row[field], (counts.get(row[field]) || 0) + 1);
        manifest.openCategories[field] = [...counts.entries()]
          .filter(([, n]) => n >= V4_MIN_CATEGORY_SAMPLES)
          .map(([value]) => value)
          .sort(atlmCompareId);
        levels = [
          'OTHER',
          'UNKNOWN',
          ...manifest.openCategories[field].map((value) => 'VALUE:' + value),
        ];
      }
      for (const level of levels.slice(1)) candidates.push({ kind: 'category', field, level });
      continue;
    }
    const isFlag = V4_FLAG_FIELDS.includes(field) || field === V4_RATIO_FIELD,
      isOrdinal = V4_ORDINAL_FIELDS.includes(field);
    const kind = isFlag || isOrdinal ? 'ordinal' : 'count';
    const known = featureRows
      .map((row) => row[field])
      .filter((value) => value !== null && value !== undefined);
    if (known.some((value) => !Number.isFinite(value) || value < 0))
      return atlmUnavailable('INVALID_FEATURES');
    manifest.imputations[field] = v4Median(
      known.map((value) => (kind === 'count' ? Math.log1p(value) : value)),
    );
    candidates.push({ kind, field }, { kind: 'missing', field });
  }
  if (candidates.length > V4_MODEL_COLUMN_LIMIT)
    return atlmUnavailable('MODEL_CAPACITY_LIMIT', {
      p: candidates.length,
      limit: V4_MODEL_COLUMN_LIMIT,
    });
  for (const candidate of candidates) {
    const values = featureRows.map((row) => v4RawColumn(row, candidate, manifest));
    if (values.some((value) => !Number.isFinite(value))) return atlmUnavailable('INVALID_FEATURES');
    if (values.every((value) => value === values[0])) {
      manifest.droppedColumns.push(candidate);
      continue;
    }
    // Store the origin separately: subtracting a rounded large mean from
    // nearby log values can otherwise destroy centering and conditioning.
    const origin = values[0],
      offsets = values.map((value) => value - origin);
    const center = atlmSum(offsets) / values.length;
    const scale = Math.sqrt(atlmSum(offsets.map((value) => (value - center) ** 2)) / values.length);
    manifest.columns.push({ ...candidate, origin, center, scale });
  }
  return { status: 'AVAILABLE', manifest };
}

function encodeAtlmV4Features(features, manifest) {
  if (
    !isPlainRecord(manifest) ||
    manifest.formatVersion !== 2 ||
    !Array.isArray(manifest.fields) ||
    !manifest.fields.every((field) => typeof field === 'string') ||
    !isPlainRecord(manifest.openCategories) ||
    !isPlainRecord(manifest.imputations) ||
    !Array.isArray(manifest.columns) ||
    !Array.isArray(manifest.droppedColumns) ||
    manifest.columns.length + manifest.droppedColumns.length > V4_MODEL_COLUMN_LIMIT
  )
    return atlmUnavailable('INVALID_ARTIFACT');
  if (canonical(manifest.fields) !== canonical(V4_FEATURE_FIELDS))
    return atlmUnavailable('INVALID_ARTIFACT');
  if (
    !atlmExactKeys(manifest.openCategories, V4_OPEN_CATEGORY_FIELDS) ||
    !atlmExactKeys(manifest.imputations, [
      V4_RATIO_FIELD,
      ...V4_COUNT_FIELDS,
      ...V4_ORDINAL_FIELDS,
      ...V4_FLAG_FIELDS,
    ])
  )
    return atlmUnavailable('INVALID_ARTIFACT');
  for (const field of V4_OPEN_CATEGORY_FIELDS.filter((field) => manifest.fields.includes(field))) {
    const levels = manifest.openCategories[field];
    if (
      !Array.isArray(levels) ||
      levels.some(
        (value) => typeof value !== 'string' || !value.trim() || Array.from(value).length > 128,
      ) ||
      new Set(levels).size !== levels.length ||
      canonical(levels) !== canonical(levels.slice().sort(atlmCompareId))
    )
      return atlmUnavailable('INVALID_ARTIFACT');
  }
  const expectedColumns = [];
  for (const field of V4_FEATURE_FIELDS) {
    if (Object.hasOwn(V4_CATEGORY_FIELDS, field) || V4_OPEN_CATEGORY_FIELDS.includes(field)) {
      const levels = V4_CATEGORY_FIELDS[field] || [
        'OTHER',
        'UNKNOWN',
        ...manifest.openCategories[field].map((value) => 'VALUE:' + value),
      ];
      for (const level of levels.slice(1))
        expectedColumns.push(canonical({ kind: 'category', field, level }));
    } else {
      const kind =
        field === V4_RATIO_FIELD ||
        V4_FLAG_FIELDS.includes(field) ||
        V4_ORDINAL_FIELDS.includes(field)
          ? 'ordinal'
          : 'count';
      const imputed = manifest.imputations[field];
      const upper =
        field === V4_RATIO_FIELD || V4_FLAG_FIELDS.includes(field)
          ? 1
          : V4_ORDINAL_FIELDS.includes(field)
            ? 3
            : Math.log1p(Number.MAX_SAFE_INTEGER);
      if (!Number.isFinite(imputed) || imputed < 0 || imputed > upper)
        return atlmUnavailable('INVALID_ARTIFACT');
      expectedColumns.push(canonical({ kind, field }), canonical({ kind: 'missing', field }));
    }
  }
  const actualColumns = [...manifest.columns, ...manifest.droppedColumns].map((column) => {
    if (!isPlainRecord(column)) return 'invalid';
    return canonical(
      column.kind === 'category'
        ? { kind: column.kind, field: column.field, level: column.level }
        : { kind: column.kind, field: column.field },
    );
  });
  const canonicalIndex = new Map(expectedColumns.map((column, index) => [column, index]));
  const inOrder = (columns) =>
    columns.every(
      (column, index) =>
        index === 0 || canonicalIndex.get(columns[index - 1]) < canonicalIndex.get(column),
    );
  if (
    canonical(actualColumns.slice().sort()) !== canonical(expectedColumns.slice().sort()) ||
    !inOrder(actualColumns.slice(0, manifest.columns.length)) ||
    !inOrder(actualColumns.slice(manifest.columns.length))
  )
    return atlmUnavailable('INVALID_ARTIFACT');
  for (const column of manifest.columns) {
    if (
      !isPlainRecord(column) ||
      !manifest.fields.includes(column.field) ||
      !['category', 'missing', 'ordinal', 'count'].includes(column.kind) ||
      !Number.isFinite(column.origin) ||
      !Number.isFinite(column.center) ||
      !Number.isFinite(column.scale) ||
      column.scale <= 0 ||
      (column.kind === 'category' &&
        (typeof column.level !== 'string' ||
          (!Object.hasOwn(V4_CATEGORY_FIELDS, column.field) &&
            !V4_OPEN_CATEGORY_FIELDS.includes(column.field)))) ||
      (['count', 'ordinal'].includes(column.kind) &&
        !Number.isFinite(manifest.imputations[column.field]))
    )
      return atlmUnavailable('INVALID_ARTIFACT');
    const binary =
        ['category', 'missing'].includes(column.kind) || V4_FLAG_FIELDS.includes(column.field),
      mean = column.origin + column.center;
    if (
      binary &&
      (!(mean > 0 && mean < 1) ||
        ![0, 1].includes(column.origin) ||
        Math.abs(column.scale - Math.sqrt(mean * (1 - mean))) > 1e-10)
    )
      return atlmUnavailable('INVALID_ARTIFACT');
    if (
      !binary &&
      (column.origin < 0 ||
        mean < 0 ||
        (column.kind === 'ordinal' && (mean > 3 || column.origin > 3)) ||
        (column.kind === 'count' &&
          (mean > Math.log1p(Number.MAX_SAFE_INTEGER) ||
            column.origin > Math.log1p(Number.MAX_SAFE_INTEGER))))
    )
      return atlmUnavailable('INVALID_ARTIFACT');
  }
  const problem = v4FeatureProblem(features);
  if (problem) return atlmUnavailable(problem);
  const row = [
    1,
    ...manifest.columns.map(
      (column) =>
        (v4RawColumn(features, column, manifest) - column.origin - column.center) / column.scale,
    ),
  ];
  return row.every(Number.isFinite)
    ? { status: 'AVAILABLE', row }
    : atlmUnavailable('INVALID_FEATURES');
}

async function fitAtlmV4Regression(rows, engine) {
  if (!Array.isArray(rows) || !['OLS', 'RIDGE'].includes(engine))
    return atlmUnavailable('INVALID_DATASET');
  if (rows.length > ATLM_MAX_ROWS)
    return atlmUnavailable('DATASET_LIMIT_REACHED', {
      sampleCount: rows.length,
      limit: ATLM_MAX_ROWS,
    });
  if (!rows.length) return atlmUnavailable('INSUFFICIENT_DATA');
  const ids = new Set(),
    plans = new Set();
  for (const row of rows) {
    if (
      !isPlainRecord(row) ||
      !atlmValidId(row.sampleId) ||
      !atlmValidId(row.planId) ||
      ids.has(row.sampleId) ||
      plans.has(row.planId) ||
      ![row.capturedAt, row.sourceAvailableAt, row.actualMs].every(isNonnegativeSafeInteger) ||
      row.sourceAvailableAt < row.capturedAt ||
      !isPlainRecord(row.features)
    )
      return atlmUnavailable('INVALID_DATASET');
    ids.add(row.sampleId);
    plans.add(row.planId);
  }
  const sorted = atlmSortedRows(rows),
    n = sorted.length;
  const preprocessor = fitAtlmV4Preprocessor(sorted.map((row) => row.features));
  if (preprocessor.status !== 'AVAILABLE') return preprocessor;
  const plannedP = preprocessor.manifest.columns.length + 1,
    work = n * plannedP * plannedP + plannedP * plannedP * plannedP;
  if (work > ATLM_FIT_WORK_LIMIT)
    return atlmUnavailable('MODEL_RESOURCE_LIMIT', {
      sampleCount: n,
      p: plannedP,
      work,
      limit: ATLM_FIT_WORK_LIMIT,
    });
  const encoded = sorted.map((row) => encodeAtlmV4Features(row.features, preprocessor.manifest));
  if (encoded.some((row) => row.status !== 'AVAILABLE')) return atlmUnavailable('INVALID_FEATURES');
  const matrix = encoded.map((row) => row.row),
    p = matrix[0].length;
  const target = sorted.map((row) => Math.log1p(row.actualMs / ATLM_MS_PER_MINUTE));
  if (engine === 'OLS' && p > n) return atlmUnavailable('INSUFFICIENT_DATA', { sampleCount: n, p });
  const raw = atlmQr(matrix, target);
  if (engine === 'OLS' && raw.rank !== p)
    return atlmUnavailable('RANK_DEFICIENT', { sampleCount: n, p, rank: raw.rank });
  let solved = raw;
  if (engine === 'RIDGE') {
    const augmented = matrix.slice(),
      response = target.slice();
    for (let j = 1; j < p; j++) {
      const penalty = Array(p).fill(0);
      penalty[j] = Math.sqrt(n * ATLM_RIDGE_LAMBDA);
      augmented.push(penalty);
      response.push(0);
    }
    solved = atlmQr(augmented, response);
  }
  if (!solved.coefficients?.every(Number.isFinite))
    return atlmUnavailable('NUMERICAL_FAILURE', { sampleCount: n, p });
  const artifact = atlmFreeze({
    formatVersion: 3,
    kind: engine,
    featureSchemaVersion: 'agent-task-v4',
    metric: 'PLAN_ACTIVE',
    n,
    p,
    rank: raw.rank,
    preprocessor: preprocessor.manifest,
    coefficients: solved.coefficients,
    targetTransform: 'log1p-minutes-v1',
    lambda: engine === 'RIDGE' ? ATLM_RIDGE_LAMBDA : null,
    manifest: sorted.map(({ sampleId, planId }) => ({ sampleId, planId })),
    datasetDigest: 'sha256:' + (await hashCommandInput(sorted)),
  });
  return { status: 'AVAILABLE', artifact };
}

function atlmV4DefaultFeatures() {
  return Object.fromEntries(
    V4_FEATURE_FIELDS.map((field) => {
      if (field === 'doneBoundary') return [field, 'ANALYSIS'];
      if (V4_OPEN_CATEGORY_FIELDS.includes(field)) return [field, null];
      if (field === 'plannedParallelAgents') return [field, 1];
      if (Object.hasOwn(V4_CATEGORY_FIELDS, field)) return [field, V4_CATEGORY_FIELDS[field][0]];
      return [field, field === 'workUnits.CREATE' ? 1 : 0];
    }),
  );
}

function atlmV4RegressionArtifactValid(artifact) {
  if (
    !isPlainRecord(artifact) ||
    artifact.formatVersion !== 3 ||
    !['OLS', 'RIDGE'].includes(artifact.kind) ||
    artifact.featureSchemaVersion !== 'agent-task-v4' ||
    artifact.metric !== 'PLAN_ACTIVE' ||
    artifact.targetTransform !== 'log1p-minutes-v1' ||
    !Number.isSafeInteger(artifact.n) ||
    artifact.n < 1 ||
    artifact.n > ATLM_MAX_ROWS ||
    !Number.isSafeInteger(artifact.p) ||
    artifact.p < 1 ||
    artifact.p > V4_MODEL_COLUMN_LIMIT + 1 ||
    !Number.isSafeInteger(artifact.rank) ||
    artifact.rank < 1 ||
    artifact.rank > Math.min(artifact.n, artifact.p) ||
    (artifact.kind === 'OLS' && (artifact.rank !== artifact.p || artifact.lambda !== null)) ||
    (artifact.kind === 'RIDGE' && artifact.lambda !== ATLM_RIDGE_LAMBDA) ||
    !atlmManifestValid(artifact.manifest, artifact.n) ||
    !isSnapshotDigest(artifact.datasetDigest) ||
    !Array.isArray(artifact.coefficients) ||
    artifact.coefficients.length !== artifact.p ||
    !artifact.coefficients.every(Number.isFinite)
  )
    return false;
  const encoded = encodeAtlmV4Features(atlmV4DefaultFeatures(), artifact.preprocessor);
  return encoded.status === 'AVAILABLE' && encoded.row.length === artifact.p;
}

function predictAtlmV4Regression(artifact, features) {
  if (!atlmV4RegressionArtifactValid(artifact)) return atlmUnavailable('INVALID_ARTIFACT');
  const encoded = encodeAtlmV4Features(features, artifact.preprocessor);
  if (encoded.status !== 'AVAILABLE') return encoded;
  if (encoded.row.length !== artifact.p) return atlmUnavailable('INVALID_ARTIFACT');
  const z = atlmSum(encoded.row.map((value, i) => value * artifact.coefficients[i]));
  const ms = Math.max(0, ATLM_MS_PER_MINUTE * Math.expm1(z));
  return Number.isFinite(ms) && ms <= Number.MAX_SAFE_INTEGER
    ? { status: 'AVAILABLE', pointMs: Math.round(ms), reason: null }
    : atlmUnavailable('INVALID_PREDICTION');
}

const ATLM_BAYES_INTERCEPT_PRECISION = 0.000001;

const ATLM_BAYES_COEFFICIENT_PRECISION = 1;

const ATLM_BAYES_PRIOR_SHAPE = 2;

const ATLM_BAYES_PRIOR_SCALE = 1;

const ATLM_BAYES_NOMINAL_COVERAGE = 0.8;

function atlmCholesky(matrix) {
  const p = matrix.length,
    lower = Array.from({ length: p }, () => Array(p).fill(0));
  for (let i = 0; i < p; i++)
    for (let j = 0; j <= i; j++) {
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

function atlmLogGamma(z) {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
    12.507343278686905, -0.13857109526572012, 0.000009984369578019572, 0.00000015056327351493116,
  ];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - atlmLogGamma(1 - z);
  z -= 1;
  let sum = 0.9999999999998099;
  for (let i = 0; i < coefficients.length; i++) sum += coefficients[i] / (z + i + 1);
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

function atlmBetaFraction(a, b, x) {
  const tiny = 1e-300,
    tolerance = 3e-14,
    maxIterations = 1000;
  let c = 1,
    d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let value = d;
  for (let m = 1; m <= maxIterations; m++) {
    const twice = 2 * m;
    let numerator = (m * (b - m) * x) / ((a + twice - 1) * (a + twice));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    value *= d * c;
    numerator = (-(a + m) * (a + b + m) * x) / ((a + twice) * (a + twice + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    value *= delta;
    if (Math.abs(delta - 1) <= tolerance) return value;
  }
  return NaN;
}

function atlmRegularizedBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const factor = Math.exp(
    atlmLogGamma(a + b) - atlmLogGamma(a) - atlmLogGamma(b) + a * Math.log(x) + b * Math.log1p(-x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (factor * atlmBetaFraction(a, b, x)) / a
    : 1 - (factor * atlmBetaFraction(b, a, 1 - x)) / b;
}

function atlmStudentT90(degreesOfFreedom) {
  const cdf = (value) =>
    1 -
    atlmRegularizedBeta(
      degreesOfFreedom / (degreesOfFreedom + value * value),
      degreesOfFreedom / 2,
      0.5,
    ) /
      2;
  let low = 0,
    high = 1;
  while (cdf(high) < 0.9 && high < 1e6) high *= 2;
  if (!Number.isFinite(cdf(high)) || cdf(high) < 0.9) return NaN;
  for (let i = 0; i < 80; i++) {
    const middle = (low + high) / 2;
    if (cdf(middle) < 0.9) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function atlmBayesArtifactValid(artifact) {
  if (
    !isPlainRecord(artifact) ||
    artifact.formatVersion !== 3 ||
    artifact.kind !== 'BAYESIAN' ||
    artifact.featureSchemaVersion !== 'agent-task-v4' ||
    artifact.metric !== 'PLAN_ACTIVE' ||
    artifact.priorVersion !== 1 ||
    artifact.targetTransform !== 'log1p-minutes-v1' ||
    !Number.isSafeInteger(artifact.n) ||
    artifact.n < 1 ||
    artifact.n > ATLM_MAX_ROWS ||
    !Number.isSafeInteger(artifact.p) ||
    artifact.p < 1 ||
    artifact.p > V4_MODEL_COLUMN_LIMIT + 1 ||
    !Number.isSafeInteger(artifact.rank) ||
    artifact.rank < 1 ||
    artifact.rank > Math.min(artifact.n, artifact.p) ||
    !atlmManifestValid(artifact.manifest, artifact.n) ||
    !isSnapshotDigest(artifact.datasetDigest) ||
    !isPlainRecord(artifact.posterior) ||
    artifact.posterior.shape !== ATLM_BAYES_PRIOR_SHAPE + artifact.n / 2 ||
    !Number.isFinite(artifact.posterior.scale) ||
    artifact.posterior.scale < ATLM_BAYES_PRIOR_SCALE ||
    !Array.isArray(artifact.posterior.coefficients) ||
    artifact.posterior.coefficients.length !== artifact.p ||
    !artifact.posterior.coefficients.every(Number.isFinite) ||
    !Array.isArray(artifact.posterior.cholesky) ||
    artifact.posterior.cholesky.length !== artifact.p
  )
    return false;
  for (let i = 0; i < artifact.p; i++) {
    const row = artifact.posterior.cholesky[i];
    if (
      !Array.isArray(row) ||
      row.length !== artifact.p ||
      !row.every(Number.isFinite) ||
      row[i] <= 0 ||
      row.some((value, j) => j > i && value !== 0)
    )
      return false;
    const diagonal = atlmSum(row.map((value) => value * value));
    const expected =
      artifact.n + (i === 0 ? ATLM_BAYES_INTERCEPT_PRECISION : ATLM_BAYES_COEFFICIENT_PRECISION);
    if (
      Math.abs(diagonal - expected) > 1e-8 * expected ||
      (i > 0 && Math.abs(row[0]) > 1e-7 * Math.sqrt(artifact.n))
    )
      return false;
  }
  const encoded = encodeAtlmV4Features(atlmV4DefaultFeatures(), artifact.preprocessor);
  return encoded.status === 'AVAILABLE' && encoded.row.length === artifact.p;
}

async function fitAtlmBayesian(rows) {
  const problem = atlmDatasetProblem(rows);
  if (problem) return problem;
  if (!rows.length) return atlmUnavailable('INSUFFICIENT_DATA');
  const sorted = atlmSortedRows(rows);
  for (const row of sorted) {
    const missing = atlmFeatureProblem(row.features);
    if (missing) return missing;
  }
  const fitted = fitAtlmV4Preprocessor(sorted.map((row) => row.features));
  if (fitted.status !== 'AVAILABLE') return fitted;
  const plannedP = fitted.manifest.columns.length + 1,
    work = sorted.length * plannedP * plannedP + plannedP * plannedP * plannedP;
  if (work > ATLM_FIT_WORK_LIMIT)
    return atlmUnavailable('MODEL_RESOURCE_LIMIT', {
      sampleCount: sorted.length,
      p: plannedP,
      work,
      limit: ATLM_FIT_WORK_LIMIT,
    });
  const encoded = sorted.map((row) => encodeAtlmV4Features(row.features, fitted.manifest));
  if (encoded.some((row) => row.status !== 'AVAILABLE')) return atlmUnavailable('INVALID_FEATURES');
  const matrix = encoded.map((row) => row.row),
    n = matrix.length,
    p = matrix[0].length;
  const target = sorted.map((row) => Math.log1p(row.actualMs / ATLM_MS_PER_MINUTE));
  const precision = Array.from({ length: p }, (_, i) =>
    Array.from(
      { length: p },
      (_, j) =>
        atlmSum(matrix.map((row) => row[i] * row[j])) +
        (i === j
          ? i === 0
            ? ATLM_BAYES_INTERCEPT_PRECISION
            : ATLM_BAYES_COEFFICIENT_PRECISION
          : 0),
    ),
  );
  const lower = atlmCholesky(precision);
  if (!lower) return atlmUnavailable('NUMERICAL_FAILURE', { sampleCount: n, p });
  const rhs = Array.from({ length: p }, (_, i) =>
    atlmSum(matrix.map((row, j) => row[i] * target[j])),
  );
  const coefficients = atlmUpperTransposeSolve(lower, atlmLowerSolve(lower, rhs));
  const residualSquares = atlmSum(
    matrix.map((row, i) => (target[i] - atlmSum(row.map((x, j) => x * coefficients[j]))) ** 2),
  );
  const priorPenalty = coefficients.reduce(
    (sum, value, i) =>
      sum +
      value * value * (i === 0 ? ATLM_BAYES_INTERCEPT_PRECISION : ATLM_BAYES_COEFFICIENT_PRECISION),
    0,
  );
  const shape = ATLM_BAYES_PRIOR_SHAPE + n / 2,
    scale = ATLM_BAYES_PRIOR_SCALE + (residualSquares + priorPenalty) / 2;
  if (!coefficients.every(Number.isFinite) || !Number.isFinite(scale) || scale <= 0)
    return atlmUnavailable('NUMERICAL_FAILURE', { sampleCount: n, p });
  const rank = atlmQr(matrix, Array(n).fill(0)).rank;
  const artifact = atlmFreeze({
    formatVersion: 3,
    kind: 'BAYESIAN',
    featureSchemaVersion: 'agent-task-v4',
    metric: 'PLAN_ACTIVE',
    n,
    p,
    rank,
    priorVersion: 1,
    targetTransform: 'log1p-minutes-v1',
    preprocessor: fitted.manifest,
    posterior: { coefficients, cholesky: lower, shape, scale },
    manifest: sorted.map(({ sampleId, planId }) => ({ sampleId, planId })),
    datasetDigest: 'sha256:' + (await hashCommandInput(sorted)),
  });
  return { status: 'AVAILABLE', artifact };
}

function predictAtlmBayesian(artifact, features) {
  if (
    !atlmBayesArtifactValid(artifact) ||
    artifact.priorVersion !== 1 ||
    artifact.targetTransform !== 'log1p-minutes-v1'
  )
    return atlmUnavailable('INVALID_ARTIFACT');
  const encoded = encodeAtlmV4Features(features, artifact.preprocessor);
  if (encoded.status !== 'AVAILABLE') return encoded;
  const posterior = artifact.posterior,
    x = encoded.row,
    transformed = atlmLowerSolve(posterior.cholesky, x);
  const location = atlmSum(x.map((value, i) => value * posterior.coefficients[i]));
  const scale = Math.sqrt(
    (posterior.scale / posterior.shape) * (1 + atlmSum(transformed.map((value) => value * value))),
  );
  const degreesOfFreedom = 2 * posterior.shape,
    quantile = atlmStudentT90(degreesOfFreedom);
  const ms = (z) => Math.max(0, ATLM_MS_PER_MINUTE * Math.expm1(z));
  const point = ms(location);
  if (
    !Number.isFinite(location) ||
    !(scale > 0) ||
    !Number.isFinite(scale) ||
    !Number.isFinite(point) ||
    point > Number.MAX_SAFE_INTEGER
  )
    return atlmUnavailable('INVALID_PREDICTION');
  const lower = ms(location - quantile * scale),
    upper = ms(location + quantile * scale);
  const available =
    Number.isFinite(quantile) &&
    Number.isFinite(lower) &&
    Number.isFinite(upper) &&
    upper <= Number.MAX_SAFE_INTEGER;
  return {
    status: 'AVAILABLE',
    pointMs: Math.round(point),
    reason: null,
    predictive: { location, scale, degreesOfFreedom },
    interval: available
      ? {
          status: 'AVAILABLE',
          lowerMs: Math.round(lower),
          upperMs: Math.round(upper),
          nominalCoverage: ATLM_BAYES_NOMINAL_COVERAGE,
          engine: 'BAYESIAN_PREDICTIVE',
        }
      : {
          status: 'UNAVAILABLE',
          lowerMs: null,
          upperMs: null,
          nominalCoverage: ATLM_BAYES_NOMINAL_COVERAGE,
          engine: 'BAYESIAN_PREDICTIVE',
          unavailableReason: 'NUMERICAL_FAILURE',
        },
  };
}

const ATLM_QUANTILE_LEVELS = [0.1, 0.5, 0.9];

const ATLM_QUANTILE_LAMBDA = 1;

const ATLM_QUANTILE_MAX_ITERATIONS = 2000;

const ATLM_QUANTILE_TOLERANCE = 0.000001;

const ATLM_QUANTILE_RESOLUTION_FACTOR = 16;

const ATLM_QUANTILE_WORK_LIMIT = 5000000;

async function fitAtlmResidualQuantile(samples, quantile) {
  if (!Array.isArray(samples) || !ATLM_QUANTILE_LEVELS.includes(quantile))
    return atlmUnavailable('INVALID_DATASET');
  if (samples.length < 5)
    return atlmUnavailable('INSUFFICIENT_RESIDUALS', { sampleCount: samples.length });
  if (samples.length > ATLM_MAX_ROWS)
    return atlmUnavailable('DATASET_LIMIT_REACHED', {
      sampleCount: samples.length,
      limit: ATLM_MAX_ROWS,
    });
  const plans = new Set();
  for (const sample of samples) {
    if (
      !isPlainRecord(sample) ||
      !atlmValidId(sample.planId) ||
      plans.has(sample.planId) ||
      !Number.isFinite(sample.residual) ||
      v4FeatureProblem(sample.features)
    )
      return atlmUnavailable('INVALID_DATASET');
    if (
      Math.abs(sample.residual) * Number.EPSILON * ATLM_QUANTILE_RESOLUTION_FACTOR >=
      Math.min(quantile, 1 - quantile) * ATLM_QUANTILE_TOLERANCE
    )
      return atlmUnavailable('NUMERICAL_FAILURE', { sampleCount: samples.length });
    plans.add(sample.planId);
  }
  const ordered = samples.slice().sort((a, b) => atlmCompareId(a.planId, b.planId));
  const fitted = fitAtlmV4Preprocessor(ordered.map((sample) => sample.features));
  if (fitted.status !== 'AVAILABLE') return fitted;
  const encoded = ordered.map((sample) => encodeAtlmV4Features(sample.features, fitted.manifest));
  if (encoded.some((row) => row.status !== 'AVAILABLE')) return atlmUnavailable('INVALID_FEATURES');
  const matrix = encoded.map((row) => row.row),
    target = ordered.map((sample) => sample.residual),
    n = matrix.length,
    p = matrix[0].length;
  const work = n * p * p + p * p * p + ATLM_QUANTILE_MAX_ITERATIONS * n * p;
  if (work > ATLM_QUANTILE_WORK_LIMIT)
    return atlmUnavailable('QUANTILE_RESOURCE_LIMIT', {
      sampleCount: n,
      p,
      work,
      limit: ATLM_QUANTILE_WORK_LIMIT,
    });
  const precision = Array.from({ length: p }, (_, i) =>
    Array.from(
      { length: p },
      (_, j) =>
        atlmSum(matrix.map((row) => row[i] * row[j])) +
        (i === j && i > 0 ? n * ATLM_QUANTILE_LAMBDA : 0),
    ),
  );
  const lower = atlmCholesky(precision);
  if (!lower) return atlmUnavailable('NUMERICAL_FAILURE', { sampleCount: n, p });
  let coefficients = Array(p).fill(0),
    residual = Array(n).fill(0),
    dual = Array(n).fill(0),
    iterations = 0,
    converged = false;
  for (iterations = 1; iterations <= ATLM_QUANTILE_MAX_ITERATIONS; iterations++) {
    const rhs = Array.from({ length: p }, (_, j) =>
      atlmSum(matrix.map((row, i) => row[j] * (target[i] - residual[i] + dual[i]))),
    );
    coefficients = atlmUpperTransposeSolve(lower, atlmLowerSolve(lower, rhs));
    if (!coefficients.every(Number.isFinite))
      return atlmUnavailable('NUMERICAL_FAILURE', { sampleCount: n, p });
    const predicted = matrix.map((row) => atlmSum(row.map((value, j) => value * coefficients[j]))),
      previous = residual;
    residual = predicted.map((value, i) => {
      const z = target[i] - value + dual[i];
      return z > quantile ? z - quantile : z < quantile - 1 ? z + 1 - quantile : 0;
    });
    const primal = target.map((value, i) => value - predicted[i] - residual[i]);
    dual = dual.map((value, i) => value + primal[i]);
    const norm = (values) => Math.sqrt(atlmSum(values.map((value) => value * value)));
    const dualResidual = Array.from({ length: p }, (_, j) =>
      atlmSum(matrix.map((row, i) => row[j] * (residual[i] - previous[i]))),
    );
    const dualScale = Array.from({ length: p }, (_, j) =>
      atlmSum(matrix.map((row, i) => row[j] * dual[i])),
    );
    const primalLimit =
      ATLM_QUANTILE_TOLERANCE *
      (Math.sqrt(n) + Math.max(norm(target), norm(predicted), norm(residual)));
    const dualLimit = ATLM_QUANTILE_TOLERANCE * (Math.sqrt(p) + norm(dualScale));
    if (norm(primal) <= primalLimit && norm(dualResidual) <= dualLimit) {
      converged = true;
      break;
    }
  }
  if (!converged)
    return atlmUnavailable('QUANTILE_NOT_CONVERGED', {
      sampleCount: n,
      p,
      iterations: ATLM_QUANTILE_MAX_ITERATIONS,
    });
  const artifact = atlmFreeze({
    formatVersion: 1,
    kind: 'RESIDUAL_QUANTILE',
    quantile,
    lambda: ATLM_QUANTILE_LAMBDA,
    solver: 'admm-pinball-v1',
    tolerance: ATLM_QUANTILE_TOLERANCE,
    iterations,
    n,
    p,
    preprocessor: fitted.manifest,
    coefficients,
    manifest: ordered.map((row) => row.planId),
    datasetDigest: 'sha256:' + (await hashCommandInput(ordered)),
  });
  return { status: 'AVAILABLE', artifact };
}

function predictAtlmResidualQuantile(artifact, features) {
  if (
    !isPlainRecord(artifact) ||
    artifact.formatVersion !== 1 ||
    artifact.kind !== 'RESIDUAL_QUANTILE' ||
    !ATLM_QUANTILE_LEVELS.includes(artifact.quantile) ||
    artifact.lambda !== ATLM_QUANTILE_LAMBDA ||
    artifact.solver !== 'admm-pinball-v1' ||
    artifact.tolerance !== ATLM_QUANTILE_TOLERANCE ||
    !Number.isSafeInteger(artifact.n) ||
    artifact.n < 5 ||
    artifact.n > ATLM_MAX_ROWS ||
    !Number.isSafeInteger(artifact.p) ||
    artifact.p < 1 ||
    artifact.p > V4_MODEL_COLUMN_LIMIT + 1 ||
    !Number.isSafeInteger(artifact.iterations) ||
    artifact.iterations < 1 ||
    artifact.iterations > ATLM_QUANTILE_MAX_ITERATIONS ||
    !Array.isArray(artifact.manifest) ||
    artifact.manifest.length !== artifact.n ||
    new Set(artifact.manifest).size !== artifact.n ||
    !artifact.manifest.every(atlmValidId) ||
    !isSnapshotDigest(artifact.datasetDigest) ||
    !Array.isArray(artifact.coefficients) ||
    artifact.coefficients.length !== artifact.p ||
    !artifact.coefficients.every(Number.isFinite)
  )
    return atlmUnavailable('INVALID_ARTIFACT');
  const encoded = encodeAtlmV4Features(features, artifact.preprocessor);
  if (encoded.status !== 'AVAILABLE') return encoded;
  if (encoded.row.length !== artifact.p) return atlmUnavailable('INVALID_ARTIFACT');
  const value = atlmSum(encoded.row.map((x, i) => x * artifact.coefficients[i]));
  return Number.isFinite(value)
    ? { status: 'AVAILABLE', value }
    : { status: 'UNAVAILABLE', value: null, reason: 'INVALID_PREDICTION' };
}

async function fitAtlmResidualQuantiles(samples) {
  if (!Array.isArray(samples) || samples.length < 5)
    return atlmUnavailable('INSUFFICIENT_RESIDUALS', {
      sampleCount: Array.isArray(samples) ? samples.length : 0,
    });
  const models = [];
  for (const quantile of ATLM_QUANTILE_LEVELS) {
    const fit = await fitAtlmResidualQuantile(samples, quantile);
    if (fit.status !== 'AVAILABLE')
      return atlmUnavailable(fit.reason, { quantile, sampleCount: samples.length });
    models.push(fit.artifact);
  }
  return {
    status: 'AVAILABLE',
    artifact: atlmFreeze({
      formatVersion: 1,
      kind: 'BAYES_QUANTILE',
      sampleCount: samples.length,
      models,
    }),
  };
}

function atlmResidualQuantilesValid(artifact) {
  if (
    !isPlainRecord(artifact) ||
    artifact.formatVersion !== 1 ||
    artifact.kind !== 'BAYES_QUANTILE' ||
    !Number.isSafeInteger(artifact.sampleCount) ||
    artifact.sampleCount < 5 ||
    !Array.isArray(artifact.models) ||
    artifact.models.length !== 3
  )
    return false;
  return artifact.models.every(
    (model, i) =>
      isPlainRecord(model) &&
      model.quantile === ATLM_QUANTILE_LEVELS[i] &&
      model.n === artifact.sampleCount &&
      model.datasetDigest === artifact.models[0].datasetDigest &&
      canonical(model.manifest) === canonical(artifact.models[0].manifest) &&
      canonical(model.preprocessor) === canonical(artifact.models[0].preprocessor) &&
      predictAtlmResidualQuantile(model, atlmV4DefaultFeatures()).status === 'AVAILABLE',
  );
}

function combineAtlmQuantileInterval(
  predictive,
  quantiles,
  pointMs,
  calibrationSampleCount,
  validationStatus = 'EXPERIMENTAL',
) {
  const unavailable = (reason) => ({
    status: 'UNAVAILABLE',
    lowerMs: null,
    upperMs: null,
    nominalCoverage: ATLM_BAYES_NOMINAL_COVERAGE,
    engine: 'BAYES_QUANTILE',
    calibrationSampleCount,
    validationStatus,
    unavailableReason: reason,
  });
  if (
    !isPlainRecord(predictive) ||
    !Number.isFinite(predictive.location) ||
    !Number.isFinite(predictive.scale) ||
    predictive.scale <= 0 ||
    !Array.isArray(quantiles) ||
    quantiles.length !== 3 ||
    !quantiles.every(Number.isFinite) ||
    !isNonnegativeSafeInteger(pointMs) ||
    !Number.isSafeInteger(calibrationSampleCount) ||
    calibrationSampleCount < 5 ||
    !['EXPERIMENTAL', 'HISTORICALLY_EVALUATED'].includes(validationStatus)
  )
    return unavailable('INVALID_PREDICTION');
  const ordered = quantiles.slice().sort((a, b) => a - b);
  const converted = (value) =>
    Math.max(0, ATLM_MS_PER_MINUTE * Math.expm1(predictive.location + predictive.scale * value));
  const rawLower = converted(ordered[0]),
    rawUpper = converted(ordered[2]);
  if (
    !Number.isFinite(rawLower) ||
    !Number.isFinite(rawUpper) ||
    rawUpper > Number.MAX_SAFE_INTEGER
  )
    return unavailable('NUMERICAL_FAILURE');
  return {
    status: 'AVAILABLE',
    lowerMs: Math.min(pointMs, Math.round(rawLower)),
    upperMs: Math.max(pointMs, Math.round(rawUpper)),
    nominalCoverage: ATLM_BAYES_NOMINAL_COVERAGE,
    engine: 'BAYES_QUANTILE',
    calibrationSampleCount,
    validationStatus,
    unavailableReason: null,
  };
}

function predictAtlmResidualInterval(
  artifact,
  features,
  bayesianPrediction,
  pointMs,
  validationStatus = 'EXPERIMENTAL',
) {
  if (!atlmResidualQuantilesValid(artifact))
    return {
      status: 'UNAVAILABLE',
      lowerMs: null,
      upperMs: null,
      nominalCoverage: ATLM_BAYES_NOMINAL_COVERAGE,
      engine: 'BAYES_QUANTILE',
      calibrationSampleCount: 0,
      validationStatus,
      unavailableReason: 'INVALID_ARTIFACT',
    };
  const predictions = artifact.models.map((model) => predictAtlmResidualQuantile(model, features));
  if (predictions.some((prediction) => prediction.status !== 'AVAILABLE'))
    return {
      status: 'UNAVAILABLE',
      lowerMs: null,
      upperMs: null,
      nominalCoverage: ATLM_BAYES_NOMINAL_COVERAGE,
      engine: 'BAYES_QUANTILE',
      calibrationSampleCount: artifact.sampleCount,
      validationStatus,
      unavailableReason: predictions.find((prediction) => prediction.status !== 'AVAILABLE').reason,
    };
  return combineAtlmQuantileInterval(
    bayesianPrediction?.predictive,
    predictions.map((prediction) => prediction.value),
    pointMs,
    artifact.sampleCount,
    validationStatus,
  );
}

function atlmUnavailableInterval(engine, reason, calibrationSampleCount = 0) {
  return {
    status: 'UNAVAILABLE',
    lowerMs: null,
    upperMs: null,
    nominalCoverage: ATLM_BAYES_NOMINAL_COVERAGE,
    engine,
    calibrationSampleCount,
    validationStatus: 'EXPERIMENTAL',
    unavailableReason: reason,
  };
}

async function evaluateAtlmIntervalCandidates(base, history, pointMs) {
  const bayesian = base?.bayesian;
  if (
    !isPlainRecord(base) ||
    !isNonnegativeSafeInteger(base.capturedAt) ||
    !Array.isArray(history) ||
    history.some(
      (prior) =>
        !isPlainRecord(prior) ||
        !atlmValidId(prior.planId) ||
        prior.planId === base.planId ||
        !isNonnegativeSafeInteger(prior.sourceAvailableAt) ||
        prior.sourceAvailableAt >= base.capturedAt,
    ) ||
    new Set(history.map((prior) => prior.planId)).size !== history.length
  )
    return {
      BAYESIAN_PREDICTIVE: atlmUnavailableInterval('BAYESIAN_PREDICTIVE', 'INVALID_HISTORY'),
      BAYES_QUANTILE: atlmUnavailableInterval('BAYES_QUANTILE', 'INVALID_HISTORY'),
    };
  if (
    !isNonnegativeSafeInteger(pointMs) ||
    bayesian?.status !== 'AVAILABLE' ||
    !bayesian.predictive
  ) {
    const reason =
      bayesian?.reason || bayesian?.interval?.unavailableReason || 'BAYESIAN_UNAVAILABLE';
    return {
      BAYESIAN_PREDICTIVE: atlmUnavailableInterval('BAYESIAN_PREDICTIVE', reason),
      BAYES_QUANTILE: atlmUnavailableInterval('BAYES_QUANTILE', reason),
    };
  }
  const predictive =
    bayesian.interval?.status === 'AVAILABLE'
      ? {
          status: 'AVAILABLE',
          lowerMs: Math.min(pointMs, bayesian.interval.lowerMs),
          upperMs: Math.max(pointMs, bayesian.interval.upperMs),
          nominalCoverage: ATLM_BAYES_NOMINAL_COVERAGE,
          engine: 'BAYESIAN_PREDICTIVE',
          calibrationSampleCount: 0,
          validationStatus: 'EXPERIMENTAL',
          unavailableReason: null,
        }
      : atlmUnavailableInterval(
          'BAYESIAN_PREDICTIVE',
          bayesian.interval?.unavailableReason || 'NUMERICAL_FAILURE',
        );
  const residuals = [];
  for (const prior of history) {
    if (prior.bayesian?.status !== 'AVAILABLE' || !isNonnegativeSafeInteger(prior.actualMs))
      continue;
    const prediction = prior.bayesian.predictive;
    if (
      !prediction ||
      !Number.isFinite(prediction.location) ||
      !Number.isFinite(prediction.scale) ||
      prediction.scale <= 0
    )
      return {
        BAYESIAN_PREDICTIVE: predictive,
        BAYES_QUANTILE: atlmUnavailableInterval(
          'BAYES_QUANTILE',
          'INVALID_PREDICTION',
          residuals.length,
        ),
      };
    residuals.push({
      planId: prior.planId,
      features: prior.features,
      residual:
        (Math.log1p(prior.actualMs / ATLM_MS_PER_MINUTE) - prediction.location) / prediction.scale,
    });
  }
  const fitted = await fitAtlmResidualQuantiles(residuals);
  return {
    BAYESIAN_PREDICTIVE: predictive,
    BAYES_QUANTILE:
      fitted.status === 'AVAILABLE'
        ? predictAtlmResidualInterval(fitted.artifact, base.features, bayesian, pointMs)
        : atlmUnavailableInterval('BAYES_QUANTILE', fitted.reason, residuals.length),
  };
}

function summarizeAtlmV4Metrics(cases) {
  if (!Array.isArray(cases)) return atlmUnavailable('INVALID_EVALUATION');
  const plans = new Set();
  for (const item of cases) {
    if (
      !isPlainRecord(item) ||
      !atlmValidId(item.planId) ||
      plans.has(item.planId) ||
      !isNonnegativeSafeInteger(item.actualMs) ||
      !(item.pointMs === null || isNonnegativeSafeInteger(item.pointMs)) ||
      !isPlainRecord(item.interval) ||
      !['AVAILABLE', 'UNAVAILABLE'].includes(item.interval.status)
    )
      return atlmUnavailable('INVALID_EVALUATION');
    if (
      item.interval.status === 'AVAILABLE' &&
      (!isNonnegativeSafeInteger(item.pointMs) ||
        !isNonnegativeSafeInteger(item.interval.lowerMs) ||
        !isNonnegativeSafeInteger(item.interval.upperMs) ||
        item.interval.lowerMs > item.pointMs ||
        item.pointMs > item.interval.upperMs)
    )
      return atlmUnavailable('INVALID_EVALUATION');
    if (
      item.interval.status === 'UNAVAILABLE' &&
      (item.interval.lowerMs !== null ||
        item.interval.upperMs !== null ||
        typeof item.interval.unavailableReason !== 'string' ||
        !item.interval.unavailableReason.trim())
    )
      return atlmUnavailable('INVALID_EVALUATION');
    plans.add(item.planId);
  }
  const valid = cases;
  const points = valid.filter((item) => isNonnegativeSafeInteger(item.pointMs));
  const intervals = points.filter(
    (item) =>
      item.interval?.status === 'AVAILABLE' &&
      isNonnegativeSafeInteger(item.interval.lowerMs) &&
      isNonnegativeSafeInteger(item.interval.upperMs) &&
      item.interval.lowerMs <= item.pointMs &&
      item.pointMs <= item.interval.upperMs,
  );
  const errors = points.map((item) => item.pointMs - item.actualMs),
    absolute = errors.map(Math.abs);
  const totalActual = atlmSum(points.map((item) => item.actualMs)),
    sumAbsoluteError = atlmSum(absolute),
    sumSignedError = atlmSum(errors);
  const hits = intervals.filter(
    (item) => item.interval.lowerMs <= item.actualMs && item.actualMs <= item.interval.upperMs,
  ).length;
  const widths = intervals.map((item) => item.interval.upperMs - item.interval.lowerMs);
  const scores = intervals.map(
    (item, i) =>
      widths[i] +
      10 *
        Math.max(0, item.interval.lowerMs - item.actualMs, item.actualMs - item.interval.upperMs),
  );
  return {
    caseCount: valid.length,
    pointCaseCount: points.length,
    intervalCaseCount: intervals.length,
    caseIds: valid.map((item) => item.planId),
    pointCaseIds: points.map((item) => item.planId),
    intervalCaseIds: intervals.map((item) => item.planId),
    forecastRate: valid.length ? points.length / valid.length : null,
    intervalAvailabilityRate: valid.length ? intervals.length / valid.length : null,
    maeMs: points.length ? sumAbsoluteError / points.length : null,
    medaeMs: points.length ? median(absolute) : null,
    meanSignedErrorMs: points.length ? sumSignedError / points.length : null,
    sumAbsoluteErrorMs: sumAbsoluteError,
    sumSignedErrorMs: sumSignedError,
    totalActualMs: totalActual,
    wapePercent: totalActual ? (100 * sumAbsoluteError) / totalActual : null,
    signedBiasPercent: totalActual ? (100 * sumSignedError) / totalActual : null,
    coverageNumerator: hits,
    coverageDenominator: intervals.length,
    intervalCoverage: intervals.length ? hits / intervals.length : null,
    meanIntervalWidthMs: intervals.length ? atlmSum(widths) / intervals.length : null,
    meanIntervalScore: intervals.length ? atlmSum(scores) / intervals.length : null,
  };
}

function selectAtlmIntervalEngine(candidates, cases, { incumbent = null } = {}) {
  if (
    !isPlainRecord(candidates) ||
    !Array.isArray(cases) ||
    cases.some(
      (item) =>
        !isPlainRecord(item) ||
        !atlmValidId(item.planId) ||
        !isNonnegativeSafeInteger(item.capturedAt) ||
        !isNonnegativeSafeInteger(item.actualMs) ||
        !isNonnegativeSafeInteger(item.pointMs) ||
        !isPlainRecord(item.intervals),
    ) ||
    new Set(cases.map((item) => item.planId)).size !== cases.length
  )
    return atlmUnavailable('INVALID_EVALUATION');
  const engines = ['BAYESIAN_PREDICTIVE', 'BAYES_QUANTILE'],
    available = engines.filter((engine) => candidates[engine]?.status === 'AVAILABLE');
  const window = cases
    .slice()
    .sort((a, b) => a.capturedAt - b.capturedAt || atlmCompareId(a.planId, b.planId))
    .slice(-ATLM_MAX_EVALUATION_CASES);
  const validInterval = (item, engine) => {
    const interval = item.intervals[engine];
    return (
      isPlainRecord(interval) &&
      interval.status === 'AVAILABLE' &&
      isNonnegativeSafeInteger(interval.lowerMs) &&
      isNonnegativeSafeInteger(interval.upperMs) &&
      interval.lowerMs <= item.pointMs &&
      item.pointMs <= interval.upperMs
    );
  };
  for (const item of window)
    for (const engine of engines) {
      const interval = item.intervals[engine];
      if (
        !isPlainRecord(interval) ||
        !['AVAILABLE', 'UNAVAILABLE'].includes(interval.status) ||
        (interval.status === 'AVAILABLE' && !validInterval(item, engine)) ||
        (interval.status === 'UNAVAILABLE' &&
          (interval.lowerMs !== null ||
            interval.upperMs !== null ||
            typeof interval.unavailableReason !== 'string' ||
            !interval.unavailableReason.trim()))
      )
        return atlmUnavailable('INVALID_EVALUATION');
    }
  const eligible = available.filter(
    (engine) => window.filter((item) => validInterval(item, engine)).length >= ATLM_MIN_COMPARISONS,
  );
  const common = eligible.length
    ? window.filter((item) => eligible.every((engine) => validInterval(item, engine)))
    : [];
  const metrics = {};
  for (const engine of eligible) {
    const values = common.map((item) => ({
      planId: item.planId,
      actualMs: item.actualMs,
      pointMs: item.pointMs,
      interval: item.intervals[engine],
    }));
    metrics[engine] = summarizeAtlmV4Metrics(values);
  }
  let selectedEngine = null,
    reason = 'NO_INTERVAL_AVAILABLE';
  if (common.length >= ATLM_MIN_COMPARISONS) {
    const best = Math.min(...eligible.map((engine) => metrics[engine].meanIntervalScore));
    let tied = eligible.filter(
      (engine) => Math.abs(metrics[engine].meanIntervalScore - best) <= 1e-9,
    );
    const coverageDistance = Math.min(
      ...tied.map((engine) =>
        Math.abs(metrics[engine].intervalCoverage - ATLM_BAYES_NOMINAL_COVERAGE),
      ),
    );
    tied = tied.filter(
      (engine) =>
        Math.abs(
          Math.abs(metrics[engine].intervalCoverage - ATLM_BAYES_NOMINAL_COVERAGE) -
            coverageDistance,
        ) <= 1e-12,
    );
    const width = Math.min(...tied.map((engine) => metrics[engine].meanIntervalWidthMs));
    tied = tied.filter((engine) => Math.abs(metrics[engine].meanIntervalWidthMs - width) <= 1e-9);
    selectedEngine = tied.includes(incumbent) ? incumbent : tied[0];
    reason = 'LOWEST_INTERVAL_SCORE';
  } else if (available.length) {
    selectedEngine = available.includes(incumbent) ? incumbent : available[0];
    reason = 'EARLY_EXPERIMENTAL';
  }
  return {
    selectedEngine,
    reason,
    caseCount: common.length,
    caseIds: common.map((item) => item.planId),
    metrics,
    validationStatus:
      common.length >= ATLM_MIN_COMPARISONS ? 'HISTORICALLY_EVALUATED' : 'EXPERIMENTAL',
  };
}

const AGENT_TASK_SCHEMA = V4_TASK_SCHEMA;

function isTaskProofPath(key) {
  if (Object.hasOwn(V4_TASK_SCHEMA.properties, key)) return true;
  if (key.startsWith('execution.'))
    return Object.hasOwn(
      V4_TASK_SCHEMA.properties.execution.properties,
      key.slice('execution.'.length),
    );
  if (key.startsWith('verificationKinds.'))
    return V4_VERIFICATION_KINDS.includes(key.slice('verificationKinds.'.length));
  const match =
    /^systemBoundaries\[([a-z0-9][a-z0-9._:-]{0,127})\]\.operations\[([a-z0-9][a-z0-9._:-]{0,127})\]\.(\w+)$/.exec(
      key,
    );
  return Boolean(match && Object.hasOwn(V4_OPERATION_ENUMS, match[3]));
}

function validateAssessmentValue(value, schema, path = 'input', depth = 0) {
  if (depth > 12) throw appError('VALIDATION_ERROR', 'JSON depth exceeds 12.');
  if (schema.enum && !schema.enum.includes(value)) throw taskFieldError(path, value === null);
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = schema.type ? [].concat(schema.type) : null;
  if (
    types &&
    !types.includes(type) &&
    !(type === 'number' && types.includes('integer') && Number.isSafeInteger(value))
  )
    throw taskFieldError(path, value === null);
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) ||
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum))
  )
    throw taskFieldError(path);
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw taskFieldError(path);
    if (
      Array.from(value).length > (schema.maxLength ?? 4000) ||
      Array.from(value.trim()).length < (schema.minLength ?? 0) ||
      (schema.format === 'uuid' && !UUID.test(value))
    )
      throw taskFieldError(path, !value.trim());
    assertSafeMetadataText(value, path);
  }
  if (Array.isArray(value)) {
    if (value.length > (schema.maxItems ?? 100) || value.length < (schema.minItems ?? 0))
      throw taskFieldError(path, value.length < (schema.minItems ?? 0));
    value.forEach((item, index) =>
      validateAssessmentValue(item, schema.items || {}, path + '[' + index + ']', depth + 1),
    );
  } else if (value && typeof value === 'object') {
    if (!isPlainRecord(schema.additionalProperties) && Object.keys(value).length > 100)
      throw appError('VALIDATION_ERROR', path + ': too many keys.');
    for (const key of schema.required || [])
      if (!Object.hasOwn(value, key)) throw taskFieldError(path + '.' + key, true, 'MISSING_FIELD');
    if (schema.additionalProperties === false)
      assertExactKeys(value, new Set(Object.keys(schema.properties || {})), path);
    for (const [key, item] of Object.entries(value)) {
      if (
        schema === V4_TASK_SCHEMA.properties.evidence ||
        schema === V4_TASK_SCHEMA.properties.unknownReasons
      ) {
        if (!isTaskProofPath(key)) throw taskFieldError(path);
        assertSafeMetadataText(key, path);
      }
      if (!isPlainRecord(schema.additionalProperties) && key.length > 128)
        throw appError('VALIDATION_ERROR', path + ': key too long.');
      validateAssessmentValue(
        item,
        Object.hasOwn(schema.properties ?? {}, key)
          ? schema.properties[key]
          : isPlainRecord(schema.additionalProperties)
            ? schema.additionalProperties
            : {},
        path + '.' + key,
        depth + 1,
      );
    }
  }
}

export {
  AGENT_TASK_SCHEMA,
  ATLM_FEATURE_VERSION,
  ATLM_INTERNAL_REPLAY,
  ATLM_MAX_ROWS,
  ATLM_METHOD,
  ATLM_MIN_COMPARISONS,
  ATLM_MS_PER_MINUTE,
  ATLM_OLS_METHOD,
  ATLM_POLICY_VERSION,
  V4_TASK_MAX_BYTES,
  atlmArtifactValid,
  atlmFitCandidates,
  atlmFitDiagnostic,
  atlmHybridTargets,
  atlmReconstructResidual,
  atlmReplayPolicyCase,
  atlmTrainingRow,
  atlmUnavailableInterval,
  combineAtlmQuantileInterval,
  encodeAtlmV4Features,
  evaluateAtlmIntervalCandidates,
  evaluateHybridAtlmChronologically,
  evaluateHybridBaseCase,
  fitAtlm,
  fitAtlmBayesian,
  fitAtlmOls,
  fitAtlmResidualQuantile,
  fitAtlmResidualQuantiles,
  fitAtlmRidge,
  fitAtlmV4Preprocessor,
  fitAtlmV4Regression,
  fitHybridAtlm,
  isNonnegativeSafeInteger,
  normalizeAgentTask,
  predictAtlm,
  predictAtlmBayesian,
  predictAtlmOls,
  predictAtlmResidualInterval,
  predictAtlmResidualQuantile,
  predictAtlmRidge,
  predictAtlmV4Regression,
  predictHybridAtlm,
  selectAtlmIntervalEngine,
  selectHybridEngine,
  selectHybridEvaluationCases,
  selectHybridHistory,
  summarizeAtlmV4Metrics,
  summarizeHybridAtlmEvaluation,
  summarizeHybridCase,
  validateAssessmentValue,
};
