// Actual Worker + isolated SQLite; the browser cannot contact production.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { context, OWNER, ok, call, command } from "./fixtures/tracker-db.mjs";
import { planText } from "./fixtures/plan-document.mjs";
const modulePath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(
  modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath
);
const c = context();
c.advance(Date.now() - c.now());
const artifactDir = resolve(
  process.env.UI_ACCEPTANCE_ARTIFACT_DIR || "/tmp/tracker-ui",
  "document",
);
mkdirSync(artifactDir, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || "/usr/bin/chromium",
  args: ["--no-sandbox"],
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors = [],
  posts = [];
let loseStatusAck = true;
page.setDefaultTimeout(6000);
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", async (route) => {
  const request = route.request(),
    url = new URL(request.url());
  assert.equal(url.origin, "http://localhost");
  const body = request.postDataJSON();
  if (body) posts.push(body);
  const response = await c.worker.fetch(
    new Request(request.url(), {
      method: request.method(),
      headers: {
        "content-type": "application/json",
        "oai-authenticated-user-id": OWNER,
      },
      ...(request.postData() ? { body: request.postData() } : {}),
    }),
    { DB: c.db },
  );
  if (body?.commandType === "SetStepStatus" && loseStatusAck) {
    loseStatusAck = false;
    return route.abort("failed");
  }
  await route.fulfill({
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  });
});
try {
  await page.goto("http://localhost");
  await page.locator("#newPlan").click();
  assert.equal(
    await page.getByLabel("Критерии приёмки", { exact: true }).count(),
    0,
  );
  await page
    .getByLabel("Название", { exact: true })
    .fill("План и статусы этапов");
  await page.getByLabel("Текст плана", { exact: true }).fill(planText);
  await page.locator("#create button.primary").click();
  await page.locator("#modal").waitFor({ state: "hidden" });
  const planId = c.db.sqlite.prepare("SELECT plan_id FROM plans").get().plan_id;
  assert.equal(
    c.db.sqlite.prepare("SELECT COUNT(*) n FROM work_intervals").get().n,
    0,
  );
  await page.locator('[data-view="plans"]').click();
  await page.locator("#plans .plan-open").first().click();
  await page.locator(".document-step").first().waitFor();
  assert.equal(await page.locator(".document-step").count(), 2);
  assert.equal(
    await page.locator('[data-tracker-form="create-step"]').count(),
    0,
  );
  assert.equal(
    await page.getByText("Digest проверенного снимка", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.locator(".document-plan .tracker-form").count(),
    0,
    "planned text is readable before starting",
  );
  await page.getByText("Исходный текст", { exact: true }).click();
  assert.equal(
    await page.getByLabel("Исходный текст плана", { exact: true }).inputValue(),
    planText,
  );
  await page.getByText("Исходный текст", { exact: true }).click();
  await page.locator("#backPlans").click();
  await page
    .locator('#plans [data-plan-id="' + planId + '"] button')
    .filter({ hasText: "Запустить" })
    .click();
  await page.locator("#plans .plan-open").first().click();
  await page.locator(".step-status-form").first().waitFor();
  const first = page.locator(".document-step").first();
  await first
    .getByLabel("Статус этапа", { exact: true })
    .selectOption("RUNNING");
  await first
    .getByRole("button", { name: "Сохранить статус", exact: true })
    .click();
  await first.locator(".form-error").waitFor({ state: "visible" });
  await first
    .getByRole("button", { name: "Сохранить статус", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector(".document-step .tracker-card-status")
        ?.textContent === "Выполняется",
  );
  assert.equal(await page.locator("#toast").isVisible(),false,"visible status update needs no overlapping toast");
  const statusPosts = posts.filter((p) => p.commandType === "SetStepStatus");
  assert.deepEqual(
    statusPosts[0],
    statusPosts[1],
    "lost response retries the exact command",
  );
  // Draft belongs to this step and survives a server refresh.
  await first
    .getByLabel("Статус этапа", { exact: true })
    .selectOption("BLOCKED");
  await page
    .getByRole("button", { name: "Обновить этапы", exact: true })
    .click();
  await first.getByLabel("Статус этапа", { exact: true }).waitFor();
  assert.equal(
    await first.getByLabel("Статус этапа", { exact: true }).inputValue(),
    "BLOCKED",
  );
  const geometry = [];
  for (const width of [320, 360, 390, 768, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    const sizes = await page.evaluate(() => {
      const size = (selector) =>
        parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
      return {
        width: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        h1: size("h1"),
        h2: size("#planDetail>h2"),
        h3: size(".document-step .tracker-card-toggle>strong"),
        h4: size(".document-step .plan-prose h4"),
        body: size(".document-step .plan-prose p"),
        label: size(".step-status-form label"),
        input: size(".step-status-form select"),
      };
    });
    assert.equal(sizes.overflow, false, JSON.stringify(sizes));
    for(const header of await page.locator(".plan-prose th").all())assert.equal(await header.evaluate(node=>getComputedStyle(node).whiteSpace),"nowrap");
    assert(
      sizes.h1 > sizes.h2 &&
        sizes.h2 > sizes.h3 &&
        sizes.h3 > sizes.h4 &&
        sizes.h4 > sizes.body,
      JSON.stringify(sizes),
    );
    assert(sizes.body >= 16 && sizes.input >= 16);
    geometry.push(sizes);
    await page.locator(".document-step").first().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve(artifactDir, "plan-" + width + ".png"),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await first.getByLabel("Статус этапа", { exact: true }).selectOption("DONE");
  await first
    .getByRole("button", { name: "Сохранить статус", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector(".document-step .tracker-card-status")
        ?.textContent === "Завершён",
  );
  await page.reload();
  await page.locator('[data-view="plans"]').click();
  await page.locator("#plans .plan-open").first().click();
  await page.waitForFunction(
    () =>
      document.querySelector(".document-step .tracker-card-status")
        ?.textContent === "Завершён",
  );
  const source = (await call(c, "/api/plans/" + planId)).value.plan.planText;
  assert.equal(source, planText);
  assert.equal(
    c.db.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='step_attempts'").get().n,
    0,
  );
  // Raw HTML and unsafe URLs in a plan remain text.
  const unsafe = await ok(c, "CreatePlan", {
    title: "Проверка текста",
    planText:
      "## Этап 1. Проверить текст\n\n<img src=x onerror=alert(1)>\n\n[Открыть](javascript:alert)\n",
    planCreatedAt: { precision: "dateOnly", on: "2026-11-11", timeZone: "UTC" },
  });
  await page.reload();
  await page.locator('[data-view="plans"]').click();
  await page
    .locator('#plans [data-plan-id="' + unsafe.planId + '"] .plan-open')
    .click();
  await page.locator(".document-step").waitFor();
  assert.equal(
    await page
      .locator(".plan-prose img,.plan-prose script,.plan-prose a")
      .count(),
    0,
  );
  assert.match(
    await page.locator(".document-step").innerText(),
    /<img src=x onerror=alert\(1\)>/,
  );
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    backend: "actual Worker + migrated SQLite",
    productionRequests: 0,
    geometry,
    checks: [
      "full source preserved",
      "no synthetic step fields",
      "status save and exact replay",
      "draft preserved",
      "reload persists status",
      "heading hierarchy",
      "responsive reading",
      "unsafe Markdown stays text",
    ],
  };
  writeFileSync(
    resolve(artifactDir, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  c.close();
}
