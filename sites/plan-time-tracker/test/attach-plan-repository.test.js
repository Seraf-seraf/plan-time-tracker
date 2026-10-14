import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker } from "../worker/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const migrationsDir = resolve(root, "drizzle");
const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const OWNER = "attach-owner";
const OTHER_OWNER = "foreign-owner";
const PLAN = "11111111-1111-4111-8111-111111111111";
const SESSION = "33333333-3333-4333-8333-333333333333";
const REPO = "repo-public-1";
const SHA = "a".repeat(40);
let commandNumber = 0;
const id = () => `d0000000-0000-4000-8000-${String(++commandNumber).padStart(12, "0")}`;

class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  async run() { return { meta: { changes: Number(this.db.sqlite.prepare(this.sql).run(...this.args).changes) } }; }
  async first() { return this.db.sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: this.db.sqlite.prepare(this.sql).all(...this.args) }; }
}
class TestDatabase {
  constructor(until = migrations.length) {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(migrations.slice(0, until).map((name) => readFileSync(resolve(migrationsDir, name), "utf8")).join("\n"));
  }
  prepare(sql) { return new Statement(this, sql); }
}
function context(until) {
  const db = new TestDatabase(until);
  let now = 1800000000000;
  const worker = createWorker(() => now);
  return { db, worker, now: () => now, setNow: (value) => { now = value; } };
}
async function post(c, commandType, payload, expectedVersion, ownerId = OWNER, commandId = id(), path = "/api/commands") {
  const envelope = { schemaVersion: 1, commandId, commandType, payload };
  if (expectedVersion !== undefined) envelope.expectedVersion = expectedVersion;
  const response = await c.worker.fetch(new Request("https://tracker.test" + path, {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-id": ownerId },
    body: JSON.stringify(path === "/mcp" ? { jsonrpc: "2.0", id: commandNumber, method: "tools/call", params: { name: commandType, arguments: envelope } } : envelope),
  }), { DB: c.db });
  const body = await response.json();
  if (path === "/mcp" && body.result?.structuredContent) return { status: response.status, body: body.result.structuredContent, raw: body };
  if (path === "/mcp" && body.result?.isError) return { status: response.status, body: body.result.structuredContent, raw: body };
  return { status: response.status, body, raw: body };
}
async function createPlan(c) {
  const result = await post(c, "CreatePlan", { planId: PLAN, title: "Acceptance recovery", planCreatedAt: { precision: "dateOnly", on: "2026-10-01", timeZone: "Asia/Omsk" } });
  assert.equal(result.status, 200);
  return result;
}
function seedRepository(db, ownerId, repositoryId, accessState = "available") {
  const sqlite = db.sqlite;
  sqlite.prepare("INSERT OR IGNORE INTO owners(owner_id,created_at) VALUES(?,?)").run(ownerId, 1800000000000);
  sqlite.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,0,'main',?,0,?)")
    .run(ownerId, repositoryId, ownerId + "/" + repositoryId, accessState, 1800000000000);
}
async function startPlanAndStep(c, requiredChecks = ["unit"]) {
  await createPlan(c);
  const step = await post(c, "CreateStep", { planId: PLAN, ordinal: 0, title: "Record and verify", expectedResult: "Persist a result then record its required check", requiredChecks, commitPolicy: "NEVER", pushPolicy: "NEVER" });
  assert.equal(step.status, 200);
  const stepId = step.body.result.stepId;
  const startedPlan = await post(c, "StartPlan", { planId: PLAN }, 0);
  assert.equal(startedPlan.status, 200);
  return { stepId, planVersion: startedPlan.body.result.version };
}
async function claim(c, stepId, expectedVersion, sessionId = SESSION) {
  return post(c, "ClaimStepAttempt", { stepId, sessionId, sourceId: "acceptance-fixture", clientType: "LOCAL" }, expectedVersion);
}
async function startAttempt(c, stepId, expectedVersion, attempt) {
  return post(c, "StartStep", { stepId, attemptId: attempt.attemptId, fence: attempt.fence }, expectedVersion);
}
async function closeAttempt(c, stepId, attempt, disposition = "ABANDONED") {
  return post(c, "CloseStepAttempt", { stepId, attemptId: attempt.attemptId, fence: attempt.fence, disposition, reason: "Safe local recovery fixture" });
}
async function result(c, stepId, attempt, expectedVersion, repositoryId = REPO, commandId = id()) {
  return post(c, "RecordStepResult", { stepId, attemptId: attempt.attemptId, fence: attempt.fence, outcome: "DONE", summary: "Validated result", repositoryId, revisionSha: SHA }, expectedVersion, OWNER, commandId);
}

test("AttachPlanRepository atomically binds an owned available repository and replays idempotently", async () => {
  const c = context(); await createPlan(c); seedRepository(c.db, OWNER, REPO);
  const before = c.db.sqlite.prepare("SELECT status,version,first_started_at,finished_at FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN);
  const intervals = c.db.sqlite.prepare("SELECT * FROM work_intervals WHERE owner_id=? AND plan_id=?").all(OWNER, PLAN);
  const commandId = id(), payload = { planId: PLAN, repositoryId: REPO };
  const first = await post(c, "AttachPlanRepository", payload, 0, OWNER, commandId);
  assert.equal(first.status, 200); assert.equal(first.body.result.version, 1);
  assert.deepEqual({ ...c.db.sqlite.prepare("SELECT selected_ref,fixed_at FROM plan_repositories WHERE owner_id=? AND plan_id=? AND repository_id=?").get(OWNER, PLAN, REPO) }, { selected_ref: "main", fixed_at: null });
  assert.equal(c.db.sqlite.prepare("SELECT event_type,version_before,version_after FROM plan_events WHERE owner_id=? AND command_id=?").get(OWNER, commandId).event_type, "REPOSITORY_ATTACHED");
  assert.deepEqual({ ...c.db.sqlite.prepare("SELECT status,version,first_started_at,finished_at FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN) }, { ...before, version: 1 });
  assert.deepEqual(c.db.sqlite.prepare("SELECT * FROM work_intervals WHERE owner_id=? AND plan_id=?").all(OWNER, PLAN), intervals);
  const after = c.db.sqlite.prepare("SELECT * FROM plan_repositories WHERE owner_id=? AND plan_id=?").all(OWNER, PLAN);
  const replay = await post(c, "AttachPlanRepository", payload, 0, OWNER, commandId);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.deepEqual(replay.body.result, first.body.result);
  assert.deepEqual(c.db.sqlite.prepare("SELECT * FROM plan_repositories WHERE owner_id=? AND plan_id=?").all(OWNER, PLAN), after);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM plan_events WHERE owner_id=? AND plan_id=? AND event_type='REPOSITORY_ATTACHED'").get(OWNER, PLAN).n, 1);
  const collision = await post(c, "AttachPlanRepository", { planId: PLAN, repositoryId: "different" }, 0, OWNER, commandId);
  assert.equal(collision.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  const duplicate = await post(c, "AttachPlanRepository", payload, 1);
  assert.equal(duplicate.body.error.code, "REPOSITORY_ALREADY_ATTACHED");
  assert.equal(c.db.sqlite.prepare("SELECT version FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN).version, 1);
});

test("AttachPlanRepository rejects foreign/unavailable repositories and stale concurrent versions", async () => {
  const c = context(); await createPlan(c); seedRepository(c.db, OTHER_OWNER, "foreign-repo"); seedRepository(c.db, OWNER, "revoked-repo", "revoked");
  const foreign = await post(c, "AttachPlanRepository", { planId: PLAN, repositoryId: "foreign-repo" }, 0);
  const revoked = await post(c, "AttachPlanRepository", { planId: PLAN, repositoryId: "revoked-repo" }, 0);
  assert.equal(foreign.body.error.code, "REPOSITORY_UNAVAILABLE"); assert.equal(revoked.body.error.code, "REPOSITORY_UNAVAILABLE");
  assert.equal(c.db.sqlite.prepare("SELECT version FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN).version, 0);
  seedRepository(c.db, OWNER, "repo-a"); seedRepository(c.db, OWNER, "repo-b");
  const [a, b] = await Promise.all([
    post(c, "AttachPlanRepository", { planId: PLAN, repositoryId: "repo-a" }, 0),
    post(c, "AttachPlanRepository", { planId: PLAN, repositoryId: "repo-b" }, 0),
  ]);
  assert.deepEqual([a.body.result?.version, b.body.result?.version].filter(Boolean), [1]);
  assert.equal([a.body.error?.code, b.body.error?.code].filter((code) => code === "VERSION_CONFLICT").length, 1);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM plan_repositories WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN).n, 1);
  assert.equal(c.db.sqlite.prepare("SELECT version FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN).version, 1);
});

test("UpdatePlanMetadata exposes the definitive 400 VALIDATION_ERROR used by the client retry contract", async () => {
  const c = context(); await createPlan(c);
  const response = await post(c, "UpdatePlanMetadata", {
    planId: PLAN,
    planCreatedAt: { precision: "dateOnly", on: "2026-10-02", timeZone: "Asia/Omsk" },
    reason: "",
  }, 0);

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "VALIDATION_ERROR");
  assert.equal(response.body.error.message, "Изменение даты составления требует причины.");
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM command_receipts WHERE owner_id=?").get(OWNER).n, 1,
    "only the preceding CreatePlan receipt exists; rejected metadata validation is not persisted as a business command");
  assert.equal(c.db.sqlite.prepare("SELECT version FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN).version, 0);
});

test("unbound result is a precise retained receipt; binding enables a new fenced attempt and check", async () => {
  const c = context(); const { stepId } = await startPlanAndStep(c); seedRepository(c.db, OWNER, REPO);
  let currentVersion = 1;
  let claimResult = await claim(c, stepId, currentVersion); assert.equal(claimResult.status, 200);
  let attempt = claimResult.body.result;
  const firstAttemptId = attempt.attemptId, firstFence = attempt.fence;
  let started = await startAttempt(c, stepId, currentVersion, attempt); assert.equal(started.status, 200); currentVersion = started.body.result.version;
  const failedCommandId = id();
  const rejectedExpectedVersion = currentVersion;
  const unbound = await result(c, stepId, attempt, rejectedExpectedVersion, REPO, failedCommandId);
  assert.equal(unbound.body.error.code, "REPOSITORY_NOT_ATTACHED");
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_results WHERE owner_id=? AND step_id=?").get(OWNER, stepId).n, 0);
  await closeAttempt(c, stepId, attempt); // A failed business command does not change the open attempt; close through its normal API.
  currentVersion = c.db.sqlite.prepare("SELECT version FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, stepId).version;
  let second = await claim(c, stepId, currentVersion); attempt = second.body.result;
  started = await startAttempt(c, stepId, currentVersion, attempt); currentVersion = started.body.result.version;
  await closeAttempt(c, stepId, attempt);
  const binding = await post(c, "AttachPlanRepository", { planId: PLAN, repositoryId: REPO }, 1);
  assert.equal(binding.status, 200);
  const oldReplay = await result(c, stepId, { attemptId: firstAttemptId, fence: firstFence }, rejectedExpectedVersion, REPO, failedCommandId);
  assert.equal(oldReplay.body.error.code, "REPOSITORY_NOT_ATTACHED");
  assert.equal(c.db.sqlite.prepare("SELECT outcome_code FROM command_receipts WHERE owner_id=? AND command_id=?").get(OWNER, failedCommandId).outcome_code, "REPOSITORY_NOT_ATTACHED");
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_results WHERE owner_id=? AND step_id=?").get(OWNER, stepId).n, 0);
  const stepVersion = c.db.sqlite.prepare("SELECT version FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, stepId).version;
  const recoveryClaim = await claim(c, stepId, stepVersion); assert.equal(recoveryClaim.status, 200);
  const recoveryAttempt = recoveryClaim.body.result;
  const notStarted = await result(c, stepId, recoveryAttempt, stepVersion, REPO);
  assert.equal(notStarted.body.error.code, "STEP_NOT_STARTED");
  started = await startAttempt(c, stepId, stepVersion, recoveryAttempt); assert.equal(started.status, 200);
  const recorded = await result(c, stepId, recoveryAttempt, started.body.result.version, REPO);
  assert.equal(recorded.status, 200); assert.equal(recorded.body.result.resultRevision, 1);
  const check = await post(c, "RecordCheck", { stepId, resultRevision: 1, checkKey: "unit", status: "PASSED", testedSha: SHA, exitCode: 0, evidenceSummary: "Local SQLite acceptance" });
  assert.equal(check.status, 200);
  const step = c.db.sqlite.prepare("SELECT status,acceptance_decision,current_result_revision FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, stepId);
  assert.deepEqual({ ...step }, { status: "DONE", acceptance_decision: "NONE", current_result_revision: 1 });
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_attempts WHERE owner_id=? AND step_id=? AND status='ABANDONED'").get(OWNER, stepId).n, 2);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_results WHERE owner_id=? AND step_id=?").get(OWNER, stepId).n, 1);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM work_intervals WHERE owner_id=? AND plan_id=? AND end_ms IS NULL").get(OWNER, PLAN).n, 1);
});

test("revoked repository blocks result atomically while accepted receipt replay stays unchanged", async () => {
  const c = context(); const { stepId } = await startPlanAndStep(c, []); seedRepository(c.db, OWNER, REPO);
  await post(c, "AttachPlanRepository", { planId: PLAN, repositoryId: REPO }, 1);
  const claimed = await claim(c, stepId, 1), attempt = claimed.body.result;
  const started = await startAttempt(c, stepId, 1, attempt); assert.equal(started.status, 200);
  const commandId = id();
  const accepted = await result(c, stepId, attempt, started.body.result.version, REPO, commandId);
  assert.equal(accepted.status, 200);
  const acceptedReceipt = c.db.sqlite.prepare("SELECT outcome_code,result_json FROM command_receipts WHERE owner_id=? AND command_id=?").get(OWNER, commandId);
  const acceptedRows = c.db.sqlite.prepare("SELECT * FROM step_results WHERE owner_id=? AND step_id=?").all(OWNER, stepId);
  assert.equal(acceptedRows.length, 1);
  c.db.sqlite.prepare("UPDATE repositories SET access_state='revoked' WHERE owner_id=? AND repository_id=?").run(OWNER, REPO);

  const replay = await result(c, stepId, attempt, started.body.result.version, REPO, commandId);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.result, JSON.parse(acceptedReceipt.result_json));
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_results WHERE owner_id=? AND step_id=?").get(OWNER, stepId).n, 1,
    "replaying a stored success after revocation does not run the trigger again or duplicate the result");
  assert.equal(c.db.sqlite.prepare("SELECT outcome_code,result_json FROM command_receipts WHERE owner_id=? AND command_id=?").get(OWNER, commandId).outcome_code, acceptedReceipt.outcome_code);

  c.db.sqlite.prepare("UPDATE repositories SET access_state='available' WHERE owner_id=? AND repository_id=?").run(OWNER, REPO);
  const secondStep = await post(c, "CreateStep", { planId: PLAN, ordinal: 1, title: "Revoked access guard", expectedResult: "No result may be written after revocation", requiredChecks: [], commitPolicy: "NEVER", pushPolicy: "NEVER" });
  assert.equal(secondStep.status, 200, JSON.stringify(secondStep.body));
  const secondId = secondStep.body.result.stepId;
  const secondAttempt = (await claim(c, secondId, 1)).body.result;
  const secondStarted = await startAttempt(c, secondId, 1, secondAttempt); assert.equal(secondStarted.status, 200);
  c.db.sqlite.exec(`CREATE TRIGGER acceptance_revoke_before_result BEFORE INSERT ON command_receipts
    WHEN NEW.command_type='RecordStepResult' AND json_extract(NEW.payload_json,'$.repositoryId')='${REPO}'
    BEGIN UPDATE repositories SET access_state='revoked' WHERE owner_id=NEW.owner_id AND repository_id='${REPO}'; END`);
  const raced = await result(c, secondId, secondAttempt, secondStarted.body.result.version, REPO);
  assert.equal(raced.body.error.code, "REPOSITORY_UNAVAILABLE",
    "a revocation serialized after request validation but before the command trigger is seen by the atomic INSERT SELECT");
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_results WHERE owner_id=? AND step_id=?").get(OWNER, secondId).n, 0,
    "access_state is checked in the same INSERT SELECT that writes the result");
  assert.equal(c.db.sqlite.prepare("SELECT status FROM step_attempts WHERE owner_id=? AND attempt_id=?").get(OWNER, secondAttempt.attemptId).status, "OPEN",
    "a rejected result does not close or fence the attempt");
  assert.equal(c.db.sqlite.prepare("SELECT status FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, secondId).status, "RUNNING");
  c.db.sqlite.exec("DROP TRIGGER acceptance_revoke_before_result");
  c.db.sqlite.prepare("UPDATE repositories SET access_state='unavailable' WHERE owner_id=? AND repository_id=?").run(OWNER, REPO);
  const unavailable = await result(c, secondId, secondAttempt, secondStarted.body.result.version, REPO);
  assert.equal(unavailable.body.error.code, "REPOSITORY_UNAVAILABLE");
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_results WHERE owner_id=? AND step_id=?").get(OWNER, secondId).n, 0);
});

test("lease result protections distinguish missing owner attempt, expired lease, and stale fence; Renew version is honored", async () => {
  const c = context(); const { stepId } = await startPlanAndStep(c); seedRepository(c.db, OWNER, REPO);
  await post(c, "AttachPlanRepository", { planId: PLAN, repositoryId: REPO }, 1);
  const first = (await claim(c, stepId, 1)).body.result;
  const wrongOwnerAttempt = await result(c, stepId, { attemptId: "00000000-0000-4000-8000-000000000002", fence: first.fence }, 1);
  assert.equal(wrongOwnerAttempt.body.error.code, "ATTEMPT_NOT_FOUND");
  const wrongFence = await result(c, stepId, { attemptId: first.attemptId, fence: first.fence + 1 }, 1);
  assert.equal(wrongFence.body.error.code, "LEASE_FENCED");
  const started = await startAttempt(c, stepId, 1, first); assert.equal(started.status, 200);
  const renewZero = await post(c, "RenewStepLease", { stepId, attemptId: first.attemptId, fence: first.fence }, 0, OWNER, id(), "/mcp");
  assert.equal(renewZero.body.code, "VALIDATION_ERROR", "runtime rejects the MCP-advertised lower bound 0 before it reaches SQL");
  const mcpNoVersion = await post(c, "RenewStepLease", { stepId, attemptId: first.attemptId, fence: first.fence }, undefined, OWNER, id(), "/mcp");
  assert.equal(mcpNoVersion.raw.result.isError, undefined);
  const renewedWithVersion = await post(c, "RenewStepLease", { stepId, attemptId: first.attemptId, fence: first.fence }, 2, OWNER, id(), "/mcp");
  assert.equal(renewedWithVersion.body.error, undefined);
  const staleVersion = await post(c, "RenewStepLease", { stepId, attemptId: first.attemptId, fence: first.fence }, 1, OWNER, id(), "/mcp");
  assert.equal(staleVersion.body.code, "VERSION_CONFLICT"); assert.equal(staleVersion.body.details.currentVersion, 2);
  c.setNow(c.now() + 10 * 60 * 1000);
  const expired = await result(c, stepId, first, 2);
  assert.equal(expired.body.error.code, "LEASE_EXPIRED");
});

test("0011 upgrades a populated 0010 database without changing application history", async () => {
  const c = context(migrations.indexOf("0011_plan_repository_binding.sql"));
  const { stepId } = await startPlanAndStep(c, []);
  const attempt = (await claim(c, stepId, 1)).body.result;
  const started = await startAttempt(c, stepId, 1, attempt);
  const saved = await post(c, "RecordStepResult", { stepId, attemptId: attempt.attemptId, fence: attempt.fence, outcome: "DONE", summary: "Pre-migration result" }, started.body.result.version);
  assert.equal(saved.status, 200);
  const selectedTables = ["plans", "work_intervals", "plan_events", "command_receipts", "plan_steps", "step_attempts", "step_results", "tracker_journal"];
  const before = Object.fromEntries(selectedTables.map((table) => [table, c.db.sqlite.prepare("SELECT * FROM " + table + " ORDER BY 1,2").all()]));
  c.db.sqlite.exec(readFileSync(resolve(migrationsDir, "0011_plan_repository_binding.sql"), "utf8"));
  const after = Object.fromEntries(selectedTables.map((table) => [table, c.db.sqlite.prepare("SELECT * FROM " + table + " ORDER BY 1,2").all()]));
  assert.deepEqual(after, before);
  assert.deepEqual(c.db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM plan_events").get().n, before.plan_events.length);
});
