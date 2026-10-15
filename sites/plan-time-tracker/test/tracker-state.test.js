import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker } from "../worker/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const migrationDirectory = resolve(root, "drizzle");
const schema = readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()
  .map((name) => readFileSync(resolve(migrationDirectory, name), "utf8")).join("\n");
const OWNER = "tracker-state-owner";
const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_A = "33333333-3333-4333-8333-333333333333";
const SESSION_B = "44444444-4444-4444-8444-444444444444";
const TRACKER_LEASE_MS = 10 * 60 * 1000;
let number = 0;
const commandId = () => {
  number += 1;
  return "d0000000-0000-4000-8000-" + String(number).padStart(12, "0");
};

class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  async run() { return { meta: { changes: Number(this.db.sqlite.prepare(this.sql).run(...this.args).changes) } }; }
  async first() { return this.db.sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: this.db.sqlite.prepare(this.sql).all(...this.args) }; }
}

class TestDatabase {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(schema);
  }
  prepare(sql) { return new Statement(this, sql); }
}

function createContext() {
  const db = new TestDatabase();
  let now = 1800000000000;
  const worker = createWorker(() => now);
  return { db, worker, now: () => now, setNow: (value) => { now = value; } };
}

async function request(context, commandType, payload, expectedVersion, channel = "ui") {
  const envelope = { schemaVersion: 1, commandId: commandId(), commandType, payload };
  if (expectedVersion !== undefined) envelope.expectedVersion = expectedVersion;
  const path = channel === "mcp" ? "/mcp" : "/api/commands";
  const body = channel === "mcp"
    ? { jsonrpc: "2.0", id: number, method: "tools/call", params: { name: commandType, arguments: envelope } }
    : envelope;
  const response = await context.worker.fetch(new Request("https://tracker.test" + path, {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-id": OWNER },
    body: JSON.stringify(body),
  }), { DB: context.db });
  const responseBody = await response.json();
  return channel === "mcp" && responseBody.result && responseBody.result.structuredContent
    ? { status: response.status, value: responseBody.result.structuredContent, raw: responseBody }
    : { status: response.status, value: responseBody, raw: responseBody };
}

async function setupRunningStep(context, requiredChecks = []) {
  const plan = await request(context, "CreatePlan", {
    planId: PLAN_ID, title: "Tracker transition plan",
    planCreatedAt: { precision: "dateOnly", on: "2026-10-01", timeZone: "UTC" },
  });
  assert.equal(plan.status, 200);
  const step = await request(context, "CreateStep", {
    planId: PLAN_ID, ordinal: 0, title: "Implement and verify",
    expectedResult: "A reviewable implementation with recorded evidence.", requiredChecks,
  });
  assert.equal(step.status, 200);
  assert.equal(step.value.result.status, "PENDING");
  const stepId = step.value.result.stepId;
  const started = await request(context, "StartPlan", { planId: PLAN_ID }, 0);
  assert.equal(started.status, 200);
  return stepId;
}

async function claim(context, stepId, expectedVersion, sessionId = SESSION_A, extra = {}, channel = "ui") {
  return request(context, "ClaimStepAttempt", {
    stepId: stepId, sessionId, sourceId: "codex-local", clientType: "LOCAL", ...extra,
  }, expectedVersion, channel);
}

test("checkpoint lifecycle preserves failed results, required-check gates and explicit finish exceptions", async () => {
  const c = createContext();
  const stepId = await setupRunningStep(c, ["unit"]);
  const initialIntervals = c.db.sqlite.prepare("SELECT interval_id,start_ms,end_ms FROM work_intervals WHERE owner_id=? AND plan_id=?").all(OWNER, PLAN_ID);
  assert.equal(initialIntervals.length, 1);
  assert.equal(initialIntervals[0].end_ms, null);

  const firstClaim = await claim(c, stepId, 1);
  assert.equal(firstClaim.status, 200);
  const firstAttempt = firstClaim.value.result.attemptId;
  const firstFence = firstClaim.value.result.fence;
  assert.equal(firstClaim.value.result.stepVersion, 1);
  const started = await request(c, "StartStep", { stepId: stepId, attemptId: firstAttempt, fence: firstFence }, 1);
  assert.equal(started.status, 200);
  assert.equal(started.value.result.status, "RUNNING");
  assert.equal(started.value.result.version, 2);

  const blocked = await request(c, "BlockStep", { stepId: stepId, attemptId: firstAttempt, fence: firstFence, reason: "Нужна недостающая спецификация." }, 2);
  assert.equal(blocked.status, 200);
  assert.equal(blocked.value.result.status, "BLOCKED");
  assert.equal(blocked.value.result.version, 3);
  assert.equal(c.db.sqlite.prepare("SELECT status FROM step_attempts WHERE owner_id=? AND attempt_id=?").get(OWNER, firstAttempt).status, "ABANDONED");

  const secondClaim = await claim(c, stepId, 3);
  const secondAttempt = secondClaim.value.result.attemptId;
  const secondFence = secondClaim.value.result.fence;
  const secondStart = await request(c, "StartStep", { stepId: stepId, attemptId: secondAttempt, fence: secondFence }, 3);
  assert.equal(secondStart.status, 200);
  const failed = await request(c, "RecordStepResult", {
    stepId: stepId, attemptId: secondAttempt, fence: secondFence, outcome: "FAILED", summary: "Проверка обнаружила дефект.",
  }, 4);
  assert.equal(failed.status, 200);
  assert.equal(failed.value.result.resultRevision, 1);
  assert.equal(failed.value.result.version, 5);
  assert.equal(c.db.sqlite.prepare("SELECT outcome FROM step_results WHERE owner_id=? AND step_id=? AND revision=1").get(OWNER, stepId).outcome, "FAILED");

  const thirdClaim = await claim(c, stepId, 5);
  const thirdAttempt = thirdClaim.value.result.attemptId;
  const thirdFence = thirdClaim.value.result.fence;
  assert.equal((await request(c, "StartStep", { stepId: stepId, attemptId: thirdAttempt, fence: thirdFence }, 5)).status, 200);
  const done = await request(c, "RecordStepResult", {
    stepId: stepId, attemptId: thirdAttempt, fence: thirdFence, outcome: "DONE", summary: "Изменение готово.",
  }, 6);
  assert.equal(done.status, 200);
  assert.equal(done.value.result.resultRevision, 2);
  assert.equal(done.value.result.version, 7);
  const currentStep = { ...c.db.sqlite.prepare("SELECT status,current_result_revision FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, stepId) };
  assert.deepEqual(currentStep, { status: "DONE", current_result_revision: 2 });

  c.setNow(c.now() + 1000);
  const incompleteFinish = await request(c, "FinishPlan", { planId: PLAN_ID }, 1);
  assert.equal(incompleteFinish.status, 409);
  assert.equal(incompleteFinish.value.error.code, "CHECKPOINTS_INCOMPLETE");
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM tracker_finish_exceptions WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID).count, 0);

  const explicitFinish = await request(c, "FinishPlan", { planId: PLAN_ID, allowIncomplete: true, reason: "Владелец завершил план с зафиксированным исключением." }, 1);
  assert.equal(explicitFinish.status, 200);
  assert.equal(explicitFinish.value.result.status, "COMPLETED");
  assert.equal(explicitFinish.value.result.incompleteCount, 1);
  assert.deepEqual(JSON.parse(c.db.sqlite.prepare("SELECT snapshot_json FROM tracker_finish_exceptions WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID).snapshot_json).map((item) => item.stepId), [stepId]);
  assert.equal(c.db.sqlite.prepare("SELECT status,finished_at FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID).status, "COMPLETED");
  const finalIntervals = c.db.sqlite.prepare("SELECT interval_id,start_ms,end_ms FROM work_intervals WHERE owner_id=? AND plan_id=?").all(OWNER, PLAN_ID);
  assert.equal(finalIntervals.length, 1);
  assert.ok(finalIntervals[0].end_ms > finalIntervals[0].start_ms);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM tracker_journal WHERE owner_id=? AND plan_id=? AND event_type='PLAN_FINISHED'").get(OWNER, PLAN_ID).count, 1);
});

test("bottleneck counters distinguish current blocks, block events, retry attempts, and failed results", async () => {
  const context = createContext();
  const stepId = await setupRunningStep(context);
  const firstClaim = await claim(context, stepId, 1, SESSION_A);
  const firstAttemptId = firstClaim.value.result.attemptId;
  const firstFence = firstClaim.value.result.fence;
  assert.equal((await request(context, "StartStep", { stepId, attemptId: firstAttemptId, fence: firstFence }, 1)).status, 200);
  assert.equal((await request(context, "BlockStep", {
    stepId, attemptId: firstAttemptId, fence: firstFence, reason: "Зависимость ещё не готова.",
  }, 2)).status, 200);

  const retry = await claim(context, stepId, 3, SESSION_B);
  const retryAttemptId = retry.value.result.attemptId;
  const retryFence = retry.value.result.fence;
  assert.equal((await request(context, "StartStep", { stepId, attemptId: retryAttemptId, fence: retryFence }, 3)).status, 200);
  assert.equal((await request(context, "RecordStepResult", {
    stepId, attemptId: retryAttemptId, fence: retryFence, outcome: "FAILED", summary: "Повторная попытка завершилась ошибкой.",
  }, 4)).status, 200);

  const response = await context.worker.fetch(new Request("https://tracker.test/api/tracker/plans/" + PLAN_ID + "/execution", {
    headers: { "oai-authenticated-user-id": OWNER },
  }), { DB: context.db });
  const snapshot = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(snapshot.bottlenecks, {
    blockedSteps: 0, blockedEvents: 1, retries: 1,
    retryMeasurement: "attempts with fence greater than 1; includes lease recovery and owner-assigned rework",
    failedResults: 1,
    checkDelay: {
      sampleCount: 0, medianMs: null, maxMs: null,
      measurement: "server time from result recording to first check recording; not test execution time",
    },
  });
});

test("expired lease recovery advances the fence and rejects stale executor commands", async () => {
  const c = createContext();
  const stepId = await setupRunningStep(c);
  const oldClaim = await claim(c, stepId, 1);
  const oldAttempt = oldClaim.value.result.attemptId;
  const oldFence = oldClaim.value.result.fence;
  assert.equal((await request(c, "StartStep", { stepId: stepId, attemptId: oldAttempt, fence: oldFence }, 1)).status, 200);
  const beforePlan = c.db.sqlite.prepare("SELECT version,status FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID);
  c.setNow(c.now() + TRACKER_LEASE_MS);

  const newClaim = await claim(c, stepId, 2, SESSION_B, { recoveryReason: "Продолжение после превышения lease." });
  assert.equal(newClaim.status, 200);
  const newAttempt = newClaim.value.result.attemptId;
  const newFence = newClaim.value.result.fence;
  assert.equal(newFence, oldFence + 1);
  assert.equal(newClaim.value.result.stepVersion, 2);
  assert.equal(c.db.sqlite.prepare("SELECT status FROM step_attempts WHERE owner_id=? AND attempt_id=?").get(OWNER, oldAttempt).status, "ABANDONED");
  assert.equal(c.db.sqlite.prepare("SELECT classification FROM tracker_journal WHERE owner_id=? AND attempt_id=? AND event_type='ATTEMPT_ABANDONED'").get(OWNER, oldAttempt).classification, "STALE_EXECUTOR");

  const staleRenewal = await request(c, "RenewStepLease", { stepId: stepId, attemptId: oldAttempt, fence: oldFence });
  assert.equal(staleRenewal.status, 409);
  assert.equal(staleRenewal.value.error.code, "ATTEMPT_CLOSED");
  assert.equal((await request(c, "StartStep", { stepId: stepId, attemptId: newAttempt, fence: newFence }, 2)).status, 200);
  c.setNow(c.now() + 1000);
  const renewed = await request(c, "RenewStepLease", { stepId: stepId, attemptId: newAttempt, fence: newFence });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.value.result.leaseUntil, c.now() + TRACKER_LEASE_MS);
  const afterPlan = c.db.sqlite.prepare("SELECT version,status FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID);
  assert.deepEqual(afterPlan, beforePlan);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM work_intervals WHERE owner_id=? AND plan_id=? AND end_ms IS NULL").get(OWNER, PLAN_ID).count, 1);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM tracker_journal WHERE owner_id=? AND plan_id=? AND event_type='LEASE_RENEWED'").get(OWNER, PLAN_ID).count, 1);
});

test("completed checkpoint rework requires a new owner-assigned claim and its matching reason", async () => {
  const c = createContext();
  const stepId = await setupRunningStep(c);
  const firstClaim = await claim(c, stepId, 1);
  const firstAttempt = firstClaim.value.result.attemptId;
  const firstFence = firstClaim.value.result.fence;
  assert.equal((await request(c, "StartStep", { stepId: stepId, attemptId: firstAttempt, fence: firstFence }, 1)).status, 200);
  assert.equal((await request(c, "RecordStepResult", {
    stepId: stepId, attemptId: firstAttempt, fence: firstFence, outcome: "DONE", summary: "Первый результат.",
  }, 2)).status, 200);

  const unassigned = await claim(c, stepId, 3);
  assert.equal(unassigned.status, 409);
  assert.equal(unassigned.value.error.code, "REWORK_REQUIRED");
  const attemptedAgentAssignment = await claim(c, stepId, 3, SESSION_B, { reworkReason: "Исправить отзыв владельца." }, "mcp");
  assert.equal(attemptedAgentAssignment.status, 200);
  assert.equal(attemptedAgentAssignment.value.code, "FORBIDDEN");

  const assignmentReason = "Владелец назначил доработку по результату ревью.";
  const reworkClaim = await claim(c, stepId, 3, SESSION_B, { reworkReason: assignmentReason });
  assert.equal(reworkClaim.status, 200);
  const reworkAttempt = reworkClaim.value.result.attemptId;
  assert.equal(c.db.sqlite.prepare("SELECT rework_reason FROM step_attempts WHERE owner_id=? AND attempt_id=?").get(OWNER, reworkAttempt).rework_reason, assignmentReason);
  const mismatchedStart = await request(c, "StartStep", { stepId: stepId, attemptId: reworkAttempt, fence: reworkClaim.value.result.fence, rework: true, reason: "Другая причина." }, 3);
  assert.equal(mismatchedStart.status, 409);
  assert.equal(mismatchedStart.value.error.code, "REWORK_REQUIRED");
  const authorizedStart = await request(c, "StartStep", { stepId: stepId, attemptId: reworkAttempt, fence: reworkClaim.value.result.fence, rework: true, reason: assignmentReason }, 3, "mcp");
  assert.equal(authorizedStart.status, 200);
  assert.equal(authorizedStart.value.result.version, 4);
  assert.equal(c.db.sqlite.prepare("SELECT outcome FROM step_results WHERE owner_id=? AND step_id=? AND revision=1").get(OWNER, stepId).outcome, "DONE");
});

test("explicit finish records and abandons a live unstarted attempt atomically", async () => {
  const c = createContext();
  const stepId = await setupRunningStep(c);
  const attempt = await claim(c, stepId, 1);
  const attemptId = attempt.value.result.attemptId;
  c.setNow(c.now() + 1000);
  const finish = await request(c, "FinishPlan", { planId: PLAN_ID, allowIncomplete: true, reason: "Владелец завершил план до начала шага." }, 1);
  assert.equal(finish.status, 200);
  assert.equal(c.db.sqlite.prepare("SELECT status FROM step_attempts WHERE owner_id=? AND attempt_id=?").get(OWNER, attemptId).status, "ABANDONED");
  const exception = c.db.sqlite.prepare("SELECT reason,snapshot_json FROM tracker_finish_exceptions WHERE owner_id=? AND command_id=?").get(OWNER, finish.value.commandId);
  assert.equal(exception.reason, "Владелец завершил план до начала шага.");
  assert.equal(JSON.parse(exception.snapshot_json)[0].stepId, stepId);
  assert.equal(c.db.sqlite.prepare("SELECT status,version FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, stepId).status, "PENDING");
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM work_intervals WHERE owner_id=? AND plan_id=? AND end_ms IS NULL").get(OWNER, PLAN_ID).count, 0);
});

test("an attempt may be closed before Start without changing checkpoint or plan lifecycle", async () => {
  const c = createContext();
  const stepId = await setupRunningStep(c);
  const attempt = await claim(c, stepId, 1);
  const attemptId = attempt.value.result.attemptId;
  const beforePlan = c.db.sqlite.prepare("SELECT status,version FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID);
  const closed = await request(c, "CloseStepAttempt", {
    stepId: stepId, attemptId: attemptId, fence: attempt.value.result.fence,
    disposition: "CLOSED", reason: "Работа передана другому исполнителю.",
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.value.result.status, "CLOSED");
  assert.equal(c.db.sqlite.prepare("SELECT status FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, stepId).status, "PENDING");
  assert.deepEqual(c.db.sqlite.prepare("SELECT status,version FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID), beforePlan);
  assert.equal(c.db.sqlite.prepare("SELECT event_type FROM tracker_journal WHERE owner_id=? AND attempt_id=? AND event_type='ATTEMPT_CLOSED'").get(OWNER, attemptId).event_type, "ATTEMPT_CLOSED");
});
