import test from 'node:test';
import assert from 'node:assert/strict';
import {context, migrations, migration, envelope, call, command, ok, mcp, assessForStart, PLAN, OWNER} from './fixtures/tracker-db.mjs';

test('0027 retains owner data, v3 provenance and receipts, resets training and permits legacy resume', async () => {
  const name = '0027_agent_task_v4_gate.sql', c = context(migrations.indexOf(name));
  try {
    const db = c.db.sqlite;
    db.exec('PRAGMA foreign_keys=ON');
    const paused = crypto.randomUUID();
    for (const [planId, owner] of [[PLAN,OWNER],[paused,'owner-2']]) {
      assert.equal((await call(c,'/api/commands',envelope('CreatePlan',{planId,title:'Migration',planText:'## Этап 1. Миграция\nПроверка',planCreatedAt:{precision:'dateOnly',on:'2027-01-01',timeZone:'UTC'}}),owner)).status,200);
    }
    db.prepare("UPDATE plans SET status='PAUSED',first_started_at=?,version=2 WHERE plan_id=?").run(c.now(),paused);
    db.prepare("INSERT INTO work_intervals(interval_id,owner_id,plan_id,start_ms,end_ms,opened_by,closed_by) VALUES('old','owner-2',?,?,?,'owner-2','owner-2')").run(paused,c.now(),c.now()+100);
    const old = envelope('RecordAssessment',{context:{agentTask:{schemaVersion:'agent-task-v3'}}},0);
    const {payloadHash} = await import('../worker/index.js');
    db.prepare("INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,result_json,recorded_at) VALUES(?,?,?,'RecordAssessment',?,0,?,?,'agent','{}','OK','{}',?)")
      .run(OWNER,old.commandId,await payloadHash(old),PLAN,c.now(),OWNER,c.now());
    db.prepare("INSERT INTO assessment_revisions(owner_id,assessment_id,revision,plan_id,author_id,recorded_at,command_id,requirements_json,requirements_digest,assessment_json) SELECT ?,?,1,?,?,?, ?,requirements_json,'old',? FROM assessment_targets WHERE plan_id=? AND step_id IS NULL").run(OWNER,crypto.randomUUID(),PLAN,OWNER,c.now(),old.commandId,JSON.stringify(old.payload),PLAN);
    db.prepare(`INSERT INTO estimation_models(owner_id,model_id,model_version,status,manifest_json,dataset_digest,train_cutoff,sample_count,created_at,method_version,feature_version)
      VALUES(?,'old',1,'ACTIVE','[]','legacy',0,0,0,'agent-v4-probabilistic','agent-task-v3')`).run(OWNER);
    db.prepare("INSERT OR REPLACE INTO estimation_owner_state(owner_id,active_model_id) VALUES(?,'old')").run(OWNER);
    db.prepare("INSERT INTO estimation_training_attempts(owner_id,attempt_id,started_at,method_version,feature_version,dataset_revision,manifest_json) VALUES(?,'old',0,'old','agent-task-v3',0,'[]')").run(OWNER);
    db.prepare(`INSERT INTO estimation_samples(owner_id,plan_id,input_assessment_sequence,source_digest,source_generation,eligibility,reasons_json,features_json,actual_ms,captured_at,source_available_at,observed_at,is_first_eligible)
      SELECT owner_id,plan_id,sequence,'old',1,'ELIGIBLE','[]','{"integrations.USE":1}',0,0,0,0,1 FROM assessment_revisions`).run();
    const records = () => ['owners','plans','plan_steps','work_intervals','command_receipts','assessment_revisions'].map(table=>db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());
    const before = records();
    db.exec('BEGIN'); db.exec(migration(name)); db.exec('COMMIT');
    assert.deepEqual(records(),before);
    for(const table of ['plan_estimation_inputs','estimation_samples','estimation_models','estimation_jobs','estimation_training_attempts'])
      assert.equal(db.prepare('SELECT count(*) AS n FROM '+table).get().n,0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal((await call(c,'/api/commands',old)).value.replayed,true);
    assert.equal((await mcp(c,'GetSavedEstimate',{planId:PLAN})).value.result.structuredContent.assessmentReadiness.status,'OUTDATED');
    assert.equal((await command(c,'StartPlan',{planId:PLAN},0)).value.error.code,'ASSESSMENT_SCHEMA_OUTDATED');
    c.advance(200);
    assert.equal((await command(c,'ResumePlan',{planId:paused},2,undefined,'owner-2')).status,200);
    await assessForStart(c); await ok(c,'StartPlan',{planId:PLAN},0);
    const snapshot = () => ['estimation_owner_state','estimation_jobs','plan_estimation_inputs','assessment_revisions','command_receipts','work_intervals'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all());
    const v4=snapshot();
    db.exec('BEGIN'); db.exec(migration(name)); db.exec('COMMIT');
    assert.deepEqual(snapshot(),v4);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {c.close();}
});
