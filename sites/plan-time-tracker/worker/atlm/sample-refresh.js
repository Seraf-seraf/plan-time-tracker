import { dbFirst } from '../shared/index.js';
import { claimAtlmJob, persistAtlmSample, readAtlmSampleSource } from './sample.js';

const REFRESH_LEASE_MS = 60_000;
const REFRESH_BUDGET_MS = 9_000;
const REFRESH_RETRY_MS = [60_000, 300_000, 900_000];
const REFRESH_MAX_ATTEMPTS = REFRESH_RETRY_MS.length + 1;
const REFRESH_MAX_JOBS = 100;
const REFRESH_PASSES = 2;

function refreshFailureCode(error) {
  return ['INVALID_ESTIMATION_SOURCE', 'SOURCE_UNAVAILABLE'].includes(error?.code)
    ? error.code : 'SOURCE_REFRESH_FAILED';
}

async function readAtlmSampleRefreshStatus(db, ownerId, nowMs) {
  const row = await dbFirst(db,
    `SELECT
      count(*) FILTER (WHERE status<>'FAILED') AS pending_count,
      count(*) FILTER (WHERE status='FAILED') AS failed_count,
      min(CASE WHEN status='RUNNING' THEN lease_until
        WHEN status<>'FAILED' THEN next_attempt_at END) AS next_at
    FROM estimation_jobs
    WHERE owner_id=? AND kind='REFRESH_SAMPLE' AND generation>processed_generation`,
    ownerId);
  return {
    pendingCount: row.pending_count,
    failedCount: row.failed_count,
    due: row.next_at !== null && row.next_at <= nowMs,
    nextAttemptAt: row.next_at,
  };
}

async function recoverExpiredRefreshes(db, ownerId, nowMs) {
  await db.prepare(
    `UPDATE estimation_jobs
    SET status=CASE WHEN attempts>=? THEN 'FAILED' WHEN attempts=0 THEN 'QUEUED' ELSE 'RETRY_WAIT' END,
      executor_epoch=executor_epoch+2,
      next_attempt_at=CASE WHEN attempts>=? OR attempts=0 THEN 0
        ELSE lease_until+CASE attempts WHEN 1 THEN ? WHEN 2 THEN ? ELSE ? END END,
      lease_until=NULL,last_error=CASE WHEN attempts=0 THEN NULL ELSE 'LEASE_EXPIRED' END,updated_at=?
    WHERE owner_id=? AND kind='REFRESH_SAMPLE' AND status='RUNNING' AND lease_until<=?`,
  ).bind(REFRESH_MAX_ATTEMPTS, REFRESH_MAX_ATTEMPTS, ...REFRESH_RETRY_MS, nowMs, ownerId, nowMs).run();
}

async function releaseSupersededRefresh(db, ownerId, job, nowMs) {
  await db.prepare(
    `UPDATE estimation_jobs SET status='QUEUED',executor_epoch=executor_epoch+2,lease_until=NULL,
      attempts=0,next_attempt_at=0,last_error=NULL,updated_at=?
    WHERE owner_id=? AND job_key=? AND kind='REFRESH_SAMPLE' AND fence=?
      AND generation>? AND status='RUNNING' AND lease_until>?`,
  ).bind(nowMs, ownerId, job.job_key, job.fence, job.generation, nowMs).run();
}

async function refreshSample(db, ownerId, job, clock) {
  try {
    const source = await readAtlmSampleSource(db, ownerId, job.plan_id, clock());
    await persistAtlmSample(db, ownerId, source, clock(), job);
    const nowMs = clock();
    await db.prepare(
      `UPDATE estimation_jobs SET processed_generation=generation,status='IDLE',executor_epoch=executor_epoch+2,
        lease_until=NULL,next_attempt_at=0,last_error=NULL,updated_at=?
      WHERE owner_id=? AND job_key=? AND kind='REFRESH_SAMPLE' AND generation=? AND fence=?
        AND status='RUNNING' AND lease_until>?`,
    ).bind(nowMs, ownerId, job.job_key, job.generation, job.fence, nowMs).run();
  } catch (error) {
    const nowMs = clock();
    const exhausted = job.attempts >= REFRESH_MAX_ATTEMPTS;
    const retryAt = exhausted ? 0 : nowMs + REFRESH_RETRY_MS[job.attempts - 1];
    await db.prepare(
      `UPDATE estimation_jobs SET status=?,executor_epoch=executor_epoch+2,lease_until=NULL,
         next_attempt_at=?,last_error=?,updated_at=?
      WHERE owner_id=? AND job_key=? AND kind='REFRESH_SAMPLE' AND generation=? AND fence=?
        AND status='RUNNING' AND lease_until>?`,
    ).bind(exhausted ? 'FAILED' : 'RETRY_WAIT', retryAt, refreshFailureCode(error), nowMs,
      ownerId, job.job_key, job.generation, job.fence, nowMs).run();
  }
  await releaseSupersededRefresh(db, ownerId, job, clock());
}

async function processAtlmSampleRefresh(db, ownerId, nowMs, options = {}) {
  const wallClock = options.wallClock ?? (() => performance.now());
  const started = wallClock();
  const clock = options.clock ?? (() => nowMs + Math.max(0, Math.floor(wallClock() - started)));
  const maxJobs = Math.min(options.maxJobs ?? REFRESH_MAX_JOBS, REFRESH_MAX_JOBS);
  await recoverExpiredRefreshes(db, ownerId, clock());
  let processedCount = 0;
  for (let operations = 0; operations < maxJobs && wallClock() - started < REFRESH_BUDGET_MS; operations++) {
    const next = await dbFirst(db,
      `SELECT job_key FROM estimation_jobs WHERE owner_id=? AND kind='REFRESH_SAMPLE'
        AND generation>processed_generation AND status IN ('QUEUED','RETRY_WAIT') AND next_attempt_at<=?
      ORDER BY updated_at,job_key LIMIT 1`,
      ownerId, clock());
    if (!next) break;
    const job = await claimAtlmJob(db, ownerId, next.job_key, clock(), REFRESH_LEASE_MS,
      { allowExpiredLease: false });
    if (!job) continue;
    await refreshSample(db, ownerId, job, clock);
    processedCount++;
  }
  return { ...await readAtlmSampleRefreshStatus(db, ownerId, clock()), processedCount };
}

function scheduleAtlmSampleRefresh(db, ownerId, nowMs, ctx, clock) {
  if (typeof ctx?.waitUntil !== 'function') return;
  const run = async () => {
    for (let pass = 0; pass < REFRESH_PASSES; pass++) {
      const result = await processAtlmSampleRefresh(db, ownerId, clock?.() ?? nowMs, { clock });
      if (!result.due || result.processedCount === 0) break;
    }
  };
  const logFailure = (error) => console.error(JSON.stringify({
    event: 'atlm_sample_refresh_background_error', reason: refreshFailureCode(error),
  }));
  try {
    ctx.waitUntil(Promise.resolve().then(run).catch(logFailure));
  } catch (error) {
    logFailure(error);
  }
}

export { processAtlmSampleRefresh, readAtlmSampleRefreshStatus, scheduleAtlmSampleRefresh };
