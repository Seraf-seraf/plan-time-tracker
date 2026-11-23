import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAgentTask, evaluateHybridAtlmChronologically, selectHybridHistory, selectHybridEvaluationCases, summarizeHybridAtlmEvaluation } from '../worker/atlm/model.js';
import { taskV4 } from './fixtures/tracker-db.mjs';
const features=normalizeAgentTask(taskV4()).features;
const journal=(n=12)=>Array.from({length:n},(_,i)=>({sampleId:String(i+1),planId:`plan-${i}`,capturedAt:i*10000,sourceAvailableAt:i*10000+5000,observedAt:i*10000+5000,eligibility:'ELIGIBLE',features:structuredClone(features),actualMs:60000+i%2}));

test('strict as-of history excludes equality, future and target',()=>{
 const input=journal(),target=input.at(-1); input[9].sourceAvailableAt=target.capturedAt;input[9].observedAt=target.capturedAt;
 const prior=selectHybridHistory(input,target.capturedAt,{excludePlanId:target.planId});
 assert.equal(prior.length,10);assert(!prior.some(row=>row.planId===target.planId));
});
test('future outcomes and revisions cannot change earlier forecasts',async()=>{
 const input=journal(),before=await evaluateHybridAtlmChronologically(input),changed=structuredClone(input);
 changed.at(-1).actualMs=900000;changed.push({...changed[0],sampleId:'13',eligibility:'EXCLUDED',observedAt:200000,sourceAvailableAt:200000});
 const after=await evaluateHybridAtlmChronologically(changed);
 const old=before.cases.at(-1),next=after.cases.find(c=>c.sampleId===old.sampleId);
 assert.deepEqual(next.prediction,old.prediction);assert.deepEqual(next.decision,old.decision);assert.equal(next.trainDatasetDigest,old.trainDatasetDigest);
});
test('even-prefix medians round to safe integer milliseconds',async()=>{
 const report=await evaluateHybridAtlmChronologically(journal());assert.equal(report.status,'AVAILABLE');
 for(const i of [2,4,6,8,10]) assert.equal(report.cases[i].median.pointMs,60001);
});
test('latest twenty cases and independently recomputed summary agree',async()=>{
 const input=journal(22),report=await evaluateHybridAtlmChronologically(input),selection=selectHybridEvaluationCases(input);
 assert.equal(report.caseCount,20);assert.deepEqual(report.cases.map(c=>c.sampleId),input.slice(-20).map(c=>c.sampleId));
 assert.deepEqual(summarizeHybridAtlmEvaluation(report.cases,selection),report);
});
test('empty, zero actual and cutoffs are reported honestly',async()=>{
 const empty=await evaluateHybridAtlmChronologically([]);assert.equal(empty.caseCount,0);assert.equal(empty.metrics.overall.forecastRate,null);
 const input=journal(6);input.forEach(x=>x.actualMs=0);const result=await evaluateHybridAtlmChronologically(input,{cutoff:input[4].observedAt});
 assert.equal(result.caseCount,5);assert.equal(result.metrics.overall.wapePercent,null);
});
test('duplicate revisions and unsupported evaluation options reject',async()=>{
 const input=journal();input[1].sampleId=input[0].sampleId;
 assert.equal((await evaluateHybridAtlmChronologically(input)).reason,'INVALID_DATASET');
 assert.equal((await evaluateHybridAtlmChronologically(journal(),{maxCases:1})).reason,'INVALID_PROTOCOL');
});
test('CLI validates a complete v3 journal and does not mutate the source',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'atlm-cli-')),file=path.join(dir,'rows.json'),cli=fileURLToPath(new URL('../scripts/evaluate-atlm.mjs',import.meta.url));
 try {const input=JSON.stringify({formatVersion:3,sourceAuthority:'SYNTHETIC',datasetRevision:1,asOf:200000,throughSequence:12,nextCursor:null,rows:journal()});writeFileSync(file,input);
 const run=spawnSync(process.execPath,[cli,file],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).protocolVersion,3);assert.equal(readFileSync(file,'utf8'),input);
 writeFileSync(file,'{broken');const bad=spawnSync(process.execPath,[cli,file],{encoding:'utf8'});assert.equal(bad.status,1);assert.equal(bad.stdout,'');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
