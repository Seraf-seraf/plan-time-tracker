PRAGMA foreign_keys = ON;

CREATE TABLE owners (
  owner_id TEXT PRIMARY KEY,
  email TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  locale TEXT NOT NULL DEFAULT 'en',
  created_at INTEGER NOT NULL
);

CREATE TABLE plans (
  plan_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES owners(owner_id),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  plan_created_precision TEXT NOT NULL CHECK(plan_created_precision IN ('instant','dateOnly')),
  plan_created_at_ms INTEGER,
  plan_created_on TEXT,
  plan_created_timezone TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PLANNED','RUNNING','PAUSED','COMPLETED')),
  first_started_at INTEGER,
  finished_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  created_by TEXT NOT NULL,
  source_reference TEXT,
  CHECK((plan_created_precision='instant' AND plan_created_at_ms IS NOT NULL AND plan_created_on IS NULL)
     OR (plan_created_precision='dateOnly' AND plan_created_at_ms IS NULL AND plan_created_on IS NOT NULL)),
  CHECK((status='RUNNING') = (first_started_at IS NOT NULL AND finished_at IS NULL)
     OR status='PAUSED' AND first_started_at IS NOT NULL AND finished_at IS NULL
     OR status='COMPLETED' AND first_started_at IS NOT NULL AND finished_at IS NOT NULL
     OR status='PLANNED' AND first_started_at IS NULL AND finished_at IS NULL),
  PRIMARY KEY(owner_id, plan_id)
);

CREATE UNIQUE INDEX plans_one_running_per_owner
  ON plans(owner_id) WHERE status='RUNNING';
CREATE INDEX plans_owner_registered ON plans(owner_id, registered_at DESC);
CREATE INDEX plans_owner_finished ON plans(owner_id, finished_at DESC) WHERE status='COMPLETED';

CREATE TABLE repositories (
  owner_id TEXT NOT NULL REFERENCES owners(owner_id),
  repository_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  is_private INTEGER NOT NULL CHECK(is_private IN (0,1)),
  default_branch TEXT NOT NULL,
  access_state TEXT NOT NULL CHECK(access_state IN ('available','revoked','unavailable')),
  selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0,1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id, repository_id),
  UNIQUE(owner_id, full_name)
);

CREATE TABLE plan_repositories (
  owner_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  selected_ref TEXT,
  fixed_at INTEGER,
  PRIMARY KEY(owner_id, plan_id, repository_id),
  FOREIGN KEY(owner_id, plan_id) REFERENCES plans(owner_id, plan_id),
  FOREIGN KEY(owner_id, repository_id) REFERENCES repositories(owner_id, repository_id)
);
CREATE INDEX plan_repositories_repo ON plan_repositories(owner_id, repository_id, plan_id);

CREATE TABLE work_intervals (
  interval_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,
  opened_by TEXT NOT NULL,
  closed_by TEXT,
  CHECK(end_ms IS NULL OR end_ms >= start_ms),
  FOREIGN KEY(owner_id, plan_id) REFERENCES plans(owner_id, plan_id)
);
CREATE UNIQUE INDEX work_intervals_one_open_per_plan
  ON work_intervals(owner_id, plan_id) WHERE end_ms IS NULL;
CREATE INDEX work_intervals_owner_plan_start
  ON work_intervals(owner_id, plan_id, start_ms);

CREATE TRIGGER work_intervals_no_overlap_insert
BEFORE INSERT ON work_intervals
WHEN EXISTS (
  SELECT 1 FROM work_intervals old
   WHERE old.owner_id=NEW.owner_id AND old.plan_id=NEW.plan_id
     AND NEW.start_ms < COALESCE(old.end_ms, 9223372036854775807)
     AND COALESCE(NEW.end_ms, 9223372036854775807) > old.start_ms
)
BEGIN
  SELECT RAISE(ABORT, 'WORK_INTERVAL_OVERLAP');
END;

CREATE TRIGGER work_intervals_no_overlap_close
BEFORE UPDATE OF end_ms ON work_intervals
WHEN NEW.end_ms IS NOT NULL AND EXISTS (
  SELECT 1 FROM work_intervals old
   WHERE old.owner_id=NEW.owner_id AND old.plan_id=NEW.plan_id AND old.interval_id<>NEW.interval_id
     AND NEW.start_ms < COALESCE(old.end_ms, 9223372036854775807)
     AND NEW.end_ms > old.start_ms
)
BEGIN
  SELECT RAISE(ABORT, 'WORK_INTERVAL_OVERLAP');
END;

CREATE TABLE plan_events (
  event_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','agent','system')),
  event_type TEXT NOT NULL,
  server_occurred_at INTEGER NOT NULL,
  version_before INTEGER NOT NULL,
  version_after INTEGER NOT NULL,
  reason TEXT,
  UNIQUE(owner_id, command_id),
  FOREIGN KEY(owner_id, plan_id) REFERENCES plans(owner_id, plan_id)
);
CREATE INDEX plan_events_owner_plan_time ON plan_events(owner_id, plan_id, server_occurred_at);
CREATE TRIGGER plan_events_immutable_update BEFORE UPDATE ON plan_events
BEGIN SELECT RAISE(ABORT, 'PLAN_EVENTS_ARE_IMMUTABLE'); END;
CREATE TRIGGER plan_events_immutable_delete BEFORE DELETE ON plan_events
BEGIN SELECT RAISE(ABORT, 'PLAN_EVENTS_ARE_IMMUTABLE'); END;

CREATE TABLE plan_date_history (
  history_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  old_precision TEXT NOT NULL,
  old_at_ms INTEGER,
  old_on TEXT,
  old_timezone TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  changed_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  FOREIGN KEY(owner_id, plan_id) REFERENCES plans(owner_id, plan_id)
);

CREATE TABLE command_receipts (
  owner_id TEXT NOT NULL REFERENCES owners(owner_id),
  command_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  command_type TEXT NOT NULL,
  plan_id TEXT,
  expected_version INTEGER,
  server_now_ms INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','agent','system')),
  payload_json TEXT NOT NULL,
  outcome_code TEXT NOT NULL DEFAULT 'PENDING',
  result_version INTEGER,
  result_json TEXT,
  execution_lease_until INTEGER,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id, command_id)
);
CREATE INDEX command_receipts_recorded ON command_receipts(owner_id, recorded_at);
CREATE TRIGGER command_receipts_no_delete BEFORE DELETE ON command_receipts
BEGIN SELECT RAISE(ABORT, 'COMMAND_RECEIPTS_ARE_RETAINED'); END;

CREATE TABLE repository_sync_state (
  owner_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  last_successful_sync_at INTEGER,
  cursor TEXT,
  completeness TEXT NOT NULL DEFAULT 'none' CHECK(completeness IN ('none','complete','partial')),
  last_error_code TEXT,
  reconciliation_id TEXT,
  author_filter_json TEXT,
  PRIMARY KEY(owner_id, repository_id, ref),
  FOREIGN KEY(owner_id, repository_id) REFERENCES repositories(owner_id, repository_id)
);

CREATE TABLE commits (
  owner_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  author_at INTEGER,
  committer_at INTEGER,
  observed_at INTEGER NOT NULL,
  author_github_id TEXT,
  committer_github_id TEXT,
  author_login TEXT,
  committer_login TEXT,
  author_type TEXT NOT NULL DEFAULT 'Unknown',
  committer_type TEXT NOT NULL DEFAULT 'Unknown',
  author_name TEXT,
  committer_name TEXT,
  message TEXT NOT NULL,
  url TEXT NOT NULL,
  parents_json TEXT NOT NULL DEFAULT '[]',
  refs_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(owner_id, repository_id, sha),
  FOREIGN KEY(owner_id, repository_id) REFERENCES repositories(owner_id, repository_id)
);

CREATE TABLE repository_ref_commits (
  owner_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  sha TEXT NOT NULL,
  last_seen_sync_id TEXT NOT NULL,
  PRIMARY KEY(owner_id, repository_id, ref, sha),
  FOREIGN KEY(owner_id, repository_id) REFERENCES repositories(owner_id, repository_id),
  FOREIGN KEY(owner_id, repository_id, sha) REFERENCES commits(owner_id, repository_id, sha)
);

CREATE TABLE plan_commit_links (
  owner_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('confirmed','candidate','excluded')),
  basis TEXT NOT NULL CHECK(basis IN ('marker','manual','time')),
  reason TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL,
  reviewed_at INTEGER NOT NULL,
  history_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(owner_id, plan_id, repository_id, sha),
  FOREIGN KEY(owner_id, plan_id) REFERENCES plans(owner_id, plan_id),
  FOREIGN KEY(owner_id, repository_id) REFERENCES repositories(owner_id, repository_id),
  FOREIGN KEY(owner_id, repository_id, sha) REFERENCES commits(owner_id, repository_id, sha)
);

CREATE UNIQUE INDEX plan_commit_links_one_confirmed_owner_repo_sha
  ON plan_commit_links(owner_id, repository_id, sha) WHERE status='confirmed';

CREATE TABLE commit_attribution_conflicts (
  owner_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  marker_plan_ids_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'unresolved' CHECK(status IN ('unresolved','resolved')),
  resolved_by TEXT,
  resolved_at INTEGER,
  PRIMARY KEY(owner_id, repository_id, sha),
  FOREIGN KEY(owner_id, repository_id, sha) REFERENCES commits(owner_id, repository_id, sha)
);

CREATE TRIGGER command_create_plan AFTER INSERT ON command_receipts
WHEN NEW.command_type='CreatePlan' AND NEW.outcome_code='PENDING'
BEGIN
  INSERT INTO owners(owner_id, created_at) VALUES(NEW.owner_id, NEW.server_now_ms)
    ON CONFLICT(owner_id) DO NOTHING;
  INSERT INTO plans (
    plan_id, owner_id, title, description, acceptance_criteria,
    plan_created_precision, plan_created_at_ms, plan_created_on,
    plan_created_timezone, registered_at, status, version, created_by, source_reference
  )
  SELECT NEW.plan_id, NEW.owner_id,
         json_extract(NEW.payload_json,'$.title'),
         COALESCE(json_extract(NEW.payload_json,'$.description'),''),
         COALESCE(json_extract(NEW.payload_json,'$.acceptanceCriteria'),''),
         json_extract(NEW.payload_json,'$.planCreatedAt.precision'),
         json_extract(NEW.payload_json,'$.planCreatedAt.atMs'),
         json_extract(NEW.payload_json,'$.planCreatedAt.on'),
         json_extract(NEW.payload_json,'$.planCreatedAt.timeZone'),
         NEW.server_now_ms, 'PLANNED', 0,
         NEW.actor_id, json_extract(NEW.payload_json,'$.sourceReference')
  WHERE json_extract(NEW.payload_json,'$.title') IS NOT NULL
    AND json_extract(NEW.payload_json,'$.planCreatedAt.precision') IN ('instant','dateOnly')
    AND json_extract(NEW.payload_json,'$.planCreatedAt.timeZone') IS NOT NULL
    AND ((json_extract(NEW.payload_json,'$.planCreatedAt.precision')='instant'
          AND json_extract(NEW.payload_json,'$.planCreatedAt.atMs') IS NOT NULL
          AND json_extract(NEW.payload_json,'$.planCreatedAt.on') IS NULL)
      OR (json_extract(NEW.payload_json,'$.planCreatedAt.precision')='dateOnly'
          AND json_extract(NEW.payload_json,'$.planCreatedAt.atMs') IS NULL
          AND json_extract(NEW.payload_json,'$.planCreatedAt.on') IS NOT NULL))
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.payload_json,'$.repositoryIds') j
      LEFT JOIN repositories r ON r.owner_id=NEW.owner_id AND r.repository_id=CAST(j.value AS TEXT)
      WHERE r.repository_id IS NULL OR r.access_state<>'available'
    );
  INSERT INTO plan_repositories(owner_id,plan_id,repository_id,selected_ref,fixed_at)
  SELECT NEW.owner_id,NEW.plan_id,CAST(j.value AS TEXT),
         COALESCE((SELECT CAST(ref.value AS TEXT) FROM json_each(NEW.payload_json,'$.repositoryRefs') ref
                    WHERE ref.key=CAST(j.value AS TEXT)),r.default_branch),NULL
    FROM json_each(NEW.payload_json,'$.repositoryIds') j
    JOIN repositories r ON r.owner_id=NEW.owner_id AND r.repository_id=CAST(j.value AS TEXT)
   WHERE EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)
     AND r.access_state='available';
  INSERT INTO plan_events(event_id, owner_id, plan_id, command_id, actor_id, actor_type,
                          event_type, server_occurred_at, version_before, version_after, reason)
  SELECT lower(hex(randomblob(16))), NEW.owner_id, NEW.plan_id, NEW.command_id,
         NEW.actor_id, NEW.actor_type, 'CREATED', NEW.server_now_ms, 0, 0, NULL
   WHERE EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id);
  UPDATE command_receipts
     SET outcome_code=CASE WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
                           THEN 'OK' ELSE 'VALIDATION_ERROR' END,
         result_version=CASE WHEN EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 0 END,
         result_json=CASE WHEN EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)
           THEN json_object('planId',NEW.plan_id,'status','PLANNED','version',0,'registeredAt',NEW.server_now_ms,
                            'serverNow',NEW.server_now_ms)
           ELSE json_object('error','VALIDATION_ERROR') END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

CREATE TRIGGER command_start_plan AFTER INSERT ON command_receipts
WHEN NEW.command_type='StartPlan' AND NEW.outcome_code='PENDING'
BEGIN
  UPDATE plans
     SET status='RUNNING', first_started_at=NEW.server_now_ms, version=version+1
   WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id
     AND version=NEW.expected_version AND status='PLANNED'
     AND NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND status='RUNNING');
  INSERT INTO plan_events(event_id, owner_id, plan_id, command_id, actor_id, actor_type,
                          event_type, server_occurred_at, version_before, version_after, reason)
  SELECT lower(hex(randomblob(16))), NEW.owner_id, NEW.plan_id, NEW.command_id, NEW.actor_id,
         NEW.actor_type, 'STARTED', NEW.server_now_ms, NEW.expected_version, NEW.expected_version+1,
         json_extract(NEW.payload_json,'$.reason')
   WHERE changes()=1;
  INSERT INTO work_intervals(interval_id, owner_id, plan_id, start_ms, end_ms, opened_by, closed_by)
  SELECT lower(hex(randomblob(16))), NEW.owner_id, NEW.plan_id, NEW.server_now_ms, NULL, NEW.actor_id, NULL
   WHERE EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id);
  UPDATE plan_repositories SET fixed_at=NEW.server_now_ms
   WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND fixed_at IS NULL
     AND EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id);
  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
      WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
      WHEN (SELECT status FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>'PLANNED' THEN 'INVALID_TRANSITION'
      WHEN EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND status='RUNNING') THEN 'ACTIVE_PLAN_EXISTS'
      ELSE 'INTERNAL_ERROR' END,
    result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN json_object('planId',NEW.plan_id,'status','RUNNING','version',NEW.expected_version+1,
                       'firstStartedAt',NEW.server_now_ms,'serverNow',NEW.server_now_ms)
      ELSE (SELECT json_object('error',outcome_code,'planId',NEW.plan_id,'status',status,
                               'currentVersion',version,'serverNow',NEW.server_now_ms)
              FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

CREATE TRIGGER command_pause_plan AFTER INSERT ON command_receipts
WHEN NEW.command_type='PausePlan' AND NEW.outcome_code='PENDING'
BEGIN
  UPDATE plans SET status='PAUSED', version=version+1
   WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND status='RUNNING'
     AND version=NEW.expected_version
     AND EXISTS(SELECT 1 FROM work_intervals WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL);
  INSERT INTO plan_events(event_id, owner_id, plan_id, command_id, actor_id, actor_type,
                          event_type, server_occurred_at, version_before, version_after, reason)
  SELECT lower(hex(randomblob(16))), NEW.owner_id, NEW.plan_id, NEW.command_id, NEW.actor_id,
         NEW.actor_type, 'PAUSED', NEW.server_now_ms, NEW.expected_version, NEW.expected_version+1,
         json_extract(NEW.payload_json,'$.reason')
   WHERE changes()=1;
  UPDATE work_intervals SET end_ms=NEW.server_now_ms, closed_by=NEW.actor_id
   WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL
     AND EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id);
  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
      WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
      WHEN (SELECT status FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>'RUNNING' THEN 'INVALID_TRANSITION'
      ELSE 'INTERNAL_ERROR' END,
    result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN json_object('planId',NEW.plan_id,'status','PAUSED','version',NEW.expected_version+1,'serverNow',NEW.server_now_ms)
      ELSE (SELECT json_object('error',outcome_code,'planId',NEW.plan_id,'status',status,
                               'currentVersion',version,'serverNow',NEW.server_now_ms)
              FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

CREATE TRIGGER command_resume_plan AFTER INSERT ON command_receipts
WHEN NEW.command_type='ResumePlan' AND NEW.outcome_code='PENDING'
BEGIN
  UPDATE plans SET status='RUNNING', version=version+1
   WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND status='PAUSED'
     AND version=NEW.expected_version
     AND EXISTS(SELECT 1 FROM work_intervals WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NOT NULL)
     AND NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND status='RUNNING');
  INSERT INTO plan_events(event_id, owner_id, plan_id, command_id, actor_id, actor_type,
                          event_type, server_occurred_at, version_before, version_after, reason)
  SELECT lower(hex(randomblob(16))), NEW.owner_id, NEW.plan_id, NEW.command_id, NEW.actor_id,
         NEW.actor_type, 'RESUMED', NEW.server_now_ms, NEW.expected_version, NEW.expected_version+1,
         json_extract(NEW.payload_json,'$.reason')
   WHERE changes()=1;
  INSERT INTO work_intervals(interval_id, owner_id, plan_id, start_ms, end_ms, opened_by, closed_by)
  SELECT lower(hex(randomblob(16))), NEW.owner_id, NEW.plan_id, NEW.server_now_ms, NULL, NEW.actor_id, NULL
   WHERE EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id);
  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
      WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
      WHEN (SELECT status FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>'PAUSED' THEN 'INVALID_TRANSITION'
      WHEN EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND status='RUNNING') THEN 'ACTIVE_PLAN_EXISTS'
      ELSE 'INTERNAL_ERROR' END,
    result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN json_object('planId',NEW.plan_id,'status','RUNNING','version',NEW.expected_version+1,'serverNow',NEW.server_now_ms)
      ELSE (SELECT json_object('error',outcome_code,'planId',NEW.plan_id,'status',status,
                               'currentVersion',version,'serverNow',NEW.server_now_ms)
              FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

CREATE TRIGGER command_finish_plan AFTER INSERT ON command_receipts
WHEN NEW.command_type='FinishPlan' AND NEW.outcome_code='PENDING'
BEGIN
  UPDATE plans SET status='COMPLETED', finished_at=NEW.server_now_ms, version=version+1
   WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND version=NEW.expected_version
     AND ((status='RUNNING' AND EXISTS(SELECT 1 FROM work_intervals WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL))
       OR (status='PAUSED' AND NOT EXISTS(SELECT 1 FROM work_intervals WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL)));
  INSERT INTO plan_events(event_id, owner_id, plan_id, command_id, actor_id, actor_type,
                          event_type, server_occurred_at, version_before, version_after, reason)
  SELECT lower(hex(randomblob(16))), NEW.owner_id, NEW.plan_id, NEW.command_id, NEW.actor_id,
         NEW.actor_type, 'FINISHED', NEW.server_now_ms, NEW.expected_version, NEW.expected_version+1,
         json_extract(NEW.payload_json,'$.reason')
   WHERE changes()=1;
  UPDATE work_intervals SET end_ms=NEW.server_now_ms, closed_by=NEW.actor_id
   WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND end_ms IS NULL
     AND EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id);
  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
      WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
      WHEN (SELECT status FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) NOT IN ('RUNNING','PAUSED') THEN 'INVALID_TRANSITION'
      ELSE 'INTERNAL_ERROR' END,
    result_version=(SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id),
    result_json=CASE WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id)
      THEN json_object('planId',NEW.plan_id,'status','COMPLETED','version',NEW.expected_version+1,
                       'finishedAt',NEW.server_now_ms,'serverNow',NEW.server_now_ms)
      ELSE (SELECT json_object('error',outcome_code,'planId',NEW.plan_id,'status',status,
                               'currentVersion',version,'serverNow',NEW.server_now_ms)
              FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) END
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id;
END;

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
  INSERT INTO plan_events(event_id, owner_id, plan_id, command_id, actor_id, actor_type,
                          event_type, server_occurred_at, version_before, version_after, reason)
  SELECT lower(hex(randomblob(16))), NEW.owner_id, NEW.plan_id, NEW.command_id, NEW.actor_id,
         NEW.actor_type, 'METADATA_UPDATED', NEW.server_now_ms, NEW.expected_version, NEW.expected_version+1,
         json_extract(NEW.payload_json,'$.reason')
   WHERE changes()=1;
  UPDATE command_receipts SET
    outcome_code=CASE
      WHEN EXISTS(SELECT 1 FROM plan_events WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id) THEN 'OK'
      WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id) THEN 'PLAN_NOT_FOUND'
      WHEN (SELECT version FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id)<>NEW.expected_version THEN 'VERSION_CONFLICT'
      WHEN json_type(NEW.payload_json,'$.planCreatedAt.precision') IS NOT NULL
       AND json_extract(NEW.payload_json,'$.dateAfterStart')=1
       AND json_extract(NEW.payload_json,'$.confirmDateAnomaly')<>1
        THEN 'VALIDATION_ERROR'
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
     AND json_extract(NEW.payload_json,'$.status')='excluded';
  UPDATE commit_attribution_conflicts
     SET status='resolved',resolved_by=NEW.actor_id,resolved_at=NEW.server_now_ms
   WHERE owner_id=NEW.owner_id
     AND repository_id=json_extract(NEW.payload_json,'$.repositoryId')
     AND sha=json_extract(NEW.payload_json,'$.sha')
     AND json_extract(NEW.payload_json,'$.status') IN ('confirmed','excluded');
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
