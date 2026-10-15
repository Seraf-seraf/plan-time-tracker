import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const OBSERVATION_QUEUE_LIMITS = Object.freeze({
  maxEvents: 1000,
  maxBytes: 5 * 1024 * 1024,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  maxSendAttempts: 5,
  backoffCapMs: 30000,
  inFlightTimeoutMs: 30000,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,60}$/;
const EVENT_DATA_KEYS = {
  turn_started: ["turnId"],
  turn_finished: ["turnId", "status"],
  tool_started: ["operationId", "toolName"],
  tool_finished: ["operationId", "toolName", "status", "durationMs"],
  heartbeat: [],
  gap: [],
  correction: ["reason"],
};
const EVENT_REQUIRED_KEYS = {
  turn_started: ["turnId"], turn_finished: ["turnId", "status"],
  tool_started: ["operationId", "toolName"], tool_finished: ["operationId", "toolName", "status"],
  heartbeat: [], gap: [], correction: ["reason"],
};
const SECRET_LIKE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/-]{16,})/i;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateScope(ownerScope, planContext) {
  if (typeof ownerScope !== "string" || !/^[a-f0-9]{64}$/i.test(ownerScope)) {
    throw new Error("ownerScope must come from authenticated GetTrackerCapabilities.");
  }
  const planContextPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
  if (typeof planContext !== "string" || !planContextPattern.test(planContext) ||
      /(?:token|secret|password|authorization)/i.test(planContext)) {
    throw new Error("planContext must be a plan ID or local source label without a URL or credentials.");
  }
}

function validateEventMetadata(payload) {
  const data = payload.data;
  if (payload.eventType === "turn_started" || payload.eventType === "turn_finished") {
    if (!UUID.test(data.turnId || "")) throw new Error("turnId must be a UUID.");
    if (payload.eventType === "turn_finished" && !["OK", "FAILED", "CANCELLED"].includes(data.status)) throw new Error("Invalid turn_finished status.");
  }
  if (payload.eventType === "tool_started" || payload.eventType === "tool_finished") {
    if (!UUID.test(data.operationId || "") || typeof data.toolName !== "string" || !data.toolName.trim() || data.toolName.length > 80) {
      throw new Error("operationId or toolName is invalid.");
    }
    if (payload.eventType === "tool_finished" &&
        (!["OK", "FAILED", "CANCELLED"].includes(data.status) ||
          (data.durationMs !== undefined && (!Number.isSafeInteger(data.durationMs) || data.durationMs < 0 || data.durationMs > 604800000)))) {
      throw new Error("Invalid tool_finished status or durationMs.");
    }
  }
  if (payload.eventType === "correction" && (typeof data.reason !== "string" || !data.reason.trim() || data.reason.length > 1000)) {
    throw new Error("correction requires a bounded reason.");
  }
}

function validateObservationEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("Observation envelope must be an object.");
  const envelopeKeys = Object.keys(envelope).sort();
  if (envelopeKeys.join(",") !== "commandId,commandType,payload,schemaVersion" ||
      envelope.schemaVersion !== 1 || envelope.commandType !== "AppendObservation" || !UUID.test(envelope.commandId || "")) {
    throw new Error("Only a version 1 AppendObservation envelope with a UUID commandId can be queued.");
  }
  const payload = envelope.payload;
  const allowedPayloadKeys = ["attemptId", "correctionOfEventId", "data", "eventId", "eventType", "occurredAt", "planId", "sessionId", "sourceId", "sourceSequence", "stepId"];
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some((key) => !allowedPayloadKeys.includes(key))) {
    throw new Error("Observation payload contains unsupported fields.");
  }
  for (const key of ["eventId", "planId", "sessionId"]) if (!UUID.test(payload[key] || "")) throw new Error(key + " must be a UUID.");
  if (payload.stepId !== undefined && !UUID.test(payload.stepId)) throw new Error("stepId must be a UUID.");
  if (payload.attemptId !== undefined && (!UUID.test(payload.attemptId) || !payload.stepId)) throw new Error("attemptId requires a UUID stepId.");
  if (payload.correctionOfEventId !== undefined && !UUID.test(payload.correctionOfEventId)) throw new Error("correctionOfEventId must be a UUID.");
  if ((payload.eventType === "correction") !== (payload.correctionOfEventId !== undefined)) throw new Error("Only correction events may name correctionOfEventId.");
  if (typeof payload.sourceId !== "string" || !payload.sourceId.trim() || payload.sourceId.length > 128 ||
      !Number.isSafeInteger(payload.sourceSequence) || payload.sourceSequence < 1 ||
      !Number.isSafeInteger(payload.occurredAt) || payload.occurredAt < 0) {
    throw new Error("Observation source and sequence fields are invalid.");
  }
  if (SECRET_LIKE.test(payload.sourceId) || /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/i.test(payload.sourceId)) {
    throw new Error("Observation sourceId must not contain credentials.");
  }
  const dataKeys = EVENT_DATA_KEYS[payload.eventType];
  if (!dataKeys || !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) throw new Error("Unsupported observation type or metadata.");
  const actualKeys = Object.keys(payload.data);
  if (actualKeys.some((key) => !dataKeys.includes(key)) || EVENT_REQUIRED_KEYS[payload.eventType].some((key) => !Object.hasOwn(payload.data, key))) {
    throw new Error("Observation metadata contains fields outside its event allowlist.");
  }
  const encodedMetadata = JSON.stringify(payload.data);
  if (encodedMetadata.length > 4000 || SECRET_LIKE.test(encodedMetadata) || /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/i.test(encodedMetadata)) {
    throw new Error("Observation metadata exceeds the limit or appears to contain a credential.");
  }
  validateEventMetadata(payload);
  for (const value of Object.values(payload.data)) {
    if (typeof value === "string" && value.length > 1000) throw new Error("Observation metadata text exceeds 1000 characters.");
  }
  return JSON.parse(JSON.stringify(envelope));
}

function sessionSequenceKey(payload) {
  return sha256(payload.sourceId + "\0" + payload.sessionId);
}

function serializeState(state) {
  return JSON.stringify(state);
}

function defaultStateDirectory() {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  const stateHome = xdgStateHome && xdgStateHome.startsWith("/") ? xdgStateHome : join(homedir(), ".local", "state");
  return join(stateHome, "plan-time-tracker", "observation-queues");
}

export class ObservationQueue {
  constructor({ stateDirectory = defaultStateDirectory(), ownerScope, planContext, now = Date.now, random = Math.random }) {
    validateScope(ownerScope, planContext);
    if (typeof stateDirectory !== "string" || !stateDirectory.startsWith("/")) throw new Error("stateDirectory must be absolute.");
    this.stateDirectory = stateDirectory;
    this.scopeHash = sha256("owner\0" + ownerScope);
    this.planHash = sha256("plan\0" + planContext);
    this.filePath = join(stateDirectory, sha256(this.scopeHash + "\0" + this.planHash) + ".json");
    this.now = now;
    this.random = random;
  }

  async enqueue(inputEnvelope) {
    const envelope = validateObservationEnvelope(inputEnvelope);
    return this.withState((state) => {
      const byCommand = state.events.find((entry) => entry.envelope.commandId === envelope.commandId);
      if (byCommand) {
        if (JSON.stringify(byCommand.envelope) !== JSON.stringify(envelope)) throw new Error("commandId already belongs to a different observation.");
        return { status: byCommand.status, commandId: envelope.commandId, duplicate: true };
      }
      const byEvent = state.events.find((entry) => entry.envelope.payload.eventId === envelope.payload.eventId);
      if (byEvent) {
        if (JSON.stringify(byEvent.envelope.payload) !== JSON.stringify(envelope.payload)) throw new Error("eventId already belongs to a different observation.");
        return { status: byEvent.status, commandId: byEvent.envelope.commandId, duplicate: true };
      }
      const sequenceKey = sessionSequenceKey(envelope.payload);
      const prior = state.sequences[sequenceKey];
      if (prior && envelope.payload.sourceSequence <= prior.lastSequence) throw new Error("sourceSequence must increase within a source session.");
      const createdAt = this.now();
      state.events.push({ envelope, status: "QUEUED", attempts: 0, createdAt, nextAttemptAt: createdAt, sentAt: null, lastErrorCode: null });
      state.sequences[sequenceKey] = { lastSequence: envelope.payload.sourceSequence, updatedAt: createdAt };
      this.enforceBounds(state);
      return { status: "QUEUED", commandId: envelope.commandId, duplicate: false };
    });
  }

  async next() {
    return this.withState((state) => {
      const entry = state.events[0];
      if (!entry) return { status: "EMPTY" };
      const now = this.now();
      if (entry.status === "PENDING") return { status: "PENDING", commandId: entry.envelope.commandId, attempts: entry.attempts, lastErrorCode: entry.lastErrorCode };
      if (entry.status === "IN_FLIGHT" && now - entry.sentAt < OBSERVATION_QUEUE_LIMITS.inFlightTimeoutMs) {
        return { status: "IN_FLIGHT", commandId: entry.envelope.commandId, retryAt: entry.sentAt + OBSERVATION_QUEUE_LIMITS.inFlightTimeoutMs };
      }
      if (entry.status === "IN_FLIGHT" && entry.attempts >= OBSERVATION_QUEUE_LIMITS.maxSendAttempts) {
        entry.status = "PENDING";
        entry.nextAttemptAt = null;
        entry.lastErrorCode = entry.lastErrorCode || "ACK_UNKNOWN";
        return { status: "PENDING", commandId: entry.envelope.commandId, attempts: entry.attempts, lastErrorCode: entry.lastErrorCode };
      }
      if (entry.status === "RETRY_WAIT" && now < entry.nextAttemptAt) return { status: "RETRY_WAIT", commandId: entry.envelope.commandId, retryAt: entry.nextAttemptAt, attempts: entry.attempts };
      return { status: "READY", commandId: entry.envelope.commandId, attempts: entry.attempts, envelope: entry.envelope };
    });
  }

  async begin(commandId) {
    return this.withState((state) => {
      const entry = state.events[0];
      const now = this.now();
      if (!entry || entry.envelope.commandId !== commandId) throw new Error("Only the oldest queued observation can be sent.");
      const ready = entry.status === "QUEUED" || (entry.status === "RETRY_WAIT" && now >= entry.nextAttemptAt) ||
        (entry.status === "IN_FLIGHT" && now - entry.sentAt >= OBSERVATION_QUEUE_LIMITS.inFlightTimeoutMs);
      if (!ready) throw new Error("Observation is not ready for another send.");
      if (entry.attempts >= OBSERVATION_QUEUE_LIMITS.maxSendAttempts) {
        entry.status = "PENDING";
        return { status: entry.status, commandId, attempts: entry.attempts, lastErrorCode: entry.lastErrorCode };
      }
      entry.attempts += 1;
      entry.sentAt = now;
      entry.status = "IN_FLIGHT";
      return { status: entry.status, commandId, attempts: entry.attempts, envelope: entry.envelope };
    });
  }

  async acknowledge(commandId) {
    return this.withState((state) => {
      const index = state.events.findIndex((entry) => entry.envelope.commandId === commandId);
      if (index < 0) return { status: "NOT_FOUND", commandId };
      if (state.events[index].status !== "IN_FLIGHT") throw new Error("Only a sent observation can be acknowledged.");
      const [entry] = state.events.splice(index, 1);
      return { status: "ACKNOWLEDGED", commandId, eventId: entry.envelope.payload.eventId };
    });
  }

  async fail(commandId, { retryable, retryAfterMs = null, errorCode = "UNKNOWN" }) {
    if (typeof retryable !== "boolean") throw new Error("retryable must be a boolean from the authenticated MCP result.");
    if (retryAfterMs !== null && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)) throw new Error("retryAfterMs must be a nonnegative integer.");
    return this.withState((state) => {
      const entry = state.events.find((candidate) => candidate.envelope.commandId === commandId);
      if (!entry || entry.status !== "IN_FLIGHT") throw new Error("Only an in-flight observation can record a send failure.");
      entry.lastErrorCode = SAFE_ERROR_CODE.test(errorCode) ? errorCode : "UNKNOWN";
      entry.sentAt = null;
      if (!retryable || entry.attempts >= OBSERVATION_QUEUE_LIMITS.maxSendAttempts) {
        entry.status = "PENDING";
        entry.nextAttemptAt = null;
        return { status: "PENDING", commandId, attempts: entry.attempts, lastErrorCode: entry.lastErrorCode };
      }
      const baseDelayMs = Math.min(OBSERVATION_QUEUE_LIMITS.backoffCapMs, 1000 * (2 ** (entry.attempts - 1)));
      const jitter = Math.min(OBSERVATION_QUEUE_LIMITS.backoffCapMs - baseDelayMs, Math.floor(this.random() * Math.max(1, baseDelayMs / 4)));
      const localBackoffMs = Math.min(OBSERVATION_QUEUE_LIMITS.backoffCapMs, baseDelayMs + jitter);
      const delayMs = retryAfterMs === null ? localBackoffMs : Math.max(localBackoffMs, retryAfterMs);
      entry.status = "RETRY_WAIT";
      entry.nextAttemptAt = this.now() + delayMs;
      return { status: entry.status, commandId, attempts: entry.attempts, retryAt: entry.nextAttemptAt, delayMs };
    });
  }

  async requeuePending(commandId) {
    return this.withState((state) => {
      const entry = state.events.find((candidate) => candidate.envelope.commandId === commandId);
      if (!entry || entry.status !== "PENDING") throw new Error("Only a visibly PENDING observation can be manually requeued.");
      entry.status = "QUEUED";
      entry.attempts = 0;
      entry.nextAttemptAt = this.now();
      entry.sentAt = null;
      entry.lastErrorCode = null;
      return { status: entry.status, commandId, attempts: 0, envelope: entry.envelope };
    });
  }

  async list() {
    return this.withState((state) => ({
      count: state.events.length,
      bytes: Buffer.byteLength(serializeState(state), "utf8"),
      entries: state.events.map((entry) => ({
        commandId: entry.envelope.commandId, eventId: entry.envelope.payload.eventId, eventType: entry.envelope.payload.eventType,
        sourceSequence: entry.envelope.payload.sourceSequence, status: entry.status, attempts: entry.attempts,
        retryAt: entry.nextAttemptAt, lastErrorCode: entry.lastErrorCode,
      })),
    }));
  }

  async withState(action) {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.stateDirectory, 0o700);
    const lockPath = this.filePath + ".lock";
    const releaseLock = await this.acquireLock(lockPath);
    try {
      const state = await this.readState();
      this.pruneExpired(state);
      const result = action(state);
      this.enforceBounds(state);
      await this.writeState(state);
      return result;
    } finally {
      await releaseLock();
    }
  }

  async acquireLock(lockPath) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
        return async () => { await unlink(lockPath).catch(() => {}); };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > OBSERVATION_QUEUE_LIMITS.inFlightTimeoutMs * 2) await unlink(lockPath);
        } catch (statError) {
          if (statError.code !== "ENOENT") throw statError;
        }
        await new Promise((resolve) => setTimeout(resolve, 15 + Math.floor(Math.random() * 25)));
      }
    }
    throw new Error("Timed out waiting for the local observation queue lock.");
  }

  async readState() {
    try {
      const state = JSON.parse(await readFile(this.filePath, "utf8"));
      if (state.schemaVersion !== 1 || state.scopeHash !== this.scopeHash || state.planHash !== this.planHash ||
          !Array.isArray(state.events) || !state.sequences || typeof state.sequences !== "object") {
        throw new Error("Local observation queue state has an unsupported schema or scope.");
      }
      return state;
    } catch (error) {
      if (error.code === "ENOENT") return { schemaVersion: 1, scopeHash: this.scopeHash, planHash: this.planHash, events: [], sequences: {} };
      throw error;
    }
  }

  pruneExpired(state) {
    const cutoff = this.now() - OBSERVATION_QUEUE_LIMITS.retentionMs;
    state.events = state.events.filter((entry) => entry.createdAt > cutoff);
    for (const [key, sequence] of Object.entries(state.sequences)) if (sequence.updatedAt <= cutoff) delete state.sequences[key];
  }

  enforceBounds(state) {
    const eventCount = state.events.length;
    if (eventCount > OBSERVATION_QUEUE_LIMITS.maxEvents) throw new Error("Observation queue is full: maximum 1000 pending events.");
    const bytes = Buffer.byteLength(serializeState(state), "utf8");
    if (bytes > OBSERVATION_QUEUE_LIMITS.maxBytes) throw new Error("Observation queue is full: maximum 5 MiB persisted state.");
  }

  async writeState(state) {
    const serialized = serializeState(state);
    this.enforceBounds(state);
    const temporaryPath = this.filePath + "." + randomUUID() + ".tmp";
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  const input = await readStdin();
  const operation = process.argv[2];
  const queue = new ObservationQueue(input);
  let result;
  if (operation === "enqueue") result = await queue.enqueue(input.envelope);
  else if (operation === "next") result = await queue.next();
  else if (operation === "begin") result = await queue.begin(input.commandId);
  else if (operation === "acknowledge") result = await queue.acknowledge(input.commandId);
  else if (operation === "fail") result = await queue.fail(input.commandId, input.failure);
  else if (operation === "requeue-pending") result = await queue.requeuePending(input.commandId);
  else if (operation === "list") result = await queue.list();
  else throw new Error("Use enqueue, next, begin, acknowledge, fail, requeue-pending, or list.");
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write((error && error.message) || "Local observation queue failed.\n");
    process.exitCode = 1;
  });
}
