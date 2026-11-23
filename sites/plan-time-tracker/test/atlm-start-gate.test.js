import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAtlm, normalizeAgentTask } from '../worker/atlm/model.js';
import {context, command, call, mcp, ok, assessForStart, plannedAtlm, completeAtlm, atlmAssessment, taskV4, OWNER, PLAN} from './fixtures/tracker-db.mjs';

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
    const prepare=c.db.prepare.bind(c.db);
    let raced=false;
    c.db.prepare=sql=>{
      const stmt=prepare(sql);
      if (!raced && sql.includes('INSERT OR IGNORE INTO command_receipts') && sql.includes('source.snapshot_key')) {
        const bind=stmt.bind.bind(stmt);
        stmt.bind=(...args)=>{const bound=bind(...args), run=bound.run.bind(bound);
          bound.run=async()=>{raced=true;await ok(c,'RecordAssessment',{...assessment,reason:'Confirm a revised input'},1);return run();};
          return bound;};
      }
      return stmt;
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

async function registerRaceModel(c) {
  const db = c.db.sqlite;
  const modelRevisionId = 'race-model';
  const features = normalizeAgentTask(taskV4()).features;
  const examples = [];
  for (const actualMs of [1000, 2000]) {
    const plan = await plannedAtlm(c, crypto.randomUUID());
    await completeAtlm(c, plan, actualMs);
    examples.push({ planId: plan.planId, sampleId: String(examples.length + 1), features, actualMs,
      capturedAt: c.now() - actualMs, sourceAvailableAt: c.now() });
    c.advance(1);
  }
  const fitted = await fitAtlm(examples);
  assert.equal(fitted.status, 'AVAILABLE');
  const { artifact } = fitted;
  db.prepare(`INSERT INTO estimation_model_revisions(owner_id,model_revision_id,model_version,origin,
    method_version,feature_version,registered_at,artifact_json,manifest_json,provenance_json,fit_count,source_count,supported)
    VALUES(?,?,1,'IMPORTED',?,?,?,?,?,'{}',?,?,1)`)
    .run(OWNER, modelRevisionId, artifact.method.version, artifact.featureSchemaVersion, c.now(),
      JSON.stringify(artifact), JSON.stringify(artifact.manifest), artifact.n, examples.length);
  const insert = db.prepare(`INSERT INTO estimation_model_revision_sources(owner_id,model_revision_id,plan_id,source_generation,ordinal)
    VALUES(?,?,?,(SELECT generation FROM estimation_jobs WHERE owner_id=? AND job_key='refresh:'||?),?)`);
  for (const [ordinal, { planId }] of examples.entries()) insert.run(OWNER, modelRevisionId, planId, OWNER, planId, ordinal);
  return { modelRevisionId, sourcePlanId: examples[0].planId };
}

function beforeReceipt(c, marker, action) {
  const prepare = c.db.prepare;
  const restore = () => { c.db.prepare = prepare; };
  let ran = false;
  c.db.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (!sql.includes('INSERT OR IGNORE INTO command_receipts') || !sql.includes(marker)) return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...args) => {
      const bound = bind(...args);
      const run = bound.run.bind(bound);
      bound.run = async () => {
        ran = true;
        restore();
        await action();
        return run();
      };
      return bound;
    };
    return statement;
  };
  return { ran: () => ran, restore };
}

for (const commandType of ['RecordAssessment', 'StartPlan']) {
  for (const change of ['activation', 'source generation']) {
    test(`${commandType} cannot commit a forecast across a change in ${change}`, async () => {
      const c = context();
      try {
        const db = c.db.sqlite;
        const { modelRevisionId, sourcePlanId } = await registerRaceModel(c);
        const activate = () => db.prepare('INSERT INTO estimation_active_revisions VALUES(?,?,1)').run(OWNER, modelRevisionId);
        if (change === 'source generation') activate();
        await plannedAtlm(c);
        const before = (await mcp(c, 'GetSavedEstimate', { planId: PLAN })).value.result.structuredContent.serverEstimation;
        assert.equal(before.modelRevisionId ?? null, change === 'activation' ? null : modelRevisionId);
        const assessment = commandType === 'RecordAssessment';
        const payload = assessment
          ? await atlmAssessment(c, PLAN, taskV4(), {
            reason: 'Refresh the forecast', predictionRequest: { method: 'ATLM', methodVersion: 1 },
          })
          : { planId: PLAN };
        const beforeRevisions = db.prepare('SELECT count(*) n FROM assessment_revisions WHERE plan_id=?').get(PLAN).n;
        const race = beforeReceipt(c, assessment ? 'snapshot_key=?) THEN' : 'source.snapshot_key', async () => {
          if (change === 'activation') activate();
          else await ok(c, 'DeletePlan', { planId: sourcePlanId }, 2);
        });
        const commandId = crypto.randomUUID();
        let rejected;
        try { rejected = await command(c, commandType, payload, 0, commandId); }
        finally { race.restore(); }
        assert.equal(race.ran(), true, JSON.stringify(rejected.value));
        const errorCode = assessment ? 'ATLM_MODEL_CHANGED' : 'ASSESSMENT_CONTEXT_CHANGED';
        assert.equal(rejected.value.error.code, errorCode);
        assert.equal(db.prepare('SELECT count(*) n FROM assessment_revisions WHERE plan_id=?').get(PLAN).n, beforeRevisions);
        assert.equal(db.prepare('SELECT count(*) n FROM work_intervals WHERE plan_id=?').get(PLAN).n, 0);
        assert.equal(db.prepare('SELECT count(*) n FROM plan_estimation_inputs WHERE plan_id=?').get(PLAN).n, 0);
        await ok(c, commandType, payload, 0);
        const after = assessment
          ? JSON.parse(db.prepare('SELECT assessment_json FROM assessment_revisions WHERE plan_id=? ORDER BY sequence DESC').get(PLAN).assessment_json).serverEstimation
          : JSON.parse(db.prepare('SELECT forecast_json FROM plan_estimation_inputs WHERE plan_id=?').get(PLAN).forecast_json);
        assert.equal(after.modelRevisionId ?? null, change === 'activation' ? modelRevisionId : null);
        const replay = await command(c, commandType, payload, 0, commandId);
        assert.equal(replay.value.error.code, errorCode);
      } finally { c.close(); }
    });
  }
}
