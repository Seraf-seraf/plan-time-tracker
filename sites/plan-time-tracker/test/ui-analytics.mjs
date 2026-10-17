// Browser verification uses only synthetic plans in isolated SQLite and the actual Worker.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { context, OWNER, PLAN, ok, result, rows } from "./fixtures/tracker-db.mjs";
const modulePath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const c = context();c.advance(Date.UTC(2026, 9, 15, 10) - c.now());
const artifacts = resolve(process.env.UI_ACCEPTANCE_ARTIFACT_DIR || "/tmp/tracker-analytics-ui");mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
const errors = [], requests = [];let failOnce = false, pendingDetail = null, releaseDetail;
async function seed(planId, title, sections) {
  await ok(c, "CreatePlan", { planId, title, planCreatedAt: { precision: "dateOnly", on: "2026-10-15", timeZone: "UTC" } });
  const steps = [];
  for (let i = 0; i < sections.length; i++) steps.push(await ok(c, "CreateStep", { planId, ordinal: i + 1, title: sections[i].title, expectedResult: "Synthetic expected result", requiredChecks: [] }));
  await ok(c, "StartPlan", { planId }, 0);
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].ms == null) continue;
    const stepId = steps[i].stepId;
    const claim = await ok(c, "ClaimStepAttempt", { stepId, sessionId: crypto.randomUUID(), sourceId: "analytics-browser-fixture" }, 1);
    const lease = { stepId, attemptId: claim.attemptId, fence: claim.fence };
    await ok(c, "StartStep", lease, 1);c.advance(sections[i].ms);await result(c, lease, null);
  }
  c.advance(1000);await ok(c, "FinishPlan", { planId, allowIncomplete: true, reason: "Finish synthetic browser fixture" }, 1);
}
async function seedOverlap(planId, offset) {
  await ok(c, "CreatePlan", { planId, title: (offset ? "Частичное" : "Полное") + " перекрытие · тестовые данные", planCreatedAt: { precision: "dateOnly", on: "2026-10-15", timeZone: "UTC" } });
  const steps = [];
  for (let i = 0; i < 2; i++) steps.push(await ok(c, "CreateStep", { planId, ordinal: i, title: i === 1 ? longTitle : "Пересекающийся пункт " + (i + 1), expectedResult: "Synthetic overlap", requiredChecks: [] }));
  await ok(c, "StartPlan", { planId }, 0);
  const leases = [];
  for (const step of steps) {
    if (leases.length) c.advance(offset);
    const claim = await ok(c, "ClaimStepAttempt", { stepId: step.stepId, sessionId: crypto.randomUUID(), sourceId: "analytics-overlap-fixture" }, 1);
    const lease = { stepId: step.stepId, attemptId: claim.attemptId, fence: claim.fence };
    await ok(c, "StartStep", lease, 1);leases.push(lease);
  }
  c.advance(60000);await result(c, leases[0], null);c.advance(offset);await result(c, leases[1], null);
  await ok(c, "FinishPlan", { planId }, 1);
}
const singleId = crypto.randomUUID(), emptyId = crypto.randomUUID(), manyId = crypto.randomUUID(), unknownId = crypto.randomUUID(), fullOverlapId = crypto.randomUUID(), partialOverlapId = crypto.randomUUID(), lazyId = crypto.randomUUID();
const longTitle = "Проверка_длинного_названия_без_пробелов_".repeat(5).slice(0, 200);
await seed(PLAN, "Пример проверки аналитики · тестовые данные", [
  { title: "Анализ требований", ms: 180123 }, { title: "Подготовка материалов", ms: 240000 },
  { title: longTitle, ms: 480000 }, { title: "Проверка результата", ms: 0 },
  { title: "Подведение итогов", ms: 120000 }, { title: "Пункт без привязки времени", ms: null },
]);
await seed(singleId, "Один пункт · тестовые данные", [{ title: "Единственный пункт", ms: 61234 }]);
await seed(emptyId, "Пустой план · тестовые данные", []);
await seed(manyId, "Много пунктов · тестовые данные", Array.from({ length: 40 }, (_, i) => ({ title: "Пункт " + (i + 1) + " " + "длинное название ".repeat(8), ms: i === 0 ? 90000 : null })));
await seed(unknownId, "Нет привязки · тестовые данные", [{ title: "Пункт без данных", ms: null }]);
await seedOverlap(fullOverlapId, 0);await seedOverlap(partialOverlapId, 60000);
await ok(c, "CreatePlan", { planId: lazyId, title: "Проверка среза · тестовые данные", planCreatedAt: { precision: "dateOnly", on: "2026-10-15", timeZone: "UTC" } });
await ok(c, "CreateStep", { planId: lazyId, ordinal: 0, title: "Пункт на момент отчёта", expectedResult: "Synthetic cutoff", requiredChecks: [] });
await ok(c, "StartPlan", { planId: lazyId }, 0);c.advance(1000);
let before = rows(c);
async function routePage(page) {
  page.setDefaultTimeout(8000);page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, "http://localhost", "external requests are forbidden");requests.push({ method: request.method(), path: url.pathname });
    if (url.pathname.includes("/steps") && failOnce) { failOnce = false;return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Synthetic temporary failure" } }) }); }
    const response = await c.worker.fetch(new Request(request.url(), { method: request.method(), headers: { "oai-authenticated-user-id": OWNER } }), { DB: c.db });
    if (url.pathname.includes("/steps") && pendingDetail) { const hold = pendingDetail;pendingDetail = null;await hold; }
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
}
async function analytics(page) {
  await page.goto("http://localhost");await page.locator('#plans[data-loaded="true"]').waitFor({ state: "attached" });
  await page.locator('[data-view="analytics"]').click();
  await page.locator("#from").fill("2026-10-14");await page.locator("#to").fill("2026-10-15");await page.locator("#apply").click();
  await page.locator(".analytics-plan").first().waitFor();
}
const card = (page, id = PLAN) => page.locator('.analytics-plan[data-plan-id="' + id + '"]');
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });await routePage(page);await analytics(page);
  assert.equal(await page.title(), "Трекер планов");assert.equal(await page.locator("h1").innerText(), "Трекер планов");
  assert.equal(await page.locator(".nav button").count(), 4);assert.equal(await page.locator(".barrow").count() > 0, true);
  assert.equal(await page.locator(".metric").filter({ hasText: "Общее время за период" }).count() > 0, true);
  const main = card(page);await main.locator("summary.row").click();await main.locator(".step-column").first().waitFor();
  assert.equal(await main.getAttribute("open"), "");assert.equal(await main.locator(".step-column").count(), 6);
  const first = main.locator(".step-column").nth(0), zero = main.locator(".step-column").nth(3), missing = main.locator(".step-column").nth(5);
  await first.locator(".step-bar").hover();assert.equal(await main.locator(".step-tooltip").innerText(), "Анализ требований\n3 мин 123 мс");
  await page.keyboard.press("Escape");assert.equal(await main.locator(".step-tooltip").isVisible(), false, "Escape dismisses hover without focus");
  await page.mouse.move(0, 0);await first.locator(".step-bar").hover();
  await main.locator(".step-tooltip").hover();assert.equal(await main.locator(".step-tooltip").isVisible(), true, "tooltip remains hoverable");
  await main.locator(".step-column").nth(2).locator(".step-x-label").hover();assert((await main.locator(".step-tooltip").innerText()).includes(longTitle));
  assert.equal(await main.locator(".step-x-label").nth(2).evaluate(n => n.scrollWidth > n.clientWidth), true);
  await zero.focus();assert.equal(await main.locator(".step-tooltip span").innerText(), "0 мин");
  assert.equal(await zero.locator(".step-bar").evaluate(n => n.getBoundingClientRect().height), 0);
  assert((await missing.getAttribute("aria-label")).includes("Нет данных о привязке времени"));assert.equal(await missing.locator(".step-bar").count(), 0);
  await page.keyboard.press("Escape");assert.equal(await main.locator(".step-tooltip").isVisible(), false);
  await page.keyboard.press("Enter");assert.equal(await main.locator(".step-tooltip").isVisible(), true);
  await page.keyboard.press("Escape");assert.equal(await main.locator(".step-tooltip").isVisible(), false);
  await page.keyboard.press("Tab");assert.equal(await main.locator(".step-tooltip").isVisible(), true);
  await first.focus();await page.screenshot({ path: resolve(artifacts, "analytics-desktop.png"), fullPage: true });
  const detailCount = requests.filter(r => r.path.endsWith("/steps")).length;
  await main.locator("summary.row").click();assert.equal(await main.locator(".step-chart").isVisible(), false);
  await main.locator("summary.row").focus();await page.keyboard.press("Enter");await main.locator(".step-chart").waitFor();
  assert.equal(requests.filter(r => r.path.endsWith("/steps")).length, detailCount, "reopening reuses accepted data");
  await main.locator("summary.row").click();
  await card(page, singleId).locator("summary.row").click();await card(page, singleId).locator(".step-column").waitFor();
  assert.equal(await card(page, singleId).locator(".step-column").count(), 1);
  await card(page, emptyId).locator("summary.row").click();await card(page, emptyId).getByText("На момент отчёта в плане нет пунктов. График недоступен.").waitFor();
  assert.equal(await card(page, emptyId).locator(".step-column").count(), 0);
  await card(page, unknownId).locator("summary.row").click();await card(page, unknownId).getByText("Данные о привязке времени к пунктам отсутствуют. Знак «—» означает отсутствие данных.").waitFor();
  assert.equal(await card(page, unknownId).locator(".step-bar").count(), 0);
  const full = card(page, fullOverlapId);await full.locator("summary.row").click();await full.locator(".step-column").first().waitFor();
  assert.equal(await full.locator(".step-bar").count(), 0, "full ambiguity is never a zero bar");
  assert.equal(await full.locator(".step-missing").count(), 2);
  await full.locator(".step-column").first().focus();assert.match(await full.locator(".step-tooltip").innerText(), /Время не определено: 1 мин/);
  assert.match(await full.locator(".step-column").first().getAttribute("aria-label"), /Время не определено/);
  await page.screenshot({ path: resolve(artifacts, "analytics-full-overlap.png"), fullPage: true });
  const partial = card(page, partialOverlapId);await partial.locator("summary.row").click();await partial.locator(".step-column").first().waitFor();
  assert.equal(await partial.locator(".step-bar").count(), 2);
  assert.match(await partial.locator(".step-x-label").first().innerText(), /1\*/);
  await partial.locator(".step-column").first().focus();assert.match(await partial.locator(".step-tooltip span").innerText(), /^1 мин · неполное время/);
  assert.match(await partial.locator(".step-column").first().getAttribute("aria-label"), /только однозначная часть/);
  assert.deepEqual(rows(c), before, "reads before the cutoff mutation do not change data");
  c.advance(1);await ok(c, "CreateStep", { planId: lazyId, ordinal: 1, title: "Создан после отчёта", expectedResult: "Synthetic late section", requiredChecks: [] });
  before = rows(c);const lazy = card(page, lazyId);await lazy.locator("summary.row").click();await lazy.locator(".step-column").first().waitFor();
  assert.equal(await lazy.locator(".step-column").count(), 1, "lazy expansion uses the accepted report cutoff");
  await page.locator("#apply").click();await page.waitForFunction(() => !document.querySelector(".analytics-plan[open]"));
  await card(page, lazyId).locator("summary.row").click();await card(page, lazyId).locator(".step-column").nth(1).waitFor();
  assert.equal(await card(page, lazyId).locator(".step-column").count(), 2, "a new report includes the later section");
  failOnce = true;const many = card(page, manyId);await many.locator("summary.row").click();await many.getByRole("button", { name: "Повторить" }).waitFor();
  assert.equal(await many.locator(".step-column").count(), 0, "failure never fabricates zero values");
  await many.getByRole("button", { name: "Повторить" }).click();await many.locator(".step-column").first().waitFor();
  assert.equal(await many.locator(".step-column").count(), 40);
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1200 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "document overflow at " + width);
    assert.equal(await many.evaluate(node => {
      const zero = node.querySelector('.step-y-axis span').getBoundingClientRect(), slot = node.querySelector('.step-plot-slot').getBoundingClientRect();
      return Math.abs(zero.top + zero.height / 2 - slot.bottom) < 0.6;
    }), true, "Y zero aligns with plot baseline at " + width);
    const scroll = many.locator(".step-chart-scroll");assert.equal(await scroll.evaluate(n => n.scrollWidth > n.clientWidth), true);
    await scroll.evaluate(n => { n.scrollLeft = n.scrollWidth; });assert.equal(await scroll.evaluate(n => n.scrollLeft > 0), true);
    await many.locator(".step-column").last().focus();assert((await many.locator(".step-tooltip").innerText()).includes("Пункт 40"));
  }
  // A late detail cannot render into the newly applied report.
  await page.locator("#apply").click();await page.waitForFunction(() => !document.querySelector(".analytics-plan[open]"));
  pendingDetail = new Promise(resolve => { releaseDetail = resolve; });
  await card(page).locator("summary.row").click();await card(page).getByText("Загрузка графика…").waitFor();
  await page.locator("#apply").click();await page.waitForFunction(() => !document.querySelector(".analytics-plan[open]"));releaseDetail();
  await page.waitForLoadState("networkidle");assert.equal(await page.locator(".step-column").count(), 0);
  const mobile = await browser.newPage({ viewport: { width: 360, height: 1000 }, isMobile: true, hasTouch: true });await routePage(mobile);await analytics(mobile);
  await card(mobile).locator("summary.row").tap();await card(mobile).locator(".step-column").first().waitFor();
  await card(mobile).locator(".step-column").nth(3).locator(".step-x-label").tap();
  assert.equal(await card(mobile).locator(".step-tooltip span").innerText(), "0 мин");
  await card(mobile).locator(".step-column").first().locator(".step-bar").tap();
  assert.equal(await card(mobile).locator(".step-tooltip span").innerText(), "3 мин 123 мс");
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mobile.screenshot({ path: resolve(artifacts, "analytics-mobile.png"), fullPage: true });
  await card(mobile, manyId).locator("summary.row").tap();await card(mobile, manyId).locator(".step-column").first().waitFor();
  await card(mobile, manyId).locator(".step-chart-scroll").evaluate(n => { n.scrollLeft = n.scrollWidth; });
  await card(mobile, manyId).locator(".step-column").last().locator(".step-x-label").tap();
  await mobile.screenshot({ path: resolve(artifacts, "analytics-mobile-many.png"), fullPage: true });
  await card(mobile, partialOverlapId).locator("summary.row").tap();await card(mobile, partialOverlapId).locator(".step-column").first().waitFor();
  await card(mobile, partialOverlapId).locator(".step-column").first().locator(".step-x-label").tap();
  assert.match(await card(mobile, partialOverlapId).locator(".step-tooltip span").innerText(), /неполное время/);
  await card(mobile, fullOverlapId).locator("summary.row").tap();await card(mobile, fullOverlapId).locator(".step-column").first().waitFor();
  await card(mobile, fullOverlapId).locator(".step-column").first().locator(".step-x-label").tap();
  assert.match(await card(mobile, fullOverlapId).locator(".step-tooltip span").innerText(), /Время не определено/);
  for (const width of [360, 390]) {
    await mobile.setViewportSize({ width, height: 1000 });
    for (const id of [fullOverlapId, partialOverlapId]) {
      const target = card(mobile, id);await target.locator('.step-column').last().locator('.step-x-label').tap();
      assert((await target.locator('.step-tooltip strong').innerText()).includes(longTitle));
      assert.equal(await target.evaluate(node => {
        const tip = node.querySelector('.step-tooltip').getBoundingClientRect(), scroll = node.querySelector('.step-chart-scroll').getBoundingClientRect(), caption = node.querySelector('.step-axis-caption').getBoundingClientRect();
        return tip.top >= scroll.bottom && tip.bottom <= caption.top;
      }), true, "long overlap tooltip does not cover X labels or caption at " + width);
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
  }
  assert.deepEqual(rows(c), before, "browser analytics never mutates plan data");assert(requests.every(r => r.method === "GET"));assert.deepEqual(errors, []);
  const report = { passed: true, backend: "actual Worker + isolated SQLite", productionRequests: 0, widths: [360, 390, 768, 1440], checks: ["name and document title", "preserved metrics/day bars/navigation", "hover bar and X label", "full long title and exact milliseconds", "focus/Tab/Escape", "mobile touch bar and label", "collapse and keyboard reopen", "one/zero/40 sections", "zero vs unavailable attribution", "full overlap is uncertain, not zero", "partial overlap is visibly incomplete and accessible by focus/tap", "lazy expansion excludes a later section until a fresh report", "local horizontal scrolling without page overflow", "load error and retry", "stale response after period change", "read-only requests and unchanged DB apart from the explicit synthetic late-section fixture"] };
  writeFileSync(resolve(artifacts, "analytics-report.json"), JSON.stringify(report, null, 2));console.log(JSON.stringify(report));
} finally { releaseDetail?.();await browser.close();c.close(); }
