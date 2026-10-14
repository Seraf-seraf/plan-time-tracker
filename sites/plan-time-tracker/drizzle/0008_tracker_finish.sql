CREATE TABLE tracker_finish_exceptions (
  owner_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) <= 200000 AND json_valid(snapshot_json) AND json_type(snapshot_json)='array'),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at >= 0),
  PRIMARY KEY(owner_id, command_id),
  FOREIGN KEY(owner_id, plan_id) REFERENCES plans(owner_id, plan_id),
  FOREIGN KEY(owner_id, command_id) REFERENCES command_receipts(owner_id, command_id)
);

CREATE TRIGGER tracker_finish_exceptions_immutable_update BEFORE UPDATE ON tracker_finish_exceptions
BEGIN SELECT RAISE(ABORT, 'TRACKER_FINISH_EXCEPTIONS_ARE_IMMUTABLE'); END;
CREATE TRIGGER tracker_finish_exceptions_immutable_delete BEFORE DELETE ON tracker_finish_exceptions
BEGIN SELECT RAISE(ABORT, 'TRACKER_FINISH_EXCEPTIONS_ARE_IMMUTABLE'); END;

DROP TRIGGER command_finish_plan;
CREATE TRIGGER command_finish_plan AFTER INSERT ON command_receipts
WHEN NEW.command_type='FinishPlan' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT INTO tracker_finish_exceptions(owner_id,plan_id,command_id,reason,snapshot_json,created_at)
  SELECT NEW.owner_id,NEW.plan_id,NEW.command_id,trim(json_extract(NEW.payload_json,'$.reason')),
    COALESCE((SELECT json_group_array(json_object(
      'stepId',step_id,'ordinal',ordinal,'status',status,'version',version,
      'currentResultRevision',current_result_revision,'acceptanceRevision',acceptance_revision,
      'acceptanceDecision',acceptance_decision,'currentFence',current_fence))
      FROM tracker_incomplete_steps WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),'[]'),NEW.server_now_ms
   WHERE json_extract(NEW.payload_json,'$.allowIncomplete')=1
     AND length(trim(COALESCE(json_extract(NEW.payload_json,'$.reason'),''))) BETWEEN 1 AND 1000
     AND EXISTS(SELECT 1 FROM tracker_plan_config c WHERE c.owner_id=NEW.owner_id AND c.plan_id=NEW.plan_id
       AND c.enabled=1 AND c.finish_policy='ALLOW_EXPLICIT_EXCEPTION')
     AND EXISTS(SELECT 1 FROM tracker_incomplete_steps WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)
     AND EXISTS(SELECT 1 FROM plans p WHERE p.owner_id=NEW.owner_id AND p.plan_id=NEW.plan_id
       AND p.version=NEW.expected_version AND p.status IN ('RUNNING','PAUSED'));

  INSERT OR IGNORE INTO tracker_owner_state(owner_id,next_sequence)
  SELECT NEW.owner_id,1 WHERE EXISTS(SELECT 1 FROM tracker_plan_config WHERE owner_id=NEW.owner_id
    AND plan_id=NEW.plan_id AND enabled=1);

  UPDATE plans SET status='COMPLETED', finished_at=NEW.server_now_ms, version=version+1
   WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND version=NEW.expected_version
     AND ((status='RUNNING' AND EXISTS(SELECT 1 FROM work_intervals WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL))
       OR (status='PAUSED' AND NOT EXISTS(SELECT 1 FROM work_intervals WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL)))
     AND (NOT EXISTS(SELECT 1 FROM tracker_plan_config c WHERE c.owner_id=NEW.owner_id AND c.plan_id=NEW.plan_id AND c.enabled=1)
       OR NOT EXISTS(SELECT 1 FROM tracker_incomplete_steps WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)
       OR EXISTS(SELECT 1 FROM tracker_finish_exceptions WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id));

  INSERT INTO plan_events(event_id, owner_id, plan_id, command_id, actor_id, actor_type,
                          event_type, server_occurred_at, version_before, version_after, reason)
  SELECT lower(hex(randomblob(16))), NEW.owner_id, NEW.plan_id, NEW.command_id, NEW.actor_id,
         NEW.actor_type, 'FINISHED', NEW.server_now_ms, NEW.expected_version, NEW.expected_version+1,
         CASE WHEN EXISTS(SELECT 1 FROM tracker_plan_config c WHERE c.owner_id=NEW.owner_id AND c.plan_id=NEW.plan_id AND c.enabled=1)
           THEN COALESCE(json_extract(NEW.payload_json,'$.reason'),json_extract(NEW.payload_json,'$.completionNote'))
           ELSE json_extract(NEW.payload_json,'$.reason') END
   WHERE changes()=1;

  UPDATE work_intervals SET end_ms=NEW.server_now_ms, closed_by=NEW.actor_id
   WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL
     AND EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id);

  UPDATE step_attempts SET status='ABANDONED',closed_at=NEW.server_now_ms
   WHERE owner_id=NEW.owner_id AND status='OPEN'
     AND EXISTS(SELECT 1 FROM plan_steps s JOIN plan_events e ON e.owner_id=s.owner_id AND e.plan_id=s.plan_id
       WHERE s.owner_id=step_attempts.owner_id AND s.step_id=step_attempts.step_id
         AND s.plan_id=NEW.plan_id AND e.command_id=NEW.command_id);

  INSERT INTO tracker_journal(owner_id,event_id,plan_id,command_id,command_event_ordinal,server_sequence,
    event_type,payload_json,payload_hash,occurred_at,received_at,classification)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.finishEventId'),NEW.plan_id,NEW.command_id,0,
    (SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),'PLAN_FINISHED',
    json_extract(NEW.payload_json,'$.finishEventPayloadJson'),json_extract(NEW.payload_json,'$.finishEventPayloadHash'),
    NEW.server_now_ms,NEW.recorded_at,'NORMAL'
   WHERE EXISTS(SELECT 1 FROM tracker_plan_config WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND enabled=1)
     AND EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id);

  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
      WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
      WHEN (SELECT status FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) NOT IN ('RUNNING','PAUSED') THEN 'INVALID_TRANSITION'
      WHEN EXISTS(SELECT 1 FROM tracker_plan_config c WHERE c.owner_id=NEW.owner_id AND c.plan_id=NEW.plan_id AND c.enabled=1)
        AND EXISTS(SELECT 1 FROM tracker_incomplete_steps WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)
        AND NOT EXISTS(SELECT 1 FROM tracker_finish_exceptions WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
        THEN 'CHECKPOINTS_INCOMPLETE'
      ELSE 'INVALID_TRANSITION' END,
    result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN json_object('planId',NEW.plan_id,'status','COMPLETED','version',NEW.expected_version+1,
        'finishedAt',NEW.server_now_ms,'serverNow',NEW.server_now_ms,
        'exceptionId',(SELECT command_id FROM tracker_finish_exceptions WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id),
        'incompleteCount',COALESCE(json_array_length((SELECT snapshot_json FROM tracker_finish_exceptions WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)),0))
      ELSE (SELECT json_object('error',outcome_code,'planId',NEW.plan_id,'status',status,
                               'currentVersion',version,'serverNow',NEW.server_now_ms)
              FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;
