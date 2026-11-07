import test from "node:test";
import assert from "node:assert/strict";
import {
  context, call, command, ok, mcp, running, result, check, rows,
  OWNER, DIGEST_A,
} from "./fixtures/tracker-db.mjs";

const TARGET = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const OTHER_SOURCE = "33333333-3333-4333-8333-333333333333";
const OTHER_OWNER = "estimation-mcp-other-owner";
const profile = Object.freeze({ workKind: "MODIFY_MECHANISM", reuseState: "PARTIAL", doneBoundary: "LOCAL_STAGED" });
const createdAt = { precision: "dateOnly", on: "2026-10-01", timeZone: "UTC" };

async function createPlan(c, planId, title = "Сопоставимый план", owner) {
  const response = await command(c, "CreatePlan", { planId, title, planCreatedAt: createdAt }, undefined, undefined, owner);
  assert.equal(response.status, 200, JSON.stringify(response.value));
}

async function requirementsDigest(c, planId, owner) {
  const response = await mcp(c, "GetAssessment", { planId }, owner);
  assert.equal(response.value.result.isError, undefined, JSON.stringify(response.value));
  return response.value.result.structuredContent.currentRequirementsDigest;
}

async function estimateArgs(c, candidateIds = []) {
  const targetDigest = await requirementsDigest(c, TARGET);
  const candidates = [];
  for (const planId of candidateIds) {
    candidates.push({
      planId,
      expectedRequirementsDigest: await requirementsDigest(c, planId),
      profile,
      decision: "INCLUDE",
      scopeStability: "STABLE",
      timeCoverage: "COMPLETE",
      rationale: "Результат и граница совпадают",
    });
  }
  return {
    methodVersion: 1,
    metric: "PLAN_ACTIVE",
    referenceCutoffMs: c.now(),
    target: { planId: TARGET, expectedRequirementsDigest: targetDigest, profile },
    candidates,
  };
}

async function ensureOwner(c) {
  const response = await mcp(c, "GetTrackerCapabilities");
  assert.equal(response.value.result.isError, undefined, JSON.stringify(response.value));
}

async function completedPlan(c, planId, { intervals, requiredChecks = ["unit"], recordResult = true, outcome = "DONE", checkStatus = "PASSED", toolDurationMs = 0 } = {}) {
  const lease = await running(c, requiredChecks, planId);
  const startedAtMs = c.db.sqlite.prepare("SELECT first_started_at FROM plans WHERE plan_id=?").get(planId).first_started_at;
  const intervalRows = typeof intervals === "function" ? intervals(startedAtMs) : intervals;
  if (toolDurationMs > 0) {
    const session = c.db.sqlite.prepare("SELECT s.session_id,s.source_id FROM step_attempts a JOIN tracker_sessions s ON s.owner_id=a.owner_id AND s.session_id=a.session_id WHERE a.attempt_id=?").get(lease.attemptId);
    const operationId = crypto.randomUUID();
    const observe = (eventType, sourceSequence, data) => ok(c, "AppendObservation", {
      eventId: crypto.randomUUID(), planId, stepId: lease.stepId, sourceId: session.source_id,
      sessionId: session.session_id, sourceSequence, occurredAt: c.now(), eventType, data,
    });
    await observe("tool_started", 1, { operationId, toolName: "fixture-tool" });
    c.advance(toolDurationMs);
    await observe("tool_finished", 2, { operationId, toolName: "fixture-tool", status: "OK", durationMs: toolDurationMs });
  }
  if (recordResult && outcome === "DONE") await result(c, lease, DIGEST_A);
  else if (recordResult) await ok(c, "RecordStepResult", { ...lease, outcome, summary: "Synthetic checked result" }, 2);
  if (recordResult && requiredChecks.length > 0 && checkStatus) await ok(c, "RecordCheck", check(lease.stepId, checkStatus));
  const requestedLastEnd = intervalRows?.length ? Math.max(...intervalRows.map(([, end]) => end)) : 0;
  const finishedAtMs = Math.max(c.now() + 1, requestedLastEnd);
  c.advance(finishedAtMs - c.now());
  const needsException = !recordResult || outcome !== "DONE" || (requiredChecks.length > 0 && checkStatus !== "PASSED");
  await ok(c, "FinishPlan", { planId, ...(needsException ? { allowIncomplete: true, reason: "Фикстура содержит неполный результат" } : {}) }, 1);
  if (intervalRows) {
    c.db.sqlite.prepare("DELETE FROM work_intervals WHERE owner_id=? AND plan_id=?").run(OWNER, planId);
    c.db.sqlite.exec("DROP TRIGGER work_intervals_no_overlap_insert; DROP TRIGGER work_intervals_no_overlap_close;");
    for (const [startMs, endMs] of intervalRows) {
      c.db.sqlite.prepare("INSERT INTO work_intervals(interval_id,owner_id,plan_id,start_ms,end_ms,opened_by,closed_by) VALUES(?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(), OWNER, planId, startMs, endMs, OWNER, OWNER);
    }
    c.db.sqlite.exec(`CREATE TRIGGER work_intervals_no_overlap_insert
      BEFORE INSERT ON work_intervals WHEN EXISTS (
        SELECT 1 FROM work_intervals old WHERE old.owner_id=NEW.owner_id AND old.plan_id=NEW.plan_id
          AND NEW.start_ms < COALESCE(old.end_ms, 9223372036854775807)
          AND COALESCE(NEW.end_ms, 9223372036854775807) > old.start_ms
      ) BEGIN SELECT RAISE(ABORT, 'WORK_INTERVAL_OVERLAP'); END;
      CREATE TRIGGER work_intervals_no_overlap_close
      BEFORE UPDATE OF end_ms ON work_intervals WHEN NEW.end_ms IS NOT NULL AND EXISTS (
        SELECT 1 FROM work_intervals old WHERE old.owner_id=NEW.owner_id AND old.plan_id=NEW.plan_id AND old.interval_id<>NEW.interval_id
          AND NEW.start_ms < COALESCE(old.end_ms, 9223372036854775807) AND NEW.end_ms > old.start_ms
      ) BEGIN SELECT RAISE(ABORT, 'WORK_INTERVAL_OVERLAP'); END;`);
  }
  return { startedAtMs, finishedAtMs };
}

test("CalculateEstimate is discovered as read-only and advertises its exact capability", async () => {
  const c = context();
  try {
    await ensureOwner(c);
    const listing = (await call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).value.result.tools;
    const tool = listing.find(item => item.name === "CalculateEstimate");
    assert.ok(tool, "CalculateEstimate is listed");
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.inputSchema.additionalProperties, false);
    const caps = (await mcp(c, "GetTrackerCapabilities")).value.result.structuredContent;
    assert.deepEqual(caps.assessments.calculator, {
      tool: "CalculateEstimate", formatVersion: 1,
      method: { id: "reference-class-median", version: "1" },
      metrics: ["PLAN_ACTIVE"], maxCandidates: 20, readOnly: true, accuracy: "NOT_VALIDATED",
    });
  } finally { c.close(); }
});

test("CalculateEstimate returns an authenticated, current, empty-class result through Worker MCP", async () => {
  const c = context();
  try {
    await ensureOwner(c);
    await createPlan(c, TARGET, "Целевая задача");
    const args = await estimateArgs(c);
    const response = await mcp(c, "CalculateEstimate", args);
    assert.equal(response.value.result.isError, undefined, JSON.stringify(response.value));
    const value = response.value.result.structuredContent;
    assert.equal(value.status, "INSUFFICIENT_DATA");
    assert.equal(value.pointMs, null);
    assert.deepEqual(value.includedPlanIds, []);
    assert.equal(value.inputSnapshot.sourceAuthority, "SERVER_PLAN_INTERVALS");
    assert.equal(value.readAtMs, c.now());
  } finally { c.close(); }
});

test("authorized complete intervals are unioned into PLAN_ACTIVE without adding attempts, tools or parallel plans", async () => {
  const c = context();
  try {
    await ensureOwner(c);
    await createPlan(c, TARGET, "Целевая задача");
    const minute = 60_000;
    await completedPlan(c, SOURCE, {
      toolDurationMs: 8 * minute,
      intervals: started => [[started, started + 10 * minute], [started + 5 * minute, started + 12 * minute], [started + 20 * minute, started + 25 * minute]],
    });
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM tracker_journal WHERE owner_id=? AND plan_id=? AND event_type='tool_finished' AND json_extract(payload_json,'$.data.durationMs')=?").get(OWNER, SOURCE, 8 * minute).count, 1);
    const parallel = await running(c, ["unit"], OTHER_SOURCE);
    const session = c.db.sqlite.prepare("SELECT s.session_id,s.source_id FROM step_attempts a JOIN tracker_sessions s ON s.owner_id=a.owner_id AND s.session_id=a.session_id WHERE a.attempt_id=?").get(parallel.attemptId);
    await ok(c, "AppendObservation", {
      eventId: crypto.randomUUID(), planId: OTHER_SOURCE, stepId: parallel.stepId, sourceId: session.source_id,
      sessionId: session.session_id, sourceSequence: 1, occurredAt: c.now(), eventType: "tool_finished",
      data: { operationId: crypto.randomUUID(), toolName: "fixture-tool", status: "OK", durationMs: 30 * minute },
    });
    c.advance(minute);
    const args = await estimateArgs(c, [SOURCE]);
    const response = await mcp(c, "CalculateEstimate", args);
    assert.equal(response.value.result.isError, undefined, JSON.stringify(response.value));
    const value = response.value.result.structuredContent;
    assert.equal(value.status, "AVAILABLE");
    assert.equal(value.pointMs, 17 * minute);
    assert.equal(value.sampleCount, 1);
    assert.equal(value.inputSnapshot.candidates[0].activeMs, 17 * minute);
    assert.equal(value.inputSnapshot.candidates[0].intervalCount, 3);
    assert.equal(value.inputSnapshot.candidates[0].measurement, "COMPLETE");
    assert.equal(value.inputSnapshot.candidates[0].checksConfirmed, true);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM step_attempts WHERE owner_id=? AND step_id IN (SELECT step_id FROM plan_steps WHERE plan_id=?)").get(OWNER, SOURCE).count, 1);
    assert.ok(parallel.attemptId);
  } finally { c.close(); }
});

test("candidate permutations yield the same normalized snapshot and calculation digest", async () => {
  const c = context();
  try {
    await ensureOwner(c);
    await createPlan(c, TARGET, "Целевая задача");
    await completedPlan(c, SOURCE);
    await completedPlan(c, OTHER_SOURCE);
    c.advance(100);
    const firstArgs = await estimateArgs(c, [SOURCE, OTHER_SOURCE]);
    const secondArgs = { ...firstArgs, candidates: firstArgs.candidates.slice().reverse() };
    const first = (await mcp(c, "CalculateEstimate", firstArgs)).value.result.structuredContent;
    const uppercaseArgs = structuredClone(firstArgs);
    uppercaseArgs.target.planId = uppercaseArgs.target.planId.toUpperCase();
    uppercaseArgs.candidates[0].planId = uppercaseArgs.candidates[0].planId.toUpperCase();
    const normalized = (await mcp(c, "CalculateEstimate", uppercaseArgs)).value.result.structuredContent;
    assert.deepEqual(normalized.inputSnapshot, first.inputSnapshot);
    c.advance(1);
    const second = (await mcp(c, "CalculateEstimate", secondArgs)).value.result.structuredContent;
    assert.equal(first.calculationDigest, second.calculationDigest);
    assert.deepEqual(first.inputSnapshot, second.inputSnapshot);
    assert.notEqual(first.readAtMs, second.readAtMs);
    assert.match(first.calculationDigest, /^sha256:[a-f0-9]{64}$/);
  } finally { c.close(); }
});

test("result digest excludes readAtMs and includes newly read interval facts", async () => {
  const c = context();
  try {
    await ensureOwner(c);
    await createPlan(c, TARGET, "Целевая задача");
    await completedPlan(c, SOURCE);
    c.advance(100);
    const args = await estimateArgs(c, [SOURCE]);
    const before = (await mcp(c, "CalculateEstimate", args)).value.result.structuredContent;
    c.advance(1);
    const reread = (await mcp(c, "CalculateEstimate", args)).value.result.structuredContent;
    assert.equal(before.calculationDigest, reread.calculationDigest);
    assert.notEqual(before.readAtMs, reread.readAtMs);
    const row = c.db.sqlite.prepare("SELECT interval_id,start_ms,end_ms FROM work_intervals WHERE owner_id=? AND plan_id=?").get(OWNER, SOURCE);
    c.advance(1000);
    c.db.sqlite.prepare("UPDATE work_intervals SET end_ms=? WHERE interval_id=?").run(row.end_ms + 1000, row.interval_id);
    c.db.sqlite.prepare("UPDATE plans SET finished_at=? WHERE owner_id=? AND plan_id=?").run(row.end_ms + 1000, OWNER, SOURCE);
    args.referenceCutoffMs = c.now();
    const changed = (await mcp(c, "CalculateEstimate", args)).value.result.structuredContent;
    assert.notEqual(changed.calculationDigest, before.calculationDigest);
    assert.notEqual(changed.inputSnapshot.candidates[0].intervalsDigest, before.inputSnapshot.candidates[0].intervalsDigest);
    assert.equal(changed.pointMs, before.pointMs + 1000);
  } finally { c.close(); }
});

test("anonymous requests and foreign or missing target/source IDs fail without revealing ownership", async () => {
  const c = context();
  try {
    await ensureOwner(c);
    await createPlan(c, TARGET, "Целевая задача");
    await createPlan(c, SOURCE, "Чужой план", OTHER_OWNER);
    const ownArgs = await estimateArgs(c);
    const anonymous = await mcp(c, "CalculateEstimate", ownArgs, "");
    assert.equal(anonymous.status, 401);

    const foreignDigest = await requirementsDigest(c, SOURCE, OTHER_OWNER);
    const foreignSourceArgs = structuredClone(ownArgs);
    foreignSourceArgs.candidates = [{
      planId: SOURCE,
      expectedRequirementsDigest: foreignDigest,
      profile,
      decision: "EXCLUDE",
      scopeStability: "UNKNOWN",
      timeCoverage: "UNKNOWN",
      rationale: "Проверка границы доступа",
    }];
    const foreignSource = (await mcp(c, "CalculateEstimate", foreignSourceArgs)).value.result.structuredContent;
    const missingSourceArgs = structuredClone(foreignSourceArgs);
    missingSourceArgs.candidates[0].planId = OTHER_SOURCE;
    const missingSource = (await mcp(c, "CalculateEstimate", missingSourceArgs)).value.result.structuredContent;
    assert.deepEqual([foreignSource.code, foreignSource.message], [missingSource.code, missingSource.message]);
    assert.equal(foreignSource.code, "PLAN_NOT_FOUND");

    const foreignTargetArgs = structuredClone(ownArgs);
    foreignTargetArgs.target = { ...foreignTargetArgs.target, planId: SOURCE, expectedRequirementsDigest: foreignDigest };
    const foreignTarget = (await mcp(c, "CalculateEstimate", foreignTargetArgs)).value.result.structuredContent;
    const missingTargetArgs = structuredClone(foreignTargetArgs);
    missingTargetArgs.target.planId = OTHER_SOURCE;
    const missingTarget = (await mcp(c, "CalculateEstimate", missingTargetArgs)).value.result.structuredContent;
    assert.deepEqual([foreignTarget.code, foreignTarget.message], [missingTarget.code, missingTarget.message]);
    assert.equal(foreignTarget.code, "PLAN_NOT_FOUND");
  } finally { c.close(); }
});

test("deleted candidates are redacted and deleted targets are rejected", async () => {
  const c = context();
  try {
    await ensureOwner(c);
    await createPlan(c, TARGET, "Целевая задача");
    await completedPlan(c, SOURCE);
    const args = await estimateArgs(c, [SOURCE]);
    await ok(c, "DeletePlan", { planId: SOURCE }, 2);
    const candidate = (await mcp(c, "CalculateEstimate", args)).value.result.structuredContent;
    assert.deepEqual(candidate.inputSnapshot.candidates, [{ planId: SOURCE, deleted: true }]);
    assert.deepEqual(candidate.excluded, [{ planId: SOURCE, reasons: ["DELETED_SOURCE"] }]);
    assert.equal(JSON.stringify(candidate).includes("Source evidence"), false);

    await ok(c, "DeletePlan", { planId: TARGET }, 0);
    const target = (await mcp(c, "CalculateEstimate", args)).value.result.structuredContent;
    assert.equal(target.code, "PLAN_DELETED");
  } finally { c.close(); }
});

test("target and current source requirements digests are checked without silent refresh", async () => {
  for (const staleTarget of [false, true]) {
    const c = context();
    try {
      await ensureOwner(c);
      await createPlan(c, TARGET, "Целевая задача");
      await createPlan(c, SOURCE, "Сопоставимый источник");
      const args = await estimateArgs(c, [SOURCE]);
      const planId = staleTarget ? TARGET : SOURCE;
      await ok(c, "UpdatePlanMetadata", { planId, title: "Изменённый результат", reason: "Изменились требования" }, 0);
      const response = await mcp(c, "CalculateEstimate", args);
      assert.equal(response.value.result.structuredContent.code, "ASSESSMENT_CONTEXT_CHANGED");
    } finally { c.close(); }
  }
});

test("agent scope decisions, measurement state, checks and strict cutoff remain separate exclusions", async () => {
  const c = context();
  try {
    await ensureOwner(c);
    await createPlan(c, TARGET, "Целевая задача");
    const unmeasured = "44444444-4444-4444-8444-444444444444";
    const unchecked = "55555555-5555-4555-8555-555555555555";
    const open = "66666666-6666-4666-8666-666666666666";
    const zero = "77777777-7777-4777-8777-777777777777";
    const failed = "88888888-8888-4888-8888-888888888888";
    await completedPlan(c, SOURCE);
    await completedPlan(c, unmeasured);
    c.db.sqlite.prepare("DELETE FROM work_intervals WHERE owner_id=? AND plan_id=?").run(OWNER, unmeasured);
    await completedPlan(c, unchecked, { requiredChecks: ["unit"], checkStatus: null });
    await running(c, ["unit"], open);
    await completedPlan(c, zero, { intervals: started => [[started, started]] });
    await completedPlan(c, failed, { requiredChecks: [], outcome: "FAILED" });
    c.advance(1);

    const args = await estimateArgs(c, [SOURCE, unmeasured, unchecked, open, zero, failed]);
    args.candidates.find(item => item.planId === SOURCE).scopeStability = "CHANGED";
    args.candidates.find(item => item.planId === unmeasured).decision = "DESCRIPTIVE";
    const response = await mcp(c, "CalculateEstimate", args);
    assert.equal(response.value.result.isError, undefined, JSON.stringify(response.value));
    const byId = Object.fromEntries(response.value.result.structuredContent.excluded.map(item => [item.planId, item.reasons]));
    assert.deepEqual(byId[SOURCE], ["SCOPE_CHANGED"]);
    assert.ok(byId[unmeasured].includes("DESCRIPTIVE_ONLY"));
    assert.ok(byId[unmeasured].includes("NO_MEASUREMENT"));
    assert.ok(byId[unchecked].includes("CHECKS_UNCONFIRMED"));
    assert.ok(byId[failed].includes("CHECKS_UNCONFIRMED"));
    assert.ok(byId[open].includes("NOT_COMPLETED"));
    assert.equal(response.value.result.structuredContent.inputSnapshot.candidates.find(item => item.planId === zero).activeMs, 0);

    const cutoffArgs = await estimateArgs(c, [SOURCE]);
    const sourceAt = c.db.sqlite.prepare(`SELECT MAX(value) AS availableAt FROM (
      SELECT registered_at AS value FROM plans WHERE owner_id=? AND plan_id=?
      UNION ALL SELECT server_occurred_at FROM plan_events WHERE owner_id=? AND plan_id=?
      UNION ALL SELECT created_at FROM plan_steps WHERE owner_id=? AND plan_id=?
      UNION ALL SELECT updated_at FROM plan_steps WHERE owner_id=? AND plan_id=?
      UNION ALL SELECT created_at FROM step_results WHERE owner_id=? AND step_id IN (SELECT step_id FROM plan_steps WHERE owner_id=? AND plan_id=?)
      UNION ALL SELECT created_at FROM tracker_check_evidence WHERE owner_id=? AND step_id IN (SELECT step_id FROM plan_steps WHERE owner_id=? AND plan_id=?)
      UNION ALL SELECT finished_at FROM plans WHERE owner_id=? AND plan_id=?
    )`).get(OWNER, SOURCE, OWNER, SOURCE, OWNER, SOURCE, OWNER, SOURCE, OWNER, OWNER, SOURCE, OWNER, OWNER, SOURCE, OWNER, SOURCE).availableAt;
    cutoffArgs.referenceCutoffMs = sourceAt;
    const cutoff = (await mcp(c, "CalculateEstimate", cutoffArgs)).value.result.structuredContent;
    assert.ok(cutoff.excluded[0].reasons.includes("AFTER_CUTOFF"));
  } finally { c.close(); }
});

test("completed sources with open, future or negative interval timestamps fail as invalid source data", async () => {
  for (const mode of ["open", "future", "negative"]) {
    const c = context();
    try {
      await ensureOwner(c);
      await createPlan(c, TARGET, "Целевая задача");
      await completedPlan(c, SOURCE);
      const args = await estimateArgs(c, [SOURCE]);
      const interval = c.db.sqlite.prepare("SELECT interval_id,start_ms,end_ms FROM work_intervals WHERE owner_id=? AND plan_id=?").get(OWNER, SOURCE);
      if (mode === "open") {
        c.db.sqlite.prepare("DELETE FROM work_intervals WHERE interval_id=?").run(interval.interval_id);
        c.db.sqlite.prepare("INSERT INTO work_intervals(interval_id,owner_id,plan_id,start_ms,end_ms,opened_by) VALUES(?,?,?,?,NULL,?)")
          .run(crypto.randomUUID(), OWNER, SOURCE, interval.start_ms, OWNER);
      } else if (mode === "future") {
        c.db.sqlite.prepare("UPDATE work_intervals SET end_ms=? WHERE interval_id=?").run(c.now() + 1000, interval.interval_id);
      } else {
        c.db.sqlite.prepare("UPDATE work_intervals SET start_ms=-1 WHERE interval_id=?").run(interval.interval_id);
      }
      const response = await mcp(c, "CalculateEstimate", args);
      assert.equal(response.value.result.structuredContent.code, "INVALID_ESTIMATION_SOURCE", mode);
    } finally { c.close(); }
  }
});

test("malformed, duplicated, target-leaking, over-limit and client-authored source fields are rejected", async () => {
  const c = context();
  try {
    await ensureOwner(c);
    await createPlan(c, TARGET, "Целевая задача");
    await createPlan(c, SOURCE, "Сопоставимый источник");
    const args = await estimateArgs(c, [SOURCE]);
    const invalid = [
      { ...args, methodVersion: 2 },
      { ...args, metric: "ATTEMPT" },
      { ...args, ownerId: OWNER },
      { ...args, nowMs: c.now() },
      { ...args, sourceAuthority: "EXTERNAL_FIXTURE" },
      { ...args, target: { ...args.target, stepId: crypto.randomUUID() } },
      { ...args, referenceCutoffMs: c.now() + 1 },
      { ...args, candidates: [...args.candidates, { ...args.candidates[0], planId: args.candidates[0].planId.toUpperCase() }] },
      { ...args, candidates: [{ ...args.candidates[0], planId: TARGET.toUpperCase() }] },
      { ...args, candidates: [{ ...args.candidates[0], durationMs: 1 }] },
      { ...args, candidates: [{ ...args.candidates[0], status: "COMPLETED" }] },
      { ...args, candidates: [{ ...args.candidates[0], profile: { ...profile, extra: "UNTRUSTED" } }] },
      { ...args, candidates: [{ ...args.candidates[0], rationale: "я".repeat(129) }] },
      { ...args, candidates: Array.from({ length: 21 }, (_, i) => ({ ...args.candidates[0], planId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}` })) },
    ];
    for (const input of invalid) {
      const response = await mcp(c, "CalculateEstimate", input);
      assert.equal(response.value.result.structuredContent.code, "VALIDATION_ERROR", JSON.stringify(input).slice(0, 300));
    }
    const unicodeRationale = structuredClone(args);
    unicodeRationale.candidates[0].rationale = "😀".repeat(128);
    const acceptedUnicode = await mcp(c, "CalculateEstimate", unicodeRationale);
    assert.equal(acceptedUnicode.value.result.isError, undefined, JSON.stringify(acceptedUnicode.value));
  } finally { c.close(); }
});

test("one parameterized fact snapshot is used; SQL errors fail closed and reads do not mutate subject tables", async () => {
  const c = context();
  try {
    await ensureOwner(c);
    await createPlan(c, TARGET, "Целевая задача");
    await completedPlan(c, SOURCE);
    c.advance(1);
    const args = await estimateArgs(c, [SOURCE]);
    const before = rows(c);
    const originalPrepare = c.db.prepare.bind(c.db);
    const snapshotQueries = [];
    c.db.prepare = sql => {
      if (/assessment_targets/.test(sql) && /work_intervals/.test(sql)) snapshotQueries.push(sql);
      return originalPrepare(sql);
    };
    const response = await mcp(c, "CalculateEstimate", args);
    c.db.prepare = originalPrepare;
    assert.equal(response.value.result.isError, undefined, JSON.stringify(response.value));
    assert.equal(snapshotQueries.length, 1);
    assert.equal(snapshotQueries[0].includes(SOURCE), false, "plan IDs are bound parameters");
    assert.deepEqual(rows(c), before);

    c.db.prepare = sql => {
      if (/assessment_targets/.test(sql) && /work_intervals/.test(sql)) throw new Error("injected read failure");
      return originalPrepare(sql);
    };
    const failed = await mcp(c, "CalculateEstimate", args);
    c.db.prepare = originalPrepare;
    assert.equal(failed.value.result.isError, true);
    assert.equal(failed.value.result.structuredContent.code, "INTERNAL_ERROR");
    assert.deepEqual(rows(c), before);
  } finally { c.close(); }
});

test("assessment roundtrip stores the calculation in a 24 KB, depth-10 Cyrillic context and retains digest conflict", async () => {
  const c = context();
  try {
    await ensureOwner(c);
    await createPlan(c, TARGET, "Целевая задача");
    await completedPlan(c, SOURCE);
    c.advance(1);
    const args = await estimateArgs(c, [SOURCE]);
    const calculated = (await mcp(c, "CalculateEstimate", args)).value.result.structuredContent;
    const contextValue = { expectedResult: "Результат сохраняется", scope: "Целый план", checks: ["unit"], estimation: calculated };
    let nested = contextValue;
    for (let index = 0; index < 9; index += 1) nested = nested.child = {};
    const payload = {
      assessmentId: crypto.randomUUID(), planId: TARGET, expectedRequirementsDigest: args.target.expectedRequirementsDigest,
      context: contextValue,
      method: { id: "reference-class-median", version: "1", scale: { unit: "ms", estimand: "ACCEPTED_UNCHANGED_SCOPE" } },
      complexity: { status: "KNOWN", value: 5, rationale: "Сопоставимый измеренный источник" },
      unknowns: [], assumptions: ["Текущие требования не менялись"], dependencies: [],
      forecast: { status: "KNOWN", metric: "PLAN_ACTIVE", lowerMs: calculated.pointMs, upperMs: calculated.pointMs, confidence: "LOW", basis: "CalculateEstimate", sampleCount: calculated.sampleCount },
      sources: calculated.includedPlanIds.map(planId => ({ planId })),
      approach: { description: "Зафиксировать неизменяемую оценку", rationale: "Сохранить расчётный снимок" }, phase: "planning",
    };
    const baseBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    let remainingChars = Math.floor((23_500 - baseBytes) / 2);
    let detailIndex = 0;
    while (remainingChars > 0) {
      const chunkLength = Math.min(3_900, remainingChars);
      payload.context[`details${detailIndex}`] = "я".repeat(chunkLength);
      remainingChars -= chunkLength;
      detailIndex += 1;
    }
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    assert.ok(payloadBytes >= 23_000 && payloadBytes <= 24_000, `payload bytes: ${payloadBytes}`);
    const recorded = await ok(c, "RecordAssessment", payload, 0);
    assert.equal(recorded.revision, 1);
    const read = await mcp(c, "GetAssessment", { planId: TARGET, assessmentId: payload.assessmentId });
    assert.deepEqual(read.value.result.structuredContent.assessment.context.estimation, calculated);
    assert.equal(read.value.result.structuredContent.needsRevision, false);

    const tooDeep = structuredClone(payload);
    let cursor = tooDeep.context;
    for (let index = 0; index < 10; index += 1) cursor = cursor.child = {};
    tooDeep.assessmentId = crypto.randomUUID();
    const rejected = await command(c, "RecordAssessment", tooDeep, 0);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.value.error.code, "VALIDATION_ERROR");

    await ok(c, "UpdatePlanMetadata", { planId: TARGET, title: "Изменённые требования", reason: "Изменена граница" }, 0);
    const stale = await mcp(c, "GetAssessment", { planId: TARGET, assessmentId: payload.assessmentId });
    assert.equal(stale.value.result.structuredContent.needsRevision, true);
    const conflict = await command(c, "RecordAssessment", { ...payload, reason: "Устаревший контекст" }, 1);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.value.error.code, "ASSESSMENT_CONTEXT_CHANGED");
    assert.equal((await mcp(c, "GetAssessment", { planId: TARGET, assessmentId: payload.assessmentId })).value.result.structuredContent.revisionCount, 1);
  } finally { c.close(); }
});
