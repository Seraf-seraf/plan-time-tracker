import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fitAtlm, normalizeAgentTask } from '../worker/atlm/model.js';
import { processAtlmSampleRefresh } from '../worker/atlm/sample-refresh.js';
import { context, OWNER, PLAN, call, ok, mcp, plannedAtlm, completeAtlm, taskV4 } from './fixtures/tracker-db.mjs';

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(modulePath.startsWith('/') ? pathToFileURL(modulePath).href : modulePath);
const c = context();
c.advance(Date.now() - c.now());
if (process.env.SITE_WORKER_MODULE) c.worker = (await import(pathToFileURL(process.env.SITE_WORKER_MODULE).href)).createWorker(c.now);
const otherPlan = crypto.randomUUID();
const activeId = 'atlm-11-r2';
const priorId = 'atlm-11-r1';
const registeredId = 'atlm-11-r3';
const longId = 'atlm-' + 'archived-revision-'.repeat(6) + '7';
for (const planId of [PLAN, otherPlan]) {
  await ok(c, 'CreatePlan', { planId, title: 'Forecast planned', planText: '## Этап 1. Проверить\nГотово.',
    planCreatedAt: { precision: 'dateOnly', on: '2026-10-01', timeZone: 'UTC' } });
}
const initial = await call(c, '/api/tracker/model-revisions?view=list');
assert.equal(initial.status, 200);
assert.equal(initial.value.activeRevision, null);
assert.equal(initial.value.dataSummary.currentEligibleCount, 0);
const initialEstimate = await call(c, '/api/tracker/plans/' + PLAN + '/estimate');
assert.equal(initialEstimate.status, 200);
assert.equal(initialEstimate.value.serverEstimation.unavailableReason, 'ASSESSMENT_REQUIRED');

const artifacts = resolve(process.env.UI_ACCEPTANCE_ARTIFACT_DIR || '/tmp/tracker-atlm-ui');
mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(10000);
await page.clock.install({ time: c.now() });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const requests = [], errors = [];
let controlled = false, estimateError = false, estimate, holdPlan = null, heldStarted, releaseHeld, heldFinished;
let failRegistry = true, failRegistryPage = false, failCasesPage = false, holdModel = null;
page.on('pageerror', error => errors.push(error.message));
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
const unavailable = route => json(route, { error: { message: 'Fixture unavailable' } }, 503);
const estimateFor = id => ({ planId: id, source:'CURRENT_INPUT', isStale: false, serverEstimation: { formatVersion: 1, calculatedAt:c.now(), status: 'AVAILABLE', pointMs: id === PLAN ? 120000 : 420000, metric: 'PLAN_ACTIVE', forecastScope: 'FULL_FROM_FIRST_START', method: { id: 'atlm', version: 'agent-v4-probabilistic' }, sampleCount: 23, accuracy:'HISTORICALLY_EVALUATED', modelVersion: 'agent-v2/model-7', modelId: 'model-7', evaluation: { validationStatus:"HISTORICALLY_EVALUATED", caseCount: 6, pointCaseCount:6, maeMs: 30000 }, interval: {status:'AVAILABLE',lowerMs:60000,upperMs:600000,nominalCoverage:0.8,engine:'BAYESIAN_PREDICTIVE',calibrationSampleCount:0,validationStatus:'EXPERIMENTAL',unavailableReason:null} } });
await page.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  assert.equal(url.origin, 'http://localhost');
  requests.push({ path: url.pathname, method: request.method(), query: new URLSearchParams(url.search) });
  if (url.pathname.startsWith('/api/tracker/model-revisions')) {
    const view = url.searchParams.get('view');
    if (holdModel?.matches(url)) {
      const held = holdModel;
      holdModel = null;
      held.arrival.resolve();
      await held.release.promise;
    }
    if (view === 'list' && (failRegistry || (failRegistryPage && url.searchParams.has('cursor')))) return unavailable(route);
    if (url.pathname.endsWith('/evidence/cases') && failCasesPage && url.searchParams.has('cursor')) return unavailable(route);
    if (view === 'list' || url.pathname.endsWith('/evidence/cases')) url.searchParams.set('limit', '2');
  }
  const match = url.pathname.match(/^\/api\/tracker\/plans\/([^/]+)\/estimate$/);
  if (match && controlled) {
    const id = decodeURIComponent(match[1]);
    if (estimateError) return json(route, { error: { message: 'Estimate service unavailable' } }, 503);
    const response = structuredClone(estimate || estimateFor(id));
    if (holdPlan === id) {
      holdPlan = null;heldStarted();await new Promise(resolve => { releaseHeld = resolve; });
      await json(route, response);heldFinished();return;
    }
    return json(route, response);
  }

  const response = await c.worker.fetch(new Request(url, { method: request.method(), headers: {
    'content-type': 'application/json', 'oai-authenticated-user-id': OWNER,
  }, ...(request.postData() ? { body: request.postData() } : {}) }), { DB: c.db });
  await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
});

const forecast = () => page.locator('.atlm-plan-estimate');
const settings = page.locator('#atlm-model-overview');
const modelHeading = settings.getByRole('heading', { name: 'Модель прогноза', exact: true });
const qualityHeading = settings.getByRole('heading', { name: 'Качество', exact: true });
const navSettings = page.locator('[data-view="settings"]');
const history = settings.locator('#atlm-model-history');
const cases = settings.locator('#atlm-model-cases');
const current = settings.locator('#atlm-model-current');
const activeLabel = current.getByText('Выдаёт прогнозы', { exact: true });
const retry = settings.getByRole('button', { name: 'Повторить загрузку', exact: true });
const openSummary = (section, text) => section.locator('summary').filter({ hasText: text }).click();
const isFocused = locator => locator.evaluate(node => node === document.activeElement);
const hold = matches => {
  const gate = { matches, arrival: deferred(), release: deferred() };
  holdModel = gate;
  return gate;
};
const open = async id => {
  await page.locator('[data-view="overview"]').click();
  await page.locator('[data-plan-id="' + id + '"] .plan-open').first().click();
  await forecast().waitFor();
  await page.waitForFunction(id => document.querySelector('.atlm-plan-estimate')?.dataset.planId === id && !document.querySelector('.atlm-plan-estimate')?.hasAttribute('aria-busy'), id);
};
const refreshPlan = async () => { await forecast().getByRole('button', { name: 'Обновить прогноз', exact: true }).click();await page.waitForFunction(() => !document.querySelector('.atlm-plan-estimate')?.hasAttribute('aria-busy')); };

async function seedRegistry() {
  const training = [];
  const task = taskV4();
  const features = normalizeAgentTask(task).features;
  for (let index = 0; index < 61; index++) {
    const plan = await plannedAtlm(c, crypto.randomUUID(), task);
    const capturedAt = c.now();
    const actualMs = 60000 + (index % 3) * 60000;
    await completeAtlm(c, plan, actualMs);
    training.push({ planId: plan.planId, features, actualMs, capturedAt, sourceAvailableAt: c.now() });
    c.advance(1);
  }
  await processAtlmSampleRefresh(c.db, OWNER, c.now(), { clock: c.now });
  const sql = c.db.sqlite;
  const sequence = sql.prepare('SELECT max(sequence) AS sequence FROM estimation_samples WHERE owner_id=? AND plan_id=?');
  const examples = training.map(row => ({ ...row, sampleId: String(sequence.get(OWNER, row.planId).sequence) }));
  const fitted = await fitAtlm(examples);
  assert.equal(fitted.status, 'AVAILABLE', JSON.stringify(fitted));
  const artifact = fitted.artifact;
  const register = sql.prepare(`INSERT INTO estimation_model_revisions(owner_id,model_revision_id,model_version,origin,
    method_version,feature_version,registered_at,imported_at,artifact_json,manifest_json,dataset_digest,
    evaluation_json,provenance_json,fit_count,source_count,train_cutoff,supported)
    VALUES(?,?,11,'IMPORTED',?,?,?,?,?,?,?,?,'{}',?,?,?,?)`);
  const archive = (id, evaluation = null) => register.run(OWNER, id, artifact.method.version, artifact.featureSchemaVersion, c.now(),
    c.now(), null, '[]', null, evaluation ? JSON.stringify(evaluation) : null, 0, 0, null, 0);
  const controlMode = (prediction, grouped = true) => ({
    status: 'AVAILABLE', summary: {
      rowCount: 1, ...(grouped ? { groupCount: 1 } : {}), excludedFromScoringCount: 0,
      forecastAvailability: { numerator: 1, denominator: 1 },
      intervalAvailability: { numerator: 0, denominator: 1 },
      metrics: { maeMs: prediction - 60000 },
    },
    cases: [{ planId: examples[0].planId, actualMs: 60000, pointMs: prediction }],
  });
  archive(priorId, { schemaVersion: 1, modes: {
    INTERNAL_HOLDOUT_PLANNED: controlMode(90000),
    INTERNAL_HOLDOUT_ACTUAL: controlMode(150000),
    ISSUED_FORECASTS: controlMode(60000),
  } });
  c.advance(1);
  archive(longId);
  c.advance(1);
  const evaluation = { protocol: 'Grouped rolling-origin', unit: 'minutes',
    all: { cases: 50, groups: 19, revisedMAE: 84.08, own: 50 }, cases: [] };
  register.run(OWNER, activeId, artifact.method.version, artifact.featureSchemaVersion, c.now(), c.now(),
    JSON.stringify(artifact), JSON.stringify(artifact.manifest), artifact.datasetDigest, JSON.stringify(evaluation),
    artifact.n, examples.length, artifact.trainCutoff, 1);
  const source = sql.prepare(`INSERT INTO estimation_model_revision_sources(owner_id,model_revision_id,plan_id,source_generation,ordinal)
    SELECT owner_id,?,plan_id,generation,? FROM estimation_jobs WHERE owner_id=? AND plan_id=?`);
  for (const [index, example] of examples.entries()) source.run(activeId, index, OWNER, example.planId);
  c.advance(1000);
  const activation = await mcp(c, 'ActivateModelRevision', { schemaVersion: 1, commandId: crypto.randomUUID(),
    modelRevisionId: activeId, expectedActiveModelRevisionId: null, expectedActivationVersion: 0,
    acceptExperimental: true, reason: 'Изолированная браузерная проверка' });
  assert.equal(activation.value.result.structuredContent?.activeModelRevisionId, activeId, JSON.stringify(activation.value));
  c.advance(1);
  const perPlanEvaluation = { schemaVersion: 1, protocolVersion: 2, modes: {
    ROLLING_PLAN_PLANNED: { ...controlMode(120000, false), paired: {
      rowIds: ['first'], candidate: { maeMs: 60000 }, median: { maeMs: 120000 },
    } },
    ROLLING_PLAN_ACTUAL: controlMode(180000, false),
    ISSUED_FORECASTS: controlMode(60000, false),
  } };
  register.run(OWNER, registeredId, artifact.method.version, artifact.featureSchemaVersion, c.now(), c.now(),
    JSON.stringify(artifact), JSON.stringify(artifact.manifest), artifact.datasetDigest, JSON.stringify(perPlanEvaluation),
    artifact.n, examples.length, artifact.trainCutoff, 1);
  for (const [index, example] of examples.entries()) source.run(registeredId, index, OWNER, example.planId);
  for (let index = 0; index < 14; index++) {
    const plan = await plannedAtlm(c, crypto.randomUUID(), task);
    await completeAtlm(c, plan, 60000 + (index % 5) * 60000);
    c.advance(1);
  }
  await processAtlmSampleRefresh(c.db, OWNER, c.now(), { clock: c.now });
  const detail = (await call(c, '/api/tracker/model-revisions?view=detail&modelRevisionId=' + activeId)).value;
  assert.equal(detail.revision.fitCount, 61);
  assert.equal(detail.evidence[0].summary.rowCount, 14);
  return examples[0].planId;
}

try {
  const response = await page.goto('http://localhost');
  assert.match(await response.text(), /Для загрузки сведений о модели требуется JavaScript/);
  await page.locator('#plans[data-loaded="true"]').waitFor({ state: 'attached' });
  await open(PLAN);
  assert.match(await forecast().innerText(), /До первого запуска не сохранены исходные признаки/);
  assert.equal(requests.filter(item => item.path.endsWith('/status-history') || item.path.endsWith('/timeline')).length, 0);
  assert.equal(await page.getByText('История команд', { exact: true }).count(), 0);

  const first = hold(url => url.searchParams.get('view') === 'list');
  await navSettings.click();
  await first.arrival.promise;
  await modelHeading.waitFor();
  await settings.getByRole('status').filter({ hasText: 'Загружаем модель прогноза…' }).waitFor();
  assert.ok(await settings.locator('[aria-busy="true"]').count() || await settings.getAttribute('aria-busy') === 'true');
  first.release.resolve();
  await settings.getByText('Не удалось загрузить сведения о модели', { exact: true }).waitFor();
  failRegistry = false;
  await retry.focus();
  await page.keyboard.press('Enter');
  await current.getByText('Модель для новых прогнозов пока не назначена', { exact: true }).waitFor();
  assert.equal(await isFocused(modelHeading), true);
  await openSummary(history, 'История ревизий');
  await history.getByText('Ревизий пока нет', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(artifacts, 'atlm-cold-start.png'), fullPage: true });
  await openSummary(history, 'История ревизий');

  controlled = true;
  await open(PLAN);
  await forecast().getByText('Около 2 мин', { exact: true }).waitFor();
  assert.match(await forecast().innerText(), /Диапазон:/);
  assert.match(await forecast().innerText(), /цель 80%/);
  const refresh = forecast().getByRole('button', { name: 'Обновить прогноз', exact: true });
  await refresh.focus();assert.equal(await refresh.evaluate(node => node === document.activeElement), true);
  const keyboardRequest = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/' + PLAN + '/estimate'));
  await page.keyboard.press('Enter');await keyboardRequest;
  await page.waitForFunction(() => !document.querySelector('.atlm-plan-estimate')?.hasAttribute('aria-busy'));

  for(const engine of ['RIDGE','OLS']){
    estimate=estimateFor(PLAN);estimate.serverEstimation.method={id:'atlm',version:'agent-v3-hybrid'};
    estimate.serverEstimation.hybrid={policyVersion:1,selectedEngine:'OLS',usedEngine:engine,fallbackReason:engine==='RIDGE'?'INVALID_PREDICTION':null};
    estimate.serverEstimation.evaluation={validationStatus:"HISTORICALLY_EVALUATED",pointCaseCount:20,metricsScope:'FULL_POLICY',caseCount:20,modelCaseCount:15,
      maeMs:60000,medianBaselineMaeMs:120000,profileGroupCount:6};
    await refreshPlan();const text=await forecast().innerText();
    assert(text.includes(engine==='RIDGE'?'ATLM — ridge':'ATLM — обычная регрессия'));
    assert.match(text,/Диапазон:/);
    for(const width of [320,1440]){
      await page.setViewportSize({width,height:1100});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:resolve(artifacts,'atlm-hybrid-'+engine.toLowerCase()+'-'+width+'.png'),fullPage:true});
    }
  }
  for(const k of [0,1,4]) {
    estimate=estimateFor(PLAN);estimate.serverEstimation.accuracy='EXPERIMENTAL';estimate.serverEstimation.sampleCount=k+1;
    estimate.serverEstimation.evaluation={validationStatus:"EXPERIMENTAL",pointCaseCount:k,caseCount:k,maeMs:k?0:null};
    await refreshPlan();const text=await forecast().innerText();
    assert.match(text,/Экспериментальный/);assert.match(text,/Диапазон:/);
    if(k===0){await page.setViewportSize({width:320,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:resolve(artifacts,'atlm-experimental-320.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});}

  }
  estimate=estimateFor(PLAN);estimate.serverEstimation={...estimate.serverEstimation,method:{id:'historical-median',version:'1'},pointMs:300000,modelId:null,modelVersion:null,sampleCount:7,accuracy:'HISTORICAL_BASELINE',evaluation:null,fallback:{atlmUnavailableReason:'COLLECTING_DATA',atlmDiagnostics:{code:'INSUFFICIENT_DATA',message:'Недостаточно данных: sampleCount=7, p=9.'}}};
  await refreshPlan();let baselineText=await forecast().innerText();
  assert.match(baselineText,/Около 5 мин/);assert.match(baselineText,/Ранний ориентир по истории/);assert.match(baselineText,/Учтено завершённых планов: 7/);
  assert.match(baselineText,/особенности новой задачи не учитываются/);assert.match(baselineText,/Пока недостаточно пригодных данных/);
  assert.doesNotMatch(baselineText,/Проверено прогнозов|Средняя ошибка|Качество проверено/);
  estimate.source='CURRENT_INPUT';estimate.recordedEstimation={pointMs:60000,sampleCount:2};
  estimate.serverEstimation.pointMs=360000;estimate.serverEstimation.sampleCount=8;
  estimate.serverEstimation.calculatedAt=c.now();await refreshPlan();baselineText=await forecast().innerText();
  assert.match(baselineText,/Около 6 мин/);assert.match(baselineText,/Учтено завершённых планов: 8/);
  assert.match(baselineText,/Рассчитано:/);
  assert.doesNotMatch(baselineText,/Кнопка перечитывает|сохранённая медиана показана|Около 1 мин/);

  estimate.serverEstimation.pointMs=0;await refreshPlan();assert.match(await forecast().innerText(),/Около 0 мин/);
  estimate.isStale=true;estimate.staleReasons=['BASELINE_SOURCE_CHANGED'];await refreshPlan();
  assert.doesNotMatch(await forecast().innerText(),/История завершённых планов изменилась/);
  estimate.source='FROZEN_INPUT';await refreshPlan();
  assert.match(await forecast().innerText(),/История завершённых планов изменилась/);
  assert.doesNotMatch(await forecast().innerText(),/изменился объём задачи или исходные данные модели/);


  estimate=estimateFor(PLAN);await refreshPlan();assert.match(await forecast().innerText(),/Экспериментальный/);

  estimate = { planId: PLAN, isStale: false, serverEstimation: { status: 'UNAVAILABLE', unavailableReason: 'INCOMPLETE_FEATURES', pointMs: null } };
  await refreshPlan();assert.match(await forecast().innerText(), /не хватает исходных сведений/);assert.equal(await forecast().locator('.atlm-point').count(), 0);
  estimate={planId:PLAN,isStale:false,serverEstimation:{status:'UNAVAILABLE',unavailableReason:'COLLECTING_DATA',pointMs:null},diagnostics:{code:'INSUFFICIENT_DATA',message:'Недостаточно данных: sampleCount=5, p=8, residualDegreesOfFreedom=-3.'}};
  await refreshPlan();assert.match(await forecast().innerText(),/Пока недостаточно пригодных данных/);
  estimate = { ...estimateFor(PLAN), source:'FROZEN_INPUT', isStale: true };await refreshPlan();assert.match(await forecast().innerText(), /Оценка устарела/);assert.match(await forecast().innerText(), /Около 2 мин/);
  estimateError = true;await refreshPlan();assert.match(await forecast().innerText(), /Не удалось загрузить прогноз/);assert.equal(await forecast().locator('.atlm-point').count(), 0);
  estimateError = false;estimate = null;await refreshPlan();assert.match(await forecast().innerText(), /Около 2 мин/);
  estimate = estimateFor(otherPlan);await refreshPlan();assert.match(await forecast().innerText(), /Ответ относится к другому плану/);estimate = null;

  estimate = { planId: PLAN, isStale: false };await refreshPlan();assert.match(await forecast().innerText(), /Сервер вернул неполную оценку/);assert.doesNotMatch(await forecast().innerText(), /Исходная оценка до запуска не сохранена/);estimate = null;

  // The authoritative response can be newer than the plan card rendered in this tab.
  for(const availability of [{planStatus:'COMPLETED',deleted:false},{planStatus:'PLANNED',deleted:true}]){
    estimate={...estimateFor(PLAN),forecastAvailability:{...availability,canRefreshSaved:false,canCalculate:false}};
    await refreshPlan();assert.equal(await forecast().count(),availability.deleted?0:1);
    estimate=null;await open(PLAN);
  }

  estimate={planId:PLAN,source:'FROZEN_INPUT',isStale:false,
    serverEstimation:{status:'UNAVAILABLE',pointMs:null,unavailableReason:'MISSING_FEATURES'},
    forecastAvailability:{planStatus:'RUNNING',deleted:false,canRefreshSaved:false,canCalculate:false}};
  await refreshPlan();assert.equal(await forecast().getByRole('button',{name:'Обновить прогноз',exact:true}).count(),0);
  assert.match(await forecast().innerText(),/Исходная оценка зафиксирована при первом запуске/);
  assert.doesNotMatch(await forecast().innerText(),/Агент может дополнить исходные сведения до первого запуска/);
  estimate=null;await open(PLAN);

  // Release the old response only after a different plan has rendered its own forecast.
  const started = new Promise(resolve => { heldStarted = resolve; });
  const finished = new Promise(resolve => { heldFinished = resolve; });holdPlan = PLAN;
  await forecast().getByRole('button', { name: 'Обновить прогноз', exact: true }).click();await started;
  await open(otherPlan);assert.match(await forecast().innerText(), /Около 7 мин/);
  releaseHeld();releaseHeld = null;await finished;
  assert.equal(await forecast().getAttribute('data-plan-id'), otherPlan);assert.match(await forecast().innerText(), /Около 7 мин/);assert.doesNotMatch(await forecast().innerText(), /Около 2 мин/);

  const changedPlan = await seedRegistry();
  const modelRequests = () => requests.filter(item => item.path.startsWith('/api/tracker/model-revisions'));
  const caseRequests = () => modelRequests().filter(item => item.path.endsWith('/evidence/cases'));
  await navSettings.click();
  await activeLabel.waitFor();
  await settings.getByText('Планов 14', { exact: true }).waitFor();
  assert.match(await current.innerText(), /atlm-11-r2/);
  assert.match(await current.innerText(), /Назначенная ревизия/);
  assert.equal(await current.locator('time[datetime]').count(), 1);
  const data = settings.locator('#atlm-model-data');
  assert.match(await data.innerText(), /В обучении\s+61/);
  assert.match(await data.innerText(), /Новые пригодные\s+14/);
  assert.match(await data.innerText(), /Изменились после обучения\s+0/);
  assert.equal(await caseRequests().length, 0, 'the case table loads only on demand');
  assert.equal(await history.evaluate(node => node.open), false);
  assert.equal(await cases.evaluate(node => node.open), false);
  const coverage = settings.locator('.model-quality-grid').filter({ hasText: 'Попадания в интервал' }).first();
  assert.match(await coverage.innerText(), /Попадания в интервал\s+[\d]+ из [\d]+\s+Средняя ширина/);
  const methodology = settings.locator('#atlm-model-metrics');
  await methodology.locator('summary').click();
  await methodology.getByText(/прогнозы выбранной ревизии/).waitFor();
  await methodology.locator('summary').click();
  writeFileSync(resolve(artifacts, 'model-overview.html'), await page.content());
  await page.screenshot({ path: resolve(artifacts, 'model-overview-1440.png'), fullPage: true });

  const reportPicker = settings.getByLabel('Отчёт проверки');
  const issued = settings.getByRole('radio', { name: 'Выданные прогнозы' });
  const control = settings.getByRole('radio', { name: 'Контрольная проверка' });
  await issued.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await control.isChecked(), true);
  assert.equal(await isFocused(control), true);
  await settings.getByRole('heading', { name: 'Проверка на истории' }).waitFor();
  assert.match(await settings.locator('#atlm-model-report').innerText(), /50, групп 19/);
  assert.match(await settings.locator('#atlm-model-report').innerText(), /84,1 мин/);
  await settings.locator('#atlm-model-report').getByText('Список задач этой проверки не сохранён.', { exact: true }).waitFor();
  await issued.check();

  const staleCases = hold(url => url.pathname.endsWith('/evidence/cases'));
  await settings.getByRole('button', { name: 'Показать планы', exact: true }).click();
  await staleCases.arrival.promise;
  assert.equal(await isFocused(cases.locator('summary')), true);
  await control.check();
  staleCases.release.resolve();
  await cases.getByText('Список задач этой проверки не сохранён.', { exact: true }).waitFor();
  assert.equal(await cases.getByRole('table').count(), 0);
  await issued.check();
  await cases.getByRole('table').waitFor();
  assert.equal(await cases.getByRole('rowheader').count(), 2);
  failCasesPage = true;
  await cases.getByRole('button', { name: 'Показать ещё планы' }).click();
  await cases.getByText('Не удалось загрузить планы.', { exact: true }).waitFor();
  assert.equal(await cases.getByRole('rowheader').count(), 2);
  const failedCursor = caseRequests().at(-1).query.get('cursor');
  failCasesPage = false;
  const caseRetry = cases.getByRole('button', { name: 'Повторить', exact: true });
  await caseRetry.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#atlm-model-cases tbody tr').length === 4);
  assert.equal(caseRequests().at(-1).query.get('cursor'), failedCursor);
  assert.equal(await isFocused(cases.locator('summary')), true);

  await history.locator('summary').focus();
  await page.keyboard.press('Space');
  await history.getByRole('table').waitFor();
  const registered = history.getByRole('row').filter({ hasText: registeredId });
  await registered.getByText('Не назначена', { exact: true }).waitFor();
  const moreRevisions = history.getByRole('button', { name: 'Показать ещё ревизии' });
  failRegistryPage = true;
  await moreRevisions.click();
  await history.getByText('Не удалось загрузить ревизии.', { exact: true }).waitFor();
  assert.equal(await history.getByRole('rowheader').count(), 2);
  failRegistryPage = false;
  const historyRetry = history.getByRole('button', { name: 'Повторить', exact: true });
  await historyRetry.focus();
  await page.keyboard.press('Enter');
  await history.getByRole('button', { name: 'Показать ' + priorId, exact: true }).waitFor();
  const archived = history.getByRole('row').filter({ hasText: longId });
  await archived.getByText('Недоступна', { exact: true }).waitFor();
  await archived.getByText('Формат артефакта не поддерживается.', { exact: true }).waitFor();
  assert.equal(await isFocused(history.locator('summary')), true);

  for (const width of [1440, 768, 720, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    const layout = await settings.evaluate(panel => ({
      panel: panel.getBoundingClientRect().width,
      grid: panel.parentElement.getBoundingClientRect().width,
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      panelOverflow: panel.scrollWidth > panel.clientWidth,
    }));
    assert.ok(layout.panel >= layout.grid - 2, 'model occupies the settings grid at ' + width);
    assert.equal(layout.pageOverflow || layout.panelOverflow, false, 'no horizontal overflow at ' + width);
    assert.match(await history.getByRole('table').ariaSnapshot(), /columnheader.*Ревизия/);
    assert.match(await cases.getByRole('table').ariaSnapshot(), /columnheader.*Интервал/);
    assert.equal(await history.getByRole('rowheader').filter({ hasText: longId }).count(), 1);
    if (width <= 390) assert.ok(await history.locator('summary').evaluate(node => node.getBoundingClientRect().height >= 44));
    await page.screenshot({ path: resolve(artifacts, 'model-overview-tables-' + width + '.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => { document.body.style.zoom = ''; });

  const moreCases = cases.getByRole('button', { name: 'Показать ещё планы' });
  for (let count = 6; count <= 14; count += 2) {
    await moreCases.click();
    await page.waitForFunction(expected => document.querySelectorAll('#atlm-model-cases tbody tr').length === expected, count);
  }
  assert.equal(await isFocused(moreCases), true);
  assert.equal(await moreCases.getAttribute('aria-disabled'), 'true');
  await settings.getByRole('status').filter({ hasText: 'Все планы загружены' }).waitFor();
  await page.keyboard.press('Tab');
  await moreCases.waitFor({ state: 'hidden' });

  await navSettings.click();
  await settings.getByText('Планов 14', { exact: true }).waitFor();
  await moreRevisions.click();
  await history.getByRole('button', { name: 'Показать ' + priorId, exact: true }).waitFor();
  assert.equal(await isFocused(moreRevisions), true);
  assert.equal(await moreRevisions.getAttribute('aria-disabled'), 'true');
  await settings.getByRole('status').filter({ hasText: 'Все ревизии загружены' }).waitFor();
  await page.keyboard.press('Tab');
  await moreRevisions.waitFor({ state: 'hidden' });

  const waiting = hold(url => url.searchParams.get('view') === 'detail' && url.searchParams.get('modelRevisionId') === priorId);
  const prior = history.getByRole('button', { name: 'Показать ' + priorId, exact: true });
  await prior.focus();
  await page.keyboard.press('Enter');
  await waiting.arrival.promise;
  assert.equal(await isFocused(qualityHeading), true);
  await settings.getByRole('button', { name: 'Вернуться к назначенной ревизии' }).click();
  await settings.getByText('Планов 14', { exact: true }).waitFor();
  waiting.release.resolve();
  await prior.click();
  await control.check();
  await settings.getByRole('heading', { name: 'Проверка на отложенных планах по исходным признакам' }).waitFor();
  assert.match(await reportPicker.locator('option:checked').textContent(), /по исходным признакам/);
  await cases.getByRole('table').waitFor();
  assert.match(await cases.getByRole('table').innerText(), /1,5 мин/);
  const holdoutReportTitle = 'Проверка на отложенной выборке';
  const savedForecastsTitle = 'Выданные прогнозы в сохранённом отчёте';
  await reportPicker.focus();
  await reportPicker.selectOption({ label: holdoutReportTitle });
  await cases.getByText('2,5 мин', { exact: true }).waitFor();
  assert.equal(await isFocused(reportPicker), true);
  assert.match(await current.innerText(), /atlm-11-r2/);
  const quality = settings.getByRole('region', { name: 'Качество' });
  const mobileWidthsCssPx = [320, 360, 375, 390];
  const desktopWidthCssPx = 1440;
  const minTouchHeightCssPx = 44;
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  for (const title of [holdoutReportTitle, savedForecastsTitle]) {
    if (title === savedForecastsTitle) await reportPicker.press('End');
    await quality.getByRole('heading', { name: title, exact: true }).waitFor();
    for (const width of [...mobileWidthsCssPx, desktopWidthCssPx]) {
      await page.setViewportSize({ width, height: 1100 });
      const layout = await reportPicker.evaluate(picker => {
        const field = picker.getBoundingClientRect();
        const section = picker.closest('section').getBoundingClientRect();
        const panel = picker.closest('.atlm-model-overview').getBoundingClientRect();
        const style = getComputedStyle(picker);
        const outline = parseFloat(style.outlineWidth);
        const focusOutset = outline + parseFloat(style.outlineOffset);
        return {
          fitsSection: field.left >= section.left && field.right <= section.right,
          focusVisible: picker.matches(':focus-visible') && style.outlineStyle !== 'none' && outline > 0,
          focusFitsPanel: field.left - focusOutset >= panel.left && field.right + focusOutset <= panel.right,
          height: field.height,
        };
      });
      assert.ok(layout.fitsSection, 'report picker fits the quality section at ' + width + ' CSS px');
      assert.ok(layout.focusVisible && layout.focusFitsPanel, 'picker focus stays visible at ' + width + ' CSS px');
      if (mobileWidthsCssPx.includes(width)) {
        assert.ok(layout.height >= minTouchHeightCssPx, 'report picker has a mobile touch target at ' + width + ' CSS px');
      }
      if (title === savedForecastsTitle && (width === 375 || width === desktopWidthCssPx)) {
        await quality.screenshot({ path: resolve(artifacts, 'model-quality-' + width + '.png') });
      }
    }
  }
  await methodology.locator('summary').click();
  await methodology.getByText(/историческая медиана/).waitFor();
  await methodology.locator('summary').click();
  await reportPicker.selectOption({ label: 'Проверка на отложенной выборке' });

  failRegistry = true;
  await navSettings.click();
  await settings.getByText('Обновить сведения не удалось', { exact: true }).waitFor();
  await settings.getByText('Показаны данные от', { exact: false }).waitFor();
  await current.getByText('Выдавала прогнозы', { exact: true }).waitFor();
  assert.equal(await activeLabel.count(), 0, 'stale content does not claim current serving');
  failRegistry = false;
  await retry.click();
  await activeLabel.waitFor();
  await settings.getByRole('heading', { name: 'Проверка на отложенной выборке' }).waitFor();
  assert.equal(await history.evaluate(node => node.open), true);
  assert.equal(await cases.evaluate(node => node.open), true);

  await history.getByRole('button', { name: 'Показать ' + registeredId, exact: true }).click();
  await control.check();
  await quality.getByText('Планов в финальном обучении 61', { exact: true }).waitFor();
  const plannedReportTitle = 'Проверка на истории по исходным признакам';
  const actualReportTitle = 'Проверка на истории по фактическим признакам';
  await quality.getByRole('heading', { name: plannedReportTitle, exact: true }).waitFor();
  const report = settings.locator('#atlm-model-report');
  assert.match(await report.innerText(), /Планов 1\n/);
  assert.doesNotMatch(await report.innerText(), /групп/u);
  assert.match(await report.innerText(), /Средняя абсолютная ошибка медианы\s+2 мин/u);
  await page.setViewportSize({ width: 375, height: 1100 });
  await quality.screenshot({ path: resolve(artifacts, 'model-per-plan-quality-375.png') });
  await page.setViewportSize({ width: desktopWidthCssPx, height: 1100 });
  await reportPicker.selectOption({ label: actualReportTitle });
  await report.getByRole('heading', { name: actualReportTitle, exact: true }).waitFor();
  await methodology.locator('summary').click();
  await methodology.getByText(/доступные до его первого старта/u).waitFor();
  await methodology.locator('summary').click();
  await reportPicker.selectOption({ label: savedForecastsTitle });
  await report.getByRole('heading', { name: savedForecastsTitle, exact: true }).waitFor();
  await settings.getByRole('button', { name: 'Вернуться к назначенной ревизии' }).click();
  await control.check();
  await quality.getByRole('heading', { name: 'Проверка на истории', exact: true }).waitFor();

  await ok(c, 'DeletePlan', { planId: changedPlan }, 2);
  await moreRevisions.click();
  await current.getByText('Недоступна', { exact: true }).waitFor();
  await current.getByText('Изменились исходные наблюдения.', { exact: true }).waitFor();
  await current.getByText(activeId, { exact: true }).waitFor();
  assert.equal(await settings.getByText('Выдаёт прогнозы', { exact: true }).count(), 0);
  assert.equal(await settings.getByText('Накопление опыта', { exact: true }).count(), 0);
  assert.ok(modelRequests().every(request => request.method === 'GET'));
  const legacyPath = /^\/api\/tracker\/(atlm-dataset|estimation-model|estimation-training-history)(\/|$)/;
  assert.equal(requests.some(item => legacyPath.test(item.path)), false);
  assert.deepEqual(errors, []);
  console.log('Forecasts and read-only model overview: browser checks passed.');
} finally {
  releaseHeld?.();
  holdModel?.release.resolve();
  await browser.close();
  c.close();
}
