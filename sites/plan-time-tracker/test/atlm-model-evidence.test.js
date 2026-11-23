import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readAtlmIssuedHistory, readAtlmModelEvidenceCases, readAtlmModelRevisions,
} from '../worker/atlm/model-evidence.js';
import { processAtlmSampleRefresh } from '../worker/atlm/sample-refresh.js';
import { call, completeAtlm, context, ok, OWNER, plannedAtlm, rows } from './fixtures/tracker-db.mjs';

const SECOND_OWNER = 'other-evidence-owner';
const FIRST_REVISION = 'atlm-11-r1';
const SECOND_REVISION = 'atlm-11-r2';
const INTERVAL = { status: 'AVAILABLE', lowerMs: 0, upperMs: 2000, nominalCoverage: 0.8, engine: 'BAYESIAN_PREDICTIVE' };

function register(c, modelRevisionId, { planId = null, evaluation = null, owner = OWNER } = {}) {
  const sql = c.db.sqlite;
  sql.prepare('INSERT OR IGNORE INTO owners(owner_id,created_at) VALUES(?,?)').run(owner, c.now());
  const revision = modelRevisionId === FIRST_REVISION ? 1 : 2;
  sql.prepare(`INSERT INTO estimation_model_revisions(owner_id,model_revision_id,model_version,legacy_revision,
    origin,method_version,feature_version,registered_at,imported_at,artifact_json,manifest_json,evaluation_json,
    provenance_json,fit_count,source_count,supported)
    VALUES(?,?,11,?,'IMPORTED','agent-v5-operations','agent-task-v4',?,?,?,?,?,?,
      ?,?,?)`).run(owner, modelRevisionId, revision, c.now(), c.now(),
    JSON.stringify({ selectedEngine: 'RIDGE', intervalEngine: 'BAYESIAN_PREDICTIVE' }),
    JSON.stringify(planId ? { trainingPlanIds: [planId] } : []), evaluation ? JSON.stringify(evaluation) : null,
    JSON.stringify({ parentModelId: 'atlm-11', legacyStatus: 'REJECTED', legacyReason: 'INSUFFICIENT_INCUMBENT_CASES' }),
    planId ? 1 : 0, planId ? 1 : 0, planId ? 1 : 0);
  if (planId) {
    sql.prepare(`INSERT INTO estimation_model_revision_sources(owner_id,model_revision_id,plan_id,source_generation,ordinal)
      SELECT owner_id,?,plan_id,generation,0 FROM estimation_jobs WHERE owner_id=? AND plan_id=?`).run(modelRevisionId, owner, planId);
  }
}

function assign(c, id, version, previous = null) {
  const sql = c.db.sqlite;
  sql.prepare(`INSERT INTO estimation_model_activations(owner_id,activation_version,previous_model_revision_id,
    model_revision_id,activated_at,reason,decision) VALUES(?,?,?,?,?,'imported fixture','IMPORTED')`)
    .run(OWNER, version, previous, id, c.now());
  sql.prepare(`INSERT INTO estimation_active_revisions VALUES(?,?,?) ON CONFLICT(owner_id)
    DO UPDATE SET model_revision_id=excluded.model_revision_id,activation_version=excluded.activation_version`)
    .run(OWNER, id, version);
}

function issued(modelRevisionId, pointMs, interval = INTERVAL) {
  return { status: 'AVAILABLE', modelRevisionId, pointMs, interval, method: { id: 'atlm', version: 'agent-v5-operations' } };
}

async function completed(c, forecast, actualMs = 1000, scopeKnown = true) {
  const plan = await plannedAtlm(c, crypto.randomUUID());
  await completeAtlm(c, plan, actualMs);
  const start = c.db.sqlite.prepare('SELECT first_started_at FROM plans WHERE owner_id=? AND plan_id=?')
    .get(OWNER, plan.planId).first_started_at;
  // Seed legacy issued formats before the first refresh writes the immutable observation.
  c.db.sqlite.prepare(`UPDATE plan_estimation_inputs SET forecast_json=?,
    requirements_json=CASE WHEN ? THEN requirements_json ELSE '{}' END WHERE owner_id=? AND plan_id=?`)
    .run(forecast === null ? null : JSON.stringify({ calculatedAt: start, ...forecast }), scopeKnown ? 1 : 0, OWNER, plan.planId);
  c.advance(1);
  return plan.planId;
}

function drain(c) {
  return processAtlmSampleRefresh(c.db, OWNER, c.now(), { clock: c.now });
}

function list(c, args = {}) {
  return readAtlmModelRevisions(c.db, OWNER, { view: 'list', ...args }, c.now());
}

function detail(c, modelRevisionId) {
  return readAtlmModelRevisions(c.db, OWNER, { view: 'detail', modelRevisionId }, c.now());
}

function evidencePage(c, id, source, evidenceId, args = {}) {
  return readAtlmModelEvidenceCases(c.db, OWNER, id, { source, evidenceId, ...args }, c.now());
}

test('revision evidence uses exact forecast identity and freezes the sample versions for cases and summary', async () => {
  const c = context();
  try {
    c.db.sqlite.exec('DROP TRIGGER atlm_input_no_update');
    const trainingPlan = await completed(c, null);
    const actual = await completed(c, issued(SECOND_REVISION, 0), 0);
    const inferred = await completed(c, { ...issued(null, 1500), modelId: 'atlm-11', modelRevision: 2 }, 1000);
    const excluded = await completed(c, issued(SECOND_REVISION, 900), 1000, false);
    await completed(c, issued(FIRST_REVISION, 1400));
    await drain(c);
    register(c, FIRST_REVISION);
    register(c, SECOND_REVISION, { planId: trainingPlan, evaluation: {
      protocol: 'Grouped rolling-origin', unit: 'minutes', all: { cases: 1, groups: 1, revisedMAE: 1, own: 1 },
      cases: [{ planId: inferred, actualMs: 1000, revised: { pointMs: 61000 } }],
    } });
    register(c, SECOND_REVISION, { owner: SECOND_OWNER });

    const stored = await detail(c, SECOND_REVISION);
    const issuedReport = stored.evidence.find(item => item.source === 'issued');
    const evaluation = stored.evidence.find(item => item.source === 'evaluation');
    assert.equal(issuedReport.summary.rowCount, 3);
    assert.equal(issuedReport.summary.metrics.caseCount, 2);
    assert.equal(issuedReport.summary.metrics.pointCaseCount, 2);
    assert.equal(issuedReport.summary.metrics.maeMs, 250);
    assert.equal(issuedReport.summary.metrics.coverageDenominator, 2);
    assert.equal(issuedReport.summary.metrics.nominalCoverage, 0.8);
    assert.equal(evaluation.kind, 'ROLLING_GROUPED_ACTUAL');
    assert.equal(evaluation.summary.metrics.maeMs, 60000);
    assert.equal(evaluation.summary.metrics.coverageDenominator, 0);
    assert.equal(JSON.stringify(stored).includes('caseIds'), false);
    assert.deepEqual(stored.revision.historicalDecision, { status: 'REJECTED', reason: 'INSUFFICIENT_INCUMBENT_CASES' });

    const before = rows(c);
    const first = await evidencePage(c, SECOND_REVISION, 'issued', issuedReport.evidenceId, { limit: 1 });
    assert.equal(first.cases[0].planId, excluded);
    assert.equal(first.cases[0].scoringExclusionReason, 'SCOPE_UNKNOWN');
    assert.equal(first.cases[0].signedErrorMs, null);
    const evaluatedCase = (await evidencePage(c, SECOND_REVISION, 'evaluation', evaluation.evidenceId)).cases[0];
    assert.equal(evaluatedCase.signedErrorMs, 60000);
    assert.equal(evaluatedCase.interval.status, 'UNAVAILABLE');
    assert.equal(evaluatedCase.finishedAt, null);
    assert.equal(evaluatedCase.title, inferred);
    assert.deepEqual(rows(c), before);

    await assert.rejects(() => readAtlmModelEvidenceCases(c.db, SECOND_OWNER, SECOND_REVISION,
      { source: 'issued', evidenceId: issuedReport.evidenceId }, c.now()), { code: 'INVALID_CURSOR' });
    await assert.rejects(() => evidencePage(c, FIRST_REVISION, 'issued', issuedReport.evidenceId), { code: 'INVALID_CURSOR' });
    const late = await completed(c, issued(SECOND_REVISION, 700), 1000);
    await ok(c, 'UpdatePlanMetadata', { planId: inferred, title: 'Renamed after evaluation' }, 2);
    assert.deepEqual((await evidencePage(c, SECOND_REVISION, 'evaluation', evaluation.evidenceId)).cases,
      [evaluatedCase]);
    await ok(c, 'DeletePlan', { planId: inferred }, 3);
    await drain(c);

    const next = await evidencePage(c, SECOND_REVISION, 'issued', issuedReport.evidenceId, { limit: 1, cursor: first.nextCursor });
    assert.equal(next.cases[0].planId, inferred);
    assert.equal(next.cases[0].actualMs, 1000);
    assert.equal(next.cases[0].signedErrorMs, 500);
    const last = await evidencePage(c, SECOND_REVISION, 'issued', issuedReport.evidenceId, { limit: 1, cursor: next.nextCursor });
    assert.equal(last.cases[0].planId, actual);
    assert.equal(last.cases[0].pointMs, 0);
    assert.equal(last.cases[0].actualMs, 0);
    assert.equal(last.nextCursor, null);
    assert.deepEqual(first.summary, last.summary);
    const fresh = (await detail(c, SECOND_REVISION)).evidence[0];
    assert.notEqual(fresh.evidenceId, issuedReport.evidenceId);
    assert.equal(fresh.summary.rowCount, 4);
    assert.equal(fresh.summary.metrics.caseCount, 2);
    assert.ok((await evidencePage(c, SECOND_REVISION, 'issued', fresh.evidenceId)).cases.some(row => row.planId === late));
  } finally { c.close(); }
});

test('issued history uses inclusive local days and preserves unavailable and unassigned forecasts', async () => {
  const c = context();
  try {
    c.db.sqlite.exec('DROP TRIGGER atlm_input_no_update');
    const midnight = Date.parse('2027-02-01T18:00:00Z');
    c.advance(midnight - c.now() - 101);
    await completed(c, issued(SECOND_REVISION, 10), 100);
    const median = await completed(c, { status: 'AVAILABLE', modelId: null, pointMs: 1000,
      method: { id: 'historical-median', version: '1' } }, 0);
    const unresolved = await completed(c, { ...issued(null, 2000), modelVersion: 11 });
    const unavailable = await completed(c, { status: 'UNAVAILABLE', unavailableReason: 'MODEL_INVALIDATED' });
    const absent = await completed(c, null);
    await drain(c);
    register(c, FIRST_REVISION);
    register(c, SECOND_REVISION);
    const args = { from: '2027-02-02', to: '2027-02-02', timeZone: 'Asia/Omsk', limit: 2 };
    const get = ({ cursor } = {}) => readAtlmIssuedHistory(c.db, OWNER, { ...args, cursor }, c.now());
    const first = await get();
    assert.deepEqual(first.cases.map(row => row.planId), [absent, unavailable]);
    assert.deepEqual(first.cases.map(row => row.pointUnavailableReason), ['FORECAST_NOT_RECORDED', 'MODEL_INVALIDATED']);
    assert.equal(first.summary.rowCount, 4);
    assert.equal(first.summary.metrics.pointCaseCount, 2);
    assert.equal(first.summary.metrics.coverageDenominator, 1);
    assert.equal(first.summary.metrics.maeMs, 1000);
    assert.equal(first.summary.metrics.wapePercent, 200);
    await completed(c, issued(SECOND_REVISION, 700));
    await drain(c);
    const second = await get({ cursor: first.nextCursor });
    assert.deepEqual(second.cases.map(row => row.planId), [unresolved, median]);
    assert.ok(second.cases.every(row => row.modelRevisionId === null));
    assert.equal(second.cases[1].method, 'historical-median');
    assert.deepEqual(second.summary, first.summary);
    assert.equal(second.nextCursor, null);
    const response = await call(c, '/api/tracker/model-revisions?' + new URLSearchParams({ view: 'issued-history',
      from: args.from, to: args.to, timeZone: args.timeZone }));
    assert.equal(response.status, 200);
    assert.equal(response.value.summary.rowCount, 5);
    await assert.rejects(() => readAtlmIssuedHistory(c.db, OWNER,
      { ...args, timeZone: 'UTC', cursor: first.nextCursor }, c.now()), { code: 'INVALID_CURSOR' });
  } finally { c.close(); }
});

test('issued points with absent or late timestamps stay visible outside accuracy metrics', async () => {
  const c = context();
  try {
    c.db.sqlite.exec('DROP TRIGGER atlm_input_no_update');
    await completed(c, { ...issued(SECOND_REVISION, 500), calculatedAt: null });
    await completed(c, { ...issued(SECOND_REVISION, 500), calculatedAt: c.now() + 60_000 });
    await completed(c, issued(SECOND_REVISION, 1200));
    await drain(c);
    register(c, SECOND_REVISION);
    const report = (await detail(c, SECOND_REVISION)).evidence[0];
    const page = await evidencePage(c, SECOND_REVISION, 'issued', report.evidenceId);
    assert.equal(report.summary.forecastAvailability.numerator, 3);
    assert.equal(report.summary.metrics.pointCaseCount, 1);
    assert.equal(report.summary.metrics.maeMs, 200);
    const excluded = page.cases.filter(row => row.scoringExclusionReason === 'ISSUED_TIME_UNVERIFIED');
    assert.equal(excluded.length, 2);
    assert.ok(excluded.every(row => row.pointMs === 500 && row.signedErrorMs === null));
  } finally { c.close(); }
});

test('registry pages freeze membership and report fresh, changed, pending and failed sources separately', async () => {
  const c = context();
  try {
    c.db.sqlite.exec('DROP TRIGGER atlm_input_no_update');
    const source = await completed(c, null);
    await completed(c, null);
    await drain(c);
    register(c, FIRST_REVISION, { planId: source });
    c.advance(1);
    register(c, SECOND_REVISION, { planId: source });
    const pending = await plannedAtlm(c, crypto.randomUUID());
    const failed = await plannedAtlm(c, crypto.randomUUID());
    assign(c, SECOND_REVISION, 1);
    const initial = await list(c, { limit: 1 });
    assert.equal(initial.rows[0].modelRevisionId, SECOND_REVISION);
    assert.equal(initial.activeRevision.pointEngine, 'RIDGE');
    assert.equal(initial.dataSummary.changedSourceCount, 0);
    assert.equal(initial.dataSummary.newEligibleCount, 1);
    await completeAtlm(c, pending);
    await completeAtlm(c, failed);
    c.db.sqlite.prepare("UPDATE estimation_jobs SET status='FAILED',attempts=4 WHERE plan_id=?").run(failed.planId);
    await ok(c, 'DeletePlan', { planId: source }, 2);
    c.advance(1);
    register(c, 'atlm-11-r3');
    const second = await list(c, { limit: 1, cursor: initial.nextCursor });
    assert.equal(second.rows[0].modelRevisionId, FIRST_REVISION);
    assert.equal(second.nextCursor, null);
    assert.equal(second.activeModelRevisionId, SECOND_REVISION);
    assert.equal(second.servingModelRevisionId, null);
    assert.equal(second.dataSummary.changedSourceCount, 1);
    assert.equal(second.dataSummary.newEligibleCount, 1);
    assert.equal(second.dataSummary.pendingRefreshCount, 2);
    assert.equal(second.dataSummary.failedRefreshCount, 1);
    assert.equal(c.db.sqlite.prepare('SELECT status FROM estimation_jobs WHERE plan_id=?').get(pending.planId).status, 'QUEUED');
    const newest = await list(c, { limit: 1 });
    assert.equal(newest.rows[0].modelRevisionId, 'atlm-11-r3');
    await assert.rejects(() => readAtlmModelRevisions(c.db, SECOND_OWNER,
      { view: 'list', cursor: initial.nextCursor }, c.now()), { code: 'INVALID_CURSOR' });
  } finally { c.close(); }
});
