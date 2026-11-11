-- Keep the original plan separate from historical checkpoint evidence.
CREATE TABLE plan_documents (
  owner_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  markdown TEXT NOT NULL CHECK(length(markdown) BETWEEN 1 AND 60000),
  PRIMARY KEY(owner_id,plan_id),
  FOREIGN KEY(owner_id,plan_id) REFERENCES plans(owner_id,plan_id)
);
CREATE TABLE plan_document_sections (
  owner_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY(owner_id,step_id),
  FOREIGN KEY(owner_id,plan_id) REFERENCES plan_documents(owner_id,plan_id),
  FOREIGN KEY(owner_id,plan_id,step_id) REFERENCES plan_steps(owner_id,plan_id,step_id)
);

-- Run after the existing atomic creation succeeds, inside the same statement.
CREATE TRIGGER command_create_plan_document AFTER UPDATE OF outcome_code ON command_receipts
WHEN NEW.command_type='CreatePlan' AND OLD.outcome_code='PENDING' AND NEW.outcome_code='OK'
  AND json_type(NEW.payload_json,'$.planText')='text'
BEGIN
  INSERT INTO plan_documents(owner_id,plan_id,markdown)
  VALUES(NEW.owner_id,NEW.plan_id,json_extract(NEW.payload_json,'$.planText'));
  INSERT INTO tracker_plan_config(owner_id,plan_id,enabled,created_at,updated_at)
  VALUES(NEW.owner_id,NEW.plan_id,1,NEW.server_now_ms,NEW.server_now_ms);
  INSERT OR IGNORE INTO tracker_owner_state(owner_id,next_sequence) VALUES(NEW.owner_id,1);
  INSERT INTO plan_steps(owner_id,plan_id,step_id,ordinal,title,expected_result,created_at,updated_at)
  SELECT NEW.owner_id,NEW.plan_id,json_extract(value,'$.stepId'),json_extract(value,'$.ordinal'),
    json_extract(value,'$.title'),json_extract(value,'$.title'),NEW.server_now_ms,NEW.server_now_ms
  FROM json_each(NEW.payload_json,'$.documentSteps');
  INSERT INTO plan_document_sections(owner_id,plan_id,step_id,content)
  SELECT NEW.owner_id,NEW.plan_id,json_extract(value,'$.stepId'),json_extract(value,'$.content')
  FROM json_each(NEW.payload_json,'$.documentSteps');
  INSERT INTO tracker_journal(owner_id,event_id,plan_id,command_id,command_event_ordinal,server_sequence,
    event_type,payload_json,payload_hash,occurred_at,received_at,classification)
  VALUES(NEW.owner_id,json_extract(NEW.payload_json,'$.documentEventId'),NEW.plan_id,NEW.command_id,0,
    (SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),'PLAN_DOCUMENT_SAVED',
    json_extract(NEW.payload_json,'$.documentEventPayloadJson'),json_extract(NEW.payload_json,'$.documentEventPayloadHash'),
    NEW.server_now_ms,NEW.recorded_at,'NORMAL');
END;

-- A document stage needs only an explicit status. Legacy evidence keeps its rules.
DROP VIEW tracker_incomplete_steps;
CREATE VIEW tracker_incomplete_steps AS
SELECT s.owner_id,s.plan_id,s.step_id,s.ordinal,s.title,s.status,s.version,s.current_result_revision,s.current_fence
FROM plan_steps s LEFT JOIN step_results r
  ON r.owner_id=s.owner_id AND r.step_id=s.step_id AND r.revision=s.current_result_revision
WHERE s.status<>'DONE' OR (
  NOT EXISTS(SELECT 1 FROM plan_document_sections d WHERE d.owner_id=s.owner_id AND d.step_id=s.step_id)
  AND (s.current_result_revision IS NULL OR r.outcome IS NULL OR r.outcome<>'DONE'
    OR EXISTS(SELECT 1 FROM step_attempts a WHERE a.owner_id=s.owner_id AND a.step_id=s.step_id AND a.status='OPEN')
    OR EXISTS(SELECT 1 FROM json_each(s.required_checks_json) required
      WHERE NOT EXISTS(SELECT 1 FROM tracker_latest_checks c
        WHERE c.owner_id=s.owner_id AND c.step_id=s.step_id AND c.result_revision=s.current_result_revision
          AND c.check_key=CAST(required.value AS TEXT) AND c.status='PASSED' AND c.matches_result=1))));

CREATE TRIGGER command_set_step_status AFTER INSERT ON command_receipts
WHEN NEW.command_type='SetStepStatus' AND NEW.outcome_code='PENDING'
BEGIN
  UPDATE plan_steps SET status=json_extract(NEW.payload_json,'$.status'),version=version+1,updated_at=NEW.server_now_ms
  WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId') AND version=NEW.expected_version
    AND EXISTS(SELECT 1 FROM plan_document_sections d WHERE d.owner_id=NEW.owner_id AND d.step_id=plan_steps.step_id)
    AND EXISTS(SELECT 1 FROM plans p WHERE p.owner_id=NEW.owner_id AND p.plan_id=plan_steps.plan_id AND p.status='RUNNING' AND p.deleted_at IS NULL);
  INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,command_id,command_event_ordinal,server_sequence,
    event_type,payload_json,payload_hash,occurred_at,received_at,classification)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.eventId'),s.plan_id,s.step_id,NEW.command_id,0,
    (SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),'STEP_STATUS_CHANGED',
    json_extract(NEW.payload_json,'$.eventPayloadJson'),json_extract(NEW.payload_json,'$.eventPayloadHash'),
    NEW.server_now_ms,NEW.recorded_at,'NORMAL'
  FROM plan_steps s WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND changes()=1;
  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')) THEN 'STEP_NOT_FOUND'
      WHEN (SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'))<>NEW.expected_version THEN 'VERSION_CONFLICT'
      WHEN EXISTS(SELECT 1 FROM plans p JOIN plan_steps s ON s.owner_id=p.owner_id AND s.plan_id=p.plan_id WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='PAUSED') THEN 'PLAN_PAUSED'
      ELSE 'INVALID_TRANSITION' END,
    result_version=(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
    result_json=(SELECT json_object('stepId',step_id,'planId',plan_id,'status',status,'version',version,'serverNow',NEW.server_now_ms)
      FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId'))
  WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

-- Source-derived stages cannot drift from the saved document via legacy editors.
CREATE TRIGGER command_document_steps_guard BEFORE INSERT ON command_receipts
WHEN NEW.command_type IN ('CreateStep','UpdateStep','ClaimStepAttempt') AND NEW.outcome_code='PENDING'
  AND EXISTS(SELECT 1 FROM plan_documents d WHERE d.owner_id=NEW.owner_id AND d.plan_id=NEW.plan_id)
BEGIN SELECT RAISE(ABORT,'PLAN_DOCUMENT_STEPS'); END;

-- Requirements contain source prose as well as stable stage identities.
-- Legacy JSON is unchanged so existing assessment digests remain valid.
DROP VIEW assessment_targets;
CREATE VIEW assessment_targets AS
SELECT p.owner_id,p.plan_id,NULL AS step_id,
 json_object('plan',json(CASE WHEN d.markdown IS NULL
   THEN json_object('title',p.title,'description',p.description,'acceptanceCriteria',p.acceptance_criteria)
   ELSE json_object('title',p.title,'planText',d.markdown) END),
 'steps',json((SELECT json_group_array(json(item)) FROM
   (SELECT CASE WHEN section.content IS NULL
     THEN json_object('stepId',s.step_id,'ordinal',s.ordinal,'title',s.title,'expectedResult',s.expected_result,'requiredChecks',json(s.required_checks_json))
     ELSE json_object('stepId',s.step_id,'ordinal',s.ordinal,'title',s.title,'content',section.content) END AS item
    FROM plan_steps s LEFT JOIN plan_document_sections section ON section.owner_id=s.owner_id AND section.step_id=s.step_id
    WHERE s.owner_id=p.owner_id AND s.plan_id=p.plan_id ORDER BY s.ordinal,s.step_id)))) AS requirements_json
FROM plans p LEFT JOIN plan_documents d ON d.owner_id=p.owner_id AND d.plan_id=p.plan_id
UNION ALL
SELECT p.owner_id,p.plan_id,s.step_id,
 json_object('plan',json(CASE WHEN d.markdown IS NULL
   THEN json_object('title',p.title,'description',p.description,'acceptanceCriteria',p.acceptance_criteria)
   ELSE json_object('title',p.title,'planText',d.markdown) END),
 'step',json(CASE WHEN section.content IS NULL
   THEN json_object('stepId',s.step_id,'title',s.title,'expectedResult',s.expected_result,'requiredChecks',json(s.required_checks_json))
   ELSE json_object('stepId',s.step_id,'title',s.title,'content',section.content) END))
FROM plans p JOIN plan_steps s ON s.owner_id=p.owner_id AND s.plan_id=p.plan_id
LEFT JOIN plan_documents d ON d.owner_id=p.owner_id AND d.plan_id=p.plan_id
LEFT JOIN plan_document_sections section ON section.owner_id=s.owner_id AND section.step_id=s.step_id;
