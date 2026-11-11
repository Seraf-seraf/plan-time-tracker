import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {context,running,ok,OWNER} from './fixtures/tracker-db.mjs';
const modulePath=process.env.PLAYWRIGHT_MODULE||'playwright';
const {chromium}=await import(modulePath.startsWith('/')?pathToFileURL(modulePath).href:modulePath);
const c=context();c.advance(Date.now()-c.now()-86400000*2);
for(const duration of [180000,0,120000]){const id=crypto.randomUUID(),step=await running(c,[],id);c.advance(duration);await ok(c,'SetStepStatus',{...step,status:'DONE'},2);await ok(c,'FinishPlan',{planId:id},1);c.advance(1);}
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],requests=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',async route=>{const r=route.request();assert.equal(new URL(r.url()).origin,'http://localhost');requests.push(r.url());const response=await c.worker.fetch(new Request(r.url(),{method:r.method(),headers:{'content-type':'application/json','oai-authenticated-user-id':OWNER},...(r.postData()?{body:r.postData()}: {})}),{DB:c.db});await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});});
try{
 await page.goto('http://localhost');await page.locator('#plans[data-loaded="true"]').waitFor({state:'attached'});await page.locator('[data-view="analytics"]').click();await page.locator('#stats .metric').first().waitFor();
 assert.equal(await page.locator('#stats .metric strong').nth(0).innerText(),'5 мин');assert.equal(await page.locator('#stats .metric strong').nth(1).innerText(),'3');assert.match(await page.locator('#stats .metric strong').nth(2).innerText(),/^2 мин/);assert.equal(await page.locator('#analyticPlans .row').count(),3);assert((await page.locator('#chart .barrow').count())>0);
 for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'overflow at '+width);}
 assert(!requests.some(url=>/status-history|timeline|\/analytics\/plans\//.test(url)));assert.deepEqual(errors,[]);console.log('Plan analytics browser QA passed: unchanged total, median, day bars and plan list, without execution history requests.');
}finally{await browser.close();c.close();}
