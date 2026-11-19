import test from 'node:test';
import assert from 'node:assert/strict';
import { command, context, ok, plannedAtlm, rows, OWNER, PLAN } from './fixtures/tracker-db.mjs';

function generation(c) {
  return c.db.sqlite.prepare('SELECT generation FROM estimation_jobs WHERE owner_id=? AND job_key=?')
    .get(OWNER, 'refresh:' + PLAN)?.generation ?? 0;
}

test('command events capture first start once and refresh only changed source fields', async () => {
  const c = context();
  try {
    const planned = await plannedAtlm(c);
    const commandId = crypto.randomUUID();
    const started = await command(c, 'StartPlan', { planId: PLAN }, 0, commandId);
    assert.equal(started.status, 200, JSON.stringify(started.value));
    const snapshot = c.db.sqlite.prepare('SELECT * FROM plan_estimation_inputs WHERE owner_id=? AND plan_id=?').get(OWNER, PLAN);
    const receipt = c.db.sqlite.prepare('SELECT rowid,* FROM command_receipts WHERE owner_id=? AND command_id=?').get(OWNER, commandId);
    assert.equal(snapshot.captured_receipt_rowid, receipt.rowid);
    assert.equal(snapshot.first_started_at, c.now());
    assert.equal(snapshot.selection_status, 'CAPTURED');
    assert.equal(JSON.parse(snapshot.forecast_json).featureDigest,
      JSON.parse(receipt.payload_json).atlmStartForecast.estimation.featureDigest);
    assert.equal(generation(c), 1);

    const before = rows(c);
    const replay = await command(c, 'StartPlan', { planId: PLAN }, 0, commandId);
    assert.equal(replay.value.replayed, true);
    assert.deepEqual(rows(c), before);
    assert.equal((await command(c, 'PausePlan', { planId: PLAN }, 0)).value.error.code, 'VERSION_CONFLICT');
    assert.equal(generation(c), 1);
    assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM work_intervals WHERE end_ms IS NULL').get().n, 1);

    await ok(c, 'SetStepStatus', { stepId: planned.step.stepId, status: 'RUNNING' }, 1);
    assert.equal(generation(c), 2);
    c.advance(10);
    await ok(c, 'SetStepStatus', { stepId: planned.step.stepId, status: 'RUNNING' }, 2);
    assert.equal(generation(c), 2, 'a repeated RUNNING does not change the ATLM source');
    assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM step_work_intervals').get().n, 1);
    await ok(c, 'UpdatePlanMetadata', { planId: PLAN, title: 'ATLM synthetic feature' }, 1);
    assert.equal(generation(c), 2, 'same-value metadata leaves the source unchanged');
    await ok(c, 'UpdatePlanMetadata', { planId: PLAN, title: 'Changed requirement' }, 2);
    assert.equal(generation(c), 3);
    await ok(c, 'SetStepStatus', { stepId: planned.step.stepId, status: 'DONE' }, 3);
    assert.equal(generation(c), 4);
    await ok(c, 'FinishPlan', { planId: PLAN }, 3);
    assert.equal(generation(c), 5);
    assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM work_intervals WHERE end_ms IS NULL').get().n, 0);
    assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM step_work_intervals WHERE end_ms IS NULL').get().n, 0);
  } finally {
    c.close();
  }
});

for (const [name, trigger] of [
  ['snapshot', "BEFORE INSERT ON plan_estimation_inputs BEGIN SELECT RAISE(ABORT,'injected'); END"],
  ['refresh queue', "BEFORE INSERT ON estimation_jobs BEGIN SELECT RAISE(ABORT,'injected'); END"],
  ['plan interval', "BEFORE INSERT ON work_intervals BEGIN SELECT RAISE(ABORT,'injected'); END"],
  ['final receipt', "BEFORE UPDATE OF result_json ON command_receipts WHEN NEW.command_type='StartPlan' AND OLD.outcome_code='OK' BEGIN SELECT RAISE(ABORT,'injected'); END"],
]) {
  test(`a failed ${name} write rolls the entire start back and permits an exact retry`, async () => {
    const c = context();
    try {
      await plannedAtlm(c);
      c.db.sqlite.exec('CREATE TRIGGER fail_application_write ' + trigger);
      const before = rows(c);
      const commandId = crypto.randomUUID();
      const rejected = await command(c, 'StartPlan', { planId: PLAN }, 0, commandId);
      assert.equal(rejected.status, 500);
      assert.deepEqual(rows(c), before);
      c.db.sqlite.exec('DROP TRIGGER fail_application_write');
      const retry = await command(c, 'StartPlan', { planId: PLAN }, 0, commandId);
      assert.equal(retry.status, 200, JSON.stringify(retry.value));
      assert.equal(retry.value.replayed, false);
      assert.equal(generation(c), 1);
      assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM plan_estimation_inputs').get().n, 1);
      assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM work_intervals').get().n, 1);
    } finally {
      c.close();
    }
  });
}

test('competing first starts commit one snapshot, interval and source event', async () => {
  const c = context();
  try {
    await plannedAtlm(c);
    const results = await Promise.all([
      command(c, 'StartPlan', { planId: PLAN }, 0),
      command(c, 'StartPlan', { planId: PLAN }, 0),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.equal(results.find((result) => result.status === 409).value.error.code, 'VERSION_CONFLICT');
    assert.equal(c.db.sqlite.prepare('SELECT version FROM plans WHERE plan_id=?').get(PLAN).version, 1);
    assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM plan_estimation_inputs').get().n, 1);
    assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM work_intervals').get().n, 1);
    assert.equal(generation(c), 1);
  } finally {
    c.close();
  }
});
