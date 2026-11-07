#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calculateComparableEstimate, median, scoreEstimateCases } from "../worker/index.js";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 1000;
const ID_PATTERN = /^[\x20-\x7e]{1,128}$/;
const PROFILE_VALUES = Object.freeze({
  workKind: new Set(["CREATE_MECHANISM", "MODIFY_MECHANISM", "RUN_EXISTING_PROCESS", "VERIFY_EXISTING", "MIGRATE_DATA", "INVESTIGATE", "MIXED", "UNKNOWN"]),
  reuseState: new Set(["ABSENT", "PARTIAL", "READY", "UNKNOWN"]),
  doneBoundary: new Set(["ANALYSIS", "LOCAL_VERIFIED", "LOCAL_STAGED", "PUBLISHED", "DEPLOYED_VERIFIED", "UNKNOWN"]),
});
const TRAINING_KEYS = Object.freeze([
  "caseId", "planGroupId", "availableAtMs", "profile", "scopeStability", "timeCoverage", "checksConfirmed", "activeMs",
]);
const TEST_CASE_KEYS = Object.freeze([
  "caseId", "planGroupId", "forecastAtMs", "profile", "eligible", "exclusionReason", "actualMs", "expertPointMs", "expertRecordedAtMs",
]);

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requireExactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail(`${label} должен быть объектом.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} содержит отсутствующие или неизвестные поля.`);
  }
}

function requireId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value) || value.trim().length === 0) {
    fail(`${label} должен быть непустым ASCII ID длиной до 128 символов.`);
  }
}

function requireNonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} должен быть неотрицательным safe integer в миллисекундах.`);
}

function requireNullableNonnegativeSafeInteger(value, label) {
  if (value !== null) requireNonnegativeSafeInteger(value, label);
}

function requireProfile(profile, label) {
  requireExactKeys(profile, ["workKind", "reuseState", "doneBoundary"], label);
  for (const [field, values] of Object.entries(PROFILE_VALUES)) {
    if (!values.has(profile[field])) fail(`${label}.${field} содержит неподдерживаемое значение.`);
  }
}

function requireUniqueCaseAndGroupIds(rows, label, caseIds, groupIds) {
  for (const row of rows) {
    requireId(row.caseId, `${label}.caseId`);
    requireId(row.planGroupId, `${label}.planGroupId`);
    if (caseIds.has(row.caseId)) fail(`caseId ${row.caseId} повторяется во всём наборе.`);
    if (groupIds.has(row.planGroupId)) fail(`planGroupId ${row.planGroupId} повторяется или пересекает train/test.`);
    caseIds.add(row.caseId);
    groupIds.add(row.planGroupId);
  }
}

function validateInput(input) {
  requireExactKeys(input, ["formatVersion", "training", "testCases"], "Входной документ");
  if (input.formatVersion !== 1) fail("Поддерживается только formatVersion=1.");
  for (const [key, rows] of [["training", input.training], ["testCases", input.testCases]]) {
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) fail(`${key} должен быть массивом не более ${MAX_ROWS} строк.`);
  }

  const caseIds = new Set();
  const groupIds = new Set();
  for (const row of input.training) requireExactKeys(row, TRAINING_KEYS, "training row");
  requireUniqueCaseAndGroupIds(input.training, "training", caseIds, groupIds);
  for (const row of input.training) {
    requireNonnegativeSafeInteger(row.availableAtMs, "availableAtMs");
    requireProfile(row.profile, "training.profile");
    if (!["STABLE", "CHANGED", "UNKNOWN"].includes(row.scopeStability)) fail("scopeStability некорректен.");
    if (!["COMPLETE", "PARTIAL", "UNKNOWN"].includes(row.timeCoverage)) fail("timeCoverage некорректен.");
    if (typeof row.checksConfirmed !== "boolean") fail("checksConfirmed должен быть boolean.");
    requireNullableNonnegativeSafeInteger(row.activeMs, "activeMs");
  }

  for (const row of input.testCases) requireExactKeys(row, TEST_CASE_KEYS, "testCase row");
  requireUniqueCaseAndGroupIds(input.testCases, "testCases", caseIds, groupIds);
  for (const row of input.testCases) {
    requireNonnegativeSafeInteger(row.forecastAtMs, "forecastAtMs");
    requireProfile(row.profile, "testCase.profile");
    if (typeof row.eligible !== "boolean") fail("eligible должен быть boolean.");
    if (row.eligible) {
      if (row.exclusionReason !== null) fail("У допустимого test-case exclusionReason должен быть null.");
    } else if (typeof row.exclusionReason !== "string" || row.exclusionReason.trim().length === 0
      || Array.from(row.exclusionReason).length > 500) {
      fail("У исключённого test-case нужна причина длиной от 1 до 500 символов.");
    }
    requireNullableNonnegativeSafeInteger(row.actualMs, "actualMs");
    requireNullableNonnegativeSafeInteger(row.expertPointMs, "expertPointMs");
    requireNullableNonnegativeSafeInteger(row.expertRecordedAtMs, "expertRecordedAtMs");
    if (row.expertPointMs === null ? row.expertRecordedAtMs !== null : row.expertRecordedAtMs === null) {
      fail("expertRecordedAtMs обязателен только вместе с expertPointMs.");
    }
    if (row.expertRecordedAtMs !== null && row.expertRecordedAtMs > row.forecastAtMs) {
      fail("Экспертная точка записана позже forecastAtMs.");
    }
  }
  return input;
}

function isUsableTrainingRow(row, forecastAtMs) {
  return row.availableAtMs < forecastAtMs
    && row.activeMs !== null
    && row.scopeStability === "STABLE"
    && row.timeCoverage === "COMPLETE"
    && row.checksConfirmed === true;
}

function asComparableCandidate(row) {
  return {
    planId: row.caseId,
    requirementsDigest: null,
    profile: row.profile,
    decision: "INCLUDE",
    scopeStability: row.scopeStability,
    timeCoverage: row.timeCoverage,
    rationale: "frozen external sample",
    deleted: false,
    planStatus: "COMPLETED",
    firstStartedAtMs: null,
    finishedAtMs: null,
    sourceAvailableAtMs: row.availableAtMs,
    checksConfirmed: true,
    measurement: "COMPLETE",
    activeMs: row.activeMs,
    intervalCount: 0,
    intervalsDigest: null,
  };
}

function comparableEstimate(target, trainingRows) {
  return calculateComparableEstimate({
    methodVersion: 1,
    metric: "PLAN_ACTIVE",
    referenceCutoffMs: target.forecastAtMs,
    sourceAuthority: "EXTERNAL_FIXTURE",
    target: {
      planId: target.caseId,
      expectedRequirementsDigest: null,
      profile: target.profile,
    },
    candidates: trainingRows.map(asComparableCandidate),
  });
}

function metricCases(rows, predictionFor) {
  return rows.map((row) => ({ caseId: row.caseId, actualMs: row.actualMs, predictedMs: predictionFor(row) }));
}

function scoreByIds(rows, ids, predictionFor) {
  const selected = new Set(ids);
  return scoreEstimateCases(metricCases(rows.filter((row) => selected.has(row.caseId)), predictionFor));
}

function evaluate(inputValue) {
  const input = validateInput(inputValue);
  const eligibleTestCases = input.testCases.filter((row) => row.eligible)
    .sort((left, right) => left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0);
  const forecasts = new Map();
  eligibleTestCases.forEach((row) => {
    const usableTraining = input.training.filter((candidate) => isUsableTrainingRow(candidate, row.forecastAtMs));
    const comparable = comparableEstimate(row, usableTraining);
    const forecast = {
      caseId: row.caseId,
      globalPointMs: median(usableTraining.map((candidate) => candidate.activeMs)),
      comparablePointMs: comparable.pointMs,
      expertPointMs: row.expertPointMs,
      globalSampleCount: usableTraining.length,
      comparableSampleCount: comparable.sampleCount,
    };
    forecasts.set(row.caseId, forecast);
  });

  const predictions = eligibleTestCases.map((row) => ({ ...forecasts.get(row.caseId), actualMs: row.actualMs }));

  const excludedCases = input.testCases.filter((row) => !row.eligible)
    .map((row) => ({ caseId: row.caseId, reason: row.exclusionReason }))
    .sort((left, right) => left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0);
  const getForecast = (row) => forecasts.get(row.caseId);
  const globalPrediction = (row) => getForecast(row).globalPointMs;
  const comparablePrediction = (row) => getForecast(row).comparablePointMs;
  const expertPrediction = (row) => getForecast(row).expertPointMs;
  const metrics = {
    global: scoreEstimateCases(metricCases(eligibleTestCases, globalPrediction)),
    comparable: scoreEstimateCases(metricCases(eligibleTestCases, comparablePrediction)),
    expert: scoreEstimateCases(metricCases(eligibleTestCases, expertPrediction)),
  };

  const pairedBaselines = eligibleTestCases.filter((row) => {
    const forecast = forecasts.get(row.caseId);
    return row.actualMs !== null && forecast.globalPointMs !== null && forecast.comparablePointMs !== null;
  }).map((row) => row.caseId).sort();
  const pairedAllMethods = eligibleTestCases.filter((row) => {
    const forecast = forecasts.get(row.caseId);
    return row.actualMs !== null && forecast.globalPointMs !== null && forecast.comparablePointMs !== null && forecast.expertPointMs !== null;
  }).map((row) => row.caseId).sort();

  return {
    formatVersion: 1,
    sourceAuthority: "EXTERNAL_FIXTURE",
    methodVersion: 1,
    estimand: "ACCEPTED_UNCHANGED_SCOPE",
    predictions,
    excludedCases,
    metrics,
    pairedMetrics: {
      baselines: {
        caseIds: pairedBaselines,
        global: scoreByIds(eligibleTestCases, pairedBaselines, globalPrediction),
        comparable: scoreByIds(eligibleTestCases, pairedBaselines, comparablePrediction),
      },
      allMethods: {
        caseIds: pairedAllMethods,
        global: scoreByIds(eligibleTestCases, pairedAllMethods, globalPrediction),
        comparable: scoreByIds(eligibleTestCases, pairedAllMethods, comparablePrediction),
        expert: scoreByIds(eligibleTestCases, pairedAllMethods, expertPrediction),
      },
    },
  };
}

function readInputFile(inputPath) {
  const resolvedPath = path.resolve(inputPath);
  const fileSize = statSync(resolvedPath).size;
  if (!Number.isSafeInteger(fileSize) || fileSize > MAX_INPUT_BYTES) fail("Размер JSON-файла превышает 2 МиБ.");
  const raw = readFileSync(resolvedPath);
  if (raw.byteLength > MAX_INPUT_BYTES) fail("Размер JSON-файла превышает 2 МиБ.");
  const jsonText = raw.toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    fail("Файл содержит некорректный JSON.");
  }
  return parsed;
}

function main(args) {
  if (args.length !== 1 || args[0].length === 0) fail("Использование: node scripts/evaluate-estimates.mjs <один JSON-файл>.");
  const report = evaluate(readInputFile(args[0]));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Ошибка оценки: ${error instanceof Error ? error.message : "неизвестная ошибка"}\n`);
    process.exitCode = 1;
  }
}
