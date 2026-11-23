import test from 'node:test';
import assert from 'node:assert/strict';
import { claimAtlmJob, readAtlmSamples } from '../worker/atlm/sample.js';
import { processAtlmSampleRefresh, readAtlmSampleRefreshStatus } from '../worker/atlm/sample-refresh.js';
import { command, completeAtlm, context, envelope, ok, plannedAtlm, OWNER, PLAN } from './fixtures/tracker-db.mjs';

const retryDelaysMs = [60_000, 300_000, 900_000];
const readSource = sql => sql.startsWith('SELECT p.*,') && sql.includes('i.forecast_json');
const readyRefresh = sql => sql.startsWith('SELECT job_key FROM estimation_jobs');
const jobKey = 'refresh:' + PLAN;
const job = c => c.db.sqlite.prepare('SELECT * FROM estimation_jobs WHERE owner_id=? AND job_key=?').get(OWNER, jobKey);
const status = c => readAtlmSampleRefreshStatus(c.db, OWNER, c.now());
const drain = (c, maxJobs) => processAtlmSampleRefresh(c.db, OWNER, c.now(), { clock: c.now, maxJobs });

function interceptRead(c, predicate, callback) {
  const prepare = c.db.prepare;
  c.db.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (!predicate(sql)) return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...args) => {
      const bound = bind(...args);
      bound.first = callback.bind(null, bound.first.bind(bound));
      return bound;
    };
    return statement;
  };
  return () => { c.db.prepare = prepare; };
}

function pauseSource(c) {
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  const restore = interceptRead(c, readSource, async read => {
    restore();
    const row = await read();
    reached.resolve();
    await release.promise;
    return row;
  });
  return { reached: reached.promise, release: release.resolve };
}

test('refresh retries at 1, 5 and 15 minutes, reports exhaustion, and resets for new source facts', async () => {
  const c = context();
  try {
    await completeAtlm(c, await plannedAtlm(c));
    assert.equal((await status(c)).pendingCount, 1);
    assert.equal((await readAtlmSampleRefreshStatus(c.db, 'another-owner', c.now())).pendingCount, 0);
    const restore = interceptRead(c, readSource, async () => { throw new Error('private injected storage failure'); });
    try {
      for (const [i, waitMs] of retryDelaysMs.entries()) {
        await drain(c);
        const failed = job(c);
        assert.equal(failed.attempts, i + 1);
        assert.equal(failed.status, 'RETRY_WAIT');
        assert.equal(failed.next_attempt_at, c.now() + waitMs);
        assert.equal((await status(c)).nextAttemptAt, failed.next_attempt_at);
        c.advance(waitMs - 1);
        assert.equal((await drain(c)).processedCount, 0);
        assert.equal(job(c).attempts, i + 1);
        c.advance(1);
        assert.equal((await status(c)).due, true);
      }
      const exhausted = await drain(c);
      assert.equal(job(c).attempts, 4);
      assert.equal(job(c).status, 'FAILED');
      assert.equal(job(c).last_error, 'SOURCE_REFRESH_FAILED');
      assert.deepEqual(exhausted, { pendingCount: 0, failedCount: 1, due: false, nextAttemptAt: null, processedCount: 1 });
      assert.deepEqual(await readAtlmSamples(c.db, OWNER), []);
    } finally { restore(); }
    assert.equal((await drain(c)).processedCount, 0);
    await ok(c, 'UpdatePlanMetadata', { planId: PLAN, title: 'Changed source facts' }, 2);
    assert.equal(job(c).attempts, 0);
    assert.equal((await drain(c)).failedCount, 0);
    assert.equal(job(c).attempts, 1);
    assert.equal(job(c).status, 'IDLE');
    assert.equal((await readAtlmSamples(c.db, OWNER)).length, 1);
  } finally { c.close(); }
});

test('a generation changed during a leased read stays pending and only the fresh observation is saved', async () => {
  const c = context();
  let paused, pending;
  try {
    await completeAtlm(c, await plannedAtlm(c));
    paused = pauseSource(c);
    pending = drain(c, 1);
    await paused.reached;
    const old = job(c);
    await ok(c, 'UpdatePlanMetadata', { planId: PLAN, title: 'Changed while reading' }, 2);
    assert.ok(job(c).generation > old.generation);
    paused.release();
    const result = await pending;
    assert.equal(result.pendingCount, 1);
    assert.equal(result.due, true);
    assert.equal(job(c).status, 'QUEUED');
    assert.deepEqual(await readAtlmSamples(c.db, OWNER), []);
    assert.equal((await drain(c, 1)).pendingCount, 0);
    const [sample] = await readAtlmSamples(c.db, OWNER, { latestOnly: false });
    assert.equal(sample.sourceGeneration, job(c).generation);
    assert.ok(sample.reasons.includes('SCOPE_CHANGED'));
    assert.equal((await drain(c)).processedCount, 0);
    assert.deepEqual(await readAtlmSamples(c.db, OWNER, { latestOnly: false }), [sample]);
  } finally {
    paused?.release();
    await pending?.catch(() => {});
    c.close();
  }
});

test('at lease expiry a refresh waits durably and a new fence rejects the late executor', async () => {
  const c = context();
  let first, oldPass, second, newPass;
  try {
    await completeAtlm(c, await plannedAtlm(c));
    first = pauseSource(c);
    oldPass = drain(c, 1);
    await first.reached;
    const old = job(c);
    c.advance(old.lease_until - c.now());
    const recovered = await drain(c);
    assert.equal(recovered.processedCount, 0);
    assert.equal(recovered.nextAttemptAt, old.lease_until + retryDelaysMs[0]);
    assert.equal(job(c).last_error, 'LEASE_EXPIRED');
    assert.equal(job(c).status, 'RETRY_WAIT');

    c.advance(retryDelaysMs[0]);
    second = pauseSource(c);
    newPass = drain(c, 1);
    await second.reached;
    const replacement = job(c);
    assert.ok(replacement.fence > old.fence);
    assert.equal(replacement.attempts, 2);
    first.release();
    await oldPass;
    assert.deepEqual(job(c), replacement);
    assert.deepEqual(await readAtlmSamples(c.db, OWNER), []);

    second.release();
    assert.equal((await newPass).pendingCount, 0);
    assert.equal(job(c).status, 'IDLE');
    assert.equal(job(c).processed_generation, replacement.generation);
    assert.equal((await readAtlmSamples(c.db, OWNER, { latestOnly: false })).length, 1);
  } finally {
    first?.release();
    second?.release();
    await Promise.allSettled([oldPass, newPass]);
    c.close();
  }
});

test('an expired competing claim after the ready read cannot bypass recovery and backoff', async () => {
  const c = context();
  try {
    await completeAtlm(c, await plannedAtlm(c));
    const restore = interceptRead(c, readyRefresh, async read => {
      const selected = await read();
      const competing = await claimAtlmJob(c.db, OWNER, jobKey, c.now());
      assert.ok(competing);
      c.advance(competing.lease_until - c.now());
      return selected;
    });
    try { assert.equal((await drain(c, 1)).processedCount, 0); } finally { restore(); }
    const expired = job(c);
    assert.equal(expired.attempts, 1);
    assert.equal(expired.status, 'RUNNING');
    assert.equal((await drain(c)).nextAttemptAt, expired.lease_until + retryDelaysMs[0]);
    assert.equal(job(c).status, 'RETRY_WAIT');
    assert.deepEqual(await readAtlmSamples(c.db, OWNER), []);
  } finally { c.close(); }
});

test('failure to schedule the refresh leaves the successful Finish response and receipt available', async () => {
  const c = context();
  try {
    const plan = await plannedAtlm(c);
    await ok(c, 'StartPlan', { planId: PLAN }, 0);
    await ok(c, 'SetStepStatus', { stepId: plan.step.stepId, status: 'DONE' }, 1);
    c.advance(1000);
    const finish = envelope('FinishPlan', { planId: PLAN }, 1);
    const request = new Request('http://localhost/api/commands', {
      method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': OWNER },
      body: JSON.stringify(finish),
    });
    let attempted = false;
    const response = await c.worker.fetch(request, { DB: c.db }, {
      waitUntil() { attempted = true; throw new Error('execution context unavailable'); },
    });
    assert.equal(attempted, true);
    assert.equal(response.status, 200);
    const applied = await response.json();
    const replay = await command(c, 'FinishPlan', finish.payload, finish.expectedVersion, finish.commandId);
    assert.equal(replay.value.replayed, true);
    assert.deepEqual(replay.value.result, applied.result);
    await drain(c);
    const samples = await readAtlmSamples(c.db, OWNER, { latestOnly: false });
    assert.equal(samples.length, 1);
    assert.equal(samples[0].actualMs, 1000);
  } finally { c.close(); }
});
