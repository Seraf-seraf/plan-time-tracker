import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalytics, buildStepAnalytics } from "../worker/index.js";
import { context, OWNER, PLAN, call, ok, running, result, rows } from "./fixtures/tracker-db.mjs";

const period = { from: "2026-10-14", to: "2026-10-15", timeZone: "UTC" };
function fixture() {
  const c = context();c.advance(Date.UTC(2026, 9, 14, 23, 58) - c.now());return c;
}
const detail = (c, filter = period, owner = OWNER) => buildStepAnalytics(c.db, owner, PLAN, filter, c.now());
const claimStart = async (c, stepId, version = 1) => {
  const claim = await ok(c, "ClaimStepAttempt", { stepId, sessionId: crypto.randomUUID(), sourceId: "analytics-fixture" }, version);
  const lease = { stepId, attemptId: claim.attemptId, fence: claim.fence };
  await ok(c, "StartStep", lease, version);return lease;
};
const addStep = (c, ordinal, title = "Synthetic section " + ordinal) => ok(c, "CreateStep", { planId: PLAN, ordinal, title, expectedResult: "Synthetic verification", requiredChecks: [] });

test("step analytics intersects work intervals, all attempts and inclusive period; pauses never accrue", async () => {
  const c = fixture();
  try {
    const first = await running(c, []);
    c.advance(90000);await ok(c, "PausePlan", { planId: PLAN }, 1);
    c.advance(120000);await ok(c, "ResumePlan", { planId: PLAN }, 2);
    c.advance(30000);await ok(c, "BlockStep", { ...first, reason: "Synthetic retry" }, 2);
    c.advance(10000); // Active plan time without an executing step remains unattributed.
    const second = await claimStart(c, first.stepId, 3);
    c.advance(61234);await ok(c, "RecordStepResult", { ...second, outcome: "FAILED", summary: "Synthetic failed attempt" }, 4);
    const before = rows(c), all = await detail(c);
    assert.equal(all.steps[0].activeMs, 181234);
    assert.equal(all.totalActiveMs, 191234);assert.equal(all.unattributedMs, 10000);
    assert.equal(all.ambiguousMs, 0);
    assert.equal(all.totalActiveMs, (await buildAnalytics(c.db, OWNER, period, c.now())).totalActiveMs);
    assert.deepEqual(rows(c), before, "analytics never writes application data");
    assert.equal((await detail(c, { ...period, to: "2026-10-14" })).steps[0].activeMs, 90000);
    assert.equal((await detail(c, { ...period, from: "2026-10-15" })).steps[0].activeMs, 91234);
    assert.equal((await detail(c, { ...period, asOf: c.now() - 61234 })).steps[0].activeMs, 120000);
  } finally { c.close(); }
});

test("parallel steps leave ambiguous time unassigned, source order and missing attribution are preserved", async () => {
  const c = fixture();
  try {
    const first = await running(c, []);
    const other = await addStep(c, 7, "Длинное название ".repeat(10));
    const untouched = await addStep(c, 2);
    c.advance(60000);const second = await claimStart(c, other.stepId);
    c.advance(60000);await result(c, first, null);
    c.advance(60000);await result(c, second, null);
    const data = await detail(c);
    assert.deepEqual(data.steps.map(s => s.ordinal), [0, 2, 7]);
    assert.deepEqual(data.steps.map(s => s.activeMs), [60000, null, 60000]);
    assert.deepEqual(data.steps.map(s => s.ambiguousMs), [60000, null, 60000], "partial values retain per-step uncertainty");
    assert.equal(data.steps[1].stepId, untouched.stepId);
    assert.equal(data.steps[2].title, "Длинное название ".repeat(10).trim());
    assert.equal(data.totalActiveMs, 180000);assert.equal(data.unattributedMs, 60000);assert.equal(data.ambiguousMs, 60000);
    assert.equal(data.steps.reduce((sum, s) => sum + (s.activeMs ?? 0), 0) + data.unattributedMs, data.totalActiveMs);
  } finally { c.close(); }
});

test("claim time is not execution; expired and renewed leases limit attribution without stopping plan time", async () => {
  const c = fixture();
  try {
    await ok(c, "CreatePlan", { planId: PLAN, title: "Synthetic plan", planCreatedAt: { precision: "dateOnly", on: "2026-10-14", timeZone: "UTC" } });
    const step = await addStep(c, 0);await ok(c, "StartPlan", { planId: PLAN }, 0);
    const claim = await ok(c, "ClaimStepAttempt", { stepId: step.stepId, sessionId: crypto.randomUUID(), sourceId: "analytics-fixture" }, 1);
    c.advance(60000);
    assert.equal((await detail(c)).steps[0].activeMs, null);
    const lease = { stepId: step.stepId, attemptId: claim.attemptId, fence: claim.fence };
    await ok(c, "StartStep", lease, 1);c.advance(240000);await ok(c, "RenewStepLease", lease);
    c.advance(720000);
    const data = await detail(c);
    assert.equal(data.steps[0].activeMs, 840000); // 4 minutes + renewed 10-minute lease.
    assert.equal(data.totalActiveMs, 1020000);assert.equal(data.unattributedMs, 180000);
    const historical = await detail(c, { ...period, asOf: c.now() - 720000 });
    assert.equal(historical.steps[0].activeMs, 240000);
  } finally { c.close(); }
});

test("empty, never-started and measured zero have distinct results; detail API is owner scoped and validates inputs", async () => {
  const c = fixture();
  try {
    await ok(c, "CreatePlan", { planId: PLAN, title: "Empty synthetic plan", planCreatedAt: { precision: "dateOnly", on: "2026-10-14", timeZone: "UTC" } });
    assert.deepEqual((await detail(c)).steps, []);assert.equal((await detail(c)).totalActiveMs, null);
    const zero = await addStep(c, 0);assert.equal((await detail(c)).steps[0].activeMs, null);
    await ok(c, "StartPlan", { planId: PLAN }, 0);
    const lease = await claimStart(c, zero.stepId);await result(c, lease, null);
    assert.equal((await detail(c)).steps[0].activeMs, 0);
    const path = "/api/analytics/plans/" + PLAN + "/steps?";
    assert.equal((await call(c, path + new URLSearchParams(period))).status, 200);
    assert.equal((await call(c, path + new URLSearchParams(period), undefined, "other-owner")).status, 404);
    assert.equal((await call(c, path + new URLSearchParams(period), undefined, null)).status, 401);
    for (const values of [{ from: "2026-02-30" }, { from: "2026-10-16" }, { timeZone: "Invalid/Zone" }, { asOf: "bad" }, { asOf: String(c.now() + 1) }]) {
      assert.equal((await call(c, path + new URLSearchParams({ ...period, ...values }))).status, 400, JSON.stringify(values));
    }
    c.advance(1);
    const legacy = (await call(c, "/api/analytics?" + new URLSearchParams(period))).value;
    assert(!("steps" in legacy.plans[0]), "existing analytics/MCP shape is unchanged");
  } finally { c.close(); }
});

test("local midnight, half-open endpoints and snapshot time agree with the existing analytics", async () => {
  const c = fixture();
  try {
    const lease = await running(c, []);c.advance(300000);await result(c, lease, null);
    const filter = { from: "2026-10-15", to: "2026-10-15", timeZone: "Europe/Moscow" };
    assert.equal((await detail(c, filter)).steps[0].activeMs, 300000);
    assert.equal((await detail(c, { ...filter, timeZone: "UTC" })).steps[0].activeMs, 180000);
    assert.equal((await detail(c, { ...period, asOf: Date.UTC(2026, 9, 15) })).steps[0].activeMs, 120000);
    assert.equal((await detail(c, { ...period, from: "2026-10-16", to: "2026-10-16" })).steps[0].activeMs, 0);
  } finally { c.close(); }
});

test("lazy step detail excludes sections created after report.asOf and includes the exact creation boundary", async () => {
  const c = fixture();
  try {
    const first = await running(c, []);c.advance(1000);
    const boundary = await addStep(c, 7, "Created exactly at report cutoff");
    const report = await buildAnalytics(c.db, OWNER, period, c.now());
    c.advance(1);const later = await addStep(c, 2, "Created after report cutoff");
    const before = rows(c);
    const response = await call(c, "/api/analytics/plans/" + PLAN + "/steps?" + new URLSearchParams({ ...period, asOf: String(report.asOf) }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.value.steps.map(s => s.stepId), [first.stepId, boundary.stepId]);
    assert.equal(response.value.totalActiveMs, report.totalActiveMs);
    assert.deepEqual((await detail(c, { ...period, asOf: report.asOf - 1 })).steps.map(s => s.stepId), [first.stepId]);
    assert.deepEqual((await detail(c)).steps.map(s => s.stepId), [first.stepId, later.stepId, boundary.stepId]);
    assert.deepEqual(rows(c), before, "historical detail is read-only");
  } finally { c.close(); }
});

test("asOf before the first plan start remains missing after a later start; exact start is measured zero", async () => {
  const c = fixture();
  try {
    await ok(c, "CreatePlan", { planId: PLAN, title: "Synthetic historical start", planCreatedAt: { precision: "dateOnly", on: "2026-10-14", timeZone: "UTC" } });
    const step = await addStep(c, 0), cutoff = c.now();
    const original = await detail(c, { ...period, asOf: cutoff });
    c.advance(1);const firstStart = c.now();
    await ok(c, "StartPlan", { planId: PLAN }, 0);const lease = await claimStart(c, step.stepId);
    c.advance(1);await result(c, lease, null);
    const historical = await detail(c, { ...period, asOf: cutoff });
    for (const key of ["totalActiveMs", "unattributedMs", "ambiguousMs"]) {
      assert.equal(original[key], null);assert.equal(historical[key], null, key + " was missing at the cutoff");
    }
    assert.equal(historical.steps[0].activeMs, null);
    const boundary = await detail(c, { ...period, asOf: firstStart });
    assert.equal(boundary.totalActiveMs, 0);assert.equal(boundary.steps[0].activeMs, 0);
    const current = await detail(c);
    assert.equal(current.totalActiveMs, 1);assert.equal(current.steps[0].activeMs, 1);
  } finally { c.close(); }
});

test("fully overlapping execution windows expose per-step uncertainty rather than measured zero", async () => {
  const c = fixture();
  try {
    const first = await running(c, []), other = await addStep(c, 1);
    const second = await claimStart(c, other.stepId);
    c.advance(60000);await result(c, first, null);await result(c, second, null);
    const zero = await addStep(c, 2), zeroLease = await claimStart(c, zero.stepId);
    await result(c, zeroLease, null);await addStep(c, 3);
    const data = await detail(c);
    assert.equal(data.totalActiveMs, 60000);assert.equal(data.ambiguousMs, 60000);assert.equal(data.unattributedMs, 60000);
    assert.deepEqual(data.steps.map(s => s.activeMs), [null, null, 0, null]);
    assert.deepEqual(data.steps.map(s => s.ambiguousMs), [60000, 60000, 0, null]);
  } finally { c.close(); }
});
