import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAtlmBayesian, predictAtlmBayesian, fitHybridAtlm, predictHybridAtlm, normalizeAgentTask } from '../worker/index.js';
import { taskV4 } from './fixtures/tracker-db.mjs';

const base = normalizeAgentTask(taskV4()).features;
const rows = values => values.map((actualMs, i) => ({ sampleId: `s${i}`, planId: `p${i}`, capturedAt:i*10,
  sourceAvailableAt:i*10+1, features:{...base}, actualMs }));

test('Bayesian predictive interval matches an independent Student-t reference', async () => {
  const fit=await fitAtlmBayesian(rows([0,60000,180000]));
  assert.equal(fit.status,'AVAILABLE',JSON.stringify(fit));
  const pred=predictAtlmBayesian(fit.artifact,base);
  assert.equal(pred.status,'AVAILABLE'); assert.equal(pred.pointMs,60000);
  assert.equal(pred.interval.status,'AVAILABLE'); assert.equal(pred.interval.lowerMs,0); assert.equal(pred.interval.upperMs,287263);
  assert.ok(Math.abs(pred.predictive.location-0.693146949510962)<1e-9);
  assert.ok(Math.abs(pred.predictive.scale-0.7509874466704461)<1e-9);
  assert.equal(pred.predictive.degreesOfFreedom,7);
  const corrupt=structuredClone(fit.artifact);corrupt.posterior.cholesky[0][0]=1;
  assert.equal(predictAtlmBayesian(corrupt,base).reason,'INVALID_ARTIFACT');
});

test('Bayesian posterior with a predictor matches independent linear algebra', async () => {
  const counts=[0,1,3,7,15], samples=rows([0,70000,140000,310000,720000]).map((row,i)=>
    ({ ...row, features:{...row.features,'components.MODIFY':counts[i]} }));
  const fit=await fitAtlmBayesian(samples); assert.equal(fit.status,'AVAILABLE');
  const coefficients=fit.artifact.posterior.coefficients;
  assert.ok(Math.abs(coefficients[0]-1.2722538442366556)<1e-10);
  assert.ok(Math.abs(coefficients[1]-0.7278329377333057)<1e-10);
  const pred=predictAtlmBayesian(fit.artifact,{...base,'components.MODIFY':2});
  assert.equal(pred.pointMs,112949); assert.equal(pred.interval.lowerMs,15475); assert.equal(pred.interval.upperMs,336308);
});

test('Bayesian handles zero, collinear wide designs and serialized artifacts', async () => {
  const samples=rows([0,0]).map((row,i)=>({...row,features:{...row.features,'components.MODIFY':i,'contracts.API':i}}));
  const fit=await fitAtlmBayesian(samples);
  assert.equal(fit.status,'AVAILABLE',JSON.stringify(fit)); assert.ok(fit.artifact.p>fit.artifact.n);
  const prediction=predictAtlmBayesian(JSON.parse(JSON.stringify(fit.artifact)),samples[0].features);
  assert.equal(prediction.status,'AVAILABLE'); assert.equal(prediction.pointMs,0);
  assert.ok(prediction.interval.upperMs>0,'future observation noise must remain in the interval');
  const bad=structuredClone(fit.artifact);bad.posterior.scale=0.1;
  assert.equal(predictAtlmBayesian(bad,samples[0].features).reason,'INVALID_ARTIFACT');
});

test('nearby large predictor values retain stable centering', async () => {
  for (const delta of [1,100,1000000]) {
    const samples=rows([60000,120000]).map((row,i)=>({...row,features:{...row.features,
      plannedParallelAgents:Number.MAX_SAFE_INTEGER-(i?delta:0)}}));
    const fit=await fitAtlmBayesian(samples);assert.equal(fit.status,'AVAILABLE',JSON.stringify(fit));
    assert.equal(predictAtlmBayesian(fit.artifact,samples[0].features).status,'AVAILABLE');
  }
});

test('Bayesian fails explicitly for invalid data and overflow', async () => {
  assert.equal((await fitAtlmBayesian([])).reason,'INSUFFICIENT_DATA');
  assert.equal((await fitAtlmBayesian([null])).reason,'INVALID_DATASET');
  const fit=await fitAtlmBayesian(rows([Number.MAX_SAFE_INTEGER]));
  assert.equal(fit.status,'AVAILABLE');
  const prediction=predictAtlmBayesian(fit.artifact,base);
  assert.equal(prediction.status,'AVAILABLE'); assert.ok(Number.isSafeInteger(prediction.pointMs));
  assert.equal(prediction.interval.status,'UNAVAILABLE'); assert.equal(prediction.interval.upperMs,null);
});

test('Bayesian is a selectable internal point candidate', async () => {
  const samples=rows([0,60000,180000]), bayesian=await fitAtlmBayesian(samples);
  const unavailable={status:'UNAVAILABLE',pointMs:null,reason:'INSUFFICIENT_DATA'};
  const fit=await fitHybridAtlm(samples,{candidates:{ols:unavailable,ridge:unavailable,bayesian}});
  assert.equal(fit.status,'AVAILABLE',JSON.stringify(fit));
  assert.equal(fit.artifact.selectedEngine,'BAYESIAN');
  const prediction=predictHybridAtlm(fit.artifact,base);
  assert.equal(prediction.hybrid.usedEngine,'BAYESIAN');
  assert.equal(prediction.interval.status,'AVAILABLE');
  assert.equal((await fitHybridAtlm(samples.slice(0,1))).reason,'INSUFFICIENT_DATA');
});
