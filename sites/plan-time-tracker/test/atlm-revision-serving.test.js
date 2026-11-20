import test from "node:test";
import assert from "node:assert/strict";
import { fitAtlm, atlmArtifactValid, predictAtlm, normalizeAgentTask } from "../worker/atlm/model.js";
import { atlmReadActiveModel, predictWithActiveModel, atlmTrainingJson } from "../worker/atlm/training.js";
import { context, atlmTask, assessForStart, ok, OWNER } from "./fixtures/tracker-db.mjs";

test("revision 2 serves its exact artifact while preserving immutable ATLM-11 revision 1", async () => {
  const c = context();
  try {
    const db = c.db.sqlite;
    const features = normalizeAgentTask(atlmTask()).features;
    db.prepare("INSERT INTO owners(owner_id,created_at) VALUES(?,?)").run(OWNER, c.now());
    const examples = Array.from({ length: 12 }, (_, i) => ({
      sampleId: String(i + 1), planId: crypto.randomUUID(),
      capturedAt: 1000 + i, sourceAvailableAt: 1000 + i,
      features, actualMs: 60_000 + i * 30_000,
    }));
    const fitted = await fitAtlm(examples);
    assert.equal(fitted.status, "AVAILABLE");
    const artifact = fitted.artifact;
    assert.equal(atlmArtifactValid(artifact), true);

    const priorArtifact = JSON.stringify({ preserved: "revision-1" });
    db.prepare(`INSERT INTO estimation_models(owner_id,model_id,model_version,status,artifact_json,manifest_json,
      dataset_digest,train_cutoff,sample_count,created_at,method_version,feature_version)
      VALUES(?,'atlm-11',11,'REJECTED',?,'[]','old',0,37,0,'agent-v5-operations','agent-task-v4')`)
      .run(OWNER, priorArtifact);
    const retrospective = db.prepare("INSERT INTO estimation_retrospective_builds VALUES(?, 'atlm-11',2,?,'REJECTED','INSUFFICIENT_INCUMBENT_CASES',?,?,?)");
    retrospective.run(OWNER, c.now(), JSON.stringify(artifact), JSON.stringify(artifact.manifest), "{}");
    for (const example of examples) {
      await ok(c, "CreatePlan", { planId: example.planId, title: "Training source", planText: "## Этап 1. Работа\nПроверка",
        planCreatedAt: { precision: "dateOnly", on: "2027-01-01", timeZone: "UTC" } });
      await assessForStart(c, example.planId);
      await ok(c, "StartPlan", { planId: example.planId }, 0);
      db.prepare("UPDATE plans SET status='COMPLETED', finished_at=? WHERE owner_id=? AND plan_id=?").run(c.now(), OWNER, example.planId);
      db.prepare(`INSERT INTO estimation_revision_sources VALUES(?,'atlm-11',2,?,
        COALESCE((SELECT generation FROM estimation_jobs WHERE owner_id=? AND job_key='refresh:'||?),0))`)
        .run(OWNER, example.planId, OWNER, example.planId);
    }
    db.prepare("INSERT INTO estimation_revision_releases VALUES(?,'atlm-11',2,?)").run(OWNER, c.now());
    db.prepare("UPDATE estimation_owner_state SET active_model_id='atlm-11' WHERE owner_id=?").run(OWNER);

    const served = db.prepare("SELECT * FROM estimation_serving_models WHERE owner_id=? AND preferred=1").get(OWNER);
    assert.equal(served.model_id, "atlm-11-r2");
    assert.equal(served.model_version, 11);
    assert.equal(served.model_revision, 2);
    assert.equal(atlmTrainingJson(served.artifact_json).n, 12);
    const actual = await predictWithActiveModel(c.db, OWNER, features, c.now());
    const expected = predictAtlm(artifact, features);
    assert.equal(actual.status, "AVAILABLE");
    assert.equal(actual.pointMs, expected.pointMs);
    assert.equal(actual.modelId, "atlm-11-r2");
    assert.equal(actual.modelVersion, 11);
    assert.equal(actual.modelRevision, 2);
    assert.equal(db.prepare("SELECT artifact_json FROM estimation_models WHERE model_id='atlm-11'").get().artifact_json, priorArtifact);
    assert.equal(await atlmReadActiveModel(c.db, "another-owner"), null);
    db.prepare("UPDATE plans SET deleted_at=? WHERE owner_id=? AND plan_id=?").run(c.now(), OWNER, examples[0].planId);
    assert.equal(await atlmReadActiveModel(c.db, OWNER), null);
  } finally { c.close(); }
});
