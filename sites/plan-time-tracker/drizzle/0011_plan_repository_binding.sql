DROP TRIGGER command_renew_step_lease;

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
     AND (NEW.expected_version IS NULL OR EXISTS(SELECT 1 FROM plan_steps expected WHERE expected.owner_id=NEW.owner_id AND expected.step_id=step_attempts.step_id AND expected.version=NEW.expected_version))
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
        AND (NEW.expected_version IS NULL OR (SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'))=NEW.expected_version)
        AND EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
          JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
          WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='RUNNING' AND c.enabled=1) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')) THEN 'STEP_NOT_FOUND'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps s JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
        WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND c.enabled=1) THEN 'FEATURE_UNAVAILABLE'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='PAUSED') THEN 'PLAN_PAUSED'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='COMPLETED') THEN 'PLAN_COMPLETED'
      WHEN NEW.expected_version IS NOT NULL AND (SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'))<>NEW.expected_version THEN 'VERSION_CONFLICT'
      WHEN EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND status<>'OPEN') THEN 'ATTEMPT_CLOSED'
      WHEN EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND status='OPEN' AND lease_until<=NEW.server_now_ms) THEN 'LEASE_EXPIRED'
      WHEN EXISTS(SELECT 1 FROM step_attempts a JOIN plan_steps s ON s.owner_id=a.owner_id AND s.step_id=a.step_id WHERE a.owner_id=NEW.owner_id AND a.step_id=json_extract(NEW.payload_json,'$.stepId') AND a.attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND a.status='OPEN' AND (a.fence<>json_extract(NEW.payload_json,'$.fence') OR s.current_fence<>a.fence)) THEN 'LEASE_FENCED'
      WHEN EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND status<>'RUNNING') THEN 'INVALID_TRANSITION'
      ELSE 'LEASE_CONFLICT' END,
    result_version=(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
    result_json=CASE WHEN outcome_code='PENDING'
      AND EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
        AND attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND status='OPEN' AND fence=json_extract(NEW.payload_json,'$.fence')
        AND lease_until=NEW.server_now_ms+600000)
      THEN json_object('stepId',json_extract(NEW.payload_json,'$.stepId'),'attemptId',json_extract(NEW.payload_json,'$.attemptId'),
        'fence',json_extract(NEW.payload_json,'$.fence'),'leaseUntil',NEW.server_now_ms+600000,'serverNow',NEW.server_now_ms)
      ELSE json_object('error',outcome_code,'stepId',json_extract(NEW.payload_json,'$.stepId'),'currentVersion',(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),'serverNow',NEW.server_now_ms) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

DROP TRIGGER command_record_step_result;

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
         AND repo.access_state='available' AND allowed_repo.plan_id=s.plan_id));

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
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status<>'RUNNING') THEN 'INVALID_TRANSITION'
      WHEN (SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'))<>NEW.expected_version THEN 'VERSION_CONFLICT'
      WHEN NOT EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND attempt_id=json_extract(NEW.payload_json,'$.attemptId')) THEN 'ATTEMPT_NOT_FOUND'
      WHEN EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND status<>'OPEN') THEN 'ATTEMPT_CLOSED'
      WHEN EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND status='OPEN' AND lease_until<=NEW.server_now_ms) THEN 'LEASE_EXPIRED'
      WHEN EXISTS(SELECT 1 FROM step_attempts a JOIN plan_steps s ON s.owner_id=a.owner_id AND s.step_id=a.step_id WHERE a.owner_id=NEW.owner_id AND a.step_id=json_extract(NEW.payload_json,'$.stepId') AND a.attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND a.status='OPEN' AND (a.fence<>json_extract(NEW.payload_json,'$.fence') OR s.current_fence<>a.fence)) THEN 'LEASE_FENCED'
      WHEN NOT EXISTS(SELECT 1 FROM tracker_journal started WHERE started.owner_id=NEW.owner_id AND started.step_id=json_extract(NEW.payload_json,'$.stepId') AND started.attempt_id=json_extract(NEW.payload_json,'$.attemptId') AND started.event_type='STEP_STARTED') THEN 'STEP_NOT_STARTED'
      WHEN json_extract(NEW.payload_json,'$.repositoryId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM repositories repo WHERE repo.owner_id=NEW.owner_id AND repo.repository_id=json_extract(NEW.payload_json,'$.repositoryId') AND repo.access_state='available') THEN 'REPOSITORY_UNAVAILABLE'
      WHEN json_extract(NEW.payload_json,'$.repositoryId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM plan_repositories pr WHERE pr.owner_id=NEW.owner_id AND pr.plan_id=(SELECT plan_id FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')) AND pr.repository_id=json_extract(NEW.payload_json,'$.repositoryId')) THEN 'REPOSITORY_NOT_ATTACHED'
      ELSE 'LEASE_CONFLICT' END,
    result_version=(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN json_object('stepId',json_extract(NEW.payload_json,'$.stepId'),'outcome',json_extract(NEW.payload_json,'$.outcome'),
        'resultRevision',(SELECT revision FROM step_results WHERE owner_id=NEW.owner_id AND result_id=json_extract(NEW.payload_json,'$.resultId')),
        'version',NEW.expected_version+1,'attemptStatus','CLOSED','serverNow',NEW.server_now_ms)
      ELSE json_object('error',outcome_code,'stepId',json_extract(NEW.payload_json,'$.stepId'),'currentVersion',(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),'serverNow',NEW.server_now_ms) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

CREATE TRIGGER command_attach_plan_repository AFTER INSERT ON command_receipts
WHEN NEW.command_type='AttachPlanRepository' AND NEW.outcome_code='PENDING'
BEGIN
  UPDATE plans SET version=version+1
   WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND version=NEW.expected_version
     AND EXISTS(SELECT 1 FROM repositories r WHERE r.owner_id=NEW.owner_id
       AND r.repository_id=json_extract(NEW.payload_json,'$.repositoryId') AND r.access_state='available')
     AND NOT EXISTS(SELECT 1 FROM plan_repositories existing WHERE existing.owner_id=NEW.owner_id
       AND existing.plan_id=NEW.plan_id AND existing.repository_id=json_extract(NEW.payload_json,'$.repositoryId'));

  INSERT INTO plan_repositories(owner_id,plan_id,repository_id,selected_ref,fixed_at)
  SELECT NEW.owner_id,NEW.plan_id,r.repository_id,r.default_branch,
    CASE WHEN p.status='PLANNED' THEN NULL ELSE NEW.server_now_ms END
   FROM repositories r JOIN plans p ON p.owner_id=r.owner_id AND p.plan_id=NEW.plan_id
   WHERE r.owner_id=NEW.owner_id AND r.repository_id=json_extract(NEW.payload_json,'$.repositoryId')
     AND r.access_state='available' AND p.version=NEW.expected_version+1 AND changes()=1;

  INSERT INTO plan_events(event_id,owner_id,plan_id,command_id,actor_id,actor_type,event_type,server_occurred_at,version_before,version_after,reason)
  SELECT lower(hex(randomblob(16))),NEW.owner_id,NEW.plan_id,NEW.command_id,NEW.actor_id,NEW.actor_type,
    'REPOSITORY_ATTACHED',NEW.server_now_ms,NEW.expected_version,NEW.expected_version+1,NULL
   WHERE EXISTS(SELECT 1 FROM plan_repositories WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id
     AND repository_id=json_extract(NEW.payload_json,'$.repositoryId')) AND changes()=1;

  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
      WHEN NOT EXISTS(SELECT 1 FROM repositories WHERE owner_id=NEW.owner_id AND repository_id=json_extract(NEW.payload_json,'$.repositoryId') AND access_state='available') THEN 'REPOSITORY_UNAVAILABLE'
      WHEN EXISTS(SELECT 1 FROM plan_repositories WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND repository_id=json_extract(NEW.payload_json,'$.repositoryId')) THEN 'REPOSITORY_ALREADY_ATTACHED'
      WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
      ELSE 'INVALID_TRANSITION' END,
    result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN json_object('planId',NEW.plan_id,'repositoryId',json_extract(NEW.payload_json,'$.repositoryId'),
        'version',NEW.expected_version+1,'serverNow',NEW.server_now_ms)
      ELSE json_object('error',outcome_code,'planId',NEW.plan_id,
        'currentVersion',(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
        'serverNow',NEW.server_now_ms) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;
