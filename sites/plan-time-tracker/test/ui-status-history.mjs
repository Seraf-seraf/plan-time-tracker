import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { context, OWNER, PLAN, running, ok } from './fixtures/tracker-db.mjs';
const modulePath=process.env.PLAYWRIGHT_MODULE||'playwright';
const {chromium}=await import(modulePath.startsWith('/')?pathToFileURL(modulePath).href:modulePath);
const c=context();c.advance(Date.now()-c.now());
if(process.env.SITE_WORKER_MODULE)c.worker=(await import(pathToFileURL(process.env.SITE_WORKER_MODULE).href)).createWorker(()=>c.now());
await running(c,[]);
for(let i=0;i<15;i++){c.advance(1);await ok(c,'UpdatePlanMetadata',{planId:PLAN,description:'History revision '+i,reason:'Pagination fixture'},i+1);}
// A valid imported legacy plan may have no journal or event records.
const other={planId:crypto.randomUUID()},imported={...c.db.sqlite.prepare('SELECT * FROM plans WHERE plan_id=?').get(PLAN),plan_id:other.planId,title:'Empty history plan',status:'PLANNED',first_started_at:null,finished_at:null,version:0};
c.db.sqlite.prepare('INSERT INTO plans('+Object.keys(imported).join(',')+') VALUES('+Object.keys(imported).map(()=>'?').join(',')+')').run(...Object.values(imported));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.setDefaultTimeout(10000);
const requests=[],errors=[];let failNext=false,holdNext=false,releaseHeld,heldStarted;
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());assert.equal(url.origin,'http://localhost');
  requests.push(url.pathname+url.search);
  if(url.pathname.endsWith('/status-history')&&failNext){failNext=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Test service unavailable'}})});}
  const response=await c.worker.fetch(new Request(req.url(),{method:req.method(),headers:{'content-type':'application/json','oai-authenticated-user-id':OWNER},...(req.postData()?{body:req.postData()}: {})}),{DB:c.db});
  if(url.pathname.endsWith('/status-history')&&holdNext){holdNext=false;heldStarted();await new Promise(resolve=>releaseHeld=resolve);}
  await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
});
const historyRequests=()=>requests.filter(p=>p.includes('/status-history')||p.includes('/timeline'));
const open=async id=>{await page.locator('[data-view="overview"]').click();await page.locator('[data-plan-id="'+id+'"] .plan-open').first().click();await page.getByRole('button',{name:'Показать историю статусов',exact:true}).waitFor();};
const history=()=>page.locator('.status-history');
const next=()=>history().getByRole('button',{name:'Следующая страница',exact:true});
const previous=()=>history().getByRole('button',{name:'Предыдущая страница',exact:true});
const ids=()=>history().locator('.timeline-card').evaluateAll(nodes=>nodes.map(n=>n.id));
try{
  await page.goto('http://localhost');await page.locator('#plans[data-loaded="true"]').waitFor({state:'attached'});
  await open(PLAN);await page.waitForLoadState('networkidle');
  assert.equal(historyRequests().length,0,'opening a plan must not fetch history');
  assert.equal(await page.getByText('История команд',{exact:true}).count(),0);
  assert(requests.filter(p=>p.startsWith('/api/plans/')).every(p=>p.endsWith('?includeEvents=false')),'detail requests must omit command events');
  failNext=true;await page.getByRole('button',{name:'Показать историю статусов',exact:true}).click();
  await history().getByRole('button',{name:'Повторить загрузку'}).waitFor();
  assert.equal(await history().locator('.timeline-card').count(),0);
  await history().getByRole('button',{name:'Повторить загрузку'}).click();
  await history().locator('.pager-page').getByText('1 / 3',{exact:true}).waitFor();
  assert.equal(await history().locator('.timeline-card').count(),8);
  const first=await ids(),count=historyRequests().length;
  assert.equal(await previous().isDisabled(),true);
  await next().click();await history().locator('.pager-page').getByText('2 / 3',{exact:true}).waitFor();
  const second=await ids();assert.equal(first.some(id=>second.includes(id)),false);
  await previous().click();assert.deepEqual(await ids(),first);
  assert.equal(historyRequests().length,count+1,'back navigation uses the cached page');
  await next().click();await next().click();await history().locator('.pager-page').getByText('3 / 3',{exact:true}).waitFor();
  assert.equal(await next().isDisabled(),true);assert((await ids()).length<=8);
  const totalBefore=await history().locator('.pager-summary').innerText();
  c.advance(1);await ok(c,'PausePlan',{planId:PLAN},16);
  await history().getByRole('button',{name:'Обновить историю',exact:true}).click();
  await history().locator('.pager-page').getByText('1 / 3',{exact:true}).waitFor();
  assert.notEqual(await history().locator('.pager-summary').innerText(),totalBefore);
  const loaded=historyRequests().length;
  await page.getByRole('button',{name:'Скрыть историю статусов',exact:true}).click();
  await page.getByRole('button',{name:'Показать историю статусов',exact:true}).click();
  assert.equal(historyRequests().length,loaded);
  const out=resolve(process.env.UI_ACCEPTANCE_ARTIFACT_DIR||'/workspace/work/history-qa');mkdirSync(out,{recursive:true});
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'overflow at '+width);
    const geometry=await history().locator('.pager').evaluate(node=>{const p=node.getBoundingClientRect(),c=node.querySelector('.pager-controls').getBoundingClientRect();return Math.abs((p.left+p.right-c.left-c.right)/2);});
    assert(geometry<1,'centered controls at '+width);
    if(width===390||width===1440)await history().screenshot({path:resolve(out,'history-'+width+'.png')});
  }
  await page.getByRole('button',{name:'Обновить состояние этапов',exact:true}).click();
  await page.getByRole('button',{name:'Показать историю статусов',exact:true}).waitFor();
  assert.equal(historyRequests().length,loaded,'checkpoint refresh does not reload history');
  holdNext=true;const started=new Promise(resolve=>heldStarted=resolve);
  await page.getByRole('button',{name:'Показать историю статусов',exact:true}).click();await started;
  await open(other.planId);releaseHeld();releaseHeld=null;await page.waitForLoadState('networkidle');
  assert.equal(await history().locator('.timeline-card').count(),0,'late response cannot populate another plan');
  await page.getByRole('button',{name:'Показать историю статусов',exact:true}).click();
  await history().getByText('История пока пуста.',{exact:true}).waitFor();
  assert.equal(await previous().isDisabled(),true);assert.equal(await next().isDisabled(),true);
  assert.deepEqual(errors,[]);
  console.log('Status history browser QA passed: lazy load, retries, stable pages, cache, refresh, stale responses, empty state, 320–1440px.');
}finally{releaseHeld?.();await browser.close();c.close();}
