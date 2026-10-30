// Independent timers/actions against actual Worker+SQLite, with delayed reads and a lost write reply.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { context, OWNER, PLAN, ok } from "./fixtures/tracker-db.mjs";
const modulePath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const c = context(), minute = 60000, B = "22222222-2222-4222-8222-222222222222";
c.advance(Date.parse("2026-10-15T10:00:00Z") - c.now());
const create = (planId, title) => ok(c, "CreatePlan", { planId, title, planCreatedAt: { precision: "dateOnly", on: "2026-10-15", timeZone: "UTC" } });
await create(PLAN, "План A");await ok(c, "StartPlan", { planId: PLAN }, 0);c.advance(30 * minute);
await create(B, "План B");await ok(c, "StartPlan", { planId: B }, 0);c.advance(60 * minute);
// More than a full page must never hide either active plan, including equal registration times.
for (let i = 0; i < 100; i++) await create(crypto.randomUUID(), "Синтетический план " + i);
// Put B on the earlier page and A on the later page so timing differs between pages.
c.db.sqlite.prepare("UPDATE plans SET registered_at=? WHERE plan_id=?").run(c.now() + 1, B);
const artifacts = resolve(process.env.UI_ACCEPTANCE_ARTIFACT_DIR || "/tmp/tracker-source-ui");mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const posts = [], errors = [], paths = [];let delayList = true, losePause = true;
page.setDefaultTimeout(8000);page.on("pageerror", error => errors.push(error.message));
await page.clock.install({ time: c.now() + 2 * 86400000 }); // Deliberately skew the client clock.
await page.addInitScript(() => { window.confirm = () => true; });
await page.route("**/*", async route => {
  const request = route.request(), url = new URL(request.url());
  assert.equal(url.origin, "http://localhost", "external requests forbidden");paths.push(url.pathname + url.search);
  const body = request.postDataJSON();if (body) posts.push(body);
  const response = await c.worker.fetch(new Request(request.url(), { method: request.method(), headers: { "content-type": "application/json", "oai-authenticated-user-id": OWNER }, ...(request.postData() ? { body: request.postData() } : {}) }), { DB: c.db });
  // First page is a real earlier snapshot; later pages and daily analytics see two more minutes.
  if (url.pathname === "/api/plans" && delayList) { delayList = false;c.advance(2 * minute); }
  if (body?.commandType === "PausePlan" && body.payload.planId === PLAN && losePause) { losePause = false;return route.abort("failed"); }
  return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
});
const card = id => page.locator('#active .active-plan[data-plan-id="' + id + '"]');
const clock = id => card(id).locator(".timer");
const bState = () => JSON.stringify({ plan: c.db.sqlite.prepare("SELECT * FROM plans WHERE plan_id=?").get(B), intervals: c.db.sqlite.prepare("SELECT * FROM work_intervals WHERE plan_id=?").all(B) });
try {
  await page.goto("http://localhost");await page.locator('#plans[data-loaded="true"]').waitFor({ state: "attached" });
  await page.locator('#plans[data-filtered="true"]').waitFor({ state: "attached" });
  assert.equal(await page.locator("#plans>.row").count(), 8);
  assert.equal(await page.locator("#plansPager .pager-summary").innerText(), "1–8 из 102");
  assert.equal(await page.locator("#activeCount").innerText(), "2");
  assert.equal(await clock(PLAN).innerText(), "1 ч 32 мин");
  assert.equal(await clock(B).innerText(), "1 ч 2 мин");
  assert.equal(await page.locator("#today").innerText(), "1 ч 32 мин", "daily metric uses server-local day despite clock skew");
  c.advance(minute);await page.clock.runFor(minute);
  assert.equal(await clock(PLAN).innerText(), "1 ч 33 мин");assert.equal(await clock(B).innerText(), "1 ч 3 мин");
  assert.equal(await page.locator("#today").innerText(), "1 ч 33 мин", "parallel timers add only one elapsed minute to owner time");
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: resolve(artifacts, "parallel-" + width + ".png"), fullPage: true });
  }
  const beforeB = bState();
  await card(PLAN).getByRole("button", { name: "Пауза", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#toast").classList.contains("error"));
  assert.equal(bState(), beforeB);
  await card(PLAN).getByRole("button", { name: "Пауза", exact: true }).click();
  await card(PLAN).waitFor({ state: "detached" });
  assert.equal(await page.locator("#activeCount").innerText(), "1");assert.equal(bState(), beforeB);
  const pauses = posts.filter(p => p.commandType === "PausePlan");assert.equal(pauses.length, 2);assert.deepEqual(pauses[0], pauses[1]);
  await card(B).getByRole("button", { name: "План B", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Описание", exact: true });await draft.fill("Несохранённый черновик B");
  await page.evaluate(async planId => {
    await new Promise((resolve, reject) => window.dispatchEvent(new CustomEvent("plan-time-tracker:refresh-plan", { detail: { planId, resolve, reject } })));
  }, PLAN);
  assert.equal(await page.locator("#planDetail").getAttribute("data-plan-id"), B);assert.equal(await draft.inputValue(), "Несохранённый черновик B");
  await page.locator('[data-view="plans"]').click();
  while (!await page.locator('#plans [data-plan-id="' + PLAN + '"]').count()) {
    const next = page.locator('#plansPager [aria-label="Следующая страница"]');
    assert.equal(await next.isEnabled(), true, "paused plan remains reachable through pagination");
    await next.click();
  }
  await page.locator('#plans [data-plan-id="' + PLAN + '"]').getByRole("button", { name: "Продолжить", exact: true }).click();
  await page.locator('[data-view="overview"]').click();await card(PLAN).waitFor();
  // A stale version refreshes A only; B keeps its own current version for the next action.
  await ok(c, "UpdatePlanMetadata", { planId: PLAN, title: "Обновлённый A" }, 3);
  await card(PLAN).getByRole("button", { name: "Пауза", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#toast")?.textContent.includes("VERSION_CONFLICT"));
  await card(PLAN).getByRole("button", { name: "Обновлённый A", exact: true }).waitFor();
  await card(PLAN).getByRole("button", { name: "Завершить", exact: true }).click();await card(PLAN).waitFor({ state: "detached" });
  assert.equal(bState(), beforeB);assert.equal(await page.locator("#activeCount").innerText(), "1");
  assert.equal(paths.some(p => p.startsWith("/api/active")), false);assert.deepEqual(errors, []);
  writeFileSync(resolve(artifacts, "parallel-report.json"), JSON.stringify({ plans: 102, independentCards: 2, delayedRead: true, skewDays: 2, exactPauseReplay: true, draftsPreserved: true, versionConflictIsolated: true, errors }, null, 2));
  console.log("Parallel browser verification passed: pagination, independent timers/actions, server time, exact retry and drafts.");
} finally { await browser.close();c.close(); }
