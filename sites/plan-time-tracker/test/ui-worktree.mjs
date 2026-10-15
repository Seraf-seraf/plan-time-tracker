// Real Worker + migrated, in-memory SQLite behind a local browser route. No production traffic.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWorker } from "../worker/index.js";
const modulePath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const sqlite = new DatabaseSync(":memory:");
const migrations = new URL("../drizzle/", import.meta.url);
for (const file of readdirSync(migrations).filter(file => file.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
class Statement {
  constructor(sql, args = []) { Object.assign(this, { sql, args }); }
  bind(...args) { return new Statement(this.sql, args); }
  async run() { return { meta: { changes: Number(sqlite.prepare(this.sql).run(...this.args).changes) } }; }
  async first() { return sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
}
let now = Date.now();
const db = { prepare(sql) { return new Statement(sql); } }, worker = createWorker(() => now), owner = "source-browser-fixture";
const origin = "http://localhost", digest = "sha256:" + "a".repeat(64);
const legacyPlan = "11111111-1111-4111-8111-111111111111", snapshotPlan = "22222222-2222-4222-8222-222222222222";
const requiredChecks = ["unit", "postgres", "typecheck", "lint"];
async function fetchLocal(path, options = {}) {
  return worker.fetch(new Request(origin + path, { ...options, headers: { "content-type": "application/json", "oai-authenticated-user-id": owner } }), { DB: db });
}
async function command(type, payload, expectedVersion) {
  const response = await fetchLocal("/api/commands", { method: "POST", body: JSON.stringify({ schemaVersion: 1, commandId: crypto.randomUUID(), commandType: type, payload, ...(expectedVersion === undefined ? {} : { expectedVersion }) }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.result;
}
async function createRunningStep(planId, title) {
  await command("CreatePlan", { planId, title, planCreatedAt: { precision: "dateOnly", on: "2026-10-15", timeZone: "UTC" } });
  const step = await command("CreateStep", { planId, ordinal: 3, title: "Verify source contents", expectedResult: "Synthetic browser check", requiredChecks });
  await command("StartPlan", { planId }, 0);
  const claim = await command("ClaimStepAttempt", { stepId: step.stepId, sessionId: crypto.randomUUID(), sourceId: "browser-fixture" }, 1);
  const lease = { stepId: step.stepId, attemptId: claim.attemptId, fence: claim.fence };
  await command("StartStep", lease, 1);
  return lease;
}
const legacyLease = await createRunningStep(legacyPlan, "Historical prose report");
now += 60000;
await command("RecordStepResult", { ...legacyLease, outcome: "DONE", summary: "Synthetic prose report without source evidence" }, 2);
await command("PausePlan", { planId: legacyPlan }, 1);
const snapshotLease = await createRunningStep(snapshotPlan, "Snapshot source result");
now += 60000;
const artifactDir = resolve(process.env.UI_ACCEPTANCE_ARTIFACT_DIR || "/tmp/tracker-source-browser", "source");
mkdirSync(artifactDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => { window.__confirmChoice = false; window.confirm = () => window.__confirmChoice; });
const page = await context.newPage(), posts = [], errors = [];
page.setDefaultTimeout(5000);
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", async route => {
  const request = route.request(), url = new URL(request.url());
  assert.equal(url.origin, origin, "production/external traffic is forbidden in this fixture");
  if (request.method() === "POST") posts.push({ path: url.pathname, body: request.postDataJSON() });
  const response = await fetchLocal(url.pathname + url.search, { method: request.method(), ...(request.postData() ? { body: request.postData() } : {}) });
  if (response.status >= 400) console.error(url.pathname, response.status, await response.clone().text());
  await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
});
try {
  await page.goto(origin);
  await page.locator('#plans[data-loaded="true"]').waitFor({ state: "attached" });
  assert.equal(await page.getByRole("button",{name:"Репозитории",exact:true}).count(),0);
  assert.equal(await page.locator('#repoIds,#sync,#repos,#overviewRepo,#planRepo,#analyticsRepo').count(),0);
  await page.locator('.nav [data-view="plans"]').click();
  const count = posts.length;
  const legacyRow = page.locator('#plans [data-plan-id="' + legacyPlan + '"]');
  assert.equal(await legacyRow.getByRole("button", { name: "Завершить", exact: true }).count(), 0);
  await legacyRow.getByRole("button", { name: "Условия завершения", exact: true }).click();
  const legacyCard = page.locator('.tracker-card[data-step-id="' + legacyLease.stepId + '"]');
  await legacyCard.locator(".tracker-card-summary").waitFor();
  assert.match(await legacyCard.locator(".tracker-card-summary").innerText(), /0\/4.*Не готов к завершению/);
  assert.equal(await legacyCard.locator(".tracker-card-status").innerText(), "Не готов к завершению");
  assert.match(await legacyCard.innerText(), /Основание проверок отсутствует/);
  assert.equal(await legacyCard.locator('[data-tracker-form^="check:"]').count(), 0);
  await legacyCard.locator("[data-checkpoint-toggle]").click();
  assert.equal(await legacyCard.locator(".tracker-blockers").isVisible(), true);
  assert.equal(posts.length, count, "opening completion conditions and toggling do not write");
  const exception = page.locator('[data-tracker-form="finish-exception"]');
  await exception.locator("textarea").fill("Synthetic explicit exception");
  await exception.getByRole("button", { name: "Завершить план с исключением", exact: true }).click();
  assert.equal(posts.length, count, "cancelled exception sends no command");
  assert.equal(sqlite.prepare("SELECT status FROM plans WHERE plan_id=?").get(legacyPlan).status, "PAUSED");
  await page.locator("#backPlans").click();
  await page.locator('#plans [data-plan-id="' + snapshotPlan + '"] .plan-open').click();
  const card = page.locator('.tracker-card[data-step-id="' + snapshotLease.stepId + '"]');
  const resultForm = card.locator('[data-tracker-form^="result:"]');
  await resultForm.locator("textarea").fill("Synthetic snapshot result");
  await resultForm.locator('[data-draft-field="Digest снимка файлов"]').fill(digest);
  await resultForm.getByRole("button", { name: "Записать результат", exact: true }).click();
  await card.locator('[data-tracker-form^="check:"]').first().waitFor();
  const recorded = posts.find(post => post.body?.commandType === "RecordStepResult").body.payload;
  assert.equal(recorded.revisionSha, undefined);
  assert.deepEqual(recorded.sourceSnapshot, {kind:"SOURCE_SNAPSHOT",formatVersion:2,digest});
  assert.match(await card.innerText(), /Снимок файлов/);
  for (const key of requiredChecks) {
    const checkForm = card.locator('[data-tracker-form="check:' + snapshotLease.stepId + ':1:' + key + '"]');
    await checkForm.locator("textarea").fill("Synthetic fixture check evidence");
    await checkForm.locator('button[type="submit"]').click();
    await page.waitForFunction(({ stepId, key }) => [...document.querySelectorAll('.tracker-card[data-step-id="' + stepId + '"] .tracker-meta p')].some(node => node.textContent.includes(key + " · Пройдена")), { stepId: snapshotLease.stepId, key });
  }
  assert.match(await card.locator(".tracker-card-summary").innerText(), /4\/4.*Готов к завершению/);
  assert.equal(await card.locator(".tracker-card-status").innerText(), "Готов к завершению");
  assert.equal(await page.locator("#planDetail>.plan-completion-actions").getByRole("button", { name: "Завершить", exact: true }).count(), 1, "detail completion updates without reload");
  assert.equal(await page.locator('#plans [data-plan-id="' + snapshotPlan + '"] [data-finish-plan]').textContent(), "Завершить", "list completion updates without reload");
  assert.equal(await page.locator("#active [data-finish-plan]").textContent(), "Завершить", "active completion updates without reload");
  assert(posts.filter(post => post.body?.commandType === "RecordCheck").every(post => post.body.payload.testedSnapshotDigest === digest && post.body.payload.testedSha === undefined));
  const unitForm = () => card.locator('[data-tracker-form="check:' + snapshotLease.stepId + ':1:unit"]');
  await unitForm().locator("select").selectOption("NOT_RUN");
  assert.equal(await unitForm().locator('input[type="number"]').isDisabled(), true);
  await unitForm().locator('button[type="submit"]').click();
  await page.waitForFunction(stepId => document.querySelector('.tracker-card[data-step-id="' + stepId + '"] .tracker-card-summary')?.textContent.includes("3/4"), snapshotLease.stepId);
  assert.equal(await page.locator("#planDetail>.plan-completion-actions [data-finish-plan]").textContent(), "Условия завершения");
  assert.equal(await page.locator('#plans [data-plan-id="' + snapshotPlan + '"] [data-finish-plan]').textContent(), "Условия завершения");
  assert.equal(await page.locator("#active [data-finish-plan]").textContent(), "Условия завершения");
  const notRun = posts.filter(post => post.body?.commandType === "RecordCheck").at(-1).body.payload;
  assert.equal(notRun.status, "NOT_RUN");
  assert.equal(notRun.exitCode, undefined);
  await unitForm().locator("select").selectOption("PASSED");
  await unitForm().locator('button[type="submit"]').click();
  await page.waitForFunction(stepId => document.querySelector('.tracker-card[data-step-id="' + stepId + '"] .tracker-card-summary')?.textContent.includes("4/4"), snapshotLease.stepId);
  const widths = [];
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, "snapshot digest and labels must fit at " + width);
    widths.push({ width, overflow });
    await page.screenshot({ path: resolve(artifactDir, "snapshot-ready-" + width + ".png"), fullPage: true });
  }
  const beforeFinish = posts.length;
  await page.locator('#planDetail>.plan-completion-actions').getByRole("button", { name: "Завершить", exact: true }).click();
  assert.equal(posts.length, beforeFinish, "cancelled normal finish sends no command");
  await page.evaluate(() => { window.__confirmChoice = true; });
  await page.locator('#planDetail>.plan-completion-actions').getByRole("button", { name: "Завершить", exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => document.querySelector("#planDetail>p")?.textContent.includes("Завершён"));
  assert.equal(posts.filter(post => post.body?.commandType === "FinishPlan").length, 1, "duplicate click finishes once");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM work_intervals WHERE plan_id=? AND end_ms IS NULL").get(snapshotPlan).n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM commits").get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM tracker_finish_exceptions").get().n, 0);
  assert(!posts.some(post=>/Repository|Commit/.test(post.body.commandType)));
  assert(!posts.some(post=>/repositoryId|commitPolicy|pushPolicy|revisionSha|testedSha/.test(JSON.stringify(post.body))));
  assert.deepEqual(errors, []);
  const report = { passed: true, backend: "actual Worker + in-memory migrated SQLite", productionRequests: 0, widths, commands: posts.map(post => post.body.commandType), checks: ["source-less legacy block", "consistent badges and conditions", "snapshot result and checks", "repository-free evidence", "cancel normal/exception", "double-click finish", "no Git prerequisite", "closed timer"] };
  writeFileSync(resolve(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) { console.error(JSON.stringify({fixturePageErrors:errors,rows:await page.locator("#plans").innerHTML(),toast:await page.locator("#toast").innerText(),detail:(await page.locator("#planDetail").innerText()).slice(0,300)}));throw error; } finally { await browser.close(); sqlite.close(); }
