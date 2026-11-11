import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {context,running,ok,OWNER,PLAN} from './fixtures/tracker-db.mjs';
const modulePath=process.env.PLAYWRIGHT_MODULE||'playwright';
const {chromium}=await import(modulePath.startsWith('/')?pathToFileURL(modulePath).href:modulePath);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 for(const scenario of ['RUNNING','BLOCKED','FAILED','PAUSED']){
  const c=context();c.advance(Date.now()-c.now());const binding=await running(c);
  if(['BLOCKED','FAILED'].includes(scenario))await ok(c,'SetStepStatus',{...binding,status:scenario},2);
  if(scenario==='PAUSED')await ok(c,'PausePlan',{planId:PLAN},1);
  const before=c.db.sqlite.prepare('SELECT * FROM work_intervals').all(),page=await browser.newPage({viewport:{width:390,height:1000}}),errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{const r=route.request();assert.equal(new URL(r.url()).origin,'http://localhost');const body=r.postDataJSON();if(body?.commandType)writes.push(body);const response=await c.worker.fetch(new Request(r.url(),{method:r.method(),headers:{'content-type':'application/json','oai-authenticated-user-id':OWNER},...(r.postData()?{body:r.postData()}: {})}),{DB:c.db});await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});});
  try{
   await page.goto('http://localhost');await page.locator('#plans[data-loaded="true"]').waitFor({state:'attached'});await page.locator('[data-view="plans"]').click();await page.locator('#plans .plan-open').first().click();const card=page.locator('.tracker-card');await card.waitFor();
   assert.equal(await card.locator('.step-status-form').count(),scenario==='PAUSED'?0:1);assert.match(await card.innerText(),/Checked source/);assert(!/fence|lease|sha256:|попытк/i.test(await card.innerText()));assert.equal(await page.getByText('История статусов',{exact:true}).count(),0);assert.deepEqual(writes,[]);assert.deepEqual(c.db.sqlite.prepare('SELECT * FROM work_intervals').all(),before);assert.deepEqual(errors,[]);
  }finally{await page.close();c.close();}
 }
 console.log('Current status rendering passed for running, blocked, failed and paused plans without execution attempts.');
}finally{await browser.close();}
