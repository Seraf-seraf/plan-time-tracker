-- Remove the application length cap while preserving saved documents and creation semantics.
DROP TRIGGER command_create_plan;
CREATE TABLE plan_documents_unlimited (
  owner_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  markdown TEXT NOT NULL CHECK(length(markdown) >= 1),
  PRIMARY KEY(owner_id,plan_id),
  FOREIGN KEY(owner_id,plan_id) REFERENCES plans(owner_id,plan_id)
);
INSERT INTO plan_documents_unlimited SELECT owner_id,plan_id,markdown FROM plan_documents;
DROP TABLE plan_documents;
ALTER TABLE plan_documents_unlimited RENAME TO plan_documents;

CREATE TRIGGER command_create_plan AFTER INSERT ON command_receipts
WHEN NEW.command_type='CreatePlan' AND NEW.outcome_code='PENDING'
BEGIN
 INSERT OR IGNORE INTO owners(owner_id,created_at) VALUES(NEW.owner_id,NEW.server_now_ms);
 INSERT OR IGNORE INTO plans(plan_id,owner_id,title,description,acceptance_criteria,plan_created_precision,plan_created_at_ms,plan_created_on,plan_created_timezone,registered_at,status,version,created_by,source_reference)
 VALUES(NEW.plan_id,NEW.owner_id,json_extract(NEW.payload_json,'$.title'),COALESCE(json_extract(NEW.payload_json,'$.description'),''),COALESCE(json_extract(NEW.payload_json,'$.acceptanceCriteria'),''),json_extract(NEW.payload_json,'$.planCreatedAt.precision'),json_extract(NEW.payload_json,'$.planCreatedAt.atMs'),json_extract(NEW.payload_json,'$.planCreatedAt.on'),json_extract(NEW.payload_json,'$.planCreatedAt.timeZone'),NEW.server_now_ms,'PLANNED',0,NEW.actor_id,json_extract(NEW.payload_json,'$.sourceReference'));
 UPDATE command_receipts SET outcome_code=CASE WHEN changes()=1 THEN 'OK' ELSE 'VALIDATION_ERROR' END,result_version=0,
 result_json=json_object('planId',NEW.plan_id,'status','PLANNED','version',0,'registeredAt',NEW.server_now_ms,'serverNow',NEW.server_now_ms)
 WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
 INSERT INTO plan_documents(owner_id,plan_id,markdown)
 SELECT NEW.owner_id,NEW.plan_id,json_extract(NEW.payload_json,'$.planText') WHERE json_type(NEW.payload_json,'$.planText')='text' AND EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
 INSERT INTO plan_steps(owner_id,plan_id,step_id,ordinal,title,content,created_at,updated_at)
 SELECT NEW.owner_id,NEW.plan_id,json_extract(value,'$.stepId'),json_extract(value,'$.ordinal'),json_extract(value,'$.title'),json_extract(value,'$.content'),NEW.server_now_ms,NEW.server_now_ms FROM json_each(NEW.payload_json,'$.documentSteps') WHERE EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
 INSERT INTO assessment_targets(owner_id,plan_id,step_id,requirements_json)
 SELECT NEW.owner_id,NEW.plan_id,json_extract(value,'$.stepId'),json_extract(value,'$.requirementsJson') FROM json_each(NEW.payload_json,'$.requirementsTargets') WHERE json_extract(value,'$.stepId') IS NULL AND EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
 -- Derive each stage's requirements here instead of duplicating the full plan per stage in the receipt.
 INSERT INTO assessment_targets(owner_id,plan_id,step_id,requirements_json)
 SELECT s.owner_id,s.plan_id,s.step_id,
   json_object('plan',json_extract(t.requirements_json,'$.plan'),'step',json_object('stepId',s.step_id,'title',s.title,'content',s.content))
 FROM plan_steps s JOIN assessment_targets t ON t.owner_id=s.owner_id AND t.plan_id=s.plan_id AND t.step_id IS NULL
 WHERE s.owner_id=NEW.owner_id AND s.plan_id=NEW.plan_id
   AND EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
END;

-- Metadata edits update requirements in place instead of copying every document into the receipt.
DROP TRIGGER command_update_metadata;
CREATE TRIGGER command_update_metadata AFTER INSERT ON command_receipts
WHEN NEW.command_type='UpdatePlanMetadata' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT INTO plan_date_history(history_id, owner_id, plan_id, old_precision, old_at_ms, old_on,
                                old_timezone, changed_at, changed_by, reason)
  SELECT lower(hex(randomblob(16))), owner_id, plan_id, plan_created_precision, plan_created_at_ms,
         plan_created_on, plan_created_timezone, NEW.server_now_ms, NEW.actor_id,
         COALESCE(json_extract(NEW.payload_json,'$.reason'),'')
    FROM plans
   WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND version=NEW.expected_version
     AND (json_type(NEW.payload_json,'$.planCreatedAt') IS NOT NULL)
     AND (plan_created_precision<>json_extract(NEW.payload_json,'$.planCreatedAt.precision')
       OR plan_created_at_ms IS NOT json_extract(NEW.payload_json,'$.planCreatedAt.atMs')
       OR plan_created_on IS NOT json_extract(NEW.payload_json,'$.planCreatedAt.on')
       OR plan_created_timezone<>json_extract(NEW.payload_json,'$.planCreatedAt.timeZone'))
     AND (json_type(NEW.payload_json,'$.planCreatedAt.precision') IS NULL OR status='PLANNED'
       OR json_extract(NEW.payload_json,'$.dateAfterStart')<>1
       OR json_extract(NEW.payload_json,'$.confirmDateAnomaly')=1)
     AND (first_started_at IS NULL OR json_type(NEW.payload_json,'$.planCreatedAt.precision') IS NULL
       OR json_extract(NEW.payload_json,'$.dateAfterStart')<>1
       OR json_extract(NEW.payload_json,'$.confirmDateAnomaly')=1);
  UPDATE plans SET
    title=CASE WHEN json_type(NEW.payload_json,'$.title') IS NULL THEN title ELSE json_extract(NEW.payload_json,'$.title') END,
    description=CASE WHEN json_type(NEW.payload_json,'$.description') IS NULL THEN description ELSE COALESCE(json_extract(NEW.payload_json,'$.description'),'') END,
    acceptance_criteria=CASE WHEN json_type(NEW.payload_json,'$.acceptanceCriteria') IS NULL THEN acceptance_criteria ELSE COALESCE(json_extract(NEW.payload_json,'$.acceptanceCriteria'),'') END,
    plan_created_precision=CASE WHEN json_type(NEW.payload_json,'$.planCreatedAt.precision') IS NULL THEN plan_created_precision ELSE json_extract(NEW.payload_json,'$.planCreatedAt.precision') END,
    plan_created_at_ms=CASE WHEN json_type(NEW.payload_json,'$.planCreatedAt.precision') IS NULL THEN plan_created_at_ms ELSE json_extract(NEW.payload_json,'$.planCreatedAt.atMs') END,
    plan_created_on=CASE WHEN json_type(NEW.payload_json,'$.planCreatedAt.precision') IS NULL THEN plan_created_on ELSE json_extract(NEW.payload_json,'$.planCreatedAt.on') END,
    plan_created_timezone=CASE WHEN json_type(NEW.payload_json,'$.planCreatedAt.timeZone') IS NULL THEN plan_created_timezone ELSE json_extract(NEW.payload_json,'$.planCreatedAt.timeZone') END,
    version=version+1
   WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND version=NEW.expected_version
     AND (json_type(NEW.payload_json,'$.planCreatedAt.precision') IS NULL OR status='PLANNED'
       OR json_extract(NEW.payload_json,'$.dateAfterStart')<>1
       OR json_extract(NEW.payload_json,'$.confirmDateAnomaly')=1)
     AND (first_started_at IS NULL OR json_type(NEW.payload_json,'$.planCreatedAt.precision') IS NULL
       OR json_extract(NEW.payload_json,'$.dateAfterStart')<>1
       OR json_extract(NEW.payload_json,'$.confirmDateAnomaly')=1);
UPDATE command_receipts SET outcome_code=CASE
 WHEN changes()=1 THEN 'OK'
 WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
 WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
 WHEN json_extract(NEW.payload_json,'$.dateAfterStart')=1 AND COALESCE(json_extract(NEW.payload_json,'$.confirmDateAnomaly'),0)<>1 THEN 'VALIDATION_ERROR'
 ELSE 'INVALID_TRANSITION' END,
 result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
 result_json=COALESCE((SELECT json_object('planId',plan_id,'status',status,'version',version,'currentVersion',version,'serverNow',NEW.server_now_ms,'firstStartedAt',first_started_at,'finishedAt',finished_at,'deletedAt',deleted_at) FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),json_object('serverNow',NEW.server_now_ms))
 WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
 UPDATE assessment_targets SET requirements_json=json_set(requirements_json,'$.plan.title',COALESCE(json_extract(NEW.payload_json,'$.title'),'')) WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND json_type(requirements_json,'$.plan.title') IS NOT NULL AND json_type(NEW.payload_json,'$.title') IS NOT NULL AND EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
 UPDATE assessment_targets SET requirements_json=json_set(requirements_json,'$.plan.description',COALESCE(json_extract(NEW.payload_json,'$.description'),'')) WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND json_type(requirements_json,'$.plan.description') IS NOT NULL AND json_type(NEW.payload_json,'$.description') IS NOT NULL AND EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
 UPDATE assessment_targets SET requirements_json=json_set(requirements_json,'$.plan.acceptanceCriteria',COALESCE(json_extract(NEW.payload_json,'$.acceptanceCriteria'),'')) WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND json_type(requirements_json,'$.plan.acceptanceCriteria') IS NOT NULL AND json_type(NEW.payload_json,'$.acceptanceCriteria') IS NOT NULL AND EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id AND outcome_code='OK');
END;
