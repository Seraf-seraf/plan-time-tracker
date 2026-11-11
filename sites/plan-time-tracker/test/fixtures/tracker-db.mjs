import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { createWorker, executeCommand } from "../../worker/index.js";
export const OWNER = "source-evidence-owner", PLAN = "11111111-1111-4111-8111-111111111111";
export const DIGEST_A = "sha256:" + "a".repeat(64), DIGEST_B = "sha256:" + "b".repeat(64);
export const source = (digest = DIGEST_A) => ({ kind: "SOURCE_SNAPSHOT", formatVersion: 2, digest });
const directory = new URL("../../drizzle/", import.meta.url);
export const migrations = readdirSync(directory).filter(name => name.endsWith(".sql")).sort();
export const migration = name => readFileSync(new URL(name, directory), "utf8");
class Statement {
  constructor(db, sql, args = []) { Object.assign(this, { db, sql, args }); }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  async run() { return { meta: { changes: Number(this.db.sqlite.prepare(this.sql).run(...this.args).changes) } }; }
  async first() { return this.db.sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: this.db.sqlite.prepare(this.sql).all(...this.args) }; }
}
export function context(until = migrations.length, { databasePath = ":memory:" } = {}) {
  const sqlite = new DatabaseSync(databasePath);
  for (const name of migrations.slice(0, until)) sqlite.exec(migration(name));
  const db = { sqlite, prepare(sql) { return new Statement(this, sql); }, async batch(statements) {
    sqlite.exec("SAVEPOINT d1_batch");
    try {
      const result = statements.map(item => {
        if (!(item instanceof Statement) || item.db !== this) throw new Error("batch statement belongs to another database");
        const statement = sqlite.prepare(item.sql);
        if (statement.columns().length) return { results: statement.all(...item.args), success: true, meta: {} };
        const applied = statement.run(...item.args);
        return { results: [], success: true, meta: { changes: Number(applied.changes), last_row_id: Number(applied.lastInsertRowid) } };
      });
      sqlite.exec("RELEASE d1_batch");
      return result;
    } catch (error) { sqlite.exec("ROLLBACK TO d1_batch; RELEASE d1_batch"); throw error; }
  } };
  let now = 1800000000000;
  const worker = createWorker(() => now);
  return { db, worker, now: () => now, advance: ms => { now += ms; }, close: () => sqlite.close() };
}
export async function call(c, path, body, owner = OWNER, method = body === undefined ? "GET" : "POST") {
  const response = await c.worker.fetch(new Request("http://localhost" + path, {
    method, headers: { "content-type": "application/json", ...(owner ? { "oai-authenticated-user-id": owner } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { DB: c.db });
  return { status: response.status, value: await response.json() };
}
export function envelope(commandType, payload, expectedVersion, commandId = crypto.randomUUID()) {
  return { schemaVersion: 1, commandId, commandType, payload, ...(expectedVersion === undefined ? {} : { expectedVersion }) };
}
export const command = (c, type, payload, version, id, owner) => call(c, "/api/commands", envelope(type, payload, version, id), owner);
export async function ok(c, type, payload, version) {
  const response = await command(c, type, payload, version);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value.result;
}
export async function mcp(c, name, args = {}, owner) {
  return call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, owner);
}
export async function running(c, requiredChecks = ["unit"], planId = PLAN) {
  await ok(c, "CreatePlan", { planId, title: "Source evidence", planCreatedAt: { precision: "dateOnly", on: "2026-10-01", timeZone: "UTC" } });
  const step = await ok(c, "CreateStep", { planId, ordinal: 0, title: "Verify source", expectedResult: "Checked source", requiredChecks });
  await ok(c, "StartPlan", { planId }, 0);
  const claim = await ok(c, "ClaimStepAttempt", { stepId: step.stepId, sessionId: crypto.randomUUID(), sourceId: "fixture" }, 1);
  const lease = { stepId: step.stepId, attemptId: claim.attemptId, fence: claim.fence };
  await ok(c, "StartStep", lease, 1);
  return lease;
}
export async function result(c, lease, digest = DIGEST_A, version = 2) {
  return ok(c, "RecordStepResult", { ...lease, outcome: "DONE", summary: "Synthetic checked result", ...(digest ? { sourceSnapshot: source(digest) } : {}) }, version);
}
export const check = (stepId, status = "PASSED", digest = DIGEST_A, revision = 1, key = "unit") => ({ stepId, resultRevision: revision, checkKey: key, status, testedSnapshotDigest: digest, ...(status === "NOT_RUN" ? {} : { exitCode: status === "PASSED" ? 0 : 1 }) });
export const execution = async c => (await call(c, "/api/tracker/plans/" + PLAN + "/execution")).value;
export function rows(c) {
  const names = c.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  return Object.fromEntries(names.map(name => [name, c.db.sqlite.prepare('SELECT * FROM "' + name + '"').all().map(row => JSON.stringify(row)).sort()]));
}
export const internalCommand = (c, type, payload, version, id) => executeCommand(c.db, { ownerId: OWNER }, envelope(type, payload, version, id), "ui", c.now());

export function atlmTask() {
  return { schemaVersion: "agent-task-v1", profile: { workKind: "MODIFY_MECHANISM", reuseState: "PARTIAL", doneBoundary: "LOCAL_VERIFIED" },
    outcomes: [{ id: "feature", description: "Change existing behavior", evidence: "Synthetic requirement" }], changedContracts: [], verificationKinds: ["UNIT"],
    profileEvidence: { workKind: "Existing behavior changes", reuseState: "Existing mechanism needs modification", doneBoundary: "Local checked result" },
    runtimeContext: { modelId: null, reasoningEffort: null, environmentId: null, plannedParallelAgents: null, provenance: "UNKNOWN" } };
}
export async function atlmAssessment(c, planId = PLAN, task = atlmTask(), overrides = {}) {
  const response = await mcp(c, "GetAssessment", { planId });
  const expectedRequirementsDigest = response.value.result.structuredContent.currentRequirementsDigest;
  return { assessmentId: crypto.randomUUID(), planId, expectedRequirementsDigest, phase: "planning", context: { agentTask: task },
    method: { id: "agent-task-features", version: "1", scale: { schema: "agent-task-v1" } },
    complexity: { status: "UNKNOWN", value: null, rationale: "Descriptive inputs only" }, unknowns: [], assumptions: [], dependencies: [],
    forecast: { status: "UNKNOWN", metric: "PLAN_ACTIVE", lowerMs: null, upperMs: null, confidence: "UNKNOWN", basis: "No model yet", sampleCount: 0 },
    sources: [], approach: { description: "Modify and verify", rationale: "Existing mechanism" }, ...overrides };
}
export async function plannedAtlm(c, planId = PLAN, task = atlmTask()) {
  await ok(c, "CreatePlan", { planId, title: "ATLM synthetic feature", planCreatedAt: { precision: "dateOnly", on: "2027-01-01", timeZone: "UTC" } });
  const step = await ok(c, "CreateStep", { planId, ordinal: 0, title: "Feature", expectedResult: "Checked change", requiredChecks: ["unit"] });
  const assessment = await atlmAssessment(c, planId, task);
  await ok(c, "RecordAssessment", assessment, 0);
  return { step, assessment, planId };
}
export async function completeAtlm(c, planned, elapsed = 1000) {
  await ok(c, "StartPlan", { planId: planned.planId }, 0);
  const claim = await ok(c, "ClaimStepAttempt", { stepId: planned.step.stepId, sessionId: crypto.randomUUID(), sourceId: "fixture" }, 1);
  const lease = { stepId: planned.step.stepId, attemptId: claim.attemptId, fence: claim.fence };
  await ok(c, "StartStep", lease, 1);
  c.advance(elapsed);
  await result(c, lease);
  await ok(c, "RecordCheck", check(lease.stepId));
  await ok(c, "FinishPlan", { planId: planned.planId }, 1);
  return lease;
}
