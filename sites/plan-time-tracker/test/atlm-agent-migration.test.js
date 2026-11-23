import assert from 'node:assert/strict';
import test from 'node:test';
import { OWNER, PLAN, context, migration, migrations } from './fixtures/tracker-db.mjs';

const filename = '0031_agent_atlm_revisions.sql';
const preceding = migrations.indexOf('0030_retrospective_model_releases.sql');
const apply = (db) => db.exec(`BEGIN; ${migration(filename)} COMMIT;`);

test('clean migration installs an owner-scoped registry with no serving pointers', () => {
  const c = context();
  try {
    assert.deepEqual(c.db.sqlite.prepare('SELECT * FROM estimation_serving_models').all(), []);
    assert.deepEqual(c.db.sqlite.prepare("SELECT * FROM estimation_training_snapshots").all(), []);
    assert.deepEqual(c.db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    c.close();
  }
});

test('upgrade archives a live TRAIN and fences old starts while preserving prior objects', () => {
  const c = context(preceding + 1);
  try {
    const db = c.db.sqlite;
    seedLegacyPlan(db);
    db.prepare("INSERT INTO estimation_jobs(owner_id,job_key,kind,status,lease_until,created_at,updated_at) VALUES(?,'train','TRAIN','RUNNING',42,0,0)").run(OWNER);
    db.prepare("INSERT INTO estimation_checkpoint_parts VALUES(?,1,'draft','fit','part',0,'value')").run(OWNER);
    db.prepare("INSERT INTO estimation_training_attempts(owner_id,attempt_id,started_at,method_version,feature_version,dataset_revision,manifest_json) VALUES(?,'attempt',0,'agent-v5-operations','agent-task-v4',0,'[]')").run(OWNER);
    apply(db);
    assert.equal(db.prepare('SELECT lease_until FROM estimation_legacy_train_jobs').get().lease_until, 42);
    assert.equal(db.prepare('SELECT content FROM estimation_legacy_train_checkpoint_parts').get().content, 'value');
    assert.equal(db.prepare('SELECT count(*) n FROM estimation_jobs WHERE kind=\'TRAIN\'').get().n, 0);
    assert.equal(db.prepare('SELECT reason FROM estimation_training_attempts').get().reason, 'RETIRED_BY_AGENT_FLOW');
    assert.throws(() => db.prepare("INSERT INTO estimation_jobs(owner_id,job_key,kind,created_at,updated_at) VALUES(?,'train','TRAIN',0,0)").run(OWNER), /ATLM_CLIENT_RETIRED/);
    const oldStart = db.prepare(`INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,
      plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,recorded_at)
      VALUES(?,'retired-start','hash','StartPlan',?,0,1000,?,'agent',?,1000)`);
    assert.throws(() => oldStart.run(OWNER, PLAN, OWNER, JSON.stringify({
      planId: PLAN, atlmStartForecast: { snapshotVersion: 4 },
    })), /ATLM_CLIENT_RETIRED/);
    assert.equal(db.prepare('SELECT first_started_at FROM plans').get().first_started_at, null);
    assert.equal(db.prepare('SELECT count(*) n FROM plan_estimation_inputs').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM work_intervals').get().n, 0);
  } finally {
    c.close();
  }
});

function seedLegacyPlan(db) {
  db.prepare('INSERT INTO owners(owner_id,created_at) VALUES(?,0)').run(OWNER);
  db.prepare(`INSERT INTO plans(plan_id,owner_id,title,plan_created_precision,plan_created_on,
    plan_created_timezone,registered_at,status,created_by)
    VALUES(?,?,'Legacy plan','dateOnly','2026-11-23','UTC',0,'PLANNED',?)`).run(PLAN, OWNER, OWNER);
}

const reconstructedDefinition = `CREATE TABLE estimation_reconstructed_dataset_rows (
 owner_id TEXT NOT NULL, model_id TEXT NOT NULL, plan_id TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)), PRIMARY KEY(owner_id,model_id,plan_id),
 FOREIGN KEY(owner_id,model_id) REFERENCES estimation_models(owner_id,model_id),
 FOREIGN KEY(owner_id,plan_id) REFERENCES plans(owner_id,plan_id))`;
const retrospectiveDefinition = `CREATE TABLE estimation_retrospective_dataset_rows (
 owner_id TEXT NOT NULL, model_id TEXT NOT NULL, revision INTEGER NOT NULL,
 plan_id TEXT NOT NULL, ordinal INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 PRIMARY KEY(owner_id,model_id,revision,plan_id), UNIQUE(owner_id,model_id,revision,ordinal),
 FOREIGN KEY(owner_id,model_id,revision) REFERENCES estimation_retrospective_builds(owner_id,model_id,revision),
 FOREIGN KEY(owner_id,plan_id) REFERENCES plans(owner_id,plan_id))`;

for (const [reconstructed, retrospective] of [[true, true], [true, false], [false, true], [false, false]]) {
  test(`manual 0030 with reconstructed=${reconstructed} and retrospective=${retrospective}`, () => {
    const c = context(preceding);
    const db = c.db.sqlite;
    try {
      seedLegacyPlan(db);
      db.exec(migration('0030_retrospective_model_releases.sql'));
      if (reconstructed) db.exec(reconstructedDefinition);
      if (retrospective) db.exec(retrospectiveDefinition);
      db.prepare(`INSERT INTO estimation_models(owner_id,model_id,model_version,status,manifest_json,
        dataset_digest,train_cutoff,sample_count,created_at) VALUES(?,'old',1,'REJECTED','[]','old-digest',0,0,1)`).run(OWNER);
      const rawArtifact = '{ "n": 1, "method": { "version": "agent-v5-operations" }, "featureSchemaVersion":"agent-task-v4" }';
      db.prepare("INSERT INTO estimation_retrospective_builds VALUES(?,'old',2,2,'REJECTED','OLD_GATE',?,'[]','{}')").run(OWNER, rawArtifact);
      db.prepare("INSERT INTO estimation_revision_releases VALUES(?,'old',2,3)").run(OWNER);
      db.prepare("INSERT INTO estimation_revision_sources VALUES(?,'old',2,?,0)").run(OWNER, PLAN);
      db.prepare("INSERT INTO estimation_owner_state(owner_id,active_model_id,data_reset_at) VALUES(?,'old',0)").run(OWNER);

      const record = '{ "eligibility":"EXCLUDED", "reasons":["PLAN_NOT_COMPLETED"], "evidence":"original bytes" }';
      if (reconstructed) db.prepare("INSERT INTO estimation_reconstructed_dataset_rows VALUES(?,'old',?,?)").run(OWNER, PLAN, record);
      if (retrospective) db.prepare("INSERT INTO estimation_retrospective_dataset_rows VALUES(?,'old',2,?,0,?)").run(OWNER, PLAN, record);
      db.exec(migration('0030_retrospective_model_releases.sql'));
      apply(db);

      const models = db.prepare('SELECT model_id,model_revision,artifact_json,activated_at FROM estimation_serving_models WHERE status=\'ACTIVE\'').all();
      assert.deepEqual(models.map(Object.values), [['old-r2', 2, rawArtifact, 3]]);
      const rows = db.prepare('SELECT snapshot_id,snapshot_row_id,origin,record_json FROM estimation_dataset_revision_rows').all();
      assert.deepEqual(rows.map(Object.values), Array.from({length: Number(reconstructed)+Number(retrospective)}, () => [null, null, 'IMPORTED', record]));
      assert.throws(() => db.exec("UPDATE estimation_model_revisions SET artifact_json='{}' WHERE model_revision_id='old-r2'"), /ATLM_MODEL_IMMUTABLE/);
      assert.throws(() => db.exec("UPDATE estimation_models SET status='ACTIVE'"), /ATLM_CLIENT_RETIRED/);
      assert.throws(() => db.exec('UPDATE estimation_owner_state SET active_model_id=NULL'), /ATLM_CLIENT_RETIRED/);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      c.close();
    }
  });
}
