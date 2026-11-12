import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { context, call, ok, mcp, plannedAtlm, completeAtlm, atlmAssessment, PLAN } from "./fixtures/tracker-db.mjs";

const workerPath = process.env.SITE_WORKER_MODULE || new URL("../dist/server/index.js", import.meta.url).pathname;

// This is a public-protocol acceptance test: no synthetic models, samples or jobs
// are inserted into SQL. The only training inputs are completed tracker plans.
test("packaged Worker learns automatically from completed plans and freezes the issued forecast", async () => {
  const c = context();
  try {
    const built = await import(pathToFileURL(resolve(workerPath)).href + "?atlm-public-lifecycle");
    const runtime = built.createWorker(c.now);
    const background = [];
    let scheduled = 0;
    c.worker = { async fetch(request, env) {
      const response = await runtime.fetch(request, env, { waitUntil(promise) {
        scheduled++;
        background.push(Promise.resolve(promise));
      } });
      // Deterministically flush actual waitUntil work, without sleeps or calling
      // the training implementation directly from this test.
      for (let pass = 0; background.length; pass++) {
        assert.ok(pass < 50, "background work must finish in bounded passes");
        await Promise.all(background.splice(0));
      }
      return response;
    } };

    const readTool = async (name, args = {}) => {
      const response = await mcp(c, name, args);
      assert.equal(response.status, 200, JSON.stringify(response.value));
      assert.equal(response.value.result?.isError, undefined, JSON.stringify(response.value));
      assert.ok(response.value.result?.structuredContent, name + " returns structured data");
      return response.value.result.structuredContent;
    };
    const before = await readTool("GetEstimationModelStatus");
    assert.equal(before.activeModel, null);
    assert.equal(before.eligibleSampleCount, 0);

    let firstId;
    for (let i = 0; i < 10; i++) {
      const planId = i === 0 ? PLAN : crypto.randomUUID();
      firstId ??= planId;
      const planned = await plannedAtlm(c, planId);
      await ok(c, "RecordAssessment", await atlmAssessment(c, planId, undefined, {
        predictionRequest: { method: "ATLM", methodVersion: 1 },
      }), 0);
      await completeAtlm(c, planned, 1000);
      c.advance(1); // Every new assessment follows the prior known outcome.
      if (i === 0 || i === 1) {
        const status = await readTool("GetEstimationModelStatus");
        assert.equal(status.eligibleSampleCount, i + 1);
        if(i===0)assert.equal(status.activeModel,null);
        else {assert.equal(status.activeModel.sampleCount,2);assert.equal(status.activeModel.accuracy,"EXPERIMENTAL");}
      }
    }

    const learned = await readTool("GetEstimationModelStatus");
    assert.equal(learned.eligibleSampleCount, 10);
    assert.ok(learned.activeModel, JSON.stringify(learned));
    assert.equal(learned.activeModel.sampleCount, 10, "fit uses accumulated history, not the latest pair");
    assert.ok(learned.activeModel.evaluation.caseCount >= 5);
    assert.ok(scheduled > 0, "normal tracker commands actually schedule background processing");

    const historical = await readTool("GetPlanEstimate", { planId: firstId });
    assert.equal(historical.serverEstimation.status, "UNAVAILABLE", "a completed plan is not retrospectively predicted");
    assert.equal(historical.serverEstimation.pointMs, null);

    const targetId = crypto.randomUUID();
    const target = await plannedAtlm(c, targetId);
    const assessment = await atlmAssessment(c, targetId, undefined, {
      predictionRequest: { method: "ATLM", methodVersion: 1 },
    });
    await ok(c, "RecordAssessment", assessment, 0);
    const issued = await readTool("GetPlanEstimate", { planId: targetId });
    assert.equal(issued.serverEstimation.status, "AVAILABLE");
    assert.equal(issued.serverEstimation.pointMs, 1000);
    assert.equal(issued.serverEstimation.modelId, learned.activeModel.modelId);
    assert.equal(issued.serverEstimation.interval, null);
    assert.equal(issued.serverEstimation.confidence, "UNKNOWN");
    const saved = await readTool("GetAssessment", { planId: targetId, assessmentId: assessment.assessmentId });
    assert.equal(saved.assessment.forecast.status, "UNKNOWN");
    assert.equal(saved.assessment.forecast.lowerMs, null);
    assert.equal(saved.assessment.forecast.upperMs, null);

    await completeAtlm(c, target, 2000);
    const after = await readTool("GetPlanEstimate", { planId: targetId });
    assert.deepEqual(after.serverEstimation, issued.serverEstimation, "execution retains the pre-start prediction exactly");
    const status = await readTool("GetEstimationModelStatus");
    assert.equal(status.eligibleSampleCount, 11);
    assert.equal(status.newPlansSinceTraining, 1);

    const http = await call(c, "/api/tracker/plans/" + targetId + "/estimate");
    assert.equal(http.status, 200);
    assert.deepEqual(http.value, after, "HTTP and MCP return the same saved forecast");
    assert.deepEqual(c.db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { c.close(); }
});

test("packaged public workflow learns all runtime effects and predicts omitted runtime",async()=>{
  const c=context();try{
    const built=await import(pathToFileURL(resolve(workerPath)).href+'?runtime-workflow');c.worker=built.createWorker(c.now);
    const taskFor=(modelId,reasoningEffort,plannedParallelAgents)=>({schemaVersion:'agent-task-v1',profile:{workKind:'MODIFY_MECHANISM',reuseState:'PARTIAL',doneBoundary:'LOCAL_VERIFIED'},outcomes:[{id:'change',description:'Change',evidence:'Fixture'}],changedContracts:[],verificationKinds:['UNIT'],profileEvidence:{workKind:'Change',reuseState:'Partial',doneBoundary:'Test'},runtimeContext:{modelId,reasoningEffort,plannedParallelAgents}});
    for(const model of ['a','b'])for(const effort of ['low','high'])for(const count of [1,2]){
      const p=await plannedAtlm(c,crypto.randomUUID(),taskFor(model,effort,count));
      await completeAtlm(c,p,60000*(10+(model==='b'?10:0)+(effort==='high'?6:0)+2*count));c.advance(1);
    }
    const trained=await mcp(c,'StartTraining');assert.equal(trained.value.result.isError,undefined,JSON.stringify(trained.value));
    const target=await plannedAtlm(c,crypto.randomUUID(),taskFor('b','high',2));
    const digest=(await mcp(c,'GetAssessment',{planId:target.planId})).value.result.structuredContent.currentRequirementsDigest;
    const known=await mcp(c,'EstimatePlanTime',{planId:target.planId,expectedRequirementsDigest:digest,agentTask:taskFor('b','high',2)});
    assert.equal(known.value.result.isError,undefined,JSON.stringify(known.value));assert.equal(known.value.result.structuredContent.pointMs,30*60000);
    const missing=taskFor(null,null,null);delete missing.runtimeContext;
    const unknown=await mcp(c,'EstimatePlanTime',{planId:target.planId,expectedRequirementsDigest:digest,agentTask:missing});
    assert.equal(unknown.value.result.isError,undefined,JSON.stringify(unknown.value));assert.equal(unknown.value.result.structuredContent.pointMs,21*60000);
    const saved=await atlmAssessment(c,target.planId,missing,{predictionRequest:{method:'ATLM',methodVersion:1}});
    await ok(c,'RecordAssessment',saved,0);
    const estimate=(await mcp(c,'GetSavedEstimate',{planId:target.planId})).value.result.structuredContent;
    assert.equal(estimate.serverEstimation.pointMs,21*60000);
    const artifact=JSON.parse(c.db.sqlite.prepare("SELECT artifact_json FROM estimation_models WHERE status='ACTIVE'").get().artifact_json);
    assert(artifact.columns.some(col=>col.field==='modelId'));assert(artifact.columns.some(col=>col.field==='reasoningEffort'));assert(artifact.columns.some(col=>col.kind==='runtimeNumeric'));
  }finally{c.close();}
});
