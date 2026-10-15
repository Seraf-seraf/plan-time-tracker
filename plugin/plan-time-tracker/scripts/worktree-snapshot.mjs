import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// v1: all tracked and non-ignored untracked paths, raw path bytes in byte-sorted order,
// file kind/mode and SHA-256 of current file bytes (or symlink target bytes).
// Missing tracked paths are absent. Index/staging state and HEAD are
// not contents. Ignored dependencies, build outputs and runtime state are outside
// this source snapshot and must be described separately in check evidence.
function git(cwd, args) {
  return execFileSync("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}
function paths(buffer) {
  const values = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) if (buffer[i] === 0) { if (i > start) values.push(buffer.subarray(start, i)); start = i + 1; }
  return values;
}
function field(hash, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(buffer.length);
  hash.update(length).update(buffer);
}
function capture(root) {
  const entries = paths(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]));
  const unique = [...new Map(entries.map(path => [path.toString("hex"), path])).values()].sort(Buffer.compare);
  const hash = createHash("sha256").update("plan-time-tracker.worktree.v1\0");
  let fileCount = 0;
  for (const name of unique) {
    const file = Buffer.concat([Buffer.from(root + "/"), name]);
    let info;
    try { info = lstatSync(file); } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
    if (!info) continue;
    field(hash, name);
    fileCount++;
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error("Snapshot v1 does not support directories, submodules or special files in the source path set.");
    field(hash, info.isSymbolicLink() ? "120000" : info.mode & 0o111 ? "100755" : "100644");
    const bytes = info.isSymbolicLink() ? readlinkSync(file, { encoding: "buffer" }) : readFileSync(file);
    field(hash, createHash("sha256").update(bytes).digest());
  }
  return { digest: "sha256:" + hash.digest("hex"), fileCount };
}
export function worktreeSnapshot(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).toString().replace(/\r?\n$/, "");
  let baseRevisionSha;
  try { baseRevisionSha = git(root, ["rev-parse", "--verify", "HEAD"]).toString().trim(); } catch { /* An unborn repository is supported. */ }
  const first = capture(root), second = capture(root);
  if (first.digest !== second.digest || first.fileCount !== second.fileCount) throw new Error("Source changed during snapshot capture; retry only after stopping writers.");
  return { kind: "WORKTREE_SNAPSHOT", formatVersion: 1, ...first, ...(baseRevisionSha ? { baseRevisionSha } : {}) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 3 || (args.length > 1 && args[1] !== "--expect") || (args[1] === "--expect" && !/^sha256:[a-f0-9]{64}$/.test(args[2] || ""))) throw new Error("Usage: node worktree-snapshot.mjs <repository-path> [--expect sha256:64hex]");
    const snapshot = worktreeSnapshot(resolve(args[0] || "."));
    if (args[1] === "--expect" && snapshot.digest !== args[2]) throw new Error("Worktree content differs from the tested snapshot. Do not reuse its checks.");
    console.log(JSON.stringify(snapshot));
  } catch (error) {
    // Never print file paths, source content, Git stderr or credentials.
    console.error(error.message?.startsWith("Usage:") || error.message?.startsWith("Worktree content") || error.message?.startsWith("Source changed") || error.message?.startsWith("Snapshot v1") ? error.message : "Unable to capture source snapshot. Check repository access and source stability.");
    process.exitCode = 1;
  }
}
