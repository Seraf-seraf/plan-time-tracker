CREATE TRIGGER command_renew_step_lease AFTER INSERT ON command_receipts
WHEN NEW.command_type='RenewStepLease' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT OR IGNORE INTO tracker_owner_state(owner_id,next_sequence)
  SELECT NEW.owner_id,1 WHERE EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id
    AND step_id=json_extract(NEW.payload_json,'$.stepId') AND attempt_id=json_extract(NEW.payload_json,'$.attemptId'));

  UPDATE step_attempts SET lease_until=NEW.server_now_ms+600000
   WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
     AND attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND status='OPEN'
     AND fence=json_extract(NEW.payload_json,'$.fence') AND lease_until>NEW.server_now_ms
     AND EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
       JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
       WHERE s.owner_id=NEW.owner_id AND s.step_id=step_attempts.step_id AND s.current_fence=step_attempts.fence
         AND p.status='RUNNING' AND c.enabled=1);

  INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,attempt_id,command_id,command_event_ordinal,
    server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at,classification)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.eventId'),s.plan_id,s.step_id,a.attempt_id,NEW.command_id,0,
    (SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),'LEASE_RENEWED',
    json_extract(NEW.payload_json,'$.eventPayloadJson'),json_extract(NEW.payload_json,'$.eventPayloadHash'),
    NEW.server_now_ms,NEW.recorded_at,'NORMAL'
   FROM step_attempts a JOIN plan_steps s ON s.owner_id=a.owner_id AND s.step_id=a.step_id
   WHERE a.owner_id=NEW.owner_id AND a.step_id=json_extract(NEW.payload_json,'$.stepId')
     AND a.attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND a.status='OPEN'
     AND a.fence=json_extract(NEW.payload_json,'$.fence') AND a.lease_until=NEW.server_now_ms+600000
     AND changes()=1;

  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND event_type='LEASE_RENEWED') THEN 'OK'
      WHEN EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
        AND attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND status='OPEN' AND fence=json_extract(NEW.payload_json,'$.fence')
        AND lease_until=NEW.server_now_ms+600000)
        AND EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
          JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
          WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='RUNNING' AND c.enabled=1) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')) THEN 'STEP_NOT_FOUND'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps s JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
        WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND c.enabled=1) THEN 'FEATURE_UNAVAILABLE'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='PAUSED') THEN 'PLAN_PAUSED'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='COMPLETED') THEN 'PLAN_COMPLETED'
      ELSE 'LEASE_CONFLICT' END,
    result_version=(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
    result_json=CASE WHEN outcome_code='PENDING'
      AND EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
        AND attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND status='OPEN' AND fence=json_extract(NEW.payload_json,'$.fence')
        AND lease_until=NEW.server_now_ms+600000)
      THEN json_object('stepId',json_extract(NEW.payload_json,'$.stepId'),'attemptId',json_extract(NEW.payload_json,'$.attemptId'),
        'fence',json_extract(NEW.payload_json,'$.fence'),'leaseUntil',NEW.server_now_ms+600000,'serverNow',NEW.server_now_ms)
      ELSE json_object('error',outcome_code,'stepId',json_extract(NEW.payload_json,'$.stepId'),'serverNow',NEW.server_now_ms) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

CREATE TRIGGER command_close_step_attempt AFTER INSERT ON command_receipts
WHEN NEW.command_type='CloseStepAttempt' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT OR IGNORE INTO tracker_owner_state(owner_id,next_sequence)
  SELECT NEW.owner_id,1 WHERE EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id
    AND step_id=json_extract(NEW.payload_json,'$.stepId') AND attempt_id=json_extract(NEW.payload_json,'$.attemptId'));

  UPDATE step_attempts SET status=json_extract(NEW.payload_json,'$.disposition'),closed_at=NEW.server_now_ms
   WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
     AND attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND status='OPEN'
     AND fence=json_extract(NEW.payload_json,'$.fence')
     AND EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
       JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
       WHERE s.owner_id=NEW.owner_id AND s.step_id=step_attempts.step_id AND s.current_fence=step_attempts.fence
         AND p.status='RUNNING' AND c.enabled=1);

  INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,attempt_id,command_id,command_event_ordinal,
    server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at,classification)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.eventId'),s.plan_id,s.step_id,a.attempt_id,NEW.command_id,0,
    (SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),'ATTEMPT_CLOSED',
    json_extract(NEW.payload_json,'$.eventPayloadJson'),json_extract(NEW.payload_json,'$.eventPayloadHash'),
    NEW.server_now_ms,NEW.recorded_at,CASE WHEN a.lease_until<=NEW.server_now_ms THEN 'STALE_EXECUTOR' ELSE 'NORMAL' END
   FROM step_attempts a JOIN plan_steps s ON s.owner_id=a.owner_id AND s.step_id=a.step_id
   WHERE a.owner_id=NEW.owner_id AND a.attempt_id=json_extract(NEW.payload_json,'$.attemptId')
     AND a.status=json_extract(NEW.payload_json,'$.disposition') AND a.closed_at=NEW.server_now_ms
     AND changes()=1;

  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND attempt_id=json_extract(NEW.payload_json,'$.attemptId')) THEN 'STEP_NOT_FOUND'
      WHEN EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND status<>'OPEN') THEN 'ATTEMPT_CLOSED'
      ELSE 'LEASE_CONFLICT' END,
    result_version=(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN json_object('stepId',json_extract(NEW.payload_json,'$.stepId'),'attemptId',json_extract(NEW.payload_json,'$.attemptId'),
        'status',json_extract(NEW.payload_json,'$.disposition'),'stepVersion',(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),'serverNow',NEW.server_now_ms)
      ELSE json_object('error',outcome_code,'stepId',json_extract(NEW.payload_json,'$.stepId'),'attemptId',json_extract(NEW.payload_json,'$.attemptId'),'serverNow',NEW.server_now_ms) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

CREATE TRIGGER command_start_step AFTER INSERT ON command_receipts
WHEN NEW.command_type='StartStep' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT OR IGNORE INTO tracker_owner_state(owner_id,next_sequence)
  SELECT NEW.owner_id,1 WHERE EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'));

  UPDATE plan_steps SET status='RUNNING',version=version+1,acceptance_revision=NULL,
    acceptance_decision='NONE',current_acceptance_id=NULL,updated_at=NEW.server_now_ms
   WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
     AND version=NEW.expected_version
     AND EXISTS(SELECT 1 FROM plans p JOIN tracker_plan_config c ON c.owner_id=p.owner_id AND c.plan_id=p.plan_id
       WHERE p.owner_id=plan_steps.owner_id AND p.plan_id=plan_steps.plan_id AND p.status='RUNNING' AND c.enabled=1)
     AND EXISTS(SELECT 1 FROM step_attempts a WHERE a.owner_id=NEW.owner_id AND a.step_id=plan_steps.step_id
       AND a.attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND a.status='OPEN'
       AND a.fence=json_extract(NEW.payload_json,'$.fence') AND a.fence=plan_steps.current_fence AND a.lease_until>NEW.server_now_ms)
     AND (status IN ('PENDING','BLOCKED','FAILED')
       OR (status='RUNNING' AND NOT EXISTS(SELECT 1 FROM tracker_journal j WHERE j.owner_id=NEW.owner_id
         AND j.step_id=plan_steps.step_id AND j.attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND j.event_type='STEP_STARTED'))
       OR (status='DONE' AND json_extract(NEW.payload_json,'$.rework')=1
         AND length(trim(COALESCE(json_extract(NEW.payload_json,'$.reason'),'')))>0
         AND EXISTS(SELECT 1 FROM step_attempts a WHERE a.owner_id=NEW.owner_id AND a.step_id=plan_steps.step_id
           AND a.attempt_id=json_extract(NEW.payload_json,'$.attemptId')
           AND a.rework_reason=trim(json_extract(NEW.payload_json,'$.reason')))));

  INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,attempt_id,command_id,command_event_ordinal,
    server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at,classification)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.eventId'),s.plan_id,s.step_id,json_extract(NEW.payload_json,'$.attemptId'),
    NEW.command_id,0,(SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),'STEP_STARTED',
    json_extract(NEW.payload_json,'$.eventPayloadJson'),json_extract(NEW.payload_json,'$.eventPayloadHash'),
    NEW.server_now_ms,NEW.recorded_at,'NORMAL'
   FROM plan_steps s WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')
     AND s.version=NEW.expected_version+1 AND s.status='RUNNING' AND changes()=1;

  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')) THEN 'STEP_NOT_FOUND'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps s JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
        WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND c.enabled=1) THEN 'FEATURE_UNAVAILABLE'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='PAUSED') THEN 'PLAN_PAUSED'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='COMPLETED') THEN 'PLAN_COMPLETED'
      WHEN (SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'))<>NEW.expected_version THEN 'VERSION_CONFLICT'
      WHEN EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND status<>'OPEN') THEN 'ATTEMPT_CLOSED'
      WHEN EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND status='DONE') THEN 'REWORK_REQUIRED'
      ELSE 'LEASE_CONFLICT' END,
    result_version=(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN json_object('stepId',json_extract(NEW.payload_json,'$.stepId'),'status','RUNNING','version',NEW.expected_version+1,'serverNow',NEW.server_now_ms)
      ELSE json_object('error',outcome_code,'stepId',json_extract(NEW.payload_json,'$.stepId'),'serverNow',NEW.server_now_ms) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

CREATE TRIGGER command_block_step AFTER INSERT ON command_receipts
WHEN NEW.command_type='BlockStep' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT OR IGNORE INTO tracker_owner_state(owner_id,next_sequence)
  SELECT NEW.owner_id,1 WHERE EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'));

  UPDATE step_attempts SET status='ABANDONED',closed_at=NEW.server_now_ms
   WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
     AND attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND status='OPEN'
     AND fence=json_extract(NEW.payload_json,'$.fence') AND lease_until>NEW.server_now_ms
     AND EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
       JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
       WHERE s.owner_id=NEW.owner_id AND s.step_id=step_attempts.step_id AND s.version=NEW.expected_version
         AND s.status='RUNNING' AND s.current_fence=step_attempts.fence AND p.status='RUNNING' AND c.enabled=1);

  UPDATE plan_steps SET status='BLOCKED',version=version+1,acceptance_revision=NULL,
    acceptance_decision='NONE',current_acceptance_id=NULL,updated_at=NEW.server_now_ms
   WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
     AND version=NEW.expected_version AND status='RUNNING'
     AND EXISTS(SELECT 1 FROM plans p JOIN tracker_plan_config c ON c.owner_id=p.owner_id AND c.plan_id=p.plan_id
       WHERE p.owner_id=plan_steps.owner_id AND p.plan_id=plan_steps.plan_id AND p.status='RUNNING' AND c.enabled=1)
     AND EXISTS(SELECT 1 FROM step_attempts a WHERE a.owner_id=NEW.owner_id AND a.step_id=plan_steps.step_id
       AND a.attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND a.fence=json_extract(NEW.payload_json,'$.fence')
       AND a.status='ABANDONED' AND a.closed_at=NEW.server_now_ms)
     AND EXISTS(SELECT 1 FROM tracker_journal started WHERE started.owner_id=NEW.owner_id
       AND started.step_id=plan_steps.step_id AND started.attempt_id=json_extract(NEW.payload_json,'$.attemptId')
       AND started.event_type='STEP_STARTED');

  INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,attempt_id,command_id,command_event_ordinal,
    server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at,classification)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.eventId'),s.plan_id,s.step_id,json_extract(NEW.payload_json,'$.attemptId'),
    NEW.command_id,0,(SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),'STEP_BLOCKED',
    json_extract(NEW.payload_json,'$.eventPayloadJson'),json_extract(NEW.payload_json,'$.eventPayloadHash'),
    NEW.server_now_ms,NEW.recorded_at,'NORMAL'
   FROM plan_steps s WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')
     AND s.version=NEW.expected_version+1 AND s.status='BLOCKED' AND changes()=1;

  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')) THEN 'STEP_NOT_FOUND'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps s JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND c.enabled=1) THEN 'FEATURE_UNAVAILABLE'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='PAUSED') THEN 'PLAN_PAUSED'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='COMPLETED') THEN 'PLAN_COMPLETED'
      WHEN (SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'))<>NEW.expected_version THEN 'VERSION_CONFLICT'
      ELSE 'LEASE_CONFLICT' END,
    result_version=(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN json_object('stepId',json_extract(NEW.payload_json,'$.stepId'),'status','BLOCKED','version',NEW.expected_version+1,'serverNow',NEW.server_now_ms)
      ELSE json_object('error',outcome_code,'stepId',json_extract(NEW.payload_json,'$.stepId'),'serverNow',NEW.server_now_ms) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

CREATE TRIGGER command_record_step_result AFTER INSERT ON command_receipts
WHEN NEW.command_type='RecordStepResult' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT OR IGNORE INTO tracker_owner_state(owner_id,next_sequence)
  SELECT NEW.owner_id,1 WHERE EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'));

  INSERT OR IGNORE INTO step_results(owner_id,result_id,step_id,attempt_id,revision,outcome,summary,repository_id,revision_sha,payload_hash,created_at)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.resultId'),s.step_id,a.attempt_id,
    COALESCE((SELECT MAX(r.revision) FROM step_results r WHERE r.owner_id=s.owner_id AND r.step_id=s.step_id),0)+1,
    json_extract(NEW.payload_json,'$.outcome'),json_extract(NEW.payload_json,'$.summary'),
    json_extract(NEW.payload_json,'$.repositoryId'),json_extract(NEW.payload_json,'$.revisionSha'),
    json_extract(NEW.payload_json,'$.resultPayloadHash'),NEW.server_now_ms
   FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
     JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
     JOIN step_attempts a ON a.owner_id=s.owner_id AND a.step_id=s.step_id
       AND a.attempt_id=json_extract(NEW.payload_json,'$.attemptId')
   WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')
     AND s.version=NEW.expected_version AND s.status='RUNNING' AND p.status='RUNNING' AND c.enabled=1
     AND s.current_fence=a.fence AND a.fence=json_extract(NEW.payload_json,'$.fence')
     AND a.status='OPEN' AND a.lease_until>NEW.server_now_ms
     AND EXISTS(SELECT 1 FROM tracker_journal started WHERE started.owner_id=NEW.owner_id
       AND started.step_id=s.step_id AND started.attempt_id=a.attempt_id AND started.event_type='STEP_STARTED')
     AND (json_extract(NEW.payload_json,'$.repositoryId') IS NULL OR EXISTS(
       SELECT 1 FROM repositories repo JOIN plan_repositories allowed_repo
         ON allowed_repo.owner_id=repo.owner_id AND allowed_repo.repository_id=repo.repository_id
       WHERE repo.owner_id=NEW.owner_id AND repo.repository_id=json_extract(NEW.payload_json,'$.repositoryId')
         AND allowed_repo.plan_id=s.plan_id));

  UPDATE step_attempts SET status='CLOSED',closed_at=NEW.server_now_ms
   WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
     AND attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND status='OPEN'
     AND fence=json_extract(NEW.payload_json,'$.fence') AND lease_until>NEW.server_now_ms
     AND EXISTS(SELECT 1 FROM step_results r WHERE r.owner_id=NEW.owner_id AND r.result_id=json_extract(NEW.payload_json,'$.resultId'));

  UPDATE plan_steps SET status=json_extract(NEW.payload_json,'$.outcome'),version=version+1,
    current_result_revision=(SELECT revision FROM step_results WHERE owner_id=NEW.owner_id AND result_id=json_extract(NEW.payload_json,'$.resultId')),
    acceptance_revision=NULL,acceptance_decision='NONE',current_acceptance_id=NULL,updated_at=NEW.server_now_ms
   WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
     AND version=NEW.expected_version AND status='RUNNING'
     AND EXISTS(SELECT 1 FROM step_attempts a WHERE a.owner_id=NEW.owner_id AND a.step_id=plan_steps.step_id
       AND a.attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND a.status='CLOSED' AND a.closed_at=NEW.server_now_ms)
     AND EXISTS(SELECT 1 FROM step_results r WHERE r.owner_id=NEW.owner_id AND r.result_id=json_extract(NEW.payload_json,'$.resultId'));

  INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,attempt_id,command_id,command_event_ordinal,
    server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at,classification)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.eventId'),s.plan_id,s.step_id,json_extract(NEW.payload_json,'$.attemptId'),
    NEW.command_id,0,(SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),'STEP_RESULT_RECORDED',
    json_extract(NEW.payload_json,'$.eventPayloadJson'),json_extract(NEW.payload_json,'$.eventPayloadHash'),
    NEW.server_now_ms,NEW.recorded_at,'NORMAL'
   FROM plan_steps s WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')
     AND s.version=NEW.expected_version+1 AND changes()=1;

  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')) THEN 'STEP_NOT_FOUND'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps s JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND c.enabled=1) THEN 'FEATURE_UNAVAILABLE'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='PAUSED') THEN 'PLAN_PAUSED'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='COMPLETED') THEN 'PLAN_COMPLETED'
      WHEN (SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'))<>NEW.expected_version THEN 'VERSION_CONFLICT'
      WHEN EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND status<>'OPEN') THEN 'ATTEMPT_CLOSED'
      ELSE 'LEASE_CONFLICT' END,
    result_version=(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN json_object('stepId',json_extract(NEW.payload_json,'$.stepId'),'outcome',json_extract(NEW.payload_json,'$.outcome'),
        'resultRevision',(SELECT revision FROM step_results WHERE owner_id=NEW.owner_id AND result_id=json_extract(NEW.payload_json,'$.resultId')),
        'version',NEW.expected_version+1,'attemptStatus','CLOSED','serverNow',NEW.server_now_ms)
      ELSE json_object('error',outcome_code,'stepId',json_extract(NEW.payload_json,'$.stepId'),'serverNow',NEW.server_now_ms) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;
