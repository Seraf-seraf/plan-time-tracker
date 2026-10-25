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
  inclusiveDateRange,
  median,
  parsePlanCreatedAt,
  payloadHash,
  resolveUiTimeZone,
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
    title:"Referenced plan",planCreatedAt:{precision:"dateOnly",on:"2026-10-08",timeZone:"UTC"},
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

test("Start of two plans at once opens independent RUNNING intervals", async () => {
  const c = context();
  await createPlan(c.worker, c.db, PLAN_A, "Plan A");
  await createPlan(c.worker, c.db, PLAN_B, "Plan B");
  const outcomes = await Promise.all([
    transition(c.worker, c.db, "StartPlan", PLAN_A, 0),
    transition(c.worker, c.db, "StartPlan", PLAN_B, 0),
  ]);
  assert.deepEqual(outcomes.map((x) => x.response.status).sort(), [200, 200]);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM plans WHERE owner_id=? AND status='RUNNING'").bind(OWNER).first()).n, 2);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM work_intervals WHERE owner_id=? AND end_ms IS NULL").bind(OWNER).first()).n, 2);
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
    payload: { title: "A", planCreatedAt: { precision: "dateOnly", on: "2026-10-08", timeZone: "UTC" },  },
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
















test("inclusive date period uses calendar days across spring and autumn DST changes", () => {
  const spring = inclusiveDateRange("2026-03-08", "2026-03-08", "America/New_York");
  const autumn = inclusiveDateRange("2026-11-01", "2026-11-01", "America/New_York");
  assert.equal(spring.endMs - spring.startMs, 23 * 60 * 60 * 1000);
  assert.equal(autumn.endMs - autumn.startMs, 25 * 60 * 60 * 1000);
  assert.throws(() => inclusiveDateRange("2026-03-09", "2026-03-08", "UTC"), /диапазон/);
});

test("analytics API rejects impossible calendar endpoints before inclusive-day normalization", async () => {
  const c = context();
  const invalidRanges = [
    ["2026-02-01", "2026-02-30"], ["2026-02-01", "2026-02-29"],
    ["2026-04-01", "2026-04-31"], ["2026-01-01", "2026-13-01"],
    ["1900-02-01", "1900-02-29"], ["2026-02-30", "2026-03-03"],
    ["2026-10-15", "2026-10-14"], ["", "2026-10-14"], ["2026-10-14", ""],
    ["10000-01-01", "10000-01-01"], ["+010000-01-01", "+010000-01-01"],
    ["0000-01-01", "0000-01-01"], ["0099-02-29", "0099-03-01"],
    ["0099-02-01", "0099-02-29"],
  ];
  try {
    for (const [from, to] of invalidRanges) {
      const query = new URLSearchParams({ from, to, timeZone: "UTC" });
      const result = await call(c.worker, c.db, "/api/analytics?" + query);
      assert.equal(result.response.status, 400, `${from}..${to}`);
      assert.equal(result.body.error.code, "VALIDATION_ERROR", `${from}..${to}`);
      assert.equal(result.body.period, undefined, "invalid input must not produce a normalized period");
    }
  } finally { c.db.sqlite.close(); }
});

for (const [day, startMs, endMs] of [
  ["0001-01-01", -62135596800000, -62135510400000],
  ["0099-12-31", -59011545600000, -59011459200000],
  ["9999-12-31", 253402214400000, 253402300800000],
]) {
  test(`analytics API accepts the same positive dateOnly boundary as CreatePlan: ${day}`, async () => {
    const c = context();
    try {
      const created = await createPlan(c.worker, c.db, PLAN_A, "Calendar boundary fixture", OWNER, {
        planCreatedAt: { precision: "dateOnly", on: day, timeZone: "UTC" },
      });
      assert.equal(created.response.status, 200, "existing dateOnly contract must accept this date");
      const plan = await call(c.worker, c.db, "/api/plans/" + PLAN_A);
      assert.equal(plan.body.plan.planCreatedAt.on, day);
      const query = new URLSearchParams({ from: day, to: day, timeZone: "UTC" });
      const analytics = await call(c.worker, c.db, "/api/analytics?" + query);
      assert.equal(analytics.response.status, 200, `analytics must accept ${day}`);
      assert.deepEqual(analytics.body.period, { from: day, to: day, timeZone: "UTC", startMs, endMs });
      assert.equal(endMs - startMs, 86400000);
    } finally { c.db.sqlite.close(); }
  });
}

test("analytics API preserves all positive years 0001 through 0099 without the 1900 remap", async () => {
  const c = context();
  try {
    for (let year = 1; year <= 99; year += 1) {
      const day = String(year).padStart(4, "0") + "-12-31";
      const nextDay = String(year + 1).padStart(4, "0") + "-01-01";
      const startMs = Date.parse(day + "T00:00:00Z"), endMs = Date.parse(nextDay + "T00:00:00Z");
      const analytics = await call(c.worker, c.db, "/api/analytics?" + new URLSearchParams({ from: day, to: day, timeZone: "UTC" }));
      assert.equal(analytics.response.status, 200, day);
      assert.deepEqual(analytics.body.period, { from: day, to: day, timeZone: "UTC", startMs, endMs });
      assert.equal(endMs - startMs, 86400000);
    }
  } finally { c.db.sqlite.close(); }
});

test("dateOnly API enforces the same positive four-digit calendar contract as analytics", async () => {
  const c = context();
  try {
    for (const on of ["0000-01-01", "10000-01-01", "+010000-01-01", "0099-02-29", "2026-02-30"]) {
      const created = await createPlan(c.worker, c.db, PLAN_A, "Invalid date fixture", OWNER, {
        planCreatedAt: { precision: "dateOnly", on, timeZone: "UTC" },
      });
      assert.equal(created.response.status, 400, on);
      assert.equal(created.body.error.code, "VALIDATION_ERROR", on);
    }
    const plans = await call(c.worker, c.db, "/api/plans");
    assert.deepEqual(plans.body.plans, [], "rejected dates must not create plans");
  } finally { c.db.sqlite.close(); }
});

test("analytics API preserves valid leap dates, inclusive year rollover and local DST boundaries", async () => {
  const c = context();
  const validRanges = [
    ["0004-02-29", "0004-02-29", "UTC", "0004-02-29T00:00:00Z", "0004-03-01T00:00:00Z"],
    ["2024-02-29", "2024-02-29", "UTC", "2024-02-29T00:00:00Z", "2024-03-01T00:00:00Z"],
    ["2000-02-29", "2000-02-29", "UTC", "2000-02-29T00:00:00Z", "2000-03-01T00:00:00Z"],
    ["2026-02-28", "2026-02-28", "UTC", "2026-02-28T00:00:00Z", "2026-03-01T00:00:00Z"],
    ["2026-10-14", "2026-10-14", "UTC", "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"],
    ["2026-12-31", "2027-01-01", "UTC", "2026-12-31T00:00:00Z", "2027-01-02T00:00:00Z"],
    ["2026-03-08", "2026-03-08", "America/New_York", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
    ["2026-11-01", "2026-11-01", "America/New_York", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"],
    ["2026-10-14", "2026-10-14", "Europe/Moscow", "2026-10-13T21:00:00Z", "2026-10-14T21:00:00Z"],
    ["2026-10-14", "2026-10-14", "Asia/Omsk", "2026-10-13T18:00:00Z", "2026-10-14T18:00:00Z"],
  ];
  try {
    for (const [from, to, timeZone, start, end] of validRanges) {
      const query = new URLSearchParams({ from, to, timeZone });
      const result = await call(c.worker, c.db, "/api/analytics?" + query);
      assert.equal(result.response.status, 200, `${from}..${to} ${timeZone}`);
      assert.deepEqual(result.body.period, { from, to, timeZone, startMs: Date.parse(start), endMs: Date.parse(end) });
    }
  } finally { c.db.sqlite.close(); }
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
  const analytics = await buildAnalytics(c.db, OWNER, { from: "2026-10-12", to: "2026-10-12", timeZone: "Europe/Moscow",  }, finish);
  assert.equal(analytics.totalActiveMs, 2.5 * 60 * 60 * 1000);
  assert.equal(analytics.completedPlans, 1);
  assert.equal(analytics.completedMeasuredN, 1);
  assert.equal(analytics.completedSmallSample, true);
  assert.equal(analytics.asOf, finish);
  assert.equal(analytics.completedMedianActiveMs, 4.5 * 60 * 60 * 1000);
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
    method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ListPlans", arguments: {} } }),
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
  assert.doesNotMatch(html, /data-refrepo|GitHub|commitPolicy|repositoryId/);
  assert.doesNotMatch(html, /authorIds/);
  assert.doesNotMatch(html, /authorGithubIds/);
  assert.doesNotMatch(html, /автор:/);
  assert.doesNotMatch(html, /коммитер:/);
  assert.doesNotMatch(html, /неизвестный GitHub-аккаунт/);
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
  assert.ok(Array.isArray(exported.body.plans[0].timeline));
  assert.ok(Array.isArray(exported.body.plans[0].intervals));
  assert.equal(Object.hasOwn(exported.body.plans[0], "commits"), false);
  assert.equal(Object.hasOwn(exported.body.plans[0], "repositories"), false);
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





test("command guard migration preserves existing plans, events and receipt replay", async () => {
  const db=new SqliteD1(readFileSync(new URL("0001_initial.sql",migrationsDirectory),"utf8"));
  const worker=createWorker(()=>1000);
  const envelope={schemaVersion:1,commandId:commandId(),commandType:"CreatePlan",payload:{planId:PLAN_A,title:"Existing plan",planCreatedAt:{precision:"dateOnly",on:"2026-10-08",timeZone:"Europe/Moscow"}}};
  const created=await call(worker,db,"/api/commands",{method:"POST",body:JSON.stringify(envelope)});assert.equal(created.response.status,200);
  const before=["plans","plan_events","command_receipts"].map(table=>db.sqlite.prepare("SELECT * FROM "+table).all());
  for (const name of readdirSync(migrationsDirectory).filter(name=>name.endsWith(".sql")&&name!=="0001_initial.sql").sort()) {
    db.sqlite.exec(readFileSync(new URL(name,migrationsDirectory),"utf8"));
  }
  const after=["plans","plan_events","command_receipts"].map(table=>db.sqlite.prepare("SELECT * FROM "+table).all());
  // 0016 adds a nullable tombstone; every pre-existing field remains unchanged.
  after[0]=after[0].map(row=>{assert.equal(row.deleted_at,null);delete row.deleted_at;return row;});
  assert.deepEqual(after,before);
  const replay=await executeCommand(db,{ownerId:OWNER},envelope,"ui",2000);
  assert.equal(replay.replayed,true);assert.deepEqual(replay.result,created.body.result);
  db.sqlite.close();
});
