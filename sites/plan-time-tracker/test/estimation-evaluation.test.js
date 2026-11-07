import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreEstimateCases } from "../worker/index.js";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_DIR, "scripts", "evaluate-estimates.mjs");
const TEMP_ROOT = "/tmp/tracker-estimation";
const PROFILE = Object.freeze({
  workKind: "RUN_EXISTING_PROCESS",
  reuseState: "READY",
  doneBoundary: "LOCAL_VERIFIED",
});

function training(caseId, activeMs, overrides = {}) {
  return {
    caseId,
    planGroupId: `train-group-${caseId}`,
    availableAtMs: 1,
    profile: { ...PROFILE },
    scopeStability: "STABLE",
    timeCoverage: "COMPLETE",
    checksConfirmed: true,
    activeMs,
    ...overrides,
  };
}

function testCase(caseId, overrides = {}) {
  return {
    caseId,
    planGroupId: `test-group-${caseId}`,
    forecastAtMs: 10,
    profile: { ...PROFILE },
    eligible: true,
    exclusionReason: null,
    actualMs: 20,
    expertPointMs: 30,
    expertRecordedAtMs: 9,
    ...overrides,
  };
}

function baseInput() {
  return {
    formatVersion: 1,
    training: [training("train-a", 10), training("train-b", 20)],
    testCases: [
      testCase("accepted", { actualMs: 18 }),
      testCase("unfinished", { actualMs: null, expertPointMs: null, expertRecordedAtMs: null }),
      testCase("changed", { eligible: false, exclusionReason: "scope changed" }),
      testCase("rejected", { eligible: false, exclusionReason: "not accepted" }),
    ],
  };
}

function runCli(input, options = {}) {
  mkdirSync(TEMP_ROOT, { recursive: true });
  const directory = mkdtempSync(path.join(TEMP_ROOT, "cases-"));
  const inputPath = path.join(directory, "cases.json");
  try {
    if (options.raw !== undefined) writeFileSync(inputPath, options.raw);
    else writeFileSync(inputPath, JSON.stringify(input));
    const args = [CLI_PATH, inputPath, ...(options.extraArgs || [])];
    const result = spawnSync(process.execPath, args, {
      cwd: REPO_DIR,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env },
    });
    return { ...result, inputPath, stdoutJson: result.stdout ? JSON.parse(result.stdout) : null };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function validRun(input = baseInput()) {
  const result = runCli(input);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdoutJson;
}

test("CLI emits the versioned report and preserves accepted, excluded, and unfinished cases", () => {
  const report = validRun();
  assert.deepEqual(Object.keys(report), [
    "formatVersion", "sourceAuthority", "methodVersion", "estimand", "predictions", "excludedCases", "metrics", "pairedMetrics",
  ]);
  assert.equal(report.formatVersion, 1);
  assert.equal(report.sourceAuthority, "EXTERNAL_FIXTURE");
  assert.equal(report.methodVersion, 1);
  assert.equal(report.estimand, "ACCEPTED_UNCHANGED_SCOPE");
  assert.deepEqual(report.predictions.map(({ caseId }) => caseId), ["accepted", "unfinished"]);
  assert.deepEqual(report.predictions[0], {
    caseId: "accepted", actualMs: 18, globalPointMs: 15, comparablePointMs: 15, expertPointMs: 30,
    globalSampleCount: 2, comparableSampleCount: 2,
  });
  assert.equal(report.predictions[1].actualMs, null);
  assert.deepEqual(report.excludedCases, [
    { caseId: "changed", reason: "scope changed" },
    { caseId: "rejected", reason: "not accepted" },
  ]);
  assert.equal(report.metrics.global.caseCount, 2);
  assert.equal(report.metrics.global.actualKnownCount, 1);
  assert.equal(report.metrics.global.predictionCount, 2);
  assert.deepEqual(report.pairedMetrics.baselines.caseIds, ["accepted"]);
  assert.deepEqual(report.pairedMetrics.allMethods.caseIds, ["accepted"]);
});

test("empty arrays and insufficient training return a valid report with no fabricated points", () => {
  const empty = validRun({ formatVersion: 1, training: [], testCases: [] });
  assert.deepEqual(empty.predictions, []);
  assert.deepEqual(empty.excludedCases, []);
  assert.equal(empty.metrics.global.forecastRate, null);
  assert.deepEqual(empty.pairedMetrics.baselines.caseIds, []);
  assert.equal(empty.pairedMetrics.baselines.comparable.maeMs, null);

  const noTraining = validRun({ formatVersion: 1, training: [], testCases: [testCase("no-data", { expertPointMs: null, expertRecordedAtMs: null })] });
  assert.equal(noTraining.predictions[0].globalPointMs, null);
  assert.equal(noTraining.predictions[0].comparablePointMs, null);
  assert.equal(noTraining.predictions[0].globalSampleCount, 0);
  assert.equal(noTraining.metrics.global.forecastRate, 0);

  const knownZero = validRun({
    formatVersion: 1,
    training: [training("zero", 0)],
    testCases: [testCase("zero-target", { expertPointMs: 0, expertRecordedAtMs: 10, forecastAtMs: 10, actualMs: 0 })],
  });
  assert.equal(knownZero.predictions[0].globalPointMs, 0);
  assert.equal(knownZero.predictions[0].comparablePointMs, 0);
  assert.equal(knownZero.metrics.global.forecastRate, 1);
  assert.equal(knownZero.metrics.global.wapePercent, null);
  assert.equal(knownZero.metrics.global.maeMs, 0);
});

test("changing only actual facts cannot change forecast points, counts, or prediction availability", () => {
  const original = baseInput();
  const altered = structuredClone(original);
  altered.testCases[0].actualMs = 9_999_999;
  altered.testCases[1].actualMs = 0;
  const first = validRun(original);
  const second = validRun(altered);
  const forecastOnly = report => report.predictions.map(({ caseId, globalPointMs, comparablePointMs, expertPointMs, globalSampleCount, comparableSampleCount }) => ({
    caseId, globalPointMs, comparablePointMs, expertPointMs, globalSampleCount, comparableSampleCount,
  }));
  assert.deepEqual(forecastOnly(first), forecastOnly(second));
});

test("training at or after a forecast cutoff cannot affect the prediction", () => {
  const original = baseInput();
  const baseline = validRun(original);
  const perturbed = structuredClone(original);
  perturbed.training.push(
    training("equal-cutoff", 500, { availableAtMs: 10 }),
    training("after-cutoff", 900, { availableAtMs: 11 }),
  );
  const changed = validRun(perturbed);
  assert.equal(changed.predictions[0].globalPointMs, baseline.predictions[0].globalPointMs);
  assert.equal(changed.predictions[0].comparablePointMs, baseline.predictions[0].comparablePointMs);
  assert.equal(changed.predictions[0].globalSampleCount, baseline.predictions[0].globalSampleCount);
  assert.equal(changed.predictions[0].comparableSampleCount, baseline.predictions[0].comparableSampleCount);
});

test("all baseline eligibility conditions are shared; comparable adds only the exact profile filter", () => {
  const profileMismatch = { ...PROFILE, workKind: "CREATE_MECHANISM" };
  const input = {
    formatVersion: 1,
    training: [
      training("usable-a", 10), training("usable-b", 30),
      training("mismatch", 100, { profile: profileMismatch }),
      training("unstable", 1000, { scopeStability: "CHANGED" }),
      training("partial", 2000, { timeCoverage: "PARTIAL" }),
      training("unchecked", 3000, { checksConfirmed: false }),
      training("unknown", 4000, { activeMs: null }),
    ],
    testCases: [testCase("target")],
  };
  const report = validRun(input);
  assert.equal(report.predictions[0].globalPointMs, 30);
  assert.equal(report.predictions[0].globalSampleCount, 3);
  assert.equal(report.predictions[0].comparablePointMs, 20);
  assert.equal(report.predictions[0].comparableSampleCount, 2);
});

test("report is canonical across permutations and paired methods use their own common case sets", () => {
  const input = baseInput();
  input.testCases.push(testCase("expert-missing", { actualMs: 40, expertPointMs: null, expertRecordedAtMs: null }));
  const original = validRun(input);
  const reversed = structuredClone(input);
  reversed.training.reverse();
  reversed.testCases.reverse();
  assert.deepEqual(validRun(reversed), original);
  assert.deepEqual(original.pairedMetrics.baselines.caseIds, ["accepted", "expert-missing"]);
  assert.deepEqual(original.pairedMetrics.allMethods.caseIds, ["accepted"]);
  assert.equal(original.pairedMetrics.baselines.global.caseCount, 2);
  assert.equal(original.pairedMetrics.allMethods.expert.caseCount, 1);
});

test("strict-audit arithmetic fixture preserves exact sums without claiming a blind evaluation", () => {
  const actual = [3_475_455, 883_125, 1_771_106];
  const forecastA = [12_240_000, 3_240_000, 16_200_000];
  const forecastB = [9_720_000, 2_700_000, 16_200_000];
  assert.equal(actual.reduce((sum, value) => sum + value, 0), 6_129_686);
  assert.equal(forecastA.reduce((sum, value) => sum + value, 0), 31_680_000);
  assert.equal(forecastB.reduce((sum, value) => sum + value, 0), 28_620_000);
  const scoreA = scoreEstimateCases(actual.map((actualMs, index) => ({ caseId: `T0${index + 6}`, actualMs, predictedMs: forecastA[index] })));
  const scoreB = scoreEstimateCases(actual.map((actualMs, index) => ({ caseId: `T0${index + 6}`, actualMs, predictedMs: forecastB[index] })));
  assert.equal(scoreA.caseCount, 3);
  assert.equal(scoreA.actualKnownCount, 3);
  assert.equal(scoreB.caseCount, 3);
  assert.equal(scoreB.actualKnownCount, 3);
});

test("input schema rejects unknown fields, duplicate identities/groups, coercions, and invalid expert timestamps", () => {
  const invalidInputs = [];
  invalidInputs.push({ ...baseInput(), unexpected: true });
  invalidInputs.push({ ...baseInput(), formatVersion: 2 });
  invalidInputs.push({ ...baseInput(), training: [training("a", 1, { activeMs: "1" })] });
  invalidInputs.push({ ...baseInput(), training: [training("a", 1, { checksConfirmed: "true" })] });
  invalidInputs.push({ ...baseInput(), training: [training("a", 1, { extra: true })] });
  invalidInputs.push({ ...baseInput(), testCases: [testCase("a", { expertRecordedAtMs: 11 })] });
  invalidInputs.push({ ...baseInput(), testCases: [testCase("a", { expertPointMs: null })] });
  invalidInputs.push({ ...baseInput(), testCases: [testCase("a", { eligible: false, exclusionReason: " " })] });
  invalidInputs.push({ ...baseInput(), testCases: [testCase("a", { eligible: true, exclusionReason: "changed" })] });
  invalidInputs.push({ ...baseInput(), training: [training("duplicate", 1)], testCases: [testCase("duplicate")] });
  invalidInputs.push({ ...baseInput(), training: [training("same-group", 1)], testCases: [testCase("test", { planGroupId: "train-group-same-group" })] });
  invalidInputs.push({ ...baseInput(), training: [training("a", 1), training("b", 2, { planGroupId: "train-group-a" })] });
  invalidInputs.push({ ...baseInput(), testCases: [testCase("a"), testCase("b", { planGroupId: "test-group-a" })] });
  invalidInputs.push({ ...baseInput(), testCases: [testCase("bad-id", { caseId: "кириллица" })] });
  invalidInputs.push({ ...baseInput(), testCases: [testCase("bad-time", { forecastAtMs: Number.MAX_SAFE_INTEGER + 1 })] });

  for (const input of invalidInputs) {
    const result = runCli(input);
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /ошиб|некоррект|invalid|valid|CLI|JSON/i);
  }
});

test("CLI rejects malformed JSON, missing path, extra arguments, oversized input, and non-files", () => {
  const malformed = runCli(null, { raw: "{" });
  assert.notEqual(malformed.status, 0);
  assert.equal(malformed.stdout, "");
  assert.notEqual(malformed.stderr, "");

  const noPath = spawnSync(process.execPath, [CLI_PATH], { cwd: REPO_DIR, encoding: "utf8" });
  assert.notEqual(noPath.status, 0);
  assert.equal(noPath.stdout, "");
  assert.notEqual(noPath.stderr, "");

  const extra = runCli({ formatVersion: 1, training: [], testCases: [] }, { extraArgs: ["unexpected"] });
  assert.notEqual(extra.status, 0);
  assert.equal(extra.stdout, "");

  const tooLarge = runCli(null, { raw: " ".repeat(2 * 1024 * 1024 + 1) });
  assert.notEqual(tooLarge.status, 0);
  assert.equal(tooLarge.stdout, "");
  assert.notEqual(tooLarge.stderr, "");

  mkdirSync(TEMP_ROOT, { recursive: true });
  const directory = mkdtempSync(path.join(TEMP_ROOT, "directory-"));
  try {
    const result = spawnSync(process.execPath, [CLI_PATH, directory], { cwd: REPO_DIR, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.notEqual(result.stderr, "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("same group cannot cross train and test, and expert points must be recorded before forecast", () => {
  const invalidGroup = baseInput();
  invalidGroup.testCases[0].planGroupId = invalidGroup.training[0].planGroupId;
  const groupResult = runCli(invalidGroup);
  assert.notEqual(groupResult.status, 0);

  const lateExpert = baseInput();
  lateExpert.testCases[0].expertRecordedAtMs = lateExpert.testCases[0].forecastAtMs + 1;
  const expertResult = runCli(lateExpert);
  assert.notEqual(expertResult.status, 0);

  const recordedAtCutoff = baseInput();
  recordedAtCutoff.testCases[0].expertRecordedAtMs = recordedAtCutoff.testCases[0].forecastAtMs;
  assert.equal(validRun(recordedAtCutoff).predictions[0].expertPointMs, recordedAtCutoff.testCases[0].expertPointMs);
});

test("array bounds and aggregate safe-integer overflow fail closed", () => {
  const tooManyTraining = { formatVersion: 1, training: Array.from({ length: 1001 }, (_, index) => training(`train-${index}`, 1)), testCases: [] };
  const trainingResult = runCli(tooManyTraining);
  assert.notEqual(trainingResult.status, 0);
  assert.equal(trainingResult.stdout, "");

  const tooManyTests = { formatVersion: 1, training: [], testCases: Array.from({ length: 1001 }, (_, index) => testCase(`test-${index}`)) };
  const testResult = runCli(tooManyTests);
  assert.notEqual(testResult.status, 0);
  assert.equal(testResult.stdout, "");

  const overflowingScore = {
    formatVersion: 1,
    training: [training("zero", 0)],
    testCases: [
      testCase("large-fact", { actualMs: Number.MAX_SAFE_INTEGER, expertPointMs: null, expertRecordedAtMs: null }),
      testCase("additional-fact", { actualMs: 1, expertPointMs: null, expertRecordedAtMs: null }),
    ],
  };
  const overflowResult = runCli(overflowingScore);
  assert.notEqual(overflowResult.status, 0);
  assert.equal(overflowResult.stdout, "");
  assert.notEqual(overflowResult.stderr, "");
});

test("successful CLI output is one JSON document and uses no timestamps from runtime", () => {
  const run = runCli(baseInput());
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim().split("\n").length, 1);
  const report = JSON.parse(run.stdout);
  assert.equal(Object.hasOwn(report, "readAtMs"), false);
  assert.equal(Object.hasOwn(report, "generatedAtMs"), false);
});
