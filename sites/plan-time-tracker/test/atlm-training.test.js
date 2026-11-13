import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processEstimationTraining, getEstimationModelStatus, predictWithActiveModel,
  normalizeAgentTaskV1, claimAtlmJob, scheduleAtlmTraining, readAtlmSamples, evaluateHybridAtlmChronologically } from "../worker/index.js";
import { context, plannedAtlm, completeAtlm, atlmTask, atlmAssessment, command, ok, mcp, rows, OWNER } from "./fixtures/tracker-db.mjs";
const features = normalizeAgentTaskV1(atlmTask()).features;
const drain = c => processEstimationTraining(c.db, OWNER, c.now(), { clock: c.now });
const status = c => getEstimationModelStatus(c.db, OWNER, c.now());
const trainJob = c => c.db.sqlite.prepare("SELECT * FROM estimation_jobs WHERE owner_id=? AND job_key='train'").get(OWNER);
const models = c => c.db.sqlite.prepare("SELECT * FROM estimation_models WHERE owner_id=? ORDER BY model_version").all(OWNER);
async function completed(c, duration = 1000, task = atlmTask()) {
  const plan = await plannedAtlm(c, crypto.randomUUID(), task);
  await completeAtlm(c, plan, duration); c.advance(1); return plan;
}
async function experience(c, count, { processEach = false, duration = 1000 } = {}) {
  const plans = [];
  for (let i = 0; i < count; i++) { plans.push(await completed(c, duration)); if (processEach) await drain(c); }
  return plans;
}
// Interleave actual D1 operations; batch stays transactional in the fixture.
function intercept(c, predicate, callback, method = "first") {
  const prepare = c.db.prepare;
  c.db.prepare = function(sql) {
    const statement = prepare.call(this, sql), bind = statement.bind.bind(statement);
    statement.bind = (...args) => {
      const bound = bind(...args), execute = bound[method].bind(bound);
      if (predicate(sql, args)) bound[method] = () => callback(execute, sql, args);
      return bound;
    }; return statement;
  }; return () => { c.db.prepare = prepare; };
}
function pauseOnce(c, predicate) {
  let announce, resume, selected = false;
  const reached = new Promise(resolve => { announce = resolve; });
  const continued = new Promise(resolve => { resume = resolve; });
  const restore = intercept(c, (sql, args) => !selected && predicate(sql, args), async execute => {
    selected = true; const result = await execute(); announce(result); await continued; return result;
  });
  return { reached, release: () => { restore(); resume(); } };
}
const snapshotWrite = sql => sql.includes("UPDATE estimation_jobs SET snapshot_json=?");

test("model status is read-only, owner scoped and does not invent a cold model", async () => {
  const c = context();
  try {
    const before = rows(c), s = await status(c);
    assert.equal(s.training.due, false); assert.equal(s.training.status, "COLLECTING_DATA");
    assert.equal(s.activeModel, null); assert.equal(s.eligibleSampleCount, 0);
    assert.equal((await predictWithActiveModel(c.db, OWNER, features, c.now())).unavailableReason, "COLLECTING_DATA");
    assert.deepEqual(rows(c), before);
    await experience(c, 1); await drain(c);
    const other = await getEstimationModelStatus(c.db, "unrelated-owner", c.now());
    assert.equal(other.eligibleSampleCount, 0); assert.equal(other.training.due, false);
  } finally { c.close(); }
});

test("one to two eligible plans triggers once; receipt replay and excluded plans add no experience", async () => {
  const c = context();
  try {
    await experience(c, 1, { processEach: true });
    assert.equal((await status(c)).newPlansSinceTraining, 1); assert.equal(trainJob(c), undefined);
    const incomplete = atlmTask(); incomplete.outcomes = null;
    await completed(c, 1000, incomplete); await drain(c);
    assert.equal((await status(c)).excludedSampleCount, 1); assert.equal(trainJob(c), undefined);
    const second = await completed(c);
    const receipt = c.db.sqlite.prepare("SELECT command_id FROM command_receipts WHERE owner_id=? AND plan_id=? AND command_type='FinishPlan'").get(OWNER, second.planId);
    assert.equal((await status(c)).training.due, true);
    const tasks = []; scheduleAtlmTraining(c.db, OWNER, c.now(), { waitUntil(task) { tasks.push(task); } }, c.now);
    await Promise.all(tasks);
    const after = await status(c);
    assert.equal(after.eligibleSampleCount, 2); assert.equal(after.newPlansSinceTraining, 0);
    assert.equal(after.training.generation, 1); assert.equal(after.training.due, false);
    assert.equal(after.training.status, "IDLE"); assert.equal(after.lastReason, null);
    assert.equal(after.activeModel.accuracy,"EXPERIMENTAL");
    assert.equal((await command(c, "FinishPlan", { planId: second.planId }, 1, receipt.command_id)).status, 200);
    await drain(c); assert.deepEqual(await status(c), after);
    assert.equal(models(c).length, 1); assert.equal(JSON.parse(models(c)[0].manifest_json).length, 2);
  } finally { c.close(); }
});

test("accumulated candidates preserve immutable artifacts and a median tie retains the incumbent", async () => {
  const c = context();
  try {
    await experience(c, 15); await drain(c);
    const first = await status(c), artifact = models(c).at(-1);
    assert.equal(first.activeModel.sampleCount, 15); assert.equal(first.activeModel.evaluation.caseCount, 0);
    assert.equal((await predictWithActiveModel(c.db, OWNER, features, c.now())).pointMs, 1000);
    assert.throws(() => c.db.sqlite.prepare("UPDATE estimation_models SET manifest_json='[]' WHERE owner_id=? AND model_id=?").run(OWNER, artifact.model_id), /ATLM_MODEL_IMMUTABLE/);
    c.advance(1); await experience(c, 5); await drain(c);
    const second = await status(c), history = models(c);
    assert.equal(second.activeModel.modelId, first.activeModel.modelId); assert.equal(history.at(-1).sample_count, 20);
    assert.equal(second.lastReason,"MEDIAN_BASELINE_NOT_WORSE");
    assert.equal(history.find(m => m.model_id === artifact.model_id).status, "ACTIVE");
    assert.equal(history.find(m => m.model_id === artifact.model_id).artifact_json, artifact.artifact_json);
    assert.equal(history.filter(m => m.status === "ACTIVE").length, 1);
    assert.equal(JSON.parse(history.at(-1).metrics_json).selection.selectedEngine, "MEDIAN");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM estimation_samples").get().n, 20);
  } finally { c.close(); }
});

test("a worse candidate is rejected without changing the active prediction or retrying its same five plans", async () => {
  const c = context();
  try {
    await experience(c, 15); await drain(c);
    const before = await predictWithActiveModel(c.db, OWNER, features, c.now());
    c.advance(1); await completed(c, 100000); await experience(c, 4); await drain(c);
    const s = await status(c);
    assert.equal(s.training.status, "REJECTED"); assert.equal(s.lastReason, "MEDIAN_BASELINE_NOT_WORSE");
    assert.equal(s.training.due, false); assert.equal(s.newPlansSinceTraining, 0); assert.equal(models(c).at(-1).status, "REJECTED");
    assert.deepEqual(await predictWithActiveModel(c.db, OWNER, features, c.now()), before);
    await drain(c); assert.equal(models(c).length, 2);
  } finally { c.close(); }
});

test("a second runner cannot replace a leased snapshot; another five plans survive finalization", async () => {
  const c = context(); let paused, pending;
  try {
    await experience(c, 15, { duration: 10 });
    paused = pauseOnce(c, snapshotWrite); pending = drain(c);
    const initial = await paused.reached, frozen = initial.snapshot_json;
    assert.equal(JSON.parse(frozen).manifest.length, 15);
    await experience(c, 5, { duration: 10 });
    assert.equal((await drain(c)).training.status, "RUNNING"); assert.equal(trainJob(c).snapshot_json, frozen);
    assert.equal(models(c).length, 0); paused.release(); await pending;
    const history = models(c);
    assert.deepEqual(history.map(m => m.sample_count), [15, 20]);
    assert.equal(JSON.parse(history[0].manifest_json).length, 15); assert.equal(history[1].status, "ACTIVE");
    assert.equal((await status(c)).newPlansSinceTraining, 0);
  } finally { paused?.release(); if (pending) await pending.catch(() => {}); c.close(); }
});

test("stale fence cannot checkpoint or activate; an expired lease resumes its frozen manifest", async () => {
  const c = context(); let paused, pending;
  try {
    await experience(c, 15); paused = pauseOnce(c, snapshotWrite); pending = drain(c);
    const initial = await paused.reached; c.advance(60001);
    const replacement = await claimAtlmJob(c.db, OWNER, "train", c.now());
    assert.ok(replacement.fence > initial.fence); assert.equal(replacement.snapshot_json, initial.snapshot_json);
    paused.release(); await pending;
    assert.equal(models(c).length, 0); assert.equal(trainJob(c).fence, replacement.fence);
    c.advance(60001);
    assert.equal((await drain(c)).training.status, "RETRY_WAIT");
    assert.equal(trainJob(c).next_attempt_at, replacement.lease_until + 300000);
    c.advance(300000); await drain(c);
    assert.equal((await status(c)).activeModel.sampleCount, 15);
    assert.equal(models(c).length, 1); assert.equal(trainJob(c).attempts, 3);
  } finally { paused?.release(); if (pending) await pending.catch(() => {}); c.close(); }
});

test("checkpoint survives a database reopen and queued continuation does not consume a retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "atlm-restart-")), databasePath = join(directory, "tracker.sqlite");
  let c = context(undefined, { databasePath }), paused, pending;
  try {
    await experience(c, 15); paused = pauseOnce(c, snapshotWrite); pending = drain(c);
    const initial = await paused.reached;
    c.advance(60001); paused.release(); await pending;
    const persisted = trainJob(c), resumeAt = c.now();
    c.db.sqlite.prepare("UPDATE estimation_jobs SET status='QUEUED',lease_until=NULL WHERE owner_id=? AND job_key='train'").run(OWNER);
    c.close(); c = context(0, { databasePath }); c.advance(resumeAt - c.now()); await drain(c);
    assert.equal(trainJob(c).attempts, persisted.attempts);
    assert.equal(models(c)[0].manifest_json, JSON.stringify(JSON.parse(initial.snapshot_json).manifest));
    assert.equal((await status(c)).activeModel.sampleCount, 15);
  } finally { paused?.release(); if (pending) await pending.catch(() => {}); c.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("source deletion immediately invalidates predictions and retrains without counting an old plan twice", async () => {
  const c = context();
  try {
    const plans = await experience(c, 15); await drain(c); const old = (await status(c)).activeModel;
    await ok(c, "DeletePlan", { planId: plans[0].planId }, 2);
    assert.equal((await predictWithActiveModel(c.db, OWNER, features, c.now())).unavailableReason, "MODEL_INVALIDATED");
    assert.equal((await status(c)).training.due, true); await drain(c);
    const replaced = await status(c);
    assert.equal(replaced.activeModel.sampleCount, 14); assert.notEqual(replaced.activeModel.modelId, old.modelId);
    assert.equal(replaced.newPlansSinceTraining, 0); assert.equal(replaced.excludedSampleCount, 1);
    c.advance(1); await ok(c, "RestorePlan", { planId: plans[0].planId }, 3); await drain(c);
    assert.equal(c.db.sqlite.prepare("SELECT new_sample_count FROM estimation_owner_state").get().new_sample_count, 15);
  } finally { c.close(); }
});

test("source change between snapshot and activation cannot activate contaminated history", async () => {
  const c = context(); let paused, pending;
  try {
    const plans = await experience(c, 15); paused = pauseOnce(c, snapshotWrite); pending = drain(c);
    const original = await paused.reached;
    await ok(c, "UpdatePlanMetadata", { planId: plans[0].planId, title: "Scope changed after capture" }, 2);
    paused.release(); await pending;
    assert.equal((await status(c)).activeModel, null); assert.equal(models(c).filter(m => m.status === "ACTIVE").length, 0);
    await drain(c); const active = models(c).find(m => m.status === "ACTIVE");
    assert.equal(active.sample_count, 14);
    assert.notEqual(active.model_version, JSON.parse(original.snapshot_json).modelVersion, "obsolete snapshot requires a new generation");
    assert.equal((await status(c)).newPlansSinceTraining, 0);
  } finally { paused?.release(); if (pending) await pending.catch(() => {}); c.close(); }
});

test("transient refresh failures obey 1/5/15 minute backoff then stop at four attempts", async () => {
  const c = context(); let restore;
  try {
    const plan = await completed(c);
    restore = intercept(c, sql => sql.startsWith("SELECT p.*,"), async () => { throw new Error("injected storage failure"); });
    const waits = [60000, 300000, 900000];
    for (let attempt = 1; attempt <= 4; attempt++) {
      await assert.rejects(drain(c), error => error.code === "SOURCE_UNAVAILABLE");
      const job = c.db.sqlite.prepare("SELECT * FROM estimation_jobs WHERE owner_id=? AND job_key=?").get(OWNER, "refresh:" + plan.planId);
      assert.equal(job.attempts, attempt); assert.equal(job.status, attempt === 4 ? "FAILED" : "RETRY_WAIT");
      if (attempt < 4) { assert.equal(job.next_attempt_at, c.now() + waits[attempt - 1]); assert.equal((await drain(c)).training.due, false); c.advance(waits[attempt - 1]); }
    }
    restore(); const failed = await drain(c);
    assert.equal(failed.training.status, "FAILED"); assert.equal(failed.training.due, false);
    await ok(c, "UpdatePlanMetadata", { planId: plan.planId, title: "New source generation" }, 2); await drain(c);
    assert.equal(c.db.sqlite.prepare("SELECT attempts FROM estimation_jobs WHERE plan_id=?").get(plan.planId).attempts, 1);
  } finally { restore?.(); c.close(); }
});

test("a crashed fourth training attempt fails visibly without immediately requeueing the same experience", async () => {
  const c = context(); let paused, pending;
  try {
    await experience(c, 15); paused = pauseOnce(c, snapshotWrite); pending = drain(c); await paused.reached;
    c.db.sqlite.prepare("UPDATE estimation_jobs SET attempts=4 WHERE owner_id=? AND job_key='train'").run(OWNER);
    c.advance(60001); paused.release(); await pending;
    const s = await drain(c);
    assert.equal(s.training.status, "FAILED"); assert.equal(s.lastError, "LEASE_EXPIRED");
    assert.equal(s.training.due, false); assert.equal(s.newPlansSinceTraining, 0);
    const generation = trainJob(c).generation; await drain(c); assert.equal(trainJob(c).generation, generation);
  } finally { paused?.release(); if (pending) await pending.catch(() => {}); c.close(); }
});

test("background scheduling failures cannot alter a successful Finish receipt", async () => {
  const c = context();
  try {
    const plan = await completed(c), before = c.db.sqlite.prepare("SELECT result_json FROM command_receipts WHERE owner_id=? AND plan_id=? AND command_type='FinishPlan'").get(OWNER, plan.planId);
    const originalError = console.error, errors = []; console.error = text => errors.push(text);
    try {
      const queued = [], badDb = { prepare() { throw new Error("offline"); } };
      scheduleAtlmTraining(badDb, OWNER, c.now(), { waitUntil(task) { queued.push(task); } }, c.now); await Promise.all(queued);
      scheduleAtlmTraining(badDb, OWNER, c.now(), { waitUntil() { throw new Error("context expired"); } }, c.now);
      await new Promise(resolve => setImmediate(resolve)); assert.ok(errors.some(text => text.includes("atlm_training_background_error")));
    } finally { console.error = originalError; }
    assert.deepEqual(c.db.sqlite.prepare("SELECT result_json FROM command_receipts WHERE owner_id=? AND plan_id=? AND command_type='FinishPlan'").get(OWNER, plan.planId), before);
    assert.equal(c.db.sqlite.prepare("SELECT status FROM plans WHERE plan_id=?").get(plan.planId).status, "COMPLETED");
    await drain(c); assert.equal((await status(c)).eligibleSampleCount, 1);
  } finally { c.close(); }
});

test("training failure before snapshot obeys four attempts and acknowledges the failed experience", async () => {
  const c = context(); const batch = c.db.batch.bind(c.db);
  try {
    await experience(c, 5);
    c.db.batch = statements => {
      if (statements[0]?.sql === "SELECT * FROM estimation_owner_state WHERE owner_id=?") throw new Error("injected snapshot read failure");
      return batch(statements);
    };
    for (let attempt = 1; attempt <= 4; attempt++) {
      await assert.rejects(drain(c), error => error.code === "SOURCE_UNAVAILABLE");
      assert.equal(trainJob(c).attempts, attempt);
      if (attempt < 4) c.advance([60000, 300000, 900000][attempt - 1]);
    }
    c.db.batch = batch;
    const s = await drain(c);
    assert.equal(s.training.status, "FAILED"); assert.equal(s.training.due, false);
    assert.equal(s.newPlansSinceTraining, 0); assert.equal(s.training.generation, 1);
    assert.equal(s.lastError, "TRAINING_EXECUTION_FAILED");
    await experience(c, 5); await drain(c); assert.equal(trainJob(c).generation, 2);
  } finally { c.db.batch = batch; c.close(); }
});

test("sample capture uses the observed read cutoff and never fits a future source", async () => {
  const c = context(); const batch = c.db.batch.bind(c.db);
  try {
    await experience(c, 15);
    let changed = false, observedCutoff;
    c.db.batch = async statements => {
      if (!changed && statements[0]?.sql === "SELECT * FROM estimation_owner_state WHERE owner_id=?") {
        changed = true; await completed(c); await drain(c); observedCutoff = c.now();
      }
      return batch(statements);
    };
    await drain(c);
    assert.equal(models(c)[0].train_cutoff, observedCutoff);
    assert.equal(models(c)[0].sample_count, 16);
    assert.equal(JSON.parse(models(c)[0].metrics_json).cutoff, observedCutoff);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM estimation_samples s,json_each(?) m WHERE s.sequence=m.value AND s.source_available_at>?")
      .get(models(c)[0].manifest_json, observedCutoff).n, 0);
  } finally { c.db.batch = batch; c.close(); }
});

// Storage capacity fixture only: clone checked rows with valid FK identities. This
// exercises 5001 accumulated samples without pretending these are real model evidence.
function cloneStoredExperience(c, sourcePlanId, count) {
  const plan = c.db.sqlite.prepare("SELECT * FROM plans WHERE plan_id=?").get(sourcePlanId);
  const assessment = c.db.sqlite.prepare("SELECT * FROM assessment_revisions WHERE plan_id=?").get(sourcePlanId);
  const receipt = c.db.sqlite.prepare("SELECT * FROM command_receipts WHERE command_id=?").get(assessment.command_id);
  const sample = c.db.sqlite.prepare("SELECT * FROM estimation_samples WHERE plan_id=?").get(sourcePlanId);
  const prepare = (table, example, omitted = []) => {
    const names = Object.keys(example).filter(key => !omitted.includes(key));
    const insert = c.db.sqlite.prepare(`INSERT INTO ${table}(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`);
    return row => insert.run(...names.map(key => row[key]));
  };
  const insertPlan = prepare("plans", plan), insertReceipt = prepare("command_receipts", receipt);
  const insertAssessment = prepare("assessment_revisions", assessment, ["sequence"]), insertSample = prepare("estimation_samples", sample, ["sequence"]);
  c.db.sqlite.exec("BEGIN");
  try {
    for (let i = 0; i < count; i++) {
      const planId = crypto.randomUUID(), commandId = crypto.randomUUID();
      insertPlan({ ...plan, plan_id: planId });
      insertReceipt({ ...receipt, plan_id: planId, command_id: commandId });
      const inserted = insertAssessment({ ...assessment, plan_id: planId, command_id: commandId, assessment_id: crypto.randomUUID() });
      insertSample({ ...sample, plan_id: planId, input_assessment_sequence: Number(inserted.lastInsertRowid), source_digest: "capacity-" + i });
    }
    c.db.sqlite.exec("COMMIT");
  } catch (error) { c.db.sqlite.exec("ROLLBACK"); throw error; }
}

test("5001 accumulated eligible samples are retained with an explicit resource failure and old model preserved", async () => {
  const c = context();
  try {
    const plans = await experience(c, 15); await drain(c); const before = await predictWithActiveModel(c.db, OWNER, features, c.now());
    cloneStoredExperience(c, plans[0].planId, 5001 - plans.length);
    const s = await drain(c);
    assert.equal(s.eligibleSampleCount, 5001); assert.equal(s.training.status, "FAILED");
    assert.equal(s.lastReason, "DATASET_LIMIT_REACHED"); assert.equal(s.lastError, "DATASET_LIMIT_REACHED");
    assert.equal(s.training.due, false); assert.equal(s.newPlansSinceTraining, 0);
    assert.deepEqual(await predictWithActiveModel(c.db, OWNER, features, c.now()), before);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM estimation_samples").get().n, 5001);
    assert.equal(models(c).at(-1).artifact_json, null);
  } finally { c.close(); }
});

test("concurrent second and third completions and drains allocate a single training generation", async () => {
  const c = context();
  try {
    await experience(c, 1, { processEach: true }); await experience(c, 2);
    await Promise.all([drain(c), drain(c)]);
    assert.equal((await status(c)).eligibleSampleCount, 3); assert.equal(models(c).length, 1);
    assert.equal(trainJob(c).generation, 1); assert.equal(models(c)[0].sample_count, 3);
  } finally { c.close(); }
});

test("a ten second bounded pass checkpoints between cases and resumes without spending retries", async () => {
  const c = context(); let restore;
  try {
    await experience(c, 15);
    let elapsed = 0;
    restore = intercept(c, sql => sql.startsWith("UPDATE estimation_jobs SET checkpoint_json=?"), async execute => {
      const result = await execute(); elapsed = 10000; return result;
    });
    const first = await processEstimationTraining(c.db, OWNER, c.now(), { clock: c.now, wallClock: () => elapsed });
    restore();
    assert.equal(first.training.status, "QUEUED"); assert.equal(first.training.due, true);
    assert.equal(first.training.progress.completedCases, 0); assert.equal(first.training.progress.totalCases, 15);
    assert.equal(first.training.progress.phase,"BASE_CASE");
    assert.equal(Object.keys(JSON.parse(trainJob(c).checkpoint_json).baseCases).length,1);
    const checkpoint = trainJob(c), snapshot = checkpoint.snapshot_json;
    assert.equal(checkpoint.attempts, 1); assert.equal(models(c).length, 0);
    await drain(c);
    assert.equal(trainJob(c).attempts, 1); assert.equal(trainJob(c).snapshot_json, snapshot);
    assert.equal((await status(c)).activeModel.sampleCount, 15);
  } finally { restore?.(); c.close(); }
});

test("fit waits for another pass when its checkpoint consumed the remaining wall budget", async () => {
  const c = context(); let restore;
  try {
    await experience(c, 15); let elapsed = 0;
    restore = intercept(c, (sql, args) => sql.startsWith("UPDATE estimation_jobs SET checkpoint_json=?")
      && JSON.parse(args[0]).phase === "FIT", async execute => { const result = await execute(); elapsed = 10001; return result; });
    const first = await processEstimationTraining(c.db, OWNER, c.now(), { clock: c.now, wallClock: () => elapsed });
    restore();
    assert.equal(first.activeModel, null); assert.equal(first.training.status, "QUEUED");
    assert.equal(first.training.progress.phase, "FIT"); assert.equal(models(c).length, 0);
    await drain(c); assert.equal((await status(c)).activeModel.sampleCount, 15);
  } finally { restore?.(); c.close(); }
});

test("a lease expiring mid-pass cannot be claimed without durable retry backoff", async () => {
  const c = context(); const batch = c.db.batch.bind(c.db);
  try {
    const plan = await completed(c), key = "refresh:" + plan.planId;
    await claimAtlmJob(c.db, OWNER, key, c.now()); c.advance(60001);
    const second = await claimAtlmJob(c.db, OWNER, key, c.now()); c.advance(59999);
    let advanced = false;
    c.db.batch = async statements => {
      const result = await batch(statements);
      if (!advanced && statements.some(s => s.sql.includes("last_training_reason='LEASE_EXPIRED'"))) { advanced = true; c.advance(2); }
      return result;
    };
    await drain(c);
    const after = c.db.sqlite.prepare("SELECT * FROM estimation_jobs WHERE job_key=?").get(key);
    assert.equal(after.attempts, 2); assert.equal(after.status, "RUNNING");
    const waiting = await drain(c); assert.equal(waiting.training.status, "RETRY_WAIT");
    assert.equal(waiting.training.nextAttemptAt, second.lease_until + 300000);
  } finally { c.db.batch = batch; c.close(); }
});

test("atomic claim cannot bypass backoff when another lease expires after the ready-job read", async () => {
  const c = context(); let restore;
  try {
    const plan = await completed(c), key = "refresh:" + plan.planId;
    let interleaved = false;
    restore = intercept(c, sql => !interleaved && sql.startsWith("SELECT * FROM estimation_jobs j WHERE"), async execute => {
      const selected = await execute(); interleaved = true;
      await claimAtlmJob(c.db, OWNER, key, c.now()); c.advance(60001); return selected;
    });
    await drain(c); restore();
    const after = c.db.sqlite.prepare("SELECT * FROM estimation_jobs WHERE job_key=?").get(key);
    assert.equal(after.attempts, 1); assert.equal(after.status, "RUNNING");
    assert.equal((await drain(c)).training.status, "RETRY_WAIT");
  } finally { restore?.(); c.close(); }
});


test("late-ingested batches persist early models without inventing historical checks",async()=>{
  for(const n of [1,2,5,6]){
    const c=context();try{
      await experience(c,n);
      const response=await mcp(c,"StartTraining");assert.equal(response.value.result.isError,undefined,JSON.stringify(response.value));
      const state=await status(c),model=models(c).at(-1);
      assert.equal(state.activeModel.sampleCount,n);
      assert.equal(state.activeModel.evaluation.caseCount,0);
      assert.equal(model.method_version,"agent-v3-hybrid");assert.equal(model.feature_version,"agent-task-v2");
      const before=rows(c),prediction=await predictWithActiveModel(c.db,OWNER,features,c.now());
      assert.equal(prediction.pointMs,1000);
      assert.equal(prediction.accuracy,"EXPERIMENTAL");
      assert.equal(prediction.evaluation.qualityConfirmed,false);
      if(n===1)assert.equal(prediction.evaluation.maeMs,null);
      assert.deepEqual(rows(c),before,"inference reuses immutable stored artifacts without training or writes");
    }finally{c.close();}
  }
});

test("a checkpoint from another method restarts evaluation under the current lease",async()=>{
  const c=context();let paused,pending;
  try{
    await experience(c,2);
    paused=pauseOnce(c,snapshotWrite);pending=drain(c);const initial=await paused.reached;
    c.advance(60001);const lease=await claimAtlmJob(c.db,OWNER,'train',c.now());assert(lease.fence>initial.fence);
    const old=JSON.parse(lease.snapshot_json);old.methodVersion='agent-v1';old.featureSchemaVersion='agent-task-v1';
    c.db.sqlite.prepare("UPDATE estimation_jobs SET snapshot_json=?,checkpoint_json=? WHERE owner_id=? AND job_key='train'")
      .run(JSON.stringify(old),JSON.stringify({phase:'EVALUATE',cases:[{sampleId:'invalid-old-case'}],progressRevision:1}),OWNER);
    paused.release();await pending;c.advance(60001);await drain(c);c.advance(300000);await drain(c);
    assert.equal((await status(c)).activeModel.sampleCount,2);
    const job=trainJob(c);assert.equal(JSON.parse(job.snapshot_json).methodVersion,'agent-v3-hybrid');
    assert.equal(JSON.parse(job.checkpoint_json).cases.length,2);
    assert.equal((await predictWithActiveModel(c.db,OWNER,features,c.now())).pointMs,1000);
  }finally{paused?.release();if(pending)await pending.catch(()=>{});c.close();}
});

test("ridge unblocks failed OLS and attempt diagnostics stay independent of later counts",async()=>{
 const c=context();try{
  await completed(c);
  const t=atlmTask();t.profile.workKind="CREATE_MECHANISM";t.profile.reuseState="ABSENT";
  t.outcomes.push({id:"second",description:"Second independent result",evidence:"Synthetic requirement"});
  await completed(c,2000,t);await drain(c);
  const first=await status(c);
  assert.equal(first.lastReason,null);
  assert.equal(first.lastAttempt.code,"AVAILABLE");
  assert.equal(first.lastAttempt.candidates.ols.reason,"INSUFFICIENT_DATA");
  assert.equal(first.lastAttempt.candidates.ols.sampleCount,2);
  assert.equal(first.lastAttempt.candidates.ols.p,4);
  assert.equal(first.lastAttempt.candidates.ridge.status,"AVAILABLE");
  assert.equal(first.lastAttempt.selection.selectedEngine,"RIDGE");
  const snapshot=JSON.stringify(first.lastAttempt);
  await completed(c);await drain(c);
  const next=await status(c);assert.equal(next.eligibleSampleCount,3);
  assert.equal(JSON.stringify(next.lastAttempt),snapshot);
  const other=await getEstimationModelStatus(c.db,"unrelated-owner",c.now());
  assert.equal(other.lastAttempt,null);
  const preview=await predictWithActiveModel(c.db,OWNER,features,c.now());
  assert.equal(preview.status,"AVAILABLE");assert.equal(preview.hybrid.usedEngine,"RIDGE");assert.equal(preview.sampleCount,2);
 }finally{c.close();}
});

test("ingested reference history validates the whole policy and preserves a readable legacy OLS model",async()=>{
  const c=context();try{
    // Existing numerical reference facts, not invented durations or owner records.
    const reference=JSON.parse(readFileSync(new URL('./fixtures/atlm-reference.json',import.meta.url)));
    for(const row of reference.cases[0].rows.slice(0,12)){
      const f=row.features,task=atlmTask();
      task.profile=Object.fromEntries(['workKind','reuseState','doneBoundary'].map(k=>[k,f[k]]));
      task.outcomes=Array.from({length:f.outcomeCount},(_,i)=>({id:'out-'+i,description:'Reference outcome',evidence:'Existing reference fixture'}));
      task.changedContracts=Array.from({length:f.contractCount},(_,i)=>({kind:'OTHER',key:'contract-'+i,description:'Reference contract',evidence:'Existing reference fixture'}));
      task.verificationKinds=['BUILD_STATIC','UNIT','INTEGRATION','UI_E2E','DEPLOY_SMOKE'].slice(0,f.verificationKindCount);
      const p=await plannedAtlm(c,crypto.randomUUID(),task);await completeAtlm(c,p,row.actualMs);await drain(c);c.advance(1);
    }
    const current=await status(c);
    assert.equal(current.activeModel.accuracy,'HISTORICALLY_EVALUATED');
    assert.equal(current.activeModel.hybrid.selectedEngine,'OLS');
    assert.equal(current.activeModel.evaluation.protocolVersion,2);
    assert.equal(current.activeModel.evaluation.metricsScope,'FULL_POLICY');
    assert(current.activeModel.evaluation.maeMs<current.activeModel.evaluation.medianBaselineMaeMs);
    assert.equal(current.activeModel.evaluation.caseCount,11);
    assert.equal(current.activeModel.evaluation.modelCaseCount,10);
    const active=models(c).find(m=>m.status==='ACTIVE'),artifact=JSON.parse(active.artifact_json);
    const journal=await readAtlmSamples(c.db,OWNER,{latestOnly:false});
    const replay=await evaluateHybridAtlmChronologically(journal,{cutoff:active.train_cutoff});
    assert.deepEqual(JSON.parse(active.metrics_json).cases,replay.cases,'SQL as-of reads equal the immutable journal replay');
    assert.deepEqual(JSON.parse(active.metrics_json).metrics,replay.metrics);
    const hybrid=await predictWithActiveModel(c.db,OWNER,features,c.now());
    const old=artifact.candidates.ols.artifact;
    c.db.sqlite.prepare("UPDATE estimation_models SET status='RETIRED' WHERE owner_id=? AND model_id=?").run(OWNER,active.model_id);
    c.db.sqlite.prepare(`INSERT INTO estimation_models(owner_id,model_id,model_version,status,artifact_json,manifest_json,dataset_digest,
      train_cutoff,metrics_json,sample_count,created_at,method_version,feature_version)
      VALUES(?,'legacy-v2',1000,'ACTIVE',?,?,?,?,?,?,?,'agent-v2','agent-task-v2')`)
      .run(OWNER,JSON.stringify(old),active.manifest_json,old.datasetDigest,active.train_cutoff,active.metrics_json,old.n,c.now());
    c.db.sqlite.prepare("UPDATE estimation_owner_state SET active_model_id='legacy-v2' WHERE owner_id=?").run(OWNER);
    const legacy=await predictWithActiveModel(c.db,OWNER,features,c.now());
    assert.equal(legacy.status,'AVAILABLE');assert.equal(legacy.pointMs,hybrid.pointMs);
    assert.equal(legacy.method.version,'agent-v2');assert.equal(legacy.hybrid,undefined);
    const next=await plannedAtlm(c,crypto.randomUUID());
    await ok(c,'RecordAssessment',await atlmAssessment(c,next.planId,atlmTask(),{predictionRequest:{method:'ATLM',methodVersion:1}}),0);
    const saved=(await mcp(c,'GetSavedEstimate',{planId:next.planId})).value.result.structuredContent;
    assert.equal(saved.serverEstimation.method.version,'agent-v2','read and guarded forecast write support the same legacy model');
  }finally{c.close();}
});
