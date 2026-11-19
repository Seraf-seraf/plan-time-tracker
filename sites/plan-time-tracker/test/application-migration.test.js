import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { processEstimationTraining } from '../worker/atlm/training.js';
import { context, OWNER } from './fixtures/tracker-db.mjs';

const migrationDirectory = new URL('../drizzle/', import.meta.url);
const migrationName = '0029_application_transactions.sql';
const migrationSql = readFileSync(new URL(migrationName, migrationDirectory), 'utf8');
const previousMigrations = readdirSync(migrationDirectory)
  .filter(name => name.endsWith('.sql') && name < migrationName).sort();

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const name of previousMigrations) {
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(new URL(name, migrationDirectory), 'utf8'));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  return db;
}

function upgrade(db) {
  db.exec('BEGIN');
  try {
    db.exec(migrationSql);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function snapshot(db) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all();
  return Object.fromEntries(tables.map(({ name }) => [name,
    db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => ({ ...row })),
  ]));
}

function seed(db) {
  db.exec(`
    INSERT INTO owners(owner_id,created_at) VALUES('alpha',100),('beta',100);
    INSERT INTO plans(owner_id,plan_id,title,plan_created_precision,plan_created_on,
      plan_created_timezone,registered_at,status,first_started_at,finished_at,created_by)
    VALUES('alpha','completed','Completed','dateOnly','2026-01-01','UTC',100,'COMPLETED',1000,2000,'alpha'),
      ('beta','running','Running','dateOnly','2026-01-01','UTC',100,'RUNNING',1000,NULL,'beta');
    INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,plan_id,
      server_now_ms,actor_id,actor_type,payload_json,outcome_code,result_json,recorded_at)
    VALUES('alpha','assessment','hash','Fixture','completed',900,'alpha','agent','{}','OK','{}',900),
      ('alpha','legacy-start','hash','StartPlan','completed',1000,'alpha','agent','{}','OK','{"version":1}',1000),
      ('beta','legacy-start','hash','StartPlan','running',1000,'beta','agent','{}','OK','{"version":1}',1000);
    INSERT INTO plan_documents(owner_id,plan_id,markdown)
    VALUES('alpha','completed','# Completed'),('beta','running','# Running');
    INSERT INTO plan_steps(owner_id,plan_id,step_id,ordinal,title,content,status,created_at,updated_at)
    VALUES('alpha','completed','done-step',0,'Done','Original work','DONE',100,2000),
      ('beta','running','running-step',0,'Running','In progress','RUNNING',100,1000);
    INSERT INTO assessment_targets(owner_id,plan_id,step_id,requirements_json)
    VALUES('alpha','completed',NULL,'{"plan":{"title":"Completed"}}'),
      ('beta','running',NULL,'{"plan":{"title":"Running"}}');
    INSERT INTO assessment_revisions(owner_id,assessment_id,revision,plan_id,author_id,
      recorded_at,command_id,requirements_json,requirements_digest,assessment_json)
    VALUES('alpha','assessment',1,'completed','alpha',900,'assessment',
      '{"plan":{"title":"Completed"}}','requirements','{"context":{"agentTask":{"schemaVersion":"agent-task-v4"}}}');
    INSERT INTO plan_estimation_inputs(owner_id,plan_id,assessment_sequence,requirements_digest,
      requirements_json,first_started_at,captured_receipt_rowid,selection_status,forecast_json)
    VALUES('alpha','completed',1,'requirements','{"plan":{"title":"Completed"}}',1000,2,'CAPTURED','{"pointMs":1000}');
    INSERT INTO work_intervals(interval_id,owner_id,plan_id,start_ms,end_ms,opened_by,closed_by)
    VALUES('closed','alpha','completed',1000,2000,'alpha','alpha'),
      ('open','beta','running',1000,NULL,'beta',NULL);
    INSERT INTO step_work_intervals(owner_id,step_id,start_ms,end_ms)
    VALUES('alpha','done-step',1100,1900),('beta','running-step',1100,NULL);
    INSERT INTO plan_date_history(history_id,owner_id,plan_id,old_precision,old_on,
      old_timezone,changed_at,changed_by,reason)
    VALUES('date-history','alpha','completed','dateOnly','2025-12-31','UTC',500,'alpha','Corrected date');
    INSERT INTO tracker_finish_exceptions(owner_id,plan_id,command_id,reason,created_at)
    VALUES('alpha','completed','assessment','Historical reason',2000);
    INSERT INTO estimation_samples(owner_id,plan_id,input_assessment_sequence,source_digest,
      source_generation,eligibility,reasons_json,features_json,issued_prediction_json,actual_ms,
      captured_at,source_available_at,observed_at,is_first_eligible)
    VALUES('alpha','completed',1,'source',1,'ELIGIBLE','[]','{"feature":1}',
      '{"pointMs":1000}',1000,1000,2000,2100,1);
    INSERT INTO estimation_models(owner_id,model_id,model_version,status,artifact_json,
      manifest_json,dataset_digest,train_cutoff,metrics_json,sample_count,created_at,activated_at)
    VALUES('alpha','active',1,'ACTIVE','{"coefficients":[1,2]}','[1]','digest',2100,'{"mae":5}',1,2200,2200);
    UPDATE estimation_owner_state SET active_model_id='active',training_generation=3 WHERE owner_id='alpha';
    INSERT INTO estimation_training_attempts(owner_id,attempt_id,started_at,completed_at,
      method_version,feature_version,dataset_revision,manifest_json,metrics_json,reason)
    VALUES('alpha','attempt',2100,2200,'agent-v5-operations','agent-task-v4',1,'[1]','{"mae":5}','ACTIVATED');
    INSERT INTO estimation_jobs(owner_id,job_key,kind,generation,processed_generation,status,
      lease_until,fence,executor_epoch,attempts,snapshot_json,checkpoint_json,created_at,updated_at)
    VALUES('alpha','train','TRAIN',3,2,'RUNNING',9000,11,12,1,'{"rows":[1]}','{"stage":"fit"}',2100,2300),
      ('beta','train','TRAIN',2,1,'RETRY_WAIT',NULL,7,8,2,'{"rows":[]}','{"stage":"evaluate"}',2000,2300);
    UPDATE estimation_jobs SET status='RUNNING',fence=fence+1,executor_epoch=executor_epoch+2,
      lease_until=8000 WHERE owner_id='alpha' AND job_key='refresh:completed';
    INSERT INTO estimation_checkpoint_parts(owner_id,generation,storage_id,field,item,part,content)
    VALUES('alpha',3,'checkpoint','fit','ols',0,'{"partial":true}');
  `);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

test('application migration preserves all stored history and revokes only running writer leases', () => {
  const db = database();
  try {
    seed(db);
    const expected = snapshot(db);
    for (const receipt of expected.command_receipts) receipt.execution_nonce = null;
    for (const job of expected.estimation_jobs) {
      if (job.status !== 'RUNNING') continue;
      job.fence += 1;
      job.executor_epoch += 3;
    }
    upgrade(db);
    assert.deepEqual(snapshot(db), expected);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare("SELECT status FROM estimation_models WHERE model_id='active'").get().status, 'ACTIVE');
    assert.equal(db.prepare("SELECT end_ms FROM work_intervals WHERE interval_id='open'").get().end_ms, null);
  } finally {
    db.close();
  }
});

test('new schema contains only rejecting triggers and retains storage integrity constraints', () => {
  const db = database();
  try {
    upgrade(db);
    const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
    assert.ok(triggers.length > 0);
    for (const { name, sql } of triggers) {
      const body = sql.slice(sql.indexOf('BEGIN'));
      assert.doesNotMatch(body, /\b(?:INSERT|UPDATE|DELETE)\b/i, name);
      assert.match(body, /RAISE\s*\(/i, name);
    }
    for (const name of ['command_application_writer', 'atlm_owner_schema_required',
      'assessment_immutable_update', 'atlm_model_artifact_immutable', 'work_intervals_no_overlap_insert']) {
      assert.ok(triggers.some(trigger => trigger.name === name), name);
    }
    db.exec("INSERT INTO owners(owner_id,created_at) VALUES('alpha',100)");
    assert.throws(() => db.exec("INSERT INTO estimation_owner_state(owner_id) VALUES('alpha')"), /ATLM_CLIENT_RETIRED/);
    db.exec("INSERT INTO estimation_owner_state(owner_id,schema_version) VALUES('alpha',4)");
    assert.throws(() => db.exec("INSERT OR IGNORE INTO estimation_owner_state(owner_id) VALUES('alpha')"), /ATLM_CLIENT_RETIRED/);
    assert.throws(() => db.exec("INSERT INTO estimation_owner_state(owner_id,schema_version) VALUES('missing-owner',4)"), /FOREIGN KEY/);
    assert.throws(() => db.exec("UPDATE estimation_owner_state SET forced_retrain=2"), /CHECK constraint/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('old command writers are rejected before any receipt or effect is committed', () => {
  const db = database();
  try {
    upgrade(db);
    db.exec("INSERT INTO owners(owner_id,created_at) VALUES('alpha',100)");
    const insert = db.prepare(`INSERT INTO command_receipts(owner_id,command_id,payload_hash,
      command_type,server_now_ms,actor_id,actor_type,payload_json,outcome_code,recorded_at,execution_nonce)
      VALUES('alpha',?,'hash',?,100,'alpha','agent','{}','PENDING',100,?)`);
    for (const command of ['CreatePlan', 'StartPlan', 'PausePlan', 'ResumePlan', 'FinishPlan',
      'DeletePlan', 'RestorePlan', 'UpdatePlanMetadata', 'SetStepStatus', 'RecordAssessment']) {
      assert.throws(() => insert.run(command, command, null), /APPLICATION_WRITER_REQUIRED/, command);
      assert.throws(() => insert.run(command, command, ''), /APPLICATION_WRITER_REQUIRED/, command);
    }
    assert.equal(db.prepare('SELECT COUNT(*) count FROM command_receipts').get().count, 0);
    insert.run('fixture', 'Fixture', null);
    insert.run('application', 'CreatePlan', crypto.randomUUID());
    assert.equal(db.prepare('SELECT COUNT(*) count FROM command_receipts').get().count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM plans').get().count, 0,
      'a stored command does not execute application behavior in SQLite');
  } finally {
    db.close();
  }
});

test('retired training claims and old leases cannot publish after the migration', () => {
  const db = database();
  try {
    seed(db);
    const oldLease = db.prepare("SELECT * FROM estimation_jobs WHERE owner_id='alpha' AND job_key='train'").get();
    upgrade(db);
    assert.throws(() => db.exec(`UPDATE estimation_jobs SET status='RUNNING',fence=fence+1,
      executor_epoch=executor_epoch+2,lease_until=10000 WHERE owner_id='alpha' AND job_key='train'`), /ATLM_CLIENT_RETIRED/);
    const stale = db.prepare(`UPDATE estimation_models SET status='RETIRED'
      WHERE owner_id='alpha' AND model_id='active' AND EXISTS(SELECT 1 FROM estimation_jobs
        WHERE owner_id='alpha' AND job_key='train' AND status='RUNNING' AND fence=? AND executor_epoch=?)`)
      .run(oldLease.fence, oldLease.executor_epoch);
    assert.equal(Number(stale.changes), 0);
    db.exec(`UPDATE estimation_jobs SET status='RUNNING',fence=fence+1,
      executor_epoch=executor_epoch+3,lease_until=10000 WHERE owner_id='alpha' AND job_key='train'`);
    assert.throws(() => db.exec(`UPDATE estimation_jobs SET status='IDLE',processed_generation=generation,
      executor_epoch=executor_epoch+2,lease_until=NULL WHERE owner_id='alpha' AND job_key='train'`), /ATLM_CLIENT_RETIRED/);
    db.exec(`UPDATE estimation_jobs SET status='IDLE',processed_generation=generation,
      executor_epoch=executor_epoch+3,lease_until=NULL WHERE owner_id='alpha' AND job_key='train'`);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM estimation_checkpoint_parts').get().count, 1,
      'direct SQL does not implicitly delete checkpoint data');
    assert.equal(db.prepare("SELECT status FROM estimation_models WHERE model_id='active'").get().status, 'ACTIVE');
  } finally {
    db.close();
  }
});

for (const attempts of [1, 4]) {
  test(`migration preserves recovery of an interrupted training attempt ${attempts} without a checkpoint`, async () => {
    const c = context(previousMigrations.length);
    try {
      const leaseUntil = c.now() + 60000;
      c.db.sqlite.prepare('INSERT INTO owners(owner_id,created_at) VALUES(?,?)').run(OWNER, c.now());
      c.db.sqlite.prepare('INSERT INTO estimation_owner_state(owner_id,schema_version) VALUES(?,4)').run(OWNER);
      c.db.sqlite.prepare(`INSERT INTO estimation_jobs(owner_id,job_key,kind,status,generation,
        processed_generation,lease_until,fence,executor_epoch,attempts,snapshot_json,checkpoint_json,created_at,updated_at)
        VALUES(?,'train','TRAIN','RUNNING',1,0,?,7,2,?,NULL,NULL,?,?)`)
        .run(OWNER, leaseUntil, attempts, c.now(), c.now());
      c.db.sqlite.prepare(`INSERT INTO estimation_training_attempts(owner_id,attempt_id,started_at,
        method_version,feature_version,dataset_revision,manifest_json)
        VALUES(?, ?,?,'agent-v5-operations','agent-task-v4',0,'[]')`)
        .run(OWNER, 'g1-a' + attempts, c.now());
      upgrade(c.db.sqlite);
      c.advance(60001);
      await processEstimationTraining(c.db, OWNER, c.now(), { clock: c.now, wallClock: () => 0 });

      const job = c.db.sqlite.prepare("SELECT * FROM estimation_jobs WHERE owner_id=? AND job_key='train'").get(OWNER);
      assert.equal(job.status, attempts === 4 ? 'FAILED' : 'RETRY_WAIT');
      assert.equal(job.attempts, attempts);
      assert.equal(job.lease_until, null);
      assert.equal(job.last_error, 'LEASE_EXPIRED');
      assert.equal(job.next_attempt_at, attempts === 4 ? 0 : leaseUntil + 60000);
      assert.equal(job.fence, 8, 'migration invalidates the old holder without starting an extra attempt');
      const history = c.db.sqlite.prepare('SELECT * FROM estimation_training_attempts WHERE owner_id=?').all(OWNER);
      assert.equal(history.length, 1);
      assert.equal(history[0].attempt_id, 'g1-a' + attempts);
      assert.equal(history[0].completed_at, c.now());
      assert.equal(history[0].reason, 'LEASE_EXPIRED');
      assert.equal(c.db.sqlite.prepare(`SELECT COUNT(*) count FROM estimation_jobs WHERE owner_id=?
        AND status IN ('QUEUED','RETRY_WAIT') AND next_attempt_at<=? AND generation>processed_generation`)
        .get(OWNER, c.now()).count, 0);
      if (attempts === 4) {
        const owner = c.db.sqlite.prepare('SELECT * FROM estimation_owner_state WHERE owner_id=?').get(OWNER);
        assert.equal(owner.last_training_status, 'FAILED');
        assert.equal(owner.last_training_reason, 'LEASE_EXPIRED');
      }
    } finally {
      c.close();
    }
  });
}
