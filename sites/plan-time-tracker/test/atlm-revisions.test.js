import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { materializeAtlmRevisionFile } from '../worker/atlm/revision-files.js';
import { summarizeAtlmTeacherMode } from '../worker/atlm/teacher-dataset.js';
import { createWorker } from '../worker/index.js';
import { teacherAnnotation } from './fixtures/atlm-revisions.mjs';
import { completeAtlm, context, mcp, ok, OWNER, plannedAtlm, taskV4 } from './fixtures/tracker-db.mjs';

const SNAPSHOT = 'CreateTrainingSnapshot';
const SAVE_DATASET = 'SaveDatasetRevision';
const DATASET = 'GetDatasetRevision';
const REGISTER = 'RegisterModelRevision';
const MODELS = 'ListModelRevisions';
const ACTIVATE = 'ActivateModelRevision';
const OTHER = 'revision-another-owner';
const PART_BYTES = 49_152;
const RETRY_LIMIT = 30;
const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function setup(t) {
  const c = context();
  t.after(() => c.close());
  return c;
}

function sha256(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

async function rpc(c, name, args, owner = OWNER) {
  const response = await mcp(c, name, { schemaVersion: 1, ...args }, owner);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  assert.ok(response.value.result?.structuredContent, JSON.stringify(response.value));
  return response.value.result;
}

function accepted(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent;
}

async function tool(c, name, args, owner) {
  return accepted(await rpc(c, name, args, owner));
}

function refused(result, code) {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.code, code, JSON.stringify(result));
  return result.structuredContent;
}

async function expectError(c, name, args, code, owner) {
  return refused(await rpc(c, name, args, owner), code);
}

const snapshotArgs = (commandId = crypto.randomUUID()) => ({ mode: 'create', commandId });
const snapshotRead = (snapshotId, view, args = {}) => ({ mode: 'read', snapshotId, view, ...args });

async function download(c, name, selector, owner) {
  let state;
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
    state = await tool(c, name, { ...selector, view: 'download' }, owner);
    if (state.state === 'READY') break;
    assert.equal(state.state, 'MATERIALIZING');
  }
  assert.equal(state.state, 'READY');
  const { file } = state;
  assert.equal(file.partSize, PART_BYTES);
  assert.equal(file.encoding, 'base64');
  const parts = [];
  for (let partIndex = 0; partIndex < file.partCount; partIndex++) {
    const result = await rpc(c, name, { ...selector, view: 'filePart', partIndex }, owner);
    const part = accepted(result);
    assert.equal(part.partIndex, partIndex);
    assert.equal(part.fileSha256, file.sha256);
    assert.equal(result.content.some((item) => item.text?.includes(part.contentBase64)), false);
    parts.push(Buffer.from(part.contentBase64, 'base64'));
  }
  const bytes = Buffer.concat(parts);
  assert.equal(bytes.byteLength, file.byteLength);
  assert.equal(sha256(bytes), file.sha256);
  return { bytes, file, value: JSON.parse(bytes) };
}

async function upload(c, name, args, value, owner) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const input = {
    ...args, commandId: args.commandId ?? crypto.randomUUID(),
    file: { sha256: sha256(bytes), byteLength: bytes.byteLength },
  };
  const prepared = await tool(c, name, { ...input, phase: 'prepare' }, owner);
  assert.equal(prepared.state, 'UPLOADING');
  for (let start = 0, partIndex = 0; start < bytes.length; start += PART_BYTES, partIndex++) {
    const contentBase64 = bytes.subarray(start, start + PART_BYTES).toString('base64');
    await tool(c, name, { ...input, phase: 'putPart', partIndex, contentBase64 }, owner);
  }
  return { ...input, phase: 'commit' };
}

async function commit(c, name, args, owner) {
  let result;
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
    result = await rpc(c, name, args, owner);
    if (result.structuredContent.state !== 'VALIDATING') return result;
  }
  throw new Error(name + ' did not resolve VALIDATING: ' + JSON.stringify(result));
}

async function completed(c, elapsedMs, task) {
  const plan = await plannedAtlm(c, crypto.randomUUID(), task);
  await completeAtlm(c, plan, elapsedMs);
  c.advance(1);
  return plan;
}

function beforeBatch(c, table, effect) {
  const original = c.db.batch;
  const insert = new RegExp('insert(?: or [a-z_]+)? into\\s+' + table + '\\b', 'i');
  let calls = 0;
  c.db.batch = async function(statements) {
    if (!calls && statements.some((statement) => insert.test(statement.sql))) {
      calls++;
      await effect();
    }
    return original.call(this, statements);
  };
  return {
    calls: () => calls,
    restore: () => { c.db.batch = original; },
  };
}

function annotations(snapshot, parentDatasetRevisionId = null) {
  return {
    schemaVersion: 1, contract: 'atlm-teacher-annotations',
    snapshotId: snapshot.snapshotId, parentDatasetRevisionId,
    rows: snapshot.rows.map((row, index) => row.source.status === 'AVAILABLE'
      && row.source.planStatus === 'COMPLETED' && row.source.deletedAt === null
      ? teacherAnnotation(row.rowId, 'group-' + index)
      : { rowId: row.rowId, groupId: null, eligibility: 'EXCLUDED',
        reasons: ['SOURCE_NOT_USABLE'], annotation: null }),
  };
}

async function save(c, document, owner) {
  const { snapshotId, parentDatasetRevisionId } = document;
  const args = await upload(c, SAVE_DATASET, { snapshotId, parentDatasetRevisionId }, document, owner);
  return { args, saved: accepted(await commit(c, SAVE_DATASET, args, owner)) };
}

async function capture(c) {
  const { snapshotId } = await tool(c, SNAPSHOT, snapshotArgs());
  return (await download(c, SNAPSHOT, { mode: 'read', snapshotId })).value;
}

test('snapshot source repair requeues safely and verifies old measurements from the original journal', async (t) => {
  const c = setup(t);
  const healthy = await completed(c, 1_000);
  await capture(c);
  const missing = await completed(c, 2_000);
  await ok(c, 'UpdatePlanMetadata', { planId: missing.planId, title: 'Verified source update' }, 2);
  const sourceChangedAt = c.now();
  c.advance(10);
  const failed = await completed(c, 3_000);
  const pending = await completed(c, 4_000);
  const protectedPlan = await completed(c, 5_000);
  const badJournal = await completed(c, 6_000);
  const deleted = await completed(c, 7_000);
  await ok(c, 'DeletePlan', { planId: deleted.planId }, 2);
  const unfinished = await plannedAtlm(c, crypto.randomUUID());
  const unknown = crypto.randomUUID();
  const db = c.db.sqlite;
  db.prepare('UPDATE work_intervals SET start_ms=start_ms+1 WHERE owner_id=? AND plan_id=?')
    .run(OWNER, badJournal.planId);
  const removeJob = db.prepare('DELETE FROM estimation_jobs WHERE owner_id=? AND plan_id=?');
  for (const plan of [missing, protectedPlan, badJournal]) {
    assert.equal(removeJob.run(OWNER, plan.planId).changes, 1);
  }
  const jobFor = db.prepare('SELECT * FROM estimation_jobs WHERE owner_id=? AND plan_id=?');
  db.prepare(`UPDATE estimation_jobs SET status='FAILED',attempts=4,last_error='SOURCE_REFRESH_FAILED'
    WHERE owner_id=? AND plan_id=?`).run(OWNER, failed.planId);
  const failure = jobFor.get(OWNER, failed.planId);
  const healthyJob = jobFor.get(OWNER, healthy.planId);
  const pendingJob = jobFor.get(OWNER, pending.planId);
  const issued = db.prepare('SELECT forecast_json FROM plan_estimation_inputs WHERE owner_id=? AND plan_id=?');
  const forecastBefore = issued.get(OWNER, missing.planId);

  db.prepare(`INSERT INTO estimation_model_revisions(owner_id,model_revision_id,origin,method_version,feature_version,
    registered_at,artifact_json,manifest_json,provenance_json,fit_count,source_count,supported)
    VALUES(?,'supported-source','IMPORTED','agent-v5-operations','agent-task-v4',?,'{}','[]','{}',1,1,1)`)
    .run(OWNER, c.now());
  db.prepare(`INSERT INTO estimation_model_revision_sources(owner_id,model_revision_id,plan_id,source_generation,ordinal)
    VALUES(?,'supported-source',?,0,0)`).run(OWNER, protectedPlan.planId);
  const protectedSource = db.prepare("SELECT source_problem FROM estimation_serving_models WHERE owner_id=? AND model_id='supported-source'");
  assert.equal(protectedSource.get(OWNER).source_problem, null);

  const requested = [
    [missing.planId, 'QUEUED'], [failed.planId, 'REQUEUED'], [pending.planId, 'ALREADY_PENDING'],
    [healthy.planId, 'SOURCE_ALREADY_OBSERVED'], [protectedPlan.planId, 'PROTECTED_MODEL_SOURCE'],
    [badJournal.planId, 'QUEUED'], [deleted.planId, 'NOT_APPLICABLE'], [unfinished.planId, 'NOT_APPLICABLE'],
    [unknown, 'PLAN_NOT_FOUND'],
  ];
  const command = { mode: 'repair', commandId: crypto.randomUUID(), planIds: requested.map(([planId]) => planId) };
  await expectError(c, SNAPSHOT, { ...command, planIds: [missing.planId, missing.planId] }, 'VALIDATION_ERROR');
  const outsideOwner = await tool(c, SNAPSHOT, { ...command, planIds: [missing.planId] }, OTHER);
  assert.deepEqual(outsideOwner.rows, [{ planId: missing.planId, status: 'PLAN_NOT_FOUND' }]);
  const simultaneous = await Promise.all([tool(c, SNAPSHOT, command), tool(c, SNAPSHOT, command)]);
  const repaired = simultaneous.find((result) => !result.replayed);
  assert.ok(repaired);
  assert.equal(simultaneous.filter((result) => result.replayed).length, 1);
  assert.equal(repaired.state, 'REPAIR_QUEUED');
  assert.deepEqual(repaired.rows, requested.map(([planId, status]) => ({ planId, status })));
  assert.deepEqual(await tool(c, SNAPSHOT, command), { ...repaired, replayed: true });
  await expectError(c, SNAPSHOT, { ...command, planIds: [healthy.planId] }, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(jobFor.get(OWNER, missing.planId).source_changed_at, sourceChangedAt);
  assert.deepEqual(jobFor.get(OWNER, healthy.planId), healthyJob);
  assert.deepEqual(jobFor.get(OWNER, pending.planId), pendingJob);
  const requeued = jobFor.get(OWNER, failed.planId);
  assert.equal(requeued.generation, failure.generation);
  assert.equal(requeued.source_changed_at, failure.source_changed_at);
  assert.equal(requeued.attempts, 0);
  assert.equal(requeued.last_error, null);
  assert.equal(jobFor.get(OWNER, protectedPlan.planId), undefined);
  assert.equal(protectedSource.get(OWNER).source_problem, null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM estimation_samples WHERE owner_id=? AND plan_id=?')
    .get(OWNER, missing.planId).n, 0);

  const snapshot = await capture(c);
  const rows = new Map(snapshot.rows.map((row) => [row.planId, row]));
  assert.equal(rows.get(missing.planId).source.actualMs, 2_000);
  assert.equal(rows.get(missing.planId).source.sourceAvailableAt, sourceChangedAt);
  assert.equal(rows.get(failed.planId).source.actualMs, 3_000);
  assert.ok(rows.get(badJournal.planId).rawReasons.includes('INCOMPLETE_MEASUREMENT'));
  assert.equal(rows.get(badJournal.planId).source.actualMs, null);
  assert.deepEqual(issued.get(OWNER, missing.planId), forecastBefore);
});

async function fitBundle(t, c, count, afterComplete = async () => {}, { perPlan = false } = {}) {
  const plans = [];
  for (let i = 0; i < count; i++) {
    const task = perPlan ? { ...taskV4(), reuseLevel: i % 4 } : undefined;
    const duration = perPlan ? 60_000 + (i % 4) * 90_000 : 60_000 + i * 10_001;
    const plan = await completed(c, duration, task);
    await afterComplete(plan, i);
    c.advance(1);
    plans.push(plan);
  }
  const snapshot = await capture(c);
  const decisions = annotations(snapshot);
  if (perPlan) {
    const sourceByRow = new Map(snapshot.rows.map((row) => [row.rowId, row.source]));
    const planById = new Map(plans.map((plan, index) => [plan.planId, { plan, index }]));
    const startById = new Map(snapshot.rows.map((row) => [row.planId, row.source.firstStartedAt]));
    for (const decision of decisions.rows) {
      const { plan, index } = planById.get(sourceByRow.get(decision.rowId).planId);
      delete decision.groupId;
      decision.annotation.agentTask = plan.assessment.context.agentTask;
      if (index === 0) decision.annotation.historicalAvailability = {
        availableAt: null, evidence: 'The archived evidence has no verifiable date.',
      };
      if (index === 1) decision.annotation.historicalAvailability = {
        availableAt: startById.get(plans[3].planId), evidence: 'This evidence first appeared at the fourth start.',
      };
    }
  }
  const { saved } = await save(c, decisions);
  assert.equal(saved.state, 'SAVED');
  const { datasetRevisionId } = saved;
  const source = await download(c, DATASET, { datasetRevisionId });
  assert.equal(source.file.sha256, saved.datasetDigest);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'atlm-revision-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const datasetPath = path.join(directory, 'dataset.json');
  const recipePath = path.join(directory, 'recipe.json');
  const outputDir = path.join(directory, 'fit');
  writeFileSync(datasetPath, source.bytes);
  writeFileSync(recipePath, JSON.stringify({
    schemaVersion: 1, recipeId: perPlan ? 'atlm-teacher-hybrid-v2' : 'atlm-teacher-hybrid-v1', datasetRevisionId,
    datasetDigest: source.file.sha256, selection: { mode: 'ALL_ELIGIBLE' },
    ...(perPlan
      ? { backtestUse: 'UNKNOWN', backtestUseNote: 'Synthetic full roster fixture' }
      : { holdoutUse: 'UNKNOWN', holdoutUseNote: 'Synthetic revision contract fixture' }),
  }));
  const fit = spawnSync(process.execPath, [
    'scripts/train-atlm.mjs', '--dataset', datasetPath, '--recipe', recipePath, '--out', outputDir,
  ], { cwd: SITE_ROOT, encoding: 'utf8' });
  assert.ifError(fit.error);
  assert.equal(fit.status, 0, fit.stderr);
  const bundleBytes = readFileSync(JSON.parse(fit.stdout).registrationPath);
  return { datasetRevisionId, bundleBytes, bundle: JSON.parse(bundleBytes), plans, dataset: source.value };
}

test('snapshot retries pending refresh, preserves failed rows, and remains frozen across pages', async (t) => {
  const c = setup(t);
  const zero = await completed(c, 0);
  const failed = await completed(c, 2000);
  const deleted = await completed(c, 3000);
  await ok(c, 'DeletePlan', { planId: deleted.planId }, 2);
  const unfinished = await plannedAtlm(c, crypto.randomUUID());
  const db = c.db.sqlite;
  const leaseUntil = c.now() + 60_000;
  assert.equal(db.prepare(
    "UPDATE estimation_jobs SET status='RUNNING',lease_until=?,attempts=0 WHERE owner_id=? AND plan_id=?",
  ).run(leaseUntil, OWNER, zero.planId).changes, 1);
  assert.equal(db.prepare(
    "UPDATE estimation_jobs SET status='FAILED',attempts=4,last_error='SOURCE_UNAVAILABLE' WHERE owner_id=? AND plan_id=?",
  ).run(OWNER, failed.planId).changes, 1);

  const create = snapshotArgs();
  const pending = await expectError(c, SNAPSHOT, create, 'SOURCES_PENDING');
  assert.equal(pending.details.pendingCount, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM estimation_training_snapshots').get().n, 0);
  c.advance(60_000);
  const saved = await tool(c, SNAPSHOT, create);
  assert.equal(saved.snapshotId, create.commandId);
  assert.deepEqual(saved.counts, { total: 4, eligible: 1, excluded: 3, failedSources: 1 });
  assert.equal((await tool(c, SNAPSHOT, create)).snapshotId, saved.snapshotId);
  const first = await tool(c, SNAPSHOT, snapshotRead(saved.snapshotId, 'rows', { limit: 1 }));
  assert.equal(first.rows.length, 1);
  assert.ok(first.nextCursor);
  assert.equal(Object.hasOwn(first.rows[0], 'evidence'), false);

  const fresh = await plannedAtlm(c, crypto.randomUUID());
  await ok(c, 'UpdatePlanMetadata', { planId: zero.planId, title: 'Later edit' }, 2);
  const secondSnapshot = await tool(c, SNAPSHOT, snapshotArgs());
  const listed = await tool(c, SNAPSHOT, { mode: 'read', view: 'list', limit: 1 });
  assert.ok(listed.nextCursor);
  await tool(c, SNAPSHOT, snapshotArgs());
  const rest = await tool(c, SNAPSHOT, { mode: 'read', view: 'list', cursor: listed.nextCursor });
  assert.deepEqual([...listed.rows, ...rest.rows].map((item) => item.snapshotId).sort(),
    [saved.snapshotId, secondSnapshot.snapshotId].sort());
  await expectError(c, SNAPSHOT, { mode: 'read', view: 'list', cursor: listed.nextCursor },
    'INVALID_CURSOR', OTHER);
  await expectError(c, SNAPSHOT, snapshotRead(secondSnapshot.snapshotId, 'rows', {
    cursor: first.nextCursor,
  }), 'INVALID_CURSOR');
  const tail = await tool(c, SNAPSHOT, snapshotRead(saved.snapshotId, 'rows', { cursor: first.nextCursor }));
  const rowPlanIds = [...first.rows, ...tail.rows].map((row) => row.planId);
  assert.deepEqual(rowPlanIds.sort(), [zero.planId, failed.planId, deleted.planId, unfinished.planId].sort());
  assert.equal(rowPlanIds.includes(fresh.planId), false);
  c.worker = createWorker(c.now);
  const { value: frozen } = await download(c, SNAPSHOT, { mode: 'read', snapshotId: saved.snapshotId });
  assert.equal(frozen.contract, 'atlm-training-snapshot');
  const rows = new Map(frozen.rows.map((row) => [row.planId, row]));
  assert.equal(rows.get(zero.planId).source.actualMs, 0);
  assert.equal(rows.get(zero.planId).source.scopeChanged, false);
  assert.equal(rows.get(zero.planId).source.issuedPrediction.status, 'UNAVAILABLE');
  assert.notEqual(rows.get(zero.planId).evidence.title, 'Later edit');
  assert.equal(rows.get(unfinished.planId).source.planStatus, 'PLANNED');
  assert.equal(rows.get(unfinished.planId).source.issuedPrediction, null);
  assert.equal(rows.get(unfinished.planId).source.scopeChanged, null);
  assert.ok(rows.get(deleted.planId).source.deletedAt !== null);
  const failedRow = rows.get(failed.planId);
  assert.equal(failedRow.rawEligibility, 'EXCLUDED');
  assert.deepEqual(failedRow.rawReasons, ['SOURCE_REFRESH_FAILED']);
  assert.equal(failedRow.source.actualMs, null);
  assert.equal(failedRow.source.status, 'UNAVAILABLE');
  await expectError(c, SNAPSHOT, snapshotRead(saved.snapshotId, 'summary'), 'SNAPSHOT_NOT_FOUND', OTHER);
  await expectError(c, SNAPSHOT, snapshotRead(saved.snapshotId, 'filePart', { partIndex: 0 }),
    'SNAPSHOT_NOT_FOUND', OTHER);
  await expectError(c, SNAPSHOT, { ...create, ownerId: OTHER }, 'VALIDATION_ERROR');
});

async function verifySnapshotWithLargeEvidence(t, sqliteEncoding, legacyFinishesFirst) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'snapshot-export-'));
  const databasePath = path.join(directory, 'tracker.sqlite3');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const empty = new DatabaseSync(databasePath);
  empty.exec(`PRAGMA encoding='${sqliteEncoding}'; CREATE TABLE encoding_fixture(value TEXT)`);
  empty.close();
  const c = context(undefined, { databasePath });
  t.after(() => c.close());
  assert.equal(c.db.sqlite.prepare('PRAGMA encoding').get().encoding, sqliteEncoding);
  const plan = await completed(c, 60_000);
  await completed(c, 30_000);
  const detail = '🙂я'.repeat(150_000);
  c.db.sqlite.prepare(`INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,plan_id,
    server_now_ms,actor_id,actor_type,payload_json,outcome_code,recorded_at)
    VALUES(?,?,'hash','AppendObservation',?,?,'agent','agent',?,'OK',?)`)
    .run(OWNER, crypto.randomUUID(), plan.planId, c.now(),
      '{"number":1.0,"detail":' + JSON.stringify(detail) + '}', c.now());
  const { snapshotId, capturedAt, sourceDataVersion, featureSchemaVersion } = await tool(c, SNAPSHOT, snapshotArgs());
  const header = { schemaVersion: 1, contract: 'atlm-training-snapshot',
    snapshotId, capturedAt, sourceDataVersion, featureSchemaVersion };
  const rows = c.db.sqlite.prepare(`SELECT * FROM estimation_training_snapshot_rows
    WHERE owner_id=? AND snapshot_id=? ORDER BY ordinal`).all(OWNER, snapshotId).map(row => ({
    rowId: row.row_id, planId: row.plan_id, rawEligibility: row.raw_eligibility,
    rawReasons: JSON.parse(row.raw_reasons_json), source: JSON.parse(row.source_json),
    evidence: JSON.parse(row.evidence_json),
  }));
  const chunks = [JSON.stringify(header).slice(0, -1) + ',"rows":[',
    ...rows.map((row, index) => (index ? ',' : '') + JSON.stringify(row)), ']}'];
  const legacyDownload = () => materializeAtlmRevisionFile(c.db, OWNER, {
    storageId: snapshotId, fileKind: 'SNAPSHOT', readChunk: index => chunks[index] ?? null,
  }, c.now());
  const draft = await legacyDownload();
  assert.equal(draft.state, 'MATERIALIZING');
  assert.ok(c.db.sqlite.prepare('SELECT checked_parts FROM estimation_revision_files WHERE storage_id=?')
    .get(snapshotId).checked_parts > 0);

  const maxResponseBytes = 4 * PART_BYTES + 1024;
  const prepare = c.db.prepare;
  let sourceReads = 0;
  c.db.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (!/\bFROM estimation_training_snapshot_rows\b/i.test(sql)) return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...args) => {
      const bound = bind(...args);
      for (const method of ['first', 'all']) {
        const read = bound[method].bind(bound);
        bound[method] = async () => {
          const result = await read();
          sourceReads++;
          if (Buffer.byteLength(JSON.stringify(result)) > maxResponseBytes) throw new Error('DB_REQUEST_TIMEOUT');
          return result;
        };
      }
      return bound;
    };
    return statement;
  };

  const downloads = await Promise.all([0, 1].map(() => tool(c, SNAPSHOT, snapshotRead(snapshotId, 'download'))));
  assert.ok(downloads.every(result => result.state === 'MATERIALIZING'));
  if (legacyFinishesFirst) {
    let legacy;
    const hook = beforeBatch(c, 'estimation_revision_file_parts', async () => {
      for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
        legacy = await legacyDownload();
        if (legacy.state === 'READY') return;
      }
      assert.fail('Legacy export did not finish');
    });
    const ready = await tool(c, SNAPSHOT, snapshotRead(snapshotId, 'download'));
    hook.restore();
    assert.equal(hook.calls(), 1);
    assert.equal(ready.state, 'READY');
    assert.deepEqual(ready.file, legacy.file);
    assert.equal(c.db.sqlite.prepare('SELECT count(*) AS count FROM estimation_revision_files WHERE file_kind=?')
      .get('SNAPSHOT').count, 1);
    const part = await tool(c, SNAPSHOT, snapshotRead(snapshotId, 'filePart', { partIndex: 0 }));
    assert.equal(part.fileSha256, legacy.file.sha256);
  }
  const { value, file } = await download(c, SNAPSHOT, { mode: 'read', snapshotId });
  assert.deepEqual(value, { ...header, rows });
  assert.deepEqual((await legacyDownload()).file, file);
  assert.deepEqual(c.db.sqlite.prepare('SELECT storage_id FROM estimation_revision_files WHERE file_kind=?')
    .all('SNAPSHOT').map(row => row.storage_id), [snapshotId]);
  assert.ok(sourceReads > 1);
  const completedReads = sourceReads;
  assert.deepEqual((await tool(c, SNAPSHOT, snapshotRead(snapshotId, 'download'))).file, file);
  assert.equal(sourceReads, completedReads);
}

for (const encoding of ['UTF-8', 'UTF-16le']) {
  test('snapshot downloads large ' + encoding + ' evidence independently of the legacy writer',
    t => verifySnapshotWithLargeEvidence(t, encoding, encoding === 'UTF-8'));
}

test('snapshot serves the already published legacy manifest and bytes', async (t) => {
  const c = setup(t);
  const { snapshotId, capturedAt, sourceDataVersion, featureSchemaVersion } = await tool(c, SNAPSHOT, snapshotArgs());
  const document = { schemaVersion: 1, contract: 'atlm-training-snapshot',
    snapshotId, capturedAt, sourceDataVersion, featureSchemaVersion, rows: [] };
  const text = JSON.stringify(document, null, 2);
  const legacy = await materializeAtlmRevisionFile(c.db, OWNER, {
    storageId: snapshotId, fileKind: 'SNAPSHOT', readChunk: index => index === 0 ? text : null,
  }, c.now());
  const { file, bytes } = await download(c, SNAPSHOT, { mode: 'read', snapshotId });
  assert.deepEqual(file, legacy.file);
  assert.equal(bytes.toString(), text);
});

test('snapshot checks its refresh boundary in the final batch and retains source and sample generations', async (t) => {
  const c = setup(t);
  const example = await completed(c, 1000);
  const first = await capture(c);
  const create = snapshotArgs();
  const db = c.db.sqlite;
  const hook = beforeBatch(c, 'estimation_training_snapshots', () => {
    assert.equal(db.prepare(
      "UPDATE estimation_jobs SET generation=generation+1,status='QUEUED',attempts=0,next_attempt_at=0 "
      + 'WHERE owner_id=? AND plan_id=?',
    ).run(OWNER, example.planId).changes, 1);
  });
  try {
    await expectError(c, SNAPSHOT, create, 'SOURCES_PENDING');
    assert.equal(hook.calls(), 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM estimation_training_snapshots').get().n, 1);
  } finally {
    hook.restore();
  }
  const saved = await tool(c, SNAPSHOT, create);
  const { value: next } = await download(c, SNAPSHOT, { mode: 'read', snapshotId: saved.snapshotId });
  const oldSource = first.rows[0].source;
  const source = next.rows[0].source;
  assert.equal(source.sourceDigest, oldSource.sourceDigest);
  assert.equal(source.sampleId, oldSource.sampleId);
  assert.equal(source.sampleGeneration, oldSource.sampleGeneration);
  assert.equal(source.sourceGeneration, oldSource.sourceGeneration + 1);
  assert.equal(next.sourceDataVersion, first.sourceDataVersion);
});

test('teacher saves reject forged facts, preserve true lineage and keep owner-scoped revisions', async (t) => {
  const c = setup(t);
  const changed = await completed(c, 4000);
  await ok(c, 'UpdatePlanMetadata', { planId: changed.planId, title: 'Different actual scope' }, 2);
  await plannedAtlm(c, crypto.randomUUID());
  const snapshot = await capture(c);
  const document = annotations(snapshot);
  const sourceRow = snapshot.rows.find((row) => row.planId === changed.planId);
  const decision = document.rows.find((row) => row.rowId === sourceRow.rowId);
  decision.annotation.agentTask.reuseLevel = 3;
  assert(sourceRow.rawReasons.includes('SCOPE_CHANGED'));
  assert.equal(sourceRow.source.scopeChanged, true);

  const forged = structuredClone(document);
  forged.rows[0].source = { actualMs: 42 };
  const missing = { ...document, rows: document.rows.slice(0, 1) };
  const unfinished = structuredClone(document);
  unfinished.rows[1] = teacherAnnotation(unfinished.rows[1].rowId);
  const invalidReference = structuredClone(document);
  invalidReference.rows[0].annotation.fieldEvidence.workUnits = { kind: 'PLAN', id: crypto.randomUUID() };
  for (const invalid of [forged, missing, unfinished, invalidReference]) {
    const args = await upload(c, SAVE_DATASET, { snapshotId: snapshot.snapshotId }, invalid);
    refused(await commit(c, SAVE_DATASET, args), 'INVALID_TEACHER_DATASET');
  }
  const invalidId = structuredClone(document);
  invalidId.rows[0].rowId = 'x'.repeat(120_000);
  const invalidIdArgs = await upload(c, SAVE_DATASET, { snapshotId: snapshot.snapshotId }, invalidId);
  const invalidIdResult = await commit(c, SAVE_DATASET, invalidIdArgs);
  refused(invalidIdResult, 'INVALID_TEACHER_DATASET');
  assert.equal(invalidIdResult.structuredContent.details?.rowId, undefined);
  assert.ok(JSON.stringify(invalidIdResult).length < 1024);
  assert.equal(c.db.sqlite.prepare('SELECT count(*) AS n FROM estimation_dataset_revisions').get().n, 0);

  const { saved, args } = await save(c, document);
  assert.equal(saved.state, 'SAVED');
  assert.equal(saved.datasetRevisionId, args.commandId);
  assert.deepEqual(saved.counts, { total: 2, eligible: 1, excluded: 1 });
  const replay = accepted(await commit(c, SAVE_DATASET, args));
  assert.equal(replay.datasetRevisionId, saved.datasetRevisionId);
  assert.equal(replay.datasetDigest, saved.datasetDigest);
  await expectError(c, SAVE_DATASET, {
    ...args, phase: 'prepare', file: { ...args.file, byteLength: args.file.byteLength + 1 },
  }, 'IDEMPOTENCY_KEY_REUSED');
  const child = await save(c, { ...document, parentDatasetRevisionId: saved.datasetRevisionId });
  const datasetRevisionId = saved.datasetRevisionId;
  c.worker = createWorker(c.now);
  const loaded = await tool(c, DATASET, { datasetRevisionId, view: 'summary' });
  assert.equal(loaded.datasetDigest, saved.datasetDigest);
  const page = await tool(c, DATASET, { datasetRevisionId, view: 'rows', limit: 1 });
  assert.equal(page.rows[0].rowId, sourceRow.rowId);
  const tail = await tool(c, DATASET, { datasetRevisionId, view: 'rows', cursor: page.nextCursor });
  assert.equal(tail.rows.length, 1);
  assert.equal(tail.rows[0].eligibility, 'EXCLUDED');
  const lineage = await tool(c, DATASET, { datasetRevisionId: child.saved.datasetRevisionId, view: 'summary' });
  assert.equal(lineage.parentDatasetRevisionId, datasetRevisionId);
  const { file, value } = await download(c, DATASET, { datasetRevisionId });
  assert.equal(value.contract, 'atlm-teacher-dataset');
  assert.equal(file.sha256, saved.datasetDigest);
  const validated = value.rows.find((row) => row.rowId === sourceRow.rowId);
  assert.equal(validated.source.actualMs, 4000);
  assert.deepEqual(validated.source.issuedPrediction, sourceRow.source.issuedPrediction);
  assert.deepEqual(validated.source.plannedFeatures, sourceRow.source.plannedFeatures);
  assert.equal(validated.features.reuseLevel, 3);
  assert.equal(validated.source.plannedFeatures.reuseLevel, 2);
  const carried = (await download(c, DATASET, {
    datasetRevisionId: child.saved.datasetRevisionId,
  })).value.rows.find((row) => row.rowId === sourceRow.rowId);
  assert.equal(carried.annotationOrigin.kind, 'CARRIED');
  assert.equal(carried.annotationOrigin.datasetRevisionId, datasetRevisionId);
  assert.equal(carried.annotationRecordedAt, validated.annotationRecordedAt);
  await expectError(c, DATASET, { datasetRevisionId, view: 'summary' }, 'DATASET_REVISION_NOT_FOUND', OTHER);
  await expectError(c, DATASET, { datasetRevisionId, view: 'download' }, 'DATASET_REVISION_NOT_FOUND', OTHER);
  await expectError(c, DATASET, { datasetRevisionId, view: 'filePart', partIndex: 0 },
    'DATASET_REVISION_NOT_FOUND', OTHER);
  await expectError(c, SAVE_DATASET, { ...args, phase: 'prepare' }, 'SNAPSHOT_NOT_FOUND', OTHER);
  const ownSnapshot = await tool(c, SNAPSHOT, snapshotArgs(), OTHER);
  await expectError(c, SAVE_DATASET, {
    ...args, phase: 'prepare', commandId: crypto.randomUUID(), snapshotId: ownSnapshot.snapshotId,
    parentDatasetRevisionId: datasetRevisionId,
  }, 'DATASET_REVISION_NOT_FOUND', OTHER);
  c.advance(1);
  await ok(c, 'UpdatePlanMetadata', { planId: changed.planId, title: 'Reviewed source changed again' }, 3);
  const newSnapshot = await capture(c);
  const invalidCarry = { ...document, snapshotId: newSnapshot.snapshotId, parentDatasetRevisionId: datasetRevisionId };
  const stale = await upload(c, SAVE_DATASET, {
    snapshotId: invalidCarry.snapshotId, parentDatasetRevisionId: datasetRevisionId,
  }, invalidCarry);
  refused(await commit(c, SAVE_DATASET, stale), 'LINEAGE_MISMATCH');
  const reviewed = structuredClone(invalidCarry);
  reviewed.rows[0].annotation.fieldEvidence.workUnits = 'Reviewed again for the changed source';
  const newRevision = await save(c, reviewed);
  assert.equal(newRevision.saved.parentDatasetRevisionId, datasetRevisionId);
  assert.deepEqual(c.db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('an annotation cannot be carried when both frozen sources lack a digest', async (t) => {
  const c = setup(t);
  await plannedAtlm(c);
  const snapshot = await capture(c);
  const [row] = snapshot.rows;
  assert.equal(row.source.sourceGeneration, 0);
  assert.equal(row.source.sourceDigest, null);
  const document = annotations(snapshot);
  const [decision] = document.rows;
  assert.equal(decision.eligibility, 'EXCLUDED');
  decision.annotation = teacherAnnotation(row.rowId).annotation;
  const { saved } = await save(c, document);

  const next = await capture(c);
  assert.equal(next.rows[0].planId, row.planId);
  assert.equal(next.rows[0].source.sourceGeneration, row.source.sourceGeneration);
  assert.equal(next.rows[0].source.sourceDigest, null);
  const child = { ...document, snapshotId: next.snapshotId, parentDatasetRevisionId: saved.datasetRevisionId };
  const args = await upload(c, SAVE_DATASET, {
    snapshotId: child.snapshotId, parentDatasetRevisionId: child.parentDatasetRevisionId,
  }, child);
  refused(await commit(c, SAVE_DATASET, args), 'LINEAGE_MISMATCH');

  child.rows[0].annotation.fieldEvidence.workUnits = 'Checked the plan steps in snapshot ' + next.snapshotId;
  const reviewed = await save(c, child);
  const { value } = await download(c, DATASET, { datasetRevisionId: reviewed.saved.datasetRevisionId });
  assert.deepEqual(value.rows[0].annotationOrigin, { kind: 'NEW' });
  assert.equal(value.rows[0].eligibility, 'EXCLUDED');
});

test('registration keeps the pointer unchanged and activation is a replayable CAS including ABA', async (t) => {
  const c = setup(t);
  const { datasetRevisionId, bundleBytes, plans } = await fitBundle(t, c, 2);
  const firstArgs = await upload(c, REGISTER, { datasetRevisionId }, bundleBytes);
  const secondArgs = await upload(c, REGISTER, { datasetRevisionId }, bundleBytes);
  const first = accepted(await commit(c, REGISTER, firstArgs));
  const second = accepted(await commit(c, REGISTER, secondArgs));
  assert.equal(first.state, 'REGISTERED');
  assert.equal(first.datasetRevisionId, datasetRevisionId);
  assert.equal(first.modelRevisionId, firstArgs.commandId);
  assert.equal(second.state, 'REGISTERED');
  assert.equal(second.modelVersion, first.modelVersion + 1);
  assert.equal(second.artifactDigest, first.artifactDigest);
  const { activeModelRevisionId, activationVersion, rows } = await tool(c, MODELS, { view: 'list' });
  assert.equal(activeModelRevisionId, null);
  assert.equal(activationVersion, 0);
  assert.deepEqual(rows.map((row) => row.modelRevisionId).sort(), [first.modelRevisionId, second.modelRevisionId].sort());
  assert(rows.every((row) => row.status === 'REGISTERED'));
  await expectError(c, REGISTER, { ...firstArgs, phase: 'prepare' }, 'DATASET_REVISION_NOT_FOUND', OTHER);
  for (const view of ['detail', 'download', 'filePart']) {
    await expectError(c, MODELS, { view, modelRevisionId: first.modelRevisionId,
      ...(view === 'filePart' ? { partIndex: 0 } : {}) }, 'MODEL_REVISION_NOT_FOUND', OTHER);
  }

  const activation = (model, previous, version) => ({
    modelRevisionId: model.modelRevisionId, commandId: crypto.randomUUID(),
    expectedActiveModelRevisionId: previous, expectedActivationVersion: version,
    acceptExperimental: true, reason: 'Synthetic activation acceptance',
  });
  const pendingFirst = activation(first, null, 0);
  const pendingSecond = activation(second, null, 0);
  await expectError(c, ACTIVATE, { ...activation(first, null, 0), acceptExperimental: false },
    'EXPERIMENTAL_CONFIRMATION_REQUIRED');
  await expectError(c, ACTIVATE, activation(first, null, 0), 'MODEL_REVISION_NOT_FOUND', OTHER);
  const competing = await Promise.all([rpc(c, ACTIVATE, pendingFirst), rpc(c, ACTIVATE, pendingSecond)]);
  const successIndex = competing.findIndex((result) => !result.isError);
  assert.notEqual(successIndex, -1);
  const original = accepted(competing[successIndex]);
  refused(competing[1 - successIndex], 'MODEL_ACTIVATION_CONFLICT');
  const current = [first, second][successIndex];
  const other = [second, first][successIndex];
  const replayArgs = [pendingFirst, pendingSecond][successIndex];
  assert.equal(original.activeModelRevisionId, current.modelRevisionId);
  assert.equal(original.activationVersion, 1);
  assert.equal(original.replayed, false);
  assert.equal((await tool(c, ACTIVATE, activation(other, current.modelRevisionId, 1))).activationVersion, 2);
  const retired = await tool(c, MODELS, { view: 'detail', modelRevisionId: current.modelRevisionId });
  assert.equal(retired.revision.status, 'RETIRED');
  assert.equal(retired.revision.activatedAt, original.activatedAt);
  const history = await tool(c, MODELS, { view: 'activations', limit: 1 });
  assert.equal(history.rows[0].activationVersion, 2);
  assert.equal(history.rows[0].to, other.modelRevisionId);
  assert.ok(history.nextCursor);
  assert.equal((await tool(c, ACTIVATE, activation(current, other.modelRevisionId, 2))).activationVersion, 3);
  const previous = await tool(c, MODELS, { view: 'activations', cursor: history.nextCursor });
  assert.equal(previous.activeModelRevisionId, current.modelRevisionId);
  assert.deepEqual(previous.rows.map((row) => row.activationVersion), [1]);
  await expectError(c, MODELS, { view: 'activations', cursor: history.nextCursor }, 'INVALID_CURSOR', OTHER);
  await expectError(c, ACTIVATE, activation(other, current.modelRevisionId, 1), 'MODEL_ACTIVATION_CONFLICT');
  const already = await tool(c, ACTIVATE, activation(current, current.modelRevisionId, 3));
  assert.equal(already.decision, 'ALREADY_ACTIVE');
  assert.equal(already.activationVersion, 3);

  const db = c.db.sqlite;
  const log = db.prepare('SELECT activation_version,model_revision_id FROM estimation_model_activations '
    + 'WHERE owner_id=? ORDER BY activation_version').all(OWNER);
  assert.deepEqual(log.map((row) => [row.activation_version, row.model_revision_id]), [
    [1, current.modelRevisionId], [2, other.modelRevisionId], [3, current.modelRevisionId],
  ]);
  const target = await plannedAtlm(c, crypto.randomUUID());
  await ok(c, 'StartPlan', { planId: target.planId }, 0);
  const before = accepted((await mcp(c, 'GetSavedEstimate', { planId: target.planId })).value.result);
  assert.equal(before.serverEstimation.modelRevisionId, current.modelRevisionId);
  await ok(c, 'DeletePlan', { planId: plans[0].planId }, 2);
  const invalidated = await tool(c, MODELS, { view: 'list' });
  assert.equal(invalidated.activeModelRevisionId, current.modelRevisionId);
  assert.equal(invalidated.servingModelRevisionId, null);
  assert.equal(invalidated.activationVersion, 3);
  await expectError(c, ACTIVATE, activation(current, current.modelRevisionId, 3), 'MODEL_SOURCES_CHANGED');
  const historicalReplay = await tool(c, ACTIVATE, replayArgs);
  assert.deepEqual(historicalReplay, { ...original, replayed: true });
  const receipt = accepted((await mcp(c, 'GetCommandResult', { commandId: replayArgs.commandId })).value.result);
  assert.equal(receipt.status, 'FINAL');
  const frozen = accepted((await mcp(c, 'GetSavedEstimate', { planId: target.planId })).value.result);
  assert.deepEqual(frozen.serverEstimation, before.serverEstimation);
  const repeatRegister = accepted(await commit(c, REGISTER, firstArgs));
  assert.equal(repeatRegister.modelRevisionId, first.modelRevisionId);
  assert.equal(db.prepare('SELECT count(*) AS n FROM estimation_model_activations').get().n, 3);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('registration rejects forged proof and rolls back if a held-out source changes after validation', async (t) => {
  const c = setup(t);
  const { datasetRevisionId, bundleBytes, bundle } = await fitBundle(t, c, 7);
  assert.equal(bundle.provenance.fitRowIds.length, 2);
  assert.equal(bundle.provenance.holdoutRowIds.length, 5);
  const plannedHoldout = bundle.evaluation.modes.INTERNAL_HOLDOUT_PLANNED;
  assert.equal(plannedHoldout.cases[0].medianPointMs, 65_001);
  assert.ok(Number.isFinite(plannedHoldout.paired.median.maeMs));
  const holdout = bundle.evaluation.modes.INTERNAL_HOLDOUT_ACTUAL.cases[0];
  const badRoster = structuredClone(bundle);
  badRoster.provenance.holdoutRowIds.pop();
  const badPointSelection = structuredClone(bundle);
  const earliestFitCase = bundle.evaluation.modes.ROLLING_GROUPED_ACTUAL.cases.find(row => row.trainRowCount === 0);
  badPointSelection.artifact.selection.caseIds = [earliestFitCase.planId];
  badPointSelection.artifact.selection.caseCount = 1;
  const badPrediction = structuredClone(bundle);
  badPrediction.evaluation.modes.INTERNAL_HOLDOUT_ACTUAL.cases[0].pointMs += 1;
  for (const forged of [badRoster, badPointSelection, badPrediction]) {
    const args = await upload(c, REGISTER, { datasetRevisionId }, forged);
    refused(await commit(c, REGISTER, args), 'INVALID_ARTIFACT');
  }
  const badRolling = structuredClone(bundle);
  const rolling = badRolling.evaluation.modes.ROLLING_GROUPED_ACTUAL;
  const singleSource = rolling.cases.find(row => row.trainRowCount === 1);
  assert.equal(singleSource.pointEngine, 'MEDIAN');
  singleSource.pointEngine = 'RIDGE';
  singleSource.pointMs += 1;
  singleSource.signedErrorMs = singleSource.pointMs - singleSource.actualMs;
  badRolling.evaluation.modes.ROLLING_GROUPED_ACTUAL = summarizeAtlmTeacherMode(rolling.cases);
  const rollingArgs = await upload(c, REGISTER, { datasetRevisionId }, badRolling);
  const badRollingResult = await commit(c, REGISTER, rollingArgs);
  refused(badRollingResult, 'INVALID_ARTIFACT');
  assert.equal(badRollingResult.structuredContent.details.reason, 'INVALID_ROLLING_CASES');

  const args = await upload(c, REGISTER, { datasetRevisionId }, bundleBytes);
  const hook = beforeBatch(c, 'estimation_model_revisions',
    () => ok(c, 'DeletePlan', { planId: holdout.planId }, 2));
  try {
    refused(await commit(c, REGISTER, args), 'MODEL_SOURCES_CHANGED');
    assert.equal(hook.calls(), 1);
  } finally {
    hook.restore();
  }
  const db = c.db.sqlite;
  assert.equal(db.prepare('SELECT count(*) AS n FROM estimation_model_revisions').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM estimation_model_revision_sources').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM estimation_active_revisions').get().n, 0);
  const receipt = db.prepare('SELECT outcome_code FROM command_receipts WHERE owner_id=? AND command_id=?')
    .get(OWNER, args.commandId);
  assert.notEqual(receipt?.outcome_code, 'OK');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('v2 registration keeps every verified plan and validates causal, comparable replay', async (t) => {
  const c = setup(t);
  const info = accepted((await mcp(c, 'GetTrackerInfo')).value.result);
  assert.deepEqual(info.assessments.atlm.registry.teacherRecipeIds, ['atlm-teacher-hybrid-v1', 'atlm-teacher-hybrid-v2']);
  const { datasetRevisionId, bundleBytes, bundle, plans, dataset } = await fitBundle(t, c, 9, async (plan, index) => {
    if (index === 8) await ok(c, 'UpdatePlanMetadata', { planId: plan.planId, title: 'Changed actual scope' }, 2);
  }, { perPlan: true });
  const { provenance, evaluation, artifact } = bundle;
  assert.equal(provenance.trainerVersion, 2);
  assert.equal(evaluation.protocolVersion, 2);
  assert.equal(artifact.n, plans.length);
  assert.deepEqual(provenance.fitRowIds, provenance.selectedRowIds);
  assert(dataset.rows.every((row) => row.eligibility === 'ELIGIBLE' && row.groupId === null));
  const actual = evaluation.modes.ROLLING_PLAN_ACTUAL;
  const planned = evaluation.modes.ROLLING_PLAN_PLANNED;
  const caseFor = (mode, index) => mode.cases.find((row) => row.planId === plans[index].planId);
  assert.equal(caseFor(actual, 2).trainRowCount, 0);
  assert.equal(caseFor(actual, 3).trainRowCount, 1);
  assert.equal(caseFor(actual, 4).trainRowCount, 3);
  assert.equal(caseFor(actual, 8).scoringExclusionReason, null);
  assert.equal(caseFor(planned, 8).scoringExclusionReason, 'SCOPE_CHANGED');
  assert.equal(caseFor(planned, 8).pointMs, null);
  assert.equal(caseFor(planned, 8).medianPointMs, null);
  assert.equal(Object.hasOwn(planned.summary, 'groupCount'), false);

  const missing = structuredClone(bundle);
  missing.provenance.fitRowIds.pop();
  const invalidHistory = structuredClone(bundle);
  invalidHistory.evaluation.modes.ROLLING_PLAN_PLANNED.cases[0].trainDigest = sha256('forged history');
  const invalidRecipe = structuredClone(bundle);
  invalidRecipe.provenance.recipeDigest = sha256('forged recipe');
  const inconsistentModes = structuredClone(bundle);
  const forgedPlanned = inconsistentModes.evaluation.modes.ROLLING_PLAN_PLANNED;
  caseFor(forgedPlanned, 4).fallbackReason = 'FORGED_POLICY';
  inconsistentModes.evaluation.modes.ROLLING_PLAN_PLANNED =
    summarizeAtlmTeacherMode(forgedPlanned.cases, { includeGroups: false });
  for (const [forged, reason] of [[missing, 'INVALID_SELECTED_ROSTER'],
    [invalidHistory, 'INVALID_ROLLING_REPORT'], [invalidRecipe, 'INVALID_RECIPE_DIGEST'],
    [inconsistentModes, 'INCONSISTENT_ROLLING_FEATURE_BASIS']]) {
    const args = await upload(c, REGISTER, { datasetRevisionId }, forged);
    const failure = refused(await commit(c, REGISTER, args), 'INVALID_ARTIFACT');
    assert.equal(failure.details.reason, reason);
  }

  const args = await upload(c, REGISTER, { datasetRevisionId }, bundleBytes);
  const result = accepted(await commit(c, REGISTER, args));
  assert.equal(result.state, 'REGISTERED');
  assert.equal((await tool(c, MODELS, { view: 'list' })).activeModelRevisionId, null);
  assert.deepEqual(result.evaluationSummary.map(({ kind }) => kind),
    ['ROLLING_PLAN_ACTUAL', 'ROLLING_PLAN_PLANNED', 'ISSUED_FORECASTS']);
  const detail = await tool(c, MODELS, { view: 'detail', modelRevisionId: result.modelRevisionId });
  assert.equal(detail.revision.fitCount, plans.length);
  const evidence = detail.evidence.find(({ kind }) => kind === 'ROLLING_PLAN_PLANNED');
  assert.equal(evidence.summary.excludedFromScoringCount, 1);
  assert.equal(Object.hasOwn(evidence.summary, 'groupCount'), false);
  assert.equal(evidence.paired.rowCount, planned.paired.rowIds.length);
  assert.equal(evidence.paired.median.maeMs, planned.paired.median.maeMs);
  const eligible = planned.paired.rowIds.length >= 5 && planned.paired.candidate.maeMs <= planned.paired.median.maeMs;
  assert.equal(result.activationEligibility.status, eligible ? 'ELIGIBLE' : 'REQUIRES_EXPERIMENTAL_ACK');

  const modelRevisionId = result.modelRevisionId;
  const activation = {
    modelRevisionId, expectedActiveModelRevisionId: null, expectedActivationVersion: 0,
    reason: 'Verify the v2 activation gate', commandId: crypto.randomUUID(),
  };
  if (!eligible) {
    await expectError(c, ACTIVATE, activation, 'EXPERIMENTAL_CONFIRMATION_REQUIRED');
  }
  const applied = await tool(c, ACTIVATE, { ...activation, commandId: crypto.randomUUID(), acceptExperimental: !eligible });
  assert.equal(applied.decision, eligible ? 'ELIGIBLE' : 'EXPERIMENTAL_ACCEPTED');
  assert.equal(applied.activeModelRevisionId, modelRevisionId);
  const replay = accepted(await commit(c, REGISTER, args));
  assert.equal(replay.modelRevisionId, modelRevisionId);
});
