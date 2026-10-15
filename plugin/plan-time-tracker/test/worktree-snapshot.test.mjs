import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { worktreeSnapshot } from "../scripts/worktree-snapshot.mjs";

test("worktree digest covers unstaged, staged, untracked, deleted, modes and symlink targets without creating commits", () => {
  const root = mkdtempSync(join(tmpdir(), "tracker-snapshot-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", "--quiet");
    writeFileSync(join(root, ".gitignore"), "ignored\n");
    writeFileSync(join(root, "source.txt"), "original");
    git("add", ".");
    const initial = worktreeSnapshot(root);
    assert.equal(initial.kind, "WORKTREE_SNAPSHOT");
    assert.equal(initial.baseRevisionSha, undefined, "no commit required in an unborn repo");
    assert.match(initial.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(worktreeSnapshot(root).digest, initial.digest);
    writeFileSync(join(root, "ignored"), "ignored runtime state");
    assert.equal(worktreeSnapshot(root).digest, initial.digest);
    const index = readFileSync(join(root, ".git/index"));
    writeFileSync(join(root, "source.txt"), "changed");
    const unstaged = worktreeSnapshot(root);
    assert.notEqual(unstaged.digest, initial.digest);
    assert.deepEqual(readFileSync(join(root, ".git/index")), index, "capture never stages or changes the index");
    git("add", "source.txt");
    assert.equal(worktreeSnapshot(root).digest, unstaged.digest, "staging does not change actual source contents");
    writeFileSync(join(root, "new\nfile.txt"), "untracked input");
    const untracked = worktreeSnapshot(root);
    assert.notEqual(untracked.digest, unstaged.digest);
    chmodSync(join(root, "source.txt"), 0o755);
    const executable = worktreeSnapshot(root);
    assert.notEqual(executable.digest, untracked.digest);
    symlinkSync("source.txt", join(root, "source-link"));
    const link = worktreeSnapshot(root);
    assert.notEqual(link.digest, executable.digest);
    rmSync(join(root, "source-link"));
    symlinkSync("elsewhere", join(root, "source-link"));
    assert.notEqual(worktreeSnapshot(root).digest, link.digest);
    rmSync(join(root, "source.txt"));
    const deleted = worktreeSnapshot(root);
    assert.notEqual(deleted.digest, executable.digest);
    git("add", "-u");
    assert.equal(worktreeSnapshot(root).digest, deleted.digest, "staging a deletion does not change source contents");
    assert.equal(git("rev-list", "--all").toString(), "", "helper creates no commit");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("snapshot CLI verifies the same source and refuses changed content with sanitized output", () => {
  const root = mkdtempSync(join(tmpdir(), "tracker-snapshot-cli-"));
  const script = fileURLToPath(new URL("../scripts/worktree-snapshot.mjs", import.meta.url));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    writeFileSync(join(root, "source.txt"), "private source bytes");
    const run = (...args) => spawnSync(process.execPath, [script, root, ...args], { encoding: "utf8" });
    const first = run();
    assert.equal(first.status, 0);
    assert(!first.stdout.includes("private source bytes"));
    const snapshot = JSON.parse(first.stdout);
    assert.equal(run("--expect", snapshot.digest).status, 0);
    writeFileSync(join(root, "source.txt"), "new private source bytes");
    const changed = run("--expect", snapshot.digest);
    assert.equal(changed.status, 1);
    assert.equal(changed.stdout, "");
    assert.match(changed.stderr, /differs from the tested snapshot/);
    assert(!changed.stderr.includes(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
