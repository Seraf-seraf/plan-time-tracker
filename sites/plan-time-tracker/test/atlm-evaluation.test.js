import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitAtlm, predictAtlm, evaluateAtlmChronologically, selectAtlmEvaluationCases, evaluateAtlmCase, summarizeAtlmEvaluation } from "../worker/index.js";

const features = { workKind: "MODIFY_MECHANISM", reuseState: "PARTIAL", doneBoundary: "LOCAL_VERIFIED", outcomeCount: 1, contractCount: 0, verificationKindCount: 1 };
const rows = (n = 40) => Array.from({ length: n }, (_, i) => ({ sampleId: `sample-${String(i).padStart(3, "0")}`, planId: `plan-${String(i).padStart(3, "0")}`, capturedAt: i * 10000, sourceAvailableAt: i * 10000 + 5000, features: { ...features }, actualMs: 60000 }));
const options = { protocolVersion: 1, cutoff: 1_000_000 };

test("chronology uses strict source availability, excluding future facts, equality and the target", async () => {
  const input = rows(12);
  input[9].sourceAvailableAt = input[11].capturedAt;
  input[10].sourceAvailableAt = input[11].capturedAt + 1000;
  input[9].actualMs = 900000; input[10].actualMs = 900000;
  const result = await evaluateAtlmCase(input, input[11].sampleId, options);
  const fit = await fitAtlm(input.slice(0, 9));
  assert.equal(result.trainSampleCount, 9);
  assert.equal(result.trainDatasetDigest, fit.artifact.datasetDigest);
  assert.deepEqual(result.atlm, predictAtlm(fit.artifact, features));
  assert.equal(result.median.pointMs, 60000);
});

test("future outcomes cannot change historical predictions or learned preprocessing", async () => {
  const input = rows(30);
  input.forEach((r, i) => { r.features.outcomeCount = i % 12 + 1; r.actualMs = Math.round(Math.exp(1 + .2 * r.features.outcomeCount) * 60000); });
  const first = await evaluateAtlmCase(input, input[20].sampleId, options);
  for (let i = 20; i < input.length; i++) input[i].actualMs = i * 50_000_000;
  const later = await evaluateAtlmCase(input, input[20].sampleId, options);
  assert.deepEqual(later.atlm, first.atlm);
  assert.equal(later.trainDatasetDigest, first.trainDatasetDigest);
});

test("even-prefix half-millisecond medians use the integer-ms contract and remain scoreable", async () => {
  const input = rows(12);
  input.forEach((row, i) => { row.actualMs = 1000 + i % 2; });
  const report = await evaluateAtlmChronologically(input, options);
  assert.equal(report.status, "AVAILABLE");
  assert.equal(report.caseCount, 12);
  assert.equal(report.paired.caseCount, 6);
  // The exact arithmetic median is 1000.5; public forecasts round to integer ms.
  for (const i of [2, 4, 6, 8, 10]) assert.equal(report.cases[i].median.pointMs, 1001);
  for (const item of report.cases) {
    for (const prediction of [item.atlm, item.median]) {
      assert.ok(prediction.pointMs === null || Number.isSafeInteger(prediction.pointMs));
    }
  }
});

test("latest twenty cases are selected before prediction and misses reduce coverage", async () => {
  const input = rows(); input.at(-1).features.workKind = "CREATE_MECHANISM";
  const report = await evaluateAtlmChronologically(input, options);
  assert.equal(report.caseCount, 20);
  assert.deepEqual(report.cases.map(r => r.sampleId), input.slice(-20).map(r => r.sampleId));
  assert.equal(report.cases.at(-1).atlm.reason, "UNSUPPORTED_CATEGORY");
  assert.equal(report.metrics.atlm.forecastRate, 19 / 20);
  assert.equal(report.metrics.median.forecastRate, 1);
  assert.equal(report.paired.caseCount, 19);
  assert.equal(report.paired.atlm.maeMs, 0);
  assert.equal(report.paired.median.maeMs, 0);
});

test("checkpointed fold evaluation yields exactly the same report as one pass", async () => {
  const input = rows();
  const selection = selectAtlmEvaluationCases(input, options);
  const cases = [];
  for (const id of selection.caseSampleIds) cases.push(await evaluateAtlmCase(input, id, options));
  assert.deepEqual(summarizeAtlmEvaluation(cases, selection), await evaluateAtlmChronologically(input, options));
});

test("cutoff/exclusions, empty data and tiny validation are explicitly reported", async () => {
  const input = rows(8); input[0].features.workKind = "UNKNOWN";
  const report = await evaluateAtlmChronologically(input, { protocolVersion: 1, cutoff: input[6].sourceAvailableAt });
  assert.equal(report.caseCount, 6);
  assert.equal(report.excluded.length, 2);
  assert.ok(report.excluded.some(r => r.reason === "INCOMPLETE_FEATURES"));
  assert.ok(report.excluded.some(r => r.reason === "AFTER_CUTOFF"));
  assert.equal(report.candidateReady, false);
  const empty = await evaluateAtlmChronologically([], options);
  assert.equal(empty.caseCount, 0);
  assert.equal(empty.metrics.atlm.maeMs, null);
  assert.equal(empty.candidateReady, false);
  const zero = rows(30); zero.forEach(r => { r.actualMs = 0; });
  const z = await evaluateAtlmChronologically(zero, options);
  assert.equal(z.metrics.atlm.maeMs, 0);
  assert.equal(z.metrics.atlm.wapePercent, null);
  assert.equal(z.candidateReady, true);
});

test("revision duplicates and attempts to tune the fixed evaluation protocol reject", async () => {
  const input = rows(); input[1].planId = input[0].planId;
  assert.equal((await evaluateAtlmChronologically(input, options)).reason, "INVALID_DATASET");
  assert.equal((await evaluateAtlmChronologically(rows(), { ...options, maxCases: 1 })).reason, "INVALID_PROTOCOL");
});

test("CLI preserves source provenance, is read-only, and rejects malformed input", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "atlm-cli-"));
  const file = path.join(dir, "rows.json");
  const cli = fileURLToPath(new URL("../scripts/evaluate-atlm.mjs", import.meta.url));
  try {
    for (const sourceAuthority of ["SYNTHETIC", "OWNER_EXPORT"]) {
      const input = JSON.stringify({ formatVersion: 1, sourceAuthority, asOf: options.cutoff, rows: rows(), excluded: [] });
      writeFileSync(file, input);
      const run = spawnSync(process.execPath, [cli, file], { encoding: "utf8", timeout: 10000 });
      assert.equal(run.status, 0, run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.sourceAuthority, sourceAuthority);
      assert.equal(report.protocolVersion, 1);
      assert.equal(report.caseCount, 20);
      assert.equal(readFileSync(file, "utf8"), input);
    }
    writeFileSync(file, "{broken");
    const bad = spawnSync(process.execPath, [cli, file], { encoding: "utf8", timeout: 10000 });
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
