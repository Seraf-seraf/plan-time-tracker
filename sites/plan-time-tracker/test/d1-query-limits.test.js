import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "./fixtures/tracker-db.mjs";

const sqliteRunner = fileURLToPath(new URL("./fixtures/sqlite-d1.py", import.meta.url));

function executeLimited(databasePath, sql, parameters = [], options = {}) {
  const result = spawnSync("python3", [sqliteRunner], {
    input: JSON.stringify({ databasePath, sql, parameters, ...options }), encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return JSON.parse(result.stdout);
}

test("real SQLite rejects a six-term compound SELECT under the D1 test limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "tracker-d1-")), databasePath = join(directory, "tracker.sqlite");
  const c = context(undefined, { databasePath });
  try {
    const result = executeLimited(databasePath, Array(6).fill("SELECT 1 AS value").join(" UNION ALL "));
    assert.equal(result.ok, false);
    assert.match(result.error, /too many terms in compound SELECT/);
  } finally { c.close(); rmSync(directory, { recursive: true, force: true }); }
});
