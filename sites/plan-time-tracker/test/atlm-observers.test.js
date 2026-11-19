import assert from 'node:assert/strict';
import test from 'node:test';
import { SqlTransaction } from '../worker/application/transaction.js';
import { TransactionalEvents } from '../worker/application/events.js';
import { AtlmCheckpointObserver } from '../worker/atlm/observers.js';
import { AtlmOwnerRepository } from '../worker/atlm/owner-repository.js';
import { claimAtlmJob, persistAtlmSample, readAtlmSampleSource } from '../worker/atlm/sample.js';
import { processEstimationTraining } from '../worker/atlm/training.js';
import { executeCommand } from '../worker/index.js';
import { OWNER, PLAN, completeAtlm, context, envelope, ok, plannedAtlm } from './fixtures/tracker-db.mjs';

function ownerState(c) {
  return c.db.sqlite.prepare('SELECT * FROM estimation_owner_state WHERE owner_id=?').get(OWNER);
}

test('ATLM initializes owner schema and both job fences without write triggers', async () => {
  const c = context();
  try {
    const first = await plannedAtlm(c);
    await new AtlmOwnerRepository(c.db).ensureStatement(OWNER).run();
    assert.equal(ownerState(c).schema_version, 4);
    const resetAt = c.now() - 1000;
    c.db.sqlite.prepare('UPDATE estimation_owner_state SET data_reset_at=? WHERE owner_id=?')
      .run(resetAt, OWNER);
    await completeAtlm(c, first);
    assert.equal(c.db.sqlite.prepare("SELECT fence FROM estimation_jobs WHERE job_key=?")
      .get('refresh:' + PLAN).fence, resetAt);
    const second = await plannedAtlm(c, '22222222-2222-4222-8222-222222222222');
    await completeAtlm(c, second);
    await processEstimationTraining(c.db, OWNER, c.now());
    const train = c.db.sqlite.prepare("SELECT * FROM estimation_jobs WHERE job_key='train'").get();
    assert.equal(train.fence, resetAt + 1);
    assert.equal(train.status, 'IDLE');
    assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) AS n FROM estimation_checkpoint_parts').get().n, 0);
  } finally {
    c.close();
  }
});

test('delayed source commands keep the owner receipt time for training chronology', async () => {
  const c = context();
  try {
    const first = await plannedAtlm(c);
    const delayedStartAt = c.now();
    c.advance(200);
    const otherPlanId = '33333333-3333-4333-8333-333333333333';
    await plannedAtlm(c, otherPlanId);
    await ok(c, 'StartPlan', { planId: otherPlanId }, 0);
    const latestStartAt = c.now();
    // A request can retain its earlier injected clock while another plan commits.
    await executeCommand(c.db, { ownerId: OWNER },
      envelope('StartPlan', { planId: PLAN }, 0), 'ui', delayedStartAt);
    const job = () => c.db.sqlite.prepare(
      'SELECT created_at,updated_at,source_changed_at FROM estimation_jobs WHERE owner_id=? AND job_key=?',
    ).get(OWNER, 'refresh:' + PLAN);
    assert.equal(job().created_at, latestStartAt);
    assert.equal(job().updated_at, latestStartAt);
    assert.equal(job().source_changed_at, latestStartAt);

    c.advance(200);
    await ok(c, 'SetStepStatus', { stepId: first.step.stepId, status: 'DONE' }, 1);
    await ok(c, 'FinishPlan', { planId: PLAN }, 1);
    await ok(c, 'DeletePlan', { planId: PLAN }, 2);
    const delayedRestoreAt = c.now();
    c.advance(200);
    await ok(c, 'PausePlan', { planId: otherPlanId }, 1);
    await executeCommand(c.db, { ownerId: OWNER },
      envelope('RestorePlan', { planId: PLAN }, 3), 'ui', delayedRestoreAt);
    assert.equal(job().created_at, latestStartAt);
    assert.equal(job().updated_at, c.now());
    assert.equal(job().source_changed_at, c.now());
    const restored = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
    assert.equal(restored.eligibility, 'ELIGIBLE');
    assert.equal(restored.sourceAvailableAt, c.now());
  } finally {
    c.close();
  }
});

test('sample failure rolls back staged counters and a retry records one experience', async () => {
  const c = context();
  try {
    await completeAtlm(c, await plannedAtlm(c));
    const lease = await claimAtlmJob(c.db, OWNER, 'refresh:' + PLAN, c.now());
    const source = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
    const before = ownerState(c);
    c.db.sqlite.exec(`CREATE TRIGGER fail_sample_insert BEFORE INSERT ON estimation_samples
      BEGIN SELECT RAISE(ABORT,'sample insertion fault'); END;`);
    await assert.rejects(persistAtlmSample(c.db, OWNER, source, c.now(), lease), /sample insertion fault/);
    assert.deepEqual(ownerState(c), before);
    assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) AS n FROM estimation_samples').get().n, 0);
    c.db.sqlite.exec('DROP TRIGGER fail_sample_insert');
    const saved = await persistAtlmSample(c.db, OWNER, source, c.now(), lease);
    assert.equal(saved.inserted, true);
    assert.equal(ownerState(c).dataset_revision, 1);
    assert.equal(ownerState(c).new_sample_count, 1);
    const after = ownerState(c);
    assert.equal((await persistAtlmSample(c.db, OWNER, source, c.now(), lease)).inserted, false);
    assert.deepEqual(ownerState(c), after);
    await assert.rejects(
      persistAtlmSample(c.db, OWNER, { ...source, sourceDigest: 'different-digest' }, c.now(), lease),
      /UNIQUE constraint failed/,
    );
    assert.deepEqual(ownerState(c), after);
  } finally {
    c.close();
  }
});

test('a changed source prevents both sample and owner accounting under an old lease', async () => {
  const c = context();
  try {
    await completeAtlm(c, await plannedAtlm(c));
    const lease = await claimAtlmJob(c.db, OWNER, 'refresh:' + PLAN, c.now());
    const source = await readAtlmSampleSource(c.db, OWNER, PLAN, c.now());
    await ok(c, 'DeletePlan', { planId: PLAN }, 2);
    const before = ownerState(c);
    assert.equal((await persistAtlmSample(c.db, OWNER, source, c.now(), lease)).inserted, false);
    assert.deepEqual(ownerState(c), before);
    assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) AS n FROM estimation_samples').get().n, 0);
  } finally {
    c.close();
  }
});

test('checkpoint discard shares the generation transition guard and rollback', async () => {
  const c = context();
  try {
    await plannedAtlm(c);
    c.db.sqlite.prepare(`INSERT INTO estimation_jobs(owner_id,job_key,kind,generation,processed_generation,
      status,fence,lease_until,executor_epoch,created_at,updated_at)
      VALUES(?,'train','TRAIN',3,1,'RUNNING',8,?,3,?,?)`).run(OWNER, c.now() + 60000, c.now(), c.now());
    for (const generation of [1, 2, 3, 4]) {
      c.db.sqlite.prepare(`INSERT INTO estimation_checkpoint_parts(owner_id,generation,storage_id,field,item,part,content)
        VALUES(?,?,'checkpoint','cases','0',0,'{}')`).run(OWNER, generation);
    }
    const events = new TransactionalEvents({
      'training.checkpoint-discarding': [new AtlmCheckpointObserver()],
    });
    const finish = async (fence) => {
      const guard = {
        sql: `EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key='train'
          AND generation=3 AND fence=? AND status='RUNNING' AND lease_until>?)`,
        args: [OWNER, fence, c.now()],
      };
      const transaction = new SqlTransaction(c.db);
      events.emit(transaction, {
        type: 'training.checkpoint-discarding', ownerId: OWNER, generation: 3, guard,
      });
      transaction.add(`UPDATE estimation_jobs SET processed_generation=generation,status='IDLE',
        executor_epoch=executor_epoch+3,lease_until=NULL WHERE owner_id=? AND job_key='train' AND ${guard.sql}`,
      OWNER, ...guard.args);
      await transaction.commit();
    };
    const generations = () => c.db.sqlite.prepare(
      'SELECT generation FROM estimation_checkpoint_parts ORDER BY generation',
    ).all().map((row) => row.generation);
    await finish(7);
    assert.deepEqual(generations(), [1, 2, 3, 4]);
    c.db.sqlite.exec(`CREATE TRIGGER fail_job_completion BEFORE UPDATE OF status ON estimation_jobs
      BEGIN SELECT RAISE(ABORT,'job completion fault'); END;`);
    await assert.rejects(finish(8), /job completion fault/);
    assert.deepEqual(generations(), [1, 2, 3, 4]);
    c.db.sqlite.exec('DROP TRIGGER fail_job_completion');
    await finish(8);
    assert.deepEqual(generations(), [4]);
    assert.equal(c.db.sqlite.prepare("SELECT status FROM estimation_jobs WHERE job_key='train'").get().status, 'IDLE');
  } finally {
    c.close();
  }
});
