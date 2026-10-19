-- Recoverable plan deletion. No history or evidence is physically removed.
ALTER TABLE plans ADD COLUMN deleted_at INTEGER
  CHECK(deleted_at IS NULL OR (typeof(deleted_at)='integer' AND deleted_at>=0));
CREATE INDEX plans_owner_deleted_registered ON plans(owner_id,deleted_at,registered_at DESC,plan_id DESC);

-- Reject writes atomically before any existing command trigger can run.
-- The nested final receipt never matches PENDING command triggers. RAISE(IGNORE)
-- cancels only the outer insert, retaining the truthful idempotent rejection.
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

CREATE TRIGGER command_delete_plan AFTER INSERT ON command_receipts
WHEN NEW.command_type='DeletePlan' AND NEW.outcome_code='PENDING'
BEGIN
  UPDATE plans SET deleted_at=NEW.server_now_ms,
    status=CASE WHEN status='RUNNING' THEN 'PAUSED' ELSE status END,version=version+1
  WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND deleted_at IS NULL AND version=NEW.expected_version;

  INSERT INTO plan_events(event_id,owner_id,plan_id,command_id,actor_id,actor_type,event_type,
    server_occurred_at,version_before,version_after,reason)
  SELECT lower(hex(randomblob(16))),NEW.owner_id,NEW.plan_id,NEW.command_id,NEW.actor_id,NEW.actor_type,
    'DELETED',NEW.server_now_ms,NEW.expected_version,NEW.expected_version+1,json_extract(NEW.payload_json,'$.reason')
  WHERE changes()=1;

  UPDATE work_intervals SET end_ms=MAX(start_ms,NEW.server_now_ms),closed_by=NEW.actor_id
  WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL
    AND EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id);

  UPDATE step_attempts SET status='ABANDONED',closed_at=MAX(started_at,NEW.server_now_ms)
  WHERE owner_id=NEW.owner_id AND status='OPEN'
    AND EXISTS(SELECT 1 FROM plan_steps s WHERE s.owner_id=NEW.owner_id AND s.step_id=step_attempts.step_id AND s.plan_id=NEW.plan_id)
    AND EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id);

  UPDATE plan_steps SET status=CASE WHEN status='RUNNING' THEN 'BLOCKED' ELSE status END,
    current_fence=current_fence+1,version=version+1,updated_at=MAX(updated_at,NEW.server_now_ms)
  WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id
    AND EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id);

  INSERT INTO tracker_journal(owner_id,event_id,plan_id,command_id,command_event_ordinal,server_sequence,
    event_type,payload_json,payload_hash,occurred_at,received_at,classification)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.lifecycleEventId'),NEW.plan_id,NEW.command_id,0,
    (SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),'PLAN_DELETED',
    json_extract(NEW.payload_json,'$.lifecycleEventPayloadJson'),json_extract(NEW.payload_json,'$.lifecycleEventPayloadHash'),
    NEW.server_now_ms,NEW.recorded_at,'NORMAL'
  WHERE EXISTS(SELECT 1 FROM tracker_plan_config WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND enabled=1)
    AND EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id);

  UPDATE command_receipts SET outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
      WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
      ELSE 'PLAN_DELETED' END,
    result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN (SELECT json_object('planId',plan_id,'status',status,'deletedAt',deleted_at,'version',version,'serverNow',NEW.server_now_ms)
        FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)
      ELSE json_object('error',outcome_code,'planId',NEW.plan_id,'currentVersion',result_version,'serverNow',NEW.server_now_ms) END
  WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

CREATE TRIGGER command_restore_plan AFTER INSERT ON command_receipts
WHEN NEW.command_type='RestorePlan' AND NEW.outcome_code='PENDING'
BEGIN
  -- Deletion has already stopped RUNNING plans. Restoration never opens an interval.
  UPDATE plans SET deleted_at=NULL,version=version+1
  WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND deleted_at IS NOT NULL AND version=NEW.expected_version;

  INSERT INTO plan_events(event_id,owner_id,plan_id,command_id,actor_id,actor_type,event_type,
    server_occurred_at,version_before,version_after,reason)
  SELECT lower(hex(randomblob(16))),NEW.owner_id,NEW.plan_id,NEW.command_id,NEW.actor_id,NEW.actor_type,
    'RESTORED',NEW.server_now_ms,NEW.expected_version,NEW.expected_version+1,json_extract(NEW.payload_json,'$.reason')
  WHERE changes()=1;

  INSERT INTO tracker_journal(owner_id,event_id,plan_id,command_id,command_event_ordinal,server_sequence,
    event_type,payload_json,payload_hash,occurred_at,received_at,classification)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.lifecycleEventId'),NEW.plan_id,NEW.command_id,0,
    (SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),'PLAN_RESTORED',
    json_extract(NEW.payload_json,'$.lifecycleEventPayloadJson'),json_extract(NEW.payload_json,'$.lifecycleEventPayloadHash'),
    NEW.server_now_ms,NEW.recorded_at,'NORMAL'
  WHERE EXISTS(SELECT 1 FROM tracker_plan_config WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND enabled=1)
    AND EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id);

  UPDATE command_receipts SET outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
      WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
      ELSE 'PLAN_NOT_DELETED' END,
    result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN (SELECT json_object('planId',plan_id,'status',status,'deletedAt',deleted_at,'version',version,'serverNow',NEW.server_now_ms)
        FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)
      ELSE json_object('error',outcome_code,'planId',NEW.plan_id,'currentVersion',result_version,'serverNow',NEW.server_now_ms) END
  WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;
