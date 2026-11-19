-- Application services now own command effects and transactional observers.
-- Historical rows and migrations remain intact; only active writer leases change.
DROP TRIGGER command_create_plan;
DROP TRIGGER command_start_plan;
DROP TRIGGER command_pause_plan;
DROP TRIGGER command_resume_plan;
DROP TRIGGER command_finish_plan;
DROP TRIGGER command_delete_plan;
DROP TRIGGER command_restore_plan;
DROP TRIGGER command_update_metadata;
DROP TRIGGER command_set_step_status;
DROP TRIGGER command_record_assessment;
DROP TRIGGER command_deleted_plan_guard;

DROP TRIGGER step_time_status;
DROP TRIGGER step_time_finish;

DROP TRIGGER atlm_capture_first_start;
DROP TRIGGER atlm_plan_source;
DROP TRIGGER atlm_step_insert;
DROP TRIGGER atlm_step_update;
DROP TRIGGER atlm_interval_insert;
DROP TRIGGER atlm_interval_update;
DROP TRIGGER atlm_interval_delete;
DROP TRIGGER atlm_sample_owner_state;
DROP TRIGGER atlm_new_owner_schema;
DROP TRIGGER atlm_v4_job_initial_fence;
DROP TRIGGER atlm_discard_checkpoint;

-- Old receipts must remain replayable. Every new application write carries a
-- server-generated execution nonce, also used to guard its batch's effects.
ALTER TABLE command_receipts ADD COLUMN execution_nonce TEXT;
CREATE TRIGGER command_application_writer BEFORE INSERT ON command_receipts
WHEN NEW.command_type IN (
  'CreatePlan','StartPlan','PausePlan','ResumePlan','FinishPlan',
  'DeletePlan','RestorePlan','UpdatePlanMetadata','SetStepStatus','RecordAssessment'
)
AND (typeof(NEW.execution_nonce)<>'text' OR length(NEW.execution_nonce)<>36)
BEGIN
  SELECT RAISE(ABORT,'APPLICATION_WRITER_REQUIRED');
END;

-- Initialization is explicit in the owner repository. Reject older Workers
-- instead of silently fixing their values or allowing partial ATLM writes.
CREATE TRIGGER atlm_owner_schema_required BEFORE INSERT ON estimation_owner_state
WHEN NEW.schema_version<>4
BEGIN
  SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED');
END;

-- Retire the previous executor protocol. A Worker holding a pre-migration lease
-- cannot persist a sample, publish a model, or release another executor's work.
DROP TRIGGER atlm_operations_claim;
DROP TRIGGER atlm_operations_release;
CREATE TRIGGER atlm_operations_claim BEFORE UPDATE OF fence ON estimation_jobs
WHEN NEW.status='RUNNING' AND NEW.fence<>OLD.fence
  AND NEW.executor_epoch<>OLD.executor_epoch+3
BEGIN
  SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED');
END;
CREATE TRIGGER atlm_operations_release BEFORE UPDATE OF status ON estimation_jobs
WHEN OLD.status='RUNNING' AND NEW.status<>'RUNNING'
  AND NEW.executor_epoch<>OLD.executor_epoch+3
BEGIN
  SELECT RAISE(ABORT,'ATLM_CLIENT_RETIRED');
END;

-- Preserve the bounded lease deadline and RUNNING state so normal expiry closes
-- the interrupted attempt's history and applies its retry budget. Requeueing a
-- fourth attempt without a checkpoint would leave an unclaimable job forever.
UPDATE estimation_jobs
SET fence=fence+1,executor_epoch=executor_epoch+3
WHERE status='RUNNING';
