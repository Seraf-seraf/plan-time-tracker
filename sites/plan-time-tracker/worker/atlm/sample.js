import {
  AppError,
  UUID,
  appError,
  canonical,
  dbAll,
  dbFirst,
  hashCommandInput,
  messageFor,
  unionIntervals,
} from '../shared/index.js';
import {
  AGENT_TASK_SCHEMA,
  normalizeAgentTask,
} from './model.js';

async function readAtlmSampleSource(db, ownerId, planId, nowMs) {
  if (!UUID.test(planId || '') || !Number.isSafeInteger(nowMs) || nowMs < 0)
    throw appError('VALIDATION_ERROR', 'Invalid ATLM source arguments.');
  const row = await dbFirst(
    db,
    `SELECT p.*,
    i.assessment_sequence AS input_assessment_sequence,i.selection_status,i.requirements_json AS input_requirements_json,
    i.requirements_digest AS input_requirements_digest,i.captured_receipt_rowid,i.forecast_json,
    a.assessment_json,a.assessment_id,a.revision AS assessment_revision,a.recorded_at AS captured_at,
    t.requirements_json AS current_requirements_json,
    j.status AS refresh_status,j.last_error AS refresh_error,
    (SELECT markdown FROM plan_documents d WHERE d.owner_id=p.owner_id AND d.plan_id=p.plan_id) AS markdown,
    latest.sequence AS sample_sequence,latest.source_generation AS sample_generation,latest.source_digest AS sample_digest,
    COALESCE(j.generation,0) AS source_generation,COALESCE(j.source_changed_at,p.registered_at) AS source_changed_at,
    EXISTS(SELECT 1 FROM plan_steps cfg WHERE cfg.owner_id=p.owner_id AND cfg.plan_id=p.plan_id) AS tracker_enabled,
    (SELECT COUNT(*) FROM tracker_incomplete_steps s WHERE s.owner_id=p.owner_id AND s.plan_id=p.plan_id) AS incomplete_step_count,
    (SELECT json_group_array(json_object('intervalId',w.interval_id,'startMs',w.start_ms,'endMs',w.end_ms)) FROM work_intervals w WHERE w.owner_id=p.owner_id AND w.plan_id=p.plan_id) AS intervals_json,
    (SELECT json_group_array(json_object('rowid',r.rowid,'commandId',r.command_id,'type',r.command_type,'at',r.server_now_ms)) FROM command_receipts r
      WHERE r.owner_id=p.owner_id AND r.plan_id=p.plan_id AND r.outcome_code='OK'
        AND r.command_type IN ('StartPlan','ResumePlan','PausePlan','FinishPlan','DeletePlan')) AS timer_commands_json,
    (SELECT json_group_array(json_object('stepId',s.step_id,'ordinal',s.ordinal,'title',s.title,'content',s.content,'status',s.status,'version',s.version,'updatedAt',s.updated_at)) FROM plan_steps s WHERE s.owner_id=p.owner_id AND s.plan_id=p.plan_id) AS steps_json,
    (SELECT json_group_array(json_object('rowid',r.rowid,'commandId',r.command_id,'type',r.command_type,'payload',json(r.payload_json))) FROM command_receipts r
      WHERE r.owner_id=p.owner_id AND r.plan_id=p.plan_id AND r.outcome_code='OK' AND r.rowid>i.captured_receipt_rowid
       AND r.command_type='UpdatePlanMetadata') AS scope_commands_json
    FROM plans p LEFT JOIN plan_estimation_inputs i ON i.owner_id=p.owner_id AND i.plan_id=p.plan_id
    LEFT JOIN assessment_revisions a ON a.owner_id=p.owner_id AND a.plan_id=p.plan_id AND a.sequence=i.assessment_sequence
    LEFT JOIN assessment_targets t ON t.owner_id=p.owner_id AND t.plan_id=p.plan_id AND t.step_id IS NULL
    LEFT JOIN estimation_jobs j ON j.owner_id=p.owner_id AND j.job_key='refresh:'||p.plan_id
    LEFT JOIN estimation_samples latest ON latest.sequence=(SELECT MAX(sequence) FROM estimation_samples
      WHERE owner_id=p.owner_id AND plan_id=p.plan_id)
    WHERE p.owner_id=? AND p.plan_id=?`,
    ownerId,
    planId,
  );
  if (!row) throw appError('PLAN_NOT_FOUND', messageFor('PLAN_NOT_FOUND'), 404);
  const reasons = [];
  const intervals = JSON.parse(row.intervals_json);
  const steps = JSON.parse(row.steps_json);
  const timerEvents = JSON.parse(row.timer_commands_json);
  const scopeChanges = JSON.parse(row.scope_commands_json);
  let features = null;
  if (row.selection_status !== 'CAPTURED') reasons.push('MISSING_FEATURES');
  else {
    try {
      const normalized = normalizeAgentTask(JSON.parse(row.assessment_json).context.agentTask);
      if (normalized.missingFields.length) reasons.push('MISSING_REQUIRED_FEATURES');
      else features = normalized.features;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'VALIDATION_ERROR') throw error;
      reasons.push('INVALID_FEATURES');
    }
  }
  if (row.deleted_at !== null) reasons.push('PLAN_DELETED');
  if (row.status !== 'COMPLETED') reasons.push('PLAN_NOT_COMPLETED');
  if (!row.tracker_enabled || !steps.length || row.incomplete_step_count !== 0)
    reasons.push('RESULT_NOT_VERIFIED');
  let scopeChanged = row.input_requirements_json === null
    ? null : row.input_requirements_json !== row.current_requirements_json;
  if (row.input_requirements_json) {
    const original = JSON.parse(row.input_requirements_json);
    for (const change of scopeChanges)
      for (const key of ['title', 'description', 'acceptanceCriteria'])
        if (
          Object.hasOwn(original.plan, key) &&
          Object.hasOwn(change.payload, key) &&
          (change.payload[key] ?? '') !== original.plan[key]
        )
          scopeChanged = true;
  }
  if (scopeChanged) reasons.push('SCOPE_CHANGED');
  let actualMs = null;
  const safeTime = (value) => Number.isSafeInteger(value) && value >= 0 && value <= nowMs;
  // Receipts prove that no opening/closing interval disappeared from the full lifecycle.
  const expectedIntervals = [];
  let openAt = null,
    timerHistoryValid = true,
    finishedAt = null;
  for (const event of timerEvents.sort((a, b) => a.rowid - b.rowid)) {
    if (!safeTime(event.at) || (finishedAt !== null && event.type !== 'DeletePlan')) {
      timerHistoryValid = false;
      break;
    }
    if (['StartPlan', 'ResumePlan'].includes(event.type)) {
      if (openAt !== null) {
        timerHistoryValid = false;
        break;
      }
      openAt = event.at;
    } else {
      if (openAt !== null) {
        expectedIntervals.push([
          openAt,
          event.type === 'DeletePlan' ? Math.max(openAt, event.at) : event.at,
        ]);
        openAt = null;
      } else if (!['FinishPlan', 'DeletePlan'].includes(event.type)) {
        timerHistoryValid = false;
        break;
      }
      if (event.type === 'FinishPlan') finishedAt = event.at;
    }
  }
  const intervalOrder = (a, b) => a[0] - b[0] || a[1] - b[1];
  timerHistoryValid &&=
    openAt === null &&
    finishedAt === row.finished_at &&
    expectedIntervals.length > 0 &&
    expectedIntervals[0][0] === row.first_started_at &&
    canonical(expectedIntervals.sort(intervalOrder)) ===
      canonical(intervals.map((i) => [i.startMs, i.endMs]).sort(intervalOrder));
  const complete =
    timerHistoryValid &&
    row.status === 'COMPLETED' &&
    safeTime(row.first_started_at) &&
    safeTime(row.finished_at) &&
    row.finished_at >= row.first_started_at &&
    intervals.length > 0 &&
    intervals.every(
      (i) =>
        safeTime(i.startMs) &&
        safeTime(i.endMs) &&
        i.startMs >= row.first_started_at &&
        i.endMs >= i.startMs &&
        i.endMs <= row.finished_at,
    );
  if (complete) {
    actualMs = unionIntervals(intervals.map((i) => [i.startMs, i.endMs])).reduce(
      (total, [start, end]) => total + end - start,
      0,
    );
    if (!Number.isSafeInteger(actualMs))
      throw appError(
        'INVALID_ESTIMATION_SOURCE',
        'ATLM source duration exceeds safe integer.',
        500,
      );
  } else reasons.push('INCOMPLETE_MEASUREMENT');
  const sourceAvailableAt = Math.max(
    row.registered_at,
    row.finished_at ?? 0,
    row.source_changed_at,
    ...steps.map((s) => s.updatedAt ?? 0),
  );
  if (!safeTime(sourceAvailableAt))
    throw appError('INVALID_ESTIMATION_SOURCE', 'ATLM source timestamps are invalid.', 500);
  const issuedPrediction = row.forecast_json === null ? null : JSON.parse(row.forecast_json);
  const source = {
    planId,
    issuedPrediction,
    inputAssessmentSequence: row.input_assessment_sequence ?? null,
    eligibility: reasons.length ? 'EXCLUDED' : 'ELIGIBLE',
    reasons,
    features,
    actualMs,
    capturedAt: row.forecast_json !== null ? row.first_started_at : (row.captured_at ?? null),
    sourceAvailableAt,
    observedAt: nowMs,
    sourceGeneration: row.source_generation,
  };
  // Versions reflect source changes, not repeated observations or the current wall clock.
  source.sourceDigest =
    'sha256:' +
    (await hashCommandInput({
      ...source,
      observedAt: undefined,
      sourceGeneration: undefined,
      requirements: row.current_requirements_json,
      intervals: intervals.map(({ startMs, endMs }) => ({ startMs, endMs }))
        .sort((a, b) => a.startMs - b.startMs || (a.endMs ?? Infinity) - (b.endMs ?? Infinity)),
      steps: steps.map(({ version, updatedAt, ...content }) => content)
        .sort((a, b) => (a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0)),
      checks: [],
    }));
  return {
    ...source,
    status: complete ? 'AVAILABLE' : 'UNAVAILABLE',
    planStatus: row.status,
    deletedAt: row.deleted_at,
    firstStartedAt: row.first_started_at,
    finishedAt: row.finished_at,
    plannedFeatures: features,
    scopeChanged,
    sampleId: row.sample_sequence === null ? null : String(row.sample_sequence),
    sampleGeneration: row.sample_generation,
    sampleDigest: row.sample_digest,
    refreshStatus: row.refresh_status,
    refreshError: row.refresh_error,
    originalAssessment: row.assessment_id ? {
      assessmentId: row.assessment_id, revision: row.assessment_revision,
      sequence: row.input_assessment_sequence, value: JSON.parse(row.assessment_json),
    } : null,
    evidenceRefs: [
      ...timerEvents.map((event) => ({ kind: 'COMMAND', id: event.commandId })),
      ...steps.map((step) => ({ kind: 'STEP', id: step.stepId, version: step.version })),
    ],
    evidence: {
      title: row.title, description: row.description, acceptanceCriteria: row.acceptance_criteria,
      markdown: row.markdown,
      originalRequirements: row.input_requirements_json === null ? null : JSON.parse(row.input_requirements_json),
      currentRequirements: row.current_requirements_json === null ? null : JSON.parse(row.current_requirements_json),
      steps, intervals, timerEvents, scopeChanges,
    },
  };
}

async function claimAtlmJob(
  db,
  ownerId,
  jobKey,
  nowMs,
  leaseMs = 60000,
  { allowExpiredLease = true } = {},
) {
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0)
    throw appError('VALIDATION_ERROR', 'Invalid ATLM lease.');
  return dbFirst(
    db,
    `UPDATE estimation_jobs SET status='RUNNING',lease_until=?,updated_at=?,fence=fence+1,executor_epoch=executor_epoch+2,attempts=attempts+1
    WHERE owner_id=? AND job_key=? AND kind='REFRESH_SAMPLE' AND generation>processed_generation AND next_attempt_at<=?
      AND status<>'FAILED' AND attempts<4
      AND (? OR status<>'RUNNING') AND (status<>'RUNNING' OR lease_until<=?) RETURNING *`,
    nowMs + leaseMs,
    nowMs,
    ownerId,
    jobKey,
    nowMs,
    allowExpiredLease ? 1 : 0,
    nowMs,
  );
}

async function persistAtlmSample(db, ownerId, source, nowMs, guard) {
  if (!guard || !Number.isSafeInteger(guard.generation) || !Number.isSafeInteger(guard.fence))
    throw appError('VALIDATION_ERROR', 'ATLM sample requires a leased job guard.');
  const params = [
    ownerId,
    source.planId,
    source.inputAssessmentSequence,
    source.sourceDigest,
    source.sourceGeneration,
    source.eligibility,
    JSON.stringify(source.reasons),
    source.features === null ? null : JSON.stringify(source.features),
    source.issuedPrediction == null ? null : JSON.stringify(source.issuedPrediction),
    source.actualMs,
    source.capturedAt,
    source.sourceAvailableAt,
    nowMs,
    source.eligibility,
    ownerId,
    source.planId,
    ownerId,
    'refresh:' + source.planId,
    guard.generation,
    guard.fence,
    nowMs,
    source.sourceGeneration,
    ownerId,
    source.planId,
    source.sourceDigest,
  ];
  const inserted = await dbFirst(
    db,
    `INSERT INTO estimation_samples(owner_id,plan_id,input_assessment_sequence,source_digest,source_generation,
    eligibility,reasons_json,features_json,issued_prediction_json,actual_ms,captured_at,source_available_at,observed_at,is_first_eligible)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ?='ELIGIBLE' AND NOT EXISTS(SELECT 1 FROM estimation_samples WHERE owner_id=? AND plan_id=? AND is_first_eligible=1) THEN 1 ELSE 0 END
    WHERE EXISTS(SELECT 1 FROM estimation_jobs WHERE owner_id=? AND job_key=? AND generation=? AND fence=? AND lease_until>?
      AND generation=? AND status='RUNNING')
      AND NOT EXISTS(SELECT 1 FROM estimation_samples WHERE sequence=(SELECT MAX(sequence) FROM estimation_samples WHERE owner_id=? AND plan_id=?) AND source_digest=?)
    RETURNING *`,
    ...params,
  );
  return inserted
    ? { inserted: true, sample: atlmSampleView(inserted) }
    : { inserted: false, sample: null };
}

function atlmSampleView(row) {
  return {
    sampleId: String(row.sequence),
    planId: row.plan_id,
    inputAssessmentSequence: row.input_assessment_sequence,
    sourceDigest: row.source_digest,
    sourceGeneration: row.source_generation,
    eligibility: row.eligibility,
    reasons: JSON.parse(row.reasons_json),
    features: row.features_json ? JSON.parse(row.features_json) : null,
    issuedPrediction: row.issued_prediction_json ? JSON.parse(row.issued_prediction_json) : null,
    actualMs: row.actual_ms,
    capturedAt: row.captured_at,
    sourceAvailableAt: row.source_available_at,
    observedAt: row.observed_at,
    firstEligible: Boolean(row.is_first_eligible),
  };
}

async function readAtlmSamples(
  db,
  ownerId,
  { latestOnly = true, afterSequence = 0, limit = 100 } = {},
) {
  if (
    typeof latestOnly !== 'boolean' ||
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 5001
  )
    throw appError('VALIDATION_ERROR', 'Invalid ATLM sample page.');
  const rows = await dbAll(
    db,
    `SELECT s.* FROM estimation_samples s WHERE s.owner_id=? AND s.sequence>? ${latestOnly ? 'AND s.sequence=(SELECT MAX(current.sequence) FROM estimation_samples current WHERE current.owner_id=s.owner_id AND current.plan_id=s.plan_id)' : ''} ORDER BY s.sequence LIMIT ?`,
    ownerId,
    afterSequence,
    limit,
  );
  return rows.map(atlmSampleView);
}

const ATLM_TOOL_SCHEMAS = Object.freeze({
  CalculateAtlmEstimate: {
    type: 'object',
    additionalProperties: false,
    required: ['planId', 'expectedRequirementsDigest', 'agentTask'],
    properties: {
      planId: { type: 'string', format: 'uuid' },
      expectedRequirementsDigest: {
        type: 'string',
        minLength: 71,
        maxLength: 71,
        pattern: '^sha256:[a-f0-9]{64}$',
      },
      agentTask: AGENT_TASK_SCHEMA,
    },
  },
  GetPlanEstimate: {
    type: 'object',
    additionalProperties: false,
    required: ['planId'],
    properties: { planId: { type: 'string', format: 'uuid' } },
  },
});

const ATLM_LATEST_SAMPLE_SQL =
  's.sequence=(SELECT MAX(latest.sequence) FROM estimation_samples latest WHERE latest.owner_id=s.owner_id AND latest.plan_id=s.plan_id)';

export {
  ATLM_LATEST_SAMPLE_SQL,
  ATLM_TOOL_SCHEMAS,
  atlmSampleView,
  claimAtlmJob,
  persistAtlmSample,
  readAtlmSampleSource,
  readAtlmSamples,
};
