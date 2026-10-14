CREATE TRIGGER command_create_step AFTER INSERT ON command_receipts
WHEN NEW.command_type='CreateStep' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT OR IGNORE INTO plan_steps(
    owner_id,step_id,plan_id,ordinal,title,status,version,expected_result,required_checks_json,
    commit_policy,push_policy,current_fence,created_at,updated_at
  )
  SELECT NEW.owner_id,
         json_extract(NEW.payload_json,'$.stepId'),
         NEW.plan_id,
         json_extract(NEW.payload_json,'$.ordinal'),
         json_extract(NEW.payload_json,'$.title'),
         'PENDING',1,
         json_extract(NEW.payload_json,'$.expectedResult'),
         json(json_extract(NEW.payload_json,'$.requiredChecksJson')),
         json_extract(NEW.payload_json,'$.commitPolicy'),
         json_extract(NEW.payload_json,'$.pushPolicy'),
         0,NEW.server_now_ms,NEW.server_now_ms
   WHERE EXISTS (
      SELECT 1 FROM plans p WHERE p.owner_id=NEW.owner_id AND p.plan_id=NEW.plan_id
        AND p.status IN ('PLANNED','RUNNING')
   )
     AND NOT EXISTS (
      SELECT 1 FROM plan_steps s WHERE s.owner_id=NEW.owner_id AND s.plan_id=NEW.plan_id
        AND (s.ordinal=json_extract(NEW.payload_json,'$.ordinal')
          OR s.step_id=json_extract(NEW.payload_json,'$.stepId'))
   );

  INSERT OR IGNORE INTO tracker_plan_config(owner_id,plan_id,enabled,finish_policy,created_at,updated_at)
  SELECT NEW.owner_id,NEW.plan_id,1,'ALLOW_EXPLICIT_EXCEPTION',NEW.server_now_ms,NEW.server_now_ms
   WHERE EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'));

  INSERT OR IGNORE INTO tracker_owner_state(owner_id,next_sequence)
  SELECT NEW.owner_id,1
   WHERE EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'));

  INSERT INTO tracker_journal(
    owner_id,event_id,plan_id,step_id,command_id,command_event_ordinal,
    server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at,classification
  )
  SELECT NEW.owner_id,
         json_extract(NEW.payload_json,'$.eventId'),
         NEW.plan_id,
         json_extract(NEW.payload_json,'$.stepId'),
         NEW.command_id,
         0,
         (SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),
         'STEP_CREATED',
         json_extract(NEW.payload_json,'$.eventPayloadJson'),
         json_extract(NEW.payload_json,'$.eventPayloadHash'),
         NEW.server_now_ms,NEW.recorded_at,'NORMAL'
   WHERE EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'));

  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND command_event_ordinal=0) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
      WHEN (SELECT status FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)='PAUSED' THEN 'PLAN_PAUSED'
      WHEN (SELECT status FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)='COMPLETED' THEN 'PLAN_COMPLETED'
      WHEN EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id
                   AND ordinal=json_extract(NEW.payload_json,'$.ordinal')) THEN 'STEP_ALREADY_EXISTS'
      ELSE 'VALIDATION_ERROR' END,
    result_version=(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
    result_json=CASE
      WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND command_event_ordinal=0)
      THEN json_object('planId',NEW.plan_id,'stepId',json_extract(NEW.payload_json,'$.stepId'),
        'ordinal',json_extract(NEW.payload_json,'$.ordinal'),'title',json_extract(NEW.payload_json,'$.title'),
        'status','PENDING','version',1,'serverNow',NEW.server_now_ms)
      ELSE json_object('error',CASE
        WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
        WHEN (SELECT status FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)='PAUSED' THEN 'PLAN_PAUSED'
        WHEN (SELECT status FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)='COMPLETED' THEN 'PLAN_COMPLETED'
        WHEN EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id
                     AND ordinal=json_extract(NEW.payload_json,'$.ordinal')) THEN 'STEP_ALREADY_EXISTS'
        ELSE 'VALIDATION_ERROR' END,
        'planId',NEW.plan_id,'serverNow',NEW.server_now_ms)
      END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;
