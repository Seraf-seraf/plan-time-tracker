import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createWorker } from "../worker/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const migrationDirectory = resolve(root, "drizzle");
const migrations = readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort();
const schema = migrations.map((name) => readFileSync(resolve(migrationDirectory, name), "utf8")).join("\n");
const OWNER = "tracker-evidence-owner";
const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const REPOSITORY_ID = "repo-evidence";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
let number = 0;
const commandId = () => {
  number += 1;
  return "e0000000-0000-4000-8000-" + String(number).padStart(12, "0");
};

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
    this.sqlite.exec(migrations.slice(0, until).map((name) => readFileSync(resolve(migrationDirectory, name), "utf8")).join("\n"));
  }
  prepare(sql) { return new Statement(this, sql); }
}

function createContext(until) {
  const db = new TestDatabase(until);
  let now = 1800000000000;
  const worker = createWorker(() => now);
  return { db, worker, now: () => now, setNow: (value) => { now = value; } };
}

async function request(c, commandType, payload, expectedVersion, id = commandId()) {
  const envelope = { schemaVersion: 1, commandId: id, commandType, payload };
  if (expectedVersion !== undefined) envelope.expectedVersion = expectedVersion;
  const response = await c.worker.fetch(new Request("https://tracker.test/api/commands", {
    method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-id": OWNER },
    body: JSON.stringify(envelope),
  }), { DB: c.db });
  return { status: response.status, value: await response.json() };
}

async function setupResult(c, requiredChecks = ["unit", "build"], revisionSha = SHA_A) {
  const created = await request(c, "CreatePlan", {
    planId: PLAN_ID, title: "Evidence plan", planCreatedAt: { precision: "dateOnly", on: "2026-10-01", timeZone: "UTC" },
  });
  assert.equal(created.status, 200);
  await c.db.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,0,'main','available',1,?)")
    .bind(OWNER, REPOSITORY_ID, "fixture/evidence", c.now()).run();
  await c.db.prepare("INSERT INTO plan_repositories(owner_id,plan_id,repository_id,selected_ref) VALUES(?,?,?,'main')")
    .bind(OWNER, PLAN_ID, REPOSITORY_ID).run();
  const checkpoint = await request(c, "CreateStep", {
    planId: PLAN_ID, ordinal: 0, title: "Implement checkpoint", expectedResult: "A verified code change.",
    requiredChecks, commitPolicy: "ON_EXPLICIT_REQUEST", pushPolicy: "NEVER",
  });
  assert.equal(checkpoint.status, 200);
  const stepId = checkpoint.value.result.stepId;
  const planStarted = await request(c, "StartPlan", { planId: PLAN_ID }, 0);
  assert.equal(planStarted.status, 200);
  const claimed = await request(c, "ClaimStepAttempt", {
    stepId, sessionId: SESSION_ID, sourceId: "codex-local", clientType: "LOCAL",
  }, 1);
  assert.equal(claimed.status, 200);
  const attemptId = claimed.value.result.attemptId;
  const fence = claimed.value.result.fence;
  assert.equal((await request(c, "StartStep", { stepId, attemptId, fence }, 1)).status, 200);
  const recorded = await request(c, "RecordStepResult", {
    stepId, attemptId, fence, outcome: "DONE", summary: "Рабочий результат для проверки.",
    ...(revisionSha ? { repositoryId: REPOSITORY_ID, revisionSha } : {}),
  }, 2);
  assert.equal(recorded.status, 200);
  assert.equal(recorded.value.result.resultRevision, 1);
  return { stepId, resultRevision: 1, version: 3, attemptId, fence };
}

async function recordCheck(c, stepId, checkKey, status, sha = SHA_A, exitCode = 0) {
  return request(c, "RecordCheck", {
    stepId, resultRevision: 1, checkKey, status, testedSha: sha,
    exitCode: status === "NOT_RUN" ? undefined : exitCode,
    evidenceSummary: "exit status was recorded",
  });
}

async function readTracker(c, path, ownerId = OWNER) {
  const response = await c.worker.fetch(new Request("https://tracker.test" + path, {
    headers: { "oai-authenticated-user-id": ownerId },
  }), { DB: c.db });
  return { status: response.status, value: await response.json() };
}

async function realCommandClient(c, kind = "tracker") {
  const html = await (await c.worker.fetch(new Request("https://tracker.test/", {
    headers: { "oai-authenticated-user-id": OWNER },
  }), { DB: c.db })).text();
  const tracker = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][kind === "main" ? 0 : 2][1];
  const start = tracker.indexOf(kind === "main" ? "async function call(" : "async function api("), end = tracker.indexOf(kind === "main" ? "function btn(" : "function inputField(", start);
  assert(start >= 0 && end > start, "use the actual delivered tracker command client");
  const calls = [];
  const sandbox = {
    uuid: commandId, uid: commandId, root: { dataset: { planId: PLAN_ID } },
    pending: new Map(), rejectedValidation: new Set(), rejectedVersion: new Map(),
    showToast() {}, refresh: async () => {}, window: { addEventListener() {} },
    fetch: async (path, options = {}) => {
      const headers = new Headers(options.headers || {});
      headers.set("oai-authenticated-user-id", OWNER);
      const response = await c.worker.fetch(new Request("https://tracker.test" + path, { ...options, headers }), { DB: c.db });
      calls.push({ path, envelope: options.body ? JSON.parse(options.body) : null, status: response.status, body: await response.clone().json() });
      return response;
    },
  };
  const command = runInNewContext(tracker.slice(start, end) + ";command;", sandbox);
  return { command, calls };
}

test("real tracker Add checkpoint correction releases only a matching FINAL ordinal rejection", async () => {
  const c = createContext();
  try {
    assert.equal((await request(c, "CreatePlan", {
      planId: PLAN_ID, title: "Ordinal correction fixture", planCreatedAt: { precision: "dateOnly", on: "2026-10-01", timeZone: "UTC" },
    })).status, 200);
    const firstPayload = { planId: PLAN_ID, ordinal: 0, title: "Original checkpoint", expectedResult: "Preserve this checkpoint", requiredChecks: [], commitPolicy: "NEVER", pushPolicy: "NEVER" };
    const first = await request(c, "CreateStep", firstPayload);
    assert.equal(first.status, 200);
    const originalSteps = c.db.sqlite.prepare("SELECT * FROM plan_steps ORDER BY ordinal").all();
    const journalCount = () => c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM tracker_journal").get().n;
    const beforeJournal = journalCount();
    const client = await realCommandClient(c);
    const rejectedPayload = { ...firstPayload, title: "Second checkpoint" };
    await assert.rejects(() => client.command("CreateStep", rejectedPayload), (error) => error.code === "STEP_ALREADY_EXISTS");
    const rejected = client.calls.find((call) => call.envelope);
    const receipt = await readTracker(c, "/api/tracker/commands/" + rejected.envelope.commandId);
    assert.equal(receipt.value.status, "FINAL");
    assert.equal(receipt.value.commandId, rejected.envelope.commandId);
    assert.equal(receipt.value.commandType, "CreateStep");
    assert.equal(receipt.value.error.code, "STEP_ALREADY_EXISTS");
    assert.deepEqual(c.db.sqlite.prepare("SELECT * FROM plan_steps ORDER BY ordinal").all(), originalSteps);
    assert.equal(journalCount(), beforeJournal, "rejected duplicate must not add checkpoint journal events");
    await client.command("CreateStep", { ...rejectedPayload, ordinal: 1 });
    const posts = client.calls.filter((call) => call.envelope);
    assert.equal(posts.length, 2);
    assert.notEqual(posts[1].envelope.commandId, posts[0].envelope.commandId);
    assert.equal(posts[1].envelope.payload.ordinal, 1);
    assert.equal(posts[1].status, 200);
    const finalSteps = c.db.sqlite.prepare("SELECT * FROM plan_steps ORDER BY ordinal").all();
    assert.equal(finalSteps.length, 2);
    assert.deepEqual(finalSteps[0], originalSteps[0]);
    assert.equal(finalSteps[1].ordinal, 1);
    assert.equal(finalSteps[1].title, "Second checkpoint");
    const replay = await request(c, "CreateStep", rejectedPayload, undefined, rejected.envelope.commandId);
    assert.equal(replay.status, 409);
    assert.equal(replay.value.error.code, "STEP_ALREADY_EXISTS");
    assert.deepEqual(c.db.sqlite.prepare("SELECT * FROM plan_steps ORDER BY ordinal").all(), finalSteps, "old rejection replay cannot create another checkpoint");
  } finally { c.db.sqlite.close(); }
});

async function createRunningAttempt(c) {
  assert.equal((await request(c, "CreatePlan", {
    planId: PLAN_ID, title: "Expired attempt plan", planCreatedAt: { precision: "dateOnly", on: "2026-10-01", timeZone: "UTC" },
  })).status, 200);
  const created = await request(c, "CreateStep", {
    planId: PLAN_ID, ordinal: 1, title: "Expired lease result", expectedResult: "Record only while the lease is valid.",
    requiredChecks: [], commitPolicy: "NEVER", pushPolicy: "NEVER",
  });
  const stepId = created.value.result.stepId;
  assert.equal((await request(c, "StartPlan", { planId: PLAN_ID }, 0)).status, 200);
  const claim = await request(c, "ClaimStepAttempt", { stepId, sessionId: SESSION_ID, sourceId: "codex-local", clientType: "LOCAL" }, 1);
  const { attemptId, fence } = claim.value.result;
  assert.equal((await request(c, "StartStep", { stepId, attemptId, fence }, 1)).status, 200);
  return { stepId, attemptId, fence };
}

async function createExpiredAttempt(c) {
  const attempt = await createRunningAttempt(c);
  c.setNow(c.now() + 11 * 60_000);
  return attempt;
}

test("real tracker result correction after FINAL unavailable repository keeps lease guards and writes once", async () => {
  const c = createContext();
  try {
    const attempt = await createRunningAttempt(c);
    for (const [repositoryId, accessState] of [["repo-revoked", "revoked"], [REPOSITORY_ID, "available"]]) {
      c.db.sqlite.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,0,'main',?,1,?)")
        .run(OWNER, repositoryId, "fixture/" + repositoryId, accessState, c.now());
    }
    c.db.sqlite.prepare("INSERT INTO plan_repositories(owner_id,plan_id,repository_id,selected_ref) VALUES(?,?,?,'main')").run(OWNER, PLAN_ID, REPOSITORY_ID);
    const before = trackerSideEffects(c, attempt.stepId);
    const beforeAttempt = c.db.sqlite.prepare("SELECT * FROM step_attempts WHERE attempt_id=?").get(attempt.attemptId);
    const client = await realCommandClient(c);
    const payload = { ...attempt, outcome: "DONE", summary: "Result with corrected bound repository", repositoryId: "repo-revoked", revisionSha: SHA_A };
    await assert.rejects(() => client.command("RecordStepResult", payload, 2), (error) => error.code === "REPOSITORY_UNAVAILABLE");
    const rejected = client.calls.find((call) => call.envelope);
    const receipt = await readTracker(c, "/api/tracker/commands/" + rejected.envelope.commandId);
    assert.equal(receipt.value.status, "FINAL");
    assert.equal(receipt.value.commandId, rejected.envelope.commandId);
    assert.equal(receipt.value.commandType, "RecordStepResult");
    assert.equal(receipt.value.error.code, "REPOSITORY_UNAVAILABLE");
    assert.deepEqual(trackerSideEffects(c, attempt.stepId), before);
    assert.deepEqual(c.db.sqlite.prepare("SELECT * FROM step_attempts WHERE attempt_id=?").get(attempt.attemptId), beforeAttempt);
    await client.command("RecordStepResult", { ...payload, repositoryId: REPOSITORY_ID }, 2);
    const posts = client.calls.filter((call) => call.envelope);
    assert.equal(posts.length, 2);
    assert.notEqual(posts[1].envelope.commandId, posts[0].envelope.commandId);
    assert.equal(posts[1].status, 200);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_results").get().n, 1);
    assert.equal(c.db.sqlite.prepare("SELECT repository_id,revision_sha FROM step_results").get().repository_id, REPOSITORY_ID);
    assert.equal(c.db.sqlite.prepare("SELECT repository_id,revision_sha FROM step_results").get().revision_sha, SHA_A);
    const after = trackerSideEffects(c, attempt.stepId);
    const oldReplay = await request(c, "RecordStepResult", payload, 2, rejected.envelope.commandId);
    assert.equal(oldReplay.value.error.code, "REPOSITORY_UNAVAILABLE");
    assert.deepEqual(trackerSideEffects(c, attempt.stepId), after);
  } finally { c.db.sqlite.close(); }
});

function trackerSideEffects(c, stepId) {
  return {
    steps: c.db.sqlite.prepare("SELECT version,status FROM plan_steps WHERE owner_id=? AND step_id=?").all(OWNER, stepId),
    results: c.db.sqlite.prepare("SELECT * FROM step_results WHERE owner_id=? AND step_id=?").all(OWNER, stepId),
    checks: c.db.sqlite.prepare("SELECT * FROM step_checks WHERE owner_id=? AND step_id=?").all(OWNER, stepId),
    journal: c.db.sqlite.prepare("SELECT event_type,command_id FROM tracker_journal WHERE owner_id=? AND step_id=? ORDER BY server_sequence").all(OWNER, stepId),
  };
}

test("removed owner-decision commands reject before cached receipts and cannot mutate tracker data", async () => {
  const c = createContext();
  try {
    const step = await setupResult(c, []);
    const before = trackerSideEffects(c, step.stepId);
    const receiptCount = c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM command_receipts").get().n;
    for (const type of ["AcceptStep", "RejectStep"]) {
      const response = await request(c, type, { stepId: step.stepId, resultRevision: 1, reason: "Old client" }, 3);
      assert.equal(response.status, 400);
      assert.equal(response.value.error.code, "VALIDATION_ERROR");
      assert.deepEqual(trackerSideEffects(c, step.stepId), before);
      assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM command_receipts").get().n, receiptCount);
    }
    const execution = (await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution")).value;
    for (const key of Object.keys(execution.steps[0])) assert.ok(!/acceptance/i.test(key), key);
    assert.equal(execution.steps[0].readyToFinish, true);
  } finally { c.db.sqlite.close(); }
});

test("real tracker rework correction remains scoped after a version refresh and FINAL rework refusal", async () => {
  const c = createContext();
  try {
    const step = await setupResult(c, []);
    const client = await realCommandClient(c);
    const payload = { stepId: step.stepId, sessionId: SESSION_ID, sourceId: "codex-local", clientType: "LOCAL" };
    await assert.rejects(() => client.command("ClaimStepAttempt", payload, 1), (error) => error.code === "VERSION_CONFLICT");
    await assert.rejects(() => client.command("ClaimStepAttempt", payload, 1), (error) => error.code === "REWORK_REQUIRED");
    assert.equal(client.calls.at(-1).body.status, "FINAL");
    const before = c.db.sqlite.prepare("SELECT * FROM step_attempts").all();
    await client.command("ClaimStepAttempt", { ...payload, reworkReason: "Owner approved scoped rework" }, 3);
    const posts = client.calls.filter((call) => call.envelope);
    assert.deepEqual(posts.map((call) => call.envelope.expectedVersion), [1, 3, 3]);
    assert.notEqual(posts[2].envelope.commandId, posts[1].envelope.commandId);
    assert.equal(posts[2].status, 200);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_attempts").get().n, before.length + 1);
  } finally { c.db.sqlite.close(); }
});

test("real main FinishPlan resubmit uses a new ID after FINAL rejection and current required checks", async () => {
  const c = createContext();
  try {
    const step = await setupResult(c, ["unit"]);
    const client = await realCommandClient(c, "main");
    const plan = { planId: PLAN_ID, version: 1 };
    await assert.rejects(() => client.command("FinishPlan", plan, {}), (error) => error.code === "CHECKPOINTS_INCOMPLETE");
    const rejected = client.calls.find((call) => call.envelope);
    assert.equal(client.calls.at(-1).body.status, "FINAL");
    assert.equal(client.calls.at(-1).body.commandType, "FinishPlan");
    assert.equal((await recordCheck(c, step.stepId, "unit", "PASSED")).status, 200);
    assert.equal(c.db.sqlite.prepare("SELECT version FROM plans").get().version, 1);
    await client.command("FinishPlan", plan, {});
    const posts = client.calls.filter((call) => call.envelope);
    assert.notEqual(posts[1].envelope.commandId, posts[0].envelope.commandId);
    assert.deepEqual(posts[1].envelope.payload, posts[0].envelope.payload);
    assert.equal(c.db.sqlite.prepare("SELECT status FROM plans").get().status, "COMPLETED");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM work_intervals WHERE end_ms IS NULL").get().n, 0);
    assert.equal((await request(c, "FinishPlan", rejected.envelope.payload, 1, rejected.envelope.commandId)).value.error.code, "CHECKPOINTS_INCOMPLETE");
  } finally { c.db.sqlite.close(); }
});

test("real main commit review correction requires a retained FINAL exclusion receipt and leaves rejection unchanged", async () => {
  const c = createContext();
  const otherPlan = "22222222-2222-4222-8222-222222222222";
  try {
    for (const planId of [PLAN_ID, otherPlan]) assert.equal((await request(c, "CreatePlan", {
      planId, title: "Commit review fixture", planCreatedAt: { precision: "dateOnly", on: "2026-10-01", timeZone: "UTC" },
    })).status, 200);
    c.db.sqlite.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,0,'main','available',1,?)").run(OWNER, REPOSITORY_ID, "fixture/review", c.now());
    for (const planId of [PLAN_ID, otherPlan]) assert.equal((await request(c, "AttachPlanRepository", { planId, repositoryId: REPOSITORY_ID }, 0)).status, 200);
    c.db.sqlite.prepare("INSERT INTO commits(owner_id,repository_id,sha,observed_at,message,url) VALUES(?,?,?,?,'synthetic','https://example.invalid/commit')").run(OWNER, REPOSITORY_ID, SHA_A, c.now());
    const payload = { repositoryId: REPOSITORY_ID, sha: SHA_A, status: "confirmed", reason: "Owner review" };
    assert.equal((await request(c, "ReviewCommitLink", { ...payload, planId: otherPlan, status: "excluded" }, 1)).status, 200);
    assert.equal((await request(c, "ReviewCommitLink", { ...payload, planId: PLAN_ID, status: "candidate" }, 1)).status, 200);
    const snapshot = () => ({
      plans: c.db.sqlite.prepare("SELECT plan_id,version FROM plans ORDER BY plan_id").all(),
      links: c.db.sqlite.prepare("SELECT * FROM plan_commit_links ORDER BY plan_id").all(),
      events: c.db.sqlite.prepare("SELECT * FROM plan_events ORDER BY event_id").all(),
      conflicts: c.db.sqlite.prepare("SELECT * FROM commit_attribution_conflicts").all(),
    });
    const before = snapshot();
    const client = await realCommandClient(c, "main"), plan = { planId: PLAN_ID, version: 2 };
    await assert.rejects(() => client.command("ReviewCommitLink", plan, payload), (error) => error.code === "COMMIT_EXCLUDED" && error.status === 409);
    const rejected = client.calls.find((call) => call.envelope);
    assert.equal(client.calls.at(-1).body.status, "FINAL");
    assert.equal(client.calls.at(-1).body.commandId, rejected.envelope.commandId);
    assert.equal(client.calls.at(-1).body.commandType, "ReviewCommitLink");
    assert.equal(client.calls.at(-1).body.error.code, "COMMIT_EXCLUDED");
    assert.deepEqual(snapshot(), before);
    assert.equal((await readTracker(c, "/api/tracker/commands/" + rejected.envelope.commandId, "another-owner")).value.status, "NOT_FOUND");
    await client.command("ReviewCommitLink", plan, { ...payload, status: "excluded" });
    const posts = client.calls.filter((call) => call.envelope);
    assert.notEqual(posts[1].envelope.commandId, posts[0].envelope.commandId);
    assert.equal(posts[1].status, 200);
    assert.equal(c.db.sqlite.prepare("SELECT status FROM plan_commit_links WHERE plan_id=?").get(PLAN_ID).status, "excluded");
    const after = snapshot();
    const replay = await request(c, "ReviewCommitLink", rejected.envelope.payload, 2, rejected.envelope.commandId);
    assert.equal(replay.status, 409);
    assert.equal(replay.value.error.code, "COMMIT_EXCLUDED");
    assert.deepEqual(snapshot(), after);
    const collision = await request(c, "ReviewCommitLink", { ...rejected.envelope.payload, status: "excluded" }, 2, rejected.envelope.commandId);
    assert.equal(collision.value.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.deepEqual(snapshot(), after);
    // A version change between preflight and the atomic rejection INSERT must win.
    const prepare = c.db.prepare.bind(c.db);
    let raced = false;
    c.db.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql.includes("FROM plans p") && sql.includes("'COMMIT_EXCLUDED'")) {
        const run = statement.run.bind(statement);
        statement.run = async () => {
          if (!raced) { raced = true; c.db.sqlite.prepare("UPDATE plans SET version=version+1 WHERE owner_id=? AND plan_id=?").run(OWNER, PLAN_ID); }
          return run();
        };
        const bind = statement.bind.bind(statement);
        statement.bind = (...args) => {
          const bound = bind(...args), boundRun = bound.run.bind(bound);
          bound.run = async () => {
            if (!raced) { raced = true; c.db.sqlite.prepare("UPDATE plans SET version=version+1 WHERE owner_id=? AND plan_id=?").run(OWNER, PLAN_ID); }
            return boundRun();
          };
          return bound;
        };
      }
      return statement;
    };
    const raceId = commandId();
    const race = await request(c, "ReviewCommitLink", rejected.envelope.payload, 3, raceId);
    assert.equal(raced, true);
    assert.equal(race.value.error.code, "VERSION_CONFLICT");
    assert.equal((await readTracker(c, "/api/tracker/commands/" + raceId)).value.error.code, "VERSION_CONFLICT");
    assert.deepEqual(snapshot().links, after.links);
    assert.deepEqual(snapshot().events, after.events);
    assert.deepEqual(snapshot().conflicts, after.conflicts);
  } finally { c.db.sqlite.close(); }
});

test("normal finish requires all current checks and no separate owner decision", async () => {
  const c = createContext();
  try {
    const step = await setupResult(c);
    const wrongSha = await recordCheck(c, step.stepId, "unit", "PASSED", SHA_B);
    assert.equal(wrongSha.status, 409);
    assert.equal(wrongSha.value.error.code, "RESULT_REVISION_STALE");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM step_checks").get().count, 0);
    assert.equal((await recordCheck(c, step.stepId, "unit", "PASSED")).status, 200);
    const missing = await request(c, "FinishPlan", { planId: PLAN_ID }, 1);
    assert.equal(missing.value.error.code, "CHECKPOINTS_INCOMPLETE");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM work_intervals WHERE end_ms IS NULL").get().count, 1);
    assert.equal((await recordCheck(c, step.stepId, "build", "PASSED")).status, 200);
    const snapshot = (await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution")).value;
    assert.equal(snapshot.steps[0].readyToFinish, true);
    assert.deepEqual(snapshot.steps[0].currentChecks.map(check => check.check_key), ["build", "unit"]);
    assert(snapshot.steps[0].currentChecks.every(check => check.matchesCurrentResult));
    assert.equal(snapshot.steps[0].version, 3, "checks never mutate step version");
    c.setNow(c.now() + 1000);
    const finished = await request(c, "FinishPlan", { planId: PLAN_ID }, 1);
    assert.equal(finished.status, 200);
    assert.equal(finished.value.result.status, "COMPLETED");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM tracker_finish_exceptions").get().count, 0);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM step_acceptances").get().count, 0);
  } finally { c.db.sqlite.close(); }
});

test("terminal stale-check and expired-lease rejections have final receipts and no tracker side effects", async () => {
  const checkContext = createContext();
  const checkStep = await setupResult(checkContext, ["unit"], SHA_B);
  const checkEnvelopeId = commandId();
  const invalidCheck = {
    stepId: checkStep.stepId, resultRevision: 1, checkKey: "unit", status: "PASSED",
    testedSha: SHA_A, exitCode: 0, evidenceSummary: "Correct format, wrong result revision.",
  };
  const checkBefore = trackerSideEffects(checkContext, checkStep.stepId);
  const rejectedCheck = await request(checkContext, "RecordCheck", invalidCheck, undefined, checkEnvelopeId);
  assert.equal(rejectedCheck.status, 409);
  assert.equal(rejectedCheck.value.error.code, "RESULT_REVISION_STALE");
  assert.deepEqual(trackerSideEffects(checkContext, checkStep.stepId), checkBefore);
  const checkReceipt = await readTracker(checkContext, "/api/tracker/commands/" + checkEnvelopeId);
  assert.equal(checkReceipt.status, 200);
  assert.equal(checkReceipt.value.status, "FINAL");
  assert.equal(checkReceipt.value.commandId, checkEnvelopeId);
  assert.equal(checkReceipt.value.commandType, "RecordCheck");
  assert.equal(checkReceipt.value.error.code, "RESULT_REVISION_STALE");
  assert.equal(checkReceipt.value.resultVersion, 3);
  const hiddenReceipt = await readTracker(checkContext, "/api/tracker/commands/" + checkEnvelopeId, "another-owner");
  assert.deepEqual(hiddenReceipt.value, { status: "NOT_FOUND", commandId: checkEnvelopeId }, "command receipts are scoped to the authenticated owner");
  const checkReplay = await request(checkContext, "RecordCheck", invalidCheck, undefined, checkEnvelopeId);
  assert.equal(checkReplay.status, 409);
  assert.equal(checkReplay.value.error.code, "RESULT_REVISION_STALE");
  assert.deepEqual(trackerSideEffects(checkContext, checkStep.stepId), checkBefore);
  const correctedCheck = await request(checkContext, "RecordCheck", { ...invalidCheck, testedSha: SHA_B, evidenceSummary: "Verified against current revision." });
  assert.equal(correctedCheck.status, 200);
  assert.equal(checkContext.db.sqlite.prepare("SELECT COUNT(*) AS count FROM step_checks WHERE owner_id=? AND step_id=?").get(OWNER, checkStep.stepId).count, 1);
  assert.equal(checkContext.db.sqlite.prepare("SELECT COUNT(*) AS count FROM tracker_journal WHERE owner_id=? AND step_id=? AND event_type='CHECK_RECORDED'").get(OWNER, checkStep.stepId).count, 1);

  const leaseContext = createContext();
  const expired = await createExpiredAttempt(leaseContext);
  const resultEnvelopeId = commandId();
  const invalidResult = {
    stepId: expired.stepId, attemptId: expired.attemptId, fence: expired.fence,
    outcome: "DONE", summary: "Initial summary rejected after lease expiry.",
  };
  const resultBefore = trackerSideEffects(leaseContext, expired.stepId);
  const rejectedResult = await request(leaseContext, "RecordStepResult", invalidResult, 2, resultEnvelopeId);
  assert.equal(rejectedResult.status, 409);
  assert.equal(rejectedResult.value.error.code, "LEASE_EXPIRED");
  assert.deepEqual(trackerSideEffects(leaseContext, expired.stepId), resultBefore);
  const resultReceipt = await readTracker(leaseContext, "/api/tracker/commands/" + resultEnvelopeId);
  assert.equal(resultReceipt.status, 200);
  assert.equal(resultReceipt.value.status, "FINAL");
  assert.equal(resultReceipt.value.commandId, resultEnvelopeId);
  assert.equal(resultReceipt.value.commandType, "RecordStepResult");
  assert.equal(resultReceipt.value.error.code, "LEASE_EXPIRED");
  const resultReplay = await request(leaseContext, "RecordStepResult", invalidResult, 2, resultEnvelopeId);
  assert.equal(resultReplay.status, 409);
  assert.equal(resultReplay.value.error.code, "LEASE_EXPIRED");
  assert.deepEqual(trackerSideEffects(leaseContext, expired.stepId), resultBefore);
  const correctedResult = await request(leaseContext, "RecordStepResult", { ...invalidResult, summary: "Corrected summary after final rejection." }, 2);
  assert.equal(correctedResult.status, 409);
  assert.equal(correctedResult.value.error.code, "LEASE_EXPIRED");
  assert.deepEqual(trackerSideEffects(leaseContext, expired.stepId), resultBefore);
});

test("same-timestamp latest server-sequence FAILED and NOT_RUN invalidate earlier PASS", async () => {
  for (const status of ["FAILED", "NOT_RUN"]) {
    const c = createContext();
    try {
      const step = await setupResult(c, ["unit"]);
      assert.equal((await recordCheck(c, step.stepId, "unit", "PASSED")).status, 200);
      assert.equal((await recordCheck(c, step.stepId, "unit", status, SHA_A, 7)).status, 200);
      const snapshot = (await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution")).value;
      assert.equal(snapshot.steps[0].readyToFinish, false);
      assert.equal(snapshot.steps[0].currentChecks.length, 1);
      assert.equal(snapshot.steps[0].currentChecks[0].status, status);
      assert.equal(snapshot.steps[0].checks[0].status, status);
      assert.equal(snapshot.steps[0].checks[0].created_at, snapshot.steps[0].checks[1].created_at);
      assert(snapshot.steps[0].checks[0].server_sequence > snapshot.steps[0].checks[1].server_sequence);
      assert.equal(snapshot.steps[0].version, 3);
      assert.equal((await request(c, "FinishPlan", { planId: PLAN_ID }, 1)).value.error.code, "CHECKPOINTS_INCOMPLETE");
      assert.equal((await recordCheck(c, step.stepId, "unit", "PASSED")).status, 200);
      assert.equal((await request(c, "FinishPlan", { planId: PLAN_ID }, 1)).status, 200);
    } finally { c.db.sqlite.close(); }
  }
});

test("added required check invalidates prior readiness through explicit checkpoint rework", async () => {
  const c = createContext();
  try {
    const step = await setupResult(c, ["unit"]);
    await recordCheck(c, step.stepId, "unit", "PASSED");
    assert.equal((await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution")).value.steps[0].readyToFinish, true);
    const update = await request(c, "UpdateStep", { stepId: step.stepId, changes: { requiredChecks: ["unit", "build"] }, reason: "Require build for a revised checkpoint" }, 3);
    assert.equal(update.status, 200);
    assert.equal(update.value.result.status, "PENDING");
    const snapshot = (await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution")).value;
    assert.equal(snapshot.steps[0].readyToFinish, false);
    assert.equal(snapshot.steps[0].currentResult, null);
    assert.deepEqual(snapshot.steps[0].currentChecks, []);
    assert.equal(snapshot.steps[0].resultHistory.length, 1);
    assert.equal(snapshot.steps[0].checks.length, 1);
    assert.equal((await request(c, "FinishPlan", { planId: PLAN_ID }, 1)).value.error.code, "CHECKPOINTS_INCOMPLETE");
  } finally { c.db.sqlite.close(); }
});

test("rework and a new result revision never inherit older PASS checks", async () => {
  const c = createContext();
  try {
    const step = await setupResult(c, ["unit"], SHA_A);
    assert.equal((await recordCheck(c, step.stepId, "unit", "PASSED", SHA_A)).status, 200);
    const reworkReason = "Owner assigned rework after rebase";
    const rework = await request(c, "ClaimStepAttempt", {
      stepId: step.stepId, sessionId: "55555555-5555-4555-8555-555555555555", sourceId: "codex-local", clientType: "LOCAL", reworkReason,
    }, 3);
    assert.equal(rework.status, 200);
    assert.equal((await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution")).value.steps[0].readyToFinish, false, "open rework attempt blocks finish even before StartStep");
    const lease = { stepId: step.stepId, attemptId: rework.value.result.attemptId, fence: rework.value.result.fence };
    assert.equal((await request(c, "StartStep", { ...lease, rework: true, reason: reworkReason }, 3)).status, 200);
    assert.equal((await request(c, "RecordStepResult", { ...lease, outcome: "DONE", summary: "New SHA result", repositoryId: REPOSITORY_ID, revisionSha: SHA_B }, 4)).status, 200);
    assert.equal((await request(c, "RecordCheck", { stepId: step.stepId, resultRevision: 2, checkKey: "unit", status: "PASSED", testedSha: SHA_A, exitCode: 0 })).value.error.code, "RESULT_REVISION_STALE");
    // A valid historical check is preserved without making the new revision ready.
    assert.equal((await request(c, "RecordCheck", { stepId: step.stepId, resultRevision: 1, checkKey: "unit", status: "PASSED", testedSha: SHA_A, exitCode: 0 })).status, 200);
    let snapshot = (await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution")).value;
    assert.equal(snapshot.steps[0].currentResult.revision, 2);
    assert.equal(snapshot.steps[0].readyToFinish, false);
    assert.deepEqual(snapshot.steps[0].currentChecks, []);
    assert.equal((await request(c, "FinishPlan", { planId: PLAN_ID }, 1)).value.error.code, "CHECKPOINTS_INCOMPLETE");
    assert.equal((await request(c, "RecordCheck", { stepId: step.stepId, resultRevision: 2, checkKey: "unit", status: "PASSED", testedSha: SHA_B, exitCode: 0 })).status, 200);
    assert.equal((await request(c, "FinishPlan", { planId: PLAN_ID }, 1)).status, 200);
  } finally { c.db.sqlite.close(); }
});

test("commit observations distinguish local evidence from synced public proof and redact inaccessible private evidence", async () => {
  const c = createContext();
  const step = await setupResult(c, ["unit"], SHA_A);
  assert.equal((await request(c, "RecordCheck", {
    stepId: step.stepId, resultRevision: 1, checkKey: "unit", status: "PASSED", testedSha: SHA_A,
    exitCode: 0, evidenceSummary: "bounded check metadata", evidenceUrl: "https://example.test/private-evidence",
  })).status, 200);
  await c.db.prepare("INSERT INTO commits(owner_id,repository_id,sha,observed_at,message,url) VALUES(?,?,?,?,?,?)")
    .bind(OWNER, REPOSITORY_ID, SHA_A, c.now(), "bounded fixture", "https://github.com/fixture/evidence/commit/" + SHA_A).run();
  await c.db.prepare("INSERT INTO repository_sync_state(owner_id,repository_id,ref,last_successful_sync_at,completeness) VALUES(?,?,?,?,'complete')")
    .bind(OWNER, REPOSITORY_ID, "main", c.now()).run();
  await c.db.prepare("INSERT INTO repository_ref_commits(owner_id,repository_id,ref,sha,last_seen_sync_id) VALUES(?,?,?,?,?)")
    .bind(OWNER, REPOSITORY_ID, "main", SHA_A, "sync-fixture").run();
  const observationBase = {
    planId: PLAN_ID, stepId: step.stepId, attemptId: step.attemptId, sourceId: "codex-local", sessionId: SESSION_ID,
    occurredAt: c.now(), data: { repositoryId: REPOSITORY_ID, revisionSha: SHA_A, ref: "main", resultRevision: 1 },
  };
  const local = await request(c, "AppendObservation", {
    ...observationBase, eventId: "77777777-7777-4777-8777-777777777777", sourceSequence: 1, eventType: "commit_created",
  });
  assert.equal(local.status, 200);
  const pushed = await request(c, "AppendObservation", {
    ...observationBase, eventId: "88888888-8888-4888-8888-888888888888", sourceSequence: 2, eventType: "commit_pushed",
    data: { repositoryId: REPOSITORY_ID, revisionSha: SHA_A, ref: "main" },
  });
  assert.equal(pushed.status, 200);
  const publicTimeline = await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/timeline?afterSequence=0&limit=100");
  assert.equal(publicTimeline.status, 200);
  const localEvent = publicTimeline.value.events.find((event) => event.eventId === local.value.result.eventId);
  const pushedEvent = publicTimeline.value.events.find((event) => event.eventId === pushed.value.result.eventId);
  assert.equal(localEvent.gitEvidence.localObserved, true);
  assert.equal(localEvent.gitEvidence.remoteVerified, true);
  assert.equal(pushedEvent.gitEvidence.refMembership, "present");

  await c.db.prepare("UPDATE repositories SET is_private=1,access_state='unavailable' WHERE owner_id=? AND repository_id=?")
    .bind(OWNER, REPOSITORY_ID).run();
  const privateTimeline = await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/timeline?afterSequence=0&limit=100");
  const redactedEvent = privateTimeline.value.events.find((event) => event.eventId === local.value.result.eventId);
  assert.deepEqual(redactedEvent.payload, { eventId: local.value.result.eventId, eventType: "commit_created", redacted: true });
  assert.equal(redactedEvent.gitEvidence.protectedDetailsHidden, true);
  assert.equal(redactedEvent.gitEvidence.remoteVerified, null);
  const snapshot = await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution");
  assert.equal(snapshot.value.steps[0].currentResult.protectedRevisionHidden, true);
  assert.equal(snapshot.value.steps[0].currentResult.revision_sha, null);
  assert.equal(snapshot.value.steps[0].checks[0].protectedEvidenceHidden, true);
  assert.equal(snapshot.value.steps[0].checks[0].tested_sha, null);
  assert.equal(snapshot.value.steps[0].checks[0].evidence_url, null);
});

test("execution snapshot reports blocked, retry, failed-result, and server-recorded check-delay bottlenecks", async () => {
  const c = createContext();
  const step = await setupResult(c, ["unit"], SHA_A);
  c.setNow(c.now() + 17000);
  assert.equal((await request(c, "RecordCheck", {
    stepId: step.stepId, resultRevision: 1, checkKey: "unit", status: "PASSED", testedSha: SHA_A,
    exitCode: 0, evidenceSummary: "check recorded after result",
  })).status, 200);

  const snapshot = await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution");
  assert.equal(snapshot.status, 200);
  assert.deepEqual(snapshot.value.bottlenecks, {
    blockedSteps: 0, blockedEvents: 0, retries: 0,
    retryMeasurement: "attempts with fence greater than 1; includes lease recovery and owner-assigned rework",
    failedResults: 0,
    checkDelay: {
      sampleCount: 1, medianMs: 17000, maxMs: 17000,
      measurement: "server time from result recording to first check recording; not test execution time",
    },
  });
});

function applicationRows(c) {
  return Object.fromEntries(c.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name,
    c.db.sqlite.prepare('SELECT * FROM "' + name + '"').all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]));
}

// Historical fixture only: execute the installed pre-0013 trigger directly.
// The current Worker never exposes a compatibility handler for these commands.
function historicalDecision(c, stepId, decision, waivers = []) {
  assert.ok(c.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='command_decide_step'").get(), "historical fixture requires the old schema");
  const id = commandId(), acceptanceId = commandId(), eventId = commandId();
  const row = c.db.sqlite.prepare("SELECT version,current_result_revision FROM plan_steps WHERE step_id=?").get(stepId);
  const payload = { stepId, resultRevision: row.current_result_revision, acceptanceId, decision, reason: "Historical explicit decision", waiversJson: JSON.stringify(waivers), eventId, eventPayloadJson: JSON.stringify({ stepId, resultRevision: row.current_result_revision, decision, waivers }), eventPayloadHash: "a".repeat(64) };
  c.db.sqlite.prepare(`INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,recorded_at)
    VALUES(?,?,?,?,?,?,?,?,'user',?,'PENDING',?)`).run(OWNER, id, "b".repeat(64), decision === "ACCEPTED" ? "AcceptStep" : "RejectStep", PLAN_ID, row.version, c.now(), OWNER, JSON.stringify(payload), c.now());
  assert.equal(c.db.sqlite.prepare("SELECT outcome_code FROM command_receipts WHERE command_id=?").get(id).outcome_code, "OK");
  return { commandId: id, acceptanceId, payload };
}

test("0013 populated upgrade preserves every historical row, receipt, active lease and timer while waivers become inert", async () => {
  const migrationName = "0013_remove_owner_acceptance.sql", migrationIndex = migrations.indexOf(migrationName);
  assert.ok(migrationIndex > 0);
  const c = createContext(migrationIndex);
  try {
    const step = await setupResult(c, ["unit", "build"]);
    assert.equal((await recordCheck(c, step.stepId, "unit", "PASSED")).status, 200);
    const accepted = historicalDecision(c, step.stepId, "ACCEPTED", [{ checkKey: "build", reason: "Historical risk waiver" }]);
    historicalDecision(c, step.stepId, "REJECTED");
    historicalDecision(c, step.stepId, "ACCEPTED", [{ checkKey: "build", reason: "Historical risk waiver" }]);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM tracker_incomplete_steps").get().n, 0, "old waiver bypass is reproduced on the previous schema");
    const activeCreated = await request(c, "CreateStep", { planId: PLAN_ID, ordinal: 1, title: "Active checkpoint", expectedResult: "Retain active lease", requiredChecks: [], commitPolicy: "NEVER", pushPolicy: "NEVER" });
    const activeStepId = activeCreated.value.result.stepId;
    const activeClaim = await request(c, "ClaimStepAttempt", { stepId: activeStepId, sessionId: commandId(), sourceId: "upgrade-active" }, 1);
    const active = { stepId: activeStepId, attemptId: activeClaim.value.result.attemptId, fence: activeClaim.value.result.fence };
    assert.equal((await request(c, "StartStep", active, 1)).status, 200);
    assert.equal((await request(c, "UpdatePlanMetadata", { planId: PLAN_ID, planCreatedAt: { precision: "dateOnly", on: "2026-10-02", timeZone: "UTC" }, reason: "Historical date correction" }, 1)).status, 200);
    const refusalId = commandId(), refused = await request(c, "FinishPlan", { planId: PLAN_ID }, 2, refusalId);
    assert.equal(refused.value.error.code, "CHECKPOINTS_INCOMPLETE");
    const before = applicationRows(c);
    for (const table of ["plans", "work_intervals", "plan_events", "plan_date_history", "command_receipts", "plan_steps", "step_attempts", "step_results", "step_checks", "step_acceptances", "tracker_journal"]) assert.ok(before[table].length > 0, table);
    c.db.sqlite.exec(readFileSync(resolve(migrationDirectory, migrationName), "utf8"));
    assert.deepEqual(applicationRows(c), before, "the append-only migration changes no persisted application row");
    assert.deepEqual(c.db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(c.db.sqlite.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(c.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='command_decide_step'").get(), undefined);
    for (const type of ["AcceptStep", "RejectStep"]) {
      const rejected = await request(c, type, { stepId: step.stepId, resultRevision: 1, reason: "Old client", waivers: [] }, 3, accepted.commandId);
      assert.equal(rejected.status, 400);
      assert.equal(rejected.value.error.code, "VALIDATION_ERROR");
      assert.deepEqual(applicationRows(c), before, "old clients cannot activate or replay the removed mechanism");
      const mcp = await c.worker.fetch(new Request("https://tracker.test/mcp", { method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-id": OWNER }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: type, arguments: { schemaVersion: 1, commandId: commandId(), payload: { stepId: step.stepId, resultRevision: 1, reason: "Old MCP client" }, expectedVersion: 3 } } }) }), { DB: c.db });
      const value = await mcp.json();
      assert.equal(value.result.isError, true);
      assert.equal(value.result.structuredContent.code, "VALIDATION_ERROR");
      assert.deepEqual(applicationRows(c), before);
    }
    const historicalReceipt = (await readTracker(c, "/api/tracker/commands/" + accepted.commandId)).value;
    assert.equal(historicalReceipt.status, "FINAL");
    assert.equal(historicalReceipt.result.decision, "ACCEPTED", "historic audit receipt remains readable, never an active operation");
    const execution = (await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution")).value;
    const oldStep = execution.steps.find(item => item.step_id === step.stepId);
    assert.equal(oldStep.readyToFinish, false, "historical build waiver cannot replace its missing check");
    for (const key of Object.keys(oldStep)) assert.ok(!/acceptance/i.test(key), key);
    assert.equal((await request(c, "FinishPlan", { planId: PLAN_ID }, 2, refusalId)).value.error.code, "CHECKPOINTS_INCOMPLETE");
    assert.deepEqual(applicationRows(c), before, "failed receipt replay preserves rows");
    const oldPointers = c.db.sqlite.prepare("SELECT acceptance_revision,acceptance_decision,current_acceptance_id,version FROM plan_steps WHERE step_id=?").get(step.stepId);
    assert.equal((await recordCheck(c, step.stepId, "build", "FAILED", SHA_A, 1)).status, 200);
    assert.deepEqual(c.db.sqlite.prepare("SELECT acceptance_revision,acceptance_decision,current_acceptance_id,version FROM plan_steps WHERE step_id=?").get(step.stepId), oldPointers, "new check does not mutate inert decision history or version");
    assert.equal((await recordCheck(c, step.stepId, "build", "PASSED")).status, 200);
    assert.equal((await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution")).value.steps.find(item => item.step_id === step.stepId).readyToFinish, true);
    const historicalPointers = () => c.db.sqlite.prepare("SELECT acceptance_revision,acceptance_decision,current_acceptance_id FROM plan_steps WHERE step_id=?").get(step.stepId);
    const immutablePointers = historicalPointers();
    const rework = await request(c, "ClaimStepAttempt", { stepId: step.stepId, sessionId: commandId(), sourceId: "upgrade-rework", reworkReason: "Explicitly rework the old result" }, oldPointers.version);
    assert.equal(rework.status, 200);
    const reworkLease = { stepId: step.stepId, attemptId: rework.value.result.attemptId, fence: rework.value.result.fence };
    assert.equal((await request(c, "StartStep", { ...reworkLease, rework: true, reason: "Explicitly rework the old result" }, oldPointers.version)).status, 200);
    assert.deepEqual(historicalPointers(), immutablePointers, "StartStep leaves historical decision pointers inert");
    assert.equal((await request(c, "BlockStep", { ...reworkLease, reason: "Temporary fixture blocker" }, oldPointers.version + 1)).status, 200);
    assert.deepEqual(historicalPointers(), immutablePointers, "BlockStep preserves historical pointers");
    assert.equal((await request(c, "CloseStepAttempt", { ...reworkLease, disposition: "CLOSED", reason: "Update requirements explicitly" })).value.error.code, "ATTEMPT_CLOSED");
    assert.equal((await request(c, "UpdateStep", { stepId: step.stepId, changes: { title: "Reworked historical checkpoint" }, reason: "Safe new checkpoint revision" }, oldPointers.version + 2)).status, 200);
    assert.deepEqual(historicalPointers(), immutablePointers, "UpdateStep preserves historical pointers");
    const newClaim = await request(c, "ClaimStepAttempt", { stepId: step.stepId, sessionId: commandId(), sourceId: "upgrade-new-result" }, oldPointers.version + 3);
    assert.equal(newClaim.status, 200);
    const newLease = { stepId: step.stepId, attemptId: newClaim.value.result.attemptId, fence: newClaim.value.result.fence };
    assert.equal((await request(c, "StartStep", newLease, oldPointers.version + 3)).status, 200);
    assert.equal((await request(c, "RecordStepResult", { ...newLease, outcome: "DONE", summary: "New revision, no old decision reuse", repositoryId: REPOSITORY_ID, revisionSha: SHA_B }, oldPointers.version + 4)).status, 200);
    assert.deepEqual(historicalPointers(), immutablePointers, "RecordStepResult preserves history but never reads it as readiness");
    let revised = (await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution")).value.steps.find(item => item.step_id === step.stepId);
    assert.equal(revised.currentResult.revision, 2);
    assert.equal(revised.readyToFinish, false);
    assert.deepEqual(revised.currentChecks, []);
    for (const checkKey of ["unit", "build"]) assert.equal((await request(c, "RecordCheck", { stepId: step.stepId, resultRevision: 2, checkKey, status: "PASSED", testedSha: SHA_B, exitCode: 0 })).status, 200);
    revised = (await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution")).value.steps.find(item => item.step_id === step.stepId);
    assert.equal(revised.readyToFinish, true);
    c.setNow(c.now() + 1000);
    assert.equal((await request(c, "RenewStepLease", active, 2)).status, 200);
    assert.deepEqual(applicationRows(c).work_intervals, before.work_intervals);
    const finish = await request(c, "FinishPlan", { planId: PLAN_ID, allowIncomplete: true, reason: "Conscious exception for the active checkpoint" }, 2);
    assert.equal(finish.status, 200);
    const exception = c.db.sqlite.prepare("SELECT snapshot_json FROM tracker_finish_exceptions WHERE command_id=?").get(finish.value.commandId);
    const snapshot = JSON.parse(exception.snapshot_json);
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].stepId, activeStepId);
    assert.ok(!JSON.stringify(snapshot).toLowerCase().includes("acceptance"));
    assert.equal(c.db.sqlite.prepare("SELECT status FROM step_attempts WHERE attempt_id=?").get(active.attemptId).status, "ABANDONED");
    assert.deepEqual(applicationRows(c).step_acceptances, before.step_acceptances, "finish exception preserves historic decisions");
  } finally { c.db.sqlite.close(); }
});

test("empty required checks permit a DONE result without SHA but never a live attempt", async () => {
  const c = createContext();
  try {
    const step = await setupResult(c, [], null);
    const execution = (await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution")).value;
    assert.equal(execution.steps[0].currentResult.revision_sha, null);
    assert.equal(execution.steps[0].readyToFinish, true);
    assert.deepEqual(execution.steps[0].currentChecks, []);
    const claim = await request(c, "ClaimStepAttempt", { stepId: step.stepId, sessionId: commandId(), sourceId: "no-sha-rework", reworkReason: "Explicit rework claim" }, 3);
    assert.equal(claim.status, 200);
    assert.equal((await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution")).value.steps[0].readyToFinish, false);
    assert.equal((await request(c, "FinishPlan", { planId: PLAN_ID }, 1)).value.error.code, "CHECKPOINTS_INCOMPLETE");
    assert.equal((await request(c, "CloseStepAttempt", { stepId: step.stepId, attemptId: claim.value.result.attemptId, fence: claim.value.result.fence, disposition: "CLOSED", reason: "Cancel explicit rework claim" })).status, 200);
    assert.equal((await request(c, "FinishPlan", { planId: PLAN_ID }, 1)).status, 200);
  } finally { c.db.sqlite.close(); }
});

test("authoritative required-check summary survives history truncation and private-SHA redaction", async () => {
  const c = createContext();
  try {
    const step = await setupResult(c, ["unit"]);
    assert.equal((await recordCheck(c, step.stepId, "unit", "PASSED")).status, 200);
    for (let index = 0; index < 101; index++) assert.equal((await recordCheck(c, step.stepId, "optional-" + index, "PASSED")).status, 200);
    c.db.sqlite.prepare("UPDATE repositories SET is_private=1,access_state='revoked' WHERE repository_id=?").run(REPOSITORY_ID);
    const execution = (await readTracker(c, "/api/tracker/plans/" + PLAN_ID + "/execution")).value;
    assert.equal(execution.steps[0].checks.length, 100);
    assert.equal(execution.steps[0].checks.some(check => check.check_key === "unit"), false);
    assert.equal(execution.steps[0].currentChecks.length, 102);
    const unit = execution.steps[0].currentChecks.find(check => check.check_key === "unit");
    assert.equal(unit.tested_sha, null);
    assert.equal(unit.matchesCurrentResult, true);
    assert.equal(unit.protectedEvidenceHidden, true);
    assert.equal(execution.steps[0].readyToFinish, true, "protected SHA redaction must not invalidate authoritative readiness");
    assert.equal(execution.steps[0].currentResult.revision_sha, null);
    assert.equal((await request(c, "FinishPlan", { planId: PLAN_ID }, 1)).status, 200);
  } finally { c.db.sqlite.close(); }
});
