/** The execution nonce makes every effect belong to this insertion, never a replay. */
class CommandReceipt {
  constructor(context) {
    Object.assign(this, context);
    this.keyArgs = [this.ownerId, this.commandId, this.executionNonce];
    this.keySql = 'owner_id=? AND command_id=? AND execution_nonce=?';
    this.guard = {
      sql: `EXISTS(SELECT 1 FROM command_receipts WHERE ${this.keySql} AND outcome_code='OK')`,
      args: this.keyArgs,
    };
  }

  decide(transaction, sql, ...args) {
    transaction.add(
      `WITH decision AS (${sql})
      UPDATE command_receipts SET outcome_code=(SELECT code FROM decision),
        result_version=(SELECT result_version FROM decision),
        result_json=(SELECT result_json FROM decision)
      WHERE ${this.keySql} AND outcome_code='PENDING'`,
      ...args,
      ...this.keyArgs,
    );
  }

  rejectDeletedPlan(transaction) {
    if (['DeletePlan', 'RestorePlan'].includes(this.commandType)) return;
    transaction.add(
      `UPDATE command_receipts SET outcome_code='PLAN_DELETED',
        result_version=(SELECT version FROM plans WHERE owner_id=? AND plan_id=?),
        result_json=json_object('error','PLAN_DELETED','planId',?,'serverNow',?)
      WHERE ${this.keySql} AND outcome_code='PENDING'
        AND EXISTS(SELECT 1 FROM plans WHERE owner_id=? AND plan_id=? AND deleted_at IS NOT NULL)`,
      this.ownerId, this.planId, this.planId, this.nowMs,
      ...this.keyArgs, this.ownerId, this.planId,
    );
  }

  finish(transaction, assignments, ...args) {
    transaction.add(
      `UPDATE command_receipts SET ${assignments} WHERE ${this.keySql} AND outcome_code='OK'`,
      ...args,
      ...this.keyArgs,
    );
  }

  emit(events, transaction, type) {
    events.emit(transaction, {
      type,
      ownerId: this.ownerId,
      planId: this.planId,
      stepId: this.values.stepId,
      commandId: this.commandId,
      nowMs: this.nowMs,
      actorId: this.actorId,
      values: this.values,
      guard: this.guard,
    });
  }
}

export { CommandReceipt };
