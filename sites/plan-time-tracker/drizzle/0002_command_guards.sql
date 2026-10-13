DROP TRIGGER command_review_commit;

CREATE TRIGGER command_review_commit AFTER INSERT ON command_receipts
WHEN NEW.command_type='ReviewCommitLink' AND NEW.outcome_code='PENDING'
BEGIN
  UPDATE plans SET version=version+1
   WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND version=NEW.expected_version
     AND EXISTS(SELECT 1 FROM plan_repositories pr WHERE pr.owner_id=NEW.owner_id
                 AND pr.plan_id=NEW.plan_id AND pr.repository_id=json_extract(NEW.payload_json,'$.repositoryId'))
     AND EXISTS(SELECT 1 FROM commits c WHERE c.owner_id=NEW.owner_id AND c.repository_id=json_extract(NEW.payload_json,'$.repositoryId')
                 AND c.sha=json_extract(NEW.payload_json,'$.sha'));
  INSERT INTO plan_events(event_id, owner_id, plan_id, command_id, actor_id, actor_type,
                          event_type, server_occurred_at, version_before, version_after, reason)
  SELECT lower(hex(randomblob(16))), NEW.owner_id, NEW.plan_id, NEW.command_id, NEW.actor_id,
         NEW.actor_type, 'COMMIT_LINK_REVIEWED', NEW.server_now_ms, NEW.expected_version,
         NEW.expected_version+1, json_extract(NEW.payload_json,'$.reason')
   WHERE changes()=1;
  INSERT INTO plan_commit_links(owner_id, plan_id, repository_id, sha, status, basis, reason, reviewed_by, reviewed_at, history_json)
  SELECT NEW.owner_id, NEW.plan_id, json_extract(NEW.payload_json,'$.repositoryId'), json_extract(NEW.payload_json,'$.sha'),
         json_extract(NEW.payload_json,'$.status'), 'manual', COALESCE(json_extract(NEW.payload_json,'$.reason'),''),
         NEW.actor_id, NEW.server_now_ms,
         COALESCE((SELECT json_group_array(json_object('status',status,'basis',basis,'reason',reason,'reviewedAt',reviewed_at))
                     FROM plan_commit_links old WHERE old.owner_id=NEW.owner_id AND old.plan_id=NEW.plan_id
                       AND old.repository_id=json_extract(NEW.payload_json,'$.repositoryId')
                       AND old.sha=json_extract(NEW.payload_json,'$.sha')),'[]')
   WHERE EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
  ON CONFLICT(owner_id, plan_id, repository_id, sha) DO UPDATE SET
    status=excluded.status, basis=excluded.basis, reason=excluded.reason,
    reviewed_by=excluded.reviewed_by, reviewed_at=excluded.reviewed_at,
    history_json=excluded.history_json;
  UPDATE plan_commit_links
     SET history_json=json_insert(history_json,'$[#]',json_object(
           'status',status,'basis',basis,'reason',reason,'reviewedAt',reviewed_at)),
         status='excluded',basis='manual',
         reason='Global owner exclusion supersedes all automatic attribution',
         reviewed_by=NEW.actor_id,reviewed_at=NEW.server_now_ms
   WHERE owner_id=NEW.owner_id
     AND repository_id=json_extract(NEW.payload_json,'$.repositoryId')
     AND sha=json_extract(NEW.payload_json,'$.sha')
     AND status<>'excluded'
     AND json_extract(NEW.payload_json,'$.status')='excluded'
     AND EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id);
  UPDATE commit_attribution_conflicts
     SET status='resolved',resolved_by=NEW.actor_id,resolved_at=NEW.server_now_ms
   WHERE owner_id=NEW.owner_id
     AND repository_id=json_extract(NEW.payload_json,'$.repositoryId')
     AND sha=json_extract(NEW.payload_json,'$.sha')
     AND json_extract(NEW.payload_json,'$.status') IN ('confirmed','excluded')
     AND EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id);
  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
      WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
      ELSE 'VALIDATION_ERROR' END,
    result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN json_object('planId',NEW.plan_id,'status',(SELECT status FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
                       'version',NEW.expected_version+1,'serverNow',NEW.server_now_ms)
      ELSE (SELECT json_object('error',outcome_code,'planId',NEW.plan_id,'status',status,
                               'currentVersion',version,'serverNow',NEW.server_now_ms)
              FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;
