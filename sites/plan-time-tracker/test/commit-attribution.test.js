import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createWorker } from "../worker/index.js";

const migrationRoot = new URL("../drizzle/", import.meta.url);
const migrations = readdirSync(migrationRoot).filter((name) => name.endsWith(".sql")).sort();
const OWNER = "attribution-owner", OTHER = "other-attribution-owner";
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const MISSING = "99999999-9999-4999-8999-999999999999", REPO = "attribution-repo", SHA = "a".repeat(40);
let sequence = 0;
const id = () => `f0000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;

class Statement {
  constructor(db, sql, args = []) { Object.assign(this, { db, sql, args }); }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  async run() {
    if (this.db.beforeRun) await this.db.beforeRun(this.sql, this.args);
    return { meta: { changes: Number(this.db.sqlite.prepare(this.sql).run(...this.args).changes) } };
  }
  async first() { return this.db.sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: this.db.sqlite.prepare(this.sql).all(...this.args) }; }
}
class Database {
  constructor(until = migrations.length) {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(migrations.slice(0, until).map((name) => readFileSync(new URL(name, migrationRoot), "utf8")).join("\n"));
  }
  prepare(sql) { return new Statement(this, sql); }
}
function context(until) {
  const db = new Database(until);
  let now = 1800000000000;
  return { db, worker: createWorker(() => now), now: () => now, setNow: (value) => { now = value; } };
}
async function api(c, path, options = {}, owner = OWNER) {
  const response = await c.worker.fetch(new Request("https://tracker.test" + path, {
    ...options, headers: { "content-type": "application/json", "oai-authenticated-user-id": owner },
  }), { DB: c.db });
  return { status: response.status, body: await response.json() };
}
async function post(c, type, payload, version, owner = OWNER, commandId = id()) {
  const envelope = { schemaVersion: 1, commandId, commandType: type, payload };
  if (version !== undefined) envelope.expectedVersion = version;
  return { ...await api(c, "/api/commands", { method: "POST", body: JSON.stringify(envelope) }, owner), envelope };
}
async function fixture(c, bOwner = OWNER) {
  for (const owner of new Set([OWNER, bOwner])) {
    assert.equal((await api(c, "/api/whoami", {}, owner)).status, 200);
    c.db.sqlite.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,0,'main','available',1,?)")
      .run(owner, REPO, owner + "/fixture", c.now());
    c.db.sqlite.prepare("INSERT INTO commits(owner_id,repository_id,sha,observed_at,message,url) VALUES(?,?,?,?,'Synthetic commit','https://example.invalid/commit')")
      .run(owner, REPO, SHA, c.now());
  }
  for (const [planId, owner] of [[A, OWNER], [B, bOwner]]) {
    assert.equal((await post(c, "CreatePlan", { planId, title: "Attribution fixture", repositoryIds: [REPO], planCreatedAt: { precision: "dateOnly", on: "2026-10-01", timeZone: "UTC" } }, undefined, owner)).status, 200);
    assert.equal((await post(c, "ReviewCommitLink", { planId, repositoryId: REPO, sha: SHA, status: "candidate", reason: "Initial candidate" }, 0, owner)).status, 200);
  }
}
function tables(c, excluded = []) {
  const names = c.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  return Object.fromEntries(names.filter((name) => !excluded.includes(name)).map((name) => [name,
    c.db.sqlite.prepare('SELECT * FROM "' + name + '"').all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]));
}
function interleaveExclusion(c, aId, bOwner = OWNER) {
  const evidence = { ran: false, b: null, afterB: null };
  c.db.beforeRun = async (sql, args) => {
    if (evidence.ran || args[1] !== aId || !sql.includes("INSERT OR IGNORE INTO command_receipts") || !sql.includes("'PENDING'")) return;
    evidence.ran = true;
    // Both operations use the actual Worker API; no link is modified directly.
    evidence.b = await post(c, "ReviewCommitLink", { planId: B, repositoryId: REPO, sha: SHA, status: "excluded", reason: "Concurrent owner exclusion" }, 1, bOwner);
    assert.equal(evidence.b.status, 200);
    evidence.afterB = tables(c, ["command_receipts"]);
  };
  return evidence;
}

test("ReviewCommitLink excludes a late concurrent owner decision atomically before any A mutation", async () => {
  const c = context();
  try {
    await fixture(c);
    const commandId = id(), evidence = interleaveExclusion(c, commandId);
    const payload = { planId: A, repositoryId: REPO, sha: SHA, status: "confirmed", reason: "Confirm after preflight" };
    const rejected = await post(c, "ReviewCommitLink", payload, 1, OWNER, commandId);
    assert.equal(evidence.ran, true, "nested API exclusion must execute after preflight and before A's INSERT");
    assert.equal(rejected.status, 409, "A must not confirm after B's successful exclusion");
    assert.equal(rejected.body.error.code, "COMMIT_EXCLUDED");
    assert.deepEqual(tables(c, ["command_receipts"]), evidence.afterB, "A rejection must leave every domain table exactly as committed by B");
    const receipt = await api(c, "/api/tracker/commands/" + commandId);
    assert.equal(receipt.body.status, "FINAL");
    assert.equal(receipt.body.commandId, commandId);
    assert.equal(receipt.body.commandType, "ReviewCommitLink");
    assert.equal(receipt.body.error.code, "COMMIT_EXCLUDED");
    assert.equal((await api(c, "/api/tracker/commands/" + commandId, {}, OTHER)).body.status, "NOT_FOUND");
    const beforeReplay = tables(c);
    const replay = await post(c, "ReviewCommitLink", payload, 1, OWNER, commandId);
    assert.equal(replay.status, 409); assert.equal(replay.body.error.code, "COMMIT_EXCLUDED");
    assert.deepEqual(tables(c), beforeReplay);
    const collision = await post(c, "ReviewCommitLink", { ...payload, status: "candidate" }, 1, OWNER, commandId);
    assert.equal(collision.body.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.deepEqual(tables(c), beforeReplay);
    assert.equal((await post(c, "ReviewCommitLink", { ...payload, planId: B, status: "candidate" }, 2)).status, 200);
    assert.equal((await post(c, "ReviewCommitLink", payload, 1, OWNER, commandId)).body.error.code, "COMMIT_EXCLUDED", "old refusal remains immutable after external prerequisites change");
    const fresh = await post(c, "ReviewCommitLink", payload, 1);
    assert.equal(fresh.status, 200);
    assert.equal(c.db.sqlite.prepare("SELECT status FROM plan_commit_links WHERE owner_id=? AND plan_id=?").get(OWNER, A).status, "confirmed");
  } finally { c.db.sqlite.close(); }
});

for (const [name, planId, expectedVersion, code, status] of [
  ["version", A, 0, "VERSION_CONFLICT", 409],
  ["owned plan", MISSING, 0, "PLAN_NOT_FOUND", 404],
]) {
  test(`atomic commit exclusion preserves ${name} error precedence`, async () => {
    const c = context();
    try {
      await fixture(c);
      const commandId = id(), evidence = interleaveExclusion(c, commandId);
      const result = await post(c, "ReviewCommitLink", { planId, repositoryId: REPO, sha: SHA, status: "confirmed", reason: "Guard precedence" }, expectedVersion, OWNER, commandId);
      assert.equal(evidence.ran, true); assert.equal(result.status, status); assert.equal(result.body.error.code, code);
      assert.equal((await api(c, "/api/tracker/commands/" + commandId)).body.error.code, code);
      assert.deepEqual(tables(c, ["command_receipts"]), evidence.afterB);
    } finally { c.db.sqlite.close(); }
  });
}

test("a concurrent exclusion for another owner cannot block or expose their repository to A", async () => {
  const c = context();
  try {
    await fixture(c, OTHER);
    const commandId = id(), evidence = interleaveExclusion(c, commandId, OTHER);
    const accepted = await post(c, "ReviewCommitLink", { planId: A, repositoryId: REPO, sha: SHA, status: "confirmed", reason: "Own attribution" }, 1, OWNER, commandId);
    assert.equal(evidence.ran, true); assert.equal(accepted.status, 200);
    assert.equal(c.db.sqlite.prepare("SELECT status FROM plan_commit_links WHERE owner_id=? AND plan_id=?").get(OWNER, A).status, "confirmed");
    assert.equal(c.db.sqlite.prepare("SELECT status FROM plan_commit_links WHERE owner_id=? AND plan_id=?").get(OTHER, B).status, "excluded");
    assert.equal((await api(c, "/api/tracker/commands/" + commandId, {}, OTHER)).body.status, "NOT_FOUND");
  } finally { c.db.sqlite.close(); }
});

test("own-plan exclusion retains the existing explicit excluded-to-confirmed workflow", async () => {
  const c = context();
  try {
    await fixture(c);
    const payload = { planId: A, repositoryId: REPO, sha: SHA, status: "excluded", reason: "Own decision" };
    assert.equal((await post(c, "ReviewCommitLink", payload, 1)).status, 200);
    // Global exclusion also affects B; explicitly restore B to candidate first.
    assert.equal((await post(c, "ReviewCommitLink", { ...payload, planId: B, status: "candidate" }, 1)).status, 200);
    assert.equal((await post(c, "ReviewCommitLink", { ...payload, status: "confirmed" }, 2)).status, 200);
  } finally { c.db.sqlite.close(); }
});

test("0012 upgrades populated receipts, history, results and active leases without data loss", async () => {
  const migrationName = "0012_atomic_commit_exclusion.sql";
  const migrationIndex = migrations.indexOf(migrationName);
  assert.ok(migrationIndex > 0);
  const c = context(migrationIndex);
  try {
    await fixture(c);
    assert.equal((await post(c, "StartPlan", { planId: A }, 1)).status, 200);
    assert.equal((await post(c, "UpdatePlanMetadata", {
      planId: A, planCreatedAt: { precision: "dateOnly", on: "2026-10-02", timeZone: "UTC" },
      reason: "Populated migration history",
    }, 2)).status, 200);
    const createPayload = {
      planId: A, ordinal: 0, title: "Verified checkpoint", expectedResult: "Preserve the accepted result",
      requiredChecks: ["unit"], commitPolicy: "NEVER", pushPolicy: "NEVER",
    };
    const created = await post(c, "CreateStep", createPayload);
    assert.equal(created.status, 200);
    const stepId = created.body.result.stepId;
    const claimed = await post(c, "ClaimStepAttempt", {
      stepId, sessionId: id(), sourceId: "migration-fixture", clientType: "LOCAL",
    }, 1);
    assert.equal(claimed.status, 200);
    const { attemptId, fence } = claimed.body.result;
    assert.equal((await post(c, "StartStep", { stepId, attemptId, fence }, 1)).status, 200);
    const recorded = await post(c, "RecordStepResult", {
      stepId, attemptId, fence, outcome: "DONE", summary: "Existing verified result",
      repositoryId: REPO, revisionSha: SHA,
    }, 2);
    assert.equal(recorded.status, 200);
    assert.equal((await post(c, "RecordCheck", {
      stepId, resultRevision: 1, checkKey: "unit", status: "PASSED", testedSha: SHA,
      exitCode: 0, evidenceSummary: "Existing successful evidence",
    })).status, 200);
    // Historical synthetic rows preserve the pre-0012 no-data-loss assertion;
    // the current Worker intentionally no longer implements owner decisions.
    const acceptanceId = id();
    c.db.sqlite.prepare("INSERT INTO step_acceptances(owner_id,acceptance_id,step_id,result_revision,decision,actor_id,reason,created_at) VALUES(?,?,?,1,'ACCEPTED',?,'Historical owner decision',?)")
      .run(OWNER, acceptanceId, stepId, OWNER, c.now());
    c.db.sqlite.prepare("UPDATE plan_steps SET acceptance_revision=1,acceptance_decision='ACCEPTED',current_acceptance_id=? WHERE owner_id=? AND step_id=?")
      .run(acceptanceId, OWNER, stepId);
    const activeStep = await post(c, "CreateStep", { ...createPayload, ordinal: 1, title: "Active leased checkpoint" });
    assert.equal(activeStep.status, 200);
    const activeStepId = activeStep.body.result.stepId;
    const activeClaim = await post(c, "ClaimStepAttempt", {
      stepId: activeStepId, sessionId: id(), sourceId: "active-migration-fixture", clientType: "LOCAL",
    }, 1);
    assert.equal(activeClaim.status, 200);
    const active = activeClaim.body.result;
    assert.equal((await post(c, "StartStep", { stepId: activeStepId, attemptId: active.attemptId, fence: active.fence }, 1)).status, 200);
    const rejected = await post(c, "CreateStep", createPayload);
    assert.equal(rejected.body.error.code, "STEP_ALREADY_EXISTS");

    const before = tables(c);
    for (const table of ["plans", "work_intervals", "plan_events", "plan_date_history", "command_receipts",
      "plan_commit_links", "plan_steps", "step_attempts", "tracker_journal", "step_results", "step_checks", "step_acceptances"]) {
      assert.ok(before[table].length > 0, table + " must be populated before upgrade");
    }
    assert.equal(before.work_intervals.filter((row) => row.end_ms === null).length, 1);
    c.db.sqlite.exec(readFileSync(new URL(migrationName, migrationRoot), "utf8"));
    assert.deepEqual(tables(c), before, "DDL must preserve every existing application row byte-for-byte");
    assert.deepEqual(c.db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(c.db.sqlite.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    for (const original of [recorded, rejected]) {
      const envelope = original.envelope;
      const replay = await post(c, envelope.commandType, envelope.payload, envelope.expectedVersion, OWNER, envelope.commandId);
      assert.equal(replay.status, original.status);
      if (original.body.result) assert.deepEqual(replay.body.result, original.body.result);
      else {
        // HTTP request IDs identify each request; the persisted rejection is immutable.
        const { requestId: originalRequestId, ...originalError } = original.body.error;
        const { requestId: replayRequestId, ...replayError } = replay.body.error;
        assert.deepEqual(replayError, originalError);
      }
    }
    assert.deepEqual(tables(c), before, "old success/error replay must not modify migrated rows");
    c.setNow(c.now() + 1000);
    const renewed = await post(c, "RenewStepLease", { stepId: activeStepId, attemptId: active.attemptId, fence: active.fence }, 2);
    assert.equal(renewed.status, 200);
    const activeAfter = c.db.sqlite.prepare("SELECT * FROM step_attempts WHERE attempt_id=?").get(active.attemptId);
    assert.equal(activeAfter.status, "OPEN"); assert.equal(activeAfter.fence, active.fence);
    assert.deepEqual(tables(c).work_intervals, before.work_intervals, "lease renewal must not change the running timer");
    const commandId = id(), evidence = interleaveExclusion(c, commandId);
    const raced = await post(c, "ReviewCommitLink", { planId: A, repositoryId: REPO, sha: SHA, status: "confirmed", reason: "Guard after upgrade" }, 3, OWNER, commandId);
    assert.equal(evidence.ran, true); assert.equal(raced.body.error.code, "COMMIT_EXCLUDED");
    assert.deepEqual(tables(c, ["command_receipts"]), evidence.afterB, "new guard must also protect the upgraded populated database");
  } finally { c.db.sqlite.close(); }
});
