import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { context, ok, mcp, PLAN } from "./fixtures/tracker-db.mjs";

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

function captureQueries(c, predicate) {
  const queries = [], prepare = c.db.prepare.bind(c.db);
  c.db.prepare = sql => {
    const statement = prepare(sql), bind = statement.bind.bind(statement);
    statement.bind = (...parameters) => {
      if (predicate(sql)) queries.push({ sql, parameters });
      return bind(...parameters);
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

test("CalculateEstimate SQL supports empty and maximum candidate sets within D1 limits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tracker-d1-")), databasePath = join(directory, "tracker.sqlite");
  const c = context(undefined, { databasePath });
  try {
    const digest = await createTarget(c);
    const candidates = [];
    for (let index = 0; index < 20; index++) {
      const planId = `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`;
      candidates.push({ planId, expectedRequirementsDigest: await createTarget(c, planId), profile,
        decision: "DESCRIPTIVE", scopeStability: "STABLE", timeCoverage: "UNKNOWN", rationale: "Boundary regression" });
    }
    const queries = captureQueries(c, sql => sql.startsWith("WITH owner_scope"));
    for (const selected of [[], candidates]) {
      const args = { methodVersion: 1, metric: "PLAN_ACTIVE", referenceCutoffMs: c.now(),
        target: { planId: PLAN, expectedRequirementsDigest: digest, profile }, candidates: selected };
      const response = (await mcp(c, "CalculateEstimate", args)).value.result;
      assert.equal(response.isError, undefined, JSON.stringify(response));
      assert.equal(response.structuredContent.status, "INSUFFICIENT_DATA");
      const query = queries.at(-1), limited = executeLimited(databasePath, query.sql, query.parameters);
      assert.equal(limited.ok, true, JSON.stringify(limited));
      assert.equal(limited.rows.length, selected.length + 1);
      assert.equal(query.parameters.length, selected.length + 2);
    }
    const missing = "99999999-9999-4999-8999-999999999999";
    const response = (await mcp(c, "CalculateEstimate", { methodVersion: 1, metric: "PLAN_ACTIVE", referenceCutoffMs: c.now(),
      target: { planId: missing, expectedRequirementsDigest: digest, profile }, candidates: [] })).value.result;
    assert.equal(response.structuredContent.code, "PLAN_NOT_FOUND");
    const query = queries.at(-1), limited = executeLimited(databasePath, query.sql, query.parameters);
    assert.equal(limited.ok, true, JSON.stringify(limited));
    assert.equal(limited.rows[0].source_available_at, null);
  } finally { c.close(); rmSync(directory, { recursive: true, force: true }); }
});
