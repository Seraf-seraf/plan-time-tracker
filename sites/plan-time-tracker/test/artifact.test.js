import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
