import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAtlmRidge, predictAtlmRidge, fitAtlmV4Preprocessor, encodeAtlmV4Features, normalizeAgentTask } from '../worker/index.js';
import { taskV4 } from './fixtures/tracker-db.mjs';

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
