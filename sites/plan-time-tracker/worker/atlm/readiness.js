import { dbFirst, hashCommandInput, parseColumn } from '../shared/index.js';
import { ATLM_FEATURE_VERSION, normalizeAgentTask } from './model.js';

async function assessmentReadiness(assessment, savedDigest, requirementsDigest) {
  const task = assessment?.context?.agentTask;
  const state = {
    status: 'INCOMPLETE',
    code: 'ASSESSMENT_INCOMPLETE',
    schemaVersion: task?.schemaVersion ?? null,
    requirementsDigest,
    featureDigest: null,
    missingPaths: [],
    invalidPaths: [],
    unknownPaths: [],
  };
  if (!assessment) return { ...state, code: 'ASSESSMENT_REQUIRED', missingPaths: ['assessment'] };
  if (!task) return { ...state, missingPaths: ['context.agentTask'] };
  if (task.schemaVersion && task.schemaVersion !== ATLM_FEATURE_VERSION)
    return {
      ...state,
      status: 'OUTDATED',
      code: 'ASSESSMENT_SCHEMA_OUTDATED',
      invalidPaths: ['schemaVersion'],
    };
  let normalized;
  try {
    normalized = normalizeAgentTask(task);
  } catch (error) {
    if (error.code !== 'VALIDATION_ERROR') throw error;
    const path = (error.details?.path ?? 'agentTask').replace(/^agentTask\./, '');
    return error.details?.readiness === 'INCOMPLETE'
      ? { ...state, missingPaths: [path] }
      : { ...state, status: 'INVALID', code: 'ASSESSMENT_INVALID', invalidPaths: [path] };
  }
  const f = normalized.features;
  Object.assign(state, {
    featureDigest: 'sha256:' + (await hashCommandInput(f)),
    unknownPaths: normalized.unknownPaths,
    operations: { readCount: f.readCount, writeCount: f.writeCount, writeRatio: f.writeRatio },
  });
  if (
    assessment.predictionRequest?.method !== 'ATLM' ||
    assessment.predictionRequest.methodVersion !== 1
  )
    return { ...state, missingPaths: ['predictionRequest'] };
  if (
    savedDigest !== requirementsDigest ||
    assessment.serverEstimation?.requirementsDigest !== savedDigest
  )
    return {
      ...state,
      status: 'STALE',
      code: 'ASSESSMENT_CONTEXT_CHANGED',
      invalidPaths: ['requirementsDigest'],
    };
  if (assessment.serverEstimation.featureDigest !== state.featureDigest)
    return {
      ...state,
      status: 'STALE',
      code: 'ASSESSMENT_CONTEXT_CHANGED',
      invalidPaths: ['featureDigest'],
    };
  return { ...state, status: 'READY', code: null };
}

async function planStartReadiness(db, ownerId, planId) {
  const row = await dbFirst(
    db,
    `SELECT t.requirements_json,a.assessment_json,a.requirements_digest
    FROM assessment_targets t LEFT JOIN assessment_revisions a ON a.sequence=(SELECT MAX(r.sequence)
      FROM assessment_revisions r WHERE r.owner_id=t.owner_id AND r.plan_id=t.plan_id AND r.step_id IS NULL)
    WHERE t.owner_id=? AND t.plan_id=? AND t.step_id IS NULL`,
    ownerId,
    planId,
  );
  return readinessFromRow(row);
}

async function readinessFromRow(row) {
  return assessmentReadiness(
    parseColumn(row?.assessment_json, null),
    row?.requirements_digest,
    row ? 'sha256:' + (await hashCommandInput(JSON.parse(row.requirements_json))) : null,
  );
}

export { assessmentReadiness, planStartReadiness, readinessFromRow };
