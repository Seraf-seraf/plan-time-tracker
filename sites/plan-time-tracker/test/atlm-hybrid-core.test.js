import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAtlmOls, fitAtlmRidge, predictAtlmRidge, normalizeAgentTask } from '../worker/index.js';
import { taskV4 } from './fixtures/tracker-db.mjs';

const base = normalizeAgentTask(taskV4()).features;
const rows = Array.from({ length: 8 }, (_, i) => ({ sampleId: `s${i}`, planId: `p${i}`, capturedAt: i * 10,
  sourceAvailableAt: i * 10 + 1, actualMs: 60000 * (i + 1), features: { ...base,
    'components.MODIFY': i % 2, 'contracts.API': i % 2, requirementsUncertainty: i % 2 } }));

test('ridge fits an underdetermined and dependent design using the full manifest', async () => {
  const input = rows.slice(0, 2), before = JSON.stringify(input), fit = await fitAtlmRidge(input);
  assert.equal(fit.status, 'AVAILABLE', JSON.stringify(fit));
  assert.ok(fit.artifact.p > fit.artifact.n); assert.ok(fit.artifact.rank < fit.artifact.p);
  assert.equal(fit.artifact.lambda, 1);
  assert.deepEqual(fit.artifact.preprocessor.fields, Object.keys(base).sort());
  assert.equal(JSON.stringify(input), before);
  assert.equal(predictAtlmRidge(fit.artifact, input[0].features).status, 'AVAILABLE');
  assert.equal((await fitAtlmOls(input)).reason, 'INSUFFICIENT_DATA');
});

test('ridge artifacts are deterministic and reject damaged preprocessing', async () => {
  const fit = await fitAtlmRidge(rows);
  assert.equal(fit.status, 'AVAILABLE'); assert.deepEqual(fit, await fitAtlmRidge([...rows].reverse()));
  assert.ok(Object.isFrozen(fit.artifact.coefficients));
  const restored = JSON.parse(JSON.stringify(fit.artifact));
  assert.deepEqual(predictAtlmRidge(restored, rows[0].features), predictAtlmRidge(fit.artifact, rows[0].features));
  for (const mutate of [a => a.lambda = 0, a => a.preprocessor.columns[0].scale = 0,
    a => a.coefficients[0] = null, a => a.preprocessor.columns.pop(), a => a.manifest[1] = a.manifest[0]]) {
    const bad = structuredClone(restored); mutate(bad);
    assert.equal(predictAtlmRidge(bad, rows[0].features).reason, 'INVALID_ARTIFACT');
  }
});

test('single observation is unpenalized and unknown optional inputs remain usable', async () => {
  const fit = await fitAtlmRidge(rows.slice(0, 1)), f = rows[0].features;
  assert.equal(fit.status, 'AVAILABLE'); assert.equal(predictAtlmRidge(fit.artifact, f).pointMs, rows[0].actualMs);
  for (const changes of [{modelId:null}, {modelId:'unseen'}, {reasoningEffort:'unseen'}, {plannedParallelAgents:null}]) {
    assert.equal(predictAtlmRidge(fit.artifact, { ...f, ...changes }).status, 'AVAILABLE');
  }
  assert.equal((await fitAtlmRidge([])).reason, 'INSUFFICIENT_DATA');
  assert.equal((await fitAtlmRidge([rows[0], rows[0]])).reason, 'INVALID_DATASET');
  assert.equal(predictAtlmRidge(fit.artifact, { ...f, doneBoundary:'UNKNOWN' }).reason, 'MISSING_REQUIRED_FEATURES');
  assert.equal(predictAtlmRidge(fit.artifact, { ...f, plannedParallelAgents:0 }).reason, 'INVALID_FEATURES');
});
