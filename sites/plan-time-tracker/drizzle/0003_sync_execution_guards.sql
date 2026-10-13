CREATE TABLE sync_execution_guards (
  owner_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  PRIMARY KEY(owner_id, command_id),
  FOREIGN KEY(owner_id, command_id) REFERENCES command_receipts(owner_id, command_id)
);

CREATE TRIGGER sync_execution_guard_current
BEFORE INSERT ON sync_execution_guards
WHEN NOT EXISTS (
  SELECT 1 FROM command_receipts
   WHERE owner_id=NEW.owner_id AND command_id=NEW.command_id
     AND command_type='SyncRepository' AND outcome_code='PENDING'
     AND execution_lease_until=NEW.lease_until
)
BEGIN
  SELECT RAISE(ABORT, 'SYNC_LEASE_LOST');
END;
