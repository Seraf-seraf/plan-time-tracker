import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { context, running, ok, OWNER } from './fixtures/tracker-db.mjs';
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(modulePath.startsWith('/') ? pathToFileURL(modulePath).href : modulePath);
const c = context();c.advance(Date.now() - c.now() - 86400000 * 2);
if (process.env.SITE_WORKER_MODULE) c.worker = (await import(pathToFileURL(process.env.SITE_WORKER_MODULE).href)).createWorker(() => c.now());
const mainId = crypto.randomUUID(), manyId = crypto.randomUUID();
const titles = ['Изучить требования и выбрать решение', 'Реализовать изменение и проверить интеграцию', 'Проверить измеренный ноль', 'Этап без измерений'];
await ok(c, 'CreatePlan', { planId: mainId, title: 'Обновление трекера (тестовые данные)', planText: '# Test\n\n' + titles.map((title, i) => '## Этап ' + (i + 1) + '. ' + title + '\nSynthetic fixture').join('\n\n'), planCreatedAt: { precision: 'dateOnly', on: new Date(c.now()).toISOString().slice(0, 10), timeZone: 'UTC' } });
await ok(c, 'StartPlan', { planId: mainId }, 0);
const steps = c.db.sqlite.prepare('SELECT step_id FROM plan_steps WHERE plan_id=? ORDER BY ordinal').all(mainId);
for (const [index, ms] of [60000, 120000, 0].entries()) {
  await ok(c, 'SetStepStatus', { stepId: steps[index].step_id, status: 'RUNNING' }, 1);c.advance(ms);
  await ok(c, 'SetStepStatus', { stepId: steps[index].step_id, status: 'DONE' }, 2);
}
await ok(c, 'FinishPlan', { planId: mainId, allowIncomplete: true, reason: 'Synthetic fixture with an unmeasured step' }, 1);c.advance(1);
for (const ms of [0, 120000]) { const id = crypto.randomUUID(), step = await running(c, [], id);c.advance(ms);await ok(c, 'SetStepStatus', { ...step, status: 'DONE' }, 2);await ok(c, 'FinishPlan', { planId: id }, 1);c.advance(1); }
const artifacts = resolve(process.env.UI_ACCEPTANCE_ARTIFACT_DIR || '/tmp/tracker-analytics-ui');mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [], requests = [];
let failOnce = false, holdNext = false, releaseHeld, heldStarted;
page.setDefaultTimeout(10000);page.on('pageerror', e => errors.push(e.message));
await page.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());assert.equal(url.origin, 'http://localhost');requests.push(url.pathname);
  if (url.pathname.includes('/api/analytics/plans/') && failOnce) { failOnce = false;return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic temporary failure' } }) }); }
  const response = await c.worker.fetch(new Request(request.url(), { method: request.method(), headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': OWNER }, ...(request.postData() ? { body: request.postData() } : {}) }), { DB: c.db });
  const body = await response.text();
  if (url.pathname.includes('/api/analytics/plans/') && holdNext) { holdNext = false;heldStarted();await new Promise(resolve => { releaseHeld = resolve; }); }
  await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
});
const card = id => page.locator('.analytics-plan[data-plan-id="' + id + '"]');
const detailRequests = () => requests.filter(path => path.includes('/api/analytics/plans/')).length;
async function apply() { await page.locator('#apply').click();await page.waitForFunction(() => !document.querySelector('#apply').disabled); }
try {
  await page.goto('http://localhost');await page.locator('#plans[data-loaded="true"]').waitFor({ state: 'attached' });await page.locator('[data-view="analytics"]').click();await page.locator('#stats .metric').first().waitFor();
  assert.equal(await page.locator('#stats .metric strong').nth(0).innerText(), '5 мин');assert.equal(await page.locator('#stats .metric strong').nth(1).innerText(), '3');assert.match(await page.locator('#stats .metric strong').nth(2).innerText(), /^2 мин/);
  assert.equal(await page.locator('#analyticPlans .row').count(), 3);assert((await page.locator('#chart .barrow').count()) > 0);assert.equal(detailRequests(), 0, 'charts load only on disclosure');
  failOnce = true;await card(mainId).locator('summary').focus();await page.keyboard.press('Enter');
  await card(mainId).getByRole('button', { name: 'Повторить загрузку' }).waitFor();assert.match(await card(mainId).innerText(), /Не удалось загрузить график/);
  await card(mainId).getByRole('button', { name: 'Повторить загрузку' }).click();await card(mainId).locator('.stage-row').first().waitFor();
  assert.deepEqual(await card(mainId).locator('.stage-value').allTextContents(), ['1 мин', '2 мин', '0 мин', 'Нет данных']);
  assert.equal(await card(mainId).locator('rect').count(), 2);assert.equal(await card(mainId).locator('rect').nth(0).getAttribute('width'), '500');assert.equal(await card(mainId).locator('rect').nth(1).getAttribute('width'), '1000');
  const loaded = detailRequests();await card(mainId).locator('summary').click();await card(mainId).locator('summary').click();assert.equal(detailRequests(), loaded, 'same report caches chart data');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'overflow at ' + width);
    assert.equal(await card(mainId).locator('summary').evaluate(node => node.getBoundingClientRect().height >= 44), true);
    for (const row of await card(mainId).locator('.stage-row').all()) assert.equal(await row.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'stage content fits at ' + width);
    await page.screenshot({ path: resolve(artifacts, 'analytics-' + width + '.png'), fullPage: true });
    if (width === 1440) {
      const preview = await page.evaluate(mainId => '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Время этапов</title><meta name="description" content="Предпросмотр графика времени этапов на тестовых данных."><meta name="viewport" content="width=device-width,initial-scale=1">' + [...document.querySelectorAll('style')].map(n => n.outerHTML).join('') + '</head><body><main class="shell"><h1>Время этапов</h1><p>Предпросмотр на тестовых данных.</p><h2>План</h2>' + document.querySelector('.analytics-plan[data-plan-id="' + mainId + '"]').outerHTML + '</main></body></html>', mainId);
      writeFileSync(resolve(artifacts, 'chart-preview.html'), preview);
    }
  }
  const waiting = new Promise(resolve => { heldStarted = resolve; });holdNext = true;
  await apply();await card(mainId).locator('summary').click();await waiting;
  await apply();releaseHeld();releaseHeld = null;
  assert.equal(await card(mainId).locator('.stage-row').count(), 0, 'late chart response cannot populate a replaced report');
  await card(mainId).locator('summary').click();await card(mainId).locator('.stage-row').first().waitFor();

  await ok(c, 'CreatePlan', { planId: manyId, title: 'Длинный план — тестовые данные', planText: '# Test\n\n' + Array.from({ length: 40 }, (_, i) => '## Этап ' + (i + 1) + '. ' + 'Полное длинное название этапа '.repeat(5) + '\nSynthetic fixture').join('\n\n'), planCreatedAt: { precision: 'dateOnly', on: new Date(c.now()).toISOString().slice(0, 10), timeZone: 'UTC' } });
  await ok(c, 'StartPlan', { planId: manyId }, 0);c.advance(1000);await apply();
  await card(manyId).locator('summary').click();await card(manyId).locator('.stage-row').first().waitFor();assert.equal(await card(manyId).locator('.stage-row').count(), 40);
  await page.setViewportSize({ width: 320, height: 1000 });assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert((await card(manyId).locator('.stage-value').allTextContents()).every(value => value === 'Нет данных'));
  await page.emulateMedia({ reducedMotion: 'reduce' });assert.equal(await card(manyId).locator('.stage-row').count(), 40);
  assert(!requests.some(url => /status-history|timeline/.test(url)));assert.deepEqual(errors, []);
  console.log('Analytics UI passed: existing metrics, lazy duration charts, exact and missing/zero values, error/retry, keyboard, snapshot refresh and late responses, 40 long names, 320–1440px and reduced motion. Screenshots: ' + artifacts);
} finally { releaseHeld?.();await browser.close();c.close(); }
