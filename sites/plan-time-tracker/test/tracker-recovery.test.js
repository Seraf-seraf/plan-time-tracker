import test from "node:test";
import assert from "node:assert/strict";
import {context,running,ok,command,call,mcp,envelope,execution,rows,OWNER,PLAN,DIGEST_A,source} from "./fixtures/tracker-db.mjs";

test("historical retired receipts retain audit identity/outcome/time but no Git or private metadata through API and MCP",async()=>{
 const c=context();try{
  await running(c);
  for(const type of ["SyncRepository","AttachPlanRepository","ReviewCommitLink"]) for(const outcome of ["OK","PARTIAL","SOURCE_UNAVAILABLE","PENDING"]){
   const id=crypto.randomUUID(),raw=JSON.stringify({repositoryId:"private",fullName:"fixture/private-name",ref:"private-ref",url:"https://example.invalid/private",errorMessage:"private-name",nested:{full_name:"private-name",refs:["private-ref"]}});
   c.db.sqlite.prepare("INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,result_json,result_version,recorded_at) VALUES(?,?,?,?,?,0,100,?,'user','{}',?,?,3,200)").run(OWNER,id,"a".repeat(64),type,PLAN,OWNER,"OK",raw);
   c.db.sqlite.prepare("UPDATE command_receipts SET outcome_code=? WHERE command_id=?").run(outcome,id);
   const before=rows(c),api=(await call(c,"/api/tracker/commands/"+id)).value,rpc=(await mcp(c,"GetCommandReceipt",{commandId:id})).value.result.structuredContent;
   assert.deepEqual(api,rpc);assert.equal(api.commandId,id);assert.equal(api.commandType,type);
   assert.equal(api.serverNow,100);assert.equal(api.status,outcome==="PENDING"?"PENDING":"FINAL");
   assert.equal(api.historical,true);assert(!/private-name|private-ref|fullName|full_name|errorMessage|https:/.test(JSON.stringify(api)));
   if(outcome!=="PENDING"){assert.equal(api.outcomeCode,outcome);assert.equal(api.recordedAt,200);assert.equal(api.resultVersion,3);}
   assert.deepEqual(rows(c),before);assert.equal(c.db.sqlite.prepare("SELECT result_json FROM command_receipts WHERE command_id=?").get(id).result_json,raw);
   assert.equal((await call(c,"/api/tracker/commands/"+id,undefined,"other")).value.status,"NOT_FOUND");
  }
 }finally{c.close();}
});

test("closed RUNNING attempt is explicitly recoverable with a new fence and no interval/result/check mutation",async()=>{
 const c=context();try{
  const old=await running(c),closed=await ok(c,"CloseStepAttempt",{...old,disposition:"CLOSED",reason:"Executor stopped"});
  assert.equal(closed.status,"CLOSED");c.advance(1234);
  const before=rows(c),s=(await execution(c)).steps[0];
  assert.equal(s.status,"RUNNING");assert.equal(s.execution.state,"ATTEMPT_CLOSED");assert.equal(s.execution.canClaim,true);assert.equal(s.execution.canRecordResult,false);
  const input=envelope("ClaimStepAttempt",{stepId:old.stepId,sessionId:crypto.randomUUID(),sourceId:"recovery",recoveryReason:"Owner continued closed attempt"},2);
  const send=()=>call(c,"/api/commands",input);const first=await send(),again=await send();assert.equal(first.status,200);assert.equal(again.value.replayed,true);
  const next={stepId:old.stepId,attemptId:first.value.result.attemptId,fence:first.value.result.fence};assert(next.fence>old.fence);
  const pending=(await execution(c)).steps[0];assert.equal(pending.execution.state,"AWAITING_START");assert.equal(pending.execution.canStart,true);assert.equal(pending.execution.canRecordResult,false);
  const start=envelope("StartStep",next,2);assert.equal((await call(c,"/api/commands",start)).status,200);assert.equal((await call(c,"/api/commands",start)).value.replayed,true);
  assert.equal((await execution(c)).steps[0].execution.state,"RUNNING");
  assert.equal((await command(c,"RecordStepResult",{...old,outcome:"DONE",summary:"Stale result",sourceSnapshot:source()},3)).value.error.code,"ATTEMPT_CLOSED");
  assert.deepEqual(rows(c).work_intervals,before.work_intervals);assert.deepEqual(rows(c).step_results,before.step_results);assert.deepEqual(rows(c).step_source_checks,before.step_source_checks);
  assert.equal((await execution(c)).plan.activeMs,1234);
 }finally{c.close();}
});

test("server lease boundary, expired recovery and plan pause never revive a fence or change elapsed interval time",async()=>{
 const c=context();try{
  const old=await running(c),until=(await execution(c)).steps[0].attempts[0].lease_until;
  c.advance(until-c.now()-1);assert.equal((await execution(c)).steps[0].execution.state,"RUNNING");
  c.advance(1);const expired=(await execution(c)).steps[0];assert.equal(expired.execution.state,"LEASE_EXPIRED");assert.equal(expired.execution.canClaim,true);assert.equal(expired.execution.canRenew,false);
  assert.equal((await command(c,"RenewStepLease",old)).value.error.code,"LEASE_EXPIRED");
  await ok(c,"PausePlan",{planId:PLAN},1);const paused=await execution(c);assert.equal(paused.steps[0].execution.canClaim,false);
  const activeMs=paused.plan.activeMs;c.advance(10000);assert.equal((await execution(c)).plan.activeMs,activeMs);
  const denied=(await mcp(c,"ClaimStepAttempt",envelope("ClaimStepAttempt",{stepId:old.stepId,sessionId:crypto.randomUUID(),sourceId:"recovery"},2))).value.result;
  assert.equal(denied.isError,true);await ok(c,"ResumePlan",{planId:PLAN},2);
  const claim=await ok(c,"ClaimStepAttempt",{stepId:old.stepId,sessionId:crypto.randomUUID(),sourceId:"recovery",recoveryReason:"Expired lease"},2);
  assert(claim.fence>old.fence);assert.equal(c.db.sqlite.prepare("SELECT status FROM step_attempts WHERE attempt_id=?").get(old.attemptId).status,"ABANDONED");
  const next={stepId:old.stepId,attemptId:claim.attemptId,fence:claim.fence};await ok(c,"StartStep",next,2);
  const state=await execution(c);assert.equal(state.plan.activeMs,activeMs);assert.equal(state.steps[0].execution.canRecordResult,true);assert.equal(state.steps[0].readyToFinish,false);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_source_checks").get().n,0);
 }finally{c.close();}
});
