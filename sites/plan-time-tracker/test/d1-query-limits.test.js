import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { context, ok, mcp, running, PLAN, OWNER } from "./fixtures/tracker-db.mjs";

const profile = { workKind: "VERIFY_EXISTING", reuseState: "READY", doneBoundary: "ANALYSIS" };
const createdAt = { precision: "dateOnly", on: "2027-01-01", timeZone: "UTC" };
const sqliteRunner = fileURLToPath(new URL("./fixtures/sqlite-d1.py", import.meta.url));

function executeLimited(databasePath, sql, parameters = [], options = {}) {
  const result = spawnSync("python3", [sqliteRunner], {
    input: JSON.stringify({ databasePath, sql, parameters, ...options }), encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return JSON.parse(result.stdout);
}

function captureQueries(c, predicate, skipExecution = false) {
  const queries = [], prepare = c.db.prepare.bind(c.db);
  c.db.prepare = sql => {
    const statement = prepare(sql), bind = statement.bind.bind(statement);
    statement.bind = (...parameters) => {
      const selected = predicate(sql), bound = bind(...parameters);
      if (selected) {
        queries.push({ sql, parameters });
        if (skipExecution) bound.all = async () => ({ results: [] });
      }
      return bound;
    };
    return statement;
  };
  return queries;
}

async function createTarget(c, planId = PLAN) {
  await ok(c, "CreatePlan", { planId, title: "D1 query regression", planCreatedAt: createdAt });
  return (await mcp(c, "GetAssessment", { planId })).value.result.structuredContent.currentRequirementsDigest;
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
