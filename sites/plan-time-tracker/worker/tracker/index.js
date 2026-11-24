import { assessmentReadiness, planStartReadiness, readinessFromRow } from '../atlm/readiness.js';
import { ATLM_REVISION_LIMITS, ATLM_REVISION_TEACHER_RECIPE_IDS, ATLM_REVISION_TOOL_SCHEMAS } from '../atlm/revisions.js';
import {
  ATLM_TEACHER_RECIPE_ID_V4, TEACHER_REVIEWED_ANNOTATIONS_CONTRACT, TEACHER_REVIEWED_DATASET_CONTRACT,
} from '../atlm/teacher-dataset.js';
import {
  AppError,
  ENVIRONMENT_IDS,
  STEP_STATUSES,
  TRACKER_COMMANDS,
  TRACKER_VERSION,
  UUID,
  appError,
  assertExactKeys,
  assertSafeMetadataText,
  checkTimeZone,
  dbAll,
  dbFirst,
  hashCommandInput,
  inclusiveDateRange,
  isPlainRecord,
  isSnapshotDigest,
  mapDbError,
  median,
  messageFor,
  parseColumn,
  parsePlanCreatedAt,
  payloadHash,
  planDateAfterStart,
  receiptMatchesCommand,
  resultFromReceipt,
  unionIntervals,
  validateEnvelope,
} from '../shared/index.js';
import {
  AGENT_TASK_SCHEMA,
  ATLM_FEATURE_VERSION,
  ATLM_METHOD,
  ATLM_POLICY_VERSION,
  V4_TASK_MAX_BYTES,
  atlmUnavailableInterval,
  normalizeAgentTask,
  validateAssessmentValue,
} from '../atlm/model.js';
import {
  CURRENT_FORECAST_INPUT_SQL,
  CURRENT_FORECAST_MAX_READ_ATTEMPTS,
  HISTORICAL_MEDIAN_METHOD,
  calculateAtlmEstimate,
  currentForecastInput,
  currentPlanForecast,
} from '../atlm/forecast.js';
import { atlmDiagnostics } from '../atlm/serving.js';

import { isDocumentUpdate, parsePlanDocument } from './plan-document.js';
import { preparePlanAssessmentTargets, updatePlanDocumentBatch } from './plan-document-update.js';

const FORECAST_METRICS = ['PLAN_ACTIVE', 'CALENDAR', 'PAUSED'];

const assessmentPayloadSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'assessmentId',
    'planId',
    'expectedRequirementsDigest',
    'context',
    'method',
    'complexity',
    'unknowns',
    'assumptions',
    'dependencies',
    'forecast',
    'sources',
    'approach',
    'phase',
  ],
  properties: {
    assessmentId: { type: 'string', format: 'uuid' },
    planId: { type: 'string', format: 'uuid' },
    stepId: { type: 'string', format: 'uuid' },
    expectedRequirementsDigest: {
      type: 'string',
      pattern: '^sha256:[a-f0-9]{64}$',
      description:
        'Digest of the requirements read by the agent before assessing; never refresh it just to retry a write',
    },
    context: {
      type: 'object',
      properties: { agentTask: AGENT_TASK_SCHEMA },
      description: 'Bounded JSON: expected result, scope and checks',
    },
    predictionRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'methodVersion'],
      properties: { method: { enum: ['ATLM'] }, methodVersion: { enum: [1] } },
    },
    method: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'scale'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 128 },
        version: { type: 'string', minLength: 1, maxLength: 128 },
        scale: { description: 'Agent-declared scale, bounded JSON' },
      },
    },
    complexity: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'value', 'rationale'],
      properties: {
        status: { enum: ['KNOWN', 'UNKNOWN'] },
        value: { description: 'Bounded JSON; null when UNKNOWN' },
        rationale: { type: 'string', minLength: 1, maxLength: 4000 },
      },
    },
    ...Object.fromEntries(
      ['unknowns', 'assumptions', 'dependencies'].map((key) => [
        key,
        { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 } },
      ]),
    ),
    forecast: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'metric', 'lowerMs', 'upperMs', 'confidence', 'basis', 'sampleCount'],
      properties: {
        status: { enum: ['KNOWN', 'UNKNOWN'] },
        metric: { enum: FORECAST_METRICS },
        lowerMs: { type: ['integer', 'null'], minimum: 0 },
        upperMs: { type: ['integer', 'null'], minimum: 0 },
        confidence: { enum: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] },
        basis: { type: 'string', minLength: 1, maxLength: 4000 },
        sampleCount: { type: 'integer', minimum: 0 },
      },
    },
    sources: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['planId'],
        properties: {
          planId: { type: 'string', format: 'uuid' },
          stepId: { type: 'string', format: 'uuid' },
        },
      },
    },
    approach: {
      type: 'object',
      additionalProperties: false,
      required: ['description', 'rationale'],
      properties: {
        description: { type: 'string', minLength: 1, maxLength: 4000 },
        rationale: { type: 'string', minLength: 1, maxLength: 4000 },
      },
    },
    phase: { type: 'string', minLength: 1, maxLength: 100 },
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
  },
};

function validateAssessmentCommand(envelope) {
  assertExactKeys(
    envelope,
    new Set([
      'schemaVersion',
      'commandId',
      'commandType',
      'expectedVersion',
      'payloadHash',
      'payload',
    ]),
    'RecordAssessment',
  );
  if (
    envelope.schemaVersion !== 1 ||
    !UUID.test(envelope.commandId || '') ||
    !Number.isSafeInteger(envelope.expectedVersion) ||
    envelope.expectedVersion < 0
  )
    throw appError('VALIDATION_ERROR', 'Invalid assessment envelope.');
  if (envelope.payloadHash !== undefined && !/^[a-f0-9]{64}$/i.test(envelope.payloadHash))
    throw appError('VALIDATION_ERROR', 'Invalid payloadHash.');
  validateAssessmentValue(envelope.payload, assessmentPayloadSchema);
  if (new TextEncoder().encode(JSON.stringify(envelope.payload)).length > V4_TASK_MAX_BYTES)
    throw appError('VALIDATION_ERROR', 'Assessment exceeds 64 KiB UTF-8.');
  const p = envelope.payload,
    f = p.forecast,
    c = p.complexity;
  if (Object.hasOwn(p.context, 'agentTask')) normalizeAgentTask(p.context.agentTask);
  if (p.predictionRequest && (p.stepId !== undefined || !Object.hasOwn(p.context, 'agentTask')))
    throw appError('VALIDATION_ERROR', 'predictionRequest requires plan-level agentTask v4.');
  if (!isSnapshotDigest(p.expectedRequirementsDigest))
    throw appError(
      'VALIDATION_ERROR',
      'expectedRequirementsDigest must identify the requirements assessed by the agent.',
    );
  if (p.method.scale === null || p.method.scale === '')
    throw appError('VALIDATION_ERROR', 'Declare the assessment scale.');
  if ((c.status === 'UNKNOWN') !== (c.value === null))
    throw appError(
      'VALIDATION_ERROR',
      'Unknown complexity requires null; known complexity requires a value.',
    );
  if (
    f.status === 'UNKNOWN'
      ? f.lowerMs !== null || f.upperMs !== null
      : !Number.isSafeInteger(f.lowerMs) ||
        !Number.isSafeInteger(f.upperMs) ||
        f.lowerMs < 0 ||
        f.upperMs < f.lowerMs
  )
    throw appError('VALIDATION_ERROR', 'Invalid duration range in milliseconds.');
  if (envelope.expectedVersion > 0 && !p.reason?.trim())
    throw appError('VALIDATION_ERROR', 'Revision reason required.');
}

async function assessmentTarget(db, ownerId, planId, stepId) {
  return dbFirst(
    db,
    'SELECT * FROM assessment_targets WHERE owner_id=? AND plan_id=? AND step_id IS ?',
    ownerId,
    planId,
    stepId ?? null,
  );
}

async function assessmentView(db, ownerId, row) {
  const target = await assessmentTarget(db, ownerId, row.plan_id, row.step_id);
  const digest = target
    ? 'sha256:' + (await hashCommandInput(JSON.parse(target.requirements_json)))
    : null;
  return {
    sequence: row.sequence,
    assessmentId: row.assessment_id,
    revision: row.revision,
    previousRevision: row.previous_revision,
    planId: row.plan_id,
    stepId: row.step_id,
    authorId: row.author_id,
    recordedAt: row.recorded_at,
    assessmentReadiness: await assessmentReadiness(
      JSON.parse(row.assessment_json),
      row.requirements_digest,
      digest,
    ),
    requirementsDigest: row.requirements_digest,
    currentRequirementsDigest: digest,
    needsRevision: digest !== row.requirements_digest,
    requirements: JSON.parse(row.requirements_json),
    assessment: { formatVersion: 1, ...JSON.parse(row.assessment_json) },
  };
}

const getAssessmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['planId'],
  properties: {
    planId: { type: 'string', format: 'uuid' },
    stepId: {
      type: 'string',
      format: 'uuid',
      description: 'Context-only read; omit assessmentId and revision',
    },
    assessmentId: { type: 'string', format: 'uuid' },
    revision: { type: 'integer', minimum: 1 },
  },
};

async function readAssessment(db, ownerId, args, nowMs) {
  validateAssessmentValue(args, getAssessmentSchema);
  if (args.assessmentId === undefined) {
    if (args.revision !== undefined)
      throw appError('VALIDATION_ERROR', 'revision requires assessmentId.');
    const plan = await dbFirst(
      db,
      'SELECT plan_id FROM plans WHERE owner_id=? AND plan_id=?',
      ownerId,
      args.planId,
    );
    if (!plan) throw appError('PLAN_NOT_FOUND', messageFor('PLAN_NOT_FOUND'), 404);
    const target = await assessmentTarget(db, ownerId, args.planId, args.stepId);
    if (!target) throw appError('STEP_NOT_FOUND', messageFor('STEP_NOT_FOUND'), 404);
    const requirements = JSON.parse(target.requirements_json);
    const digest = 'sha256:' + (await hashCommandInput(requirements));
    const latest = await dbFirst(
      db,
      'SELECT assessment_json,requirements_digest FROM assessment_revisions WHERE owner_id=? AND plan_id=? AND step_id IS ? ORDER BY sequence DESC LIMIT 1',
      ownerId,
      args.planId,
      args.stepId ?? null,
    );
    return {
      assessmentReadiness: await assessmentReadiness(
        latest ? JSON.parse(latest.assessment_json) : null,
        latest?.requirements_digest,
        digest,
      ),
      contextOnly: true,
      planId: args.planId,
      stepId: args.stepId ?? null,
      requirements,
      currentRequirementsDigest: digest,
      serverNow: nowMs,
    };
  }
  if (args.stepId !== undefined)
    throw appError('VALIDATION_ERROR', 'stepId is only used for a context-only read.');
  const rows = await dbAll(
    db,
    'SELECT * FROM assessment_revisions WHERE owner_id=? AND plan_id=? AND assessment_id=? ORDER BY revision DESC LIMIT 1',
    ownerId,
    args.planId,
    args.assessmentId,
  );
  if (!rows.length) throw appError('ASSESSMENT_NOT_FOUND', 'Assessment not found.', 404);
  const row =
    args.revision === undefined
      ? rows[0]
      : await dbFirst(
          db,
          'SELECT * FROM assessment_revisions WHERE owner_id=? AND plan_id=? AND assessment_id=? AND revision=?',
          ownerId,
          args.planId,
          args.assessmentId,
          args.revision,
        );
  if (!row) throw appError('ASSESSMENT_NOT_FOUND', 'Assessment revision not found.', 404);
  return {
    ...(await assessmentView(db, ownerId, row)),
    revisionCount: rows[0].revision,
    serverNow: nowMs,
  };
}

const estimationHistorySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['targets', 'from', 'to', 'timeZone'],
  properties: {
    targets: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: assessmentPayloadSchema.properties.sources.items,
    },
    from: { type: 'string', format: 'date' },
    to: { type: 'string', format: 'date' },
    timeZone: { type: 'string' },
    asOf: { type: 'integer', minimum: 0 },
    afterSequence: { type: 'integer', minimum: 0 },
    throughSequence: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
};

function durationStatistics(values) {
  const measured = values.filter((value) => value !== null);
  return {
    sampleCount: measured.length,
    unknownCount: values.length - measured.length,
    minMs: measured.length ? Math.min(...measured) : null,
    medianMs: median(measured),
    maxMs: measured.length ? Math.max(...measured) : null,
    status: measured.length ? 'AVAILABLE' : 'INSUFFICIENT_DATA',
  };
}

async function readEstimationHistory(db, ownerId, args, nowMs) {
  validateAssessmentValue(args, estimationHistorySchema);
  const timeZone = checkTimeZone(args.timeZone),
    range = inclusiveDateRange(args.from, args.to, timeZone),
    asOf = args.asOf ?? nowMs,
    limit = args.limit ?? 50;
  if (asOf > nowMs) throw appError('VALIDATION_ERROR', 'asOf exceeds server time.');
  const keys = args.targets.map((t) => t.planId + ':' + (t.stepId || ''));
  if (new Set(keys).size !== keys.length) throw appError('VALIDATION_ERROR', 'Duplicate targets.');
  const throughSequence =
    args.throughSequence ??
    (
      await dbFirst(
        db,
        'SELECT COALESCE(MAX(sequence),0) AS seq FROM assessment_revisions WHERE owner_id=?',
        ownerId,
      )
    ).seq;
  const facts = [],
    allIntervals = [],
    cache = new Map(),
    elapsed = (windows) =>
      unionIntervals(windows.filter(([a, b]) => b > a)).reduce((n, [a, b]) => n + b - a, 0),
    clip = (a, b) => [Math.max(a, range.startMs), Math.min(b, range.endMs, asOf)];
  for (const target of args.targets) {
    let info = cache.get(target.planId);
    if (!info) {
      const plan = await dbFirst(
        db,
        'SELECT * FROM plans WHERE owner_id=? AND plan_id=? AND deleted_at IS NULL',
        ownerId,
        target.planId,
      );
      if (!plan) throw appError('PLAN_NOT_FOUND', messageFor('PLAN_NOT_FOUND'), 404);
      const intervals = await dbAll(
        db,
        'SELECT interval_id,start_ms,end_ms FROM work_intervals WHERE owner_id=? AND plan_id=? AND start_ms<=? ORDER BY start_ms',
        ownerId,
        target.planId,
        asOf,
      );
      info = {
        plan,
        intervals,
        windows: intervals.map((i) => clip(i.start_ms, i.end_ms ?? asOf)),
        snapshot: await readPlanExecutionSnapshot(db, ownerId, target.planId, nowMs),
      };
      cache.set(target.planId, info);
      allIntervals.push(...info.windows);
    }
    const { plan, intervals, windows, snapshot } = info,
      step = target.stepId ? snapshot.steps.find((s) => s.step_id === target.stepId) : null;
    if (target.stepId && !step) throw appError('STEP_NOT_FOUND', messageFor('STEP_NOT_FOUND'), 404);
    const measured = plan.first_started_at != null && plan.first_started_at <= asOf,
      active = measured && intervals.length > 0,
      planActiveMs = active ? elapsed(windows) : null,
      calendarMs = measured
        ? elapsed([clip(plan.first_started_at, plan.finished_at ?? asOf)])
        : null;
    facts.push({
      ...target,
      source: 'server work_intervals',
      units: 'ms',
      planStatus: plan.status,
      planActiveMs,
      calendarMs,
      pausedMs: active ? Math.max(0, calendarMs - planActiveMs) : null,
      intervals,
      currentReadiness: step ? step.readyToFinish : snapshot.plan.completion.readyToFinish,
      limitations: [
        'readiness is current, not historical asOf',
        'time is measured for the parent plan',
      ],
    });
  }
  const selection = args.targets.map(() => '(plan_id=? AND step_id IS ?)').join(' OR '),
    history = await dbAll(
      db,
      `SELECT * FROM assessment_revisions WHERE owner_id=? AND (${selection}) AND sequence>? AND sequence<=? AND recorded_at<=? ORDER BY sequence LIMIT ?`,
      ownerId,
      ...args.targets.flatMap((t) => [t.planId, t.stepId ?? null]),
      args.afterSequence ?? 0,
      throughSequence,
      asOf,
      limit + 1,
    );
  const selected = facts.filter((f) => !f.stepId),
    statistics = [
      ['PLAN_ACTIVE', 'planActiveMs'],
      ['CALENDAR', 'calendarMs'],
      ['PAUSED', 'pausedMs'],
    ].map(([metric, field]) => ({
      scope: 'plan',
      metric,
      units: 'ms',
      ...durationStatistics(selected.map((f) => f[field])),
    }));
  return {
    asOf,
    throughSequence,
    serverNow: nowMs,
    period: { from: args.from, to: args.to, timeZone, ...range },
    targets: args.targets,
    facts,
    statistics,
    totalActiveMs: [...cache.values()].some(
      (p) =>
        p.plan.first_started_at != null && p.plan.first_started_at <= asOf && p.intervals.length,
    )
      ? elapsed(allIntervals)
      : null,
    totalActiveMeasurement: 'union of selected parent plan intervals',
    assessments: await Promise.all(
      history.slice(0, limit).map((row) => assessmentView(db, ownerId, row)),
    ),
    nextAfterSequence: history.length > limit ? history[limit - 1].sequence : null,
    assessmentStatistics: 'not aggregated across methods, scales or metrics',
    selectionResponsibility: 'agent',
  };
}

function validateTrackerCommand(envelope) {
  if (envelope?.commandType === 'RecordAssessment') return validateAssessmentCommand(envelope);
  if (
    !envelope ||
    envelope.schemaVersion !== 1 ||
    !UUID.test(envelope.commandId || '') ||
    envelope.commandType !== 'SetStepStatus'
  )
    throw appError('VALIDATION_ERROR', 'Неизвестная команда или неверный конверт.');
  assertExactKeys(
    envelope,
    new Set([
      'schemaVersion',
      'commandId',
      'commandType',
      'expectedVersion',
      'payloadHash',
      'payload',
    ]),
    'Конверт команды',
  );
  if (!Number.isSafeInteger(envelope.expectedVersion) || envelope.expectedVersion < 1)
    throw appError('VALIDATION_ERROR', 'expectedVersion должен быть целым числом не меньше 1.');
  if (!isPlainRecord(envelope.payload))
    throw appError('VALIDATION_ERROR', 'payload должен быть объектом.');
  assertExactKeys(envelope.payload, new Set(['stepId', 'status']), 'payload');
  if (
    !UUID.test(envelope.payload.stepId || '') ||
    !STEP_STATUSES.includes(envelope.payload.status)
  )
    throw appError('VALIDATION_ERROR', 'Укажите этап и его статус.');
}

async function executeTrackerCommand(db, identity, envelope, channel, nowMs) {
  // A retry of an old assessment must replay even after retiring its schema.
  if (
    envelope?.commandType === 'RecordAssessment' &&
    envelope.schemaVersion === 1 &&
    UUID.test(envelope.commandId || '') &&
    Number.isSafeInteger(envelope.expectedVersion) &&
    envelope.expectedVersion >= 0 &&
    isPlainRecord(envelope.payload)
  ) {
    const recorded = await dbFirst(
      db,
      "SELECT * FROM command_receipts WHERE owner_id=? AND command_id=? AND command_type='RecordAssessment'",
      identity.ownerId,
      envelope.commandId,
    );
    if (recorded) {
      assertExactKeys(
        envelope,
        new Set([
          'schemaVersion',
          'commandId',
          'commandType',
          'expectedVersion',
          'payload',
          'payloadHash',
        ]),
        'RecordAssessment',
      );
      const hash = await payloadHash(envelope);
      if (
        envelope.payloadHash !== undefined &&
        envelope.payloadHash !== hash &&
        envelope.payloadHash !== recorded.payload_hash
      )
        throw appError('VALIDATION_ERROR', 'payloadHash не совпадает с конвертом.');
      if (!(await receiptMatchesCommand(recorded, envelope, hash)))
        throw appError('IDEMPOTENCY_KEY_REUSED', messageFor('IDEMPOTENCY_KEY_REUSED'), 409);
      return resultFromReceipt(recorded, true);
    }
  }
  validateTrackerCommand(envelope);
  const hash = await payloadHash(envelope);
  let receipt = await dbFirst(
    db,
    'SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?',
    identity.ownerId,
    envelope.commandId,
  );
  const matchesReceipt = receipt && (await receiptMatchesCommand(receipt, envelope, hash));
  if (
    envelope.payloadHash &&
    envelope.payloadHash !== hash &&
    !(matchesReceipt && envelope.payloadHash === receipt.payload_hash)
  )
    throw appError('VALIDATION_ERROR', 'payloadHash не совпадает с конвертом.');
  if (receipt) {
    if (!matchesReceipt)
      throw appError('IDEMPOTENCY_KEY_REUSED', messageFor('IDEMPOTENCY_KEY_REUSED'), 409);
    return resultFromReceipt(receipt, true);
  }

  const input = envelope.payload;
  let planId = input.planId || null;
  if (!planId && input.stepId) {
    const step = await dbFirst(
      db,
      'SELECT plan_id FROM plan_steps WHERE owner_id=? AND step_id=?',
      identity.ownerId,
      input.stepId,
    );
    planId = step ? step.plan_id : null;
  }
  let payload = { ...input };
  let predictionPreparationError = null;
  let predictionInputKey = null;
  if (envelope.commandType === 'RecordAssessment') {
    const target = await assessmentTarget(db, identity.ownerId, input.planId, input.stepId);
    const requirementsJson = target?.requirements_json || '{}';
    let storedInput = Object.hasOwn(input.context, 'agentTask')
      ? {
          ...input,
          context: {
            ...input.context,
            agentTask: normalizeAgentTask(input.context.agentTask).agentTask,
          },
        }
      : input;
    if (input.predictionRequest) {
      try {
        predictionInputKey = (await currentForecastInput(db, identity.ownerId, input.planId))?.snapshot_key ?? null;
        const serverEstimation = await calculateAtlmEstimate(
          db,
          identity.ownerId,
          {
            planId: input.planId,
            expectedRequirementsDigest: input.expectedRequirementsDigest,
            agentTask: storedInput.context.agentTask,
          },
          nowMs,
        );
        if (serverEstimation.unavailableReason === 'UNSUPPORTED_FORECAST_SCOPE')
          predictionPreparationError = 'ATLM_FORECAST_SCOPE_CHANGED';
        else storedInput = { ...storedInput, serverEstimation };
      } catch (error) {
        // Domain rejection must be receipted, so a later context change cannot turn
        // the same command into a successful write. Genuine source failures still throw.
        if (
          error instanceof AppError &&
          ['ASSESSMENT_CONTEXT_CHANGED', 'PLAN_NOT_FOUND'].includes(error.code)
        )
          predictionPreparationError = error.code;
        else throw error;
      }
    }
    const assessmentJson = JSON.stringify(storedInput);
    if (new TextEncoder().encode(assessmentJson).length > V4_TASK_MAX_BYTES)
      throw appError('VALIDATION_ERROR', 'Assessment with server estimation exceeds 64 KiB UTF-8.');
    Object.assign(payload, {
      assessmentJson,
      requirementsJson,
      requirementsDigest: 'sha256:' + (await hashCommandInput(JSON.parse(requirementsJson))),
    });
  }
  const actorType = channel === 'mcp' ? 'agent' : 'user';
  let receiptInserted = false;
  try {
    const values = [
      identity.ownerId,
      envelope.commandId,
      hash,
      envelope.commandType,
      planId,
      envelope.expectedVersion == null ? null : envelope.expectedVersion,
      nowMs,
      identity.ownerId,
      actorType,
      JSON.stringify(payload),
    ];
    let write;
    if (envelope.commandType === 'RecordAssessment' && input.predictionRequest) {
      write = await db
        .prepare(
          `WITH source AS (${CURRENT_FORECAST_INPUT_SQL})
        INSERT OR IGNORE INTO command_receipts
        (owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,result_json,recorded_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,CASE
          WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=? AND plan_id=?) THEN 'PLAN_NOT_FOUND'
          WHEN EXISTS(SELECT 1 FROM plans WHERE owner_id=? AND plan_id=? AND deleted_at IS NOT NULL) THEN 'PLAN_DELETED'
          WHEN EXISTS(SELECT 1 FROM plans WHERE owner_id=? AND plan_id=? AND first_started_at IS NOT NULL) THEN 'ATLM_FORECAST_SCOPE_CHANGED'
          WHEN ? IS NOT NULL THEN ?
          WHEN NOT EXISTS(SELECT 1 FROM source WHERE snapshot_key=?) THEN 'ATLM_MODEL_CHANGED'
          ELSE 'PENDING' END,?,?`,
        )
        .bind(
          identity.ownerId,
          input.planId,
          ...values,
          identity.ownerId,
          planId,
          identity.ownerId,
          planId,
          identity.ownerId,
          planId,
          predictionPreparationError,
          predictionPreparationError,
          predictionInputKey,
          JSON.stringify({ serverNow: nowMs }),
          nowMs,
        )
        .run();
    } else {
      write = await db
        .prepare(
          "INSERT OR IGNORE INTO command_receipts (owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING',?)",
        )
        .bind(...values, nowMs)
        .run();
    }
    receiptInserted = Number(write.meta?.changes) > 0;
  } catch (error) {
    throw mapDbError(error);
  }
  receipt = await dbFirst(
    db,
    'SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?',
    identity.ownerId,
    envelope.commandId,
  );
  if (!receipt)
    throw appError('INTERNAL_ERROR', 'Не удалось сохранить результат tracker-команды.', 500);
  if (!(await receiptMatchesCommand(receipt, envelope, hash)))
    throw appError('IDEMPOTENCY_KEY_REUSED', messageFor('IDEMPOTENCY_KEY_REUSED'), 409);
  return resultFromReceipt(receipt, !receiptInserted);
}

async function createPlanBatch(db, insertReceipt, receiptValues, payload, nowMs) {
  const [ownerId, commandId] = receiptValues;
  const {
    title,
    description,
    acceptanceCriteria,
    planCreatedAt,
    sourceReference,
    planText,
    documentSteps,
    planId,
  } = payload;
  const nonce = crypto.randomUUID();
  const receipt = JSON.stringify({
    title,
    description,
    acceptanceCriteria,
    planCreatedAt,
    sourceReference,
    nonce,
  });
  const insertion = db
    .prepare(insertReceipt + " VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING',NULL,?)")
    .bind(...receiptValues, receipt, nowMs);
  const guard = `EXISTS (SELECT 1 FROM command_receipts WHERE owner_id=? AND command_id=?
    AND json_extract(payload_json,'$.nonce')=? AND outcome_code='OK')`;
  const guardArgs = [ownerId, commandId, nonce];
  const statements = [insertion];
  if (planText !== undefined) {
    statements.push(
      db
        .prepare(
          `INSERT INTO plan_documents(owner_id,plan_id,markdown)
      SELECT ?,?,? WHERE ${guard}`,
        )
        .bind(ownerId, planId, planText, ...guardArgs),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO plan_steps(owner_id,plan_id,step_id,ordinal,title,content,created_at,updated_at)
      SELECT ?,?,json_extract(value,'$.stepId'),json_extract(value,'$.ordinal'),json_extract(value,'$.title'),
        json_extract(value,'$.content'),?,? FROM json_each(?) WHERE ${guard}`,
        )
        .bind(ownerId, planId, nowMs, nowMs, JSON.stringify(documentSteps), ...guardArgs),
    );
  }
  const plan =
    planText === undefined ? { title, description, acceptanceCriteria } : { title, planText };
  statements.push(...preparePlanAssessmentTargets(db, ownerId, planId, plan, guard, guardArgs));
  statements.push(
    db
      .prepare(
        `UPDATE command_receipts SET payload_json=? WHERE owner_id=? AND command_id=?
    AND json_extract(payload_json,'$.nonce')=?`,
      )
      .bind(JSON.stringify({ sourceReference }), ...guardArgs),
  );
  return (await db.batch(statements))[0];
}

async function executeCommand(db, identity, envelope, channel, nowMs) {
  if (envelope && TRACKER_COMMANDS.has(envelope.commandType))
    return executeTrackerCommand(db, identity, envelope, channel, nowMs);
  validateEnvelope(envelope);
  const hash = await payloadHash(envelope);
  let receipt = await dbFirst(
    db,
    'SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?',
    identity.ownerId,
    envelope.commandId,
  );
  const matchesReceipt = receipt && (await receiptMatchesCommand(receipt, envelope, hash));
  if (
    envelope.payloadHash &&
    envelope.payloadHash !== hash &&
    !(matchesReceipt && envelope.payloadHash === receipt.payload_hash)
  )
    throw appError('VALIDATION_ERROR', 'payloadHash не совпадает с конвертом.');
  if (receipt) {
    if (!matchesReceipt)
      throw appError('IDEMPOTENCY_KEY_REUSED', messageFor('IDEMPOTENCY_KEY_REUSED'), 409);
    return resultFromReceipt(receipt, true);
  }

  const payload = { ...envelope.payload };
  if (Object.hasOwn(payload, 'atlmStartForecast'))
    throw appError('VALIDATION_ERROR', 'atlmStartForecast — служебный параметр сервера.');
  if (['DeletePlan', 'RestorePlan'].includes(envelope.commandType)) {
    assertExactKeys(
      envelope,
      new Set([
        'schemaVersion',
        'commandId',
        'commandType',
        'expectedVersion',
        'payloadHash',
        'payload',
      ]),
      'Конверт команды',
    );
    assertExactKeys(payload, new Set(['planId', 'reason']), 'payload');
    if (
      payload.reason !== undefined &&
      (typeof payload.reason !== 'string' || payload.reason.length > 1000)
    )
      throw appError('VALIDATION_ERROR', 'reason ограничен 1000 символами.');
    if (payload.reason !== undefined) payload.reason = payload.reason.trim();
    assertSafeMetadataText(payload.reason, 'reason');
  }
  let planId = payload.planId || null;
  const documentUpdate = envelope.commandType === 'UpdatePlanMetadata' && isDocumentUpdate(payload);
  if (envelope.commandType === 'CreatePlan') {
    for (const field of ['documentSteps', 'requirementsTargets'])
      if (Object.hasOwn(payload, field))
        throw appError('VALIDATION_ERROR', 'Служебные поля плана не принимаются.');
    if (
      typeof payload.title !== 'string' ||
      !payload.title.trim() ||
      payload.title.trim().length > 200
    )
      throw appError('VALIDATION_ERROR', 'Название плана обязательно (до 200 символов).');
    payload.title = payload.title.trim();
    payload.description =
      typeof payload.description === 'string' ? payload.description.slice(0, 20000) : '';
    payload.acceptanceCriteria =
      typeof payload.acceptanceCriteria === 'string'
        ? payload.acceptanceCriteria.slice(0, 20000)
        : '';
    payload.planCreatedAt = parsePlanCreatedAt(payload.planCreatedAt);
    const sourceReference =
      envelope.sourceReference === undefined ? payload.sourceReference : envelope.sourceReference;
    if (
      sourceReference !== undefined &&
      (typeof sourceReference !== 'string' || sourceReference.length > 2048)
    ) {
      throw appError(
        'VALIDATION_ERROR',
        'sourceReference должен быть строкой не длиннее 2048 символов.',
      );
    }
    if (sourceReference !== undefined) payload.sourceReference = sourceReference;
    planId = payload.planId || crypto.randomUUID();
    if (!UUID.test(planId)) throw appError('VALIDATION_ERROR', 'planId должен быть UUID.');
    payload.planId = planId;
    payload.documentSteps =
      payload.planText === undefined ? [] : parsePlanDocument(payload.planText);
  } else {
    if (typeof payload.reason === 'string') payload.reason = payload.reason.slice(0, 1000);
    if (envelope.commandType === 'UpdatePlanMetadata' && !documentUpdate) {
      const fields = ['title', 'description', 'acceptanceCriteria', 'planCreatedAt'];
      if (
        !fields.some(
          (field) =>
            Object.prototype.hasOwnProperty.call(payload, field) && payload[field] !== undefined,
        )
      ) {
        throw appError('VALIDATION_ERROR', 'Укажите хотя бы одно изменяемое поле плана.');
      }
      if (
        payload.title !== undefined &&
        (typeof payload.title !== 'string' ||
          !payload.title.trim() ||
          payload.title.trim().length > 200)
      )
        throw appError('VALIDATION_ERROR', 'Название плана обязательно (до 200 символов).');
      if (payload.planCreatedAt !== undefined)
        payload.planCreatedAt = parsePlanCreatedAt(payload.planCreatedAt);
      if (payload.planCreatedAt !== undefined) {
        const current = await dbFirst(
          db,
          'SELECT first_started_at FROM plans WHERE owner_id=? AND plan_id=?',
          identity.ownerId,
          payload.planId,
        );
        payload.dateAfterStart = planDateAfterStart(
          payload.planCreatedAt,
          current && current.first_started_at,
        );
      }
      for (const key of ['description', 'acceptanceCriteria'])
        if (payload[key] !== undefined && payload[key] !== null && typeof payload[key] !== 'string')
          throw appError('VALIDATION_ERROR', 'Метаданные должны быть строками.');
    }
    if (envelope.commandType === 'FinishPlan') {
      if (payload.allowIncomplete !== undefined && typeof payload.allowIncomplete !== 'boolean')
        throw appError('VALIDATION_ERROR', 'allowIncomplete должен быть boolean.');
      if (
        payload.reason !== undefined &&
        (typeof payload.reason !== 'string' || payload.reason.trim().length > 1000)
      )
        throw appError('VALIDATION_ERROR', 'reason ограничен 1000 символами.');
      if (payload.allowIncomplete === true && (!payload.reason || !payload.reason.trim()))
        throw appError(
          'VALIDATION_ERROR',
          'Для завершения с незавершёнными этапами требуется причина.',
        );
      if (payload.reason !== undefined) payload.reason = payload.reason.trim();
      assertSafeMetadataText(payload.reason, 'reason');
    }
  }

  const start =
    envelope.commandType === 'StartPlan'
      ? await currentForecastInput(db, identity.ownerId, planId)
      : null;
  const firstStart =
    start?.status === 'PLANNED' && start.first_started_at === null && start.deleted_at === null;
  const actorType = channel === 'mcp' ? 'agent' : 'user';
  const receiptValues = [
    identity.ownerId,
    envelope.commandId,
    hash,
    envelope.commandType,
    planId,
    envelope.expectedVersion ?? null,
    nowMs,
    identity.ownerId,
    actorType,
  ];
  const insertReceipt = `INSERT OR IGNORE INTO command_receipts
    (owner_id,command_id,payload_hash,command_type,plan_id,expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,result_json,recorded_at)`;
  let receiptInserted = false;
  for (let attempt = 1; attempt <= CURRENT_FORECAST_MAX_READ_ATTEMPTS; attempt++) {
    let statement;
    if (firstStart) {
      let current;
      try {
        current = await currentPlanForecast(db, identity.ownerId, planId, nowMs);
      } catch (error) {
        if (error.code === 'SOURCE_UNAVAILABLE') {
          const requirementsDigest =
            'sha256:' + (await hashCommandInput(JSON.parse(start.requirements_json)));
          const readiness = await assessmentReadiness(
            parseColumn(start.assessment_json, null),
            start.requirements_digest,
            requirementsDigest,
          );
          current = {
            input: start,
            result: {
              assessmentReadiness: readiness,
              serverEstimation: {
                formatVersion: 2,
                metric: 'PLAN_ACTIVE',
                forecastScope: 'FULL_FROM_FIRST_START',
                status: 'UNAVAILABLE',
                pointMs: null,
                method: { ...ATLM_METHOD },
                modelId: null,
                modelVersion: null,
                calculatedAt: nowMs,
                requirementsDigest,
                featureDigest: readiness.featureDigest,
                sampleCount: 0,
                accuracy: 'NOT_VALIDATED',
                evaluation: null,
                pointEngine: null,
                interval: atlmUnavailableInterval('BAYESIAN_PREDICTIVE', error.code),
                unavailableReason: error.code,
                diagnostics: atlmDiagnostics(error.code),
              },
            },
          };
        } else if (error.code !== 'ASSESSMENT_CONTEXT_CHANGED') throw error;
      }
      const readiness =
        current?.input.start_key === start.start_key ? current.result.assessmentReadiness : null;
      const outcome = readiness ? (readiness.code ?? 'PENDING') : 'ASSESSMENT_CONTEXT_CHANGED';
      const contents =
        readiness?.status === 'READY'
          ? {
              ...payload,
              atlmStartForecast: {
                snapshotVersion: 5,
                assessmentSequence: start.sequence,
                estimation: current.result.serverEstimation,
              },
            }
          : payload;
      // A change to the assessment, serving revision or source history requires a new command.
      // A refresh for another unfinished plan can safely trigger a fresh calculation here.
      statement = db
        .prepare(
          `WITH source AS (${CURRENT_FORECAST_INPUT_SQL}), decision AS (
        SELECT CASE
          WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=? AND plan_id=? AND deleted_at IS NULL) THEN 'PLAN_NOT_FOUND'
          WHEN (SELECT version FROM plans WHERE owner_id=? AND plan_id=?)<>? THEN 'VERSION_CONFLICT'
          WHEN NOT EXISTS(SELECT 1 FROM source WHERE start_key=?) THEN 'ASSESSMENT_CONTEXT_CHANGED'
          WHEN NOT EXISTS(SELECT 1 FROM source WHERE source.snapshot_key=?) AND ?='PENDING' THEN ?
          ELSE ? END AS code)
        ${insertReceipt} SELECT ?,?,?,?,?,?,?,?,?,?,code,
          CASE WHEN code=? THEN ? WHEN code='ASSESSMENT_CONTEXT_CHANGED' THEN ? ELSE NULL END,?
          FROM decision WHERE code IS NOT NULL`,
        )
        .bind(
          identity.ownerId,
          planId,
          identity.ownerId,
          planId,
          identity.ownerId,
          planId,
          envelope.expectedVersion,
          start.start_key,
          current?.input.snapshot_key ?? null,
          outcome,
          attempt === CURRENT_FORECAST_MAX_READ_ATTEMPTS ? 'ASSESSMENT_CONTEXT_CHANGED' : null,
          outcome,
          ...receiptValues,
          JSON.stringify(contents),
          readiness?.code ?? null,
          readiness?.code ? JSON.stringify({ assessmentReadiness: readiness }) : null,
          JSON.stringify({ invalidPaths: ['assessment'] }),
          nowMs,
        );
    } else if (envelope.commandType !== 'CreatePlan' && !documentUpdate) {
      statement = db
        .prepare(`${insertReceipt} VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING',NULL,?)`)
        .bind(...receiptValues, JSON.stringify(payload), nowMs);
    }
    try {
      let inserted;
      if (envelope.commandType === 'CreatePlan') {
        inserted = await createPlanBatch(db, insertReceipt, receiptValues, payload, nowMs);
      } else if (documentUpdate) {
        inserted = await updatePlanDocumentBatch(db, insertReceipt, receiptValues, envelope, nowMs);
      } else {
        inserted = await statement.run();
      }
      receiptInserted = Number(inserted.meta?.changes) > 0;
    } catch (error) {
      throw mapDbError(error);
    }
    receipt = await dbFirst(
      db,
      'SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?',
      identity.ownerId,
      envelope.commandId,
    );
    if (receipt) break;
  }
  if (!receipt) throw appError('INTERNAL_ERROR', 'Не удалось сохранить результат команды.', 500);
  if (!(await receiptMatchesCommand(receipt, envelope, hash)))
    throw appError('IDEMPOTENCY_KEY_REUSED', messageFor('IDEMPOTENCY_KEY_REUSED'), 409);
  return resultFromReceipt(receipt, !receiptInserted);
}

const PLAN_STATUSES = ['PLANNED', 'RUNNING', 'PAUSED', 'COMPLETED'];

const MAX_PLAN_PAGE_SIZE = 100;

const PLAN_LIST_ORDER = 'isCompleted ASC, registeredAt DESC, planId DESC';

const PLAN_COMPLETION_GROUP = "CASE WHEN p.status='COMPLETED' THEN 1 ELSE 0 END";

async function readPlanCards(db, pageSql, values, nowMs) {
  const rows = await dbAll(
    db,
    `WITH page AS (${pageSql}),
    cards AS (
      SELECT p.plan_id,p.title,p.status,p.version,p.registered_at,p.deleted_at,p.first_started_at,p.finished_at,
        CASE WHEN p.first_started_at IS NOT NULL THEN COALESCE((
          SELECT SUM(MAX(0, COALESCE(w.end_ms, ?) - w.start_ms)) FROM work_intervals w
          WHERE w.owner_id=p.owner_id AND w.plan_id=p.plan_id),0) END AS active_ms,
        (SELECT COUNT(*) FROM tracker_incomplete_steps i WHERE i.owner_id=p.owner_id AND i.plan_id=p.plan_id) AS incomplete,
        t.requirements_json,a.assessment_json,a.requirements_digest,
        json_extract(a.assessment_json,'$.context.agentTask.schemaVersion') AS schema_version
      FROM page p LEFT JOIN assessment_targets t ON p.status='PLANNED' AND p.deleted_at IS NULL
        AND t.owner_id=p.owner_id AND t.plan_id=p.plan_id AND t.step_id IS NULL
      LEFT JOIN assessment_revisions a ON a.sequence=(
        SELECT MAX(r.sequence) FROM assessment_revisions r
        WHERE r.owner_id=t.owner_id AND r.plan_id=t.plan_id AND r.step_id IS NULL)
    )
    SELECT plan_id,title,status,version,registered_at,deleted_at,first_started_at,finished_at,active_ms,incomplete,
      schema_version,requirements_digest,
      CASE WHEN schema_version=? OR schema_version IS NULL THEN assessment_json END AS assessment_json,
      CASE WHEN assessment_json IS NOT NULL AND (schema_version=? OR schema_version IS NULL)
        THEN requirements_json END AS requirements_json
    FROM cards p ORDER BY ${PLAN_COMPLETION_GROUP},p.registered_at DESC,p.plan_id DESC`,
    ...values,
    nowMs,
    ATLM_FEATURE_VERSION,
    ATLM_FEATURE_VERSION,
  );
  return Promise.all(
    rows.map(async (row) => {
      const card = {
        planId: row.plan_id,
        title: row.title,
        status: row.status,
        version: row.version,
        registeredAt: row.registered_at,
        deletedAt: row.deleted_at,
        firstStartedAt: row.first_started_at,
        finishedAt: row.finished_at,
        activeMs: row.active_ms,
        serverNow: nowMs,
        completion: {
          readyToFinish: row.deleted_at === null && row.incomplete === 0,
          incompleteStepCount: row.incomplete,
        },
      };
      if (row.status === 'PLANNED' && row.deleted_at === null) {
        // Only the status controls the Start button. The detail route has the full assessment.
        const readiness =
          row.schema_version && row.schema_version !== ATLM_FEATURE_VERSION
            ? await assessmentReadiness(
                { context: { agentTask: { schemaVersion: row.schema_version } } },
                null,
                null,
              )
            : await readinessFromRow(row.requirements_json ? row : null);
        card.assessmentReadiness = { status: readiness.status };
      }
      return card;
    }),
  );
}

async function listPlans(db, ownerId, nowMs, filter = {}, cardsOnly = false) {
  if (
    !filter ||
    typeof filter !== 'object' ||
    Array.isArray(filter) ||
    Object.keys(filter).some((key) => !['statuses', 'limit', 'cursor', 'deleted'].includes(key))
  ) {
    throw appError('VALIDATION_ERROR', 'Допустимы только statuses, limit, cursor и deleted.');
  }
  if (filter.deleted !== undefined && typeof filter.deleted !== 'boolean')
    throw appError('VALIDATION_ERROR', 'deleted должен быть boolean.');
  const limit = filter.limit === undefined ? 50 : filter.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PLAN_PAGE_SIZE)
    throw appError('VALIDATION_ERROR', 'limit должен быть целым числом от 1 до 100.');
  const statuses = filter.statuses === undefined ? PLAN_STATUSES : filter.statuses;
  if (
    !Array.isArray(statuses) ||
    statuses.length < 1 ||
    statuses.length > PLAN_STATUSES.length ||
    new Set(statuses).size !== statuses.length ||
    statuses.some((status) => !PLAN_STATUSES.includes(status))
  ) {
    throw appError('VALIDATION_ERROR', 'statuses должен содержать уникальные состояния планов.');
  }
  const clauses = [
    'p.owner_id=?',
    filter.deleted === true ? 'p.deleted_at IS NOT NULL' : 'p.deleted_at IS NULL',
    'p.status IN (' + statuses.map(() => '?').join(',') + ')',
  ];
  const values = [ownerId, ...statuses];
  if (filter.cursor !== undefined) {
    let cursor;
    try {
      cursor = JSON.parse(filter.cursor);
    } catch {}
    if (
      typeof filter.cursor !== 'string' ||
      filter.cursor.length > 200 ||
      !Array.isArray(cursor) ||
      cursor.length !== 3 ||
      !Number.isInteger(cursor[0]) ||
      (cursor[0] !== 0 && cursor[0] !== 1) ||
      !Number.isSafeInteger(cursor[1]) ||
      cursor[1] < 0 ||
      !UUID.test(cursor[2] || '')
    ) {
      throw appError('VALIDATION_ERROR', 'Некорректный cursor списка планов.');
    }
    clauses.push(
      '(' +
        PLAN_COMPLETION_GROUP +
        ' > ? OR (' +
        PLAN_COMPLETION_GROUP +
        ' = ? AND (p.registered_at < ? OR (p.registered_at = ? AND p.plan_id < ?))))',
    );
    values.push(cursor[0], cursor[0], cursor[1], cursor[1], cursor[2]);
  }
  const pageSql = `SELECT p.* FROM plans p WHERE ${clauses.join(' AND ')}
    ORDER BY ${PLAN_COMPLETION_GROUP} ASC,p.registered_at DESC,p.plan_id DESC LIMIT ?`;
  if (cardsOnly) {
    const rows = await readPlanCards(db, pageSql, [...values, limit + 1], nowMs);
    const plans = rows.slice(0, limit),
      last = plans.at(-1);
    return {
      plans,
      serverNow: nowMs,
      nextCursor:
        rows.length > limit
          ? JSON.stringify([last.status === 'COMPLETED' ? 1 : 0, last.registeredAt, last.planId])
          : null,
    };
  }
  const rows = await dbAll(
    db,
    `WITH plan_page AS (${pageSql}), interval_lists AS (
      SELECT w.owner_id,w.plan_id,json_group_array(json_object(
        'interval_id',w.interval_id,'start_ms',w.start_ms,'end_ms',w.end_ms,
        'opened_by',w.opened_by,'closed_by',w.closed_by)) AS intervals_json
      FROM work_intervals w JOIN plan_page p ON p.owner_id=w.owner_id AND p.plan_id=w.plan_id
      GROUP BY w.owner_id,w.plan_id
    )
    SELECT p.*,
      COALESCE(i.intervals_json,'[]') AS intervals_json,
      (SELECT COUNT(*) FROM tracker_incomplete_steps x WHERE x.owner_id=p.owner_id AND x.plan_id=p.plan_id) AS incompleteStepCount,
      (SELECT COUNT(*) FROM plan_steps s WHERE s.owner_id=p.owner_id AND s.plan_id=p.plan_id) AS enabled,
      (SELECT t.requirements_json FROM assessment_targets t WHERE t.owner_id=p.owner_id AND t.plan_id=p.plan_id
        AND t.step_id IS NULL AND p.status='PLANNED' AND p.deleted_at IS NULL LIMIT 1) AS requirements_json,
      (SELECT a.assessment_json FROM assessment_revisions a WHERE a.sequence=(SELECT MAX(r.sequence)
        FROM assessment_revisions r WHERE r.owner_id=p.owner_id AND r.plan_id=p.plan_id AND r.step_id IS NULL)
        AND EXISTS(SELECT 1 FROM assessment_targets t WHERE t.owner_id=p.owner_id AND t.plan_id=p.plan_id
          AND t.step_id IS NULL AND p.status='PLANNED' AND p.deleted_at IS NULL) LIMIT 1) AS assessment_json,
      (SELECT a.requirements_digest FROM assessment_revisions a WHERE a.sequence=(SELECT MAX(r.sequence)
        FROM assessment_revisions r WHERE r.owner_id=p.owner_id AND r.plan_id=p.plan_id AND r.step_id IS NULL)
        AND EXISTS(SELECT 1 FROM assessment_targets t WHERE t.owner_id=p.owner_id AND t.plan_id=p.plan_id
          AND t.step_id IS NULL AND p.status='PLANNED' AND p.deleted_at IS NULL) LIMIT 1) AS requirements_digest
    FROM plan_page p LEFT JOIN interval_lists i ON i.owner_id=p.owner_id AND i.plan_id=p.plan_id
    ORDER BY ${PLAN_COMPLETION_GROUP} ASC,p.registered_at DESC,p.plan_id DESC`,
    ...values,
    limit + 1,
  );
  const page = rows.slice(0, limit),
    last = page.at(-1);
  return {
    plans: await Promise.all(
      page.map((row) => {
        const intervals = parseColumn(row.intervals_json, []);
        intervals.sort((a, b) => a.start_ms - b.start_ms);
        const summary = {
          incompleteStepCount: row.incompleteStepCount,
          enabled: row.enabled,
          requirements_json: row.requirements_json,
          assessment_json: row.assessment_json,
          requirements_digest: row.requirements_digest,
        };
        return planSummary(db, ownerId, row, nowMs, intervals, summary);
      }),
    ),
    nextCursor:
      rows.length > limit
        ? JSON.stringify([last.status === 'COMPLETED' ? 1 : 0, last.registered_at, last.plan_id])
        : null,
    serverNow: nowMs,
  };
}

function intervalsByPlan(rows) {
  const grouped = new Map();
  for (const { plan_id, ...interval } of rows) {
    if (!grouped.has(plan_id)) grouped.set(plan_id, []);
    grouped.get(plan_id).push(interval);
  }
  return grouped;
}

async function planSummary(db, ownerId, row, nowMs, intervalRows, summary) {
  const intervals =
    intervalRows ??
    (await dbAll(
      db,
      'SELECT interval_id,start_ms,end_ms,opened_by,closed_by FROM work_intervals WHERE owner_id=? AND plan_id=? ORDER BY start_ms',
      ownerId,
      row.plan_id,
    ));
  const activeMs =
    row.first_started_at == null
      ? null
      : intervals.reduce(
          (sum, interval) =>
            sum +
            Math.max(0, (interval.end_ms == null ? nowMs : interval.end_ms) - interval.start_ms),
          0,
        );
  const end = row.finished_at ?? row.deleted_at ?? nowMs;
  const calendarMs = row.first_started_at == null ? null : Math.max(0, end - row.first_started_at);
  const completion =
    summary ??
    (await dbFirst(
      db,
      'SELECT (SELECT COUNT(*) FROM tracker_incomplete_steps WHERE owner_id=? AND plan_id=?) AS incompleteStepCount,(SELECT COUNT(*) FROM plan_steps WHERE owner_id=? AND plan_id=?) AS enabled',
      ownerId,
      row.plan_id,
      ownerId,
      row.plan_id,
    ));
  return {
    ...(row.status === 'PLANNED' && row.deleted_at === null
      ? {
          assessmentReadiness: summary
            ? await readinessFromRow(summary.requirements_json ? summary : null)
            : await planStartReadiness(db, ownerId, row.plan_id),
        }
      : {}),
    completion: {
      readyToFinish:
        row.deleted_at == null && (!completion.enabled || completion.incompleteStepCount === 0),
      incompleteStepCount: completion.incompleteStepCount,
      trackerEnabled: Boolean(completion.enabled),
    },
    planId: row.plan_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    planCreatedAt:
      row.plan_created_precision === 'instant'
        ? {
            precision: 'instant',
            value: new Date(row.plan_created_at_ms).toISOString(),
            timeZone: row.plan_created_timezone,
          }
        : { precision: 'dateOnly', on: row.plan_created_on, timeZone: row.plan_created_timezone },
    registeredAt: row.registered_at,
    status: row.status,
    deletedAt: row.deleted_at ?? null,
    firstStartedAt: row.first_started_at,
    finishedAt: row.finished_at,
    version: row.version,
    createdBy: row.created_by,
    sourceReference: row.source_reference,
    intervals: intervals,
    activeMs: activeMs,
    calendarMs: calendarMs,
    pausedMs: calendarMs == null ? null : Math.max(0, calendarMs - activeMs),
    serverNow: nowMs,
  };
}

async function readPlanSnapshot(db, ownerId, planId, nowMs, includeSteps = false) {
  const stepsSql = includeSteps
    ? `(SELECT json_group_array(json_object('step_id',step_id,'ordinal',ordinal,'title',title,
        'content',content,'status',status,'version',version,'created_at',created_at,'updated_at',updated_at))
        FROM (SELECT * FROM plan_steps WHERE owner_id=p.owner_id AND plan_id=p.plan_id ORDER BY ordinal,step_id))`
    : "'[]'";
  const row = await dbFirst(
    db,
    `SELECT p.*,d.markdown,
      (SELECT COUNT(*) FROM tracker_incomplete_steps s WHERE s.owner_id=p.owner_id AND s.plan_id=p.plan_id) AS incompleteStepCount,
      (SELECT COUNT(*) FROM plan_steps s WHERE s.owner_id=p.owner_id AND s.plan_id=p.plan_id) AS enabled,
      t.requirements_json,a.assessment_json,a.requirements_digest,
      (SELECT json_group_array(json_object('interval_id',interval_id,'start_ms',start_ms,'end_ms',end_ms,
        'opened_by',opened_by,'closed_by',closed_by)) FROM (
        SELECT * FROM work_intervals WHERE owner_id=p.owner_id AND plan_id=p.plan_id ORDER BY start_ms
      )) AS intervals_json,
      (SELECT json_group_array(json_object('old_precision',old_precision,'old_at_ms',old_at_ms,'old_on',old_on,
        'old_timezone',old_timezone,'changed_at',changed_at,'changed_by',changed_by,'reason',reason)) FROM (
        SELECT * FROM plan_date_history WHERE owner_id=p.owner_id AND plan_id=p.plan_id ORDER BY changed_at
      )) AS dates_json,
      ${stepsSql} AS steps_json
    FROM plans p LEFT JOIN plan_documents d USING(owner_id,plan_id)
    LEFT JOIN assessment_targets t ON t.owner_id=p.owner_id AND t.plan_id=p.plan_id
      AND t.step_id IS NULL AND p.status='PLANNED' AND p.deleted_at IS NULL
    LEFT JOIN assessment_revisions a ON a.sequence=(SELECT MAX(r.sequence) FROM assessment_revisions r
      WHERE r.owner_id=t.owner_id AND r.plan_id=t.plan_id AND r.step_id IS NULL)
    WHERE p.owner_id=? AND p.plan_id=?`,
    ownerId,
    planId,
  );
  if (!row) throw appError('PLAN_NOT_FOUND', messageFor('PLAN_NOT_FOUND'), 404);
  const plan = await planSummary(db, ownerId, row, nowMs, JSON.parse(row.intervals_json), row);
  if (row.markdown !== null) plan.planText = row.markdown;
  plan.dateHistory = JSON.parse(row.dates_json);
  return { plan, steps: JSON.parse(row.steps_json) };
}

async function readPlan(db, ownerId, planId, nowMs) {
  return (await readPlanSnapshot(db, ownerId, planId, nowMs)).plan;
}

async function buildStepAnalytics(db, ownerId, planId, filter, nowMs) {
  if (!UUID.test(planId || '')) throw appError('VALIDATION_ERROR', 'planId должен быть UUID.');
  const timeZone = checkTimeZone(filter.timeZone || 'UTC');
  const range = inclusiveDateRange(filter.from, filter.to, timeZone);
  if (typeof filter.asOf === 'string' && !/^\d+$/.test(filter.asOf))
    throw appError('VALIDATION_ERROR', 'Некорректное время отчёта.');
  const asOf = filter.asOf == null ? nowMs : Number(filter.asOf);
  if (!Number.isSafeInteger(asOf) || asOf < 0 || asOf > nowMs)
    throw appError('VALIDATION_ERROR', 'Некорректное время отчёта.');
  const row = await dbFirst(
    db,
    `SELECT p.plan_id,
    (SELECT json_group_array(json_object('stepId',step_id,'ordinal',ordinal,'title',title)) FROM
      (SELECT step_id,ordinal,title FROM plan_steps WHERE owner_id=?1 AND plan_id=?2 AND created_at<=?3 ORDER BY ordinal)) AS steps,
    (SELECT json_group_array(json_object('stepId',i.step_id,'startMs',i.start_ms,'endMs',i.end_ms))
      FROM step_work_intervals i JOIN plan_steps s ON s.owner_id=i.owner_id AND s.step_id=i.step_id
      WHERE s.owner_id=?1 AND s.plan_id=?2 AND i.start_ms<=?3) AS windows,
    (SELECT json_group_array(json_object('startMs',start_ms,'endMs',end_ms)) FROM work_intervals
      WHERE owner_id=?1 AND plan_id=?2 AND start_ms<=?3) AS intervals
    FROM plans p WHERE p.owner_id=?1 AND p.plan_id=?2 AND p.deleted_at IS NULL`,
    ownerId,
    planId,
    asOf,
  );
  if (!row) throw appError('PLAN_NOT_FOUND', messageFor('PLAN_NOT_FOUND'), 404);
  const windows = JSON.parse(row.windows),
    intervals = JSON.parse(row.intervals);
  const endMs = Math.min(range.endMs, asOf);
  const steps = JSON.parse(row.steps).map((step) => {
    const recorded = windows.filter((window) => window.stepId === step.stepId);
    let activeMs = recorded.length ? 0 : null;
    for (const window of recorded)
      for (const interval of intervals) {
        activeMs += Math.max(
          0,
          Math.min(window.endMs ?? asOf, interval.endMs ?? asOf, endMs) -
            Math.max(window.startMs, interval.startMs, range.startMs),
        );
      }
    return {
      ...step,
      activeMs,
      firstMeasuredAt: recorded.length
        ? Math.min(...recorded.map((window) => window.startMs))
        : null,
    };
  });
  return { planId, period: { from: filter.from, to: filter.to, timeZone }, asOf, steps };
}

async function readTrackerCapabilities(db, ownerId) {
  return {
    available: true,
    schemaVersion: 2,
    version: TRACKER_VERSION,
    assessments: {
      formatVersion: 1,
      recordTool: 'RecordAssessment',
      getTool: 'GetAssessment',
      historyTool: 'GetEstimationHistory',
      immutableRevisions: true,
      agentDefinedMethods: true,
      maxPayloadBytes: V4_TASK_MAX_BYTES,
      maxJsonDepth: 12,
      forecastUnits: 'ms',
      forecastMetrics: FORECAST_METRICS,
      initialExpectedVersion: 0,
      requirementsDigest: true,
      contextRead: { tool: 'GetAssessment', omitAssessmentId: true },
      expectedRequirementsDigestRequired: true,
      historyMaxTargets: 20,
      historyMaxLimit: 100,
      methodologyControlsExecution: true,
      atlm: {
        formatVersion: 1,
        method: { ...ATLM_METHOD },
        inputSchemaVersion: 'agent-task-v4',
        featureSchemaVersion: ATLM_FEATURE_VERSION,
        agentTaskSchema: AGENT_TASK_SCHEMA,
        metric: 'PLAN_ACTIVE',
        policyVersion: ATLM_POLICY_VERSION,
        engines: ['OLS', 'RIDGE', 'BAYESIAN'],
        intervalEngines: ['BAYESIAN_PREDICTIVE', 'BAYES_QUANTILE'],
        execution: {
          environmentId: {
            optional: false,
            type: 'string',
            closedSet: true,
            values: [...ENVIRONMENT_IDS],
            description: 'Допустимые значения: local, cloud_workspace.',
          },
        },
        predictionScope: 'FULL_FROM_FIRST_START',
        plannedForecastMode: 'CURRENT_READ_ONLY',
        firstStartForecast: 'FROZEN_SNAPSHOT',
        firstStartRequires: 'READY',
        earlyForecastMethod: { ...HISTORICAL_MEDIAN_METHOD },
        calculateTool: 'CalculateAtlmEstimate',
        planEstimateTool: 'GetPlanEstimate',
        predictionRequest: { method: 'ATLM', methodVersion: 1 },
        registry: {
          schemaVersion: 1,
          tools: ATLM_REVISION_TOOL_SCHEMAS,
          limits: ATLM_REVISION_LIMITS,
          teacherRecipeIds: [...ATLM_REVISION_TEACHER_RECIPE_IDS],
          defaultTeacherRecipeId: ATLM_TEACHER_RECIPE_ID_V4,
          teacherDataset: {
            annotationContract: TEACHER_REVIEWED_ANNOTATIONS_CONTRACT,
            exportContract: TEACHER_REVIEWED_DATASET_CONTRACT,
            featureSource: 'annotation.agentTask',
            measuredTimeOverride: 'annotation.actualTime',
            timeUnit: 'milliseconds',
            instructions: 'Проверьте каждый завершённый неудалённый план. По коду и материалам плана уточните все признаки. Для исправления или добавления фактического активного времени запишите actualMs и evidence в annotation.actualTime. Подтверждённый ноль допустим. Исходные замечания снимка служат подсказками для проверки. Учтите явные уточнения пользователя.',
          },
          trainingExecution: 'LOCAL',
          activation: 'EXPLICIT',
        },
      },
    },

    planDocuments: {
      available: true,
      format: 'markdown',
      createField: 'planText',
      stageHeadings: '## Этап 1. Название',
      statusTool: 'SetStepStatus',
      statuses: STEP_STATUSES,
      preservesOriginal: false,
      updateTool: 'UpdatePlanMetadata',
      updateStatus: 'PLANNED',
      updateFields: ['planText', 'stepEdits'],
    },
    steps: {
      model: 'current-state',
      statusHistory: false,
      versionRequired: true,
      timing: {
        available: true,
        unit: 'ms',
        startStatus: 'RUNNING',
        excludesPlanPauses: true,
        historyBackfilled: false,
      },
    },
    planDeletion: {
      softDelete: true,
      deleteTool: 'DeletePlan',
      restoreTool: 'RestorePlan',
      deletedFilter: 'deleted',
      restoreStartsTimer: false,
    },
    parallelPlans: true,
    planList: {
      tool: 'ListPlans',
      statuses: PLAN_STATUSES,
      defaultLimit: 50,
      maxLimit: MAX_PLAN_PAGE_SIZE,
      order: PLAN_LIST_ORDER,
      deletedDefault: false,
    },
    analytics: {
      totalActiveMs: 'union of owner intervals',
      activeByDay: 'union by local day',
      sumPlanActiveMs: 'sum of per-plan intervals',
    },
    exportFormatVersion: 3,
  };
}

async function readPlanExecutionSnapshot(db, ownerId, planId, nowMs) {
  if (!UUID.test(planId || '')) throw appError('VALIDATION_ERROR', 'planId должен быть UUID.');
  const { plan, steps } = await readPlanSnapshot(db, ownerId, planId, nowMs, true);
  for (const step of steps) {
    step.readyToFinish = step.status === 'DONE';
    step.readinessBlockers = step.readyToFinish ? [] : [{ code: 'STEP_NOT_DONE' }];
  }
  return { plan, steps, serverNow: nowMs };
}

async function readCommandReceipt(db, ownerId, commandId) {
  if (!UUID.test(commandId || ''))
    throw appError('VALIDATION_ERROR', 'commandId должен быть UUID.');
  const row = await dbFirst(
    db,
    'SELECT command_id,command_type,outcome_code,result_version,result_json,server_now_ms,recorded_at FROM command_receipts WHERE owner_id=? AND command_id=?',
    ownerId,
    commandId,
  );
  if (!row) return { status: 'NOT_FOUND', commandId };
  if (row.outcome_code === 'PENDING')
    return {
      status: 'PENDING',
      commandId,
      commandType: row.command_type,
      serverNow: row.server_now_ms,
    };
  const result = parseColumn(row.result_json, {});
  return {
    status: 'FINAL',
    commandId,
    commandType: row.command_type,
    ...(row.outcome_code === 'OK'
      ? { result }
      : {
          error: { code: row.outcome_code, message: messageFor(row.outcome_code), details: result },
        }),
    resultVersion: row.result_version,
    recordedAt: row.recorded_at,
    serverNow: row.server_now_ms,
  };
}

async function buildAnalytics(db, ownerId, filter, nowMs) {
  const timeZone = checkTimeZone(filter.timeZone || 'UTC');
  const range = inclusiveDateRange(filter.from, filter.to, timeZone);
  const plans = await dbAll(
    db,
    'SELECT p.plan_id,p.title,p.status,p.version,p.finished_at,p.first_started_at FROM plans p WHERE p.owner_id=? AND p.deleted_at IS NULL ORDER BY p.registered_at DESC',
    ownerId,
  );
  const intervalRows = await dbAll(
    db,
    `SELECT i.plan_id,i.start_ms,i.end_ms FROM work_intervals i
    JOIN plans p ON p.owner_id=i.owner_id AND p.plan_id=i.plan_id WHERE i.owner_id=? AND p.deleted_at IS NULL
    ORDER BY i.plan_id,i.start_ms`,
    ownerId,
  );
  const groupedIntervals = intervalsByPlan(intervalRows);
  const days = new Map(),
    clippedIntervals = [];
  let sumPlanActiveMs = 0;
  const completedDurations = [];
  const inactivePlans = [];
  let completedPlans = 0;
  const included = [];
  for (const plan of plans) {
    const intervals = groupedIntervals.get(plan.plan_id) ?? [];
    let clippedTotal = 0;
    for (const interval of intervals) {
      const end = Math.min(interval.end_ms ?? nowMs, nowMs);
      let cursor = Math.max(interval.start_ms, range.startMs);
      const stop = Math.min(end, range.endMs);
      if (stop <= cursor) continue;
      clippedTotal += stop - cursor;
      clippedIntervals.push([cursor, stop]);
    }
    sumPlanActiveMs += clippedTotal;
    const fullActive =
      plan.first_started_at == null || intervals.length === 0
        ? null
        : intervals.reduce(
            (sum, interval) =>
              sum + Math.max(0, Math.min(interval.end_ms ?? nowMs, nowMs) - interval.start_ms),
            0,
          );
    const finishedInRange =
      plan.status === 'COMPLETED' &&
      plan.finished_at <= nowMs &&
      plan.finished_at >= range.startMs &&
      plan.finished_at < range.endMs;
    if (finishedInRange) {
      completedPlans += 1;
      if (fullActive != null) completedDurations.push(fullActive);
    }
    if (clippedTotal > 0 || finishedInRange) {
      included.push({
        planId: plan.plan_id,
        title: plan.title,
        status: plan.status,
        activeInPeriodMs: clippedTotal,
        fullActiveMs: fullActive,
        measured: fullActive != null,
        finishedAt: plan.finished_at,
      });
    }
    if ((plan.status === 'PLANNED' || plan.status === 'PAUSED') && clippedTotal === 0) {
      inactivePlans.push({
        planId: plan.plan_id,
        title: plan.title,
        status: plan.status,
        version: plan.version,
        activeInPeriodMs: 0,
        finishedAt: null,
      });
    }
  }
  for (const [start, stop] of unionIntervals(clippedIntervals)) {
    let cursor = start;
    while (cursor < stop) {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        })
          .formatToParts(cursor)
          .map((part) => [part.type, part.value]),
      );
      const day = parts.year.padStart(4, '0') + '-' + parts.month + '-' + parts.day;
      const pieceEnd = Math.min(stop, inclusiveDateRange(day, day, timeZone).endMs);
      if (pieceEnd <= cursor) throw new Error('Invalid local day boundary');
      days.set(day, (days.get(day) || 0) + pieceEnd - cursor);
      cursor = pieceEnd;
    }
  }
  return {
    period: {
      from: filter.from,
      to: filter.to,
      timeZone: timeZone,
      startMs: range.startMs,
      endMs: range.endMs,
    },
    activeByDay: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, activeMs]) => ({ date: date, activeMs: activeMs })),
    totalActiveMs: [...days.values()].reduce((sum, value) => sum + value, 0),
    sumPlanActiveMs: sumPlanActiveMs,
    completedPlans: completedPlans,
    completedMedianActiveMs: median(completedDurations),
    completedMeasuredN: completedDurations.length,
    completedSmallSample: completedDurations.length > 0 && completedDurations.length < 5,
    asOf: nowMs,
    plans: included,
    inactivePlans: inactivePlans,
    serverNow: nowMs,
  };
}

export {
  MAX_PLAN_PAGE_SIZE,
  PLAN_STATUSES,
  assessmentPayloadSchema,
  buildAnalytics,
  buildStepAnalytics,
  estimationHistorySchema,
  executeCommand,
  getAssessmentSchema,
  listPlans,
  parsePlanDocument,
  readAssessment,
  readCommandReceipt,
  readEstimationHistory,
  readPlan,
  readPlanExecutionSnapshot,
  readTrackerCapabilities,
};
