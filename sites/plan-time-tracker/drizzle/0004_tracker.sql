CREATE TABLE tracker_plan_config (
  owner_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  finish_policy TEXT NOT NULL DEFAULT 'ALLOW_EXPLICIT_EXCEPTION'
    CHECK(finish_policy IN ('REQUIRE_ACCEPTED','ALLOW_EXPLICIT_EXCEPTION')),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at >= created_at),
  PRIMARY KEY(owner_id, plan_id),
  FOREIGN KEY(owner_id, plan_id) REFERENCES plans(owner_id, plan_id)
);

CREATE TABLE plan_steps (
  owner_id TEXT NOT NULL,
  step_id TEXT NOT NULL CHECK(length(step_id)=36 AND substr(step_id,9,1)='-' AND substr(step_id,14,1)='-' AND substr(step_id,19,1)='-' AND substr(step_id,24,1)='-'),
  plan_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal >= 0),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','BLOCKED','FAILED','DONE')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version >= 1),
  expected_result TEXT NOT NULL CHECK(length(trim(expected_result)) BETWEEN 1 AND 4000),
  required_checks_json TEXT NOT NULL DEFAULT '[]'
    CHECK(length(required_checks_json) <= 20000 AND json_valid(required_checks_json) AND json_type(required_checks_json)='array'),
  commit_policy TEXT NOT NULL DEFAULT 'NEVER'
    CHECK(commit_policy IN ('NEVER','ON_EXPLICIT_REQUEST','REQUIRED_BY_APPROVED_CHECKPOINT')),
  push_policy TEXT NOT NULL DEFAULT 'NEVER'
    CHECK(push_policy IN ('NEVER','ON_EXPLICIT_REQUEST','REQUIRED_BY_APPROVED_CHECKPOINT')),
  current_fence INTEGER NOT NULL DEFAULT 0 CHECK(typeof(current_fence)='integer' AND current_fence >= 0),
  current_result_revision INTEGER,
  acceptance_revision INTEGER,
  acceptance_decision TEXT NOT NULL DEFAULT 'NONE' CHECK(acceptance_decision IN ('NONE','ACCEPTED','REJECTED')),
  current_acceptance_id TEXT,
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at >= created_at),
  PRIMARY KEY(owner_id, step_id),
  UNIQUE(owner_id, plan_id, ordinal),
  UNIQUE(owner_id, plan_id, step_id),
  CHECK((acceptance_decision='NONE' AND acceptance_revision IS NULL AND current_acceptance_id IS NULL)
     OR (acceptance_decision IN ('ACCEPTED','REJECTED') AND acceptance_revision IS NOT NULL AND current_acceptance_id IS NOT NULL)),
  FOREIGN KEY(owner_id, plan_id) REFERENCES plans(owner_id, plan_id),
  FOREIGN KEY(owner_id, step_id, current_result_revision)
    REFERENCES step_results(owner_id, step_id, revision),
  FOREIGN KEY(owner_id, step_id, acceptance_revision)
    REFERENCES step_results(owner_id, step_id, revision),
  FOREIGN KEY(owner_id, step_id, current_acceptance_id)
    REFERENCES step_acceptances(owner_id, step_id, acceptance_id)
);

CREATE TABLE tracker_sessions (
  owner_id TEXT NOT NULL,
  session_id TEXT NOT NULL CHECK(length(session_id)=36 AND substr(session_id,9,1)='-' AND substr(session_id,14,1)='-' AND substr(session_id,19,1)='-' AND substr(session_id,24,1)='-'),
  source_id TEXT NOT NULL CHECK(length(trim(source_id)) BETWEEN 1 AND 128),
  client_type TEXT NOT NULL CHECK(length(trim(client_type)) BETWEEN 1 AND 32),
  executor_label TEXT CHECK(executor_label IS NULL OR length(executor_label) <= 128),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at >= 0),
  closed_at INTEGER CHECK(closed_at IS NULL OR (typeof(closed_at)='integer' AND closed_at >= created_at)),
  PRIMARY KEY(owner_id, session_id),
  UNIQUE(owner_id, session_id, source_id),
  FOREIGN KEY(owner_id) REFERENCES owners(owner_id)
);

CREATE TABLE step_attempts (
  owner_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL CHECK(length(attempt_id)=36 AND substr(attempt_id,9,1)='-' AND substr(attempt_id,14,1)='-' AND substr(attempt_id,19,1)='-' AND substr(attempt_id,24,1)='-'),
  step_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED','ABANDONED')),
  fence INTEGER NOT NULL CHECK(typeof(fence)='integer' AND fence >= 1),
  lease_until INTEGER NOT NULL CHECK(typeof(lease_until)='integer' AND lease_until >= 0),
  rework_reason TEXT CHECK(rework_reason IS NULL OR length(trim(rework_reason)) BETWEEN 1 AND 1000),
  started_at INTEGER NOT NULL CHECK(typeof(started_at)='integer' AND started_at >= 0),
  closed_at INTEGER CHECK(closed_at IS NULL OR (typeof(closed_at)='integer' AND closed_at >= started_at)),
  PRIMARY KEY(owner_id, attempt_id),
  UNIQUE(owner_id, step_id, attempt_id),
  UNIQUE(owner_id, step_id, fence),
  CHECK((status='OPEN' AND closed_at IS NULL) OR (status IN ('CLOSED','ABANDONED') AND closed_at IS NOT NULL)),
  FOREIGN KEY(owner_id, step_id) REFERENCES plan_steps(owner_id, step_id),
  FOREIGN KEY(owner_id, session_id) REFERENCES tracker_sessions(owner_id, session_id)
);
CREATE UNIQUE INDEX step_attempts_one_open_per_step
  ON step_attempts(owner_id, step_id) WHERE status='OPEN';
CREATE INDEX step_attempts_step_started
  ON step_attempts(owner_id, step_id, started_at DESC);

CREATE TABLE tracker_journal (
  owner_id TEXT NOT NULL,
  event_id TEXT NOT NULL CHECK(length(event_id)=36 AND substr(event_id,9,1)='-' AND substr(event_id,14,1)='-' AND substr(event_id,19,1)='-' AND substr(event_id,24,1)='-'),
  plan_id TEXT NOT NULL,
  step_id TEXT,
  attempt_id TEXT,
  command_id TEXT,
  command_event_ordinal INTEGER CHECK(command_event_ordinal IS NULL OR (typeof(command_event_ordinal)='integer' AND command_event_ordinal >= 0)),
  source_id TEXT,
  session_id TEXT,
  source_sequence INTEGER CHECK(source_sequence IS NULL OR (typeof(source_sequence)='integer' AND source_sequence >= 0)),
  server_sequence INTEGER NOT NULL CHECK(typeof(server_sequence)='integer' AND server_sequence >= 1),
  event_type TEXT NOT NULL CHECK(length(trim(event_type)) BETWEEN 1 AND 80),
  payload_json TEXT NOT NULL CHECK(length(payload_json) <= 8192 AND json_valid(payload_json) AND json_type(payload_json)='object'),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-fA-F0-9]*'),
  occurred_at INTEGER NOT NULL CHECK(typeof(occurred_at)='integer' AND occurred_at >= 0),
  received_at INTEGER NOT NULL CHECK(typeof(received_at)='integer' AND received_at >= 0),
  classification TEXT NOT NULL DEFAULT 'NORMAL'
    CHECK(classification IN ('NORMAL','LATE','GAP','STALE_EXECUTOR','CORRECTION')),
  correction_of_event_id TEXT,
  PRIMARY KEY(owner_id, event_id),
  UNIQUE(owner_id, event_id, step_id),
  UNIQUE(owner_id, server_sequence),
  UNIQUE(owner_id, command_id, command_event_ordinal),
  CHECK((command_id IS NULL) = (command_event_ordinal IS NULL)),
  CHECK((source_id IS NULL AND session_id IS NULL AND source_sequence IS NULL)
     OR (source_id IS NOT NULL AND length(trim(source_id)) BETWEEN 1 AND 128
         AND session_id IS NOT NULL AND source_sequence IS NOT NULL)),
  CHECK(source_sequence IS NULL OR source_id IS NOT NULL),
  CHECK((classification='CORRECTION' AND correction_of_event_id IS NOT NULL)
     OR (classification<>'CORRECTION' AND correction_of_event_id IS NULL)),
  CHECK(attempt_id IS NULL OR step_id IS NOT NULL),
  FOREIGN KEY(owner_id, plan_id) REFERENCES plans(owner_id, plan_id),
  FOREIGN KEY(owner_id, plan_id, step_id) REFERENCES plan_steps(owner_id, plan_id, step_id),
  FOREIGN KEY(owner_id, step_id, attempt_id) REFERENCES step_attempts(owner_id, step_id, attempt_id),
  FOREIGN KEY(owner_id, session_id) REFERENCES tracker_sessions(owner_id, session_id),
  FOREIGN KEY(owner_id, session_id, source_id) REFERENCES tracker_sessions(owner_id, session_id, source_id),
  FOREIGN KEY(owner_id, command_id) REFERENCES command_receipts(owner_id, command_id),
  FOREIGN KEY(owner_id, correction_of_event_id) REFERENCES tracker_journal(owner_id, event_id),
  FOREIGN KEY(owner_id) REFERENCES tracker_owner_state(owner_id)
);
CREATE UNIQUE INDEX tracker_journal_observation_sequence
  ON tracker_journal(owner_id, source_id, session_id, source_sequence)
  WHERE source_sequence IS NOT NULL;
CREATE INDEX tracker_journal_plan_sequence
  ON tracker_journal(owner_id, plan_id, server_sequence);
CREATE INDEX tracker_journal_step_sequence
  ON tracker_journal(owner_id, step_id, server_sequence);

CREATE TRIGGER tracker_journal_sequence_guard BEFORE INSERT ON tracker_journal
WHEN NOT EXISTS (
  SELECT 1 FROM tracker_owner_state
   WHERE owner_id=NEW.owner_id AND next_sequence=NEW.server_sequence
)
BEGIN SELECT RAISE(ABORT, 'TRACKER_SEQUENCE_CONFLICT'); END;

CREATE TRIGGER tracker_journal_advance_sequence AFTER INSERT ON tracker_journal
BEGIN
  UPDATE tracker_owner_state SET next_sequence=next_sequence+1
   WHERE owner_id=NEW.owner_id;
END;

CREATE TABLE tracker_owner_state (
  owner_id TEXT PRIMARY KEY,
  next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(typeof(next_sequence)='integer' AND next_sequence >= 1),
  FOREIGN KEY(owner_id) REFERENCES owners(owner_id)
);

CREATE TABLE step_results (
  owner_id TEXT NOT NULL,
  result_id TEXT NOT NULL CHECK(length(result_id)=36 AND substr(result_id,9,1)='-' AND substr(result_id,14,1)='-' AND substr(result_id,19,1)='-' AND substr(result_id,24,1)='-'),
  step_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision >= 1),
  outcome TEXT NOT NULL CHECK(outcome IN ('DONE','FAILED')),
  summary TEXT NOT NULL CHECK(length(trim(summary)) BETWEEN 1 AND 4000),
  repository_id TEXT,
  revision_sha TEXT CHECK(revision_sha IS NULL OR (length(revision_sha)=40 AND revision_sha NOT GLOB '*[^a-fA-F0-9]*')),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-fA-F0-9]*'),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at >= 0),
  PRIMARY KEY(owner_id, result_id),
  UNIQUE(owner_id, step_id, revision),
  UNIQUE(owner_id, step_id, result_id, revision),
  CHECK((repository_id IS NULL) = (revision_sha IS NULL)),
  FOREIGN KEY(owner_id, step_id) REFERENCES plan_steps(owner_id, step_id),
  FOREIGN KEY(owner_id, step_id, attempt_id) REFERENCES step_attempts(owner_id, step_id, attempt_id),
  FOREIGN KEY(owner_id, repository_id) REFERENCES repositories(owner_id, repository_id)
);

CREATE TABLE step_checks (
  owner_id TEXT NOT NULL,
  check_id TEXT NOT NULL CHECK(length(check_id)=36 AND substr(check_id,9,1)='-' AND substr(check_id,14,1)='-' AND substr(check_id,19,1)='-' AND substr(check_id,24,1)='-'),
  step_id TEXT NOT NULL,
  result_revision INTEGER NOT NULL CHECK(typeof(result_revision)='integer' AND result_revision >= 1),
  event_id TEXT NOT NULL CHECK(length(event_id)=36 AND substr(event_id,9,1)='-' AND substr(event_id,14,1)='-' AND substr(event_id,19,1)='-' AND substr(event_id,24,1)='-'),
  check_key TEXT NOT NULL CHECK(length(trim(check_key)) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK(status IN ('PASSED','FAILED','NOT_RUN')),
  tested_sha TEXT NOT NULL CHECK(length(tested_sha)=40 AND tested_sha NOT GLOB '*[^a-fA-F0-9]*'),
  exit_code INTEGER CHECK(exit_code IS NULL OR (typeof(exit_code)='integer' AND exit_code BETWEEN 0 AND 255)),
  evidence_summary TEXT CHECK(evidence_summary IS NULL OR length(evidence_summary) <= 2000),
  evidence_url TEXT CHECK(evidence_url IS NULL OR (length(evidence_url) <= 2048 AND substr(evidence_url,1,8)='https://')),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at >= 0),
  PRIMARY KEY(owner_id, check_id),
  UNIQUE(owner_id, check_id, step_id),
  CHECK((status='PASSED' AND exit_code=0) OR (status='FAILED' AND exit_code BETWEEN 1 AND 255) OR (status='NOT_RUN' AND exit_code IS NULL)),
  FOREIGN KEY(owner_id, step_id, result_revision) REFERENCES step_results(owner_id, step_id, revision),
  FOREIGN KEY(owner_id, event_id, step_id) REFERENCES tracker_journal(owner_id, event_id, step_id)
);
CREATE INDEX step_checks_result_status
  ON step_checks(owner_id, step_id, result_revision, status);

CREATE TABLE step_acceptances (
  owner_id TEXT NOT NULL,
  acceptance_id TEXT NOT NULL CHECK(length(acceptance_id)=36 AND substr(acceptance_id,9,1)='-' AND substr(acceptance_id,14,1)='-' AND substr(acceptance_id,19,1)='-' AND substr(acceptance_id,24,1)='-'),
  step_id TEXT NOT NULL,
  result_revision INTEGER NOT NULL CHECK(typeof(result_revision)='integer' AND result_revision >= 1),
  decision TEXT NOT NULL CHECK(decision IN ('ACCEPTED','REJECTED')),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  waivers_json TEXT NOT NULL DEFAULT '[]'
    CHECK(length(waivers_json) <= 8000 AND json_valid(waivers_json) AND json_type(waivers_json)='array'),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at >= 0),
  PRIMARY KEY(owner_id, acceptance_id),
  UNIQUE(owner_id, step_id, acceptance_id),
  FOREIGN KEY(owner_id, step_id, result_revision) REFERENCES step_results(owner_id, step_id, revision),
  FOREIGN KEY(owner_id) REFERENCES owners(owner_id)
);
CREATE INDEX step_acceptances_current
  ON step_acceptances(owner_id, step_id, result_revision, created_at DESC);

CREATE TRIGGER step_results_immutable_update BEFORE UPDATE ON step_results
BEGIN SELECT RAISE(ABORT, 'STEP_RESULTS_ARE_IMMUTABLE'); END;
CREATE TRIGGER step_results_immutable_delete BEFORE DELETE ON step_results
BEGIN SELECT RAISE(ABORT, 'STEP_RESULTS_ARE_IMMUTABLE'); END;
CREATE TRIGGER step_checks_immutable_update BEFORE UPDATE ON step_checks
BEGIN SELECT RAISE(ABORT, 'STEP_CHECKS_ARE_IMMUTABLE'); END;
CREATE TRIGGER step_checks_immutable_delete BEFORE DELETE ON step_checks
BEGIN SELECT RAISE(ABORT, 'STEP_CHECKS_ARE_IMMUTABLE'); END;
CREATE TRIGGER step_acceptances_immutable_update BEFORE UPDATE ON step_acceptances
BEGIN SELECT RAISE(ABORT, 'STEP_ACCEPTANCES_ARE_IMMUTABLE'); END;
CREATE TRIGGER step_acceptances_immutable_delete BEFORE DELETE ON step_acceptances
BEGIN SELECT RAISE(ABORT, 'STEP_ACCEPTANCES_ARE_IMMUTABLE'); END;
CREATE TRIGGER tracker_journal_immutable_update BEFORE UPDATE ON tracker_journal
BEGIN SELECT RAISE(ABORT, 'TRACKER_JOURNAL_IS_IMMUTABLE'); END;
CREATE TRIGGER tracker_journal_immutable_delete BEFORE DELETE ON tracker_journal
BEGIN SELECT RAISE(ABORT, 'TRACKER_JOURNAL_IS_IMMUTABLE'); END;
CREATE TRIGGER tracker_owner_state_advance_guard BEFORE UPDATE OF next_sequence ON tracker_owner_state
WHEN NEW.next_sequence<>OLD.next_sequence+1
  OR NOT EXISTS (
    SELECT 1 FROM tracker_journal
     WHERE owner_id=OLD.owner_id AND server_sequence=OLD.next_sequence
  )
BEGIN SELECT RAISE(ABORT, 'TRACKER_SEQUENCE_MUST_FOLLOW_EVENT'); END;
CREATE TRIGGER tracker_owner_state_no_delete BEFORE DELETE ON tracker_owner_state
BEGIN SELECT RAISE(ABORT, 'TRACKER_OWNER_STATE_IS_REQUIRED'); END;
