// Historical evidence remains on the server; the UI only reads prose and status.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  context,
  OWNER,
  PLAN,
  running,
  result,
  check,
  ok,
} from "./fixtures/tracker-db.mjs";
const modulePath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(
  modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath
);
const c = context();
c.advance(Date.now() - c.now());
const lease = await running(c, ["unit"]);
await result(c, lease);
const artifacts = resolve(
  process.env.UI_ACCEPTANCE_ARTIFACT_DIR || "/tmp/tracker-ui",
  "source",
);
mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || "/usr/bin/chromium",
  args: ["--no-sandbox"],
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  posts = [],
  errors = [];
page.setDefaultTimeout(5000);
await page.addInitScript(() => {
  window.__confirmChoice = false;
  window.confirm = () => window.__confirmChoice;
});
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/*", async (route) => {
  const request = route.request(),
    url = new URL(request.url());
  assert.equal(url.origin, "http://localhost");
  const body = request.postDataJSON();
  if (body?.commandType) posts.push(body);
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
  await route.fulfill({
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  });
});
try {
  await page.goto("http://localhost");
  await page.locator("#active .plan-open").first().click();
  const card = page.locator(".tracker-card");
  await card.waitFor();
  assert.match(await card.innerText(), /Checked source/);
  assert.match(await card.innerText(), /Synthetic checked result/);
  assert.equal(await card.locator("input,textarea,select,form").count(), 0);
  assert.equal(
    await page.getByText("Подробности проверок", { exact: true }).count(),
    0,
  );
  assert(
    !/sha256:|Digest|fence|lease|Код завершения|evidence summary/.test(
      await card.innerText(),
    ),
  );
  assert.equal(
    await page
      .locator("#planDetail>.plan-completion-actions [data-finish-plan]")
      .textContent(),
    "Условия завершения",
  );
  assert.equal(posts.length, 0);
  await ok(c, "RecordCheck", check(lease.stepId));
  await page
    .getByRole("button", { name: "Обновить этапы", exact: true })
    .click();
  await page.getByText("Готов к завершению", { exact: true }).waitFor();
  assert.equal(
    await page
      .locator("#planDetail>.plan-completion-actions [data-finish-plan]")
      .textContent(),
    "Завершить",
  );
  await ok(c, "RecordCheck", check(lease.stepId, "NOT_RUN"));
  await page
    .getByRole("button", { name: "Обновить этапы", exact: true })
    .click();
  await page
    .getByText("Этап ещё не готов к завершению", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator("#planDetail>.plan-completion-actions [data-finish-plan]")
      .textContent(),
    "Условия завершения",
  );
  await page.locator(".finish-exception>summary").click();
  await page
    .locator('[data-tracker-form="finish-exception"] textarea')
    .fill("Explicit fixture exception");
  await page
    .getByRole("button", { name: "Завершить досрочно", exact: true })
    .click();
  assert.equal(posts.length, 0, "cancelled finish writes nothing");
  await ok(c, "RecordCheck", check(lease.stepId));
  await page
    .getByRole("button", { name: "Обновить этапы", exact: true })
    .click();
  await page.getByText("Готов к завершению", { exact: true }).waitFor();
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: resolve(artifacts, "legacy-prose-" + width + ".png"),
      fullPage: true,
    });
  }
  await page
    .locator("#planDetail>.plan-completion-actions [data-finish-plan]")
    .click();
  assert.equal(posts.length, 0);
  await page.evaluate(() => {
    window.__confirmChoice = true;
  });
  await page
    .locator("#planDetail>.plan-completion-actions [data-finish-plan]")
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await page.waitForFunction(() =>
    document.querySelector("#planDetail>p")?.textContent.includes("Завершён"),
  );
  assert.equal(posts.filter((p) => p.commandType === "FinishPlan").length, 1);
  assert.equal(
    c.db.sqlite
      .prepare("SELECT COUNT(*) n FROM work_intervals WHERE end_ms IS NULL")
      .get().n,
    0,
  );
  assert.equal(
    c.db.sqlite.prepare("SELECT COUNT(*) n FROM step_source_checks").get().n,
    3,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      backend: "actual Worker + SQLite",
      checks: [
        "historical text and result retained",
        "no technical fields or forms",
        "read-only inspection",
        "authoritative readiness refresh",
        "cancel and double-click finish",
        "evidence retained",
      ],
    }),
  );
} finally {
  await browser.close();
  c.close();
}
