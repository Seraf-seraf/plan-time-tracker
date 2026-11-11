// Real cold-start integration, followed by controlled model responses for UI state and race coverage.
// All traffic stays in an isolated SQLite-backed Worker; no production samples are created.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { context, OWNER, PLAN, running, call } from './fixtures/tracker-db.mjs';

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(modulePath.startsWith('/') ? pathToFileURL(modulePath).href : modulePath);
const c = context();c.advance(Date.now() - c.now());
if (process.env.SITE_WORKER_MODULE) c.worker = (await import(pathToFileURL(process.env.SITE_WORKER_MODULE).href)).createWorker(() => c.now());
await running(c, []);
const otherPlan = crypto.randomUUID();await running(c, [], otherPlan);
const capabilities = await call(c, '/api/tracker/capabilities');
assert.equal(capabilities.status, 200);assert(capabilities.value.assessments.atlm, 'the delivered Worker must advertise ATLM');
const initial = await call(c, '/api/tracker/estimation-model');
assert.equal(initial.status, 200);assert.equal(initial.value.eligibleSampleCount, 0);
assert.equal(initial.value.activeModel, null);assert.equal(initial.value.training.due, true, 'first starts queue source refresh even without a usable ATLM input');
const initialEstimate = await call(c, '/api/tracker/plans/' + PLAN + '/estimate');
assert.equal(initialEstimate.status, 200);assert.equal(initialEstimate.value.planId, PLAN);
assert.equal(initialEstimate.value.serverEstimation, null, 'a legacy started plan gets no retrospective estimate');

const artifacts = resolve(process.env.UI_ACCEPTANCE_ARTIFACT_DIR || '/tmp/tracker-atlm-ui');
mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(10000);await page.clock.install({ time: c.now() });
const requests = [], errors = [];let controlled = false, statusError = false, estimateError = false, processError = false;
let status = structuredClone(initial.value), estimate, holdPlan = null, heldStarted, releaseHeld, heldFinished;
let processCount = 0, statusCount = 0, advancingQueue = false;
page.on('pageerror', error => errors.push(error.message));
const json = (route, value, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(value) });
const estimateFor = id => ({ planId: id, isStale: false, serverEstimation: { formatVersion: 1, status: 'AVAILABLE', pointMs: id === PLAN ? 120000 : 420000, metric: 'PLAN_ACTIVE', forecastScope: 'FULL_FROM_FIRST_START', method: { id: 'atlm', version: 'agent-v1' }, modelVersion: 'agent-v1/model-7', modelId: 'model-7', evaluation: { caseCount: 6, maeMs: 30000 }, interval: null, confidence: 'UNKNOWN' } });
const modelState = (trainingStatus, due = false) => ({ ...structuredClone(initial.value), datasetRevision: 7, newPlansSinceTraining: 3, eligibleSampleCount: 23, excludedSampleCount: 2, retrainEveryNewPlans: 5, exclusionReasons: [{ reason: 'MISSING_FEATURES', count: 2 }], activeModel: { modelId: 'model-7', modelVersion: 'agent-v1/model-7', sampleCount: 23 }, training: { status: trainingStatus, due, generation: 4, progressRevision: 0, pendingRefreshCount: 0, nextAttemptAt: null, progress: null }, lastError: null, lastReason: null });
await page.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());assert.equal(url.origin, 'http://localhost', 'production traffic is forbidden');
  requests.push({ path: url.pathname, method: request.method(), body: request.postData() });
  if (url.pathname === '/api/tracker/estimation-model') {
    statusCount++;
    if (controlled) return statusError ? json(route, { error: { message: 'Status service unavailable' } }, 503) : json(route, status);
  }
  if (url.pathname === '/api/tracker/estimation-model/process' && controlled) {
    assert.equal(request.method(), 'POST');assert.deepEqual(request.postDataJSON(), {});processCount++;
    if (processError) return json(route, { error: { message: 'Training service unavailable' } }, 503);
    if (advancingQueue) status.training.progressRevision++;
    return json(route, { processed: true });
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
  const response = await c.worker.fetch(new Request(request.url(), { method: request.method(), headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': OWNER }, ...(request.postData() ? { body: request.postData() } : {}) }), { DB: c.db });
  await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
});
const forecast = () => page.locator('.atlm-plan-estimate');
const settings = () => page.locator('#atlm-model-status');
const open = async id => {
  await page.locator('[data-view="overview"]').click();
  await page.locator('[data-plan-id="' + id + '"] .plan-open').first().click();
  await forecast().getByRole('button', { name: 'Обновить прогноз', exact: true }).waitFor();
  await page.waitForFunction(id => document.querySelector('.atlm-plan-estimate')?.dataset.planId === id && !document.querySelector('.atlm-plan-estimate')?.hasAttribute('aria-busy'), id);
};
const refreshPlan = async () => { await forecast().getByRole('button', { name: 'Обновить прогноз', exact: true }).click();await page.waitForFunction(() => !document.querySelector('.atlm-plan-estimate')?.hasAttribute('aria-busy')); };
const refreshStatus = async () => { await settings().getByRole('button', { name: 'Обновить состояние обучения', exact: true }).click();await page.waitForFunction(() => !document.querySelector('#atlm-model-status')?.hasAttribute('aria-busy')); };
const readPoll = async () => {
  const before = statusCount;await page.clock.runFor(800);
  // Fetch callbacks run in Node, outside Playwright's controlled browser clock.
  const deadline = Date.now() + 10000;while (statusCount === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert(statusCount > before, 'the bounded status poll must run');
  await page.waitForFunction(() => !document.querySelector('#atlm-model-status')?.hasAttribute('aria-busy'));
};
try {
  await page.goto('http://localhost');await page.locator('#plans[data-loaded="true"]').waitFor({ state: 'attached' });
  await open(PLAN);
  assert.match(await forecast().innerText(), /Исходная оценка до запуска не сохранена/);
  assert.equal(requests.filter(item => item.path.endsWith('/status-history') || item.path.endsWith('/timeline')).length, 0, 'forecast loading preserves lazy status history');
  assert.equal(await page.getByText('История команд', { exact: true }).count(), 0);
  await page.locator('[data-view="settings"]').click();await settings().getByText('Всего пригодных планов: 0. Исключено: 2.', { exact: true }).waitFor();
  const recovered = await call(c, '/api/tracker/estimation-model');assert.equal(recovered.status, 200);
  assert.equal(recovered.value.training.due, false);assert.equal(recovered.value.activeModel, null);
  assert(requests.some(item => item.path === '/api/tracker/estimation-model/process' && item.method === 'POST'), 'opening the real UI must recover pending source refresh');
  await settings().getByText('Почему планы не учитываются', { exact: true }).click();
  assert.match(await settings().locator('details').innerText(), /До первого запуска не сохранены исходные признаки/);
  await refreshStatus();assert.equal(await settings().locator('details').evaluate(node => node.open), true, 'status reads preserve the open explanation');
  await page.screenshot({ path: resolve(artifacts, 'atlm-cold-start.png'), fullPage: true });

  controlled = true;status = modelState('COLLECTING_DATA');await open(PLAN);
  await forecast().getByText('Около 2 мин', { exact: true }).waitFor();
  assert.match(await forecast().innerText(), /Полное активное время от первого запуска/);
  assert.match(await forecast().innerText(), /Средняя ошибка прошлых проверок/);
  assert.match(await forecast().innerText(), /не гарантия длительности/);
  const refresh = forecast().getByRole('button', { name: 'Обновить прогноз', exact: true });
  await refresh.focus();assert.equal(await refresh.evaluate(node => node === document.activeElement), true);
  const keyboardRequest = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/' + PLAN + '/estimate'));
  await page.keyboard.press('Enter');await keyboardRequest;
  await page.waitForFunction(() => !document.querySelector('.atlm-plan-estimate')?.hasAttribute('aria-busy'));

  estimate = { planId: PLAN, isStale: false, serverEstimation: { status: 'UNAVAILABLE', unavailableReason: 'INCOMPLETE_FEATURES', pointMs: null } };
  await refreshPlan();assert.match(await forecast().innerText(), /не хватает исходных сведений/);assert.equal(await forecast().locator('.atlm-point').count(), 0);
  estimate = { ...estimateFor(PLAN), isStale: true };await refreshPlan();assert.match(await forecast().innerText(), /Оценка устарела/);assert.match(await forecast().innerText(), /Около 2 мин/);
  estimateError = true;await refreshPlan();assert.match(await forecast().innerText(), /Не удалось загрузить прогноз/);assert.equal(await forecast().locator('.atlm-point').count(), 0);
  estimateError = false;estimate = null;await refreshPlan();assert.match(await forecast().innerText(), /Около 2 мин/);
  estimate = estimateFor(otherPlan);await refreshPlan();assert.match(await forecast().innerText(), /Ответ относится к другому плану/);estimate = null;

  estimate = { planId: PLAN, isStale: false };await refreshPlan();assert.match(await forecast().innerText(), /Сервер вернул неполную оценку/);assert.doesNotMatch(await forecast().innerText(), /Исходная оценка до запуска не сохранена/);estimate = null;

  // Release the old response only after a different plan has rendered its own forecast.
  const started = new Promise(resolve => { heldStarted = resolve; });
  const finished = new Promise(resolve => { heldFinished = resolve; });holdPlan = PLAN;
  await forecast().getByRole('button', { name: 'Обновить прогноз', exact: true }).click();await started;
  await open(otherPlan);assert.match(await forecast().innerText(), /Около 7 мин/);
  releaseHeld();releaseHeld = null;await finished;
  assert.equal(await forecast().getAttribute('data-plan-id'), otherPlan);assert.match(await forecast().innerText(), /Около 7 мин/);assert.doesNotMatch(await forecast().innerText(), /Около 2 мин/);

  await page.locator('[data-view="settings"]').click();await refreshStatus();
  assert.match(await settings().innerText(), /3 новых пригодных планов из 5/);
  status = modelState('RUNNING');status.training.progress = { phase: 'EVALUATION', completedCases: 2, totalCases: 7 };await refreshStatus();
  assert.match(await settings().innerText(), /Модель обучается/);assert.match(await settings().innerText(), /Проверено случаев: 2 из 7/);
  status = modelState('REJECTED');status.lastReason = 'CANDIDATE_MAE_WORSE';await refreshStatus();
  assert.match(await settings().innerText(), /Новая модель не прошла проверку/);assert.match(await settings().innerText(), /Предыдущая пригодная модель продолжает/);
  assert.match(await settings().innerText(), /Средняя ошибка новой модели выше/);
  await open(PLAN);assert.match(await forecast().innerText(), /Около 2 мин/, 'a rejected candidate must not hide the saved forecast');
  await page.locator('[data-view="settings"]').click();statusError = true;await refreshStatus();
  assert.match(await settings().innerText(), /Не удалось загрузить состояние/);assert.doesNotMatch(await settings().innerText(), /Всего пригодных планов: 0/);
  statusError = false;await refreshStatus();assert.match(await settings().innerText(), /Предыдущая пригодная модель/);
  status.eligibleSampleCount = null;await refreshStatus();assert.match(await settings().innerText(), /Не удалось прочитать состояние обучения/);

  // One automatic process call per unchanged checkpoint, finite polling, and a read-only refresh.
  status = modelState('QUEUED', true);await page.locator('[data-view="overview"]').click();await page.locator('[data-view="settings"]').click();
  await page.waitForFunction(() => !document.querySelector('#atlm-model-status')?.hasAttribute('aria-busy'));
  assert.equal(processCount, 1);for (let i = 0; i < 3; i++) await readPoll();
  const boundedReads = statusCount;await page.clock.runFor(30000);assert.equal(statusCount, boundedReads);assert.equal(processCount, 1);
  await refreshStatus();assert.equal(processCount, 1, 'explicit status refresh is read-only');

  processError = true;await settings().getByRole('button', { name: 'Продолжить обработку', exact: true }).click();
  await settings().getByText(/Не удалось продолжить обучение/).waitFor();assert.equal(processCount, 2);
  await readPoll();assert.match(await settings().innerText(), /Не удалось продолжить обучение/, 'polling must preserve a failed process message');
  processError = false;advancingQueue = true;
  const beforeBudget = processCount;await settings().getByRole('button', { name: 'Продолжить обработку', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#atlm-model-status')?.hasAttribute('aria-busy'));
  for (let i = 0; i < 10; i++) await readPoll();
  assert.equal(processCount - beforeBudget, 8, 'even changing checkpoints cannot cause unlimited automatic processing');
  const finalReads = statusCount;await page.clock.runFor(30000);assert.equal(statusCount, finalReads);
  assert.equal(await settings().getByRole('button', { name: 'Продолжить обработку', exact: true }).isVisible(), true);
  assert.doesNotMatch(await settings().innerText(), /Не удалось продолжить обучение/);
  advancingQueue = false;status = modelState('IDLE');await refreshStatus();

  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1100 });await open(PLAN);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `forecast overflows at ${width}`);
    assert.equal(await forecast().getByRole('button').evaluate(node => node.getBoundingClientRect().height >= 42), true);
    await page.screenshot({ path: resolve(artifacts, `atlm-plan-${width}.png`), fullPage: true });
    await page.locator('[data-view="settings"]').click();await refreshStatus();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `model status overflows at ${width}`);
    await settings().getByRole('button', { name: 'Обновить состояние обучения', exact: true }).focus();
    assert.equal(await settings().getByRole('button', { name: 'Обновить состояние обучения', exact: true }).evaluate(node => node === document.activeElement), true);
    await page.screenshot({ path: resolve(artifacts, `atlm-settings-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('ATLM UI: real cold start and queue recovery; saved/unknown/stale forecasts; rejection, errors and retry; late responses; bounded recovery; keyboard and 320/390/768/1440 layouts passed.');
  console.log('Screenshots: ' + artifacts);
} finally { releaseHeld?.();await browser.close();c.close(); }
