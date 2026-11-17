import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {context,call,mcp,ok,PLAN} from '../../../sites/plan-time-tracker/test/fixtures/tracker-db.mjs';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const assess=read('../skills/assess-task/SKILL.md'),features=read('../skills/assess-task/references/features.md');
const track=read('../skills/track-plan/SKILL.md'),embedded=read('../../../sites/plan-time-tracker/skill/plan-time-tracker/SKILL.md');
const invoke=async(c,name,args={})=>{const r=await mcp(c,name,args);assert.equal(r.status,200);assert.notEqual(r.value.result?.isError,true,JSON.stringify(r.value));return r.value.result.structuredContent;};

test('instructions describe the delivered v4 input and server forecast',()=>{
 for(const text of [assess,track,embedded]){assert.match(text,/assessments\.atlm/);assert.match(text,/StartPlan/);assert.match(text,/serverEstimation/);assert.match(text,/agent-task-v4/);}
 for(const field of ['workUnits','doneBoundary','reuseLevel','components','contracts','systemBoundaries','migrationEntities','dataVolumeBand','requirementsUncertainty','solutionUncertainty','diagnosisState','learningTargets','scopeChangeRisk','verificationKinds','verificationScenarios','verificationReadiness','requiredReviewPasses','environmentReadiness','accessReadiness','deploymentTargets','execution','evidence','unknownReasons'])assert(features.includes('`'+field+'`'),field);
 assert.match(assess,/GetTrainingHistory/);assert.match(assess,/intervalCoverage/);assert.match(assess,/historical-median/);assert.match(assess,/не является календарным сроком/);
 assert.doesNotMatch(assess+features+track+embedded,/agent-task-v1|agent-v3-hybrid|qualityConfirmed|24000/);
});

test('MCP discovery matches the instructions',async()=>{
 const c=context();try{
  const capability=(await invoke(c,'GetTrackerInfo')).assessments.atlm;
  assert.equal(capability.retrainEveryNewPlans,2);assert.equal(capability.featureSchemaVersion,'agent-task-v4');assert.equal(capability.inputSchemaVersion,'agent-task-v4');
  assert.equal(capability.method.version,'agent-v5-operations');assert.equal(capability.policyVersion,2);assert.deepEqual(capability.engines,['OLS','RIDGE','BAYESIAN']);
  const listing=(await call(c,'/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'})).value.result.tools;
  for(const name of ['EstimatePlanTime','GetSavedEstimate','GetTrainingStatus','GetTrainingData','GetTrainingHistory','ContinueTraining']){
   assert(JSON.stringify(capability).includes(name));const tool=listing.find(t=>t.name===name);assert(tool,name);assert.equal(tool.inputSchema.additionalProperties,false);assert.equal(tool.annotations.readOnlyHint,name!=='ContinueTraining');
  }
  const schema=listing.find(t=>t.name==='EstimatePlanTime').inputSchema;assert.deepEqual([...schema.required].sort(),['agentTask','expectedRequirementsDigest','planId']);
  const props=schema.properties.agentTask.properties;
  assert.deepEqual(props.execution.properties.environmentId.enum,['local','cloud_workspace']);
  assert.deepEqual(props.systemBoundaries.items.properties.operations.items.properties.action.enum,['READ','WRITE']);
  assert.deepEqual(props.learningTargets.items.properties.kind.enum,['TOOLING','RUNTIME','DATA_MODEL','OTHER']);
  assert.equal(capability.firstStartRequires,'READY');
 }finally{c.close();}
});

test('documented example is accepted, stored and frozen',async()=>{
 const c=context();try{
  const match=features.match(/```json\s*([\s\S]*?)```/);assert(match);const agentTask=JSON.parse(match[1]);
  await ok(c,'CreatePlan',{planId:PLAN,title:'Документированный пример',planText:'# Example\n\n## Этап 1. Проверить\nГотово.',planCreatedAt:{precision:'dateOnly',on:'2026-11-11',timeZone:'UTC'}});
  const current=await invoke(c,'GetTaskAssessment',{planId:PLAN}),expectedRequirementsDigest=current.currentRequirementsDigest;
  const preview=await invoke(c,'EstimatePlanTime',{planId:PLAN,expectedRequirementsDigest,agentTask});assert.equal(preview.status,'UNAVAILABLE');assert.equal(preview.interval.status,'UNAVAILABLE');
  const assessmentId=crypto.randomUUID(),payload={assessmentId,planId:PLAN,expectedRequirementsDigest,phase:'planning',context:{agentTask},method:{id:'qualitative',version:'1',scale:['UNKNOWN']},
   complexity:{status:'UNKNOWN',value:null,rationale:'No scale'},unknowns:[],assumptions:[],dependencies:[],forecast:{status:'UNKNOWN',metric:'PLAN_ACTIVE',lowerMs:null,upperMs:null,confidence:'UNKNOWN',basis:'Server forecast',sampleCount:0},sources:[],approach:{description:'Update',rationale:'Existing path'},predictionRequest:{method:'ATLM',methodVersion:1}};
  await invoke(c,'SaveTaskAssessment',{schemaVersion:1,commandId:crypto.randomUUID(),expectedVersion:0,payload});
  const saved=await invoke(c,'GetTaskAssessment',{planId:PLAN,assessmentId});assert.deepEqual(saved.assessment.context.agentTask,agentTask);
  await ok(c,'StartPlan',{planId:PLAN},0);const frozen=await invoke(c,'GetSavedEstimate',{planId:PLAN});assert.equal(frozen.source,'FROZEN_INPUT');
 }finally{c.close();}
});
