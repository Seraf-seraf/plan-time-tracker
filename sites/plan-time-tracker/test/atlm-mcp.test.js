import test from "node:test";
import assert from "node:assert/strict";
import { readAtlmSampleSource } from "../worker/index.js";
import { fitAtlm, normalizeAgentTask } from "../worker/atlm/model.js";
import { processAtlmSampleRefresh } from "../worker/atlm/sample-refresh.js";
import { assessForStart, context, call, command, ok, mcp, rows, atlmTask, atlmAssessment, plannedAtlm, completeAtlm, envelope, migrations, migration, OWNER, PLAN } from "./fixtures/tracker-db.mjs";
const request = { method: "ATLM", methodVersion: 1 };
const value = r => { assert.equal(r.value.result.isError, undefined, JSON.stringify(r.value)); return r.value.result.structuredContent; };
async function argsFor(c, planId = PLAN, agentTask = atlmTask()) {
  return { planId, expectedRequirementsDigest: value(await mcp(c, "GetTaskAssessment", { planId })).currentRequirementsDigest, agentTask };
}
const registryArgs = (view, args = {}) => ({ schemaVersion: 1, view, ...args });
const registry = async (c, view = "list", args) => value(await mcp(c, "ListModelRevisions", registryArgs(view, args)));
const retiredTools = [
  "GetTrainingStatus", "GetTrainingData", "GetTrainingHistory", "StartTraining", "ContinueTraining",
  "GetEstimationModelStatus", "GetAtlmDataset", "GetEstimationTrainingHistory",
  "StartEstimationTraining", "ProcessEstimationTraining",
];
const revisionTools = [
  "CreateTrainingSnapshot", "SaveDatasetRevision", "GetDatasetRevision",
  "RegisterModelRevision", "ListModelRevisions", "ActivateModelRevision",
];

function seedActiveModel(c, modelRevisionId, artifact, planIds) {
  const db = c.db.sqlite;
  db.prepare(`INSERT INTO estimation_model_revisions(owner_id,model_revision_id,model_version,origin,
    method_version,feature_version,registered_at,imported_at,artifact_json,manifest_json,provenance_json,
    fit_count,source_count,supported) VALUES(?,?,1,'IMPORTED','agent-v5-operations','agent-task-v4',
    ?,?,?,?,'{}',?,?,1)`).run(OWNER, modelRevisionId, c.now() + 1, c.now(), JSON.stringify(artifact),
      JSON.stringify(artifact.manifest ?? []), planIds.length, planIds.length);
  const insert = db.prepare(`INSERT INTO estimation_model_revision_sources(owner_id,model_revision_id,plan_id,source_generation,ordinal)
    VALUES(?,?,?,coalesce((SELECT generation FROM estimation_jobs WHERE owner_id=? AND job_key='refresh:'||?),0),?)`);
  for (const [ordinal, planId] of planIds.entries()) insert.run(OWNER, modelRevisionId, planId, OWNER, planId, ordinal);
  db.prepare('INSERT INTO estimation_active_revisions VALUES(?,?,1)').run(OWNER, modelRevisionId);
}

async function seedForecastFixtures(c) {
  const plans = [], examples = [];
  const features = normalizeAgentTask(atlmTask()).features;
  for (let i = 0; i < 15; i++) {
    const p = await plannedAtlm(c, crypto.randomUUID());
    await completeAtlm(c, p);
    plans.push(p);
    examples.push({sampleId: String(i + 1), planId: p.planId, capturedAt: c.now() - 1000,
      sourceAvailableAt: c.now(), features, actualMs: 1000});
    c.advance(1);
  }
  await processBaseline(c);
  const fitted = await fitAtlm(examples);
  assert.equal(fitted.status, "AVAILABLE", JSON.stringify(fitted));
  seedActiveModel(c, "atlm-fixture", fitted.artifact, plans.map(p => p.planId));
  return plans;
}
function beforePredictionWrite(c, effect) {
  const prepare = c.db.prepare; let used = false;
  c.db.prepare = function(sql) {
    const statement = prepare.call(this, sql), bind = statement.bind.bind(statement);
    statement.bind = (...args) => {
      const bound = bind(...args);
      if (!used && sql.startsWith("WITH source AS (") && args[5] === "RecordAssessment"
        && sql.includes("THEN 'ATLM_FORECAST_SCOPE_CHANGED'")) {
        const run = bound.run.bind(bound);
        bound.run = async () => { used = true; await effect(); return run(); };
      }
      return bound;
    };
    return statement;
  };
  return () => { c.db.prepare = prepare; };
}

test("forecast and registry MCP discovery use the same strict branches as runtime", async () => {
  const c = context();
  try {
    const listing = (await call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).value.result.tools;
    const atlm = value(await mcp(c, "GetTrackerInfo")).assessments.atlm;
    const tools = new Map(listing.map(tool => [tool.name, tool]));
    for (const name of [...retiredTools, "issued-history"]) assert.equal(tools.has(name), false, name);
    assert.deepEqual(Object.keys(atlm.registry.tools).sort(), [...revisionTools].sort());
    for (const name of revisionTools) {
      const tool = tools.get(name);
      assert.deepEqual(tool.inputSchema, atlm.registry.tools[name]);
      assert.ok(tool.inputSchema.oneOf.every(shape => shape.additionalProperties === false));
      for (const discriminator of ["mode", "view", "phase"]) {
        const values = tool.inputSchema.oneOf.flatMap(shape => shape.properties[discriminator]?.enum ?? []);
        if (values.length) assert.deepEqual(tool.inputSchema.properties[discriminator].enum, [...new Set(values)]);
      }
      assert.equal(tool.annotations.idempotentHint, true);
      assert.equal((await mcp(c, name, { schemaVersion: 1, ownerId: OWNER })).value.result.structuredContent.code, "VALIDATION_ERROR");
      assert.equal((await mcp(c, name, null)).value.result.structuredContent.code, "VALIDATION_ERROR");
    }
    for (const name of ["EstimatePlanTime", "GetSavedEstimate"]) {
      const tool = tools.get(name);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal((await mcp(c, name, { actualMs: 10 })).value.result.structuredContent.code, "VALIDATION_ERROR");
    }
    const schema = tools.get("SaveTaskAssessment").inputSchema.properties.payload;
    assert.deepEqual(schema.properties.predictionRequest.properties.method.enum, ["ATLM"]);
    assert.equal(schema.properties.serverEstimation, undefined);
    assert.equal(atlm.featureSchemaVersion, "agent-task-v4");
    assert.equal(atlm.predictionScope, "FULL_FROM_FIRST_START");
    assert.equal(atlm.registry.limits.partSize, 49152);
    assert.equal(atlm.registry.limits.maxPageSize, 50);
    assert.equal(atlm.registry.defaultTeacherRecipeId, "atlm-teacher-hybrid-v3");
    const snapshots = tools.get("CreateTrainingSnapshot");
    const repair = snapshots.inputSchema.oneOf.find(shape => shape.properties.mode?.enum.includes("repair"));
    assert.ok(repair.required.includes("planIds"));
    assert.equal(repair.properties.planIds.maxItems, 25);
    assert.match(snapshots.description, /свежий снимок.*mode:"repair"/);
    assert.match(snapshots.description, /по отдельному поручению на восстановление/);
    assert.match(tools.get("SaveDatasetRevision").description, /USER_REQUESTED_SKIP по planId/);
    assert.match(tools.get("SaveDatasetRevision").description, /исключите удалённые планы и планы без подтверждённого факта/i);
    assert.equal(atlm.retrainEveryNewPlans, undefined);
  } finally { c.close(); }
});

test("retired MCP and HTTP operations fail without changing state", async () => {
  const c = context();
  try {
    const before = rows(c);
    for (const name of retiredTools) {
      const response = (await mcp(c, name, {})).value.result;
      assert.equal(response.isError, true);
      assert.equal(response.structuredContent.code, "FEATURE_REMOVED", name);
    }
    for (const [path, body] of [["estimation-model"], ["estimation-model/start", {}],
      ["estimation-model/process", {}], ["estimation-training-history"], ["atlm-dataset", {}]]) {
      const response = await call(c, "/api/tracker/" + path, body);
      assert.equal(response.status, 404, path);
      assert.equal(response.value.error.code, "NOT_FOUND", path);
    }
    assert.deepEqual(rows(c), before);
  } finally { c.close(); }
});

test("model registry requires strict query branches on both transports", async () => {
  const c = context();
  try {
    const path = "/api/tracker/model-revisions";
    assert.deepEqual((await call(c, path + "?view=list")).value, await registry(c));
    for (const query of ["?view=download", "?view=detail", "?view=detail&modelRevisionId=x&limit=1",
      "?view=list&modelRevisionId=x", "?view=list&limit=51", "?view=list&view=activations", "?view=list&ownerId=other",
      "?view=issued-history&from=2027-01-01&timeZone=UTC"]) {
      const response = await call(c, path + query);
      assert.equal(response.status, 400, query);
      assert.equal(response.value.error.code, "VALIDATION_ERROR");
    }
    for (const args of [{ view: "detail" }, { view: "list", modelRevisionId: "x" }, { view: "issued-history" }]) {
      const response = await mcp(c, "ListModelRevisions", { schemaVersion: 1, ...args });
      assert.equal(response.value.result.structuredContent.code, "VALIDATION_ERROR");
    }
    assert.equal((await call(c, path + "?view=list", undefined, null)).status, 401);
    assert.equal((await call(c, path + "?view=detail&modelRevisionId=missing")).value.error.code, "MODEL_REVISION_NOT_FOUND");
  } finally { c.close(); }
});

test("cold and incomplete previews are read-only across MCP/HTTP; forecasts are unavailable after Start", async () => {
  const c = context();
  try {
    await plannedAtlm(c); const args = await argsFor(c), before = rows(c);
    const preview = value(await mcp(c, "EstimatePlanTime", args));
    assert.equal(preview.unavailableReason, "COLLECTING_DATA"); assert.equal(preview.pointMs, null);
    assert.deepEqual((await call(c, "/api/tracker/atlm-estimate", args)).value, preview);
    await registry(c); value(await mcp(c, "GetSavedEstimate", { planId: PLAN }));
    assert.deepEqual(rows(c), before);
    const unknown = atlmTask(); unknown.workUnits = null; unknown.unknownReasons.workUnits = "Unknown";
    const missing = (await mcp(c, "EstimatePlanTime", await argsFor(c, PLAN, unknown))).value.result.structuredContent;
    assert.equal(missing.code, "VALIDATION_ERROR");
    await ok(c, "StartPlan", { planId: PLAN }, 0);
    assert.equal(value(await mcp(c, "EstimatePlanTime", args)).unavailableReason, "UNSUPPORTED_FORECAST_SCOPE");
    assert.equal((await command(c, "RecordAssessment", await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request }), 0)).value.error.code, "ATLM_FORECAST_SCOPE_CHANGED");
    await ok(c, "RecordAssessment", await atlmAssessment(c), 0);
    assert.equal(value(await mcp(c, "GetSavedEstimate", { planId: PLAN })).serverEstimation.status, "UNAVAILABLE");
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
    assert.equal(value(await mcp(c, "GetSavedEstimate", { planId: PLAN })).serverEstimation.status, "UNAVAILABLE");
  } finally { restore?.(); c.close(); }
});

test("the 65536-byte assessment limit also applies after adding the server forecast", async () => {
  const c = context();
  try {
    await plannedAtlm(c);
    const payload = await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request });
    payload.context.padding = [...Array.from({ length: 15 }, () => "x".repeat(4000)), ""];
    const size = value => new TextEncoder().encode(JSON.stringify(value)).length;
    payload.context.padding[15] = "x".repeat(65450 - size(payload));
    assert.equal(size(payload), 65450);
    assert.equal((await command(c, "RecordAssessment", payload, 0)).status, 400);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM assessment_revisions WHERE assessment_id=?").get(payload.assessmentId).n, 0);
    payload.context.padding.pop(); await ok(c, "RecordAssessment", payload, 0);
    assert.ok(new TextEncoder().encode(c.db.sqlite.prepare("SELECT assessment_json FROM assessment_revisions WHERE assessment_id=?").get(payload.assessmentId).assessment_json).length <= 65536);
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
    const trained = await seedForecastFixtures(c), p = await plannedAtlm(c);
    const payload = await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request });
    await ok(c, "RecordAssessment", payload, 0);
    const before = value(await mcp(c, "GetSavedEstimate", { planId: PLAN }));
    assert.equal(before.serverEstimation.status, "AVAILABLE"); assert.equal(before.serverEstimation.pointMs, 1000);
    assert.equal(before.serverEstimation.accuracy, "EXPERIMENTAL");
    assert.equal(before.serverEstimation.evaluation, null, "a fixture without a saved report has no quality claim");
    assert.equal(before.serverEstimation.interval.status, "AVAILABLE"); assert.ok(before.serverEstimation.interval.lowerMs<=before.serverEstimation.pointMs && before.serverEstimation.interval.upperMs>=before.serverEstimation.pointMs);
    await completeAtlm(c, p, 1200); await ok(c, "RecordAssessment", await atlmAssessment(c), 0);
    const frozen = value(await mcp(c, "GetSavedEstimate", { planId: PLAN }));
    assert.equal(frozen.assessmentId, payload.assessmentId); assert.deepEqual(frozen.serverEstimation, before.serverEstimation);
    const source = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
    assert.deepEqual(source.issuedPrediction, frozen.serverEstimation);
    assert.equal(source.actualMs, 1200);
    assert.equal(source.issuedPrediction.pointMs - source.actualMs, -200);
    await ok(c, "UpdatePlanMetadata", { planId: PLAN, title: "Temporary scope change" }, 2);
    await ok(c, "UpdatePlanMetadata", { planId: PLAN, title: "ATLM synthetic feature" }, 3);
    assert.ok(value(await mcp(c, "GetSavedEstimate", { planId: PLAN })).staleReasons.includes("SCOPE_CHANGED"));
    await ok(c, "DeletePlan", { planId: trained[0].planId }, 2);
    const stale = value(await mcp(c, "GetSavedEstimate", { planId: PLAN })); assert.equal(stale.isStale, true); assert.ok(stale.staleReasons.includes("MODEL_INVALIDATED"));
    assert.deepEqual(stale.serverEstimation, frozen.serverEstimation);
  } finally { c.close(); }
});

test("model invalidation racing save cannot commit a fresh prediction from the stale artifact", async () => {
  const c = context(); let restore;
  try {
    const trained = await seedForecastFixtures(c); await plannedAtlm(c);
    const payload = await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request });
    restore = beforePredictionWrite(c, () => ok(c, "DeletePlan", { planId: trained[0].planId }, 2));
    const response = await command(c, "RecordAssessment", payload, 0); assert.equal(response.status, 409);
    assert.equal(response.value.error.code, "ATLM_MODEL_CHANGED");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM assessment_revisions WHERE assessment_id=?").get(payload.assessmentId).n, 0);
    const preview = value(await mcp(c, "EstimatePlanTime", await argsFor(c))); assert.equal(preview.unavailableReason, "MODEL_INVALIDATED");
    await ok(c, "RecordAssessment", await atlmAssessment(c, PLAN, atlmTask(), { predictionRequest: request }), 0);
    assert.equal(value(await mcp(c, "GetSavedEstimate", { planId: PLAN })).serverEstimation.unavailableReason, "MODEL_INVALIDATED");
  } finally { restore?.(); c.close(); }
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
    prepare = c.db.prepare; c.db.prepare = function(sql) { if (sql.includes("SELECT m.* FROM estimation_serving_models")) throw new Error("injected DB failure with private detail"); return prepare.call(this, sql); };
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
    seedActiveModel(c, "corrupt-model", {}, [PLAN]);
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
    assert.equal((await (await fetch("/api/commands", start)).json()).replayed, true);
    await fetch("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ListModelRevisions", arguments: registryArgs("list") } });
    await fetch("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "GetCommandResult", arguments: { commandId: start.commandId } } });
    assert.equal(background.length, n);
    assert.equal((await fetch("/api/commands", envelope("StartPlan", { planId: PLAN }, 0))).status, 409); assert.equal(background.length, n);
    const pause = await fetch("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "PausePlan", arguments: envelope("PausePlan", { planId: PLAN }, 1) } });
    assert.equal((await pause.json()).result.isError, undefined); assert.equal(background.length, n + 1);
    await Promise.all(background);
  } finally { await Promise.allSettled(background); c.close(); }
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
    for (const name of ["GetTrackerInfo", "EstimatePlanTime", "GetSavedEstimate", "SaveTaskAssessment", "GetTaskAssessment", "GetTimeReport"]) assert.ok(names.includes(name), name);
    for (const oldName of ["GetTrackerCapabilities", "CalculateAtlmEstimate", "GetAnalytics", "BlockStep", "CalculateEstimate"]) assert.ok(!names.includes(oldName), oldName);
    const cap = value(await mcp(c, "GetTrackerInfo"));
    assert.deepEqual((await call(c, "/api/tracker/capabilities")).value, cap);
    assert.equal(cap.assessments.atlm.calculateTool, "EstimatePlanTime");
    assert.equal(cap.assessments.atlm.registry.activation, "EXPLICIT");
    assert.equal(cap.assessments.recordTool, "SaveTaskAssessment");
    assert.deepEqual(cap.assessments.atlm.execution.environmentId, {
      optional:false,type:"string",closedSet:true,values:["local","cloud_workspace"],
      description:"Допустимые значения: local, cloud_workspace."
    });
    const environmentTool=listing.find(item=>item.name==="EstimatePlanTime");
    const environmentSchema=environmentTool.inputSchema.properties.agentTask.properties.execution.properties.environmentId;
    assert.deepEqual(environmentSchema.enum,["local","cloud_workspace"]);
    const saveSchema=listing.find(item=>item.name==="SaveTaskAssessment").inputSchema;
    const savedEnvironmentSchema=saveSchema.properties.payload.properties.context.properties.agentTask.properties.execution.properties.environmentId;
    assert.deepEqual(savedEnvironmentSchema.enum,["local","cloud_workspace"]);
  } finally { c.close(); }
});

test("forecast diagnostics explain missing inputs and freeze calculation availability after first start", async () => {
  const c=context();
  try {
    await ok(c,"CreatePlan",{planId:PLAN,title:"Diagnostics",planText:"## Этап 1. Выполнить\nРезультат.",planCreatedAt:{precision:"dateOnly",on:"2026-01-01",timeZone:"UTC"}});
    const before=rows(c);
    const empty=value(await mcp(c,"GetSavedEstimate",{planId:PLAN}));
    assert.equal(empty.diagnostics.code,"ASSESSMENT_REQUIRED");
    assert.deepEqual(empty.assessmentReadiness.missingPaths,["assessment"]);
    assert.equal(empty.forecastAvailability.canRefreshSaved,true);
    assert.equal(empty.forecastAvailability.canCalculate,false);
    assert.deepEqual(rows(c),before);
    const unknown=atlmTask();unknown.workUnits=null;unknown.unknownReasons.workUnits="Unknown";
    const preview=(await mcp(c,"EstimatePlanTime",await argsFor(c,PLAN,unknown))).value.result.structuredContent;
    assert.equal(preview.code,"VALIDATION_ERROR");
    const cold=value(await mcp(c,"EstimatePlanTime",await argsFor(c)));
    assert.equal(cold.diagnostics.code,"COLLECTING_DATA");
    assert.match(cold.diagnostics.message,/модель прогноза/i);
    await assessForStart(c);
    await ok(c,"StartPlan",{planId:PLAN},0);
    for(const [statusName,version] of [["RUNNING",1],["PAUSED",2],["RUNNING",3]]){
      if(statusName==="PAUSED")await ok(c,"PausePlan",{planId:PLAN},1);
      else if(version===3)await ok(c,"ResumePlan",{planId:PLAN},2);
      const saved=value(await mcp(c,"GetSavedEstimate",{planId:PLAN}));
      assert.equal(saved.forecastAvailability.canCalculate,false);
      assert.equal(saved.forecastAvailability.canRefreshSaved,false);
      assert.match(saved.forecastAvailability.diagnostics.message,new RegExp(statusName));
      assert.equal(saved.forecastAvailability.reason,"UNSUPPORTED_FORECAST_SCOPE");
    }
  } finally {c.close();}
});

test("completed and deleted plans keep history but reject new forecasts",async()=>{
 const c=context();try{
  const p=await plannedAtlm(c);const args=await argsFor(c);
  await completeAtlm(c,p);
  const completed=value(await mcp(c,"GetSavedEstimate",{planId:PLAN}));
  assert.equal(completed.forecastAvailability.canCalculate,false);
  assert.equal(completed.forecastAvailability.canRefreshSaved,false);
  assert.match(completed.forecastAvailability.diagnostics.message,/status=COMPLETED/);
  const before=rows(c);
  assert.equal(value(await mcp(c,"EstimatePlanTime",args)).unavailableReason,"UNSUPPORTED_FORECAST_SCOPE");
  assert.deepEqual(rows(c),before);
  await ok(c,"DeletePlan",{planId:PLAN},2);
  const deleted=value(await mcp(c,"GetSavedEstimate",{planId:PLAN}));
  assert.equal(deleted.forecastAvailability.reason,"PLAN_DELETED");
  assert.deepEqual(deleted.serverEstimation,completed.serverEstimation);
  const refusal=await mcp(c,"EstimatePlanTime",args);
  assert.equal(refusal.value.result.structuredContent.code,"PLAN_NOT_FOUND");
 }finally{c.close();}
});

test("saved availability checks model categories and reports invalidated revision sources",async()=>{
 const c=context();try{
  const sources=await seedForecastFixtures(c);
  const s=await registry(c);
  assert.equal(s.servingModelRevisionId,"atlm-fixture");
  const task=atlmTask();task.workUnits[0].kind="CREATE";
  const p=await plannedAtlm(c,crypto.randomUUID(),task);
  await ok(c,"RecordAssessment",await atlmAssessment(c,p.planId,task,{predictionRequest:request}),0);
  const before=rows(c), saved=value(await mcp(c,"GetSavedEstimate",{planId:p.planId}));
  assert.equal(saved.forecastAvailability.canCalculate,true);
  assert.equal(saved.forecastAvailability.calculationMethod.id,"atlm");
  assert.equal(saved.serverEstimation.method.id,"atlm");
  assert.equal(saved.serverEstimation.interval.status,"AVAILABLE");
  assert.deepEqual(rows(c),before);
  assert.equal(saved.forecastAvailability.planStatus,"PLANNED");
  await ok(c,"DeletePlan",{planId:p.planId},0);
  const removed=value(await mcp(c,"GetSavedEstimate",{planId:p.planId}));
  assert.equal(removed.forecastAvailability.deleted,true);
  await ok(c,"DeletePlan",{planId:sources[0].planId},2);
  const invalidated=await registry(c);
  assert.equal(invalidated.sourceStatus,"INVALIDATED");
  assert.equal(invalidated.servingModelRevisionId,null);
  const known=await plannedAtlm(c,crypto.randomUUID());
  await ok(c,"RecordAssessment",await atlmAssessment(c,known.planId,atlmTask(),{predictionRequest:request}),0);
  const invalid=value(await mcp(c,"GetSavedEstimate",{planId:known.planId}));
  assert.equal(invalid.diagnostics.code,"MODEL_INVALIDATED");
  assert.equal(invalid.forecastAvailability.canCalculate,false);
 }finally{c.close();}
});

function processBaseline(c) {
  return processAtlmSampleRefresh(c.db, OWNER, c.now(), { clock: c.now });
}
async function baselineHistory(c,durations){
 const plans=[];
 for(let i=0;i<durations.length;i++){
  // Keep the target's MODIFY category unseen: rank deficiency alone no longer forces a median.
  const task=atlmTask();task.workUnits[0].kind=["CREATE","VERIFY","ANALYZE","CREATE"][i%4];task.reuseLevel=[1,0,3][i%3];
  const p=await plannedAtlm(c,crypto.randomUUID(),task);await completeAtlm(c,p,durations[i]);c.advance(1);plans.push(p);
 }
 await processBaseline(c);return plans;
}
test("early historical median returns real odd/even durations, persists honestly and does not impersonate ATLM",async()=>{
 const c=context();try{
  const sources=await baselineHistory(c,[1000,5000,9000]);await plannedAtlm(c);
  const args=await argsFor(c),before=rows(c);
  const p=value(await mcp(c,"EstimatePlanTime",args));
  assert.equal(p.status,"AVAILABLE");assert.equal(p.method.id,"historical-median");assert.equal(p.pointMs,5000);
  assert.equal(p.modelId,null);assert.equal(p.sampleCount,3);assert.equal(p.accuracy,"HISTORICAL_BASELINE");
  assert.equal(p.interval.status,"UNAVAILABLE");assert.equal(p.fallback.atlmUnavailableReason,"COLLECTING_DATA");
  assert.deepEqual(rows(c),before);
  const payload=await atlmAssessment(c,PLAN,atlmTask(),{predictionRequest:request});
  await ok(c,"RecordAssessment",payload,0);
  const saved=value(await mcp(c,"GetSavedEstimate",{planId:PLAN}));
  assert.equal(saved.serverEstimation.pointMs,5000);
  assert.equal(saved.forecastAvailability.canCalculate,true);
  assert.equal(saved.forecastAvailability.calculationMethod.id,"historical-median");
  const t=atlmTask();t.workUnits[0].kind="MODIFY";t.reuseLevel=3;
  await completeAtlm(c,await plannedAtlm(c,crypto.randomUUID(),t),13000);await processBaseline(c);
  const even=value(await mcp(c,"EstimatePlanTime",args));assert.equal(even.pointMs,7000);
  const previous=value(await mcp(c,"GetSavedEstimate",{planId:PLAN}));
  assert.equal(previous.serverEstimation.pointMs,7000);
  assert.equal(previous.recordedEstimation.pointMs,5000);
  assert.equal(previous.source,"CURRENT_INPUT");assert.equal(previous.isStale,false);
  assert.deepEqual((await call(c,"/api/tracker/plans/"+PLAN+"/estimate")).value,previous);
  await ok(c,"DeletePlan",{planId:sources[0].planId},2);
  const stale=value(await mcp(c,"GetSavedEstimate",{planId:PLAN}));
  assert.equal(stale.serverEstimation.pointMs,null);assert.equal(stale.recordedEstimation.pointMs,5000);
  assert.equal(stale.isStale,false);await processBaseline(c);
  assert.equal(value(await mcp(c,"GetSavedEstimate",{planId:PLAN})).serverEstimation.pointMs,9000);
  await ok(c,"StartPlan",{planId:PLAN},0);
  assert.equal(value(await mcp(c,"EstimatePlanTime",args)).unavailableReason,"UNSUPPORTED_FORECAST_SCOPE");
 }finally{c.close();}
});
test("baseline source change racing assessment write is receipted and cannot save stale history",async()=>{
 const c=context();let restore;try{
  const plans=await baselineHistory(c,[1000,5000,9000]);await plannedAtlm(c);
  const payload=await atlmAssessment(c,PLAN,atlmTask(),{predictionRequest:request});
  restore=beforePredictionWrite(c,()=>ok(c,"DeletePlan",{planId:plans[0].planId},2));
  const r=await command(c,"RecordAssessment",payload,0);
  assert.equal(r.status,409);assert.equal(r.value.error.code,"ATLM_MODEL_CHANGED");
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) n FROM assessment_revisions WHERE assessment_id=?").get(payload.assessmentId).n,0);
 }finally{restore?.();c.close();}
});

test("a frozen median is audited against the actual duration without a modelId",async()=>{
  const c=context();try{
    await baselineHistory(c,[1000,5000,9000]);const target=await plannedAtlm(c);
    await ok(c,'RecordAssessment',await atlmAssessment(c,PLAN,atlmTask(),{predictionRequest:request}),0);
    const issued=value(await mcp(c,'GetSavedEstimate',{planId:PLAN})).serverEstimation;
    await completeAtlm(c,target,1000);
    const source=await readAtlmSampleSource(c.db,OWNER,PLAN,c.now());
    assert.equal(source.eligibility,'ELIGIBLE');assert.equal(source.actualMs,1000);
    assert.equal(source.issuedPrediction.method.id,'historical-median');assert.equal(source.issuedPrediction.modelId,null);
    assert.equal(source.issuedPrediction.pointMs,5000);assert.equal(source.issuedPrediction.pointMs-source.actualMs,4000);
    assert.deepEqual(value(await mcp(c,'GetSavedEstimate',{planId:PLAN})).serverEstimation,issued);
  }finally{c.close();}
});
test("early median respects owner isolation, genuine zero and incomplete inputs",async()=>{
 const c=context();try{
  const sources=await baselineHistory(c,[0]);await plannedAtlm(c);
  const zero=value(await mcp(c,"EstimatePlanTime",await argsFor(c)));assert.equal(zero.pointMs,0);assert.equal(zero.sampleCount,1);
  const incomplete=atlmTask();incomplete.workUnits=null;incomplete.unknownReasons.workUnits="Unknown";
  assert.equal((await mcp(c,"EstimatePlanTime",await argsFor(c,PLAN,incomplete))).value.result.structuredContent.code,"VALIDATION_ERROR");
  const otherPlan=crypto.randomUUID(),other="isolated-other";
  assert.equal((await command(c,"CreatePlan",{planId:otherPlan,title:"Isolated",planText:"## Этап 1. Test\nГотово.",planCreatedAt:{precision:"dateOnly",on:"2026-01-01",timeZone:"UTC"}},undefined,undefined,other)).status,200);
  const ctx=value(await mcp(c,"GetTaskAssessment",{planId:otherPlan},other));
  const isolated=value(await mcp(c,"EstimatePlanTime",{planId:otherPlan,expectedRequirementsDigest:ctx.currentRequirementsDigest,agentTask:atlmTask()},other));
  assert.equal(isolated.status,"UNAVAILABLE");assert.equal(isolated.pointMs,null);
  await ok(c,"DeletePlan",{planId:sources[0].planId},2);
  const dirty=value(await mcp(c,"EstimatePlanTime",await argsFor(c)));
  assert.equal(dirty.status,"UNAVAILABLE");
  await processBaseline(c);
  assert.equal(value(await mcp(c,"EstimatePlanTime",await argsFor(c))).pointMs,null);
 }finally{c.close();}
});


test("current PLANNED reads latest input without predictionRequest and refuses changed requirements",async()=>{
 const c=context();try{
  await baselineHistory(c,[1000,5000,9000]);const planned=await plannedAtlm(c);
  const before=rows(c),fresh=value(await mcp(c,"GetSavedEstimate",{planId:PLAN}));
  assert.equal(fresh.serverEstimation.pointMs,5000);assert.equal(fresh.recordedEstimation.pointMs,5000);
  assert.equal(fresh.assessmentId,planned.assessment.assessmentId);assert.deepEqual(rows(c),before);
  await ok(c,"UpdatePlanMetadata",{planId:PLAN,title:"New scope"},0);
  const stale=value(await mcp(c,"GetSavedEstimate",{planId:PLAN}));
  assert.equal(stale.serverEstimation.pointMs,null);assert.equal(stale.serverEstimation.unavailableReason,"ASSESSMENT_CONTEXT_CHANGED");
  assert.deepEqual(stale.assessmentReadiness.invalidPaths,["requirementsDigest"]);
  const unknown=atlmTask();unknown.workUnits=null;unknown.unknownReasons.workUnits="Unknown";
  const revised=await atlmAssessment(c,PLAN);await ok(c,"RecordAssessment",revised,0);
  const latest=value(await mcp(c,"GetSavedEstimate",{planId:PLAN}));
  assert.equal(latest.assessmentId,revised.assessmentId);
  assert.equal(latest.serverEstimation.unavailableReason,"ASSESSMENT_INCOMPLETE");assert.equal(latest.serverEstimation.pointMs,null);
 }finally{c.close();}
});

test("first Start freezes fresh forecast, preserves recorded revision and replays without recapture",async()=>{
 const c=context();try{
  await baselineHistory(c,[1000,5000,9000]);const planned=await plannedAtlm(c);
  const payload=await atlmAssessment(c,PLAN,atlmTask(),{predictionRequest:request});await ok(c,"RecordAssessment",payload,0);
  const raw=c.db.sqlite.prepare("SELECT assessment_json FROM assessment_revisions WHERE assessment_id=?").get(payload.assessmentId).assessment_json;
  const task=atlmTask();task.workUnits[0].kind="MODIFY";
  await completeAtlm(c,await plannedAtlm(c,crypto.randomUUID(),task),13000);await processBaseline(c);c.advance(200);
  const id=crypto.randomUUID(),first=await command(c,"StartPlan",{planId:PLAN},0,id);
  assert.equal(first.status,200);
  const frozen=value(await mcp(c,"GetSavedEstimate",{planId:PLAN}));
  assert.equal(frozen.source,"FROZEN_INPUT");assert.equal(frozen.serverEstimation.pointMs,7000);
  assert.equal(frozen.recordedEstimation.pointMs,5000);assert.equal(frozen.serverEstimation.calculatedAt,c.now());
  const input=c.db.sqlite.prepare("SELECT * FROM plan_estimation_inputs WHERE plan_id=?").get(PLAN);
  assert.throws(()=>c.db.sqlite.prepare("UPDATE plan_estimation_inputs SET forecast_json='{}' WHERE plan_id=?").run(PLAN),/IMMUTABLE/);
  c.advance(300);await ok(c,"RecordAssessment",await atlmAssessment(c),0);
  assert.equal((await command(c,"StartPlan",{planId:PLAN},0,id)).status,200);
  assert.deepEqual(c.db.sqlite.prepare("SELECT * FROM plan_estimation_inputs WHERE plan_id=?").get(PLAN),input);
  assert.equal(c.db.sqlite.prepare("SELECT assessment_json FROM assessment_revisions WHERE assessment_id=?").get(payload.assessmentId).assessment_json,raw);
  assert.equal((await readAtlmSampleSource(c.db,OWNER,PLAN,c.now())).capturedAt,input.first_started_at);
  assert.deepEqual(value(await mcp(c,"GetSavedEstimate",{planId:PLAN})).serverEstimation,frozen.serverEstimation);
 }finally{c.close();}
});
function beforeStartWrite(c,effect){
 const prepare=c.db.prepare;let used=false;
 c.db.prepare=function(sql){
  const statement=prepare.call(this,sql),bind=statement.bind.bind(statement);
  statement.bind=(...args)=>{
   const bound=bind(...args);
   if(!used&&sql.includes("INSERT OR IGNORE INTO command_receipts")&&args.includes("StartPlan")){
    const run=bound.run.bind(bound);bound.run=async()=>{used=true;await effect();return run();};
   }
   return bound;
  };return statement;
 };return()=>{c.db.prepare=prepare;};
}
test("first Start rejects changed features durably, with no interval or snapshot; private input is rejected",async()=>{
 const c=context();let restore;try{
  await plannedAtlm(c);
  assert.equal((await command(c,"StartPlan",{planId:PLAN,atlmStartForecast:{}},0)).status,400);
  restore=beforeStartWrite(c,()=>assessForStart(c));
  const id=crypto.randomUUID(),r=await command(c,"StartPlan",{planId:PLAN},0,id);
  assert.equal(r.status,409);assert.equal(r.value.error.code,"ASSESSMENT_CONTEXT_CHANGED");restore();
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) n FROM work_intervals WHERE plan_id=?").get(PLAN).n,0);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) n FROM plan_estimation_inputs WHERE plan_id=?").get(PLAN).n,0);
  assert.equal((await command(c,"StartPlan",{planId:PLAN},0,id)).value.error.code,"ASSESSMENT_CONTEXT_CHANGED");
  await ok(c,"StartPlan",{planId:PLAN},0);
 }finally{restore?.();c.close();}
});
test("first Start rejects changed historical source before timer begins",async()=>{
 const c=context();let restore;try{
  const sources=await baselineHistory(c,[1000,5000,9000]);await plannedAtlm(c);
  restore=beforeStartWrite(c,()=>ok(c,"DeletePlan",{planId:sources[0].planId},2));
  const r=await command(c,"StartPlan",{planId:PLAN},0);
  assert.equal(r.status,409);assert.equal(r.value.error.code,"ASSESSMENT_CONTEXT_CHANGED");
  assert.match(r.value.error.message,/данные прогноза/);assert.match(r.value.error.message,/Таймер не запущен/);
  assert.doesNotMatch(r.value.error.message,/Перечитайте контекст и пересмотрите оценку/);
  assert.equal(c.db.sqlite.prepare("SELECT first_started_at FROM plans WHERE plan_id=?").get(PLAN).first_started_at,null);
 }finally{restore?.();c.close();}
});

function afterCurrentInputRead(c,effect){
 const prepare=c.db.prepare;let used=false;
 c.db.prepare=function(sql){
  const statement=prepare.call(this,sql),bind=statement.bind.bind(statement);
  statement.bind=(...args)=>{
   const bound=bind(...args);
   if(!used&&sql.startsWith("SELECT input.*,")){
    const first=bound.first.bind(bound);
    bound.first=async()=>{const row=await first();if(!used){used=true;await effect();}return row;};
   }
   return bound;
  };return statement;
 };return()=>{c.db.prepare=prepare;};
}
test("current getter retries a newer assessment and returns authoritative frozen snapshot after concurrent Start",async()=>{
 for(const action of ["assessment","start"]){
  const c=context();let restore;try{
   await baselineHistory(c,[1000,5000,9000]);await plannedAtlm(c);
   restore=afterCurrentInputRead(c,async()=>{
    if(action==="start")await ok(c,"StartPlan",{planId:PLAN},0);
    else{await ok(c,"RecordAssessment",await atlmAssessment(c,PLAN),0);}
   });
   const r=value(await mcp(c,"GetSavedEstimate",{planId:PLAN}));
   if(action==="start"){
    assert.equal(r.source,"FROZEN_INPUT");assert.equal(r.forecastAvailability.planStatus,"RUNNING");
    assert.equal(r.forecastAvailability.canRefreshSaved,false);assert.equal(r.serverEstimation.pointMs,5000);
   }else{
    assert.equal(r.source,"CURRENT_INPUT");assert.equal(r.serverEstimation.unavailableReason,"ASSESSMENT_INCOMPLETE");
    assert.equal(r.serverEstimation.pointMs,null);
   }
  }finally{restore?.();c.close();}
 }
});

test("a technical model failure is explicit on current read and cannot hide a frozen first-start snapshot",async()=>{
 const c=context();try{
  await plannedAtlm(c);
  seedActiveModel(c, "corrupt-model", {}, [PLAN]);
  const before=rows(c),failure=await mcp(c,"GetSavedEstimate",{planId:PLAN});
  assert.equal(failure.value.result.structuredContent.code,"SOURCE_UNAVAILABLE");assert.deepEqual(rows(c),before);
  await ok(c,"StartPlan",{planId:PLAN},0);
  const frozen=value(await mcp(c,"GetSavedEstimate",{planId:PLAN}));
  assert.equal(frozen.source,"FROZEN_INPUT");assert.equal(frozen.serverEstimation.status,"UNAVAILABLE");
  assert.equal(frozen.serverEstimation.pointMs,null);assert.equal(frozen.diagnostics.code,"SOURCE_UNAVAILABLE");
  await ok(c,"PausePlan",{planId:PLAN},1);
  assert.deepEqual(value(await mcp(c,"GetSavedEstimate",{planId:PLAN})).serverEstimation,frozen.serverEstimation);
 }finally{c.close();}
});

test("a pre-reset started plan reports missing history without consulting a broken model",async()=>{
 const c=context();try{
  await plannedAtlm(c);await ok(c,"StartPlan",{planId:PLAN},0);
  c.db.sqlite.exec("DROP TRIGGER atlm_input_no_delete");
  c.db.sqlite.prepare("DELETE FROM plan_estimation_inputs WHERE owner_id=? AND plan_id=?").run(OWNER,PLAN);
  c.db.sqlite.prepare("UPDATE estimation_owner_state SET data_reset_at=? WHERE owner_id=?").run(c.now(),OWNER);
  seedActiveModel(c, "corrupt-model", {}, [PLAN]);
  const before=rows(c),result=value(await mcp(c,"GetSavedEstimate",{planId:PLAN}));
  assert.equal(result.source,"HISTORY_RESET");assert.equal(result.serverEstimation,null);assert.equal(result.forecastAvailability.reason,"HISTORY_RESET");assert.deepEqual(rows(c),before);
 }finally{c.close();}
});



test('read-only MCP and HTTP requests never update owner identity',async()=>{
 const c=context();try{
  await plannedAtlm(c);const before=rows(c),headers={'content-type':'application/json','oai-authenticated-user-id':OWNER,'oai-authenticated-user-email':'changed@example.invalid'};
  for(const name of ['ListModelRevisions','GetDatasetRevision','GetSavedEstimate']){
   const r=await c.worker.fetch(new Request('http://localhost/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:name==='GetSavedEstimate'?{planId:PLAN}:registryArgs('list')}})}),{DB:c.db});assert.equal((await r.json()).result.isError,undefined);
  }
  for(const path of ['/api/tracker/model-revisions?view=list','/api/tracker/model-revisions?view=activations','/api/tracker/plans/'+PLAN+'/estimate']){
   const r=await c.worker.fetch(new Request('http://localhost'+path,{headers}),{DB:c.db});assert.equal(r.status,200);
  }
  assert.deepEqual(rows(c),before);
 }finally{c.close();}
});
