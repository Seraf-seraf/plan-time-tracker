import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { context, call, ok, mcp, result, check, rows, PLAN, DIGEST_A } from "./fixtures/tracker-db.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactRoot = resolve(projectRoot, "dist");
const workerPath = resolve(artifactRoot, "server/index.js");
const hostingPath = resolve(artifactRoot, ".openai/hosting.json");

test("built Site artifact imports with its hosting manifest and tracker UI/read routes", async () => {
  await Promise.all([access(workerPath), access(hostingPath)]);
  const [source, manifestSource] = await Promise.all([readFile(workerPath, "utf8"), readFile(hostingPath, "utf8")]);
  const manifest = JSON.parse(manifestSource);
  assert.equal(manifest.d1, "DB");
  assert.match(source, /GetPlanExecutionSnapshot/);
  assert.match(source, /GetTimeline/);
  assert.match(source, /UI_TRACKER/);
  const relativeImports = [...source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g)].map((match) => match[1]);
  for (const specifier of relativeImports) await access(resolve(artifactRoot, "server", specifier));
  const workerModule = await import(pathToFileURL(workerPath).href + "?artifact-test");
  assert.equal(typeof workerModule.default?.fetch, "function");
});

test("packaged UI includes licensed local font bytes and allows them in its CSP", async () => {
  const built = await import(pathToFileURL(workerPath).href + "?font-entrypoint");
  const response = await built.default.fetch(new Request("http://localhost/", { headers: { "oai-authenticated-user-id": "font-test" } }), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /font-src data:/);
  const html = await response.text();
  for (const name of ["host-grotesk", "atkinson-hyperlegible-mono"]) {
    for (const subset of ["latin", "latin-ext"]) {
      const bytes = await readFile(resolve(projectRoot, `assets/fonts/${name}-${subset}.woff2`));
      assert.ok(html.includes(bytes.toString("base64")), `${name} ${subset} is included in the actual Worker response`);
    }
    assert.match(await readFile(resolve(projectRoot, `assets/fonts/${name}-OFL.txt`), "utf8"), /SIL OPEN FONT LICENSE/i);
  }
});

test("packaged Worker executes the neutral assessment path with the declared runtime entrypoint", async () => {
  const c = context();
  try {
    const built = await import(pathToFileURL(workerPath).href + "?assessment-entrypoint");
    c.worker = built.createWorker(c.now);
    await ok(c, "CreatePlan", { planId: PLAN, title: "Packaged assessment", planCreatedAt: { precision: "dateOnly", on: "2027-01-01", timeZone: "UTC" } });
    const assessmentId = crypto.randomUUID();
    const context = (await mcp(c, "GetAssessment", { planId: PLAN })).value.result.structuredContent;
    await ok(c, "RecordAssessment", { assessmentId, planId: PLAN, expectedRequirementsDigest: context.currentRequirementsDigest, phase: "planning", context: { result: "Packaged runtime" },
      method: { id: "qualitative", version: "1", scale: ["small", "large"] },
      complexity: { status: "UNKNOWN", value: null, rationale: "Research pending" }, unknowns: [], assumptions: [], dependencies: [], sources: [],
      forecast: { status: "UNKNOWN", metric: "PLAN_ACTIVE", lowerMs: null, upperMs: null, confidence: "UNKNOWN", basis: "No history", sampleCount: 0 },
      approach: { description: "Research", rationale: "Resolve uncertainty" } }, 0);
    const response = await mcp(c, "GetAssessment", { planId: PLAN, assessmentId });
    assert.equal(response.value.result.structuredContent.assessment.method.id, "qualitative");
    assert.equal(response.value.result.structuredContent.revision, 1);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) n FROM work_intervals").get().n, 0);
  } finally { c.close(); }
});

test("built Worker exposes read-only CalculateEstimate and stores its snapshot only through RecordAssessment", async () => {
  const c = context();
  try {
    const built = await import(pathToFileURL(workerPath).href + "?calculator-entrypoint");
    c.worker = built.createWorker(c.now);

    const discovery = await call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tool = discovery.value.result.tools.find((item) => item.name === "CalculateEstimate");
    assert.ok(tool, "the built artifact lists CalculateEstimate");
    assert.equal(tool.annotations?.readOnlyHint, true);

    await ok(c, "CreatePlan", { planId: PLAN, title: "Проверка собранного калькулятора", planCreatedAt: { precision: "dateOnly", on: "2027-01-01", timeZone: "UTC" } });
    const sourcePlanId = "22222222-2222-4222-8222-222222222222";
    await ok(c, "CreatePlan", { planId: sourcePlanId, title: "Готовый сопоставимый процесс", planCreatedAt: { precision: "dateOnly", on: "2027-01-01", timeZone: "UTC" } });
    const sourceStep = await ok(c, "CreateStep", { planId: sourcePlanId, ordinal: 0, title: "Выполнить процесс", expectedResult: "Проверенный результат", requiredChecks: ["unit"] });
    await ok(c, "StartPlan", { planId: sourcePlanId }, 0);
    const claim = await ok(c, "ClaimStepAttempt", { stepId: sourceStep.stepId, sessionId: crypto.randomUUID(), sourceId: "artifact-estimate-test" }, 1);
    const lease = { stepId: sourceStep.stepId, attemptId: claim.attemptId, fence: claim.fence };
    await ok(c, "StartStep", lease, 1);
    c.advance(60_000);
    await result(c, lease, DIGEST_A, 2);
    await ok(c, "RecordCheck", check(sourceStep.stepId));
    await ok(c, "FinishPlan", { planId: sourcePlanId }, 1);
    c.advance(1);

    const profile = { workKind: "RUN_EXISTING_PROCESS", reuseState: "READY", doneBoundary: "LOCAL_VERIFIED" };
    const targetContext = (await mcp(c, "GetAssessment", { planId: PLAN })).value.result.structuredContent;
    const sourceContext = (await mcp(c, "GetAssessment", { planId: sourcePlanId })).value.result.structuredContent;
    const calculateArgs = {
      methodVersion: 1,
      metric: "PLAN_ACTIVE",
      referenceCutoffMs: c.now(),
      target: { planId: PLAN, expectedRequirementsDigest: targetContext.currentRequirementsDigest, profile },
      candidates: [{
        planId: sourcePlanId,
        expectedRequirementsDigest: sourceContext.currentRequirementsDigest,
        profile,
        decision: "INCLUDE",
        scopeStability: "STABLE",
        timeCoverage: "COMPLETE",
        rationale: "Полный результат, условия и проверки совпадают",
      }],
    };
    const beforeCalculation = rows(c);
    const calculatedResponse = await mcp(c, "CalculateEstimate", calculateArgs);
    assert.equal(calculatedResponse.value.result.isError, undefined, JSON.stringify(calculatedResponse.value));
    const calculated = calculatedResponse.value.result.structuredContent;
    assert.equal(calculated.status, "AVAILABLE");
    assert.equal(calculated.pointMs, 60_000);
    assert.equal(calculated.sampleCount, 1);
    assert.deepEqual(rows(c), beforeCalculation, "CalculateEstimate does not mutate subject or tracker tables");

    const estimation = {
      formatVersion: 1,
      baseline: {
        method: calculated.method,
        metric: calculated.metric,
        estimand: calculated.estimand,
        status: calculated.status,
        referenceKind: calculated.referenceKind,
        pointMs: calculated.pointMs,
        observedRange: calculated.observedRange,
        sampleCount: calculated.sampleCount,
        accuracy: calculated.accuracy,
        intervalCoverage: calculated.intervalCoverage,
      },
      inputSnapshot: calculated.inputSnapshot,
      calculationDigest: calculated.calculationDigest,
      expertAdjustment: null,
      forecastScope: "FULL",
    };
    const assessmentId = crypto.randomUUID();
    const assessment = {
      assessmentId,
      planId: PLAN,
      expectedRequirementsDigest: targetContext.currentRequirementsDigest,
      phase: "planning",
      context: { expectedResult: "Проверенный план", scope: "Весь план", checks: ["unit"], estimation },
      method: { id: "reference-class-median", version: "1", scale: { unit: "PLAN_ACTIVE milliseconds", estimand: "ACCEPTED_UNCHANGED_SCOPE" } },
      complexity: { status: "UNKNOWN", value: null, rationale: "Сложность отдельно не классифицирована" },
      unknowns: [], assumptions: [], dependencies: [], sources: [{ planId: sourcePlanId }],
      forecast: {
        status: "UNKNOWN", metric: "PLAN_ACTIVE", lowerMs: null, upperMs: null, confidence: "UNKNOWN",
        basis: "Точечный исторический ориентир находится в context.estimation.baseline.pointMs; интервал не установлен.",
        sampleCount: calculated.sampleCount,
      },
      approach: { description: "Использовать исторический ориентир", rationale: "Сохранить его снимок и источник" },
    };
    const beforeRecord = rows(c);
    await ok(c, "RecordAssessment", assessment, 0);
    const afterRecord = rows(c);
    assert.deepEqual(afterRecord.plans, beforeRecord.plans);
    assert.deepEqual(afterRecord.plan_steps, beforeRecord.plan_steps);
    assert.deepEqual(afterRecord.work_intervals, beforeRecord.work_intervals);
    assert.deepEqual(afterRecord.step_attempts, beforeRecord.step_attempts);
    assert.notDeepEqual(afterRecord.assessment_revisions, beforeRecord.assessment_revisions);

    const read = await mcp(c, "GetAssessment", { planId: PLAN, assessmentId });
    assert.equal(read.value.result.isError, undefined, JSON.stringify(read.value));
    assert.deepEqual(read.value.result.structuredContent.assessment.context.estimation, estimation);
    assert.equal(read.value.result.structuredContent.assessment.forecast.status, "UNKNOWN");
    assert.equal(read.value.result.structuredContent.assessment.forecast.sampleCount, 1);
  } finally { c.close(); }
});
