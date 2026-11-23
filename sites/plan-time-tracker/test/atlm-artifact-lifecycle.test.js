import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { fitAtlm, normalizeAgentTask } from '../worker/atlm/model.js';
import { context, call, ok, mcp, plannedAtlm, completeAtlm, atlmAssessment, taskV4, OWNER, PLAN } from './fixtures/tracker-db.mjs';

const workerPath = process.env.SITE_WORKER_MODULE || new URL('../dist/server/index.js', import.meta.url).pathname;

async function useBuiltWorker(c, selector) {
  const built = await import(pathToFileURL(resolve(workerPath)).href + '?' + selector);
  const runtime = built.createWorker(c.now);
  const tasks = [];
  let scheduled = 0;
  c.worker = { async fetch(request, env) {
    const response = await runtime.fetch(request, env, { waitUntil(promise) {
      scheduled++;
      tasks.push(Promise.resolve(promise));
    } });
    for (let pass = 0; tasks.length; pass++) {
      assert.ok(pass < 50, 'background work finishes within bounded passes');
      await Promise.all(tasks.splice(0));
    }
    return response;
  } };
  return { scheduled: () => scheduled };
}

async function tool(c, name, args) {
  const response = await mcp(c, name, args);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  assert.equal(response.value.result?.isError, undefined, JSON.stringify(response.value));
  assert.ok(response.value.result?.structuredContent);
  return response.value.result.structuredContent;
}

async function completeTrainingExample(c, planId, task, duration) {
  const plan = await plannedAtlm(c, planId, task);
  const start = c.now();
  await completeAtlm(c, plan, duration);
  const sample = c.db.sqlite.prepare('SELECT max(sequence) AS sequence FROM estimation_samples WHERE owner_id=? AND plan_id=?')
    .get(OWNER, planId);
  const example = { planId, sampleId: String(sample.sequence), capturedAt: start, sourceAvailableAt: c.now(),
    features: normalizeAgentTask(task).features, actualMs: duration };
  c.advance(1);
  return example;
}

async function registerFixtureAndActivate(c, { modelRevisionId, modelVersion, examples, expectedActiveModelRevisionId = null,
  expectedActivationVersion = 0 }) {
  const fitted = await fitAtlm(examples);
  assert.equal(fitted.status, 'AVAILABLE', JSON.stringify(fitted));
  const artifact = fitted.artifact;
  const db = c.db.sqlite;
  db.prepare(`INSERT INTO estimation_model_revisions(owner_id,model_revision_id,model_version,origin,
    method_version,feature_version,registered_at,imported_at,artifact_json,manifest_json,dataset_digest,provenance_json,
    fit_count,source_count,train_cutoff,supported) VALUES(?,?,?,'IMPORTED',?,?,?,?,?,?,?,'{}',?,?,?,1)`)
    .run(OWNER, modelRevisionId, modelVersion, artifact.method.version, artifact.featureSchemaVersion, c.now(),
      c.now(), JSON.stringify(artifact), JSON.stringify(artifact.manifest), artifact.datasetDigest, artifact.n, examples.length,
      artifact.trainCutoff);
  const source = db.prepare(`INSERT INTO estimation_model_revision_sources(owner_id,model_revision_id,plan_id,source_generation,ordinal)
    SELECT owner_id,?,plan_id,generation,? FROM estimation_jobs WHERE owner_id=? AND plan_id=?`);
  for (const [index, example] of examples.entries()) source.run(modelRevisionId, index, OWNER, example.planId);
  const activation = await tool(c, 'ActivateModelRevision', { schemaVersion: 1, commandId: crypto.randomUUID(),
    modelRevisionId, expectedActiveModelRevisionId, expectedActivationVersion, reason: 'Synthetic packaged Worker fixture',
    acceptExperimental: true });
  assert.equal(activation.activeModelRevisionId, modelRevisionId);
  assert.equal(activation.activationVersion, expectedActivationVersion + 1);
  return artifact;
}

const registry = c => tool(c, 'ListModelRevisions', { schemaVersion: 1, view: 'list' });
const estimate = (c, planId) => tool(c, 'GetSavedEstimate', { planId });

test('packaged Worker accumulates samples, requires explicit activation and preserves the first-start forecast', async () => {
  const c = context();
  try {
    const background = await useBuiltWorker(c, 'atlm-public-lifecycle');
    const before = await registry(c);
    assert.equal(before.activeRevision, null);
    assert.equal(before.dataSummary.currentEligibleCount, 0);

    const examples = [];
    for (let i = 0; i < 10; i++)
      examples.push(await completeTrainingExample(c, i === 0 ? PLAN : crypto.randomUUID(), taskV4(), 1000));
    const accumulated = await registry(c);
    assert.equal(accumulated.dataSummary.currentEligibleCount, 10);
    assert.equal(accumulated.activeRevision, null);
    assert.deepEqual(accumulated.rows, []);
    assert.equal(c.db.sqlite.prepare("SELECT count(*) AS n FROM estimation_jobs WHERE kind='TRAIN'").get().n, 0);
    assert.equal(c.db.sqlite.prepare('SELECT count(*) AS n FROM estimation_model_activations').get().n, 0);
    const scheduled = background.scheduled();
    assert.ok(scheduled > 0);
    const historical = await estimate(c, PLAN);
    assert.equal(historical.serverEstimation.status, 'UNAVAILABLE');
    assert.equal(background.scheduled(), scheduled);

    const firstId = 'atlm-packaged-r1';
    const secondId = 'atlm-packaged-r2';
    await registerFixtureAndActivate(c, { modelRevisionId: firstId, modelVersion: 1, examples });
    const target = await plannedAtlm(c, crypto.randomUUID());
    const issued = await estimate(c, target.planId);
    assert.equal(issued.serverEstimation.modelRevisionId, firstId);
    assert.equal(issued.serverEstimation.pointMs, 1000);
    assert.equal(issued.serverEstimation.interval.status, 'AVAILABLE');
    await completeAtlm(c, target, 2000);
    const firstForecast = (await estimate(c, target.planId)).serverEstimation;
    assert.deepEqual(firstForecast, issued.serverEstimation);

    await registerFixtureAndActivate(c, { modelRevisionId: secondId, modelVersion: 2, examples,
      expectedActiveModelRevisionId: firstId, expectedActivationVersion: 1 });
    const next = await plannedAtlm(c, crypto.randomUUID());
    assert.equal((await estimate(c, next.planId)).serverEstimation.modelRevisionId, secondId);
    const frozen = await estimate(c, target.planId);
    assert.deepEqual(frozen.serverEstimation, firstForecast);
    const status = await registry(c);
    assert.equal(status.dataSummary.currentEligibleCount, 11);
    assert.equal(status.dataSummary.newEligibleCount, 1);
    assert.equal(status.activationVersion, 2);
    const http = await call(c, '/api/tracker/plans/' + target.planId + '/estimate');
    assert.equal(http.status, 200);
    assert.deepEqual(http.value, frozen);
    assert.deepEqual(c.db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { c.close(); }
});

function runtimeTask(modelId, reasoningEffort, plannedParallelAgents) {
  const task = taskV4();
  const fields = { modelId, reasoningEffort, plannedParallelAgents };
  Object.assign(task.execution, fields);
  for (const [field, value] of Object.entries(fields)) {
    const path = 'execution.' + field;
    if (value === null) {
      delete task.evidence[path];
      task.unknownReasons[path] = { reason: 'Metadata not disclosed', checkedSource: 'Runner metadata' };
    } else {
      task.evidence[path] = 'Fixture';
      delete task.unknownReasons[path];
    }
  }
  return task;
}

test('packaged forecast uses registered runtime features and accepts explicit unknowns', async () => {
  const c = context();
  try {
    await useBuiltWorker(c, 'atlm-runtime-features');
    const examples = [];
    for (const model of ['a', 'b']) for (const effort of ['low', 'high']) for (const count of [1, 2]) {
      const duration = 60_000 * (10 + (model === 'b' ? 10 : 0) + (effort === 'high' ? 6 : 0) + 2 * count);
      examples.push(await completeTrainingExample(c, crypto.randomUUID(), runtimeTask(model, effort, count), duration));
    }
    const artifact = await registerFixtureAndActivate(c, { modelRevisionId: 'atlm-runtime-fixture', modelVersion: 1, examples });
    const knownTask = runtimeTask('b', 'high', 2);
    const target = await plannedAtlm(c, crypto.randomUUID(), knownTask);
    const { currentRequirementsDigest } = await tool(c, 'GetTaskAssessment', { planId: target.planId });
    const args = { planId: target.planId, expectedRequirementsDigest: currentRequirementsDigest };
    const known = await tool(c, 'EstimatePlanTime', { ...args, agentTask: knownTask });
    assert.equal(known.hybrid.usedEngine, 'RIDGE');
    assert.ok(known.pointMs > 0);
    const unknownTask = runtimeTask(null, null, 1);
    const unknown = await tool(c, 'EstimatePlanTime', { ...args, agentTask: unknownTask });
    assert.ok(unknown.pointMs > 0);
    const saved = await atlmAssessment(c, target.planId, unknownTask, { predictionRequest: { method: 'ATLM', methodVersion: 1 } });
    await ok(c, 'RecordAssessment', saved, 0);
    assert.equal((await estimate(c, target.planId)).serverEstimation.pointMs, unknown.pointMs);
    const selected = artifact.candidates[artifact.selectedEngine.toLowerCase()].artifact;
    for (const field of ['modelId', 'reasoningEffort', 'plannedParallelAgents'])
      assert.ok(selected.preprocessor.columns.some(column => column.field === field), field);
  } finally { c.close(); }
});
