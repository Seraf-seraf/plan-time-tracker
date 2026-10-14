-- Remove the active owner-decision mechanism; retain immutable historical data.
-- Readiness depends on the current DONE result and latest required checks by server sequence.
DROP TRIGGER command_decide_step;
DROP VIEW tracker_incomplete_steps;
CREATE VIEW tracker_incomplete_steps AS
SELECT s.owner_id,s.plan_id,s.step_id,s.ordinal,s.title,s.status,s.version,
       s.current_result_revision,s.current_fence
  FROM plan_steps s
  LEFT JOIN step_results current_result
    ON current_result.owner_id=s.owner_id AND current_result.step_id=s.step_id
   AND current_result.revision=s.current_result_revision
 WHERE s.status<>'DONE'
    OR s.current_result_revision IS NULL
    OR current_result.outcome IS NULL
    OR current_result.outcome<>'DONE'
    OR EXISTS (
      SELECT 1 FROM step_attempts active_attempt
       WHERE active_attempt.owner_id=s.owner_id AND active_attempt.step_id=s.step_id AND active_attempt.status='OPEN'
    )
    OR EXISTS (
      SELECT 1 FROM json_each(s.required_checks_json) required
       WHERE NOT EXISTS (
         SELECT 1 FROM step_checks latest_check
         JOIN tracker_journal latest_event
           ON latest_event.owner_id=latest_check.owner_id AND latest_event.event_id=latest_check.event_id
          AND latest_event.step_id=latest_check.step_id
          WHERE latest_check.owner_id=s.owner_id AND latest_check.step_id=s.step_id
            AND latest_check.result_revision=s.current_result_revision
            AND latest_check.check_key=CAST(required.value AS TEXT)
            AND latest_check.status='PASSED'
            AND current_result.revision_sha IS NOT NULL
            AND latest_check.tested_sha=current_result.revision_sha
            AND latest_event.server_sequence=(
              SELECT MAX(candidate_event.server_sequence)
                FROM step_checks candidate_check
                JOIN tracker_journal candidate_event
                  ON candidate_event.owner_id=candidate_check.owner_id AND candidate_event.event_id=candidate_check.event_id
                 AND candidate_event.step_id=candidate_check.step_id
               WHERE candidate_check.owner_id=s.owner_id AND candidate_check.step_id=s.step_id
                 AND candidate_check.result_revision=s.current_result_revision
                 AND candidate_check.check_key=CAST(required.value AS TEXT)
            )
       )
    );

DROP TRIGGER command_update_step;
CREATE TRIGGER command_update_step AFTER INSERT ON command_receipts
WHEN NEW.command_type='UpdateStep' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT OR IGNORE INTO tracker_owner_state(owner_id,next_sequence)
  SELECT NEW.owner_id,1
   WHERE EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'));

  UPDATE OR IGNORE plan_steps SET
    title=COALESCE(json_extract(NEW.payload_json,'$.changes.title'),title),
    expected_result=COALESCE(json_extract(NEW.payload_json,'$.changes.expectedResult'),expected_result),
    required_checks_json=CASE WHEN json_type(NEW.payload_json,'$.changes.requiredChecksJson')='text'
      THEN json(json_extract(NEW.payload_json,'$.changes.requiredChecksJson')) ELSE required_checks_json END,
    commit_policy=COALESCE(json_extract(NEW.payload_json,'$.changes.commitPolicy'),commit_policy),
    push_policy=COALESCE(json_extract(NEW.payload_json,'$.changes.pushPolicy'),push_policy),
    status='PENDING',version=version+1,current_result_revision=NULL,updated_at=NEW.server_now_ms
   WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
     AND version=NEW.expected_version AND status<>'RUNNING'
     AND EXISTS (SELECT 1 FROM plans p WHERE p.owner_id=NEW.owner_id AND p.plan_id=plan_steps.plan_id
                  AND p.status IN ('PLANNED','RUNNING'))
     AND EXISTS (SELECT 1 FROM tracker_plan_config c WHERE c.owner_id=NEW.owner_id
                  AND c.plan_id=plan_steps.plan_id AND c.enabled=1)
     AND NOT EXISTS (SELECT 1 FROM step_attempts a WHERE a.owner_id=NEW.owner_id
                      AND a.step_id=plan_steps.step_id AND a.status='OPEN');

  INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,command_id,command_event_ordinal,
    server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at,classification)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.eventId'),s.plan_id,s.step_id,NEW.command_id,0,
    (SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),
    'STEP_UPDATED',json_extract(NEW.payload_json,'$.eventPayloadJson'),json_extract(NEW.payload_json,'$.eventPayloadHash'),
    NEW.server_now_ms,NEW.recorded_at,'NORMAL'
   FROM plan_steps s WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')
     AND s.version=NEW.expected_version+1
     AND changes()=1;

  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')) THEN 'STEP_NOT_FOUND'
      WHEN NOT EXISTS(SELECT 1 FROM tracker_plan_config c JOIN plan_steps s ON s.owner_id=c.owner_id AND s.plan_id=c.plan_id
                       WHERE c.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND c.enabled=1) THEN 'FEATURE_UNAVAILABLE'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
                   WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='PAUSED') THEN 'PLAN_PAUSED'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
                   WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='COMPLETED') THEN 'PLAN_COMPLETED'
      WHEN (SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'))<>NEW.expected_version THEN 'VERSION_CONFLICT'
      WHEN EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND status='OPEN') THEN 'ACTIVE_ATTEMPT_EXISTS'
      WHEN EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND status='DONE') THEN 'REWORK_REQUIRED'
      ELSE 'INVALID_TRANSITION' END,
    result_version=(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN json_object('planId',(SELECT plan_id FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
        'stepId',json_extract(NEW.payload_json,'$.stepId'),'status','PENDING','version',NEW.expected_version+1,'serverNow',NEW.server_now_ms)
      ELSE json_object('error',outcome_code,'stepId',json_extract(NEW.payload_json,'$.stepId'),'serverNow',NEW.server_now_ms) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

DROP TRIGGER command_start_step;
CREATE TRIGGER command_start_step AFTER INSERT ON command_receipts
WHEN NEW.command_type='StartStep' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT OR IGNORE INTO tracker_owner_state(owner_id,next_sequence)
  SELECT NEW.owner_id,1 WHERE EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'));

  UPDATE plan_steps SET status='RUNNING',version=version+1,updated_at=NEW.server_now_ms
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

DROP TRIGGER command_block_step;
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

  UPDATE plan_steps SET status='BLOCKED',version=version+1,updated_at=NEW.server_now_ms
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
    updated_at=NEW.server_now_ms
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

DROP TRIGGER command_record_check;
CREATE TRIGGER command_record_check AFTER INSERT ON command_receipts
WHEN NEW.command_type='RecordCheck' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT OR IGNORE INTO tracker_owner_state(owner_id,next_sequence)
  SELECT NEW.owner_id,1 WHERE EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id
    AND step_id=json_extract(NEW.payload_json,'$.stepId'));

  INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,command_id,command_event_ordinal,
    server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at,classification)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.eventId'),s.plan_id,s.step_id,NEW.command_id,0,
    (SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),'CHECK_RECORDED',
    json_extract(NEW.payload_json,'$.eventPayloadJson'),json_extract(NEW.payload_json,'$.eventPayloadHash'),
    NEW.server_now_ms,NEW.recorded_at,'NORMAL'
   FROM plan_steps s JOIN step_results r ON r.owner_id=s.owner_id AND r.step_id=s.step_id
     AND r.revision=json_extract(NEW.payload_json,'$.resultRevision')
     JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
     JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id AND c.enabled=1
   WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')
     AND r.revision_sha=json_extract(NEW.payload_json,'$.testedSha')
     AND (p.status='RUNNING' OR (NEW.actor_type='user' AND p.status IN ('PAUSED','COMPLETED')));

  INSERT INTO step_checks(owner_id,check_id,step_id,result_revision,event_id,check_key,status,tested_sha,exit_code,evidence_summary,evidence_url,created_at)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.checkId'),json_extract(NEW.payload_json,'$.stepId'),
    json_extract(NEW.payload_json,'$.resultRevision'),json_extract(NEW.payload_json,'$.eventId'),
    json_extract(NEW.payload_json,'$.checkKey'),json_extract(NEW.payload_json,'$.status'),
    json_extract(NEW.payload_json,'$.testedSha'),json_extract(NEW.payload_json,'$.exitCode'),
    json_extract(NEW.payload_json,'$.evidenceSummary'),json_extract(NEW.payload_json,'$.evidenceUrl'),NEW.server_now_ms
   WHERE EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND event_id=json_extract(NEW.payload_json,'$.eventId'));

  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM step_checks WHERE owner_id=NEW.owner_id AND check_id=json_extract(NEW.payload_json,'$.checkId')) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')) THEN 'STEP_NOT_FOUND'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps s JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
        WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND c.enabled=1) THEN 'FEATURE_UNAVAILABLE'
      WHEN NOT EXISTS(SELECT 1 FROM step_results WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
        AND revision=json_extract(NEW.payload_json,'$.resultRevision')) THEN 'RESULT_REVISION_STALE'
      WHEN (SELECT revision_sha FROM step_results WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
        AND revision=json_extract(NEW.payload_json,'$.resultRevision')) IS NOT json_extract(NEW.payload_json,'$.testedSha') THEN 'RESULT_REVISION_STALE'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
        WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='PAUSED') THEN 'PLAN_PAUSED'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
        WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='COMPLETED') THEN 'PLAN_COMPLETED'
      ELSE 'INVALID_TRANSITION' END,
    result_version=(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM step_checks WHERE owner_id=NEW.owner_id AND check_id=json_extract(NEW.payload_json,'$.checkId'))
      THEN json_object('stepId',json_extract(NEW.payload_json,'$.stepId'),'checkId',json_extract(NEW.payload_json,'$.checkId'),
        'resultRevision',json_extract(NEW.payload_json,'$.resultRevision'),'checkKey',json_extract(NEW.payload_json,'$.checkKey'),
        'status',json_extract(NEW.payload_json,'$.status'),'version',(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),'serverNow',NEW.server_now_ms)
      ELSE json_object('error',outcome_code,'stepId',json_extract(NEW.payload_json,'$.stepId'),'serverNow',NEW.server_now_ms) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

DROP TRIGGER command_finish_plan;
CREATE TRIGGER command_finish_plan AFTER INSERT ON command_receipts
WHEN NEW.command_type='FinishPlan' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT INTO tracker_finish_exceptions(owner_id,plan_id,command_id,reason,snapshot_json,created_at)
  SELECT NEW.owner_id,NEW.plan_id,NEW.command_id,trim(json_extract(NEW.payload_json,'$.reason')),
    COALESCE((SELECT json_group_array(json_object(
      'stepId',step_id,'ordinal',ordinal,'status',status,'version',version,
      'currentResultRevision',current_result_revision,'currentFence',current_fence))
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
