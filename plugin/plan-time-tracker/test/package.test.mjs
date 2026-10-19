import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(pluginRoot, "../..");
const readJson = path => JSON.parse(readFileSync(path, "utf8"));

test("portable package has one manifest with the marketplace identity and existing App connection", () => {
  const manifest = readJson(join(pluginRoot, "plugin.json"));
  const marketplace = readJson(join(repositoryRoot, ".agents/plugins/marketplace.json"));
  const entry = marketplace.plugins.find(plugin => resolve(repositoryRoot, plugin.source.path) === resolve(pluginRoot));
  assert.ok(entry, "marketplace must resolve to this plugin directory");
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(manifest.name, entry.name);
  assert.equal(existsSync(join(pluginRoot, ".codex-plugin")), false);
  const extension = manifest.extensions["com.openai"];
  assert.equal(extension.apps, "./.app.json");
  assert.equal(extension.interface.displayName, "Трекер планов");
  const apps = readJson(join(pluginRoot, extension.apps));
  assert.equal(apps.apps[manifest.name].id, "asdk_app_sites_ae77444ef43481919c2588ef24f70c84");
  assert.ok(existsSync(join(pluginRoot, "skills/track-plan/SKILL.md")));
});

test("runtime package survives a tar roundtrip with one manifest and its App, skill and helpers", () => {
  const directory = mkdtempSync(join(tmpdir(), "tracker-package-"));
  const archive = join(directory, "plugin.tar.gz");
  const unpacked = join(directory, "unpacked");
  const runTar = args => {
    const result = spawnSync("tar", args, { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    runTar(["-czf", archive, "-C", pluginRoot, "plugin.json", ".app.json", "skills", "scripts"]);
    const entries = runTar(["-tzf", archive]).trim().split("\n");
    assert.deepEqual(entries.filter(entry => entry.endsWith("plugin.json")), ["plugin.json"]);
    assert.ok(entries.includes(".app.json"));
    assert.ok(entries.includes("skills/track-plan/SKILL.md"));
    assert.ok(entries.includes("scripts/source-snapshot.mjs"));
    assert.ok(entries.includes("scripts/observation-queue.mjs"));
    assert.ok(entries.every(entry => !entry.split("/").includes(".codex-plugin")));
    mkdirSync(unpacked);
    runTar(["-xzf", archive, "-C", unpacked]);
    const files = readdirSync(unpacked, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
    for (const entry of files) {
      const path = join(entry.parentPath, entry.name);
      assert.deepEqual(readFileSync(path), readFileSync(join(pluginRoot, relative(unpacked, path))));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
