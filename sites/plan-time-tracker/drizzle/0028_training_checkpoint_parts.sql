CREATE TABLE estimation_checkpoint_parts (
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  storage_id TEXT NOT NULL,
  field TEXT NOT NULL,
  item TEXT NOT NULL,
  part INTEGER NOT NULL,
  content TEXT NOT NULL,
  UNIQUE(owner_id,generation,storage_id,field,item,part)
);
CREATE TRIGGER atlm_discard_checkpoint AFTER UPDATE OF generation,processed_generation ON estimation_jobs
WHEN NEW.job_key='train' AND (NEW.generation<>OLD.generation OR NEW.processed_generation=NEW.generation)
BEGIN
  DELETE FROM estimation_checkpoint_parts WHERE owner_id=NEW.owner_id AND generation<=OLD.generation;
END;
