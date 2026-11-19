/** Plan timers share the command transaction and its single clock value. */
class WorkIntervalObserver {
  observe(transaction, event) {
    const { ownerId, planId, actorId, nowMs, guard } = event;
    if (['plan.starting', 'plan.resuming'].includes(event.type)) {
      transaction.add(
        `INSERT INTO work_intervals(interval_id,owner_id,plan_id,start_ms,end_ms,opened_by,closed_by)
        SELECT ?,?,?,?,NULL,?,NULL WHERE ${guard.sql}`,
        crypto.randomUUID().replaceAll('-', ''), ownerId, planId, nowMs, actorId, ...guard.args,
      );
    } else if (['plan.pausing', 'plan.finishing', 'plan.deleting'].includes(event.type)) {
      const end = event.type === 'plan.deleting' ? 'MAX(start_ms,?)' : '?';
      transaction.add(
        `UPDATE work_intervals SET end_ms=${end},closed_by=?
        WHERE owner_id=? AND plan_id=? AND end_ms IS NULL AND ${guard.sql}`,
        nowMs, actorId, ownerId, planId, ...guard.args,
      );
    }
  }
}

/** Step windows remain open across pauses; reports intersect them with plan time. */
class StepIntervalObserver {
  observe(transaction, event) {
    const { ownerId, planId, stepId, nowMs, values, guard } = event;
    if (event.type === 'step.status-changing') {
      if (values.status !== 'RUNNING') {
        transaction.add(
          `UPDATE step_work_intervals SET end_ms=MAX(start_ms,?)
          WHERE owner_id=? AND step_id=? AND end_ms IS NULL AND ${guard.sql}`,
          nowMs, ownerId, stepId, ...guard.args,
        );
      } else {
        transaction.add(
          `INSERT INTO step_work_intervals(owner_id,step_id,start_ms)
          SELECT ?,?,? WHERE ${guard.sql}
            AND NOT EXISTS(SELECT 1 FROM step_work_intervals WHERE owner_id=? AND step_id=? AND end_ms IS NULL)
          ON CONFLICT(owner_id,step_id,start_ms) DO UPDATE SET end_ms=NULL`,
          ownerId, stepId, nowMs, ...guard.args, ownerId, stepId,
        );
      }
    } else if (['plan.deleting', 'plan.finishing'].includes(event.type)) {
      const running = event.type === 'plan.deleting' ? "AND status='RUNNING'" : '';
      transaction.add(
        `UPDATE step_work_intervals SET end_ms=MAX(start_ms,?)
        WHERE owner_id=? AND end_ms IS NULL AND step_id IN (
          SELECT step_id FROM plan_steps WHERE owner_id=? AND plan_id=? ${running})
          AND ${guard.sql}`,
        nowMs, ownerId, ownerId, planId, ...guard.args,
      );
    }
  }
}

/** Refresh only the requirement fields represented in the stored document form. */
class RequirementsObserver {
  observe(transaction, event) {
    if (event.type !== 'plan.metadata-changing') return;
    const { ownerId, planId, values, guard } = event;
    for (const field of ['title', 'description', 'acceptanceCriteria']) {
      if (!Object.hasOwn(values, field) || values[field] === undefined) continue;
      transaction.add(
        `UPDATE assessment_targets SET requirements_json=json_set(requirements_json,?,?)
        WHERE owner_id=? AND plan_id=? AND json_type(requirements_json,?) IS NOT NULL
          AND ${guard.sql}`,
        '$.plan.' + field, values[field] ?? '', ownerId, planId, '$.plan.' + field, ...guard.args,
      );
    }
  }
}

export { WorkIntervalObserver, StepIntervalObserver, RequirementsObserver };
