import { appError, dbFirst, messageFor } from '../shared/index.js';
import { revisePlanDocument, validateDocumentUpdate } from './plan-document.js';

function preparePlanAssessmentTargets(db, ownerId, planId, plan, guard, guardArgs) {
  return [
    db.prepare(
      `INSERT INTO assessment_targets(owner_id,plan_id,step_id,requirements_json)
      SELECT ?,?,NULL,json_object('plan',json(?),'steps',json_group_array(json_object(
        'stepId',step_id,'ordinal',ordinal,'title',title,'content',content)))
      FROM (SELECT * FROM plan_steps WHERE owner_id=? AND plan_id=? ORDER BY ordinal) HAVING ${guard}`,
    ).bind(ownerId, planId, JSON.stringify(plan), ownerId, planId, ...guardArgs),
    db.prepare(
      `INSERT INTO assessment_targets(owner_id,plan_id,step_id,requirements_json)
      SELECT s.owner_id,s.plan_id,s.step_id,json_object('plan',json_extract(t.requirements_json,'$.plan'),
        'step',json_object('stepId',s.step_id,'title',s.title,'content',s.content))
      FROM plan_steps s JOIN assessment_targets t
        ON t.owner_id=s.owner_id AND t.plan_id=s.plan_id AND t.step_id IS NULL
      WHERE s.owner_id=? AND s.plan_id=? AND ${guard}`,
    ).bind(ownerId, planId, ...guardArgs),
  ];
}

async function updatePlanDocumentBatch(db, insertReceipt, receiptValues, envelope, nowMs) {
  const [ownerId, commandId] = receiptValues;
  const { payload, expectedVersion } = envelope;
  const { planId } = payload;
  const current = await dbFirst(db,
    `SELECT p.title,p.version,p.status,p.first_started_at,p.deleted_at,d.markdown,
      (SELECT json_group_array(json_object('step_id',step_id,'ordinal',ordinal,'title',title,'content',content))
         FROM (SELECT * FROM plan_steps WHERE owner_id=p.owner_id AND plan_id=p.plan_id ORDER BY ordinal)) AS steps
     FROM plans p LEFT JOIN plan_documents d USING(owner_id,plan_id)
     WHERE p.owner_id=? AND p.plan_id=?`, ownerId, planId);
  if (!current) throw appError('PLAN_NOT_FOUND', messageFor('PLAN_NOT_FOUND'), 404);
  if (current.deleted_at !== null) throw appError('PLAN_DELETED', messageFor('PLAN_DELETED'), 409);
  if (current.version !== expectedVersion)
    throw appError('VERSION_CONFLICT', messageFor('VERSION_CONFLICT'), 409, { currentVersion: current.version });
  if (current.status !== 'PLANNED' || current.first_started_at !== null)
    throw appError('INVALID_TRANSITION', 'Документ можно менять только до первого запуска плана.', 409);

  const fullSections = validateDocumentUpdate(payload);
  const oldSteps = JSON.parse(current.steps);
  const revision = revisePlanDocument(payload, current.markdown, oldSteps, fullSections);
  const removed = JSON.stringify(revision.removed);
  const nonce = crypto.randomUUID();
  const guard = `EXISTS(SELECT 1 FROM command_receipts WHERE owner_id=? AND command_id=?
    AND outcome_code='OK' AND json_extract(payload_json,'$.nonce')=?)`;
  const guardArgs = [ownerId, commandId, nonce];

  // Decide inside the same batch as the writes. A concurrent start or assessment may
  // supersede the snapshot after the Markdown was parsed.
  const receipt = db.prepare(
    `WITH decision AS (
      SELECT p.version,p.status,CASE
        WHEN p.plan_id IS NULL THEN 'PLAN_NOT_FOUND'
        WHEN p.deleted_at IS NOT NULL THEN 'PLAN_DELETED'
        WHEN p.version<>? THEN 'VERSION_CONFLICT'
        WHEN p.status<>'PLANNED' OR p.first_started_at IS NOT NULL THEN 'INVALID_TRANSITION'
        WHEN EXISTS(SELECT 1 FROM assessment_revisions a
          WHERE a.owner_id=p.owner_id AND a.plan_id=p.plan_id AND a.step_id IN (SELECT value FROM json_each(?)))
          OR EXISTS(SELECT 1 FROM step_work_intervals i
          WHERE i.owner_id=p.owner_id AND i.step_id IN (SELECT value FROM json_each(?)))
          THEN 'STEP_HISTORY_EXISTS'
        ELSE 'OK' END AS code
      FROM (SELECT 1) LEFT JOIN plans p ON p.owner_id=? AND p.plan_id=?
    )
    ${insertReceipt}
    SELECT ?,?,?,?,?,?,?,?,?,CASE WHEN code='OK' THEN ? ELSE '{}' END,
      code,json_object('planId',?,'status',status,'version',version+(code='OK'),
        'currentVersion',version+(code='OK'),'serverNow',?),? FROM decision`,
  ).bind(
    expectedVersion, removed, removed, ownerId, planId, ...receiptValues,
    JSON.stringify({ nonce }), planId, nowMs, nowMs,
  );
  const oldOrdinalMax = oldSteps.at(-1)?.ordinal ?? 0;
  const statements = [
    receipt,
    db.prepare(`DELETE FROM assessment_targets WHERE owner_id=? AND plan_id=? AND ${guard}`)
      .bind(ownerId, planId, ...guardArgs),
    db.prepare(`DELETE FROM plan_steps WHERE owner_id=? AND plan_id=? AND ${guard}
      AND step_id IN (SELECT value FROM json_each(?))`)
      .bind(ownerId, planId, ...guardArgs, removed),
    // Park existing ordinals above both lists to avoid collisions when reordering.
    db.prepare(`UPDATE plan_steps SET ordinal=ordinal+? WHERE owner_id=? AND plan_id=? AND ${guard}`)
      .bind(oldOrdinalMax + revision.steps.length, ownerId, planId, ...guardArgs),
    db.prepare(`INSERT INTO plan_steps(owner_id,plan_id,step_id,ordinal,title,content,created_at,updated_at)
      SELECT ?,?,json_extract(value,'$.stepId'),json_extract(value,'$.ordinal'),
        json_extract(value,'$.title'),json_extract(value,'$.content'),?,?
      FROM json_each(?) WHERE ${guard}
      ON CONFLICT(owner_id,step_id) DO UPDATE SET
        ordinal=excluded.ordinal,title=excluded.title,content=excluded.content`)
      .bind(ownerId, planId, nowMs, nowMs, JSON.stringify(revision.steps), ...guardArgs),
    db.prepare(`UPDATE plan_steps SET version=version+1,updated_at=MAX(updated_at,?)
      WHERE owner_id=? AND plan_id=? AND ${guard} AND step_id IN (SELECT value FROM json_each(?))`)
      .bind(nowMs, ownerId, planId, ...guardArgs,
        JSON.stringify(revision.steps.filter(step => step.changed).map(step => step.stepId))),
    db.prepare(`INSERT INTO plan_documents(owner_id,plan_id,markdown) SELECT ?,?,? WHERE ${guard}
      ON CONFLICT(owner_id,plan_id) DO UPDATE SET markdown=excluded.markdown`)
      .bind(ownerId, planId, revision.markdown, ...guardArgs),
    ...preparePlanAssessmentTargets(db, ownerId, planId,
      { title: current.title, planText: revision.markdown }, guard, guardArgs),
    db.prepare(`UPDATE plans SET version=version+1 WHERE owner_id=? AND plan_id=? AND ${guard}`)
      .bind(ownerId, planId, ...guardArgs),
    db.prepare(`UPDATE command_receipts SET payload_json='{}',
      result_version=json_extract(result_json,'$.version') WHERE owner_id=? AND command_id=?
      AND json_extract(payload_json,'$.nonce')=?`).bind(...guardArgs),
  ];
  return (await db.batch(statements))[0];
}

export { preparePlanAssessmentTargets, updatePlanDocumentBatch };
