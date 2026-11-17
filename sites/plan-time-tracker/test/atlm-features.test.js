import test from "node:test";
import assert from "node:assert/strict";
import { context, command, ok, mcp, legacyAtlmTask, taskV4, atlmAssessment, PLAN } from "./fixtures/tracker-db.mjs";

test("v4 normalizer rejects the retired task schema", async () => {
  const { normalizeAgentTask } = await import("../worker/index.js");
  assert.equal(typeof normalizeAgentTask, "function");
  assert.throws(() => normalizeAgentTask(legacyAtlmTask()), error => error.code === "VALIDATION_ERROR");
});

test("ATLM v4 distinguishes confirmed empty facts from missing facts", async () => {
  const { normalizeAgentTask } = await import("../worker/index.js");
  const input = taskV4();
  const original = structuredClone(input);
  const result = normalizeAgentTask(input);
  assert.deepEqual(input, original);
  assert.deepEqual(result.agentTask.components, []);
  assert.equal(result.agentTask.unfamiliarTechnologies, null);
  assert.equal(result.features.reuseLevel, 2);
  assert.equal(result.features.requiredReviewPasses, 0);
  assert.equal(result.features["workUnits.MODIFY"], 1);
  assert.equal(result.features["components.CREATE"], 0);
  assert.equal(result.features.unfamiliarTechnologies, null);
  assert.equal(result.features["verificationKinds.UNIT"], 1);
  assert.equal(result.features["verificationKinds.UI_E2E"], 0);
  const badDebug = structuredClone(input);
  badDebug.workUnits[0].kind = "DEBUG";
  assert.throws(() => normalizeAgentTask(badDebug), error => error.code === "VALIDATION_ERROR");
  const badMigration = structuredClone(input);
  badMigration.migrationEntities = [{ key: "entity", evidence: "Migration" }];
  assert.throws(() => normalizeAgentTask(badMigration), error => error.code === "VALIDATION_ERROR");
  const duplicates = structuredClone(input);
  duplicates.workUnits.push({ ...duplicates.workUnits[0] });
  assert.equal(normalizeAgentTask(duplicates).features["workUnits.MODIFY"], 1);
  duplicates.workUnits[1].evidence = "Conflicting evidence";
  assert.throws(() => normalizeAgentTask(duplicates), error => error.code === "VALIDATION_ERROR");
  const many = structuredClone(input);
  many.components = Array.from({ length: 101 }, (_, i) => ({ key: `component-${i}`, change: "MODIFY", evidence: "Requirement" }));
  assert.equal(normalizeAgentTask(many).features["components.MODIFY"], 101);
  const knownId = structuredClone(input);
  knownId.execution.modelId = "UNKNOWN";
  knownId.evidence["execution.modelId"] = "Known literal ID";
  delete knownId.unknownReasons["execution.modelId"];
  assert.equal(normalizeAgentTask(knownId).features.modelId, "UNKNOWN");
  const unicode = taskV4(); unicode.evidence.doneBoundary = '😀'.repeat(400);
  assert.equal(normalizeAgentTask(unicode).agentTask.evidence.doneBoundary, unicode.evidence.doneBoundary);
  unicode.evidence.doneBoundary += '😀';
  assert.throws(() => normalizeAgentTask(unicode), error => error.code === "VALIDATION_ERROR");
});

test("v4 preprocessing fits imputation and open categories on the training prefix", async () => {
  const { fitAtlmV4Preprocessor, encodeAtlmV4Features, normalizeAgentTask } = await import("../worker/index.js");
  const base = normalizeAgentTask(taskV4()).features;
  const prefix = [
    { "components.MODIFY": 0, reuseLevel: 1, modelId: "known" },
    { "components.MODIFY": 3, reuseLevel: null, modelId: "known" },
    { "components.MODIFY": null, reuseLevel: 3, modelId: "known" },
    { "components.MODIFY": 1, reuseLevel: 2, modelId: null },
  ].map(row => ({ ...base, ...row }));
  const result = fitAtlmV4Preprocessor(prefix);
  assert.equal(result.status, "AVAILABLE");
  assert.equal(result.manifest.imputations.reuseLevel, 2);
  assert.equal(result.manifest.imputations["components.MODIFY"], Math.log1p(1));
  assert.deepEqual(result.manifest.openCategories.modelId, ["known"]);
  const before = encodeAtlmV4Features({ ...prefix[0], modelId: "unseen" }, result.manifest);
  assert.equal(before.status, "AVAILABLE");
  assert.notDeepEqual(before.row, encodeAtlmV4Features({ ...prefix[0], modelId: null }, result.manifest).row);
  const after = fitAtlmV4Preprocessor([...prefix, { ...prefix[0], modelId: "future" }]);
  assert.deepEqual(encodeAtlmV4Features({ ...prefix[0], modelId: "unseen" }, result.manifest), before);
  assert.notDeepEqual(after.manifest, result.manifest);
  assert.ok(result.manifest.columns.some(column => column.kind === "missing" && column.field === "reuseLevel"));
  const reserved = fitAtlmV4Preprocessor(["OTHER", "OTHER", "OTHER", "UNKNOWN", "UNKNOWN", "UNKNOWN", null].map(modelId => ({ ...base, modelId })));
  assert.deepEqual(reserved.manifest.openCategories.modelId, ["OTHER", "UNKNOWN"]);
  assert.notDeepEqual(encodeAtlmV4Features({ ...base, modelId: "UNKNOWN" }, reserved.manifest).row,
    encodeAtlmV4Features({ ...base, modelId: null }, reserved.manifest).row);
  assert.equal(new Set(reserved.manifest.columns.map(column => column.level)).size, reserved.manifest.columns.length);
  assert.equal(fitAtlmV4Preprocessor([{ modelId: "known" }]).reason, "INVALID_FEATURES");
  assert.equal(encodeAtlmV4Features(base, { formatVersion: 1, fields: Object.keys(base), columns: [{ kind: "category", field: "modelId" }] }).reason, "INVALID_ARTIFACT");
  const reordered = structuredClone(result.manifest);
  [reordered.columns[0], reordered.columns[1]] = [reordered.columns[1], reordered.columns[0]];
  assert.equal(encodeAtlmV4Features(base, reordered).reason, "INVALID_ARTIFACT");
});

test("v4 OLS and ridge use the full feature manifest and log1p target", async () => {
  const { fitAtlmV4Regression, predictAtlmV4Regression, predictAtlmOls, predictAtlmRidge, fitHybridAtlm, predictHybridAtlm, normalizeAgentTask } = await import("../worker/index.js");
  const base = normalizeAgentTask(taskV4()).features;
  const rows = [0, 1, 3].map((value, index) => ({
    sampleId: `sample-${index}`, planId: `plan-${index}`, capturedAt: index * 2,
    sourceAvailableAt: index * 2 + 1, features: { ...base, "components.MODIFY": value }, actualMs: value * 60000,
  }));
  const ols = await fitAtlmV4Regression(rows, "OLS");
  assert.equal(ols.status, "AVAILABLE");
  assert.equal(predictAtlmV4Regression(ols.artifact, rows[1].features).pointMs, 60000);
  const expectedFields = [
    ...['CREATE','MODIFY','DEBUG','REFACTOR','MIGRATE','VERIFY','ANALYZE','OPERATE'].map(kind => `workUnits.${kind}`),
    'doneBoundary', 'reuseLevel', ...['CREATE','MODIFY','REMOVE'].map(kind => `components.${kind}`),
    ...['API','MCP','EVENT','STORAGE','UI','CONFIG','BREAKING','REMOVE'].map(kind => `contracts.${kind}`),
    ...['USE','CHANGE','ADD'].map(kind => `integrations.${kind}`), 'migrationEntities', 'dataVolumeBand',
    'requirementsUncertainty', 'solutionUncertainty', 'diagnosisState', 'unfamiliarTechnologies', 'scopeChangeRisk',
    ...['BUILD_STATIC','UNIT','INTEGRATION','UI_E2E','DEPLOY_SMOKE'].map(kind => `verificationKinds.${kind}`),
    'verificationScenarios', 'verificationReadiness', 'requiredReviewPasses', 'environmentReadiness', 'accessReadiness',
    'deploymentTargets', 'mode', 'modelId', 'reasoningEffort', 'environmentId', 'plannedParallelAgents', 'codebaseFamiliarity',
  ].sort();
  assert.deepEqual(ols.artifact.preprocessor.fields, expectedFields);
  const represented = new Set([...ols.artifact.preprocessor.columns, ...ols.artifact.preprocessor.droppedColumns].map(column => column.field));
  for (const field of expectedFields) assert.ok(represented.has(field), field);
  const ridge = await fitAtlmV4Regression(rows, "RIDGE");
  assert.equal(ridge.status, "AVAILABLE");
  assert.equal(predictAtlmV4Regression(ridge.artifact, rows[0].features).status, "AVAILABLE");
  const logs = [0, Math.log(2), Math.log(4)], mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const variance = logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / logs.length;
  const expected = Math.round(Math.expm1(mean + variance / (variance + 1) * (logs[1] - mean)) * 60000);
  assert.equal(predictAtlmV4Regression(ridge.artifact, rows[1].features).pointMs, expected);
  assert.equal((await fitAtlmV4Regression([{ ...rows[0], features: { modelId: "partial" } }], "RIDGE")).reason, "INVALID_FEATURES");
  const corrupt = structuredClone(ridge.artifact);
  corrupt.preprocessor.imputations["components.MODIFY"] = -1;
  assert.equal(predictAtlmV4Regression(corrupt, rows[0].features).reason, "INVALID_ARTIFACT");
  const hybrid = await fitHybridAtlm(rows);
  assert.equal(hybrid.status, "AVAILABLE", JSON.stringify(hybrid));
  assert.equal(predictHybridAtlm(hybrid.artifact, rows[1].features).status, "AVAILABLE");
  assert.equal(predictAtlmOls(ridge.artifact, rows[1].features).reason, "INVALID_ARTIFACT");
  assert.equal(predictAtlmRidge(ols.artifact, rows[1].features).reason, "INVALID_ARTIFACT");
  const swapped = structuredClone(hybrid.artifact);
  swapped.candidates.ridge.artifact = swapped.candidates.ols.artifact;
  assert.equal(predictHybridAtlm(swapped, rows[1].features).reason, "INVALID_ARTIFACT");
});

test("MCP accepts a v4 task for a planned assessment", async () => {
  const c = context();
  try {
    await ok(c, "CreatePlan", { planId: PLAN, title: "ATLM v4", planText: "# ATLM v4\n\n## Этап 1. Проверка\nИзменение", planCreatedAt: { precision: "dateOnly", on: "2027-01-01", timeZone: "UTC" } });
    const response = await command(c, "RecordAssessment", await atlmAssessment(c, PLAN, taskV4(), { predictionRequest: { method: "ATLM", methodVersion: 1 } }), 0);
    assert.equal(response.status, 200, JSON.stringify(response.value));
    const old = await command(c, "RecordAssessment", await atlmAssessment(c, PLAN, legacyAtlmTask()), 0);
    assert.equal(old.status, 400);
    const digest = (await mcp(c, "GetAssessment", { planId: PLAN })).value.result.structuredContent.currentRequirementsDigest;
    const estimate = await mcp(c, "EstimatePlanTime", { planId: PLAN, expectedRequirementsDigest: digest, agentTask: taskV4() });
    assert.equal(estimate.value.result.isError, undefined, JSON.stringify(estimate.value));
    const incomplete = taskV4(); incomplete.workUnits = null; incomplete.unknownReasons.workUnits = "Results not specified";
    const missing = await mcp(c, "EstimatePlanTime", { planId: PLAN, expectedRequirementsDigest: digest, agentTask: incomplete });
    assert.equal(missing.value.result.structuredContent.unavailableReason, "MISSING_REQUIRED_FEATURES");
  } finally { c.close(); }
});

test("v4 assessment stores normalized facts and keeps receipt identity", async () => {
  const c = context();
  try {
    await ok(c, "CreatePlan", { planId: PLAN, title: "ATLM v4", planText: "# ATLM v4\n\n## Этап 1. Проверка\nИзменение", planCreatedAt: { precision: "dateOnly", on: "2027-01-01", timeZone: "UTC" } });
    const task = taskV4();
    task.workUnits.push({ ...task.workUnits[0] });
    const assessment = await atlmAssessment(c, PLAN, task);
    const commandId = crypto.randomUUID();
    const first = await command(c, "RecordAssessment", assessment, 0, commandId);
    const retry = await command(c, "RecordAssessment", assessment, 0, commandId);
    assert.equal(first.status, 200); assert.equal(retry.value.replayed, true);
    const read = (await mcp(c, "GetAssessment", { planId: PLAN, assessmentId: assessment.assessmentId })).value.result.structuredContent;
    assert.equal(read.assessment.context.agentTask.workUnits.length, 1);
    const invalid = taskV4(); invalid.count = 42;
    assert.equal((await command(c, "RecordAssessment", await atlmAssessment(c, PLAN, invalid), 0)).status, 400);
    assert.equal(c.db.sqlite.prepare("SELECT first_started_at FROM plans WHERE plan_id=?").get(PLAN).first_started_at, null);
  } finally { c.close(); }
});

test("v4 environmentId is a closed enum and missing is explicit", async () => {
  const { normalizeAgentTask } = await import("../worker/index.js");
  for (const value of ["local", "cloud_workspace", null]) {
    const task = taskV4(); task.execution.environmentId = value;
    if (value === null) task.unknownReasons["execution.environmentId"] = "Not known";
    assert.equal(normalizeAgentTask(task).agentTask.execution.environmentId, value);
  }
  for (const value of ["UNKNOWN", "local workspace", " local ", "", { name: "local" }]) {
    const task = taskV4(); task.execution.environmentId = value;
    assert.throws(() => normalizeAgentTask(task), error => error.code === "VALIDATION_ERROR");
  }
});
