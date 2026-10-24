import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { context, ok, mcp, PLAN } from "./fixtures/tracker-db.mjs";

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
