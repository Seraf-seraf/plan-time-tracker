import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {context,ok,call,command,mcp,running,rows,PLAN,OWNER,migrations,atlmTask} from './fixtures/tracker-db.mjs';
import {getEstimationModelStatus,predictWithActiveModel,normalizeAgentTaskV1,readAtlmSampleSource} from '../worker/index.js';

const retiredTables=['step_attempts','tracker_sessions','tracker_journal','tracker_owner_state','tracker_plan_config','step_results','step_checks','step_acceptances','step_source_snapshots','step_source_checks','step_result_snapshots','step_snapshot_checks','plan_events','plan_document_sections','repositories','commits'];
const retiredCommands=['CreateStep','UpdateStep','ClaimStepAttempt','RenewStepLease','CloseStepAttempt','StartStep','BlockStep','RecordStepResult','RecordCheck','AppendObservation'];
const doc='# Plan\n\n## Этап 1. First\nDo first.\n\n## Этап 2. Second\nDo second.';
const create=(c,id=PLAN)=>ok(c,'CreatePlan',{planId:id,title:'Plan',planText:doc,planCreatedAt:{precision:'dateOnly',on:'2026-11-11',timeZone:'UTC'}});

test('steps have only current state; status changes create no event or attempt storage',async()=>{
 const c=context();try{
  await create(c);await ok(c,'StartPlan',{planId:PLAN},0);
  const progress=(await call(c,`/api/tracker/plans/${PLAN}/execution`)).value,step=progress.steps[0];
  let version=step.version;
  for(const status of ['RUNNING','BLOCKED','FAILED','PENDING','DONE']){c.advance(1);await ok(c,'SetStepStatus',{stepId:step.step_id,status},version++);}
  const current=(await call(c,`/api/tracker/plans/${PLAN}/execution`)).value.steps[0];
  assert.equal(current.status,'DONE');assert.equal(current.version,6);assert.equal(current.content,step.content);
  for(const field of ['attempts','execution','resultHistory','currentResult','checks','currentChecks','current_fence'])assert(!Object.hasOwn(current,field),field);
  const tables=c.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
  for(const table of retiredTables)assert(!tables.includes(table),table);
  assert.deepEqual(c.db.sqlite.prepare('SELECT payload_json FROM command_receipts WHERE command_type=?').all('SetStepStatus').map(r=>r.payload_json),Array(5).fill('{}'));
  assert.equal((await call(c,`/api/plans/${PLAN}`)).value.plan.events,undefined);
  assert.equal((await call(c,`/api/tracker/plans/${PLAN}/status-history`)).status,404);
  assert.equal((await call(c,`/api/tracker/plans/${PLAN}/timeline`)).status,404);
 }finally{c.close();}
});

test('all old mutation commands and MCP aliases are absent and cannot replay an old operation',async()=>{
 const c=context();try{
  await create(c);const before=rows(c);
  for(const type of retiredCommands)assert.equal((await command(c,type,{planId:PLAN,stepId:crypto.randomUUID()},1)).status,400,type);
  const tools=(await call(c,'/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'})).value.result.tools.map(t=>t.name);
  for(const name of [...retiredCommands,'AssignStepAttempt','ExtendStepAssignment','SaveStepResult','SaveCheckResult','RecordActivityEvent','GetPlanHistory'])assert(!tools.includes(name),name);
  assert(tools.includes('SetStepStatus'));assert(tools.includes('SaveTaskAssessment'));
  assert.equal((await mcp(c,'GetPlanHistory',{planId:PLAN})).value.result.isError,true);
  assert.deepEqual(rows(c),before);
 }finally{c.close();}
});

test('concurrent status writers use CAS and exact replay; another plan and owner remain isolated',async()=>{
 const c=context();try{
  await create(c);const other=crypto.randomUUID();await create(c,other);await ok(c,'StartPlan',{planId:PLAN},0);await ok(c,'StartPlan',{planId:other},0);
  const step=c.db.sqlite.prepare('SELECT step_id FROM plan_steps WHERE plan_id=? ORDER BY ordinal').get(PLAN).step_id;
  const id=crypto.randomUUID(),payload={stepId:step,status:'DONE'};
  const responses=await Promise.all([command(c,'SetStepStatus',payload,1,id),command(c,'SetStepStatus',payload,1,id)]);
  assert(responses.every(r=>r.status===200));assert.equal(responses.filter(r=>r.value.replayed).length,1);
  assert.equal((await command(c,'SetStepStatus',{stepId:step,status:'FAILED'},1)).status,409);
  assert.equal((await command(c,'SetStepStatus',{stepId:step,status:'FAILED'},2,undefined,'another-owner')).status,404);
  assert(c.db.sqlite.prepare('SELECT status FROM plan_steps WHERE plan_id=?').all(other).every(s=>s.status==='PENDING'));
  assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM work_intervals WHERE end_ms IS NULL').get().n,2);
 }finally{c.close();}
});

test('status changes and timer commands remain atomic when a receipt or interval write fails',async()=>{
 const c=context();try{
  await create(c);await ok(c,'StartPlan',{planId:PLAN},0);const step=c.db.sqlite.prepare('SELECT step_id FROM plan_steps WHERE plan_id=?').get(PLAN).step_id;
  const before=rows(c);c.db.sqlite.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE OF outcome_code ON command_receipts WHEN NEW.command_type='SetStepStatus' BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.equal((await command(c,'SetStepStatus',{stepId:step,status:'DONE'},1)).status,500);assert.deepEqual(rows(c),before);
  c.db.sqlite.exec('DROP TRIGGER fail_receipt;');
  c.db.sqlite.exec("CREATE TRIGGER fail_interval BEFORE UPDATE ON work_intervals BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.equal((await command(c,'PausePlan',{planId:PLAN},1)).status,500);assert.deepEqual(rows(c),before);
 }finally{c.close();}
});

test('completion requires current DONE states; explicit exception, deletion and restoration retain their behavior',async()=>{
 const c=context();try{
  const binding=await running(c,[]);c.advance(100);
  assert.equal((await command(c,'FinishPlan',{planId:PLAN},1)).value.error.code,'CHECKPOINTS_INCOMPLETE');
  await ok(c,'SetStepStatus',{...binding,status:'DONE'},2);
  await ok(c,'PausePlan',{planId:PLAN},1);c.advance(50);await ok(c,'FinishPlan',{planId:PLAN},2);
  assert.equal((await call(c,`/api/plans/${PLAN}`)).value.plan.activeMs,100);
  const second=crypto.randomUUID();await create(c,second);await ok(c,'StartPlan',{planId:second},0);await ok(c,'FinishPlan',{planId:second,allowIncomplete:true,reason:'Explicit stop'},1);
  assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM tracker_finish_exceptions').get().n,1);
  const third=crypto.randomUUID();await create(c,third);await ok(c,'StartPlan',{planId:third},0);await ok(c,'DeletePlan',{planId:third},1);await ok(c,'RestorePlan',{planId:third},2);
  assert.equal((await call(c,`/api/plans/${third}`)).value.plan.status,'PAUSED');
  assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM work_intervals WHERE end_ms IS NULL').get().n,0);
 }finally{c.close();}
});

const fixture=JSON.parse(readFileSync(new URL('./fixtures/pre-simple-data.json',import.meta.url),'utf8'));
test('timer transitions reject inconsistent intervals instead of completing or resuming corrupted state',async()=>{
 const c=context();try{
  await running(c);const step=c.db.sqlite.prepare('SELECT step_id,version FROM plan_steps WHERE plan_id=?').get(PLAN);await ok(c,'SetStepStatus',{stepId:step.step_id,status:'DONE'},step.version);
  c.db.sqlite.prepare('DELETE FROM work_intervals WHERE plan_id=?').run(PLAN);
  assert.equal((await command(c,'FinishPlan',{planId:PLAN},1)).status,409);assert.equal((await call(c,`/api/plans/${PLAN}`)).value.plan.status,'RUNNING');
  c.db.sqlite.prepare("UPDATE plans SET status='PAUSED' WHERE plan_id=?").run(PLAN);
  assert.equal((await command(c,'ResumePlan',{planId:PLAN},1)).status,409);assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM work_intervals').get().n,0);
 }finally{c.close();}
});
function populatedContext(paths){
 const boundary=paths.findIndex(path=>String(path).endsWith('0021_simple_steps.sql'));
 assert(boundary>=0);const c=context(0);for(const path of paths.slice(0,boundary))c.db.sqlite.exec(readFileSync(path,'utf8'));
 const triggers=c.db.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
 for(const t of triggers)c.db.sqlite.exec(`DROP TRIGGER "${t.name}"`);
 c.db.sqlite.exec('PRAGMA foreign_keys=OFF;');
 for(const [table,data] of Object.entries(fixture.data))for(const row of data){const entries=Object.entries(row).map(([key,value])=>[key==='_rowid'?'rowid':key,value]);c.db.sqlite.prepare(`INSERT INTO "${table}"(${entries.map(([key])=>`"${key}"`).join(',')}) VALUES(${entries.map(()=>'?').join(',')})`).run(...entries.map(([,value])=>value));}
 for(const t of triggers)c.db.sqlite.exec(t.sql);
 c.db.sqlite.exec('PRAGMA foreign_keys=ON;');assert.deepEqual(c.db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);c.advance(fixture.now-c.now());return c;
}
const canonicalDirectory=new URL('../drizzle/',import.meta.url);
const canonicalPaths=migrations.map(name=>new URL(name,canonicalDirectory));
const chains=[['canonical',canonicalPaths]];
if(process.env.SITES_SOURCE_ROOT){const dir=resolve(process.env.SITES_SOURCE_ROOT,'drizzle');chains.push(['Sites',readdirSync(dir).filter(n=>n.endsWith('.sql')).sort().map(n=>resolve(dir,n))]);}
for(const [name,paths] of chains)test(`${name} populated migration deletes the old model and preserves active plans, requirements, timers and ATLM artifacts`,async()=>{
 const c=populatedContext(paths);try{
  const preserved=['plans','work_intervals','plan_documents','plan_date_history','assessment_revisions','plan_estimation_inputs','estimation_samples','estimation_models','estimation_owner_state','estimation_jobs'];
  const before=Object.fromEntries(preserved.map(t=>[t,c.db.sqlite.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]));
  const requirements=c.db.sqlite.prepare('SELECT * FROM assessment_targets ORDER BY owner_id,plan_id,step_id').all(),steps=c.db.sqlite.prepare('SELECT owner_id,step_id,plan_id,ordinal,title,status,version FROM plan_steps ORDER BY step_id').all();
  c.db.sqlite.exec('BEGIN;');const sql=paths.slice(paths.findIndex(path=>String(path).endsWith('0021_simple_steps.sql'))).map(path=>readFileSync(path,'utf8')).join('\n');
  if(name==='Sites')await c.db.batch(sql.split('--> statement-breakpoint').filter(s=>s.trim()).map(s=>c.db.prepare(s)));
  else c.db.sqlite.exec(sql);
  assert.deepEqual(c.db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);c.db.sqlite.exec('COMMIT;');
  for(const table of preserved)assert.deepEqual(c.db.sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),before[table],table);
  assert.deepEqual(c.db.sqlite.prepare('SELECT * FROM assessment_targets ORDER BY owner_id,plan_id,step_id').all(),requirements);
  assert.deepEqual(c.db.sqlite.prepare('SELECT owner_id,step_id,plan_id,ordinal,title,status,version FROM plan_steps ORDER BY step_id').all(),steps);
  const status=await getEstimationModelStatus(c.db,fixture.owner,c.now());assert.equal(status.activeModel.sampleCount,15);assert.equal(status.eligibleSampleCount,15);
  assert.equal((await predictWithActiveModel(c.db,fixture.owner,normalizeAgentTaskV1(atlmTask()).features,c.now())).pointMs,1000);
  const completed=before.plans.find(p=>p.status==='COMPLETED'),source=await readAtlmSampleSource(c.db,fixture.owner,completed.plan_id,c.now());assert.equal(source.eligibility,'ELIGIBLE');assert.equal(source.actualMs,1000);
  const current=(await call(c,`/api/tracker/plans/${fixture.runningPlanId}/execution`)).value;assert.equal(current.plan.status,'RUNNING');assert.equal(current.steps[0].status,'RUNNING');assert.equal(current.steps[0].content,'Original expected result');
  c.advance(25);await ok(c,'SetStepStatus',{stepId:current.steps[0].step_id,status:'DONE'},current.steps[0].version);await ok(c,'FinishPlan',{planId:fixture.runningPlanId},current.plan.version);
  assert.equal((await call(c,`/api/plans/${fixture.runningPlanId}`)).value.plan.activeMs,50);
  assert.deepEqual(c.db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{c.close();}
});
