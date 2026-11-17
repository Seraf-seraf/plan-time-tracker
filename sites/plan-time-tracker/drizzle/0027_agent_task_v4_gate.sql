-- The migration ledger applies this reset once. Keep assessment revisions and
-- receipts intact so old plans explain OUTDATED and old commands can replay.
DROP TRIGGER atlm_input_no_delete;
DROP TRIGGER atlm_sample_no_delete;
DROP TRIGGER atlm_model_no_delete;
INSERT OR IGNORE INTO estimation_owner_state(owner_id) SELECT owner_id FROM owners;

-- v3 training data is incompatible with the v4 feature schema, but keep an
-- exact row copy so it can be inspected or restored if the upgrade is rolled back.
CREATE TABLE IF NOT EXISTS estimation_v3_archive_owner_state AS
  SELECT rowid AS source_rowid, *, CAST(NULL AS INTEGER) AS archived_at
  FROM estimation_owner_state WHERE 0;
CREATE TABLE IF NOT EXISTS estimation_v3_archive_models AS
  SELECT rowid AS source_rowid, *, CAST(NULL AS INTEGER) AS archived_at
  FROM estimation_models WHERE 0;
CREATE TABLE IF NOT EXISTS estimation_v3_archive_samples AS
  SELECT rowid AS source_rowid, *, CAST(NULL AS INTEGER) AS archived_at
  FROM estimation_samples WHERE 0;
CREATE TABLE IF NOT EXISTS estimation_v3_archive_training_attempts AS
  SELECT rowid AS source_rowid, *, CAST(NULL AS INTEGER) AS archived_at
  FROM estimation_training_attempts WHERE 0;
CREATE TABLE IF NOT EXISTS estimation_v3_archive_plan_inputs AS
  SELECT rowid AS source_rowid, *, CAST(NULL AS INTEGER) AS archived_at
  FROM plan_estimation_inputs WHERE 0;
CREATE TABLE IF NOT EXISTS estimation_v3_archive_jobs AS
  SELECT rowid AS source_rowid, *, CAST(NULL AS INTEGER) AS archived_at
  FROM estimation_jobs WHERE 0;

CREATE UNIQUE INDEX IF NOT EXISTS estimation_v3_archive_owner_state_key
  ON estimation_v3_archive_owner_state(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS estimation_v3_archive_models_key
  ON estimation_v3_archive_models(owner_id,model_id);
CREATE UNIQUE INDEX IF NOT EXISTS estimation_v3_archive_samples_key
  ON estimation_v3_archive_samples(owner_id,sequence);
CREATE UNIQUE INDEX IF NOT EXISTS estimation_v3_archive_attempts_key
  ON estimation_v3_archive_training_attempts(owner_id,attempt_id);
CREATE UNIQUE INDEX IF NOT EXISTS estimation_v3_archive_inputs_key
  ON estimation_v3_archive_plan_inputs(owner_id,plan_id);
CREATE UNIQUE INDEX IF NOT EXISTS estimation_v3_archive_jobs_key
  ON estimation_v3_archive_jobs(owner_id,job_key);

INSERT OR IGNORE INTO estimation_v3_archive_owner_state
  SELECT rowid,*,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  FROM estimation_owner_state WHERE schema_version<4;
INSERT OR IGNORE INTO estimation_v3_archive_models
  SELECT rowid,*,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  FROM estimation_models WHERE owner_id IN (SELECT owner_id FROM estimation_owner_state WHERE schema_version<4);
INSERT OR IGNORE INTO estimation_v3_archive_samples
  SELECT rowid,*,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  FROM estimation_samples WHERE owner_id IN (SELECT owner_id FROM estimation_owner_state WHERE schema_version<4);
INSERT OR IGNORE INTO estimation_v3_archive_training_attempts
  SELECT rowid,*,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  FROM estimation_training_attempts WHERE owner_id IN (SELECT owner_id FROM estimation_owner_state WHERE schema_version<4);
INSERT OR IGNORE INTO estimation_v3_archive_plan_inputs
  SELECT rowid,*,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  FROM plan_estimation_inputs WHERE owner_id IN (SELECT owner_id FROM estimation_owner_state WHERE schema_version<4);
INSERT OR IGNORE INTO estimation_v3_archive_jobs
  SELECT rowid,*,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  FROM estimation_jobs WHERE owner_id IN (SELECT owner_id FROM estimation_owner_state WHERE schema_version<4);

UPDATE estimation_owner_state SET active_model_id=NULL,
  data_reset_at=max(CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),
    COALESCE((SELECT max(fence)+1 FROM estimation_jobs WHERE owner_id=estimation_owner_state.owner_id),0),
    COALESCE((SELECT max(first_started_at) FROM plans WHERE owner_id=estimation_owner_state.owner_id),0)),
  dataset_revision=0, training_generation=0, new_sample_count=0, last_attempted_new_sample_count=0,
  last_attempted_new_sample_sequence=0, forced_retrain=0,last_training_status='IDLE',
  last_training_reason=NULL,last_training_diagnostics_json=NULL WHERE schema_version<4;
DELETE FROM estimation_training_attempts WHERE owner_id IN (SELECT owner_id FROM estimation_owner_state WHERE schema_version<4);
DELETE FROM estimation_models WHERE owner_id IN (SELECT owner_id FROM estimation_owner_state WHERE schema_version<4);
DELETE FROM estimation_samples WHERE owner_id IN (SELECT owner_id FROM estimation_owner_state WHERE schema_version<4);
DELETE FROM plan_estimation_inputs WHERE owner_id IN (SELECT owner_id FROM estimation_owner_state WHERE schema_version<4);
DELETE FROM estimation_jobs WHERE owner_id IN (SELECT owner_id FROM estimation_owner_state WHERE schema_version<4);
UPDATE estimation_owner_state SET schema_version=4 WHERE schema_version<4;
CREATE TRIGGER atlm_input_no_delete BEFORE DELETE ON plan_estimation_inputs BEGIN SELECT RAISE(ABORT,'ATLM_INPUT_IMMUTABLE'); END;
CREATE TRIGGER atlm_sample_no_delete BEFORE DELETE ON estimation_samples BEGIN SELECT RAISE(ABORT,'ATLM_SAMPLE_IMMUTABLE'); END;
CREATE TRIGGER atlm_model_no_delete BEFORE DELETE ON estimation_models BEGIN SELECT RAISE(ABORT,'ATLM_MODEL_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS atlm_new_owner_schema AFTER INSERT ON estimation_owner_state WHEN NEW.schema_version<>4
BEGIN UPDATE estimation_owner_state SET schema_version=4 WHERE owner_id=NEW.owner_id; END;

DROP TRIGGER IF EXISTS atlm_v4_job_claim_guard;
DROP TRIGGER IF EXISTS atlm_v4_job_release_guard;
CREATE TRIGGER IF NOT EXISTS atlm_operations_release BEFORE UPDATE OF status ON estimation_jobs
WHEN OLD.status='RUNNING' AND NEW.status<>'RUNNING' AND NEW.executor_epoch<>OLD.executor_epoch+2
BEGIN SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED'); END;
CREATE TRIGGER IF NOT EXISTS atlm_operations_claim BEFORE UPDATE OF fence ON estimation_jobs
WHEN NEW.status='RUNNING' AND NEW.fence<>OLD.fence AND NEW.executor_epoch<>OLD.executor_epoch+2
BEGIN SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED'); END;

DROP TRIGGER IF EXISTS assessment_atlm_v4_only;
CREATE TRIGGER IF NOT EXISTS assessment_operations_only BEFORE INSERT ON assessment_revisions
WHEN json_type(NEW.assessment_json,'$.context.agentTask') IS NOT NULL
 AND json_extract(NEW.assessment_json,'$.context.agentTask.schemaVersion') IS NOT 'agent-task-v4'
BEGIN SELECT RAISE(ABORT,'ASSESSMENT_SCHEMA_RETIRED'); END;
DROP TRIGGER IF EXISTS atlm_v4_start_forecast_only;
CREATE TRIGGER IF NOT EXISTS atlm_operations_start BEFORE INSERT ON command_receipts
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
   AND json_extract(NEW.payload_json,'$.atlmStartForecast.snapshotVersion')=4)
BEGIN SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED'); END;
DROP TRIGGER atlm_capture_first_start;
CREATE TRIGGER atlm_capture_first_start AFTER UPDATE OF first_started_at ON plans
WHEN OLD.first_started_at IS NULL AND NEW.first_started_at IS NOT NULL
BEGIN
 INSERT INTO plan_estimation_inputs(owner_id,plan_id,assessment_sequence,requirements_digest,requirements_json,
   first_started_at,captured_receipt_rowid,selection_status,forecast_json)
 SELECT NEW.owner_id,NEW.plan_id,a.sequence,a.requirements_digest,a.requirements_json,NEW.first_started_at,
   r.rowid,'CAPTURED',json_extract(r.payload_json,'$.atlmStartForecast.estimation')
 FROM command_receipts r JOIN assessment_revisions a ON a.sequence=json_extract(r.payload_json,'$.atlmStartForecast.assessmentSequence')
 WHERE r.owner_id=NEW.owner_id AND r.plan_id=NEW.plan_id AND r.command_type='StartPlan' AND r.outcome_code='PENDING'
 ORDER BY r.rowid DESC LIMIT 1;
 SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'ASSESSMENT_REQUIRED') END;
END;
