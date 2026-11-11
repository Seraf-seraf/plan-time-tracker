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

test("history observation matching stays within a fixed SQLite work budget on a noisy journal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tracker-d1-")), databasePath = join(directory, "tracker.sqlite");
  const c = context(undefined, { databasePath });
  try {
    const lease = await running(c, []);
    const { session_id: sessionId } = c.db.sqlite.prepare("SELECT session_id FROM step_attempts WHERE attempt_id=?").get(lease.attemptId);
    let sequence = c.db.sqlite.prepare("SELECT MAX(server_sequence) AS value FROM tracker_journal WHERE owner_id=?").get(OWNER).value;
    const insert = c.db.sqlite.prepare(`INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,source_id,session_id,
      source_sequence,server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at,classification)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'NORMAL')`);
    const append = (eventType, operationId, occurredAt) => {
      sequence++;
      insert.run(OWNER, `aaaaaaaa-aaaa-4aaa-8aaa-${String(sequence).padStart(12, "0")}`, PLAN, lease.stepId,
        "fixture", sessionId, sequence + 100_000, sequence, eventType,
        JSON.stringify({ data: { operationId, toolName: "test", status: "OK", durationMs: 100 } }),
        "f".repeat(64), occurredAt, c.now());
    };
    c.db.sqlite.exec("BEGIN");
    for (let index = 0; index < 10_000; index++) append("heartbeat", `noise-${index}`, c.now() - 1000);
    for (let index = 0; index < 100; index++) {
      append("tool_started", `operation-${index}`, c.now() - 100);
      append("tool_finished", `operation-${index}`, c.now());
    }
    c.db.sqlite.exec("COMMIT");
    const historyArgs = { targets: [{ planId: PLAN }], from: "2027-01-01", to: "2027-01-31", timeZone: "UTC" };
    const hundred = (await mcp(c, "GetEstimationHistory", historyArgs)).value.result;
    assert.equal(hundred.isError, undefined, JSON.stringify(hundred));
    assert.equal(hundred.structuredContent.facts[0].tools.length, 100);
    assert.equal(hundred.structuredContent.facts[0].truncation.tools, false);
    append("tool_started", "operation-100", c.now() - 100);
    append("tool_finished", "operation-100", c.now());
    const originalPrepare = c.db.prepare;
    const queries = captureQueries(c, sql => sql.includes("AS matching_starts"), true);
    const response = (await mcp(c, "GetEstimationHistory", historyArgs)).value.result;
    assert.equal(response.isError, undefined, JSON.stringify(response));
    assert.equal(queries.length, 1);
    const query = queries[0], limited = executeLimited(databasePath, query.sql, query.parameters, { maxVmSteps: 1_000_000 });
    assert.equal(limited.ok, true, JSON.stringify(limited));
    assert.equal(limited.rows.length, 101);
    assert.ok(limited.rows.every(row => row.matching_starts === 1 && row.matching_finishes === 1 && row.corrected === 0));
    assert.ok(limited.plan.some(line => line.includes("tracker_journal_tool_match")), JSON.stringify(limited.plan));
    assert.ok(limited.plan.some(line => line.includes("tracker_journal_corrections")), JSON.stringify(limited.plan));
    c.db.prepare = originalPrepare;
    const hundredOne = (await mcp(c, "GetEstimationHistory", historyArgs)).value.result;
    assert.equal(hundredOne.isError, undefined, JSON.stringify(hundredOne));
    assert.equal(hundredOne.structuredContent.facts[0].tools.length, 100);
    assert.equal(hundredOne.structuredContent.facts[0].truncation.tools, true);
    assert.ok(hundredOne.structuredContent.facts[0].tools.every(tool => tool.durationMs === 100));
  } finally { c.close(); rmSync(directory, { recursive: true, force: true }); }
});
