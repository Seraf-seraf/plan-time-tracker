-- Additive, neutral assessment storage. Existing history is never backfilled.
CREATE VIEW assessment_targets AS
SELECT p.owner_id,p.plan_id,NULL AS step_id,
 json_object('plan',json_object('title',p.title,'description',p.description,'acceptanceCriteria',p.acceptance_criteria),
 'steps',json((SELECT json_group_array(json(item)) FROM
   (SELECT json_object('stepId',s.step_id,'ordinal',s.ordinal,'title',s.title,
     'expectedResult',s.expected_result,'requiredChecks',json(s.required_checks_json)) AS item
    FROM plan_steps s WHERE s.owner_id=p.owner_id AND s.plan_id=p.plan_id ORDER BY s.ordinal,s.step_id)))) AS requirements_json
FROM plans p
UNION ALL
SELECT p.owner_id,p.plan_id,s.step_id,
 json_object('plan',json_object('title',p.title,'description',p.description,'acceptanceCriteria',p.acceptance_criteria),
 'step',json_object('stepId',s.step_id,'title',s.title,'expectedResult',s.expected_result,'requiredChecks',json(s.required_checks_json)))
FROM plans p JOIN plan_steps s ON s.owner_id=p.owner_id AND s.plan_id=p.plan_id;

CREATE TABLE assessment_revisions (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id TEXT NOT NULL,
 assessment_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=1),
 previous_revision INTEGER,
 plan_id TEXT NOT NULL,
 step_id TEXT,
 author_id TEXT NOT NULL,
 recorded_at INTEGER NOT NULL,
 command_id TEXT NOT NULL,
 requirements_json TEXT NOT NULL CHECK(json_valid(requirements_json)),
 requirements_digest TEXT NOT NULL,
 assessment_json TEXT NOT NULL CHECK(json_valid(assessment_json)),
 CHECK((revision=1 AND previous_revision IS NULL) OR (revision>1 AND previous_revision IS NOT NULL AND previous_revision=revision-1)),
 UNIQUE(owner_id,assessment_id,revision),
 UNIQUE(owner_id,command_id),
 FOREIGN KEY(owner_id,plan_id) REFERENCES plans(owner_id,plan_id),
 FOREIGN KEY(owner_id,plan_id,step_id) REFERENCES plan_steps(owner_id,plan_id,step_id),
 FOREIGN KEY(owner_id,assessment_id,previous_revision) REFERENCES assessment_revisions(owner_id,assessment_id,revision),
 FOREIGN KEY(owner_id,command_id) REFERENCES command_receipts(owner_id,command_id)
);
CREATE INDEX assessments_target ON assessment_revisions(owner_id,plan_id,step_id,sequence);
CREATE TRIGGER assessment_immutable_update BEFORE UPDATE ON assessment_revisions
BEGIN SELECT RAISE(ABORT,'ASSESSMENT_IMMUTABLE'); END;
CREATE TRIGGER assessment_immutable_delete BEFORE DELETE ON assessment_revisions
BEGIN SELECT RAISE(ABORT,'ASSESSMENT_IMMUTABLE'); END;

CREATE TRIGGER command_record_assessment AFTER INSERT ON command_receipts
WHEN NEW.command_type='RecordAssessment' AND NEW.outcome_code='PENDING'
BEGIN
 INSERT INTO assessment_revisions(owner_id,assessment_id,revision,previous_revision,plan_id,step_id,
   author_id,recorded_at,command_id,requirements_json,requirements_digest,assessment_json)
 SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.assessmentId'),NEW.expected_version+1,
   CASE WHEN NEW.expected_version=0 THEN NULL ELSE NEW.expected_version END,
   NEW.plan_id,json_extract(NEW.payload_json,'$.stepId'),NEW.actor_id,NEW.server_now_ms,NEW.command_id,
   json_extract(NEW.payload_json,'$.requirementsJson'),json_extract(NEW.payload_json,'$.requirementsDigest'),
   json_extract(NEW.payload_json,'$.assessmentJson')
 WHERE EXISTS(SELECT 1 FROM plans p WHERE p.owner_id=NEW.owner_id AND p.plan_id=NEW.plan_id AND p.deleted_at IS NULL)
   AND EXISTS(SELECT 1 FROM assessment_targets t WHERE t.owner_id=NEW.owner_id AND t.plan_id=NEW.plan_id
     AND t.step_id IS json_extract(NEW.payload_json,'$.stepId')
     AND t.requirements_json=json_extract(NEW.payload_json,'$.requirementsJson'))
   AND json_extract(NEW.payload_json,'$.expectedRequirementsDigest')=json_extract(NEW.payload_json,'$.requirementsDigest')
   AND COALESCE((SELECT MAX(a.revision) FROM assessment_revisions a WHERE a.owner_id=NEW.owner_id
     AND a.assessment_id=json_extract(NEW.payload_json,'$.assessmentId')),0)=NEW.expected_version
   AND NOT EXISTS(SELECT 1 FROM assessment_revisions a WHERE a.owner_id=NEW.owner_id
     AND a.assessment_id=json_extract(NEW.payload_json,'$.assessmentId')
     AND (a.plan_id<>NEW.plan_id OR a.step_id IS NOT json_extract(NEW.payload_json,'$.stepId')))
   AND NOT EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.sources') src
     WHERE NOT EXISTS(SELECT 1 FROM assessment_targets t WHERE t.owner_id=NEW.owner_id
       AND t.plan_id=json_extract(src.value,'$.planId') AND t.step_id IS json_extract(src.value,'$.stepId')));

 INSERT INTO tracker_journal(owner_id,event_id,plan_id,step_id,command_id,command_event_ordinal,server_sequence,
   event_type,payload_json,payload_hash,occurred_at,received_at,classification)
 SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.eventId'),NEW.plan_id,json_extract(NEW.payload_json,'$.stepId'),
   NEW.command_id,0,(SELECT next_sequence FROM tracker_owner_state WHERE owner_id=NEW.owner_id),
   'ASSESSMENT_RECORDED',json_extract(NEW.payload_json,'$.eventPayloadJson'),json_extract(NEW.payload_json,'$.eventPayloadHash'),
   NEW.server_now_ms,NEW.recorded_at,'NORMAL'
 WHERE EXISTS(SELECT 1 FROM assessment_revisions WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
   AND EXISTS(SELECT 1 FROM tracker_plan_config WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND enabled=1);

 UPDATE command_receipts SET outcome_code=CASE
   WHEN EXISTS(SELECT 1 FROM assessment_revisions WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
   WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
   WHEN json_extract(NEW.payload_json,'$.stepId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assessment_targets t
     WHERE t.owner_id=NEW.owner_id AND t.plan_id=NEW.plan_id AND t.step_id=json_extract(NEW.payload_json,'$.stepId')) THEN 'STEP_NOT_FOUND'
   WHEN EXISTS(SELECT 1 FROM assessment_revisions WHERE owner_id=NEW.owner_id AND assessment_id=json_extract(NEW.payload_json,'$.assessmentId')
     AND (plan_id<>NEW.plan_id OR step_id IS NOT json_extract(NEW.payload_json,'$.stepId'))) THEN 'ASSESSMENT_TARGET_CONFLICT'
   WHEN COALESCE((SELECT MAX(revision) FROM assessment_revisions WHERE owner_id=NEW.owner_id
     AND assessment_id=json_extract(NEW.payload_json,'$.assessmentId')),0)<>NEW.expected_version THEN 'VERSION_CONFLICT'
   WHEN json_extract(NEW.payload_json,'$.expectedRequirementsDigest') IS NOT json_extract(NEW.payload_json,'$.requirementsDigest')
     OR NOT EXISTS(SELECT 1 FROM assessment_targets t WHERE t.owner_id=NEW.owner_id AND t.plan_id=NEW.plan_id
       AND t.step_id IS json_extract(NEW.payload_json,'$.stepId') AND t.requirements_json=json_extract(NEW.payload_json,'$.requirementsJson')) THEN 'ASSESSMENT_CONTEXT_CHANGED'
   ELSE 'ASSESSMENT_SOURCE_NOT_FOUND' END,
 result_version=COALESCE((SELECT MAX(revision) FROM assessment_revisions WHERE owner_id=NEW.owner_id
   AND assessment_id=json_extract(NEW.payload_json,'$.assessmentId')),0),
 result_json=CASE WHEN EXISTS(SELECT 1 FROM assessment_revisions WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
   THEN (SELECT json_object('assessmentId',assessment_id,'revision',revision,'previousRevision',previous_revision,
     'planId',plan_id,'stepId',step_id,'requirementsDigest',requirements_digest,'sequence',sequence,'serverNow',NEW.server_now_ms)
     FROM assessment_revisions WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
   ELSE json_object('serverNow',NEW.server_now_ms) END
 WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;
