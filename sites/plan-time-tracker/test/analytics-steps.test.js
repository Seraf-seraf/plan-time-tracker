import test from 'node:test';
import assert from 'node:assert/strict';
import { context, ok, call, command, migrations, migration, rows, OWNER, PLAN } from './fixtures/tracker-db.mjs';

const period = { from: '2027-01-01', to: '2027-12-31', timeZone: 'UTC' };
const path = (planId = PLAN, filter = period) => '/api/analytics/plans/' + planId + '/steps?' + new URLSearchParams(filter);
async function create(c, planId = PLAN) {
  await ok(c, 'CreatePlan', { planId, title: 'Recorded stage time', planText: '# Test\n\n' + Array.from({ length: 4 }, (_, i) => '## Этап ' + (i + 1) + '. Stage ' + (i + 1) + '\nSynthetic fixture').join('\n\n'), planCreatedAt: { precision: 'dateOnly', on: '2027-01-01', timeZone: 'UTC' } });
  return c.db.sqlite.prepare('SELECT step_id FROM plan_steps WHERE plan_id=? ORDER BY ordinal').all(planId).map(s => s.step_id);
}
const set = (c, stepId, status, version) => ok(c, 'SetStepStatus', { stepId, status }, version);

test('recorded stage windows exclude plan pauses, preserve parallel time, repeat safely and distinguish missing from zero', async () => {
  const c = context();
  try {
    const [one, two, zero] = await create(c);
    await ok(c, 'StartPlan', { planId: PLAN }, 0);const start = c.now();
    await set(c, one, 'RUNNING', 1);c.advance(60000);
    await set(c, two, 'RUNNING', 1);c.advance(30000);
    await ok(c, 'PausePlan', { planId: PLAN }, 1);c.advance(100000);
    await ok(c, 'ResumePlan', { planId: PLAN }, 2);c.advance(20000);
    await set(c, one, 'DONE', 2);await set(c, two, 'DONE', 2);
    await set(c, one, 'RUNNING', 3);c.advance(10000);await set(c, one, 'DONE', 4);
    await set(c, zero, 'RUNNING', 1);await set(c, zero, 'DONE', 2);
    const before = rows(c), report = await call(c, path());
    assert.equal(report.status, 200);assert.deepEqual(report.value.steps.map(s => s.activeMs), [120000, 50000, 0, null]);
    assert.deepEqual(rows(c), before, 'chart reads must not write');
    assert.deepEqual((await call(c, path(PLAN, { ...period, asOf: start + 1 }))).value.steps.map(s => s.activeMs), [1, null, null, null]);
    assert.deepEqual((await call(c, path(PLAN, { ...period, from: '2027-12-31' }))).value.steps.map(s => s.activeMs), [0, 0, 0, null]);
    const exported = (await call(c, '/api/export')).value.plans[0];
    assert.equal(exported.steps[0].intervals.length, 2);assert.equal(exported.steps[3].intervals.length, 0);
  } finally { c.close(); }
});

test('step timing follows successful status writes atomically; pause, delete, restore and finish exceptions remain independent', async () => {
  const c = context();
  try {
    const [step] = await create(c);await ok(c, 'StartPlan', { planId: PLAN }, 0);
    const id = crypto.randomUUID(), payload = { stepId: step, status: 'RUNNING' };
    await command(c, 'SetStepStatus', payload, 1, id);c.advance(10);
    assert.equal((await command(c, 'SetStepStatus', payload, 1, id)).value.replayed, true);
    assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM step_work_intervals').get().n, 1);
    const before = rows(c);
    assert.equal((await command(c, 'SetStepStatus', { stepId: step, status: 'DONE' }, 1)).status, 409);
    assert.equal((await call(c, path())).value.steps[0].activeMs, 10);
    c.db.sqlite.exec("CREATE TRIGGER fail_timing_receipt BEFORE UPDATE OF outcome_code ON command_receipts WHEN NEW.command_type='SetStepStatus' BEGIN SELECT RAISE(ABORT,'injected'); END;");
    const committed = rows(c);
    assert.equal((await command(c, 'SetStepStatus', { stepId: step, status: 'DONE' }, 2)).status, 500);assert.deepEqual(rows(c), committed);
    c.db.sqlite.exec('DROP TRIGGER fail_timing_receipt;');
    await ok(c, 'DeletePlan', { planId: PLAN }, 1);
    assert.equal(c.db.sqlite.prepare('SELECT end_ms FROM step_work_intervals').get().end_ms, c.now());
    assert.equal((await call(c, path())).status, 404);
    await ok(c, 'RestorePlan', { planId: PLAN }, 2);c.advance(1000);await ok(c, 'ResumePlan', { planId: PLAN }, 3);
    assert.equal((await call(c, path())).value.steps[0].activeMs, 10, 'restoration never restarts a blocked step');
    await set(c, step, 'RUNNING', 3);c.advance(5);
    await ok(c, 'FinishPlan', { planId: PLAN, allowIncomplete: true, reason: 'Explicit stop' }, 4);
    assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM step_work_intervals WHERE end_ms IS NULL').get().n, 0);
    c.advance(5000);assert.equal((await call(c, path())).value.steps[0].activeMs, 15);
  } finally { c.close(); }
});

test('analytics clips local date boundaries and validates owner, plan and snapshot', async () => {
  const c = context();
  try {
    c.advance(Date.parse('2027-02-02T17:59:30Z') - c.now());
    const [step] = await create(c);await ok(c, 'StartPlan', { planId: PLAN }, 0);await set(c, step, 'RUNNING', 1);c.advance(90000);
    const local = { from: '2027-02-02', to: '2027-02-02', timeZone: 'Asia/Omsk' };
    assert.equal((await call(c, path(PLAN, local))).value.steps[0].activeMs, 30000);
    assert.equal((await call(c, path(PLAN, { ...local, from: '2027-02-03', to: '2027-02-03' }))).value.steps[0].activeMs, 60000);
    assert.equal((await call(c, path(), undefined, 'other-owner')).status, 404);
    assert.equal((await call(c, path(), undefined, null)).status, 401);
    assert.equal((await call(c, path(crypto.randomUUID()))).status, 404);
    for (const filter of [{ asOf: c.now() + 1 }, { asOf: '' }, { asOf: '-1' }, { timeZone: 'Bad/Zone' }, { from: '2027-13-01' }]) assert.equal((await call(c, path(PLAN, { ...period, ...filter }))).status, 400);
    assert.equal((await call(c, path('bad-id'))).status, 400);
  } finally { c.close(); }
});

test('upgrading a populated current-state database preserves data without inventing past timing', async () => {
  const boundary = migrations.indexOf('0022_step_time.sql'), c = context(boundary);
  try {
    const [step] = await create(c);
    // Seed the pre-0022 lifecycle through that schema's receipt triggers. The current
    // Worker intentionally requires all current migrations before serving StartPlan.
    c.db.sqlite.prepare("INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,recorded_at) VALUES(?,?,?,'StartPlan',?,0,?,?,'agent',?,'PENDING',?)")
      .run(OWNER,crypto.randomUUID(),'legacy-fixture',PLAN,c.now(),OWNER,JSON.stringify({planId:PLAN}),c.now());
    assert.equal(c.db.sqlite.prepare('SELECT status FROM plans WHERE plan_id=?').get(PLAN).status,'RUNNING');
    await set(c, step, 'RUNNING', 1);c.advance(60000);
    const before = rows(c);c.db.sqlite.exec(migration('0022_step_time.sql'));
    const after = rows(c);delete after.step_work_intervals;assert.deepEqual(after, before);
    assert.equal((await call(c, path())).value.steps[0].activeMs, null);
    await set(c, step, 'RUNNING', 2);c.advance(100);await set(c, step, 'DONE', 3);
    assert.equal((await call(c, path())).value.steps[0].activeMs, 100);
    assert.deepEqual(c.db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { c.close(); }
});

test('a concurrent pause cannot add time beyond the report snapshot or disagree with stage charts', async () => {
  const c = context();
  try {
    const [step] = await create(c);await ok(c, 'StartPlan', { planId: PLAN }, 0);await set(c, step, 'RUNNING', 1);c.advance(60000);
    const asOf = c.now(), prepare = c.db.prepare.bind(c.db);let paused = false;
    c.db.prepare = sql => {
      const statement = prepare(sql), bind = statement.bind.bind(statement);
      statement.bind = (...args) => {
        const bound = bind(...args);
        if (!paused && sql === 'SELECT start_ms,end_ms FROM work_intervals WHERE owner_id=? AND plan_id=? ORDER BY start_ms') {
          const all = bound.all.bind(bound);
          bound.all = async () => { paused = true;c.advance(10000);await ok(c, 'PausePlan', { planId: PLAN }, 1);return all(); };
        }
        return bound;
      };
      return statement;
    };
    const report = await call(c, '/api/analytics?' + new URLSearchParams(period));
    assert.equal(report.status, 200);assert(paused);assert.equal(report.value.asOf, asOf);
    assert.equal(report.value.totalActiveMs, 60000);assert.equal(report.value.sumPlanActiveMs, 60000);
    assert.equal(report.value.plans[0].activeInPeriodMs, 60000);assert.equal(report.value.plans[0].fullActiveMs, 60000);
    const chart = await call(c, path(PLAN, { ...period, asOf }));
    assert.equal(chart.value.steps[0].activeMs, report.value.plans[0].activeInPeriodMs);
  } finally { c.close(); }
});

test('a completion after the report cutoff is not counted as a completed plan', async () => {
  const c = context();
  try {
    const [step] = await create(c);await ok(c, 'StartPlan', { planId: PLAN }, 0);await set(c, step, 'RUNNING', 1);c.advance(60000);
    const asOf = c.now(), prepare = c.db.prepare.bind(c.db);let finished = false;
    c.db.prepare = sql => {
      const statement = prepare(sql), bind = statement.bind.bind(statement);
      statement.bind = (...args) => {
        const bound = bind(...args);
        if (!finished && sql === 'SELECT p.* FROM plans p WHERE p.owner_id=? AND p.deleted_at IS NULL ORDER BY p.registered_at DESC') {
          const all = bound.all.bind(bound);
          bound.all = async () => { finished = true;c.advance(10000);await set(c, step, 'DONE', 2);await ok(c, 'FinishPlan', { planId: PLAN, allowIncomplete: true, reason: 'Concurrent cutoff fixture' }, 1);return all(); };
        }
        return bound;
      };
      return statement;
    };
    const report = await call(c, '/api/analytics?' + new URLSearchParams(period));
    assert.equal(report.status, 200);assert(finished);assert.equal(report.value.asOf, asOf);
    assert.equal(report.value.completedPlans, 0);assert.equal(report.value.completedMeasuredN, 0);assert.equal(report.value.completedMedianActiveMs, null);
    assert.equal(report.value.totalActiveMs, 60000);
    assert.equal((await call(c, path(PLAN, { ...period, asOf }))).value.steps[0].activeMs, 60000);
  } finally { c.close(); }
});
