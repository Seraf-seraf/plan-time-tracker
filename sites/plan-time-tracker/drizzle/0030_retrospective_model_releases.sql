CREATE TABLE IF NOT EXISTS estimation_retrospective_builds (
 owner_id TEXT NOT NULL, model_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 created_at INTEGER NOT NULL, eligibility_status TEXT NOT NULL, reason TEXT,
 artifact_json TEXT NOT NULL CHECK(json_valid(artifact_json)),
 manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
 evaluation_json TEXT NOT NULL CHECK(json_valid(evaluation_json)),
 PRIMARY KEY(owner_id,model_id,revision),
 FOREIGN KEY(owner_id,model_id) REFERENCES estimation_models(owner_id,model_id)
);
CREATE TABLE IF NOT EXISTS estimation_revision_releases (
 owner_id TEXT NOT NULL, model_id TEXT NOT NULL, revision INTEGER NOT NULL, activated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,model_id),
 FOREIGN KEY(owner_id,model_id,revision) REFERENCES estimation_retrospective_builds(owner_id,model_id,revision)
);
CREATE TABLE IF NOT EXISTS estimation_revision_sources (
 owner_id TEXT NOT NULL, model_id TEXT NOT NULL, revision INTEGER NOT NULL, plan_id TEXT NOT NULL,
 source_generation INTEGER NOT NULL,
 PRIMARY KEY(owner_id,model_id,revision,plan_id),
 FOREIGN KEY(owner_id,model_id,revision) REFERENCES estimation_retrospective_builds(owner_id,model_id,revision),
 FOREIGN KEY(owner_id,plan_id) REFERENCES plans(owner_id,plan_id)
);
CREATE TRIGGER IF NOT EXISTS atlm_released_build_immutable
 BEFORE UPDATE ON estimation_retrospective_builds
 WHEN EXISTS(SELECT 1 FROM estimation_revision_releases r WHERE r.owner_id=OLD.owner_id
   AND r.model_id=OLD.model_id AND r.revision=OLD.revision)
 BEGIN SELECT RAISE(ABORT,'ATLM_MODEL_IMMUTABLE'); END;

-- A revision has a distinct public ID. The owner's existing FK still names its parent.
-- Native manifests reference the live sample journal. Revision manifests reference frozen examples.
DROP VIEW IF EXISTS estimation_serving_models;
CREATE VIEW estimation_serving_models AS
 SELECT m.owner_id,m.model_id AS pointer_id,m.model_id,m.model_version,NULL AS model_revision,
   m.status,m.method_version,m.feature_version,m.artifact_json,m.manifest_json,m.metrics_json,
   m.sample_count,m.train_cutoff,m.created_at,m.activated_at,
   NOT EXISTS(SELECT 1 FROM estimation_revision_releases r
     WHERE r.owner_id=m.owner_id AND r.model_id=m.model_id) AS preferred
 FROM estimation_models m
 UNION ALL
 SELECT b.owner_id,b.model_id,b.model_id||'-r'||b.revision,m.model_version,b.revision,
   CASE WHEN o.data_reset_at>=b.created_at OR
     (SELECT count(*) FROM estimation_revision_sources s WHERE s.owner_id=b.owner_id
       AND s.model_id=b.model_id AND s.revision=b.revision)<>json_extract(b.artifact_json,'$.n') OR
     EXISTS(SELECT 1 FROM estimation_revision_sources s LEFT JOIN estimation_jobs j
       ON j.owner_id=s.owner_id AND j.job_key='refresh:'||s.plan_id
       WHERE s.owner_id=b.owner_id AND s.model_id=b.model_id AND s.revision=b.revision
         AND s.source_generation<>coalesce(j.generation,0)) THEN 'INVALIDATED'
     WHEN o.active_model_id=b.model_id THEN 'ACTIVE' ELSE 'RETIRED' END,
   json_extract(b.artifact_json,'$.method.version'),json_extract(b.artifact_json,'$.featureSchemaVersion'),
   b.artifact_json,json_extract(b.artifact_json,'$.manifest'),NULL,
   json_extract(b.artifact_json,'$.n'),json_extract(b.artifact_json,'$.trainCutoff'),b.created_at,r.activated_at,1
 FROM estimation_revision_releases r JOIN estimation_retrospective_builds b USING(owner_id,model_id,revision)
 JOIN estimation_models m USING(owner_id,model_id) JOIN estimation_owner_state o USING(owner_id);
