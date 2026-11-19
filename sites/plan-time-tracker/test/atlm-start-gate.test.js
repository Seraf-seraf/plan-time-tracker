import test from 'node:test';
import assert from 'node:assert/strict';
import {context, command, call, mcp, ok, assessForStart, plannedAtlm, taskV4, PLAN} from './fixtures/tracker-db.mjs';

test('first-start errors are receipted, recovery needs a fresh command, frozen input survives replay', async () => {
  const c=context();
  try {
    await ok(c,'CreatePlan',{planId:PLAN,title:'Gate',planCreatedAt:{precision:'dateOnly',on:'2027-01-01',timeZone:'UTC'}});
    const id=crypto.randomUUID(), payload={planId:PLAN};
    const refused=await command(c,'StartPlan',payload,0,id);
    assert.equal(refused.value.error.code,'ASSESSMENT_REQUIRED');
    assert.deepEqual(refused.value.error.details.assessmentReadiness.missingPaths,['assessment']);
    assert.equal(c.db.sqlite.prepare('SELECT status FROM plans').get().status,'PLANNED');
    for(const table of ['work_intervals','plan_estimation_inputs','estimation_jobs'])
      assert.equal(c.db.sqlite.prepare('SELECT count(*) AS n FROM '+table).get().n,0);
    await assessForStart(c);
    const replay=await mcp(c,'StartPlan',{schemaVersion:1,expectedVersion:0,commandId:id,payload});
    assert.equal(replay.value.result.structuredContent.code,'ASSESSMENT_REQUIRED');
    const read=await call(c,'/api/tracker/plans/'+PLAN+'/estimate');
    assert.equal(read.value.assessmentReadiness.status,'READY');
    assert.equal(read.value.serverEstimation.status,'UNAVAILABLE');
    const success=crypto.randomUUID();
    assert.equal((await command(c,'StartPlan',payload,0,success)).status,200);
    assert.equal((await command(c,'StartPlan',payload,0,success)).value.replayed,true);
    const frozen=(await mcp(c,'GetSavedEstimate',payload)).value.result.structuredContent;
    assert.equal(frozen.source,'FROZEN_INPUT'); assert.equal(frozen.serverEstimation.pointMs,null);
    assert.equal(c.db.sqlite.prepare('SELECT count(*) AS n FROM work_intervals').get().n,1);
  }finally{c.close();}
});

test('stored incomplete and invalid inputs return field paths and no first start',async()=>{
  for (const [mutate,code,path] of [
    [t=>{delete t.workUnits;},'ASSESSMENT_INCOMPLETE','workUnits'],
    [t=>{delete t.unknownReasons['execution.modelId'].checkedSource;},'ASSESSMENT_INCOMPLETE','unknownReasons.execution.modelId.checkedSource'],
    [t=>{t.evidence.reuseLevel=" TODO ";},'ASSESSMENT_INCOMPLETE','reuseLevel'],
    [t=>{t.workUnits[0].evidence="evidence";},'ASSESSMENT_INCOMPLETE','workUnits.evidence'],
    [t=>{t.unknownReasons['execution.modelId'].checkedSource="неизвестно";},'ASSESSMENT_INCOMPLETE','execution.modelId'],
    [t=>{t.reuseLevel=8;},'ASSESSMENT_INVALID','reuseLevel'],
    [t=>{t.reuseLevel=1;},'ASSESSMENT_CONTEXT_CHANGED','featureDigest'],
  ]) {
    const c=context();
    try{
      await ok(c,'CreatePlan',{planId:PLAN,title:'Recovery',planCreatedAt:{precision:'dateOnly',on:'2027-01-01',timeZone:'UTC'}});
      await assessForStart(c);
      const db=c.db.sqlite, assessment=JSON.parse(db.prepare('SELECT assessment_json FROM assessment_revisions').get().assessment_json);
      mutate(assessment.context.agentTask);
      db.exec('DROP TRIGGER assessment_immutable_update'); db.prepare('UPDATE assessment_revisions SET assessment_json=?').run(JSON.stringify(assessment));
      const r=await command(c,'StartPlan',{planId:PLAN},0);
      assert.equal(r.value.error.code,code);
      const readiness=r.value.error.details.assessmentReadiness;
      assert.ok([...readiness.missingPaths,...readiness.invalidPaths].includes(path));
      assert.equal(db.prepare('SELECT first_started_at FROM plans').get().first_started_at,null);
    }finally{c.close();}
  }
});

test('superseding revision immediately before the receipt insert rejects the calculated start', async () => {
  const c=context();
  try {
    await ok(c,'CreatePlan',{planId:PLAN,title:'Revision race',planCreatedAt:{precision:'dateOnly',on:'2027-01-01',timeZone:'UTC'}});
    const assessment=await assessForStart(c);
    const batch=c.db.batch.bind(c.db);
    let raced=false;
    c.db.batch=async statements=>{
      if (!raced && statements.some(({sql}) => sql.includes('INSERT OR IGNORE INTO command_receipts') && sql.includes('source.snapshot_key'))) {
        raced=true;
        await ok(c,'RecordAssessment',{...assessment,reason:'Confirm a revised input'},1);
      }
      return batch(statements);
    };
    const rejected=await command(c,'StartPlan',{planId:PLAN},0);
    assert.equal(raced,true);assert.equal(rejected.value.error.code,'ASSESSMENT_CONTEXT_CHANGED');
    assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) AS n FROM work_intervals').get().n,0);
    await ok(c,'StartPlan',{planId:PLAN},0);
    assert.equal((await mcp(c,'GetSavedEstimate',{planId:PLAN})).value.result.structuredContent.assessmentRevision,2);
  } finally {c.close();}
});

test('documented partial knowledge and known access blockers allow first start', async () => {
  const c = context();
  try {
    const {goldenCases, goldenBoundary} = await import('./fixtures/atlm-v4-golden.mjs');
    const task = taskV4();
    task.systemBoundaries = goldenBoundary(goldenCases[3]);
    delete task.evidence.systemBoundaries;
    task.environmentReadiness = 'BLOCKED';
    task.accessReadiness = 'MISSING';
    task.evidence.environmentReadiness = 'Runner health report says the sandbox is offline';
    task.evidence.accessReadiness = 'Access inventory shows no account for the partner API';
    const op = task.systemBoundaries[0].operations[0];
    Object.assign(op, {contractState:'PARTIAL', retryPolicy:'UNKNOWN', accessState:'MISSING'});
    const path = 'systemBoundaries[target].operations[op-0].';
    for (const field of ['contractState', 'retryPolicy']) {
      task.unknownReasons[path + field] = {reason:'Provider omits retry guarantees', checkedSource:'Partner API contract, delivery guarantees'};
    }
    await plannedAtlm(c, PLAN, task);
    const {assessmentReadiness} = (await mcp(c, 'GetSavedEstimate', {planId:PLAN})).value.result.structuredContent;
    assert.equal(assessmentReadiness.status, 'READY');
    assert.ok(assessmentReadiness.unknownPaths.includes(path + 'contractState'));
    assert.ok(assessmentReadiness.unknownPaths.includes(path + 'retryPolicy'));
    await ok(c, 'StartPlan', {planId:PLAN}, 0);
  } finally { c.close(); }
});
