// Real Worker and migrated in-memory SQLite; all browser requests stay on localhost.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { context, OWNER, PLAN, ok, running } from "./fixtures/tracker-db.mjs";
const modulePath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const c = context(), B = "22222222-2222-4222-8222-222222222222";
c.advance(Date.parse("2026-10-15T10:00:00Z") - c.now());
const lease = await running(c);
await ok(c, "UpdatePlanMetadata", { planId: PLAN, title: "План A" }, 1);
await ok(c, "CreatePlan", { planId: B, title: "План B", planCreatedAt: { precision: "dateOnly", on: "2026-10-15", timeZone: "UTC" } });
await ok(c, "StartPlan", { planId: B }, 0);
for (let i = 0; i < 101; i++) {
  c.advance(1);const created = await ok(c, "CreatePlan", { title: "Удалённый пример " + i, planCreatedAt: { precision: "dateOnly", on: "2026-10-15", timeZone: "UTC" } });
  await ok(c, "DeletePlan", { planId: created.planId }, 0);
}
c.advance(60000);
const artifacts = resolve(process.env.UI_ACCEPTANCE_ARTIFACT_DIR || "/tmp/tracker-source-ui");mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
const posts = [], errors = [], paths = [];
let loseDelete = true, loseRestore = true, holdDelete = false, releaseDelete, failDeleted = true;
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", async route => {
  const request = route.request(), url = new URL(request.url());assert.equal(url.origin, "http://localhost", "external requests forbidden");
  paths.push(url.pathname + url.search);const body = request.postDataJSON();if (body) posts.push(body);
  if (url.pathname === "/api/plans" && url.searchParams.get("deleted") === "true" && failDeleted) {
    failDeleted = false;return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "Временная ошибка" } }) });
  }
  const response = await c.worker.fetch(new Request(request.url(), { method: request.method(), headers: { "content-type": "application/json", "oai-authenticated-user-id": OWNER }, ...(request.postData() ? { body: request.postData() } : {}) }), { DB: c.db });
  if (body?.commandType === "DeletePlan" && loseDelete) { loseDelete = false;return route.abort("failed"); }
  if (body?.commandType === "RestorePlan" && loseRestore) { loseRestore = false;return route.abort("failed"); }
  if (body?.commandType === "DeletePlan" && holdDelete) await new Promise(resolve => { releaseDelete = resolve; });
  return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
});
const active = id => page.locator('#active .active-plan[data-plan-id="' + id + '"]');
const confirm = () => page.once("dialog", dialog => dialog.accept());
const bState = () => JSON.stringify({ plan: c.db.sqlite.prepare("SELECT * FROM plans WHERE plan_id=?").get(B), intervals: c.db.sqlite.prepare("SELECT * FROM work_intervals WHERE plan_id=?").all(B) });
try {
  await page.goto("http://localhost");await active(PLAN).waitFor();const beforeB = bState();
  page.once("dialog", dialog => dialog.dismiss());await active(PLAN).getByRole("button", { name: "Удалить", exact: true }).click();
  assert.equal(posts.filter(p => p.commandType === "DeletePlan").length, 0);
  assert.equal(c.db.sqlite.prepare("SELECT deleted_at FROM plans WHERE plan_id=?").get(PLAN).deleted_at, null);
  confirm();await active(PLAN).getByRole("button", { name: "Удалить", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#toast").classList.contains("error"));
  confirm();await active(PLAN).getByRole("button", { name: "Удалить", exact: true }).click();await active(PLAN).waitFor({ state: "detached" });
  const deletes = posts.filter(p => p.commandType === "DeletePlan");assert.equal(deletes.length, 2);assert.deepEqual(deletes[0], deletes[1]);
  assert.equal(bState(), beforeB);assert.equal(c.db.sqlite.prepare("SELECT status FROM step_attempts WHERE attempt_id=?").get(lease.attemptId).status, "ABANDONED");
  await page.locator('[data-view="settings"]').click();
  await page.locator("#openDeleted").click();
  await page.locator('#deleted').getByRole("button", { name: "Повторить", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("#deleted>.row").length === 102);
  assert.equal(await page.locator('[data-view="settings"]').getAttribute("aria-current"), "page");
  assert(paths.some(path => path.startsWith("/api/plans?deleted=true&limit=100&cursor=")));
  await page.locator('#deleted [data-plan-id="' + PLAN + '"]').getByRole("button", { name: "План A", exact: true }).click();
  await page.getByText("План удалён. Этапы и история доступны только для чтения.", { exact: true }).waitFor();
  assert.equal(await page.locator("#backPlans").innerText(), "← К удалённым планам");
  assert.equal(await page.locator('[data-view="settings"]').getAttribute("aria-current"), "page");
  await page.locator("#backPlans").click();
  await page.locator('#deleted [data-plan-id="' + PLAN + '"] .plan-open').click();
  await page.getByText("План удалён. Этапы и история доступны только для чтения.", { exact: true }).waitFor();
  assert.equal(await page.locator("#planDetail form").count(), 0);
  assert.equal(await page.locator("#planDetail").getByRole("button", { name: "Восстановить", exact: true }).count(), 1);
  assert.equal(await page.locator("#planDetail").getByRole("button", { name: "Продолжить", exact: true }).count(), 0);
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: resolve(artifacts, "deletion-readonly-" + width + ".png") });
  }
  confirm();await page.locator("#planDetail").getByRole("button", { name: "Восстановить", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#toast").classList.contains("error"));
  confirm();await page.locator("#planDetail").getByRole("button", { name: "Восстановить", exact: true }).click();
  await page.locator("#planDetail").getByRole("button", { name: "Сохранить изменения", exact: true }).waitFor();
  const restores = posts.filter(p => p.commandType === "RestorePlan");assert.equal(restores.length, 2);assert.deepEqual(restores[0], restores[1]);
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM work_intervals WHERE plan_id=? AND end_ms IS NULL").get(PLAN).n, 0);
  assert.equal(c.db.sqlite.prepare("SELECT status FROM plans WHERE plan_id=?").get(PLAN).status, "PAUSED");
  assert.equal(await page.locator("#backPlans").innerText(), "← К удалённым планам");
  await page.locator("#backPlans").click();
  await page.waitForFunction(() => document.querySelectorAll("#deleted>.row").length === 101);
  assert.equal(await page.locator('#deleted [data-plan-id="' + PLAN + '"]').count(), 0);
  await page.locator("#backSettings").click();
  assert.equal(await page.locator("#view-settings").isVisible(), true);
  await page.locator('[data-view="plans"]').click();
  await page.locator('#plans [data-plan-id="' + PLAN + '"]').getByRole("button", { name: "Продолжить", exact: true }).click();
  assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) AS n FROM work_intervals WHERE plan_id=? AND end_ms IS NULL").get(PLAN).n, 1);
  // A delayed deletion reply must not navigate away from B or erase B's draft.
  await page.locator('#plans [data-plan-id="' + PLAN + '"]').getByRole("button", { name: "План A", exact: true }).click();
  holdDelete = true;confirm();await page.locator("#planDetail").getByRole("button", { name: "Удалить", exact: true }).click();
  await page.locator('[data-view="plans"]').click();
  await page.locator('#plans [data-plan-id="' + B + '"]').getByRole("button", { name: "План B", exact: true }).click();
  const draft = page.locator("#planDetail").getByRole("textbox", { name: "Описание", exact: true });await draft.fill("Черновик B");
  assert(releaseDelete);releaseDelete();
  await page.waitForFunction(() => document.querySelectorAll("#active>.active-plan").length === 1);
  assert.equal(await page.locator("#planDetail").getAttribute("data-plan-id"), B);assert.equal(await draft.inputValue(), "Черновик B");
  assert.equal(bState(), beforeB);assert.deepEqual(errors, []);
  // Actual list/overview/trash cards: every status, long titles and unbroken words.
  for (const status of ["PLANNED", "RUNNING", "PAUSED", "COMPLETED", "DELETED"]) {
    c.advance(1);
    const created = await ok(c, "CreatePlan", { title: (status + " · Очень длинное название плана для проверки расположения кнопок · " + "ДлинноеСлово".repeat(12)).slice(0, 200), planCreatedAt: { precision: "dateOnly", on: "2026-10-15", timeZone: "UTC" } });
    let version = 0;
    if (["RUNNING", "PAUSED", "COMPLETED"].includes(status)) {
      await ok(c, "StartPlan", { planId: created.planId }, version++);
      c.advance(60000);
    }
    if (status === "PAUSED") await ok(c, "PausePlan", { planId: created.planId }, version++);
    if (status === "COMPLETED") await ok(c, "FinishPlan", { planId: created.planId }, version++);
    if (status === "DELETED") await ok(c, "DeletePlan", { planId: created.planId }, version++);
  }
  await page.reload();await page.locator('#plans[data-loaded="true"]').waitFor({ state: "attached" });
  const layoutChecks = [];
  for (const width of [320, 360, 390, 600, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const view of ["plans", "overview", "deleted"]) {
      if (view === "deleted") {
        await page.locator('[data-view="settings"]').click();
        await page.locator("#openDeleted").click();
      } else await page.locator('[data-view="' + view + '"]').click();
      if (view === "deleted") await page.waitForFunction(() => document.querySelectorAll("#deleted>.row").length === 103);
      const geometry = await page.locator('#view-' + view).evaluate((root) => {
        const failures = [];
        for (const group of root.querySelectorAll(".row>.row-right,.active-plan>.actions")) {
          if (!group.checkVisibility()) continue;
          const controls = [...group.children], outer = group.getBoundingClientRect();
          for (const [index, control] of controls.entries()) {
            const box = control.getBoundingClientRect();
            if (box.left < outer.left - 1 || box.right > outer.right + 1 || control.scrollWidth > control.clientWidth + 1) failures.push("clipped control");
            for (const other of controls.slice(index + 1)) {
              const second = other.getBoundingClientRect();
              if (Math.min(box.right, second.right) - Math.max(box.left, second.left) > 1 && Math.min(box.bottom, second.bottom) - Math.max(box.top, second.top) > 1) failures.push("overlapping controls");
            }
          }
          if (innerWidth <= 600) {
            if (getComputedStyle(group).display !== "grid") failures.push("missing mobile grid");
            const buttons = [...group.querySelectorAll(":scope>button")];
            for (const button of buttons) if (button.getBoundingClientRect().height < 44) failures.push("small touch target");
            if (innerWidth > 360 && buttons.length > 1) {
              const [first, second] = buttons.map(button => button.getBoundingClientRect());
              if (Math.abs(first.top - second.top) > 1 || Math.abs(first.width - second.width) > 1 || Math.abs(second.left - first.right - 8) > 1) failures.push("unaligned first row");
            }
            const last = buttons.at(-1)?.getBoundingClientRect();
            if ((innerWidth <= 360 || buttons.length % 2 === 1) && last && Math.abs(last.width - outer.width) > 1) failures.push("unaligned final row");
          } else if (getComputedStyle(group).display !== "flex") failures.push("desktop layout changed");
        }
        return { failures, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.deepEqual(geometry, { failures: [], overflow: false }, view + " at " + width);
      await page.screenshot({ path: resolve(artifacts, "cards-" + view + "-" + width + ".png") });
      if (view === "overview") {
        await page.locator("#active>.active-plan").first().screenshot({ path: resolve(artifacts, "card-active-" + width + ".png") });
        await page.locator("#recent").screenshot({ path: resolve(artifacts, "cards-recent-" + width + ".png") });
      }
      if (view === "plans") await page.locator("#plans").screenshot({ path: resolve(artifacts, "cards-plans-" + width + ".png") });
      layoutChecks.push({ view, width, ...geometry });
    }
  }
  assert.deepEqual(errors, []);
  writeFileSync(resolve(artifacts, "card-layout-report.json"), JSON.stringify(layoutChecks, null, 2));
  writeFileSync(resolve(artifacts, "deletion-report.json"), JSON.stringify({ cancelled: true, exactDeleteReplay: true, exactRestoreReplay: true, deletedPagination: 102, readOnlyDetail: true, restoreDoesNotStart: true, unrelatedDraftPreserved: true, errors }, null, 2));
  console.log("Deletion browser verification passed: confirmation, trash pagination, exact replay, read-only history, stopped restore, independent draft and mobile/desktop card layout.");
} finally { await browser.close();c.close(); }
