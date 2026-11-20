import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { payloadHash, claimAtlmJob } from '../worker/index.js';
import { assessForStart, context, migrations, migration, ok, call, mcp, envelope, command, taskV4, atlmAssessment, PLAN, OWNER } from './fixtures/tracker-db.mjs';

const resetUrl = new URL('../drizzle/0026_atlm_v4_reset.sql', import.meta.url);
const snapshot = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }));

test('v4 reset removes old estimation data while retaining plans, time and receipt identity', async () => {
  const index = migrations.indexOf('0026_atlm_v4_reset.sql');
  const c = context(index < 0 ? migrations.length : index);
  try {
    c.db.sqlite.exec('PRAGMA foreign_keys=ON');
    await ok(c, 'CreatePlan', { planId: PLAN, title: 'Preserve plan', planText: '# Plan\n\n## Этап 1. Работа\nТекст',
      planCreatedAt: { precision: 'dateOnly', on: '2027-01-01', timeZone: 'UTC' } });
    const secondPlan = '77777777-7777-4777-8777-777777777777';
    const second = await call(c, '/api/commands', envelope('CreatePlan', { planId: secondPlan, title: 'Other owner',
      planText: '# Other\n\n## Этап 1. Работа\nТекст', planCreatedAt: { precision: 'dateOnly', on: '2027-01-01', timeZone: 'UTC' } }), 'second-owner');
    assert.equal(second.status, 200);
    const db = c.db.sqlite, oldCommand = '99999999-9999-4999-8999-999999999999', assessmentId = '88888888-8888-4888-8888-888888888888';
    const oldEnvelope = { schemaVersion: 1, commandId: oldCommand, commandType: 'RecordAssessment', expectedVersion: 0,
      payload: { context: { agentTask: { schemaVersion: 'agent-task-v1', old: 'old-marker' } } } };
    const originalHash = await payloadHash(oldEnvelope);
    db.prepare(`INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,result_json,recorded_at)
      VALUES(?,?,?,'RecordAssessment',?,0,?,?, 'agent', ?, 'OK', ?, ?)`).run(OWNER, oldCommand, originalHash, PLAN, c.now(), OWNER,
      '{"secretOldFeature":"old-marker"}', '{"oldForecast":"old-marker"}', c.now());
    db.prepare(`INSERT INTO assessment_revisions(owner_id,assessment_id,revision,plan_id,author_id,recorded_at,command_id,requirements_json,requirements_digest,assessment_json)
      SELECT ?,?,1,?,?,?, ?,requirements_json,'old-digest',? FROM assessment_targets WHERE owner_id=? AND plan_id=? AND step_id IS NULL`)
      .run(OWNER, assessmentId, PLAN, OWNER, c.now(), oldCommand, '{"context":{"agentTask":{"schemaVersion":"agent-task-v1","old":"old-marker"}}}', OWNER, PLAN);
    const secondCommand = '33333333-3333-4333-8333-333333333333';
    db.prepare(`INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,result_json,recorded_at)
      VALUES('second-owner',?,'second-hash','RecordAssessment',?,0,?,'second-owner','agent','{"old":"old-marker"}','OK','{}',?)`)
      .run(secondCommand, secondPlan, c.now(), c.now());
    db.prepare(`INSERT INTO assessment_revisions(owner_id,assessment_id,revision,plan_id,author_id,recorded_at,command_id,requirements_json,requirements_digest,assessment_json)
      SELECT 'second-owner','second-assessment',1,?,'second-owner',?, ?,requirements_json,'old-digest',?
      FROM assessment_targets WHERE owner_id='second-owner' AND plan_id=? AND step_id IS NULL`)
      .run(secondPlan, c.now(), secondCommand, '{"context":{"agentTask":{"schemaVersion":"agent-task-v1","old":"old-marker"}}}', secondPlan);
    db.prepare("UPDATE plans SET status='RUNNING',first_started_at=?,version=1 WHERE owner_id='second-owner' AND plan_id=?").run(c.now(), secondPlan);
    db.prepare('INSERT INTO work_intervals(interval_id,owner_id,plan_id,start_ms,opened_by) VALUES(?,?,?,?,?)')
      .run('second-interval', 'second-owner', secondPlan, c.now(), 'second-owner');
    db.prepare("UPDATE plans SET status='RUNNING',first_started_at=?,version=1 WHERE owner_id=? AND plan_id=?").run(c.now(), OWNER, PLAN);
    db.prepare('INSERT INTO work_intervals(interval_id,owner_id,plan_id,start_ms,opened_by) VALUES(?,?,?,?,?)').run('old-interval', OWNER, PLAN, c.now(), OWNER);
    db.prepare('UPDATE estimation_jobs SET fence=42 WHERE owner_id=? AND plan_id=?').run(OWNER, PLAN);
    const sequence = db.prepare('SELECT sequence FROM assessment_revisions WHERE assessment_id=?').get(assessmentId).sequence;
    const sample = db.prepare(`INSERT INTO estimation_samples(owner_id,plan_id,input_assessment_sequence,source_digest,source_generation,
      eligibility,reasons_json,features_json,issued_prediction_json,actual_ms,captured_at,source_available_at,observed_at,is_first_eligible)
      VALUES(?,?,?,'old-source',1,'ELIGIBLE','[]','{"old":"old-marker"}','{"old":"old-marker"}',100,?,?,?,1)`)
      .run(OWNER, PLAN, sequence, c.now(), c.now(), c.now()).lastInsertRowid;
    db.prepare(`INSERT INTO estimation_models(owner_id,model_id,model_version,status,artifact_json,manifest_json,dataset_digest,train_cutoff,sample_count,created_at)
      VALUES(?,'old-model',1,'ACTIVE','{"old":"old-marker"}',?,'old-digest',?,1,?)`)
      .run(OWNER, JSON.stringify([Number(sample)]), c.now(), c.now());
    db.prepare("UPDATE estimation_owner_state SET active_model_id='old-model',last_training_diagnostics_json='\"old-marker\"' WHERE owner_id=?").run(OWNER);
    const startId = '66666666-6666-4666-8666-666666666666';
    db.prepare(`INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,result_json,recorded_at)
      VALUES(?,?,?,'StartPlan',?,0,?,?,'agent',?,'OK',?,?)`)
      .run(OWNER,startId,'start-hash',PLAN,c.now(),OWNER,'{"atlmStartForecast":{"estimation":"old-marker"}}','{"status":"RUNNING"}',c.now());
    const before = Object.fromEntries(['plans','plan_steps','work_intervals','assessment_targets'].map(table => [table, snapshot(db, table)]));
    const sql = readFileSync(resetUrl, 'utf8');
    db.exec('SAVEPOINT migration');
    try { db.exec(sql); db.exec('RELEASE migration'); } catch (error) { db.exec('ROLLBACK TO migration; RELEASE migration'); throw error; }
    for (const [table, values] of Object.entries(before)) assert.deepEqual(snapshot(db, table), values, table);
    for (const table of ['assessment_revisions','plan_estimation_inputs','estimation_samples','estimation_models','estimation_jobs']) assert.equal(snapshot(db, table).length, 0, table);
    const receipt = db.prepare('SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?').get(OWNER, oldCommand);
    assert.equal(receipt.payload_hash, originalHash); assert.equal(receipt.outcome_code, 'ASSESSMENT_SCHEMA_RETIRED');
    assert.ok(!JSON.stringify(receipt).includes('old-marker'));
    const startReceipt = db.prepare('SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?').get(OWNER, startId);
    assert.equal(startReceipt.payload_hash, 'start-hash'); assert.equal(startReceipt.outcome_code, 'OK');
    assert.ok(!JSON.stringify(startReceipt).includes('old-marker'));
    assert.ok(!JSON.stringify(snapshot(db, 'estimation_owner_state')).includes('old-marker'));
    assert.equal(snapshot(db, 'estimation_owner_state').length, 2);
    const beforeOldTraining = db.prepare('SELECT * FROM estimation_owner_state WHERE owner_id=?').get(OWNER);
    assert.throws(() => db.prepare('UPDATE estimation_owner_state SET forced_retrain=1,updated_at=? WHERE owner_id=?')
      .run(c.now(), OWNER), /ATLM_CLIENT_RETIRED/);
    assert.deepEqual(db.prepare('SELECT * FROM estimation_owner_state WHERE owner_id=?').get(OWNER), beforeOldTraining);
    db.prepare('UPDATE estimation_owner_state SET forced_retrain=1,manual_epoch=manual_epoch+1 WHERE owner_id=?').run(OWNER);
    const alreadyForced = db.prepare('SELECT * FROM estimation_owner_state WHERE owner_id=?').get(OWNER);
    assert.throws(() => db.prepare('UPDATE estimation_owner_state SET forced_retrain=1,updated_at=? WHERE owner_id=?')
      .run(c.now(), OWNER), /ATLM_CLIENT_RETIRED/);
    assert.deepEqual(db.prepare('SELECT * FROM estimation_owner_state WHERE owner_id=?').get(OWNER), alreadyForced);
    db.prepare('UPDATE estimation_owner_state SET forced_retrain=0 WHERE owner_id=?').run(OWNER);
    assert.throws(() => db.prepare(`INSERT INTO assessment_revisions(owner_id,assessment_id,revision,plan_id,author_id,recorded_at,command_id,requirements_json,requirements_digest,assessment_json)
      SELECT ?,?,1,?,?,?, ?,requirements_json,'old-digest',? FROM assessment_targets WHERE owner_id=? AND plan_id=? AND step_id IS NULL`)
      .run(OWNER, assessmentId, PLAN, OWNER, c.now(), oldCommand, '{"context":{"agentTask":{"schemaVersion":"agent-task-v1"}}}', OWNER, PLAN), /ASSESSMENT_SCHEMA_RETIRED/);
    const replay = await call(c, '/api/commands', oldEnvelope);
    assert.equal(replay.value.error.code, 'ASSESSMENT_SCHEMA_RETIRED');
    const { commandType, ...mcpEnvelope } = oldEnvelope;
    const mcpReplay = await mcp(c, 'SaveTaskAssessment', mcpEnvelope);
    assert.equal(mcpReplay.value.result.structuredContent.code, 'ASSESSMENT_SCHEMA_RETIRED');
    const receiptView = (await mcp(c, 'GetCommandResult', { commandId: oldCommand })).value.result.structuredContent;
    assert.equal(receiptView.error.code, 'ASSESSMENT_SCHEMA_RETIRED');
    const altered = structuredClone(oldEnvelope); altered.payload.extra = 1;
    assert.equal((await call(c, '/api/commands', altered)).value.error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(snapshot(db, 'assessment_revisions').length, 0);
    db.prepare('UPDATE estimation_owner_state SET data_reset_at=? WHERE owner_id=?').run(c.now() + 1, OWNER);
    db.exec(migration('0030_retrospective_model_releases.sql'));
    const estimate = (await mcp(c, 'GetSavedEstimate', { planId: PLAN })).value.result.structuredContent;
    assert.equal(estimate.source, 'HISTORY_RESET');
    assert.equal(estimate.serverEstimation, null);
    assert.equal(estimate.forecastAvailability.reason, 'HISTORY_RESET');
    db.exec(readFileSync(new URL("../drizzle/0027_agent_task_v4_gate.sql",import.meta.url),"utf8"));
    const freshPlan = '55555555-5555-4555-8555-555555555555';
    await ok(c, 'CreatePlan', { planId: freshPlan, title: 'New plan', planText: '# New\n\n## Этап 1. Работа\nТекст',
      planCreatedAt: { precision: 'dateOnly', on: '2027-01-01', timeZone: 'UTC' } });
    const freshAssessment = await atlmAssessment(c, freshPlan, taskV4(), { predictionRequest: { method: 'ATLM', methodVersion: 1 } });
    assert.equal((await command(c, 'RecordAssessment', freshAssessment, 0)).status, 200);
    assert.throws(() => db.prepare(`INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,recorded_at)
      VALUES(?,?,?,'StartPlan',?,0,?,?,'agent',?,'PENDING',?)`).run(OWNER,'22222222-2222-4222-8222-222222222222','hash',freshPlan,c.now(),OWNER,
      '{"atlmStartForecast":{"estimation":{"formatVersion":1}}}',c.now()), /ATLM_CLIENT_RETIRED/);
    assert.equal(db.prepare('SELECT status FROM plans WHERE owner_id=? AND plan_id=?').get(OWNER, freshPlan).status, 'PLANNED');
    const freshStartId = '44444444-4444-4444-8444-444444444444';
    const firstStart = await command(c, 'StartPlan', { planId: freshPlan }, 0, freshStartId);
    assert.equal(firstStart.status, 200, JSON.stringify(firstStart.value));
    const frozen = db.prepare('SELECT * FROM plan_estimation_inputs WHERE owner_id=? AND plan_id=?').get(OWNER, freshPlan);
    assert.equal(frozen.selection_status, 'CAPTURED');
    assert.ok(frozen.assessment_sequence); assert.ok(JSON.parse(frozen.forecast_json));
    const replayStart = await command(c, 'StartPlan', { planId: freshPlan }, 0, freshStartId);
    assert.equal(replayStart.value.replayed, true);
    assert.deepEqual(db.prepare('SELECT * FROM plan_estimation_inputs WHERE owner_id=? AND plan_id=?').get(OWNER, freshPlan), frozen);
    const jobKey = 'refresh:' + freshPlan;
    const pending = db.prepare('SELECT * FROM estimation_jobs WHERE owner_id=? AND job_key=?').get(OWNER, jobKey);
    assert.ok(pending.fence > 42, 'reset cannot reuse a pre-reset fence');
    assert.throws(() => db.prepare("UPDATE estimation_jobs SET status='RUNNING',fence=fence+1,lease_until=? WHERE owner_id=? AND job_key=?")
      .run(c.now() + 60000, OWNER, jobKey), /ATLM_CLIENT_RETIRED/);
    assert.equal(db.prepare('SELECT fence FROM estimation_jobs WHERE owner_id=? AND job_key=?').get(OWNER, jobKey).fence, pending.fence);
    const lease = await claimAtlmJob(c.db, OWNER, jobKey, c.now());
    assert.ok(lease.fence > pending.fence);
    const noAssessment = '12121212-1212-4212-8212-121212121212';
    await ok(c, 'CreatePlan', { planId: noAssessment, title: 'No assessment', planText: '# New\n\n## Этап 1. Работа\nТекст',
      planCreatedAt: { precision: 'dateOnly', on: '2027-01-01', timeZone: 'UTC' } });
    assert.equal((await command(c,'StartPlan',{planId:noAssessment},0)).value.error.code,'ASSESSMENT_REQUIRED');
    const noAssessmentForecast = (await mcp(c, 'GetSavedEstimate', { planId: noAssessment })).value.result.structuredContent;
    assert.equal(noAssessmentForecast.serverEstimation.unavailableReason, 'ASSESSMENT_REQUIRED');
    assert.equal(noAssessmentForecast.isStale, false);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { c.close(); }
});

test('a failed reset rolls back schema, receipts and data atomically', async () => {
  const index = migrations.indexOf('0026_atlm_v4_reset.sql'), c = context(index < 0 ? migrations.length : index);
  try {
    c.db.sqlite.exec('PRAGMA foreign_keys=ON');
    await ok(c, 'CreatePlan', { planId: PLAN, title: 'Rollback', planText: '# Plan\n\n## Этап 1. Работа\nТекст',
      planCreatedAt: { precision: 'dateOnly', on: '2027-01-01', timeZone: 'UTC' } });
    const db = c.db.sqlite, before = Object.fromEntries(['plans','plan_steps','command_receipts','assessment_targets'].map(table => [table, snapshot(db, table)]));
    db.exec('BEGIN');
    try {
      assert.throws(() => db.exec(readFileSync(resetUrl, 'utf8') + '\nINSERT INTO no_such_reset_table VALUES(1);'));
      db.exec('ROLLBACK');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    for (const [table, values] of Object.entries(before)) assert.deepEqual(snapshot(db, table), values, table);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='estimation_training_attempts'").get().n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { c.close(); }
});

test('reset refuses to reuse a fence newer than its reset marker', async () => {
  const index = migrations.indexOf('0026_atlm_v4_reset.sql'), c = context(index < 0 ? migrations.length : index);
  try {
    await ok(c, 'CreatePlan', { planId: PLAN, title: 'Fence', planText: '# Plan\n\n## Этап 1. Работа\nТекст',
      planCreatedAt: { precision: 'dateOnly', on: '2027-01-01', timeZone: 'UTC' } });
    const db = c.db.sqlite;
    db.prepare("INSERT INTO estimation_jobs(owner_id,job_key,kind,generation,status,fence,created_at,updated_at) VALUES(?,'train','TRAIN',1,'QUEUED',?,?,?)")
      .run(OWNER, Number.MAX_SAFE_INTEGER, c.now(), c.now());
    db.exec('BEGIN');
    assert.throws(() => db.exec(readFileSync(resetUrl, 'utf8')), /CHECK constraint failed/);
    db.exec('ROLLBACK');
    assert.equal(db.prepare("SELECT fence FROM estimation_jobs WHERE owner_id=? AND job_key='train'").get(OWNER).fence, Number.MAX_SAFE_INTEGER);
  } finally { c.close(); }
});

test('old recovery cannot complete a new executor lease', async () => {
  const c = context();
  try {
    await ok(c, 'CreatePlan', { planId: PLAN, title: 'Recovery', planText: '# Plan\n\n## Этап 1. Работа\nТекст',
      planCreatedAt: { precision: 'dateOnly', on: '2027-01-01', timeZone: 'UTC' } });
    await assessForStart(c);
    await ok(c, 'StartPlan', { planId: PLAN }, 0);
    const db = c.db.sqlite, jobKey = 'refresh:' + PLAN;
    const lease = await claimAtlmJob(c.db, OWNER, jobKey, c.now());
    assert.ok(lease);
    db.prepare('UPDATE estimation_jobs SET attempts=4,lease_until=? WHERE owner_id=? AND job_key=?').run(c.now() - 1, OWNER, jobKey);
    assert.throws(() => db.prepare("UPDATE estimation_jobs SET status='FAILED',lease_until=NULL WHERE owner_id=? AND job_key=?")
      .run(OWNER, jobKey), /ATLM_CLIENT_RETIRED/);
    assert.equal(db.prepare('SELECT status FROM estimation_jobs WHERE owner_id=? AND job_key=?').get(OWNER, jobKey).status, 'RUNNING');
    const result = await mcp(c, 'ContinueTraining');
    assert.equal(result.value.result.isError, undefined, JSON.stringify(result.value));
    assert.equal(db.prepare('SELECT status FROM estimation_jobs WHERE owner_id=? AND job_key=?').get(OWNER, jobKey).status, 'FAILED');
  } finally { c.close(); }
});
