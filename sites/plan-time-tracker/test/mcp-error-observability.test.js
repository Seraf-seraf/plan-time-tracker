import test from "node:test";
import assert from "node:assert/strict";
import { context, mcp } from "./fixtures/tracker-db.mjs";

const args = { schemaVersion: 1, view: "list" };

test("MCP failures retain the public contract and one safe diagnostic correlated by requestId", async () => {
  const c = context(), originalError = console.error, entries = [];
  try {
    console.error = value => entries.push(JSON.parse(value));
    const prepare = c.db.prepare.bind(c.db);
    let fault;
    c.db.prepare = sql => {
      if (sql.includes("FROM estimation_active_revisions a LEFT JOIN estimation_serving_models m")) throw fault;
      return prepare(sql);
    };
    const secret = "sk-sensitive-test-credential-do-not-log";
    for (const [error, reason] of [
      [new Error(`D1_ERROR: too many terms in compound SELECT: ${secret}`), "D1_COMPOUND_SELECT_LIMIT"],
      [new Error("adapter failure", { cause: new Error(`D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window ${secret}`) }), "D1_RESOURCE_LIMIT"],
      [new Error(`Unexpected sensitive input ${secret}`), "UNEXPECTED_ERROR"],
    ]) {
      fault = error;
      const before = entries.length, response = (await mcp(c, "ListModelRevisions", args)).value.result;
      assert.equal(response.isError, true);
      const value = response.structuredContent;
      assert.deepEqual({ ...value, requestId: null }, { code: "INTERNAL_ERROR", message: "Внутренняя ошибка.",
        details: null, requestId: null, retryable: true, retryAfter: null });
      assert.equal(entries.length, before + 1);
      assert.deepEqual(entries.at(-1), { event: "mcp_unexpected_error", tool: "ListModelRevisions", requestId: value.requestId, reason });
      assert.equal(JSON.stringify(response).includes(secret), false);
      assert.equal(JSON.stringify(entries).includes(secret), false);
    }
    c.db.prepare = prepare;
    const count = entries.length;
    const empty = (await mcp(c, "ListModelRevisions", args)).value.result;
    assert.equal(empty.isError, undefined);
    assert.deepEqual(empty.structuredContent.rows, []);
    const missing = (await mcp(c, "ListModelRevisions", { ...args, view: "detail", modelRevisionId: "missing" })).value.result;
    assert.equal(missing.structuredContent.code, "MODEL_REVISION_NOT_FOUND");
    assert.equal((await mcp(c, "GetTrackerInfo")).value.result.isError, undefined);
    assert.equal(entries.length, count);
  } finally { console.error = originalError; c.close(); }
});
