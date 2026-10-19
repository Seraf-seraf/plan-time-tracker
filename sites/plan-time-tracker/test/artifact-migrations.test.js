import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { context, running, result, ok, rows, migrations, check, PLAN } from "./fixtures/tracker-db.mjs";

const sourceDirectory = new URL("../drizzle/", import.meta.url);
const artifactDirectory = new URL("../dist/.openai/drizzle/", import.meta.url);

test("Sites artifact retains every canonical migration and metadata file byte-for-byte", () => {
  const files = readdirSync(sourceDirectory, { recursive: true }).sort();
  assert.deepEqual(readdirSync(artifactDirectory, { recursive: true }).sort(), files);
  for (const name of files.filter(name => statSync(new URL(name, sourceDirectory)).isFile())) {
    assert.deepEqual(readFileSync(new URL(name, artifactDirectory)), readFileSync(new URL(name, sourceDirectory)), name);
  }
});

test("packaged 0016 upgrades populated 0015 while retaining evidence, receipts and an unrelated live timer", async () => {
  const c = context(migrations.indexOf("0016_plan_deletion.sql"));
  const other = "22222222-2222-4222-8222-222222222222";
  try {
    const lease = await running(c);
    await result(c, lease);
    await ok(c, "RecordCheck", check(lease.stepId));
    await ok(c, "FinishPlan", { planId: PLAN }, 1);
    await running(c, ["unit"], other);
    c.advance(1000);
    const before = rows(c);
    c.db.sqlite.exec(readFileSync(new URL("0016_plan_deletion.sql", artifactDirectory), "utf8"));
    const after = rows(c);
    after.plans = after.plans.map(value => {
      const row = JSON.parse(value);
      assert.equal(row.deleted_at, null);
      delete row.deleted_at;
      return JSON.stringify(row);
    });
    assert.deepEqual(after, before);
    assert.deepEqual(c.db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    await ok(c, "DeletePlan", { planId: PLAN }, 2);
    await ok(c, "RestorePlan", { planId: PLAN }, 3);
    const otherPlan = c.db.sqlite.prepare("SELECT status,version FROM plans WHERE plan_id=?").get(other);
    assert.equal(otherPlan.status, "RUNNING");
    assert.equal(otherPlan.version, 1);
    assert.equal(c.db.sqlite.prepare("SELECT COUNT(*) n FROM work_intervals WHERE plan_id=? AND end_ms IS NULL").get(other).n, 1);
  } finally { c.close(); }
});
