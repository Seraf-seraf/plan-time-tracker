import test from 'node:test';
import assert from 'node:assert/strict';
import { context, mcp, plannedAtlm, completeAtlm, OWNER } from './fixtures/tracker-db.mjs';
import { processEstimationTraining } from '../worker/index.js';

test('training history detects a snapshot captured after its first page', async () => {
  const c = context();
  let release, processing;
  try {
    await mcp(c, 'StartTraining');
    for (const planId of [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
    ]) {
      const plan = await plannedAtlm(c, planId);
      await completeAtlm(c, plan, 1000);
      c.advance(1);
    }
    const prepare = c.db.prepare.bind(c.db);
    let reached, released = false;
    const claimed = new Promise((resolve) => { reached = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    c.db.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql.startsWith('INSERT OR IGNORE INTO estimation_training_attempts')) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...args) => {
          const bound = bind(...args);
          const run = bound.run.bind(bound);
          bound.run = async () => {
            const result = await run();
            reached();
            await gate;
            return result;
          };
          return bound;
        };
      }
      return statement;
    };
    processing = processEstimationTraining(c.db, OWNER, c.now(), {
      clock: c.now, wallClock: () => released ? 9001 : 0,
    });
    await claimed;
    const first = (await mcp(c, 'GetTrainingHistory', { limit: 1 })).value.result.structuredContent;
    assert.ok(first.nextCursor);
    const pending = c.db.sqlite.prepare('SELECT * FROM estimation_training_attempts WHERE completed_at IS NULL');
    assert.deepEqual(JSON.parse(pending.get().manifest_json), []);
    released = true;
    release();
    await processing;
    assert.equal(JSON.parse(pending.get().manifest_json).length, 2);
    const continued = (await mcp(c, 'GetTrainingHistory', { limit: 1, cursor: first.nextCursor })).value.result;
    assert.equal(continued.isError, true);
    assert.equal(continued.structuredContent.code, 'HISTORY_CHANGED');
    const restarted = (await mcp(c, 'GetTrainingHistory')).value.result.structuredContent;
    assert.equal(restarted.rows.at(-1).manifest.length, 2);
  } finally {
    release?.();
    await processing?.catch(() => {});
    c.close();
  }
});

test('training history ignores attempts beyond its boundary but detects changed pending contents', async () => {
  const c = context();
  try {
    await mcp(c, 'StartTraining');
    const insert = c.db.sqlite.prepare(`INSERT INTO estimation_training_attempts
      (owner_id,attempt_id,started_at,method_version,feature_version,dataset_revision,manifest_json)
      VALUES(?, ?, ?, 'agent-v5-operations', 'agent-task-v4', 1, '[1]')`);
    insert.run(OWNER, 'pending', c.now());
    const first = (await mcp(c, 'GetTrainingHistory', { limit: 1 })).value.result.structuredContent;
    assert.ok(first.nextCursor);
    insert.run(OWNER, 'beyond-boundary', c.now());
    const next = () => mcp(c, 'GetTrainingHistory', { limit: 1, cursor: first.nextCursor });
    let response = (await next()).value.result;
    assert.equal(response.isError, undefined);
    assert.deepEqual(response.structuredContent.rows.map((row) => row.attemptId), ['pending']);
    c.db.sqlite.prepare(`UPDATE estimation_training_attempts
      SET dataset_revision=2,manifest_json='[2]',completed_at=? WHERE attempt_id='beyond-boundary'`)
      .run(c.now());
    response = (await next()).value.result;
    assert.equal(response.isError, undefined, 'new attempts and their completion are outside the opened snapshot');
    c.db.sqlite.prepare("UPDATE estimation_training_attempts SET manifest_json='[2]' WHERE attempt_id='pending'").run();
    response = (await next()).value.result;
    assert.equal(response.isError, true, 'a same-size manifest change inside the snapshot must be detected');
    assert.equal(response.structuredContent.code, 'HISTORY_CHANGED');
  } finally {
    c.close();
  }
});

test('legacy training history cursors require a fresh snapshot', async () => {
  const c = context();
  try {
    await mcp(c, 'StartTraining');
    await mcp(c, 'StartTraining');
    const first = (await mcp(c, 'GetTrainingHistory', { limit: 1 })).value.result.structuredContent;
    const current = JSON.parse(first.nextCursor);
    const legacy = JSON.stringify({
      version: 1, ownerScope: current.ownerScope, after: current.after,
      through: current.through, completed: current.completed,
    });
    const stale = (await mcp(c, 'GetTrainingHistory', { limit: 1, cursor: legacy })).value.result;
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent.code, 'HISTORY_CHANGED');
    const fresh = (await mcp(c, 'GetTrainingHistory', { limit: 1 })).value.result;
    assert.equal(fresh.isError, undefined);
    assert.equal(JSON.parse(fresh.structuredContent.nextCursor).version, 2);
  } finally {
    c.close();
  }
});
