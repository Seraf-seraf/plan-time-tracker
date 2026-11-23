import { ATLM_FEATURE_VERSION, isNonnegativeSafeInteger, normalizeAgentTask } from './model.js';
import { ESTIMATE_ID, appError, canonical, isPlainRecord } from '../shared/index.js';

const ATLM_DATASET_VERSION = 1;
const TEACHER_ANNOTATIONS_CONTRACT = 'atlm-teacher-annotations';
const TEACHER_DATASET_CONTRACT = 'atlm-teacher-dataset';
const TEACHER_EXCEPTIONS = new Set([
  'SCOPE_CHANGED', 'MISSING_FEATURES', 'MISSING_REQUIRED_FEATURES', 'INVALID_FEATURES',
]);
const ANNOTATION_FIELDS = ['scope', 'agentTask', 'fieldEvidence', 'codeEvidence'];
const DECISION_FIELDS = ['rowId', 'groupId', 'eligibility', 'reasons', 'annotation'];
const EXPORT_FIELDS = ['schemaVersion', 'contract', 'datasetRevisionId', 'snapshotId',
  'parentDatasetRevisionId', 'featureSchemaVersion', 'rows', 'origin', 'provenance'];
const EXPORTED_ROW_FIELDS = ['rowId', 'planId', 'groupId', 'eligibility', 'reasons',
  'annotation', 'source', 'features', 'record', 'annotationOrigin', 'annotationRecordedAt'];

function datasetError(description, rowId) {
  return appError('INVALID_TEACHER_DATASET', description, 400, rowId ? { rowId } : undefined);
}

function exactFields(value, fields, description, rowId) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw datasetError(description, rowId);
  }
}

function validId(value) {
  return typeof value === 'string' && ESTIMATE_ID.test(value);
}

function reasonList(reasons, rowId) {
  if (!Array.isArray(reasons) || !reasons.every((item) => validId(item))) {
    throw datasetError('Invalid teacher reasons.', rowId);
  }
  return [...new Set(reasons)].sort();
}

function recordedEvidence(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0 && value.every(recordedEvidence);
  return isPlainRecord(value) && Object.keys(value).length > 0
    && Object.values(value).every(recordedEvidence);
}

function normalizedAnnotation(annotation, rowId) {
  exactFields(annotation, ANNOTATION_FIELDS, 'Unexpected teacher annotation field.', rowId);
  if (annotation.scope !== 'ACTUAL' || !isPlainRecord(annotation.fieldEvidence)
    || !recordedEvidence(annotation.fieldEvidence) || !recordedEvidence(annotation.codeEvidence)) {
    throw datasetError('Teacher annotation requires ACTUAL scope and field/code evidence.', rowId);
  }
  const result = normalizeAgentTask(annotation.agentTask);
  if (result.missingFields.length) {
    throw datasetError('Teacher annotation is missing required features.', rowId);
  }
  return { annotation: { ...annotation, agentTask: result.agentTask }, features: result.features };
}

function fitSourceValid(source, planId) {
  return isPlainRecord(source) && source.planId === planId
    && source.status === 'AVAILABLE' && source.planStatus === 'COMPLETED' && source.deletedAt === null
    && isNonnegativeSafeInteger(source.sourceGeneration)
    && isNonnegativeSafeInteger(source.firstStartedAt) && isNonnegativeSafeInteger(source.finishedAt)
    && isNonnegativeSafeInteger(source.sourceAvailableAt) && isNonnegativeSafeInteger(source.actualMs)
    && source.firstStartedAt <= source.finishedAt && source.finishedAt <= source.sourceAvailableAt
    && source.actualMs <= source.finishedAt - source.firstStartedAt;
}

function mergeAtlmTeacherAnnotations(snapshotRows, decisions) {
  if (!Array.isArray(decisions) || decisions.length !== snapshotRows.length) {
    throw datasetError('Teacher decision membership must match the entire snapshot.');
  }
  const byId = new Map();
  for (const decision of decisions) {
    exactFields(decision, DECISION_FIELDS, 'Unexpected teacher decision field.', decision?.rowId);
    if (!validId(decision.rowId) || byId.has(decision.rowId)) {
      throw datasetError('Invalid or duplicate row in teacher membership.', decision.rowId);
    }
    byId.set(decision.rowId, decision);
  }
  return snapshotRows.map(({ rowId, planId, rawReasons, source }) => {
    const decision = byId.get(rowId);
    if (!decision || !byId.delete(rowId)) {
      throw datasetError('Missing member of teacher decision roster.', rowId);
    }
    const { eligibility, groupId, annotation } = decision;
    const reasons = reasonList(decision.reasons, rowId);
    if ((groupId !== null && !validId(groupId)) || !['ELIGIBLE', 'EXCLUDED'].includes(eligibility)) {
      throw datasetError('Invalid group or teacher eligibility.', rowId);
    }
    if (eligibility === 'EXCLUDED') {
      if (!reasons.length) throw datasetError('Excluded rows require reasons.', rowId);
      return { rowId, planId, groupId, eligibility, reasons,
        annotation: annotation === null ? null : normalizedAnnotation(annotation, rowId).annotation,
        source, features: null };
    }
    if (!validId(groupId) || reasons.length) {
      throw datasetError('An eligible row requires a group and no exclusion reasons.', rowId);
    }
    if (!fitSourceValid(source, planId) || rawReasons.some((reason) => !TEACHER_EXCEPTIONS.has(reason))) {
      throw datasetError('Teacher eligibility requires a verified completed source.', rowId);
    }
    const normalized = normalizedAnnotation(annotation, rowId);
    return { rowId, planId, groupId, eligibility, reasons, annotation: normalized.annotation,
      source, features: normalized.features };
  });
}

function buildAtlmTeacherTrainingRows(rows, selectedRowIds) {
  if (!Array.isArray(rows)) throw datasetError('Dataset rows must be a list.');
  const seenRows = new Set();
  const seenPlans = new Set();
  const selected = selectedRowIds === undefined ? null : new Set(selectedRowIds);
  if (selected && selected.size !== selectedRowIds.length) {
    throw datasetError('Duplicate selected row.');
  }
  const result = [];
  for (const row of rows) {
    exactFields(row, EXPORTED_ROW_FIELDS, 'Unexpected export row field.', row?.rowId);
    const { rowId, planId, groupId, eligibility, source, features } = row;
    if (!validId(rowId) || !validId(planId) || seenRows.has(rowId) || seenPlans.has(planId)) {
      throw datasetError('Invalid or duplicate plan or row identity.', rowId);
    }
    seenRows.add(rowId);
    seenPlans.add(planId);
    const reasons = reasonList(row.reasons, rowId);
    if (eligibility === 'EXCLUDED' && reasons.length && features === null) continue;
    if (eligibility !== 'ELIGIBLE' || reasons.length || !validId(groupId) || !fitSourceValid(source, planId)) {
      throw datasetError('Invalid eligible source or decision.', rowId);
    }
    const normalized = normalizedAnnotation(row.annotation, rowId);
    if (canonical(normalized.features) !== canonical(features)) {
      throw datasetError('Teacher features differ from normalized actual annotation.', rowId);
    }
    if (selected && !selected.delete(rowId)) continue;
    result.push({ sampleId: rowId, planId, capturedAt: source.firstStartedAt,
      sourceAvailableAt: source.sourceAvailableAt, features, actualMs: source.actualMs });
  }
  if (selected?.size) throw datasetError('Selected row is missing or excluded.', selected.values().next().value);
  return result;
}

function readAtlmTeacherDataset(value) {
  exactFields(value, EXPORT_FIELDS, 'Unexpected teacher dataset field.');
  if (value.schemaVersion !== ATLM_DATASET_VERSION || value.contract !== TEACHER_DATASET_CONTRACT
    || value.featureSchemaVersion !== ATLM_FEATURE_VERSION) {
    throw datasetError('Unsupported teacher dataset version or contract.');
  }
  if (value.origin === 'IMPORTED') {
    throw appError('HISTORICAL_PROVENANCE_INCOMPLETE', 'Imported data requires a new verified snapshot.', 409);
  }
  if ((value.origin !== undefined && value.origin !== 'NATIVE') || !validId(value.datasetRevisionId)
    || !validId(value.snapshotId) || (value.parentDatasetRevisionId !== null && !validId(value.parentDatasetRevisionId))) {
    throw datasetError('Invalid dataset identity or lineage.');
  }
  return { dataset: value, trainingRows: buildAtlmTeacherTrainingRows(value.rows) };
}

export {
  ATLM_DATASET_VERSION, TEACHER_ANNOTATIONS_CONTRACT, TEACHER_DATASET_CONTRACT,
  buildAtlmTeacherTrainingRows, mergeAtlmTeacherAnnotations, readAtlmTeacherDataset,
};
