import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalytics } from "../worker/index.js";
import { context, call, ok, command, mcp, running, result, check, rows, PLAN, OWNER, DIGEST_A, DIGEST_B } from "./fixtures/tracker-db.mjs";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const create = (c, planId, owner) => command(c, "CreatePlan", { planId, title: planId, planCreatedAt: { precision: "dateOnly", on: "2026-10-01", timeZone: "UTC" } }, undefined, undefined, owner);
const list = async (c, args = {}, owner) => (await mcp(c, "ListPlans", args, owner)).value.result;

test("fresh schema permits independent start/resume/pause/finish and exact retries", async () => {
  const c = context();
  try {
    await create(c, PLAN);await create(c, B);
    const starts = await Promise.all([command(c, "StartPlan", { planId: PLAN }, 0), command(c, "StartPlan", { planId: B }, 0)]);
    assert.deepEqual(starts.map(r => r.status), [200, 200]);
    c.advance(60000);
    await ok(c, "PausePlan", { planId: PLAN }, 1);
    const before = (await call(c, "/api/plans/" + B)).value.plan;
    const retryId = crypto.randomUUID();
    assert.equal((await command(c, "ResumePlan", { planId: PLAN }, 2, retryId)).status, 200);
    const replay = await command(c, "ResumePlan", { planId: PLAN }, 2, retryId);
    assert.equal(replay.value.replayed, true);
    await ok(c, "FinishPlan", { planId: PLAN }, 3);
    assert.deepEqual((await call(c, "/api/plans/" + B)).value.plan, before);
    assert.equal(c.db.sqlite.prepare("SELECT count(*) AS n FROM work_intervals WHERE plan_id=?").get(PLAN).n, 2);
    assert.equal(c.db.sqlite.prepare("SELECT count(*) AS n FROM work_intervals WHERE plan_id=? AND end_ms IS NULL").get(B).n, 1);
    assert.equal(c.db.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='plans_one_running_per_owner'").get().n, 0);
  } finally { c.close(); }
});

test("ListPlans filters, paginates ties stably, isolates owners and replaces the singular contract", async () => {
  const c = context();
  try {
    assert.deepEqual((await list(c, { statuses: ["RUNNING"] })).structuredContent.plans, []);
    for (const id of [PLAN, B, C]) assert.equal((await create(c, id)).status, 200);
    await create(c, PLAN, "other-owner");
    await ok(c, "StartPlan", { planId: PLAN }, 0);
    assert.equal((await list(c, { statuses: ["RUNNING"] })).structuredContent.plans.length, 1);
    await ok(c, "StartPlan", { planId: B }, 0);
    const active = (await list(c, { statuses: ["RUNNING"] })).structuredContent;
    assert.equal(active.plans.length, 2);assert.equal(active.serverNow, c.now());
    const snapshot = rows(c), ids = [];let cursor;
    do {
      const page = (await list(c, { limit: 1, ...(cursor ? { cursor } : {}) })).structuredContent;
      assert.equal(page.plans.length, 1);ids.push(page.plans[0].planId);cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(ids, [C, B, PLAN]);
    assert.deepEqual((await list(c, { statuses: ["PLANNED", "PAUSED"] })).structuredContent.plans.map(p => p.planId), [C]);
    assert.equal((await list(c, {}, "other-owner")).structuredContent.plans.length, 1);
    assert.equal((await call(c, "/api/plans?limit=1&statuses=RUNNING")).value.plans.length, 1);
    for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { statuses: ["BOGUS"] }, { statuses: [] }, { cursor: "bad" }, { ownerId: OWNER }]) {
      assert.equal((await list(c, args)).structuredContent.code, "VALIDATION_ERROR", JSON.stringify(args));
    }
    assert.deepEqual(rows(c), snapshot, "list operations are read only");
    const discovery = await call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert(discovery.value.result.tools.some(t => t.name === "ListPlans"));
    assert(!discovery.value.result.tools.some(t => t.name === "GetActivePlan"));
    assert.equal((await mcp(c, "GetActivePlan")).value.result.isError, true);
    assert.equal((await call(c, "/api/active")).status, 404);
    const capabilities = (await mcp(c, "GetTrackerCapabilities")).value.result.structuredContent;
    assert.equal(capabilities.parallelPlans, true);assert.equal(capabilities.planList.tool, "ListPlans");
  } finally { c.close(); }
});

test("concurrent plans keep attempts, result revisions, checks and readiness separate", async () => {
  const c = context();
  try {
    const a = await running(c, ["unit"], PLAN), b = await running(c, ["unit"], B);
    await result(c, a, DIGEST_A);await result(c, b, DIGEST_B);
    await ok(c, "RecordCheck", check(a.stepId));
    const get = async id => (await call(c, "/api/tracker/plans/" + id + "/execution")).value;
    assert.equal((await get(PLAN)).plan.completion.readyToFinish, true);
    assert.equal((await get(B)).plan.completion.readyToFinish, false);
    const before = await get(B);
    await ok(c, "FinishPlan", { planId: PLAN }, 1);
    assert.deepEqual(await get(B), before);
    const cross = await command(c, "RecordCheck", check(b.stepId, "PASSED", DIGEST_A));
    assert.equal(cross.status, 409);
    assert.equal((await get(B)).plan.completion.readyToFinish, false);
  } finally { c.close(); }
});

for (const [name, segments, expected] of [
  ["overlapping", [[0, 60], [30, 90]], 90],
  ["nested", [[0, 90], [30, 60]], 90],
  ["touching", [[0, 30], [30, 60]], 60],
  ["disjoint", [[0, 30], [60, 90]], 60],
]) test("analytics unions " + name + " plans while preserving their sums", async () => {
  const c = context();
  try {
    const base = Date.parse("2026-10-15T10:00:00Z"), minute = 60000;
    for (const [i, id] of [PLAN, B].entries()) {
      await create(c, id);const [start, end] = segments[i];
      c.db.sqlite.prepare("UPDATE plans SET status='COMPLETED',first_started_at=?,finished_at=? WHERE plan_id=?").run(base + start * minute, base + end * minute, id);
      c.db.sqlite.prepare("INSERT INTO work_intervals(interval_id,owner_id,plan_id,start_ms,end_ms,opened_by) VALUES(?,?,?,?,?,?)").run(id, OWNER, id, base + start * minute, base + end * minute, OWNER);
    }
    const now = base + 100 * minute;
    const data = await buildAnalytics(c.db, OWNER, { from: "2026-10-15", to: "2026-10-15", timeZone: "UTC" }, now);
    assert.equal(data.totalActiveMs, expected * minute);
    assert.equal(data.sumPlanActiveMs, segments.reduce((n, [a, b]) => n + b - a, 0) * minute);
    assert.equal(data.activeByDay[0].activeMs, expected * minute);
    assert.deepEqual(data.plans.map(p => p.activeInPeriodMs).sort((a,b)=>a-b), segments.map(([a,b]) => (b-a)*minute).sort((a,b)=>a-b));
    assert.equal(data.asOf, now);
  } finally { c.close(); }
});

test("analytics clips the union at local midnight, period edges and one asOf for open intervals", async () => {
  const c = context();
  try {
    const base = Date.parse("2026-10-15T17:30:00Z"), minute = 60000;
    c.advance(base - c.now());await create(c, PLAN);await create(c, B);
    await ok(c, "StartPlan", { planId: PLAN }, 0);c.advance(30 * minute);
    await ok(c, "StartPlan", { planId: B }, 0);c.advance(90 * minute);
    const data = await buildAnalytics(c.db, OWNER, { from: "2026-10-15", to: "2026-10-16", timeZone: "Asia/Omsk" }, c.now());
    assert.equal(data.totalActiveMs, 120 * minute);assert.equal(data.sumPlanActiveMs, 210 * minute);
    assert.deepEqual(data.activeByDay, [{ date: "2026-10-15", activeMs: 30 * minute }, { date: "2026-10-16", activeMs: 90 * minute }]);
    const day = await buildAnalytics(c.db, OWNER, { from: "2026-10-16", to: "2026-10-16", timeZone: "Asia/Omsk" }, c.now());
    assert.equal(day.totalActiveMs, 90 * minute);assert.equal(day.sumPlanActiveMs, 180 * minute);
  } finally { c.close(); }
});

for (const [date, start, end, hours] of [
  ["2026-03-08", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", 23],
  ["2026-11-01", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", 25],
]) test("analytics unions and clips overlapping plans on a " + hours + "-hour local day", async () => {
  const c = context(), hour = 3600000, from = Date.parse(start), to = Date.parse(end);
  try {
    for (const [id, a, b] of [[PLAN, from - hour, from + 10 * hour], [B, from + 5 * hour, to + hour]]) {
      await create(c, id);
      c.db.sqlite.prepare("UPDATE plans SET status='COMPLETED',first_started_at=?,finished_at=? WHERE plan_id=?").run(a, b, id);
      c.db.sqlite.prepare("INSERT INTO work_intervals(interval_id,owner_id,plan_id,start_ms,end_ms,opened_by) VALUES(?,?,?,?,?,?)").run(id, OWNER, id, a, b, OWNER);
    }
    const data = await buildAnalytics(c.db, OWNER, { from: date, to: date, timeZone: "America/New_York" }, to + hour);
    assert.equal(data.totalActiveMs, hours * hour);assert.equal(data.sumPlanActiveMs, (hours + 5) * hour);
    assert.deepEqual(data.activeByDay, [{ date, activeMs: hours * hour }]);
  } finally { c.close(); }
});
