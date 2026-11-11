-- Sites bridge generated from the live source ledger at commit 2a07674.
-- Tables/indexes: drizzle-kit 0.31.10; triggers: canonical GitHub 0019_atlm.sql.
-- Canonical SHA-256: 8856efa78f730f417c9e74ee60bb3e471b5e11f522732bd4100f2ae4fe016a1e
CREATE TABLE `estimation_jobs` (
	`owner_id` text NOT NULL,
	`job_key` text NOT NULL,
	`kind` text NOT NULL,
	`plan_id` text,
	`generation` integer DEFAULT 1 NOT NULL,
	`processed_generation` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'QUEUED' NOT NULL,
	`lease_until` integer,
	`fence` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`snapshot_json` text,
	`checkpoint_json` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`source_changed_at` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`owner_id`, `job_key`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`owner_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`plan_id`) REFERENCES `plans`(`owner_id`,`plan_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "atlm_job_kind" CHECK(kind IN ('REFRESH_SAMPLE','TRAIN')),
	CONSTRAINT "atlm_job_status" CHECK(status IN ('QUEUED','RUNNING','IDLE','RETRY_WAIT','FAILED')),
	CONSTRAINT "atlm_job_snapshot_json" CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
	CONSTRAINT "atlm_job_checkpoint_json" CHECK(checkpoint_json IS NULL OR json_valid(checkpoint_json)),
	CONSTRAINT "atlm_job_counters" CHECK(generation>=1 AND processed_generation>=0 AND processed_generation<=generation AND fence>=0 AND attempts>=0),
	CONSTRAINT "atlm_job_scope" CHECK((kind='REFRESH_SAMPLE' AND plan_id IS NOT NULL AND job_key='refresh:'||plan_id) OR (kind='TRAIN' AND plan_id IS NULL AND job_key='train'))
);
--> statement-breakpoint
CREATE INDEX `atlm_jobs_due` ON `estimation_jobs` (`owner_id`,`status`,`next_attempt_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `estimation_models` (
	`owner_id` text NOT NULL,
	`model_id` text NOT NULL,
	`model_version` integer NOT NULL,
	`method_version` text DEFAULT 'agent-v1' NOT NULL,
	`feature_version` text DEFAULT 'agent-task-v1' NOT NULL,
	`status` text NOT NULL,
	`artifact_json` text,
	`manifest_json` text NOT NULL,
	`dataset_digest` text NOT NULL,
	`train_cutoff` integer NOT NULL,
	`metrics_json` text,
	`sample_count` integer NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`activated_at` integer,
	PRIMARY KEY(`owner_id`, `model_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`owner_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "atlm_model_status" CHECK(status IN ('CANDIDATE','ACTIVE','REJECTED','INVALIDATED','RETIRED')),
	CONSTRAINT "atlm_model_artifact_json" CHECK(artifact_json IS NULL OR json_valid(artifact_json)),
	CONSTRAINT "atlm_model_manifest_json" CHECK(json_valid(manifest_json) AND json_type(manifest_json)='array'),
	CONSTRAINT "atlm_model_metrics_json" CHECK(metrics_json IS NULL OR json_valid(metrics_json))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `atlm_one_active_model` ON `estimation_models` (`owner_id`) WHERE status='ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX `estimation_models_owner_id_model_version_unique` ON `estimation_models` (`owner_id`,`model_version`);--> statement-breakpoint
CREATE TABLE `estimation_owner_state` (
	`owner_id` text PRIMARY KEY,
	`dataset_revision` integer DEFAULT 0 NOT NULL,
	`active_model_id` text,
	`training_generation` integer DEFAULT 0 NOT NULL,
	`new_sample_count` integer DEFAULT 0 NOT NULL,
	`last_attempted_new_sample_count` integer DEFAULT 0 NOT NULL,
	`last_attempted_new_sample_sequence` integer DEFAULT 0 NOT NULL,
	`forced_retrain` integer DEFAULT 0 NOT NULL,
	`last_training_status` text DEFAULT 'IDLE' NOT NULL,
	`last_training_reason` text,
	`updated_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`owner_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`active_model_id`) REFERENCES `estimation_models`(`owner_id`,`model_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "atlm_owner_forced_retrain" CHECK(forced_retrain IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `estimation_samples` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`input_assessment_sequence` integer,
	`source_digest` text NOT NULL,
	`source_generation` integer NOT NULL,
	`eligibility` text NOT NULL,
	`reasons_json` text NOT NULL,
	`features_json` text,
	`issued_prediction_json` text,
	`actual_ms` integer,
	`captured_at` integer,
	`source_available_at` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`is_first_eligible` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`owner_id`,`plan_id`) REFERENCES `plans`(`owner_id`,`plan_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`plan_id`,`input_assessment_sequence`) REFERENCES `assessment_revisions`(`owner_id`,`plan_id`,`sequence`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "atlm_sample_eligibility" CHECK(eligibility IN ('ELIGIBLE','EXCLUDED')),
	CONSTRAINT "atlm_sample_reasons_json" CHECK(json_valid(reasons_json)),
	CONSTRAINT "atlm_sample_features_json" CHECK(features_json IS NULL OR json_valid(features_json)),
	CONSTRAINT "atlm_sample_prediction_json" CHECK(issued_prediction_json IS NULL OR json_valid(issued_prediction_json)),
	CONSTRAINT "atlm_sample_actual_ms" CHECK(actual_ms IS NULL OR (typeof(actual_ms)='integer' AND actual_ms>=0)),
	CONSTRAINT "atlm_sample_first_boolean" CHECK(is_first_eligible IN (0,1)),
	CONSTRAINT "atlm_sample_complete" CHECK(eligibility<>'ELIGIBLE' OR (features_json IS NOT NULL AND actual_ms IS NOT NULL AND captured_at IS NOT NULL AND input_assessment_sequence IS NOT NULL)),
	CONSTRAINT "atlm_sample_first_eligible" CHECK(is_first_eligible=0 OR eligibility='ELIGIBLE')
);
--> statement-breakpoint
CREATE INDEX `atlm_samples_latest` ON `estimation_samples` (`owner_id`,`plan_id`,sequence DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `atlm_sample_first_eligible` ON `estimation_samples` (`owner_id`,`plan_id`) WHERE is_first_eligible=1;--> statement-breakpoint
CREATE UNIQUE INDEX `estimation_samples_owner_id_sequence_unique` ON `estimation_samples` (`owner_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `estimation_samples_owner_id_plan_id_source_generation_unique` ON `estimation_samples` (`owner_id`,`plan_id`,`source_generation`);--> statement-breakpoint
CREATE TABLE `plan_estimation_inputs` (
	`owner_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`assessment_sequence` integer,
	`requirements_digest` text,
	`requirements_json` text NOT NULL,
	`first_started_at` integer NOT NULL,
	`captured_receipt_rowid` integer NOT NULL,
	`selection_status` text NOT NULL,
	PRIMARY KEY(`owner_id`, `plan_id`),
	FOREIGN KEY (`owner_id`,`plan_id`) REFERENCES `plans`(`owner_id`,`plan_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`plan_id`,`assessment_sequence`) REFERENCES `assessment_revisions`(`owner_id`,`plan_id`,`sequence`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "atlm_input_requirements_json" CHECK(json_valid(requirements_json)),
	CONSTRAINT "atlm_input_selection" CHECK(selection_status IN ('CAPTURED','MISSING_FEATURES')),
	CONSTRAINT "atlm_input_capture" CHECK((selection_status='CAPTURED' AND assessment_sequence IS NOT NULL AND requirements_digest IS NOT NULL) OR (selection_status='MISSING_FEATURES' AND assessment_sequence IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assessment_atlm_owner_sequence` ON `assessment_revisions` (`owner_id`,`plan_id`,`sequence`);
--> statement-breakpoint
-- Canonical trigger definitions from GitHub 0019_atlm.sql.
CREATE TRIGGER atlm_input_no_update BEFORE UPDATE ON plan_estimation_inputs BEGIN SELECT RAISE(ABORT,'ATLM_INPUT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER atlm_input_no_delete BEFORE DELETE ON plan_estimation_inputs BEGIN SELECT RAISE(ABORT,'ATLM_INPUT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER atlm_sample_no_update BEFORE UPDATE ON estimation_samples BEGIN SELECT RAISE(ABORT,'ATLM_SAMPLE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER atlm_sample_no_delete BEFORE DELETE ON estimation_samples BEGIN SELECT RAISE(ABORT,'ATLM_SAMPLE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER atlm_sample_owner_state AFTER INSERT ON estimation_samples BEGIN
 INSERT OR IGNORE INTO estimation_owner_state(owner_id) VALUES(NEW.owner_id);
 UPDATE estimation_owner_state SET dataset_revision=dataset_revision+1,
   new_sample_count=new_sample_count+NEW.is_first_eligible,updated_at=NEW.observed_at WHERE owner_id=NEW.owner_id;
END;
--> statement-breakpoint
CREATE TRIGGER atlm_model_artifact_immutable BEFORE UPDATE ON estimation_models
WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.model_id IS NOT OLD.model_id OR NEW.model_version IS NOT OLD.model_version
 OR NEW.artifact_json IS NOT OLD.artifact_json OR NEW.manifest_json IS NOT OLD.manifest_json OR NEW.dataset_digest IS NOT OLD.dataset_digest
 OR NEW.method_version IS NOT OLD.method_version OR NEW.feature_version IS NOT OLD.feature_version
 OR NEW.train_cutoff IS NOT OLD.train_cutoff OR NEW.metrics_json IS NOT OLD.metrics_json OR NEW.sample_count IS NOT OLD.sample_count OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'ATLM_MODEL_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER atlm_model_manifest_owner BEFORE INSERT ON estimation_models
WHEN EXISTS(SELECT 1 FROM json_each(NEW.manifest_json) m WHERE typeof(m.value)<>'integer' OR NOT EXISTS(
 SELECT 1 FROM estimation_samples s WHERE s.owner_id=NEW.owner_id AND s.sequence=m.value))
BEGIN SELECT RAISE(ABORT,'ATLM_MODEL_SOURCE_NOT_FOUND'); END;
--> statement-breakpoint
CREATE TRIGGER atlm_model_no_delete BEFORE DELETE ON estimation_models BEGIN SELECT RAISE(ABORT,'ATLM_MODEL_IMMUTABLE'); END;
--> statement-breakpoint
-- The revision must already exist in the transaction which applies the first StartPlan.
CREATE TRIGGER atlm_capture_first_start AFTER UPDATE OF first_started_at ON plans
WHEN OLD.first_started_at IS NULL AND NEW.first_started_at IS NOT NULL
BEGIN
 INSERT INTO plan_estimation_inputs(owner_id,plan_id,assessment_sequence,requirements_digest,requirements_json,first_started_at,captured_receipt_rowid,selection_status)
 SELECT NEW.owner_id,NEW.plan_id,a.sequence,a.requirements_digest,t.requirements_json,NEW.first_started_at,
   COALESCE((SELECT MAX(rowid) FROM command_receipts WHERE owner_id=NEW.owner_id),0),
   CASE WHEN a.sequence IS NULL THEN 'MISSING_FEATURES' ELSE 'CAPTURED' END
 FROM assessment_targets t LEFT JOIN assessment_revisions a ON a.sequence=(
   SELECT MAX(r.sequence) FROM assessment_revisions r WHERE r.owner_id=NEW.owner_id AND r.plan_id=NEW.plan_id AND r.step_id IS NULL
    AND json_extract(r.assessment_json,'$.context.agentTask.schemaVersion')='agent-task-v1' AND r.requirements_json=t.requirements_json)
 WHERE t.owner_id=NEW.owner_id AND t.plan_id=NEW.plan_id AND t.step_id IS NULL;
END;
--> statement-breakpoint
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
 UPDATE estimation_owner_state SET forced_retrain=1,updated_at=COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0)
 WHERE owner_id=NEW.owner_id AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=NEW.owner_id
   AND m.model_id=active_model_id AND m.status='INVALIDATED');
END;
--> statement-breakpoint
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
 UPDATE estimation_owner_state SET forced_retrain=1,updated_at=COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0)
 WHERE owner_id=NEW.owner_id AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=NEW.owner_id
   AND m.model_id=active_model_id AND m.status='INVALIDATED');
END;
--> statement-breakpoint
CREATE TRIGGER atlm_step_update AFTER UPDATE ON plan_steps
WHEN EXISTS(SELECT 1 FROM plans p WHERE p.owner_id=NEW.owner_id AND p.plan_id=NEW.plan_id AND p.first_started_at IS NOT NULL) AND (NEW.title IS NOT OLD.title OR NEW.expected_result IS NOT OLD.expected_result OR NEW.required_checks_json IS NOT OLD.required_checks_json OR NEW.ordinal IS NOT OLD.ordinal OR NEW.status IS NOT OLD.status OR NEW.current_result_revision IS NOT OLD.current_result_revision)
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
 UPDATE estimation_owner_state SET forced_retrain=1,updated_at=COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0)
 WHERE owner_id=NEW.owner_id AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=NEW.owner_id
   AND m.model_id=active_model_id AND m.status='INVALIDATED');
END;
--> statement-breakpoint
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
 UPDATE estimation_owner_state SET forced_retrain=1,updated_at=COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0)
 WHERE owner_id=NEW.owner_id AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=NEW.owner_id
   AND m.model_id=active_model_id AND m.status='INVALIDATED');
END;
--> statement-breakpoint
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
 UPDATE estimation_owner_state SET forced_retrain=1,updated_at=COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0)
 WHERE owner_id=NEW.owner_id AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=NEW.owner_id
   AND m.model_id=active_model_id AND m.status='INVALIDATED');
END;
--> statement-breakpoint
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
 UPDATE estimation_owner_state SET forced_retrain=1,updated_at=COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=OLD.owner_id),0)
 WHERE owner_id=OLD.owner_id AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=OLD.owner_id
   AND m.model_id=active_model_id AND m.status='INVALIDATED');
END;
--> statement-breakpoint
CREATE TRIGGER atlm_step_checks_insert AFTER INSERT ON step_checks
WHEN EXISTS(SELECT 1 FROM plans p WHERE p.owner_id=NEW.owner_id AND p.plan_id=(SELECT plan_id FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=NEW.step_id) AND p.first_started_at IS NOT NULL) AND EXISTS(SELECT 1 FROM plan_steps s,json_each(s.required_checks_json) r WHERE s.owner_id=NEW.owner_id AND s.step_id=NEW.step_id AND s.current_result_revision=NEW.result_revision AND r.value=NEW.check_key)
BEGIN
 INSERT OR IGNORE INTO estimation_owner_state(owner_id) VALUES(NEW.owner_id);
 INSERT INTO estimation_jobs(owner_id,job_key,kind,plan_id,generation,status,created_at,updated_at,source_changed_at)
 VALUES(NEW.owner_id,'refresh:'||(SELECT plan_id FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=NEW.step_id),'REFRESH_SAMPLE',(SELECT plan_id FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=NEW.step_id),1,'QUEUED',COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0))
 ON CONFLICT(owner_id,job_key) DO UPDATE SET generation=generation+1,
   status=CASE WHEN status='RUNNING' THEN status ELSE 'QUEUED' END,
   attempts=0,next_attempt_at=0,updated_at=excluded.updated_at,source_changed_at=excluded.source_changed_at;
 UPDATE estimation_models SET status='INVALIDATED',reason='SOURCE_CHANGED'
 WHERE owner_id=NEW.owner_id AND status='ACTIVE' AND EXISTS(
   SELECT 1 FROM json_each(estimation_models.manifest_json) m JOIN estimation_samples s
     ON s.owner_id=estimation_models.owner_id AND s.sequence=CAST(m.value AS INTEGER)
     WHERE s.plan_id=(SELECT plan_id FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=NEW.step_id));
 UPDATE estimation_owner_state SET forced_retrain=1,updated_at=COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0)
 WHERE owner_id=NEW.owner_id AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=NEW.owner_id
   AND m.model_id=active_model_id AND m.status='INVALIDATED');
END;
--> statement-breakpoint
CREATE TRIGGER atlm_step_source_checks_insert AFTER INSERT ON step_source_checks
WHEN EXISTS(SELECT 1 FROM plans p WHERE p.owner_id=NEW.owner_id AND p.plan_id=(SELECT plan_id FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=NEW.step_id) AND p.first_started_at IS NOT NULL) AND EXISTS(SELECT 1 FROM plan_steps s,json_each(s.required_checks_json) r WHERE s.owner_id=NEW.owner_id AND s.step_id=NEW.step_id AND s.current_result_revision=NEW.result_revision AND r.value=NEW.check_key)
BEGIN
 INSERT OR IGNORE INTO estimation_owner_state(owner_id) VALUES(NEW.owner_id);
 INSERT INTO estimation_jobs(owner_id,job_key,kind,plan_id,generation,status,created_at,updated_at,source_changed_at)
 VALUES(NEW.owner_id,'refresh:'||(SELECT plan_id FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=NEW.step_id),'REFRESH_SAMPLE',(SELECT plan_id FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=NEW.step_id),1,'QUEUED',COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0),COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0))
 ON CONFLICT(owner_id,job_key) DO UPDATE SET generation=generation+1,
   status=CASE WHEN status='RUNNING' THEN status ELSE 'QUEUED' END,
   attempts=0,next_attempt_at=0,updated_at=excluded.updated_at,source_changed_at=excluded.source_changed_at;
 UPDATE estimation_models SET status='INVALIDATED',reason='SOURCE_CHANGED'
 WHERE owner_id=NEW.owner_id AND status='ACTIVE' AND EXISTS(
   SELECT 1 FROM json_each(estimation_models.manifest_json) m JOIN estimation_samples s
     ON s.owner_id=estimation_models.owner_id AND s.sequence=CAST(m.value AS INTEGER)
     WHERE s.plan_id=(SELECT plan_id FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=NEW.step_id));
 UPDATE estimation_owner_state SET forced_retrain=1,updated_at=COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0)
 WHERE owner_id=NEW.owner_id AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=NEW.owner_id
   AND m.model_id=active_model_id AND m.status='INVALIDATED');
END;
