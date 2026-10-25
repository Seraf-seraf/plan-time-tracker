import test from "node:test";
import assert from "node:assert/strict";
import { context, call, command, ok, running, result, check, source, internalCommand, rows, PLAN, OWNER, DIGEST_A } from "./fixtures/tracker-db.mjs";

const report = async c => {
  const response = await call(c, "/api/export");
  assert.equal(response.status, 200, JSON.stringify(response.value));return response.value;
};
const stepVersion = (c, stepId) => c.db.sqlite.prepare("SELECT version FROM plan_steps WHERE step_id=?").get(stepId).version;
const claimStart = async (c, stepId) => {
  const version = stepVersion(c, stepId);
  const claim = await ok(c, "ClaimStepAttempt", { stepId, sessionId: crypto.randomUUID(), sourceId: "export-fixture" }, version);
  const lease = { stepId, attemptId: claim.attemptId, fence: claim.fence };
  await ok(c, "StartStep", lease, stepVersion(c, stepId));return lease;
};

test("analytic export includes execution history, links and full assessment content without changing storage", async () => {
  const c = context();
  try {
    const lease = await running(c);c.advance(60000);
    await result(c, lease);await ok(c, "RecordCheck", check(lease.stepId));
    const target = (await call(c, "/api/tracker/assessment", { planId: PLAN })).value;
    const assessment = {
      assessmentId: crypto.randomUUID(), planId: PLAN, expectedRequirementsDigest: target.currentRequirementsDigest,
      context: { owner_id: "user dimension", serverNow: "user context", repositoryId: "user-defined field" },
      method: { id: "expert", version: "1", scale: [1, 2, 3] },
      complexity: { status: "KNOWN", value: 2, rationale: "One boundary" },
      unknowns: ["Latency"], assumptions: ["Existing runtime"], dependencies: [],
      forecast: { status: "KNOWN", metric: "PLAN_ACTIVE", lowerMs: 30000, upperMs: 120000, confidence: "LOW", basis: "Expert range", sampleCount: 0 },
      sources: [], approach: { description: "Extend export", rationale: "Preserve history" }, phase: "planning",
    };
    await ok(c, "RecordAssessment", assessment, 0);
    const before = rows(c), report = (await call(c, "/api/export")).value;
    assert.equal(report.formatVersion, 1);
    const plan = report.plans[0], step = plan.steps[0];
    assert.equal(step.stepId, lease.stepId);assert.equal(step.results.length, 1);assert.equal(step.checks.length, 1);
    assert.equal(step.attempts[0].attemptId, lease.attemptId);
    assert.equal(step.results[0].attemptId, lease.attemptId);assert.equal(step.checks[0].resultRevision, step.results[0].revision);
    assert.deepEqual(plan.assessments[0].assessment.context, assessment.context);
    assert.equal(plan.assessments[0].assessment.forecast.lowerMs, 30000);
    assert.equal(plan.assessments[0].needsRevision, false);
    assert(plan.timeline.some(e => e.eventType === "STEP_STARTED"));
    assert(plan.timeline.some(e => e.eventType === "CHECK_RECORDED"));
    assert.equal(plan.timeline.filter(e => e.eventType === "PLAN_STARTED").length, 1);
    assert.equal(plan.activeMs, 60000);assert.equal(step.activeMs, 60000);
    assert.equal(report.summary.totalActiveMs, 60000);assert.equal(report.summary.sumPlanActiveMs, 60000);
    assert.deepEqual(rows(c), before);
    const inspect = value => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "assessment") continue;
        assert(!["ownerId", "owner_id", "serverNow", "commandId", "command_id", "payloadHash", "fence", "version", "canStart", "sessionId"].includes(key), key);
        inspect(child);
      }
    };
    inspect(report);
  } finally { c.close(); }
});

test("export retains more than 50 attempts, 10 results, 100 checks/events and all assessment revisions", async () => {
  const c = context();
  try {
    let lease = await running(c);
    for (let i = 0; i < 51; i++) {
      c.advance(1);
      await ok(c, "RecordStepResult", { ...lease, outcome: i === 50 ? "DONE" : "FAILED", summary: "Result " + i, sourceSnapshot: source() }, stepVersion(c, lease.stepId));
      if (i < 50) lease = await claimStart(c, lease.stepId);
    }
    for (let i = 0; i < 105; i++) {
      await ok(c, "RecordCheck", { ...check(lease.stepId, i % 2 ? "FAILED" : "PASSED", DIGEST_A, 51), evidenceSummary: "Check " + i });
    }
    const target = (await call(c, "/api/tracker/assessment", { planId: PLAN, stepId: lease.stepId })).value;
    const payload = {
      assessmentId: crypto.randomUUID(), planId: PLAN, stepId: lease.stepId, expectedRequirementsDigest: target.currentRequirementsDigest,
      context: { scope: "all history" }, method: { id: "neutral", version: "1", scale: [1, 2, 3] },
      complexity: { status: "UNKNOWN", value: null, rationale: "Unknown" },
      unknowns: [], assumptions: [], dependencies: [], sources: [],
      forecast: { status: "UNKNOWN", metric: "STEP_ATTRIBUTED", lowerMs: null, upperMs: null, confidence: "UNKNOWN", basis: "No reference", sampleCount: 0 },
      approach: { description: "Read history", rationale: "Completeness" }, phase: "planning",
    };
    for (let i = 0; i < 12; i++) await ok(c, "RecordAssessment", { ...payload, ...(i ? { reason: "Review " + i } : {}) }, i);
    await ok(c, "UpdateStep", { stepId: lease.stepId, changes: { expectedResult: "New requirement" }, reason: "Scope changed" }, stepVersion(c, lease.stepId));
    const before = rows(c), data = await report(c), step = data.plans[0].steps[0];
    assert.equal(step.attempts.length, 51);assert.equal(step.results.length, 51);assert.equal(step.checks.length, 105);
    assert.equal(step.results[0].summary, "Result 0");assert.equal(step.checks[0].evidenceSummary, "Check 0");
    assert.equal(step.assessments.length, 12);assert.deepEqual(step.assessments.map(a => a.revision), Array.from({ length: 12 }, (_, i) => i + 1));
    assert(step.assessments.every(a => a.needsRevision));assert.equal(step.assessments[11].assessment.reason, "Review 11");
    assert.equal(step.assessments[0].requirements.step.expectedResult, "Checked source");
    const events = data.plans[0].timeline;
    assert(events.length > 200);assert.equal(events.filter(e => e.eventType === "STEP_RESULT_RECORDED").length, 51);
    assert.deepEqual(new Set(events.filter(e => e.eventType === "STEP_RESULT_RECORDED").map(e => e.details.resultId)), new Set(step.results.map(r => r.resultId)));
    assert.deepEqual(rows(c), before);
  } finally { c.close(); }
});

test("summary unions parallel plans, excludes deleted plans and retains their frozen history", async () => {
  const c = context(), other = crypto.randomUUID();
  try {
    await running(c, []);c.advance(10000);
    await ok(c, "CreatePlan", { planId: other, title: "Parallel", planCreatedAt: { precision: "dateOnly", on: "2026-10-01", timeZone: "UTC" } });
    await ok(c, "StartPlan", { planId: other }, 0);c.advance(10000);
    let data = await report(c);
    assert.equal(data.summary.totalActiveMs, 20000);assert.equal(data.summary.sumPlanActiveMs, 30000);
    await ok(c, "DeletePlan", { planId: PLAN, reason: "Archive this work" }, 1);c.advance(10000);
    data = await report(c);
    const deleted = data.plans.find(p => p.planId === PLAN);
    assert.equal(deleted.activeMs, 20000);assert.equal(deleted.calendarMs, 20000);assert.equal(deleted.steps.length, 1);
    assert.equal(deleted.steps[0].activeMs, 20000);assert.equal(data.summary.deletedPlanCount, 1);
    assert.equal(data.summary.totalActiveMs, 20000);assert.equal(data.summary.sumPlanActiveMs, 20000);
    assert.equal(deleted.timeline.filter(e => e.eventType === "PLAN_DELETED").length, 1);
    await ok(c, "RestorePlan", { planId: PLAN }, 2);
    data = await report(c);
    assert.equal(data.summary.deletedPlanCount, 0);assert.equal(data.summary.totalActiveMs, 30000);assert.equal(data.summary.sumPlanActiveMs, 40000);
    assert.equal(data.plans.find(p => p.planId === PLAN).activeMs, 20000);
  } finally { c.close(); }
});

test("step time preserves overlap uncertainty, pauses, unstarted and expired attempts", async () => {
  const c = context();
  try {
    const first = await running(c, []);
    const second = await ok(c, "CreateStep", { planId: PLAN, ordinal: 1, title: "Overlap", expectedResult: "Checked", requiredChecks: [] });
    const unstarted = await ok(c, "CreateStep", { planId: PLAN, ordinal: 2, title: "Unstarted", expectedResult: "Later", requiredChecks: [] });
    await ok(c, "ClaimStepAttempt", { stepId: unstarted.stepId, sessionId: crypto.randomUUID(), sourceId: "fixture" }, 1);
    await claimStart(c, second.stepId);c.advance(10000);
    let plan = (await report(c)).plans[0];
    assert.equal(plan.steps[0].activeMs, null);assert.equal(plan.steps[0].ambiguousMs, 10000);
    assert.equal(plan.steps[2].activeMs, null);assert.equal(plan.steps[2].attempts[0].startedAt, null);
    assert.equal(plan.unattributedMs, 10000);assert.equal(plan.ambiguousMs, 10000);
    await ok(c, "BlockStep", { ...first, reason: "Dependency missing" }, 2);
    await ok(c, "PausePlan", { planId: PLAN }, 1);c.advance(10000);await ok(c, "ResumePlan", { planId: PLAN }, 2);
    c.advance(700000);
    plan = (await report(c)).plans[0];
    assert.equal(plan.activeMs, 710000);assert.equal(plan.steps[1].activeMs, 580000);
    assert.equal(plan.steps[1].ambiguousMs, 10000);assert.equal(plan.steps[1].attempts[0].executionState, "LEASE_EXPIRED");
    assert(plan.timeline.some(e => e.eventType === "STEP_BLOCKED" && e.details.reason === "Dependency missing"));
    assert.equal(plan.steps.reduce((n, s) => n + (s.activeMs ?? 0), 0) + plan.unattributedMs, plan.activeMs);
  } finally { c.close(); }
});

test("timeline drops only normal transport noise and retains meaningful observations and corrections", async () => {
  const c = context();
  try {
    const lease = await running(c, []);
    await ok(c, "RenewStepLease", lease);
    const sessionId = c.db.sqlite.prepare("SELECT session_id FROM step_attempts WHERE attempt_id=?").get(lease.attemptId).session_id;
    const heartbeat = crypto.randomUUID();
    const observe = (eventId, sourceSequence, eventType, data = {}, correctionOfEventId) => ok(c, "AppendObservation", {
      planId: PLAN, stepId: lease.stepId, attemptId: lease.attemptId, eventId, sessionId, sourceId: "fixture", sourceSequence,
      eventType, occurredAt: c.now(), data, ...(correctionOfEventId ? { correctionOfEventId } : {}),
    });
    await observe(heartbeat, 1, "heartbeat");
    await observe(crypto.randomUUID(), 2, "heartbeat");
    await observe(crypto.randomUUID(), 4, "tool_finished", { operationId: crypto.randomUUID(), toolName: "build", status: "FAILED", durationMs: 123 });
    await observe(crypto.randomUUID(), 5, "correction", { reason: "Clock corrected" }, heartbeat);
    const timeline = (await report(c)).plans[0].timeline;
    assert.equal(timeline.filter(e => e.eventType === "LEASE_RENEWED").length, 0);
    assert.equal(timeline.filter(e => e.eventType === "heartbeat").length, 1, "referenced heartbeat keeps correction link valid");
    assert(timeline.some(e => e.eventType === "tool_finished" && e.details.durationMs === 123 && e.classification === "GAP"));
    assert(timeline.some(e => e.correctionOfEventId === heartbeat && e.details.reason === "Clock corrected"));
  } finally { c.close(); }
});

test("export preserves finish exceptions, date precision, measured zero and owner isolation", async () => {
  const c = context(), other = "other-owner";
  try {
    const lease = await running(c, []);
    await ok(c, "FinishPlan", { planId: PLAN, allowIncomplete: true, reason: "Explicit incomplete handoff" }, 1);
    await command(c, "CreatePlan", { planId: PLAN, title: "Other owner's secret", planCreatedAt: { precision: "instant", value: "2026-10-01T00:00:00Z", timeZone: "UTC" } }, undefined, undefined, other);
    await command(c, "CreateStep", { planId: PLAN, ordinal: 0, title: "Secret step", expectedResult: "Secret", requiredChecks: [] }, undefined, undefined, other);
    const data = await report(c), plan = data.plans[0];
    assert.equal(data.plans.length, 1);assert(!JSON.stringify(data).includes("Secret"));
    assert.equal(plan.activeMs, 0);assert.equal(plan.steps[0].activeMs, 0);assert.equal(data.summary.totalActiveMs, 0);
    assert.equal(plan.finishExceptions[0].reason, "Explicit incomplete handoff");assert.equal(plan.finishExceptions[0].incompleteSteps[0].stepId, lease.stepId);
    assert.equal(plan.timeline.filter(e => e.eventType === "PLAN_FINISHED").length, 1);
    assert.deepEqual(plan.planCreatedAt, { precision: "dateOnly", on: "2026-10-01", timeZone: "UTC" });
    const foreign = (await call(c, "/api/export", undefined, other)).value.plans[0];
    assert.equal(foreign.activeMs, null);assert.equal(foreign.steps[0].activeMs, null);
    assert.deepEqual(foreign.planCreatedAt, { precision: "instant", value: "2026-10-01T00:00:00.000Z", timeZone: "UTC" });
  } finally { c.close(); }
});

test("export keeps historical result status while redacting revoked evidence", async () => {
  const c = context();
  try {
    const lease = await running(c);
    c.db.sqlite.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,updated_at) VALUES(?,'legacy','private/legacy',1,'main','available',1)").run(OWNER);
    c.db.sqlite.prepare("INSERT INTO plan_repositories(owner_id,plan_id,repository_id,selected_ref) VALUES(?,?,'legacy','main')").run(OWNER, PLAN);
    await internalCommand(c, "RecordStepResult", { ...lease, outcome: "DONE", summary: "Historical result", worktreeSnapshot: { kind: "WORKTREE_SNAPSHOT", formatVersion: 1, repositoryId: "legacy", digest: DIGEST_A, baseRevisionSha: "b".repeat(40) } }, 2);
    await internalCommand(c, "RecordCheck", { ...check(lease.stepId), evidenceUrl: "https://private.example/check" });
    assert(JSON.stringify(await report(c)).includes(DIGEST_A));
    c.db.sqlite.prepare("UPDATE repositories SET access_state='revoked'").run();
    const data = await report(c), step = data.plans[0].steps[0], serialized = JSON.stringify(data);
    assert.equal(step.results[0].outcome, "DONE");assert.equal(step.results[0].source.kind, "HISTORICAL");
    assert.equal(step.results[0].source.protectedDetailsHidden, true);assert.equal(step.checks[0].status, "PASSED");
    assert(!serialized.includes(DIGEST_A));assert(!serialized.includes("private.example"));assert(!serialized.includes("repositoryId"));
  } finally { c.close(); }
});

test("export uses one read snapshot and fails rather than returning a partial document", async () => {
  const c = context();
  try {
    await running(c);
    const original = c.db.prepare.bind(c.db);let reads = 0;
    c.db.prepare = sql => { reads++;assert(sql.startsWith("SELECT"));return original(sql); };
    await report(c);assert.equal(reads, 1);
    c.db.prepare = () => { throw new Error("Read unavailable"); };
    const response = await call(c, "/api/export");assert.equal(response.status, 500);assert.equal(response.value.plans, undefined);
    c.db.prepare = () => ({ bind: () => ({ all: async () => ({ success: false, results: [] }) }) });
    assert.equal((await call(c, "/api/export")).status, 500);
  } finally { c.close(); }
});

test("export is read only for a new owner and returns a versioned empty report", async () => {
  const c = context();
  try {
    const before = rows(c), response = await call(c, "/api/export");
    assert.equal(response.status, 200);assert.equal(response.value.formatVersion, 1);
    assert.deepEqual(response.value.plans, []);assert.deepEqual(rows(c), before);
    assert.equal((await call(c, "/api/export", undefined, null)).status, 401);
  } finally { c.close(); }
});
