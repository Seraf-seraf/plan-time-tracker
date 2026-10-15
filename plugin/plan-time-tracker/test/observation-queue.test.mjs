import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ObservationQueue, OBSERVATION_QUEUE_LIMITS } from "../scripts/observation-queue.mjs";

const OWNER_SCOPE = "a".repeat(64);
const OTHER_OWNER_SCOPE = "b".repeat(64);
const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

function uuid(number) {
  return "a0000000-0000-4000-8000-" + String(number).padStart(12, "0");
}

function envelope(sequence) {
  return {
    schemaVersion: 1,
    commandId: uuid(sequence * 2),
    commandType: "AppendObservation",
    payload: {
      eventId: uuid(sequence * 2 + 1), planId: PLAN_ID, sourceId: "codex-local", sessionId: SESSION_ID,
      sourceSequence: sequence, occurredAt: 1800000000000 + sequence, eventType: "heartbeat", data: {},
    },
  };
}

async function withQueue(run) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "plan-time-tracker-queue-"));
  let now = 1800000000000;
  const options = { stateDirectory, ownerScope: OWNER_SCOPE, planContext: "plan-fixture", now: () => now, random: () => 0.5 };
  try {
    await run({ queue: new ObservationQueue(options), options, setNow: (value) => { now = value; } });
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

test("offline observations persist exact envelopes, preserve FIFO, honor Retry-After, and become visibly PENDING after five sends", async () => {
  await withQueue(async ({ queue, options, setNow }) => {
    const first = envelope(1), second = envelope(2);
    assert.deepEqual(await queue.enqueue(first), { status: "QUEUED", commandId: first.commandId, duplicate: false });
    assert.equal((await queue.enqueue(first)).duplicate, true);
    await queue.enqueue(second);
    assert.equal((await queue.next()).envelope.commandId, first.commandId);

    const sent = await queue.begin(first.commandId);
    assert.equal(sent.attempts, 1);
    assert.deepEqual(sent.envelope, first);
    assert.equal((await queue.next()).status, "IN_FLIGHT");

    const restartedQueue = new ObservationQueue(options);
    setNow(1800000000000 + OBSERVATION_QUEUE_LIMITS.inFlightTimeoutMs);
    const recovered = await restartedQueue.next();
    assert.equal(recovered.status, "READY");
    assert.deepEqual(recovered.envelope, first);
    await restartedQueue.begin(first.commandId);
    const retryWait = await restartedQueue.fail(first.commandId, { retryable: true, retryAfterMs: 45000, errorCode: "RATE_LIMITED" });
    assert.equal(retryWait.status, "RETRY_WAIT");
    assert.ok(retryWait.delayMs >= 45000, "Retry-After is a lower bound even when it exceeds local backoff cap");

    let attempts = 2;
    while (attempts < OBSERVATION_QUEUE_LIMITS.maxSendAttempts) {
      setNow(retryWait.retryAt + (attempts - 2) * 100000);
      const next = await restartedQueue.next();
      assert.equal(next.status, "READY");
      const begun = await restartedQueue.begin(first.commandId);
      attempts = begun.attempts;
      const failed = await restartedQueue.fail(first.commandId, { retryable: true, errorCode: "SOURCE_UNAVAILABLE" });
      if (attempts < OBSERVATION_QUEUE_LIMITS.maxSendAttempts) assert.equal(failed.status, "RETRY_WAIT");
      else assert.equal(failed.status, "PENDING");
      if (failed.status === "PENDING") break;
      setNow(failed.retryAt);
    }

    assert.deepEqual(await restartedQueue.next(), {
      status: "PENDING", commandId: first.commandId, attempts: OBSERVATION_QUEUE_LIMITS.maxSendAttempts, lastErrorCode: "SOURCE_UNAVAILABLE",
    });
    const manualRetry = await restartedQueue.requeuePending(first.commandId);
    assert.deepEqual(manualRetry.envelope, first);
    assert.equal(manualRetry.attempts, 0);
    await restartedQueue.begin(first.commandId);
    assert.equal((await restartedQueue.acknowledge(first.commandId)).status, "ACKNOWLEDGED");
    assert.equal((await restartedQueue.next()).commandId, second.commandId);
  });
});

test("retry backoff grows exponentially with bounded positive jitter", async () => {
  await withQueue(async ({ options, setNow }) => {
    const randomValues = [0, 0.999999, 0.5, 0.999999];
    const queue = new ObservationQueue({ ...options, random: () => randomValues.shift() ?? 0.5 });
    const item = envelope(1);
    await queue.enqueue(item);

    const expectedDelays = [1000, 2499, 4500, 9999];
    for (let index = 0; index < OBSERVATION_QUEUE_LIMITS.maxSendAttempts; index += 1) {
      const ready = await queue.next();
      assert.equal(ready.status, "READY");
      const sent = await queue.begin(item.commandId);
      assert.equal(sent.attempts, index + 1);
      const failed = await queue.fail(item.commandId, { retryable: true, errorCode: "SOURCE_UNAVAILABLE" });

      if (index < expectedDelays.length) {
        assert.equal(failed.status, "RETRY_WAIT");
        assert.equal(failed.delayMs, expectedDelays[index]);
        assert.ok(failed.delayMs <= OBSERVATION_QUEUE_LIMITS.backoffCapMs);
        setNow(failed.retryAt);
      } else {
        assert.deepEqual(failed, {
          status: "PENDING", commandId: item.commandId, attempts: OBSERVATION_QUEUE_LIMITS.maxSendAttempts,
          lastErrorCode: "SOURCE_UNAVAILABLE",
        });
      }
    }
  });
});

test("queue is owner and plan scoped, expires after seven days, and refuses lifecycle or secret payloads", async () => {
  await withQueue(async ({ queue, options, setNow }) => {
    await queue.enqueue(envelope(1));
    const otherOwner = new ObservationQueue({ ...options, ownerScope: OTHER_OWNER_SCOPE });
    const otherRepository = new ObservationQueue({ ...options, planContext: "other-plan" });
    assert.equal((await otherOwner.next()).status, "EMPTY");
    assert.equal((await otherRepository.next()).status, "EMPTY");

    const lifecycle = envelope(2);
    lifecycle.commandType = "StartPlan";
    await assert.rejects(queue.enqueue(lifecycle), /Only a version 1 AppendObservation/);
    const secret = envelope(2);
    secret.payload.eventType = "correction";
    secret.payload.correctionOfEventId = uuid(8);
    secret.payload.data = { reason: "Bearer abcdefghijklmnopabcdefghijklmnop" };
    await assert.rejects(queue.enqueue(secret), /credential/);
    const secretSource = envelope(2);
    secretSource.payload.sourceId = "Bearer abcdefghijklmnopabcdefghijklmnop";
    await assert.rejects(queue.enqueue(secretSource), /sourceId/);
    const invalidTool = envelope(2);
    invalidTool.payload.eventType = "tool_started";
    invalidTool.payload.data = { operationId: uuid(9), toolName: "t".repeat(81) };
    await assert.rejects(queue.enqueue(invalidTool), /toolName/);

    setNow(1800000000000 + OBSERVATION_QUEUE_LIMITS.retentionMs);
    assert.equal((await queue.list()).count, 0);
    assert.equal((await queue.next()).status, "EMPTY");
  });
});

test("source sequence remains monotonic across restart within a session and resets for a new session", async () => {
  await withQueue(async ({ queue, options }) => {
    await queue.enqueue(envelope(1));
    const restartedQueue = new ObservationQueue(options);
    const reusedSequence = {
      ...envelope(1),
      commandId: uuid(80),
      payload: { ...envelope(1).payload, eventId: uuid(81) },
    };
    await assert.rejects(restartedQueue.enqueue(reusedSequence), /sourceSequence must increase within a source session/);

    const nextSession = {
      ...envelope(1),
      commandId: uuid(82),
      payload: { ...envelope(1).payload, eventId: uuid(83), sessionId: "33333333-3333-4333-8333-333333333333" },
    };
    assert.deepEqual(await restartedQueue.enqueue(nextSession), {
      status: "QUEUED", commandId: nextSession.commandId, duplicate: false,
    });
  });
});

test("concurrent local consumers cannot begin the same observation twice", async () => {
  await withQueue(async ({ queue, options }) => {
    const item = envelope(1);
    await queue.enqueue(item);
    const otherConsumer = new ObservationQueue(options);
    const results = await Promise.allSettled([queue.begin(item.commandId), otherConsumer.begin(item.commandId)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const stored = await queue.list();
    assert.equal(stored.entries[0].status, "IN_FLIGHT");
    assert.equal(stored.entries[0].attempts, 1);
  });
});

test("event and durable-state caps are enforced at their exact boundaries", async () => {
  await withQueue(async ({ queue }) => {
    const dummy = { envelope: envelope(1), status: "QUEUED", attempts: 0, createdAt: 1, nextAttemptAt: 1, sentAt: null, lastErrorCode: null };
    const state = { schemaVersion: 1, scopeHash: "a", repositoryHash: "b", events: Array(OBSERVATION_QUEUE_LIMITS.maxEvents).fill(dummy), sequences: {} };
    assert.doesNotThrow(() => queue.enforceBounds(state));
    state.events.push(dummy);
    assert.throws(() => queue.enforceBounds(state), /maximum 1000 pending events/);
    state.events = [];
    state.sequences = { oversized: { lastSequence: 1, updatedAt: 1, metadata: "x".repeat(OBSERVATION_QUEUE_LIMITS.maxBytes) } };
    assert.throws(() => queue.enforceBounds(state), /maximum 5 MiB/);
  });
});

test("CLI persists an observation without receiving or storing the authenticated owner identity", async () => {
  await withQueue(async ({ options }) => {
    const scriptPath = fileURLToPath(new URL("../scripts/observation-queue.mjs", import.meta.url));
    const input = { stateDirectory: options.stateDirectory, ownerScope: OWNER_SCOPE, planContext: "plan-fixture", envelope: envelope(1) };
    const enqueue = spawnSync(process.execPath, [scriptPath, "enqueue"], { input: JSON.stringify(input), encoding: "utf8" });
    assert.equal(enqueue.status, 0, enqueue.stderr);
    assert.equal(JSON.parse(enqueue.stdout).status, "QUEUED");
    const list = spawnSync(process.execPath, [scriptPath, "list"], { input: JSON.stringify(input), encoding: "utf8" });
    assert.equal(list.status, 0, list.stderr);
    assert.equal(JSON.parse(list.stdout).entries[0].commandId, input.envelope.commandId);
  });
});

test("queue state uses private local permissions and stores only hashed owner/plan scope", async () => {
  await withQueue(async ({ queue, options }) => {
    await queue.enqueue(envelope(1));
    const [directoryStat, fileStat, stored] = await Promise.all([
      stat(options.stateDirectory), stat(queue.filePath), readFile(queue.filePath, "utf8"),
    ]);
    assert.equal(directoryStat.mode & 0o777, 0o700);
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.equal(stored.includes(OWNER_SCOPE), false);
    assert.equal(stored.includes(options.planContext), false);
  });
});
