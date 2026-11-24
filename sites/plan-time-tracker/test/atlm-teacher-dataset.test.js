import assert from 'node:assert/strict';
import test from 'node:test';
import { teacherAnnotation, teacherSource } from './fixtures/atlm-revisions.mjs';
import {
  ATLM_TEACHER_PROTOCOL_V2,
  ATLM_TEACHER_PROTOCOL_V3,
  ATLM_TEACHER_RECIPE_ID,
  ATLM_TEACHER_RECIPE_ID_V2,
  ATLM_TEACHER_RECIPE_ID_V3,
  atlmTeacherIssuedCase,
  atlmTeacherRollingCase,
  atlmTeacherRollingHistory,
  buildAtlmTeacherSplit,
  buildAtlmTeacherTrainingRows,
  mergeAtlmTeacherAnnotations,
  parseAtlmTeacherRecipe,
  summarizeAtlmTeacherMode,
} from '../worker/atlm/teacher-dataset.js';

const frozen = {
  rowId: 'row-1', planId: 'plan-1', rawEligibility: 'EXCLUDED', rawReasons: ['SCOPE_CHANGED'],
  source: teacherSource('plan-1'), evidence: {},
};

const planRecipe = {
  schemaVersion: 1,
  recipeId: ATLM_TEACHER_RECIPE_ID_V2,
  datasetRevisionId: 'dataset',
  datasetDigest: `sha256:${'a'.repeat(64)}`,
  selection: { mode: 'ALL_ELIGIBLE' },
  backtestUse: 'UNKNOWN',
  backtestUseNote: 'Fixture history.',
};

function eligibleRow(rowId, sequence, { groupId = null, availableAt, recordedAt, matchingPlan } = {}) {
  const planId = `plan-${rowId}`;
  const source = teacherSource(planId, sequence);
  const decision = teacherAnnotation(rowId, groupId);
  if (availableAt !== undefined) {
    decision.annotation.historicalAvailability = { availableAt, evidence: 'Verified work log timestamp.' };
  }
  const [row] = mergeAtlmTeacherAnnotations([{ rowId, planId, rawReasons: [], source }], [decision]);
  if (matchingPlan) {
    row.source = { ...source, scopeChanged: false, plannedFeatures: row.features };
  }
  if (recordedAt !== undefined) row.annotationRecordedAt = recordedAt;
  return row;
}

test('teacher facts and fitter inputs retain the measured target and use actual features', () => {
  const [row] = mergeAtlmTeacherAnnotations([frozen], [teacherAnnotation(frozen.rowId)]);
  assert.deepEqual(row.source, frozen.source);
  assert.equal(row.features['workUnits.MODIFY'], 1);
  assert.deepEqual(buildAtlmTeacherTrainingRows([row]), [{
    sampleId: 'row-1', planId: 'plan-1', capturedAt: 10_000, sourceAvailableAt: 11_000,
    actualMs: 1000, features: row.features,
  }]);
});

test('each frozen row needs one decision and uploads cannot overwrite authoritative fields', () => {
  assert.throws(() => mergeAtlmTeacherAnnotations([frozen], []), /membership/i);
  assert.throws(() => mergeAtlmTeacherAnnotations([frozen], [
    { ...teacherAnnotation(frozen.rowId), actualMs: 777 },
  ]), /field/i);
  assert.throws(() => mergeAtlmTeacherAnnotations([{
    ...frozen, rawReasons: ['SOURCE_REFRESH_FAILED'],
    source: { ...frozen.source, status: 'UNAVAILABLE', actualMs: null },
  }], [teacherAnnotation(frozen.rowId)]), /source/i);
});

test('an excluded decision can omit the annotation and normalizes independent reasons', () => {
  const [row] = mergeAtlmTeacherAnnotations([frozen], [{
    rowId: frozen.rowId, groupId: null, eligibility: 'EXCLUDED',
    reasons: ['INSUFFICIENT_EVIDENCE', 'EXAMPLE_NOT_REPEATED', 'INSUFFICIENT_EVIDENCE'],
    annotation: null,
  }]);
  assert.equal(row.features, null);
  assert.deepEqual(row.reasons, ['EXAMPLE_NOT_REPEATED', 'INSUFFICIENT_EVIDENCE']);
  assert.deepEqual(buildAtlmTeacherTrainingRows([row]), []);
});

test('eligible teaching rows can omit a group and annotate when historical evidence was available', () => {
  const decision = teacherAnnotation(frozen.rowId);
  delete decision.groupId;
  decision.annotation.historicalAvailability = { availableAt: null, evidence: 'Historical date unknown.' };
  const [row] = mergeAtlmTeacherAnnotations([frozen], [decision]);
  assert.equal(row.groupId, null);
  assert.deepEqual(row.annotation.historicalAvailability, decision.annotation.historicalAvailability);
  assert.equal(buildAtlmTeacherTrainingRows([row]).length, 1);

  for (const invalid of [{ availableAt: -1, evidence: 'Invalid time.' }, { availableAt: 0, evidence: ' ' },
    { availableAt: null }, { availableAt: null, evidence: 'Does not allow extra fields.', groupId: 'same-work' }]) {
    assert.throws(() => mergeAtlmTeacherAnnotations([frozen], [{
      ...decision, annotation: { ...decision.annotation, historicalAvailability: invalid },
    }]), /historical availability/i);
  }
});

test('v2 requires the full roster and uses per-plan history before the strict start cutoff', () => {
  const rows = [
    eligibleRow('source-ready', 1, { groupId: 'same', matchingPlan: true }),
    eligibleRow('declared-ready', 1, { availableAt: 2 }),
    eligibleRow('unknown', 1, { availableAt: null, matchingPlan: true }),
    eligibleRow('undated', 1),
    eligibleRow('tie', 2, { availableAt: 30_000 }),
    eligibleRow('recorded', 2, { recordedAt: 35_000 }),
    eligibleRow('earlier-target', 3, { groupId: 'same' }),
    eligibleRow('later-target', 4, { matchingPlan: true }),
    {
      ...eligibleRow('excluded', 2),
      eligibility: 'EXCLUDED', reasons: ['PLAN_DELETED'],
      annotation: null, features: null,
    },
  ];
  const { datasetRevisionId, datasetDigest } = planRecipe;
  const recipe = parseAtlmTeacherRecipe(planRecipe, datasetRevisionId, datasetDigest);
  assert.throws(() => parseAtlmTeacherRecipe({
    ...planRecipe, selection: { mode: 'EXPLICIT', rowIds: ['source-ready'] },
  }, datasetRevisionId, datasetDigest), /all eligible/i);

  const trainingRows = buildAtlmTeacherTrainingRows(rows);
  const protocol = buildAtlmTeacherSplit({ rows }, trainingRows, recipe);
  assert.equal(protocol.split.protocolVersion, ATLM_TEACHER_PROTOCOL_V2);
  assert.deepEqual(protocol.fitRowIds, rows.slice(0, -1).map((row) => row.rowId));
  assert.deepEqual(protocol.selectedRowIds, protocol.fitRowIds);
  assert.equal(protocol.trainCutoff, 41_000);
  assert.equal(Object.hasOwn(protocol, 'holdoutRowIds'), false);
  assert.equal(Object.hasOwn(protocol.split, 'groups'), false);
  assert.deepEqual(protocol.rowDecisions.map(({ historicalAvailableAt }) => historicalAvailableAt),
    [11_000, 11_000, null, null, 30_000, 35_000, null, 41_000, null]);

  const historyFor = atlmTeacherRollingHistory(protocol, trainingRows);
  const history = (target) => historyFor(trainingRows.find(({ sampleId }) => sampleId === target))
    .map(({ sampleId, sourceAvailableAt }) => [sampleId, sourceAvailableAt]);
  assert.deepEqual(history('earlier-target'), [['declared-ready', 11_000], ['source-ready', 11_000]]);
  assert.deepEqual(history('later-target'), [
    ['declared-ready', 11_000], ['recorded', 35_000], ['source-ready', 11_000], ['tie', 30_000],
  ]);
  assert.equal(trainingRows.find(({ sampleId }) => sampleId === 'tie').sourceAvailableAt, 21_000);
});

test('v3 requires the full roster and disregards historical annotation availability', () => {
  const { backtestUse, backtestUseNote, ...common } = planRecipe;
  const input = { ...common, recipeId: ATLM_TEACHER_RECIPE_ID_V3 };
  const { datasetRevisionId, datasetDigest } = input;
  const recipe = parseAtlmTeacherRecipe(input, datasetRevisionId, datasetDigest);
  for (const change of [{ backtestUse }, { backtestUseNote }, { selection: { mode: 'EXPLICIT', rowIds: ['repaired'] } }]) {
    assert.throws(() => parseAtlmTeacherRecipe({ ...input, ...change }, datasetRevisionId, datasetDigest),
      { code: 'INVALID_RECIPE' });
  }
  const rows = [eligibleRow('legacy', 1, { groupId: 'legacy', availableAt: null }),
    eligibleRow('repaired', 2, { availableAt: 90_000, recordedAt: 100_000 })];
  const trainingRows = buildAtlmTeacherTrainingRows(rows);
  assert.deepEqual(buildAtlmTeacherSplit({ rows }, trainingRows, recipe), {
    split: { protocolVersion: ATLM_TEACHER_PROTOCOL_V3 },
    selectedRowIds: ['legacy', 'repaired'],
    fitRowIds: ['legacy', 'repaired'],
    trainCutoff: 21_000,
    rowDecisions: rows.map(({ rowId, planId, eligibility, reasons }) => ({
      rowId, planId, eligibility, reasons, role: 'FIT',
    })),
  });
});

test('v1 excludes rows that cannot be verified with the grouped protocol', () => {
  const recipe = { recipeId: ATLM_TEACHER_RECIPE_ID, selection: { mode: 'ALL_ELIGIBLE' } };
  for (const row of [eligibleRow('without-group', 1), eligibleRow('with-availability', 1, {
    groupId: 'same', availableAt: null,
  })]) {
    assert.throws(() => buildAtlmTeacherSplit({ rows: [row] }, buildAtlmTeacherTrainingRows([row]), recipe),
      { code: 'INVALID_GROUPED_ROW' });
  }
});

test('v2 planned scoring uses the preserved before-start fields and reports no group counts', () => {
  const row = eligibleRow('planned', 1, { matchingPlan: true });
  const args = { prediction: { status: 'AVAILABLE', pointMs: 1000 }, medianPointMs: 900 };
  const comparable = atlmTeacherRollingCase(row, 'PLANNED', args);
  const changed = atlmTeacherRollingCase({ ...row, source: { ...row.source, scopeChanged: true } }, 'PLANNED', args);
  const missing = atlmTeacherRollingCase({ ...row, source: { ...row.source, plannedFeatures: null } }, 'PLANNED', args);

  assert.equal(comparable.signedErrorMs, 0);
  assert.equal(changed.scoringExclusionReason, 'SCOPE_CHANGED');
  assert.equal(changed.pointMs, null);
  assert.equal(changed.medianPointMs, null);
  assert.equal(missing.scoringExclusionReason, 'PLANNED_FEATURES_UNAVAILABLE');
  assert.equal(Object.hasOwn(comparable, 'groupId'), false);
  assert.equal(Object.hasOwn(atlmTeacherIssuedCase(row, { includeGroups: false }), 'groupId'), false);
  const report = summarizeAtlmTeacherMode([comparable, changed, missing], { includeGroups: false });
  assert.equal(Object.hasOwn(report.summary, 'groupCount'), false);
  assert.equal(Object.hasOwn(report.paired, 'groupCount'), false);
  assert.deepEqual(report.paired.rowIds, ['planned']);
});
