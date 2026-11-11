-- Current step state replaces attempts and status event history.
-- Existing plans, source text, timer intervals, requirements and ATLM artifacts retain their identities.
PRAGMA defer_foreign_keys=ON;

DROP TRIGGER IF EXISTS "assessment_immutable_delete";

DROP TRIGGER IF EXISTS "assessment_immutable_update";

DROP TRIGGER IF EXISTS "atlm_capture_first_start";

DROP TRIGGER IF EXISTS "atlm_input_no_delete";

DROP TRIGGER IF EXISTS "atlm_input_no_update";

DROP TRIGGER IF EXISTS "atlm_interval_delete";

DROP TRIGGER IF EXISTS "atlm_interval_insert";

DROP TRIGGER IF EXISTS "atlm_interval_update";

DROP TRIGGER IF EXISTS "atlm_model_artifact_immutable";

DROP TRIGGER IF EXISTS "atlm_model_manifest_owner";

DROP TRIGGER IF EXISTS "atlm_model_no_delete";

DROP TRIGGER IF EXISTS "atlm_plan_source";

DROP TRIGGER IF EXISTS "atlm_sample_no_delete";

DROP TRIGGER IF EXISTS "atlm_sample_no_update";

DROP TRIGGER IF EXISTS "atlm_sample_owner_state";

DROP TRIGGER IF EXISTS "atlm_step_checks_insert";

DROP TRIGGER IF EXISTS "atlm_step_insert";

DROP TRIGGER IF EXISTS "atlm_step_source_checks_insert";

DROP TRIGGER IF EXISTS "atlm_step_update";

DROP TRIGGER IF EXISTS "command_append_observation";

DROP TRIGGER IF EXISTS "command_attach_plan_repository";

DROP TRIGGER IF EXISTS "command_block_step";

DROP TRIGGER IF EXISTS "command_claim_step_attempt";

DROP TRIGGER IF EXISTS "command_close_step_attempt";

DROP TRIGGER IF EXISTS "command_create_plan";

DROP TRIGGER IF EXISTS "command_create_plan_document";

DROP TRIGGER IF EXISTS "command_create_step";

DROP TRIGGER IF EXISTS "command_delete_plan";

DROP TRIGGER IF EXISTS "command_deleted_plan_guard";

DROP TRIGGER IF EXISTS "command_document_steps_guard";

DROP TRIGGER IF EXISTS "command_finish_plan";

DROP TRIGGER IF EXISTS "command_pause_plan";

DROP TRIGGER IF EXISTS "command_receipts_no_delete";

DROP TRIGGER IF EXISTS "command_record_assessment";

DROP TRIGGER IF EXISTS "command_record_check";

DROP TRIGGER IF EXISTS "command_record_step_result";

DROP TRIGGER IF EXISTS "command_renew_step_lease";

DROP TRIGGER IF EXISTS "command_restore_plan";

DROP TRIGGER IF EXISTS "command_resume_plan";

DROP TRIGGER IF EXISTS "command_review_commit";

DROP TRIGGER IF EXISTS "command_set_step_status";

DROP TRIGGER IF EXISTS "command_start_plan";

DROP TRIGGER IF EXISTS "command_start_step";

DROP TRIGGER IF EXISTS "command_update_metadata";

DROP TRIGGER IF EXISTS "command_update_step";

DROP TRIGGER IF EXISTS "historical_snapshot_kind";

DROP TRIGGER IF EXISTS "plan_events_immutable_delete";

DROP TRIGGER IF EXISTS "plan_events_immutable_update";

DROP TRIGGER IF EXISTS "step_acceptances_immutable_delete";

DROP TRIGGER IF EXISTS "step_acceptances_immutable_update";

DROP TRIGGER IF EXISTS "step_attempts_advance_fence";

DROP TRIGGER IF EXISTS "step_attempts_fence_guard";

DROP TRIGGER IF EXISTS "step_checks_immutable_delete";

DROP TRIGGER IF EXISTS "step_checks_immutable_update";

DROP TRIGGER IF EXISTS "step_result_snapshot_kind";

DROP TRIGGER IF EXISTS "step_result_snapshots_immutable_delete";

DROP TRIGGER IF EXISTS "step_result_snapshots_immutable_update";

DROP TRIGGER IF EXISTS "step_results_immutable_delete";

DROP TRIGGER IF EXISTS "step_results_immutable_update";

DROP TRIGGER IF EXISTS "step_results_revision_guard";

DROP TRIGGER IF EXISTS "step_snapshot_checks_immutable_delete";

DROP TRIGGER IF EXISTS "step_snapshot_checks_immutable_update";

DROP TRIGGER IF EXISTS "step_source_checks_immutable_delete";

DROP TRIGGER IF EXISTS "step_source_checks_immutable_update";

DROP TRIGGER IF EXISTS "step_source_snapshot_kind";

DROP TRIGGER IF EXISTS "step_source_snapshots_immutable_delete";

DROP TRIGGER IF EXISTS "step_source_snapshots_immutable_update";

DROP TRIGGER IF EXISTS "sync_execution_guard_current";

DROP TRIGGER IF EXISTS "tracker_finish_exceptions_immutable_delete";

DROP TRIGGER IF EXISTS "tracker_finish_exceptions_immutable_update";

DROP TRIGGER IF EXISTS "tracker_journal_advance_sequence";

DROP TRIGGER IF EXISTS "tracker_journal_immutable_delete";

DROP TRIGGER IF EXISTS "tracker_journal_immutable_update";

DROP TRIGGER IF EXISTS "tracker_journal_sequence_guard";

DROP TRIGGER IF EXISTS "tracker_owner_state_advance_guard";

DROP TRIGGER IF EXISTS "tracker_owner_state_no_delete";

DROP TRIGGER IF EXISTS "work_intervals_no_overlap_close";

DROP TRIGGER IF EXISTS "work_intervals_no_overlap_insert";

CREATE TABLE _saved_requirements AS SELECT * FROM assessment_targets;

CREATE TABLE _saved_steps AS SELECT s.owner_id,s.step_id,s.plan_id,s.ordinal,s.title,s.status,s.version,COALESCE(d.content,s.expected_result) AS content,s.created_at,s.updated_at FROM plan_steps s LEFT JOIN plan_document_sections d ON d.owner_id=s.owner_id AND d.step_id=s.step_id;

DROP VIEW "assessment_targets";

DROP VIEW "tracker_check_evidence";

DROP VIEW "tracker_checks_with_source";

DROP VIEW "tracker_incomplete_steps";

DROP VIEW "tracker_latest_checks";

DROP VIEW "tracker_result_sources";

DROP TABLE "step_source_checks";

DROP TABLE "step_source_snapshots";

DROP TABLE "step_snapshot_checks";

DROP TABLE "step_result_snapshots";

DROP TABLE "step_acceptances";

DROP TABLE "step_checks";

DROP TABLE "step_results";

DROP TABLE "tracker_journal";

DROP TABLE "step_attempts";

DROP TABLE "tracker_sessions";

DROP TABLE "tracker_owner_state";

DROP TABLE "tracker_plan_config";

DROP TABLE "plan_document_sections";

DROP TABLE "plan_commit_links";

DROP TABLE "commit_attribution_conflicts";

DROP TABLE "repository_ref_commits";

DROP TABLE "repository_sync_state";

DROP TABLE "sync_execution_guards";

DROP TABLE "plan_repositories";

DROP TABLE "commits";

DROP TABLE "repositories";

DROP TABLE "plan_events";

CREATE TABLE _plan_steps_new (
	`owner_id` text NOT NULL,
	`step_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `step_id`),
	FOREIGN KEY (`owner_id`,`plan_id`) REFERENCES `plans`(`owner_id`,`plan_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "plan_steps_ordinal" CHECK(typeof(ordinal)='integer' AND ordinal>=0),
	CONSTRAINT "plan_steps_title" CHECK(length(trim(title)) BETWEEN 1 AND 200),
	CONSTRAINT "plan_steps_status" CHECK(status IN ('PENDING','RUNNING','BLOCKED','FAILED','DONE')),
	CONSTRAINT "plan_steps_version" CHECK(typeof(version)='integer' AND version>=1),
	CONSTRAINT "plan_steps_time" CHECK(updated_at>=created_at)
);
INSERT INTO _plan_steps_new(owner_id,step_id,plan_id,ordinal,title,status,version,content,created_at,updated_at)
 SELECT owner_id,step_id,plan_id,ordinal,title,status,version,content,created_at,updated_at FROM _saved_steps;
DROP TABLE plan_steps;
ALTER TABLE _plan_steps_new RENAME TO plan_steps;
CREATE UNIQUE INDEX plan_steps_unique_1 ON plan_steps(owner_id,plan_id,step_id);
CREATE UNIQUE INDEX plan_steps_unique_2 ON plan_steps(owner_id,plan_id,ordinal);
DROP TABLE _saved_steps;
CREATE TABLE `assessment_targets` (
	`owner_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`step_id` text,
	`requirements_json` text NOT NULL,
	FOREIGN KEY (`owner_id`,`plan_id`) REFERENCES `plans`(`owner_id`,`plan_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`plan_id`,`step_id`) REFERENCES `plan_steps`(`owner_id`,`plan_id`,`step_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assessment_targets_json" CHECK(json_valid(requirements_json))
);
CREATE UNIQUE INDEX assessment_targets_plan ON assessment_targets(owner_id,plan_id) WHERE step_id IS NULL;
CREATE UNIQUE INDEX assessment_targets_step ON assessment_targets(owner_id,plan_id,step_id) WHERE step_id IS NOT NULL;
INSERT INTO assessment_targets SELECT * FROM _saved_requirements;
DROP TABLE _saved_requirements;
CREATE VIEW tracker_incomplete_steps AS
 SELECT owner_id,plan_id,step_id,ordinal,title,status,version FROM plan_steps WHERE status<>'DONE';
DELETE FROM command_receipts WHERE command_type NOT IN ('CreatePlan','StartPlan','PausePlan','ResumePlan','FinishPlan','UpdatePlanMetadata','DeletePlan','RestorePlan','SetStepStatus','RecordAssessment');
ALTER TABLE command_receipts DROP COLUMN execution_lease_until;
CREATE TABLE `__new_tracker_finish_exceptions` (
	`owner_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`command_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `command_id`),
	FOREIGN KEY (`owner_id`,`command_id`) REFERENCES `command_receipts`(`owner_id`,`command_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`plan_id`) REFERENCES `plans`(`owner_id`,`plan_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tracker_finish_exceptions_check_1" CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
	CONSTRAINT "tracker_finish_exceptions_check_3" CHECK(typeof(created_at)='integer' AND created_at >= 0)
);
INSERT INTO __new_tracker_finish_exceptions(owner_id,plan_id,command_id,reason,created_at) SELECT owner_id,plan_id,command_id,reason,created_at FROM tracker_finish_exceptions;
DROP TABLE tracker_finish_exceptions;
ALTER TABLE __new_tracker_finish_exceptions RENAME TO tracker_finish_exceptions;
UPDATE command_receipts SET payload_json='{}' WHERE command_type='SetStepStatus';

CREATE TRIGGER command_create_plan AFTER INSERT ON command_receipts
WHEN NEW.command_type='CreatePlan' AND NEW.outcome_code='PENDING'
BEGIN
 INSERT OR IGNORE INTO owners(owner_id,created_at) VALUES(NEW.owner_id,NEW.server_now_ms);
 INSERT OR IGNORE INTO plans(plan_id,owner_id,title,description,acceptance_criteria,plan_created_precision,plan_created_at_ms,plan_created_on,plan_created_timezone,registered_at,status,version,created_by,source_reference)
 VALUES(NEW.plan_id,NEW.owner_id,json_extract(NEW.payload_json,'$.title'),COALESCE(json_extract(NEW.payload_json,'$.description'),''),COALESCE(json_extract(NEW.payload_json,'$.acceptanceCriteria'),''),json_extract(NEW.payload_json,'$.planCreatedAt.precision'),json_extract(NEW.payload_json,'$.planCreatedAt.atMs'),json_extract(NEW.payload_json,'$.planCreatedAt.on'),json_extract(NEW.payload_json,'$.planCreatedAt.timeZone'),NEW.server_now_ms,'PLANNED',0,NEW.actor_id,json_extract(NEW.payload_json,'$.sourceReference'));
 UPDATE command_receipts SET outcome_code=CASE WHEN changes()=1 THEN 'OK' ELSE 'VALIDATION_ERROR' END,result_version=0,
 result_json=json_object('planId',NEW.plan_id,'status','PLANNED','version',0,'registeredAt',NEW.server_now_ms,'serverNow',NEW.server_now_ms)
 WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
 INSERT INTO plan_documents(owner_id,plan_id,markdown)
 SELECT NEW.owner_id,NEW.plan_id,json_extract(NEW.payload_json,'$.planText') WHERE json_type(NEW.payload_json,'$.planText')='text' AND EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
 INSERT INTO plan_steps(owner_id,plan_id,step_id,ordinal,title,content,created_at,updated_at)
 SELECT NEW.owner_id,NEW.plan_id,json_extract(value,'$.stepId'),json_extract(value,'$.ordinal'),json_extract(value,'$.title'),json_extract(value,'$.content'),NEW.server_now_ms,NEW.server_now_ms FROM json_each(NEW.payload_json,'$.documentSteps') WHERE EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
 INSERT INTO assessment_targets(owner_id,plan_id,step_id,requirements_json)
 SELECT NEW.owner_id,NEW.plan_id,json_extract(value,'$.stepId'),json_extract(value,'$.requirementsJson') FROM json_each(NEW.payload_json,'$.requirementsTargets') WHERE EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
END;

CREATE TRIGGER command_start_plan AFTER INSERT ON command_receipts WHEN NEW.command_type='StartPlan' AND NEW.outcome_code='PENDING'
BEGIN
 UPDATE plans SET status='RUNNING',version=version+1,first_started_at=NEW.server_now_ms WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND version=NEW.expected_version AND status='PLANNED' AND deleted_at IS NULL;
 UPDATE command_receipts SET outcome_code=CASE
 WHEN changes()=1 THEN 'OK'
 WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
 WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
 
 ELSE 'INVALID_TRANSITION' END,
 result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
 result_json=COALESCE((SELECT json_object('planId',plan_id,'status',status,'version',version,'currentVersion',version,'serverNow',NEW.server_now_ms,'firstStartedAt',first_started_at,'finishedAt',finished_at,'deletedAt',deleted_at) FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),json_object('serverNow',NEW.server_now_ms))
 WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
 INSERT INTO work_intervals(interval_id,owner_id,plan_id,start_ms,end_ms,opened_by,closed_by) SELECT lower(hex(randomblob(16))),NEW.owner_id,NEW.plan_id,NEW.server_now_ms,NULL,NEW.actor_id,NULL WHERE EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
END;

CREATE TRIGGER command_pause_plan AFTER INSERT ON command_receipts WHEN NEW.command_type='PausePlan' AND NEW.outcome_code='PENDING'
BEGIN
 UPDATE plans SET status='PAUSED',version=version+1 WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND version=NEW.expected_version AND status='RUNNING' AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM work_intervals WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL);
 UPDATE command_receipts SET outcome_code=CASE
 WHEN changes()=1 THEN 'OK'
 WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
 WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
 
 ELSE 'INVALID_TRANSITION' END,
 result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
 result_json=COALESCE((SELECT json_object('planId',plan_id,'status',status,'version',version,'currentVersion',version,'serverNow',NEW.server_now_ms,'firstStartedAt',first_started_at,'finishedAt',finished_at,'deletedAt',deleted_at) FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),json_object('serverNow',NEW.server_now_ms))
 WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
 UPDATE work_intervals SET end_ms=NEW.server_now_ms,closed_by=NEW.actor_id WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL AND EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
END;

CREATE TRIGGER command_resume_plan AFTER INSERT ON command_receipts WHEN NEW.command_type='ResumePlan' AND NEW.outcome_code='PENDING'
BEGIN
 UPDATE plans SET status='RUNNING',version=version+1 WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND version=NEW.expected_version AND status='PAUSED' AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM work_intervals WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NOT NULL);
 UPDATE command_receipts SET outcome_code=CASE
 WHEN changes()=1 THEN 'OK'
 WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
 WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
 
 ELSE 'INVALID_TRANSITION' END,
 result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
 result_json=COALESCE((SELECT json_object('planId',plan_id,'status',status,'version',version,'currentVersion',version,'serverNow',NEW.server_now_ms,'firstStartedAt',first_started_at,'finishedAt',finished_at,'deletedAt',deleted_at) FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),json_object('serverNow',NEW.server_now_ms))
 WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
 INSERT INTO work_intervals(interval_id,owner_id,plan_id,start_ms,end_ms,opened_by,closed_by) SELECT lower(hex(randomblob(16))),NEW.owner_id,NEW.plan_id,NEW.server_now_ms,NULL,NEW.actor_id,NULL WHERE EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
END;

CREATE TRIGGER command_finish_plan AFTER INSERT ON command_receipts WHEN NEW.command_type='FinishPlan' AND NEW.outcome_code='PENDING'
BEGIN
 INSERT INTO tracker_finish_exceptions(owner_id,plan_id,command_id,reason,created_at)
 SELECT NEW.owner_id,NEW.plan_id,NEW.command_id,trim(json_extract(NEW.payload_json,'$.reason')),
 NEW.server_now_ms
 WHERE json_extract(NEW.payload_json,'$.allowIncomplete')=1 AND length(trim(COALESCE(json_extract(NEW.payload_json,'$.reason'),''))) BETWEEN 1 AND 1000
 AND EXISTS(SELECT 1 FROM tracker_incomplete_steps WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)
 AND EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND version=NEW.expected_version AND status IN ('RUNNING','PAUSED') AND deleted_at IS NULL AND ((status='RUNNING' AND EXISTS(SELECT 1 FROM work_intervals WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL)) OR (status='PAUSED' AND NOT EXISTS(SELECT 1 FROM work_intervals WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL))));
 UPDATE plans SET status='COMPLETED',finished_at=NEW.server_now_ms,version=version+1
 WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND version=NEW.expected_version AND status IN ('RUNNING','PAUSED') AND deleted_at IS NULL
 AND ((status='RUNNING' AND EXISTS(SELECT 1 FROM work_intervals WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL)) OR (status='PAUSED' AND NOT EXISTS(SELECT 1 FROM work_intervals WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL)))
 AND (NOT EXISTS(SELECT 1 FROM tracker_incomplete_steps WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) OR EXISTS(SELECT 1 FROM tracker_finish_exceptions WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id));
 UPDATE command_receipts SET outcome_code=CASE
 WHEN changes()=1 THEN 'OK'
 WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
 WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
 WHEN EXISTS(SELECT 1 FROM tracker_incomplete_steps WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) AND (SELECT status FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) IN ('RUNNING','PAUSED') THEN 'CHECKPOINTS_INCOMPLETE'
 ELSE 'INVALID_TRANSITION' END,
 result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
 result_json=COALESCE((SELECT json_object('planId',plan_id,'status',status,'version',version,'currentVersion',version,'serverNow',NEW.server_now_ms,'firstStartedAt',first_started_at,'finishedAt',finished_at,'deletedAt',deleted_at) FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),json_object('serverNow',NEW.server_now_ms))
 WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
 UPDATE command_receipts SET result_json=json_set(result_json,'$.exceptionId',(SELECT command_id FROM tracker_finish_exceptions WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id),'$.incompleteCount',(SELECT COUNT(*) FROM tracker_incomplete_steps WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)) WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK';
 UPDATE work_intervals SET end_ms=NEW.server_now_ms,closed_by=NEW.actor_id WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL AND EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
END;

CREATE TRIGGER command_delete_plan AFTER INSERT ON command_receipts WHEN NEW.command_type='DeletePlan' AND NEW.outcome_code='PENDING'
BEGIN
 UPDATE plans SET deleted_at=NEW.server_now_ms,status=CASE WHEN status='RUNNING' THEN 'PAUSED' ELSE status END,version=version+1 WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND version=NEW.expected_version AND deleted_at IS NULL;
 UPDATE command_receipts SET outcome_code=CASE
 WHEN changes()=1 THEN 'OK'
 WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
 WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
 WHEN (SELECT deleted_at FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) IS NOT NULL THEN 'PLAN_DELETED'
 ELSE 'INVALID_TRANSITION' END,
 result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
 result_json=COALESCE((SELECT json_object('planId',plan_id,'status',status,'version',version,'currentVersion',version,'serverNow',NEW.server_now_ms,'firstStartedAt',first_started_at,'finishedAt',finished_at,'deletedAt',deleted_at) FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),json_object('serverNow',NEW.server_now_ms))
 WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
 UPDATE work_intervals SET end_ms=MAX(start_ms,NEW.server_now_ms),closed_by=NEW.actor_id WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL AND EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
 UPDATE plan_steps SET status='BLOCKED',version=version+1,updated_at=NEW.server_now_ms WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND status='RUNNING' AND EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
END;

CREATE TRIGGER command_restore_plan AFTER INSERT ON command_receipts WHEN NEW.command_type='RestorePlan' AND NEW.outcome_code='PENDING'
BEGIN
 UPDATE plans SET deleted_at=NULL,version=version+1 WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND version=NEW.expected_version AND deleted_at IS NOT NULL;
 UPDATE command_receipts SET outcome_code=CASE
 WHEN changes()=1 THEN 'OK'
 WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
 WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
 WHEN (SELECT deleted_at FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) IS NULL THEN 'PLAN_NOT_DELETED'
 ELSE 'INVALID_TRANSITION' END,
 result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
 result_json=COALESCE((SELECT json_object('planId',plan_id,'status',status,'version',version,'currentVersion',version,'serverNow',NEW.server_now_ms,'firstStartedAt',first_started_at,'finishedAt',finished_at,'deletedAt',deleted_at) FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),json_object('serverNow',NEW.server_now_ms))
 WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

CREATE TRIGGER command_update_metadata AFTER INSERT ON command_receipts
WHEN NEW.command_type='UpdatePlanMetadata' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT INTO plan_date_history(history_id, owner_id, plan_id, old_precision, old_at_ms, old_on,
                                old_timezone, changed_at, changed_by, reason)
  SELECT lower(hex(randomblob(16))), owner_id, plan_id, plan_created_precision, plan_created_at_ms,
         plan_created_on, plan_created_timezone, NEW.server_now_ms, NEW.actor_id,
         COALESCE(json_extract(NEW.payload_json,'$.reason'),'')
    FROM plans
   WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND version=NEW.expected_version
     AND (json_type(NEW.payload_json,'$.planCreatedAt') IS NOT NULL)
     AND (plan_created_precision<>json_extract(NEW.payload_json,'$.planCreatedAt.precision')
       OR plan_created_at_ms IS NOT json_extract(NEW.payload_json,'$.planCreatedAt.atMs')
       OR plan_created_on IS NOT json_extract(NEW.payload_json,'$.planCreatedAt.on')
       OR plan_created_timezone<>json_extract(NEW.payload_json,'$.planCreatedAt.timeZone'))
     AND (json_type(NEW.payload_json,'$.planCreatedAt.precision') IS NULL OR status='PLANNED'
       OR json_extract(NEW.payload_json,'$.dateAfterStart')<>1
       OR json_extract(NEW.payload_json,'$.confirmDateAnomaly')=1)
     AND (first_started_at IS NULL OR json_type(NEW.payload_json,'$.planCreatedAt.precision') IS NULL
       OR json_extract(NEW.payload_json,'$.dateAfterStart')<>1
       OR json_extract(NEW.payload_json,'$.confirmDateAnomaly')=1);
  UPDATE plans SET
    title=CASE WHEN json_type(NEW.payload_json,'$.title') IS NULL THEN title ELSE json_extract(NEW.payload_json,'$.title') END,
    description=CASE WHEN json_type(NEW.payload_json,'$.description') IS NULL THEN description ELSE COALESCE(json_extract(NEW.payload_json,'$.description'),'') END,
    acceptance_criteria=CASE WHEN json_type(NEW.payload_json,'$.acceptanceCriteria') IS NULL THEN acceptance_criteria ELSE COALESCE(json_extract(NEW.payload_json,'$.acceptanceCriteria'),'') END,
    plan_created_precision=CASE WHEN json_type(NEW.payload_json,'$.planCreatedAt.precision') IS NULL THEN plan_created_precision ELSE json_extract(NEW.payload_json,'$.planCreatedAt.precision') END,
    plan_created_at_ms=CASE WHEN json_type(NEW.payload_json,'$.planCreatedAt.precision') IS NULL THEN plan_created_at_ms ELSE json_extract(NEW.payload_json,'$.planCreatedAt.atMs') END,
    plan_created_on=CASE WHEN json_type(NEW.payload_json,'$.planCreatedAt.precision') IS NULL THEN plan_created_on ELSE json_extract(NEW.payload_json,'$.planCreatedAt.on') END,
    plan_created_timezone=CASE WHEN json_type(NEW.payload_json,'$.planCreatedAt.timeZone') IS NULL THEN plan_created_timezone ELSE json_extract(NEW.payload_json,'$.planCreatedAt.timeZone') END,
    version=version+1
   WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND version=NEW.expected_version
     AND (json_type(NEW.payload_json,'$.planCreatedAt.precision') IS NULL OR status='PLANNED'
       OR json_extract(NEW.payload_json,'$.dateAfterStart')<>1
       OR json_extract(NEW.payload_json,'$.confirmDateAnomaly')=1)
     AND (first_started_at IS NULL OR json_type(NEW.payload_json,'$.planCreatedAt.precision') IS NULL
       OR json_extract(NEW.payload_json,'$.dateAfterStart')<>1
       OR json_extract(NEW.payload_json,'$.confirmDateAnomaly')=1);
UPDATE command_receipts SET outcome_code=CASE
 WHEN changes()=1 THEN 'OK'
 WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
 WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
 WHEN json_extract(NEW.payload_json,'$.dateAfterStart')=1 AND COALESCE(json_extract(NEW.payload_json,'$.confirmDateAnomaly'),0)<>1 THEN 'VALIDATION_ERROR'
 ELSE 'INVALID_TRANSITION' END,
 result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
 result_json=COALESCE((SELECT json_object('planId',plan_id,'status',status,'version',version,'currentVersion',version,'serverNow',NEW.server_now_ms,'firstStartedAt',first_started_at,'finishedAt',finished_at,'deletedAt',deleted_at) FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),json_object('serverNow',NEW.server_now_ms))
 WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
 UPDATE assessment_targets SET requirements_json=(SELECT json_extract(value,'$.requirementsJson') FROM json_each(NEW.payload_json,'$.requirementsTargets') WHERE json_extract(value,'$.stepId') IS assessment_targets.step_id) WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
END;

CREATE TRIGGER command_set_step_status AFTER INSERT ON command_receipts WHEN NEW.command_type='SetStepStatus' AND NEW.outcome_code='PENDING'
BEGIN
 UPDATE plan_steps SET status=json_extract(NEW.payload_json,'$.status'),version=version+1,updated_at=NEW.server_now_ms
 WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND version=NEW.expected_version
 AND EXISTS(SELECT 1 FROM plans p WHERE p.owner_id=NEW.owner_id AND p.plan_id=plan_steps.plan_id AND p.status='RUNNING' AND p.deleted_at IS NULL);
 UPDATE command_receipts SET outcome_code=CASE
 WHEN changes()=1 THEN 'OK'
 WHEN NOT EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')) THEN 'STEP_NOT_FOUND'
 WHEN (SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'))<>NEW.expected_version THEN 'VERSION_CONFLICT'
 WHEN EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND status='PAUSED') THEN 'PLAN_PAUSED'
 ELSE 'INVALID_TRANSITION' END,
 result_version=(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
 result_json=COALESCE((SELECT json_object('planId',plan_id,'status',status,'version',version,'currentVersion',version,'serverNow',NEW.server_now_ms,'stepId',step_id) FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),json_object('serverNow',NEW.server_now_ms))
 WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
 UPDATE command_receipts SET payload_json='{}' WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

CREATE TRIGGER command_record_assessment AFTER INSERT ON command_receipts
WHEN NEW.command_type='RecordAssessment' AND NEW.outcome_code='PENDING'
BEGIN
 INSERT INTO assessment_revisions(owner_id,assessment_id,revision,previous_revision,plan_id,step_id,
   author_id,recorded_at,command_id,requirements_json,requirements_digest,assessment_json)
 SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.assessmentId'),NEW.expected_version+1,
   CASE WHEN NEW.expected_version=0 THEN NULL ELSE NEW.expected_version END,
   NEW.plan_id,json_extract(NEW.payload_json,'$.stepId'),NEW.actor_id,NEW.server_now_ms,NEW.command_id,
   json_extract(NEW.payload_json,'$.requirementsJson'),json_extract(NEW.payload_json,'$.requirementsDigest'),
   json_extract(NEW.payload_json,'$.assessmentJson')
 WHERE EXISTS(SELECT 1 FROM plans p WHERE p.owner_id=NEW.owner_id AND p.plan_id=NEW.plan_id AND p.deleted_at IS NULL)
   AND EXISTS(SELECT 1 FROM assessment_targets t WHERE t.owner_id=NEW.owner_id AND t.plan_id=NEW.plan_id
     AND t.step_id IS json_extract(NEW.payload_json,'$.stepId')
     AND t.requirements_json=json_extract(NEW.payload_json,'$.requirementsJson'))
   AND json_extract(NEW.payload_json,'$.expectedRequirementsDigest')=json_extract(NEW.payload_json,'$.requirementsDigest')
   AND COALESCE((SELECT MAX(a.revision) FROM assessment_revisions a WHERE a.owner_id=NEW.owner_id
     AND a.assessment_id=json_extract(NEW.payload_json,'$.assessmentId')),0)=NEW.expected_version
   AND NOT EXISTS(SELECT 1 FROM assessment_revisions a WHERE a.owner_id=NEW.owner_id
     AND a.assessment_id=json_extract(NEW.payload_json,'$.assessmentId')
     AND (a.plan_id<>NEW.plan_id OR a.step_id IS NOT json_extract(NEW.payload_json,'$.stepId')))
   AND NOT EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.sources') src
     WHERE NOT EXISTS(SELECT 1 FROM assessment_targets t WHERE t.owner_id=NEW.owner_id
       AND t.plan_id=json_extract(src.value,'$.planId') AND t.step_id IS json_extract(src.value,'$.stepId')));


 UPDATE command_receipts SET outcome_code=CASE
   WHEN EXISTS(SELECT 1 FROM assessment_revisions WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
   WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
   WHEN json_extract(NEW.payload_json,'$.stepId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assessment_targets t
     WHERE t.owner_id=NEW.owner_id AND t.plan_id=NEW.plan_id AND t.step_id=json_extract(NEW.payload_json,'$.stepId')) THEN 'STEP_NOT_FOUND'
   WHEN EXISTS(SELECT 1 FROM assessment_revisions WHERE owner_id=NEW.owner_id AND assessment_id=json_extract(NEW.payload_json,'$.assessmentId')
     AND (plan_id<>NEW.plan_id OR step_id IS NOT json_extract(NEW.payload_json,'$.stepId'))) THEN 'ASSESSMENT_TARGET_CONFLICT'
   WHEN COALESCE((SELECT MAX(revision) FROM assessment_revisions WHERE owner_id=NEW.owner_id
     AND assessment_id=json_extract(NEW.payload_json,'$.assessmentId')),0)<>NEW.expected_version THEN 'VERSION_CONFLICT'
   WHEN json_extract(NEW.payload_json,'$.expectedRequirementsDigest') IS NOT json_extract(NEW.payload_json,'$.requirementsDigest')
     OR NOT EXISTS(SELECT 1 FROM assessment_targets t WHERE t.owner_id=NEW.owner_id AND t.plan_id=NEW.plan_id
       AND t.step_id IS json_extract(NEW.payload_json,'$.stepId') AND t.requirements_json=json_extract(NEW.payload_json,'$.requirementsJson')) THEN 'ASSESSMENT_CONTEXT_CHANGED'
   ELSE 'ASSESSMENT_SOURCE_NOT_FOUND' END,
 result_version=COALESCE((SELECT MAX(revision) FROM assessment_revisions WHERE owner_id=NEW.owner_id
   AND assessment_id=json_extract(NEW.payload_json,'$.assessmentId')),0),
 result_json=CASE WHEN EXISTS(SELECT 1 FROM assessment_revisions WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
   THEN (SELECT json_object('assessmentId',assessment_id,'revision',revision,'previousRevision',previous_revision,
     'planId',plan_id,'stepId',step_id,'requirementsDigest',requirements_digest,'sequence',sequence,'serverNow',NEW.server_now_ms)
     FROM assessment_revisions WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
   ELSE json_object('serverNow',NEW.server_now_ms) END
 WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

CREATE TRIGGER command_deleted_plan_guard BEFORE INSERT ON command_receipts
WHEN NEW.outcome_code='PENDING' AND NEW.command_type NOT IN ('DeletePlan','RestorePlan')
 AND EXISTS(SELECT 1 FROM plans p WHERE p.owner_id=NEW.owner_id AND p.deleted_at IS NOT NULL
   AND (p.plan_id=NEW.plan_id OR p.plan_id=(SELECT s.plan_id FROM plan_steps s
     WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId'))))
BEGIN
  INSERT OR IGNORE INTO command_receipts(owner_id,command_id,payload_hash,command_type,plan_id,expected_version,
    server_now_ms,actor_id,actor_type,payload_json,outcome_code,result_version,result_json,recorded_at)
  SELECT NEW.owner_id,NEW.command_id,NEW.payload_hash,NEW.command_type,p.plan_id,NEW.expected_version,
    NEW.server_now_ms,NEW.actor_id,NEW.actor_type,NEW.payload_json,'PLAN_DELETED',p.version,
    json_object('error','PLAN_DELETED','planId',p.plan_id,'serverNow',NEW.server_now_ms),NEW.recorded_at
  FROM plans p WHERE p.owner_id=NEW.owner_id AND p.deleted_at IS NOT NULL
    AND (p.plan_id=NEW.plan_id OR p.plan_id=(SELECT s.plan_id FROM plan_steps s
      WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')))
  LIMIT 1;
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER assessment_immutable_delete BEFORE DELETE ON assessment_revisions
BEGIN SELECT RAISE(ABORT,'ASSESSMENT_IMMUTABLE'); END;

CREATE TRIGGER assessment_immutable_update BEFORE UPDATE ON assessment_revisions
BEGIN SELECT RAISE(ABORT,'ASSESSMENT_IMMUTABLE'); END;

CREATE TRIGGER tracker_finish_exceptions_immutable_delete BEFORE DELETE ON tracker_finish_exceptions
BEGIN SELECT RAISE(ABORT, 'TRACKER_FINISH_EXCEPTIONS_ARE_IMMUTABLE'); END;

CREATE TRIGGER tracker_finish_exceptions_immutable_update BEFORE UPDATE ON tracker_finish_exceptions
BEGIN SELECT RAISE(ABORT, 'TRACKER_FINISH_EXCEPTIONS_ARE_IMMUTABLE'); END;

CREATE TRIGGER command_receipts_no_delete BEFORE DELETE ON command_receipts
BEGIN SELECT RAISE(ABORT, 'COMMAND_RECEIPTS_ARE_RETAINED'); END;

CREATE TRIGGER work_intervals_no_overlap_close
BEFORE UPDATE OF end_ms ON work_intervals
WHEN NEW.end_ms IS NOT NULL AND EXISTS (
  SELECT 1 FROM work_intervals old
   WHERE old.owner_id=NEW.owner_id AND old.plan_id=NEW.plan_id AND old.interval_id<>NEW.interval_id
     AND NEW.start_ms < COALESCE(old.end_ms, 9223372036854775807)
     AND NEW.end_ms > old.start_ms
)
BEGIN
  SELECT RAISE(ABORT, 'WORK_INTERVAL_OVERLAP');
END;

CREATE TRIGGER work_intervals_no_overlap_insert
BEFORE INSERT ON work_intervals
WHEN EXISTS (
  SELECT 1 FROM work_intervals old
   WHERE old.owner_id=NEW.owner_id AND old.plan_id=NEW.plan_id
     AND NEW.start_ms < COALESCE(old.end_ms, 9223372036854775807)
     AND COALESCE(NEW.end_ms, 9223372036854775807) > old.start_ms
)
BEGIN
  SELECT RAISE(ABORT, 'WORK_INTERVAL_OVERLAP');
END;

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

CREATE TRIGGER atlm_input_no_delete BEFORE DELETE ON plan_estimation_inputs BEGIN SELECT RAISE(ABORT,'ATLM_INPUT_IMMUTABLE'); END;

CREATE TRIGGER atlm_input_no_update BEFORE UPDATE ON plan_estimation_inputs BEGIN SELECT RAISE(ABORT,'ATLM_INPUT_IMMUTABLE'); END;

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

CREATE TRIGGER atlm_model_artifact_immutable BEFORE UPDATE ON estimation_models
WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.model_id IS NOT OLD.model_id OR NEW.model_version IS NOT OLD.model_version
 OR NEW.artifact_json IS NOT OLD.artifact_json OR NEW.manifest_json IS NOT OLD.manifest_json OR NEW.dataset_digest IS NOT OLD.dataset_digest
 OR NEW.method_version IS NOT OLD.method_version OR NEW.feature_version IS NOT OLD.feature_version
 OR NEW.train_cutoff IS NOT OLD.train_cutoff OR NEW.metrics_json IS NOT OLD.metrics_json OR NEW.sample_count IS NOT OLD.sample_count OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'ATLM_MODEL_IMMUTABLE'); END;

CREATE TRIGGER atlm_model_manifest_owner BEFORE INSERT ON estimation_models
WHEN EXISTS(SELECT 1 FROM json_each(NEW.manifest_json) m WHERE typeof(m.value)<>'integer' OR NOT EXISTS(
 SELECT 1 FROM estimation_samples s WHERE s.owner_id=NEW.owner_id AND s.sequence=m.value))
BEGIN SELECT RAISE(ABORT,'ATLM_MODEL_SOURCE_NOT_FOUND'); END;

CREATE TRIGGER atlm_model_no_delete BEFORE DELETE ON estimation_models BEGIN SELECT RAISE(ABORT,'ATLM_MODEL_IMMUTABLE'); END;

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

CREATE TRIGGER atlm_sample_no_delete BEFORE DELETE ON estimation_samples BEGIN SELECT RAISE(ABORT,'ATLM_SAMPLE_IMMUTABLE'); END;

CREATE TRIGGER atlm_sample_no_update BEFORE UPDATE ON estimation_samples BEGIN SELECT RAISE(ABORT,'ATLM_SAMPLE_IMMUTABLE'); END;

CREATE TRIGGER atlm_sample_owner_state AFTER INSERT ON estimation_samples BEGIN
 INSERT OR IGNORE INTO estimation_owner_state(owner_id) VALUES(NEW.owner_id);
 UPDATE estimation_owner_state SET dataset_revision=dataset_revision+1,
   new_sample_count=new_sample_count+NEW.is_first_eligible,updated_at=NEW.observed_at WHERE owner_id=NEW.owner_id;
END;

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
 UPDATE estimation_owner_state SET forced_retrain=1,updated_at=COALESCE((SELECT MAX(server_now_ms) FROM command_receipts WHERE owner_id=NEW.owner_id),0)
 WHERE owner_id=NEW.owner_id AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=NEW.owner_id
   AND m.model_id=active_model_id AND m.status='INVALIDATED');
END;

PRAGMA defer_foreign_keys=OFF;
