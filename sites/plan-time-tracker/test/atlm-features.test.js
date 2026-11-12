import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAgentTaskV1 } from "../worker/index.js";
import { context, command, ok, mcp, atlmTask, atlmAssessment, plannedAtlm, PLAN } from "./fixtures/tracker-db.mjs";

test("server canonicalizes lists without mutating input; counts represent unique facts", () => {
  const input = atlmTask();
  input.outcomes = [{ id: "z", description: "Z", evidence: "Z proof" }, { id: "a", description: "A", evidence: "A proof" }, { id: "z", description: "Z", evidence: "Z proof" }];
  input.changedContracts = [{ kind: "API", key: "get", description: "API operation", evidence: "Endpoint requirement" }, { kind: "API", key: "get", description: "API operation", evidence: "Endpoint requirement" }];
  input.verificationKinds = ["UI_E2E", "UNIT", "UNIT"];
  const before = structuredClone(input), got = normalizeAgentTaskV1(input);
  assert.deepEqual(input, before);
  assert.deepEqual(got.agentTask.outcomes.map(item => item.id), ["a", "z"]);
  assert.deepEqual(got.features, { workKind: "MODIFY_MECHANISM", reuseState: "PARTIAL", doneBoundary: "LOCAL_VERIFIED", outcomeCount: 2, contractCount: 1, verificationKindCount: 2, modelId: null, reasoningEffort: null, plannedParallelAgents: null });
  assert.deepEqual(normalizeAgentTaskV1({ ...input, outcomes: [...input.outcomes].reverse() }), got);
});

test("UNKNOWN and null remain missing, while confirmed empty lists yield genuine zero", () => {
  const input = atlmTask(); input.profile.reuseState = "UNKNOWN"; input.outcomes = null;
  const got = normalizeAgentTaskV1(input);
  assert.deepEqual(got.missingFields, ["profile.reuseState", "outcomes"]);
  assert.equal(got.features.outcomeCount, null); assert.equal(got.features.contractCount, 0);
  assert.equal(got.features.reuseState, "UNKNOWN");
});

test("strict namespace rejects fake counts, ambiguous keys, excessive or unknown facts", () => {
  const changes = [
    x => x.outcomeCount = 99, x => x.profile.workKind = "easy",
    x => x.runtimeContext.plannedParallelAgents = 0, x => x.runtimeContext.modelId = "x".repeat(129),
    x => x.outcomes = Array.from({ length: 21 }, (_, i) => ({ id: String(i), description: "Item", evidence: "Proof" })),
    x => x.outcomes.push({ ...x.outcomes[0], evidence: "Conflicting evidence" }),
    x => x.changedContracts = [{ kind: "API", key: "a", description: "x", evidence: "y", count: 100 }],
    x => x.verificationKinds = ["invented-check"], x => x.profileEvidence.workKind = "",
  ];
  for (const mutate of changes) {
    const input = atlmTask(); mutate(input);
    assert.throws(() => normalizeAgentTaskV1(input), error => error.code === "VALIDATION_ERROR");
  }
});

test("RecordAssessment enforces schema and persists normalized facts without changing receipt identity", async () => {
  const c = context();
  try {
    const planned = await plannedAtlm(c), p = await atlmAssessment(c);
    p.context.agentTask.outcomes.push({ ...p.context.agentTask.outcomes[0] });
    const commandId = crypto.randomUUID();
    const first = await command(c, "RecordAssessment", p, 0, commandId), retry = await command(c, "RecordAssessment", p, 0, commandId);
    assert.equal(first.status, 200); assert.equal(retry.value.replayed, true);
    const read = (await mcp(c, "GetAssessment", { planId: PLAN, assessmentId: p.assessmentId })).value.result.structuredContent;
    assert.equal(read.assessment.context.agentTask.outcomes.length, 1);
    const invalid = await atlmAssessment(c); invalid.context.agentTask.contractCount = 42;
    assert.equal((await command(c, "RecordAssessment", invalid, 0)).status, 400);
    const neutral = await atlmAssessment(c, PLAN, undefined, { context: { legacy: true } });
    await ok(c, "RecordAssessment", neutral, 0);
    const knownUnknown = atlmTask(); knownUnknown.outcomes = null;
    await ok(c, "RecordAssessment", await atlmAssessment(c, PLAN, knownUnknown), 0);
    assert.equal(c.db.sqlite.prepare("SELECT first_started_at FROM plans WHERE plan_id=?").get(planned.planId).first_started_at, null);
  } finally { c.close(); }
});


test("runtime inputs are optional and retain unknown without inventing an agent count", async () => {
  for (const runtime of [undefined, null, {}, {modelId:null, reasoningEffort:null, plannedParallelAgents:null}, {modelId:"  ", reasoningEffort:""}]) {
    const input=atlmTask(); if(runtime===undefined)delete input.runtimeContext;else input.runtimeContext=runtime;
    const before=structuredClone(input),normalized=normalizeAgentTaskV1(input);
    assert.deepEqual(input,before);
    assert.equal(normalized.features.modelId,null);
    assert.equal(normalized.features.reasoningEffort,null);
    assert.equal(normalized.features.plannedParallelAgents,null);
    assert.equal(normalized.agentTask.runtimeContext.provenance,"UNKNOWN");
    assert.deepEqual(normalized.missingFields,[]);
    const c=context();try {await plannedAtlm(c);const response=await mcp(c,"EstimatePlanTime",{planId:PLAN,expectedRequirementsDigest:(await mcp(c,"GetAssessment",{planId:PLAN})).value.result.structuredContent.currentRequirementsDigest,agentTask:input});assert.equal(response.value.result.isError,undefined,JSON.stringify(response.value));}finally{c.close();}
  }
  const input=atlmTask();input.runtimeContext={modelId:" model-a ",reasoningEffort:" MAX ",plannedParallelAgents:3};
  const normalized=normalizeAgentTaskV1(input);
  assert.equal(normalized.features.modelId,"model-a");assert.equal(normalized.features.reasoningEffort,"max");assert.equal(normalized.features.plannedParallelAgents,3);
  for(const count of [0,-1,1.5,"2"]){input.runtimeContext.plannedParallelAgents=count;assert.throws(()=>normalizeAgentTaskV1(input),e=>e.code==="VALIDATION_ERROR");}
});
