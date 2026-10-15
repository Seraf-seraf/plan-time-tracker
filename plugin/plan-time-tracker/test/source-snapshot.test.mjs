import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceSnapshot } from "../scripts/source-snapshot.mjs";

test("v2 captures source bytes, names, deletions, modes and symlink targets without version-control tools", () => {
  const root = mkdtempSync(join(tmpdir(), "tracker-source-"));
  try {
    writeFileSync(join(root, "source.txt"), "original");
    const initial = sourceSnapshot(root);
    assert.equal(initial.kind, "SOURCE_SNAPSHOT");
    assert.equal(initial.formatVersion, 2);
    assert.equal(initial.fileCount, 1);
    assert.equal(sourceSnapshot(root).digest, initial.digest);
    writeFileSync(join(root, "source.txt"), "changed");
    const changed = sourceSnapshot(root);
    assert.notEqual(changed.digest, initial.digest);
    writeFileSync(join(root, "new\nfile.txt"), "new source");
    const added = sourceSnapshot(root);
    assert.notEqual(added.digest, changed.digest);
    chmodSync(join(root, "source.txt"), 0o755);
    const executable = sourceSnapshot(root);
    assert.notEqual(executable.digest, added.digest);
    symlinkSync("source.txt", join(root, "source-link"));
    const link = sourceSnapshot(root);
    assert.notEqual(link.digest, executable.digest);
    rmSync(join(root, "source-link"));
    symlinkSync("outside-file", join(root, "source-link"));
    assert.notEqual(sourceSnapshot(root).digest, link.digest);
    rmSync(join(root, "source.txt"));
    assert.notEqual(sourceSnapshot(root).digest, executable.digest);
    assert(!Object.hasOwn(initial, "baseRevisionSha"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("snapshot exclusions are explicit, config bytes are attested, and metadata/dependencies are not scanned", () => {
  const root = mkdtempSync(join(tmpdir(), "tracker-source-exclusions-"));
  try {
    writeFileSync(join(root, "source.js"), "source");
    const initial = sourceSnapshot(root);
    mkdirSync(join(root, ".git"));writeFileSync(join(root, ".git/index"), "untouched metadata");
    mkdirSync(join(root, "node_modules"));writeFileSync(join(root, "node_modules/fixture"), "dependencies");
    writeFileSync(join(root, ".env.local"), "credentials");
    assert.equal(sourceSnapshot(root).digest, initial.digest);
    writeFileSync(join(root, ".gitignore"), "source.js\n");
    const ignoredByGit = sourceSnapshot(root);
    writeFileSync(join(root, "source.js"), "still included in v2");
    assert.notEqual(sourceSnapshot(root).digest, ignoredByGit.digest, "ignore files do not change source scope");
    writeFileSync(join(root, ".tracker-snapshot.json"), JSON.stringify({ exclude: ["runtime"] }));
    const configured = sourceSnapshot(root);
    mkdirSync(join(root, "runtime"));writeFileSync(join(root, "runtime/log"), "runtime output");
    assert.equal(sourceSnapshot(root).digest, configured.digest);
    writeFileSync(join(root, ".tracker-snapshot.json"), JSON.stringify({ exclude: ["runtime", "new-output"] }));
    assert.notEqual(sourceSnapshot(root).digest, configured.digest);
    assert.equal(readFileSync(join(root, ".git/index"), "utf8"), "untouched metadata");
    for (const exclude of [["../outside"], ["/absolute"], [".tracker-snapshot.json"], ["a\\b"]]) {
      writeFileSync(join(root, ".tracker-snapshot.json"), JSON.stringify({ exclude }));
      assert.throws(() => sourceSnapshot(root), /Invalid snapshot exclusion/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("snapshot CLI works with empty PATH and refuses changed contents without leaking paths or source", () => {
  const root = mkdtempSync(join(tmpdir(), "tracker-source-cli-"));
  const script = fileURLToPath(new URL("../scripts/source-snapshot.mjs", import.meta.url));
  try {
    writeFileSync(join(root, "source.txt"), "private source bytes");
    const run = (...args) => spawnSync(process.execPath, [script, root, ...args], { encoding: "utf8", env: { ...process.env, PATH: "" } });
    const first = run(); assert.equal(first.status, 0, first.stderr);
    assert(!first.stdout.includes("private source bytes"));
    const snapshot = JSON.parse(first.stdout);
    assert.equal(run("--expect", snapshot.digest).status, 0);
    writeFileSync(join(root, "source.txt"), "new private source bytes");
    const changed = run("--expect", snapshot.digest);
    assert.equal(changed.status, 1);assert.equal(changed.stdout, "");
    assert.match(changed.stderr, /differs from the tested snapshot/);
    assert(!changed.stderr.includes(root));
    assert.equal(run("--expect", "bad").status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
