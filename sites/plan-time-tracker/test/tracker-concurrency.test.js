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
const OWNER = "tracker-concurrency-owner";
const OTHER_OWNER = "tracker-concurrency-other-owner";
const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_A = "33333333-3333-4333-8333-333333333333";
const SESSION_B = "44444444-4444-4444-8444-444444444444";
let number = 0;
const id = () => {
  number += 1;
  return "f0000000-0000-4000-8000-" + String(number).padStart(12, "0");
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

async function call(context, path, body, ownerId = OWNER) {
  const headers = new Headers({ "oai-authenticated-user-id": ownerId });
  const options = { headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    options.method = "POST";
    options.body = JSON.stringify(body);
  }
  const response = await context.worker.fetch(new Request("https://tracker.test" + path, options), { DB: context.db });
  return { status: response.status, value: await response.json() };
}

async function command(context, commandType, payload, expectedVersion, commandId = id()) {
  const envelope = { schemaVersion: 1, commandId, commandType, payload };
  if (expectedVersion !== undefined) envelope.expectedVersion = expectedVersion;
  return call(context, "/api/commands", envelope);
}

async function setupPlan(context) {
  assert.equal((await command(context, "CreatePlan", {
    planId: PLAN_ID, title: "Offline tracker plan",
    planCreatedAt: { precision: "dateOnly", on: "2026-10-01", timeZone: "UTC" },
  })).status, 200);
  const createdStep = await command(context, "CreateStep", {
    planId: PLAN_ID, ordinal: 0, title: "Record observations", expectedResult: "Bounded audit events are visible.",
    requiredChecks: [],
  });
  assert.equal(createdStep.status, 200);
  const stepId = createdStep.value.result.stepId;
  assert.equal((await command(context, "StartPlan", { planId: PLAN_ID }, 0)).status, 200);
  return stepId;
}

async function append(context, event, commandId = id(), ownerId = OWNER) {
  return call(context, "/api/commands", {
    schemaVersion: 1, commandId, commandType: "AppendObservation", payload: event,
  }, ownerId);
}

async function mcp(context, name, args, ownerId = OWNER) {
  const response = await context.worker.fetch(new Request("https://tracker.test/mcp", {
    method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-id": ownerId },
    body: JSON.stringify({ jsonrpc: "2.0", id: id(), method: "tools/call", params: { name, arguments: args } }),
  }), { DB: context.db });
  return { status: response.status, value: await response.json() };
}

function observation(context, sessionId, sourceSequence, eventType, data = {}, overrides = {}) {
  return {
    eventId: id(), planId: PLAN_ID, stepId: overrides.stepId, attemptId: overrides.attemptId,
    sourceId: "codex-local", sessionId, sourceSequence, occurredAt: overrides.occurredAt ?? context.now(),
    eventType, data, correctionOfEventId: overrides.correctionOfEventId,
  };
}

test("simultaneous claims produce one active fenced attempt", async () => {
  const context = createContext();
  const stepId = await setupPlan(context);
  const claims = await Promise.all([
    command(context, "ClaimStepAttempt", {
      stepId, sessionId: SESSION_A, sourceId: "codex-local", clientType: "LOCAL",
    }, 1),
    command(context, "ClaimStepAttempt", {
      stepId, sessionId: SESSION_B, sourceId: "codex-local", clientType: "LOCAL",
    }, 1),
  ]);

  assert.equal(claims.filter((result) => result.status === 200).length, 1);
  assert.equal(claims.filter((result) => result.status === 409).length, 1);
  assert.equal(context.db.sqlite.prepare("SELECT COUNT(*) AS count FROM step_attempts WHERE owner_id=? AND step_id=? AND status='OPEN'").get(OWNER, stepId).count, 1);
  assert.equal(context.db.sqlite.prepare("SELECT status,version FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID).status, "RUNNING");
  assert.equal(context.db.sqlite.prepare("SELECT COUNT(*) AS count FROM work_intervals WHERE owner_id=? AND plan_id=? AND end_ms IS NULL").get(OWNER, PLAN_ID).count, 1);
});

test("parallel checkpoint attempts do not double-count the plan timer across pause and resume", async () => {
  const context = createContext();
  const firstStepId = await setupPlan(context);
  const secondStep = await command(context, "CreateStep", {
    planId: PLAN_ID, ordinal: 1, title: "Verify timer accounting", expectedResult: "One plan interval remains authoritative.",
    requiredChecks: [],
  });
  assert.equal(secondStep.status, 200);
  const secondStepId = secondStep.value.result.stepId;

  const claims = await Promise.all([firstStepId, secondStepId].map((stepId, index) => command(context, "ClaimStepAttempt", {
    stepId, sessionId: index === 0 ? SESSION_A : SESSION_B, sourceId: "codex-local", clientType: "LOCAL",
  }, 1)));
  assert.ok(claims.every((result) => result.status === 200));
  const starts = await Promise.all(claims.map((claim, index) => command(context, "StartStep", {
    stepId: index === 0 ? firstStepId : secondStepId,
    attemptId: claim.value.result.attemptId,
    fence: claim.value.result.fence,
  }, 1)));
  assert.ok(starts.every((result) => result.status === 200));
  assert.equal(context.db.sqlite.prepare("SELECT COUNT(*) AS count FROM work_intervals WHERE owner_id=? AND plan_id=? AND end_ms IS NULL")
    .get(OWNER, PLAN_ID).count, 1);

  const startAt = context.now();
  context.setNow(startAt + 10 * 60 * 1000);
  assert.equal((await command(context, "PausePlan", { planId: PLAN_ID }, 1)).status, 200);
  context.setNow(startAt + 70 * 60 * 1000);
  assert.equal((await command(context, "ResumePlan", { planId: PLAN_ID }, 2)).status, 200);
  context.setNow(startAt + 75 * 60 * 1000);
  assert.equal((await command(context, "FinishPlan", {
    planId: PLAN_ID, allowIncomplete: true, reason: "Тест сохранения одного таймера для параллельных checkpoint.",
  }, 3)).status, 200);

  const plan = await call(context, "/api/plans/" + PLAN_ID);
  assert.equal(plan.status, 200);
  assert.equal(plan.value.plan.activeMs, 15 * 60 * 1000);
  assert.equal(plan.value.plan.calendarMs, 75 * 60 * 1000);
  assert.equal(plan.value.plan.pausedMs, 60 * 60 * 1000);
  assert.deepEqual(plan.value.plan.intervals.map((interval) => [interval.start_ms, interval.end_ms]), [
    [startAt, startAt + 10 * 60 * 1000],
    [startAt + 70 * 60 * 1000, startAt + 75 * 60 * 1000],
  ]);
  assert.equal(context.db.sqlite.prepare("SELECT COUNT(*) AS count FROM step_attempts WHERE owner_id=? AND status='OPEN'")
    .get(OWNER).count, 0);
});

test("simultaneous StartStep commands on one attempt have a single winner", async () => {
  const context = createContext();
  const stepId = await setupPlan(context);
  const claimed = await command(context, "ClaimStepAttempt", {
    stepId, sessionId: SESSION_A, sourceId: "codex-local", clientType: "LOCAL",
  }, 1);
  assert.equal(claimed.status, 200);
  const payload = {
    stepId,
    attemptId: claimed.value.result.attemptId,
    fence: claimed.value.result.fence,
  };

  const starts = await Promise.all([
    command(context, "StartStep", payload, 1),
    command(context, "StartStep", payload, 1),
  ]);
  assert.equal(starts.filter((result) => result.status === 200).length, 1);
  assert.equal(starts.filter((result) => result.status === 409).length, 1);
  assert.deepEqual({ ...context.db.sqlite.prepare("SELECT status,version,current_fence FROM plan_steps WHERE owner_id=? AND step_id=?")
    .get(OWNER, stepId) }, { status: "RUNNING", version: 2, current_fence: 1 });
  assert.equal(context.db.sqlite.prepare("SELECT COUNT(*) AS count FROM tracker_journal WHERE owner_id=? AND step_id=? AND event_type='STEP_STARTED'")
    .get(OWNER, stepId).count, 1);
});

test("simultaneous FinishPlan commands record one finish and one interval close", async () => {
  const context = createContext();
  await setupPlan(context);
  const payload = {
    planId: PLAN_ID, allowIncomplete: true, reason: "Тест единственного победителя FinishPlan.",
  };

  const finishes = await Promise.all([
    command(context, "FinishPlan", payload, 1),
    command(context, "FinishPlan", payload, 1),
  ]);
  assert.equal(finishes.filter((result) => result.status === 200).length, 1);
  assert.equal(finishes.filter((result) => result.status === 409).length, 1);
  assert.equal(context.db.sqlite.prepare("SELECT status,version FROM plans WHERE owner_id=? AND plan_id=?")
    .get(OWNER, PLAN_ID).status, "COMPLETED");
  assert.equal(context.db.sqlite.prepare("SELECT COUNT(*) AS count FROM tracker_journal WHERE owner_id=? AND plan_id=? AND event_type='PLAN_FINISHED'")
    .get(OWNER, PLAN_ID).count, 1);
  assert.equal(context.db.sqlite.prepare("SELECT COUNT(*) AS count FROM tracker_finish_exceptions WHERE owner_id=? AND plan_id=?")
    .get(OWNER, PLAN_ID).count, 1);
  assert.equal(context.db.sqlite.prepare("SELECT COUNT(*) AS count FROM work_intervals WHERE owner_id=? AND plan_id=? AND end_ms IS NULL")
    .get(OWNER, PLAN_ID).count, 0);
});

test("late observations from an expired fenced executor are marked stale without changing progress", async () => {
  const context = createContext();
  const stepId = await setupPlan(context);
  const firstClaim = await command(context, "ClaimStepAttempt", {
    stepId, sessionId: SESSION_A, sourceId: "codex-local", clientType: "LOCAL",
  }, 1);
  const firstAttemptId = firstClaim.value.result.attemptId;
  const firstFence = firstClaim.value.result.fence;
  assert.equal((await command(context, "StartStep", { stepId, attemptId: firstAttemptId, fence: firstFence }, 1)).status, 200);
  const beforeTime = context.now();
  context.setNow(beforeTime + 600000);
  const recovered = await command(context, "ClaimStepAttempt", {
    stepId, sessionId: SESSION_B, sourceId: "codex-local", clientType: "LOCAL", recoveryReason: "Lease истёк во время отключения клиента.",
  }, 2);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.value.result.fence, firstFence + 1);
  const beforeObservation = { ...context.db.sqlite.prepare("SELECT status,version,current_fence FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, stepId) };
  const staleEvent = observation(context, SESSION_A, 1, "turn_finished", { turnId: id(), status: "OK" }, {
    stepId, attemptId: firstAttemptId, occurredAt: context.now() + 24 * 60 * 60 * 1000,
  });
  const appended = await append(context, staleEvent);
  assert.equal(appended.status, 200);
  assert.equal(appended.value.result.classification, "STALE_EXECUTOR");
  assert.deepEqual({ ...context.db.sqlite.prepare("SELECT status,version,current_fence FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, stepId) }, beforeObservation);
  assert.equal(context.db.sqlite.prepare("SELECT status FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID).status, "RUNNING");
  assert.equal(context.db.sqlite.prepare("SELECT COUNT(*) AS count FROM work_intervals WHERE owner_id=? AND plan_id=? AND end_ms IS NULL").get(OWNER, PLAN_ID).count, 1);
});

test("offline observations preserve server order, classify gaps and corrections, replay exactly, and never drive lifecycle", async () => {
  const context = createContext();
  const stepId = await setupPlan(context);
  const claimed = await command(context, "ClaimStepAttempt", {
    stepId, sessionId: SESSION_A, sourceId: "codex-local", clientType: "LOCAL",
  }, 1);
  assert.equal(claimed.status, 200);
  const attemptId = claimed.value.result.attemptId;
  const beforePlan = context.db.sqlite.prepare("SELECT status,version,first_started_at FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID);
  const beforeStep = context.db.sqlite.prepare("SELECT status,version,current_fence FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, stepId);
  const beforeInterval = context.db.sqlite.prepare("SELECT interval_id,start_ms,end_ms FROM work_intervals WHERE owner_id=? AND plan_id=?").all(OWNER, PLAN_ID);
  const snapshot = await call(context, "/api/tracker/plans/" + PLAN_ID + "/execution");
  const baseline = snapshot.value.timelineCursor;
  const oldTime = context.now() - 24 * 60 * 60 * 1000;
  const futureTime = context.now() + 24 * 60 * 60 * 1000;

  const first = observation(context, SESSION_A, 1, "turn_started", { turnId: id() }, { stepId, attemptId, occurredAt: futureTime });
  const firstCommandId = id();
  const firstResult = await append(context, first, firstCommandId);
  assert.equal(firstResult.status, 200);
  assert.equal(firstResult.value.result.classification, "NORMAL");
  const gap = observation(context, SESSION_A, 3, "heartbeat", {}, { stepId, attemptId, occurredAt: oldTime });
  const gapResult = await append(context, gap);
  assert.equal(gapResult.status, 200);
  assert.equal(gapResult.value.result.classification, "GAP");
  const late = observation(context, SESSION_A, 2, "heartbeat", {}, { stepId, attemptId });
  const lateResult = await append(context, late);
  assert.equal(lateResult.status, 200);
  assert.equal(lateResult.value.result.classification, "LATE");

  const eventReplay = await append(context, first);
  assert.equal(eventReplay.status, 200);
  assert.equal(eventReplay.value.replayed, true);
  assert.equal(eventReplay.value.applied, false);
  assert.equal(eventReplay.value.result.replayed, true);
  const commandReplay = await append(context, first, firstCommandId);
  assert.equal(commandReplay.status, 200);
  assert.equal(commandReplay.value.replayed, true);
  assert.deepEqual(commandReplay.value.result, firstResult.value.result);
  const changedEvent = { ...first, data: { turnId: id() } };
  const eventConflict = await append(context, changedEvent);
  assert.equal(eventConflict.status, 409);
  assert.equal(eventConflict.value.error.code, "OBSERVATION_CONFLICT");
  const sequenceConflict = await append(context, observation(context, SESSION_A, 3, "heartbeat"));
  assert.equal(sequenceConflict.status, 409);
  assert.equal(sequenceConflict.value.error.code, "OBSERVATION_CONFLICT");

  const correction = observation(context, SESSION_A, 4, "correction", { reason: "Уточнено по журналу клиента." }, {
    stepId, attemptId, correctionOfEventId: gap.eventId,
  });
  const correctionResult = await append(context, correction);
  assert.equal(correctionResult.status, 200);
  assert.equal(correctionResult.value.result.classification, "CORRECTION");
  assert.equal(correctionResult.value.result.replayed, false);

  const pageOne = await call(context, "/api/tracker/plans/" + PLAN_ID + "/timeline?afterSequence=" + baseline + "&limit=2");
  assert.equal(pageOne.status, 200);
  assert.equal(pageOne.value.events.length, 2);
  assert.equal(pageOne.value.hasMore, true);
  const pageTwo = await call(context, "/api/tracker/plans/" + PLAN_ID + "/timeline?afterSequence=" + pageOne.value.nextCursor + "&limit=2");
  assert.equal(pageTwo.status, 200);
  assert.equal(pageTwo.value.hasMore, false);
  assert.deepEqual([...pageOne.value.events, ...pageTwo.value.events].map((event) => event.classification), ["NORMAL", "GAP", "LATE", "CORRECTION"]);
  assert.ok([...pageOne.value.events, ...pageTwo.value.events].every((event, index, events) => index === 0 || event.serverSequence > events[index - 1].serverSequence));

  assert.equal((await call(context, "/api/tracker/plans/" + PLAN_ID + "/execution", undefined, OTHER_OWNER)).status, 404);
  assert.deepEqual(context.db.sqlite.prepare("SELECT status,version,first_started_at FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID), beforePlan);
  assert.deepEqual(context.db.sqlite.prepare("SELECT status,version,current_fence FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, stepId), beforeStep);
  assert.deepEqual(context.db.sqlite.prepare("SELECT interval_id,start_ms,end_ms FROM work_intervals WHERE owner_id=? AND plan_id=?").all(OWNER, PLAN_ID), beforeInterval);
});

test("timeline page bounds, receipt lookup, and owner scoping are enforced", async () => {
  const context = createContext();
  await setupPlan(context);
  const invalidLimit = await call(context, "/api/tracker/plans/" + PLAN_ID + "/timeline?limit=101");
  assert.equal(invalidLimit.status, 400);
  assert.equal(invalidLimit.value.error.code, "VALIDATION_ERROR");
  const missingPlan = await call(context, "/api/tracker/plans/" + PLAN_ID + "/timeline", undefined, OTHER_OWNER);
  assert.equal(missingPlan.status, 404);
  assert.equal(missingPlan.value.error.code, "PLAN_NOT_FOUND");
  const hiddenReceipt = await call(context, "/api/tracker/commands/" + id(), undefined, OTHER_OWNER);
  assert.deepEqual(hiddenReceipt.value, { status: "NOT_FOUND", commandId: hiddenReceipt.value.commandId });
  assert.equal((await call(context, "/api/tracker/capabilities")).status, 200);
});

test("owner-authenticated MCP exposes the tracker read contract and owner-scoped receipts", async () => {
  const context = createContext();
  const stepId = await setupPlan(context);
  const listed = await context.worker.fetch(new Request("https://tracker.test/mcp", {
    method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-id": OWNER },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }), { DB: context.db });
  const tools = (await listed.json()).result.tools;
  for (const name of ["GetTrackerCapabilities", "GetPlanExecutionSnapshot", "GetTimeline", "GetCommandReceipt"]) {
    assert.ok(tools.some((tool) => tool.name === name), name);
  }
  assert.equal(JSON.stringify(tools.filter((tool) => tool.name.startsWith("GetTracker") || tool.name.startsWith("GetPlanExecution") || tool.name === "GetTimeline" || tool.name === "GetCommandReceipt")).includes("ownerId"), false);

  const capabilities = await mcp(context, "GetTrackerCapabilities", {});
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.value.result.structuredContent.available, true);
  const queue = capabilities.value.result.structuredContent.localObservationQueue;
  assert.match(queue.ownerScope, /^[a-f0-9]{64}$/);
  assert.equal(queue.maxEvents, 1000);
  assert.equal(queue.maxBytes, 5 * 1024 * 1024);
  assert.equal(queue.retentionMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(queue.maxSendAttempts, 5);
  assert.equal(queue.backoffCapMs, 30000);
  assert.notEqual(queue.ownerScope, OWNER);
  const otherCapabilities = await mcp(context, "GetTrackerCapabilities", {}, OTHER_OWNER);
  assert.notEqual(otherCapabilities.value.result.structuredContent.localObservationQueue.ownerScope, queue.ownerScope);
  const snapshot = await mcp(context, "GetPlanExecutionSnapshot", { planId: PLAN_ID });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.value.result.structuredContent.steps[0].step_id, stepId);
  const timeline = await mcp(context, "GetTimeline", { planId: PLAN_ID, afterSequence: 0, limit: 10 });
  assert.equal(timeline.status, 200);
  assert.ok(timeline.value.result.structuredContent.events.some((event) => event.eventType === "STEP_CREATED"));
  const createReceipt = context.db.sqlite.prepare("SELECT command_id FROM command_receipts WHERE owner_id=? AND command_type='CreatePlan'").get(OWNER).command_id;
  const receipt = await mcp(context, "GetCommandReceipt", { commandId: createReceipt });
  assert.equal(receipt.value.result.structuredContent.status, "FINAL");
  const hiddenReceipt = await mcp(context, "GetCommandReceipt", { commandId: createReceipt }, OTHER_OWNER);
  assert.deepEqual(hiddenReceipt.value.result.structuredContent, { status: "NOT_FOUND", commandId: createReceipt });
});
