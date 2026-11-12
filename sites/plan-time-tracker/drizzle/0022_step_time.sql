-- Execution windows start only after a confirmed RUNNING status write.
-- Never infer historical time from current status or old command receipts.
CREATE TABLE step_work_intervals (
  owner_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
  end_ms INTEGER CHECK(end_ms IS NULL OR end_ms >= start_ms),
  PRIMARY KEY(owner_id, step_id, start_ms),
  FOREIGN KEY(owner_id, step_id) REFERENCES plan_steps(owner_id, step_id)
);

CREATE UNIQUE INDEX step_one_open_interval ON step_work_intervals(owner_id, step_id) WHERE end_ms IS NULL;

CREATE TRIGGER step_time_status AFTER UPDATE OF status ON plan_steps
BEGIN
  UPDATE step_work_intervals SET end_ms=MAX(start_ms, NEW.updated_at)
  WHERE owner_id=NEW.owner_id AND step_id=NEW.step_id AND end_ms IS NULL AND NEW.status<>'RUNNING';
  INSERT INTO step_work_intervals(owner_id, step_id, start_ms)
  SELECT NEW.owner_id, NEW.step_id, NEW.updated_at
  WHERE NEW.status='RUNNING'
    AND EXISTS(SELECT 1 FROM plans WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id AND status='RUNNING' AND deleted_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM step_work_intervals WHERE owner_id=NEW.owner_id AND step_id=NEW.step_id AND end_ms IS NULL)
  ON CONFLICT(owner_id, step_id, start_ms) DO UPDATE SET end_ms=NULL;
END;

-- A finish exception can leave a step RUNNING. Seal its window as well.
CREATE TRIGGER step_time_finish AFTER UPDATE OF status ON plans
WHEN NEW.status='COMPLETED' AND OLD.status<>'COMPLETED'
BEGIN
  UPDATE step_work_intervals SET end_ms=MAX(start_ms, NEW.finished_at)
  WHERE owner_id=NEW.owner_id AND end_ms IS NULL
    AND step_id IN (SELECT step_id FROM plan_steps WHERE owner_id=NEW.owner_id AND plan_id=NEW.plan_id);
END;
