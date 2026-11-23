import { taskV4 } from './tracker-db.mjs';

export function teacherSource(planId, sequence = 1) {
  return {
    planId, status: 'AVAILABLE', planStatus: 'COMPLETED', deletedAt: null,
    sourceGeneration: 2, sampleGeneration: 1, sampleId: sequence, sourceDigest: 'test-digest',
    inputAssessmentSequence: sequence, firstStartedAt: sequence * 10_000,
    finishedAt: sequence * 10_000 + 1000, capturedAt: sequence * 10_000 + 1000,
    sourceAvailableAt: sequence * 10_000 + 1000, actualMs: 1000,
    issuedPrediction: { status: 'UNAVAILABLE', unavailableReason: 'NO_MODEL' },
    plannedFeatures: null, scopeChanged: true, evidenceRefs: [],
  };
}

export function teacherAnnotation(rowId, groupId = 'same-work') {
  return {
    rowId, groupId, eligibility: 'ELIGIBLE', reasons: [],
    annotation: {
      scope: 'ACTUAL', agentTask: taskV4(),
      fieldEvidence: { workUnits: 'Verified actual behavior' },
      codeEvidence: { symbols: ['writeOutcome'] },
    },
  };
}
