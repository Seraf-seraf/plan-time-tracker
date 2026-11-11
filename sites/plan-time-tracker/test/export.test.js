import test from 'node:test';
import assert from 'node:assert/strict';
import {context,ok,call,running,atlmAssessment,rows,PLAN,OWNER} from './fixtures/tracker-db.mjs';

test('export v2 contains current text/statuses and assessment requirements without attempt or status histories',async()=>{
 const c=context();try{
  const step=await running(c);await ok(c,'RecordAssessment',await atlmAssessment(c),0);c.advance(100);
  await ok(c,'SetStepStatus',{...step,status:'BLOCKED'},2);await ok(c,'SetStepStatus',{...step,status:'DONE'},3);await ok(c,'FinishPlan',{planId:PLAN},1);
  const before=rows(c),report=(await call(c,'/api/export')).value;
  assert.equal(report.formatVersion,2);assert.equal(report.plans.length,1);const plan=report.plans[0];
  assert.equal(plan.status,'COMPLETED');assert.equal(plan.activeMs,100);assert.equal(plan.steps[0].status,'DONE');assert.equal(plan.steps[0].version,4);assert.match(plan.steps[0].content,/Checked source/);
  assert.equal(plan.assessments.length,1);assert.equal(plan.assessments[0].assessment.context.agentTask.schemaVersion,'agent-task-v1');
  const forbidden=new Set(['attempts','timeline','journal','events','checks','resultHistory','currentFence','currentResultRevision','leaseUntil','fence']);
  function inspect(value){if(Array.isArray(value))value.forEach(inspect);else if(value&&typeof value==='object')for(const [key,child]of Object.entries(value)){assert(!forbidden.has(key),key);inspect(child);}}inspect(report);
  assert.deepEqual(rows(c),before);
 }finally{c.close();}
});

test('export unions concurrent plans, preserves measured zero, excludes deleted totals and isolates owners',async()=>{
 const c=context();try{
  await running(c,[],PLAN);c.advance(500);const other=crypto.randomUUID();await running(c,[],other);c.advance(500);
  const foreign=crypto.randomUUID();await call(c,'/api/commands',{schemaVersion:1,commandId:crypto.randomUUID(),commandType:'CreatePlan',payload:{planId:foreign,title:'Foreign',planCreatedAt:{precision:'dateOnly',on:'2026-11-11',timeZone:'UTC'}}},'foreign-owner');
  let report=(await call(c,'/api/export')).value;assert.equal(report.summary.totalActiveMs,1000);assert.equal(report.summary.sumPlanActiveMs,1500);assert.equal(report.plans.length,2);
  await ok(c,'DeletePlan',{planId:PLAN},1);report=(await call(c,'/api/export')).value;
  assert.equal(report.summary.planCount,1);assert.equal(report.summary.deletedPlanCount,1);assert.equal(report.summary.totalActiveMs,500);assert(report.plans.some(p=>p.planId===PLAN&&p.deletedAt!=null));
  const fresh=crypto.randomUUID();await ok(c,'CreatePlan',{planId:fresh,title:'Zero',planCreatedAt:{precision:'dateOnly',on:'2026-11-11',timeZone:'UTC'}});await ok(c,'StartPlan',{planId:fresh},0);await ok(c,'FinishPlan',{planId:fresh},1);
  assert.equal((await call(c,'/api/export')).value.plans.find(p=>p.planId===fresh).activeMs,0);
 }finally{c.close();}
});

test('export keeps explicit finish reasons and date precision without historical step snapshots',async()=>{
 const c=context();try{
  await running(c);await ok(c,'FinishPlan',{planId:PLAN,allowIncomplete:true,reason:'User requested stop'},1);
  const plan=(await call(c,'/api/export')).value.plans[0];
  assert.deepEqual(plan.planCreatedAt,{precision:'dateOnly',on:'2026-10-01',timeZone:'UTC'});
  assert.deepEqual(plan.finishExceptions,[{reason:'User requested stop',recordedAt:c.now()}]);
  assert.equal(c.db.sqlite.prepare('PRAGMA table_info(tracker_finish_exceptions)').all().some(c=>c.name==='snapshot_json'),false);
 }finally{c.close();}
});

test('export for a new owner is read-only and has an explicit empty measurement',async()=>{
 const c=context();try{
  const before=rows(c),report=(await call(c,'/api/export',undefined,'new-owner')).value;
  assert.equal(report.formatVersion,2);assert.deepEqual(report.plans,[]);assert.equal(report.summary.totalActiveMs,null);assert.equal(report.summary.planCount,0);assert.deepEqual(rows(c),before);
 }finally{c.close();}
});

test('export reads collections in one snapshot before a concurrent pause finishes',async()=>{
 const c=context();try{
  await running(c);c.advance(100);const prepare=c.db.prepare.bind(c.db);let intercepted=false;
  c.db.prepare=sql=>{const stmt=prepare(sql),bind=stmt.bind.bind(stmt);stmt.bind=(...args)=>{const bound=bind(...args);if(sql.includes("'documents' AS kind")&&!intercepted){const all=bound.all.bind(bound);bound.all=async()=>{intercepted=true;const snapshot=await all();c.advance(100);await ok(c,'PausePlan',{planId:PLAN},1);return snapshot;};}return bound;};return stmt;};
  const report=(await call(c,'/api/export')).value;assert(intercepted);assert.equal(report.plans[0].status,'RUNNING');assert.equal(report.plans[0].intervals[0].endMs,null);assert.equal(report.exportedAt,c.now());
  c.db.prepare=prepare;const current=(await call(c,'/api/export')).value;assert.equal(current.plans[0].status,'PAUSED');assert.equal(current.plans[0].intervals[0].endMs,c.now());
 }finally{c.close();}
});
