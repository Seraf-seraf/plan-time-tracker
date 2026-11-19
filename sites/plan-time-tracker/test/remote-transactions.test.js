import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredDatabase } from '../tracker-db/index.js';
import { claimAtlmJob, persistAtlmSample, readAtlmSampleSource } from '../worker/index.js';
import { assessForStart, call, command, context, migrations, ok, OWNER, PLAN, rows } from './fixtures/tracker-db.mjs';

const endpoint = 'https://tracker-db.test/_tracker-db/';
const serverPath = fileURLToPath(new URL('../tracker-db/server.py', import.meta.url));
const serverCode = `
import importlib.util
import sqlite3
import sys

spec = importlib.util.spec_from_file_location("tracker_transport", sys.argv[1])
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
connection = sqlite3.connect(transport.DATABASE)
connection.execute("PRAGMA journal_mode=WAL")
connection.close()
server = transport.ThreadingHTTPServer(("127.0.0.1", 0), transport.Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
`;

async function remoteContext(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tracker-remote-transaction-'));
  const databasePath = join(directory, 'tracker.sqlite');
  const c = context(migrations.length, { databasePath });
  const localDb = c.db;
  const token = randomBytes(32).toString('hex');
  const server = spawn('python3', ['-B', '-u', '-c', serverCode, serverPath], {
    env: { ...process.env, DB_FILE: databasePath, DB_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (server.pid && server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, 'exit');
      server.kill('SIGTERM');
      await stopped;
    }
    c.close();
    await rm(directory, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SQLite transport startup timed out: ' + stderr)), 10000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => {
      clearTimeout(timer);
      reject(new Error('SQLite transport exited before startup: ' + code + ' ' + stderr));
    });
    server.stdout.once('data', chunk => {
      clearTimeout(timer);
      const value = Number(chunk.toString().trim());
      if (!Number.isInteger(value) || value <= 0) reject(new Error('Invalid SQLite transport port'));
      else resolve(value);
    });
  });
  const originalFetch = globalThis.fetch.bind(globalThis);
  let discardResponse;
  // Production still validates an HTTPS endpoint. Only the test's fetch boundary
  // routes that exact endpoint to the real local HTTP transport, without TLS setup.
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    assert.equal(String(input), endpoint);
    const request = JSON.parse(init.body);
    const response = await originalFetch(`http://127.0.0.1:${port}/_tracker-db/`, init);
    if (discardResponse?.(request)) {
      discardResponse = undefined;
      await response.arrayBuffer();
      throw new TypeError('Injected response loss after the server committed');
    }
    return response;
  });
  c.db = configuredDatabase({ DB_DRIVER: 'remote-sqlite', DB_URL: endpoint, DB_TOKEN: token });
  return {
    c,
    localDb,
    discardNextResponse(predicate) { discardResponse = predicate; },
  };
}

test('real remote SQLite batches return rows and roll back all writes on a later failure', async t => {
  const { c, localDb } = await remoteContext(t);
  assert.throws(() => configuredDatabase({
    DB_DRIVER: 'remote-sqlite', DB_URL: 'http://tracker-db.test/_tracker-db/', DB_TOKEN: 'test',
  }), /Invalid remote SQLite configuration/);
  const successful = await c.db.batch([
    c.db.prepare('INSERT INTO owners(owner_id,created_at) VALUES(?,?) RETURNING owner_id').bind('remote-owner', 100),
    c.db.prepare('SELECT owner_id,created_at FROM owners WHERE owner_id=?').bind('remote-owner'),
  ]);
  assert.deepEqual(successful[0].results, [{ owner_id: 'remote-owner' }]);
  assert.equal(successful[0].meta.changes, 1);
  assert.deepEqual(successful[1].results, [{ owner_id: 'remote-owner', created_at: 100 }]);
  const before = rows({ db: localDb });
  await assert.rejects(c.db.batch([
    c.db.prepare('INSERT INTO owners(owner_id,created_at) VALUES(?,?)').bind('rolled-back', 200),
    c.db.prepare('INSERT INTO estimation_owner_state(owner_id,schema_version) VALUES(?,4)').bind('missing-owner'),
  ]), /SQLITE_ERROR/);
  assert.deepEqual(rows({ db: localDb }), before);
  assert.deepEqual(await c.db.prepare('SELECT owner_id FROM owners ORDER BY owner_id').all(), {
    success: true,
    results: [{ owner_id: 'remote-owner' }],
    meta: { changes: 0, last_row_id: 0 },
  });
});

test('remote command observers roll back together and exact retry recovers a lost response', async t => {
  const { c, localDb, discardNextResponse } = await remoteContext(t);
  await ok(c, 'CreatePlan', {
    planId: PLAN, title: 'Remote transaction',
    planText: '# Remote transaction\n\n## Этап 1. Verify\nVerify the result.',
    planCreatedAt: { precision: 'dateOnly', on: '2026-11-19', timeZone: 'UTC' },
  });
  await assessForStart(c, PLAN);
  const startId = crypto.randomUUID();
  const before = rows({ db: localDb });
  localDb.sqlite.exec(`CREATE TRIGGER fail_remote_observer BEFORE INSERT ON estimation_jobs
    BEGIN SELECT RAISE(ABORT,'injected observer fault'); END;`);
  const failed = await command(c, 'StartPlan', { planId: PLAN }, 0, startId);
  assert.equal(failed.status, 500);
  assert.deepEqual(rows({ db: localDb }), before);
  localDb.sqlite.exec('DROP TRIGGER fail_remote_observer');

  discardNextResponse(request => request.mode === 'batch' && request.statements.some(statement =>
    /INSERT OR IGNORE INTO command_receipts/i.test(statement.sql)));
  const unknown = await command(c, 'StartPlan', { planId: PLAN }, 0, startId);
  assert.equal(unknown.status, 500);
  const committed = rows({ db: localDb });
  assert.equal(localDb.sqlite.prepare('SELECT outcome_code FROM command_receipts WHERE command_id=?').get(startId).outcome_code, 'OK');
  const retry = await command(c, 'StartPlan', { planId: PLAN }, 0, startId);
  assert.equal(retry.status, 200, JSON.stringify(retry.value));
  assert.equal(retry.value.replayed, true);
  assert.deepEqual(rows({ db: localDb }), committed);
  assert.equal(localDb.sqlite.prepare('SELECT COUNT(*) count FROM work_intervals WHERE end_ms IS NULL').get().count, 1);
  assert.equal(localDb.sqlite.prepare('SELECT COUNT(*) count FROM plan_estimation_inputs').get().count, 1);

  assert.equal((await call(c, `/api/plans/${PLAN}`, undefined, 'other-owner')).status, 404);
  const denied = await command(c, 'PausePlan', { planId: PLAN }, 1, undefined, 'other-owner');
  assert.equal(denied.status, 404);
  assert.equal(localDb.sqlite.prepare('SELECT status FROM plans WHERE plan_id=?').get(PLAN).status, 'RUNNING');

  const step = localDb.sqlite.prepare('SELECT step_id FROM plan_steps WHERE plan_id=?').get(PLAN);
  await ok(c, 'SetStepStatus', { stepId: step.step_id, status: 'RUNNING' }, 1);
  c.advance(1250);
  await ok(c, 'SetStepStatus', { stepId: step.step_id, status: 'DONE' }, 2);
  await ok(c, 'FinishPlan', { planId: PLAN }, 1);
  assert.equal((await call(c, `/api/plans/${PLAN}`)).value.plan.activeMs, 1250);

  const lease = await claimAtlmJob(c.db, OWNER, 'refresh:' + PLAN, c.now());
  assert.ok(lease);
  const source = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
  assert.equal(source.eligibility, 'ELIGIBLE');
  const sample = await persistAtlmSample(c.db, OWNER, source, c.now(), lease);
  assert.equal(sample.inserted, true);
  const state = localDb.sqlite.prepare('SELECT dataset_revision,new_sample_count FROM estimation_owner_state WHERE owner_id=?').get(OWNER);
  assert.deepEqual({ ...state }, { dataset_revision: 1, new_sample_count: 1 });
  assert.deepEqual(localDb.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});
