import assert from 'node:assert/strict';
import { parsePlanCreatedAt, payloadHash } from '../../worker/shared/index.js';
import { parsePlanDocument } from '../../worker/tracker/plan-document.js';
import { migration, migrations, OWNER } from './tracker-db.mjs';

/** Seed historical migration inputs through the SQL protocol of that schema. */
export async function seedLegacyCommand(c, commandType, payload, expectedVersion, ownerId = OWNER) {
  const commandId = crypto.randomUUID();
  const envelope = { schemaVersion: 1, commandId, commandType, payload,
    ...(expectedVersion === undefined ? {} : { expectedVersion }) };
  const planId = payload.planId ?? c.db.sqlite.prepare(
    'SELECT plan_id FROM plan_steps WHERE owner_id=? AND step_id=?',
  ).get(ownerId, payload.stepId)?.plan_id;
  c.db.sqlite.prepare(
    `INSERT INTO command_receipts(owner_id,command_id,payload_hash,command_type,plan_id,
      expected_version,server_now_ms,actor_id,actor_type,payload_json,outcome_code,recorded_at)
     VALUES(?,?,?,?,?,?,?,?,'agent',?,'PENDING',?)`,
  ).run(ownerId, commandId, await payloadHash(envelope), commandType, planId,
    expectedVersion ?? null, c.now(), ownerId, JSON.stringify(payload), c.now());
  const receipt = c.db.sqlite.prepare(
    'SELECT * FROM command_receipts WHERE owner_id=? AND command_id=?',
  ).get(ownerId, commandId);
  assert.equal(receipt.outcome_code, 'OK', JSON.stringify(receipt));
  return JSON.parse(receipt.result_json);
}

export async function seedLegacyPlan(c, payload, ownerId = OWNER) {
  const steps = payload.planText === undefined ? [] : parsePlanDocument(payload.planText);
  const plan = payload.planText === undefined
    ? { title: payload.title, description: payload.description ?? '',
      acceptanceCriteria: payload.acceptanceCriteria ?? '' }
    : { title: payload.title, planText: payload.planText };
  const requirementsTargets = [{
    stepId: null,
    requirementsJson: JSON.stringify({ plan, steps: steps.map(({ stepId, ordinal, title, content }) =>
      ({ stepId, ordinal, title, content })) }),
  }];
  // Before 0025, each step's target was supplied by the old application. From
  // 0025 onward, its trigger derives them from the plan-level target instead.
  const derivesStepTargets = c.db.sqlite.prepare(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='command_create_plan'",
  ).get()?.sql.includes('FROM plan_steps s JOIN assessment_targets');
  if (!derivesStepTargets) {
    for (const { stepId, title, content } of steps) requirementsTargets.push({
      stepId, requirementsJson: JSON.stringify({ plan, step: { stepId, title, content } }),
    });
  }
  return seedLegacyCommand(c, 'CreatePlan', {
    ...payload, planCreatedAt: parsePlanCreatedAt(payload.planCreatedAt),
    documentSteps: steps, requirementsTargets,
  }, undefined, ownerId);
}

/** Upgrade only after assertions about the isolated historical migration. */
export function applyRemainingMigrations(c, lastApplied) {
  const index = migrations.indexOf(lastApplied);
  assert.ok(index >= 0, lastApplied);
  for (const name of migrations.slice(index + 1)) {
    c.db.sqlite.exec('SAVEPOINT remaining_migration');
    try {
      c.db.sqlite.exec(migration(name));
      c.db.sqlite.exec('RELEASE remaining_migration');
    } catch (error) {
      c.db.sqlite.exec('ROLLBACK TO remaining_migration; RELEASE remaining_migration');
      throw error;
    }
  }
}
