import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {context,OWNER,plannedAtlm,completeAtlm,mcp,ok} from './fixtures/tracker-db.mjs';
const modulePath=process.env.PLAYWRIGHT_MODULE||'playwright';
const {chromium}=await import(modulePath.startsWith('/')?pathToFileURL(modulePath).href:modulePath);
const c=context();c.advance(Date.now()-c.now());
for(let i=0;i<2;i++){const p=await plannedAtlm(c,crypto.randomUUID());await completeAtlm(c,p,60000+i*10000);c.advance(1);}
await mcp(c,'ContinueTraining');
const target=await plannedAtlm(c,crypto.randomUUID());await completeAtlm(c,target,80000);c.advance(1);await mcp(c,'ContinueTraining');
const dir=resolve(process.env.UI_ACCEPTANCE_ARTIFACT_DIR||'/tmp/tracker-atlm-v4/ui');mkdirSync(dir,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];let datasetOverride=null,historyFailure=false,datasetFailure=false,taskFailure=false,planFailure=false,planReads=0;page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());assert.equal(url.origin,'http://localhost');if(url.pathname==='/api/plans/'+target.planId&&planFailure&&++planReads>1)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Fixture unavailable'}})});if(url.pathname==='/api/tracker/assessment'&&taskFailure)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Fixture unavailable'}})});if((url.pathname==='/api/tracker/atlm-dataset'&&datasetFailure)||(url.pathname==='/api/tracker/estimation-training-history'&&historyFailure))return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Fixture unavailable'}})});if(url.pathname==='/api/plans'&&datasetOverride)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({plans:datasetOverride.rows.map(row=>({planId:row.planId,title:row.planId,finishedAt:c.now()})),nextCursor:null,serverNow:c.now()})});if(url.pathname==='/api/tracker/atlm-dataset'&&datasetOverride)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(datasetOverride)});const r=await c.worker.fetch(new Request(req.url(),{method:req.method(),headers:{'content-type':'application/json','oai-authenticated-user-id':OWNER},...(req.postData()?{body:req.postData()}:{})}),{DB:c.db});await route.fulfill({status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()});});
try{
 await page.goto('http://localhost');await page.locator('#plans[data-loaded="true"]').waitFor({state:'attached'});
 await page.locator('[data-plan-id="'+target.planId+'"] .plan-open').first().click();
 const forecast=page.locator('.atlm-plan-estimate');await forecast.waitFor();await page.waitForFunction(()=>!document.querySelector('.atlm-plan-estimate')?.hasAttribute('aria-busy'));
 const txt=await forecast.innerText();assert.match(txt,/Около/);assert.match(txt,/Диапазон:/);assert.match(txt,/цель 80%/);assert.match(txt,/Зафиксировано при запуске/);assert.match(txt,/Факт:/);
 assert.equal(await forecast.locator('.atlm-scale').getAttribute('aria-hidden'),'true');await forecast.getByText('Признаки',{exact:true}).click();assert.match(await forecast.innerText(),/Результаты/);
 const features=forecast.locator('.atlm-features');
 const featureValue=label=>features.locator('dt').filter({has:page.getByText(label,{exact:true})}).locator('xpath=following-sibling::dd[1]');
 assert.match(await featureValue('Готовность рабочей среды').innerText(),/^Готова$/);
 assert.match(await featureValue('Среда выполнения').innerText(),/^Облачная рабочая среда$/);
 assert.match(await featureValue('Развёртывание').innerText(),/^Развёртывание не требуется$/);
 assert.match(await featureValue('Технологии для изучения').innerText(),/Неизвестно[\s\S]*Not yet established/);
 assert.doesNotMatch(await features.innerText(),/environmentId:|modelId:|AI_AGENT/);
 await page.setViewportSize({width:320,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:resolve(dir,'features-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});
 taskFailure=true;await page.locator('[data-view="overview"]').click();await page.locator('[data-plan-id="'+target.planId+'"] .plan-open').first().click();await forecast.waitFor();await page.waitForFunction(()=>!document.querySelector('.atlm-plan-estimate')?.hasAttribute('aria-busy'));
 await forecast.getByText('Признаки',{exact:true}).click();assert.match(await forecast.innerText(),/Не удалось загрузить признаки/);assert.match(await forecast.innerText(),/Около/);
 taskFailure=false;await forecast.getByRole('button',{name:'Повторить загрузку признаков'}).click();await page.waitForFunction(()=>!document.querySelector('.atlm-plan-estimate')?.hasAttribute('aria-busy'));
 planFailure=true;planReads=0;await page.locator('[data-view="overview"]').click();await page.locator('[data-plan-id="'+target.planId+'"] .plan-open').first().click();await forecast.waitFor();await page.waitForFunction(()=>!document.querySelector('.atlm-plan-estimate')?.hasAttribute('aria-busy'));
 assert.match(await forecast.innerText(),/Не удалось загрузить факт/);assert.match(await forecast.innerText(),/Около/);
 planFailure=false;await forecast.getByRole('button',{name:'Повторить загрузку факта'}).click();await page.waitForFunction(()=>!document.querySelector('.atlm-plan-estimate')?.hasAttribute('aria-busy'));assert.match(await forecast.innerText(),/Факт:/);

 for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:resolve(dir,'forecast-'+width+'.png'),fullPage:true});}
 await page.locator('[data-view="settings"]').click();await page.getByText('Попытки обучения',{exact:true}).waitFor();await page.locator('.atlm-attempts table').waitFor();assert.match(await page.locator('.atlm-attempts').innerText(),/Точка/);
 for(const width of [320,390,768,1440]){
  await page.setViewportSize({width,height:1000});
  const layout=await page.locator('#atlm-model-status').evaluate(panel=>{
   const grid=panel.parentElement.getBoundingClientRect(),box=panel.getBoundingClientRect(),table=panel.querySelector('.atlm-attempts table');
   return {width:box.width,gridWidth:grid.width,pageOverflow:document.documentElement.scrollWidth>innerWidth,
    headLines:[...table.querySelectorAll('th')].map(th=>{const range=document.createRange();range.selectNodeContents(th);return [...range.getClientRects()].filter(r=>r.width&&r.height).length;}),
    mobileLabels:[...table.querySelectorAll('.atlm-cell-label')].filter(label=>getComputedStyle(label).display!=='none').length};
  });
  assert.equal(layout.pageOverflow,false,`history overflows page at ${width}`);
  assert.ok(layout.width>=layout.gridWidth-2,`history should use available settings width at ${width}`);
  if(width<=600)assert.ok(layout.mobileLabels>=6,`each mobile cell needs a visible label at ${width}`);
  else assert.ok(layout.headLines.every(lines=>lines<=1),`table headings must remain on one line at ${width}`);
  await page.screenshot({path:resolve(dir,'attempts-'+width+'.png'),fullPage:true});
 }
 await page.locator('.atlm-attempts summary').first().focus();await page.keyboard.press('Enter');
 assert.equal(await page.locator('.atlm-attempts details').first().evaluate(node=>node.open),true);

 historyFailure=true;await page.locator('[data-view="settings"]').click();await page.getByRole('button',{name:'Повторить загрузку истории'}).waitFor();historyFailure=false;await page.getByRole('button',{name:'Повторить загрузку истории'}).click();await page.locator('.atlm-attempts table').waitFor();
 await page.locator('[data-view="analytics"]').click();await page.locator('.atlm-analytics table').waitFor();const analytics=await page.locator('.atlm-analytics').innerText();assert.match(analytics,/Попадания в диапазон/);assert.match(analytics,/Прогноз/);assert.match(analytics,/Факт/);
 datasetFailure=true;await page.locator('[data-view="analytics"]').click();await page.getByRole('button',{name:'Повторить загрузку качества'}).waitFor();datasetFailure=false;await page.getByRole('button',{name:'Повторить загрузку качества'}).click();await page.locator('.atlm-analytics table').waitFor();
 await page.locator('.atlm-metrics-help summary').focus();await page.keyboard.press('Enter');assert.match(await page.locator('.atlm-metrics-help').innerText(),/не является гарантией/);
 for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:resolve(dir,'analytics-'+width+'.png'),fullPage:true});}
 await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>{document.body.style.zoom='2';});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.evaluate(()=>{document.body.style.zoom='';});
 datasetOverride={rows:Array.from({length:12},(_,i)=>({planId:'sample-'+i,eligibility:'ELIGIBLE',actualMs:0,sourceAvailableAt:c.now(),issuedPrediction:i<6?{pointMs:0,interval:i<3?{status:'AVAILABLE',lowerMs:0,upperMs:1}:{status:'UNAVAILABLE',lowerMs:null,upperMs:null}}:null})),nextCursor:null};
 await page.locator('#apply').click();await page.waitForFunction(()=>document.querySelector('.atlm-analytics')?.innerText.includes('6 / 12'));
 let synthetic=await page.locator('.atlm-analytics').innerText();assert.match(synthetic,/3 \/ 3/);assert.match(synthetic,/WAPE\s+—/);
 await page.locator('.atlm-analytics').getByRole('button',{name:'Далее'}).click();assert.match(await page.locator('.atlm-analytics').innerText(),/Страница 2 из 2/);
 assert.deepEqual(errors,[]);console.log('Forecast intervals, frozen result, model history and analytics: browser checks passed.');
}finally{await browser.close();c.close();}


// A start racing the current forecast must display the authoritative frozen result.
{
 const c=context();c.advance(Date.now()-c.now());
 for(let i=0;i<2;i++){const p=await plannedAtlm(c,crypto.randomUUID());await completeAtlm(c,p,1000);c.advance(1);}await mcp(c,'ContinueTraining');
 const p=await plannedAtlm(c,crypto.randomUUID());let unblock,arrived,block=true;const reached=new Promise(r=>arrived=r);
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']}),page=await browser.newPage();
 await page.route('**/*',async route=>{const req=route.request(),response=await c.worker.fetch(new Request(req.url(),{method:req.method(),headers:{'oai-authenticated-user-id':OWNER,'content-type':'application/json'},...(req.postData()?{body:req.postData()}:{})}),{DB:c.db}),body=await response.text();
  if(req.url().includes('/'+p.planId+'/estimate')&&block){block=false;arrived();await new Promise(r=>unblock=r);}await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body});});
 try{await page.goto('http://localhost');await page.locator('#plans[data-loaded="true"]').waitFor({state:'attached'});await page.locator('[data-plan-id="'+p.planId+'"] .plan-open').first().click();
  await reached;await ok(c,'StartPlan',{planId:p.planId},0);unblock();const panel=page.locator('.atlm-plan-estimate');await panel.waitFor();await page.waitForFunction(()=>!document.querySelector('.atlm-plan-estimate')?.hasAttribute('aria-busy'));
  assert.match(await panel.innerText(),/Зафиксировано при запуске/);assert.equal(await panel.getByRole('button',{name:'Обновить прогноз'}).count(),0);
 }finally{unblock?.();await browser.close();c.close();}
}

// Restoring a finished plan cannot move its result to the restoration date.
{
 const c=context();c.advance(Date.parse('2026-11-12T12:00:00Z')-c.now());const p=await plannedAtlm(c,crypto.randomUUID());await completeAtlm(c,p,60000);await mcp(c,'ContinueTraining');c.advance(2*86400000);
 await ok(c,'DeletePlan',{planId:p.planId},2);await ok(c,'RestorePlan',{planId:p.planId},3);await mcp(c,'ContinueTraining');
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']}),page=await browser.newPage();await page.clock.install({time:c.now()});
 await page.route('**/*',async route=>{const req=route.request(),r=await c.worker.fetch(new Request(req.url(),{method:req.method(),headers:{'oai-authenticated-user-id':OWNER,'content-type':'application/json'},...(req.postData()?{body:req.postData()}:{})}),{DB:c.db});await route.fulfill({status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()});});
 try{await page.goto('http://localhost');await page.locator('[data-view="analytics"]').click();await page.locator('#from').fill('2026-11-12');await page.locator('#to').fill('2026-11-12');await page.locator('#apply').click();await page.locator('.atlm-analytics table').waitFor();assert.match(await page.locator('.atlm-analytics').innerText(),/ATLM synthetic feature/);
  await page.locator('#from').fill('2026-11-14');await page.locator('#to').fill('2026-11-14');await page.locator('#apply').click();await page.locator('.atlm-analytics').getByText('Нет наблюдений за выбранный период.').waitFor();
 }finally{await browser.close();c.close();}
}
