import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// This is the actual Sites 0004 generated from its preserved 0000–0003 ledger,
// not a renamed copy of 0019. Provenance is in the fixture's header. Historical
// Sites SQL stays in its source repository; this portable suite checks the new
// bridge against the repository's pre-ATLM schema and representative data.
const directory = new URL("../drizzle/", import.meta.url);
const canonical = readFileSync(new URL("0019_atlm.sql", directory), "utf8");
const bridge = readFileSync(new URL("fixtures/sites/0004_atlm.sql", import.meta.url), "utf8");
const oldMigrations = readdirSync(directory).filter(name => /^\d{4}.*\.sql$/.test(name) && name < "0019_").sort();
const tables = ["plan_estimation_inputs", "estimation_owner_state", "estimation_samples", "estimation_models", "estimation_jobs"];
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const plain = value => JSON.parse(JSON.stringify(value));
const ordered = values => values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const normalizedSQL = sql => sql.replace(/[`"\s]/g, "").toLowerCase();

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of oldMigrations) db.exec(readFileSync(new URL(name, directory), "utf8"));
  return db;
}

function checks(sql) {
  const values = [];
  const pattern = /\bCHECK\s*\(/gi;
  for (let match; (match = pattern.exec(sql));) {
    const start = pattern.lastIndex;
    let depth = 1, quoted = false, i = start;
    for (; i < sql.length && depth; i++) {
      if (sql[i] === "'") {
        if (quoted && sql[i + 1] === "'") { i++; continue; }
        quoted = !quoted;
      } else if (!quoted && sql[i] === "(") depth++;
      else if (!quoted && sql[i] === ")") depth--;
    }
    assert.equal(depth, 0, "balanced CHECK expression");
    values.push(normalizedSQL(sql.slice(start, i - 1)));
    pattern.lastIndex = i;
  }
  return values.sort();
}

function indexDefinitions(db, table) {
  return ordered(db.prepare(`PRAGMA index_list(${quote(table)})`).all().map(index => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(index.name)?.sql;
    return {
      unique: index.unique,
      columns: db.prepare(`PRAGMA index_xinfo(${quote(index.name)})`).all()
        .filter(column => column.key).map(({ name, desc, coll }) => ({ name, desc, coll })),
      where: sql && /\bWHERE\s+(.*)$/is.exec(sql) ? normalizedSQL(/\bWHERE\s+(.*)$/is.exec(sql)[1]) : null,
    };
  }));
}

function schema(db) {
  return tables.map(table => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
    const foreignKeys = new Map();
    for (const { id, seq, ...row } of db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all()) {
      const group = foreignKeys.get(id) || [];
      group[seq] = row;
      foreignKeys.set(id, group);
    }
    return {
      table,
      columns: db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(({ cid, ...column }) => {
        // An INTEGER PRIMARY KEY rejects neither omitted nor explicit NULL:
        // SQLite auto-assigns the rowid even with Drizzle's explicit NOT NULL.
        if (column.pk === 1 && column.type.toUpperCase() === "INTEGER") column.notnull = 1;
        return column;
      }),
      autoIncrement: /\bAUTOINCREMENT\b/i.test(sql),
      checks: checks(sql),
      foreignKeys: ordered([...foreignKeys.values()]),
      // Constraint-created autoindexes and named unique indexes enforce the
      // same keys. Names/origin differ between handwritten and generated DDL.
      indexes: indexDefinitions(db, table),
    };
  });
}

function snapshot(db, names) {
  return Object.fromEntries(names.map(name => [name, plain(db.prepare(`SELECT * FROM ${quote(name)} ORDER BY rowid`).all())]));
}

function seedPlan(db, plan, owner = "owner-a", status = "PLANNED") {
  db.prepare(`INSERT INTO plans(owner_id,plan_id,title,plan_created_precision,plan_created_on,
    plan_created_timezone,registered_at,status,first_started_at,finished_at,created_by)
    VALUES(?,?,'Bridge fixture','dateOnly','2026-11-01','UTC',1000,?,?,?,?)`)
    .run(owner, plan, status, status === "PLANNED" ? null : 2000, status === "COMPLETED" ? 3000 : null, owner);
}

function receipt(db, id, time = 1000, owner = "owner-a") {
  db.prepare(`INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,server_now_ms,
    actor_id,actor_type,payload_json,outcome_code,recorded_at)
    VALUES(?,?,'fixture','Fixture',?,?,'agent','{}','OK',?)`).run(owner, id, time, owner, time);
}

function assessment(db, plan, id, time = 1000, owner = "owner-a") {
  receipt(db, id, time, owner);
  db.prepare(`INSERT INTO assessment_revisions(owner_id,assessment_id,revision,plan_id,author_id,recorded_at,
    command_id,requirements_json,requirements_digest,assessment_json)
    SELECT ?,?,1,?,?,?, ?,requirements_json,'fixture-digest',
      '{"context":{"agentTask":{"schemaVersion":"agent-task-v1"}}}'
    FROM assessment_targets WHERE owner_id=? AND plan_id=? AND step_id IS NULL`)
    .run(owner, id, plan, owner, time, id, owner, plan);
  return Number(db.prepare("SELECT sequence FROM assessment_revisions WHERE owner_id=? AND assessment_id=?").get(owner, id).sequence);
}

function seed(db) {
  db.exec("INSERT INTO owners(owner_id,created_at) VALUES('owner-a',1000),('owner-b',1000)");
  seedPlan(db, "ready");
  seedPlan(db, "missing");
  seedPlan(db, "rollback");
  seedPlan(db, "old-completed", "owner-a", "COMPLETED");
  seedPlan(db, "unrelated-running", "owner-a", "RUNNING");
  seedPlan(db, "private-running", "owner-b", "RUNNING");
  db.exec(`INSERT INTO work_intervals(interval_id,owner_id,plan_id,start_ms,end_ms,opened_by,closed_by) VALUES
    ('closed','owner-a','old-completed',2000,3000,'owner-a','owner-a'),
    ('open','owner-a','unrelated-running',2000,NULL,'owner-a',NULL),
    ('private-open','owner-b','private-running',2000,NULL,'owner-b',NULL)`);
  assessment(db, "ready", "pre-start");
  assessment(db, "old-completed", "legacy");
}

function start(db, plan) {
  db.prepare("UPDATE plans SET status='RUNNING',first_started_at=3000,version=version+1 WHERE owner_id='owner-a' AND plan_id=?").run(plan);
}

function sample(db, { plan = "ready", generation = 1, first = 1, eligible = true, assessmentSequence = 1 } = {}) {
  return Number(db.prepare(`INSERT INTO estimation_samples(owner_id,plan_id,input_assessment_sequence,
    source_digest,source_generation,eligibility,reasons_json,features_json,issued_prediction_json,
    actual_ms,captured_at,source_available_at,observed_at,is_first_eligible)
    VALUES('owner-a',?,?,'source',?,?,'[]',?,NULL,?,?,4000,5000,?)`)
    .run(plan, eligible ? assessmentSequence : null, generation, eligible ? "ELIGIBLE" : "EXCLUDED",
      eligible ? "{}" : null, eligible ? 1234 : null, eligible ? 3000 : null, first).lastInsertRowid);
}

function model(db, id, version, manifest, owner = "owner-a", status = "ACTIVE") {
  db.prepare(`INSERT INTO estimation_models(owner_id,model_id,model_version,status,artifact_json,
    manifest_json,dataset_digest,train_cutoff,sample_count,created_at)
    VALUES(?,?,?,?,'{}',?,'source',4000,?,6000)`)
    .run(owner, id, version, status, JSON.stringify(manifest), manifest.length);
}

function exercise(db) {
  start(db, "ready");
  start(db, "missing");
  const input = db.prepare("SELECT * FROM plan_estimation_inputs WHERE plan_id='ready'").get();
  assert.equal(input.selection_status, "CAPTURED");
  assert.equal(input.assessment_sequence, 1);
  assert.equal(db.prepare("SELECT selection_status FROM plan_estimation_inputs WHERE plan_id='missing'").get().selection_status, "MISSING_FEATURES");
  assessment(db, "ready", "too-late", 3500);
  assert.equal(db.prepare("SELECT assessment_sequence FROM plan_estimation_inputs WHERE plan_id='ready'").get().assessment_sequence, 1);
  assert.throws(() => db.exec("UPDATE plan_estimation_inputs SET first_started_at=4000"), /ATLM_INPUT_IMMUTABLE/);
  assert.throws(() => db.exec("DELETE FROM plan_estimation_inputs"), /ATLM_INPUT_IMMUTABLE/);
  const beforeRollback = snapshot(db, [...tables, "plans"]);
  db.exec("BEGIN");
  start(db, "rollback");
  db.exec("ROLLBACK");
  assert.deepEqual(snapshot(db, [...tables, "plans"]), beforeRollback, "capture and queue share the start transaction");

  const sequence = sample(db);
  sample(db, { plan: "old-completed", first: 0, eligible: false });
  assert.deepEqual(plain(db.prepare("SELECT dataset_revision,new_sample_count FROM estimation_owner_state WHERE owner_id='owner-a'").get()),
    { dataset_revision: 2, new_sample_count: 1 });
  assert.throws(() => sample(db, { generation: 2 }), /UNIQUE constraint failed/);
  assert.throws(() => sample(db, { generation: 2, first: 0, assessmentSequence: 999 }), /FOREIGN KEY constraint failed/);
  assert.throws(() => db.exec("UPDATE estimation_samples SET actual_ms=12"), /ATLM_SAMPLE_IMMUTABLE/);
  assert.throws(() => db.exec("DELETE FROM estimation_samples"), /ATLM_SAMPLE_IMMUTABLE/);

  model(db, "active", 1, [sequence]);
  db.exec("UPDATE estimation_owner_state SET active_model_id='active' WHERE owner_id='owner-a'");
  assert.throws(() => model(db, "foreign", 1, [sequence], "owner-b"), /ATLM_MODEL_SOURCE_NOT_FOUND/);
  assert.throws(() => model(db, "missing-source", 2, [999]), /ATLM_MODEL_SOURCE_NOT_FOUND/);
  assert.throws(() => model(db, "string-source", 2, [String(sequence)]), /ATLM_MODEL_SOURCE_NOT_FOUND/);
  model(db, "candidate", 2, [sequence], "owner-a", "CANDIDATE");
  assert.throws(() => db.exec("UPDATE estimation_models SET status='ACTIVE' WHERE model_id='candidate'"), /UNIQUE constraint failed/);
  assert.throws(() => db.exec("UPDATE estimation_models SET artifact_json='[]'"), /ATLM_MODEL_IMMUTABLE/);
  assert.throws(() => db.exec("DELETE FROM estimation_models"), /ATLM_MODEL_IMMUTABLE/);
  db.exec("INSERT INTO estimation_owner_state(owner_id) VALUES('owner-b')");
  assert.throws(() => db.exec("UPDATE estimation_owner_state SET active_model_id='active' WHERE owner_id='owner-b'"), /FOREIGN KEY constraint failed/);
  db.exec("UPDATE plans SET title='Unrelated edit' WHERE plan_id IN ('unrelated-running','private-running')");
  assert.equal(db.prepare("SELECT status FROM estimation_models WHERE model_id='active'").get().status, "ACTIVE");

  receipt(db, "source-edit", 7000);
  db.exec("UPDATE estimation_jobs SET status='RUNNING',lease_until=9000,fence=3,attempts=4 WHERE plan_id='ready'");
  const oldGeneration = db.prepare("SELECT generation FROM estimation_jobs WHERE plan_id='ready'").get().generation;
  db.exec("UPDATE plans SET title='Changed source' WHERE plan_id='ready'");
  const job = db.prepare("SELECT * FROM estimation_jobs WHERE plan_id='ready'").get();
  assert.equal(job.generation, oldGeneration + 1);
  assert.equal(job.status, "RUNNING");
  assert.equal(job.fence, 3);
  assert.equal(job.attempts, 0, "a new source generation starts a fresh retry budget while preserving the in-flight lease");
  assert.equal(job.lease_until, 9000);
  assert.equal(job.source_changed_at, 7000);
  db.exec("UPDATE estimation_jobs SET updated_at=8500 WHERE plan_id='ready'");
  assert.equal(db.prepare("SELECT source_changed_at FROM estimation_jobs WHERE plan_id='ready'").get().source_changed_at, 7000);
  assert.equal(db.prepare("SELECT status FROM estimation_models WHERE model_id='active'").get().status, "INVALIDATED");
  assert.equal(db.prepare("SELECT forced_retrain FROM estimation_owner_state WHERE owner_id='owner-a'").get().forced_retrain, 1);
  assert.throws(() => db.exec("UPDATE estimation_jobs SET generation=0"), /CHECK constraint failed/);
  assert.throws(() => db.exec("UPDATE estimation_jobs SET checkpoint_json='{'"), /CHECK constraint failed/);
  assert.throws(() => db.exec("UPDATE estimation_jobs SET kind='TRAIN' WHERE plan_id='ready'"), /CHECK constraint failed/);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  return snapshot(db, [...tables, "plans", "work_intervals"]);
}

test("Sites 0004 is tied to canonical 0019 and has equivalent columns, checks, keys and triggers", () => {
  assert.equal(/-- Canonical SHA-256: ([a-f0-9]+)/.exec(bridge)?.[1], createHash("sha256").update(canonical).digest("hex"));
  const a = database(), b = database();
  try {
    a.exec(canonical); b.exec(bridge);
    assert.deepEqual(schema(b), schema(a));
    assert.deepEqual(indexDefinitions(b, "assessment_revisions"), indexDefinitions(a, "assessment_revisions"));
    const triggers = db => plain(db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'atlm_%' ORDER BY name").all());
    assert.deepEqual(triggers(b), triggers(a));
    for (const db of [a, b]) {
      assert.deepEqual(snapshot(db, tables), Object.fromEntries(tables.map(name => [name, []])));
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    }
  } finally { a.close(); b.close(); }
});

test("populated upgrade preserves existing history and unrelated running timers without fabricating samples", () => {
  for (const migration of [canonical, bridge]) {
    const db = database();
    try {
      seed(db);
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
      const before = snapshot(db, names);
      db.exec(migration);
      assert.deepEqual(snapshot(db, names), before);
      assert.deepEqual(snapshot(db, tables), Object.fromEntries(tables.map(name => [name, []])));
      assert.equal(db.prepare("SELECT status FROM plans WHERE plan_id='unrelated-running'").get().status, "RUNNING");
      assert.equal(db.prepare("SELECT end_ms FROM work_intervals WHERE interval_id='open'").get().end_ms, null);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
  }
});

test("Sites bridge enforces the same immutable capture, sample ownership, activation and durable outbox behavior", () => {
  const a = database(), b = database();
  try {
    seed(a); seed(b);
    a.exec(canonical); b.exec(bridge);
    assert.deepEqual(exercise(b), exercise(a));
  } finally { a.close(); b.close(); }
});
