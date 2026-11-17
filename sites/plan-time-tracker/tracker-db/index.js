// Server-only configuration. A transport failure must never change the selected writer.
const DEFAULT_DB_TIMEOUT_MS = 30000;

class RemoteStatement {
  constructor(database, sql, args = []) {
    Object.assign(this, { database, sql, args });
  }
  bind(...args) { return new RemoteStatement(this.database, this.sql, args); }
  async all() { return (await this.database.execute([this], "all"))[0]; }
  async first() { return (await this.database.execute([this], "first"))[0].results[0] ?? null; }
  async run() { return (await this.database.execute([this], "run"))[0]; }
}

export function configuredDatabase(env) {
  const driver = env.DB_DRIVER ?? "d1";
  if (driver === "d1") return env.DB;
  if (driver !== "remote-sqlite") throw new Error("Unknown DB_DRIVER");
  const endpoint = new URL(env.DB_URL);
  const timeout = Number(env.DB_TIMEOUT_MS ?? DEFAULT_DB_TIMEOUT_MS);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      !env.DB_TOKEN || !Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error("Invalid remote SQLite configuration");
  }
  return {
    prepare(sql) { return new RemoteStatement(this, sql); },
    batch(statements) { return this.execute(statements, "batch"); },
    async execute(statements, mode) {
      if (statements.some(s => s.database !== this)) throw new Error("Mixed database batch");
      const response = await fetch(endpoint, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(timeout),
        headers: { authorization: "Bearer " + env.DB_TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ mode, statements: statements.map(({ sql, args }) => ({ sql, args })) }),
      });
      if (!response.ok) throw new Error("SQLite service unavailable: HTTP " + response.status);
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      if (!Array.isArray(data.results) || data.results.length !== statements.length) throw new Error("Invalid SQLite response");
      return data.results;
    },
  };
}
