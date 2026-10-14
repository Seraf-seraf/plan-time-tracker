CREATE TRIGGER command_append_observation AFTER INSERT ON command_receipts
WHEN NEW.command_type='AppendObservation' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT OR IGNORE INTO tracker_owner_state(owner_id,next_sequence)
  SELECT NEW.owner_id,1 WHERE EXISTS(SELECT 1 FROM tracker_plan_config WHERE owner_id=NEW.owner_id
    AND plan_id=json_extract(NEW.payload_json,'$.planId') AND enabled=1)
    AND EXISTS(SELECT 1 FROM tracker_sessions WHERE owner_id=NEW.owner_id
      AND session_id=json_extract(NEW.payload_json,'$.sessionId')
      AND source_id=json_extract(NEW.payload_json,'$.sourceId'));

  INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,attempt_id,command_id,command_event_ordinal,
    source_id,session_id,source_sequence,server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at,classification,correction_of_event_id)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.eventId'),p.plan_id,
    json_extract(NEW.payload_json,'$.stepId'),json_extract(NEW.payload_json,'$.attemptId'),NEW.command_id,0,
    json_extract(NEW.payload_json,'$.sourceId'),json_extract(NEW.payload_json,'$.sessionId'),
    json_extract(NEW.payload_json,'$.sourceSequence'),
    (SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),
    json_extract(NEW.payload_json,'$.eventType'),json_extract(NEW.payload_json,'$.eventPayloadJson'),
    json_extract(NEW.payload_json,'$.eventPayloadHash'),json_extract(NEW.payload_json,'$.occurredAt'),
    NEW.recorded_at,
    CASE
      WHEN json_extract(NEW.payload_json,'$.correctionOfEventId') IS NOT NULL THEN 'CORRECTION'
      WHEN EXISTS(SELECT 1 FROM step_attempts stale JOIN plan_steps s
        ON s.owner_id=stale.owner_id AND s.step_id=stale.step_id
        WHERE stale.owner_id=NEW.owner_id AND stale.attempt_id=json_extract(NEW.payload_json,'$.attemptId')
          AND (stale.status='ABANDONED' OR stale.fence<>s.current_fence
            OR (stale.status='OPEN' AND stale.lease_until<=NEW.server_now_ms))) THEN 'STALE_EXECUTOR'
      WHEN json_extract(NEW.payload_json,'$.sourceSequence')<=COALESCE((SELECT MAX(source_sequence) FROM tracker_journal
        WHERE owner_id=NEW.owner_id AND source_id=json_extract(NEW.payload_json,'$.sourceId')
          AND session_id=json_extract(NEW.payload_json,'$.sessionId') AND source_sequence IS NOT NULL),0) THEN 'LATE'
      WHEN json_extract(NEW.payload_json,'$.sourceSequence')>COALESCE((SELECT MAX(source_sequence) FROM tracker_journal
        WHERE owner_id=NEW.owner_id AND source_id=json_extract(NEW.payload_json,'$.sourceId')
          AND session_id=json_extract(NEW.payload_json,'$.sessionId') AND source_sequence IS NOT NULL),0)+1 THEN 'GAP'
      ELSE 'NORMAL' END,
    json_extract(NEW.payload_json,'$.correctionOfEventId')
   FROM plans p JOIN tracker_plan_config c ON c.owner_id=p.owner_id AND c.plan_id=p.plan_id AND c.enabled=1
     JOIN tracker_sessions session ON session.owner_id=NEW.owner_id
       AND session.session_id=json_extract(NEW.payload_json,'$.sessionId')
       AND session.source_id=json_extract(NEW.payload_json,'$.sourceId')
   WHERE p.owner_id=NEW.owner_id AND p.plan_id=json_extract(NEW.payload_json,'$.planId')
     AND NOT EXISTS(SELECT 1 FROM tracker_journal existing WHERE existing.owner_id=NEW.owner_id
       AND existing.event_id=json_extract(NEW.payload_json,'$.eventId'))
     AND NOT EXISTS(SELECT 1 FROM tracker_journal sequence_conflict WHERE sequence_conflict.owner_id=NEW.owner_id
       AND sequence_conflict.source_id=json_extract(NEW.payload_json,'$.sourceId')
       AND sequence_conflict.session_id=json_extract(NEW.payload_json,'$.sessionId')
       AND sequence_conflict.source_sequence=json_extract(NEW.payload_json,'$.sourceSequence'))
     AND (json_extract(NEW.payload_json,'$.stepId') IS NULL OR EXISTS(SELECT 1 FROM plan_steps s
       WHERE s.owner_id=NEW.owner_id AND s.plan_id=p.plan_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')))
     AND (json_extract(NEW.payload_json,'$.attemptId') IS NULL OR EXISTS(SELECT 1 FROM step_attempts a
       WHERE a.owner_id=NEW.owner_id AND a.step_id=json_extract(NEW.payload_json,'$.stepId')
         AND a.attempt_id=json_extract(NEW.payload_json,'$.attemptId')))
     AND (json_extract(NEW.payload_json,'$.correctionOfEventId') IS NULL OR EXISTS(SELECT 1 FROM tracker_journal prior
       WHERE prior.owner_id=NEW.owner_id AND prior.plan_id=p.plan_id
         AND prior.event_id=json_extract(NEW.payload_json,'$.correctionOfEventId')))
     AND (json_extract(NEW.payload_json,'$.eventType') NOT IN ('commit_created','commit_pushed','push_failed') OR EXISTS(
       SELECT 1 FROM repositories repo JOIN plan_repositories allowed_repo
         ON allowed_repo.owner_id=repo.owner_id AND allowed_repo.repository_id=repo.repository_id
       WHERE repo.owner_id=NEW.owner_id AND repo.repository_id=json_extract(json_extract(NEW.payload_json,'$.eventPayloadJson'),'$.data.repositoryId')
         AND allowed_repo.plan_id=p.plan_id))
     AND (json_extract(NEW.payload_json,'$.eventType')<>'commit_created' OR EXISTS(
       SELECT 1 FROM step_results result
        WHERE result.owner_id=NEW.owner_id AND result.step_id=json_extract(NEW.payload_json,'$.stepId')
          AND result.revision=json_extract(json_extract(NEW.payload_json,'$.eventPayloadJson'),'$.data.resultRevision')
          AND result.repository_id=json_extract(json_extract(NEW.payload_json,'$.eventPayloadJson'),'$.data.repositoryId')
          AND result.revision_sha=json_extract(json_extract(NEW.payload_json,'$.eventPayloadJson'),'$.data.revisionSha')));

  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM tracker_journal e WHERE e.owner_id=NEW.owner_id AND e.event_id=json_extract(NEW.payload_json,'$.eventId')
        AND e.payload_hash=json_extract(NEW.payload_json,'$.eventPayloadHash')) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=json_extract(NEW.payload_json,'$.planId')) THEN 'PLAN_NOT_FOUND'
      WHEN NOT EXISTS(SELECT 1 FROM tracker_plan_config WHERE owner_id=NEW.owner_id AND plan_id=json_extract(NEW.payload_json,'$.planId') AND enabled=1) THEN 'FEATURE_UNAVAILABLE'
      WHEN NOT EXISTS(SELECT 1 FROM tracker_sessions WHERE owner_id=NEW.owner_id AND session_id=json_extract(NEW.payload_json,'$.sessionId')
        AND source_id=json_extract(NEW.payload_json,'$.sourceId')) THEN 'SESSION_NOT_FOUND'
      WHEN json_extract(NEW.payload_json,'$.stepId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM plan_steps
        WHERE owner_id=NEW.owner_id AND plan_id=json_extract(NEW.payload_json,'$.planId') AND step_id=json_extract(NEW.payload_json,'$.stepId')) THEN 'STEP_NOT_FOUND'
      WHEN json_extract(NEW.payload_json,'$.attemptId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM step_attempts
        WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND attempt_id=json_extract(NEW.payload_json,'$.attemptId')) THEN 'ATTEMPT_NOT_FOUND'
      WHEN json_extract(NEW.payload_json,'$.correctionOfEventId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tracker_journal
        WHERE owner_id=NEW.owner_id AND plan_id=json_extract(NEW.payload_json,'$.planId')
          AND event_id=json_extract(NEW.payload_json,'$.correctionOfEventId')) THEN 'EVENT_NOT_FOUND'
      WHEN json_extract(NEW.payload_json,'$.eventType') IN ('commit_created','commit_pushed','push_failed')
        AND NOT EXISTS(SELECT 1 FROM repositories repo JOIN plan_repositories pr ON pr.owner_id=repo.owner_id AND pr.repository_id=repo.repository_id
          WHERE repo.owner_id=NEW.owner_id AND repo.repository_id=json_extract(json_extract(NEW.payload_json,'$.eventPayloadJson'),'$.data.repositoryId')
            AND pr.plan_id=json_extract(NEW.payload_json,'$.planId')) THEN 'VALIDATION_ERROR'
      WHEN json_extract(NEW.payload_json,'$.eventType')='commit_created' AND NOT EXISTS(SELECT 1 FROM step_results result
        WHERE result.owner_id=NEW.owner_id AND result.step_id=json_extract(NEW.payload_json,'$.stepId')
          AND result.revision=json_extract(json_extract(NEW.payload_json,'$.eventPayloadJson'),'$.data.resultRevision')
          AND result.repository_id=json_extract(json_extract(NEW.payload_json,'$.eventPayloadJson'),'$.data.repositoryId')
          AND result.revision_sha=json_extract(json_extract(NEW.payload_json,'$.eventPayloadJson'),'$.data.revisionSha')) THEN 'RESULT_REVISION_STALE'
      WHEN EXISTS(SELECT 1 FROM tracker_journal e WHERE e.owner_id=NEW.owner_id AND e.event_id=json_extract(NEW.payload_json,'$.eventId')) THEN 'OBSERVATION_CONFLICT'
      WHEN EXISTS(SELECT 1 FROM tracker_journal e WHERE e.owner_id=NEW.owner_id AND e.source_id=json_extract(NEW.payload_json,'$.sourceId')
        AND e.session_id=json_extract(NEW.payload_json,'$.sessionId') AND e.source_sequence=json_extract(NEW.payload_json,'$.sourceSequence')) THEN 'OBSERVATION_CONFLICT'
      ELSE 'INVALID_TRANSITION' END,
    result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=json_extract(NEW.payload_json,'$.planId')),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM tracker_journal e WHERE e.owner_id=NEW.owner_id AND e.event_id=json_extract(NEW.payload_json,'$.eventId')
      AND e.payload_hash=json_extract(NEW.payload_json,'$.eventPayloadHash'))
      THEN (SELECT json_object('eventId',event_id,'serverSequence',server_sequence,'receivedAt',received_at,
        'classification',classification,'replayed',command_id<>NEW.command_id,'serverNow',NEW.server_now_ms)
        FROM tracker_journal WHERE owner_id=NEW.owner_id AND event_id=json_extract(NEW.payload_json,'$.eventId'))
      ELSE json_object('error',outcome_code,'eventId',json_extract(NEW.payload_json,'$.eventId'),'serverNow',NEW.server_now_ms) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;
