-- Reset the incompatible estimation history while retaining plans and measured time.
-- The migration runner executes this file atomically and records its application.
DROP TRIGGER atlm_input_no_delete;
DROP TRIGGER atlm_sample_no_delete;
DROP TRIGGER atlm_model_no_delete;
DROP TRIGGER assessment_immutable_delete;

ALTER TABLE estimation_owner_state ADD COLUMN data_reset_at INTEGER;
ALTER TABLE estimation_owner_state ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 3;
ALTER TABLE estimation_owner_state ADD COLUMN manual_epoch INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO estimation_owner_state(owner_id) SELECT owner_id FROM owners;
UPDATE estimation_owner_state SET data_reset_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),schema_version=3;
-- The new fence starts above every pre-reset lease. Abort rather than reuse a
-- token if an unexpected existing fence is already that large.
CREATE TABLE _atlm_reset_fence_guard(ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO _atlm_reset_fence_guard SELECT CASE WHEN EXISTS(
  SELECT 1 FROM estimation_jobs j JOIN estimation_owner_state o ON o.owner_id=j.owner_id WHERE j.fence>=o.data_reset_at
) THEN 0 ELSE 1 END;
DROP TABLE _atlm_reset_fence_guard;

UPDATE estimation_owner_state SET active_model_id=NULL;
DELETE FROM estimation_models;
DELETE FROM estimation_samples;
DELETE FROM plan_estimation_inputs;
DELETE FROM estimation_jobs;
DELETE FROM assessment_revisions;

-- Retire assessment receipts without losing command identity or allowing replay.
UPDATE command_receipts SET payload_json='{}',result_json=NULL,outcome_code='ASSESSMENT_SCHEMA_RETIRED',
  plan_id=NULL,expected_version=NULL,result_version=NULL
WHERE command_type='RecordAssessment';
UPDATE command_receipts SET payload_json=json_remove(payload_json,'$.atlmStartForecast')
WHERE command_type='StartPlan' AND json_valid(payload_json) AND json_type(payload_json,'$.atlmStartForecast') IS NOT NULL;
UPDATE command_receipts SET result_json=json_remove(result_json,'$.atlmStartForecast')
WHERE command_type='StartPlan' AND json_valid(result_json) AND json_type(result_json,'$.atlmStartForecast') IS NOT NULL;

UPDATE estimation_owner_state SET dataset_revision=0,training_generation=0,new_sample_count=0,
  last_attempted_new_sample_count=0,last_attempted_new_sample_sequence=0,forced_retrain=0,
  last_training_status='IDLE',last_training_reason=NULL,last_training_diagnostics_json=NULL,
  updated_at=data_reset_at;
ALTER TABLE estimation_jobs ADD COLUMN executor_epoch INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER atlm_v4_job_initial_fence AFTER INSERT ON estimation_jobs
WHEN NEW.fence=0
BEGIN
 UPDATE estimation_jobs SET fence=COALESCE((SELECT data_reset_at FROM estimation_owner_state WHERE owner_id=NEW.owner_id),0)
 WHERE owner_id=NEW.owner_id AND job_key=NEW.job_key;
END;
-- The old executor does not advance executor_epoch, so it cannot claim a job.
CREATE TRIGGER atlm_v4_job_claim_guard BEFORE UPDATE OF fence ON estimation_jobs
WHEN NEW.status='RUNNING' AND NEW.fence<>OLD.fence AND NEW.executor_epoch<>OLD.executor_epoch+1
BEGIN SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED'); END;
CREATE TRIGGER atlm_v4_job_release_guard BEFORE UPDATE OF status ON estimation_jobs
WHEN OLD.status='RUNNING' AND NEW.status<>'RUNNING' AND NEW.executor_epoch<>OLD.executor_epoch+1
BEGIN SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED'); END;

-- Manual training requests must carry the new executor epoch; database-driven
-- invalidation triggers also advance it so normal plan operations remain atomic.
CREATE TRIGGER atlm_v4_manual_request_guard BEFORE UPDATE OF forced_retrain ON estimation_owner_state
WHEN NEW.forced_retrain=1 AND NEW.manual_epoch<>OLD.manual_epoch+1
BEGIN SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED'); END;

CREATE TABLE estimation_training_attempts (
  owner_id TEXT NOT NULL REFERENCES owners(owner_id), attempt_id TEXT NOT NULL,
  started_at INTEGER NOT NULL, completed_at INTEGER, method_version TEXT NOT NULL,
  feature_version TEXT NOT NULL, dataset_revision INTEGER NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  diagnostics_json TEXT CHECK(diagnostics_json IS NULL OR json_valid(diagnostics_json)),
  case_ids_json TEXT CHECK(case_ids_json IS NULL OR json_valid(case_ids_json)),
  metrics_json TEXT CHECK(metrics_json IS NULL OR json_valid(metrics_json)),
  selected_json TEXT CHECK(selected_json IS NULL OR json_valid(selected_json)),
  reason TEXT, PRIMARY KEY(owner_id,attempt_id)
);
CREATE INDEX atlm_training_attempts_history ON estimation_training_attempts(owner_id,started_at DESC,attempt_id DESC);

CREATE TRIGGER atlm_input_no_delete BEFORE DELETE ON plan_estimation_inputs BEGIN SELECT RAISE(ABORT,'ATLM_INPUT_IMMUTABLE'); END;
CREATE TRIGGER atlm_sample_no_delete BEFORE DELETE ON estimation_samples BEGIN SELECT RAISE(ABORT,'ATLM_SAMPLE_IMMUTABLE'); END;
CREATE TRIGGER atlm_model_no_delete BEFORE DELETE ON estimation_models BEGIN SELECT RAISE(ABORT,'ATLM_MODEL_IMMUTABLE'); END;
CREATE TRIGGER assessment_immutable_delete BEFORE DELETE ON assessment_revisions BEGIN SELECT RAISE(ABORT,'ASSESSMENT_IMMUTABLE'); END;
-- An older Worker can still be serving while the platform applies migrations.
-- Reject its retired task schema at the storage boundary as well as in runtime.
CREATE TRIGGER assessment_atlm_v4_only BEFORE INSERT ON assessment_revisions
WHEN json_type(NEW.assessment_json,'$.context.agentTask') IS NOT NULL
  AND COALESCE(json_extract(NEW.assessment_json,'$.context.agentTask.schemaVersion'),'') <> 'agent-task-v3'
BEGIN SELECT RAISE(ABORT,'ASSESSMENT_SCHEMA_RETIRED'); END;
-- Do not let an old Worker freeze a retired forecast while rollout is in flight.
CREATE TRIGGER atlm_v4_start_forecast_only BEFORE INSERT ON command_receipts
WHEN NEW.command_type='StartPlan' AND NEW.outcome_code='PENDING'
  AND EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id
    AND status='PLANNED' AND first_started_at IS NULL AND deleted_at IS NULL)
  AND COALESCE(json_extract(NEW.payload_json,'$.atlmStartForecast.estimation.formatVersion'),0) <> 2
BEGIN SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED'); END;

DROP TRIGGER atlm_capture_first_start;
CREATE TRIGGER atlm_capture_first_start AFTER UPDATE OF first_started_at ON plans
WHEN OLD.first_started_at IS NULL AND NEW.first_started_at IS NOT NULL
BEGIN
 INSERT INTO plan_estimation_inputs(owner_id,plan_id,assessment_sequence,requirements_digest,requirements_json,
   first_started_at,captured_receipt_rowid,selection_status,forecast_json)
 SELECT NEW.owner_id,NEW.plan_id,a.sequence,a.requirements_digest,t.requirements_json,NEW.first_started_at,
   COALESCE((SELECT MAX(rowid) FROM command_receipts WHERE owner_id=NEW.owner_id),0),
   CASE WHEN a.sequence IS NULL THEN 'MISSING_FEATURES' ELSE 'CAPTURED' END,
   json_extract(receipt.payload_json,'$.atlmStartForecast.estimation')
 FROM assessment_targets t
 LEFT JOIN command_receipts receipt ON receipt.rowid=(
   SELECT MAX(r.rowid) FROM command_receipts r WHERE r.owner_id=NEW.owner_id AND r.plan_id=NEW.plan_id
     AND r.command_type='StartPlan' AND r.outcome_code='PENDING')
 LEFT JOIN assessment_revisions a ON a.sequence=CASE
   WHEN json_type(receipt.payload_json,'$.atlmStartForecast')='object'
     THEN json_extract(receipt.payload_json,'$.atlmStartForecast.assessmentSequence')
   ELSE (SELECT MAX(r.sequence) FROM assessment_revisions r WHERE r.owner_id=NEW.owner_id AND r.plan_id=NEW.plan_id
     AND r.step_id IS NULL AND json_extract(r.assessment_json,'$.context.agentTask.schemaVersion')='agent-task-v3'
     AND r.requirements_json=t.requirements_json) END
 WHERE t.owner_id=NEW.owner_id AND t.plan_id=NEW.plan_id AND t.step_id IS NULL;
END;

-- Preserve automatic invalidation while marking the new request generation.
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
 UPDATE estimation_models SET status='INVALIDATED',reason='SOURCE_CHANGED'
 WHERE owner_id=OLD.owner_id AND status='ACTIVE' AND EXISTS(
   SELECT 1 FROM json_each(estimation_models.manifest_json) m JOIN estimation_samples s
     ON s.owner_id=estimation_models.owner_id AND s.sequence=CAST(m.value AS INTEGER)
     WHERE s.plan_id=OLD.plan_id);
 UPDATE estimation_owner_state SET forced_retrain=1,manual_epoch=manual_epoch+1,updated_at=COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=OLD.owner_id),0)
 WHERE owner_id=OLD.owner_id AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=OLD.owner_id
   AND m.model_id=active_model_id AND m.status='INVALIDATED');
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
 UPDATE estimation_models SET status='INVALIDATED',reason='SOURCE_CHANGED'
 WHERE owner_id=NEW.owner_id AND status='ACTIVE' AND EXISTS(
   SELECT 1 FROM json_each(estimation_models.manifest_json) m JOIN estimation_samples s
     ON s.owner_id=estimation_models.owner_id AND s.sequence=CAST(m.value AS INTEGER)
     WHERE s.plan_id=NEW.plan_id);
 UPDATE estimation_owner_state SET forced_retrain=1,manual_epoch=manual_epoch+1,updated_at=COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0)
 WHERE owner_id=NEW.owner_id AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=NEW.owner_id
   AND m.model_id=active_model_id AND m.status='INVALIDATED');
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
 UPDATE estimation_models SET status='INVALIDATED',reason='SOURCE_CHANGED'
 WHERE owner_id=NEW.owner_id AND status='ACTIVE' AND EXISTS(
   SELECT 1 FROM json_each(estimation_models.manifest_json) m JOIN estimation_samples s
     ON s.owner_id=estimation_models.owner_id AND s.sequence=CAST(m.value AS INTEGER)
     WHERE s.plan_id=NEW.plan_id);
 UPDATE estimation_owner_state SET forced_retrain=1,manual_epoch=manual_epoch+1,updated_at=COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0)
 WHERE owner_id=NEW.owner_id AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=NEW.owner_id
   AND m.model_id=active_model_id AND m.status='INVALIDATED');
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
 UPDATE estimation_models SET status='INVALIDATED',reason='SOURCE_CHANGED'
 WHERE owner_id=NEW.owner_id AND status='ACTIVE' AND EXISTS(
   SELECT 1 FROM json_each(estimation_models.manifest_json) m JOIN estimation_samples s
     ON s.owner_id=estimation_models.owner_id AND s.sequence=CAST(m.value AS INTEGER)
     WHERE s.plan_id=NEW.plan_id);
 UPDATE estimation_owner_state SET forced_retrain=1,manual_epoch=manual_epoch+1,updated_at=COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0)
 WHERE owner_id=NEW.owner_id AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=NEW.owner_id
   AND m.model_id=active_model_id AND m.status='INVALIDATED');
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
 UPDATE estimation_models SET status='INVALIDATED',reason='SOURCE_CHANGED'
 WHERE owner_id=NEW.owner_id AND status='ACTIVE' AND EXISTS(
   SELECT 1 FROM json_each(estimation_models.manifest_json) m JOIN estimation_samples s
     ON s.owner_id=estimation_models.owner_id AND s.sequence=CAST(m.value AS INTEGER)
     WHERE s.plan_id=NEW.plan_id);
 UPDATE estimation_owner_state SET forced_retrain=1,manual_epoch=manual_epoch+1,updated_at=COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0)
 WHERE owner_id=NEW.owner_id AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=NEW.owner_id
   AND m.model_id=active_model_id AND m.status='INVALIDATED');
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
 UPDATE estimation_models SET status='INVALIDATED',reason='SOURCE_CHANGED'
 WHERE owner_id=NEW.owner_id AND status='ACTIVE' AND EXISTS(
   SELECT 1 FROM json_each(estimation_models.manifest_json) m JOIN estimation_samples s
     ON s.owner_id=estimation_models.owner_id AND s.sequence=CAST(m.value AS INTEGER)
     WHERE s.plan_id=NEW.plan_id);
 UPDATE estimation_owner_state SET forced_retrain=1,manual_epoch=manual_epoch+1,updated_at=COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0)
 WHERE owner_id=NEW.owner_id AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=NEW.owner_id
   AND m.model_id=active_model_id AND m.status='INVALIDATED');
END;
