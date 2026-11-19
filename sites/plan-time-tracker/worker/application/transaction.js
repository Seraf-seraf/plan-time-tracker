/** Collects the complete write set for one atomic D1/SQLite batch. */
export class SqlTransaction {
  #statements = [];
  #state = 'OPEN';
  #failure = null;

  constructor(db) {
    this.db = db;
  }

  add(sql, ...args) {
    this.#assertOpen();
    return this.addPrepared(this.db.prepare(sql).bind(...args));
  }

  addPrepared(statement) {
    this.#assertOpen();
    this.#statements.push(statement);
    return this;
  }

  abort(error) {
    this.#assertOpen();
    this.#state = 'ABORTED';
    this.#failure = error;
  }

  async commit() {
    this.#assertOpen();
    this.#state = 'COMMITTING';
    try {
      const results = this.#statements.length ? await this.db.batch(this.#statements) : [];
      this.#state = 'COMMITTED';
      return results;
    } catch (error) {
      // A lost response can mean that the database committed. The command receipt,
      // rather than an automatic retry of this batch, resolves that uncertainty.
      this.#state = 'FAILED';
      this.#failure = error;
      throw error;
    }
  }

  #assertOpen() {
    if (this.#state !== 'OPEN') {
      throw this.#failure ?? new Error('Transaction is no longer open.');
    }
  }
}
