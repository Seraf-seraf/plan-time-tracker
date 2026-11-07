import test from "node:test";
import assert from "node:assert/strict";
import { AppError, calculateComparableEstimate, median, scoreEstimateCases } from "../worker/index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PROFILE = Object.freeze({ workKind: "RUN_EXISTING_PROCESS", reuseState: "READY", doneBoundary: "LOCAL_VERIFIED" });
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function input(overrides = {}) {
  return {
    methodVersion: 1,
    metric: "PLAN_ACTIVE",
    referenceCutoffMs: MAX_SAFE_INTEGER,
    sourceAuthority: "SERVER_PLAN_INTERVALS",
    target: { planId: "target-1", expectedRequirementsDigest: DIGEST, profile: { ...PROFILE } },
    candidates: [],
    ...overrides,
  };
}

function candidate(planId, activeMs, overrides = {}) {
  return {
    planId,
    requirementsDigest: DIGEST,
    profile: { ...PROFILE },
    decision: "INCLUDE",
    scopeStability: "STABLE",
    timeCoverage: "COMPLETE",
    rationale: "Совпадает полный объём",
    deleted: false,
    planStatus: "COMPLETED",
    firstStartedAtMs: 0,
    finishedAtMs: activeMs === null ? 200 : activeMs,
    sourceAvailableAtMs: activeMs === null ? 200 : activeMs,
    checksConfirmed: true,
    measurement: "COMPLETE",
    activeMs,
    intervalCount: 1,
    intervalsDigest: DIGEST,
    ...overrides,
  };
}

function errorCode(fn, expectedCode) {
  assert.throws(fn, (error) => error instanceof AppError && error.code === expectedCode);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test("cold start has an explicit estimand and no fabricated point", () => {
  assert.deepEqual(calculateComparableEstimate(input()), {
    formatVersion: 1,
    method: { id: "reference-class-median", version: "1" },
    metric: "PLAN_ACTIVE",
    estimand: "ACCEPTED_UNCHANGED_SCOPE",
    status: "INSUFFICIENT_DATA",
    referenceKind: "NONE",
    pointMs: null,
    observedRange: null,
    sampleCount: 0,
    accuracy: "NOT_VALIDATED",
    intervalCoverage: null,
    includedPlanIds: [],
    excluded: [],
    selectionAuthority: "agent",
  });
});

test("uses arithmetic median for one, two, odd, even, and known zero samples", () => {
  assert.equal(calculateComparableEstimate(input({ candidates: [candidate("one", 0)] })).pointMs, 0);
  assert.equal(calculateComparableEstimate(input({ candidates: [candidate("a", 10), candidate("b", 20)] })).pointMs, 15);
  assert.equal(calculateComparableEstimate(input({ candidates: [candidate("a", 1), candidate("b", 2), candidate("c", 3)] })).pointMs, 2);
  assert.equal(calculateComparableEstimate(input({ candidates: [candidate("a", 1), candidate("b", 2), candidate("c", 3), candidate("d", 4)] })).pointMs, 3);
  assert.equal(calculateComparableEstimate(input({ candidates: [candidate("a", 10), candidate("b", 11)] })).pointMs, 11);
});

test("safe midpoint rounds near the maximum integer and synthetic IDs remain case-sensitive", () => {
  assert.equal(median([10, 11]), 11);
  assert.equal(median([MAX_SAFE_INTEGER - 1, MAX_SAFE_INTEGER]), MAX_SAFE_INTEGER);
  const midpoint = calculateComparableEstimate(input({ candidates: [
    candidate("near-max-a", MAX_SAFE_INTEGER - 3, { firstStartedAtMs: 0, finishedAtMs: MAX_SAFE_INTEGER - 1, sourceAvailableAtMs: MAX_SAFE_INTEGER - 1 }),
    candidate("near-max-b", MAX_SAFE_INTEGER - 2, { firstStartedAtMs: 0, finishedAtMs: MAX_SAFE_INTEGER - 1, sourceAvailableAtMs: MAX_SAFE_INTEGER - 1 }),
  ] }));
  assert.equal(midpoint.pointMs, MAX_SAFE_INTEGER - 2);
  const caseSensitive = calculateComparableEstimate(input({ candidates: [candidate("TARGET-1", 10), candidate("target-1-alt", 20)] }));
  assert.deepEqual(caseSensitive.includedPlanIds, ["TARGET-1", "target-1-alt"]);
  assert.equal(caseSensitive.sampleCount, 2);
});

test("preserves the specified n=4/n=5 and arithmetic-versus-log regressions", () => {
  const four = [60_000, 120_000, 180_000, 6_000_000].map((value, index) => candidate(`p${index}`, value));
  const five = [...four, candidate("p4", 240_000)];
  assert.equal(calculateComparableEstimate(input({ candidates: four })).pointMs, 150_000);
  assert.equal(calculateComparableEstimate(input({ candidates: five })).pointMs, 180_000);
  assert.equal(calculateComparableEstimate(input({ candidates: [1, 4, 16, 64, 256, 1024].map((value, index) => candidate(`l${index}`, value)) })).pointMs, 40);
});

test("filters candidates in the contractual reason order and keeps every exclusion", () => {
  const candidates = [
    candidate("good", 70),
    { planId: "deleted", deleted: true },
    candidate("excluded", 80, { decision: "EXCLUDE" }),
    candidate("unknown", 90, { profile: { ...PROFILE, reuseState: "UNKNOWN" } }),
    candidate("mismatch", 100, { profile: { ...PROFILE, workKind: "CREATE_MECHANISM" } }),
    candidate("changed", 110, { scopeStability: "CHANGED" }),
    candidate("scope-unknown", 120, { scopeStability: "UNKNOWN" }),
    candidate("partial", 130, { timeCoverage: "PARTIAL" }),
    candidate("running", 140, { planStatus: "RUNNING", finishedAtMs: null, measurement: "INCOMPLETE", activeMs: null }),
    candidate("checks", 150, { checksConfirmed: false }),
    candidate("missing", null, { measurement: "MISSING", intervalCount: 0, intervalsDigest: null }),
    candidate("incomplete", null, { measurement: "INCOMPLETE", intervalCount: 1 }),
    candidate("cutoff", 160, { sourceAvailableAtMs: 2_000_000 }),
    candidate("descriptive", 170, { decision: "DESCRIPTIVE" }),
  ];
  const result = calculateComparableEstimate(input({ referenceCutoffMs: 2_000_000, candidates }));
  assert.deepEqual(result.includedPlanIds, ["good"]);
  assert.deepEqual(result.excluded.find((item) => item.planId === "deleted"), { planId: "deleted", reasons: ["DELETED_SOURCE"] });
  assert.deepEqual(result.excluded.find((item) => item.planId === "excluded"), { planId: "excluded", reasons: ["AGENT_EXCLUDED"] });
  assert.deepEqual(result.excluded.find((item) => item.planId === "unknown").reasons, ["UNKNOWN_PROFILE"]);
  assert.deepEqual(result.excluded.find((item) => item.planId === "changed").reasons, ["SCOPE_CHANGED"]);
  assert.deepEqual(result.excluded.find((item) => item.planId === "scope-unknown").reasons, ["SCOPE_UNCONFIRMED"]);
  assert.deepEqual(result.excluded.find((item) => item.planId === "running").reasons, ["NOT_COMPLETED", "INCOMPLETE_INTERVALS"]);
  assert.deepEqual(result.excluded.find((item) => item.planId === "cutoff").reasons, ["AFTER_CUTOFF"]);
  assert.deepEqual(result.excluded.find((item) => item.planId === "descriptive").reasons, ["DESCRIPTIVE_ONLY"]);
  assert.deepEqual(result.excluded.map((item) => item.planId), [...result.excluded.map((item) => item.planId)].sort());
});

test("profile requires exact known field matches and candidate IDs are unique and non-target", () => {
  const target = { ...PROFILE, reuseState: "UNKNOWN" };
  const result = calculateComparableEstimate(input({ target: { planId: "target-1", expectedRequirementsDigest: DIGEST, profile: target }, candidates: [candidate("x", 10)] }));
  assert.deepEqual(result.excluded[0].reasons, ["UNKNOWN_PROFILE"]);
  errorCode(() => calculateComparableEstimate(input({ candidates: [candidate("same", 10), candidate("same", 20)] })), "VALIDATION_ERROR");
  errorCode(() => calculateComparableEstimate(input({ candidates: [candidate("target-1", 10)] })), "VALIDATION_ERROR");
});

test("rejects malformed snapshots, unsafe numbers, unsupported parameters, and inconsistent server facts", () => {
  errorCode(() => calculateComparableEstimate(input({ methodVersion: 2 })), "VALIDATION_ERROR");
  errorCode(() => calculateComparableEstimate(input({ metric: "CALENDAR" })), "VALIDATION_ERROR");
  errorCode(() => calculateComparableEstimate(input({ candidates: [candidate("x", 1, { riskMultiplier: 2 })] })), "VALIDATION_ERROR");
  errorCode(() => calculateComparableEstimate(input({ candidates: [candidate("x", true)] })), "VALIDATION_ERROR");
  errorCode(() => calculateComparableEstimate(input({ candidates: [candidate("x", MAX_SAFE_INTEGER + 1)] })), "VALIDATION_ERROR");
  errorCode(() => calculateComparableEstimate(input({ candidates: [candidate("x", -1)] })), "VALIDATION_ERROR");
  errorCode(() => calculateComparableEstimate(input({ candidates: [candidate("x", 10, { requirementsDigest: "bad" })] })), "VALIDATION_ERROR");
  errorCode(() => calculateComparableEstimate(input({ candidates: [candidate("x", 10, { measurement: "COMPLETE", activeMs: null })] })), "INVALID_ESTIMATION_SOURCE");
  errorCode(() => calculateComparableEstimate(input({ candidates: [candidate("x", 10, { firstStartedAtMs: 100, finishedAtMs: 99 })] })), "INVALID_ESTIMATION_SOURCE");
});

test("rejects MISSING server measurement when the snapshot includes a start and intervals", () => {
  const contradictory = candidate("missing-but-measured", null, {
    measurement: "MISSING",
    firstStartedAtMs: 0,
    finishedAtMs: 100,
    sourceAvailableAtMs: 100,
    intervalCount: 1,
    intervalsDigest: DIGEST,
  });
  errorCode(() => calculateComparableEstimate(input({ candidates: [contradictory] })), "INVALID_ESTIMATION_SOURCE");

  const missingStartWithIntervals = candidate("missing-start-with-intervals", null, {
    measurement: "MISSING",
    firstStartedAtMs: null,
    finishedAtMs: 100,
    sourceAvailableAtMs: 100,
    intervalCount: 1,
    intervalsDigest: DIGEST,
  });
  errorCode(() => calculateComparableEstimate(input({ candidates: [missingStartWithIntervals] })), "INVALID_ESTIMATION_SOURCE");

  const validMissing = candidate("missing-no-intervals", null, {
    measurement: "MISSING",
    intervalCount: 0,
    intervalsDigest: null,
  });
  const result = calculateComparableEstimate(input({ candidates: [validMissing] }));
  assert.deepEqual(result.excluded, [{ planId: "missing-no-intervals", reasons: ["NO_MEASUREMENT"] }]);
});

test("rejects INCOMPLETE server measurement when there are no intervals", () => {
  const contradictory = candidate("incomplete-no-intervals", null, {
    planStatus: "RUNNING",
    finishedAtMs: null,
    measurement: "INCOMPLETE",
    intervalCount: 0,
    intervalsDigest: null,
  });
  errorCode(() => calculateComparableEstimate(input({ candidates: [contradictory] })), "INVALID_ESTIMATION_SOURCE");
});

test("rejects INCOMPLETE server measurement when intervals lack a first start", () => {
  const contradictory = candidate("incomplete-interval-without-start", null, {
    planStatus: "RUNNING",
    firstStartedAtMs: null,
    finishedAtMs: null,
    measurement: "INCOMPLETE",
    intervalCount: 1,
    intervalsDigest: DIGEST,
  });
  errorCode(() => calculateComparableEstimate(input({ candidates: [contradictory] })), "INVALID_ESTIMATION_SOURCE");
});

test("accepts a large safe measurement and a frozen external fixture without server timestamps", () => {
  const large = candidate("large", MAX_SAFE_INTEGER - 2, {
    firstStartedAtMs: 0,
    finishedAtMs: MAX_SAFE_INTEGER - 1,
    sourceAvailableAtMs: MAX_SAFE_INTEGER - 1,
  });
  const result = calculateComparableEstimate(input({ referenceCutoffMs: MAX_SAFE_INTEGER, candidates: [large] }));
  assert.equal(result.pointMs, MAX_SAFE_INTEGER - 2);
  const fixture = candidate("fixture", 123, {
    requirementsDigest: null,
    firstStartedAtMs: null,
    finishedAtMs: null,
    sourceAvailableAtMs: 10,
    intervalCount: 0,
    intervalsDigest: null,
  });
  assert.equal(calculateComparableEstimate(input({ sourceAuthority: "EXTERNAL_FIXTURE", target: { ...input().target, expectedRequirementsDigest: null }, candidates: [fixture] })).pointMs, 123);
});

test("is deterministic across candidate permutations, leaves input untouched, and has no network path", () => {
  const first = candidate("a", 20, { rationale: "сопоставимо" });
  const second = candidate("z", 40, { rationale: "ready" });
  const one = deepFreeze(input({ candidates: [first, second] }));
  const two = deepFreeze(input({ candidates: [second, first] }));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = () => { throw new Error("fetch is forbidden in pure estimation"); };
    assert.deepEqual(calculateComparableEstimate(one), calculateComparableEstimate(two));
    assert.equal(calculateComparableEstimate(one).pointMs, 30);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scores forecast availability, MAE, WAPE, and signed bias independently", () => {
  assert.deepEqual(scoreEstimateCases([
    { caseId: "a", actualMs: 10, predictedMs: 13 },
    { caseId: "b", actualMs: 0, predictedMs: 0 },
    { caseId: "c", actualMs: null, predictedMs: 4 },
    { caseId: "d", actualMs: 5, predictedMs: null },
  ]), {
    caseCount: 4,
    actualKnownCount: 3,
    predictionCount: 3,
    scoredCount: 2,
    missingActualCount: 1,
    missingPredictionCount: 1,
    forecastRate: 0.75,
    maeMs: 1.5,
    wapePercent: 30,
    signedBiasPercent: 30,
  });
});

test("scores empty inputs, no scored pairs, and zero actual sum without epsilon", () => {
  assert.deepEqual(scoreEstimateCases([]), {
    caseCount: 0,
    actualKnownCount: 0,
    predictionCount: 0,
    scoredCount: 0,
    missingActualCount: 0,
    missingPredictionCount: 0,
    forecastRate: null,
    maeMs: null,
    wapePercent: null,
    signedBiasPercent: null,
  });
  const noPairs = scoreEstimateCases([{ caseId: "no-fact", actualMs: null, predictedMs: 2 }, { caseId: "no-point", actualMs: 3, predictedMs: null }]);
  assert.equal(noPairs.scoredCount, 0);
  assert.equal(noPairs.maeMs, null);
  const zeroActual = scoreEstimateCases([{ caseId: "zero", actualMs: 0, predictedMs: 2 }]);
  assert.equal(zeroActual.maeMs, 2);
  assert.equal(zeroActual.wapePercent, null);
  assert.equal(zeroActual.signedBiasPercent, null);
});

test("scoring rejects duplicate cases, invalid values, extra fields, and sum overflow", () => {
  errorCode(() => scoreEstimateCases([{ caseId: "x", actualMs: 1, predictedMs: 1 }, { caseId: "x", actualMs: 2, predictedMs: 2 }]), "VALIDATION_ERROR");
  errorCode(() => scoreEstimateCases([{ caseId: "x", actualMs: true, predictedMs: 1 }]), "VALIDATION_ERROR");
  errorCode(() => scoreEstimateCases([{ caseId: "x", actualMs: 1, predictedMs: 1, outcome: "failed" }]), "VALIDATION_ERROR");
  errorCode(() => scoreEstimateCases([{ caseId: "a", actualMs: 0, predictedMs: MAX_SAFE_INTEGER }, { caseId: "b", actualMs: 0, predictedMs: MAX_SAFE_INTEGER }]), "VALIDATION_ERROR");
});
