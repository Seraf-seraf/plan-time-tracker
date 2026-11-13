import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectHybridHistory, selectHybridEngine, evaluateHybridAtlmChronologically,
  fitHybridAtlm, predictHybridAtlm, fitAtlmRidge } from '../worker/index.js';
import { evaluate } from '../scripts/evaluate-atlm.mjs';

const reference = JSON.parse(readFileSync(new URL('./fixtures/atlm-reference.json', import.meta.url)));
const rows = reference.cases[0].rows;
const journal = rows.map((r, i) => ({...r,sampleId:String(i+1),eligibility:'ELIGIBLE',observedAt:r.sourceAvailableAt}));
const available = pointMs => ({status:'AVAILABLE',pointMs,reason:null});
const candidates = {ols:{status:'AVAILABLE'},ridge:{status:'AVAILABLE'}};

test('selection uses comparable historical errors, five OWN forecasts and deterministic ties', () => {
  // Controlled forecast responses use existing facts; this is a selector contract, not an accuracy experiment.
  const cases = rows.slice(0,6).map(r => ({...r,ols:available(r.actualMs),ridge:available(r.actualMs+4),median:available(r.actualMs+10)}));
  assert.equal(selectHybridEngine(candidates,cases.slice(0,4)).selectedEngine,'RIDGE');
  assert.equal(selectHybridEngine(candidates,cases).selectedEngine,'OLS');
  const ridgeWins=cases.map(c=>({...c,ols:available(c.actualMs+8)}));
  assert.equal(selectHybridEngine(candidates,ridgeWins).selectedEngine,'RIDGE');
  const tie=cases.map(c=>({...c,ridge:available(c.actualMs+1)}));
  assert.equal(selectHybridEngine(candidates,tie).selectedEngine,'RIDGE');
  const threeWayTie=cases.map(c=>({...c,ridge:available(c.actualMs+1),median:available(c.actualMs+2)}));
  assert.equal(selectHybridEngine(candidates,threeWayTie).selectedEngine,'RIDGE','prefer within 1ms of the global minimum, not a registration-order chain');
  assert.equal(selectHybridEngine(candidates,cases.map(c=>({...c,median:available(c.actualMs)}))).selectedEngine,'MEDIAN');
  const missingOwn=cases.map(c=>({...c,ols:{status:'UNAVAILABLE',pointMs:null,reason:'RANK_DEFICIENT'}}));
  assert.equal(selectHybridEngine(candidates,missingOwn).ownPredictionCounts.ols,0);
  assert.equal(selectHybridEngine(candidates,missingOwn).selectedEngine,'RIDGE');
});

test('as-of reads observe versions before filtering eligibility and exclude equality and future observations', () => {
  const first=journal[0];const cutoff=first.observedAt+100;
  const future={...first,sampleId:'100',observedAt:cutoff+1,sourceAvailableAt:cutoff+1,eligibility:'EXCLUDED'};
  assert(selectHybridHistory([first,future],cutoff).some(r=>r.planId===first.planId));
  const excluded={...future,observedAt:cutoff-1,sourceAvailableAt:cutoff-1};
  assert.equal(selectHybridHistory([first,excluded],cutoff).length,0);
  assert.equal(selectHybridHistory([first],first.observedAt).length,0);
  assert.equal(selectHybridHistory([first],first.observedAt,{inclusive:true}).length,1);
  assert.equal(selectHybridHistory([first],cutoff,{excludePlanId:first.planId}).length,0);
});

test('entire hybrid decisions and preprocessing cannot see target outcomes or future versions', async () => {
  const input=journal.slice(0,12);
  const first=await evaluateHybridAtlmChronologically(input);
  assert.equal(first.status,'AVAILABLE');assert.equal(first.protocolVersion,2);
  const target=first.cases.at(-1), changed=structuredClone(input);
  changed.at(-1).actualMs=input[0].actualMs;
  changed.push({...input[0],sampleId:'100',observedAt:input.at(-1).sourceAvailableAt+1,sourceAvailableAt:input.at(-1).sourceAvailableAt+1,eligibility:'EXCLUDED'});
  const second=await evaluateHybridAtlmChronologically(changed);
  const same=second.cases.find(c=>c.sampleId===target.sampleId);
  assert.deepEqual(same.atlm,target.atlm);assert.deepEqual(same.decision,target.decision);
  assert.equal(same.trainDatasetDigest,target.trainDatasetDigest);
  assert.equal(first.metrics.operational.scoredCount,first.metrics.median.scoredCount);
  assert(first.metrics.atlm.forecastRate<=first.metrics.operational.forecastRate);
});

test('hybrid artifact dispatch is immutable and rejects inconsistent nested models', async () => {
  const input=rows.slice(0,8), before=JSON.stringify(input);
  const fit=await fitHybridAtlm(input);
  assert.equal(fit.status,'AVAILABLE',JSON.stringify(fit));assert.equal(fit.artifact.selectedEngine,'RIDGE');
  const restored=JSON.parse(JSON.stringify(fit.artifact));
  assert.deepEqual(predictHybridAtlm(restored,input[0].features),predictHybridAtlm(fit.artifact,input[0].features));
  assert.equal(predictHybridAtlm(restored,input[0].features).hybrid.usedEngine,'RIDGE');
  for(const change of [a=>a.selection.caseCount=-1,a=>a.selection.scores.ridge=-1,a=>a.candidates.ols={status:'UNAVAILABLE'}]){
    const corrupt=structuredClone(restored);change(corrupt);
    assert.equal(predictHybridAtlm(corrupt,input[0].features).reason,'INVALID_ARTIFACT');
  }
  restored.candidates.ridge.artifact=structuredClone((await fitAtlmRidge(input.slice(0,2))).artifact);
  assert.equal(predictHybridAtlm(restored,input[0].features).reason,'INVALID_ARTIFACT');
  assert.equal(JSON.stringify(input),before);
});

test('journal CLI keeps protocol1 and rejects partial, mixed and reordered protocol2 input', async () => {
  const input={formatVersion:2,sourceAuthority:'OWNER_EXPORT',datasetRevision:1,asOf:journal.at(-1).observedAt,
    throughSequence:journal.length,nextCursor:null,rows:journal};
  const report=await evaluate(input);assert.equal(report.protocolVersion,2);
  assert.equal(report.sourceAuthority,'OWNER_EXPORT');
  for(const change of [{nextCursor:'more'},{rows:[...journal].reverse()},{asOf:0},{throughSequence:journal.length+1}]) {
    await assert.rejects(()=>evaluate({...input,...change}));
  }
  const legacy=await evaluate({formatVersion:1,sourceAuthority:'SYNTHETIC',rows:rows.slice(0,3),nextCursor:null});
  assert.equal(legacy.protocolVersion,1);
});
