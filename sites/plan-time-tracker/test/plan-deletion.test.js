import test from "node:test";
import assert from "node:assert/strict";
import { context, call, command, ok, running, result, mcp, rows, migrations, migration, PLAN, OWNER } from "./fixtures/tracker-db.mjs";
const B = "22222222-2222-4222-8222-222222222222";
const create = (c, planId = PLAN, owner) => command(c, "CreatePlan", { planId, title: "Удаление", planCreatedAt: { precision: "dateOnly", on: "2026-10-01", timeZone: "UTC" } }, undefined, undefined, owner);
const plan = async (c, id = PLAN) => (await call(c, "/api/plans/" + id)).value.plan;

test("soft deletion hides a plan, preserves history and restores it without starting a timer", async () => {
  const c = context();
  try {
    await create(c);await ok(c, "StartPlan", { planId: PLAN }, 0);c.advance(60000);
    const deleted = await ok(c, "DeletePlan", { planId: PLAN }, 1);
    assert.equal(deleted.deletedAt, c.now());assert.equal(deleted.status, "PAUSED");
    assert.equal((await call(c, "/api/plans")).value.plans.length, 0);
    const trash = (await call(c, "/api/plans?deleted=true")).value;
    assert.equal(trash.plans[0].planId, PLAN);
    const before = await plan(c);c.advance(60000);
    assert.equal((await plan(c)).activeMs, 60000);assert.equal((await plan(c)).calendarMs, before.calendarMs);
    const restored = await ok(c, "RestorePlan", { planId: PLAN }, 2);
    assert.equal(restored.deletedAt, null);assert.equal(restored.status, "PAUSED");
    assert.equal((await plan(c)).intervals.length, 1);assert.equal((await plan(c)).intervals[0].end_ms, deleted.deletedAt);
    assert.equal((await call(c, "/api/plans?deleted=true")).value.plans.length, 0);
    assert.equal((await call(c, "/api/plans")).value.plans.length, 1);
    await ok(c, "ResumePlan", { planId: PLAN }, 3);
    assert.equal((await plan(c)).intervals.length, 2);
  } finally { c.close(); }
});

test("deletion closes attempts and fences late executors without touching another running plan", async () => {
  const c = context();
  try {
    const lease = await running(c);await create(c, B);await ok(c, "StartPlan", { planId: B }, 0);
    const beforeB = await plan(c, B);c.advance(1000);
    await ok(c, "DeletePlan", { planId: PLAN }, 1);
    const attempt = c.db.sqlite.prepare("SELECT * FROM step_attempts WHERE attempt_id=?").get(lease.attemptId);
    assert.equal(attempt.status, "ABANDONED");assert.equal(attempt.closed_at, c.now());
    const late = await command(c, "RenewStepLease", lease);
    assert.equal(late.status, 409);assert.equal(late.value.error.code, "PLAN_DELETED");
    const snapshot = (await call(c, "/api/tracker/plans/" + PLAN + "/execution")).value;
    assert.equal(snapshot.steps[0].status, "BLOCKED");assert.equal(snapshot.steps[0].execution.canClaim, false);
    assert.equal(snapshot.plan.completion.readyToFinish, false);
    const afterB = await plan(c, B);assert.equal(afterB.status, "RUNNING");assert.deepEqual(afterB.intervals, beforeB.intervals);
    await ok(c, "RestorePlan", { planId: PLAN }, 2);await ok(c, "ResumePlan", { planId: PLAN }, 3);
    assert.equal((await command(c, "StartStep", lease, 2)).status, 409);
    assert.equal(c.db.sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { c.close(); }
});

test("delete/restore preserve lifecycle and completed evidence for every plan status", async () => {
  for (const status of ["PLANNED", "RUNNING", "PAUSED", "COMPLETED"]) {
    const c = context();
    try {
      if (status === "PLANNED") await create(c);
      else {
        await create(c);await ok(c, "StartPlan", { planId: PLAN }, 0);c.advance(1000);
        if (status === "PAUSED") await ok(c, "PausePlan", { planId: PLAN }, 1);
        if (status === "COMPLETED") await ok(c, "FinishPlan", { planId: PLAN }, 1);
      }
      const before = await plan(c);
      const deleted = await ok(c, "DeletePlan", { planId: PLAN, reason: "Тест" }, before.version);
      c.advance(5000);
      const restored = await ok(c, "RestorePlan", { planId: PLAN }, deleted.version);
      assert.equal(restored.status, status === "RUNNING" ? "PAUSED" : status);
      const after = await plan(c);
      assert.equal(after.activeMs, before.activeMs);assert.equal(after.firstStartedAt, before.firstStartedAt);
      assert.equal(after.finishedAt, before.finishedAt);assert.equal(after.version, before.version + 2);
      assert(after.intervals.every(i => i.end_ms != null));
    } finally { c.close(); }
  }
});

test("MCP exposes versioned delete/restore and deleted-only pagination with strict validation", async () => {
  const c = context();
  try {
    await create(c);await create(c, B);
    const discovery = (await call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).value.result.tools;
    for (const name of ["DeletePlan", "RestorePlan"]) {
      const schema = discovery.find(tool => tool.name === name).inputSchema;
      assert(schema.required.includes("expectedVersion"));assert.equal(schema.properties.payload.additionalProperties, false);
      assert.deepEqual(Object.keys(schema.properties.payload.properties), ["planId", "reason"]);
    }
    const capabilities = (await mcp(c, "GetTrackerCapabilities")).value.result.structuredContent;
    assert.equal(capabilities.version, "3.1.0");assert.equal(capabilities.planDeletion.restoreStartsTimer, false);
    assert.equal(capabilities.planList.deletedDefault, false);
    const id = crypto.randomUUID();
    const args = { schemaVersion: 1, commandId: id, expectedVersion: 0, payload: { planId: PLAN } };
    assert.equal((await mcp(c, "DeletePlan", args)).value.result.structuredContent.result.status, "PLANNED");
    await ok(c, "DeletePlan", { planId: B }, 0);
    let cursor, ids = [];
    do {
      const page = (await mcp(c, "ListPlans", { deleted: true, statuses: ["PLANNED"], limit: 1, ...(cursor ? { cursor } : {}) })).value.result.structuredContent;
      ids.push(...page.plans.map(p => p.planId));cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(ids.sort(), [PLAN, B].sort());
    assert.deepEqual((await mcp(c, "ListPlans")).value.result.structuredContent.plans, []);
    for (const payload of [{ planId: PLAN, purge: true }, { planId: PLAN, ownerId: "other-owner" }, { planId: PLAN, reason: 1 }, { planId: PLAN, reason: "x".repeat(1001) }]) {
      const result = await mcp(c, "RestorePlan", { ...args, commandId: crypto.randomUUID(), expectedVersion: 1, payload });
      assert.equal(result.value.result.structuredContent.code, "VALIDATION_ERROR");
    }
    assert.equal((await mcp(c, "ListPlans", { deleted: "true" })).value.result.structuredContent.code, "VALIDATION_ERROR");
    for (const flag of ["yes", "1", ""]) assert.equal((await call(c, "/api/plans?deleted=" + flag)).status, 400);
    const restored = await mcp(c, "RestorePlan", { ...args, commandId: crypto.randomUUID(), expectedVersion: 1 });
    assert.equal(restored.value.result.structuredContent.result.deletedAt, null);
    assert.equal((await call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize" })).value.result.serverInfo.version, "3.1.0");
  } finally { c.close(); }
});

test("deletion and restoration are idempotent, retain rejected receipts and never reapply old lifecycle commands", async () => {
  const c = context();
  try {
    await create(c);
    const startId = crypto.randomUUID(), deleteId = crypto.randomUUID(), restoreId = crypto.randomUUID();
    await command(c, "StartPlan", { planId: PLAN }, 0, startId);
    const concurrent = await Promise.all([command(c, "DeletePlan", { planId: PLAN }, 1, deleteId), command(c, "DeletePlan", { planId: PLAN }, 1, deleteId)]);
    assert(concurrent.every(r => r.status === 200));assert.equal(concurrent.filter(r => r.value.applied).length, 1);
    const snapshot = await plan(c);
    assert.equal((await command(c, "DeletePlan", { planId: PLAN, reason: "Другой запрос" }, 1, deleteId)).value.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal((await command(c, "DeletePlan", { planId: PLAN }, 2)).value.error.code, "PLAN_DELETED");
    assert.equal((await command(c, "StartPlan", { planId: PLAN }, 0, startId)).value.replayed, true);
    assert.deepEqual(await plan(c), snapshot);
    const rejectedId = crypto.randomUUID();
    assert.equal((await command(c, "ResumePlan", { planId: PLAN }, 2, rejectedId)).value.error.code, "PLAN_DELETED");
    assert.equal((await call(c, "/api/tracker/commands/" + rejectedId)).value.status, "FINAL");
    const first = await command(c, "RestorePlan", { planId: PLAN }, 2, restoreId);
    const replay = await command(c, "RestorePlan", { planId: PLAN }, 2, restoreId);
    assert.equal(replay.value.replayed, true);assert.deepEqual(first.value.result, replay.value.result);
    assert.equal((await command(c, "RestorePlan", { planId: PLAN }, 3)).value.error.code, "PLAN_NOT_DELETED");
    assert.equal((await command(c, "ResumePlan", { planId: PLAN }, 2, rejectedId)).value.error.code, "PLAN_DELETED");
    assert.equal((await plan(c)).status, "PAUSED");
    assert.equal((await command(c, "DeletePlan", { planId: PLAN }, 1, deleteId)).value.replayed, true);
    assert.equal((await plan(c)).deletedAt, null);
    assert.equal((await plan(c)).events.filter(e => e.event_type === "DELETED").length, 1);
  } finally { c.close(); }
});

test("owner isolation covers delete, restore, trash, direct reads and step mutations", async () => {
  const c = context();
  try {
    await create(c);await create(c, B, "other-owner");
    assert.equal((await command(c, "DeletePlan", { planId: B }, 0)).status, 404);
    await command(c, "DeletePlan", { planId: B }, 0, undefined, "other-owner");
    assert.equal((await command(c, "RestorePlan", { planId: B }, 1)).status, 404);
    assert.equal((await call(c, "/api/plans/" + B)).status, 404);
    assert.deepEqual((await call(c, "/api/plans?deleted=true")).value.plans, []);
    assert.equal((await call(c, "/api/plans?deleted=true", undefined, "other-owner")).value.plans[0].planId, B);
    const lease = await running(c, [], "33333333-3333-4333-8333-333333333333");
    const cross = await command(c, "RenewStepLease", lease, undefined, undefined, "other-owner");
    assert.equal(cross.status, 404);
    assert.equal((await call(c, "/api/plans?deleted=true", undefined, null)).status, 401);
  } finally { c.close(); }
});

test("deleted plans reject every mutation atomically while preserving their evidence and audit history", async () => {
  const c = context();
  try {
    const lease = await running(c);
    await ok(c, "DeletePlan", { planId: PLAN }, 1);
    const before = rows(c), current = (await call(c, "/api/tracker/plans/" + PLAN + "/execution")).value.steps[0];
    const mutations = [
      ["StartPlan", { planId: PLAN }, 2], ["ResumePlan", { planId: PLAN }, 2], ["PausePlan", { planId: PLAN }, 2],
      ["FinishPlan", { planId: PLAN }, 2], ["UpdatePlanMetadata", { planId: PLAN, title: "Нельзя" }, 2],
      ["CreateStep", { planId: PLAN, ordinal: 1, title: "Нельзя", expectedResult: "Нельзя", requiredChecks: [] }],
      ["UpdateStep", { stepId: lease.stepId, changes: { title: "Нельзя" }, reason: "Тест" }, current.version],
      ["ClaimStepAttempt", { stepId: lease.stepId, sessionId: crypto.randomUUID(), sourceId: "fixture" }, current.version],
      ["StartStep", lease, current.version], ["RenewStepLease", lease],
      ["CloseStepAttempt", { ...lease, disposition: "CLOSED", reason: "Тест" }],
      ["BlockStep", { ...lease, reason: "Тест" }, current.version],
      ["RecordStepResult", { ...lease, outcome: "DONE", summary: "Нельзя" }, current.version],
      ["RecordCheck", { stepId: lease.stepId, resultRevision: 1, checkKey: "unit", status: "NOT_RUN", testedSnapshotDigest: "sha256:" + "a".repeat(64) }],
      ["AppendObservation", { eventId: crypto.randomUUID(), planId: PLAN, sourceId: "fixture", sessionId: crypto.randomUUID(), sourceSequence: 1, occurredAt: c.now(), eventType: "heartbeat", data: {} }],
    ];
    for (const [type, payload, version] of mutations) {
      const response = await command(c, type, payload, version);
      assert.equal(response.status, 409, type + JSON.stringify(response.value));
      assert.equal(response.value.error.code, "PLAN_DELETED", type);
    }
    const after = rows(c);
    for (const name of Object.keys(before).filter(name => name !== "command_receipts")) assert.deepEqual(after[name], before[name], name);
    assert.equal(after.command_receipts.length, before.command_receipts.length + mutations.length);
    assert.equal(c.db.sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { c.close(); }
});

test("deleting a plan excludes its intervals, sections and completion metrics from analytics and export retains it", async () => {
  const c = context();
  try {
    const lease = await running(c, []);await result(c, lease);c.advance(60000);await ok(c, "FinishPlan", { planId: PLAN }, 1);
    const date = new Date(c.now()).toISOString().slice(0, 10), query = "?from=" + date + "&to=" + date + "&timeZone=UTC";
    const before = (await call(c, "/api/analytics" + query)).value;
    assert.equal(before.completedPlans, 1);assert.equal(before.totalActiveMs, 60000);
    await ok(c, "DeletePlan", { planId: PLAN }, 2);
    const after = (await call(c, "/api/analytics" + query)).value;
    assert.equal(after.completedPlans, 0);assert.equal(after.totalActiveMs, 0);assert.equal(after.sumPlanActiveMs, 0);
    assert.deepEqual(after.plans, []);assert.deepEqual(after.inactivePlans, []);assert.equal(after.completedMedianActiveMs, null);
    assert.equal((await call(c, "/api/analytics/plans/" + PLAN + "/steps" + query)).status, 404);
    assert.equal((await call(c, "/api/export")).value.plans[0].deletedAt, c.now());
    await ok(c, "RestorePlan", { planId: PLAN }, 3);
    assert.deepEqual((await call(c, "/api/analytics" + query)).value, before);
    const restored = (await call(c, "/api/tracker/plans/" + PLAN + "/execution")).value;
    assert.equal(restored.steps[0].currentResult.revision, 1);assert.equal(restored.plan.completion.readyToFinish, true);
  } finally { c.close(); }
});

test("competing lifecycle commands and delete resolve through version checks without an open deleted interval", async () => {
  for (const competitor of ["StartPlan", "UpdatePlanMetadata"]) {
    const c = context();
    try {
      await create(c);
      const responses = await Promise.all([command(c, "DeletePlan", { planId: PLAN }, 0), command(c, competitor, { planId: PLAN, ...(competitor === "UpdatePlanMetadata" ? { title: "Изменён" } : {}) }, 0)]);
      assert.equal(responses.filter(r => r.status === 200).length, 1);
      const failed = responses.find(r => r.status !== 200);
      assert(["VERSION_CONFLICT", "PLAN_DELETED"].includes(failed.value.error.code));
      const saved = await plan(c);
      if (saved.deletedAt != null) assert(saved.intervals.every(i => i.end_ms != null));
      assert.equal(saved.version, 1);
    } finally { c.close(); }
  }
});

test("an injected failure after deletion rolls back plan, attempts, intervals and receipt together", async () => {
  const c = context();
  try {
    await running(c);const before = rows(c);
    c.db.sqlite.exec("CREATE TRIGGER fixture_delete_failure BEFORE INSERT ON tracker_journal WHEN NEW.event_type='PLAN_DELETED' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    assert.equal((await command(c, "DeletePlan", { planId: PLAN }, 1)).status, 500);
    assert.deepEqual(rows(c), before);
  } finally { c.close(); }
});

test("0016 upgrades a populated v3 schema without changing existing data or starting/stopping timers", async () => {
  const c = context(migrations.indexOf("0016_plan_deletion.sql"));
  try {
    await running(c);const before = rows(c);
    c.db.sqlite.exec(migration("0016_plan_deletion.sql"));
    const after = rows(c);
    after.plans = after.plans.map(value => { const row = JSON.parse(value);assert.equal(row.deleted_at, null);delete row.deleted_at;return JSON.stringify(row); });
    assert.deepEqual(after, before);
    await ok(c, "DeletePlan", { planId: PLAN }, 1);
    assert.equal((await plan(c)).deletedAt, c.now());
  } finally { c.close(); }
});

test("a zero deletion timestamp is still deleted", async () => {
  const c = context();
  try {
    c.advance(-c.now());await create(c);await ok(c, "DeletePlan", { planId: PLAN }, 0);
    assert.equal((await plan(c)).deletedAt, 0);assert.equal((await call(c, "/api/plans")).value.plans.length, 0);
    assert.equal((await call(c, "/api/plans?deleted=true")).value.plans.length, 1);
  } finally { c.close(); }
});
