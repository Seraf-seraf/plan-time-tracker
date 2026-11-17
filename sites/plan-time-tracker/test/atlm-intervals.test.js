import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAtlmResidualQuantile, fitAtlmResidualQuantiles, fitHybridAtlm, predictHybridAtlm, predictAtlmResidualQuantile, predictAtlmResidualInterval, evaluateAtlmIntervalCandidates, evaluateHybridAtlmChronologically, combineAtlmQuantileInterval, summarizeAtlmV4Metrics, selectHybridEngine, selectAtlmIntervalEngine, normalizeAgentTask } from '../worker/index.js';
import { taskV4 } from './fixtures/tracker-db.mjs';

const features=normalizeAgentTask(taskV4()).features;

test('coverage counts hits among intervals, separately from forecast rate',()=>{
  const actual=[5,5,5,5,5,5];
  const cases=actual.map((value,i)=>({planId:`p${i}`,actualMs:value,pointMs:i===5?null:i<3?5:6,
    interval:i===5?{status:'UNAVAILABLE',lowerMs:null,upperMs:null,unavailableReason:'NO_INTERVAL'}:{status:'AVAILABLE',lowerMs:i<3?4:6,upperMs:i<3?6:7}}));
  const metrics=summarizeAtlmV4Metrics(cases);
  assert.equal(metrics.forecastRate,5/6);assert.equal(metrics.intervalAvailabilityRate,5/6);
  assert.equal(metrics.intervalCoverage,0.6);assert.equal(metrics.coverageNumerator,3);assert.equal(metrics.coverageDenominator,5);
  assert.equal(metrics.meanIntervalWidthMs,1.6);assert.equal(metrics.meanIntervalScore,5.6);
});

test('zero denominators are unknown, not perfect',()=>{
  const metrics=summarizeAtlmV4Metrics([{planId:'a',actualMs:0,pointMs:1,interval:{status:'UNAVAILABLE',lowerMs:null,upperMs:null,unavailableReason:'NO_INTERVAL'}}]);
  assert.equal(metrics.wapePercent,null);assert.equal(metrics.signedBiasPercent,null);
  assert.equal(metrics.intervalCoverage,null);assert.equal(metrics.meanIntervalWidthMs,null);
});

test('invalid observations and repeated plan IDs are rejected',()=>{
  const item={planId:'a',actualMs:0,pointMs:1,interval:{status:'UNAVAILABLE',lowerMs:null,upperMs:null,unavailableReason:'NO_INTERVAL'}};
  assert.equal(summarizeAtlmV4Metrics([item,item]).reason,'INVALID_EVALUATION');
  assert.equal(summarizeAtlmV4Metrics([{...item,actualMs:-1}]).reason,'INVALID_EVALUATION');
  assert.equal(summarizeAtlmV4Metrics([{...item,interval:{status:'AVAILABLE',lowerMs:2,upperMs:3}}]).reason,'INVALID_EVALUATION');
  assert.equal(summarizeAtlmV4Metrics([{...item,interval:{status:'UNAVAILABLE',lowerMs:9,upperMs:11,unavailableReason:'NO_INTERVAL'}}]).reason,'INVALID_EVALUATION');
});

test('intercept-only residual quantile fits a deterministic empirical median',async()=>{
  const samples=[-2,-1,0,1,2].map((residual,i)=>({planId:`p${i}`,features:{...features},residual}));
  const fit=await fitAtlmResidualQuantile(samples,0.5);
  assert.equal(fit.status,'AVAILABLE',JSON.stringify(fit));
  assert.ok(Math.abs(predictAtlmResidualQuantile(fit.artifact,features).value)<1e-4);
  assert.deepEqual(await fitAtlmResidualQuantile([...samples].reverse(),0.5),fit);
  const extreme=[1e16,1e16,1e16,-1e16,-1e16].map((residual,i)=>({planId:`x${i}`,features:{...features},residual}));
  assert.equal((await fitAtlmResidualQuantile(extreme,0.5)).reason,'NUMERICAL_FAILURE');
});

test('candidate selection compares the same cases rather than mixing fallback forecasts',()=>{
  const available=pointMs=>({status:'AVAILABLE',pointMs,reason:null});
  const unavailable={status:'UNAVAILABLE',pointMs:null,reason:'INSUFFICIENT_DATA'};
  const candidates={ridge:available(0),bayesian:available(0),ols:unavailable};
  const cases=Array.from({length:20},(_,i)=>({planId:`p${i}`,capturedAt:i,actualMs:100,
    median:available(i<5?1000:100),ridge:available(i<5?140:200),bayesian:i<5?available(150):unavailable,ols:unavailable}));
  const selection=selectHybridEngine(candidates,cases);
  assert.equal(selection.selectedEngine,'RIDGE');
  assert.equal(selection.scores.ridge,40);assert.equal(selection.scores.bayesian,50);
  assert.equal(selection.caseCount,5);
  assert.equal(selectHybridEngine(candidates,Array(5).fill(cases[0])).reason,'INVALID_EVALUATION');
  const invalid=structuredClone(cases);invalid[0].bayesian.pointMs=null;
  assert.equal(selectHybridEngine(candidates,invalid).reason,'INVALID_EVALUATION');
});

test('crossed residual quantiles are ordered and final bounds include the chosen point',()=>{
  const interval=combineAtlmQuantileInterval({location:Math.log(2),scale:0.5},[1,0,-1],400000,5);
  assert.equal(interval.status,'AVAILABLE');
  assert.equal(interval.lowerMs,12784); assert.equal(interval.upperMs,400000);
  assert.equal(combineAtlmQuantileInterval({location:0,scale:0},[-1,0,1],1,5).status,'UNAVAILABLE');
  assert.equal(predictAtlmResidualInterval({formatVersion:1,kind:'BAYES_QUANTILE',sampleCount:5,models:[null,null,null]},features,null,1).unavailableReason,'INVALID_ARTIFACT');
});

test('interval engine is selected independently on the same cases',()=>{
  const candidates={BAYESIAN_PREDICTIVE:{status:'AVAILABLE'},BAYES_QUANTILE:{status:'AVAILABLE'}};
  const cases=Array.from({length:5},(_,i)=>({planId:`p${i}`,capturedAt:i,actualMs:10,pointMs:10,intervals:{
    BAYESIAN_PREDICTIVE:{status:'AVAILABLE',lowerMs:0,upperMs:20},BAYES_QUANTILE:{status:'AVAILABLE',lowerMs:8,upperMs:12}}}));
  const selection=selectAtlmIntervalEngine(candidates,cases);
  assert.equal(selection.selectedEngine,'BAYES_QUANTILE');assert.equal(selection.caseCount,5);
  assert.equal(selection.metrics.BAYES_QUANTILE.meanIntervalScore,4);
  const tied=cases.map(item=>({...item,intervals:{...item.intervals,BAYES_QUANTILE:item.intervals.BAYESIAN_PREDICTIVE}}));
  assert.equal(selectAtlmIntervalEngine(candidates,tied,{incumbent:'BAYES_QUANTILE'}).selectedEngine,'BAYES_QUANTILE');
});

test('interval calibration rejects future or repeated observations',async()=>{
  const base={planId:'target',capturedAt:100,features,bayesian:{status:'AVAILABLE',predictive:{location:1,scale:1},
    interval:{status:'AVAILABLE',lowerMs:0,upperMs:100000}}};
  const prior={planId:'past',sourceAvailableAt:100,features,actualMs:100,bayesian:base.bayesian};
  assert.equal((await evaluateAtlmIntervalCandidates(base,[prior],100)).BAYES_QUANTILE.unavailableReason,'INVALID_HISTORY');
  prior.sourceAvailableAt=99;
  assert.equal((await evaluateAtlmIntervalCandidates(base,[prior,prior],100)).BAYES_QUANTILE.unavailableReason,'INVALID_HISTORY');
  const valid=await evaluateAtlmIntervalCandidates(base,[prior],100);
  assert.equal(valid.BAYESIAN_PREDICTIVE.status,'AVAILABLE');
  assert.equal(valid.BAYES_QUANTILE.unavailableReason,'INSUFFICIENT_RESIDUALS');
});

test('historical intervals use only earlier observed residuals',async()=>{
  const journal=Array.from({length:8},(_,i)=>({sampleId:String(i+1),planId:`p${i}`,capturedAt:i*100,sourceAvailableAt:i*100+20,
    observedAt:i*100+20,eligibility:'ELIGIBLE',features:{...features},actualMs:60000*(i+1)}));
  const first=await evaluateHybridAtlmChronologically(journal);
  assert.equal(first.status,'AVAILABLE',JSON.stringify(first));
  const target=first.cases.at(-1);assert.equal(target.intervalCandidates.BAYES_QUANTILE.status,'AVAILABLE');
  const changed=structuredClone(journal);changed.at(-1).actualMs*=100;
  const second=await evaluateHybridAtlmChronologically(changed);
  assert.deepEqual(second.cases.at(-1).prediction,target.prediction);
  assert.deepEqual(second.cases.at(-1).intervalCandidates,target.intervalCandidates);
});


test('quantile artifacts cannot introduce fabricated historical residuals',async()=>{
  const rows=Array.from({length:8},(_,i)=>({sampleId:`s${i}`,planId:`p${i}`,capturedAt:i*10,sourceAvailableAt:i*10+1,features,actualMs:1000+i*100}));
  const falsified=await fitAtlmResidualQuantiles(rows.slice(3).map(row=>({planId:row.planId,features,residual:0})));
  assert.equal(falsified.status,'AVAILABLE');
  const historyFor=async target=>rows.filter(row=>row.sourceAvailableAt<target.capturedAt);
  const result=await fitHybridAtlm(rows,{residualQuantiles:falsified.artifact,calibrationHistory:historyFor});
  assert.equal(result.reason,'INVALID_ARTIFACT');
  const wrongTime=await fitHybridAtlm(rows,{residualQuantiles:falsified.artifact,calibrationHistory:async target=>[target,...await historyFor(target)]});
  assert.equal(wrongTime.reason,'INVALID_ARTIFACT');
});

test('fabricated historical interval scores cannot validate an artifact',async()=>{
 const rows=Array.from({length:8},(_,i)=>({sampleId:`s${i}`,planId:`p${i}`,capturedAt:i*10,sourceAvailableAt:i*10+1,features,actualMs:1000+i*100}));
 const claims=rows.slice(0,5).map(row=>({planId:row.planId,capturedAt:row.capturedAt,actualMs:row.actualMs,pointMs:row.actualMs,intervals:{
   BAYESIAN_PREDICTIVE:{status:'AVAILABLE',lowerMs:row.actualMs,upperMs:row.actualMs},
   BAYES_QUANTILE:{status:'UNAVAILABLE',lowerMs:null,upperMs:null,unavailableReason:'NONE'}}}));
 const selection=selectAtlmIntervalEngine({BAYESIAN_PREDICTIVE:{status:'AVAILABLE'},BAYES_QUANTILE:{status:'UNAVAILABLE'}},claims);
 assert.equal(selection.validationStatus,'HISTORICALLY_EVALUATED');
 assert.equal((await fitHybridAtlm(rows,{intervalSelection:selection})).reason,'INVALID_PROTOCOL');
});


test('artifact rejects forged validation status and future sources at cutoff',async()=>{
 const rows=Array.from({length:3},(_,i)=>({sampleId:`s${i}`,planId:`p${i}`,capturedAt:i*2,sourceAvailableAt:i*2+1,features,actualMs:1000}));
 const fit=await fitHybridAtlm(rows);assert.equal(fit.status,'AVAILABLE');
 const damaged=structuredClone(fit.artifact);damaged.intervalSelection.validationStatus='HISTORICALLY_EVALUATED';
 assert.equal(predictHybridAtlm(damaged,features).reason,'INVALID_ARTIFACT');
 assert.equal((await fitHybridAtlm(rows,{cutoff:2})).reason,'INVALID_DATASET');
});
