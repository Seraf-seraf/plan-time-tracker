import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const migration = (name) => readFileSync(resolve(root, "drizzle", name), "utf8");
const ID = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const PLAN_A = ID(101);
const PLAN_B = ID(102);
const STEP_A = ID(201);
const STEP_B = ID(202);
const STEP_C = ID(203);
const SESSION_A = ID(301);
const ATTEMPT_A = ID(401);
const ATTEMPT_B = ID(402);
const RESULT_A = ID(501);
const CHECK_A = ID(601);
const ACCEPTANCE_A = ID(701);
const EVENT_A = ID(801);
const EVENT_B = ID(802);
const SHA = "a".repeat(40);
const HASH = "b".repeat(64);

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(migration("0001_initial.sql"));
  db.exec(migration("0002_command_guards.sql"));
  db.exec(migration("0003_sync_execution_guards.sql"));
  db.exec(migration("0004_tracker.sql"));
  return db;
}

function seedOwner(db, ownerId = "owner-a") {
  db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,1000)").run(ownerId);
}

function seedPlan(db, ownerId = "owner-a", planId = PLAN_A) {
  db.prepare(`INSERT INTO plans(
    plan_id,owner_id,title,plan_created_precision,plan_created_on,
    plan_created_timezone,registered_at,status,version,created_by
  ) VALUES(?,?,'Tracker plan','dateOnly','2026-10-01','UTC',1000,'PLANNED',0,?)`)
    .run(planId, ownerId, ownerId);
}

function seedStep(db, stepId = STEP_A, ordinal = 0, planId = PLAN_A, ownerId = "owner-a") {
  db.prepare(`INSERT INTO plan_steps(
    owner_id,step_id,plan_id,ordinal,title,expected_result,required_checks_json,
    created_at,updated_at
  ) VALUES(?,?,?,?,'Checkpoint','Expected outcome','["unit"]',1000,1000)`)
    .run(ownerId, stepId, planId, ordinal);
}

function seedSession(db) {
  db.prepare(`INSERT INTO tracker_sessions(owner_id,session_id,source_id,client_type,executor_label,created_at)
    VALUES('owner-a',?,'codex-local','LOCAL','agent-1',1000)`).run(SESSION_A);
}

function seedAttempt(db, attemptId = ATTEMPT_A, fence = 1, stepId = STEP_A, status = "OPEN") {
  const closedAt = status === "OPEN" ? null : 1200;
  db.prepare(`INSERT INTO step_attempts(owner_id,attempt_id,step_id,session_id,status,fence,lease_until,started_at,closed_at)
    VALUES('owner-a',?,?,? ,?,?,11000,1000,?)`)
    .run(attemptId, stepId, SESSION_A, status, fence, closedAt);
}

function seedJournal(db, eventId = EVENT_A, sequence = 1, stepId = STEP_A, overrides = {}) {
  db.prepare(`INSERT INTO tracker_journal(
    owner_id,event_id,plan_id,step_id,server_sequence,event_type,payload_json,payload_hash,
    occurred_at,received_at,classification
  ) VALUES('owner-a',?,?,?,?,'STEP_NOTE','{}',?,1000,1000,'NORMAL')`)
    .run(eventId, PLAN_A, stepId, sequence, HASH);
}

test("tracker migration preserves legacy plans, intervals, events, and receipts", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(migration("0001_initial.sql"));
  db.prepare("INSERT INTO owners(owner_id,created_at) VALUES('legacy-owner',1234)").run();
  db.prepare(`INSERT INTO plans(
    plan_id,owner_id,title,plan_created_precision,plan_created_on,plan_created_timezone,
    registered_at,status,version,created_by
  ) VALUES(?,'legacy-owner','Legacy','dateOnly','2026-10-01','UTC',1234,'PLANNED',0,'legacy-owner')`).run(PLAN_A);
  db.prepare(`INSERT INTO work_intervals(interval_id,owner_id,plan_id,start_ms,end_ms,opened_by,closed_by)
    VALUES('legacy-interval','legacy-owner',?,2000,3000,'legacy-owner','legacy-owner')`).run(PLAN_A);
  db.prepare(`INSERT INTO plan_events(event_id,owner_id,plan_id,command_id,actor_id,actor_type,event_type,
    server_occurred_at,version_before,version_after,reason)
    VALUES('legacy-event','legacy-owner',?,'legacy-command','legacy-owner','user','CREATED',1234,0,0,NULL)`)
    .run(PLAN_A);
  db.prepare(`INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,plan_id,server_now_ms,
    actor_id,actor_type,payload_json,outcome_code,result_version,result_json,recorded_at)
    VALUES('legacy-owner','legacy-command','${HASH}','CreatePlan',?,1234,'legacy-owner','user','{}','OK',0,'{}',1234)`)
    .run(PLAN_A);
  const before = Object.fromEntries(["plans", "work_intervals", "plan_events", "command_receipts"]
    .map((table) => [table, db.prepare("SELECT * FROM " + table).all()]));

  db.exec(migration("0002_command_guards.sql"));
  db.exec(migration("0003_sync_execution_guards.sql"));
  db.exec(migration("0004_tracker.sql"));

  for (const table of Object.keys(before)) assert.deepEqual(db.prepare("SELECT * FROM " + table).all(), before[table]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tracker_plan_config").get().count, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});

test("tracker schema enforces owner and parent scope, uniqueness, and immutable history", () => {
  const db = database();
  seedOwner(db);
  seedOwner(db, "owner-b");
  seedPlan(db);
  seedPlan(db, "owner-a", PLAN_B);
  seedPlan(db, "owner-b", PLAN_A);
  seedStep(db, STEP_A, 0, PLAN_A);
  seedStep(db, STEP_B, 1, PLAN_A);
  seedStep(db, STEP_C, 0, PLAN_B);
  db.prepare("INSERT INTO tracker_plan_config(owner_id,plan_id,created_at,updated_at) VALUES('owner-a',?,1000,1000)").run(PLAN_A);
  seedSession(db);

  assert.throws(() => seedStep(db, ID(204), 0, PLAN_A), /UNIQUE constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO plan_steps(owner_id,step_id,plan_id,ordinal,title,expected_result,created_at,updated_at)
    VALUES('owner-b',?, ?,0,'Cross owner','No attach',1000,1000)`).run(ID(205), PLAN_B), /FOREIGN KEY constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO plan_steps(owner_id,step_id,plan_id,ordinal,title,expected_result,commit_policy,created_at,updated_at)
    VALUES('owner-a',?,? ,2,'Bad policy','No attach','AUTO_PUSH',1000,1000)`).run(ID(206), PLAN_A), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO plan_steps(owner_id,step_id,plan_id,ordinal,title,expected_result,required_checks_json,created_at,updated_at)
    VALUES('owner-a',?,? ,2,'Bad JSON','No attach','{}',1000,1000)`).run(ID(207), PLAN_A), /CHECK constraint failed/);

  seedAttempt(db);
  assert.throws(() => seedAttempt(db, ATTEMPT_B, 2), /UNIQUE constraint failed/);
  seedAttempt(db, ATTEMPT_B, 2, STEP_A, "CLOSED");
  assert.throws(() => db.prepare(`INSERT INTO step_attempts(owner_id,attempt_id,step_id,session_id,status,fence,lease_until,started_at,closed_at)
    VALUES('owner-b',?,?,?,'OPEN',1,11000,1000,NULL)`).run(ID(403), STEP_A, SESSION_A), /FOREIGN KEY constraint failed/);
  db.prepare(`INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,updated_at)
    VALUES('owner-a','repo-1','owner/repo',0,'main','available',1000)`).run();

  db.prepare(`INSERT INTO step_results(owner_id,result_id,step_id,attempt_id,revision,outcome,summary,repository_id,revision_sha,payload_hash,created_at)
    VALUES('owner-a',?,?,?,1,'DONE','Completed','repo-1',?,?,2000)`)
    .run(RESULT_A, STEP_A, ATTEMPT_A, SHA, HASH);
  db.prepare("UPDATE plan_steps SET current_result_revision=1 WHERE owner_id='owner-a' AND step_id=?").run(STEP_A);
  assert.throws(() => db.prepare("UPDATE plan_steps SET current_result_revision=1 WHERE owner_id='owner-a' AND step_id=?").run(STEP_B), /FOREIGN KEY constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO step_results(owner_id,result_id,step_id,attempt_id,revision,outcome,summary,repository_id,revision_sha,payload_hash,created_at)
    VALUES('owner-a',?,?,?,2,'DONE','Wrong attempt','repo-1',?,?,2000)`)
    .run(ID(502), STEP_B, ATTEMPT_A, SHA, HASH), /FOREIGN KEY constraint failed/);

  db.prepare("INSERT INTO tracker_owner_state(owner_id,next_sequence) VALUES('owner-a',1)").run();
  seedJournal(db);
  assert.equal(db.prepare("SELECT next_sequence FROM tracker_owner_state WHERE owner_id='owner-a'").get().next_sequence, 2);
  assert.throws(() => db.prepare(`INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at)
    VALUES('owner-a',?,?,?,4,'GAP','{}',?,1000,1000)`)
    .run(EVENT_B, PLAN_A, STEP_A, HASH), /TRACKER_SEQUENCE_CONFLICT/);

  db.prepare(`INSERT INTO tracker_sessions(owner_id,session_id,source_id,client_type,created_at)
    VALUES('owner-a',?,'source-2','WEB',1000)`).run(ID(302));
  db.prepare(`INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,source_id,session_id,source_sequence,server_sequence,
    event_type,payload_json,payload_hash,occurred_at,received_at)
    VALUES('owner-a',?,?,?,'codex-local',?,0,2,'OBSERVATION','{}',?,1000,1100)`)
    .run(EVENT_B, PLAN_A, STEP_A, SESSION_A, HASH);
  assert.throws(() => db.prepare(`INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,source_id,session_id,source_sequence,server_sequence,
    event_type,payload_json,payload_hash,occurred_at,received_at)
    VALUES('owner-a',?,?,?,'codex-local',?,0,3,'OBSERVATION','{}',?,1000,1200)`)
    .run(ID(803), PLAN_A, STEP_A, SESSION_A, HASH), /UNIQUE constraint failed/);

  db.prepare(`INSERT INTO step_checks(owner_id,check_id,step_id,result_revision,event_id,check_key,status,tested_sha,exit_code,created_at)
    VALUES('owner-a',?,?,1,?,'unit','PASSED',?,0,1300)`)
    .run(CHECK_A, STEP_A, EVENT_A, SHA);
  db.prepare(`INSERT INTO step_acceptances(owner_id,acceptance_id,step_id,result_revision,decision,actor_id,reason,created_at)
    VALUES('owner-a',?,?,1,'ACCEPTED','owner-a','Owner accepted revision 1',1400)`)
    .run(ACCEPTANCE_A, STEP_A);
  assert.throws(() => db.prepare("UPDATE step_results SET summary='edited' WHERE owner_id='owner-a' AND result_id=?").run(RESULT_A), /STEP_RESULTS_ARE_IMMUTABLE/);
  assert.throws(() => db.prepare("DELETE FROM step_checks WHERE owner_id='owner-a' AND check_id=?").run(CHECK_A), /STEP_CHECKS_ARE_IMMUTABLE/);
  assert.throws(() => db.prepare("UPDATE step_acceptances SET reason='edited' WHERE owner_id='owner-a' AND acceptance_id=?").run(ACCEPTANCE_A), /STEP_ACCEPTANCES_ARE_IMMUTABLE/);
  assert.throws(() => db.prepare("DELETE FROM tracker_journal WHERE owner_id='owner-a' AND event_id=?").run(EVENT_A), /TRACKER_JOURNAL_IS_IMMUTABLE/);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});

test("tracker schema applies integer millisecond, bounded text, SHA, and correction constraints", () => {
  const db = database();
  seedOwner(db);
  seedPlan(db);
  seedStep(db);
  db.prepare("INSERT INTO tracker_owner_state(owner_id,next_sequence) VALUES('owner-a',1)").run();
  seedJournal(db);

  assert.throws(() => db.prepare(`INSERT INTO tracker_journal(owner_id,event_id,plan_id,server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at)
    VALUES('owner-a',?,?,2,'BAD','[]',?,1000,1000)`)
    .run(ID(804), PLAN_A, HASH), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO tracker_journal(owner_id,event_id,plan_id,server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at)
    VALUES('owner-a',?,?,2,'BAD','{}',?,1.5,1000)`)
    .run(ID(805), PLAN_A, HASH), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO tracker_journal(owner_id,event_id,plan_id,server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at,classification)
    VALUES('owner-a',?,?,2,'CORRECTION','{}',?,1000,1000,'CORRECTION')`)
    .run(ID(806), PLAN_A, HASH), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO step_results(owner_id,result_id,step_id,attempt_id,revision,outcome,summary,repository_id,revision_sha,payload_hash,created_at)
    VALUES('owner-a',?,?,?,1,'DONE','bad SHA','repo-1',?, ?,2000)`)
    .run(ID(507), STEP_A, ID(404), "not-a-sha", HASH), /CHECK constraint failed|FOREIGN KEY constraint failed/);
  db.close();
});
