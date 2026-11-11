import test from "node:test";
import assert from "node:assert/strict";
import { readAtlmSampleSource, persistAtlmSample, claimAtlmJob, readAtlmSamples } from "../worker/index.js";
import { context, command, ok, atlmTask, atlmAssessment, plannedAtlm, completeAtlm, result, check, PLAN, OWNER } from "./fixtures/tracker-db.mjs";
const input = c => c.db.sqlite.prepare("SELECT * FROM plan_estimation_inputs WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN);
const job = c => c.db.sqlite.prepare("SELECT * FROM estimation_jobs WHERE owner_id=? AND job_key=?").get(OWNER, 'refresh:' + PLAN);
async function save(c, planId = PLAN) {
  const lease = await claimAtlmJob(c.db, OWNER, 'refresh:' + planId, c.now());
  assert.ok(lease);
  const src = await readAtlmSampleSource(c.db, OWNER, planId, c.now());
  return { ...(await persistAtlmSample(c.db, OWNER, src, c.now(), lease)), lease, src };
}

test("first Start freezes existing revision by commit order, not its reported timestamp", async () => {
  const c = context();
  try {
    const planned = await plannedAtlm(c), firstSequence = c.db.sqlite.prepare("SELECT sequence FROM assessment_revisions").get().sequence;
    await ok(c, "StartPlan", { planId: PLAN }, 0);
    assert.equal(input(c).assessment_sequence, firstSequence);
    c.advance(-1);
    const newer = atlmTask(); newer.outcomes = [];
    await ok(c, "RecordAssessment", await atlmAssessment(c, PLAN, newer), 0);
    assert.equal(input(c).assessment_sequence, firstSequence);
    assert.throws(() => c.db.sqlite.exec("UPDATE plan_estimation_inputs SET assessment_sequence=NULL"), /ATLM_INPUT_IMMUTABLE/);
    c.advance(2); await ok(c, "PausePlan", { planId: PLAN }, 1); await ok(c, "ResumePlan", { planId: PLAN }, 2);
    assert.equal(input(c).assessment_sequence, firstSequence);
  } finally { c.close(); }
});

test("missing or outdated pre-start assessment cannot be repaired by a late revision", async () => {
  const c = context();
  try {
    await plannedAtlm(c);
    await ok(c, "UpdatePlanMetadata", { planId: PLAN, description: "Expanded before start" }, 0);
    await ok(c, "StartPlan", { planId: PLAN }, 1);
    assert.equal(input(c).selection_status, "MISSING_FEATURES");
    await ok(c, "RecordAssessment", await atlmAssessment(c), 0);
    const source = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
    assert.ok(source.reasons.includes("MISSING_FEATURES"));
    assert.equal(input(c).assessment_sequence, null);
  } finally { c.close(); }
});

test("verified completion yields exact full plan duration, genuine zero and one experience", async () => {
  const c = context();
  try {
    await completeAtlm(c, await plannedAtlm(c), 0);
    const source = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
    assert.equal(source.eligibility, "ELIGIBLE", JSON.stringify(source)); assert.equal(source.actualMs, 0);
    const saved = await save(c); assert.equal(saved.inserted, true); assert.equal(saved.sample.firstEligible, true);
    assert.equal(saved.sample.features.outcomeCount, 1);
    const repeated = await persistAtlmSample(c.db, OWNER, saved.src, c.now(), saved.lease); assert.equal(repeated.inserted, false);
    const state = c.db.sqlite.prepare("SELECT * FROM estimation_owner_state WHERE owner_id=?").get(OWNER);
    assert.equal(state.new_sample_count, 1); assert.equal(state.dataset_revision, 1);
    assert.throws(() => c.db.sqlite.exec("UPDATE estimation_samples SET actual_ms=42"), /ATLM_SAMPLE_IMMUTABLE/);
    assert.deepEqual(await readAtlmSamples(c.db, "other-owner"), []);
    await assert.rejects(readAtlmSampleSource(c.db, "other-owner", PLAN, c.now()), e => e.code === "PLAN_NOT_FOUND");
  } finally { c.close(); }
});

test("A to B to A requirements are excluded; successful same-value writes remain eligible", async () => {
  const c = context();
  try {
    const p = await plannedAtlm(c);
    await ok(c, "StartPlan", { planId: PLAN }, 0);
    const beforeNoop = job(c).generation;
    await ok(c, "UpdateStep", { stepId: p.step.stepId, changes: { title: "Feature" }, reason: "Same title" }, 1);
    assert.equal(job(c).generation, beforeNoop);
    const claimed = await ok(c, "ClaimStepAttempt", { stepId: p.step.stepId, sessionId: crypto.randomUUID(), sourceId: "fixture" }, 2);
    const lease = { stepId: p.step.stepId, attemptId: claimed.attemptId, fence: claimed.fence };
    await ok(c, "StartStep", lease, 2); c.advance(2500); await result(c, lease, undefined, 3);
    await ok(c, "RecordCheck", check(lease.stepId)); await ok(c, "FinishPlan", { planId: PLAN }, 1);
    const firstGeneration = job(c).generation;
    await ok(c, "UpdatePlanMetadata", { planId: PLAN, description: "" }, 2);
    assert.equal(job(c).generation, firstGeneration);
    assert.equal((await readAtlmSampleSource(c.db, OWNER, PLAN, c.now())).eligibility, "ELIGIBLE");
    c.advance(1); await ok(c, "UpdatePlanMetadata", { planId: PLAN, description: "Changed temporarily" }, 3);
    await ok(c, "UpdatePlanMetadata", { planId: PLAN, description: "" }, 4);
    const source = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
    assert.ok(source.reasons.includes("SCOPE_CHANGED")); assert.equal(source.actualMs, 2500);
  } finally { c.close(); }
});

test("sample save refuses changed generation, stale fence and expired lease", async () => {
  const c = context();
  try {
    await completeAtlm(c, await plannedAtlm(c));
    const lease = await claimAtlmJob(c.db, OWNER, 'refresh:' + PLAN, c.now());
    const source = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
    assert.equal((await persistAtlmSample(c.db, OWNER, source, c.now(), { ...lease, fence: lease.fence - 1 })).inserted, false);
    c.advance(60001);
    assert.equal((await persistAtlmSample(c.db, OWNER, source, c.now(), lease)).inserted, false);
    const next = await claimAtlmJob(c.db, OWNER, 'refresh:' + PLAN, c.now()); assert.ok(next.fence > lease.fence);
    await ok(c, "DeletePlan", { planId: PLAN }, 2);
    assert.equal((await persistAtlmSample(c.db, OWNER, source, c.now(), next)).inserted, false);
  } finally { c.close(); }
});

test("used source invalidates active model atomically; deletion and restoration do not invent experience", async () => {
  const c = context();
  try {
    await completeAtlm(c, await plannedAtlm(c));
    const first = await save(c);
    c.db.sqlite.prepare("UPDATE estimation_jobs SET processed_generation=generation,status='IDLE',lease_until=NULL WHERE owner_id=?").run(OWNER);
    c.db.sqlite.prepare("INSERT INTO estimation_models(owner_id,model_id,model_version,status,artifact_json,manifest_json,dataset_digest,train_cutoff,sample_count,created_at) VALUES(?, 'model-a',1,'ACTIVE','{}',?,'digest',?,1,?)").run(OWNER, JSON.stringify([Number(first.sample.sampleId)]), c.now(), c.now());
    c.db.sqlite.prepare("UPDATE estimation_owner_state SET active_model_id='model-a' WHERE owner_id=?").run(OWNER);
    c.advance(1); await ok(c, "DeletePlan", { planId: PLAN }, 2);
    assert.equal(c.db.sqlite.prepare("SELECT status FROM estimation_models").get().status, "INVALIDATED");
    assert.equal(c.db.sqlite.prepare("SELECT forced_retrain FROM estimation_owner_state").get().forced_retrain, 1);
    const deleted = await save(c); assert.equal(deleted.sample.eligibility, "EXCLUDED");
    c.db.sqlite.prepare("UPDATE estimation_jobs SET processed_generation=generation,status='IDLE',lease_until=NULL WHERE owner_id=?").run(OWNER);
    c.advance(1); await ok(c, "RestorePlan", { planId: PLAN }, 3);
    const restored = await save(c); assert.equal(restored.sample.eligibility, "ELIGIBLE"); assert.equal(restored.sample.firstEligible, false);
    assert.equal(c.db.sqlite.prepare("SELECT new_sample_count FROM estimation_owner_state").get().new_sample_count, 1);
    assert.equal((await readAtlmSamples(c.db, OWNER)).length, 1);
    assert.equal((await readAtlmSamples(c.db, OWNER, { latestOnly: false })).length, 3);
  } finally { c.close(); }
});

test("source/outbox write failure rolls the first Start back with its frozen input", async () => {
  const c = context();
  try {
    await plannedAtlm(c);
    c.db.sqlite.exec("CREATE TRIGGER fail_atlm_enqueue BEFORE INSERT ON estimation_jobs BEGIN SELECT RAISE(ABORT,'test enqueue fault'); END;");
    const failed = await command(c, "StartPlan", { planId: PLAN }, 0);
    assert.equal(failed.status, 500);
    assert.equal(input(c), undefined);
    assert.equal(c.db.sqlite.prepare("SELECT first_started_at FROM plans WHERE plan_id=?").get(PLAN).first_started_at, null);
    c.db.sqlite.exec("DROP TRIGGER fail_atlm_enqueue");
    await ok(c, "StartPlan", { planId: PLAN }, 0);
    assert.equal(input(c).selection_status, "CAPTURED"); assert.ok(job(c));
  } finally { c.close(); }
});

test("step A to B to A scope change remains visible without changing the frozen revision", async () => {
  const c = context();
  try {
    const p = await plannedAtlm(c); await ok(c, "StartPlan", { planId: PLAN }, 0);
    const original = input(c).assessment_sequence;
    await ok(c, "UpdateStep", { stepId: p.step.stepId, changes: { expectedResult: "Different outcome" }, reason: "New requirement" }, 1);
    await ok(c, "UpdateStep", { stepId: p.step.stepId, changes: { expectedResult: "Checked change" }, reason: "Reverted requirement" }, 2);
    assert.ok((await readAtlmSampleSource(c.db, OWNER, PLAN, c.now())).reasons.includes("SCOPE_CHANGED"));
    assert.equal(input(c).assessment_sequence, original);
  } finally { c.close(); }
});

test("queue bookkeeping cannot move source availability; checkpoint yields do not spend retries", async () => {
  const c = context();
  try {
    await completeAtlm(c, await plannedAtlm(c));
    const first = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
    const claimed = await claimAtlmJob(c.db, OWNER, 'refresh:' + PLAN, c.now());
    c.advance(500);
    c.db.sqlite.prepare("UPDATE estimation_jobs SET status='QUEUED',checkpoint_json='{}',updated_at=? WHERE owner_id=?").run(c.now(), OWNER);
    const continued = await claimAtlmJob(c.db, OWNER, 'refresh:' + PLAN, c.now());
    assert.equal(continued.attempts, claimed.attempts);
    assert.equal((await readAtlmSampleSource(c.db, OWNER, PLAN, c.now())).sourceAvailableAt, first.sourceAvailableAt);
    for (let attempt = 2; attempt <= 4; attempt++) { c.advance(60001); assert.equal((await claimAtlmJob(c.db, OWNER, 'refresh:' + PLAN, c.now())).attempts, attempt); }
    c.advance(60001); assert.equal(await claimAtlmJob(c.db, OWNER, 'refresh:' + PLAN, c.now()), null);
  } finally { c.close(); }
});

test("full measurement supports finishing paused but rejects a missing server interval", async () => {
  const c = context();
  try {
    const p = await plannedAtlm(c); await ok(c, "StartPlan", { planId: PLAN }, 0);
    const claimed = await ok(c, "ClaimStepAttempt", { stepId: p.step.stepId, sessionId: crypto.randomUUID(), sourceId: "fixture" }, 1);
    const lease = { stepId: p.step.stepId, attemptId: claimed.attemptId, fence: claimed.fence };
    await ok(c, "StartStep", lease, 1); c.advance(200); await result(c, lease);
    await ok(c, "RecordCheck", check(lease.stepId)); await ok(c, "PausePlan", { planId: PLAN }, 1);
    c.advance(300); await ok(c, "ResumePlan", { planId: PLAN }, 2);
    c.advance(400); await ok(c, "PausePlan", { planId: PLAN }, 3);
    c.advance(500); await ok(c, "FinishPlan", { planId: PLAN }, 4);
    const complete = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
    assert.equal(complete.eligibility, "ELIGIBLE"); assert.equal(complete.actualMs, 600);
    c.db.sqlite.prepare("DELETE FROM work_intervals WHERE owner_id=? AND plan_id=? AND start_ms=(SELECT MAX(start_ms) FROM work_intervals WHERE owner_id=? AND plan_id=?)").run(OWNER, PLAN, OWNER, PLAN);
    const corrupt = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
    assert.ok(corrupt.reasons.includes("INCOMPLETE_MEASUREMENT")); assert.equal(corrupt.actualMs, null);
  } finally { c.close(); }
});

test("a late required check determines availability and yields just one new experience", async () => {
  const c = context();
  try {
    const p = await plannedAtlm(c); await ok(c, "StartPlan", { planId: PLAN }, 0);
    const claimed = await ok(c, "ClaimStepAttempt", { stepId: p.step.stepId, sessionId: crypto.randomUUID(), sourceId: "fixture" }, 1);
    const lease = { stepId: p.step.stepId, attemptId: claimed.attemptId, fence: claimed.fence };
    await ok(c, "StartStep", lease, 1); c.advance(1000); await result(c, lease);
    await ok(c, "FinishPlan", { planId: PLAN, allowIncomplete: true, reason: "Check runs after completion" }, 1);
    const excluded = await save(c); assert.ok(excluded.sample.reasons.includes("RESULT_NOT_VERIFIED"));
    c.db.sqlite.prepare("UPDATE estimation_jobs SET status='IDLE',processed_generation=generation,lease_until=NULL WHERE owner_id=?").run(OWNER);
    c.advance(2000); await ok(c, "RecordCheck", check(lease.stepId));
    const verified = await save(c);
    assert.equal(verified.sample.eligibility, "ELIGIBLE"); assert.equal(verified.sample.actualMs, 1000);
    assert.equal(verified.sample.sourceAvailableAt, c.now()); assert.equal(verified.sample.firstEligible, true);
    const page1 = await readAtlmSamples(c.db, OWNER, { latestOnly: false, limit: 1 });
    const page2 = await readAtlmSamples(c.db, OWNER, { latestOnly: false, limit: 1, afterSequence: Number(page1[0].sampleId) });
    assert.equal(page1[0].sampleId, excluded.sample.sampleId); assert.equal(page2[0].sampleId, verified.sample.sampleId);
    assert.deepEqual(await readAtlmSamples(c.db, "other-owner", { latestOnly: false, afterSequence: Number(page1[0].sampleId) }), []);
  } finally { c.close(); }
});

test("deleting an active plan closes its interval; restoration and resume preserve full measurement", async () => {
  const c = context();
  try {
    const p = await plannedAtlm(c); await ok(c, "StartPlan", { planId: PLAN }, 0);
    const claimed = await ok(c, "ClaimStepAttempt", { stepId: p.step.stepId, sessionId: crypto.randomUUID(), sourceId: "fixture" }, 1);
    const lease = { stepId: p.step.stepId, attemptId: claimed.attemptId, fence: claimed.fence };
    await ok(c, "StartStep", lease, 1); c.advance(1000); await result(c, lease);
    await ok(c, "RecordCheck", check(lease.stepId)); await ok(c, "DeletePlan", { planId: PLAN }, 1);
    c.advance(1000); await ok(c, "RestorePlan", { planId: PLAN }, 2); await ok(c, "ResumePlan", { planId: PLAN }, 3);
    c.advance(1000); await ok(c, "FinishPlan", { planId: PLAN }, 4);
    const measured = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
    assert.equal(measured.eligibility, "ELIGIBLE"); assert.equal(measured.actualMs, 2000);
    await ok(c, "DeletePlan", { planId: PLAN }, 5); await ok(c, "RestorePlan", { planId: PLAN }, 6);
    assert.equal((await readAtlmSampleSource(c.db, OWNER, PLAN, c.now())).actualMs, 2000);
  } finally { c.close(); }
});

test("a new source generation receives its own retry budget after an expired fourth attempt", async () => {
  const c = context();
  try {
    await completeAtlm(c, await plannedAtlm(c));
    let old;
    for (let i = 1; i <= 4; i++) { old = await claimAtlmJob(c.db, OWNER, 'refresh:' + PLAN, c.now()); assert.equal(old.attempts, i); c.advance(60001); }
    await ok(c, "DeletePlan", { planId: PLAN }, 2);
    assert.ok(job(c).generation > old.generation); assert.equal(job(c).attempts, 0);
    const next = await claimAtlmJob(c.db, OWNER, 'refresh:' + PLAN, c.now());
    assert.equal(next.attempts, 1); assert.ok(next.fence > old.fence);
    const refreshed = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
    assert.equal((await persistAtlmSample(c.db, OWNER, refreshed, c.now(), old)).inserted, false);
    assert.equal((await persistAtlmSample(c.db, OWNER, refreshed, c.now(), next)).inserted, true);
  } finally { c.close(); }
});
