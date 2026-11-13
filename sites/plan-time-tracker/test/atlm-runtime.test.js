import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAtlmOls as fitAtlm, predictAtlmOls as predictAtlm, evaluateAtlmCase } from '../worker/index.js';

const base = { workKind:'MODIFY_MECHANISM', reuseState:'PARTIAL', doneBoundary:'LOCAL_VERIFIED', outcomeCount:1, contractCount:0, verificationKindCount:1 };
const f = (modelId=null, reasoningEffort=null, plannedParallelAgents=null) => ({...base,modelId,reasoningEffort,plannedParallelAgents});
function grid(missing=true) {
  const rows=[];
  for(const model of missing?['a','b','c',null]:['a','b','c'])
    for(const effort of missing?['low','high',null]:['low','high'])
      for(const count of missing?[1,2,3,null]:[1,2,3]) {
        const i=rows.length;
        rows.push({sampleId:'s'+i,planId:'p'+i,capturedAt:i*10,sourceAvailableAt:i*10+1,features:f(model,effort,count),
          actualMs:60000*(10+({a:0,b:10,c:20}[model]??30)+({low:0,high:6}[effort]??12)+(count===null?8:count*2))});
      }
  return rows;
}
function minutes(artifact,features) {
  const p=predictAtlm(artifact,features);assert.equal(p.status,'AVAILABLE',JSON.stringify(p));return p.pointMs/60000;
}
function near(actual,expected) { assert(Math.abs(actual-expected)<0.0001,actual+' != '+expected); }

test('model, effort, parallel count and learned unknown each affect the same task',async()=>{
  const result=await fitAtlm(grid());assert.equal(result.status,'AVAILABLE',JSON.stringify(result));
  const a=result.artifact;
  near(minutes(a,f('a','low',1)),12);
  near(minutes(a,f('b','low',1)),22);
  near(minutes(a,f('a','high',1)),18);
  near(minutes(a,f('a','low',3)),16);
  near(minutes(a,f()),60);
  near(minutes(a,f('new-model','low',1)),42); // use the learned unknown model level
  near(minutes(a,f('a','new-effort',1)),24);
  assert.deepEqual(predictAtlm(JSON.parse(JSON.stringify(a)),f()),predictAtlm(a,f()));
});

test('unseen and missing runtime use train-weighted effects when no unknown was observed',async()=>{
  const {artifact}=await fitAtlm(grid(false));
  near(minutes(artifact,f()),27); // model mean 10, effort mean 3, parallel mean effect 4
  near(minutes(artifact,f('never-seen','low',1)),22);
  near(minutes(artifact,{...base}),27);
});

test('unknown fallback is invariant to the categorical reference label',async()=>{
  const input=grid(false), renamed=input.map(r=>({...r,features:{...r.features,modelId:{a:'z',b:'y',c:'x'}[r.features.modelId]}}));
  const a=(await fitAtlm(input)).artifact,b=(await fitAtlm(renamed)).artifact;
  near(minutes(a,f()),minutes(b,f()));
});

test('all-null runtime adds no parameters and a one-plan point forecast has DOF zero',async()=>{
  const row=grid()[0];row.features=f();row.actualMs=600000;
  const result=await fitAtlm([row]);assert.equal(result.status,'AVAILABLE',JSON.stringify(result));
  assert.equal(result.artifact.p,1);assert.equal(result.artifact.residualDegreesOfFreedom,0);
  near(minutes(result.artifact,f()),10);
  near(minutes(result.artifact,f('unseen','max',20)),10);
});

test('full rank n=p is permitted; underdetermined and singular designs are not',async()=>{
  const rows=grid().slice(0,3).map((r,i)=>({...r,features:{...f(),outcomeCount:i},actualMs:60000*(10+i)}));
  const result=await fitAtlm(rows.slice(0,2));assert.equal(result.status,'AVAILABLE',JSON.stringify(result));
  assert.equal(result.artifact.residualDegreesOfFreedom,0);
  const singular=rows.map((r,i)=>({...r,features:{...r.features,contractCount:i}}));
  assert.equal((await fitAtlm(singular.slice(0,2))).reason,'INSUFFICIENT_DATA');
  assert.equal((await fitAtlm(singular)).reason,'RANK_DEFICIENT');
});

test('held-out outcomes cannot change runtime preprocessing or historical prediction',async()=>{
  const rows=grid(false), target={...rows.at(-1),sampleId:'held',planId:'held',capturedAt:10000,sourceAvailableAt:10001};
  const a=await evaluateAtlmCase([...rows,target],'held');
  const b=await evaluateAtlmCase([...rows,{...target,actualMs:99999999}],'held');
  assert.deepEqual(a.atlm,b.atlm);assert.equal(a.trainDatasetDigest,b.trainDatasetDigest);
});

test('constant known parallel count with missing values learns only the missing indicator',async()=>{
  const rows=Array.from({length:12},(_,i)=>({...grid()[0],sampleId:'c'+i,planId:'c'+i,
    features:f(null,null,i%2?2:null),actualMs:60000*(i%2?4:9)}));
  const {artifact}=await fitAtlm(rows);
  assert.equal(artifact.p,2);
  assert.equal(artifact.runtime.parallel.varying,false);
  near(minutes(artifact,f(null,null,2)),4);near(minutes(artifact,f()),9);
});

test('unbounded model identifiers cannot allocate an unbounded design matrix',async()=>{
  const rows=Array.from({length:66},(_,i)=>({...grid()[0],sampleId:'l'+i,planId:'l'+i,features:f('model-'+i),actualMs:60000}));
  const result=await fitAtlm(rows);assert.equal(result.reason,'MODEL_CAPACITY_LIMIT');assert.equal(result.limit,64);
});

test('runtime artifact metadata is validated before inference',async()=>{
  const {artifact}=await fitAtlm(grid());
  for(const change of [a=>a.runtime.categories.modelId.weights[0]=-1,a=>a.runtime.parallel.mean=Infinity,a=>delete a.runtime,a=>a.runtime.categories.reasoningEffort.levels.push('extra')]) {
    const bad=JSON.parse(JSON.stringify(artifact));change(bad);assert.equal(predictAtlm(bad,f()).reason,'INVALID_ARTIFACT');
  }
});
