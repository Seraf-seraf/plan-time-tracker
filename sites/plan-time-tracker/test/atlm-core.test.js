import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fitAtlmOls as fitAtlm, predictAtlmOls as predictAtlm } from "../worker/index.js";

const reference = JSON.parse(readFileSync(new URL("./fixtures/atlm-reference.json", import.meta.url), "utf8"));
const features = (changes = {}) => ({ workKind: "MODIFY_MECHANISM", reuseState: "PARTIAL", doneBoundary: "LOCAL_VERIFIED", outcomeCount: 1, contractCount: 0, verificationKindCount: 1, ...changes });
const rows = (n = 12, transform = (i) => 60_000) => Array.from({ length: n }, (_, i) => ({ sampleId: `sample-${i}`, planId: `plan-${i}`, capturedAt: i * 10000, sourceAvailableAt: i * 10000 + 5000, features: features(), actualMs: transform(i) }));

for (const fixture of reference.cases) test(`independent NumPy SVD reference: ${fixture.name}`, async () => {
  const result = await fitAtlm(fixture.rows);
  assert.equal(result.status, "AVAILABLE", JSON.stringify(result));
  const a = result.artifact;
  assert.deepEqual(a.transforms, fixture.expected.transforms);
  assert.deepEqual(a.columns, fixture.expected.columns);
  assert.equal(a.rank, fixture.expected.rank);
  a.coefficients.forEach((value, i) => assert.ok(Math.abs(value - fixture.expected.coefficients[i]) <= reference.reference.coefficientAbsoluteTolerance, `coefficient ${i}: ${value} vs ${fixture.expected.coefficients[i]}`));
  for (const expected of fixture.expected.predictions) {
    const prediction = predictAtlm(a, expected.features);
    assert.equal(prediction.status, "AVAILABLE", JSON.stringify(prediction));
    assert.ok(Math.abs(prediction.pointMs - expected.pointMs) <= reference.reference.predictionToleranceMs);
  }
});

test("artifacts are immutable, deterministic, serializable and preserve a frozen training manifest", async () => {
  const original = reference.cases[0].rows;
  const before = JSON.stringify(original);
  const first = await fitAtlm(original);
  const permuted = await fitAtlm([...original].reverse());
  assert.deepEqual(first, permuted);
  assert.equal(JSON.stringify(original), before);
  assert.ok(Object.isFrozen(first.artifact));
  assert.ok(Object.isFrozen(first.artifact.coefficients));
  assert.match(first.artifact.datasetDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.artifact.manifest.length, original.length);
  const restored = JSON.parse(JSON.stringify(first.artifact));
  assert.deepEqual(predictAtlm(restored, features()), predictAtlm(first.artifact, features()));
  const changed = structuredClone(original); changed[0].actualMs += 1;
  assert.notEqual((await fitAtlm(changed)).artifact.datasetDigest, first.artifact.datasetDigest);
});

test("real zero and constant target/predictors are supported without invented positive duration", async () => {
  const zero = await fitAtlm(rows(6, () => 0));
  assert.equal(zero.status, "AVAILABLE");
  assert.equal(zero.artifact.p, 1);
  assert.deepEqual(zero.artifact.constantPredictors, ["outcomeCount", "contractCount", "verificationKindCount"]);
  assert.equal(zero.artifact.transforms.target, "identity");
  assert.equal(predictAtlm(zero.artifact, features()).pointMs, 0);
  const short = await fitAtlm(rows(5));
  assert.equal(short.status, "AVAILABLE");
  assert.equal(short.artifact.residualDegreesOfFreedom, 4);
});

test("rank deficiency is explicit; no hidden ridge or selection removes correlated predictors", async () => {
  const input = rows(15).map((r, i) => ({ ...r, features: features({ outcomeCount: i, contractCount: i }), actualMs: 60000 * (i + 1) }));
  assert.equal((await fitAtlm(input)).reason, "RANK_DEFICIENT");
});

test("predict distinguishes unknown/missing features from a category not observed during training", async () => {
  const { artifact } = await fitAtlm(rows());
  assert.equal(predictAtlm(artifact, features({ workKind: "CREATE_MECHANISM" })).reason, "UNSUPPORTED_CATEGORY");
  const unknown = predictAtlm(artifact, features({ workKind: "UNKNOWN", contractCount: null }));
  assert.equal(unknown.reason, "INCOMPLETE_FEATURES");
  assert.deepEqual(unknown.missingFields, ["workKind", "contractCount"]);
  assert.equal(predictAtlm(artifact, features({ outcomeCount: -1 })).reason, "INVALID_FEATURES");
});

test("negative original predictions and invalid log/sqrt domains do not become zero", async () => {
  const sqrt = await fitAtlm(reference.cases.find(c => c.name === "sqrt target").rows);
  assert.equal(predictAtlm(sqrt.artifact, features({ outcomeCount: 0 })).reason, "INVALID_PREDICTION");
  const log = await fitAtlm(reference.cases.find(c => c.name === "log predictor").rows);
  assert.equal(predictAtlm(log.artifact, features({ outcomeCount: 0 })).reason, "INVALID_PREDICTION");
  const identity = structuredClone((await fitAtlm(rows())).artifact);
  identity.coefficients[0] = -1;
  assert.equal(predictAtlm(identity, features()).reason, "INVALID_PREDICTION");
});

test("overflow and malformed saved artifacts have explicit failures", async () => {
  const { artifact } = await fitAtlm(rows());
  const overflow = structuredClone(artifact);
  overflow.transforms.target = "log"; overflow.coefficients[0] = 1000;
  assert.equal(predictAtlm(overflow, features()).reason, "INVALID_PREDICTION");
  for (const bad of [null, {}, { ...artifact, coefficients: [NaN] }, { ...artifact, coefficients: [] }, { ...artifact, featureSchemaVersion: "future" }]) {
    assert.equal(predictAtlm(bad, features()).reason, "INVALID_ARTIFACT");
  }
});

test("invalid and duplicate input is rejected, dataset limits never silently truncate", async () => {
  assert.equal((await fitAtlm([])).reason, "INSUFFICIENT_DATA");
  assert.equal((await fitAtlm(rows(5001))).reason, "DATASET_LIMIT_REACHED");
  const duplicate = rows(); duplicate[1].planId = duplicate[0].planId;
  assert.equal((await fitAtlm(duplicate)).reason, "INVALID_DATASET");
  const malformed = rows(); malformed[1].actualMs = -1;
  assert.equal((await fitAtlm(malformed)).reason, "INVALID_DATASET");
  const impossible = rows(); impossible[1].sourceAvailableAt = impossible[1].capturedAt - 1;
  assert.equal((await fitAtlm(impossible)).reason, "INVALID_DATASET");
  const maximum = await fitAtlm(rows(5000));
  assert.equal(maximum.status, "AVAILABLE");
  assert.equal(maximum.artifact.n, 5000);
});
