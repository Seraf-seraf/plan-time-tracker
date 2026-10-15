-- Add content-addressed worktree evidence without rewriting historical results or checks.
-- A snapshot digest identifies source contents; a baseline SHA is context, never testedSha.
CREATE TABLE step_result_snapshots (
  owner_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  result_revision INTEGER NOT NULL,
  result_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest)=71 AND substr(snapshot_digest,1,7)='sha256:' AND substr(snapshot_digest,8) NOT GLOB '*[^a-f0-9]*'),
  format_version INTEGER NOT NULL CHECK(format_version=1),
  base_revision_sha TEXT CHECK(base_revision_sha IS NULL OR (length(base_revision_sha)=40 AND base_revision_sha NOT GLOB '*[^a-f0-9]*')),
  PRIMARY KEY(owner_id,step_id,result_revision),
  UNIQUE(owner_id,step_id,result_revision,snapshot_digest),
  FOREIGN KEY(owner_id,step_id,result_id,result_revision) REFERENCES step_results(owner_id,step_id,result_id,revision),
  FOREIGN KEY(owner_id,repository_id) REFERENCES repositories(owner_id,repository_id)
);
CREATE TRIGGER step_result_snapshots_immutable_update BEFORE UPDATE ON step_result_snapshots
BEGIN SELECT RAISE(ABORT, 'STEP_RESULT_SNAPSHOTS_ARE_IMMUTABLE'); END;
CREATE TRIGGER step_result_snapshots_immutable_delete BEFORE DELETE ON step_result_snapshots
BEGIN SELECT RAISE(ABORT, 'STEP_RESULT_SNAPSHOTS_ARE_IMMUTABLE'); END;
CREATE TRIGGER step_result_snapshot_kind BEFORE INSERT ON step_result_snapshots
WHEN EXISTS(SELECT 1 FROM step_results r WHERE r.owner_id=NEW.owner_id AND r.step_id=NEW.step_id AND r.revision=NEW.result_revision AND r.revision_sha IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'RESULT_SOURCE_KIND_CONFLICT'); END;

CREATE TABLE step_snapshot_checks (
  owner_id TEXT NOT NULL,
  check_id TEXT NOT NULL CHECK(length(check_id)=36 AND substr(check_id,9,1)='-' AND substr(check_id,14,1)='-' AND substr(check_id,19,1)='-' AND substr(check_id,24,1)='-'),
  step_id TEXT NOT NULL,
  result_revision INTEGER NOT NULL CHECK(typeof(result_revision)='integer' AND result_revision>=1),
  event_id TEXT NOT NULL,
  check_key TEXT NOT NULL CHECK(length(trim(check_key)) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK(status IN ('PASSED','FAILED','NOT_RUN')),
  tested_snapshot_digest TEXT NOT NULL CHECK(length(tested_snapshot_digest)=71 AND substr(tested_snapshot_digest,1,7)='sha256:' AND substr(tested_snapshot_digest,8) NOT GLOB '*[^a-f0-9]*'),
  exit_code INTEGER CHECK(exit_code IS NULL OR (typeof(exit_code)='integer' AND exit_code BETWEEN 0 AND 255)),
  evidence_summary TEXT CHECK(evidence_summary IS NULL OR length(evidence_summary)<=2000),
  evidence_url TEXT CHECK(evidence_url IS NULL OR (length(evidence_url)<=2048 AND substr(evidence_url,1,8)='https://')),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
  PRIMARY KEY(owner_id,check_id),
  CHECK((status='PASSED' AND exit_code=0) OR (status='FAILED' AND exit_code BETWEEN 1 AND 255) OR (status='NOT_RUN' AND exit_code IS NULL)),
  FOREIGN KEY(owner_id,step_id,result_revision,tested_snapshot_digest) REFERENCES step_result_snapshots(owner_id,step_id,result_revision,snapshot_digest),
  FOREIGN KEY(owner_id,event_id,step_id) REFERENCES tracker_journal(owner_id,event_id,step_id)
);
CREATE INDEX step_snapshot_checks_result_status ON step_snapshot_checks(owner_id,step_id,result_revision,status);
CREATE TRIGGER step_snapshot_checks_immutable_update BEFORE UPDATE ON step_snapshot_checks
BEGIN SELECT RAISE(ABORT, 'STEP_CHECKS_ARE_IMMUTABLE'); END;
CREATE TRIGGER step_snapshot_checks_immutable_delete BEFORE DELETE ON step_snapshot_checks
BEGIN SELECT RAISE(ABORT, 'STEP_CHECKS_ARE_IMMUTABLE'); END;

CREATE VIEW tracker_result_sources AS
SELECT r.*,COALESCE(r.repository_id,w.repository_id) AS source_repository_id,
       CASE WHEN w.result_id IS NOT NULL THEN 'WORKTREE_SNAPSHOT' WHEN r.revision_sha IS NOT NULL THEN 'COMMIT' ELSE 'NONE' END AS source_kind,
       w.snapshot_digest,w.format_version AS snapshot_format_version,w.base_revision_sha
FROM step_results r LEFT JOIN step_result_snapshots w
  ON w.owner_id=r.owner_id AND w.step_id=r.step_id AND w.result_revision=r.revision;

CREATE VIEW tracker_check_evidence AS
SELECT c.*,NULL AS tested_snapshot_digest FROM step_checks c
UNION ALL
SELECT owner_id,check_id,step_id,result_revision,event_id,check_key,status,NULL AS tested_sha,
       exit_code,evidence_summary,evidence_url,created_at,tested_snapshot_digest FROM step_snapshot_checks;

CREATE VIEW tracker_checks_with_source AS
SELECT c.*,j.server_sequence,r.source_repository_id AS result_repository_id,r.source_kind,
       CASE WHEN (r.source_kind='COMMIT' AND c.tested_sha=r.revision_sha AND c.tested_snapshot_digest IS NULL)
              OR (r.source_kind='WORKTREE_SNAPSHOT' AND c.tested_snapshot_digest=r.snapshot_digest AND c.tested_sha IS NULL)
            THEN 1 ELSE 0 END AS matches_result
FROM tracker_check_evidence c
JOIN tracker_result_sources r ON r.owner_id=c.owner_id AND r.step_id=c.step_id AND r.revision=c.result_revision
JOIN tracker_journal j ON j.owner_id=c.owner_id AND j.step_id=c.step_id AND j.event_id=c.event_id;

CREATE VIEW tracker_latest_checks AS
SELECT c.* FROM tracker_checks_with_source c
WHERE NOT EXISTS(SELECT 1 FROM tracker_checks_with_source newer
  WHERE newer.owner_id=c.owner_id AND newer.step_id=c.step_id AND newer.result_revision=c.result_revision
    AND newer.check_key=c.check_key AND newer.server_sequence>c.server_sequence);

DROP VIEW tracker_incomplete_steps;
CREATE VIEW tracker_incomplete_steps AS
SELECT s.owner_id,s.plan_id,s.step_id,s.ordinal,s.title,s.status,s.version,
       s.current_result_revision,s.current_fence
FROM plan_steps s LEFT JOIN step_results r
  ON r.owner_id=s.owner_id AND r.step_id=s.step_id AND r.revision=s.current_result_revision
WHERE s.status<>'DONE' OR s.current_result_revision IS NULL OR r.outcome IS NULL OR r.outcome<>'DONE'
   OR EXISTS(SELECT 1 FROM step_attempts a WHERE a.owner_id=s.owner_id AND a.step_id=s.step_id AND a.status='OPEN')
   OR EXISTS(SELECT 1 FROM json_each(s.required_checks_json) required
     WHERE NOT EXISTS(SELECT 1 FROM tracker_latest_checks c
       WHERE c.owner_id=s.owner_id AND c.step_id=s.step_id AND c.result_revision=s.current_result_revision
         AND c.check_key=CAST(required.value AS TEXT) AND c.status='PASSED' AND c.matches_result=1));

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
     AND (COALESCE(json_extract(NEW.payload_json,'$.worktreeSnapshot.repositoryId'),json_extract(NEW.payload_json,'$.repositoryId')) IS NULL OR EXISTS(
       SELECT 1 FROM repositories repo JOIN plan_repositories allowed_repo
         ON allowed_repo.owner_id=repo.owner_id AND allowed_repo.repository_id=repo.repository_id
       WHERE repo.owner_id=NEW.owner_id AND repo.repository_id=COALESCE(json_extract(NEW.payload_json,'$.worktreeSnapshot.repositoryId'),json_extract(NEW.payload_json,'$.repositoryId'))
         AND repo.access_state='available' AND allowed_repo.plan_id=s.plan_id));

  INSERT INTO step_result_snapshots(owner_id,step_id,result_revision,result_id,repository_id,snapshot_digest,format_version,base_revision_sha)
  SELECT r.owner_id,r.step_id,r.revision,r.result_id,
    json_extract(NEW.payload_json,'$.worktreeSnapshot.repositoryId'),json_extract(NEW.payload_json,'$.worktreeSnapshot.digest'),
    json_extract(NEW.payload_json,'$.worktreeSnapshot.formatVersion'),json_extract(NEW.payload_json,'$.worktreeSnapshot.baseRevisionSha')
  FROM step_results r WHERE r.owner_id=NEW.owner_id AND r.result_id=json_extract(NEW.payload_json,'$.resultId')
    AND json_extract(NEW.payload_json,'$.worktreeSnapshot.kind')='WORKTREE_SNAPSHOT';

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
      WHEN COALESCE(json_extract(NEW.payload_json,'$.worktreeSnapshot.repositoryId'),json_extract(NEW.payload_json,'$.repositoryId')) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM repositories repo WHERE repo.owner_id=NEW.owner_id AND repo.repository_id=COALESCE(json_extract(NEW.payload_json,'$.worktreeSnapshot.repositoryId'),json_extract(NEW.payload_json,'$.repositoryId')) AND repo.access_state='available') THEN 'REPOSITORY_UNAVAILABLE'
      WHEN COALESCE(json_extract(NEW.payload_json,'$.worktreeSnapshot.repositoryId'),json_extract(NEW.payload_json,'$.repositoryId')) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM plan_repositories pr WHERE pr.owner_id=NEW.owner_id AND pr.plan_id=(SELECT plan_id FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')) AND pr.repository_id=COALESCE(json_extract(NEW.payload_json,'$.worktreeSnapshot.repositoryId'),json_extract(NEW.payload_json,'$.repositoryId'))) THEN 'REPOSITORY_NOT_ATTACHED'
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
   FROM plan_steps s JOIN tracker_result_sources r ON r.owner_id=s.owner_id AND r.step_id=s.step_id
     AND r.revision=json_extract(NEW.payload_json,'$.resultRevision')
     JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
     JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id AND c.enabled=1
   WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId')
     AND ((r.source_kind='COMMIT' AND r.revision_sha=json_extract(NEW.payload_json,'$.testedSha') AND json_extract(NEW.payload_json,'$.testedSnapshotDigest') IS NULL) OR (r.source_kind='WORKTREE_SNAPSHOT' AND r.snapshot_digest=json_extract(NEW.payload_json,'$.testedSnapshotDigest') AND json_extract(NEW.payload_json,'$.testedSha') IS NULL))
     AND (p.status='RUNNING' OR (NEW.actor_type='user' AND p.status IN ('PAUSED','COMPLETED')));

  INSERT INTO step_checks(owner_id,check_id,step_id,result_revision,event_id,check_key,status,tested_sha,exit_code,evidence_summary,evidence_url,created_at)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.checkId'),json_extract(NEW.payload_json,'$.stepId'),
    json_extract(NEW.payload_json,'$.resultRevision'),json_extract(NEW.payload_json,'$.eventId'),
    json_extract(NEW.payload_json,'$.checkKey'),json_extract(NEW.payload_json,'$.status'),
    json_extract(NEW.payload_json,'$.testedSha'),json_extract(NEW.payload_json,'$.exitCode'),
    json_extract(NEW.payload_json,'$.evidenceSummary'),json_extract(NEW.payload_json,'$.evidenceUrl'),NEW.server_now_ms
   WHERE EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND event_id=json_extract(NEW.payload_json,'$.eventId')) AND json_extract(NEW.payload_json,'$.testedSha') IS NOT NULL;

  INSERT INTO step_snapshot_checks(owner_id,check_id,step_id,result_revision,event_id,check_key,status,tested_snapshot_digest,exit_code,evidence_summary,evidence_url,created_at)
  SELECT NEW.owner_id,json_extract(NEW.payload_json,'$.checkId'),json_extract(NEW.payload_json,'$.stepId'),
    json_extract(NEW.payload_json,'$.resultRevision'),json_extract(NEW.payload_json,'$.eventId'),
    json_extract(NEW.payload_json,'$.checkKey'),json_extract(NEW.payload_json,'$.status'),
    json_extract(NEW.payload_json,'$.testedSnapshotDigest'),json_extract(NEW.payload_json,'$.exitCode'),
    json_extract(NEW.payload_json,'$.evidenceSummary'),json_extract(NEW.payload_json,'$.evidenceUrl'),NEW.server_now_ms
   WHERE EXISTS(SELECT 1 FROM tracker_journal WHERE owner_id=NEW.owner_id AND event_id=json_extract(NEW.payload_json,'$.eventId')) AND json_extract(NEW.payload_json,'$.testedSnapshotDigest') IS NOT NULL;

  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM tracker_check_evidence WHERE owner_id=NEW.owner_id AND check_id=json_extract(NEW.payload_json,'$.checkId')) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')) THEN 'STEP_NOT_FOUND'
      WHEN NOT EXISTS(SELECT 1 FROM plan_steps s JOIN tracker_plan_config c ON c.owner_id=s.owner_id AND c.plan_id=s.plan_id
        WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND c.enabled=1) THEN 'FEATURE_UNAVAILABLE'
      WHEN NOT EXISTS(SELECT 1 FROM step_results WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')
        AND revision=json_extract(NEW.payload_json,'$.resultRevision')) THEN 'RESULT_REVISION_STALE'
      WHEN NOT EXISTS(SELECT 1 FROM tracker_result_sources r WHERE r.owner_id=NEW.owner_id AND r.step_id=json_extract(NEW.payload_json,'$.stepId') AND r.revision=json_extract(NEW.payload_json,'$.resultRevision') AND ((r.source_kind='COMMIT' AND r.revision_sha=json_extract(NEW.payload_json,'$.testedSha') AND json_extract(NEW.payload_json,'$.testedSnapshotDigest') IS NULL) OR (r.source_kind='WORKTREE_SNAPSHOT' AND r.snapshot_digest=json_extract(NEW.payload_json,'$.testedSnapshotDigest') AND json_extract(NEW.payload_json,'$.testedSha') IS NULL))) THEN 'RESULT_REVISION_STALE'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
        WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='PAUSED') THEN 'PLAN_PAUSED'
      WHEN EXISTS(SELECT 1 FROM plan_steps s JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id
        WHERE s.owner_id=NEW.owner_id AND s.step_id=json_extract(NEW.payload_json,'$.stepId') AND p.status='COMPLETED') THEN 'PLAN_COMPLETED'
      ELSE 'INVALID_TRANSITION' END,
    result_version=(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM tracker_check_evidence WHERE owner_id=NEW.owner_id AND check_id=json_extract(NEW.payload_json,'$.checkId'))
      THEN json_object('stepId',json_extract(NEW.payload_json,'$.stepId'),'checkId',json_extract(NEW.payload_json,'$.checkId'),
        'resultRevision',json_extract(NEW.payload_json,'$.resultRevision'),'checkKey',json_extract(NEW.payload_json,'$.checkKey'),
        'status',json_extract(NEW.payload_json,'$.status'),'version',(SELECT version FROM plan_steps WHERE owner_id=NEW.owner_id AND step_id=json_extract(NEW.payload_json,'$.stepId')),'serverNow',NEW.server_now_ms)
      ELSE json_object('error',outcome_code,'stepId',json_extract(NEW.payload_json,'$.stepId'),'serverNow',NEW.server_now_ms) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;
