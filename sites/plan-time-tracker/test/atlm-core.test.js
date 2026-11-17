import test from "node:test";
import assert from "node:assert/strict";
import { fitAtlmOls, predictAtlmOls, normalizeAgentTask } from "../worker/index.js";
import { taskV4 } from "./fixtures/tracker-db.mjs";

const base = normalizeAgentTask(taskV4()).features;
const features = (changes = {}) => ({ ...base, ...changes });
const rows = (n = 12, actual = () => 60000) => Array.from({ length: n }, (_, i) => ({
  sampleId: `sample-${i}`, planId: `plan-${i}`, capturedAt: i * 10000, sourceAvailableAt: i * 10000 + 5000,
  features: features(), actualMs: actual(i),
}));

test("OLS matches an independently calculated NumPy least-squares reference", async () => {
  const counts = [0, 1, 2, 4, 8], actual = [0, 70000, 140000, 310000, 720000];
  const samples = rows(5).map((row, i) => ({ ...row, features: features({ "components.MODIFY": counts[i] }), actualMs: actual[i] }));
  const fit = await fitAtlmOls(samples);
  assert.equal(fit.status, "AVAILABLE");
  assert.equal(fit.artifact.rank, 2);
  assert.ok(Math.abs(fit.artifact.coefficients[0] - 1.2722540986874245) < 1e-10);
  assert.ok(Math.abs(fit.artifact.coefficients[1] - 0.8760851462899597) < 1e-10);
  assert.equal(predictAtlmOls(fit.artifact, features({ "components.MODIFY": 3 })).pointMs, 231979);
});

test("artifacts are immutable, deterministic, serializable and keep their sample manifest", async () => {
  const samples = rows(6, i => i * 1000), before = JSON.stringify(samples);
  const first = await fitAtlmOls(samples), reversed = await fitAtlmOls([...samples].reverse());
  assert.deepEqual(first, reversed); assert.equal(JSON.stringify(samples), before);
  assert.ok(Object.isFrozen(first.artifact)); assert.ok(Object.isFrozen(first.artifact.coefficients));
  assert.match(first.artifact.datasetDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.artifact.manifest.length, samples.length);
  assert.deepEqual(predictAtlmOls(JSON.parse(JSON.stringify(first.artifact)), features()), predictAtlmOls(first.artifact, features()));
  const changed = structuredClone(samples); changed[0].actualMs++;
  assert.notEqual((await fitAtlmOls(changed)).artifact.datasetDigest, first.artifact.datasetDigest);
});

test("zero duration and constant predictors are supported", async () => {
  const zero = await fitAtlmOls(rows(6, () => 0));
  assert.equal(zero.status, "AVAILABLE"); assert.equal(zero.artifact.p, 1);
  assert.equal(predictAtlmOls(zero.artifact, features()).pointMs, 0);
});

test("OLS reports rank deficiency for correlated predictors", async () => {
  const samples = rows(15, i => 60000 * (i + 1)).map((row, i) => ({ ...row, features: features({ "components.MODIFY": i, "contracts.API": i }) }));
  assert.equal((await fitAtlmOls(samples)).reason, "RANK_DEFICIENT");
});

test("unknown additional facts remain usable and invalid input is rejected", async () => {
  const { artifact } = await fitAtlmOls(rows());
  assert.equal(predictAtlmOls(artifact, features({ "components.MODIFY": null })).reason, "INVALID_FEATURES");
  assert.equal(predictAtlmOls(artifact, features({ doneBoundary: "UNKNOWN" })).reason, "MISSING_REQUIRED_FEATURES");
  assert.equal(predictAtlmOls(artifact, features({ "components.MODIFY": -1 })).reason, "INVALID_FEATURES");
});

test("inverse transform clips negatives and rejects overflow and malformed artifacts", async () => {
  const { artifact } = await fitAtlmOls(rows());
  const negative = structuredClone(artifact); negative.coefficients[0] = -1;
  assert.equal(predictAtlmOls(negative, features()).pointMs, 0);
  const overflow = structuredClone(artifact); overflow.coefficients[0] = 1000;
  assert.equal(predictAtlmOls(overflow, features()).reason, "INVALID_PREDICTION");
  for (const bad of [null, {}, { ...artifact, coefficients: [NaN] }, { ...artifact, coefficients: [] }, { ...artifact, featureSchemaVersion: "future" }]) {
    assert.equal(predictAtlmOls(bad, features()).reason, "INVALID_ARTIFACT");
  }
});

test("invalid and duplicate observations and excessive datasets are rejected", async () => {
  assert.equal((await fitAtlmOls([])).reason, "INSUFFICIENT_DATA");
  assert.equal((await fitAtlmOls(rows(5001))).reason, "DATASET_LIMIT_REACHED");
  assert.equal((await fitAtlmOls([null])).reason, "INVALID_DATASET");
  const duplicate = rows(); duplicate[1].planId = duplicate[0].planId;
  assert.equal((await fitAtlmOls(duplicate)).reason, "INVALID_DATASET");
  const malformed = rows(); malformed[1].actualMs = -1;
  assert.equal((await fitAtlmOls(malformed)).reason, "INVALID_DATASET");
  const impossible = rows(); impossible[1].sourceAvailableAt = impossible[1].capturedAt - 1;
  assert.equal((await fitAtlmOls(impossible)).reason, "INVALID_DATASET");
  const maximum = await fitAtlmOls(rows(5000));
  assert.equal(maximum.status, "AVAILABLE"); assert.equal(maximum.artifact.n, 5000);
});
