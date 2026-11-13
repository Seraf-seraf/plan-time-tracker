import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fitAtlmOls, fitAtlmRidge, predictAtlmRidge } from '../worker/index.js';

// Reuse the existing independent numerical reference; no owner data is vendored.
const reference = JSON.parse(readFileSync(new URL('./fixtures/atlm-reference.json', import.meta.url)));
const rows = reference.cases[0].rows;

test('ridge fits a wide, dependent design without dropping any input field', async () => {
  const input = rows.slice(0, 2);
  const before = JSON.stringify(input);
  const fit = await fitAtlmRidge(input);
  assert.equal(fit.status, 'AVAILABLE', JSON.stringify(fit));
  assert(fit.artifact.p > fit.artifact.n);
  assert(fit.artifact.rank < fit.artifact.p);
  assert.equal(fit.artifact.lambda, 1);
  assert.equal(fit.artifact.objective, 'mean-square-plus-l2');
  for (const field of ['workKind','reuseState','doneBoundary','outcomeCount','contractCount','verificationKindCount','modelId','reasoningEffort','plannedParallelAgents']) {
    assert(fit.artifact.columns.some(c => c.field === field), field);
  }
  assert.equal(JSON.stringify(input), before);
  assert.equal(predictAtlmRidge(fit.artifact, input[0].features).status, 'AVAILABLE');
});

test('ridge artifacts are deterministic, immutable, serializable and validate preprocessing', async () => {
  const fit = await fitAtlmRidge(rows);
  assert.equal(fit.status, 'AVAILABLE');
  assert.deepEqual(fit, await fitAtlmRidge([...rows].reverse()));
  assert(Object.isFrozen(fit.artifact.coefficients));
  const restored = JSON.parse(JSON.stringify(fit.artifact));
  assert.deepEqual(predictAtlmRidge(restored, rows[0].features), predictAtlmRidge(fit.artifact, rows[0].features));
  for (const mutate of [a => a.lambda = 0, a => a.scales[1] = 0, a => a.centers.pop(), a => a.coefficients[0] = null,
    a => a.columns.pop(), a => a.runtime.categories.modelId.weights[0] = -1, a => a.manifest[1] = a.manifest[0]]) {
    const bad = structuredClone(restored); mutate(bad);
    assert.equal(predictAtlmRidge(bad, rows[0].features).reason, 'INVALID_ARTIFACT');
  }
});

test('ridge keeps a single constant observation unpenalized and accepts missing runtime independently', async () => {
  const fit = await fitAtlmRidge(rows.slice(0, 1));
  assert.equal(fit.status, 'AVAILABLE');
  const f = rows[0].features;
  assert.equal(predictAtlmRidge(fit.artifact, f).pointMs, rows[0].actualMs);
  for (const runtime of [{}, {modelId:null}, {modelId:'not-seen'}, {reasoningEffort:'not-seen'}, {plannedParallelAgents:null}]) {
    assert.equal(predictAtlmRidge(fit.artifact, {...f,...runtime}).status, 'AVAILABLE');
  }
  assert.equal(fit.artifact.n, 1);
  assert.equal(fit.artifact.manifest.length, 1);
});

test('OLS remains an explicit legacy method and ridge rejects corrupt or incomplete inputs', async () => {
  const old = await fitAtlmOls(rows);
  assert.equal(old.artifact.method.version, 'agent-v2');
  assert.equal((await fitAtlmRidge([])).reason, 'INSUFFICIENT_DATA');
  assert.equal((await fitAtlmRidge([rows[0],rows[0]])).reason, 'INVALID_DATASET');
  const fit = await fitAtlmRidge(rows);
  assert.equal(predictAtlmRidge(fit.artifact, {...rows[0].features,modelId:null,reasoningEffort:null,plannedParallelAgents:null}).status,'AVAILABLE');
  assert.equal(predictAtlmRidge(fit.artifact, {...rows[0].features,workKind:'UNKNOWN'}).reason,'INCOMPLETE_FEATURES');
  assert.equal(predictAtlmRidge(fit.artifact, {...rows[0].features,plannedParallelAgents:0}).reason,'INVALID_FEATURES');
});
