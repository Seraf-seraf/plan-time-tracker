import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAtlm, atlmArtifactValid, predictAtlm, normalizeAgentTask } from '../worker/atlm/model.js';
import { atlmReadActiveModel, predictWithActiveModel, readAtlmServingState } from '../worker/atlm/serving.js';
import { processAtlmSampleRefresh } from '../worker/atlm/sample-refresh.js';
import { context, atlmTask, plannedAtlm, completeAtlm, command, mcp, ok, OWNER } from './fixtures/tracker-db.mjs';

const features = normalizeAgentTask(atlmTask()).features;
const revisions = ['atlm-11-r1', 'atlm-11-r2'];
const drain = c => processAtlmSampleRefresh(c.db, OWNER, c.now(), { clock: c.now });

function register(db, id, revision, artifact, sources, registeredAt) {
  db.prepare(`INSERT INTO estimation_model_revisions(owner_id,model_revision_id,model_version,legacy_revision,
    origin,method_version,feature_version,registered_at,imported_at,artifact_json,manifest_json,dataset_digest,
    provenance_json,fit_count,source_count,train_cutoff,supported)
    VALUES(?,?,11,?,'IMPORTED',?,?,?,?,?,?,?,'{}',?,?,?,1)`)
    .run(OWNER, id, revision, artifact.method.version, artifact.featureSchemaVersion, registeredAt,
      registeredAt + 1, JSON.stringify(artifact), JSON.stringify(artifact.manifest), artifact.datasetDigest,
      artifact.n, sources.length, artifact.trainCutoff);
  const insert = db.prepare(`INSERT INTO estimation_model_revision_sources(owner_id,model_revision_id,plan_id,source_generation,ordinal)
    VALUES(?,?,?,(SELECT generation FROM estimation_jobs WHERE owner_id=? AND job_key='refresh:'||?),?)`);
  for (const [ordinal, { planId }] of sources.entries()) insert.run(OWNER, id, planId, OWNER, planId, ordinal);
}

function activate(db, id, version, at, previous = null) {
  db.prepare(`INSERT INTO estimation_model_activations(owner_id,activation_version,previous_model_revision_id,
    model_revision_id,activated_at,reason,decision) VALUES(?,?,?,?,?,'Fixture activation','IMPORTED')`)
    .run(OWNER, version, previous, id, at);
  db.prepare(`INSERT INTO estimation_active_revisions VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET
    model_revision_id=excluded.model_revision_id,activation_version=excluded.activation_version`)
    .run(OWNER, id, version);
}

function estimate(c, planId) {
  return mcp(c, 'GetSavedEstimate', { planId }).then(r => r.value.result.structuredContent);
}

test('exact r2 serving preserves the frozen r1 forecast and tracks source invalidation by generation', async () => {
  const c = context();
  try {
    const db = c.db.sqlite;
    const examples = [];
    for (let i = 0; i < 12; i++) {
      const actualMs = 60_000 + i * 30_000;
      const plan = await plannedAtlm(c, crypto.randomUUID());
      await completeAtlm(c, plan, actualMs);
      examples.push({ sampleId: String(i + 1), planId: plan.planId, capturedAt: c.now() - actualMs,
        sourceAvailableAt: c.now(), features, actualMs });
      c.advance(1);
    }
    await drain(c);
    const first = await fitAtlm(examples.map(example => ({ ...example, actualMs: example.actualMs * 2 })));
    const second = await fitAtlm(examples);
    assert.equal(first.status, 'AVAILABLE');
    assert.equal(second.status, 'AVAILABLE');
    assert.equal(atlmArtifactValid(second.artifact), true);
    register(db, revisions[0], 1, first.artifact, examples, c.now() - 200);
    const registeredAt = c.now() - 100;
    register(db, revisions[1], 2, second.artifact, examples, registeredAt);
    activate(db, revisions[0], 1, c.now());

    const plan = await plannedAtlm(c, crypto.randomUUID());
    const startId = crypto.randomUUID();
    const start = await command(c, 'StartPlan', { planId: plan.planId }, 0, startId);
    assert.equal(start.status, 200, JSON.stringify(start.value));
    const receipt = db.prepare('SELECT payload_json FROM command_receipts WHERE owner_id=? AND command_id=?').get(OWNER, startId);
    assert.equal(JSON.parse(receipt.payload_json).atlmStartForecast.snapshotVersion, 5);
    const frozen = db.prepare('SELECT forecast_json FROM plan_estimation_inputs WHERE owner_id=? AND plan_id=?');
    const r1 = frozen.get(OWNER, plan.planId).forecast_json;
    assert.equal(JSON.parse(r1).modelRevisionId, revisions[0]);
    assert.equal(JSON.parse(r1).pointMs, predictAtlm(first.artifact, features).pointMs);

    c.advance(20);
    const activatedAt = c.now();
    activate(db, revisions[1], 2, activatedAt, revisions[0]);
    const serving = await atlmReadActiveModel(c.db, OWNER);
    assert.equal(serving.model_id, revisions[1]);
    assert.equal(serving.model_version, 11);
    assert.equal(serving.model_revision, 2);
    assert.equal(serving.created_at, registeredAt);
    assert.equal(serving.activated_at, activatedAt);
    assert.equal(JSON.parse(serving.artifact_json).n, 12);
    const actual = await predictWithActiveModel(c.db, OWNER, features, c.now());
    const expected = predictAtlm(second.artifact, features);
    assert.equal(actual.status, 'AVAILABLE');
    assert.equal(actual.pointMs, expected.pointMs);
    assert.deepEqual(actual.interval, expected.interval);
    assert.equal(actual.modelRevisionId, revisions[1]);
    assert.equal(actual.modelVersion, 11);
    assert.equal(actual.modelRevision, 2);
    assert.equal(db.prepare('SELECT artifact_json FROM estimation_model_revisions WHERE model_revision_id=?').get(revisions[0]).artifact_json,
      JSON.stringify(first.artifact));
    assert.throws(() => db.prepare("UPDATE estimation_model_revisions SET artifact_json='{}' WHERE model_revision_id=?")
      .run(revisions[0]), /ATLM_MODEL_IMMUTABLE/);
    assert.equal(await atlmReadActiveModel(c.db, 'another-owner'), null);

    const replay = await command(c, 'StartPlan', { planId: plan.planId }, 0, startId);
    assert.equal(replay.value.replayed, true);
    assert.deepEqual(replay.value.result, start.value.result);
    assert.equal(frozen.get(OWNER, plan.planId).forecast_json, r1);
    assert.deepEqual((await estimate(c, plan.planId)).serverEstimation, JSON.parse(r1));

    const independent = await plannedAtlm(c, crypto.randomUUID());
    assert.equal((await estimate(c, independent.planId)).serverEstimation.modelRevisionId, revisions[1]);
    await completeAtlm(c, independent);
    assert.equal((await atlmReadActiveModel(c.db, OWNER)).model_id, revisions[1]);
    await drain(c);
    assert.equal((await atlmReadActiveModel(c.db, OWNER)).model_id, revisions[1]);
    assert.equal(db.prepare('SELECT count(*) n FROM estimation_model_revisions').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM estimation_model_activations').get().n, 2);

    await ok(c, 'DeletePlan', { planId: examples[0].planId }, 2);
    assert.equal(await atlmReadActiveModel(c.db, OWNER), null);
    assert.deepEqual(await readAtlmServingState(c.db, OWNER), {
      activeModelRevisionId: revisions[1], servingModelRevisionId: null, activationVersion: 2,
      sourceStatus: 'INVALIDATED', sourceProblem: 'SOURCE_CHANGED',
    });
    assert.equal((await predictWithActiveModel(c.db, OWNER, features, c.now())).unavailableReason, 'MODEL_INVALIDATED');
    await drain(c);
    assert.equal(await atlmReadActiveModel(c.db, OWNER), null);
    assert.equal(frozen.get(OWNER, plan.planId).forecast_json, r1);
  } finally {
    c.close();
  }
});
