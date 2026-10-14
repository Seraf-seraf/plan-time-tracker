import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker } from "../worker/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const migrationDirectory = resolve(root, "drizzle");
const schema = readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()
  .map((name) => readFileSync(resolve(migrationDirectory, name), "utf8")).join("\n");
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
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(schema);
  }
  prepare(sql) { return new Statement(this, sql); }
}

function createContext() {
  const db = new TestDatabase();
  let now = 1800000000000;
  const worker = createWorker(() => now);
  return { db, worker, now: () => now, setNow: (value) => { now = value; } };
}

async function request(c, commandType, payload, expectedVersion) {
  const envelope = { schemaVersion: 1, commandId: commandId(), commandType, payload };
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
    repositoryId: REPOSITORY_ID, revisionSha,
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

test("required checks bind to a result SHA, and owner acceptance/rejection stay separate from agent completion", async () => {
  const c = createContext();
  const step = await setupResult(c);

  const wrongSha = await recordCheck(c, step.stepId, "unit", "PASSED", SHA_B);
  assert.equal(wrongSha.status, 409);
  assert.equal(wrongSha.value.error.code, "RESULT_REVISION_STALE");
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM step_checks WHERE owner_id=?").get(OWNER).count, 0);

  assert.equal((await recordCheck(c, step.stepId, "unit", "PASSED")).status, 200);
  const missingBuild = await request(c, "AcceptStep", {
    stepId: step.stepId, resultRevision: 1, reason: "Проверяю готовый результат.",
  }, 3);
  assert.equal(missingBuild.status, 409);
  assert.equal(missingBuild.value.error.code, "CHECKS_INCOMPLETE");
  assert.equal((await recordCheck(c, step.stepId, "build", "PASSED")).status, 200);

  const accepted = await request(c, "AcceptStep", {
    stepId: step.stepId, resultRevision: 1, reason: "Проверки совпали с SHA результата.",
  }, 3);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.value.result.decision, "ACCEPTED");
  assert.equal(accepted.value.result.version, 4);
  assert.equal(c.db.sqlite.prepare("SELECT status,outcome FROM plan_steps JOIN step_results USING(owner_id,step_id) WHERE owner_id=? AND step_id=? AND revision=1").get(OWNER, step.stepId).status, "DONE");
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM tracker_incomplete_steps WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID).count, 0);

  const rejected = await request(c, "RejectStep", {
    stepId: step.stepId, resultRevision: 1, reason: "Владелец просит изменить одну деталь.",
  }, 4);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.value.result.decision, "REJECTED");
  assert.equal(c.db.sqlite.prepare("SELECT status,acceptance_decision FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, step.stepId).status, "DONE");
  assert.equal(c.db.sqlite.prepare("SELECT acceptance_decision FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, step.stepId).acceptance_decision, "REJECTED");
  const acceptedAgain = await request(c, "AcceptStep", {
    stepId: step.stepId, resultRevision: 1, reason: "Повторная проверка результата завершена.",
  }, 5);
  assert.equal(acceptedAgain.status, 200);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM step_acceptances WHERE owner_id=? AND step_id=?").get(OWNER, step.stepId).count, 3);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM tracker_journal WHERE owner_id=? AND step_id=? AND event_type IN ('STEP_ACCEPTED','STEP_REJECTED')").get(OWNER, step.stepId).count, 3);

  c.setNow(c.now() + 1000);
  const finished = await request(c, "FinishPlan", { planId: PLAN_ID }, 1);
  assert.equal(finished.status, 200);
  assert.equal(finished.value.result.status, "COMPLETED");
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM tracker_finish_exceptions WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID).count, 0);
});

test("owner waivers are recorded and may cover only named required checks", async () => {
  const c = createContext();
  const step = await setupResult(c, ["unit"]);
  assert.equal((await recordCheck(c, step.stepId, "unit", "FAILED", SHA_A, 7)).status, 200);
  const missing = await request(c, "AcceptStep", {
    stepId: step.stepId, resultRevision: 1, reason: "Попытка принятия без waiver.",
  }, 3);
  assert.equal(missing.status, 409);
  assert.equal(missing.value.error.code, "CHECKS_INCOMPLETE");

  const waiver = { checkKey: "unit", reason: "Владелец принял риск единственной известной нестабильной проверки." };
  const accepted = await request(c, "AcceptStep", {
    stepId: step.stepId, resultRevision: 1, reason: "Принято с явным исключением.", waivers: [waiver],
  }, 3);
  assert.equal(accepted.status, 200);
  assert.equal(c.db.sqlite.prepare("SELECT acceptance_decision FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, step.stepId).acceptance_decision, "ACCEPTED");
  const saved = JSON.parse(c.db.sqlite.prepare("SELECT waivers_json FROM step_acceptances WHERE owner_id=? AND acceptance_id=?").get(OWNER, accepted.value.result.acceptanceId).waivers_json);
  assert.deepEqual(saved, [waiver]);
  const timelinePayload = JSON.parse(c.db.sqlite.prepare("SELECT payload_json FROM tracker_journal WHERE owner_id=? AND command_id=?").get(OWNER, accepted.value.commandId).payload_json);
  assert.deepEqual(timelinePayload.waivers, [waiver]);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM tracker_incomplete_steps WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID).count, 0);

  const extraWaiver = await request(c, "AcceptStep", {
    stepId: step.stepId, resultRevision: 1, reason: "Недопустимый дополнительный waiver.",
    waivers: [{ checkKey: "unrequired", reason: "Этот ключ не задан checkpoint." }],
  }, 4);
  assert.equal(extraWaiver.status, 422);
  assert.equal(extraWaiver.value.error.code, "VALIDATION_ERROR");
});

test("new evidence can invalidate current acceptance while preserving its immutable history", async () => {
  const c = createContext();
  const step = await setupResult(c, ["unit"]);
  assert.equal((await recordCheck(c, step.stepId, "unit", "PASSED")).status, 200);
  const accepted = await request(c, "AcceptStep", {
    stepId: step.stepId, resultRevision: 1, reason: "Проверка unit прошла.",
  }, 3);
  assert.equal(accepted.status, 200);

  const lateFailure = await recordCheck(c, step.stepId, "unit", "FAILED", SHA_A, 2);
  assert.equal(lateFailure.status, 200);
  const current = { ...c.db.sqlite.prepare("SELECT version,status,acceptance_decision,acceptance_revision,current_acceptance_id FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, step.stepId) };
  assert.deepEqual(current, { version: 5, status: "DONE", acceptance_decision: "NONE", acceptance_revision: null, current_acceptance_id: null });
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM step_acceptances WHERE owner_id=? AND acceptance_id=?").get(OWNER, accepted.value.result.acceptanceId).count, 1);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM tracker_incomplete_steps WHERE owner_id=? AND step_id=?").get(OWNER, step.stepId).count, 1);
});

test("a new result revision does not inherit prior checks or acceptance", async () => {
  const c = createContext();
  const step = await setupResult(c, ["unit"], SHA_A);
  assert.equal((await recordCheck(c, step.stepId, "unit", "PASSED", SHA_A)).status, 200);
  const accepted = await request(c, "AcceptStep", {
    stepId: step.stepId, resultRevision: 1, reason: "Первая ревизия принята.",
  }, 3);
  assert.equal(accepted.status, 200);

  const reworkReason = "Владелец назначил обновление после rebase.";
  const rework = await request(c, "ClaimStepAttempt", {
    stepId: step.stepId, sessionId: "55555555-5555-4555-8555-555555555555", sourceId: "codex-local",
    clientType: "LOCAL", reworkReason,
  }, 4);
  assert.equal(rework.status, 200);
  assert.equal((await request(c, "StartStep", {
    stepId: step.stepId, attemptId: rework.value.result.attemptId, fence: rework.value.result.fence,
    rework: true, reason: reworkReason,
  }, 4)).status, 200);
  const revised = await request(c, "RecordStepResult", {
    stepId: step.stepId, attemptId: rework.value.result.attemptId, fence: rework.value.result.fence,
    outcome: "DONE", summary: "Результат после изменения SHA.", repositoryId: REPOSITORY_ID, revisionSha: SHA_B,
  }, 5);
  assert.equal(revised.status, 200);
  assert.equal(revised.value.result.resultRevision, 2);

  const wrongRevisionCheck = await request(c, "RecordCheck", {
    stepId: step.stepId, resultRevision: 2, checkKey: "unit", status: "PASSED", testedSha: SHA_A, exitCode: 0,
  });
  assert.equal(wrongRevisionCheck.status, 409);
  assert.equal(wrongRevisionCheck.value.error.code, "RESULT_REVISION_STALE");
  const acceptance = await request(c, "AcceptStep", {
    stepId: step.stepId, resultRevision: 2, reason: "Нельзя принять по тесту старой ревизии.",
  }, 6);
  assert.equal(acceptance.status, 409);
  assert.equal(acceptance.value.error.code, "CHECKS_INCOMPLETE");
  const current = { ...c.db.sqlite.prepare("SELECT current_result_revision,acceptance_decision,current_acceptance_id FROM plan_steps WHERE owner_id=? AND step_id=?").get(OWNER, step.stepId) };
  assert.deepEqual(current, { current_result_revision: 2, acceptance_decision: "NONE", current_acceptance_id: null });
  assert.equal(c.db.sqlite.prepare("SELECT decision FROM step_acceptances WHERE owner_id=? AND acceptance_id=?").get(OWNER, accepted.value.result.acceptanceId).decision, "ACCEPTED");
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
