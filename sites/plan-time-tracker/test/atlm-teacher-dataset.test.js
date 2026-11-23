import assert from 'node:assert/strict';
import test from 'node:test';
import { teacherAnnotation, teacherSource } from './fixtures/atlm-revisions.mjs';
import { buildAtlmTeacherTrainingRows, mergeAtlmTeacherAnnotations } from '../worker/atlm/teacher-dataset.js';

const frozen = {
  rowId: 'row-1', planId: 'plan-1', rawEligibility: 'EXCLUDED', rawReasons: ['SCOPE_CHANGED'],
  source: teacherSource('plan-1'), evidence: {},
};

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
