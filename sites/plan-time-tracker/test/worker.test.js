import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Script } from "node:vm";
import {
  AppError,
  buildAnalytics,
  calculateActiveMs,
  calculateCalendarMs,
  createWorker,
  executeCommand,
  executeSyncCommand,
  GitHubRestAdapter,
  inclusiveDateRange,
  median,
  parsePlanCreatedAt,
  payloadHash,
  resolveUiTimeZone,
  syncRepository,
} from "../worker/index.js";

const migrationsDirectory = new URL("../drizzle/", import.meta.url);
const schema = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()
  .map((name) => readFileSync(new URL(name, migrationsDirectory), "utf8")).join("\n");

class SqliteStatement {
  constructor(database, sql, args = []) { this.database = database; this.sql = sql; this.args = args; }
  bind(...args) { return new SqliteStatement(this.database, this.sql, args); }
  async run() {
    const result = this.database.sqlite.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
  async first() { return this.database.sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { success: true, results: this.database.sqlite.prepare(this.sql).all(...this.args) }; }
}

class SqliteD1 {
  constructor(migrationSql = schema) {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(migrationSql);
  }
  prepare(sql) { return new SqliteStatement(this, sql); }
  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        const result = this.sqlite.prepare(statement.sql).run(...statement.args);
        results.push({ success: true, meta: { changes: Number(result.changes) } });
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

const OWNER = "chatgpt-owner-1";
const OTHER = "chatgpt-owner-2";
const PLAN_A = "11111111-1111-4111-8111-111111111111";
const PLAN_B = "22222222-2222-4222-8222-222222222222";
let commandNumber = 0;
const commandId = () => {
  commandNumber += 1;
  return "a0000000-0000-4000-8000-" + String(commandNumber).padStart(12, "0");
};

function context(startTime = Date.parse("2026-10-09T13:00:00Z")) {
  const db = new SqliteD1();
  let now = startTime;
  const worker = createWorker(() => now);
  return { db, worker, now: () => now, setNow: (value) => { now = value; } };
}

function request(path, options = {}, ownerId = OWNER) {
  const headers = new Headers(options.headers || {});
  if (ownerId) {
    headers.set("oai-authenticated-user-id", ownerId);
    headers.set("oai-authenticated-user-email", ownerId + "@example.test");
  }
  if (options.body) headers.set("content-type", "application/json");
  return new Request("https://tracker.test" + path, { ...options, headers });
}

async function call(worker, db, path, options = {}, ownerId = OWNER) {
  const response = await worker.fetch(request(path, options, ownerId), { DB: db });
  return { response, body: await response.json() };
}

async function createPlan(worker, db, planId, title = "Feature implementation", ownerId = OWNER, extra = {}) {
  return call(worker, db, "/api/commands", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: 1,
      commandId: commandId(),
      commandType: "CreatePlan",
      payload: {
        title,
        description: "Implementation work",
        acceptanceCriteria: "Tests pass",
        planCreatedAt: { precision: "dateOnly", on: "2026-10-08", timeZone: "Europe/Moscow" },
        repositoryIds: [],
        planId: planId,
        ...extra,
      },
    }),
  }, ownerId);
}

async function transition(worker, db, type, planId, version, ownerId = OWNER, now = undefined, id = commandId()) {
  const payload = { planId: planId };
  const body = JSON.stringify({ schemaVersion: 1, commandId: id, commandType: type, expectedVersion: version, payload: payload });
  const response = await worker.fetch(request("/api/commands", { method: "POST", body: body }, ownerId), { DB: db });
  return { response, body: await response.json(), commandId: id };
}

test("owner identity is mandatory and request owner fields cannot select another account", async () => {
  const c = context();
  const anonymous = await c.worker.fetch(new Request("https://tracker.test/api/plans"), { DB: c.db });
  assert.equal(anonymous.status, 401);
  await createPlan(c.worker, c.db, PLAN_A);
  const foreign = await call(c.worker, c.db, "/api/plans/" + PLAN_A, {}, OTHER);
  assert.equal(foreign.response.status, 404);
  const spoof = await call(c.worker, c.db, "/api/commands", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: 1, commandId: commandId(), commandType: "StartPlan", expectedVersion: 0,
      ownerId: OTHER, payload: { planId: PLAN_A, ownerId: OTHER },
    }),
  });
  assert.equal(spoof.response.status, 200);
  const plan = await c.db.prepare("SELECT owner_id FROM plans WHERE plan_id=?").bind(PLAN_A).first();
  assert.equal(plan.owner_id, OWNER);
});

test("owner composite foreign keys prevent cross-owner children from attaching to another plan", async () => {
  const c = context();
  await createPlan(c.worker, c.db, PLAN_A);
  assert.throws(() => c.db.sqlite.prepare("INSERT INTO work_intervals(interval_id,owner_id,plan_id,start_ms,opened_by) VALUES('cross-owner',?,?,?,?)")
    .run(OTHER, PLAN_A, c.now(), OTHER), /FOREIGN KEY constraint failed/);
  assert.throws(() => c.db.sqlite.prepare("INSERT INTO plan_events(event_id,owner_id,plan_id,command_id,actor_id,actor_type,event_type,server_occurred_at,version_before,version_after) VALUES('cross-event',?,?,?,?,'user','X',?,0,0)")
    .run(OTHER, PLAN_A, commandId(), OTHER, c.now()), /FOREIGN KEY constraint failed/);
});

test("the same client-supplied plan UUID is isolated by owner, including open-interval uniqueness", async () => {
  const c=context();
  assert.equal((await createPlan(c.worker,c.db,PLAN_A,"Owner one plan",OWNER)).response.status,200);
  assert.equal((await createPlan(c.worker,c.db,PLAN_A,"Owner two plan",OTHER)).response.status,200);
  assert.equal((await transition(c.worker,c.db,"StartPlan",PLAN_A,0,OWNER)).response.status,200);
  assert.equal((await transition(c.worker,c.db,"StartPlan",PLAN_A,0,OTHER)).response.status,200);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM plans WHERE plan_id=?").bind(PLAN_A).first()).n,2);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM work_intervals WHERE plan_id=? AND end_ms IS NULL").bind(PLAN_A).first()).n,2);
  const ownerOne=await call(c.worker,c.db,"/api/plans/"+PLAN_A,{},OWNER);
  const ownerTwo=await call(c.worker,c.db,"/api/plans/"+PLAN_A,{},OTHER);
  assert.equal(ownerOne.body.plan.title,"Owner one plan");
  assert.equal(ownerTwo.body.plan.title,"Owner two plan");
});

test("Create records plan date separately from registration and creates no interval", async () => {
  const c = context();
  const created = await createPlan(c.worker, c.db, PLAN_A);
  assert.equal(created.response.status, 200);
  assert.equal(created.body.result.status, "PLANNED");
  const row = await c.db.prepare("SELECT registered_at,plan_created_precision,plan_created_on,status FROM plans WHERE plan_id=?").bind(PLAN_A).first();
  assert.equal(row.registered_at, c.now());
  assert.equal(row.plan_created_precision, "dateOnly");
  assert.equal(row.plan_created_on, "2026-10-08");
  assert.equal(row.status, "PLANNED");
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM work_intervals WHERE plan_id=?").bind(PLAN_A).first()).n, 0);
});

test("CreatePlan preserves the optional envelope-level sourceReference", async () => {
  const c=context();
  const env={schemaVersion:1,commandId:commandId(),commandType:"CreatePlan",sourceReference:"https://docs.example.test/spec/42",payload:{
    title:"Referenced plan",planCreatedAt:{precision:"dateOnly",on:"2026-10-08",timeZone:"UTC"},repositoryIds:[],
  }};
  const result=await call(c.worker,c.db,"/api/commands",{method:"POST",body:JSON.stringify(env)});
  assert.equal(result.response.status,200);
  assert.equal((await c.db.prepare("SELECT source_reference FROM plans WHERE plan_id=?").bind(result.body.result.planId).first()).source_reference,"https://docs.example.test/spec/42");
});

test("Start/Pause/Resume/Finish store only server-timed half-open intervals", async () => {
  const c = context();
  await createPlan(c.worker, c.db, PLAN_A);
  const start = Date.parse("2026-10-09T13:00:00Z");
  const pause = Date.parse("2026-10-09T15:00:00Z");
  const resume = Date.parse("2026-10-12T07:00:00Z");
  const finish = Date.parse("2026-10-12T09:30:00Z");
  c.setNow(start);
  assert.equal((await transition(c.worker, c.db, "StartPlan", PLAN_A, 0)).response.status, 200);
  c.setNow(pause);
  assert.equal((await transition(c.worker, c.db, "PausePlan", PLAN_A, 1)).response.status, 200);
  c.setNow(resume);
  assert.equal((await transition(c.worker, c.db, "ResumePlan", PLAN_A, 2)).response.status, 200);
  c.setNow(finish);
  assert.equal((await transition(c.worker, c.db, "FinishPlan", PLAN_A, 3)).response.status, 200);
  const detail = await call(c.worker, c.db, "/api/plans/" + PLAN_A);
  assert.equal(detail.body.plan.activeMs, 4.5 * 60 * 60 * 1000);
  assert.equal(detail.body.plan.calendarMs, 68.5 * 60 * 60 * 1000);
  assert.equal(detail.body.plan.pausedMs, 64 * 60 * 60 * 1000);
  assert.deepEqual(detail.body.plan.intervals.map((i) => [i.start_ms, i.end_ms]), [[start, pause], [resume, finish]]);
  assert.equal(detail.body.plan.serverNow, finish);
});

test("an open tab is not required for the server to report elapsed running time", async () => {
  const c = context(Date.parse("2026-10-09T13:00:00Z"));
  await createPlan(c.worker, c.db, PLAN_A);
  await transition(c.worker, c.db, "StartPlan", PLAN_A, 0);
  c.setNow(Date.parse("2026-10-10T13:00:00Z"));
  const response = await call(c.worker, c.db, "/api/plans/" + PLAN_A);
  assert.equal(response.body.plan.status, "RUNNING");
  assert.equal(response.body.plan.activeMs, 24 * 60 * 60 * 1000);
  assert.equal(response.body.plan.intervals[0].end_ms, null);
});

test("Start of two plans at once permits one RUNNING plan only", async () => {
  const c = context();
  await createPlan(c.worker, c.db, PLAN_A, "Plan A");
  await createPlan(c.worker, c.db, PLAN_B, "Plan B");
  const outcomes = await Promise.all([
    transition(c.worker, c.db, "StartPlan", PLAN_A, 0),
    transition(c.worker, c.db, "StartPlan", PLAN_B, 0),
  ]);
  assert.deepEqual(outcomes.map((x) => x.response.status).sort(), [200, 409]);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM plans WHERE owner_id=? AND status='RUNNING'").bind(OWNER).first()).n, 1);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM work_intervals WHERE owner_id=? AND end_ms IS NULL").bind(OWNER).first()).n, 1);
  assert.equal(outcomes.find((x) => x.response.status === 409).body.error.code, "ACTIVE_PLAN_EXISTS");
});

test("same commandId returns its original receipt before checking newer version", async () => {
  const c = context();
  await createPlan(c.worker, c.db, PLAN_A);
  const id = commandId();
  c.setNow(Date.parse("2026-10-09T13:00:00Z"));
  const first = await transition(c.worker, c.db, "StartPlan", PLAN_A, 0, OWNER, undefined, id);
  c.setNow(Date.parse("2026-10-09T14:00:00Z"));
  await transition(c.worker, c.db, "PausePlan", PLAN_A, 1);
  const replay = await transition(c.worker, c.db, "StartPlan", PLAN_A, 0, OWNER, undefined, id);
  assert.equal(first.response.status, 200);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(first.body.applied, true);
  assert.equal(replay.body.applied, false);
  assert.equal(replay.body.commandId, id);
  assert.equal(replay.body.serverNow, first.body.serverNow);
  assert.equal(replay.body.resultingVersion, first.body.resultingVersion);
  assert.deepEqual(replay.body.snapshot, first.body.snapshot);
  assert.deepEqual(replay.body.result, first.body.result);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM plan_events WHERE owner_id=? AND plan_id=? AND event_type='STARTED'").bind(OWNER, PLAN_A).first()).n, 1);
});

test("same commandId with changed payload is rejected", async () => {
  const c = context();
  const id = commandId();
  const first = {
    schemaVersion: 1, commandId: id, commandType: "CreatePlan",
    payload: { title: "A", planCreatedAt: { precision: "dateOnly", on: "2026-10-08", timeZone: "UTC" }, repositoryIds: [] },
  };
  await call(c.worker, c.db, "/api/commands", { method: "POST", body: JSON.stringify(first) });
  const second = { ...first, payload: { ...first.payload, title: "B" } };
  const result = await call(c.worker, c.db, "/api/commands", { method: "POST", body: JSON.stringify(second) });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "IDEMPOTENCY_KEY_REUSED");
});

test("error envelope contains a requestId and explicit retry fields without leaking database text", async () => {
  const c = context();
  const result = await call(c.worker, c.db, "/api/commands", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: 1, commandId: commandId(), commandType: "StartPlan", expectedVersion: 0, payload: { planId: PLAN_A } }),
  });
  assert.equal(result.response.status, 404);
  assert.equal(result.body.error.code, "PLAN_NOT_FOUND");
  assert.match(result.body.error.requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.body.error.retryable, false);
  assert.equal(result.body.error.retryAfter, null);
  assert.doesNotMatch(JSON.stringify(result.body.error), /sqlite|constraint failed/i);
});

test("repeated Pause with the same commandId returns the original receipt once", async () => {
  const c = context();
  await createPlan(c.worker, c.db, PLAN_A);
  await transition(c.worker, c.db, "StartPlan", PLAN_A, 0);
  const id = commandId();
  const first = await transition(c.worker, c.db, "PausePlan", PLAN_A, 1, OWNER, undefined, id);
  const retry = await transition(c.worker, c.db, "PausePlan", PLAN_A, 1, OWNER, undefined, id);
  assert.equal(first.response.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM plan_events WHERE plan_id=? AND event_type='PAUSED'").bind(PLAN_A).first()).n, 1);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM work_intervals WHERE plan_id=?").bind(PLAN_A).first()).n, 1);
});

test("stale expectedVersion changes nothing; repeated finish can recover the stored result", async () => {
  const c = context();
  await createPlan(c.worker, c.db, PLAN_A);
  await transition(c.worker, c.db, "StartPlan", PLAN_A, 0);
  const stale = await transition(c.worker, c.db, "ResumePlan", PLAN_A, 0);
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM plan_events WHERE plan_id=?").bind(PLAN_A).first()).n, 2);
  const finishId = commandId();
  const fin = await transition(c.worker, c.db, "FinishPlan", PLAN_A, 1, OWNER, undefined, finishId);
  const retry = await transition(c.worker, c.db, "FinishPlan", PLAN_A, 1, OWNER, undefined, finishId);
  assert.equal(fin.response.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM plan_events WHERE plan_id=? AND event_type='FINISHED'").bind(PLAN_A).first()).n, 1);
});

test("failed event write rolls back plan, interval, event, and receipt as one SQLite statement", async () => {
  const c = context();
  await createPlan(c.worker, c.db, PLAN_A);
  c.db.sqlite.exec("CREATE TRIGGER fail_start_event BEFORE INSERT ON plan_events WHEN NEW.event_type='STARTED' BEGIN SELECT RAISE(ABORT,'INJECTED_EVENT_FAILURE'); END");
  const id = commandId();
  const failed = await transition(c.worker, c.db, "StartPlan", PLAN_A, 0, OWNER, undefined, id);
  assert.equal(failed.response.status, 500);
  assert.equal((await c.db.prepare("SELECT status,version FROM plans WHERE plan_id=?").bind(PLAN_A).first()).status, "PLANNED");
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM work_intervals WHERE plan_id=?").bind(PLAN_A).first()).n, 0);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM command_receipts WHERE command_id=?").bind(id).first()).n, 0);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM plan_events WHERE plan_id=? AND event_type='STARTED'").bind(PLAN_A).first()).n, 0);
});

test("Finish while paused adds no time; plan and event history remain queryable", async () => {
  const c = context();
  await createPlan(c.worker, c.db, PLAN_A);
  c.setNow(1000);
  await transition(c.worker, c.db, "StartPlan", PLAN_A, 0);
  c.setNow(4000);
  await transition(c.worker, c.db, "PausePlan", PLAN_A, 1);
  c.setNow(1_000_000);
  await transition(c.worker, c.db, "FinishPlan", PLAN_A, 2);
  const result = await call(c.worker, c.db, "/api/plans/" + PLAN_A);
  assert.equal(result.body.plan.activeMs, 3000);
  assert.equal(result.body.plan.calendarMs, 999000);
  assert.equal(result.body.plan.events.length, 4);
  assert.throws(() => c.db.sqlite.prepare("UPDATE plan_events SET reason='changed' WHERE plan_id=?").run(PLAN_A), /PLAN_EVENTS_ARE_IMMUTABLE/);
  assert.throws(() => c.db.sqlite.prepare("DELETE FROM command_receipts WHERE owner_id=?").run(OWNER), /COMMAND_RECEIPTS_ARE_RETAINED/);
});

test("plan date edits require a reason and explicit confirmation when moved past first start", async () => {
  const c = context(Date.parse("2026-10-09T08:00:00Z"));
  await createPlan(c.worker, c.db, PLAN_A);
  c.setNow(Date.parse("2026-10-09T09:00:00Z"));
  await transition(c.worker, c.db, "StartPlan", PLAN_A, 0);
  const update = async (id, confirm) => call(c.worker, c.db, "/api/commands", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: 1, commandId: id, commandType: "UpdatePlanMetadata", expectedVersion: 1,
      payload: { planId: PLAN_A, planCreatedAt: { precision: "dateOnly", on: "2026-10-12", timeZone: "Europe/Moscow" }, reason: "Corrected from source document", confirmDateAnomaly: confirm },
    }),
  });
  const blocked = await update(commandId(), false);
  assert.equal(blocked.response.status, 422);
  assert.equal(blocked.body.error.code, "VALIDATION_ERROR");
  assert.equal((await c.db.prepare("SELECT plan_created_on,version FROM plans WHERE plan_id=?").bind(PLAN_A).first()).plan_created_on, "2026-10-08");
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM plan_date_history WHERE plan_id=?").bind(PLAN_A).first()).n, 0);
  const accepted = await update(commandId(), true);
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.result.version, 2);
  assert.equal((await c.db.prepare("SELECT plan_created_on,version FROM plans WHERE plan_id=?").bind(PLAN_A).first()).plan_created_on, "2026-10-12");
  assert.equal((await c.db.prepare("SELECT reason FROM plan_date_history WHERE plan_id=?").bind(PLAN_A).first()).reason, "Corrected from source document");
});

test("empty metadata updates are rejected without incrementing plan version or adding an event", async () => {
  const c=context();
  await createPlan(c.worker,c.db,PLAN_A);
  const eventCountBefore=(await c.db.prepare("SELECT COUNT(*) AS n FROM plan_events WHERE plan_id=?").bind(PLAN_A).first()).n;
  const result=await call(c.worker,c.db,"/api/commands",{method:"POST",body:JSON.stringify({
    schemaVersion:1,commandId:commandId(),commandType:"UpdatePlanMetadata",expectedVersion:0,payload:{planId:PLAN_A,reason:"No fields"},
  })});
  assert.equal(result.response.status,400);
  assert.equal(result.body.error.code,"VALIDATION_ERROR");
  assert.equal((await c.db.prepare("SELECT version FROM plans WHERE plan_id=?").bind(PLAN_A).first()).version,0);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM plan_events WHERE plan_id=?").bind(PLAN_A).first()).n,eventCountBefore);
});

test("manual commit attribution checks repository ownership and records an auditable override", async () => {
  const c = context();
  await createPlan(c.worker, c.db, PLAN_A);
  const repoId = "repo-1";
  const sha = "a".repeat(40);
  await c.db.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,0,'main','available',1,?)")
    .bind(OWNER, repoId, "Seraf-seraf/demo", c.now()).run();
  await c.db.prepare("INSERT INTO plan_repositories(owner_id,plan_id,repository_id,selected_ref) VALUES(?,?,?,'main')")
    .bind(OWNER, PLAN_A, repoId).run();
  await c.db.prepare("INSERT INTO commits(owner_id,repository_id,sha,observed_at,message,url) VALUES(?,?,?,?,'change','https://github.com/Seraf-seraf/demo/commit/'||?)")
    .bind(OWNER, repoId, sha, c.now(), sha).run();
  const result = await call(c.worker, c.db, "/api/commands", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: 1, commandId: commandId(), commandType: "ReviewCommitLink", expectedVersion: 0,
      payload: { planId: PLAN_A, repositoryId: repoId, sha, status: "confirmed", reason: "Reviewed with the plan owner" },
    }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.commandId != null, true);
  assert.equal(result.body.applied, true);
  assert.equal(result.body.snapshot.result || result.body.snapshot.planId != null, true);
  assert.equal(result.body.serverOccurredAt, c.now());
  assert.equal(result.body.serverNow, c.now());
  assert.equal(result.body.resultingVersion, 1);
  const link = await c.db.prepare("SELECT status,basis,reason,reviewed_by FROM plan_commit_links WHERE plan_id=?").bind(PLAN_A).first();
  assert.deepEqual({ ...link }, { status: "confirmed", basis: "manual", reason: "Reviewed with the plan owner", reviewed_by: OWNER });
});

test("a post-finish commit can be explicitly linked without changing recorded time", async () => {
  const c=context();
  const repoId="post-finish",sha="e".repeat(40);
  await c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").bind(OWNER,c.now()).run();
  await c.db.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,0,'main','available',1,?)")
    .bind(OWNER,repoId,"Seraf-seraf/post-finish",c.now()).run();
  await createPlan(c.worker,c.db,PLAN_A,"Post finish",OWNER,{repositoryIds:[repoId],repositoryRefs:{[repoId]:"main"}});
  await transition(c.worker,c.db,"StartPlan",PLAN_A,0);
  c.setNow(c.now()+3600000);
  await transition(c.worker,c.db,"FinishPlan",PLAN_A,1);
  await c.db.prepare("INSERT INTO commits(owner_id,repository_id,sha,observed_at,message,url) VALUES(?,?,?,?,?,?)")
    .bind(OWNER,repoId,sha,c.now(),"later commit","https://github.com/Seraf-seraf/post-finish/commit/"+sha).run();
  const before=(await call(c.worker,c.db,"/api/plans/"+PLAN_A)).body.plan.activeMs;
  const review=await call(c.worker,c.db,"/api/commands",{method:"POST",body:JSON.stringify({
    schemaVersion:1,commandId:commandId(),commandType:"ReviewCommitLink",expectedVersion:2,
    payload:{planId:PLAN_A,repositoryId:repoId,sha,status:"confirmed",reason:"Explicitly linked after finish"},
  })});
  assert.equal(review.response.status,200);
  const after=(await call(c.worker,c.db,"/api/plans/"+PLAN_A)).body.plan;
  assert.equal(after.activeMs,before);
  assert.equal(after.commits[0].link_status,"confirmed");
  const analytics=await buildAnalytics(c.db,OWNER,{from:"2026-10-09",to:"2026-10-09",timeZone:"UTC"},c.now());
  assert.equal(analytics.completedPlans,1);
  assert.equal(analytics.completedMeasuredN,1);
});

test("one confirmed repository/SHA link is enforced across every plan owned by the same user", async () => {
  const c = context();
  const repoId = "unique-confirm";
  const sha = "a".repeat(40);
  await c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").bind(OWNER, c.now()).run();
  await c.db.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,0,'main','available',1,?)")
    .bind(OWNER, repoId, "Seraf-seraf/unique-confirm", c.now()).run();
  for (const [id, title] of [[PLAN_A, "First"], [PLAN_B, "Second"]]) {
    await createPlan(c.worker, c.db, id, title, OWNER, { repositoryIds: [repoId], repositoryRefs: { [repoId]: "main" } });
  }
  await c.db.prepare("INSERT INTO commits(owner_id,repository_id,sha,observed_at,message,url) VALUES(?,?,?,?,?,?)")
    .bind(OWNER, repoId, sha, c.now(), "commit", "https://github.com/Seraf-seraf/unique-confirm/commit/" + sha).run();
  const confirm = async (planId) => call(c.worker, c.db, "/api/commands", { method: "POST", body: JSON.stringify({
    schemaVersion: 1, commandId: commandId(), commandType: "ReviewCommitLink", expectedVersion: 0,
    payload: { planId, repositoryId: repoId, sha, status: "confirmed", reason: "explicit attribution" },
  }) });
  assert.equal((await confirm(PLAN_A)).response.status, 200);
  const duplicate = await confirm(PLAN_B);
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, "COMMIT_ALREADY_CONFIRMED");
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM plan_commit_links WHERE owner_id=? AND repository_id=? AND sha=? AND status='confirmed'").bind(OWNER, repoId, sha).first()).n, 1);
});

test("GitHub importer matches full Plan-ID, keeps time-overlap as candidate, and deduplicates SHA/ref", async () => {
  const c = context();
  const repoId = "42";
  const shaMarker = "b".repeat(40);
  const shaCandidate = "c".repeat(40);
  const shaUnknown = "e".repeat(40);
  await c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").bind(OWNER, c.now()).run();
  await c.db.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,1,'main','available',1,?)")
    .bind(OWNER, repoId, "Seraf-seraf/private-demo", c.now()).run();
  await createPlan(c.worker, c.db, PLAN_A, "Synced plan", OWNER, { repositoryIds: [repoId], repositoryRefs: { [repoId]: "main" } });
  c.setNow(Date.parse("2026-10-09T13:00:00Z"));
  await transition(c.worker, c.db, "StartPlan", PLAN_A, 0);
  c.setNow(Date.parse("2026-10-09T13:30:00Z"));
  const items = [
    { sha: shaMarker, commit: { message: "Implement feature\n\nPlan-ID: " + PLAN_A, author: { date: "2026-10-09T13:05:00Z", name: "Author" }, committer: { date: "2026-10-09T13:06:00Z", name: "Build Bot" } }, author: { id: 44, login: "alice", type: "User" }, committer: { id: 77, login: "build-bot", type: "Bot" }, html_url: "https://github.com/Seraf-seraf/private-demo/commit/" + shaMarker, parents: [] },
    { sha: shaCandidate, commit: { message: "Unmarked work", author: { date: "2026-10-09T12:00:00Z", name: "Other" }, committer: { date: "2026-10-09T13:10:00Z" } }, author: { id: 55 }, committer: { id: 55 }, html_url: "https://github.com/Seraf-seraf/private-demo/commit/" + shaCandidate, parents: [] },
    { sha: shaUnknown, commit: { message: "Unmapped identity\n\nPlan-ID: " + PLAN_A, author: { name: "Unknown Git author" }, committer: { date: "2026-10-09T13:20:00Z", name: "Unknown Git committer" } }, author: null, committer: null, html_url: "https://github.com/Seraf-seraf/private-demo/commit/" + shaUnknown, parents: [] },
  ];
  const adapter = { repository: async () => ({ id: 42, full_name: "Seraf-seraf/private-demo", private: true, default_branch: "main" }), commitPage: async () => ({ data: items, links: {} }) };
  const first = await syncRepository(c.db, OWNER, "Seraf-seraf/private-demo", null, "main", adapter, c.now());
  const second = await syncRepository(c.db, OWNER, "Seraf-seraf/private-demo", null, "main", adapter, c.now() + 1000);
  assert.equal(first.completeness, "complete");
  assert.equal(second.imported, 3);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM commits WHERE repository_id=?").bind("42").first()).n, 3);
  assert.equal((await c.db.prepare("SELECT status FROM plan_commit_links WHERE plan_id=? AND sha=?").bind(PLAN_A, shaMarker).first()).status, "confirmed");
  assert.equal((await c.db.prepare("SELECT status FROM plan_commit_links WHERE plan_id=? AND sha=?").bind(PLAN_A, shaCandidate).first()).status, "candidate");
  assert.equal((await c.db.prepare("SELECT refs_json FROM commits WHERE sha=?").bind(shaMarker).first()).refs_json, '["main"]');
  const commitDetails=(await call(c.worker,c.db,"/api/plans/"+PLAN_A)).body.plan.commits;
  const marked=commitDetails.find(commit=>commit.sha===shaMarker);
  assert.equal(marked.author_login,"alice");
  assert.equal(marked.author_type,"User");
  assert.equal(marked.committer_login,"build-bot");
  assert.equal(marked.committer_type,"Bot");
  const unknown=commitDetails.find(commit=>commit.sha===shaUnknown);
  assert.equal(unknown.author_type,"Unknown");
  assert.equal(unknown.author_github_id,null);
  assert.equal(unknown.committer_type,"Unknown");
  await transition(c.worker, c.db, "FinishPlan", PLAN_A, 1);
  const afterFinishSha = "d".repeat(40);
  items.push({ sha: afterFinishSha, commit: { message: "After finish", author: { date: "2026-10-09T14:00:00Z", name: "Author" }, committer: { date: "2026-10-09T14:00:00Z" } }, author: { id: 44 }, committer: { id: 44 }, html_url: "https://github.com/Seraf-seraf/private-demo/commit/" + afterFinishSha, parents: [] });
  c.setNow(Date.parse("2026-10-09T15:00:00Z"));
  await syncRepository(c.db, OWNER, "Seraf-seraf/private-demo", null, "main", adapter, c.now());
  assert.equal((await c.db.prepare("SELECT status FROM plan_commit_links WHERE plan_id=? AND sha=?").bind(PLAN_A, afterFinishSha).first()), null);
  assert.equal((await call(c.worker, c.db, "/api/plans/" + PLAN_A)).body.plan.activeMs, 30 * 60 * 1000);
});

test("time candidates can be filtered by stable GitHub author ID and the filter persists across syncs", async () => {
  const c=context();
  const repoId="author-filter-repo",shaA="a".repeat(40),shaB="b".repeat(40);
  await c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").bind(OWNER,c.now()).run();
  await c.db.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,0,'main','available',1,?)").bind(OWNER,repoId,"Seraf-seraf/author-filter",c.now()).run();
  await createPlan(c.worker,c.db,PLAN_A,"Author filter",OWNER,{repositoryIds:[repoId],repositoryRefs:{[repoId]:"main"}});
  c.setNow(Date.parse("2026-10-09T13:00:00Z"));await transition(c.worker,c.db,"StartPlan",PLAN_A,0);
  const items=[
    {sha:shaA,commit:{message:"allowed",committer:{date:"2026-10-09T13:10:00Z"}},author:{id:44,type:"User"}},
    {sha:shaB,commit:{message:"filtered out",committer:{date:"2026-10-09T13:12:00Z"}},author:{id:55,type:"User"}},
  ];
  const adapter={repository:async()=>({id:repoId,full_name:"Seraf-seraf/author-filter",private:false,default_branch:"main"}),commitPage:async()=>({data:items,links:{}})};
  c.setNow(Date.parse("2026-10-09T13:30:00Z"));
  const first=await syncRepository(c.db,OWNER,"Seraf-seraf/author-filter",null,"main",adapter,c.now(),{authorGithubIds:["44"]});
  assert.equal(first.completeness,"complete");
  assert.equal((await c.db.prepare("SELECT status FROM plan_commit_links WHERE owner_id=? AND plan_id=? AND sha=?").bind(OWNER,PLAN_A,shaA).first()).status,"candidate");
  assert.equal(await c.db.prepare("SELECT status FROM plan_commit_links WHERE owner_id=? AND plan_id=? AND sha=?").bind(OWNER,PLAN_A,shaB).first(),null);
  assert.equal((await c.db.prepare("SELECT author_filter_json FROM repository_sync_state WHERE owner_id=? AND repository_id=? AND ref='main'").bind(OWNER,repoId).first()).author_filter_json,'["44"]');
  await syncRepository(c.db,OWNER,"Seraf-seraf/author-filter",null,"main",adapter,c.now()+1000);
  assert.equal(await c.db.prepare("SELECT status FROM plan_commit_links WHERE owner_id=? AND plan_id=? AND sha=?").bind(OWNER,PLAN_A,shaB).first(),null);
  await syncRepository(c.db,OWNER,"Seraf-seraf/author-filter",null,"main",adapter,c.now()+2000,{authorGithubIds:[]});
  assert.equal((await c.db.prepare("SELECT status FROM plan_commit_links WHERE owner_id=? AND plan_id=? AND sha=?").bind(OWNER,PLAN_A,shaB).first()).status,"candidate");
});

test("sync saves each completed page checkpoint and resumes after a later-page rate limit", async () => {
  const c = context();
  const repoId = "checkpoint-1";
  await c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").bind(OWNER, c.now()).run();
  const sha1 = "1".repeat(40), sha2 = "2".repeat(40);
  const pages = [];
  let failSecondPage = true;
  const adapter = {
    repository: async () => ({ id: repoId, full_name: "Seraf-seraf/checkpoint", private: true, default_branch: "main" }),
    commitPage: async (_name, page) => {
      pages.push(page);
      if (page === 1) return { data: [{ sha: sha1, commit: { message: "one" } }], links: { next: "page2" } };
      if (failSecondPage) throw new AppError("RATE_LIMITED", "limited", 429, { retryAfter: 3 });
      return { data: [{ sha: sha2, commit: { message: "two" } }], links: {} };
    },
  };
  const first = await syncRepository(c.db, OWNER, "Seraf-seraf/checkpoint", null, "main", adapter, c.now());
  assert.equal(first.completeness, "partial");
  assert.equal(first.nextPage, 2);
  assert.equal(first.error, "RATE_LIMITED");
  let state = await c.db.prepare("SELECT cursor,completeness FROM repository_sync_state WHERE owner_id=? AND repository_id=? AND ref='main'").bind(OWNER, repoId).first();
  assert.deepEqual({ cursor: state.cursor, completeness: state.completeness }, { cursor: "2", completeness: "partial" });
  failSecondPage = false;
  const resumed = await syncRepository(c.db, OWNER, "Seraf-seraf/checkpoint", null, "main", adapter, c.now());
  assert.deepEqual(pages, [1, 2, 2]);
  assert.equal(resumed.completeness, "complete");
  assert.equal(resumed.resumedFromPage, 2);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM commits WHERE owner_id=? AND repository_id=?").bind(OWNER, repoId).first()).n, 2);
});

test("full ref rescan removes stale ref memberships only after the complete scan", async () => {
  const c = context();
  const repoId = "reconcile-1";
  await c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").bind(OWNER, c.now()).run();
  const sha1 = "3".repeat(40), sha2 = "4".repeat(40);
  let rescanPage1Calls = 0;
  let failPage2Once = true;
  const adapter = {
    repository: async () => ({ id: repoId, full_name: "Seraf-seraf/reconcile", private: false, default_branch: "main" }),
    commitPage: async (_name, page) => {
      if (page === 1) {
        rescanPage1Calls += 1;
        if (rescanPage1Calls === 1) return { data: [{ sha: sha1, commit: { message: "first" } }, { sha: sha2, commit: { message: "second" } }], links: {} };
        return { data: [{ sha: sha1, commit: { message: "first" } }], links: { next: "page2" } };
      }
      if (failPage2Once) { failPage2Once = false; throw new AppError("RATE_LIMITED", "pause rescan", 429, { retryAfter: 1 }); }
      return { data: [], links: {} };
    },
  };
  await syncRepository(c.db, OWNER, "Seraf-seraf/reconcile", null, "main", adapter, c.now());
  assert.equal((await c.db.prepare("SELECT refs_json FROM commits WHERE owner_id=? AND repository_id=? AND sha=?").bind(OWNER, repoId, sha2).first()).refs_json, '["main"]');
  const partial = await syncRepository(c.db, OWNER, "Seraf-seraf/reconcile", null, "main", adapter, c.now() + 1000, { fullRescan: true });
  assert.equal(partial.completeness, "partial");
  assert.equal(partial.nextPage, 2);
  assert.equal((await c.db.prepare("SELECT refs_json FROM commits WHERE owner_id=? AND repository_id=? AND sha=?").bind(OWNER, repoId, sha2).first()).refs_json, '["main"]');
  const rescan = await syncRepository(c.db, OWNER, "Seraf-seraf/reconcile", null, "main", adapter, c.now() + 2000, { fullRescan: true });
  assert.equal(rescan.completeness, "complete");
  assert.equal(rescan.resumedFromPage, 2);
  assert.equal((await c.db.prepare("SELECT refs_json FROM commits WHERE owner_id=? AND repository_id=? AND sha=?").bind(OWNER, repoId, sha2).first()).refs_json, "[]");
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM repository_ref_commits WHERE owner_id=? AND repository_id=? AND ref='main'").bind(OWNER, repoId).first()).n, 1);
});

test("same SHA imported from separate refs stays one commit with both explicit ref memberships", async () => {
  const c=context(),repoId="multi-ref",sha="d".repeat(40);
  await c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").bind(OWNER,c.now()).run();
  const adapter={repository:async()=>({id:repoId,full_name:"Seraf-seraf/multi-ref",private:false,default_branch:"main"}),
    commitPage:async()=>({data:[{sha,commit:{message:"same commit"}}],links:{}})};
  await syncRepository(c.db,OWNER,"Seraf-seraf/multi-ref",null,"main",adapter,c.now());
  await syncRepository(c.db,OWNER,"Seraf-seraf/multi-ref",null,"develop",adapter,c.now()+1);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM commits WHERE owner_id=? AND repository_id=? AND sha=?").bind(OWNER,repoId,sha).first()).n,1);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM repository_ref_commits WHERE owner_id=? AND repository_id=? AND sha=?").bind(OWNER,repoId,sha).first()).n,2);
  const refs=JSON.parse((await c.db.prepare("SELECT refs_json FROM commits WHERE owner_id=? AND repository_id=? AND sha=?").bind(OWNER,repoId,sha).first()).refs_json).sort();
  assert.deepEqual(refs,["develop","main"]);
});

test("marker conflicts are recorded and an explicit exclusion suppresses later marker links", async () => {
  const c = context();
  const repoId = "marker-rules-1";
  await c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").bind(OWNER, c.now()).run();
  await c.db.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,1,'main','available',1,?)")
    .bind(OWNER, repoId, "Seraf-seraf/marker-rules", c.now()).run();
  await createPlan(c.worker, c.db, PLAN_A, "Main plan", OWNER, { repositoryIds: [repoId], repositoryRefs: { [repoId]: "main" } });
  await createPlan(c.worker, c.db, PLAN_B, "Other ref", OWNER, { repositoryIds: [repoId], repositoryRefs: { [repoId]: "develop" } });
  const multiSha = "5".repeat(40), wrongRefSha = "6".repeat(40), excludedSha = "7".repeat(40), invalidSha = "8".repeat(40);
  const marker = (id) => "Plan-ID: " + id;
  const items = [
    { sha: multiSha, commit: { message: marker(PLAN_A) + "\n" + marker(PLAN_B) } },
    { sha: wrongRefSha, commit: { message: marker(PLAN_B) } },
    { sha: excludedSha, commit: { message: marker(PLAN_A) } },
    { sha: invalidSha, commit: { message: "Plan-ID: garbage" } },
  ];
  const adapter = {
    repository: async () => ({ id: repoId, full_name: "Seraf-seraf/marker-rules", private: true, default_branch: "main" }),
    commitPage: async () => ({ data: items, links: {} }),
  };
  await syncRepository(c.db, OWNER, "Seraf-seraf/marker-rules", null, "main", adapter, c.now());
  const conflicts = await c.db.prepare("SELECT sha,reason FROM commit_attribution_conflicts WHERE owner_id=? ORDER BY sha").bind(OWNER).all();
  assert.deepEqual(conflicts.results.map((x) => [x.sha, x.reason]), [
    [multiSha, "multiple_plan_markers"],
    [wrongRefSha, "unknown_or_unselected_plan_or_ref"],
    [invalidSha, "unknown_or_unselected_plan_or_ref"],
  ]);
  assert.deepEqual(JSON.parse((await c.db.prepare("SELECT marker_plan_ids_json FROM commit_attribution_conflicts WHERE owner_id=? AND repository_id=? AND sha=?").bind(OWNER, repoId, invalidSha).first()).marker_plan_ids_json), ["invalid:garbage"]);
  const wrongRepoSha="9".repeat(40);
  const otherAdapter={
    repository:async()=>({id:"marker-other",full_name:"Seraf-seraf/other",private:false,default_branch:"main"}),
    commitPage:async()=>({data:[{sha:wrongRepoSha,commit:{message:marker(PLAN_A)}}],links:{}}),
  };
  await syncRepository(c.db,OWNER,"Seraf-seraf/other",null,"main",otherAdapter,c.now());
  assert.equal((await c.db.prepare("SELECT reason FROM commit_attribution_conflicts WHERE owner_id=? AND repository_id='marker-other' AND sha=?").bind(OWNER,wrongRepoSha).first()).reason,"unknown_or_unselected_plan_or_ref");
  const exclusion = await call(c.worker, c.db, "/api/commands", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: 1, commandId: commandId(), commandType: "ReviewCommitLink", expectedVersion: 0,
      payload: { planId: PLAN_B, repositoryId: repoId, sha: excludedSha, status: "excluded", reason: "Owner explicitly excluded this commit" },
    }),
  });
  assert.equal(exclusion.response.status, 200);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM plan_commit_links WHERE owner_id=? AND repository_id=? AND sha=? AND status='confirmed'").bind(OWNER, repoId, excludedSha).first()).n, 0);
  await syncRepository(c.db, OWNER, "Seraf-seraf/marker-rules", null, "main", adapter, c.now() + 1000);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM plan_commit_links WHERE owner_id=? AND repository_id=? AND sha=? AND status='confirmed'").bind(OWNER, repoId, excludedSha).first()).n, 0);
  assert.equal((await c.db.prepare("SELECT status FROM plan_commit_links WHERE owner_id=? AND plan_id=? AND repository_id=? AND sha=?").bind(OWNER, PLAN_B, repoId, excludedSha).first()).status, "excluded");
});

test("GitHub adapter retries transient GET failures and honors Retry-After", async () => {
  let calls = 0;
  const sleeps = [];
  const adapter = new GitHubRestAdapter("test-token", async () => {
    calls += 1;
    if (calls === 1) return new Response("temporary", { status: 503 });
    return new Response("[]", { status: 200, headers: { link: "" } });
  }, { sleep: async (ms) => sleeps.push(ms), now: () => 1000 });
  assert.deepEqual((await adapter.commitPage("owner/repo", 1, "main")).data, []);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [100]);
  let rateCalls = 0;
  const rateAdapter = new GitHubRestAdapter("test-token", async () => {
    rateCalls += 1;
    return new Response("limited", { status: 429, headers: { "retry-after": "3" } });
  }, { sleep: async () => assert.fail("must not retry before Retry-After"), now: () => 1000, maxInlineWaitMs: 1000 });
  await assert.rejects(() => rateAdapter.commitPage("owner/repo", 1, "main"), (error) =>
    error.code === "RATE_LIMITED" && error.details.retryAfter === 3);
  assert.equal(rateCalls, 1);
});

test("GitHub default fetch is bound to the runtime global receiver", async () => {
  const originalFetch = globalThis.fetch;
  const receivers = [];
  globalThis.fetch = function runtimeFetch(_url, options) {
    receivers.push(this);
    assert.equal(this, globalThis);
    assert.equal(new Headers(options.headers).has("authorization"), false);
    return Promise.resolve(new Response(JSON.stringify({ id: 801, full_name: "fixture/receiver", private: false }), { status: 200 }));
  };
  try {
    const adapter = new GitHubRestAdapter(null, undefined, { maxAttempts: 1 });
    assert.equal((await adapter.repository("fixture", "receiver")).id, 801);
    assert.deepEqual(receivers, [globalThis]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub fetch failures expose only safe invocation or network classifications", async () => {
  const invocationSentinel = "raw invocation details must stay private";
  let invocationCalls = 0;
  const invocation = new GitHubRestAdapter(null, function injectedFetch() {
    invocationCalls += 1;
    throw new TypeError(invocationSentinel);
  }, { maxAttempts: 3, sleep: async () => assert.fail("invocation failures must not retry") });
  await assert.rejects(() => invocation.repository("fixture", "invocation"), (error) => {
    assert.equal(error.code, "SOURCE_UNAVAILABLE");
    assert.equal(error.details.failureKind, "invocation");
    assert.equal(error.details.retryable, false);
    assert(!JSON.stringify({ message: error.message, details: error.details }).includes(invocationSentinel));
    return true;
  });
  assert.equal(invocationCalls, 1);

  let networkCalls = 0;
  const network = new GitHubRestAdapter(null, async () => {
    networkCalls += 1;
    throw new TypeError("raw network details must stay private");
  }, { maxAttempts: 2, sleep: async () => undefined });
  await assert.rejects(() => network.repository("fixture", "network"), (error) => {
    assert.equal(error.code, "SOURCE_UNAVAILABLE");
    assert.equal(error.details.failureKind, "network");
    assert.equal(error.details.retryable, true);
    assert(!JSON.stringify({ message: error.message, details: error.details }).includes("raw network details"));
    return true;
  });
  assert.equal(networkCalls, 2);
});

test("sync API returns durable partial progress and Retry-After instead of hiding it as a failure", async () => {
  const c = context();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    if (String(url).includes("/repos/Seraf-seraf/progress") && !String(url).includes("/commits?")) {
      return new Response(JSON.stringify({ id: 99, full_name: "Seraf-seraf/progress", private: true, default_branch: "main" }), { status: 200 });
    }
    if (String(url).includes("/commits?") && new URL(String(url)).searchParams.get("page") === "1") {
      return new Response(JSON.stringify([{ sha: "9".repeat(40), commit: { message: "page one" } }]), {
        status: 200, headers: { link: '<https://api.github.com/next?page=2>; rel="next"' },
      });
    }
    return new Response("rate limited", { status: 429, headers: { "retry-after": "4" } });
  };
  const envelope = { schemaVersion: 1, commandId: commandId(), commandType: "SyncRepository", payload: { fullName: "Seraf-seraf/progress", authorGithubIds: ["55"] } };
  try {
    const response = await c.worker.fetch(request("/api/repositories/sync", {
      method: "POST", body: JSON.stringify(envelope),
    }), { DB: c.db, GITHUB_TOKEN: "test-token" });
    const partial = { response, body: await response.json() };
    assert.equal(partial.response.status, 200, JSON.stringify(partial.body));
    assert.equal(partial.body.outcome, "PARTIAL", JSON.stringify({ body: partial.body, calls }));
    assert.equal(partial.body.applied, true);
    assert.equal(partial.body.result.completeness, "partial");
    assert.equal(partial.body.result.nextPage, 2);
    assert.equal(partial.body.result.error, "RATE_LIMITED");
    assert.equal(partial.body.result.retryAfter, 4);
    const replayResponse = await c.worker.fetch(request("/api/repositories/sync", {
      method: "POST", body: JSON.stringify(envelope),
    }), { DB: c.db, GITHUB_TOKEN: "test-token" });
    const replay = { response: replayResponse, body: await replayResponse.json() };
    assert.equal(replay.body.applied, false);
    assert.equal(calls, 3);
    const state=await c.db.prepare("SELECT cursor,author_filter_json FROM repository_sync_state WHERE owner_id=? AND repository_id='99' AND ref='main'").bind(OWNER).first();
    assert.equal(state.cursor,"2");
    assert.equal(state.author_filter_json,'["55"]');
    const listed = await call(c.worker, c.db, "/api/repositories");
    const repo = listed.body.repositories.find((item) => item.repositoryId === "99");
    assert.deepEqual(repo.syncStates.map(({ ref, completeness, lastErrorCode }) => ({ ref, completeness, lastErrorCode })), [
      { ref: "main", completeness: "partial", lastErrorCode: "RATE_LIMITED" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an expired pending sync receipt can recover from its saved command and is replayed after completion", async () => {
  const c=context();
  const envelope={schemaVersion:1,commandId:commandId(),commandType:"SyncRepository",payload:{fullName:"Seraf-seraf/recovery"}};
  const hash=await payloadHash(envelope);
  await c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").bind(OWNER,c.now()).run();
  await c.db.prepare("INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,server_now_ms,actor_id,actor_type,payload_json,outcome_code,execution_lease_until,recorded_at) VALUES(?,?,?,'SyncRepository',?,?,'user',?,'PENDING',?,?)")
    .bind(OWNER,envelope.commandId,hash,c.now(),OWNER,JSON.stringify({fullName:"Seraf-seraf/recovery",cursor:null,ref:null,fullRescan:false}),c.now()-1,c.now()-600_000).run();
  let repositoryCalls=0,pageCalls=0;
  const adapter={
    repository:async()=>{repositoryCalls+=1;return {id:901,full_name:"Seraf-seraf/recovery",private:false,default_branch:"main"}},
    commitPage:async()=>{pageCalls+=1;return {data:[],links:{}}},
  };
  const recovered=await executeSyncCommand(c.db,{ownerId:OWNER},envelope,"ui","test-token",c.now(),adapter);
  assert.equal(recovered.outcome,"OK");
  assert.equal(recovered.applied,true);
  assert.equal(repositoryCalls,1);
  assert.equal(pageCalls,1);
  assert.equal((await c.db.prepare("SELECT execution_lease_until FROM command_receipts WHERE owner_id=? AND command_id=?").bind(OWNER,envelope.commandId).first()).execution_lease_until,null);
  const replay=await executeSyncCommand(c.db,{ownerId:OWNER},envelope,"ui","test-token",c.now()+1,adapter);
  assert.equal(replay.applied,false);
  assert.equal(repositoryCalls,1);
  assert.equal(pageCalls,1);
});

test("a live sync lease rejects a duplicate same-ID request with retry guidance before remote work", async () => {
  const c=context();
  const envelope={schemaVersion:1,commandId:commandId(),commandType:"SyncRepository",payload:{fullName:"Seraf-seraf/recovery"}};
  const hash=await payloadHash(envelope);
  await c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").bind(OWNER,c.now()).run();
  await c.db.prepare("INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,server_now_ms,actor_id,actor_type,payload_json,outcome_code,execution_lease_until,recorded_at) VALUES(?,?,?,'SyncRepository',?,?,'user',?,'PENDING',?,?)")
    .bind(OWNER,envelope.commandId,hash,c.now(),OWNER,JSON.stringify({fullName:"Seraf-seraf/recovery",cursor:null,ref:null,fullRescan:false}),c.now()+30_000,c.now()).run();
  let remoteCalls=0;
  const adapter={repository:async()=>{remoteCalls+=1;throw new Error("must not run")},commitPage:async()=>{remoteCalls+=1;throw new Error("must not run")}};
  await assert.rejects(()=>executeSyncCommand(c.db,{ownerId:OWNER},envelope,"ui","test-token",c.now(),adapter),error=>
    error.code==="INTERNAL_ERROR"&&error.status===409&&error.details.retryable===true&&error.details.retryAfter===30);
  assert.equal(remoteCalls,0);
});

test("inclusive date period uses calendar days across spring and autumn DST changes", () => {
  const spring = inclusiveDateRange("2026-03-08", "2026-03-08", "America/New_York");
  const autumn = inclusiveDateRange("2026-11-01", "2026-11-01", "America/New_York");
  assert.equal(spring.endMs - spring.startMs, 23 * 60 * 60 * 1000);
  assert.equal(autumn.endMs - autumn.startMs, 25 * 60 * 60 * 1000);
  assert.throws(() => inclusiveDateRange("2026-03-09", "2026-03-08", "UTC"), /диапазон/);
});

test("Friday-to-Monday interval clipping and completed median use the required separate samples", async () => {
  const c = context();
  const friday = Date.parse("2026-10-09T13:00:00Z");
  const pause = Date.parse("2026-10-09T15:00:00Z");
  const resume = Date.parse("2026-10-12T07:00:00Z");
  const finish = Date.parse("2026-10-12T09:30:00Z");
  await createPlan(c.worker, c.db, PLAN_A);
  c.setNow(friday); await transition(c.worker, c.db, "StartPlan", PLAN_A, 0);
  c.setNow(pause); await transition(c.worker, c.db, "PausePlan", PLAN_A, 1);
  c.setNow(resume); await transition(c.worker, c.db, "ResumePlan", PLAN_A, 2);
  c.setNow(finish); await transition(c.worker, c.db, "FinishPlan", PLAN_A, 3);
  const analytics = await buildAnalytics(c.db, OWNER, { from: "2026-10-12", to: "2026-10-12", timeZone: "Europe/Moscow", repositoryIds: [] }, finish);
  assert.equal(analytics.totalActiveMs, 2.5 * 60 * 60 * 1000);
  assert.equal(analytics.completedPlans, 1);
  assert.equal(analytics.completedMeasuredN, 1);
  assert.equal(analytics.completedSmallSample, true);
  assert.equal(analytics.asOf, finish);
  assert.equal(analytics.completedMedianActiveMs, 4.5 * 60 * 60 * 1000);
});

test("analytics filters a multi-repository plan once and empty median is null", async () => {
  const c = context();
  await createPlan(c.worker, c.db, PLAN_A);
  const r = await buildAnalytics(c.db, OWNER, { from: "2026-10-01", to: "2026-10-31", timeZone: "UTC", repositoryIds: [] }, c.now());
  assert.equal(r.totalActiveMs, 0);
  assert.equal(r.completedMedianActiveMs, null);
  assert.equal(r.completedPlans, 0);
  assert.equal(r.completedMeasuredN, 0);
  assert.equal(r.completedSmallSample, false);
  assert.equal(r.asOf, c.now());
  assert.equal(calculateActiveMs([], 100), 0);
  assert.equal(calculateCalendarMs({ first_started_at: null }, 100), null);
  assert.equal(median([]), null);
  assert.equal(median([1, 3, 5]), 3);
  assert.equal(median([1, 3, 5, 7]), 4);
});

test("completed plans without measured intervals count as finished but stay outside the median sample", async () => {
  const c = context(Date.parse("2026-10-12T09:00:00Z"));
  await createPlan(c.worker, c.db, PLAN_A);
  const start = Date.parse("2026-10-12T08:00:00Z");
  await c.db.prepare("UPDATE plans SET status='COMPLETED',first_started_at=?,finished_at=? WHERE owner_id=? AND plan_id=?")
    .bind(start, c.now(), OWNER, PLAN_A).run();
  const a = await buildAnalytics(c.db, OWNER, { from: "2026-10-12", to: "2026-10-12", timeZone: "UTC" }, c.now());
  assert.equal(a.completedPlans, 1);
  assert.equal(a.completedMeasuredN, 0);
  assert.equal(a.completedMedianActiveMs, null);
  assert.equal(a.plans[0].measured, false);
  assert.equal(a.plans[0].activeInPeriodMs, 0);
});

test("selecting two repositories for one plan does not duplicate its interval time", async () => {
  const c = context(Date.parse("2026-10-09T12:00:00Z"));
  await c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").bind(OWNER, c.now()).run();
  for (const [id, name] of [["repo-a", "Seraf-seraf/a"], ["repo-b", "Seraf-seraf/b"]]) {
    await c.db.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,0,'main','available',1,?)")
      .bind(OWNER, id, name, c.now()).run();
  }
  await createPlan(c.worker, c.db, PLAN_A, "Two repo plan", OWNER, { repositoryIds: ["repo-a", "repo-b"] });
  c.setNow(Date.parse("2026-10-09T13:00:00Z")); await transition(c.worker, c.db, "StartPlan", PLAN_A, 0);
  c.setNow(Date.parse("2026-10-09T15:00:00Z")); await transition(c.worker, c.db, "PausePlan", PLAN_A, 1);
  const analytics = await buildAnalytics(c.db, OWNER, { from: "2026-10-09", to: "2026-10-09", timeZone: "UTC", repositoryIds: ["repo-a", "repo-b"] }, c.now());
  assert.equal(analytics.totalActiveMs, 2 * 60 * 60 * 1000);
  assert.equal(analytics.plans.length, 1);
});

test("MCP tools call the same command service and data discovery contains no private records", async () => {
  const c = context();
  const list = await c.worker.fetch(request("/mcp", {
    method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }, null), { DB: c.db });
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.ok(listBody.result.tools.some((x) => x.name === "StartPlan"));
  const startTool = listBody.result.tools.find((x) => x.name === "StartPlan");
  assert.deepEqual(startTool.inputSchema.required, ["schemaVersion", "commandId", "payload", "expectedVersion"]);
  const noAuth = await c.worker.fetch(request("/mcp", {
    method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "GetActivePlan", arguments: {} } }),
  }, null), { DB: c.db });
  assert.equal(noAuth.status, 401);
  await createPlan(c.worker, c.db, PLAN_A);
  const result = await call(c.worker, c.db, "/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: "s1", method: "tools/call", params: {
      name: "StartPlan", arguments: { schemaVersion: 1, commandId: commandId(), expectedVersion: 0, payload: { planId: PLAN_A } },
    } }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.result.structuredContent.result.status, "RUNNING");
  assert.equal((await c.db.prepare("SELECT actor_type FROM plan_events WHERE plan_id=? AND event_type='STARTED'").bind(PLAN_A).first()).actor_type, "agent");
});

test("MCP tool schemas describe the supported required payloads for all writes", async () => {
  const c=context();
  const response=await c.worker.fetch(request("/mcp",{method:"POST",body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})}),{DB:c.db});
  const body=await response.json();
  const tools=Object.fromEntries(body.result.tools.map(tool=>[tool.name,tool.inputSchema]));
  const create=tools.CreatePlan;
  assert.deepEqual(create.required,["schemaVersion","commandId","payload"]);
  assert.ok(create.properties.payload.required.includes("title"));
  assert.ok(create.properties.payload.required.includes("planCreatedAt"));
  assert.equal(create.properties.payload.properties.planCreatedAt.oneOf.length,2);
  assert.ok(create.properties.sourceReference);
  const review=tools.ReviewCommitLink.properties.payload;
  assert.deepEqual(review.required,["planId","repositoryId","sha","status","reason"]);
  const sync=tools.SyncRepository.properties.payload;
  assert.deepEqual(sync.required,["fullName"]);
  assert.equal(sync.properties.authorGithubIds.maxItems,100);
  assert.equal(tools.UpdatePlanMetadata.properties.payload.anyOf.length,4);
});

test("private UI response has no-store and does not interpolate untrusted database text as HTML", async () => {
  const c = context();
  const response = await c.worker.fetch(request("/"), { DB: c.db });
  const html = await response.text();
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(html, /textContent/);
  assert.doesNotMatch(html, /innerHTML/);
  assert.match(html, /Фильтр периода/);
  assert.match(html, /completedMeasuredN/);
  assert.match(html, /data-refrepo/);
  assert.match(html, /authorIds/);
  assert.match(html, /authorGithubIds/);
  assert.match(html, /автор:/);
  assert.match(html, /коммитер:/);
  assert.match(html, /неизвестный GitHub-аккаунт/);
  assert.match(html, /className=\"plan-open\"/);
  assert.doesNotMatch(html, /row\.setAttribute\(\"role\",\"button\"\)/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 2);
  scripts.forEach((script) => assert.doesNotThrow(() => new Script(script[1])));
});

test("owner export includes audit data and never includes another owner's plans", async () => {
  const c = context();
  await createPlan(c.worker, c.db, PLAN_A, "<script>not markup</script>");
  await createPlan(c.worker, c.db, PLAN_B, "Other owner's plan", OTHER);
  const exported = await call(c.worker, c.db, "/api/export");
  assert.equal(exported.response.headers.get("content-disposition"), "attachment; filename=plan-time-tracker-export.json");
  assert.equal(exported.body.plans.length, 1);
  assert.equal(exported.body.plans[0].title, "<script>not markup</script>");
  assert.ok(Array.isArray(exported.body.plans[0].events));
  assert.ok(Array.isArray(exported.body.plans[0].intervals));
  assert.equal(Object.hasOwn(exported.body.plans[0], "commits"), false);
  assert.equal(Object.hasOwn(exported.body.plans[0], "repositories"), false);
});

test("private GitHub metadata appears in export only after explicit opt-in", async () => {
  const c = context();
  const repoId = "export-private";
  const sha = "8".repeat(40);
  await c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").bind(OWNER, c.now()).run();
  await c.db.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,1,'main','available',1,?)")
    .bind(OWNER, repoId, "Seraf-seraf/private", c.now()).run();
  await createPlan(c.worker, c.db, PLAN_A, "Private metadata plan", OWNER, { repositoryIds: [repoId], repositoryRefs: { [repoId]: "main" } });
  await c.db.prepare("INSERT INTO commits(owner_id,repository_id,sha,observed_at,message,url) VALUES(?,?,?,?,?,?)")
    .bind(OWNER, repoId, sha, c.now(), "private commit text", "https://github.com/Seraf-seraf/private/commit/" + sha).run();
  await c.db.prepare("INSERT INTO plan_commit_links(owner_id,plan_id,repository_id,sha,status,basis,reason,reviewed_by,reviewed_at) VALUES(?,?,?,?,'confirmed','manual','reviewed',?,?)")
    .bind(OWNER, PLAN_A, repoId, sha, OWNER, c.now()).run();
  const safe = await call(c.worker, c.db, "/api/export");
  assert.equal(Object.hasOwn(safe.body.plans[0], "commits"), false);
  assert.equal(JSON.stringify(safe.body).includes("private commit text"), false);
  const opted = await call(c.worker, c.db, "/api/export?includeGitHub=true");
  assert.equal(opted.body.plans[0].commits[0].message, "private commit text");
  assert.equal(opted.body.plans[0].repositories[0].is_private, 1);
});

test("revoked private repositories are not read again, hidden from plan detail, and cache deletion preserves timer data", async () => {
  const c = context();
  const repoId = "revoked-private", sha = "f".repeat(40);
  await c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").bind(OWNER, c.now()).run();
  await c.db.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,1,'main','available',1,?)")
    .bind(OWNER, repoId, "Seraf-seraf/private-revoked", c.now()).run();
  await c.db.prepare("INSERT INTO repository_sync_state(owner_id,repository_id,ref,last_successful_sync_at,completeness,last_error_code) VALUES(?,?,?,?,'complete',NULL)")
    .bind(OWNER, repoId, "sensitive/release", c.now()).run();
  await createPlan(c.worker, c.db, PLAN_A, "Keep timer", OWNER, { repositoryIds: [repoId], repositoryRefs: { [repoId]: "main" } });
  await transition(c.worker, c.db, "StartPlan", PLAN_A, 0);
  await c.db.prepare("INSERT INTO commits(owner_id,repository_id,sha,observed_at,message,url) VALUES(?,?,?,?,?,?)")
    .bind(OWNER, repoId, sha, c.now(), "private cached text", "https://github.com/Seraf-seraf/private-revoked/commit/" + sha).run();
  await c.db.prepare("INSERT INTO plan_commit_links(owner_id,plan_id,repository_id,sha,status,basis,reason,reviewed_by,reviewed_at) VALUES(?,?,?,?,'confirmed','manual','reviewed',?,?)")
    .bind(OWNER, PLAN_A, repoId, sha, OWNER, c.now()).run();
  let remoteReads=0;
  const revokedAdapter={repository:async()=>{remoteReads+=1;throw new AppError("SOURCE_UNAVAILABLE","revoked",503,{status:401});},commitPage:async()=>{remoteReads+=1;throw new Error("must not reach page");}};
  await assert.rejects(()=>syncRepository(c.db,OWNER,"Seraf-seraf/private-revoked",null,"main",revokedAdapter,c.now()),e=>e.code==="SOURCE_UNAVAILABLE");
  assert.equal((await c.db.prepare("SELECT access_state FROM repositories WHERE owner_id=? AND repository_id=?").bind(OWNER,repoId).first()).access_state,"revoked");
  const details=await call(c.worker,c.db,"/api/plans/"+PLAN_A);
  assert.equal(details.body.plan.repositories.length,0);
  assert.equal(details.body.plan.commits.length,0);
  await assert.rejects(()=>syncRepository(c.db,OWNER,"Seraf-seraf/private-revoked",null,"main",revokedAdapter,c.now()+1),e=>e.code==="SOURCE_UNAVAILABLE");
  assert.equal(remoteReads,1);
  const clear=await call(c.worker,c.db,"/api/repositories/"+encodeURIComponent(repoId)+"/cache",{method:"DELETE"});
  assert.equal(clear.response.status,200);
  assert.equal(clear.body.plansAndIntervalsPreserved,true);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM commits WHERE owner_id=? AND repository_id=?").bind(OWNER,repoId).first()).n,0);
  assert.equal((await call(c.worker,c.db,"/api/plans/"+PLAN_A)).body.plan.status,"RUNNING");
  const recheck=await call(c.worker,c.db,"/api/repositories/"+encodeURIComponent(repoId)+"/recheck-access",{method:"POST"});
  assert.equal(recheck.body.accessState,"unavailable");
  const listed=await call(c.worker,c.db,"/api/repositories");
  const hidden=listed.body.repositories.find((repository)=>repository.repositoryId===repoId);
  assert.equal(hidden.syncStatusUnavailable,true);
  assert.deepEqual(hidden.syncStates,[]);
});

test("repository settings expose anonymous public sync without claiming private access", async () => {
  const c = context();
  await c.db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").bind(OWNER,c.now()).run();
  await c.db.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,?,?,0,'trunk','available',1,?)")
    .bind(OWNER, "704", "fixture/never-synced", c.now()).run();
  const publicResponse = await c.worker.fetch(request("/api/repositories"), { DB: c.db });
  const publicSettings = await publicResponse.json();
  assert.equal(publicSettings.githubAvailable, true);
  assert.equal(publicSettings.githubMode, "public");
  assert.match(publicSettings.message, /Открытые доступны без входа/);
  assert.match(publicSettings.message, /Закрытым нужен GitHub-доступ/);
  const neverSynced = publicSettings.repositories.find((repository) => repository.repositoryId === "704");
  assert.equal(neverSynced.defaultBranch, "trunk");
  assert.equal(neverSynced.lastSuccessfulSyncAt, null);
  assert.deepEqual(neverSynced.syncStates, []);
  const tokenResponse = await c.worker.fetch(request("/api/repositories"), { DB: c.db, GITHUB_TOKEN: "test-only-token" });
  const tokenSettings = await tokenResponse.json();
  assert.equal(tokenSettings.githubAvailable, true);
  assert.equal(tokenSettings.githubMode, "authenticated");
  assert.match(tokenSettings.message, /Закрытые репозитории требуют прав у токена/);
});

test("anonymous public sync paginates, applies author filters, and records marker conflicts", async () => {
  const c = context();
  const originalFetch = globalThis.fetch;
  const requests = [];
  const sha1 = "a".repeat(40), sha2 = "b".repeat(40);
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), headers: new Headers(options.headers) });
    if (String(url).endsWith("/repos/fixture/public-demo")) return new Response(JSON.stringify({
      id: 701, full_name: "fixture/public-demo", private: false, default_branch: "main",
    }), { status: 200 });
    const page = new URL(String(url)).searchParams.get("page");
    if (page === "1") return new Response(JSON.stringify([{
      sha: sha1, author: { id: 55, login: "author" }, committer: { id: 55 },
      commit: { message: `Plan-ID: ${PLAN_A}\nPlan-ID: ${PLAN_B}`, committer: { date: "2026-10-09T13:30:00Z" } },
    }]), { status: 200, headers: { link: '<https://api.github.com/next?page=2>; rel="next"' } });
    return new Response(JSON.stringify([{
      sha: sha2, author: { id: 66, login: "other" }, committer: { id: 66 },
      commit: { message: "not selected by author filter", committer: { date: "2026-10-09T14:00:00Z" } },
    }]), { status: 200 });
  };
  const envelope = { schemaVersion: 1, commandId: commandId(), commandType: "SyncRepository", payload: {
    fullName: "fixture/public-demo", ref: "release/2026", authorGithubIds: ["55"],
  } };
  try {
    const response = await c.worker.fetch(request("/api/repositories/sync", { method: "POST", body: JSON.stringify(envelope) }), { DB: c.db });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.result.completeness, "complete");
    assert.equal(result.result.ref, "release/2026");
    assert.equal(result.result.imported, 2);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map((item) => new URL(item.url).searchParams.get("page")), [null, "1", "2"]);
    assert.deepEqual(requests.slice(1).map((item) => new URL(item.url).searchParams.get("sha")), ["release/2026", "release/2026"]);
    assert(requests.every((item) => !item.headers.has("authorization")));
    const state = await c.db.prepare("SELECT author_filter_json FROM repository_sync_state WHERE owner_id=? AND repository_id='701' AND ref='release/2026'").bind(OWNER).first();
    assert.equal(state.author_filter_json, '["55"]');
    const settings = await call(c.worker, c.db, "/api/repositories");
    const listed = settings.body.repositories.find((repository) => repository.repositoryId === "701");
    assert.equal(listed.defaultBranch, "main");
    assert.equal(listed.lastSuccessfulSyncAt, null, "a non-default ref must not make the default branch look synced");
    assert.deepEqual(listed.syncStates.map(({ ref, lastSuccessfulSyncAt, completeness }) => ({ ref, lastSuccessfulSyncAt, completeness })), [
      { ref: "release/2026", lastSuccessfulSyncAt: c.now(), completeness: "complete" },
    ]);
    const conflicts = await c.db.prepare("SELECT reason,marker_plan_ids_json FROM commit_attribution_conflicts WHERE owner_id=? AND repository_id='701' AND sha=?").bind(OWNER, sha1).first();
    assert.equal(conflicts.reason, "multiple_plan_markers");
    assert.deepEqual(JSON.parse(conflicts.marker_plan_ids_json), [PLAN_A, PLAN_B]);
    const replayResponse = await c.worker.fetch(request("/api/repositories/sync", { method: "POST", body: JSON.stringify(envelope) }), { DB: c.db });
    const replay = await replayResponse.json();
    assert.equal(replay.replayed, true);
    assert.equal(requests.length, 3, "idempotent replay must not fetch GitHub again");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticated private sync remains available with the configured runtime token", async () => {
  const c = context();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), headers: new Headers(options.headers) });
    if (String(url).endsWith("/repos/fixture/private-demo")) return new Response(JSON.stringify({
      id: 702, full_name: "fixture/private-demo", private: true, default_branch: "main",
    }), { status: 200 });
    return new Response("[]", { status: 200 });
  };
  const envelope = { schemaVersion: 1, commandId: commandId(), commandType: "SyncRepository", payload: { fullName: "fixture/private-demo" } };
  try {
    const response = await c.worker.fetch(request("/api/repositories/sync", { method: "POST", body: JSON.stringify(envelope) }), { DB: c.db, GITHUB_TOKEN: "test-only-token" });
    const result = await response.json();
    assert.equal(result.result.completeness, "complete");
    assert(requests.length >= 2);
    assert(requests.every((item) => item.headers.get("authorization") === "Bearer test-only-token"));
    const repo = await c.db.prepare("SELECT is_private FROM repositories WHERE owner_id=? AND repository_id='702'").bind(OWNER).first();
    assert.equal(repo.is_private, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("anonymous private and unavailable repositories are denied before importing data", async () => {
  const { GitHubRestAdapter } = await import("../worker/index.js");
  const privateAdapter = new GitHubRestAdapter(null, async () => new Response(JSON.stringify({
    id: 703, full_name: "fixture/private-demo", private: true, default_branch: "main",
  }), { status: 200 }));
  const c = context();
  await assert.rejects(() => syncRepository(c.db, OWNER, "fixture/private-demo", null, null, privateAdapter, c.now()),
    (error) => error.code === "GITHUB_REPOSITORY_UNAVAILABLE" && /только открытые/.test(error.message));
  assert.equal(await c.db.prepare("SELECT COUNT(*) AS n FROM repositories WHERE owner_id=?").bind(OWNER).first().then((row) => row.n), 0);
  const unavailableAdapter = new GitHubRestAdapter(null, async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
  await assert.rejects(() => unavailableAdapter.repository("fixture", "missing"),
    (error) => error.code === "GITHUB_REPOSITORY_UNAVAILABLE" && /закрыт/.test(error.message));
});

test("GitHub adapter distinguishes invalid credentials, denied access, and rate limits", async () => {
  const invalidTokenCalls = [];
  const invalidToken = new GitHubRestAdapter("test-only-invalid-token", async (_url, options) => {
    invalidTokenCalls.push(new Headers(options.headers));
    return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
  });
  await assert.rejects(() => invalidToken.repository("fixture", "private-demo"), (error) => error.code === "GITHUB_AUTH_INVALID");
  assert.equal(invalidTokenCalls.length, 1, "an invalid token must not silently fall back to anonymous access");
  assert.equal(invalidTokenCalls[0].get("authorization"), "Bearer test-only-invalid-token");

  const denied = new GitHubRestAdapter(null, async () => new Response(JSON.stringify({ message: "Resource not accessible" }), { status: 403 }));
  await assert.rejects(() => denied.repository("fixture", "public-demo"), (error) => error.code === "GITHUB_ACCESS_DENIED");

  const rateLimited = new GitHubRestAdapter(null, async () => new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
    status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "8" },
  }), { maxInlineWaitMs: 1000 });
  await assert.rejects(() => rateLimited.commitPage("fixture/public-demo", 1, "main"), (error) =>
    error.code === "RATE_LIMITED" && /без входа лимит ниже/.test(error.message) && error.details.retryAfter === 8);
});

test("sync API preserves GitHub auth, denied, unavailable, and rate-limit messages", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const scenario of [
      { name: "unavailable", status: 404, expectedStatus: 404, expectedCode: "GITHUB_REPOSITORY_UNAVAILABLE", message: /закрыт/ },
      { name: "denied", status: 403, expectedStatus: 403, expectedCode: "GITHUB_ACCESS_DENIED", message: /отказал в доступе/ },
      { name: "invalid-token", status: 401, token: "test-only-invalid-token", expectedStatus: 401, expectedCode: "GITHUB_AUTH_INVALID", message: /отклонил настроенный токен/ },
    ]) {
      const c = context();
      let requests = 0;
      globalThis.fetch = async (_url, options) => {
        requests += 1;
        assert.equal(new Headers(options.headers).has("authorization"), Boolean(scenario.token));
        return new Response(JSON.stringify({ message: scenario.name === "invalid-token" ? "Bad credentials" : "Resource unavailable" }), { status: scenario.status });
      };
      const envelope = { schemaVersion: 1, commandId: commandId(), commandType: "SyncRepository", payload: { fullName: "fixture/" + scenario.name } };
      const response = await c.worker.fetch(request("/api/repositories/sync", { method: "POST", body: JSON.stringify(envelope) }), {
        DB: c.db,
        ...(scenario.token ? { GITHUB_TOKEN: scenario.token } : {}),
      });
      const body = await response.json();
      assert.equal(response.status, scenario.expectedStatus);
      assert.equal(body.error.code, scenario.expectedCode);
      assert.match(body.error.message, scenario.message);
      assert.equal(requests, 1, "failed authentication must not retry anonymously");
      assert.equal(await c.db.prepare("SELECT COUNT(*) AS n FROM repositories WHERE owner_id=?").bind(OWNER).first().then((row) => row.n), 0);
    }

    const c = context();
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "8" },
    });
    const envelope = { schemaVersion: 1, commandId: commandId(), commandType: "SyncRepository", payload: { fullName: "fixture/rate-limited" } };
    const response = await c.worker.fetch(request("/api/repositories/sync", { method: "POST", body: JSON.stringify(envelope) }), { DB: c.db });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.result.error, "RATE_LIMITED");
    assert.match(body.result.errorMessage, /без входа лимит ниже/);
    assert.equal(body.result.retryAfter, 8);
    assert.equal(await c.db.prepare("SELECT COUNT(*) AS n FROM repositories WHERE owner_id=?").bind(OWNER).first().then((row) => row.n), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("instant dates require an explicit zone and date-only precision never fabricates midnight", () => {
  assert.throws(() => parsePlanCreatedAt({ precision: "instant", value: "2026-10-01T09:00", timeZone: "UTC" }), /UTC offset/);
  const date = parsePlanCreatedAt({ precision: "dateOnly", on: "2026-10-01", timeZone: "Europe/Moscow" });
  assert.equal(date.atMs, null);
  assert.equal(date.on, "2026-10-01");
});

test("settings persist Moscow and Omsk while legacy IANA settings remain supported", async () => {
  const c = context();
  for (const timeZone of ["Europe/Moscow", "Asia/Omsk"]) {
    assert.equal(resolveUiTimeZone(timeZone), timeZone);
    const saved = await call(c.worker, c.db, "/api/settings", {
      method: "POST", body: JSON.stringify({ timezone: timeZone }),
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.timezone, timeZone);
    assert.equal((await call(c.worker, c.db, "/api/settings")).body.timezone, timeZone);
  }
  for (const legacyZone of ["UTC", "America/New_York"]) {
    const legacy = await call(c.worker, c.db, "/api/settings", {
      method: "POST", body: JSON.stringify({ timezone: legacyZone }),
    });
    assert.equal(legacy.body.timezone, legacyZone);
    assert.equal((await call(c.worker, c.db, "/api/settings")).body.timezone, legacyZone);
    assert.equal(resolveUiTimeZone(legacyZone), "Asia/Omsk");
  }
  assert.equal(resolveUiTimeZone(null), "Asia/Omsk");
});

test("Moscow and Omsk display local hours and analytics use local-day boundaries", () => {
  const instant = Date.parse("2026-01-15T12:00:00Z");
  for (const [timeZone, expectedHour, expectedStart, expectedEnd] of [
    ["Europe/Moscow", "15", "2026-01-14T21:00:00.000Z", "2026-01-15T21:00:00.000Z"],
    ["Asia/Omsk", "18", "2026-01-14T18:00:00.000Z", "2026-01-15T18:00:00.000Z"],
  ]) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(instant);
    assert.equal(parts.find((part) => part.type === "hour").value, expectedHour);
    const range = inclusiveDateRange("2026-01-15", "2026-01-15", timeZone);
    assert.equal(new Date(range.startMs).toISOString(), expectedStart);
    assert.equal(new Date(range.endMs).toISOString(), expectedEnd);
  }
});

test("request payload owner and hostile external origin are not trusted", async () => {
  const c = context();
  const bad = await c.worker.fetch(new Request("https://tracker.test/api/plans", {
    headers: { "oai-authenticated-user-id": OWNER, origin: "https://evil.example" },
  }), { DB: c.db });
  assert.equal(bad.status, 403);
});


test("sourceReference changes reject command ID reuse and legacy receipts retain safe replay", async () => {
  for (const legacy of [false, true]) {
    const c = context();
    const envelope = { schemaVersion: 1, commandId: commandId(), commandType: "CreatePlan", sourceReference: "source-A",
      payload: { planId: PLAN_A, title: "Source reference", planCreatedAt: { precision: "dateOnly", on: "2026-10-08", timeZone: "UTC" } } };
    const first = await call(c.worker, c.db, "/api/commands", { method: "POST", body: JSON.stringify(envelope) });
    assert.equal(first.response.status, 200);
    let savedHash = first.body.payloadHash;
    if (legacy) {
      const legacyEnvelope = { ...envelope }; delete legacyEnvelope.sourceReference;
      savedHash = await payloadHash(legacyEnvelope);
      await c.db.prepare("UPDATE command_receipts SET payload_hash=? WHERE owner_id=? AND command_id=?")
        .bind(savedHash, OWNER, envelope.commandId).run();
    }
    const replay = await call(c.worker, c.db, "/api/commands", { method: "POST", body: JSON.stringify({ ...envelope, payloadHash: savedHash }) });
    assert.equal(replay.response.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.payloadHash, savedHash);
    for (const sourceReference of ["source-B", undefined]) {
      const changed = await call(c.worker, c.db, "/api/commands", { method: "POST", body: JSON.stringify({ ...envelope, sourceReference }) });
      assert.equal(changed.response.status, 409); assert.equal(changed.body.error.code, "IDEMPOTENCY_KEY_REUSED");
    }
    assert.equal(c.db.sqlite.prepare("SELECT count(*) AS n FROM plan_events").get().n, 1);
    assert.equal(c.db.sqlite.prepare("SELECT source_reference FROM plans").get().source_reference, "source-A");
    c.db.sqlite.close();
  }
});

test("rejected commit review leaves all links, conflicts, history and versions unchanged", async () => {
  for (const status of ["excluded", "confirmed"]) {
    const c = context(); await call(c.worker, c.db, "/api/whoami");
    await c.db.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,selected,updated_at) VALUES(?,'42','fixture/review',0,'main','available',1,?)").bind(OWNER,c.now()).run();
    await createPlan(c.worker,c.db,PLAN_A,"Stale review",OWNER,{repositoryIds:["42"]});
    const sha = "a".repeat(40);
    await c.db.prepare("INSERT INTO commits(owner_id,repository_id,sha,observed_at,message,url) VALUES(?,'42',?,?,'probe','https://github.com/fixture/review')").bind(OWNER,sha,c.now()).run();
    await c.db.prepare("INSERT INTO plan_commit_links(owner_id,plan_id,repository_id,sha,status,basis,reviewed_by,reviewed_at) VALUES(?,?,'42',?,'candidate','time',?,?)").bind(OWNER,PLAN_A,sha,OWNER,c.now()).run();
    await c.db.prepare("INSERT INTO commit_attribution_conflicts(owner_id,repository_id,sha,marker_plan_ids_json,reason,detected_at) VALUES(?,'42',?,'[]','probe',?)").bind(OWNER,sha,c.now()).run();
    await executeCommand(c.db,{ownerId:OWNER},{schemaVersion:1,commandId:commandId(),commandType:"UpdatePlanMetadata",expectedVersion:0,payload:{planId:PLAN_A,title:"Changed"}},"ui",c.now());
    const snapshot = () => ["plans", "plan_events", "plan_commit_links", "commit_attribution_conflicts"].map(table => c.db.sqlite.prepare("SELECT * FROM "+table).all());
    const before = snapshot();
    for (const [planId, expectedVersion, code] of [[PLAN_A,0,"VERSION_CONFLICT"],[PLAN_B,0,"PLAN_NOT_FOUND"]]) {
      await assert.rejects(() => executeCommand(c.db,{ownerId:OWNER},{schemaVersion:1,commandId:commandId(),commandType:"ReviewCommitLink",expectedVersion,payload:{planId,repositoryId:"42",sha,status,reason:"Rejected review"}},"ui",c.now()), error => error.code===code);
      assert.deepEqual(snapshot(), before);
    }
    c.db.sqlite.close();
  }
});

test("first MCP sync initializes its owner and performs no remote work for anonymous calls", async () => {
  const c = context(); const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async url => { calls += 1; return new Response(JSON.stringify(url.includes("/commits?") ? [] : {id:42,full_name:"fixture/mcp",private:false,default_branch:"main"})); };
  try {
    const rpc = {jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"SyncRepository",arguments:{schemaVersion:1,commandId:commandId(),payload:{fullName:"fixture/mcp"}}}};
    const anonymous = await c.worker.fetch(request("/mcp",{method:"POST",body:JSON.stringify(rpc)},null),{DB:c.db});
    assert.equal(anonymous.status,401);assert.equal(calls,0);assert.equal(c.db.sqlite.prepare("SELECT count(*) AS n FROM owners").get().n,0);
    const response = await c.worker.fetch(request("/mcp",{method:"POST",body:JSON.stringify(rpc)}),{DB:c.db});
    const data = await response.json(); assert.notEqual(data.result.isError,true);assert.equal(data.result.structuredContent.outcome,"OK");assert.equal(calls,2);
    assert.equal(c.db.sqlite.prepare("SELECT owner_id FROM owners").get().owner_id,OWNER);
    const replay = await c.worker.fetch(request("/mcp",{method:"POST",body:JSON.stringify(rpc)}),{DB:c.db});
    assert.equal((await replay.json()).result.structuredContent.replayed,true);assert.equal(calls,2);
  } finally { globalThis.fetch=originalFetch;c.db.sqlite.close(); }
});

test("sync recovery fences old repository, page, error and receipt writes", async () => {
  for (const phase of ["repository", "page", "error", "write", "finalize"]) {
    const c = context();await call(c.worker,c.db,"/api/whoami");
    const envelope={schemaVersion:1,commandId:commandId(),commandType:"SyncRepository",payload:{fullName:"fixture/fence",fullRescan:true}};
    let release, entered;const gate=new Promise(resolve=>{release=resolve;});const blocked=new Promise(resolve=>{entered=resolve;});
    const batch=c.db.batch.bind(c.db);
    c.db.batch=async statements=>{
      const oldLease=statements[0].sql.includes("sync_execution_guards") && statements[0].args[2]===c.now()+300000;
      if(oldLease && (phase==="write" && statements.some(statement=>statement.sql.startsWith("INSERT INTO commits")) || phase==="finalize" && statements.some(statement=>statement.sql.startsWith("UPDATE command_receipts SET outcome_code")))) {
        entered();await gate;
      }
      return batch(statements);
    };
    const info={id:42,full_name:"fixture/fence",private:false,default_branch:"main"};
    const item=letter=>({sha:letter.repeat(40),commit:{message:"probe",committer:{date:"2026-10-09T13:00:00Z"}},parents:[]});
    const oldAdapter={repository:async()=>{if(phase==="repository"){entered();await gate;}return info;},commitPage:async()=>{if(phase==="page"||phase==="error"){entered();await gate;}if(phase==="error")throw new AppError("SOURCE_UNAVAILABLE","Old request failed",502);return {data:[item("a")],links:{}};}};
    const newAdapter={repository:async()=>info,commitPage:async()=>({data:[item("b")],links:{}})};
    const oldRun=executeSyncCommand(c.db,{ownerId:OWNER},envelope,"ui",null,c.now(),oldAdapter);
    // Attach immediately so a fenced rejection cannot become unhandled.
    const oldResult=oldRun.then(value=>({value}),error=>({error}));
    await blocked;
    const recovered=await executeSyncCommand(c.db,{ownerId:OWNER},envelope,"ui",null,c.now()+300001,newAdapter);
    assert.equal(recovered.outcome,"OK");
    const snapshot=()=>["repositories","commits","repository_ref_commits","repository_sync_state","command_receipts"].map(table=>c.db.sqlite.prepare("SELECT * FROM "+table).all());
    const before=snapshot();release();const old=await oldResult;assert.equal(old.error,undefined);assert.equal(old.value.replayed,true);assert.deepEqual(snapshot(),before);
    assert.equal(c.db.sqlite.prepare("SELECT count(*) AS n FROM sync_execution_guards").get().n,0);
    const replay=await executeSyncCommand(c.db,{ownerId:OWNER},envelope,"ui",null,c.now()+300002,newAdapter);
    assert.equal(replay.replayed,true);assert.deepEqual(replay.result,recovered.result);
    c.db.sqlite.close();
  }
});

test("GitHub requests abort on timeout with a safe retryable error", async () => {
  let signal;
  const adapter=new GitHubRestAdapter(null,(_url,options)=>{
    assert(options.signal instanceof AbortSignal);signal=options.signal;
    return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));
  },{maxAttempts:1,requestTimeoutMs:5});
  await assert.rejects(()=>adapter.repository("fixture","timeout"),error=>error.code==="SOURCE_UNAVAILABLE"&&error.details.retryable===true&&error.details.failureKind==="timeout");
  assert.equal(signal.aborted,true);
});

test("command guard migration preserves existing plans, events and receipt replay", async () => {
  const db=new SqliteD1(readFileSync(new URL("0001_initial.sql",migrationsDirectory),"utf8"));
  const worker=createWorker(()=>1000);
  const envelope={schemaVersion:1,commandId:commandId(),commandType:"CreatePlan",payload:{planId:PLAN_A,title:"Existing plan",planCreatedAt:{precision:"dateOnly",on:"2026-10-08",timeZone:"Europe/Moscow"}}};
  const created=await call(worker,db,"/api/commands",{method:"POST",body:JSON.stringify(envelope)});assert.equal(created.response.status,200);
  const before=["plans","plan_events","command_receipts"].map(table=>db.sqlite.prepare("SELECT * FROM "+table).all());
  for (const name of readdirSync(migrationsDirectory).filter(name=>name.endsWith(".sql")&&name!=="0001_initial.sql").sort()) {
    db.sqlite.exec(readFileSync(new URL(name,migrationsDirectory),"utf8"));
  }
  assert.deepEqual(["plans","plan_events","command_receipts"].map(table=>db.sqlite.prepare("SELECT * FROM "+table).all()),before);
  const replay=await executeCommand(db,{ownerId:OWNER},envelope,"ui",2000);
  assert.equal(replay.replayed,true);assert.deepEqual(replay.result,created.body.result);
  db.sqlite.close();
});

test("failed sync page batch rolls back its commit writes and cleans up its execution guard", async () => {
  const c=context();await call(c.worker,c.db,"/api/whoami");
  c.db.sqlite.exec("CREATE TRIGGER fail_sync_page BEFORE INSERT ON commits BEGIN SELECT RAISE(ABORT,'PAGE_WRITE_FAILED'); END;");
  const envelope={schemaVersion:1,commandId:commandId(),commandType:"SyncRepository",payload:{fullName:"fixture/rollback"}};
  const adapter={repository:async()=>({id:42,full_name:"fixture/rollback",private:false,default_branch:"main"}),commitPage:async()=>({data:[{sha:"a".repeat(40),commit:{message:"probe"},parents:[]}],links:{}})};
  await assert.rejects(()=>executeSyncCommand(c.db,{ownerId:OWNER},envelope,"ui",null,c.now(),adapter),error=>error instanceof AppError);
  for(const table of ["commits","repository_ref_commits","sync_execution_guards"])assert.equal(c.db.sqlite.prepare("SELECT count(*) AS n FROM "+table).get().n,0);
  c.db.sqlite.close();
});

test("an old sync cannot finalize the receipt while its replacement still runs", async () => {
  const c=context();await call(c.worker,c.db,"/api/whoami");
  const envelope={schemaVersion:1,commandId:commandId(),commandType:"SyncRepository",payload:{fullName:"fixture/pending"}};
  const info={id:42,full_name:"fixture/pending",private:false,default_branch:"main"};
  let releaseOld,enterOld,releaseNew,enterNew;
  const oldGate=new Promise(resolve=>{releaseOld=resolve;});const oldEntered=new Promise(resolve=>{enterOld=resolve;});
  const newGate=new Promise(resolve=>{releaseNew=resolve;});const newEntered=new Promise(resolve=>{enterNew=resolve;});
  const oldAdapter={repository:async()=>{enterOld();await oldGate;return info;},commitPage:async()=>assert.fail("old lease must stop before requesting a page")};
  const newAdapter={repository:async()=>info,commitPage:async()=>{enterNew();await newGate;return {data:[],links:{}};}};
  const oldRun=executeSyncCommand(c.db,{ownerId:OWNER},envelope,"ui",null,c.now(),oldAdapter);
  const oldResult=oldRun.then(value=>({value}),error=>({error}));
  await oldEntered;
  const newRun=executeSyncCommand(c.db,{ownerId:OWNER},envelope,"ui",null,c.now()+300001,newAdapter);
  await newEntered;
  const before=c.db.sqlite.prepare("SELECT * FROM command_receipts").get();
  releaseOld();const old=await oldResult;
  assert.equal(old.error.code,"INTERNAL_ERROR");assert.equal(old.error.status,409);assert.equal(old.error.details.retryable,true);
  assert.deepEqual(c.db.sqlite.prepare("SELECT * FROM command_receipts").get(),before);
  assert.equal(c.db.sqlite.prepare("SELECT count(*) AS n FROM sync_execution_guards").get().n,0);
  releaseNew();assert.equal((await newRun).outcome,"OK");c.db.sqlite.close();
});
