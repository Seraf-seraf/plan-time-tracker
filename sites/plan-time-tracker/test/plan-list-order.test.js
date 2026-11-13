import test from "node:test";
import assert from "node:assert/strict";
import { context, call, mcp, ok, PLAN } from "./fixtures/tracker-db.mjs";

const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

async function collectMcp(c, filters = {}) {
  const ids = [];
  let cursor;
  do {
    const response = await mcp(c, "ListPlans", { limit: 1, ...filters, ...(cursor ? { cursor } : {}) });
    assert.equal(response.status, 200);
    const page = response.value.result.structuredContent;
    assert.equal(page.plans.length, 1);
    ids.push(page.plans[0].planId);
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

async function collectHttp(c) {
  const ids = [];
  let cursor;
  do {
    const response = await call(c, "/api/plans?limit=1" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    assert.equal(response.status, 200);
    ids.push(response.value.plans[0].planId);
    cursor = response.value.nextCursor;
  } while (cursor);
  return ids;
}

test("ListPlans places completed plans last across stable API pagination", async () => {
  const c = context();
  try {
    const createdAt = { precision: "dateOnly", on: "2026-10-01", timeZone: "UTC" };
    for (const planId of [PLAN, B, C, D]) {
      await ok(c, "CreatePlan", { planId, title: planId, planCreatedAt: createdAt });
    }
    await ok(c, "StartPlan", { planId: PLAN }, 0);
    await ok(c, "StartPlan", { planId: C }, 0);
    await ok(c, "PausePlan", { planId: C }, 1);
    await ok(c, "StartPlan", { planId: B }, 0);
    await ok(c, "FinishPlan", { planId: B }, 1);

    const expected = [D, C, PLAN, B];
    assert.deepEqual(await collectMcp(c), expected, "non-completed plans precede completed plans while registration ties stay stable");
    assert.deepEqual(await collectHttp(c), expected, "HTTP pagination uses the same sort key and cursor");

    const filtered = (await mcp(c, "ListPlans", { statuses: ["RUNNING", "COMPLETED"] })).value.result.structuredContent;
    assert.deepEqual(filtered.plans.map(plan => plan.planId), [PLAN, B]);
    const completed = (await mcp(c, "ListPlans", { statuses: ["COMPLETED"] })).value.result.structuredContent;
    assert.deepEqual(completed.plans.map(plan => plan.planId), [B]);
    assert.equal(completed.nextCursor, null);

    const capabilities = (await mcp(c, "GetTrackerCapabilities")).value.result.structuredContent;
    assert.equal(capabilities.planList.order, "isCompleted ASC, registeredAt DESC, planId DESC");

    await ok(c, "DeletePlan", { planId: B }, 2);
    assert.deepEqual(await collectMcp(c), [D, C, PLAN], "deleted filter remains excluded by default");
    const deleted = (await mcp(c, "ListPlans", { deleted: true })).value.result.structuredContent;
    assert.deepEqual(deleted.plans.map(plan => plan.planId), [B]);
  } finally {
    c.close();
  }
});
