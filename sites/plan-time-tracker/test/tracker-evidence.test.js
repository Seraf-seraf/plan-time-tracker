import test from "node:test";
import assert from "node:assert/strict";
import { call, command, context, ok, running, result, source, check, execution, rows, mcp, envelope, migrations, migration, internalCommand, OWNER, PLAN, DIGEST_A, DIGEST_B } from "./fixtures/tracker-db.mjs";

test("public MCP discovery and capabilities expose source snapshots without Git fields or observations", async () => {
  const c = context(); try {
    const list = await call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = list.value.result.tools;
    assert(tools.some(tool => tool.name === "RecordCheck"));
    assert(!/SyncRepository|AttachPlanRepository|ReviewCommitLink|repositoryId|revisionSha|testedSha|commitPolicy|pushPolicy|worktreeSnapshot|commit_created|commit_pushed|push_failed/.test(JSON.stringify(tools)));
    const caps = (await mcp(c, "GetTrackerCapabilities")).value.result.structuredContent;
    assert.deepEqual(caps.resultSourceKinds, ["SOURCE_SNAPSHOT", "NONE"]);
    assert.equal(caps.sourceSnapshot.formatVersion, 2);
    assert.equal(caps.localObservationQueue.ownerScope.length, 64);
    const stepSchema = tools.find(tool => tool.name === "CreateStep").inputSchema.properties.payload;
    assert.deepEqual(stepSchema.required, ["planId", "ordinal", "title", "expectedResult", "requiredChecks"]);
    assert.equal(stepSchema.additionalProperties, false);
  } finally { c.close(); }
});

test("removed routes, commands and Git payload fields refuse before domain writes, including cached old commands", async () => {
  const c = context(); try {
    const lease = await running(c);
    const before = rows(c);
    for (const [method, path] of [["GET", "/api/repositories"], ["POST", "/api/repositories/sync"], ["DELETE", "/api/repositories/old/cache"], ["POST", "/api/repositories/old/recheck-access"], ["GET", "/api/commit-conflicts"]]) {
      assert.equal((await call(c, path, undefined, OWNER, method)).status, 404);
    }
    for (const name of ["SyncRepository", "AttachPlanRepository", "ReviewCommitLink"]) {
      assert.equal((await command(c, name, { planId: PLAN }, 1)).status, 410);
      assert.equal((await mcp(c, name, envelope(name, { planId: PLAN }, 1))).value.result.isError, true);
    }
    for (const [name, payload, version] of [
      ["CreatePlan", { title: "Removed input", repositoryIds: [] }],
      ["CreateStep", { planId: PLAN, commitPolicy: "NEVER" }],
      ["UpdateStep", { stepId: lease.stepId, changes: { pushPolicy: "NEVER" } }, 2],
      ["RecordStepResult", { ...lease, repositoryId: "old", revisionSha: "a".repeat(40) }, 2],
      ["RecordStepResult", { ...lease, worktreeSnapshot: { kind: "WORKTREE_SNAPSHOT" } }, 2],
      ["RecordCheck", { ...check(lease.stepId), testedSha: "a".repeat(40) }],
      ["AppendObservation", { planId: PLAN, eventType: "commit_created" }],
    ]) assert.equal((await command(c, name, payload, version)).status, 400);
    assert.equal((await call(c, "/api/analytics?repositoryId=old")).status, 400);
    assert.equal((await mcp(c, "GetAnalytics", { repositoryIds: [] })).value.result.isError, true);
    assert.deepEqual(rows(c), before);
    const id = crypto.randomUUID();
    c.db.sqlite.prepare("INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,result_json,recorded_at) VALUES(?,?,'old','ReviewCommitLink',?,0,1,?,'user','{}','OK','{}',1)").run(OWNER, id, PLAN, OWNER);
    const oldRows = rows(c);
    assert.equal((await command(c, "ReviewCommitLink", { planId: PLAN }, 0, id)).status, 410);
    assert.deepEqual(rows(c), oldRows);
  } finally { c.close(); }
});

test("repository-free MCP result/check flow preserves timer intervals, exact replay and owner isolation", async () => {
  const c = context(); try {
    const lease = await running(c, ["unit", "build"]);
    c.advance(1500);
    const data = envelope("RecordStepResult", { ...lease, outcome: "DONE", summary: "Checked source", sourceSnapshot: source() }, 2);
    const first = (await mcp(c, "RecordStepResult", data)).value.result.structuredContent;
    assert.equal(first.outcome, "OK");
    const replay = (await mcp(c, "RecordStepResult", data)).value.result.structuredContent;
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first.result);
    assert.equal((await mcp(c, "RecordStepResult", { ...data, payload: { ...data.payload, sourceSnapshot: source(DIGEST_B) } })).value.result.structuredContent.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_results").get().n, 1);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM repositories").get().n, 0);
    assert.equal((await execution(c)).steps[0].currentResult.source_kind, "SOURCE_SNAPSHOT");
    for (const key of ["unit", "build"]) {
      const input = envelope("RecordCheck", check(lease.stepId, "PASSED", DIGEST_A, 1, key));
      assert.equal((await mcp(c, "RecordCheck", input)).value.result.structuredContent.outcome, "OK");
      assert.equal((await mcp(c, "RecordCheck", input)).value.result.structuredContent.replayed, true);
    }
    const snapshot = await execution(c);
    assert.equal(snapshot.steps[0].readyToFinish, true);
    assert(snapshot.steps[0].currentChecks.every(item => item.matchesCurrentResult));
    assert.equal(snapshot.plan.activeMs, 1500);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_source_checks").get().n, 2);
    assert.equal((await call(c, "/api/tracker/plans/" + PLAN + "/execution", undefined, "other")).status, 404);
    assert.equal((await call(c, "/api/tracker/plans/" + PLAN + "/execution", undefined, null)).status, 401);
    const finish = envelope("FinishPlan", { planId: PLAN }, 1);
    const finished = (await mcp(c, "FinishPlan", finish)).value.result.structuredContent;
    assert.equal(finished.outcome, "OK");
    assert.equal((await mcp(c, "FinishPlan", finish)).value.result.structuredContent.replayed, true);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM work_intervals WHERE end_ms IS NULL").get().n, 0);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM plan_events WHERE event_type='FINISHED'").get().n, 1);
  } finally { c.close(); }
});

test("source validation and stale evidence fail without result/check mutations and retain final mismatch receipts", async () => {
  const c = context(); try {
    const lease = await running(c);
    for (const input of [{ ...source(), digest: "a".repeat(40) }, { ...source(), digest: "sha256:" + "A".repeat(64) }, { ...source(), digest: DIGEST_A + "\n" }, { ...source(), digest: [DIGEST_A] }, { ...source(), kind: "WORKTREE_SNAPSHOT" }, { ...source(), formatVersion: 1 }, { ...source(), repositoryId: "x" }]) {
      const before = rows(c);
      assert.equal((await command(c, "RecordStepResult", { ...lease, outcome: "DONE", summary: "Bad evidence", sourceSnapshot: input }, 2)).status, 400);
      assert.deepEqual(rows(c), before);
    }
    await result(c, lease);
    for (const payload of [{ ...check(lease.stepId), exitCode: 1 }, { ...check(lease.stepId, "FAILED"), exitCode: 0 }, { ...check(lease.stepId, "NOT_RUN"), exitCode: 0 }]) assert.equal((await command(c, "RecordCheck", payload)).status, 400);
    const id = crypto.randomUUID(), wrong = check(lease.stepId, "PASSED", DIGEST_B);
    const response = await command(c, "RecordCheck", wrong, undefined, id);
    assert.equal(response.value.error.code, "RESULT_REVISION_STALE");
    assert.equal((await call(c, "/api/tracker/commands/" + id)).value.status, "FINAL");
    assert.equal((await command(c, "RecordCheck", wrong, undefined, id)).value.error.code, "RESULT_REVISION_STALE");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_source_checks").get().n, 0);
    assert.equal((await execution(c)).steps[0].readyToFinish, false);
    await ok(c, "RecordCheck", check(lease.stepId));
    assert.equal((await execution(c)).steps[0].readyToFinish, true);
  } finally { c.close(); }
});

test("latest server sequence controls readiness at equal timestamps; FAILED and NOT_RUN block finish", async () => {
  const c = context(); try {
    const lease = await running(c); await result(c, lease);
    for (const status of ["PASSED", "FAILED", "PASSED", "NOT_RUN", "PASSED"]) {
      await ok(c, "RecordCheck", check(lease.stepId, status));
      const step = (await execution(c)).steps[0];
      assert.equal(step.currentChecks[0].status, status);
      assert.equal(step.readyToFinish, status === "PASSED");
      if (status !== "PASSED") assert.equal((await command(c, "FinishPlan", { planId: PLAN }, 1)).value.error.code, "CHECKPOINTS_INCOMPLETE");
    }
    const checks = (await execution(c)).steps[0].checks;
    assert.equal(new Set(checks.map(item => item.created_at)).size, 1);
    assert.equal(new Set(checks.map(item => item.server_sequence)).size, 5);
  } finally { c.close(); }
});

async function rework(c, lease, digest, version = 3) {
  const reason = "Owner assigned changed source";
  const claim = await ok(c, "ClaimStepAttempt", { stepId: lease.stepId, sessionId: crypto.randomUUID(), sourceId: "fixture", reworkReason: reason }, version);
  const next = { stepId: lease.stepId, attemptId: claim.attemptId, fence: claim.fence };
  await ok(c, "StartStep", { ...next, rework: true, reason }, version);
  await result(c, next, digest, version + 1);
}

test("new result revision never inherits checks, including same digest and late historical passes", async () => {
  const c = context(); try {
    const lease = await running(c); await result(c, lease);
    await ok(c, "RecordCheck", check(lease.stepId));
    await rework(c, lease, DIGEST_B);
    assert.equal((await execution(c)).steps[0].readyToFinish, false);
    assert.equal((await command(c, "RecordCheck", check(lease.stepId, "PASSED", DIGEST_A, 2))).value.error.code, "RESULT_REVISION_STALE");
    await ok(c, "RecordCheck", check(lease.stepId));
    assert.deepEqual((await execution(c)).steps[0].currentChecks, []);
    await ok(c, "RecordCheck", check(lease.stepId, "PASSED", DIGEST_B, 2));
    assert.equal((await execution(c)).steps[0].readyToFinish, true);
    await rework(c, lease, DIGEST_B, 5);
    assert.equal((await execution(c)).steps[0].currentResult.revision, 3);
    assert.equal((await execution(c)).steps[0].readyToFinish, false);
    await ok(c, "RecordCheck", check(lease.stepId, "PASSED", DIGEST_B, 3));
    assert.equal((await execution(c)).steps[0].readyToFinish, true);
  } finally { c.close(); }
});

test("adding required checks invalidates readiness and source-less results never acquire evidence", async () => {
  const c = context(); try {
    const lease = await running(c); await result(c, lease, null);
    assert.equal((await execution(c)).steps[0].readyToFinish, false);
    assert.equal((await command(c, "RecordCheck", check(lease.stepId))).value.error.code, "RESULT_REVISION_STALE");
    await rework(c, lease, DIGEST_A);
    await ok(c, "RecordCheck", check(lease.stepId, "PASSED", DIGEST_A, 2));
    assert.equal((await execution(c)).steps[0].readyToFinish, true);
    await ok(c, "UpdateStep", { stepId: lease.stepId, changes: { requiredChecks: ["unit", "build"] }, reason: "New required check" }, 5);
    assert.equal((await execution(c)).steps[0].readyToFinish, false);
    assert.equal((await command(c, "FinishPlan", { planId: PLAN }, 1)).value.error.code, "CHECKPOINTS_INCOMPLETE");
  } finally { c.close(); }
});

test("snapshot insertion failure rolls back result, receipt, lease, revision and journal atomically", async () => {
  const c = context(); try {
    const lease = await running(c), before = rows(c);
    c.db.sqlite.exec("CREATE TRIGGER fixture_fail_snapshot BEFORE INSERT ON step_source_snapshots BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    assert.equal((await command(c, "RecordStepResult", { ...lease, outcome: "DONE", summary: "Rollback fixture", sourceSnapshot: source() }, 2)).status, 500);
    assert.deepEqual(rows(c), before);
  } finally { c.close(); }
});

test("populated 0014 upgrade preserves every stored row, legacy readiness, revoked source protection and timer state", async () => {
  const c = context(migrations.indexOf("0015_source_snapshots.sql")); try {
    const lease = await running(c);
    c.db.sqlite.prepare("INSERT INTO repositories(owner_id,repository_id,full_name,is_private,default_branch,access_state,updated_at) VALUES(?,'legacy','fixture/legacy',1,'main','available',1)").run(OWNER);
    c.db.sqlite.prepare("INSERT INTO plan_repositories(owner_id,plan_id,repository_id,selected_ref) VALUES(?,?,'legacy','main')").run(OWNER, PLAN);
    await internalCommand(c, "RecordStepResult", { ...lease, outcome: "DONE", summary: "Historical COMMIT evidence", repositoryId: "legacy", revisionSha: "a".repeat(40) }, 2);
    await internalCommand(c, "RecordCheck", { stepId: lease.stepId, resultRevision: 1, checkKey: "unit", status: "PASSED", testedSha: "a".repeat(40), exitCode: 0 });
    c.db.sqlite.prepare("INSERT INTO commits(owner_id,repository_id,sha,observed_at,message,url) VALUES(?,'legacy',?,1,'Historical retained commit','https://example.invalid/commit')").run(OWNER,"a".repeat(40));
    c.db.sqlite.prepare("INSERT INTO plan_commit_links(owner_id,plan_id,repository_id,sha,status,basis,reason,reviewed_by,reviewed_at,history_json) VALUES(?,?,'legacy',?,'confirmed','manual','Historical retained attribution',?,1,'[]')").run(OWNER,PLAN,"a".repeat(40),OWNER);
    c.db.sqlite.prepare("INSERT INTO repository_ref_commits(owner_id,repository_id,ref,sha,last_seen_sync_id) VALUES(?,'legacy','main',?,'historical')").run(OWNER,"a".repeat(40));
    const second = await ok(c, "CreateStep", { planId: PLAN, ordinal: 1, title: "Historical snapshot", expectedResult: "Preserve", requiredChecks: ["unit"] });
    const claim = await ok(c, "ClaimStepAttempt", { stepId: second.stepId, sessionId: crypto.randomUUID(), sourceId: "fixture" }, 1);
    const next = { stepId: second.stepId, attemptId: claim.attemptId, fence: claim.fence };
    await ok(c, "StartStep", next, 1);
    await internalCommand(c, "RecordStepResult", { ...next, outcome: "DONE", summary: "Historical v1 evidence", worktreeSnapshot: { kind: "WORKTREE_SNAPSHOT", formatVersion: 1, repositoryId: "legacy", digest: DIGEST_B, baseRevisionSha: "b".repeat(40) } }, 2);
    await internalCommand(c, "RecordCheck", check(second.stepId, "PASSED", DIGEST_B));
    await ok(c, "FinishPlan", { planId: PLAN }, 1);
    const before = rows(c);
    c.db.sqlite.exec(migration("0015_source_snapshots.sql"));
    const after = rows(c);
    for (const [name, data] of Object.entries(before)) assert.deepEqual(after[name], data, name + " must be retained");
    assert.deepEqual(after.step_source_snapshots, []);
    const snapshot = await execution(c);
    assert(snapshot.steps.every(step => step.readyToFinish));
    assert.equal(snapshot.plan.status, "COMPLETED");
    assert(snapshot.steps.every(step => step.currentResult.source_kind === "HISTORICAL"));
    assert(!JSON.stringify(snapshot).includes('"revision_sha"'));
    c.db.sqlite.prepare("UPDATE repositories SET access_state='revoked' WHERE repository_id='legacy'").run();
    const protectedSnapshot = await execution(c);
    assert(protectedSnapshot.steps.every(step => step.readyToFinish));
    assert(protectedSnapshot.steps.every(step => step.currentResult.protectedRevisionHidden));
    assert(!JSON.stringify(protectedSnapshot).includes(DIGEST_B));
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM work_intervals WHERE end_ms IS NULL").get().n, 0);
    assert.equal(c.db.sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { c.close(); }
});

test("expired and fenced attempts cannot attribute a v2 result or close another attempt", async () => {
  const c = context(); try {
    const lease = await running(c), beforeResults = c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_results").get().n;
    c.advance(10 * 60 * 1000 + 1);
    const expired = await command(c, "RecordStepResult", { ...lease, outcome: "DONE", summary: "Expired executor", sourceSnapshot: source() }, 2);
    assert.equal(expired.value.error.code, "LEASE_EXPIRED");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_results").get().n, beforeResults);
    const recovered = await ok(c, "ClaimStepAttempt", { stepId: lease.stepId, sessionId: crypto.randomUUID(), sourceId: "recovery", recoveryReason: "Owner-approved recovery" }, 2);
    assert(recovered.fence > lease.fence);
    const next = { stepId: lease.stepId, attemptId: recovered.attemptId, fence: recovered.fence };
    await ok(c, "StartStep", next, 2);
    assert.notEqual((await command(c, "RecordStepResult", { ...lease, outcome: "DONE", summary: "Stale executor", sourceSnapshot: source() }, 3)).status, 200);
    await result(c, next, DIGEST_A, 3);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_source_snapshots").get().n, 1);
  } finally { c.close(); }
});

test("concurrent v2 check and finish obey the canonical gate and concurrent finish closes one interval", async () => {
  const c = context(); try {
    const lease = await running(c);await result(c, lease);
    const [checked, attempted] = await Promise.all([command(c, "RecordCheck", check(lease.stepId)), command(c, "FinishPlan", { planId: PLAN }, 1)]);
    assert.equal(checked.status, 200);
    if (attempted.status !== 200) {
      assert.equal(attempted.value.error.code, "CHECKPOINTS_INCOMPLETE");
      const finishes = await Promise.all([command(c, "FinishPlan", { planId: PLAN }, 1), command(c, "FinishPlan", { planId: PLAN }, 1)]);
      assert.equal(finishes.filter(item => item.status === 200).length, 1);
    }
    assert.equal((await execution(c)).steps[0].readyToFinish, true);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM work_intervals WHERE end_ms IS NULL").get().n, 0);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM plan_events WHERE event_type='FINISHED'").get().n, 1);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM tracker_finish_exceptions").get().n, 0);
  } finally { c.close(); }
});

test("0015 preserves an active attempt and open interval without attesting a historical source-less result", async () => {
  const c = context(migrations.indexOf("0015_source_snapshots.sql")); try {
    const lease = await running(c);
    await ok(c, "RecordStepResult", { ...lease, outcome: "DONE", summary: "Old prose report only" }, 2);
    const step = await ok(c, "CreateStep", { planId: PLAN, ordinal: 1, title: "Active at upgrade", expectedResult: "Preserve lease", requiredChecks: [] });
    const claim = await ok(c, "ClaimStepAttempt", { stepId: step.stepId, sessionId: crypto.randomUUID(), sourceId: "upgrade-fixture" }, 1);
    await ok(c, "StartStep", { stepId: step.stepId, attemptId: claim.attemptId, fence: claim.fence }, 1);
    const before = rows(c);
    c.db.sqlite.exec(migration("0015_source_snapshots.sql"));
    const after = rows(c);
    for (const [name, data] of Object.entries(before)) assert.deepEqual(after[name], data, name);
    const snapshot = await execution(c);
    const prose = snapshot.steps.find(item => item.step_id === lease.stepId);
    assert.equal(prose.currentResult.source_kind, "NONE");assert.equal(prose.readyToFinish, false);
    assert.deepEqual(prose.currentChecks, []);
    assert.equal(snapshot.steps.find(item => item.step_id === step.stepId).attempts[0].status, "OPEN");
    assert.equal(snapshot.plan.status, "RUNNING");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM work_intervals WHERE end_ms IS NULL").get().n, 1);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_source_snapshots").get().n, 0);
    assert.equal((await command(c, "RecordCheck", check(lease.stepId))).value.error.code, "RESULT_REVISION_STALE");
    assert.equal((await command(c, "FinishPlan", { planId: PLAN }, 1)).value.error.code, "CHECKPOINTS_INCOMPLETE");
  } finally { c.close(); }
});

test("v2 evidence remains immutable and cross-owner check commands cannot attach to another result", async () => {
  const c = context(); try {
    const lease = await running(c);await result(c, lease);await ok(c, "RecordCheck", check(lease.stepId));
    assert.throws(() => c.db.sqlite.exec("UPDATE step_source_snapshots SET snapshot_digest='sha256:" + "b".repeat(64) + "'"), /IMMUTABLE/);
    assert.throws(() => c.db.sqlite.exec("DELETE FROM step_source_snapshots"), /IMMUTABLE/);
    assert.throws(() => c.db.sqlite.exec("UPDATE step_source_checks SET status='NOT_RUN',exit_code=NULL"), /IMMUTABLE/);
    assert.throws(() => c.db.sqlite.exec("DELETE FROM step_source_checks"), /IMMUTABLE/);
    const other = await command(c, "RecordCheck", check(lease.stepId), undefined, undefined, "different-owner");
    assert.equal(other.value.error.code, "STEP_NOT_FOUND");
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_source_checks").get().n, 1);
    assert.equal((await execution(c)).steps[0].readyToFinish, true);
  } finally { c.close(); }
});
