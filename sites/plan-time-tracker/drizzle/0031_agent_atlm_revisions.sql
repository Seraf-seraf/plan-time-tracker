CREATE TABLE IF NOT EXISTS estimation_retrospective_dataset_rows (
 owner_id TEXT NOT NULL, model_id TEXT NOT NULL, revision INTEGER NOT NULL,
 plan_id TEXT NOT NULL, ordinal INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 PRIMARY KEY(owner_id,model_id,revision,plan_id), UNIQUE(owner_id,model_id,revision,ordinal),
 FOREIGN KEY(owner_id,model_id,revision) REFERENCES estimation_retrospective_builds(owner_id,model_id,revision),
 FOREIGN KEY(owner_id,plan_id) REFERENCES plans(owner_id,plan_id)
);
CREATE TABLE IF NOT EXISTS estimation_reconstructed_dataset_rows (
 owner_id TEXT NOT NULL, model_id TEXT NOT NULL, plan_id TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)), PRIMARY KEY(owner_id,model_id,plan_id),
 FOREIGN KEY(owner_id,model_id) REFERENCES estimation_models(owner_id,model_id),
 FOREIGN KEY(owner_id,plan_id) REFERENCES plans(owner_id,plan_id)
);

CREATE TABLE estimation_training_snapshots (
 registry_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id TEXT NOT NULL REFERENCES owners(owner_id), snapshot_id TEXT NOT NULL,
 captured_at INTEGER NOT NULL, source_data_version INTEGER NOT NULL CHECK(source_data_version>=0),
 feature_version TEXT NOT NULL, row_count INTEGER NOT NULL CHECK(row_count>=0),
 eligible_count INTEGER NOT NULL CHECK(eligible_count BETWEEN 0 AND row_count),
 failed_count INTEGER NOT NULL CHECK(failed_count BETWEEN 0 AND row_count-eligible_count),
 UNIQUE(owner_id,snapshot_id)
);
CREATE TABLE estimation_training_snapshot_rows (
 owner_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, row_id TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0), plan_id TEXT NOT NULL,
 source_generation INTEGER NOT NULL CHECK(source_generation>=0),
 sample_sequence INTEGER, assessment_sequence INTEGER, forecast_sequence INTEGER,
 raw_eligibility TEXT NOT NULL CHECK(raw_eligibility IN ('ELIGIBLE','EXCLUDED')),
 raw_reasons_json TEXT NOT NULL CHECK(json_valid(raw_reasons_json) AND json_type(raw_reasons_json)='array'),
 source_json TEXT NOT NULL CHECK(json_valid(source_json) AND json_type(source_json)='object'),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='object'),
 PRIMARY KEY(owner_id,snapshot_id,row_id),
 UNIQUE(owner_id,snapshot_id,ordinal), UNIQUE(owner_id,snapshot_id,plan_id),
 UNIQUE(owner_id,snapshot_id,row_id,plan_id),
 FOREIGN KEY(owner_id,snapshot_id) REFERENCES estimation_training_snapshots(owner_id,snapshot_id),
 FOREIGN KEY(owner_id,plan_id) REFERENCES plans(owner_id,plan_id),
 FOREIGN KEY(owner_id,sample_sequence) REFERENCES estimation_samples(owner_id,sequence),
 FOREIGN KEY(owner_id,plan_id,assessment_sequence) REFERENCES assessment_revisions(owner_id,plan_id,sequence),
 FOREIGN KEY(owner_id,plan_id,forecast_sequence) REFERENCES assessment_revisions(owner_id,plan_id,sequence)
);

CREATE TABLE estimation_dataset_revisions (
 registry_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id TEXT NOT NULL REFERENCES owners(owner_id), dataset_revision_id TEXT NOT NULL,
 snapshot_id TEXT, parent_dataset_revision_id TEXT,
 origin TEXT NOT NULL CHECK(origin IN ('NATIVE','IMPORTED')), schema_version INTEGER NOT NULL CHECK(schema_version=1),
 feature_version TEXT NOT NULL, created_at INTEGER, imported_at INTEGER, dataset_digest TEXT,
 row_count INTEGER NOT NULL CHECK(row_count>=0), eligible_count INTEGER NOT NULL CHECK(eligible_count BETWEEN 0 AND row_count),
 provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
 UNIQUE(owner_id,dataset_revision_id), UNIQUE(owner_id,dataset_revision_id,snapshot_id,origin),
 UNIQUE(owner_id,dataset_revision_id,origin),
 FOREIGN KEY(owner_id,snapshot_id) REFERENCES estimation_training_snapshots(owner_id,snapshot_id),
 FOREIGN KEY(owner_id,parent_dataset_revision_id) REFERENCES estimation_dataset_revisions(owner_id,dataset_revision_id),
 CHECK((origin='NATIVE' AND snapshot_id IS NOT NULL AND created_at IS NOT NULL AND imported_at IS NULL AND dataset_digest IS NOT NULL)
    OR (origin='IMPORTED' AND snapshot_id IS NULL AND imported_at IS NOT NULL))
);
CREATE INDEX estimation_datasets_by_snapshot ON estimation_dataset_revisions(owner_id,snapshot_id,registry_sequence);
CREATE TABLE estimation_dataset_revision_rows (
 owner_id TEXT NOT NULL, dataset_revision_id TEXT NOT NULL, row_id TEXT NOT NULL,
 snapshot_id TEXT, snapshot_row_id TEXT, ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 plan_id TEXT NOT NULL, group_id TEXT, origin TEXT NOT NULL CHECK(origin IN ('NATIVE','IMPORTED')),
 eligibility TEXT NOT NULL CHECK(eligibility IN ('ELIGIBLE','EXCLUDED')),
 reasons_json TEXT NOT NULL CHECK(json_valid(reasons_json) AND json_type(reasons_json)='array'),
 annotation_json TEXT CHECK(annotation_json IS NULL OR json_valid(annotation_json)),
 features_json TEXT CHECK(features_json IS NULL OR json_valid(features_json)),
 source_json TEXT NOT NULL CHECK(json_valid(source_json)),
 record_json TEXT CHECK(record_json IS NULL OR json_valid(record_json)),
 PRIMARY KEY(owner_id,dataset_revision_id,row_id), UNIQUE(owner_id,dataset_revision_id,ordinal),
 UNIQUE(owner_id,dataset_revision_id,plan_id),
 FOREIGN KEY(owner_id,plan_id) REFERENCES plans(owner_id,plan_id),
 FOREIGN KEY(owner_id,dataset_revision_id,origin) REFERENCES estimation_dataset_revisions(owner_id,dataset_revision_id,origin),
 FOREIGN KEY(owner_id,dataset_revision_id,snapshot_id,origin) REFERENCES estimation_dataset_revisions(owner_id,dataset_revision_id,snapshot_id,origin),
 FOREIGN KEY(owner_id,snapshot_id,snapshot_row_id,plan_id) REFERENCES estimation_training_snapshot_rows(owner_id,snapshot_id,row_id,plan_id),
 CHECK((origin='NATIVE' AND snapshot_id IS NOT NULL AND snapshot_row_id=row_id AND snapshot_row_id IS NOT NULL AND record_json IS NULL)
    OR (origin='IMPORTED' AND snapshot_id IS NULL AND snapshot_row_id IS NULL AND record_json IS NOT NULL)),
 CHECK(origin='IMPORTED' OR (eligibility='ELIGIBLE' AND group_id IS NOT NULL AND annotation_json IS NOT NULL AND features_json IS NOT NULL)
    OR (eligibility='EXCLUDED' AND features_json IS NULL AND json_array_length(reasons_json)>0))
);

CREATE TABLE estimation_model_revisions (
 registry_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id TEXT NOT NULL REFERENCES owners(owner_id), model_revision_id TEXT NOT NULL,
 dataset_revision_id TEXT, model_version INTEGER, legacy_revision INTEGER,
 origin TEXT NOT NULL CHECK(origin IN ('NATIVE','IMPORTED')),
 method_version TEXT NOT NULL, feature_version TEXT NOT NULL,
 registered_at INTEGER, trained_at INTEGER, imported_at INTEGER, legacy_activated_at INTEGER,
 artifact_json TEXT CHECK(artifact_json IS NULL OR json_valid(artifact_json)),
 artifact_digest TEXT, manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
 dataset_digest TEXT, evaluation_json TEXT CHECK(evaluation_json IS NULL OR json_valid(evaluation_json)),
 provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
 fit_count INTEGER NOT NULL CHECK(fit_count>=0), source_count INTEGER NOT NULL CHECK(source_count>=0),
 train_cutoff INTEGER, supported INTEGER NOT NULL CHECK(supported IN (0,1)),
 archived_reason TEXT, invalidated_reason TEXT,
 UNIQUE(owner_id,model_revision_id),
 UNIQUE(owner_id,model_revision_id,dataset_revision_id),
 FOREIGN KEY(owner_id,dataset_revision_id) REFERENCES estimation_dataset_revisions(owner_id,dataset_revision_id),
 CHECK(origin='IMPORTED' OR (dataset_revision_id IS NOT NULL AND model_version IS NOT NULL
    AND model_version>0 AND registered_at IS NOT NULL AND artifact_digest IS NOT NULL AND dataset_digest IS NOT NULL
    AND artifact_json IS NOT NULL AND evaluation_json IS NOT NULL AND source_count>=fit_count AND fit_count>0)),
 CHECK(supported=0 OR (artifact_json IS NOT NULL AND source_count>=fit_count AND fit_count>0))
);
CREATE INDEX estimation_models_by_owner ON estimation_model_revisions(owner_id,registry_sequence);
CREATE UNIQUE INDEX estimation_native_model_version ON estimation_model_revisions(owner_id,model_version) WHERE origin='NATIVE';
CREATE TABLE estimation_model_revision_sources (
 owner_id TEXT NOT NULL, model_revision_id TEXT NOT NULL, plan_id TEXT NOT NULL,
 source_generation INTEGER NOT NULL CHECK(source_generation>=0), ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 dataset_revision_id TEXT, row_id TEXT,
 PRIMARY KEY(owner_id,model_revision_id,plan_id), UNIQUE(owner_id,model_revision_id,ordinal),
 FOREIGN KEY(owner_id,model_revision_id) REFERENCES estimation_model_revisions(owner_id,model_revision_id),
 FOREIGN KEY(owner_id,model_revision_id,dataset_revision_id) REFERENCES estimation_model_revisions(owner_id,model_revision_id,dataset_revision_id),
 FOREIGN KEY(owner_id,dataset_revision_id,row_id) REFERENCES estimation_dataset_revision_rows(owner_id,dataset_revision_id,row_id),
 FOREIGN KEY(owner_id,plan_id) REFERENCES plans(owner_id,plan_id),
 CHECK(row_id IS NULL OR dataset_revision_id IS NOT NULL)
);
CREATE INDEX estimation_model_sources_by_plan ON estimation_model_revision_sources(owner_id,plan_id);
CREATE TABLE estimation_active_revisions (
 owner_id TEXT PRIMARY KEY REFERENCES owners(owner_id),
 model_revision_id TEXT NOT NULL, activation_version INTEGER NOT NULL CHECK(activation_version>0),
 FOREIGN KEY(owner_id,model_revision_id) REFERENCES estimation_model_revisions(owner_id,model_revision_id)
);
CREATE TABLE estimation_model_activations (
 owner_id TEXT NOT NULL REFERENCES owners(owner_id), activation_version INTEGER NOT NULL CHECK(activation_version>0),
 previous_model_revision_id TEXT, model_revision_id TEXT NOT NULL,
 activated_at INTEGER, reason TEXT NOT NULL, decision TEXT NOT NULL, command_id TEXT,
 PRIMARY KEY(owner_id,activation_version), UNIQUE(owner_id,command_id),
 FOREIGN KEY(owner_id,previous_model_revision_id) REFERENCES estimation_model_revisions(owner_id,model_revision_id),
 FOREIGN KEY(owner_id,model_revision_id) REFERENCES estimation_model_revisions(owner_id,model_revision_id),
 CHECK((decision='IMPORTED' AND command_id IS NULL) OR (command_id IS NOT NULL AND activated_at IS NOT NULL))
);

CREATE TABLE estimation_revision_files (
 owner_id TEXT NOT NULL REFERENCES owners(owner_id), storage_id TEXT NOT NULL,
 file_kind TEXT NOT NULL CHECK(file_kind IN ('ANNOTATIONS','SNAPSHOT','DATASET','BUNDLE','ARTIFACT')),
 state TEXT NOT NULL CHECK(state IN ('UPLOADING','VALIDATING','MATERIALIZING','READY')),
 semantic_hash TEXT, descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)),
 sha256 TEXT, byte_length INTEGER CHECK(byte_length>=0), part_count INTEGER CHECK(part_count>=0),
 checked_parts INTEGER NOT NULL DEFAULT 0 CHECK(checked_parts>=0), checked_bytes INTEGER NOT NULL DEFAULT 0 CHECK(checked_bytes>=0),
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,storage_id,file_kind),
 CHECK(state<>'READY' OR (sha256 IS NOT NULL AND byte_length IS NOT NULL
   AND part_count IS NOT NULL AND part_count=(byte_length+49151)/49152))
);
CREATE TABLE estimation_revision_file_parts (
 owner_id TEXT NOT NULL, storage_id TEXT NOT NULL, file_kind TEXT NOT NULL,
 part_index INTEGER NOT NULL CHECK(part_index>=0), byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 49152),
 content_base64 TEXT NOT NULL CHECK(length(content_base64)=4*((byte_length+2)/3)),
 PRIMARY KEY(owner_id,storage_id,file_kind,part_index),
 FOREIGN KEY(owner_id,storage_id,file_kind) REFERENCES estimation_revision_files(owner_id,storage_id,file_kind) ON DELETE CASCADE
);
CREATE INDEX estimation_upload_expiry ON estimation_revision_files(owner_id,updated_at) WHERE state IN ('UPLOADING','VALIDATING');

-- Preserve each teacher set. Legacy records do not identify a real frozen snapshot.
INSERT INTO estimation_dataset_revisions(owner_id,dataset_revision_id,origin,schema_version,feature_version,
 created_at,imported_at,row_count,eligible_count,provenance_json)
SELECT owner_id,model_id||':teacher','IMPORTED',1,'agent-task-v4',NULL,
 CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),count(*),sum(json_extract(record_json,'$.eligibility')='ELIGIBLE'),
 json_object('modelId',model_id,'source','estimation_reconstructed_dataset_rows','limitation','HISTORICAL_PROVENANCE_INCOMPLETE')
FROM estimation_reconstructed_dataset_rows GROUP BY owner_id,model_id;
INSERT INTO estimation_dataset_revisions(owner_id,dataset_revision_id,origin,schema_version,feature_version,
 created_at,imported_at,row_count,eligible_count,provenance_json)
SELECT d.owner_id,d.model_id||'-r'||d.revision||':teacher','IMPORTED',1,'agent-task-v4',b.created_at,
 CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),count(*),sum(json_extract(d.record_json,'$.eligibility')='ELIGIBLE'),
 json_object('modelId',d.model_id,'revision',d.revision,'source','estimation_retrospective_dataset_rows','limitation','HISTORICAL_PROVENANCE_INCOMPLETE')
FROM estimation_retrospective_dataset_rows d JOIN estimation_retrospective_builds b USING(owner_id,model_id,revision)
GROUP BY d.owner_id,d.model_id,d.revision;

INSERT INTO estimation_dataset_revision_rows(owner_id,dataset_revision_id,row_id,ordinal,plan_id,group_id,
 origin,eligibility,reasons_json,annotation_json,features_json,source_json,record_json)
SELECT owner_id,model_id||':teacher',plan_id,row_number() OVER(PARTITION BY owner_id,model_id ORDER BY plan_id)-1,
 plan_id,NULL,'IMPORTED',json_extract(record_json,'$.eligibility'),json_extract(record_json,'$.reasons'),
 NULL,json_extract(record_json,'$.features'),
 json_object('planId',plan_id,'sourceGeneration',NULL,'sampleId',json_extract(record_json,'$.sampleId'),
   'sourceDigest',NULL,'firstStartedAt',json_extract(record_json,'$.firstStartedAt'),
   'finishedAt',json_extract(record_json,'$.finishedAt'),'sourceAvailableAt',NULL,
   'actualMs',json_extract(record_json,'$.actualMs'),'scopeChanged',NULL),record_json
FROM estimation_reconstructed_dataset_rows;

INSERT INTO estimation_dataset_revision_rows(owner_id,dataset_revision_id,row_id,ordinal,plan_id,group_id,
 origin,eligibility,reasons_json,annotation_json,features_json,source_json,record_json)
SELECT owner_id,model_id||'-r'||revision||':teacher',plan_id,
 row_number() OVER(PARTITION BY owner_id,model_id,revision ORDER BY ordinal)-1,
 plan_id,json_extract(record_json,'$.group'),'IMPORTED',json_extract(record_json,'$.eligibility'),
 json_extract(record_json,'$.reasons'),
 CASE WHEN json_type(record_json,'$.agentTask')='object' THEN json_object('scope','ACTUAL',
  'agentTask',json_extract(record_json,'$.agentTask'),'fieldEvidence',json_extract(record_json,'$.fieldEvidence'),
  'codeEvidence',json_extract(record_json,'$.codeEvidence')) END,json_extract(record_json,'$.features'),
 json_object('planId',plan_id,'sourceGeneration',NULL,'sampleId',json_extract(record_json,'$.sampleId'),
   'sourceDigest',NULL,'firstStartedAt',json_extract(record_json,'$.firstStartedAt'),
   'finishedAt',json_extract(record_json,'$.finishedAt'),'sourceAvailableAt',json_extract(record_json,'$.sourceAvailableAt'),
   'actualMs',json_extract(record_json,'$.actualMs'),'scopeChanged',json_extract(record_json,'$.scopeChanged')),record_json
FROM estimation_retrospective_dataset_rows;

-- Validate legacy journal references independently of serving status.
WITH journal AS (
 SELECT m.owner_id,m.model_id,m.sample_count,
  count(s.sequence) AS source_count,count(DISTINCT s.plan_id) AS plan_count,
  sum(CASE WHEN s.eligibility='ELIGIBLE' THEN 1 ELSE 0 END) AS eligible_count
 FROM estimation_models m LEFT JOIN json_each(m.manifest_json) part ON typeof(part.value)='integer'
 LEFT JOIN estimation_samples s ON s.owner_id=m.owner_id AND s.sequence=part.value
 GROUP BY m.owner_id,m.model_id
)
INSERT INTO estimation_model_revisions(owner_id,model_revision_id,dataset_revision_id,model_version,
 origin,method_version,feature_version,registered_at,imported_at,legacy_activated_at,artifact_json,
 manifest_json,dataset_digest,evaluation_json,provenance_json,fit_count,source_count,train_cutoff,supported,
 archived_reason,invalidated_reason)
SELECT m.owner_id,m.model_id,d.dataset_revision_id,m.model_version,'IMPORTED',m.method_version,m.feature_version,
 m.created_at,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),m.activated_at,m.artifact_json,m.manifest_json,
 m.dataset_digest,m.metrics_json,json_object('source','estimation_models','legacyStatus',m.status,'legacyReason',m.reason),
 m.sample_count,j.plan_count,m.train_cutoff,
 CASE WHEN m.artifact_json IS NOT NULL AND m.feature_version='agent-task-v4' AND
  m.method_version ='agent-v5-operations' AND j.eligible_count=m.sample_count AND
  j.source_count=j.plan_count AND j.plan_count=m.sample_count AND m.sample_count>0 THEN 1 ELSE 0 END,
 CASE WHEN m.artifact_json IS NULL THEN coalesce(m.reason,'NO_ARTIFACT')
      WHEN j.eligible_count<>m.sample_count OR j.source_count<>j.plan_count OR j.plan_count<>m.sample_count
       THEN 'HISTORICAL_PROVENANCE_INCOMPLETE' END,
 CASE WHEN m.status='INVALIDATED' THEN coalesce(m.reason,'SOURCE_CHANGED') END
FROM estimation_models m JOIN journal j USING(owner_id,model_id)
LEFT JOIN estimation_dataset_revisions d ON d.owner_id=m.owner_id AND d.dataset_revision_id=m.model_id||':teacher'
ORDER BY m.owner_id,m.model_version;

WITH proven_sources AS (
 SELECT m.owner_id,m.model_id,s.plan_id,max(s.source_generation) AS source_generation
 FROM estimation_models m JOIN json_each(m.manifest_json) part ON typeof(part.value)='integer'
 JOIN estimation_samples s ON s.owner_id=m.owner_id AND s.sequence=part.value
 GROUP BY m.owner_id,m.model_id,s.plan_id
)
INSERT INTO estimation_model_revision_sources(owner_id,model_revision_id,plan_id,source_generation,ordinal)
SELECT owner_id,model_id,plan_id,source_generation,
 row_number() OVER(PARTITION BY owner_id,model_id ORDER BY plan_id)-1 FROM proven_sources;

INSERT INTO estimation_model_revisions(owner_id,model_revision_id,dataset_revision_id,model_version,legacy_revision,
 origin,method_version,feature_version,registered_at,imported_at,legacy_activated_at,artifact_json,
 manifest_json,dataset_digest,evaluation_json,provenance_json,fit_count,source_count,train_cutoff,supported,archived_reason)
SELECT b.owner_id,b.model_id||'-r'||b.revision,d.dataset_revision_id,m.model_version,b.revision,'IMPORTED',
 json_extract(b.artifact_json,'$.method.version'),json_extract(b.artifact_json,'$.featureSchemaVersion'),
 b.created_at,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),r.activated_at,b.artifact_json,b.manifest_json,
 json_extract(b.artifact_json,'$.datasetDigest'),b.evaluation_json,
 json_object('source','estimation_retrospective_builds','parentModelId',b.model_id,
  'legacyStatus',b.eligibility_status,'legacyReason',b.reason),
 json_extract(b.artifact_json,'$.n'),count(s.plan_id),json_extract(b.artifact_json,'$.trainCutoff'),
 CASE WHEN json_extract(b.artifact_json,'$.featureSchemaVersion')='agent-task-v4' AND
  json_extract(b.artifact_json,'$.method.version') ='agent-v5-operations' AND
  count(s.plan_id)=json_extract(b.artifact_json,'$.n') AND count(s.plan_id)>0 THEN 1 ELSE 0 END,
 CASE WHEN count(s.plan_id)<>json_extract(b.artifact_json,'$.n') THEN 'HISTORICAL_PROVENANCE_INCOMPLETE' END
FROM estimation_retrospective_builds b JOIN estimation_models m USING(owner_id,model_id)
LEFT JOIN estimation_revision_releases r USING(owner_id,model_id,revision)
LEFT JOIN estimation_revision_sources s USING(owner_id,model_id,revision)
LEFT JOIN estimation_dataset_revisions d ON d.owner_id=b.owner_id AND d.dataset_revision_id=b.model_id||'-r'||b.revision||':teacher'
GROUP BY b.owner_id,b.model_id,b.revision ORDER BY b.owner_id,m.model_version,b.revision;

INSERT INTO estimation_model_revision_sources(owner_id,model_revision_id,plan_id,source_generation,ordinal,dataset_revision_id,row_id)
SELECT s.owner_id,m.model_revision_id,s.plan_id,s.source_generation,
 row_number() OVER(PARTITION BY s.owner_id,s.model_id,s.revision ORDER BY s.plan_id)-1,
 m.dataset_revision_id,d.row_id
FROM estimation_revision_sources s
JOIN estimation_model_revisions m ON m.owner_id=s.owner_id AND m.model_revision_id=s.model_id||'-r'||s.revision
LEFT JOIN estimation_dataset_revision_rows d ON d.owner_id=m.owner_id AND d.dataset_revision_id=m.dataset_revision_id AND d.plan_id=s.plan_id;

INSERT INTO estimation_active_revisions(owner_id,model_revision_id,activation_version)
SELECT o.owner_id,v.model_id,1 FROM estimation_owner_state o JOIN estimation_serving_models v
 ON v.owner_id=o.owner_id AND v.pointer_id=o.active_model_id AND v.preferred=1;
INSERT INTO estimation_model_activations(owner_id,activation_version,model_revision_id,activated_at,reason,decision)
SELECT a.owner_id,a.activation_version,a.model_revision_id,m.legacy_activated_at,'LEGACY_ACTIVE_POINTER','IMPORTED'
FROM estimation_active_revisions a JOIN estimation_model_revisions m USING(owner_id,model_revision_id);

-- Attempts keep their old rows and diagnostics, even when a release had no artifact.
INSERT INTO estimation_model_revisions(owner_id,model_revision_id,origin,method_version,feature_version,
 registered_at,imported_at,manifest_json,evaluation_json,provenance_json,fit_count,source_count,supported,archived_reason)
SELECT owner_id,'attempt:'||attempt_id,'IMPORTED',method_version,feature_version,
 started_at,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),manifest_json,metrics_json,
 json_object('source','estimation_training_attempts','attemptId',attempt_id,'completedAt',completed_at,
  'diagnostics',json(diagnostics_json),'caseIds',json(case_ids_json),'selected',json(selected_json)),
 json_array_length(manifest_json),0,0,CASE WHEN completed_at IS NULL THEN 'RETIRED_BY_AGENT_FLOW'
   ELSE coalesce(reason,'NO_ARTIFACT') END
FROM estimation_training_attempts ORDER BY owner_id,started_at,attempt_id;

DROP VIEW estimation_serving_models;
CREATE VIEW estimation_serving_models AS
WITH status AS (
 SELECT m.*,
   CASE WHEN m.invalidated_reason IS NOT NULL THEN m.invalidated_reason
    WHEN m.supported=0 THEN coalesce(m.archived_reason,'ARTIFACT_UNSUPPORTED')
    WHEN o.data_reset_at IS NOT NULL AND o.data_reset_at>=m.registered_at THEN 'HISTORY_RESET'
    WHEN m.source_count<>(SELECT count(*) FROM estimation_model_revision_sources s
        WHERE s.owner_id=m.owner_id AND s.model_revision_id=m.model_revision_id) THEN 'MODEL_SOURCE_MISSING'
    WHEN EXISTS(SELECT 1 FROM estimation_model_revision_sources s LEFT JOIN estimation_jobs j
      ON j.owner_id=s.owner_id AND j.job_key='refresh:'||s.plan_id
      WHERE s.owner_id=m.owner_id AND s.model_revision_id=m.model_revision_id
      AND s.source_generation<>coalesce(j.generation,0)) THEN 'SOURCE_CHANGED' END AS source_problem
 FROM estimation_model_revisions m LEFT JOIN estimation_owner_state o USING(owner_id)
)
SELECT m.owner_id,m.model_revision_id AS pointer_id,m.model_revision_id AS model_id,m.model_version,
 m.legacy_revision AS model_revision,m.method_version,m.feature_version,m.artifact_json,m.manifest_json,
 m.evaluation_json AS metrics_json,m.fit_count AS sample_count,m.train_cutoff,m.registered_at AS created_at,
 coalesce(h.activated_at,m.legacy_activated_at) AS activated_at,1 AS preferred,m.source_problem,
 CASE WHEN m.source_problem IN ('SOURCE_CHANGED','HISTORY_RESET','MODEL_SOURCE_MISSING') OR m.invalidated_reason IS NOT NULL THEN 'INVALIDATED'
  WHEN m.source_problem IS NOT NULL THEN 'ARCHIVED' WHEN a.model_revision_id=m.model_revision_id THEN 'ACTIVE'
  WHEN m.legacy_activated_at IS NOT NULL OR EXISTS(SELECT 1 FROM estimation_model_activations x
    WHERE x.owner_id=m.owner_id AND x.model_revision_id=m.model_revision_id) THEN 'RETIRED' ELSE 'REGISTERED' END AS status
FROM status m LEFT JOIN estimation_active_revisions a USING(owner_id)
LEFT JOIN estimation_model_activations h ON h.owner_id=a.owner_id AND h.activation_version=a.activation_version
 AND h.model_revision_id=m.model_revision_id;

CREATE TABLE estimation_legacy_train_jobs AS SELECT * FROM estimation_jobs WHERE kind='TRAIN';
CREATE TABLE estimation_legacy_train_checkpoint_parts AS SELECT * FROM estimation_checkpoint_parts;
DROP TRIGGER IF EXISTS atlm_discard_checkpoint;
DELETE FROM estimation_checkpoint_parts;
DELETE FROM estimation_jobs WHERE kind='TRAIN';
UPDATE estimation_training_attempts SET
 completed_at=max(started_at,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)),reason='RETIRED_BY_AGENT_FLOW'
WHERE completed_at IS NULL;

CREATE TRIGGER atlm_no_train_insert BEFORE INSERT ON estimation_jobs WHEN NEW.kind='TRAIN'
BEGIN SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED'); END;
CREATE TRIGGER atlm_no_train_update BEFORE UPDATE OF kind ON estimation_jobs WHEN NEW.kind='TRAIN'
BEGIN SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED'); END;
CREATE TRIGGER atlm_legacy_models_no_insert BEFORE INSERT ON estimation_models
BEGIN SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED'); END;
CREATE TRIGGER atlm_legacy_models_no_update BEFORE UPDATE ON estimation_models
BEGIN SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED'); END;
CREATE TRIGGER atlm_legacy_pointer_no_insert BEFORE INSERT ON estimation_owner_state WHEN NEW.active_model_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED'); END;
CREATE TRIGGER atlm_legacy_pointer_no_update BEFORE UPDATE OF active_model_id ON estimation_owner_state
WHEN NEW.active_model_id IS NOT OLD.active_model_id
BEGIN SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED'); END;

CREATE TRIGGER atlm_snapshot_row_ordinal BEFORE INSERT ON estimation_training_snapshot_rows
WHEN NEW.ordinal>=(SELECT row_count FROM estimation_training_snapshots
 WHERE owner_id=NEW.owner_id AND snapshot_id=NEW.snapshot_id)
BEGIN SELECT RAISE(ABORT,'ATLM_SNAPSHOT_IMMUTABLE'); END;
CREATE TRIGGER atlm_dataset_row_ordinal BEFORE INSERT ON estimation_dataset_revision_rows
WHEN NEW.ordinal>=(SELECT row_count FROM estimation_dataset_revisions
 WHERE owner_id=NEW.owner_id AND dataset_revision_id=NEW.dataset_revision_id)
BEGIN SELECT RAISE(ABORT,'ATLM_DATASET_IMMUTABLE'); END;
CREATE TRIGGER atlm_model_source_ordinal BEFORE INSERT ON estimation_model_revision_sources
WHEN NEW.ordinal>=(SELECT source_count FROM estimation_model_revisions
 WHERE owner_id=NEW.owner_id AND model_revision_id=NEW.model_revision_id)
BEGIN SELECT RAISE(ABORT,'ATLM_MODEL_IMMUTABLE'); END;

CREATE TRIGGER atlm_ready_file_no_update BEFORE UPDATE ON estimation_revision_files WHEN OLD.state='READY'
BEGIN SELECT RAISE(ABORT,'ATLM_FILE_IMMUTABLE'); END;
CREATE TRIGGER atlm_ready_file_no_delete BEFORE DELETE ON estimation_revision_files WHEN OLD.state='READY'
BEGIN SELECT RAISE(ABORT,'ATLM_FILE_IMMUTABLE'); END;
CREATE TRIGGER atlm_file_part_no_update BEFORE UPDATE ON estimation_revision_file_parts
BEGIN SELECT RAISE(ABORT,'ATLM_FILE_PART_IMMUTABLE'); END;
CREATE TRIGGER atlm_ready_file_part_no_delete BEFORE DELETE ON estimation_revision_file_parts
WHEN EXISTS(SELECT 1 FROM estimation_revision_files f WHERE f.owner_id=OLD.owner_id
 AND f.storage_id=OLD.storage_id AND f.file_kind=OLD.file_kind AND f.state='READY')
BEGIN SELECT RAISE(ABORT,'ATLM_FILE_IMMUTABLE'); END;
CREATE TRIGGER atlm_ready_file_part_no_insert BEFORE INSERT ON estimation_revision_file_parts
WHEN EXISTS(SELECT 1 FROM estimation_revision_files f WHERE f.owner_id=NEW.owner_id
 AND f.storage_id=NEW.storage_id AND f.file_kind=NEW.file_kind AND f.state='READY')
BEGIN SELECT RAISE(ABORT,'ATLM_FILE_IMMUTABLE'); END;

CREATE TRIGGER atlm_snapshots_no_update BEFORE UPDATE ON estimation_training_snapshots
BEGIN SELECT RAISE(ABORT,'ATLM_SNAPSHOT_IMMUTABLE'); END;

CREATE TRIGGER atlm_snapshots_no_delete BEFORE DELETE ON estimation_training_snapshots
BEGIN SELECT RAISE(ABORT,'ATLM_SNAPSHOT_IMMUTABLE'); END;

CREATE TRIGGER atlm_snapshot_rows_no_update BEFORE UPDATE ON estimation_training_snapshot_rows
BEGIN SELECT RAISE(ABORT,'ATLM_SNAPSHOT_IMMUTABLE'); END;

CREATE TRIGGER atlm_snapshot_rows_no_delete BEFORE DELETE ON estimation_training_snapshot_rows
BEGIN SELECT RAISE(ABORT,'ATLM_SNAPSHOT_IMMUTABLE'); END;

CREATE TRIGGER atlm_datasets_no_update BEFORE UPDATE ON estimation_dataset_revisions
BEGIN SELECT RAISE(ABORT,'ATLM_DATASET_IMMUTABLE'); END;

CREATE TRIGGER atlm_datasets_no_delete BEFORE DELETE ON estimation_dataset_revisions
BEGIN SELECT RAISE(ABORT,'ATLM_DATASET_IMMUTABLE'); END;

CREATE TRIGGER atlm_dataset_rows_no_update BEFORE UPDATE ON estimation_dataset_revision_rows
BEGIN SELECT RAISE(ABORT,'ATLM_DATASET_IMMUTABLE'); END;

CREATE TRIGGER atlm_dataset_rows_no_delete BEFORE DELETE ON estimation_dataset_revision_rows
BEGIN SELECT RAISE(ABORT,'ATLM_DATASET_IMMUTABLE'); END;

CREATE TRIGGER atlm_model_revisions_no_update BEFORE UPDATE ON estimation_model_revisions
BEGIN SELECT RAISE(ABORT,'ATLM_MODEL_IMMUTABLE'); END;

CREATE TRIGGER atlm_model_revisions_no_delete BEFORE DELETE ON estimation_model_revisions
BEGIN SELECT RAISE(ABORT,'ATLM_MODEL_IMMUTABLE'); END;

CREATE TRIGGER atlm_model_sources_no_update BEFORE UPDATE ON estimation_model_revision_sources
BEGIN SELECT RAISE(ABORT,'ATLM_MODEL_IMMUTABLE'); END;

CREATE TRIGGER atlm_model_sources_no_delete BEFORE DELETE ON estimation_model_revision_sources
BEGIN SELECT RAISE(ABORT,'ATLM_MODEL_IMMUTABLE'); END;

CREATE TRIGGER atlm_activations_no_update BEFORE UPDATE ON estimation_model_activations
BEGIN SELECT RAISE(ABORT,'ATLM_ACTIVATION_IMMUTABLE'); END;

CREATE TRIGGER atlm_activations_no_delete BEFORE DELETE ON estimation_model_activations
BEGIN SELECT RAISE(ABORT,'ATLM_ACTIVATION_IMMUTABLE'); END;

-- Preserve source refresh generation and lease semantics; the registry checks freshness on read.
DROP TRIGGER atlm_interval_delete;
CREATE TRIGGER atlm_interval_delete AFTER DELETE ON work_intervals
WHEN EXISTS(SELECT 1 FROM plans p WHERE p.owner_id=OLD.owner_id AND p.plan_id=OLD.plan_id AND p.first_started_at IS NOT NULL)
BEGIN
 INSERT OR IGNORE INTO estimation_owner_state(owner_id) VALUES(OLD.owner_id);
 INSERT INTO estimation_jobs(owner_id,job_key,kind,plan_id,generation,status,created_at,updated_at,source_changed_at)
 VALUES(OLD.owner_id,'refresh:'||OLD.plan_id,'REFRESH_SAMPLE',OLD.plan_id,1,'QUEUED',COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=OLD.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=OLD.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=OLD.owner_id),0))
 ON CONFLICT(owner_id,job_key) DO UPDATE SET generation=generation+1,
   status=CASE WHEN status='RUNNING' THEN status ELSE 'QUEUED' END,
   attempts=0,next_attempt_at=0,updated_at=excluded.updated_at,source_changed_at=excluded.source_changed_at;
END;

DROP TRIGGER atlm_interval_insert;
CREATE TRIGGER atlm_interval_insert AFTER INSERT ON work_intervals
WHEN EXISTS(SELECT 1 FROM plans p WHERE p.owner_id=NEW.owner_id AND p.plan_id=NEW.plan_id AND p.first_started_at IS NOT NULL)
BEGIN
 INSERT OR IGNORE INTO estimation_owner_state(owner_id) VALUES(NEW.owner_id);
 INSERT INTO estimation_jobs(owner_id,job_key,kind,plan_id,generation,status,created_at,updated_at,source_changed_at)
 VALUES(NEW.owner_id,'refresh:'||NEW.plan_id,'REFRESH_SAMPLE',NEW.plan_id,1,'QUEUED',COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0))
 ON CONFLICT(owner_id,job_key) DO UPDATE SET generation=generation+1,
   status=CASE WHEN status='RUNNING' THEN status ELSE 'QUEUED' END,
   attempts=0,next_attempt_at=0,updated_at=excluded.updated_at,source_changed_at=excluded.source_changed_at;
END;

DROP TRIGGER atlm_interval_update;
CREATE TRIGGER atlm_interval_update AFTER UPDATE ON work_intervals
WHEN EXISTS(SELECT 1 FROM plans p WHERE p.owner_id=NEW.owner_id AND p.plan_id=NEW.plan_id AND p.first_started_at IS NOT NULL) AND (NEW.start_ms IS NOT OLD.start_ms OR NEW.end_ms IS NOT OLD.end_ms)
BEGIN
 INSERT OR IGNORE INTO estimation_owner_state(owner_id) VALUES(NEW.owner_id);
 INSERT INTO estimation_jobs(owner_id,job_key,kind,plan_id,generation,status,created_at,updated_at,source_changed_at)
 VALUES(NEW.owner_id,'refresh:'||NEW.plan_id,'REFRESH_SAMPLE',NEW.plan_id,1,'QUEUED',COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0))
 ON CONFLICT(owner_id,job_key) DO UPDATE SET generation=generation+1,
   status=CASE WHEN status='RUNNING' THEN status ELSE 'QUEUED' END,
   attempts=0,next_attempt_at=0,updated_at=excluded.updated_at,source_changed_at=excluded.source_changed_at;
END;

DROP TRIGGER atlm_plan_source;
CREATE TRIGGER atlm_plan_source AFTER UPDATE ON plans
WHEN NEW.first_started_at IS NOT NULL AND (NEW.status IS NOT OLD.status OR NEW.finished_at IS NOT OLD.finished_at OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.title IS NOT OLD.title OR NEW.description IS NOT OLD.description OR NEW.acceptance_criteria IS NOT OLD.acceptance_criteria)
BEGIN
 INSERT OR IGNORE INTO estimation_owner_state(owner_id) VALUES(NEW.owner_id);
 INSERT INTO estimation_jobs(owner_id,job_key,kind,plan_id,generation,status,created_at,updated_at,source_changed_at)
 VALUES(NEW.owner_id,'refresh:'||NEW.plan_id,'REFRESH_SAMPLE',NEW.plan_id,1,'QUEUED',COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0))
 ON CONFLICT(owner_id,job_key) DO UPDATE SET generation=generation+1,
   status=CASE WHEN status='RUNNING' THEN status ELSE 'QUEUED' END,
   attempts=0,next_attempt_at=0,updated_at=excluded.updated_at,source_changed_at=excluded.source_changed_at;
END;

DROP TRIGGER atlm_step_insert;
CREATE TRIGGER atlm_step_insert AFTER INSERT ON plan_steps
WHEN EXISTS(SELECT 1 FROM plans p WHERE p.owner_id=NEW.owner_id AND p.plan_id=NEW.plan_id AND p.first_started_at IS NOT NULL)
BEGIN
 INSERT OR IGNORE INTO estimation_owner_state(owner_id) VALUES(NEW.owner_id);
 INSERT INTO estimation_jobs(owner_id,job_key,kind,plan_id,generation,status,created_at,updated_at,source_changed_at)
 VALUES(NEW.owner_id,'refresh:'||NEW.plan_id,'REFRESH_SAMPLE',NEW.plan_id,1,'QUEUED',COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0))
 ON CONFLICT(owner_id,job_key) DO UPDATE SET generation=generation+1,
   status=CASE WHEN status='RUNNING' THEN status ELSE 'QUEUED' END,
   attempts=0,next_attempt_at=0,updated_at=excluded.updated_at,source_changed_at=excluded.source_changed_at;
END;

DROP TRIGGER atlm_step_update;
CREATE TRIGGER atlm_step_update AFTER UPDATE ON plan_steps
WHEN EXISTS(SELECT 1 FROM plans p WHERE p.owner_id=NEW.owner_id AND p.plan_id=NEW.plan_id AND p.first_started_at IS NOT NULL) AND (NEW.title IS NOT OLD.title OR NEW.content IS NOT OLD.content OR NEW.ordinal IS NOT OLD.ordinal OR NEW.status IS NOT OLD.status)
BEGIN
 INSERT OR IGNORE INTO estimation_owner_state(owner_id) VALUES(NEW.owner_id);
 INSERT INTO estimation_jobs(owner_id,job_key,kind,plan_id,generation,status,created_at,updated_at,source_changed_at)
 VALUES(NEW.owner_id,'refresh:'||NEW.plan_id,'REFRESH_SAMPLE',NEW.plan_id,1,'QUEUED',COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0))
 ON CONFLICT(owner_id,job_key) DO UPDATE SET generation=generation+1,
   status=CASE WHEN status='RUNNING' THEN status ELSE 'QUEUED' END,
   attempts=0,next_attempt_at=0,updated_at=excluded.updated_at,source_changed_at=excluded.source_changed_at;
END;

DROP TRIGGER atlm_operations_start;
CREATE TRIGGER atlm_operations_start BEFORE INSERT ON command_receipts
WHEN NEW.command_type='StartPlan' AND NEW.outcome_code='PENDING'
 AND EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id
    AND status='PLANNED' AND first_started_at IS NULL AND deleted_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM assessment_revisions a JOIN assessment_targets t
   ON t.owner_id=a.owner_id AND t.plan_id=a.plan_id AND t.step_id IS NULL
   WHERE a.owner_id=NEW.owner_id AND a.plan_id=NEW.plan_id AND a.step_id IS NULL
   AND a.sequence=(SELECT MAX(r.sequence) FROM assessment_revisions r WHERE r.owner_id=a.owner_id AND r.plan_id=a.plan_id AND r.step_id IS NULL)
   AND a.sequence=json_extract(NEW.payload_json,'$.atlmStartForecast.assessmentSequence')
   AND a.requirements_json=t.requirements_json
   AND a.requirements_digest=json_extract(NEW.payload_json,'$.atlmStartForecast.estimation.requirementsDigest')
   AND json_extract(a.assessment_json,'$.context.agentTask.schemaVersion')='agent-task-v4'
   AND json_extract(a.assessment_json,'$.predictionRequest.method')='ATLM'
   AND json_extract(a.assessment_json,'$.serverEstimation.featureDigest')=json_extract(NEW.payload_json,'$.atlmStartForecast.estimation.featureDigest')
   AND json_extract(NEW.payload_json,'$.atlmStartForecast.snapshotVersion')=5)
BEGIN SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED'); END;
