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
