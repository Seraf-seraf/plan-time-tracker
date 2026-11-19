import { TransactionalEvents } from '../application/events.js';
import { AtlmPlanObserver } from '../atlm/observers.js';
import { CommandReceipt } from './command-receipt.js';
import { RequirementsObserver, StepIntervalObserver, WorkIntervalObserver } from './lifecycle-observers.js';

function planResult(alias = 'p') {
  return `CASE WHEN ${alias}.plan_id IS NULL THEN json_object('serverNow',?) ELSE
    json_object('planId',${alias}.plan_id,'status',${alias}.status,'version',${alias}.version,
      'currentVersion',${alias}.version,'serverNow',?,'firstStartedAt',${alias}.first_started_at,
      'finishedAt',${alias}.finished_at,'deletedAt',${alias}.deleted_at) END`;
}

function finishPlanReceipt(transaction, receipt) {
  receipt.finish(transaction,
    `result_version=(SELECT version FROM plans WHERE owner_id=? AND plan_id=?),
    result_json=(SELECT ${planResult()} FROM (SELECT 1) LEFT JOIN plans p ON p.owner_id=? AND p.plan_id=?)`,
    receipt.ownerId, receipt.planId, receipt.nowMs, receipt.nowMs, receipt.ownerId, receipt.planId);
}

/** Owns the allowed plan transitions; observers own their dependent records. */
class PlanLifecycleHandler {
  constructor(events) {
    this.events = events;
  }

  append(transaction, receipt) {
    if (receipt.commandType === 'CreatePlan') return this.create(transaction, receipt);
    const { ownerId, planId, expectedVersion, nowMs, commandType, values, guard } = receipt;
    const open = "EXISTS(SELECT 1 FROM work_intervals WHERE owner_id=p.owner_id AND plan_id=p.plan_id AND end_ms IS NULL)";
    const closed = "EXISTS(SELECT 1 FROM work_intervals WHERE owner_id=p.owner_id AND plan_id=p.plan_id AND end_ms IS NOT NULL)";
    const incomplete = 'EXISTS(SELECT 1 FROM tracker_incomplete_steps WHERE owner_id=p.owner_id AND plan_id=p.plan_id)';
    const transitions = {
      StartPlan: { condition: "p.status='PLANNED' AND p.deleted_at IS NULL", event: 'plan.starting' },
      PausePlan: { condition: `p.status='RUNNING' AND p.deleted_at IS NULL AND ${open}`, event: 'plan.pausing' },
      ResumePlan: { condition: `p.status='PAUSED' AND p.deleted_at IS NULL AND ${closed}`, event: 'plan.resuming' },
      FinishPlan: {
        condition: `p.deleted_at IS NULL AND ((p.status='RUNNING' AND ${open}) OR (p.status='PAUSED' AND NOT ${open}))
          AND (NOT ${incomplete} OR ${values.allowIncomplete === true ? '1' : '0'})`,
        failure: `WHEN ${incomplete} AND p.status IN ('RUNNING','PAUSED') THEN 'CHECKPOINTS_INCOMPLETE'`,
        event: 'plan.finishing',
      },
      DeletePlan: { condition: 'p.deleted_at IS NULL', failure: "WHEN p.deleted_at IS NOT NULL THEN 'PLAN_DELETED'", event: 'plan.deleting' },
      RestorePlan: { condition: 'p.deleted_at IS NOT NULL', failure: "WHEN p.deleted_at IS NULL THEN 'PLAN_NOT_DELETED'", event: 'plan.restoring' },
    };
    const transition = transitions[commandType];
    receipt.decide(transaction,
      `SELECT CASE
        WHEN p.version=? AND ${transition.condition} THEN 'OK'
        WHEN p.plan_id IS NULL THEN 'PLAN_NOT_FOUND'
        WHEN p.version<>? THEN 'VERSION_CONFLICT'
        ${transition.failure ?? ''}
        ELSE 'INVALID_TRANSITION' END AS code,
      p.version AS result_version,${planResult()} AS result_json
      FROM (SELECT 1) LEFT JOIN plans p ON p.owner_id=? AND p.plan_id=?`,
      expectedVersion, expectedVersion, nowMs, nowMs, ownerId, planId);

    receipt.emit(this.events, transaction, transition.event);
    if (commandType === 'FinishPlan' && values.allowIncomplete === true) {
      transaction.add(
        `INSERT INTO tracker_finish_exceptions(owner_id,plan_id,command_id,reason,created_at)
        SELECT ?,?,?,?,? WHERE ${guard.sql}
          AND EXISTS(SELECT 1 FROM tracker_incomplete_steps WHERE owner_id=? AND plan_id=?)`,
        ownerId, planId, receipt.commandId, values.reason, nowMs, ...guard.args, ownerId, planId);
    }
    const updates = {
      StartPlan: ["status='RUNNING',version=version+1,first_started_at=?", nowMs],
      PausePlan: ["status='PAUSED',version=version+1"],
      ResumePlan: ["status='RUNNING',version=version+1"],
      FinishPlan: ["status='COMPLETED',finished_at=?,version=version+1", nowMs],
      DeletePlan: ["deleted_at=?,status=CASE WHEN status='RUNNING' THEN 'PAUSED' ELSE status END,version=version+1", nowMs],
      RestorePlan: ['deleted_at=NULL,version=version+1'],
    };
    const [assignments, ...args] = updates[commandType];
    transaction.add(`UPDATE plans SET ${assignments} WHERE owner_id=? AND plan_id=? AND ${guard.sql}`,
      ...args, ownerId, planId, ...guard.args);
    if (commandType === 'DeletePlan') {
      transaction.add(
        `UPDATE plan_steps SET status='BLOCKED',version=version+1,updated_at=?
        WHERE owner_id=? AND plan_id=? AND status='RUNNING' AND ${guard.sql}`,
        nowMs, ownerId, planId, ...guard.args);
    }
    finishPlanReceipt(transaction, receipt);
    if (commandType === 'FinishPlan') {
      receipt.finish(transaction,
        `result_json=json_set(result_json,'$.exceptionId',
          (SELECT command_id FROM tracker_finish_exceptions WHERE owner_id=? AND command_id=?),
          '$.incompleteCount',(SELECT COUNT(*) FROM tracker_incomplete_steps WHERE owner_id=? AND plan_id=?))`,
        ownerId, receipt.commandId, ownerId, planId);
    }
  }

  create(transaction, receipt) {
    const { ownerId, planId, nowMs, actorId, values, guard } = receipt;
    receipt.decide(transaction,
      `SELECT CASE WHEN EXISTS(SELECT 1 FROM plans WHERE owner_id=? AND plan_id=?)
        THEN 'VALIDATION_ERROR' ELSE 'OK' END AS code,0 AS result_version,
        json_object('planId',?,'status','PLANNED','version',0,'registeredAt',?,'serverNow',?) AS result_json`,
      ownerId, planId, planId, nowMs, nowMs);
    const date = values.planCreatedAt;
    transaction.add(
      `INSERT INTO plans(plan_id,owner_id,title,description,acceptance_criteria,plan_created_precision,
        plan_created_at_ms,plan_created_on,plan_created_timezone,registered_at,status,version,created_by,source_reference)
      SELECT ?,?,?,?,?,?,?,?,?,?,'PLANNED',0,?,? WHERE ${guard.sql}`,
      planId, ownerId, values.title, values.description ?? '', values.acceptanceCriteria ?? '',
      date.precision, date.atMs ?? null, date.on ?? null, date.timeZone, nowMs, actorId,
      values.sourceReference ?? null, ...guard.args);
  }
}

/** Metadata changes preserve their date history and dependent assessment targets. */
class MetadataCommandHandler {
  constructor(events) {
    this.events = events;
  }

  append(transaction, receipt) {
    const { ownerId, planId, nowMs, actorId, expectedVersion, values, guard } = receipt;
    const date = values.planCreatedAt;
    const dateValid = !date || !values.dateAfterStart
      || values.confirmDateAnomaly === true || values.confirmDateAnomaly === 1;
    receipt.decide(transaction,
      `SELECT CASE WHEN p.plan_id IS NULL THEN 'PLAN_NOT_FOUND'
        WHEN p.version<>? THEN 'VERSION_CONFLICT'
        WHEN ?=0 AND p.first_started_at IS NOT NULL THEN 'VALIDATION_ERROR'
        ELSE 'OK' END AS code,p.version AS result_version,${planResult()} AS result_json
      FROM (SELECT 1) LEFT JOIN plans p ON p.owner_id=? AND p.plan_id=?`,
      expectedVersion, dateValid ? 1 : 0, nowMs, nowMs, ownerId, planId);
    receipt.emit(this.events, transaction, 'plan.metadata-changing');
    if (date) {
      transaction.add(
        `INSERT INTO plan_date_history(history_id,owner_id,plan_id,old_precision,old_at_ms,old_on,
          old_timezone,changed_at,changed_by,reason)
        SELECT ?,owner_id,plan_id,plan_created_precision,plan_created_at_ms,plan_created_on,
          plan_created_timezone,?,?,? FROM plans WHERE owner_id=? AND plan_id=? AND ${guard.sql}
          AND (plan_created_precision<>? OR plan_created_at_ms IS NOT ? OR plan_created_on IS NOT ?
            OR plan_created_timezone<>?)`,
        crypto.randomUUID().replaceAll('-', ''), nowMs, actorId, values.reason ?? '', ownerId, planId, ...guard.args,
        date.precision, date.atMs ?? null, date.on ?? null, date.timeZone);
    }
    const assignments = [];
    const args = [];
    for (const [input, column] of [['title', 'title'], ['description', 'description'], ['acceptanceCriteria', 'acceptance_criteria']]) {
      if (!Object.hasOwn(values, input) || values[input] === undefined) continue;
      assignments.push(`${column}=?`);
      args.push(values[input] ?? '');
    }
    if (date) {
      assignments.push('plan_created_precision=?', 'plan_created_at_ms=?', 'plan_created_on=?', 'plan_created_timezone=?');
      args.push(date.precision, date.atMs ?? null, date.on ?? null, date.timeZone);
    }
    assignments.push('version=version+1');
    transaction.add(`UPDATE plans SET ${assignments.join(',')} WHERE owner_id=? AND plan_id=? AND ${guard.sql}`,
      ...args, ownerId, planId, ...guard.args);
    finishPlanReceipt(transaction, receipt);
  }
}

/** A step's version is independent from its parent plan's version. */
class StepStatusHandler {
  constructor(events) {
    this.events = events;
  }

  append(transaction, receipt) {
    const { ownerId, nowMs, expectedVersion, values, guard } = receipt;
    receipt.decide(transaction,
      `SELECT CASE WHEN s.step_id IS NULL THEN 'STEP_NOT_FOUND'
        WHEN s.version<>? THEN 'VERSION_CONFLICT'
        WHEN p.status='RUNNING' AND p.deleted_at IS NULL THEN 'OK'
        WHEN p.status='PAUSED' THEN 'PLAN_PAUSED' ELSE 'INVALID_TRANSITION' END AS code,
      s.version AS result_version,CASE WHEN s.step_id IS NULL THEN json_object('serverNow',?)
        ELSE json_object('planId',s.plan_id,'status',s.status,'version',s.version,'currentVersion',s.version,
          'serverNow',?,'stepId',s.step_id) END AS result_json
      FROM (SELECT 1) LEFT JOIN plan_steps s ON s.owner_id=? AND s.step_id=?
        LEFT JOIN plans p ON p.owner_id=s.owner_id AND p.plan_id=s.plan_id`,
      expectedVersion, nowMs, nowMs, ownerId, values.stepId);
    receipt.emit(this.events, transaction, 'step.status-changing');
    transaction.add(
      `UPDATE plan_steps SET status=?,version=version+1,updated_at=?
      WHERE owner_id=? AND step_id=? AND ${guard.sql}`,
      values.status, nowMs, ownerId, values.stepId, ...guard.args);
    receipt.finish(transaction,
      `result_version=(SELECT version FROM plan_steps WHERE owner_id=? AND step_id=?),
      result_json=(SELECT json_object('planId',plan_id,'status',status,'version',version,'currentVersion',version,
        'serverNow',?,'stepId',step_id) FROM plan_steps WHERE owner_id=? AND step_id=?)`,
      ownerId, values.stepId, nowMs, ownerId, values.stepId);
    transaction.add(
      `UPDATE command_receipts SET payload_json='{}' WHERE ${receipt.keySql}
        AND outcome_code IN ('OK','STEP_NOT_FOUND','VERSION_CONFLICT','PLAN_PAUSED','INVALID_TRANSITION')`,
      ...receipt.keyArgs);
  }
}

/** Assessment revisions use the same command transaction as their receipt. */
class AssessmentCommandHandler {
  append(transaction, receipt) {
    const { ownerId, planId, nowMs, actorId, commandId, expectedVersion, values, guard } = receipt;
    const stepId = values.stepId ?? null;
    const assessmentId = values.assessmentId;
    receipt.decide(transaction,
      `SELECT CASE
        WHEN NOT EXISTS(SELECT 1 FROM plans WHERE owner_id=? AND plan_id=?) THEN 'PLAN_NOT_FOUND'
        WHEN ? IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assessment_targets WHERE owner_id=? AND plan_id=? AND step_id=?) THEN 'STEP_NOT_FOUND'
        WHEN EXISTS(SELECT 1 FROM assessment_revisions WHERE owner_id=? AND assessment_id=?
          AND (plan_id<>? OR step_id IS NOT ?)) THEN 'ASSESSMENT_TARGET_CONFLICT'
        WHEN COALESCE((SELECT MAX(revision) FROM assessment_revisions WHERE owner_id=? AND assessment_id=?),0)<>? THEN 'VERSION_CONFLICT'
        WHEN ? IS NOT ? OR NOT EXISTS(SELECT 1 FROM assessment_targets WHERE owner_id=? AND plan_id=?
          AND step_id IS ? AND requirements_json=?) THEN 'ASSESSMENT_CONTEXT_CHANGED'
        WHEN EXISTS(SELECT 1 FROM json_each(?) src WHERE NOT EXISTS(SELECT 1 FROM assessment_targets t
          WHERE t.owner_id=? AND t.plan_id=json_extract(src.value,'$.planId')
            AND t.step_id IS json_extract(src.value,'$.stepId'))) THEN 'ASSESSMENT_SOURCE_NOT_FOUND'
        ELSE 'OK' END AS code,
      COALESCE((SELECT MAX(revision) FROM assessment_revisions WHERE owner_id=? AND assessment_id=?),0) AS result_version,
      json_object('serverNow',?) AS result_json`,
      ownerId, planId, stepId, ownerId, planId, stepId,
      ownerId, assessmentId, planId, stepId, ownerId, assessmentId, expectedVersion,
      values.expectedRequirementsDigest, values.requirementsDigest, ownerId, planId, stepId, values.requirementsJson,
      JSON.stringify(values.sources), ownerId, ownerId, assessmentId, nowMs);
    transaction.add(
      `INSERT INTO assessment_revisions(owner_id,assessment_id,revision,previous_revision,plan_id,step_id,
        author_id,recorded_at,command_id,requirements_json,requirements_digest,assessment_json)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql}`,
      ownerId, assessmentId, expectedVersion + 1, expectedVersion === 0 ? null : expectedVersion,
      planId, stepId, actorId, nowMs, commandId, values.requirementsJson, values.requirementsDigest,
      values.assessmentJson, ...guard.args);
    receipt.finish(transaction,
      `result_version=(SELECT revision FROM assessment_revisions WHERE owner_id=? AND command_id=?),
      result_json=(SELECT json_object('assessmentId',assessment_id,'revision',revision,'previousRevision',previous_revision,
        'planId',plan_id,'stepId',step_id,'requirementsDigest',requirements_digest,'sequence',sequence,'serverNow',?)
        FROM assessment_revisions WHERE owner_id=? AND command_id=?)`,
      ownerId, commandId, nowMs, ownerId, commandId);
  }
}

// Observers append statements before entity writes. ATLM reads the unchanged source
// first; interval and requirements observers then prepare their dependent records.
const atlm = new AtlmPlanObserver();
const workIntervals = new WorkIntervalObserver();
const stepIntervals = new StepIntervalObserver();
const requirements = new RequirementsObserver();
const events = new TransactionalEvents({
  'plan.starting': [atlm, workIntervals],
  'plan.pausing': [atlm, workIntervals],
  'plan.resuming': [atlm, workIntervals],
  'plan.finishing': [atlm, workIntervals, stepIntervals],
  'plan.deleting': [atlm, workIntervals, stepIntervals],
  'plan.restoring': [atlm],
  'plan.metadata-changing': [atlm, requirements],
  'step.status-changing': [atlm, stepIntervals],
});
const lifecycle = new PlanLifecycleHandler(events);
const handlers = new Map([
  ...['CreatePlan', 'StartPlan', 'PausePlan', 'ResumePlan', 'FinishPlan', 'DeletePlan', 'RestorePlan']
    .map((type) => [type, lifecycle]),
  ['UpdatePlanMetadata', new MetadataCommandHandler(events)],
  ['SetStepStatus', new StepStatusHandler(events)],
  ['RecordAssessment', new AssessmentCommandHandler()],
]);

function appendCommand(transaction, context) {
  const handler = handlers.get(context.commandType);
  if (!handler) throw new Error('Missing command handler: ' + context.commandType);
  const receipt = new CommandReceipt(context);
  receipt.rejectDeletedPlan(transaction);
  handler.append(transaction, receipt);
  return receipt;
}

export { appendCommand };
