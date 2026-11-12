import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { context, call, ok, mcp, result, check, rows, PLAN, DIGEST_A } from "./fixtures/tracker-db.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactRoot = resolve(process.env.SITE_ARTIFACT_ROOT || resolve(projectRoot, "dist"));
const workerPath = resolve(artifactRoot, "server/index.js");

test("built Site artifact imports with tracker UI/read routes", async () => {
  await access(workerPath);
  const source = await readFile(workerPath, "utf8");
  assert.match(source, /GetPlanExecutionSnapshot/);
  assert.doesNotMatch(source, /GetTimeline/);
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

test("built Worker exposes the new MCP names and removes retired tools", async () => {
  const c = context();
  try {
    const built = await import(pathToFileURL(workerPath).href + "?new-mcp-contract");
    c.worker = built.createWorker(c.now);
    const list = (await call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).value.result.tools;
    for (const name of ["EstimatePlanTime", "GetSavedEstimate", "GetTrainingStatus", "StartTraining", "GetTimeReport"]) assert.ok(list.some(t => t.name === name), name);
    for (const name of ["CalculateEstimate", "BlockStep"]) assert.ok(!list.some(t => t.name === name), name);
  } finally { c.close(); }
});
