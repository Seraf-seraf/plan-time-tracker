import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";

// v2 is independent of version-control tools, indexes, ignore files and revisions.
// The root and exclusion policy are explicit. Symlinks attest their target bytes;
// they are never followed. Configuration bytes are themselves part of the digest.
const OMIT_SEGMENTS = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build", "coverage", ".cache", ".wrangler"]);
const CONFIG = ".tracker-snapshot.json";
function field(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
  hash.update(size).update(bytes);
}
function exclusions(root) {
  let config;
  try {
    if (!lstatSync(resolve(root, CONFIG)).isFile()) throw new Error("Invalid snapshot exclusion configuration.");
    config = JSON.parse(readFileSync(resolve(root, CONFIG), "utf8"));
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (!config || Array.isArray(config) || Object.keys(config).join() !== "exclude" || !Array.isArray(config.exclude) || config.exclude.length > 100) throw new Error("Invalid snapshot exclusion configuration.");
  return config.exclude.map(value => {
    if (typeof value !== "string" || !value || value.includes("\\") || isAbsolute(value) || value.split("/").some(part => !part || part === "." || part === "..") || value === CONFIG) throw new Error("Invalid snapshot exclusion configuration.");
    return value;
  }).sort();
}
function capture(root) {
  const excluded = exclusions(root), entries = [];
  function walk(directory) {
    for (const rawName of readdirSync(directory, { encoding: "buffer" })) {
      const name = rawName.toString("utf8");
      if (!Buffer.from(name).equals(rawName)) throw new Error("Snapshot v2 requires UTF-8 file names.");
      if (OMIT_SEGMENTS.has(name) || name === ".env" || name.startsWith(".env.")) continue;
      const path = resolve(directory, name), local = relative(root, path).split(sep).join("/");
      if (excluded.some(prefix => local === prefix || local.startsWith(prefix + "/"))) continue;
      const info = lstatSync(path);
      if (info.isDirectory()) walk(path);
      else if (info.isFile() || info.isSymbolicLink()) entries.push({ path, local, info });
      else throw new Error("Snapshot v2 does not support special files.");
    }
  }
  walk(root);
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.local), Buffer.from(b.local)));
  const hash = createHash("sha256").update("plan-time-tracker.source.v2\0");
  // The exclusion policy participates even when excluded files are absent.
  field(hash, JSON.stringify(excluded));
  for (const { path, local, info } of entries) {
    field(hash, local);
    field(hash, info.isSymbolicLink() ? "120000" : info.mode & 0o111 ? "100755" : "100644");
    field(hash, createHash("sha256").update(info.isSymbolicLink() ? readlinkSync(path, { encoding: "buffer" }) : readFileSync(path)).digest());
  }
  return { digest: "sha256:" + hash.digest("hex"), fileCount: entries.length };
}
export function sourceSnapshot(directory) {
  const root = realpathSync(directory);
  if (!lstatSync(root).isDirectory()) throw new Error("Snapshot source must be a directory.");
  const first = capture(root), second = capture(root);
  if (first.digest !== second.digest || first.fileCount !== second.fileCount) throw new Error("Source changed during snapshot capture; stop writers before retrying.");
  return { kind: "SOURCE_SNAPSHOT", formatVersion: 2, ...first };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 3 || (args.length > 1 && args[1] !== "--expect") || (args[1] === "--expect" && !/^sha256:[a-f0-9]{64}$/.test(args[2] || ""))) throw new Error("Usage: node source-snapshot.mjs <source-directory> [--expect sha256:64hex]");
    const snapshot = sourceSnapshot(resolve(args[0] || "."));
    if (args[1] === "--expect" && snapshot.digest !== args[2]) throw new Error("Source content differs from the tested snapshot. Do not reuse its checks.");
    console.log(JSON.stringify(snapshot));
  } catch (error) {
    console.error(/^(Usage:|Source content|Source changed|Snapshot v2|Invalid snapshot)/.test(error.message || "") ? error.message : "Unable to capture source snapshot. Check access and source stability.");
    process.exitCode = 1;
  }
}
