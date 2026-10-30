import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { context, running, ok, OWNER, PLAN } from "./fixtures/tracker-db.mjs";
const modulePath=process.env.PLAYWRIGHT_MODULE||"playwright";
const {chromium}=await import(modulePath.startsWith("/")?pathToFileURL(modulePath).href:modulePath);
const replacement=process.env.RECOVERY_WORKER_MODULE?await import(pathToFileURL(process.env.RECOVERY_WORKER_MODULE).href):null;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||"/usr/bin/chromium",headless:true,args:["--no-sandbox"]});
const reports=[];
try{
 for(const scenario of ["CLOSED","ABANDONED","EXPIRED","ELAPSE","UNSTARTED","PAUSED_CLOSED"]){
  const c=context();c.advance(Date.now()-c.now());if(replacement)c.worker=replacement.createWorker(()=>c.now());
  const old=await running(c);let beforeIntervals=c.db.sqlite.prepare("SELECT * FROM work_intervals").all();
  if(["CLOSED","ABANDONED","UNSTARTED","PAUSED_CLOSED"].includes(scenario))await ok(c,"CloseStepAttempt",{...old,disposition:scenario==="ABANDONED"?"ABANDONED":"CLOSED",reason:"Executor stopped without a result"});
  if(scenario==="PAUSED_CLOSED"){await ok(c,"PausePlan",{planId:PLAN},1);c.advance(10000);}
  if(scenario==="EXPIRED")c.advance(600000);
  if(scenario==="UNSTARTED")await ok(c,"ClaimStepAttempt",{stepId:old.stepId,sessionId:crypto.randomUUID(),sourceId:"interrupted-claim"},2);
  const page=await browser.newPage({viewport:{width:390,height:1000}}),posts=[],errors=[];
  let loseClaim=scenario==="ABANDONED",loseStart=scenario==="CLOSED";
  page.setDefaultTimeout(5000);page.on("pageerror",e=>errors.push(e.message));
  await page.clock.install({time:new Date(c.now())});
  await page.clock.setSystemTime(new Date("2000-01-01T00:00:00Z")); // deliberate client/server wall-clock skew
  await page.route("**/*",async route=>{
   const req=route.request(),url=new URL(req.url());assert.equal(url.origin,"http://localhost","No external/production request");
   const body=req.postDataJSON();if(body)posts.push(body);
   const response=await c.worker.fetch(new Request(req.url(),{method:req.method(),headers:{"content-type":"application/json","oai-authenticated-user-id":OWNER},...(req.postData()?{body:req.postData()}: {})}),{DB:c.db});
   if(body?.commandType==="ClaimStepAttempt"&&loseClaim){loseClaim=false;return route.abort("failed");}
   if(body?.commandType==="StartStep"&&loseStart){loseStart=false;return route.abort("failed");}
   await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
  });
  try{
   await page.goto("http://localhost");await page.locator('#plans[data-loaded="true"]').waitFor({state:"attached"});
   await page.locator((scenario==="PAUSED_CLOSED"?'#recent':'#active')+' [data-plan-id="'+PLAN+'"] .plan-open').click();
   const card=page.locator('.tracker-card[data-step-id="'+old.stepId+'"]');await card.locator(".tracker-card-status").waitFor();
   if(scenario==="PAUSED_CLOSED"){
    assert.equal(await card.locator(".tracker-card-status").textContent(),"План на паузе");
    assert.equal(await card.getByRole("button",{name:"Начать новую попытку",exact:true}).count(),0);
    const closedInterval=c.db.sqlite.prepare("SELECT * FROM work_intervals").all()[0];
    await card.getByRole("button",{name:"Продолжить план",exact:true}).evaluate(node=>{node.click();node.click();});
    await page.waitForFunction(()=>document.querySelector(".tracker-card-status")?.textContent==="Нужна новая попытка");
    const intervals=c.db.sqlite.prepare("SELECT * FROM work_intervals ORDER BY start_ms").all();
    assert.equal(intervals.length,2);assert.deepEqual(intervals[0],closedInterval);assert.equal(intervals[1].start_ms,c.now());
    assert.equal(posts.filter(p=>p.commandType==="ResumePlan").length,1);
    beforeIntervals=intervals;
   }
   if(scenario==="ELAPSE"){
    assert.equal(await card.locator(".tracker-card-status").textContent(),"Выполняется");
    await card.getByLabel("Краткий результат",{exact:true}).fill("Draft before lease expiry");
    c.advance(600050);await page.clock.fastForward(600050);
    await page.waitForFunction(()=>document.querySelector(".tracker-card-status")?.textContent==="Срок попытки истёк");
    assert.equal(posts.length,0,"expiry refresh is read-only");
   }
   const expired=["EXPIRED","ELAPSE"].includes(scenario);
   assert.equal(await card.locator(".tracker-card-status").textContent(),expired?"Срок попытки истёк":scenario==="UNSTARTED"?"Попытка ожидает запуска":"Нужна новая попытка");
   assert.equal(await card.locator('[data-tracker-form^="result:"]').count(),0,"no result form for a closed/expired/unstarted attempt");
   const button=card.getByRole("button",{name:expired?"Начать новую попытку после истечения срока":scenario==="UNSTARTED"?"Запустить назначенную попытку":"Начать новую попытку",exact:true});
   await button.evaluate(node=>{node.click();node.click();});
   if(["CLOSED","ABANDONED"].includes(scenario)){
    await page.waitForFunction(()=>document.querySelector(".tracker-card-error")?.textContent.trim().length>0);
    await button.click();
   }
   await card.locator('[data-tracker-form^="result:"]').waitFor();
   assert.equal(await card.locator(".tracker-card-status").textContent(),"Выполняется");
   assert.equal(await card.getByRole("button",{name:"Начать новую попытку",exact:true}).count(),0);
   const attempts=c.db.sqlite.prepare("SELECT * FROM step_attempts ORDER BY fence").all();
   assert.equal(attempts.length,2);assert.equal(attempts[1].fence,old.fence+1);
   assert.equal(attempts[1].status,"OPEN");assert.notEqual(attempts[0].status,"OPEN");
   assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM tracker_journal WHERE event_type='STEP_STARTED'").get().n,2);
   const startPosts=posts.filter(p=>p.commandType==="StartStep"),claimPosts=posts.filter(p=>p.commandType==="ClaimStepAttempt");
   if(scenario==="CLOSED"){assert.equal(startPosts.length,2);assert.deepEqual(startPosts[0],startPosts[1]);assert.equal(claimPosts.length,1);}
   else if(scenario==="ABANDONED"){assert.equal(claimPosts.length,2);assert.deepEqual(claimPosts[0],claimPosts[1]);assert.equal(startPosts.length,1);}
   else{assert.equal(startPosts.length,1);assert.equal(claimPosts.length,scenario==="UNSTARTED"?0:1);}
   assert.deepEqual(c.db.sqlite.prepare("SELECT * FROM work_intervals").all(),beforeIntervals);
   assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_results").get().n,0);
   assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM step_source_checks").get().n,0);
   if(scenario==="ELAPSE")assert.equal(await card.getByLabel("Краткий результат",{exact:true}).inputValue(),"Draft before lease expiry");
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert.deepEqual(errors,[]);
   reports.push({scenario,passed:true,attempts:attempts.map(a=>({fence:a.fence,status:a.status})),posts:posts.map(p=>p.commandType),clientClockSkew:true,timerRowsUnchanged:true});
  }finally{await page.close();c.close();}
 }
}finally{await browser.close();}
const out=resolve(process.env.UI_ACCEPTANCE_ARTIFACT_DIR||"/tmp/tracker-recovery-browser","recovery");mkdirSync(out,{recursive:true});writeFileSync(resolve(out,"report.json"),JSON.stringify({passed:true,productionRequests:0,scenarios:reports},null,2));console.log(JSON.stringify({passed:true,productionRequests:0,scenarios:reports}));
