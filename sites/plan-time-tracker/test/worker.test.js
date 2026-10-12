import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  syncRepository,
} from "../worker/index.js";

const schema = readFileSync(new URL("../drizzle/0001_initial.sql", import.meta.url), "utf8");

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
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(schema);
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
  assert.equal