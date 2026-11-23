import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAtlmRidge, predictAtlmRidge, fitAtlmV4Preprocessor, encodeAtlmV4Features, normalizeAgentTask } from '../worker/atlm/model.js';
import { OWNER, call, context, envelope, mcp, ok, plannedAtlm, rows, taskV4 } from './fixtures/tracker-db.mjs';

const base = normalizeAgentTask(taskV4()).features;
const make = (i, changes = {}) => ({ sampleId: `s${i}`, planId: `p${i}`, capturedAt: i * 10, sourceAvailableAt: i * 10 + 1,
  features: { ...base, ...changes }, actualMs: (i + 1) * 60000 });

test('model and effort categories use only values occurring at least three times', () => {
  const rows = ['known','known','known','rare',null].map((modelId, i) => make(i, { modelId }).features);
  const fit = fitAtlmV4Preprocessor(rows);
  assert.equal(fit.status, 'AVAILABLE'); assert.deepEqual(fit.manifest.openCategories.modelId, ['known']);
  assert.deepEqual(encodeAtlmV4Features({ ...base, modelId:'rare' }, fit.manifest).row,
    encodeAtlmV4Features({ ...base, modelId:'unseen' }, fit.manifest).row);
  assert.notDeepEqual(encodeAtlmV4Features({ ...base, modelId:null }, fit.manifest).row,
    encodeAtlmV4Features({ ...base, modelId:'unseen' }, fit.manifest).row);
});

test('all missing runtime values add no active columns and unseen values are accepted', async () => {
  const row = make(0, { modelId:null, reasoningEffort:null, plannedParallelAgents:1 });
  const fit = await fitAtlmRidge([row]); assert.equal(fit.status, 'AVAILABLE'); assert.equal(fit.artifact.p, 1);
  assert.equal(predictAtlmRidge(fit.artifact, { ...row.features, modelId:'unseen', reasoningEffort:'max', plannedParallelAgents:3 }).status, 'AVAILABLE');
});

test('fit rejects a missing required numeric runtime feature', () => {
  assert.equal(fitAtlmV4Preprocessor([make(0,{plannedParallelAgents:null}).features]).reason, 'INVALID_FEATURES');
});

test('unbounded learned categories fail with an explicit resource limit', () => {
  const features = Array.from({ length: 1800 }, (_, i) => make(i, { modelId:`model-${Math.floor(i / 3)}` }).features);
  const fit = fitAtlmV4Preprocessor(features);
  assert.equal(fit.reason, 'MODEL_CAPACITY_LIMIT'); assert.equal(fit.limit, 512);
});

test('runtime manifest rejects reordered columns and invalid category metadata', async () => {
  const input = Array.from({length: 8}, (_, i) => make(i, {modelId: i < 4 ? 'a' : 'b', plannedParallelAgents: i % 2 ? 1 : 2}));
  const fit = await fitAtlmRidge(input); assert.equal(fit.status, 'AVAILABLE');
  for (const change of [a => a.preprocessor.openCategories.modelId.push('x'.repeat(129)),
    a => a.preprocessor.imputations.plannedParallelAgents = -1,
    a => a.preprocessor.columns[0].center = -100,
    a => { [a.preprocessor.columns[0], a.preprocessor.columns[1]] = [a.preprocessor.columns[1], a.preprocessor.columns[0]]; }]) {
    const bad = structuredClone(fit.artifact); change(bad);
    assert.equal(predictAtlmRidge(bad, input[0].features).reason, 'INVALID_ARTIFACT');
  }
});

test('retired training tools, aliases and HTTP routes cannot read or change training state', async () => {
  const c = context();
  try {
    await plannedAtlm(c);
    const before = rows(c);
    const retired = [
      'GetTrainingStatus', 'StartTraining', 'ContinueTraining', 'GetTrainingData', 'GetTrainingHistory',
      'GetEstimationModelStatus', 'StartEstimationTraining', 'ProcessEstimationTraining',
      'GetAtlmDataset', 'GetEstimationTrainingHistory',
    ];
    const list = await call(c, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = list.value.result.tools.map(tool => tool.name);
    assert.ok(tools.includes('EstimatePlanTime'));
    assert.ok(tools.includes('GetSavedEstimate'));
    for (const name of retired) {
      assert.ok(!tools.includes(name), name);
      const response = await mcp(c, name);
      assert.equal(response.value.result.structuredContent.code, 'FEATURE_REMOVED', name);
    }
    for (const [method, path] of [
      ['GET', 'estimation-model'], ['POST', 'estimation-model/start'], ['POST', 'estimation-model/process'],
      ['GET', 'estimation-training-history'], ['POST', 'atlm-dataset'],
    ]) {
      const response = await call(c, '/api/tracker/' + path, method === 'POST' ? {} : undefined, OWNER, method);
      assert.equal(response.status, 404, path);
      assert.equal(response.value.error.code, 'NOT_FOUND', path);
    }
    assert.deepEqual(rows(c), before);
  } finally {
    c.close();
  }
});

test('HTTP and MCP Finish refresh experience once each without fitting or activating a model', async () => {
  const c = context();
  const tasks = [];
  const ctx = { waitUntil(task) { tasks.push(task); } };
  async function request(path, body) {
    const response = await c.worker.fetch(new Request('http://localhost' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': OWNER },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { DB: c.db }, ctx);
    assert.equal(response.status, 200);
    return response.json();
  }
  try {
    for (const path of ['/api/commands', '/mcp']) {
      const plan = await plannedAtlm(c, crypto.randomUUID());
      await ok(c, 'StartPlan', { planId: plan.planId }, 0);
      c.advance(1000);
      await ok(c, 'SetStepStatus', { stepId: plan.step.stepId, status: 'DONE' }, 1);
      const finish = envelope('FinishPlan', { planId: plan.planId }, 1);
      const { commandType, ...args } = finish;
      const body = path === '/mcp'
        ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: commandType, arguments: args } }
        : finish;
      const applied = await request(path, body);
      assert.equal(path === '/mcp' ? applied.result.structuredContent.result.status : applied.result.status, 'COMPLETED');
      assert.equal(tasks.length, 1);
      await tasks.pop();
      const before = rows(c);
      const replay = await request(path, body);
      assert.equal(path === '/mcp' ? replay.result.structuredContent.replayed : replay.replayed, true);
      const estimate = await request(`/api/tracker/plans/${plan.planId}/estimate`);
      assert.equal(estimate.source, 'FROZEN_INPUT');
      assert.equal(tasks.length, 0);
      assert.deepEqual(rows(c), before);
    }
    const db = c.db.sqlite;
    assert.equal(db.prepare("SELECT count(*) n FROM estimation_samples WHERE eligibility='ELIGIBLE'").get().n, 2);
    assert.equal(db.prepare("SELECT count(*) n FROM estimation_jobs WHERE status='IDLE' AND generation=processed_generation").get().n, 2);
    for (const table of ['estimation_model_revisions', 'estimation_model_activations', 'estimation_training_attempts']) {
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table);
    }
    assert.equal(db.prepare("SELECT count(*) n FROM estimation_jobs WHERE kind='TRAIN'").get().n, 0);
  } finally {
    await Promise.allSettled(tasks);
    c.close();
  }
});
