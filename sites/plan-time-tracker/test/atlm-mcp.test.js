import test from "node:test";
import assert from "node:assert/strict";
import { readAtlmSampleSource } from "../worker/index.js";
import { context, call, command, ok, mcp, rows, atlmTask, atlmAssessment, plannedAtlm, completeAtlm, envelope, OWNER, PLAN } from "./fixtures/tracker-db.mjs";
const request = { method: "ATLM", methodVersion: 1 };
const value = r => { assert.equal(r.value.result.isError, undefined, JSON.stringify(r.value)); return r.value.result.structuredContent; };
async function argsFor(c, planId = PLAN, agentTask = atlmTask()) {
  return { planId, expectedRequirementsDigest: value(await mcp(c, "GetTaskAssessment", { planId })).currentRequirementsDigest, agentTask };
}
async function process(c) { return value(await mcp(c, "ContinueTraining")); }
async function train(c) {
  const plans = [];
  for (let i = 0; i < 15; i++) {
    const p = await plannedAtlm(c, crypto.randomUUID()); await completeAtlm(c, p); c.advance(1); plans.push(p);
  }
  let status = await process(c);
  for (let i = 0; i < 4 && status.training.due; i++) status = await process(c);
  assert.equal(status.activeModel?.sampleCount, 15, JSON.stringify(status));
  return { plans, status };
}
function beforePredictionWrite(c, effect) {
  const prepare = c.db.prepare; let used = false;
  c.db.prepare = function(sql) {
    const statement = prepare.call(this, sql), bind = statement.bind.bind(statement);
    statement.bind = (...args) => {
      const bound = bind(...args);
      if (!used && sql.startsWith("INSERT OR IGNORE INTO command_receipts") && args[3] === "RecordAssessment"
        && JSON.parse(args[9]).predictionRequest) {
        const run = bound.run.bind(bound);
        bound.run = async () => { used = true; await effect(); return run(); };
      }
      return bound;
    };
    return statement;
  };
  return () => { c.db.prepare = prepare; };
}

test("all ATLM tools share strict discovery/runtime schemas and declare read-only or idempotent mutation", async () => {
  const c = context();
  try {
    const listing = (await call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).value.result.tools;
    for (const name of ["EstimatePlanTime", "GetSavedEstimate", "GetTrainingStatus", "ContinueTraining", "GetTrainingData"]) {
      const tool = listing.find(t => t.name === name); assert.ok(tool);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.annotations.readOnlyHint, name !== "ContinueTraining"); assert.equal(tool.annotations.idempotentHint, true);
      const bad = await mcp(c, name, { actualMs: 10 }); assert.equal(bad.value.result.structuredContent.code, "VALIDATION_ERROR");
      assert.equal((await mcp(c, name, null)).value.result.structuredContent.code, "VALIDATION_ERROR");
    }
    const schema = listing.find(t => t.name === "SaveTaskAssessment").inputSchema.properties.payload;
    assert.deepEqual(schema.properties.predictionRequest.properties.method.enum, ["ATLM"]); assert.equal(schema.properties.serverEstimation, undefined);
    const atlm = value(await mcp(c, "GetTrackerInfo")).assessments.atlm;
    assert.equal(atlm.featureSchemaVersion, "agent-task-v2"); assert.equal(atlm.inputSchemaVersion,"agent-task-v1"); assert.equal(atlm.metric, "PLAN_ACTIVE");
    assert.equal(atlm.predictionScope, "FULL_FROM_FIRST_START"); assert.equal(atlm.retrainEveryNewPlans, 2);
    assert.equal(atlm.limits.datasetMaxLimit, 100);
  } finally { c.close(); }
});

test("cold and incomplete previews are read-only across MCP/HTTP; forecasts are unavailable after Start", async () => {
  const c = context();
  try {
    await plannedAtlm(c); const args = await argsFor(c), before = rows(c);
    const preview = value(await mcp(c, "EstimatePlanTime", args));
    assert.equal(preview.unavailableReason, "COLLECTING_DATA"); assert.equal(preview.pointMs, null);
    assert.deepEqual((await call(c, "/api/tracker/atlm-estimate", args)).value, preview);
    value(await mcp(c, "GetTrainingStatus")); value(await mcp(c, "GetTrainingData")); value(await mcp(c, "GetSavedEstimate", { planId: PLAN }));
    assert.deepEqual(rows(c), before);
    const unknown = atlmTask(); unknown.outcomes = null; unknown.profile.reuseState = "UNKNOWN";
    const missing = value(await mcp(c, "EstimatePlanTime", await argsFor(c, PLAN, unknown)));
    assert.equal(missing.unavailableReason, "INCOMPLETE_FEATURES"); assert.deepEqual(missing.missingFields, ["profile.reuseState", "outcomes"]);
    await ok(c, "StartPlan", { planId: PLAN }, 0);
    assert.equal(value(await mcp(c, "EstimatePlanTime", args)).unavailableReason, "UNSUPPORTED_FORECAST_SCOPE");
    assert.equal((await command(c, "RecordAssessment", await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request }), 0)).value.error.code, "ATLM_FORECAST_SCOPE_CHANGED");
    await ok(c, "RecordAssessment", await atlmAssessment(c), 0);
    assert.equal(value(await mcp(c, "GetSavedEstimate", { planId: PLAN })).serverEstimation, null);
  } finally { c.close(); }
});

test("server-owned UNAVAILABLE assessment persists unchanged across replay and first Start", async () => {
  const c = context();
  try {
    await plannedAtlm(c);
    const payload = await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request }), id = crypto.randomUUID();
    const first = await command(c, "RecordAssessment", payload, 0, id); assert.equal(first.status, 200);
    const saved = value(await mcp(c, "GetTaskAssessment", { planId: PLAN, assessmentId: payload.assessmentId }));
    assert.equal(saved.assessment.serverEstimation.status, "UNAVAILABLE"); assert.equal(saved.assessment.forecast.lowerMs, null);
    const forged = { ...payload, assessmentId: crypto.randomUUID(), serverEstimation: { status: "AVAILABLE", pointMs: 1 } };
    assert.equal((await command(c, "RecordAssessment", forged, 0)).value.error.code, "VALIDATION_ERROR");
    const badStep = { ...payload, assessmentId: crypto.randomUUID(), stepId: crypto.randomUUID() };
    assert.equal((await command(c, "RecordAssessment", badStep, 0)).value.error.code, "VALIDATION_ERROR");
    await ok(c, "StartPlan", { planId: PLAN }, 0);
    const repeated = await command(c, "RecordAssessment", payload, 0, id); assert.equal(repeated.status, 200); assert.equal(repeated.value.replayed, true);
    const get = value(await mcp(c, "GetSavedEstimate", { planId: PLAN }));
    assert.equal(get.source, "FROZEN_INPUT"); assert.deepEqual(get.serverEstimation, saved.assessment.serverEstimation);
    assert.deepEqual((await call(c, `/api/tracker/plans/${PLAN}/estimate`)).value, get);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM assessment_revisions WHERE assessment_id=?").get(payload.assessmentId).n, 1);
  } finally { c.close(); }
});

test("first Start racing inference rejects the new assessment atomically with a durable replayable receipt", async () => {
  const c = context(); let restore;
  try {
    await plannedAtlm(c); const payload = await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request }), id = crypto.randomUUID();
    restore = beforePredictionWrite(c, () => ok(c, "StartPlan", { planId: PLAN }, 0));
    const response = await command(c, "RecordAssessment", payload, 0, id);
    assert.equal(response.status, 409); assert.equal(response.value.error.code, "ATLM_FORECAST_SCOPE_CHANGED");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM assessment_revisions WHERE assessment_id=?").get(payload.assessmentId).n, 0);
    const receipt = value(await mcp(c, "GetCommandResult", { commandId: id })); assert.equal(receipt.status, "FINAL");
    assert.equal((await command(c, "RecordAssessment", payload, 0, id)).value.error.code, "ATLM_FORECAST_SCOPE_CHANGED");
    assert.equal(value(await mcp(c, "GetSavedEstimate", { planId: PLAN })).serverEstimation, null);
  } finally { restore?.(); c.close(); }
});

test("the 24000-byte assessment limit also applies after adding the server forecast", async () => {
  const c = context();
  try {
    await plannedAtlm(c);
    const payload = await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request });
    payload.context.padding = [...Array.from({ length: 5 }, () => "x".repeat(4000)), ""];
    const size = value => new TextEncoder().encode(JSON.stringify(value)).length;
    payload.context.padding[5] = "x".repeat(23950 - size(payload));
    assert.equal(size(payload), 23950);
    assert.equal((await command(c, "RecordAssessment", payload, 0)).status, 400);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM assessment_revisions WHERE assessment_id=?").get(payload.assessmentId).n, 0);
    payload.context.padding.pop(); await ok(c, "RecordAssessment", payload, 0);
    assert.ok(new TextEncoder().encode(c.db.sqlite.prepare("SELECT assessment_json FROM assessment_revisions WHERE assessment_id=?").get(payload.assessmentId).assessment_json).length <= 24000);
  } finally { c.close(); }
});

test("prediction write domain errors are durable receipts across context changes and restoration", async () => {
  const c = context();
  try {
    await plannedAtlm(c);
    const stale = await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request }), staleId = crypto.randomUUID();
    await ok(c, "UpdatePlanMetadata", { planId: PLAN, title: "Changed requirements" }, 0);
    assert.equal((await command(c, "RecordAssessment", stale, 0, staleId)).value.error.code, "ASSESSMENT_CONTEXT_CHANGED");
    assert.equal(value(await mcp(c, "GetCommandResult", { commandId: staleId })).status, "FINAL");
    await ok(c, "UpdatePlanMetadata", { planId: PLAN, title: "ATLM synthetic feature" }, 1);
    assert.equal((await command(c, "RecordAssessment", stale, 0, staleId)).value.error.code, "ASSESSMENT_CONTEXT_CHANGED");
    const deleted = await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request }), deletedId = crypto.randomUUID();
    await ok(c, "DeletePlan", { planId: PLAN }, 2);
    assert.equal((await command(c, "RecordAssessment", deleted, 0, deletedId)).value.error.code, "PLAN_DELETED");
    await ok(c, "RestorePlan", { planId: PLAN }, 3);
    assert.equal((await command(c, "RecordAssessment", deleted, 0, deletedId)).value.error.code, "PLAN_DELETED");
    await ok(c, "StartPlan", { planId: PLAN }, 4);
    const afterStart = await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request }), startId = crypto.randomUUID();
    assert.equal((await command(c, "RecordAssessment", afterStart, 0, startId)).value.error.code, "ATLM_FORECAST_SCOPE_CHANGED");
    assert.equal(value(await mcp(c, "GetCommandResult", { commandId: startId })).status, "FINAL");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM assessment_revisions").get().n, 1);
  } finally { c.close(); }
});

test("a trained forecast stays frozen, yields prospective error, and becomes stale when its source changes", async () => {
  const c = context();
  try {
    const trained = await train(c), p = await plannedAtlm(c);
    const payload = await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request });
    await ok(c, "RecordAssessment", payload, 0);
    const before = value(await mcp(c, "GetSavedEstimate", { planId: PLAN }));
    assert.equal(before.serverEstimation.status, "AVAILABLE"); assert.equal(before.serverEstimation.pointMs, 1000);
    assert.equal(before.serverEstimation.accuracy, "HISTORICALLY_EVALUATED"); assert.ok(before.serverEstimation.evaluation.caseCount >= 5);
    assert.equal(before.serverEstimation.interval, null); assert.equal(before.serverEstimation.confidence, "UNKNOWN");
    await completeAtlm(c, p, 1200); await ok(c, "RecordAssessment", await atlmAssessment(c), 0);
    const frozen = value(await mcp(c, "GetSavedEstimate", { planId: PLAN }));
    assert.equal(frozen.assessmentId, payload.assessmentId); assert.deepEqual(frozen.serverEstimation, before.serverEstimation);
    const source = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
    assert.deepEqual(source.issuedPrediction, { modelId: before.serverEstimation.modelId, pointMs: 1000, actualMs: 1200, errorMs: -200 });
    await ok(c, "UpdatePlanMetadata", { planId: PLAN, title: "Temporary scope change" }, 2);
    await ok(c, "UpdatePlanMetadata", { planId: PLAN, title: "ATLM synthetic feature" }, 3);
    assert.ok(value(await mcp(c, "GetSavedEstimate", { planId: PLAN })).staleReasons.includes("SCOPE_CHANGED"));
    await ok(c, "DeletePlan", { planId: trained.plans[0].planId }, 2);
    const stale = value(await mcp(c, "GetSavedEstimate", { planId: PLAN })); assert.equal(stale.isStale, true); assert.ok(stale.staleReasons.includes("MODEL_INVALIDATED"));
    assert.deepEqual(stale.serverEstimation, frozen.serverEstimation);
  } finally { c.close(); }
});

test("model invalidation racing save cannot commit a fresh prediction from the stale artifact", async () => {
  const c = context(); let restore;
  try {
    const trained = await train(c); await plannedAtlm(c);
    const payload = await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request });
    restore = beforePredictionWrite(c, () => ok(c, "DeletePlan", { planId: trained.plans[0].planId }, 2));
    const response = await command(c, "RecordAssessment", payload, 0); assert.equal(response.status, 409);
    assert.equal(response.value.error.code, "ATLM_MODEL_CHANGED");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM assessment_revisions WHERE assessment_id=?").get(payload.assessmentId).n, 0);
    const preview = value(await mcp(c, "EstimatePlanTime", await argsFor(c))); assert.equal(preview.unavailableReason, "MODEL_INVALIDATED");
    await ok(c, "RecordAssessment", await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request }), 0);
    assert.equal(value(await mcp(c, "GetSavedEstimate", { planId: PLAN })).serverEstimation.unavailableReason, "MODEL_INVALIDATED");
  } finally { restore?.(); c.close(); }
});

test("dataset pagination is owner-scoped, frozen by revision, and exports immutable facts without tool logs", async () => {
  const c = context();
  try {
    const plans = [];
    for (let i = 0; i < 3; i++) { const p = await plannedAtlm(c, crypto.randomUUID()); await completeAtlm(c, p); plans.push(p); }
    await process(c);
    const first = value(await mcp(c, "GetTrainingData", { limit: 1 })); assert.equal(first.rows.length, 1); assert.equal(first.hasMore, true);
    const next = value(await mcp(c, "GetTrainingData", { limit: 1, cursor: first.nextCursor }));
    assert.equal(next.datasetRevision, first.datasetRevision); assert.equal(next.asOf, first.asOf); assert.notEqual(next.rows[0].sampleId, first.rows[0].sampleId);
    assert.deepEqual((await call(c, "/api/tracker/atlm-dataset", { limit: 1, cursor: first.nextCursor })).value, next);
    assert.equal(JSON.stringify(first).includes(OWNER), false); assert.equal(first.rows[0].actualMs, 1000); assert.equal(first.rows[0].features.outcomeCount, 1);
    assert.equal((await mcp(c, "GetTrainingData", { cursor: first.nextCursor }, "other-owner")).value.result.structuredContent.code, "VALIDATION_ERROR");
    assert.deepEqual(value(await mcp(c, "GetTrainingData", {}, "other-owner")).rows, []);
    await ok(c, "DeletePlan", { planId: plans[0].planId }, 2); await process(c);
    assert.equal((await mcp(c, "GetTrainingData", { cursor: first.nextCursor })).value.result.structuredContent.code, "DATASET_CHANGED");
    assert.equal((await call(c, "/api/tracker/atlm-dataset", { cursor: first.nextCursor })).status, 409);
  } finally { c.close(); }
});

test("new endpoints enforce owner auth and digest conflicts; source failures stay errors", async () => {
  const c = context(); let prepare;
  try {
    await plannedAtlm(c); const args = await argsFor(c);
    assert.equal((await call(c, "/api/tracker/atlm-estimate", args, null)).status, 401);
    assert.equal((await mcp(c, "GetSavedEstimate", { planId: PLAN }, "other-owner")).value.result.structuredContent.code, "PLAN_NOT_FOUND");
    assert.equal((await call(c, `/api/tracker/plans/${PLAN}/estimate`, undefined, "other-owner")).status, 404);
    const stale = { ...args, expectedRequirementsDigest: "sha256:" + "0".repeat(64) };
    assert.equal((await mcp(c, "EstimatePlanTime", stale)).value.result.structuredContent.code, "ASSESSMENT_CONTEXT_CHANGED");
    const payload = await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request });
    prepare = c.db.prepare; c.db.prepare = function(sql) { if (sql.includes("SELECT m.* FROM estimation_models")) throw new Error("injected DB failure with private detail"); return prepare.call(this, sql); };
    const failure = await mcp(c, "EstimatePlanTime", args); assert.equal(failure.value.result.isError, true);
    assert.equal(failure.value.result.structuredContent.code, "INTERNAL_ERROR"); assert.equal(failure.value.result.structuredContent.retryable, true);
    assert.ok(failure.value.result.structuredContent.requestId); assert.equal(JSON.stringify(failure.value).includes("private detail"), false);
    assert.equal((await command(c, "RecordAssessment", payload, 0)).status, 500);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM assessment_revisions WHERE assessment_id=?").get(payload.assessmentId).n, 0);
  } finally { if (prepare) c.db.prepare = prepare; c.close(); }
});

test("a corrupt stored model is a service error, never an unavailable forecast", async () => {
  const c = context();
  try {
    await plannedAtlm(c);
    c.db.sqlite.prepare("INSERT INTO estimation_models(owner_id,model_id,model_version,status,artifact_json,manifest_json,dataset_digest,train_cutoff,sample_count,created_at,method_version,feature_version) VALUES(?,'corrupt-model',1,'ACTIVE','{}','[]','invalid',?,0,?,'agent-v2','agent-task-v2')").run(OWNER, c.now(), c.now());
    c.db.sqlite.prepare("INSERT INTO estimation_owner_state(owner_id,active_model_id) VALUES(?,'corrupt-model')").run(OWNER);
    const args = await argsFor(c), failure = await mcp(c, "EstimatePlanTime", args);
    assert.equal(failure.value.result.isError, true); assert.equal(failure.value.result.structuredContent.code, "SOURCE_UNAVAILABLE");
    assert.equal(failure.value.result.structuredContent.details.reason, "INVALID_ARTIFACT");
    assert.equal((await call(c, "/api/tracker/atlm-estimate", args)).status, 503);
    const payload = await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request });
    assert.equal((await command(c, "RecordAssessment", payload, 0)).status, 503);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM assessment_revisions WHERE assessment_id=?").get(payload.assessmentId).n, 0);
  } finally { c.close(); }
});

test("only successful commands schedule background processing; read tools and failed writes do not", async () => {
  const c = context(), background = [], ctx = { waitUntil(promise) { background.push(promise); } };
  try {
    await plannedAtlm(c);
    const fetch = async (path, body) => c.worker.fetch(new Request("http://localhost" + path, { method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-id": OWNER }, body: JSON.stringify(body) }), { DB: c.db }, ctx);
    const start = envelope("StartPlan", { planId: PLAN }, 0);
    assert.equal((await fetch("/api/commands", start)).status, 200); assert.equal(background.length, 1); await background[0];
    const n = background.length;
    await fetch("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "GetTrainingStatus", arguments: {} } });
    await fetch("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "GetCommandResult", arguments: { commandId: start.commandId } } });
    assert.equal(background.length, n);
    assert.equal((await fetch("/api/commands", envelope("StartPlan", { planId: PLAN }, 0))).status, 409); assert.equal(background.length, n);
    const pause = await fetch("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "PausePlan", arguments: envelope("PausePlan", { planId: PLAN }, 1) } });
    assert.equal((await pause.json()).result.isError, undefined); assert.equal(background.length, n + 1);
    await Promise.all(background);
  } finally { await Promise.allSettled(background); c.close(); }
});

test("manual training below the automatic threshold activates a clearly experimental model", async () => {
  const c = context();
  try {
    const tools = (await call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).value.result.tools;
    const manual = tools.find(t => t.name === "StartTraining");
    assert.ok(manual); assert.equal(manual.annotations.readOnlyHint, false); assert.equal(manual.annotations.idempotentHint, false);
    assert.equal(value(await mcp(c, "GetTrackerInfo")).assessments.atlm.startTrainingTool, "StartTraining");
    for (let i = 0; i < 1; i++) { const p = await plannedAtlm(c, crypto.randomUUID()); await completeAtlm(c, p); }
    await process(c);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) n FROM estimation_models WHERE owner_id=?").get(OWNER).n, 0);
    const result = value(await mcp(c, "StartTraining"));
    assert.equal(result.eligibleSampleCount, 1);
    assert.equal(result.activeModel.accuracy, "EXPERIMENTAL");
    assert.equal(result.activeModel.evaluation.caseCount,0);
    assert.equal(result.activeModel.evaluation.maeMs,null);
    assert.equal(result.training.generation, 1);
    assert.equal(result.lastReason,null);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) n FROM estimation_models WHERE owner_id=?").get(OWNER).n, 1);
  } finally { c.close(); }
});

test("web manual training shares the MCP path below threshold and enforces request boundaries", async () => {
  const c = context();
  try {
    for (let i = 0; i < 1; i++) { const p = await plannedAtlm(c, crypto.randomUUID()); await completeAtlm(c, p); }
    await process(c);
    const path = "/api/tracker/estimation-model/start", before = rows(c);
    assert.equal((await call(c, path, {}, null)).status, 401);
    assert.equal((await call(c, path, { actualMs: 1 })).status, 400);
    const forbidden = await c.worker.fetch(new Request("http://localhost" + path, { method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-id": OWNER, origin: "https://elsewhere.example" }, body: "{}" }), { DB: c.db });
    assert.equal(forbidden.status, 403);assert.deepEqual(rows(c), before);
    const first = await call(c, path, {});
    assert.equal(first.status, 200);assert.equal(first.value.eligibleSampleCount, 1);
    assert.equal(first.value.training.generation, 1);assert.equal(first.value.activeModel.accuracy,"EXPERIMENTAL");assert.equal(first.value.lastReason,null);
    const second = await call(c, path, {});
    assert.equal(second.status, 200);assert.equal(second.value.training.generation, 2);
    const isolated = await call(c, path, {}, "other-owner");
    assert.equal(isolated.status, 200);assert.equal(isolated.value.eligibleSampleCount, 0);
    assert.equal(value(await mcp(c, "GetTrainingStatus")).training.generation, 2);
  } finally { c.close(); }
});

test("MCP exposes one forecasting method, a time report and no BlockStep", async () => {
  const c = context();
  try {
    const listing = (await call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).value.result.tools;
    const names = listing.map(x => x.name);
    assert.ok(names.includes("EstimatePlanTime")); assert.ok(names.includes("GetSavedEstimate"));
    assert.ok(names.includes("GetTimeReport"));
    for (const name of ["CalculateEstimate", "BlockStep"]) {
      assert.equal(names.includes(name), false, name);
      assert.equal((await mcp(c, name, {})).value.result.structuredContent.code, "FEATURE_REMOVED");
    }
    const retired = await command(c, "BlockStep", {}, 1);
    assert.equal(retired.status, 400); assert.equal(retired.value.error.code, "VALIDATION_ERROR");
    const capabilities = value(await mcp(c, "GetTrackerInfo"));
    assert.equal(capabilities.assessments.calculator, undefined);
    const report = value(await mcp(c, "GetTimeReport", { from: "2026-01-01", to: "2026-01-02", timeZone: "UTC" }));
    assert.ok(Number.isFinite(report.totalActiveMs));
  } finally { c.close(); }
});

test("active public names expose the reduced model and preserve command receipts", async () => {
  const c = context();
  try {
    const listing = (await call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).value.result.tools;
    const names = listing.map(t => t.name);
    for (const name of ["GetTrackerInfo", "GetTrainingStatus", "EstimatePlanTime", "GetSavedEstimate", "StartTraining", "ContinueTraining", "GetTrainingData", "SaveTaskAssessment", "GetTaskAssessment", "GetTimeReport"]) assert.ok(names.includes(name), name);
    for (const oldName of ["GetTrackerCapabilities", "CalculateAtlmEstimate", "GetAnalytics", "BlockStep", "CalculateEstimate"]) assert.ok(!names.includes(oldName), oldName);
    assert.deepEqual(value(await mcp(c, "GetTrainingStatus")), value(await mcp(c, "GetEstimationModelStatus")));
    const cap = value(await mcp(c, "GetTrackerInfo"));
    assert.deepEqual((await call(c, "/api/tracker/capabilities")).value, cap);
    assert.equal(cap.assessments.atlm.calculateTool, "EstimatePlanTime");
    assert.equal(cap.assessments.atlm.startTrainingTool, "StartTraining");
    assert.equal(cap.assessments.recordTool, "SaveTaskAssessment");
  } finally { c.close(); }
});
