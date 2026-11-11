// Removed attempt controls must not return for old, expired or paused work.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { context, running, ok, OWNER, PLAN } from "./fixtures/tracker-db.mjs";
const modulePath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(
  modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath
);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const scenario of ["CLOSED", "ABANDONED", "EXPIRED", "PAUSED"]) {
    const c = context();
    c.advance(Date.now() - c.now());
    const lease = await running(c);
    if (["CLOSED", "ABANDONED"].includes(scenario))
      await ok(c, "CloseStepAttempt", {
        ...lease,
        disposition: scenario,
        reason: "Fixture interrupted work",
      });
    if (scenario === "EXPIRED") c.advance(600001);
    if (scenario === "PAUSED") await ok(c, "PausePlan", { planId: PLAN }, 1);
    const before = c.db.sqlite.prepare("SELECT * FROM work_intervals").all();
    const page = await browser.newPage({
        viewport: { width: 390, height: 1000 },
      }),
      errors = [],
      writes = [];
    page.setDefaultTimeout(5000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", async (route) => {
      const r = route.request();
      assert.equal(new URL(r.url()).origin, "http://localhost");
      const body = r.postDataJSON();
      if (body?.commandType) writes.push(body);
      const response = await c.worker.fetch(
        new Request(r.url(), {
          method: r.method(),
          headers: {
            "content-type": "application/json",
            "oai-authenticated-user-id": OWNER,
          },
          ...(r.postData() ? { body: r.postData() } : {}),
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
      await page.locator('[data-view="plans"]').click();
      await page.locator("#plans .plan-open").first().click();
      const card = page.locator(".tracker-card");
      await card.waitFor();
      assert.equal(await card.locator("form,input,textarea,select").count(), 0);
      assert.equal(
        await card.locator(".tracker-card-status").textContent(),
        "Выполняется",
      );
      assert.match(await card.innerText(), /Checked source/);
      assert(!/fence|lease|sha256:|попытк/i.test(await card.innerText()));
      assert.deepEqual(writes, []);
      assert.deepEqual(
        c.db.sqlite.prepare("SELECT * FROM work_intervals").all(),
        before,
      );
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
      c.close();
    }
  }
  console.log(
    JSON.stringify({
      passed: true,
      scenarios: ["closed", "abandoned", "expired", "paused"],
      checks: [
        "historical prose stays readable",
        "technical controls absent",
        "reading never changes time",
      ],
    }),
  );
} finally {
  await browser.close();
}
