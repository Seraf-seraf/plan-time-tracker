import test from 'node:test';
import assert from 'node:assert/strict';
import { context, mcp, plannedAtlm, completeAtlm, OWNER } from './fixtures/tracker-db.mjs';
import { claimAtlmJob, processEstimationTraining } from '../worker/index.js';

test('each explicit training attempt is recorded even when there is no data',async()=>{
  const c=context();try{
    const response=await mcp(c,'StartTraining');
    assert.equal(response.value.result.isError,undefined,JSON.stringify(response.value));
    const attempts=c.db.sqlite.prepare('SELECT * FROM estimation_training_attempts ORDER BY started_at,attempt_id').all();
    assert.equal(attempts.length,1);assert.ok(attempts[0].completed_at!==null);
    assert.equal(attempts[0].reason,'INSUFFICIENT_DATA');
    assert.equal(attempts[0].method_version,'agent-v5-operations');
    assert.deepEqual(JSON.parse(attempts[0].manifest_json),[]);
  }finally{c.close();}
});

test('two new eligible plans produce one automatic training attempt',async()=>{
  const c=context();try{
    for(let i=0;i<2;i++){const plan=await plannedAtlm(c,crypto.randomUUID());await completeAtlm(c,plan,1000);c.advance(1);}
    const response=await mcp(c,'ContinueTraining');assert.equal(response.value.result.isError,undefined,JSON.stringify(response.value));
    const attempts=c.db.sqlite.prepare('SELECT * FROM estimation_training_attempts').all();
    assert.equal(attempts.length,1);assert.ok(attempts[0].completed_at!==null);
    assert.equal(JSON.parse(attempts[0].manifest_json).length,2);
    await mcp(c,'ContinueTraining');assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM estimation_training_attempts').get().n,1);
  }finally{c.close();}
});

test('a failed attempt and its retry are both retained without duplicate completion',async()=>{
  const c=context();try{
    c.db.sqlite.exec("CREATE TRIGGER fail_training_model BEFORE INSERT ON estimation_models BEGIN SELECT RAISE(ABORT,'fixture fault'); END;");
    const failed=await mcp(c,'StartTraining');assert.equal(failed.value.result.isError,true);
    let attempts=c.db.sqlite.prepare('SELECT * FROM estimation_training_attempts ORDER BY attempt_id').all();
    assert.equal(attempts.length,1);assert.equal(attempts[0].reason,'TRAINING_EXECUTION_FAILED');assert.notEqual(attempts[0].completed_at,null);
    c.db.sqlite.exec('DROP TRIGGER fail_training_model');c.advance(60001);
    const retried=await mcp(c,'ContinueTraining');assert.equal(retried.value.result.isError,undefined,JSON.stringify(retried.value));
    attempts=c.db.sqlite.prepare('SELECT * FROM estimation_training_attempts ORDER BY attempt_id').all();
    assert.equal(attempts.length,2);assert.notEqual(attempts[1].completed_at,null);
    await mcp(c,'ContinueTraining');assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) n FROM estimation_training_attempts').get().n,2);
  }finally{c.close();}
});

test('training persists the independent interval decision on accumulated history',async()=>{
  const c=context();try{
    for(let i=0;i<8;i++){
      const plan=await plannedAtlm(c,crypto.randomUUID());await completeAtlm(c,plan,1000+i*200);c.advance(1);
    }
    const response=await mcp(c,'ContinueTraining');
    assert.equal(response.value.result.isError,undefined,JSON.stringify(response.value));
    const attempt=c.db.sqlite.prepare('SELECT * FROM estimation_training_attempts ORDER BY started_at DESC, rowid DESC LIMIT 1').get();
    assert.ok(attempt.completed_at!==null,JSON.stringify(attempt));
    assert.ok(attempt.selected_json,JSON.stringify(attempt));
    const selected=JSON.parse(attempt.selected_json);
    assert.ok(selected.point);assert.ok(selected.interval);
    assert.ok(['BAYESIAN_PREDICTIVE','BAYES_QUANTILE',null].includes(selected.interval.selectedEngine));
  }finally{c.close();}
});


test('recovery records an attempt if the worker crashes immediately after claiming',async()=>{
 const c=context();try {
  c.db.sqlite.prepare('INSERT INTO owners(owner_id,created_at) VALUES(?,?)').run(OWNER,c.now());
  c.db.sqlite.prepare("INSERT INTO estimation_jobs(owner_id,job_key,kind,created_at,updated_at) VALUES(?,'train','TRAIN',?,?)").run(OWNER,c.now(),c.now());
  const start=c.now(),claimed=await claimAtlmJob(c.db,OWNER,'train',start);
  assert.equal(claimed.attempts,1);assert.equal(c.db.sqlite.prepare('SELECT count(*) n FROM estimation_training_attempts').get().n,0);
  c.advance(60001);await processEstimationTraining(c.db,OWNER,c.now(),{clock:c.now});
  const attempt=c.db.sqlite.prepare('SELECT * FROM estimation_training_attempts').get();
  assert.equal(attempt.attempt_id,'g1-a1');assert.equal(attempt.started_at,start);assert.equal(attempt.reason,'LEASE_EXPIRED');
  assert.equal(c.db.sqlite.prepare("SELECT status FROM estimation_jobs WHERE job_key='train'").get().status,'RETRY_WAIT');
 }finally{c.close();}
});

test('failure to create an attempt leaves the lease recoverable',async()=>{
 const c=context();try{
  await plannedAtlm(c,crypto.randomUUID());
  c.db.sqlite.exec("CREATE TRIGGER fail_attempt BEFORE INSERT ON estimation_training_attempts BEGIN SELECT RAISE(ABORT,'fixture fault'); END;");
  const failed=await mcp(c,'StartTraining');assert.equal(failed.value.result.isError,true);
  assert.equal(c.db.sqlite.prepare("SELECT status FROM estimation_jobs WHERE job_key='train'").get().status,'RUNNING');
  c.db.sqlite.exec('DROP TRIGGER fail_attempt');c.advance(60001);
  await processEstimationTraining(c.db,OWNER,c.now(),{clock:c.now});
  const attempt=c.db.sqlite.prepare('SELECT * FROM estimation_training_attempts').get();
  assert.equal(attempt.attempt_id,'g1-a1');assert.equal(attempt.reason,'LEASE_EXPIRED');
 }finally{c.close();}
});

test('training tolerates slow setup and resumes after the candidate checkpoint', async () => {
  const c = context();
  try {
    for (const duration of [1000, 1500]) {
      const plan = await plannedAtlm(c, crypto.randomUUID());
      await completeAtlm(c, plan, duration);
      c.advance(1);
    }
    const job = c.db.sqlite.prepare("SELECT checkpoint_json FROM estimation_jobs WHERE job_key='train'");
    const wallClock = () => {
      const fields = JSON.parse(job.get()?.checkpoint_json ?? '{}').fields;
      return fields?.includes('finalCandidates') ? 10001 : 2001;
    };
    let first = true;
    const paused = await processEstimationTraining(c.db, OWNER, c.now(), {
      clock: c.now,
      wallClock: () => {
        if (!first) return wallClock();
        first = false;
        return 0;
      },
    });
    assert.equal(paused.training.status, 'QUEUED');
    assert.equal(paused.lastReason, null);
    assert.ok(JSON.parse(job.get().checkpoint_json).fields.includes('finalCandidates'));

    const pending = c.db.sqlite.prepare('SELECT * FROM estimation_training_attempts').all();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].completed_at, null);
    c.db.sqlite.exec(`CREATE TRIGGER forbid_rewriting_candidates
      BEFORE INSERT ON estimation_checkpoint_parts WHEN NEW.field='finalCandidates'
      BEGIN SELECT RAISE(ABORT, 'The saved candidate checkpoint must be reused'); END`);
    const resumed = await processEstimationTraining(c.db, OWNER, c.now(), {
      clock: c.now,
      wallClock: () => 0,
    });
    assert.equal(resumed.activeModel.sampleCount, 2);
    const completed = c.db.sqlite.prepare('SELECT * FROM estimation_training_attempts').all();
    assert.equal(completed.length, 1);
    assert.equal(completed[0].attempt_id, pending[0].attempt_id);
    assert.notEqual(completed[0].completed_at, null);
    assert.equal(completed[0].reason, null);
  } finally {
    c.close();
  }
});

test('consecutive passes without progress record the stalled phase', async () => {
  const c = context();
  try {
    for (let i = 0; i < 2; i++) {
      const plan = await plannedAtlm(c, crypto.randomUUID());
      await completeAtlm(c, plan, 1000);
      c.advance(1);
    }
    const slowSetup = () => {
      let first = true;
      return () => {
        if (!first) return 9001;
        first = false;
        return 0;
      };
    };
    // The first pass saves its snapshot. Only later passes without progress count.
    for (let pass = 0; pass < 3; pass++) {
      const result = await processEstimationTraining(c.db, OWNER, c.now(), {
        clock: c.now, wallClock: slowSetup(),
      });
      assert.equal(result.training.status, 'QUEUED');
    }
    const result = await processEstimationTraining(c.db, OWNER, c.now(), {
      clock: c.now, wallClock: slowSetup(),
    });
    assert.equal(result.training.status, 'FAILED');
    assert.equal(result.lastReason, 'TRAINING_TIME_BUDGET');
    assert.deepEqual(result.lastAttempt.parameters, {
      phase: 'EVALUATE',
      sampleCount: 2,
      completedCases: 0,
      stalledPasses: 3,
      passElapsedMs: 9001,
    });
  } finally {
    c.close();
  }
});

test('an interrupted attempt retains its snapshot and ends at the expired lease', async () => {
  const c = context();
  try {
    for (const duration of [1000, 1500]) {
      const plan = await plannedAtlm(c, crypto.randomUUID());
      await completeAtlm(c, plan, duration);
      c.advance(1);
    }
    let first = true;
    await processEstimationTraining(c.db, OWNER, c.now(), {
      clock: c.now,
      wallClock: () => {
        if (!first) return 9001;
        first = false;
        return 0;
      },
    });
    const saved = c.db.sqlite.prepare("SELECT * FROM estimation_jobs WHERE job_key='train'").get();
    const snapshot = JSON.parse(saved.snapshot_json);
    let attempt = c.db.sqlite.prepare('SELECT * FROM estimation_training_attempts').get();
    assert.deepEqual(JSON.parse(attempt.manifest_json), snapshot.manifest);
    assert.equal(attempt.dataset_revision, snapshot.datasetRevision);

    const claimed = await claimAtlmJob(c.db, OWNER, 'train', c.now());
    assert.equal(claimed.attempts, 1, 'a queued continuation keeps the same attempt');
    c.advance(12 * 60 * 60 * 1000);
    const recoveredAt = c.now();
    await processEstimationTraining(c.db, OWNER, c.now(), { clock: c.now, wallClock: () => 0 });
    const history = (await mcp(c, 'GetTrainingHistory')).value.result.structuredContent;
    attempt = history.rows.find(row => row.attemptId === 'g1-a1');
    assert.equal(attempt.reason, 'LEASE_EXPIRED');
    assert.equal(attempt.completedAt, claimed.lease_until);
    assert.deepEqual(attempt.manifest, snapshot.manifest);
    assert.equal(attempt.diagnostics.parameters.sampleCount, 2);
    assert.equal(attempt.diagnostics.parameters.phase, 'EVALUATE');
    assert.equal(attempt.diagnostics.parameters.completedCases, 0);
    assert.equal(attempt.diagnostics.parameters.recoveredAt, recoveredAt);
    assert.ok(history.rows.some(row => row.attemptId === 'g1-a2' && row.completedAt !== null));
  } finally {
    c.close();
  }
});

test('a failed checkpoint preserves the attempted dataset and phase', async () => {
  const c = context();
  try {
    for (const duration of [1000, 1500]) {
      const plan = await plannedAtlm(c, crypto.randomUUID());
      await completeAtlm(c, plan, duration);
      c.advance(1);
    }
    c.db.sqlite.exec(`CREATE TRIGGER fail_checkpoint BEFORE INSERT ON estimation_checkpoint_parts
      BEGIN SELECT RAISE(ABORT, 'private fixture failure'); END`);
    await assert.rejects(processEstimationTraining(c.db, OWNER, c.now(), {
      clock: c.now, wallClock: () => 0,
    }), { code: 'SOURCE_UNAVAILABLE' });
    const history = (await mcp(c, 'GetTrainingHistory')).value.result.structuredContent;
    const attempt = history.rows[0];
    assert.equal(attempt.reason, 'TRAINING_EXECUTION_FAILED');
    assert.equal(attempt.manifest.length, 2);
    assert.equal(attempt.diagnostics.parameters.sampleCount, 2);
    assert.equal(attempt.diagnostics.parameters.phase, 'EVALUATE');
    assert.equal(attempt.diagnostics.parameters.passElapsedMs, 0);
    assert.equal(JSON.stringify(history).includes('private fixture failure'), false);
    c.db.sqlite.exec('DROP TRIGGER fail_checkpoint');
    c.advance(60001);
    const resumed = await processEstimationTraining(c.db, OWNER, c.now(), {
      clock: c.now, wallClock: () => 0,
    });
    assert.equal(resumed.activeModel.sampleCount, 2);
  } finally {
    c.close();
  }
});
