// Server-only configuration. A transport failure must never change the selected writer.
const DEFAULT_DB_TIMEOUT_MS = 30000;

const PART_BYTES = 16 * 1024;
const MAX_TRANSFER_BYTES = 32 * 1024 * 1024;
const PARALLEL_PARTS = 4;
const PART_TIMEOUT_MS = 6000;

async function readPart(endpoint, headers, signal, id, index, length) {
  for (let attempt = 0; ; attempt++) {
    const attemptStop = new AbortController();
    const abort = () => attemptStop.abort(signal.reason);
    signal.throwIfAborted();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => attemptStop.abort(new DOMException("Part timed out", "TimeoutError")), PART_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST", redirect: "manual", headers, signal: attemptStop.signal,
        body: JSON.stringify({ id, index }),
      });
      if (!response.ok) {
        if (response.status >= 500 && attempt === 0) {
          await response.body?.cancel();
          continue;
        }
        throw new Error("SQLite result part: HTTP " + response.status);
      }
      if (response.headers.get("x-part-index") !== String(index)) {
        throw new Error("Invalid SQLite result part index");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== length) throw new Error("Invalid SQLite result part length");
      return bytes;
    } catch (error) {
      // Only fetch/body transport failures are replayable; SQL is never resubmitted.
      if (signal.aborted || attempt > 0 || (!(error instanceof TypeError) && !attemptStop.signal.aborted)) throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}

async function readTransfer(transfer, endpoint, headers, signal) {
  const { id, bytes, sha256 } = transfer;
  if (!/^[a-f0-9]{48}$/.test(id) || !Number.isSafeInteger(bytes) || bytes <= 0 ||
      bytes > MAX_TRANSFER_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Invalid SQLite result manifest");
  }
  const packed = new Uint8Array(bytes);
  const partsEndpoint = new URL("parts", endpoint);
  // Stop siblings on the first failure, with one deadline for the whole operation.
  const stop = new AbortController();
  signal.throwIfAborted();
  const abort = () => stop.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let next = 0;
  async function read() {
    while (next * PART_BYTES < bytes) {
      const index = next++;
      const offset = index * PART_BYTES;
      packed.set(await readPart(partsEndpoint, headers, stop.signal, id, index,
        Math.min(PART_BYTES, bytes - offset)), offset);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, Math.ceil(bytes / PART_BYTES)) }, read));
  } finally {
    signal.removeEventListener("abort", abort);
    stop.abort();
  }
  const digest = await crypto.subtle.digest("SHA-256", packed);
  const actual = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
  if (actual !== sha256) throw new Error("Invalid SQLite result checksum");
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"));
  const result = await new Response(stream).json();
  signal.throwIfAborted();
  return result;
}

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
      const signal = AbortSignal.timeout(timeout);
      const headers = { authorization: "Bearer " + env.DB_TOKEN, "content-type": "application/json" };
      const response = await fetch(endpoint, {
        method: "POST", redirect: "manual", signal, headers: { ...headers, "X-Result-Parts": "1" },
        body: JSON.stringify({ mode, statements: statements.map(({ sql, args }) => ({ sql, args })) }),
      });
      if (!response.ok) throw new Error("SQLite service unavailable: HTTP " + response.status);
      const initial = await response.json();
      const data = initial.transfer ? await readTransfer(initial.transfer, endpoint, headers, signal) : initial;
      if (data.error) throw new Error(data.error);
      if (!Array.isArray(data.results) || data.results.length !== statements.length) throw new Error("Invalid SQLite response");
      return data.results;
    },
  };
}
