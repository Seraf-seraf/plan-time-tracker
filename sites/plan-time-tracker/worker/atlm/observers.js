import { ATLM_OWNER_SCHEMA_VERSION, AtlmOwnerRepository } from './owner-repository.js';

const SOURCE_EVENTS = new Set([
  'plan.starting',
  'plan.pausing',
  'plan.resuming',
  'plan.finishing',
  'plan.deleting',
  'plan.restoring',
  'plan.metadata-changing',
  'step.status-changing',
]);

/** Keeps the frozen input and the durable source refresh in the command transaction. */
class AtlmPlanObserver {
  observe(transaction, event) {
    if (!SOURCE_EVENTS.has(event.type)) return;
    if (event.type === 'plan.starting') this.captureFirstStart(transaction, event);
    const guard = this.sourceGuard(event);
    if (guard) this.refreshSource(transaction, event, guard);
  }

  captureFirstStart(transaction, event) {
    const { ownerId, planId, commandId, nowMs, values, guard } = event;
    const forecast = values.atlmStartForecast;
    // The command's first-start gate has already checked the exact assessment,
    // requirements, and forecast snapshot inside this same transaction.
    transaction.add(
      `INSERT INTO plan_estimation_inputs(owner_id,plan_id,assessment_sequence,
        requirements_digest,requirements_json,first_started_at,captured_receipt_rowid,
        selection_status,forecast_json)
      SELECT a.owner_id,a.plan_id,a.sequence,a.requirements_digest,a.requirements_json,?,
        r.rowid,'CAPTURED',?
      FROM command_receipts r JOIN assessment_revisions a
        ON a.owner_id=r.owner_id AND a.plan_id=r.plan_id AND a.sequence=?
      WHERE r.owner_id=? AND r.command_id=? AND r.plan_id=? AND ${guard.sql}`,
      nowMs, JSON.stringify(forecast?.estimation ?? null), forecast?.assessmentSequence ?? null,
      ownerId, commandId, planId, ...guard.args,
    );
  }

  sourceGuard(event) {
    const { ownerId, planId, stepId, values, guard } = event;
    if (event.type === 'plan.starting') return guard;
    let difference = '1';
    const differenceArgs = [];
    if (event.type === 'plan.metadata-changing') {
      const comparisons = [];
      for (const [field, column] of [
        ['title', 'title'],
        ['description', 'description'],
        ['acceptanceCriteria', 'acceptance_criteria'],
      ]) {
        if (!Object.hasOwn(values, field) || values[field] === undefined) continue;
        comparisons.push(`p.${column} IS NOT ?`);
        differenceArgs.push(values[field] ?? '');
      }
      if (!comparisons.length) return null;
      difference = '(' + comparisons.join(' OR ') + ')';
    } else if (event.type === 'step.status-changing') {
      difference = `EXISTS(SELECT 1 FROM plan_steps s WHERE s.owner_id=p.owner_id
        AND s.plan_id=p.plan_id AND s.step_id=? AND s.status IS NOT ?)`;
      differenceArgs.push(stepId, values.status);
    }
    return {
      sql: `${guard.sql} AND EXISTS(SELECT 1 FROM plans p WHERE p.owner_id=? AND p.plan_id=?
        AND p.first_started_at IS NOT NULL AND ${difference})`,
      args: [...guard.args, ownerId, planId, ...differenceArgs],
    };
  }

  refreshSource(transaction, event, guard) {
    const { ownerId, planId, nowMs } = event;
    const owners = new AtlmOwnerRepository(transaction.db);
    // Requests for different plans may commit out of timestamp order. Preserve
    // the owner's committed receipt time so a late source cannot enter an earlier forecast.
    const sourceTime = `MAX(?,COALESCE((SELECT MAX(server_now_ms)
      FROM command_receipts WHERE owner_id=?),0))`;
    transaction.addPrepared(owners.ensureStatement(ownerId, guard));
    transaction.add(
      `WITH source_time AS (SELECT ${sourceTime} AS changed_at)
      INSERT INTO estimation_jobs(owner_id,job_key,kind,plan_id,generation,status,
        created_at,updated_at,source_changed_at,fence)
      SELECT ?,?,'REFRESH_SAMPLE',?,1,'QUEUED',changed_at,changed_at,changed_at,
        COALESCE((SELECT data_reset_at FROM estimation_owner_state WHERE owner_id=?),0)
      FROM source_time WHERE ${guard.sql}
      ON CONFLICT(owner_id,job_key) DO UPDATE SET generation=estimation_jobs.generation+1,
        status=CASE WHEN estimation_jobs.status='RUNNING' THEN estimation_jobs.status ELSE 'QUEUED' END,
        attempts=0,next_attempt_at=0,updated_at=excluded.updated_at,
        source_changed_at=MAX(estimation_jobs.source_changed_at,excluded.source_changed_at)`,
      nowMs, ownerId, ownerId, 'refresh:' + planId, planId, ownerId, ...guard.args,
    );
    transaction.add(
      `UPDATE estimation_models SET status='INVALIDATED',reason='SOURCE_CHANGED'
      WHERE owner_id=? AND status='ACTIVE' AND ${guard.sql}
        AND EXISTS(SELECT 1 FROM json_each(estimation_models.manifest_json) m
          JOIN estimation_samples s ON s.owner_id=estimation_models.owner_id
            AND s.sequence=CAST(m.value AS INTEGER) WHERE s.plan_id=?)`,
      ownerId, ...guard.args, planId,
    );
    transaction.add(
      `UPDATE estimation_owner_state SET forced_retrain=1,manual_epoch=manual_epoch+1,updated_at=${sourceTime}
      WHERE owner_id=? AND ${guard.sql}
        AND EXISTS(SELECT 1 FROM estimation_models m WHERE m.owner_id=estimation_owner_state.owner_id
          AND m.model_id=estimation_owner_state.active_model_id AND m.status='INVALIDATED')`,
      nowMs, ownerId, ownerId, ...guard.args,
    );
  }
}

/** Accounts for the sample under exactly the same predicate as its following INSERT. */
class AtlmSampleObserver {
  observe(transaction, event) {
    if (event.type !== 'sample.persisting') return;
    const { ownerId, source, nowMs, guard } = event;
    transaction.add(
      `INSERT INTO estimation_owner_state(owner_id,schema_version,dataset_revision,new_sample_count,updated_at)
      SELECT ?,?,1,CASE WHEN ?='ELIGIBLE' AND NOT EXISTS(SELECT 1 FROM estimation_samples
        WHERE owner_id=? AND plan_id=? AND is_first_eligible=1) THEN 1 ELSE 0 END,?
      WHERE ${guard.sql}
      ON CONFLICT(owner_id) DO UPDATE SET dataset_revision=estimation_owner_state.dataset_revision+1,
        new_sample_count=estimation_owner_state.new_sample_count+excluded.new_sample_count,
        updated_at=excluded.updated_at`,
      ownerId, ATLM_OWNER_SCHEMA_VERSION, source.eligibility, ownerId, source.planId, nowMs,
      ...guard.args,
    );
  }
}

/** Discards checkpoint parts only when the matching generation transition can apply. */
class AtlmCheckpointObserver {
  observe(transaction, event) {
    if (event.type !== 'training.checkpoint-discarding') return;
    const { ownerId, generation, guard } = event;
    const upperBound = generation === undefined
      ? "(SELECT generation FROM estimation_jobs WHERE owner_id=? AND job_key='train')"
      : '?';
    transaction.add(
      `DELETE FROM estimation_checkpoint_parts WHERE owner_id=? AND generation<=${upperBound}
        AND ${guard.sql}`,
      ownerId, generation === undefined ? ownerId : generation, ...guard.args,
    );
  }
}

export { AtlmPlanObserver, AtlmSampleObserver, AtlmCheckpointObserver };
