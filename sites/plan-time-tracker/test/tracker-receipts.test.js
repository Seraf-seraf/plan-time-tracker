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
const OWNER = "tracker-owner";
const PLAN_ID = "11111111-1111-4111-8111-111111111111";
let number = 0;
const commandId = () => {
  number += 1;
  return "d0000000-0000-4000-8000-" + String(number).padStart(12, "0");
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
  return { db, worker, setNow: (value) => { now = value; } };
}

async function request(worker, db, path, payload, ownerId = OWNER) {
  const headers = new Headers({
    "content-type": "application/json",
    "oai-authenticated-user-id": ownerId,
    "oai-authenticated-user-email": ownerId + "@example.test",
  });
  const response = await worker.fetch(new Request("https://tracker.test" + path, {
    method: "POST", headers, body: JSON.stringify(payload),
  }), { DB: db });
  return { response, body: await response.json() };
}

async function createPlan(context) {
  return request(context.worker, context.db, "/api/commands", {
    schemaVersion: 1,
    commandId: commandId(),
    commandType: "CreatePlan",
    payload: {
      planId: PLAN_ID,
      title: "Tracker receipt plan",
      planCreatedAt: { precision: "dateOnly", on: "2026-10-01", timeZone: "UTC" },
    },
  });
}

function createStepEnvelope(id = commandId(), overrides = {}) {
  return {
    schemaVersion: 1,
    commandId: id,
    commandType: "CreateStep",
    payload: {
      planId: PLAN_ID,
      ordinal: 0,
      title: "Implement checkpoint",
      expectedResult: "The feature is implemented and checked.",
      requiredChecks: ["unit", "build"],
      ...overrides,
    },
  };
}

function snapshot(db) {
  return Object.fromEntries(["command_receipts", "tracker_plan_config", "plan_steps", "step_attempts", "step_results", "step_checks", "step_acceptances", "tracker_journal", "tracker_owner_state"]
    .map((table) => [table, db.sqlite.prepare("SELECT * FROM " + table + " ORDER BY 1,2").all()]));
}

test("CreateStep stores an atomic receipt and journal entry; replay survives a lost acknowledgement", async () => {
  const c = createContext();
  assert.equal((await createPlan(c)).response.status, 200);
  const envelope = createStepEnvelope();
  const first = await request(c.worker, c.db, "/api/commands", envelope);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.result.status, "PENDING");
  assert.equal(first.body.result.version, 1);
  assert.equal(first.body.resultingVersion, 1);
  const stepId = first.body.result.stepId;
  const beforeReplay = snapshot(c.db);

  const replay = await request(c.worker, c.db, "/api/commands", envelope);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.result, first.body.result);
  assert.deepEqual(snapshot(c.db), beforeReplay);

  const changedPayload = createStepEnvelope(envelope.commandId, { title: "Changed checkpoint" });
  const conflict = await request(c.worker, c.db, "/api/commands", changedPayload);
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  assert.deepEqual(snapshot(c.db), beforeReplay);

  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM plan_steps WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID).count, 1);
  assert.equal(c.db.sqlite.prepare("SELECT enabled FROM tracker_plan_config WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID).enabled, 1);
  assert.equal(c.db.sqlite.prepare("SELECT event_type,command_event_ordinal FROM tracker_journal WHERE owner_id=? AND step_id=?").get(OWNER, stepId).event_type, "STEP_CREATED");
  assert.equal(c.db.sqlite.prepare("SELECT next_sequence FROM tracker_owner_state WHERE owner_id=?").get(OWNER).next_sequence, 2);
  assert.equal(c.db.sqlite.prepare("SELECT version,status FROM plans WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID).version, 0);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM work_intervals WHERE owner_id=? AND plan_id=?").get(OWNER, PLAN_ID).count, 0);
});

test("simultaneous identical plan and tracker commands report one application and one replay", async () => {
  const c = createContext();
  try {
    const planEnvelope = { schemaVersion: 1, commandId: commandId(), commandType: "CreatePlan", payload: { planId: PLAN_ID, title: "Concurrent receipt", planCreatedAt: { precision: "dateOnly", on: "2026-10-15", timeZone: "UTC" } } };
    for (const envelope of [planEnvelope, createStepEnvelope()]) {
      const results = await Promise.all([request(c.worker, c.db, "/api/commands", envelope), request(c.worker, c.db, "/api/commands", envelope)]);
      assert(results.every(result => result.response.status === 200));
      assert.equal(results.filter(result => result.body.applied).length, 1);
      assert.equal(results.filter(result => result.body.replayed).length, 1);
      assert.deepEqual(results[0].body.result, results[1].body.result);
    }
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM plans").get().n, 1);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM plan_steps").get().n, 1);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM tracker_journal WHERE event_type='STEP_CREATED'").get().n, 1);
  } finally { c.db.sqlite.close(); }
});

test("failed event insert rolls back tracker receipt, checkpoint, opt-in, and owner sequence", async () => {
  const c = createContext();
  await createPlan(c);
  c.db.sqlite.exec(`CREATE TRIGGER fail_tracker_step_event BEFORE INSERT ON tracker_journal
    WHEN NEW.event_type='STEP_CREATED' BEGIN SELECT RAISE(ABORT,'TEST_EVENT_WRITE_FAILURE'); END`);
  const failed = await request(c.worker, c.db, "/api/commands", createStepEnvelope());
  assert.equal(failed.response.status, 500);
  assert.equal(failed.body.error.code, "INTERNAL_ERROR");
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE command_type='CreateStep'").get().count, 0);
  for (const table of ["tracker_plan_config", "plan_steps", "tracker_journal", "tracker_owner_state"]) {
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM " + table).get().count, 0);
  }
});

test("CreateStep is available through the owner-authenticated MCP command layer", async () => {
  const c = createContext();
  await createPlan(c);
  const list = await c.worker.fetch(new Request("https://tracker.test/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }), { DB: c.db });
  const tools = (await list.json()).result.tools;
  const tool = tools.find((entry) => entry.name === "CreateStep");
  assert.ok(tool);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.properties.payload.required, ["planId", "ordinal", "title", "expectedResult", "requiredChecks"]);

  const call = await request(c.worker, c.db, "/mcp", {
    jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "CreateStep",
      arguments: {
        schemaVersion: 1,
        commandId: commandId(),
        payload: {
          planId: PLAN_ID, ordinal: 0, title: "MCP checkpoint", expectedResult: "Observable result",
          requiredChecks: [],
        },
      },
    },
  });
  assert.equal(call.response.status, 200);
  const result = call.body.result.structuredContent;
  assert.equal(result.result.status, "PENDING");
  assert.equal(c.db.sqlite.prepare("SELECT actor_type FROM command_receipts WHERE command_id=?").get(result.commandId).actor_type, "agent");
});

test("CreateStep validates envelope hash before recording any receipt", async () => {
  const c = createContext();
  await createPlan(c);
  const envelope = { ...createStepEnvelope(), payloadHash: "0".repeat(64) };
  const response = await request(c.worker, c.db, "/api/commands", envelope);
  assert.equal(response.response.status, 400);
  assert.equal(response.body.error.code, "VALIDATION_ERROR");
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE command_type='CreateStep'").get().count, 0);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS count FROM plan_steps").get().count, 0);
});
