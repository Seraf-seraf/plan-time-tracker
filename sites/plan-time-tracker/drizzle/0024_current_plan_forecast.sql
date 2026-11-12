-- Preserve original assessment revisions and existing first-start inputs.
ALTER TABLE plan_estimation_inputs ADD COLUMN forecast_json TEXT
 CHECK(forecast_json IS NULL OR (json_valid(forecast_json) AND json_type(forecast_json)='object'));

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
     AND r.step_id IS NULL AND json_extract(r.assessment_json,'$.context.agentTask.schemaVersion')='agent-task-v1'
     AND r.requirements_json=t.requirements_json) END
 WHERE t.owner_id=NEW.owner_id AND t.plan_id=NEW.plan_id AND t.step_id IS NULL;
END;
