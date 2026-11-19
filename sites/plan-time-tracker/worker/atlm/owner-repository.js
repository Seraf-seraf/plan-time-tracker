const ATLM_OWNER_SCHEMA_VERSION = 4;

/** Initializes ATLM state explicitly, without schema-changing insert triggers. */
class AtlmOwnerRepository {
  constructor(db) {
    this.db = db;
  }

  ensureStatement(ownerId, guard = { sql: '1', args: [] }) {
    return this.db.prepare(
      `INSERT OR IGNORE INTO estimation_owner_state(owner_id,schema_version)
      SELECT owner_id,? FROM owners WHERE owner_id=? AND ${guard.sql}`,
    ).bind(ATLM_OWNER_SCHEMA_VERSION, ownerId, ...guard.args);
  }
}

export { ATLM_OWNER_SCHEMA_VERSION, AtlmOwnerRepository };
