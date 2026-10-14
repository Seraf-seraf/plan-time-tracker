CREATE TRIGGER step_attempts_fence_guard BEFORE INSERT ON step_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM plan_steps
   WHERE owner_id=NEW.owner_id AND step_id=NEW.step_id AND current_fence+1=NEW.fence
)
BEGIN SELECT RAISE(ABORT, 'STEP_FENCE_CONFLICT'); END;

CREATE TRIGGER step_attempts_advance_fence AFTER INSERT ON step_attempts
BEGIN
  UPDATE plan_steps SET current_fence=NEW.fence,updated_at=NEW.started_at
   WHERE owner_id=NEW.owner_id AND step_id=NEW.step_id;
END;

CREATE TRIGGER step_results_revision_guard BEFORE INSERT ON step_results
WHEN NEW.revision<>COALESCE((
  SELECT MAX(revision) FROM step_results WHERE owner_id=NEW.owner_id AND step_id=NEW.step_id
),0)+1
BEGIN SELECT RAISE(ABORT, 'STEP_RESULT_REVISION_CONFLICT'); END;

CREATE VIEW tracker_incomplete_steps AS
SELECT s.owner_id,s.plan_id,s.step_id,s.ordinal,s.title,s.status,s.version,
       s.current_result_revision,s.acceptance_revision,s.acceptance_decision,s.current_fence
  FROM plan_steps s
  LEFT JOIN step_results current_result
    ON current_result.owner_id=s.owner_id AND current_result.step_id=s.step_id
   AND current_result.revision=s.current_result_revision
 WHERE s.status<>'DONE'
    OR s.current_result_revision IS NULL
    OR s.acceptance_decision<>'ACCEPTED'
    OR s.acceptance_revision IS NULL
    OR s.acceptance_revision<>s.current_result_revision
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
    status='PENDING',version=version+1,current_result_revision=NULL,acceptance_revision=NULL,
    acceptance_decision='NONE',current_acceptance_id=NULL,updated_at=NEW.server_now_ms
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

CREATE TRIGGER command_claim_step_attempt AFTER INSERT ON command_receipts
WHEN NEW.command_type='ClaimStepAttempt' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT OR IGNORE INTO tracker_sessions(owner_id,session_id,source_id,client_type,executor_label,created_at)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.sessionId'),json_extract(NEW.payload_json,'$.sourceId'),
    json_extract(NEW.payload_json,'$.clientType'),json_extract(NEW.payload_json,'$.executorLabel'),NEW.server_now_ms
   WHERE EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
      JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
      WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')
        AND p.status='RUNNING' AND c.enabled=1 AND s.version=NEW.expected_version
        AND (s.status IN ('PENDING','BLOCKED','FAILED','RUNNING')
          OR (s.status='DONE' AND length(trim(COALESCE(json_extract(NEW.payload_json,'$.reworkReason'),'')))>0))
        AND NOT EXISTS(SELECT 1 FROM step_attempts active_attempt WHERE active_attempt.owner_id=s.owner_id
          AND active_attempt.step_id=s.step_id AND active_attempt.status='OPEN' AND active_attempt.lease_until>NEW.server_now_ms)
        AND NOT EXISTS(SELECT 1 FROM step_attempts a WHERE a.owner_id=NEW.owner_id
          AND a.step_id=s.step_id AND a.status='OPEN' AND a.lease_until>NEW.server_now_ms));

  INSERT OR IGNORE INTO tracker_owner_state(owner_id,next_sequence)
  SELECT NEW.owner_id,1
   WHERE EXISTS(SELECT 1 FROM tracker_sessions session JOIN plan_steps s ON s.owner_id=session.owner_id
       AND s.step_id=json_extract(NEW.payload_json,'$.stepId') JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
       JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
       WHERE session.owner_id=NEW.owner_id AND session.session_id=json_extract(NEW.payload_json,'$.sessionId')
         AND session.source_id=json_extract(NEW.payload_json,'$.sourceId') AND p.status='RUNNING' AND c.enabled=1
         AND s.version=NEW.expected_version
         AND (s.status IN ('PENDING','BLOCKED','FAILED','RUNNING')
           OR (s.status='DONE' AND length(trim(COALESCE(json_extract(NEW.payload_json,'$.reworkReason'),'')))>0))
         AND NOT EXISTS(SELECT 1 FROM step_attempts active_attempt WHERE active_attempt.owner_id=s.owner_id
           AND active_attempt.step_id=s.step_id AND active_attempt.status='OPEN' AND active_attempt.lease_until>NEW.server_now_ms));

  UPDATE step_attempts SET status='ABANDONED',closed_at=NEW.server_now_ms
   WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
     AND status='OPEN' AND lease_until<=NEW.server_now_ms
     AND EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
       JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
       JOIN tracker_sessions session ON session.owner_id=NEW.owner_id AND session.session_id=json_extract(NEW.payload_json,'$.sessionId')
          AND session.source_id=json_extract(NEW.payload_json,'$.sourceId')
       WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')
         AND p.status='RUNNING' AND c.enabled=1 AND s.version=NEW.expected_version
         AND (s.status IN ('PENDING','BLOCKED','FAILED','RUNNING')
           OR (s.status='DONE' AND length(trim(COALESCE(json_extract(NEW.payload_json,'$.reworkReason'),'')))>0)));

  INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,attempt_id,command_id,command_event_ordinal,
    server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at,classification)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.recoveryEventId'),s.plan_id,s.step_id,
    (SELECT a.attempt_id FROM step_attempts a WHERE a.owner_id=NEW.owner_id AND a.step_id=s.step_id
       AND a.status='ABANDONED' AND a.closed_at=NEW.server_now_ms ORDER BY a.fence DESC LIMIT 1),
    NEW.command_id,0,(SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),
    'ATTEMPT_ABANDONED',json_extract(NEW.payload_json,'$.recoveryEventPayloadJson'),
    json_extract(NEW.payload_json,'$.recoveryEventPayloadHash'),NEW.server_now_ms,NEW.recorded_at,'STALE_EXECUTOR'
   FROM plan_steps s WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')
     AND changes()=1;

  INSERT INTO step_attempts(owner_id,attempt_id,step_id,session_id,status,fence,lease_until,rework_reason,started_at,closed_at)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.attemptId'),s.step_id,json_extract(NEW.payload_json,'$.sessionId'),
    'OPEN',s.current_fence+1,NEW.server_now_ms+600000,
    CASE WHEN s.status='DONE' THEN trim(json_extract(NEW.payload_json,'$.reworkReason')) ELSE NULL END,
    NEW.server_now_ms,NULL
   FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
     JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
     JOIN tracker_sessions session ON session.owner_id=NEW.owner_id AND session.session_id=json_extract(NEW.payload_json,'$.sessionId')
       AND session.source_id=json_extract(NEW.payload_json,'$.sourceId')
   WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')
     AND p.status='RUNNING' AND c.enabled=1 AND s.version=NEW.expected_version
     AND s.current_fence+1=json_extract(NEW.payload_json,'$.candidateFence')
     AND NOT EXISTS(SELECT 1 FROM step_attempts a WHERE a.owner_id=NEW.owner_id AND a.step_id=s.step_id AND a.status='OPEN')
     AND (s.status IN ('PENDING','BLOCKED','FAILED','RUNNING')
       OR (s.status='DONE' AND length(trim(COALESCE(json_extract(NEW.payload_json,'$.reworkReason'),'')))>0));

  INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,attempt_id,command_id,command_event_ordinal,
    server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at,classification)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.eventId'),s.plan_id,s.step_id,a.attempt_id,NEW.command_id,
    CASE WHEN EXISTS(SELECT 1 FROM tracker_journal recovery WHERE recovery.owner_id=NEW.owner_id
       AND recovery.event_id=json_extract(NEW.payload_json,'$.recoveryEventId')) THEN 1 ELSE 0 END,
    (SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),'ATTEMPT_CLAIMED',
    json_extract(NEW.payload_json,'$.eventPayloadJson'),json_extract(NEW.payload_json,'$.eventPayloadHash'),
    NEW.server_now_ms,NEW.recorded_at,'NORMAL'
   FROM step_attempts a JOIN plan_steps s ON s.owner_id=a.owner_id AND s.step_id=a.step_id
   WHERE a.owner_id=NEW.owner_id AND a.attempt_id=json_extract(NEW.payload_json,'$.attemptId')
     AND a.status='OPEN' AND a.fence=json_extract(NEW.payload_json,'$.candidateFence');

  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND event_type='ATTEMPT_CLAIMED') THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')) THEN 'STEP_NOT_FOUND'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps s JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
                       WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND c.enabled=1) THEN 'FEATURE_UNAVAILABLE'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='PAUSED') THEN 'PLAN_PAUSED'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='COMPLETED') THEN 'PLAN_COMPLETED'
      WHEN (SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'))<>NEW.expected_version THEN 'VERSION_CONFLICT'
      WHEN EXISTS(SELECT 1 FROM step_attempts WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND status='OPEN') THEN 'ACTIVE_ATTEMPT_EXISTS'
      WHEN EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND status='DONE')
        AND length(trim(COALESCE(json_extract(NEW.payload_json,'$.reworkReason'),'')))=0 THEN 'REWORK_REQUIRED'
      ELSE 'INVALID_TRANSITION' END,
    result_version=(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND event_type='ATTEMPT_CLAIMED')
      THEN json_object('stepId',json_extract(NEW.payload_json,'$.stepId'),'attemptId',json_extract(NEW.payload_json,'$.attemptId'),
        'fence',json_extract(NEW.payload_json,'$.candidateFence'),'leaseUntil',NEW.server_now_ms+600000,
        'stepVersion',NEW.expected_version,'serverNow',NEW.server_now_ms)
      ELSE json_object('error',outcome_code,'stepId',json_extract(NEW.payload_json,'$.stepId'),'serverNow',NEW.server_now_ms) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;
