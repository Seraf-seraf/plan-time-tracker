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
