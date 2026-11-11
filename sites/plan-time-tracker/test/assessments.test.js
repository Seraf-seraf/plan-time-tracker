import test from "node:test";
import assert from "node:assert/strict";
import { context, call, command, envelope, ok, mcp, running, result, check, PLAN, OWNER, migrations, migration, rows } from "./fixtures/tracker-db.mjs";

const OTHER = "22222222-2222-4222-8222-222222222222";
const historyArgs = targets => ({ targets, from: "2027-01-01", to: "2027-01-31", timeZone: "UTC" });
async function assessment(c, stepId, overrides = {}) {
  const response = await mcp(c, "GetAssessment", { planId: PLAN, ...(stepId ? { stepId } : {}) });
  assert.equal(response.value.result.isError, undefined, JSON.stringify(response.value));
  const expectedRequirementsDigest = response.value.result.structuredContent.currentRequirementsDigest;
  return { assessmentId: crypto.randomUUID(), planId: PLAN, expectedRequirementsDigest, ...(stepId ? { stepId } : {}),
    phase: "planning", context: { expectedResult: "Verified feature", scope: "one change", checks: ["unit"] },
    method: { id: "relative-scrum", version: "1", scale: [1, 2, 3, 5, 8, 13] },
    complexity: { status: "KNOWN", value: 5, rationale: "Comparable to reference; persistence uncertainty." },
    unknowns: ["Migration behavior"], assumptions: ["Existing runtime"], dependencies: [],
    forecast: { status: "KNOWN", metric: "PLAN_ACTIVE", lowerMs: 60000, upperMs: 120000, confidence: "LOW", basis: "Expert range, no comparable history", sampleCount: 0 },
    sources: [], approach: { description: "Extend existing command path", rationale: "Preserve atomic receipts" }, ...overrides };
}
async function planned(c) {
  await ok(c, "CreatePlan", { planId: PLAN, title: "Assessment feature", planText:"# Assessment feature\n\n## Этап 1. Feature\nWorks", planCreatedAt: { precision: "dateOnly", on: "2027-01-01", timeZone: "UTC" } });
  return {stepId:c.db.sqlite.prepare("SELECT step_id FROM plan_steps WHERE plan_id=?").get(PLAN).step_id};
}
const read = async (c, p, revision) => {
  const response = await mcp(c, "GetAssessment", { planId: p.planId, assessmentId: p.assessmentId, ...(revision ? { revision } : {}) });
  assert.equal(response.value.result.isError, undefined, JSON.stringify(response.value));
  return response.value.result.structuredContent;
};
const history = async (c, args) => {
  const response = await mcp(c, "GetEstimationHistory", args);
  assert.equal(response.value.result.isError, undefined, JSON.stringify(response.value));
  return response.value.result.structuredContent;
};

test("planning stores independent numeric and multidimensional methods without starting execution", async () => {
  const c = context();
  try {
    const step = await planned(c), first = await assessment(c, step.stepId);
    await ok(c, "RecordAssessment", first, 0);
    const second = await assessment(c, step.stepId, { method: { id: "risk-matrix", version: "2026", scale: { effort: ["S", "M", "L"], repositoryId: "neutral dimension" } }, complexity: { status: "KNOWN", value: { effort: "M", risk: "high" }, rationale: "Independent dimensions" } });
    await ok(c, "RecordAssessment", second, 0);
    assert.equal((await read(c, first)).assessment.complexity.value, 5);
    assert.deepEqual((await read(c, second)).assessment.method, second.method);
    assert.deepEqual((await read(c, second)).assessment.complexity.value, second.complexity.value);
    const snapshot = (await call(c, "/api/tracker/plans/" + PLAN + "/execution")).value;
    assert.equal(snapshot.plan.status, "PLANNED");
    assert.equal(snapshot.steps[0].status, "PENDING");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) n FROM work_intervals").get().n, 0);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='step_attempts'").get().n,0);
    const h = await history(c, historyArgs([{ planId: PLAN, stepId: step.stepId }]));
    assert.equal(h.assessments.length, 2);
    assert.equal(h.totalActiveMs, null);
    assert(h.statistics.every(s=>!["STEP_ATTRIBUTED","ATTEMPT","TOOL"].includes(s.metric)));
  } finally { c.close(); }
});

test("immutable revisions retain baseline; only requirements changes make estimates stale", async () => {
  const c = context();
  try {
    const step = await planned(c), p = await assessment(c, step.stepId);
    await ok(c, "RecordAssessment", p, 0);
    const initial = await read(c, p);
    await ok(c, "StartPlan", { planId: PLAN }, 0);
    assert.equal((await read(c, p)).needsRevision, false);
    await ok(c,"UpdatePlanMetadata",{planId:PLAN,title:"Expanded result"},1);
    assert.equal((await read(c, p)).needsRevision, true);
    await ok(c, "RecordAssessment", { ...p, expectedRequirementsDigest: (await read(c, p)).currentRequirementsDigest, reason: "Expanded result", complexity: { ...p.complexity, value: 8 } }, 1);
    const latest = await read(c, p);
    assert.equal(latest.revision, 2); assert.equal(latest.previousRevision, 1); assert.equal(latest.needsRevision, false);
    assert.equal((await read(c, p, 1)).assessment.complexity.value, 5);
    assert.equal((await read(c, p, 1)).requirementsDigest, initial.requirementsDigest);
    assert.throws(() => c.db.sqlite.exec("UPDATE assessment_revisions SET revision=99"), /ASSESSMENT_IMMUTABLE/);
    assert.throws(() => c.db.sqlite.exec("DELETE FROM assessment_revisions"), /ASSESSMENT_IMMUTABLE/);
    await ok(c,"UpdatePlanMetadata",{planId:PLAN,title:"New scope"},2);
    assert.equal((await read(c, p)).needsRevision, true);
  } finally { c.close(); }
});

test("unknowns, units, ranges, references and bounded JSON are validated without a methodology gate", async () => {
  const c = context();
  try {
    const step = await planned(c), p = await assessment(c, step.stepId, { complexity: { status: "UNKNOWN", value: null, rationale: "Needs research" }, forecast: { status: "UNKNOWN", metric: "PLAN_ACTIVE", lowerMs: null, upperMs: null, confidence: "UNKNOWN", basis: "No data", sampleCount: 0 } });
    await ok(c, "RecordAssessment", p, 0);
    const mutations = [
      x => x.forecast.lowerMs = 0, x => x.complexity.value = 0, x => x.forecast.metric = "hours",
      x => x.forecast.sampleCount = -1, x => x.method.id = "", x => x.method.version = "",
      x => delete x.expectedRequirementsDigest, x => x.expectedRequirementsDigest = "bad",
      x => x.expectedRequirementsDigest = "sha256:" + "A".repeat(64),
      x => delete x.method.scale, x => x.unknowns = Array(21).fill("unknown"),
      x => x.sources = [{ planId: "bad" }], x => x.context = [], x => x.context.text = "a".repeat(4001),
      x => { let item = x.context; for (let i = 0; i < 15; i++) item = item.child = {}; },
      x => { x.context = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, "a".repeat(3000)])); },
      x => x.forecast = { ...x.forecast, status: "KNOWN", lowerMs: 5, upperMs: 4 },
      x => x.forecast = { ...x.forecast, status: "KNOWN", lowerMs: 0.5, upperMs: 1 },
    ];
    for (const mutate of mutations) {
      const invalid = structuredClone(p); mutate(invalid); invalid.assessmentId = crypto.randomUUID();
      assert.equal((await command(c, "RecordAssessment", invalid, 0)).status, 400, JSON.stringify(invalid).slice(0, 200));
    }
    assert.equal((await command(c, "RecordAssessment", { ...p, assessmentId: crypto.randomUUID() })).status, 400);
    assert.equal((await command(c, "RecordAssessment", p, 1)).status, 400);
    assert.equal((await command(c, "RecordAssessment", { ...p, assessmentId: crypto.randomUUID(), sources: [{ planId: OTHER }] }, 0)).value.error.code, "ASSESSMENT_SOURCE_NOT_FOUND");
    assert.equal((await command(c, "RecordAssessment", { ...p, assessmentId: crypto.randomUUID(), stepId: OTHER }, 0)).status, 404);
  } finally { c.close(); }
});

test("CAS serializes competing writers; exact retries and receipt reads recover a lost response", async () => {
  const c = context();
  try {
    const step = await planned(c), p = await assessment(c, step.stepId), id = crypto.randomUUID();
    const first = await command(c, "RecordAssessment", p, 0, id);
    const replay = await command(c, "RecordAssessment", p, 0, id);
    assert.equal(replay.value.replayed, true); assert.deepEqual(replay.value.result, first.value.result);
    const receipt = (await mcp(c, "GetCommandReceipt", { commandId: id })).value.result.structuredContent;
    assert.equal(receipt.status, "FINAL");
    assert.equal((await command(c, "RecordAssessment", { ...p, phase: "changed" }, 0, id)).status, 409);
    const responses = await Promise.all([1, 2].map(n => command(c, "RecordAssessment", { ...p, reason: "Writer " + n }, 1)));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    assert.equal((await read(c, p)).revisionCount, 2);
    const conflict = await command(c, "RecordAssessment", { ...p, reason: "Move series", stepId: undefined }, 2);
    assert.equal(conflict.value.error.code, "ASSESSMENT_TARGET_CONFLICT");
  } finally { c.close(); }
});

test("owner isolation covers targets, sources, history, reads and deleted plans", async () => {
  const c = context();
  try {
    const step = await planned(c), p = await assessment(c, step.stepId);
    await ok(c, "RecordAssessment", p, 0);
    for (const name of ["GetAssessment", "GetEstimationHistory"]) {
      const args = name === "GetAssessment" ? { planId: PLAN, assessmentId: p.assessmentId } : historyArgs([{ planId: PLAN }]);
      assert.equal((await mcp(c, name, args, "other-owner")).value.result.isError, true);
      assert.equal((await mcp(c, name, args, "")).status, 401);
    }
    assert.equal((await command(c, "RecordAssessment", p, 0, undefined, "other-owner")).status, 404);
    await ok(c, "DeletePlan", { planId: PLAN }, 0);
    assert.equal((await read(c, p)).revision, 1);
    assert.equal((await command(c, "RecordAssessment", { ...p, reason: "Deleted" }, 1)).value.error.code, "PLAN_DELETED");
    assert.equal((await mcp(c, "GetEstimationHistory", historyArgs([{ planId: PLAN }]))).value.result.isError, true);
  } finally { c.close(); }
});

test("MCP discovery and HTTP expose the same strict neutral contract and version", async () => {
  const c = context();
  try {
    const step = await planned(c), p = await assessment(c, step.stepId);
    const write = await mcp(c, "RecordAssessment", { ...envelope("RecordAssessment", p, 0), commandType: undefined });
    assert.equal(write.value.result.isError, undefined, JSON.stringify(write.value));
    assert.equal((await call(c, "/api/tracker/assessment", { planId: PLAN, assessmentId: p.assessmentId })).value.revision, 1);
    assert.equal((await call(c, "/api/tracker/estimation-history", historyArgs([{ planId: PLAN }]))).status, 200);
    for (const args of [{ ...historyArgs([{ planId: PLAN }]), limit: 0 }, { ...historyArgs([{ planId: PLAN }]), asOf: c.now() + 1 }, historyArgs([{ planId: PLAN }, { planId: PLAN }])]) {
      assert.equal((await mcp(c, "GetEstimationHistory", args)).value.result.isError, true);
    }
    const init = await call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.equal(init.value.result.serverInfo.version, "0.6.0");
    const caps = (await mcp(c, "GetTrackerCapabilities")).value.result.structuredContent;
    assert.equal(caps.version, "0.6.0"); assert.equal(caps.assessments.methodologyControlsExecution, false);
    const listing = await call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tool = listing.value.result.tools.find(t => t.name === "SaveTaskAssessment");
    assert.ok(tool.inputSchema.required.includes("expectedVersion"));
    assert.equal(tool.inputSchema.properties.payload.properties.method.properties.id.enum, undefined);
  } finally { c.close(); }
});

test("assessment insertion rejects requirements changed between read and atomic write", async () => {
  const c = context();
  try {
    const step = await planned(c), p = await assessment(c, step.stepId), originalPrepare = c.db.prepare.bind(c.db);
    let changed = false;
    c.db.prepare = sql => {
      if (!changed && sql.startsWith("INSERT OR IGNORE INTO command_receipts")) {
        changed = true;
        c.db.sqlite.prepare("UPDATE assessment_targets SET requirements_json=json_set(requirements_json,'$.plan.title','Concurrent requirement') WHERE step_id=?").run(step.stepId);
      }
      return originalPrepare(sql);
    };
    const rejected = await command(c, "RecordAssessment", p, 0);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.value.error.code, "ASSESSMENT_CONTEXT_CHANGED");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) n FROM assessment_revisions").get().n, 0);
    c.db.prepare = originalPrepare;
    await ok(c, "RecordAssessment", { ...p, expectedRequirementsDigest: (await assessment(c, step.stepId)).expectedRequirementsDigest }, 0);
  } finally { c.close(); }
});

test("assessment write failure rolls revision sequence and receipt back together", async () => {
  const c = context();
  try {
    const step = await planned(c), p = await assessment(c, step.stepId), before = rows(c);
    c.db.sqlite.exec("CREATE TRIGGER fail_assessment_journal BEFORE INSERT ON assessment_revisions BEGIN SELECT RAISE(ABORT,'injected'); END;");
    const rejected = await command(c, "RecordAssessment", p, 0);
    assert.equal(rejected.status, 500);
    assert.deepEqual(rows(c), before);
    c.db.sqlite.exec("DROP TRIGGER fail_assessment_journal");
    await ok(c, "RecordAssessment", p, 0);
  } finally { c.close(); }
});

test("pagination high water excludes later assessments with identical timestamps", async () => {
  const c = context();
  try {
    const step = await planned(c), p = await assessment(c, step.stepId);
    await ok(c, "RecordAssessment", p, 0);
    await ok(c, "RecordAssessment", { ...p, reason: "First revision" }, 1);
    const args = historyArgs([{ planId: PLAN, stepId: step.stepId }]);
    const page = await history(c, { ...args, limit: 1 });
    await ok(c, "RecordAssessment", { ...p, reason: "Later revision same time" }, 2);
    const next = await history(c, { ...args, limit: 1, afterSequence: page.nextAfterSequence, throughSequence: page.throughSequence, asOf: page.asOf });
    assert.equal(next.assessments[0].revision, 2); assert.equal(next.nextAfterSequence, null);
  } finally { c.close(); }
});

async function beginAttempt(c, stepId) {
  const version = c.db.sqlite.prepare("SELECT version FROM plan_steps WHERE step_id=?").get(stepId).version;
  const claim = await ok(c, "ClaimStepAttempt", { stepId, sessionId: crypto.randomUUID(), sourceId: "period-test" }, version);
  const lease = { stepId, attemptId: claim.attemptId, fence: claim.fence };
  await ok(c, "StartStep", lease, version);
  return lease;
}
const closeAttempt = (c, lease) => ok(c, "CloseStepAttempt", { ...lease, disposition: "CLOSED", reason: "Period fixture completed" });

test("calendar facts remain measured when historical active intervals are missing", async () => {
  const c = context();
  try {
    await planned(c);
    c.db.sqlite.prepare("UPDATE plans SET status='COMPLETED',first_started_at=?,finished_at=? WHERE owner_id=? AND plan_id=?")
      .run(c.now() - 60000, c.now(), OWNER, PLAN);
    const h = await history(c, historyArgs([{ planId: PLAN }]));
    assert.equal(h.facts[0].calendarMs, 60000);
    assert.equal(h.facts[0].planActiveMs, null); assert.equal(h.facts[0].pausedMs, null);
    const calendar = h.statistics.find(s => s.metric === "CALENDAR");
    assert.equal(calendar.sampleCount, 1); assert.equal(calendar.medianMs, 60000);
    assert.equal(h.statistics.find(s => s.metric === "PLAN_ACTIVE").status, "INSUFFICIENT_DATA");
    assert.equal(h.statistics.find(s => s.metric === "PAUSED").status, "INSUFFICIENT_DATA");
    const beforeStart = await history(c, { ...historyArgs([{ planId: PLAN }]), asOf: c.now() - 60001 });
    assert.equal(beforeStart.facts[0].calendarMs, null);
    const atStart = await history(c, { ...historyArgs([{ planId: PLAN }]), asOf: c.now() - 60000 });
    assert.equal(atStart.facts[0].calendarMs, 0); assert.equal(atStart.facts[0].planActiveMs, null);
  } finally { c.close(); }
});

test("context-only reads are owner scoped, bounded and available before any assessment", async () => {
  const c = context();
  try {
    const step = await planned(c);
    const response = await call(c, "/api/tracker/assessment", { planId: PLAN, stepId: step.stepId });
    assert.equal(response.status, 200); assert.equal(response.value.contextOnly, true);
    assert.match(response.value.requirements.step.content,/Works/);
    assert.match(response.value.currentRequirementsDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) n FROM assessment_revisions").get().n, 0);
    for (const args of [{ planId: PLAN, revision: 1 }, { planId: PLAN, stepId: step.stepId, assessmentId: crypto.randomUUID() }]) {
      assert.equal((await call(c, "/api/tracker/assessment", args)).status, 400);
    }
    assert.equal((await call(c, "/api/tracker/assessment", { planId: PLAN }, "another-owner")).status, 404);
    assert.equal((await call(c, "/api/tracker/assessment", { planId: PLAN, stepId: OTHER })).status, 404);
    assert.equal((await call(c, "/api/tracker/assessment", { planId: PLAN }, "")).status, 401);
  } finally { c.close(); }
});
