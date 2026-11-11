import test from "node:test";
import assert from "node:assert/strict";
import { context, call, command, ok, running, result, check, rows, migrations, migration, plannedAtlm, completeAtlm, PLAN, OWNER } from "./fixtures/tracker-db.mjs";
import { readAtlmSampleSource, claimAtlmJob, persistAtlmSample } from "../worker/index.js";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TABLES = ["plan_estimation_inputs", "estimation_samples", "estimation_models", "estimation_jobs", "estimation_owner_state"];

test("populated 0018 upgrade preserves old rows and active timers without backfilling inputs", async () => {
  const c = context(migrations.indexOf("0019_atlm.sql"));
  try {
    const lease = await running(c); await result(c, lease); await ok(c, "RecordCheck", check(lease.stepId));
    await running(c, ["unit"], OTHER); c.advance(1000);
    const before = rows(c);
    c.db.sqlite.exec(migration("0019_atlm.sql"));
    const after = rows(c); for (const name of TABLES) { assert.deepEqual(after[name], []); delete after[name]; }
    assert.deepEqual(after, before);
    assert.deepEqual(c.db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    await ok(c, "PausePlan", { planId: PLAN }, 1); await ok(c, "ResumePlan", { planId: PLAN }, 2);
    c.advance(1000); await ok(c, "FinishPlan", { planId: PLAN }, 3);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) n FROM plan_estimation_inputs").get().n, 0);
    const source = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
    assert.equal(source.actualMs, 2000); assert.ok(source.reasons.includes("MISSING_FEATURES"));
    assert.equal(c.db.sqlite.prepare("SELECT status FROM plans WHERE plan_id=?").get(OTHER).status, "RUNNING");
  } finally { c.close(); }
});

test("fresh migration supports unassessed lifecycle, owner FK isolation and atomic D1 batch rollback", async () => {
  const c = context();
  try {
    await ok(c, "CreatePlan", { planId: PLAN, title: "Neutral lifecycle", planCreatedAt: { precision: "dateOnly", on: "2027-01-01", timeZone: "UTC" } });
    await ok(c, "StartPlan", { planId: PLAN }, 0); c.advance(10); await ok(c, "FinishPlan", { planId: PLAN }, 1);
    assert.equal(c.db.sqlite.prepare("SELECT selection_status FROM plan_estimation_inputs").get().selection_status, "MISSING_FEATURES");
    const before = rows(c);
    await assert.rejects(c.db.batch([
      c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").bind('transaction-will-rollback', c.now()),
      c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,NULL)").bind('invalid'),
    ]));
    assert.deepEqual(rows(c), before);
    const other = await command(c, "CreatePlan", { planId: OTHER, title: "Other owner", planCreatedAt: { precision: "dateOnly", on: "2027-01-01", timeZone: "UTC" } }, undefined, undefined, 'other-owner');
    assert.equal(other.status, 200);
    assert.throws(() => c.db.sqlite.prepare("INSERT INTO estimation_jobs(owner_id,job_key,kind,plan_id,created_at,updated_at) VALUES(?,?,'REFRESH_SAMPLE',?,0,0)").run(OWNER, 'refresh:' + OTHER, OTHER), /FOREIGN KEY/);
    assert.deepEqual(c.db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { c.close(); }
});

test("model manifests and active pointers cannot reference another owner's records", async () => {
  const c = context();
  try {
    await completeAtlm(c, await plannedAtlm(c));
    const lease = await claimAtlmJob(c.db, OWNER, 'refresh:' + PLAN, c.now());
    const saved = await persistAtlmSample(c.db, OWNER, await readAtlmSampleSource(c.db, OWNER, PLAN, c.now()), c.now(), lease);
    c.db.sqlite.prepare("INSERT INTO owners(owner_id,created_at) VALUES('other-owner',0)").run();
    const statement = c.db.sqlite.prepare("INSERT INTO estimation_models(owner_id,model_id,model_version,status,manifest_json,dataset_digest,train_cutoff,sample_count,created_at) VALUES(?,'model',1,'REJECTED',?,'digest',0,1,0)");
    assert.throws(() => statement.run('other-owner', JSON.stringify([Number(saved.sample.sampleId)])), /ATLM_MODEL_SOURCE_NOT_FOUND/);
    statement.run('other-owner', '[]');
    assert.throws(() => c.db.sqlite.prepare("UPDATE estimation_owner_state SET active_model_id='model' WHERE owner_id=?").run(OWNER), /FOREIGN KEY/);
  } finally { c.close(); }
});
