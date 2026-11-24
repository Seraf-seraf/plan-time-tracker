import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { atlmArtifactValid, normalizeAgentTask, predictAtlm } from '../worker/atlm/model.js';
import { mergeAtlmTeacherAnnotations } from '../worker/atlm/teacher-dataset.js';
import { canonical, hashCommandInput } from '../worker/shared/index.js';
import { teacherAnnotation, teacherSource } from './fixtures/atlm-revisions.mjs';

const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATASET_REVISION_ID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const PLAN_ID = (index) => 'p-' + String(20 - index).padStart(2, '0');
const ROW_ID = (index) => 'r-' + String(index).padStart(2, '0');
const FIT_IDS = ['r-00', 'r-01', 'r-02', 'r-03', 'r-04', 'r-05', 'r-06', 'r-07', 'r-08', 'r-09'];
const HOLDOUT_IDS = ['r-12', 'r-13', 'r-14', 'r-15', 'r-16', 'r-17'];

function sha256(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

function issuedForecast(source, pointMs, calculatedAt = source.firstStartedAt) {
  return {
    status: 'AVAILABLE', pointMs, calculatedAt, pointEngine: 'RIDGE',
    modelId: 'issued-model', modelRevisionId: 'issued-model', modelVersion: 11,
    interval: {
      status: 'AVAILABLE', lowerMs: 0, upperMs: pointMs + 20,
      nominalCoverage: 0.8, engine: 'BAYESIAN_PREDICTIVE', calibrationSampleCount: 0,
      validationStatus: 'EXPERIMENTAL', unavailableReason: null,
    },
  };
}

function datasetFixture({ changedHoldout = false, fullFit = false } = {}) {
  const snapshot = [], decisions = [];
  for (let index = 0; index < (fullFit ? 77 : 18); index++) {
    const group = Math.floor(index / 2);
    const rowId = ROW_ID(index), planId = PLAN_ID(index);
    const decision = teacherAnnotation(rowId, 'g-' + group);
    const reuseLevel = index % 4;
    decision.annotation.agentTask.reuseLevel = reuseLevel;
    if (changedHoldout && group >= 6) {
      decision.annotation.agentTask.reuseLevel = 3 - reuseLevel;
      decision.annotation.agentTask.execution.modelId = 'only-in-holdout';
      delete decision.annotation.agentTask.unknownReasons['execution.modelId'];
      decision.annotation.agentTask.evidence['execution.modelId'] = 'Execution log recorded this model';
    }
    const source = teacherSource(planId, index + 1);
    source.firstStartedAt = group * 4_000_000 + (index % 2) * 1_100_000;
    source.finishedAt = source.firstStartedAt + 500_000;
    source.sourceAvailableAt = source.finishedAt;
    source.actualMs = 60_000 * (2 ** reuseLevel - 1) + (changedHoldout && group >= 6 ? 40_000 : 0);
    source.capturedAt = source.finishedAt;
    source.scopeChanged = false;
    source.plannedFeatures = normalizeAgentTask({ ...decision.annotation.agentTask, reuseLevel: 2 }).features;
    source.issuedPrediction = issuedForecast(source, source.actualMs + 10);
    if (index === 5) source.sourceAvailableAt = 16_000_000;
    if (index === 11) source.sourceAvailableAt = 24_000_000;
    if (index === 12) source.issuedPrediction = issuedForecast(source, 0);
    if (index === 13) source.scopeChanged = true;
    if (index === 14) source.scopeChanged = null;
    if (index === 15) {
      source.plannedFeatures = null;
      source.issuedPrediction = null;
    }
    if (index === 16) source.issuedPrediction = { status: 'UNAVAILABLE', unavailableReason: 'COLLECTING_DATA' };
    if (index === 17) source.issuedPrediction = issuedForecast(source, 150_000, source.firstStartedAt + 1);
    if (fullFit) {
      decision.groupId = null;
      decision.annotation.historicalAvailability = {
        availableAt: index === 1 ? null : index === 2 ? 8_000_000 : source.sourceAvailableAt,
        evidence: 'Synthetic journal timestamps for measured and reconstructed fields',
      };
      if (index === 4) source.firstStartedAt = 5_100_000;
    }
    snapshot.push({ rowId, planId, source, rawReasons: [] });
    decisions.push(decision);
  }
  snapshot.push({
    rowId: 'excluded', planId: 'excluded-plan', rawReasons: ['INCOMPLETE_MEASUREMENT'],
    source: {
      ...teacherSource('excluded-plan'), status: 'UNAVAILABLE', actualMs: null,
      firstStartedAt: null, finishedAt: null, sourceAvailableAt: null,
    },
  });
  decisions.push({
    rowId: 'excluded', groupId: null, eligibility: 'EXCLUDED',
    reasons: ['INCOMPLETE_MEASUREMENT'], annotation: null,
  });
  return {
    schemaVersion: 1, contract: 'atlm-teacher-dataset',
    datasetRevisionId: DATASET_REVISION_ID, snapshotId: SNAPSHOT_ID, parentDatasetRevisionId: null,
    featureSchemaVersion: 'agent-task-v4', rows: mergeAtlmTeacherAnnotations(snapshot, decisions),
  };
}

function temporary(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'atlm-local-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function inputFiles(directory, name, dataset, changes = {}) {
  const datasetPath = path.join(directory, name + '.dataset.json');
  const recipePath = path.join(directory, name + '.recipe.json');
  const bytes = JSON.stringify(dataset, null, 2) + '\n';
  const recipe = {
    schemaVersion: 1,
    recipeId: 'atlm-teacher-hybrid-v1',
    datasetRevisionId: dataset.datasetRevisionId,
    datasetDigest: sha256(bytes),
    selection: { mode: 'ALL_ELIGIBLE' },
    holdoutUse: 'UNKNOWN',
    holdoutUseNote: 'История предыдущего просмотра неизвестна.',
    ...changes,
  };
  if (recipe.recipeId === 'atlm-teacher-hybrid-v2') {
    delete recipe.holdoutUse;
    delete recipe.holdoutUseNote;
  }
  writeFileSync(datasetPath, bytes);
  writeFileSync(recipePath, JSON.stringify(recipe));
  return { datasetPath, recipePath, recipe };
}

function command(files, outputDir) {
  return [
    'scripts/train-atlm.mjs', '--dataset', files.datasetPath, '--recipe', files.recipePath,
    '--out', outputDir,
  ];
}

function run(files, outputDir, expectedCode) {
  const result = spawnSync(process.execPath, command(files, outputDir), {
    cwd: SITE_ROOT, encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, expectedCode, result.stderr);
  const { stdout } = result;
  assert.equal(stdout.trim().split('\n').length, 1);
  return { result: JSON.parse(stdout), progress: result.stderr.trim().split('\n').map(JSON.parse) };
}

function readJson(directory, filename) {
  return JSON.parse(readFileSync(path.join(directory, filename), 'utf8'));
}

test('v2 fits all 77 eligible plans and evaluates only the available actual history per plan', async (t) => {
  const directory = temporary(t);
  const dataset = datasetFixture({ fullFit: true });
  const files = inputFiles(directory, 'training', dataset, {
    recipeId: 'atlm-teacher-hybrid-v2', backtestUse: 'UNKNOWN',
    backtestUseNote: 'Synthetic history has no prior decision record.',
  });
  const outputDir = path.join(directory, 'run');
  const { progress } = run(files, outputDir, 0);
  assert.equal(progress.find(({ stage }) => stage === 'ROSTER').fitCount, 77);
  const { artifact, evaluation, provenance } = readJson(outputDir, 'registration.bundle.json');
  const expected = dataset.rows.filter(({ eligibility }) => eligibility === 'ELIGIBLE').map(({ rowId }) => rowId);
  assert.equal(artifact.n, 77);
  assert.deepEqual(provenance.fitRowIds, expected);
  assert.deepEqual(provenance.selectedRowIds, expected);
  assert.deepEqual(new Set(artifact.manifest.map(({ sampleId }) => sampleId)), new Set(expected));
  assert.equal(provenance.trainerVersion, 2);
  assert.equal(provenance.recipeDigest, 'sha256:' + await hashCommandInput(files.recipe));
  assert.equal(evaluation.protocolVersion, 2);
  const { ROLLING_PLAN_ACTUAL: actual, ROLLING_PLAN_PLANNED: planned, ISSUED_FORECASTS: issued } = evaluation.modes;
  assert.equal(actual.cases.length, 77);
  assert.equal(issued.cases.length, 77);
  assert.deepEqual(actual.cases.map(({ trainDigest }) => trainDigest), planned.cases.map(({ trainDigest }) => trainDigest));
  assert.equal(actual.cases[0].pointStatus, 'UNAVAILABLE');
  assert.equal(actual.cases[1].pointEngine, 'MEDIAN');
  assert.equal(actual.cases[2].trainRowCount, 1);
  assert.equal(actual.cases[3].trainRowCount, 1);
  assert.equal(actual.cases[4].trainDigest, actual.cases[3].trainDigest);
  assert.equal(evaluation.rowDecisions[1].historicalAvailableAt, null);
  assert.equal(evaluation.rowDecisions[2].historicalAvailableAt, 8_000_000);
  assert.equal(planned.cases[13].scoringExclusionReason, 'SCOPE_CHANGED');
  assert.equal(planned.cases[14].scoringExclusionReason, 'SCOPE_CHANGE_UNKNOWN');
  assert.equal(planned.cases[15].scoringExclusionReason, 'PLANNED_FEATURES_UNAVAILABLE');
  assert(planned.cases.some((item, index) => item.pointStatus === 'AVAILABLE'
    && actual.cases[index].pointStatus === 'AVAILABLE' && item.pointMs !== actual.cases[index].pointMs));
  assert.equal(planned.paired.candidate.caseCount, planned.paired.median.caseCount);
  assert.equal(Object.hasOwn(planned.paired, 'groupCount'), false);
});

test('CLI freezes grouped development and holdout, evaluates separate feature bases and preserves the bundle', (t) => {
  const directory = temporary(t);
  const dataset = datasetFixture();
  const files = inputFiles(directory, 'training', dataset);
  const outputDir = path.join(directory, 'run');
  const { result, progress } = run(files, outputDir, 0);
  assert.deepEqual(result, {
    status: 'READY', reason: null, outputDir, registrationPath: path.join(outputDir, 'registration.bundle.json'),
  });
  assert.deepEqual(progress.map(({ stage }) => stage), ['VALIDATED', 'SPLIT', 'REPLAY', 'FIT', 'SAVED']);
  const artifact = readJson(outputDir, 'artifact.json');
  const evaluation = readJson(outputDir, 'evaluation.json');
  const { provenance } = readJson(outputDir, 'manifest.json');
  const bundle = readJson(outputDir, 'registration.bundle.json');
  const savedRun = readJson(outputDir, 'run.json');
  assert.equal(bundle.contract, 'atlm-model-revision');
  assert.equal(bundle.datasetRevisionId, DATASET_REVISION_ID);
  assert.equal(bundle.datasetDigest, files.recipe.datasetDigest);
  assert.notEqual(artifact.datasetDigest, bundle.datasetDigest);
  assert.deepEqual(bundle.artifact, artifact);
  assert.deepEqual(bundle.evaluation, evaluation);
  assert.deepEqual(bundle.provenance, provenance);
  assert.deepEqual(provenance.configuration, files.recipe);
  assert.equal(provenance.holdoutUse, 'UNKNOWN');
  assert.equal(provenance.holdoutUseNote, files.recipe.holdoutUseNote);
  assert.equal(evaluation.split.holdoutUse, 'UNKNOWN');
  assert.equal(evaluation.split.holdoutUseNote, files.recipe.holdoutUseNote);
  assert.equal(savedRun.input.recipeDigest, sha256(readFileSync(files.recipePath)));
  assert.equal(savedRun.input.codeDigest, provenance.codeRef.digest);
  assert.deepEqual(provenance.codeRef.files.map(({ path: relativePath }) => relativePath), [
    'scripts/train-atlm.mjs', 'worker/atlm/model.js', 'worker/atlm/teacher-dataset.js', 'worker/shared/index.js',
  ]);
  for (const { path: relativePath, sha256: digest } of provenance.codeRef.files) {
    assert.equal(digest, sha256(readFileSync(path.join(SITE_ROOT, relativePath))));
  }
  for (const [filename, digest] of Object.entries(savedRun.files)) {
    assert.equal(digest, sha256(readFileSync(path.join(outputDir, filename))));
  }
  assert.deepEqual(provenance.selectedRowIds, dataset.rows.slice(0, 18).map((row) => row.rowId));
  assert.deepEqual(provenance.fitRowIds, FIT_IDS);
  assert.deepEqual(provenance.holdoutRowIds, HOLDOUT_IDS);
  assert.deepEqual(provenance.purgedRowIds, ['r-10', 'r-11']);
  assert.equal(artifact.n, 10);
  assert.equal(artifact.trainCutoff, 17_600_000);
  assert.equal(evaluation.split.holdoutCutoff, 24_000_000);
  assert.deepEqual(artifact.manifest, FIT_IDS.map((sampleId, index) => ({
    sampleId, planId: PLAN_ID(index),
  })).reverse());
  assert.equal(atlmArtifactValid(artifact), true);
  assert.deepEqual(evaluation.rowDecisions.map(({ rowId }) => rowId), dataset.rows.map(({ rowId }) => rowId));
  assert.deepEqual(evaluation.rowDecisions.at(-1), {
    rowId: 'excluded', planId: 'excluded-plan', groupId: null, eligibility: 'EXCLUDED',
    role: 'EXCLUDED', reasons: ['INCOMPLETE_MEASUREMENT'],
  });
  const { ROLLING_GROUPED_ACTUAL: rolling, INTERNAL_HOLDOUT_ACTUAL: actual,
    INTERNAL_HOLDOUT_PLANNED: planned, ISSUED_FORECASTS: issued } = evaluation.modes;
  assert.deepEqual(rolling.cases.map(({ trainRowCount }) => trainRowCount), [0, 0, 2, 2, 4, 4, 4, 4, 6, 6]);
  assert.deepEqual(rolling.cases.slice(0, 2).map(({ pointStatus }) => pointStatus), ['UNAVAILABLE', 'UNAVAILABLE']);
  assert.equal(rolling.cases[6].trainDigest, rolling.cases[7].trainDigest);
  assert.equal(rolling.cases[6].trainDigest, rolling.cases[4].trainDigest);
  assert.equal(rolling.cases[6].medianPointMs, 120_000);
  const latestFold = [7, 6, 3, 2, 1, 0].map((index) => {
    const row = dataset.rows[index];
    return {
      sampleId: row.rowId, planId: row.planId, capturedAt: row.source.firstStartedAt,
      sourceAvailableAt: row.source.sourceAvailableAt, features: row.features, actualMs: row.source.actualMs,
    };
  });
  assert.equal(rolling.cases[8].trainDigest, sha256(canonical(latestFold)));
  assert(artifact.selection.caseIds.every((planId) => artifact.manifest.some((row) => row.planId === planId)));
  assert(savedRun.diagnostics.calibration.sampleCount > 0);
  assert.deepEqual(actual.cases.map(({ rowId }) => rowId), HOLDOUT_IDS);
  for (const rowCase of actual.cases) {
    const row = dataset.rows.find(({ rowId }) => rowId === rowCase.rowId);
    assert.equal(rowCase.pointMs, predictAtlm(artifact, row.features).pointMs);
    assert.equal(rowCase.trainDigest, artifact.datasetDigest);
  }
  assert.equal(actual.cases[0].actualMs, 0);
  assert.notEqual(planned.cases[0].pointMs, actual.cases[0].pointMs);
  assert.deepEqual(planned.cases.map(({ scoringExclusionReason }) => scoringExclusionReason), [
    null, 'SCOPE_CHANGED', 'SCOPE_CHANGE_UNKNOWN', 'PLANNED_FEATURES_UNAVAILABLE', null, null,
  ]);
  assert.deepEqual(planned.summary.forecastAvailability, { numerator: 3, denominator: 6 });
  assert.deepEqual(planned.paired.rowIds, ['r-12', 'r-16', 'r-17']);
  assert.equal(planned.paired.groupCount, 2);
  assert.equal(planned.paired.candidate.caseCount, planned.paired.median.caseCount);
  assert.equal(issued.cases.length, 18);
  assert(issued.cases.some(({ rowId }) => rowId === 'r-10'));
  assert.equal(issued.cases[12].pointMs, 0);
  assert.equal(issued.cases[12].signedErrorMs, 0);
  assert.equal(issued.cases[12].issuedModelRevision, 'issued-model');
  assert.equal(issued.cases[15].pointUnavailableReason, 'ISSUED_FORECAST_NOT_RECORDED');
  assert.equal(issued.cases[16].pointUnavailableReason, 'COLLECTING_DATA');
  assert.equal(issued.cases[17].scoringExclusionReason, 'ISSUED_TIME_UNVERIFIED');
  assert.equal(issued.cases[17].signedErrorMs, null);
  assert.deepEqual(issued.summary.forecastAvailability, { numerator: 16, denominator: 18 });
  assert.equal(issued.summary.metrics.caseCount, 15);
  assert.equal(issued.median, null);
  assert.equal(issued.paired, null);
});

test('holdout facts, feature values and new categories cannot affect development fitting or selection', (t) => {
  const directory = temporary(t);
  const first = inputFiles(directory, 'first', datasetFixture());
  const second = inputFiles(directory, 'second', datasetFixture({ changedHoldout: true }), {
    holdoutUse: 'REUSED_AFTER_REVIEW', holdoutUseNote: 'Оценка тех же групп уже была просмотрена.',
  });
  const firstDir = path.join(directory, 'first');
  const secondDir = path.join(directory, 'second');
  run(first, firstDir, 0);
  run(second, secondDir, 0);
  assert.deepEqual(readJson(firstDir, 'artifact.json'), readJson(secondDir, 'artifact.json'));
  assert.equal(readFileSync(path.join(firstDir, 'artifact.json'), 'utf8').includes('only-in-holdout'), false);
  const before = readJson(firstDir, 'evaluation.json');
  const after = readJson(secondDir, 'evaluation.json');
  assert.deepEqual(before.modes.ROLLING_GROUPED_ACTUAL, after.modes.ROLLING_GROUPED_ACTUAL);
  assert.notEqual(
    before.modes.INTERNAL_HOLDOUT_ACTUAL.summary.metrics.maeMs,
    after.modes.INTERNAL_HOLDOUT_ACTUAL.summary.metrics.maeMs,
  );
  assert.equal(after.split.holdoutUse, 'REUSED_AFTER_REVIEW');
  assert.equal(after.split.holdoutUseNote, second.recipe.holdoutUseNote);
  assert.equal(readJson(secondDir, 'manifest.json').provenance.holdoutUse, 'REUSED_AFTER_REVIEW');
  assert.equal(readJson(secondDir, 'manifest.json').provenance.holdoutUseNote, second.recipe.holdoutUseNote);
});

test('explicit selections reject malformed rosters and bytes and retain all excluded row decisions', (t) => {
  const directory = temporary(t);
  const dataset = datasetFixture();
  const cases = [
    { changes: { selection: { mode: 'EXPLICIT', rowIds: ['r-00'] } },
      reason: 'PARTIAL_SELECTED_GROUP', rowId: 'r-01' },
    { changes: { selection: { mode: 'EXPLICIT', rowIds: ['r-00', 'r-00'] } },
      reason: 'DUPLICATE_SELECTED_ROW', rowId: 'r-00' },
    { changes: { selection: { mode: 'EXPLICIT', rowIds: ['excluded'] } },
      reason: 'SELECTED_ROW_INELIGIBLE', rowId: 'excluded' },
    { changes: { selection: { mode: 'EXPLICIT', rowIds: ['unknown-row'] } },
      reason: 'SELECTED_ROW_UNKNOWN', rowId: 'unknown-row' },
    { changes: { datasetDigest: 'sha256:' + 'a'.repeat(64) }, reason: 'DATASET_DIGEST_MISMATCH' },
    { changes: { holdoutUseNote: '' }, reason: 'INVALID_RECIPE' },
  ];
  for (const [index, { changes, reason, rowId }] of cases.entries()) {
    const files = inputFiles(directory, 'invalid-' + index, dataset, changes);
    const outputDir = path.join(directory, 'invalid-' + index);
    const { result, progress } = run(files, outputDir, 1);
    assert.equal(result.reason, reason);
    assert.equal(result.registrationPath, null);
    if (rowId) assert.equal(progress.at(-1).rowId, rowId);
    assert.equal(existsSync(outputDir), false);
  }
  const altered = inputFiles(directory, 'altered-bytes', dataset);
  writeFileSync(altered.datasetPath, JSON.stringify(dataset));
  assert.equal(run(altered, path.join(directory, 'altered-bytes'), 1).result.reason,
    'DATASET_DIGEST_MISMATCH');
  const historical = inputFiles(directory, 'imported', { ...dataset, origin: 'IMPORTED' });
  assert.equal(run(historical, path.join(directory, 'imported'), 1).result.reason,
    'HISTORICAL_PROVENANCE_INCOMPLETE');

  const selectedIds = ['r-00', 'r-01', 'r-02', 'r-03'];
  const subset = inputFiles(directory, 'subset', dataset, {
    selection: { mode: 'EXPLICIT', rowIds: selectedIds.slice().reverse() },
  });
  const outputDir = path.join(directory, 'subset');
  run(subset, outputDir, 0);
  const evaluation = readJson(outputDir, 'evaluation.json');
  const { provenance } = readJson(outputDir, 'manifest.json');
  assert.equal(evaluation.split.holdoutStatus, 'UNAVAILABLE');
  assert.equal(evaluation.split.holdoutReason, 'TOO_FEW_HOLDOUT_GROUPS_OR_ROWS');
  assert.equal(evaluation.modes.INTERNAL_HOLDOUT_ACTUAL.summary.metrics, null);
  assert.deepEqual(provenance.selectedRowIds, selectedIds);
  assert.deepEqual(provenance.fitRowIds, selectedIds);
  assert.deepEqual(provenance.purgedRowIds, []);
  assert.deepEqual(provenance.holdoutRowIds, []);
  assert.deepEqual(evaluation.rowDecisions[4].reasons, ['OUTSIDE_SELECTED_SUBSET']);
});

test('insufficient development or fit emits the appropriate report without expanding the selection', (t) => {
  const directory = temporary(t);
  const dataset = datasetFixture();
  const sixRows = dataset.rows.slice(0, 6).map(({ rowId }) => rowId);
  const limited = inputFiles(directory, 'limited-development', dataset, {
    selection: { mode: 'EXPLICIT', rowIds: sixRows },
  });
  const limitedDir = path.join(directory, 'limited-development');
  run(limited, limitedDir, 0);
  const split = readJson(limitedDir, 'evaluation.json').split;
  assert.equal(split.holdoutReason, 'TOO_FEW_DEVELOPMENT_GROUPS_OR_ROWS');
  assert.equal(split.holdoutCutoff, null);
  assert(split.groups.every(({ role }) => role === 'FIT'));

  const oneRow = { ...dataset, rows: [dataset.rows[0], dataset.rows.at(-1)] };
  const files = inputFiles(directory, 'insufficient-solver', oneRow);
  const outputDir = path.join(directory, 'insufficient-solver');
  const { result } = run(files, outputDir, 2);
  assert.equal(result.reason, 'INSUFFICIENT_DATA');
  assert.equal(result.registrationPath, null);
  assert.deepEqual(readdirSync(outputDir).sort(), ['evaluation.json', 'manifest.json', 'run.json']);
  assert.deepEqual(readJson(outputDir, 'manifest.json').provenance.fitRowIds, ['r-00']);
  const evaluation = readJson(outputDir, 'evaluation.json');
  assert.equal(evaluation.modes.ROLLING_GROUPED_ACTUAL.cases[0].actualMs, 0);
  assert.equal(evaluation.modes.ROLLING_GROUPED_ACTUAL.cases[0].pointMs, null);
});

test('CLI repeats deterministically and preserves paths with incomplete, conflicting or corrupt runs', (t) => {
  const directory = temporary(t);
  const files = inputFiles(directory, 'training', datasetFixture());
  const outputDir = path.join(directory, 'run');
  const duplicateDir = path.join(directory, 'duplicate-run');
  const first = run(files, outputDir, 0);
  const repeat = run(files, outputDir, 0);
  assert.deepEqual(repeat.result, first.result);
  assert.deepEqual(repeat.progress.map(({ stage }) => stage), ['REUSED']);
  run(files, duplicateDir, 0);
  for (const name of readdirSync(outputDir)) {
    assert.deepEqual(readFileSync(path.join(duplicateDir, name)), readFileSync(path.join(outputDir, name)));
  }
  const changed = inputFiles(directory, 'changed-recipe', datasetFixture(), {
    holdoutUse: 'FIRST_REPORTED', holdoutUseNote: 'Отложенные группы впервые включены в отчёт.',
  });
  assert.equal(run(changed, outputDir, 1).result.reason, 'OUTPUT_DIR_CONFLICT');
  const runBefore = readFileSync(path.join(outputDir, 'run.json'));
  writeFileSync(path.join(outputDir, 'evaluation.json'), 'corrupt');
  assert.equal(run(files, outputDir, 1).result.reason, 'OUTPUT_DIR_CONFLICT');
  assert.deepEqual(readFileSync(path.join(outputDir, 'run.json')), runBefore);
  assert.equal(readFileSync(path.join(outputDir, 'evaluation.json'), 'utf8'), 'corrupt');
  const emptyDir = path.join(directory, 'existing-empty');
  mkdirSync(emptyDir);
  assert.equal(run(files, emptyDir, 1).result.reason, 'OUTPUT_DIR_CONFLICT');
  assert.deepEqual(readdirSync(emptyDir), []);
});

test('concurrent identical CLI runs publish one complete result', async (t) => {
  const directory = temporary(t);
  const files = inputFiles(directory, 'training', datasetFixture());
  const outputDir = path.join(directory, 'run');
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, command(files, outputDir), { cwd: SITE_ROOT });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const [first, second] = await Promise.all([launch(), launch()]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(first.stdout), JSON.parse(second.stdout));
  assert.equal(run(files, outputDir, 0).progress[0].stage, 'REUSED');
  assert.equal(readdirSync(directory).some((name) => name.startsWith('.run-')), false);
});
