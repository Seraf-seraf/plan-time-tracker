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

test('repeatedly insufficient time to start fitting ends explicitly instead of yielding forever',async()=>{
 const c=context();try{
  for(let i=0;i<2;i++){const p=await plannedAtlm(c,crypto.randomUUID());await completeAtlm(c,p,1000);c.advance(1);}
  const slowSetup=()=>{let calls=0;return ()=>calls++===0?0:2001;};
  let result=await processEstimationTraining(c.db,OWNER,c.now(),{clock:c.now,wallClock:slowSetup()});
  assert.equal(result.training.status,'QUEUED');
  result=await processEstimationTraining(c.db,OWNER,c.now(),{clock:c.now,wallClock:slowSetup()});
  assert.equal(result.training.status,'FAILED');assert.equal(result.lastReason,'TRAINING_TIME_BUDGET');
  assert.equal(c.db.sqlite.prepare('SELECT reason FROM estimation_training_attempts').get().reason,'TRAINING_TIME_BUDGET');
 }finally{c.close();}
});
