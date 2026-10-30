// Exercises the delivered interface against an isolated database and the real Worker.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { context, OWNER, ok } from "./fixtures/tracker-db.mjs";

const modulePath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const c = context();
c.advance(Date.parse("2026-10-14T17:50:00Z") - c.now());
const create = async title => {
  const plan = await ok(c, "CreatePlan", { title, planCreatedAt: { precision: "dateOnly", on: "2026-10-14", timeZone: "UTC" } });
  return plan.planId;
};
const old = await create("Завершён после выбранного дня");
await ok(c, "StartPlan", { planId: old }, 0);c.advance(20 * 60000);
await ok(c, "FinishPlan", { planId: old }, 1);
c.advance(Date.parse("2026-10-15T09:00:00Z") - c.now());
const finished = await create("Завершённый план");
await ok(c, "StartPlan", { planId: finished }, 0);c.advance(5 * 60000);
await ok(c, "FinishPlan", { planId: finished }, 1);
const active = await create("Активный план");
await ok(c, "StartPlan", { planId: active }, 0);c.advance(5 * 60000);
const paused = await create("План на паузе");
await ok(c, "StartPlan", { planId: paused }, 0);c.advance(5 * 60000);
await ok(c, "PausePlan", { planId: paused }, 1);
for (let i = 0; i < 21; i++) { c.advance(1);await create("Запланированный " + (i + 1)); }

const artifacts = resolve(process.env.UI_ACCEPTANCE_ARTIFACT_DIR || "/workspace/work/tracker-ui");
mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
let holdNextFilter = false, releaseHeldFilter, heldFilterStarted, startedCount = 0;
page.on("pageerror", error => errors.push(error.message));
await page.clock.install({ time: c.now() });
await page.route("**/*", async route => {
  const request = route.request(), url = new URL(request.url());
  assert.equal(url.origin, "http://localhost", "production requests are forbidden");
  const body = request.postDataJSON();
  const response = await c.worker.fetch(new Request(request.url(), {
    method: request.method(), headers: { "content-type": "application/json", "oai-authenticated-user-id": OWNER },
    ...(request.postData() ? { body: request.postData() } : {}),
  }), { DB: c.db });
  if (body?.commandType === "StartPlan" && ++startedCount === 2) c.advance(60000);
  if (holdNextFilter && url.pathname === "/api/analytics" && url.searchParams.get("from") === "2026-10-14" && url.searchParams.get("to") === "2026-10-15") {
    holdNextFilter = false;heldFilterStarted();
    await new Promise(resolve => { releaseHeldFilter = resolve; });
  }
  await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
});
const ids = async selector => page.locator(selector).evaluateAll(nodes => nodes.map(node => node.dataset.planId));
const next = name => page.locator(`#${name}Pager [aria-label="Следующая страница"]`);
const previous = name => page.locator(`#${name}Pager [aria-label="Предыдущая страница"]`);

try {
  await page.goto("http://localhost");
  await page.locator('#plans[data-filtered="true"]').waitFor({ state: "attached" });
  assert.equal(await page.locator("#view-overview #overviewFrom").count(), 1);
  assert.equal(await page.locator("#view-overview .metrics .metric").count() >= 4, true);
  assert.equal(await page.locator("#overviewPeriodPlans, #planPeriodPlans, #inactivePeriodPlans").count(), 0);
  assert.deepEqual(await ids("#active [data-plan-id]"), [active]);
  assert(!((await ids("#recent [data-plan-id]")).includes(active)), "active plans do not reappear in the other list");
  assert.equal(await previous("recent").isDisabled(), true);
  assert.equal(await next("recent").isEnabled(), true);
  const recentFirst = await ids("#recent [data-plan-id]");
  await next("recent").click();
  const recentSecond = await ids("#recent [data-plan-id]");
  assert.equal(recentFirst.length, 4);assert.equal(recentSecond.length, 4);
  assert.equal(recentFirst.some(id => recentSecond.includes(id)), false);
  await previous("recent").click();assert.deepEqual(await ids("#recent [data-plan-id]"), recentFirst);
  await page.screenshot({ path: resolve(artifacts, "overview-desktop.png"), fullPage: true });

  await page.locator('[data-view="plans"]').click();
  assert.equal(await page.locator("#view-plans #planFrom").count(), 1);
  assert.equal(await page.locator("#view-plans #planMode").count(), 1);
  await page.screenshot({ path: resolve(artifacts, "plans-desktop.png"), fullPage: true });
  const allRows = [];
  while (true) {
    const pageIds = await ids("#plans>.row");
    assert(pageIds.length <= 8);
    allRows.push(...pageIds);
    if (await next("plans").isDisabled()) break;
    await next("plans").click();
  }
  assert.equal(allRows.length, 25);
  assert.equal(new Set(allRows).size, allRows.length, "each matching plan appears exactly once");
  assert(allRows.includes(active) && allRows.includes(paused) && allRows.includes(finished));
  assert.equal(await next("plans").isDisabled(), true);
  await previous("plans").click();assert.equal(await next("plans").isEnabled(), true);

  // Completed mode must use the selected end date, even if a plan was active that day.
  await page.locator("#planFrom").fill("2026-10-14");await page.locator("#planTo").fill("2026-10-14");
  await page.locator("#planMode").selectOption("finished");
  await page.waitForFunction(() => document.querySelector("#plansPager .pager-summary")?.textContent === "Нет планов");
  assert.equal(await page.locator("#plans>.row").count(), 0);
  assert.equal(await previous("plans").isDisabled(), true);assert.equal(await next("plans").isDisabled(), true);
  await page.locator("#planTo").fill("2026-10-15");
  await page.locator("#view-plans .plan-period-panel").getByRole("button", { name: "Применить" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#plans>.row").length === 2);
  assert.deepEqual(new Set(await ids("#plans>.row")), new Set([old, finished]));
  assert.equal(await page.locator("#plansPager .pager-page").innerText(), "1 / 1");

  await page.locator("#planMode").selectOption("activity");
  await page.waitForFunction(() => document.querySelectorAll("#plans>.row").length === 8);
  assert.equal(await page.locator("#plansPager .pager-page").innerText(), "1 / 4");
  await next("plans").click();
  const plannedRow = page.locator('#plans>.row').filter({ has: page.getByRole("button", { name: "Запустить", exact: true }) }).first();
  const started = await plannedRow.getAttribute("data-plan-id");
  const filterRefresh = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/analytics" && url.searchParams.get("from") === "2026-10-14" && url.searchParams.get("to") === "2026-10-15";
  });
  await plannedRow.getByRole("button", { name: "Запустить", exact: true }).click();await filterRefresh;
  await page.waitForFunction(id => document.querySelector(`#plans [data-plan-id="${id}"] .badge`)?.textContent === "Выполняется", started);
  assert.equal(await page.locator("#plansPager .pager-page").innerText(), "2 / 4", "command refresh keeps the current page");
  assert.equal(await page.locator(`#plans [data-plan-id="${started}"] .row-meta`).innerText().then(text => text.includes("за период: без активности")), true, "a newly started timer remains visible even before measurable time accrues");

  // A command refresh must not overwrite a newer filter while its response is delayed.
  const pendingRow = page.locator('#plans>.row').filter({ has: page.getByRole("button", { name: "Запустить", exact: true }) }).first();
  const overviewTotal = await page.locator('#view-overview .panel:has(#overviewFrom) .metric strong').first().innerText();
  const filterHeld = new Promise(resolve => { heldFilterStarted = resolve; });holdNextFilter = true;
  await page.locator("#planMode").selectOption("finished");await filterHeld;
  await pendingRow.getByRole("button", { name: "Запустить", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("#plans>.row").length === 2);
  await page.waitForFunction(previous => document.querySelector('#view-overview .panel:has(#overviewFrom) .metric strong')?.textContent !== previous, overviewTotal);
  assert.deepEqual(new Set(await ids("#plans>.row")), new Set([old, finished]));
  assert.equal(await page.locator("#plansPager .pager-page").innerText(), "1 / 1");
  releaseHeldFilter();releaseHeldFilter = null;
  await page.waitForLoadState("networkidle");
  assert.deepEqual(new Set(await ids("#plans>.row")), new Set([old, finished]), "late responses cannot replace the newest filter");
  await page.locator("#planMode").selectOption("activity");
  await page.waitForFunction(() => document.querySelectorAll("#plans>.row").length === 8);
  await page.locator('[data-view="overview"]').click();
  assert((await ids("#active [data-plan-id]")).includes(started));
  assert(!(await ids("#recent [data-plan-id]")).includes(started));

  for (const width of [320, 360, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const view of ["overview", "plans"]) {
      await page.locator(`[data-view="${view}"]`).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${view} overflows at ${width}`);
      const pager = page.locator(view === "overview" ? "#recentPager" : "#plansPager");
      assert.equal(await pager.locator("button").first().evaluate(node => node.getBoundingClientRect().width >= 44), true);
    }
    if (width === 360) {
      await page.locator("#toast").evaluate(node => node.classList.add("hidden"));
      await page.screenshot({ path: resolve(artifacts, "plans-mobile.png"), fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  console.log("Plan pagination browser verification passed: unique rows, filters, page boundaries, actions, refresh and responsive layouts.");
} finally { releaseHeldFilter?.();await browser.close();c.close(); }
