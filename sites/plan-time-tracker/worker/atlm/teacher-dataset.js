import {
  ATLM_FEATURE_VERSION,
  atlmUnavailableInterval,
  isNonnegativeSafeInteger,
  normalizeAgentTask,
  predictAtlm,
  summarizeAtlmV4Metrics,
} from './model.js';
import {
  ESTIMATE_ID,
  appError,
  canonical,
  hashCommandInput,
  isPlainRecord,
  isSnapshotDigest,
  median,
} from '../shared/index.js';

const ATLM_DATASET_VERSION = 1;
const TEACHER_ANNOTATIONS_CONTRACT = 'atlm-teacher-annotations';
const TEACHER_DATASET_CONTRACT = 'atlm-teacher-dataset';
const TEACHER_EXCEPTIONS = new Set([
  'SCOPE_CHANGED', 'MISSING_FEATURES', 'MISSING_REQUIRED_FEATURES', 'INVALID_FEATURES',
]);
const ANNOTATION_FIELDS = ['scope', 'agentTask', 'fieldEvidence', 'codeEvidence', 'historicalAvailability'];
const DECISION_FIELDS = ['rowId', 'groupId', 'eligibility', 'reasons', 'annotation'];
const EXPORT_FIELDS = ['schemaVersion', 'contract', 'datasetRevisionId', 'snapshotId',
  'parentDatasetRevisionId', 'featureSchemaVersion', 'rows', 'origin', 'provenance'];
const EXPORTED_ROW_FIELDS = ['rowId', 'planId', 'groupId', 'eligibility', 'reasons',
  'annotation', 'source', 'features', 'record', 'annotationOrigin', 'annotationRecordedAt'];
const ATLM_TEACHER_TRAINER_VERSION = 1;
const ATLM_TEACHER_RECIPE_ID = 'atlm-teacher-hybrid-v1';
const ATLM_TEACHER_PROTOCOL_V2 = 2;
const ATLM_TEACHER_RECIPE_ID_V2 = 'atlm-teacher-hybrid-v2';
const ATLM_TEACHER_PROTOCOL_V3 = 3;
const ATLM_TEACHER_RECIPE_ID_V3 = 'atlm-teacher-hybrid-v3';
const ATLM_TEACHER_CODE_PATHS = Object.freeze([
  'scripts/train-atlm.mjs',
  'worker/atlm/model.js',
  'worker/atlm/teacher-dataset.js',
  'worker/shared/index.js',
]);
const ATLM_TEACHER_MODES = Object.freeze([
  'ROLLING_GROUPED_ACTUAL',
  'INTERNAL_HOLDOUT_ACTUAL',
  'INTERNAL_HOLDOUT_PLANNED',
  'ISSUED_FORECASTS',
]);
const ATLM_TEACHER_MODES_V2 = Object.freeze([
  'ROLLING_PLAN_ACTUAL',
  'ROLLING_PLAN_PLANNED',
  'ISSUED_FORECASTS',
]);
const REVIEW_DECLARATIONS = new Set(['UNKNOWN', 'FIRST_REPORTED', 'REUSED_AFTER_REVIEW']);
const HOLDOUT_FRACTION = 0.2;
const MIN_HOLDOUT_ROWS = 5;
const MIN_HOLDOUT_GROUPS = 2;
const MIN_DEVELOPMENT_ROWS = 2;
const MIN_DEVELOPMENT_GROUPS = 2;

function datasetError(description, rowId) {
  return appError('INVALID_TEACHER_DATASET', description, 400, validId(rowId) ? { rowId } : undefined);
}

function exactFields(value, fields, description, rowId) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw datasetError(description, rowId);
  }
}

function validId(value) {
  return typeof value === 'string' && ESTIMATE_ID.test(value) && Boolean(value.trim());
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
  if (Object.hasOwn(annotation, 'historicalAvailability')) {
    const availability = annotation.historicalAvailability;
    if (!hasExactFields(availability, ['availableAt', 'evidence'])
      || (availability.availableAt !== null && !isNonnegativeSafeInteger(availability.availableAt))
      || typeof availability.evidence !== 'string' || !availability.evidence.trim()) {
      throw datasetError('Historical availability requires a timestamp or null and evidence.', rowId);
    }
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
    const { eligibility, groupId = null, annotation } = decision;
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
    if (reasons.length) throw datasetError('An eligible row cannot have exclusion reasons.', rowId);
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
    const { rowId, planId, groupId = null, eligibility, source, features } = row;
    if (!validId(rowId) || !validId(planId) || seenRows.has(rowId) || seenPlans.has(planId)) {
      throw datasetError('Invalid or duplicate plan or row identity.', rowId);
    }
    seenRows.add(rowId);
    seenPlans.add(planId);
    const reasons = reasonList(row.reasons, rowId);
    if (canonical(reasons) !== canonical(row.reasons) || !isPlainRecord(source)
      || source.planId !== planId || (groupId !== null && !validId(groupId))) {
      throw datasetError('Invalid frozen row source, group or reasons.', rowId);
    }
    if (eligibility === 'EXCLUDED' && reasons.length && features === null) {
      if (row.annotation !== null) normalizedAnnotation(row.annotation, rowId);
      continue;
    }
    if (eligibility !== 'ELIGIBLE' || reasons.length || !fitSourceValid(source, planId)) {
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

function hasExactFields(value, fields) {
  return isPlainRecord(value) && Object.keys(value).length === fields.length
    && fields.every((key) => Object.hasOwn(value, key));
}

function recipeError(code, message, details) {
  return appError(code, message, 400, details);
}

function atlmTeacherProtocolVersion(recipe) {
  if (recipe?.recipeId === ATLM_TEACHER_RECIPE_ID_V3) return ATLM_TEACHER_PROTOCOL_V3;
  return recipe?.recipeId === ATLM_TEACHER_RECIPE_ID_V2
    ? ATLM_TEACHER_PROTOCOL_V2 : ATLM_TEACHER_TRAINER_VERSION;
}

function parseAtlmTeacherRecipe(recipe, datasetRevisionId, datasetDigest) {
  const protocolVersion = atlmTeacherProtocolVersion(recipe);
  const planBased = protocolVersion === ATLM_TEACHER_PROTOCOL_V2;
  const fitOnly = protocolVersion === ATLM_TEACHER_PROTOCOL_V3;
  const useField = planBased ? 'backtestUse' : 'holdoutUse';
  const noteField = planBased ? 'backtestUseNote' : 'holdoutUseNote';
  if (!hasExactFields(recipe, [
    'schemaVersion', 'recipeId', 'datasetRevisionId', 'datasetDigest', 'selection',
    ...(fitOnly ? [] : [useField, noteField]),
  ]) || recipe.schemaVersion !== ATLM_DATASET_VERSION
    || (protocolVersion === ATLM_TEACHER_TRAINER_VERSION && recipe.recipeId !== ATLM_TEACHER_RECIPE_ID)
    || !validId(recipe.datasetRevisionId) || !isSnapshotDigest(recipe.datasetDigest)
    || (!fitOnly && (!REVIEW_DECLARATIONS.has(recipe[useField])
      || typeof recipe[noteField] !== 'string' || !recipe[noteField].trim()))) {
    if (fitOnly) throw recipeError('INVALID_RECIPE', 'Invalid recipe version or fields.');
    const declaration = planBased ? 'backtest' : 'holdout';
    throw recipeError('INVALID_RECIPE', `Invalid recipe version, fields, or ${declaration} declaration.`);
  }
  if (recipe.datasetRevisionId !== datasetRevisionId) {
    throw recipeError('DATASET_REVISION_MISMATCH', 'Recipe dataset identity differs from the export.');
  }
  if (recipe.datasetDigest !== datasetDigest) {
    throw recipeError('DATASET_DIGEST_MISMATCH', 'Recipe digest differs from the dataset bytes.');
  }
  const selection = recipe.selection;
  if (selection?.mode === 'ALL_ELIGIBLE' && hasExactFields(selection, ['mode'])) return recipe;
  if (planBased || fitOnly) throw recipeError('INVALID_RECIPE', 'This recipe requires selection of all eligible rows.');
  if (selection?.mode !== 'EXPLICIT' || !hasExactFields(selection, ['mode', 'rowIds'])
    || !Array.isArray(selection.rowIds)) {
    throw recipeError('INVALID_RECIPE', 'Invalid selection mode or fields.');
  }
  const seen = new Set();
  for (const rowId of selection.rowIds) {
    if (!validId(rowId)) throw recipeError('INVALID_SELECTED_ROW_ID', 'Invalid selected row identity.');
    if (seen.has(rowId)) {
      throw recipeError('DUPLICATE_SELECTED_ROW', 'A selected row is repeated.', { rowId });
    }
    seen.add(rowId);
  }
  return recipe;
}

function compareId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function selectedTeacherGroups(dataset, trainingRows, selection) {
  const eligible = new Set(trainingRows.map((row) => row.sampleId));
  const selected = selection.mode === 'EXPLICIT' ? new Set(selection.rowIds) : eligible;
  const allRows = new Map(dataset.rows.map((row) => [row.rowId, row]));
  for (const rowId of selected) {
    if (!eligible.has(rowId)) {
      const code = allRows.has(rowId) ? 'SELECTED_ROW_INELIGIBLE' : 'SELECTED_ROW_UNKNOWN';
      throw recipeError(code, 'A selected row must belong to the eligible roster.', { rowId });
    }
    const row = allRows.get(rowId);
    if (!validId(row.groupId) || Object.hasOwn(row.annotation ?? {}, 'historicalAvailability')) {
      throw recipeError('INVALID_GROUPED_ROW', 'The grouped recipe requires a group and legacy annotation.', { rowId });
    }
  }
  const groups = new Map();
  for (const row of dataset.rows) {
    if (!eligible.has(row.rowId) || !validId(row.groupId)) continue;
    let group = groups.get(row.groupId);
    if (!group) {
      group = { groupId: row.groupId, rowIds: [], role: 'FIT',
        startedAt: row.source.firstStartedAt, readyAt: 0 };
      groups.set(row.groupId, group);
    }
    group.rowIds.push(row.rowId);
    group.startedAt = Math.min(group.startedAt, row.source.firstStartedAt);
    group.readyAt = Math.max(group.readyAt, row.source.sourceAvailableAt, row.source.finishedAt);
  }
  const chosenGroups = [];
  for (const group of groups.values()) {
    if (!group.rowIds.some((rowId) => selected.has(rowId))) continue;
    const missing = group.rowIds.find((rowId) => !selected.has(rowId));
    if (missing !== undefined) {
      throw recipeError('PARTIAL_SELECTED_GROUP', 'Select every eligible row in the group.', {
        groupId: group.groupId, rowId: missing,
      });
    }
    chosenGroups.push(group);
  }
  chosenGroups.sort((a, b) => a.startedAt - b.startedAt || compareId(a.groupId, b.groupId));
  return { groups: chosenGroups, selected };
}

function holdoutBoundary(groups, selectedCount) {
  const minRows = Math.max(MIN_HOLDOUT_ROWS, Math.ceil(HOLDOUT_FRACTION * selectedCount));
  let index = groups.length, rows = 0;
  while (index > 0 && (rows < minRows || groups.length - index < MIN_HOLDOUT_GROUPS)) {
    rows += groups[--index].rowIds.length;
  }
  if (rows < minRows || groups.length - index < MIN_HOLDOUT_GROUPS) {
    return { cutoff: null, reason: 'TOO_FEW_HOLDOUT_GROUPS_OR_ROWS' };
  }
  const cutoff = groups[index].startedAt;
  const development = groups.slice(0, index).filter((group) => group.readyAt < cutoff);
  const developmentRows = development.reduce((count, group) => count + group.rowIds.length, 0);
  if (development.length < MIN_DEVELOPMENT_GROUPS || developmentRows < MIN_DEVELOPMENT_ROWS) {
    return { cutoff: null, reason: 'TOO_FEW_DEVELOPMENT_GROUPS_OR_ROWS' };
  }
  for (const [position, group] of groups.entries()) {
    if (position >= index) group.role = 'HOLDOUT';
    else if (group.readyAt >= cutoff) group.role = 'PURGED';
  }
  return { cutoff, reason: null };
}

function historicalAvailability(row) {
  const { source, annotation, annotationRecordedAt, features } = row;
  const explicit = annotation.historicalAvailability;
  if (explicit) {
    return explicit.availableAt === null ? null : Math.max(source.sourceAvailableAt, explicit.availableAt);
  }
  if (source.scopeChanged === false && canonical(source.plannedFeatures) === canonical(features)) {
    return source.sourceAvailableAt;
  }
  if (isNonnegativeSafeInteger(annotationRecordedAt)) {
    return Math.max(source.sourceAvailableAt, annotationRecordedAt);
  }
  return null;
}

function buildAtlmTeacherPlanProtocol(dataset, trainingRows, recipe, protocolVersion) {
  const includeHistory = protocolVersion === ATLM_TEACHER_PROTOCOL_V2;
  const fitRowIds = trainingRows.map((row) => row.sampleId);
  const fitIds = new Set(fitRowIds);
  const rowDecisions = dataset.rows.map((row) => {
    const fitted = fitIds.has(row.rowId);
    return {
      rowId: row.rowId, planId: row.planId, eligibility: row.eligibility,
      role: fitted ? 'FIT' : 'EXCLUDED', reasons: row.reasons,
      ...(includeHistory ? { historicalAvailableAt: fitted ? historicalAvailability(row) : null } : {}),
    };
  });
  const trainCutoff = trainingRows.reduce((cutoff, row) => Math.max(cutoff ?? 0, row.sourceAvailableAt), null);
  const split = {
    protocolVersion,
    ...(includeHistory ? { backtestUse: recipe.backtestUse, backtestUseNote: recipe.backtestUseNote } : {}),
  };
  return { split, rowDecisions, selectedRowIds: fitRowIds, fitRowIds, trainCutoff };
}

function buildAtlmTeacherSplit(dataset, trainingRows, recipe) {
  const protocolVersion = atlmTeacherProtocolVersion(recipe);
  if (protocolVersion !== ATLM_TEACHER_TRAINER_VERSION) {
    return buildAtlmTeacherPlanProtocol(dataset, trainingRows, recipe, protocolVersion);
  }
  const { groups, selected } = selectedTeacherGroups(dataset, trainingRows, recipe.selection);
  const boundary = holdoutBoundary(groups, selected.size);
  const groupById = new Map(groups.map((group) => [group.groupId, group]));
  const selectedRowIds = [], fitRowIds = [], holdoutRowIds = [], purgedRowIds = [];
  let trainCutoff = null;
  const rowDecisions = dataset.rows.map(({ rowId, planId, groupId, eligibility, reasons }) => {
    let role = 'EXCLUDED';
    if (eligibility === 'ELIGIBLE') {
      if (selected.has(rowId)) {
        role = groupById.get(groupId).role;
        selectedRowIds.push(rowId);
        if (role === 'FIT') fitRowIds.push(rowId);
        if (role === 'HOLDOUT') holdoutRowIds.push(rowId);
        if (role === 'PURGED') purgedRowIds.push(rowId);
      } else {
        role = 'OUTSIDE_SELECTED_SUBSET';
        reasons = [role];
      }
    }
    return { rowId, planId, groupId, eligibility, role, reasons };
  });
  const fitIds = new Set(fitRowIds);
  for (const row of trainingRows) {
    if (fitIds.has(row.sampleId)) trainCutoff = Math.max(trainCutoff ?? 0, row.sourceAvailableAt);
  }
  const split = {
    holdoutUse: recipe.holdoutUse,
    holdoutUseNote: recipe.holdoutUseNote,
    holdoutStatus: boundary.reason ? 'UNAVAILABLE' : 'AVAILABLE',
    holdoutReason: boundary.reason,
    holdoutCutoff: boundary.cutoff,
    groups,
  };
  return { split, rowDecisions, selectedRowIds, fitRowIds, holdoutRowIds, purgedRowIds, trainCutoff };
}

async function atlmTeacherFitReference(trainingRows) {
  // Match atlmSortedRows in the serving solver for both the digest and manifest.
  const rows = trainingRows.slice().sort(
    (a, b) => compareId(a.planId, b.planId) || compareId(a.sampleId, b.sampleId),
  );
  const medianMs = median(rows.map((row) => row.actualMs));
  return {
    trainRowCount: rows.length,
    trainDigest: 'sha256:' + (await hashCommandInput(rows)),
    medianPointMs: medianMs === null ? null : Math.round(medianMs),
    manifest: rows.map(({ sampleId, planId }) => ({ sampleId, planId })),
    trainCutoff: rows.reduce((cutoff, row) => Math.max(cutoff ?? 0, row.sourceAvailableAt), null),
  };
}

function atlmTeacherRollingHistory(protocol, trainingRows) {
  if (protocol.split.protocolVersion === ATLM_TEACHER_PROTOCOL_V2) {
    const availability = new Map(protocol.rowDecisions.map(({ rowId, historicalAvailableAt }) => [
      rowId, historicalAvailableAt,
    ]));
    const history = trainingRows.flatMap((row) => {
      const availableAt = availability.get(row.sampleId);
      return availableAt == null ? [] : [{ ...row, sourceAvailableAt: availableAt }];
    }).sort((a, b) => compareId(a.planId, b.planId) || compareId(a.sampleId, b.sampleId));
    return (target) => history.filter((row) =>
      row.planId !== target.planId && row.sourceAvailableAt < target.capturedAt);
  }
  const groups = protocol.split.groups.filter((group) => group.role === 'FIT');
  const groupByRow = new Map();
  for (const group of groups) for (const rowId of group.rowIds) groupByRow.set(rowId, group);
  const chronological = trainingRows.slice().sort(
    (a, b) => compareId(a.planId, b.planId) || compareId(a.sampleId, b.sampleId),
  );
  return (target) => {
    const targetGroup = groupByRow.get(target.sampleId);
    if (!targetGroup) return [];
    return chronological.filter((row) => {
      const group = groupByRow.get(row.sampleId);
      return group && group !== targetGroup && group.readyAt < targetGroup.startedAt;
    });
  };
}

function atlmTeacherCase(row, {
  featureBasis,
  prediction,
  trainRowCount = null,
  trainDigest = null,
  medianPointMs = null,
  scoringExclusionReason = null,
  fallbackReason = prediction?.hybrid?.fallbackReason
    ?? prediction?.fallback?.atlmUnavailableReason ?? null,
}) {
  const actualMs = row.source?.actualMs ?? null;
  const pointMs = prediction?.status === 'AVAILABLE' && isNonnegativeSafeInteger(prediction.pointMs)
    ? prediction.pointMs : null;
  const pointUnavailableReason = pointMs === null
    ? prediction?.unavailableReason ?? prediction?.reason ?? 'FORECAST_UNAVAILABLE' : null;
  const recordedInterval = prediction?.interval;
  let interval = atlmUnavailableInterval(
    'BAYESIAN_PREDICTIVE', pointUnavailableReason ?? 'INTERVAL_NOT_RECORDED',
  );
  if (recordedInterval?.status === 'AVAILABLE' && pointMs !== null
    && isNonnegativeSafeInteger(recordedInterval.lowerMs)
    && isNonnegativeSafeInteger(recordedInterval.upperMs)
    && recordedInterval.lowerMs <= pointMs && pointMs <= recordedInterval.upperMs) {
    interval = {
      status: 'AVAILABLE', lowerMs: recordedInterval.lowerMs, upperMs: recordedInterval.upperMs,
      nominalCoverage: recordedInterval.nominalCoverage ?? interval.nominalCoverage,
      engine: recordedInterval.engine ?? interval.engine,
      calibrationSampleCount: recordedInterval.calibrationSampleCount ?? 0,
      validationStatus: recordedInterval.validationStatus ?? interval.validationStatus,
      unavailableReason: null,
    };
  } else if (recordedInterval?.status === 'UNAVAILABLE'
    && typeof recordedInterval.unavailableReason === 'string' && recordedInterval.unavailableReason.trim()) {
    interval = {
      ...atlmUnavailableInterval(
        recordedInterval.engine ?? interval.engine, recordedInterval.unavailableReason,
        recordedInterval.calibrationSampleCount ?? 0,
      ),
      nominalCoverage: recordedInterval.nominalCoverage ?? interval.nominalCoverage,
      validationStatus: recordedInterval.validationStatus ?? interval.validationStatus,
    };
  } else if (recordedInterval) {
    interval.unavailableReason = 'INVALID_ISSUED_INTERVAL';
  }
  const scorable = scoringExclusionReason === null && actualMs !== null && pointMs !== null;
  return {
    rowId: row.rowId,
    planId: row.planId,
    groupId: row.groupId,
    actualMs,
    featureBasis,
    trainRowCount,
    trainDigest,
    pointMs,
    pointEngine: pointMs === null ? null : prediction.pointEngine ?? null,
    pointStatus: pointMs === null ? 'UNAVAILABLE' : 'AVAILABLE',
    pointUnavailableReason,
    fallbackReason,
    signedErrorMs: scorable ? pointMs - actualMs : null,
    interval,
    intervalCovered: scorable && interval.status === 'AVAILABLE'
      ? interval.lowerMs <= actualMs && actualMs <= interval.upperMs : null,
    medianPointMs,
    scoringExclusionReason,
  };
}

function scopeExclusion(source) {
  if (source?.scopeChanged === false) return null;
  return source?.scopeChanged === true ? 'SCOPE_CHANGED' : 'SCOPE_CHANGE_UNKNOWN';
}

function atlmTeacherPlannedExclusion(source) {
  return scopeExclusion(source) ?? (source.plannedFeatures == null ? 'PLANNED_FEATURES_UNAVAILABLE' : null);
}

function atlmTeacherRollingCase(row, basis, args) {
  const scoringExclusionReason = basis === 'PLANNED' ? atlmTeacherPlannedExclusion(row.source) : null;
  const { groupId, ...result } = atlmTeacherCase(row, {
    ...args,
    featureBasis: basis,
    scoringExclusionReason,
    ...(scoringExclusionReason === null ? {} : {
      prediction: { status: 'UNAVAILABLE', reason: scoringExclusionReason },
      fallbackReason: null,
      medianPointMs: null,
    }),
  });
  return result;
}

function atlmTeacherHoldoutCase(row, basis, artifact, fitReference, reason = null) {
  const planned = basis === 'PLANNED';
  const source = row.source;
  const scoringExclusionReason = planned ? atlmTeacherPlannedExclusion(source) : null;
  const unavailable = scoringExclusionReason ?? reason ?? 'ARTIFACT_UNAVAILABLE';
  const prediction = artifact && scoringExclusionReason === null
    ? predictAtlm(artifact, planned ? source.plannedFeatures : row.features)
    : { status: 'UNAVAILABLE', reason: unavailable };
  return atlmTeacherCase(row, {
    featureBasis: basis,
    prediction,
    trainRowCount: fitReference.trainRowCount,
    trainDigest: fitReference.trainDigest,
    medianPointMs: scoringExclusionReason === null ? fitReference.medianPointMs : null,
    scoringExclusionReason,
  });
}

function atlmTeacherIssuedCase(row, { includeGroups = true } = {}) {
  const source = row.source;
  const issued = source?.issuedPrediction;
  const issuedAt = isNonnegativeSafeInteger(issued?.calculatedAt) ? issued.calculatedAt : null;
  const pointRecorded = issued?.status === 'AVAILABLE' && isNonnegativeSafeInteger(issued.pointMs);
  const scoringExclusionReason = scopeExclusion(source)
    ?? (!fitSourceValid(source, row.planId) ? 'ACTUAL_MEASUREMENT_UNVERIFIED' : null)
    ?? (pointRecorded && (issuedAt === null || issuedAt > source.firstStartedAt)
      ? 'ISSUED_TIME_UNVERIFIED' : null);
  const prediction = issued ? {
    ...issued,
    pointEngine: issued.pointEngine ?? (issued.method?.id === 'historical-median' ? 'MEDIAN' : null),
    reason: issued.reason ?? (issued.status === 'AVAILABLE' && !pointRecorded
      ? 'INVALID_ISSUED_POINT' : null),
  } : { status: 'UNAVAILABLE', reason: 'ISSUED_FORECAST_NOT_RECORDED' };
  const result = {
    ...atlmTeacherCase(row, { featureBasis: 'ISSUED', prediction, scoringExclusionReason }),
    issuedModelId: issued?.modelId ?? null,
    issuedModelRevision: issued?.modelRevisionId ?? issued?.modelRevision ?? null,
    issuedAt,
  };
  if (!includeGroups) delete result.groupId;
  return result;
}

function atlmTeacherMedianMetrics(cases) {
  return summarizeAtlmV4Metrics(cases.map(({ planId, actualMs, medianPointMs }) => ({
    planId, actualMs, pointMs: medianPointMs,
    interval: atlmUnavailableInterval('BAYESIAN_PREDICTIVE', 'MEDIAN_INTERVAL_UNAVAILABLE'),
  })));
}

function summarizeAtlmTeacherMode(cases, { reason = null, includeMedian = true, includeGroups = true } = {}) {
  const comparable = cases.filter((item) => item.scoringExclusionReason === null);
  const paired = includeMedian && !reason
    ? comparable.filter((item) => item.pointMs !== null && item.medianPointMs !== null) : [];
  const noMetric = reason !== null || comparable.length === 0;
  const summary = {
    rowCount: cases.length,
    ...(includeGroups ? { groupCount: new Set(cases.map((item) => item.groupId)).size } : {}),
    excludedFromScoringCount: cases.length - comparable.length,
    forecastAvailability: {
      numerator: cases.filter((item) => item.pointMs !== null).length,
      denominator: cases.length,
    },
    intervalAvailability: {
      numerator: cases.filter((item) => item.interval.status === 'AVAILABLE').length,
      denominator: cases.length,
    },
    metrics: noMetric ? null : summarizeAtlmV4Metrics(comparable),
  };
  const unavailableReason = reason ?? (comparable.length === 0 ? 'NO_COMPARABLE_ROWS' : null)
    ?? (summary.metrics?.pointCaseCount === 0 ? 'NO_AVAILABLE_FORECASTS' : null);
  return {
    status: unavailableReason === null ? 'AVAILABLE' : 'UNAVAILABLE',
    reason: unavailableReason,
    summary,
    median: includeMedian && !noMetric ? atlmTeacherMedianMetrics(comparable) : null,
    paired: paired.length ? {
      rowIds: paired.map((item) => item.rowId),
      ...(includeGroups ? { groupCount: new Set(paired.map((item) => item.groupId)).size } : {}),
      candidate: summarizeAtlmV4Metrics(paired),
      median: atlmTeacherMedianMetrics(paired),
    } : null,
    cases,
  };
}

export {
  ATLM_DATASET_VERSION, TEACHER_ANNOTATIONS_CONTRACT, TEACHER_DATASET_CONTRACT,
  ATLM_TEACHER_TRAINER_VERSION, ATLM_TEACHER_RECIPE_ID, ATLM_TEACHER_CODE_PATHS, ATLM_TEACHER_MODES,
  ATLM_TEACHER_PROTOCOL_V2, ATLM_TEACHER_RECIPE_ID_V2, ATLM_TEACHER_MODES_V2,
  ATLM_TEACHER_PROTOCOL_V3, ATLM_TEACHER_RECIPE_ID_V3,
  buildAtlmTeacherTrainingRows, mergeAtlmTeacherAnnotations, readAtlmTeacherDataset,
  atlmTeacherProtocolVersion, parseAtlmTeacherRecipe, buildAtlmTeacherSplit, atlmTeacherFitReference,
  atlmTeacherRollingHistory, atlmTeacherCase, atlmTeacherPlannedExclusion, atlmTeacherRollingCase,
  atlmTeacherHoldoutCase, atlmTeacherIssuedCase, summarizeAtlmTeacherMode,
};
