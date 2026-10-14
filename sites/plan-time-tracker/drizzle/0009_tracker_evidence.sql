DROP VIEW tracker_incomplete_steps;
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
    OR s.current_acceptance_id IS NULL
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
       AND NOT EXISTS (
         SELECT 1 FROM step_acceptances waiver_acceptance,json_each(waiver_acceptance.waivers_json) waived
          WHERE waiver_acceptance.owner_id=s.owner_id AND waiver_acceptance.step_id=s.step_id
            AND waiver_acceptance.acceptance_id=s.current_acceptance_id
            AND waiver_acceptance.result_revision=s.current_result_revision
            AND waiver_acceptance.decision='ACCEPTED'
            AND json_extract(waived.value,'$.checkKey')=CAST(required.value AS TEXT)
       )
    );

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

  UPDATE plan_steps SET version=version+1,acceptance_revision=NULL,acceptance_decision='NONE',
      current_acceptance_id=NULL,updated_at=NEW.server_now_ms
   WHERE owner_id=NEW.owner_id AND current_acceptance_id IS NOT NULL
     AND EXISTS(SELECT 1 FROM step_checks current_check JOIN step_results current_result
       ON current_result.owner_id=current_check.owner_id AND current_result.step_id=current_check.step_id
        AND current_result.revision=current_check.result_revision
       WHERE current_check.owner_id=NEW.owner_id AND current_check.check_id=json_extract(NEW.payload_json,'$.checkId')
         AND current_check.step_id=plan_steps.step_id AND current_check.result_revision=plan_steps.current_result_revision
         AND current_check.check_key=json_extract(NEW.payload_json,'$.checkKey') AND current_check.status<>'PASSED'
         AND EXISTS(SELECT 1 FROM json_each(plan_steps.required_checks_json) required
           WHERE CAST(required.value AS TEXT)=current_check.check_key)
         AND NOT EXISTS(SELECT 1 FROM step_acceptances accepted,json_each(accepted.waivers_json) waived
           WHERE accepted.owner_id=NEW.owner_id AND accepted.step_id=plan_steps.step_id
             AND accepted.acceptance_id=plan_steps.current_acceptance_id
             AND json_extract(waived.value,'$.checkKey')=current_check.check_key));

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

CREATE TRIGGER command_decide_step AFTER INSERT ON command_receipts
WHEN NEW.command_type IN ('AcceptStep','RejectStep') AND NEW.outcome_code='PENDING'
BEGIN
  INSERT OR IGNORE INTO tracker_owner_state(owner_id,next_sequence)
  SELECT NEW.owner_id,1 WHERE EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id
    AND step_id=json_extract(NEW.payload_json,'$.stepId'));

  INSERT INTO step_acceptances(owner_id,acceptance_id,step_id,result_revision,decision,actor_id,reason,waivers_json,created_at)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.acceptanceId'),s.step_id,r.revision,
    json_extract(NEW.payload_json,'$.decision'),NEW.actor_id,json_extract(NEW.payload_json,'$.reason'),
    json_extract(NEW.payload_json,'$.waiversJson'),NEW.server_now_ms
   FROM plan_steps s JOIN step_results r ON r.owner_id=s.owner_id AND r.step_id=s.step_id
     AND r.revision=json_extract(NEW.payload_json,'$.resultRevision')
     JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
     JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id AND c.enabled=1
   WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')
     AND s.version=NEW.expected_version AND s.current_result_revision=r.revision
     AND p.status IN ('RUNNING','PAUSED','COMPLETED')
     AND ((NEW.command_type='RejectStep' AND s.status IN ('DONE','FAILED')) OR (NEW.command_type='AcceptStep' AND s.status='DONE' AND r.outcome='DONE'
       AND NOT EXISTS(SELECT 1 FROM json_each(s.required_checks_json) required
         WHERE NOT EXISTS(
           SELECT 1 FROM step_checks latest_check JOIN tracker_journal latest_event
             ON latest_event.owner_id=latest_check.owner_id AND latest_event.event_id=latest_check.event_id
            AND latest_event.step_id=latest_check.step_id
            WHERE latest_check.owner_id=s.owner_id AND latest_check.step_id=s.step_id
              AND latest_check.result_revision=r.revision AND latest_check.check_key=CAST(required.value AS TEXT)
              AND latest_check.status='PASSED' AND r.revision_sha IS NOT NULL AND latest_check.tested_sha=r.revision_sha
              AND latest_event.server_sequence=(SELECT MAX(candidate_event.server_sequence)
                FROM step_checks candidate_check JOIN tracker_journal candidate_event
                  ON candidate_event.owner_id=candidate_check.owner_id AND candidate_event.event_id=candidate_check.event_id
                 AND candidate_event.step_id=candidate_check.step_id
                WHERE candidate_check.owner_id=s.owner_id AND candidate_check.step_id=s.step_id
                  AND candidate_check.result_revision=r.revision AND candidate_check.check_key=CAST(required.value AS TEXT))
         ) AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(NEW.payload_json,'$.waiversJson')) waiver
           WHERE json_extract(waiver.value,'$.checkKey')=CAST(required.value AS TEXT))
       )
       AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(NEW.payload_json,'$.waiversJson')) waiver
         WHERE NOT EXISTS(SELECT 1 FROM json_each(s.required_checks_json) required
           WHERE CAST(required.value AS TEXT)=json_extract(waiver.value,'$.checkKey')))
     ));

  UPDATE plan_steps SET acceptance_revision=json_extract(NEW.payload_json,'$.resultRevision'),
      acceptance_decision=json_extract(NEW.payload_json,'$.decision'),current_acceptance_id=json_extract(NEW.payload_json,'$.acceptanceId'),
      version=version+1,updated_at=NEW.server_now_ms
   WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
     AND version=NEW.expected_version AND current_result_revision=json_extract(NEW.payload_json,'$.resultRevision')
     AND EXISTS(SELECT 1 FROM step_acceptances a WHERE a.owner_id=NEW.owner_id
       AND a.acceptance_id=json_extract(NEW.payload_json,'$.acceptanceId') AND a.step_id=plan_steps.step_id);

  INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,command_id,command_event_ordinal,
    server_sequence,event_type,payload_json,payload_hash,occurred_at,received_at,classification)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.eventId'),s.plan_id,s.step_id,NEW.command_id,0,
    (SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),
    CASE WHEN NEW.command_type='AcceptStep' THEN 'STEP_ACCEPTED' ELSE 'STEP_REJECTED' END,
    json_extract(NEW.payload_json,'$.eventPayloadJson'),json_extract(NEW.payload_json,'$.eventPayloadHash'),
    NEW.server_now_ms,NEW.recorded_at,'NORMAL'
   FROM plan_steps s WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')
     AND s.version=NEW.expected_version+1 AND changes()=1;

  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')) THEN 'STEP_NOT_FOUND'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps s JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
        WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND c.enabled=1) THEN 'FEATURE_UNAVAILABLE'
      WHEN (SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'))<>NEW.expected_version THEN 'VERSION_CONFLICT'
      WHEN (SELECT current_result_revision FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'))<>json_extract(NEW.payload_json,'$.resultRevision') THEN 'RESULT_REVISION_STALE'
      WHEN NEW.command_type='AcceptStep' AND EXISTS(SELECT 1 FROM plan_steps s JOIN step_results r
        ON r.owner_id=s.owner_id AND r.step_id=s.step_id AND r.revision=s.current_result_revision
        WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')
          AND (s.status<>'DONE' OR r.outcome<>'DONE')) THEN 'INVALID_TRANSITION'
      WHEN NEW.command_type='AcceptStep' AND EXISTS(SELECT 1 FROM plan_steps s
        WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')
          AND EXISTS(SELECT 1 FROM json_each(json_extract(NEW.payload_json,'$.waiversJson')) waiver
            WHERE NOT EXISTS(SELECT 1 FROM json_each(s.required_checks_json) required
              WHERE CAST(required.value AS TEXT)=json_extract(waiver.value,'$.checkKey')))) THEN 'VALIDATION_ERROR'
      WHEN NEW.command_type='AcceptStep' AND EXISTS(SELECT 1 FROM plan_steps s JOIN step_results r
        ON r.owner_id=s.owner_id AND r.step_id=s.step_id AND r.revision=s.current_result_revision
        JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
        WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status IN ('RUNNING','PAUSED','COMPLETED')
          AND EXISTS(SELECT 1 FROM json_each(s.required_checks_json) required
            WHERE NOT EXISTS(SELECT 1 FROM step_checks latest_check JOIN tracker_journal latest_event
              ON latest_event.owner_id=latest_check.owner_id AND latest_event.event_id=latest_check.event_id AND latest_event.step_id=latest_check.step_id
              WHERE latest_check.owner_id=s.owner_id AND latest_check.step_id=s.step_id AND latest_check.result_revision=r.revision
                AND latest_check.check_key=CAST(required.value AS TEXT) AND latest_check.status='PASSED'
                AND r.revision_sha IS NOT NULL AND latest_check.tested_sha=r.revision_sha
                AND latest_event.server_sequence=(SELECT MAX(candidate_event.server_sequence)
                  FROM step_checks candidate_check JOIN tracker_journal candidate_event
                    ON candidate_event.owner_id=candidate_check.owner_id AND candidate_event.event_id=candidate_check.event_id AND candidate_event.step_id=candidate_check.step_id
                  WHERE candidate_check.owner_id=s.owner_id AND candidate_check.step_id=s.step_id
                    AND candidate_check.result_revision=r.revision AND candidate_check.check_key=CAST(required.value AS TEXT)))
              AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(NEW.payload_json,'$.waiversJson')) waiver
                WHERE json_extract(waiver.value,'$.checkKey')=CAST(required.value AS TEXT)))) THEN 'CHECKS_INCOMPLETE'
      ELSE 'INVALID_TRANSITION' END,
    result_version=(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN json_object('stepId',json_extract(NEW.payload_json,'$.stepId'),'acceptanceId',json_extract(NEW.payload_json,'$.acceptanceId'),
        'resultRevision',json_extract(NEW.payload_json,'$.resultRevision'),'decision',json_extract(NEW.payload_json,'$.decision'),
        'version',NEW.expected_version+1,'serverNow',NEW.server_now_ms)
      ELSE json_object('error',outcome_code,'stepId',json_extract(NEW.payload_json,'$.stepId'),'serverNow',NEW.server_now_ms) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;
