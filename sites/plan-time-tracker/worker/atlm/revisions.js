import {
  appError, canonical, dbAll, dbFirst, ensureOwner, hashCommandInput, isPlainRecord,
  isSnapshotDigest, messageFor, parseColumn,
} from '../shared/index.js';
import {
  ATLM_FEATURE_VERSION, ATLM_METHOD, atlmArtifactValid, isNonnegativeSafeInteger, validateAssessmentValue,
} from './model.js';
import { processAtlmSampleRefresh, readAtlmSampleRefreshStatus } from './sample-refresh.js';
import { readAtlmServingState } from './serving.js';
import { readAtlmModelRevisions } from './model-evidence.js';
import {
  ATLM_MAX_UPLOAD_BYTES, ATLM_PART_BYTES, ATLM_UPLOAD_READY_SQL, ATLM_UPLOAD_TTL_MS, atlmUploadReadyArgs, hashAtlmTextChunks, materializeAtlmRevisionFile,
  prepareAtlmUpload, putAtlmUploadPart, readAtlmRevisionFilePart, readAtlmUpload, readyAtlmUploadStatement,
  sliceAtlmExportText,
} from './revision-files.js';
import {
  ATLM_DATASET_VERSION, ATLM_TEACHER_CODE_PATHS, ATLM_TEACHER_MODES, ATLM_TEACHER_TRAINER_VERSION,
  TEACHER_ANNOTATIONS_CONTRACT, TEACHER_DATASET_CONTRACT, atlmTeacherCase, atlmTeacherFitReference,
  atlmTeacherHoldoutCase, atlmTeacherIssuedCase, atlmTeacherRollingHistory, buildAtlmTeacherSplit,
  mergeAtlmTeacherAnnotations, parseAtlmTeacherRecipe, readAtlmTeacherDataset, summarizeAtlmTeacherMode,
} from './teacher-dataset.js';

const SCHEMA_VERSION = ATLM_DATASET_VERSION;
const BASE64_PART_CHARS = Math.ceil(ATLM_PART_BYTES / 3) * 4;
const COMPACT_REASON_COUNT = 16;
const COMPACT_MAX_BYTES = 96 * 1024;
const PAGE_MAX = 50;
const DEFAULT_PAGE_SIZE = 25;
const VALIDATION_BATCH_ROWS = 32;
const MIN_ROLLING_REGRESSION_ROWS = 2;
const DOCUMENT_MAX_DEPTH = 32;
const SNAPSHOT_CONTRACT = 'atlm-training-snapshot';
const SNAPSHOT_EXPORT_FORMAT = 'snapshot-json-slices-v1';
const SNAPSHOT_READ_BYTES = 2 * ATLM_PART_BYTES;
const HEX_DIGITS = '0123456789ABCDEF';

const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[!-~]+$' };
const uuid = { type: 'string', format: 'uuid' };
const number = { type: 'integer', minimum: 0 };
const version = { type: 'integer', enum: [SCHEMA_VERSION] };
const digest = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$', minLength: 71, maxLength: 71 };
const enumString = (...values) => ({ type: 'string', enum: values });
const branch = (properties, optional = []) => ({
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', ...Object.keys(properties).filter((key) => !optional.includes(key))],
  properties: { schemaVersion: version, ...properties },
});
const page = {
  cursor: { type: 'string', minLength: 1, maxLength: 1024 },
  limit: { type: 'integer', minimum: 1, maximum: PAGE_MAX },
};
const file = {
  type: 'object', additionalProperties: false, required: ['sha256', 'byteLength'],
  properties: { sha256: digest, byteLength: { type: 'integer', minimum: 1, maximum: ATLM_MAX_UPLOAD_BYTES } },
};
const fieldForView = (view) => view === 'filePart' ? { partIndex: number } : {};
function readBranches(identity, views, listOptions = {}, common = {}) {
  return views.map((view) => branch({
    ...common, view: enumString(view),
    ...(view === 'list' ? listOptions : { [identity]: id }),
    ...(view === 'list' || view === 'rows' ? page : {}),
    ...fieldForView(view),
  }, ['cursor', 'limit', ...Object.keys(listOptions)]));
}
function uploadBranches(properties, optional = []) {
  return ['prepare', 'putPart', 'commit'].map((phase) => branch({
    ...properties, commandId: uuid, phase: enumString(phase), file,
    ...(phase === 'putPart' ? {
      partIndex: { ...number, maximum: Math.ceil(ATLM_MAX_UPLOAD_BYTES / ATLM_PART_BYTES) - 1 },
      contentBase64: { type: 'string', minLength: 4, maxLength: BASE64_PART_CHARS,
        pattern: '^[A-Za-z0-9+/]+={0,2}$' },
    } : {}),
  }, optional));
}

const REVISION_BRANCHES = Object.freeze({
  CreateTrainingSnapshot: [
    branch({ mode: enumString('create'), commandId: uuid }),
    ...readBranches('snapshotId', ['summary', 'rows', 'download', 'filePart', 'list'], {}, { mode: enumString('read') }),
  ],
  SaveDatasetRevision: uploadBranches({ snapshotId: id, parentDatasetRevisionId: { ...id, type: ['string', 'null'] } },
    ['parentDatasetRevisionId']),
  GetDatasetRevision: readBranches('datasetRevisionId', ['summary', 'rows', 'download', 'filePart', 'list'], { snapshotId: id }),
  RegisterModelRevision: uploadBranches({ datasetRevisionId: id }),
  ListModelRevisions: [
    ...['list', 'activations'].map((view) => branch({ view: enumString(view), ...page }, ['cursor', 'limit'])),
    branch({ view: enumString('detail'), modelRevisionId: id }),
    ...['download', 'filePart'].map((view) => branch({
      view: enumString(view), modelRevisionId: id, fileKind: enumString('ARTIFACT', 'BUNDLE'),
      ...fieldForView(view),
    }, ['fileKind'])),
  ],
  ActivateModelRevision: [branch({
    commandId: uuid, modelRevisionId: id, expectedActiveModelRevisionId: { ...id, type: ['string', 'null'] },
    expectedActivationVersion: number, reason: { type: 'string', minLength: 1, maxLength: 400 },
    acceptExperimental: { type: 'boolean' },
  }, ['acceptExperimental'])],
});
const DISCRIMINATORS = ['mode', 'view', 'phase'];
const ATLM_REVISION_TOOL_SCHEMAS = Object.freeze(Object.fromEntries(
  Object.entries(REVISION_BRANCHES).map(([name, branches]) => {
    const properties = Object.assign({}, ...branches.map((shape) => shape.properties));
    for (const key of DISCRIMINATORS) {
      const values = branches.flatMap((shape) => shape.properties[key]?.enum ?? []);
      if (values.length) properties[key] = enumString(...new Set(values));
    }
    return [name, { type: 'object', properties, required: ['schemaVersion'], oneOf: branches }];
  }),
));
const ATLM_REVISION_LIMITS = Object.freeze({
  uploadMaxBytes: ATLM_MAX_UPLOAD_BYTES, partSize: ATLM_PART_BYTES, maxCompactResponseBytes: COMPACT_MAX_BYTES,
  maxPageSize: PAGE_MAX, uploadTtlMs: ATLM_UPLOAD_TTL_MS,
});

function validateTool(name, args) {
  if (!isPlainRecord(args)) throw appError('VALIDATION_ERROR', messageFor('VALIDATION_ERROR'));
  const shape = REVISION_BRANCHES[name]?.find((candidate) =>
    DISCRIMINATORS.every((key) =>
      !candidate.properties[key] || candidate.properties[key].enum.includes(args[key])));
  if (!shape) throw appError('VALIDATION_ERROR', 'Неизвестный режим операции.');
  validateAssessmentValue(args, shape);
}

function error(code, status, details) {
  return appError(code, messageFor(code), status, details);
}

function semanticArguments(name, args) {
  const { phase, partIndex, contentBase64, ...semantic } = args;
  if (name === 'SaveDatasetRevision') semantic.parentDatasetRevisionId ??= null;
  if (name === 'ActivateModelRevision') {
    semantic.acceptExperimental ??= false;
    semantic.reason = semantic.reason.trim();
  }
  return semantic;
}

async function commandContext(db, ownerId, name, args, nowMs) {
  const payload = semanticArguments(name, args);
  const hash = await hashCommandInput({ commandType: name, ...payload });
  return { db, ownerId, name, args: payload, commandId: payload.commandId, hash, nowMs };
}

async function commandReceipt(context) {
  const { db, ownerId, commandId, hash, name } = context;
  const row = await dbFirst(db,
    'SELECT command_type,payload_hash,outcome_code,result_json FROM command_receipts WHERE owner_id=? AND command_id=?',
    ownerId, commandId);
  if (row && (row.payload_hash !== hash || row.command_type !== name))
    throw error('IDEMPOTENCY_KEY_REUSED', 409, { commandId });
  return row;
}

function finishedResult(receipt) {
  if (!receipt || receipt.outcome_code === 'PENDING') return null;
  const value = parseColumn(receipt.result_json, {});
  if (receipt.outcome_code !== 'OK') throw error(receipt.outcome_code, 409, value);
  return { ...value, replayed: true };
}

const PENDING_COMMAND_SQL = 'SELECT 1 FROM command_receipts WHERE owner_id=? AND command_id=? AND payload_hash=? AND outcome_code=\'PENDING\'';

function pendingArgs(context) {
  return [context.ownerId, context.commandId, context.hash];
}

function reserveCommand(context, condition = '1', values = []) {
  const { db, ownerId, name, commandId, hash, args, nowMs } = context;
  return db.prepare(
    'INSERT OR IGNORE INTO command_receipts(owner_id,command_id,payload_hash,command_type,server_now_ms,'
    + "actor_id,actor_type,payload_json,outcome_code,recorded_at) SELECT ?,?,?,?, ?,?,'agent',?,'PENDING',?"
    + ' WHERE ' + condition,
  ).bind(ownerId, commandId, hash, name, nowMs, ownerId, JSON.stringify(args), nowMs, ...values);
}

function finalizeCommand(context, value, outcome = 'OK', condition = '1', values = []) {
  return context.db.prepare(
    'UPDATE command_receipts SET outcome_code=?,result_json=?,recorded_at=?'
    + " WHERE owner_id=? AND command_id=? AND payload_hash=? AND outcome_code='PENDING' AND (" + condition + ')',
  ).bind(outcome, JSON.stringify(value), context.nowMs, ...pendingArgs(context), ...values);
}

async function commitResult(context, statements) {
  const results = await context.db.batch(statements);
  const receipt = await commandReceipt(context);
  const value = finishedResult(receipt);
  if (!value) return null;
  const writes = results.at(-1)?.meta?.changes > 0;
  return { ...value, replayed: !writes };
}

const SOURCE_SELECTION = [
  'SELECT p.*,i.assessment_sequence,i.forecast_json,i.captured_receipt_rowid,i.requirements_json AS original_reqs,',
  ' s.sequence AS sample_sequence,s.source_generation AS sample_generation,s.source_digest,',
  ' s.eligibility AS eligibility,s.reasons_json,s.features_json,s.actual_ms,s.captured_at,s.source_available_at,',
  ' a.assessment_json,a.assessment_id,a.revision AS assessment_revision,t.requirements_json AS current_reqs,',
  ' coalesce(j.generation,0) AS generation,j.status AS job_status,j.last_error,',
  ' CASE WHEN j.status=\'FAILED\' AND j.generation>j.processed_generation THEN 1 ELSE 0 END AS failed',
  ' FROM plans p LEFT JOIN plan_estimation_inputs i USING(owner_id,plan_id)',
  ' LEFT JOIN estimation_samples s ON s.sequence=(SELECT max(latest.sequence) FROM estimation_samples latest',
  '   WHERE latest.owner_id=p.owner_id AND latest.plan_id=p.plan_id)',
  ' LEFT JOIN assessment_revisions a ON a.owner_id=p.owner_id AND a.plan_id=p.plan_id AND a.sequence=i.assessment_sequence',
  ' LEFT JOIN assessment_targets t ON t.owner_id=p.owner_id AND t.plan_id=p.plan_id AND t.step_id IS NULL',
  " LEFT JOIN estimation_jobs j ON j.owner_id=p.owner_id AND j.job_key='refresh:'||p.plan_id",
  ' WHERE p.owner_id=?',
].join('\n');
const SOURCES_SETTLED = "NOT EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND kind='REFRESH_SAMPLE'"
  + " AND generation>processed_generation AND status<>'FAILED')";
const RAW_REASONS = "CASE WHEN failed=1 THEN json_array('SOURCE_REFRESH_FAILED')"
  + ' WHEN reasons_json IS NOT NULL THEN reasons_json'
  + " WHEN deleted_at IS NOT NULL THEN json_array('PLAN_DELETED','SOURCE_NOT_OBSERVED')"
  + " WHEN status<>'COMPLETED' THEN json_array('PLAN_NOT_COMPLETED','SOURCE_NOT_OBSERVED')"
  + " ELSE json_array('SOURCE_NOT_OBSERVED') END";

function snapshotHeader(row) {
  return {
    snapshotId: row.snapshot_id, capturedAt: row.captured_at, sourceDataVersion: row.source_data_version,
    featureSchemaVersion: row.feature_version,
    counts: { total: row.row_count, eligible: row.eligible_count, excluded: row.row_count - row.eligible_count,
      failedSources: row.failed_count },
  };
}

async function readSnapshot(db, ownerId, snapshotId) {
  const row = await dbFirst(db,
    'SELECT * FROM estimation_training_snapshots WHERE owner_id=? AND snapshot_id=?', ownerId, snapshotId);
  if (!row) throw error('SNAPSHOT_NOT_FOUND', 404, { snapshotId });
  return row;
}

function sourcesPending(status, nowMs) {
  return error('SOURCES_PENDING', 409, { ...status, retryable: true,
    retryAfterMs: status.nextAttemptAt === null ? null : Math.max(0, status.nextAttemptAt - nowMs) });
}

async function createSnapshot(db, ownerId, args, nowMs, clock) {
  const context = await commandContext(db, ownerId, 'CreateTrainingSnapshot', args, nowMs);
  const replay = finishedResult(await commandReceipt(context));
  if (replay) return { ...replay, ...(await readSnapshot(db, ownerId, context.commandId).then(snapshotHeader)) };
  const pending = await processAtlmSampleRefresh(db, ownerId, nowMs, { clock });
  if (pending.pendingCount) throw sourcesPending(pending, clock?.() ?? nowMs);
  const capturedAt = clock?.() ?? nowMs;
  const snapshotId = context.commandId;
  const value = { snapshotId };
  const sql = [
    'WITH sources AS (' + SOURCE_SELECTION + '), boundary AS (',
    ' SELECT count(*) AS total,coalesce(sum(eligibility=\'ELIGIBLE\' AND failed=0),0) AS eligible,',
    ' coalesce(sum(failed),0) AS failed FROM sources)',
    ' INSERT INTO estimation_training_snapshots(owner_id,snapshot_id,captured_at,source_data_version,',
    '  feature_version,row_count,eligible_count,failed_count)',
    ' SELECT ?,?,?,coalesce((SELECT dataset_revision FROM estimation_owner_state WHERE owner_id=?),0),',
    '  ?,total,eligible,failed FROM boundary WHERE EXISTS(' + PENDING_COMMAND_SQL + ')',
  ].join('\n');
  const rows = [
    'WITH sources AS (' + SOURCE_SELECTION + ')',
    'INSERT INTO estimation_training_snapshot_rows(owner_id,snapshot_id,row_id,ordinal,plan_id,source_generation,',
    ' sample_sequence,assessment_sequence,forecast_sequence,raw_eligibility,raw_reasons_json,source_json,evidence_json)',
    'SELECT p.owner_id,?,p.plan_id,row_number() OVER(ORDER BY registered_at,plan_id)-1,p.plan_id,p.generation,',
    " p.sample_sequence,p.assessment_sequence,CASE WHEN forecast_json IS NOT NULL THEN assessment_sequence END,",
    " CASE WHEN failed=0 AND eligibility='ELIGIBLE' THEN 'ELIGIBLE' ELSE 'EXCLUDED' END," + RAW_REASONS + ',',
    " json_object('planId',p.plan_id,'status',CASE WHEN failed=0 AND actual_ms IS NOT NULL THEN 'AVAILABLE' ELSE 'UNAVAILABLE' END,",
    "  'planStatus',p.status,'deletedAt',deleted_at,'sourceGeneration',generation,'sampleGeneration',sample_generation,",
    "  'sampleId',cast(sample_sequence AS TEXT),'sourceDigest',source_digest,'sampleDigest',source_digest,",
    "  'inputAssessmentSequence',assessment_sequence,'firstStartedAt',first_started_at,'finishedAt',finished_at,",
    "  'capturedAt',captured_at,'sourceAvailableAt',source_available_at,'actualMs',CASE WHEN failed=0 THEN actual_ms END,",
    "  'issuedPrediction',json(forecast_json),'plannedFeatures',json(features_json),",
    "  'scopeChanged',json(CASE WHEN original_reqs IS NULL THEN 'null' WHEN original_reqs IS NOT current_reqs OR",
    "    EXISTS(SELECT 1 FROM json_each(reasons_json) WHERE value='SCOPE_CHANGED') THEN 'true' ELSE 'false' END),",
    "  'originalAssessment',json(CASE WHEN assessment_id IS NOT NULL THEN json_object('assessmentId',assessment_id,",
    "    'revision',assessment_revision,'sequence',assessment_sequence,'value',json(assessment_json)) END),",
    "  'refreshError',CASE WHEN failed=1 THEN coalesce(last_error,'SOURCE_REFRESH_FAILED') END,",
    "  'evidenceRefs',json((SELECT json_group_array(json_object('kind','COMMAND','id',command_id)) FROM command_receipts r",
    "    WHERE r.owner_id=p.owner_id AND r.plan_id=p.plan_id AND r.outcome_code='OK'))),",
    " json_object('title',p.title,'description',p.description,'acceptanceCriteria',p.acceptance_criteria,",
    "  'markdown',(SELECT markdown FROM plan_documents d WHERE d.owner_id=p.owner_id AND d.plan_id=p.plan_id),",
    "  'originalRequirements',json(original_reqs),'currentRequirements',json(current_reqs),",
    "  'steps',json((SELECT json_group_array(json_object('stepId',step_id,'ordinal',ordinal,'title',title,",
    "    'status',status,'content',content,'version',version)) FROM",
    "    (SELECT * FROM plan_steps s WHERE s.owner_id=p.owner_id AND s.plan_id=p.plan_id ORDER BY ordinal,step_id))),",
    "  'intervals',json((SELECT json_group_array(json_object('intervalId',interval_id,'startMs',start_ms,'endMs',end_ms)) FROM",
    "    (SELECT * FROM work_intervals w WHERE w.owner_id=p.owner_id AND w.plan_id=p.plan_id ORDER BY start_ms,interval_id))),",
    "  'journal',json((SELECT json_group_array(json_object('sequence',sequence,'eventType',command_type,",
    "     'occurredAt',server_now_ms,'stepId',json_extract(payload_json,'$.stepId'),",
    "     'commandId',command_id,'payload',json(payload_json))) FROM (SELECT rowid AS sequence,* FROM command_receipts j",
    "     WHERE j.owner_id=p.owner_id AND j.plan_id=p.plan_id AND j.outcome_code='OK' ORDER BY rowid))),",
    "  'outcome',json((SELECT json_object('commandId',command_id,'finishedAt',server_now_ms,",
    "     'completionNote',json_extract(payload_json,'$.completionNote'),'reason',json_extract(payload_json,'$.reason'))",
    "     FROM command_receipts r WHERE r.owner_id=p.owner_id AND r.plan_id=p.plan_id AND r.outcome_code='OK'",
    "      AND r.command_type='FinishPlan' ORDER BY rowid DESC LIMIT 1)))",
    'FROM sources p WHERE EXISTS(' + PENDING_COMMAND_SQL + ')',
  ].join('\n');
  const result = await commitResult(context, [
    reserveCommand(context, SOURCES_SETTLED, [ownerId]),
    db.prepare(sql).bind(ownerId, ownerId, snapshotId, capturedAt, ownerId, ATLM_FEATURE_VERSION, ...pendingArgs(context)),
    db.prepare(rows).bind(ownerId, snapshotId, ...pendingArgs(context)),
    finalizeCommand(context, value),
  ]);
  if (!result) throw sourcesPending(await readAtlmSampleRefreshStatus(db, ownerId, capturedAt), capturedAt);
  return { ...result, ...snapshotHeader(await readSnapshot(db, ownerId, snapshotId)) };
}

function snapshotRow(row) {
  return {
    rowId: row.row_id, planId: row.plan_id, rawEligibility: row.raw_eligibility,
    rawReasons: JSON.parse(row.raw_reasons_json), source: JSON.parse(row.source_json),
    evidence: JSON.parse(row.evidence_json),
  };
}

function datasetHeader(row) {
  return {
    datasetRevisionId: row.dataset_revision_id, snapshotId: row.snapshot_id,
    parentDatasetRevisionId: row.parent_dataset_revision_id, createdAt: row.created_at,
    importedAt: row.imported_at, origin: row.origin, featureSchemaVersion: row.feature_version,
    datasetDigest: row.dataset_digest,
    counts: { total: row.row_count, eligible: row.eligible_count, excluded: row.row_count - row.eligible_count },
  };
}

async function readDataset(db, ownerId, datasetRevisionId) {
  const row = await dbFirst(db,
    'SELECT * FROM estimation_dataset_revisions WHERE owner_id=? AND dataset_revision_id=?', ownerId, datasetRevisionId);
  if (!row) throw error('DATASET_REVISION_NOT_FOUND', 404, { datasetRevisionId });
  return row;
}

function datasetRow(row) {
  const annotation = parseColumn(row.annotation_json, null);
  return {
    rowId: row.row_id, planId: row.plan_id, groupId: row.group_id, eligibility: row.eligibility,
    reasons: JSON.parse(row.reasons_json), annotation: row.origin === 'NATIVE' ? annotation?.value ?? null : annotation,
    source: JSON.parse(row.source_json), features: parseColumn(row.features_json, null),
    ...(annotation?.recordedAt !== undefined ? { annotationRecordedAt: annotation.recordedAt } : {}),
    ...(annotation?.origin !== undefined ? { annotationOrigin: annotation.origin } : {}),
    ...(row.origin === 'IMPORTED' ? { record: JSON.parse(row.record_json) } : {}),
  };
}

async function cursorContext(ownerId, view, selector, args, initial) {
  const scope = await hashCommandInput({ ownerId, view, selector });
  if (!args.cursor) return { scope, position: initial, watermark: null };
  try {
    const value = JSON.parse(atob(args.cursor));
    if (value.version !== SCHEMA_VERSION || value.scope !== scope
      || !Number.isSafeInteger(value.position) || value.position < initial
      || (value.watermark !== null && (!Number.isSafeInteger(value.watermark) || value.watermark < value.position)))
      throw Error();
    return value;
  } catch {
    throw error('INVALID_CURSOR', 400, { view });
  }
}

function pageResult(cursor, rows, limit, position, project) {
  const textEncoder = new TextEncoder();
  const items = [];
  let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    const projected = project(row);
    const increment = textEncoder.encode(JSON.stringify(projected)).byteLength + 1;
    if (bytes + increment > COMPACT_MAX_BYTES - 2048) break;
    items.push(projected);
    bytes += increment;
  }
  return {
    rows: items,
    nextCursor: items.length > 0 && rows.length > items.length
      ? btoa(JSON.stringify({ ...cursor, version: SCHEMA_VERSION, position: position(rows[items.length - 1]) }))
      : null,
  };
}

async function rowPage(db, ownerId, args, spec, identity) {
  const cursor = await cursorContext(ownerId, spec.table, identity, args, -1);
  const limit = args.limit ?? DEFAULT_PAGE_SIZE;
  const rows = await dbAll(db, [
    'SELECT ordinal,row_id,plan_id,' + spec.eligibility + ' AS eligibility,',
    ' json_array_length(' + spec.reasons + ') AS reason_count,',
    ' (SELECT json_group_array(value) FROM (SELECT value FROM json_each(' + spec.reasons + ') LIMIT ?)) AS reasons_json',
    ' FROM ' + spec.table + ' WHERE owner_id=? AND ' + spec.key + '=? AND ordinal>? ORDER BY ordinal LIMIT ?',
  ].join('\n'), COMPACT_REASON_COUNT, ownerId, identity, cursor.position, limit + 1);
  return pageResult(cursor, rows, limit, (row) => row.ordinal, (row) => {
    const reasons = JSON.parse(row.reasons_json);
    return {
      rowId: row.row_id, planId: row.plan_id, ordinal: row.ordinal, eligibility: row.eligibility,
      reasons, ...(row.reason_count > reasons.length ? { additionalReasonCount: row.reason_count - reasons.length } : {}),
      ...(spec.key === 'snapshot_id' ? { rawEligibility: row.eligibility, rawReasons: reasons } : {}),
    };
  });
}

async function registryPage(db, ownerId, args, spec, parentId) {
  const cursor = await cursorContext(ownerId, spec.table, parentId ?? null, args, 0);
  const condition = parentId ? ' AND snapshot_id=?' : '';
  const filter = parentId ? [ownerId, parentId] : [ownerId];
  if (cursor.watermark === null) {
    const row = await dbFirst(db, 'SELECT coalesce(max(registry_sequence),0) AS newest FROM ' + spec.table
      + ' WHERE owner_id=?' + condition, ...filter);
    cursor.watermark = row.newest;
  }
  const limit = args.limit ?? DEFAULT_PAGE_SIZE;
  const rows = await dbAll(db, 'SELECT * FROM ' + spec.table + ' WHERE owner_id=?' + condition
      + ' AND registry_sequence>? AND registry_sequence<=? ORDER BY registry_sequence LIMIT ?',
    ...filter, cursor.position, cursor.watermark, limit + 1);
  return { ...pageResult(cursor, rows, limit, (row) => row.registry_sequence, spec.header),
    watermark: cursor.watermark };
}

const SNAPSHOTS = { table: 'estimation_training_snapshots', header: snapshotHeader };
const DATASETS = { table: 'estimation_dataset_revisions', header: datasetHeader };
const SNAPSHOT_ROWS = { table: 'estimation_training_snapshot_rows', key: 'snapshot_id',
  eligibility: 'raw_eligibility', reasons: 'raw_reasons_json' };
const DATASET_ROWS = { table: 'estimation_dataset_revision_rows', key: 'dataset_revision_id',
  eligibility: 'eligibility', reasons: 'reasons_json' };

async function* entityRows(db, ownerId, spec, entityId, project, fields = '*') {
  let ordinal = -1;
  for (;;) {
    const rows = await dbAll(db, 'SELECT ' + fields + ' FROM ' + spec.table + ' WHERE owner_id=? AND '
      + spec.key + '=? AND ordinal>? ORDER BY ordinal LIMIT ?', ownerId, entityId, ordinal, VALIDATION_BATCH_ROWS);
    if (rows.length === 0) return;
    for (const row of rows) yield project(row);
    ordinal = rows.at(-1).ordinal;
  }
}

function datasetExportHeader(row) {
  return {
    schemaVersion: SCHEMA_VERSION, contract: TEACHER_DATASET_CONTRACT, datasetRevisionId: row.dataset_revision_id,
    snapshotId: row.snapshot_id, parentDatasetRevisionId: row.parent_dataset_revision_id,
    featureSchemaVersion: row.feature_version, origin: row.origin,
    ...(row.origin === 'IMPORTED' ? { provenance: JSON.parse(row.provenance_json) } : {}),
  };
}

async function* rowExport(header, rows) {
  yield JSON.stringify(header).slice(0, -1) + ',"rows":[';
  let separator = '';
  for await (const row of rows) {
    yield separator + JSON.stringify(row);
    separator = ',';
  }
  yield ']}';
}

function datasetExportReader(db, ownerId, datasetRevisionId, header, rowCount) {
  let page = [];
  return async (index) => {
    if (index === 0) return JSON.stringify(header).slice(0, -1) + ',"rows":[';
    if (index === rowCount + 1) return ']}';
    if (index > rowCount + 1) return null;
    const ordinal = index - 1;
    if (!page.length || ordinal < page[0].ordinal || ordinal > page.at(-1).ordinal) {
      page = await dbAll(db, `SELECT * FROM estimation_dataset_revision_rows
        WHERE owner_id=? AND dataset_revision_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?`,
      ownerId, datasetRevisionId, ordinal, VALIDATION_BATCH_ROWS);
    }
    const row = page[ordinal - (page[0]?.ordinal ?? -1)];
    if (row?.ordinal !== ordinal) throw error('SOURCE_UNAVAILABLE', 503, { reason: 'EXPORT_ROW_MISSING' });
    return (ordinal === 0 ? '' : ',') + JSON.stringify(datasetRow(row));
  };
}

function snapshotExportReader(db, ownerId, snapshotId, header, rowCount) {
  return async (index, offset, available) => {
    if (index === 0) return sliceAtlmExportText(JSON.stringify(header).slice(0, -1) + ',"rows":[', offset, available);
    if (index === rowCount + 1) return sliceAtlmExportText(']}', offset, available);
    if (index > rowCount + 1) return null;
    const limit = Math.min(available, SNAPSHOT_READ_BYTES);
    // The frozen JSON columns are valid JSON. Slice their UTF-8 bytes in SQLite
    // and use hex so a split inside a character survives transport intact.
    const row = await dbFirst(db, `SELECT hex(substr(CAST(
      (CASE WHEN ordinal=0 THEN '' ELSE ',' END) ||
      '{"rowId":' || json_quote(row_id) || ',"planId":' || json_quote(plan_id) ||
      ',"rawEligibility":' || json_quote(raw_eligibility) || ',"rawReasons":' || raw_reasons_json ||
      ',"source":' || source_json || ',"evidence":' || evidence_json || '}' AS BLOB), ?, ?)) AS chunk_hex
      FROM estimation_training_snapshot_rows WHERE owner_id=? AND snapshot_id=? AND ordinal=?`,
    offset + 1, limit + 1, ownerId, snapshotId, index - 1);
    if (!row) throw error('SOURCE_UNAVAILABLE', 503, { reason: 'EXPORT_ROW_MISSING' });
    const length = row.chunk_hex.length / 2;
    const bytes = new Uint8Array(Math.min(length, limit));
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = HEX_DIGITS.indexOf(row.chunk_hex[2 * i]) * 16 + HEX_DIGITS.indexOf(row.chunk_hex[2 * i + 1]);
    }
    return { bytes, done: length <= limit };
  };
}

async function readRevisionEntity(db, ownerId, kind, args, nowMs) {
  const snapshot = kind === 'SNAPSHOT';
  if (args.view === 'list') {
    if (args.snapshotId) await readSnapshot(db, ownerId, args.snapshotId);
    return registryPage(db, ownerId, args, snapshot ? SNAPSHOTS : DATASETS, args.snapshotId);
  }
  const entityId = snapshot ? args.snapshotId : args.datasetRevisionId;
  const row = await (snapshot ? readSnapshot : readDataset)(db, ownerId, entityId);
  const header = (snapshot ? snapshotHeader : datasetHeader)(row);
  const spec = snapshot ? SNAPSHOT_ROWS : DATASET_ROWS;
  if (args.view === 'summary') return header;
  if (args.view === 'rows') return {
    ...header, ...(await rowPage(db, ownerId, args, spec, entityId)), fullExportView: 'download',
  };
  const selector = { storageId: entityId, fileKind: kind };
  if (args.view === 'filePart') return readAtlmRevisionFilePart(db, ownerId, { ...selector, partIndex: args.partIndex });
  const exportHeader = snapshot ? {
    schemaVersion: SCHEMA_VERSION, contract: SNAPSHOT_CONTRACT, snapshotId: entityId,
    capturedAt: header.capturedAt, sourceDataVersion: header.sourceDataVersion,
    featureSchemaVersion: header.featureSchemaVersion,
  } : datasetExportHeader(row);
  const source = snapshot ? {
    readSlice: snapshotExportReader(db, ownerId, entityId, exportHeader, row.row_count), format: SNAPSHOT_EXPORT_FORMAT,
  } : {
    readChunk: datasetExportReader(db, ownerId, entityId, exportHeader, row.row_count),
  };
  const result = await materializeAtlmRevisionFile(db, ownerId, { ...selector, ...source }, nowMs);
  if (!snapshot && result.state === 'READY' && row.dataset_digest !== null && result.file.sha256 !== row.dataset_digest)
    throw error('SOURCE_UNAVAILABLE', 503, { reason: 'DATASET_DIGEST_MISMATCH', datasetRevisionId: entityId });
  return { ...header, ...result };
}

function parseDocument(text, code) {
  try {
    const document = JSON.parse(text);
    const check = (value, depth) => {
      if (depth > DOCUMENT_MAX_DEPTH || (typeof value === 'number' && !Number.isFinite(value)))
        throw new Error();
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) check(child, depth + 1);
      }
    };
    check(document, 0);
    return document;
  } catch {
    throw error(code, 422, { reason: 'INVALID_JSON' });
  }
}

function requireFields(record, fields, code, reason) {
  if (!isPlainRecord(record) || Object.keys(record).length !== fields.length
    || fields.some((field) => !Object.hasOwn(record, field))) throw error(code, 422, { reason });
}

function uploadSelector(context, fileKind) {
  return { storageId: context.commandId, fileKind, semanticHash: context.hash, file: context.args.file };
}

async function uploadPhase(context, args, fileKind, checkReferences, save) {
  const { db, ownerId, nowMs } = context;
  const receipt = await commandReceipt(context);
  const replay = finishedResult(receipt);
  if (replay) return replay;
  const selector = uploadSelector(context, fileKind);
  if (args.phase === 'prepare') {
    await checkReferences();
    await db.batch([reserveCommand(context)]);
    const afterReserve = finishedResult(await commandReceipt(context));
    return afterReserve ?? prepareAtlmUpload(db, ownerId, selector, nowMs);
  }
  if (!receipt) throw error('UPLOAD_NOT_PREPARED', 409, { commandId: context.commandId });
  if (args.phase === 'putPart') {
    return putAtlmUploadPart(db, ownerId, {
      ...selector, partIndex: args.partIndex, contentBase64: args.contentBase64,
    }, nowMs);
  }
  const references = await checkReferences();
  const input = await readAtlmUpload(db, ownerId, selector, nowMs);
  if (input.state !== 'VALIDATED') return input;
  return save(context, selector, references, input.text);
}

function* embeddedEvidence(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* embeddedEvidence(item);
  } else if (isPlainRecord(value)) {
    if (Object.hasOwn(value, 'kind') && Object.hasOwn(value, 'id')) yield value;
    for (const item of Object.values(value)) yield* embeddedEvidence(item);
  }
}

const TRACKER_REFS = new Set(['COMMAND', 'STEP', 'PLAN', 'ASSESSMENT', 'INTERVAL']);
function assertAnnotationEvidence(row, frozen) {
  if (!row.annotation) return;
  const known = new Map([
    ['PLAN', new Set([row.planId])],
    ['COMMAND', new Set(row.source.evidenceRefs.map((ref) => ref.id))],
    ['STEP', new Set(frozen.evidence.steps.map((step) => step.stepId))],
    ['INTERVAL', new Set(frozen.evidence.intervals.map((interval) => interval.intervalId))],
    ['ASSESSMENT', new Set([row.source.originalAssessment?.assessmentId].filter(Boolean))],
  ]);
  for (const { kind, id: reference } of embeddedEvidence(row.annotation)) {
    if (TRACKER_REFS.has(kind) && !known.get(kind).has(reference))
      throw error('INVALID_TEACHER_DATASET', 422, { reason: 'TRACKER_EVIDENCE_NOT_FOUND', rowId: row.rowId });
  }
}

function annotationLineage(row, parent, parentId, nowMs) {
  if (!parent || !row.annotation || canonical(row.annotation) !== canonical(parent.annotation)) {
    return { annotationRecordedAt: row.annotation ? nowMs : null, annotationOrigin: row.annotation ? { kind: 'NEW' } : null };
  }
  const unchangedSource = row.source.sourceGeneration === parent.source.sourceGeneration
    && row.source.sourceDigest === parent.source.sourceDigest
    && row.source.sourceGeneration !== null;
  if (!unchangedSource) {
    throw error('LINEAGE_MISMATCH', 409, { reason: 'SOURCE_CHANGED', rowId: row.rowId, parentDatasetRevisionId: parentId });
  }
  return { annotationRecordedAt: parent.annotationRecordedAt ?? null,
    annotationOrigin: { kind: 'CARRIED', datasetRevisionId: parentId, rowId: parent.rowId } };
}

async function saveDataset(context, selector, { snapshot, parent }, text) {
  const { db, ownerId, args, commandId, nowMs } = context;
  const document = parseDocument(text, 'INVALID_TEACHER_DATASET');
  requireFields(document, ['schemaVersion', 'contract', 'snapshotId', 'parentDatasetRevisionId', 'rows'],
    'INVALID_TEACHER_DATASET', 'INVALID_DOCUMENT_FIELDS');
  if (document.schemaVersion !== SCHEMA_VERSION || document.contract !== TEACHER_ANNOTATIONS_CONTRACT
    || document.snapshotId !== args.snapshotId || document.parentDatasetRevisionId !== args.parentDatasetRevisionId)
    throw error('LINEAGE_MISMATCH', 409, { snapshotId: args.snapshotId, parentDatasetRevisionId: args.parentDatasetRevisionId });
  const fields = [
    'ordinal,row_id,plan_id,raw_eligibility,raw_reasons_json,source_json,',
    "json_object('steps',json_extract(evidence_json,'$.steps'),",
    " 'intervals',json_extract(evidence_json,'$.intervals')) AS evidence_json",
  ].join('');
  const frozenRows = [];
  for await (const row of entityRows(db, ownerId, SNAPSHOT_ROWS, args.snapshotId, snapshotRow, fields)) frozenRows.push(row);
  const parents = new Map();
  if (parent) for await (const row of entityRows(db, ownerId, DATASET_ROWS, parent.dataset_revision_id, datasetRow))
    parents.set(row.planId, row);
  const rows = mergeAtlmTeacherAnnotations(frozenRows, document.rows).map((row, index) => {
    assertAnnotationEvidence(row, frozenRows[index]);
    return { ...row, ...annotationLineage(row, parents.get(row.planId), args.parentDatasetRevisionId, nowMs) };
  });
  const record = {
    dataset_revision_id: commandId, snapshot_id: args.snapshotId, parent_dataset_revision_id: args.parentDatasetRevisionId,
    origin: 'NATIVE', feature_version: snapshot.feature_version, row_count: rows.length,
    eligible_count: rows.filter((row) => row.eligibility === 'ELIGIBLE').length, created_at: nowMs, imported_at: null,
  };
  record.dataset_digest = (await hashAtlmTextChunks(rowExport(datasetExportHeader(record), rows))).sha256;
  const value = { state: 'SAVED', ...datasetHeader(record) };
  const pending = pendingArgs(context);
  const exists = 'EXISTS(SELECT 1 FROM estimation_dataset_revisions WHERE owner_id=? AND dataset_revision_id=?)';
  const ready = atlmUploadReadyArgs(ownerId, selector, nowMs);
  const header = db.prepare([
    'INSERT INTO estimation_dataset_revisions(owner_id,dataset_revision_id,snapshot_id,parent_dataset_revision_id,',
    ' origin,schema_version,feature_version,created_at,dataset_digest,row_count,eligible_count,provenance_json)',
    " SELECT ?,?,?,?,'NATIVE',?,?,?,?,?,?,? WHERE EXISTS(" + PENDING_COMMAND_SQL + ') AND ' + ATLM_UPLOAD_READY_SQL,
  ].join('\n')).bind(ownerId, commandId, args.snapshotId, args.parentDatasetRevisionId, SCHEMA_VERSION, snapshot.feature_version,
    nowMs, record.dataset_digest, record.row_count, record.eligible_count, JSON.stringify({ annotationsDigest: args.file.sha256 }),
    ...pending, ...ready);
  const decisions = rows.map((row) => ({
    rowId: row.rowId, groupId: row.groupId, eligibility: row.eligibility, reasons: row.reasons,
    annotation: { value: row.annotation, origin: row.annotationOrigin, recordedAt: row.annotationRecordedAt },
    features: row.features,
  }));
  const rowStatement = db.prepare([
    'INSERT INTO estimation_dataset_revision_rows(owner_id,dataset_revision_id,row_id,snapshot_id,snapshot_row_id,',
    ' ordinal,plan_id,group_id,origin,eligibility,reasons_json,annotation_json,features_json,source_json)',
    " SELECT s.owner_id,?,s.row_id,s.snapshot_id,s.row_id,s.ordinal,s.plan_id,json_extract(x.value,'$.groupId'),",
    " 'NATIVE',json_extract(x.value,'$.eligibility'),json_extract(x.value,'$.reasons'),json_extract(x.value,'$.annotation'),",
    " json_extract(x.value,'$.features'),s.source_json FROM json_each(?) x JOIN estimation_training_snapshot_rows s",
    " ON s.owner_id=? AND s.snapshot_id=? AND s.row_id=json_extract(x.value,'$.rowId')",
    ' WHERE EXISTS(' + PENDING_COMMAND_SQL + ') AND ' + exists,
  ].join('\n')).bind(commandId, JSON.stringify(decisions), ownerId, args.snapshotId, ...pending, ownerId, commandId);
  const result = await commitResult(context, [
    header, rowStatement, finalizeCommand(context, value, 'OK', exists, [ownerId, commandId]),
  ]);
  if (!result) throw error('UPLOAD_EXPIRED', 409, { commandId });
  return result;
}

function invalidArtifact(reason) {
  return error('INVALID_ARTIFACT', 422, { reason });
}

function assertSame(actual, expected, reason) {
  if (canonical(actual) !== canonical(expected)) throw invalidArtifact(reason);
}

async function validateCodeReference(codeRef) {
  requireFields(codeRef, ['digest', 'files'], 'INVALID_ARTIFACT', 'INVALID_CODE_REFERENCE');
  if (!Array.isArray(codeRef.files) || codeRef.files.length !== ATLM_TEACHER_CODE_PATHS.length)
    throw invalidArtifact('INVALID_CODE_REFERENCE');
  for (const [index, entry] of codeRef.files.entries()) {
    requireFields(entry, ['path', 'sha256'], 'INVALID_ARTIFACT', 'INVALID_CODE_REFERENCE');
    if (entry.path !== ATLM_TEACHER_CODE_PATHS[index] || !isSnapshotDigest(entry.sha256))
      throw invalidArtifact('INVALID_CODE_REFERENCE');
  }
  assertSame(codeRef.digest, 'sha256:' + await hashCommandInput(codeRef.files), 'INVALID_CODE_REFERENCE');
}

function validRollingInterval(interval, historySize) {
  return isPlainRecord(interval)
    && ['AVAILABLE', 'UNAVAILABLE'].includes(interval.status)
    && ['BAYESIAN_PREDICTIVE', 'BAYES_QUANTILE'].includes(interval.engine)
    && ['EXPERIMENTAL', 'HISTORICALLY_EVALUATED'].includes(interval.validationStatus)
    && Number.isFinite(interval.nominalCoverage) && interval.nominalCoverage > 0 && interval.nominalCoverage < 1
    && isNonnegativeSafeInteger(interval.calibrationSampleCount) && interval.calibrationSampleCount <= historySize
    && (historySize >= MIN_ROLLING_REGRESSION_ROWS || interval.status === 'UNAVAILABLE');
}

async function validateRollingMode(reported, protocol, fitRows, rowsById) {
  if (!Array.isArray(reported?.cases) || reported.cases.length !== fitRows.length)
    throw invalidArtifact('INVALID_ROLLING_CASES');
  const historyFor = atlmTeacherRollingHistory(protocol, fitRows);
  const histories = new Map();
  const cases = [];
  for (const [index, target] of fitRows.entries()) {
    const history = historyFor(target);
    const key = history.map((row) => row.sampleId).join('\0');
    if (!histories.has(key)) histories.set(key, await atlmTeacherFitReference(history));
    const reference = histories.get(key);
    const row = reported.cases[index];
    const { medianPointMs } = reference;
    if (!isPlainRecord(row) || !['AVAILABLE', 'UNAVAILABLE'].includes(row.pointStatus)
      || !validRollingInterval(row.interval, history.length)
      || (row.pointStatus === 'AVAILABLE' && !isNonnegativeSafeInteger(row.pointMs))
      || (row.pointStatus === 'AVAILABLE' && !['OLS', 'RIDGE', 'BAYESIAN', 'MEDIAN'].includes(row.pointEngine))
      || (row.pointStatus === 'UNAVAILABLE' && typeof row.pointUnavailableReason !== 'string')
      || (row.fallbackReason !== null && typeof row.fallbackReason !== 'string')
      || (history.length === 0 && row.pointStatus !== 'UNAVAILABLE')
      || (history.length === 1 && (row.pointStatus !== 'AVAILABLE' || row.pointEngine !== 'MEDIAN'))
      || (row.pointEngine === 'MEDIAN' && row.pointMs !== medianPointMs))
      throw invalidArtifact('INVALID_ROLLING_CASES');
    cases.push(atlmTeacherCase(rowsById.get(target.sampleId), {
      featureBasis: 'ACTUAL',
      prediction: { status: row.pointStatus, pointMs: row.pointMs, pointEngine: row.pointEngine,
        reason: row.pointUnavailableReason, interval: row.interval },
      trainRowCount: reference.trainRowCount, trainDigest: reference.trainDigest,
      medianPointMs, fallbackReason: row.fallbackReason,
    }));
  }
  assertSame(reported, summarizeAtlmTeacherMode(cases), 'INVALID_ROLLING_REPORT');
}

const MIN_PLANNED_HOLDOUT_PAIRS = 5;
const MIN_PLANNED_HOLDOUT_GROUPS = 2;
function activationPolicy(evaluation) {
  const mode = evaluation?.modes?.INTERNAL_HOLDOUT_PLANNED;
  const paired = mode?.paired;
  const reasons = [];
  if (mode?.status !== 'AVAILABLE') reasons.push('PLANNED_HOLDOUT_UNAVAILABLE');
  if ((paired?.rowIds?.length ?? 0) < MIN_PLANNED_HOLDOUT_PAIRS
    || (paired?.groupCount ?? 0) < MIN_PLANNED_HOLDOUT_GROUPS) reasons.push('INSUFFICIENT_PLANNED_PAIRS');
  const candidateMae = paired?.candidate?.maeMs;
  const medianMae = paired?.median?.maeMs;
  if (mode?.status === 'AVAILABLE' && (!Number.isFinite(candidateMae) || !Number.isFinite(medianMae)))
    reasons.push('PLANNED_HOLDOUT_COMPARISON_UNAVAILABLE');
  else if (Number.isFinite(candidateMae) && Number.isFinite(medianMae) && candidateMae > medianMae)
    reasons.push('CANDIDATE_MAE_ABOVE_MEDIAN');
  return { status: reasons.length ? 'REQUIRES_EXPERIMENTAL_ACK' : 'ELIGIBLE', reasons };
}

function compactEvaluation(evaluation) {
  return ATLM_TEACHER_MODES.map((kind) => {
    const { status, reason, summary } = evaluation.modes[kind];
    const metrics = summary.metrics === null ? null : Object.fromEntries(Object.entries(summary.metrics)
      .filter(([, value]) => typeof value === 'number' || value === null));
    return { kind, status, reason, ...summary, metrics };
  });
}

async function validateBundle(db, ownerId, datasetRecord, text) {
  const value = parseDocument(text, 'INVALID_ARTIFACT');
  requireFields(value, ['schemaVersion', 'contract', 'datasetRevisionId', 'datasetDigest',
    'artifact', 'evaluation', 'provenance'], 'INVALID_ARTIFACT', 'INVALID_BUNDLE_FIELDS');
  const { artifact, evaluation, provenance } = value;
  const datasetRevisionId = datasetRecord.dataset_revision_id;
  const datasetDigest = datasetRecord.dataset_digest;
  if (value.schemaVersion !== SCHEMA_VERSION || value.contract !== 'atlm-model-revision'
    || value.datasetRevisionId !== datasetRevisionId || value.datasetDigest !== datasetDigest
    || !atlmArtifactValid(artifact)) throw invalidArtifact('INVALID_BUNDLE_ARTIFACT');

  requireFields(provenance, ['trainerVersion', 'codeRef', 'recipeDigest', 'configuration', 'selectedRowIds',
    'fitRowIds', 'holdoutRowIds', 'purgedRowIds', 'trainCutoff', 'holdoutCutoff', 'groups', 'holdoutUse', 'holdoutUseNote'],
  'INVALID_ARTIFACT', 'INVALID_PROVENANCE');
  if (provenance.trainerVersion !== ATLM_TEACHER_TRAINER_VERSION || !isSnapshotDigest(provenance.recipeDigest))
    throw invalidArtifact('INVALID_PROVENANCE');
  await validateCodeReference(provenance.codeRef);

  const rows = [];
  for await (const row of entityRows(db, ownerId, DATASET_ROWS, datasetRevisionId, datasetRow)) rows.push(row);
  const { dataset, trainingRows } = readAtlmTeacherDataset({ ...datasetExportHeader(datasetRecord), rows });
  let protocol;
  try {
    const recipe = parseAtlmTeacherRecipe(provenance.configuration, datasetRevisionId, datasetDigest);
    protocol = buildAtlmTeacherSplit(dataset, trainingRows, recipe);
  } catch {
    throw invalidArtifact('INVALID_RECIPE_OR_SELECTED_GROUPS');
  }
  for (const set of ['selectedRowIds', 'fitRowIds', 'holdoutRowIds', 'purgedRowIds', 'trainCutoff'])
    assertSame(provenance[set], protocol[set], 'INVALID_SELECTED_ROSTER');
  for (const field of ['holdoutCutoff', 'groups', 'holdoutUse', 'holdoutUseNote'])
    assertSame(provenance[field], protocol.split[field], 'INVALID_SPLIT_PROVENANCE');

  const fitIds = new Set(protocol.fitRowIds);
  const fitRows = trainingRows.filter((row) => fitIds.has(row.sampleId));
  const fitReference = await atlmTeacherFitReference(fitRows);
  if (artifact.n !== fitReference.trainRowCount || artifact.datasetDigest !== fitReference.trainDigest
    || artifact.trainCutoff !== fitReference.trainCutoff) throw invalidArtifact('INVALID_FIT_ROSTER');
  assertSame(artifact.manifest, fitReference.manifest, 'INVALID_FIT_MANIFEST');

  requireFields(evaluation, ['schemaVersion', 'protocolVersion', 'metric', 'unit', 'split', 'modes', 'rowDecisions'],
    'INVALID_ARTIFACT', 'INVALID_EVALUATION_FIELDS');
  if (evaluation.schemaVersion !== SCHEMA_VERSION || evaluation.protocolVersion !== SCHEMA_VERSION
    || evaluation.metric !== 'PLAN_ACTIVE' || evaluation.unit !== 'ms') throw invalidArtifact('INVALID_EVALUATION_PROTOCOL');
  requireFields(evaluation.modes, ATLM_TEACHER_MODES, 'INVALID_ARTIFACT', 'INVALID_EVALUATION_MODES');
  assertSame(evaluation.rowDecisions, protocol.rowDecisions, 'INVALID_ROW_DECISIONS');
  assertSame(evaluation.split, protocol.split, 'INVALID_EVALUATION_SPLIT');
  const rowsById = new Map(rows.map((row) => [row.rowId, row]));
  const rolling = evaluation.modes.ROLLING_GROUPED_ACTUAL;
  await validateRollingMode(rolling, protocol, fitRows, rowsById);
  const regressionCaseIds = new Set(rolling.cases.filter((row) => row.trainRowCount >= MIN_ROLLING_REGRESSION_ROWS).map((row) => row.planId));
  if (artifact.selection.caseIds.some((planId) => !regressionCaseIds.has(planId))) {
    throw invalidArtifact('INVALID_POINT_CASE_IDS');
  }
  if (artifact.intervalSelection.caseIds.some((planId) => !regressionCaseIds.has(planId))) {
    throw invalidArtifact('INVALID_INTERVAL_CASE_IDS');
  }
  for (const basis of ['ACTUAL', 'PLANNED']) {
    const cases = protocol.holdoutRowIds.map((rowId) =>
      atlmTeacherHoldoutCase(rowsById.get(rowId), basis, artifact, fitReference, protocol.split.holdoutReason));
    assertSame(evaluation.modes['INTERNAL_HOLDOUT_' + basis],
      summarizeAtlmTeacherMode(cases, { reason: protocol.split.holdoutReason }), 'INVALID_HOLDOUT_REPORT');
  }
  const selected = protocol.selectedRowIds.map((rowId) => rowsById.get(rowId));
  assertSame(evaluation.modes.ISSUED_FORECASTS,
    summarizeAtlmTeacherMode(selected.map(atlmTeacherIssuedCase), { includeMedian: false }), 'INVALID_ISSUED_REPORT');
  return { artifact, evaluation, provenance, protocol, selected };
}

const SOURCE_GUARD = [
  'NOT EXISTS(SELECT 1 FROM json_each(?) x',
  ' LEFT JOIN estimation_jobs j ON j.owner_id=? AND j.job_key=\'refresh:\'||json_extract(x.value,\'$.planId\')',
  ' WHERE json_extract(x.value,\'$.sourceGeneration\') IS NOT coalesce(j.generation,0))',
].join('\n');

async function registerModel(context, selector, dataset, text) {
  const { db, ownerId, args, commandId, nowMs } = context;
  const { artifact, evaluation, provenance, protocol, selected } = await validateBundle(db, ownerId, dataset, text);
  const sources = JSON.stringify(selected.map((row) => ({
    rowId: row.rowId, planId: row.planId, sourceGeneration: row.source.sourceGeneration,
  })));
  const artifactJson = JSON.stringify(artifact);
  const artifactDigest = (await hashAtlmTextChunks([artifactJson])).sha256;
  const pending = pendingArgs(context);
  const ready = atlmUploadReadyArgs(ownerId, selector, nowMs);
  const exists = 'EXISTS(SELECT 1 FROM estimation_model_revisions WHERE owner_id=? AND model_revision_id=?)';
  const header = db.prepare([
    'INSERT INTO estimation_model_revisions(owner_id,model_revision_id,dataset_revision_id,model_version,origin,',
    ' method_version,feature_version,registered_at,artifact_json,artifact_digest,manifest_json,dataset_digest,',
    ' evaluation_json,provenance_json,fit_count,source_count,train_cutoff,supported)',
    ' SELECT ?,?,?,(SELECT coalesce(max(model_version),0)+1 FROM estimation_model_revisions WHERE owner_id=?),',
    " 'NATIVE',?,?,?,?,?,?,?,?,?,?,?,?,1 WHERE EXISTS(" + PENDING_COMMAND_SQL + ')',
    ' AND ' + ATLM_UPLOAD_READY_SQL + ' AND ' + SOURCE_GUARD,
  ].join('\n')).bind(ownerId, commandId, args.datasetRevisionId, ownerId, ATLM_METHOD.version, ATLM_FEATURE_VERSION,
    nowMs, artifactJson, artifactDigest, JSON.stringify(artifact.manifest), dataset.dataset_digest, JSON.stringify(evaluation),
    JSON.stringify({ ...provenance, verificationLevel: 'STRUCTURE_AND_PROVENANCE', rollingEvidenceOrigin: 'LOCAL_TRAINER' }),
    artifact.n, selected.length, protocol.trainCutoff, ...pending, ...ready, sources, ownerId);
  const sourceRows = db.prepare([
    'INSERT INTO estimation_model_revision_sources(owner_id,model_revision_id,plan_id,source_generation,ordinal,dataset_revision_id,row_id)',
    " SELECT ?,?,json_extract(x.value,'$.planId'),json_extract(x.value,'$.sourceGeneration'),x.key,?,json_extract(x.value,'$.rowId')",
    ' FROM json_each(?) x WHERE EXISTS(' + PENDING_COMMAND_SQL + ') AND ' + exists,
  ].join('\n')).bind(ownerId, commandId, args.datasetRevisionId, sources, ...pending, ownerId, commandId);
  const value = {
    state: 'REGISTERED', modelRevisionId: commandId, datasetRevisionId: args.datasetRevisionId, artifactDigest,
    evaluationSummary: compactEvaluation(evaluation), sourceStatus: 'REGISTERED', activationEligibility: activationPolicy(evaluation),
  };
  const versionQuery = '(SELECT model_version FROM estimation_model_revisions WHERE owner_id=? AND model_revision_id=?)';
  const success = db.prepare([
    "UPDATE command_receipts SET outcome_code='OK',result_json=json_set(?,'$.modelVersion'," + versionQuery + '),recorded_at=?',
    " WHERE owner_id=? AND command_id=? AND payload_hash=? AND outcome_code='PENDING' AND " + exists,
  ].join('\n')).bind(JSON.stringify(value), ownerId, commandId, nowMs, ...pending, ownerId, commandId);
  const promote = readyAtlmUploadStatement(db, ownerId, selector, nowMs, { publishedModelId: commandId });
  const result = await commitResult(context, [
    header, sourceRows,
    finalizeCommand(context, { modelRevisionId: commandId }, 'MODEL_SOURCES_CHANGED',
      ATLM_UPLOAD_READY_SQL + ' AND NOT (' + SOURCE_GUARD + ')', [...ready, sources, ownerId]),
    promote, success,
  ]);
  if (!result) throw error('UPLOAD_EXPIRED', 409, { commandId });
  return result;
}

const VALID_MODEL_SOURCE = [
  'EXISTS(SELECT 1 FROM estimation_serving_models WHERE owner_id=? AND model_id=?',
  " AND status IN ('ACTIVE','RETIRED','REGISTERED'))",
].join('\n');
const ACTIVATION_MATCH = [
  '(SELECT model_revision_id FROM estimation_active_revisions WHERE owner_id=?) IS ?',
  ' AND coalesce((SELECT activation_version FROM estimation_active_revisions WHERE owner_id=?),0)=?',
].join('\n');

async function readModel(db, ownerId, modelRevisionId) {
  const row = await dbFirst(db, [
    'SELECT m.*,s.status AS source_status,s.source_problem FROM estimation_model_revisions m',
    'JOIN estimation_serving_models s ON s.owner_id=m.owner_id AND s.model_id=m.model_revision_id',
    'WHERE m.owner_id=? AND m.model_revision_id=?',
  ].join('\n'), ownerId, modelRevisionId);
  if (!row) throw error('MODEL_REVISION_NOT_FOUND', 404, { modelRevisionId });
  return row;
}

async function activateModel(db, ownerId, input, nowMs) {
  const context = await commandContext(db, ownerId, 'ActivateModelRevision', input, nowMs);
  const replay = finishedResult(await commandReceipt(context));
  if (replay) return replay;
  const { args, commandId } = context;
  const { modelRevisionId, expectedActiveModelRevisionId, expectedActivationVersion, acceptExperimental, reason } = args;
  if (!reason) throw error('VALIDATION_ERROR', 400, { field: 'reason' });
  const model = await readModel(db, ownerId, modelRevisionId);
  const current = await readAtlmServingState(db, ownerId);
  if (current.activeModelRevisionId !== expectedActiveModelRevisionId
    || current.activationVersion !== expectedActivationVersion) throw error('MODEL_ACTIVATION_CONFLICT', 409, current);
  if (model.source_status === 'INVALIDATED') {
    throw error('MODEL_SOURCES_CHANGED', 409, { modelRevisionId, reason: model.source_problem });
  }
  if (model.source_status === 'ARCHIVED' || !atlmArtifactValid(parseColumn(model.artifact_json, null))) {
    throw invalidArtifact('MODEL_NOT_ACTIVATABLE');
  }
  const alreadyActive = modelRevisionId === expectedActiveModelRevisionId;
  const policy = activationPolicy(model.origin === 'NATIVE' ? parseColumn(model.evaluation_json, null) : null);
  if (!alreadyActive && policy.status === 'REQUIRES_EXPERIMENTAL_ACK' && !acceptExperimental) {
    throw error('EXPERIMENTAL_CONFIRMATION_REQUIRED', 409, { modelRevisionId, ...policy });
  }
  const condition = '(' + ACTIVATION_MATCH + ') AND ' + VALID_MODEL_SOURCE;
  const guardArgs = [ownerId, expectedActiveModelRevisionId, ownerId, expectedActivationVersion, ownerId, modelRevisionId];
  const activationVersion = expectedActivationVersion + (alreadyActive ? 0 : 1);
  const decision = alreadyActive ? 'ALREADY_ACTIVE' : policy.status === 'ELIGIBLE' ? 'ELIGIBLE' : 'EXPERIMENTAL_ACCEPTED';
  const value = {
    activationVersion, previousModelRevisionId: expectedActiveModelRevisionId, activeModelRevisionId: modelRevisionId,
    activatedAt: alreadyActive ? await dbFirst(db, [
      'SELECT activated_at FROM estimation_model_activations WHERE owner_id=? AND activation_version=?',
    ].join('\n'), ownerId, expectedActivationVersion).then((event) => event?.activated_at ?? null) : nowMs,
    decision,
  };
  const statements = [reserveCommand(context)];
  if (alreadyActive) {
    statements.push(finalizeCommand(context, value, 'OK', condition, guardArgs));
  } else {
    statements.push(db.prepare([
      'INSERT INTO estimation_model_activations(owner_id,activation_version,previous_model_revision_id,',
      ' model_revision_id,activated_at,reason,decision,command_id)',
      ' SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(' + PENDING_COMMAND_SQL + ') AND ' + condition,
    ].join('\n')).bind(ownerId, activationVersion, expectedActiveModelRevisionId, modelRevisionId, nowMs, reason, decision,
      commandId, ...pendingArgs(context), ...guardArgs));
    statements.push(db.prepare([
      'INSERT INTO estimation_active_revisions(owner_id,model_revision_id,activation_version)',
      ' SELECT owner_id,model_revision_id,activation_version FROM estimation_model_activations',
      ' WHERE owner_id=? AND command_id=? AND EXISTS(' + PENDING_COMMAND_SQL + ')',
      ' ON CONFLICT(owner_id) DO UPDATE SET model_revision_id=excluded.model_revision_id,activation_version=excluded.activation_version',
    ].join('\n')).bind(ownerId, commandId, ...pendingArgs(context)));
    statements.push(finalizeCommand(context, value, 'OK',
      'EXISTS(SELECT 1 FROM estimation_model_activations WHERE owner_id=? AND command_id=?)', [ownerId, commandId]));
  }
  const result = await commitResult(context, statements);
  if (result) return result;
  const updated = await readAtlmServingState(db, ownerId);
  if (updated.activeModelRevisionId !== expectedActiveModelRevisionId
    || updated.activationVersion !== expectedActivationVersion) throw error('MODEL_ACTIVATION_CONFLICT', 409, updated);
  throw error('MODEL_SOURCES_CHANGED', 409, { modelRevisionId, reason: 'SOURCE_CHANGED' });
}

async function readModelFile(db, ownerId, args, nowMs) {
  const fileKind = args.fileKind ?? 'BUNDLE';
  const model = await dbFirst(db, [
    'SELECT model_revision_id,origin,artifact_json IS NOT NULL AS has_artifact',
    ' FROM estimation_model_revisions WHERE owner_id=? AND model_revision_id=?',
  ].join(''), ownerId, args.modelRevisionId);
  if (!model) throw error('MODEL_REVISION_NOT_FOUND', 404, { modelRevisionId: args.modelRevisionId });
  if (fileKind === 'ARTIFACT' && !model.has_artifact)
    throw error('MODEL_ARTIFACT_NOT_FOUND', 404, { modelRevisionId: args.modelRevisionId });
  const selector = { storageId: args.modelRevisionId, fileKind };
  if (args.view === 'filePart') return readAtlmRevisionFilePart(db, ownerId, { ...selector, partIndex: args.partIndex });
  const readChunk = async (index) => {
    if (index !== 0) return null;
    if (fileKind === 'ARTIFACT') {
      return (await dbFirst(db, 'SELECT artifact_json FROM estimation_model_revisions WHERE owner_id=? AND model_revision_id=?',
        ownerId, args.modelRevisionId)).artifact_json;
    }
    if (model.origin === 'NATIVE')
      throw error('SOURCE_UNAVAILABLE', 503, { reason: 'REGISTERED_BUNDLE_MISSING', modelRevisionId: model.model_revision_id });
    const archive = await readModel(db, ownerId, args.modelRevisionId);
    return JSON.stringify({
      schemaVersion: SCHEMA_VERSION, contract: 'atlm-model-archive-v1',
      modelRevisionId: archive.model_revision_id, datasetRevisionId: archive.dataset_revision_id,
      datasetDigest: archive.dataset_digest, artifactDigest: archive.artifact_digest,
      registeredAt: archive.registered_at, trainedAt: archive.trained_at, importedAt: archive.imported_at,
      artifact: parseColumn(archive.artifact_json, null), manifest: JSON.parse(archive.manifest_json),
      evaluation: parseColumn(archive.evaluation_json, null), provenance: JSON.parse(archive.provenance_json),
      limitations: [archive.archived_reason, archive.invalidated_reason,
        archive.artifact_json === null ? 'ARTIFACT_UNAVAILABLE' : null,
        archive.evaluation_json === null ? 'EVALUATION_UNAVAILABLE' : null].filter(Boolean),
    });
  };
  return { modelRevisionId: args.modelRevisionId, fileKind,
    ...(await materializeAtlmRevisionFile(db, ownerId, { ...selector, readChunk }, nowMs)) };
}

async function executeAtlmRevisionTool(db, identity, name, args, nowMs, clock) {
  validateTool(name, args);
  const { ownerId } = identity;
  const writes = (name === 'CreateTrainingSnapshot' && args.mode === 'create')
    || ['SaveDatasetRevision', 'RegisterModelRevision', 'ActivateModelRevision'].includes(name);
  if (writes) await ensureOwner(db, identity, nowMs);
  if (name === 'CreateTrainingSnapshot') {
    return args.mode === 'create'
      ? createSnapshot(db, ownerId, args, nowMs, clock)
      : readRevisionEntity(db, ownerId, 'SNAPSHOT', args, nowMs);
  }
  if (name === 'GetDatasetRevision') return readRevisionEntity(db, ownerId, 'DATASET', args, nowMs);
  if (name === 'ListModelRevisions') {
    return ['download', 'filePart'].includes(args.view)
      ? readModelFile(db, ownerId, args, nowMs)
      : readAtlmModelRevisions(db, ownerId, args, nowMs);
  }
  if (name === 'ActivateModelRevision') return activateModel(db, ownerId, args, nowMs);
  const context = await commandContext(db, ownerId, name, args, nowMs);
  if (name === 'SaveDatasetRevision') {
    return uploadPhase(context, args, 'ANNOTATIONS', async () => ({
      snapshot: await readSnapshot(db, ownerId, args.snapshotId),
      parent: args.parentDatasetRevisionId == null ? null : await readDataset(db, ownerId, args.parentDatasetRevisionId),
    }), saveDataset);
  }
  return uploadPhase(context, args, 'BUNDLE', async () => {
    const dataset = await readDataset(db, ownerId, args.datasetRevisionId);
    if (dataset.origin === 'IMPORTED') throw invalidArtifact('HISTORICAL_PROVENANCE_INCOMPLETE');
    return dataset;
  }, registerModel);
}

export { ATLM_REVISION_LIMITS, ATLM_REVISION_TOOL_SCHEMAS, executeAtlmRevisionTool };
