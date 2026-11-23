import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fitAtlm, normalizeAgentTask } from '../worker/atlm/model.js';
import { processAtlmSampleRefresh } from '../worker/atlm/sample-refresh.js';
import { goldenBoundary, goldenCases } from './fixtures/atlm-v4-golden.mjs';
import { taskV4, context, OWNER, plannedAtlm, completeAtlm, mcp, ok, call } from './fixtures/tracker-db.mjs';

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(modulePath.startsWith('/') ? pathToFileURL(modulePath).href : modulePath);
const drain = c => processAtlmSampleRefresh(c.db, OWNER, c.now(), { clock: c.now });
const revisionId = 'atlm-intervals-fixture-r1';
const browserOptions = { executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] };
async function installFixtureRevision(c) {
  const examples = [], task = taskV4(), features = normalizeAgentTask(task).features;
  const sql = c.db.sqlite;
  const sample = sql.prepare('SELECT max(sequence) AS sequence FROM estimation_samples WHERE owner_id=? AND plan_id=?');
  for (let index = 0; index < 10; index++) {
    const plan = await plannedAtlm(c, crypto.randomUUID(), task);
    const actualMs = 60000 + index * 1000, capturedAt = c.now();
    await completeAtlm(c, plan, actualMs);
    await drain(c);
    examples.push({ planId: plan.planId, sampleId: String(sample.get(OWNER, plan.planId).sequence), features,
      actualMs, capturedAt, sourceAvailableAt: c.now() });
    c.advance(1);
  }
  const fitted = await fitAtlm(examples);
  assert.equal(fitted.status, 'AVAILABLE', JSON.stringify(fitted));
  const artifact = fitted.artifact;
  sql.prepare(`INSERT INTO estimation_model_revisions(owner_id,model_revision_id,model_version,origin,
    method_version,feature_version,registered_at,imported_at,artifact_json,manifest_json,dataset_digest,
    provenance_json,fit_count,source_count,train_cutoff,supported)
    VALUES(?,?,1,'IMPORTED',?,?,?,?,?,?,?,'{}',?,?,?,1)`).run(OWNER, revisionId, artifact.method.version,
    artifact.featureSchemaVersion, c.now(), c.now(), JSON.stringify(artifact), JSON.stringify(artifact.manifest),
    artifact.datasetDigest, artifact.n, examples.length, artifact.trainCutoff);
  const source = sql.prepare(`INSERT INTO estimation_model_revision_sources(owner_id,model_revision_id,plan_id,source_generation,ordinal)
    SELECT owner_id,?,plan_id,generation,? FROM estimation_jobs WHERE owner_id=? AND plan_id=?`);
  for (const [index, example] of examples.entries()) source.run(revisionId, index, OWNER, example.planId);
  const activation = await mcp(c, 'ActivateModelRevision', { schemaVersion: 1, commandId: crypto.randomUUID(),
    modelRevisionId: revisionId, expectedActiveModelRevisionId: null, expectedActivationVersion: 0,
    reason: 'Изолированная проверка интервалов', acceptExperimental: true });
  assert.equal(activation.value.result.structuredContent?.activeModelRevisionId, revisionId, JSON.stringify(activation.value));
}

const c = context();
c.advance(Date.now() - c.now());
await installFixtureRevision(c);
const mixed = taskV4();
mixed.systemBoundaries = goldenBoundary(goldenCases[0]);
delete mixed.evidence.systemBoundaries;
const target = await plannedAtlm(c, crypto.randomUUID(), mixed);
await completeAtlm(c, target, 80000);
await drain(c);

const dir = resolve(process.env.UI_ACCEPTANCE_ARTIFACT_DIR || '/tmp/tracker-atlm-v4/ui');
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch(browserOptions);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [], issuedRequests = [], paths = [];
page.on('pageerror', error => errors.push(error.message));
let analyticsFailure = false, cursorFailure = false, taskFailure = false, planFailure = false, planReads = 0;
const unavailable = route => route.fulfill({ status: 503, contentType: 'application/json',
  json: { error: { message: 'Fixture unavailable' } } });
await page.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  assert.equal(url.origin, 'http://localhost');
  paths.push(url.pathname);
  if (url.pathname === '/api/plans/' + target.planId && planFailure && ++planReads > 1) return unavailable(route);
  if (url.pathname === '/api/tracker/assessment' && taskFailure) return unavailable(route);
  if (url.pathname === '/api/tracker/model-revisions' && url.searchParams.get('view') === 'issued-history') {
    issuedRequests.push({ query: new URLSearchParams(url.search), method: request.method() });
    if (analyticsFailure || (cursorFailure && url.searchParams.has('cursor'))) return unavailable(route);
  }
  const response = await c.worker.fetch(new Request(url, { method: request.method(), headers: {
    'content-type': 'application/json', 'oai-authenticated-user-id': OWNER,
  }, ...(request.postData() ? { body: request.postData() } : {}) }), { DB: c.db });
  await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
});

try {
 await page.goto('http://localhost');await page.locator('#plans[data-loaded="true"]').waitFor({state:'attached'});
 await page.locator('[data-plan-id="'+target.planId+'"] .plan-open').first().click();
 const forecast=page.locator('.atlm-plan-estimate');await forecast.waitFor();await page.waitForFunction(()=>!document.querySelector('.atlm-plan-estimate')?.hasAttribute('aria-busy'));
 const txt=await forecast.innerText();assert.match(txt,/Около/);assert.match(txt,/Диапазон:/);assert.match(txt,/цель 80%/);assert.match(txt,/Зафиксировано при запуске/);assert.match(txt,/Факт:/);
 assert.match(txt,/READ: 9, WRITE: 1, доля WRITE: 10/);
 assert.equal(await forecast.locator('.atlm-scale').getAttribute('aria-hidden'),'true');await forecast.getByText('Признаки',{exact:true}).click();assert.match(await forecast.innerText(),/Результаты/);
 const features=forecast.locator('.atlm-features');
 const featureValue=label=>features.locator('dt').filter({has:page.getByText(label,{exact:true})}).locator('xpath=following-sibling::dd[1]');
 assert.match(await featureValue('Готовность рабочей среды').innerText(),/^Готова$/);
 assert.match(await featureValue('Среда выполнения').innerText(),/^Облачная рабочая среда$/);
 assert.match(await featureValue('Развёртывание').innerText(),/^Развёртывание не требуется$/);
 assert.match(await featureValue('Технологии для изучения').innerText(),/Технологий для изучения нет/);
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

  await page.locator('[data-view="analytics"]').click();
  const quality = page.locator('.atlm-analytics');
  await quality.getByRole('heading', { name: 'Выданные прогнозы всех версий за выбранный период' }).waitFor();
  const table = quality.getByRole('table');
  await table.waitFor();
  assert.match(await quality.innerText(), /Попадания в интервал/);
  assert.match(await quality.innerText(), /Средняя ширина/);
  assert.match(await table.innerText(), /Медиана прошлых задач/);
  assert.match(await table.innerText(), /atlm-intervals-fixture-r1/);
  assert.equal(await table.getByRole('rowheader').count(), 10);
  const server = await call(c, '/api/tracker/model-revisions?' + issuedRequests[0].query);
  assert.equal(server.status, 200);
  assert.equal(server.value.summary.rowCount, 11);
  const point = server.value.summary.forecastAvailability;
  assert.match(await quality.innerText(), new RegExp('Прогнозы\\s+' + point.numerator + ' / 11'));
  const initialMetrics = await quality.locator('.atlm-metrics').innerText();

  cursorFailure = true;
  const more = quality.getByRole('button', { name: 'Показать ещё планы' });
  await more.click();
  const retry = quality.getByRole('button', { name: 'Повторить загрузку качества' });
  await retry.waitFor();
  assert.equal(await table.getByRole('rowheader').count(), 10);
  const firstAttempt = issuedRequests.at(-1).query.toString();
  cursorFailure = false;
  await retry.click();
  await table.getByRole('rowheader').nth(10).waitFor();
  assert.equal(issuedRequests.at(-1).query.toString(), firstAttempt);
  assert.equal(await quality.locator('.atlm-metrics').innerText(), initialMetrics);
  assert.match(await table.innerText(), /Нет оценки/);

  analyticsFailure = true;
  await page.locator('#apply').click();
  await retry.waitFor();
  analyticsFailure = false;
  await retry.click();
  await table.waitFor();
  await quality.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.match(await quality.locator('.atlm-metrics-help').innerText(), /не является гарантией/);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: resolve(dir, 'analytics-' + width + '.png'), fullPage: true });
  }
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => { document.body.style.zoom = ''; });

  await page.locator('[data-view="settings"]').click();
  await page.locator('#tz').selectOption('Europe/Moscow');
  await page.locator('#settings button').click();
  await page.getByText('Часовой пояс сохранён.', { exact: true }).waitFor();
  const zonedReport = page.waitForRequest(request => {
    const query = new URL(request.url()).searchParams;
    return query.get('view') === 'issued-history' && query.get('timeZone') === 'Europe/Moscow';
  });
  await page.locator('[data-view="analytics"]').click();
  await zonedReport;
  assert.equal(issuedRequests.at(-1).query.get('timeZone'), 'Europe/Moscow');
  assert.equal(issuedRequests.at(-1).query.get('from'), await page.locator('#from').inputValue());
  assert.equal(issuedRequests.at(-1).query.get('to'), await page.locator('#to').inputValue());
  assert.ok(issuedRequests.every(request => request.method === 'GET'));
  assert.equal(paths.includes('/api/tracker/atlm-dataset'), false);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  c.close();
}

// A start racing the current forecast must display the authoritative frozen result.
{
 const c=context();c.advance(Date.now()-c.now());
 for(let i=0;i<2;i++){const p=await plannedAtlm(c,crypto.randomUUID());await completeAtlm(c,p,1000);c.advance(1);}await drain(c);
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
 const c=context();c.advance(Date.parse('2026-11-12T12:00:00Z')-c.now());const p=await plannedAtlm(c,crypto.randomUUID());await completeAtlm(c,p,60000);await drain(c);c.advance(2*86400000);
 await ok(c,'DeletePlan',{planId:p.planId},2);await ok(c,'RestorePlan',{planId:p.planId},3);await drain(c);
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']}),page=await browser.newPage();await page.clock.install({time:c.now()});
 await page.route('**/*',async route=>{const req=route.request(),r=await c.worker.fetch(new Request(req.url(),{method:req.method(),headers:{'oai-authenticated-user-id':OWNER,'content-type':'application/json'},...(req.postData()?{body:req.postData()}:{})}),{DB:c.db});await route.fulfill({status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()});});
 try{await page.goto('http://localhost');await page.locator('[data-view="analytics"]').click();await page.locator('#from').fill('2026-11-12');await page.locator('#to').fill('2026-11-12');await page.locator('#apply').click();await page.locator('.atlm-analytics table').waitFor();assert.match(await page.locator('.atlm-analytics').innerText(),/ATLM synthetic feature/);
  await page.locator('#from').fill('2026-11-14');await page.locator('#to').fill('2026-11-14');await page.locator('#apply').click();await page.locator('.atlm-analytics').getByText('Нет наблюдений за выбранный период.').waitFor();
 }finally{await browser.close();c.close();}
}

console.log('Forecast intervals, first-start freeze and issued history: browser checks passed.');
