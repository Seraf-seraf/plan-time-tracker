import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { call, context, mcp, ok, PLAN } from '../../../sites/plan-time-tracker/test/fixtures/tracker-db.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const features = read('../skills/assess-task/references/features.md');
const track = read('../skills/track-plan/SKILL.md');
const embedded = read('../../../sites/plan-time-tracker/skill/plan-time-tracker/SKILL.md');
const catalog = read('../../../docs/mcp-naming-review.md');

async function invoke(c, name, args = {}) {
  const response = await mcp(c, name, args);
  assert.equal(response.status, 200);
  assert.equal(response.value.result?.isError, undefined, JSON.stringify(response.value));
  return response.value.result.structuredContent;
}

test('the standalone and packaged tracker skills describe the same workflow', () => {
  assert.equal(embedded, track.replace('name: track-plan\n', 'name: plan-time-tracker\n'));
});

test('the tracker skill pauses only after it confirms its own BLOCKED command', () => {
  const section = track.match(/^### Пауза после BLOCKED\n\n([\s\S]*?)(?=^## )/m)?.[1];
  assert.ok(section, 'the BLOCKED workflow must have explicit instructions');
  assert.match(section, /SetStepStatus[^\n]+BLOCKED[^\n]+верси[а-я]+ этапа/u);
  assert.match(section, /Подтвердите[^\n]+SetStepStatus[^\n]+GetCommandResult/u);
  assert.match(section, /SetStepStatus` отклонён[^\n]+PausePlan` не вызывайте/u);
  assert.match(section, /GetPlanProgress[^\n]+того же плана[^\n]+PAUSED[^\n]+RUNNING[^\n]+PausePlan[^\n]+новым UUID/u);
  assert.match(section, /VERSION_CONFLICT[^\n]+BLOCKED[^\n]+RUNNING/u);
  assert.match(section, /PausePlan` не удался[^\n]+фактические статусы/u);
  assert.match(section, /правило не применяется[^\n]+FAILED[^\n]+DONE[^\n]+PENDING/u);
});

test('the MCP reference matches the public tool inventory and the advertised task schema', async () => {
  const c = context();
  try {
    const capability = (await invoke(c, 'GetTrackerInfo')).assessments.atlm;
    const response = await call(c, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const listing = response.value.result.tools;
    const documentedNames = catalog
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .flatMap((line) => [...line.split('|')[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]));
    assert.deepEqual(documentedNames.sort(), listing.map((tool) => tool.name).sort());
    for (const tool of listing) {
      assert.ok(tool.description?.trim(), tool.name);
    }

    const estimate = listing.find((tool) => tool.name === capability.calculateTool);
    const save = listing.find((tool) => tool.name === 'SaveTaskAssessment');
    const props = capability.agentTaskSchema.properties;
    assert.deepEqual(estimate.inputSchema.properties.agentTask, capability.agentTaskSchema);
    assert.deepEqual(
      save.inputSchema.properties.payload.properties.context.properties.agentTask,
      capability.agentTaskSchema,
    );
    assert.deepEqual(props.schemaVersion.enum, [capability.inputSchemaVersion]);
    for (const field of capability.agentTaskSchema.required) {
      assert.ok(features.includes('`' + field + '`'), field);
    }
    assert.deepEqual(props.execution.properties.environmentId.enum, ['local', 'cloud_workspace']);
    assert.deepEqual(
      props.systemBoundaries.items.properties.operations.items.properties.action.enum,
      ['READ', 'WRITE'],
    );
  } finally {
    c.close();
  }
});

for (const withBoundary of [false, true]) {
  test('the documented request saves, reads and freezes an estimate '
    + (withBoundary ? 'with an operation' : 'with no system boundaries'), async () => {
    const c = context();
    try {
      const [agentTask, boundary, request] = [...features.matchAll(/```json\s*([\s\S]*?)```/g)]
        .map((match) => JSON.parse(match[1]));
      if (withBoundary) {
        agentTask.systemBoundaries = [boundary];
        delete agentTask.evidence.systemBoundaries;
      }
      await ok(c, 'CreatePlan', {
        planId: PLAN,
        title: 'Документированный пример',
        planText: '# План\n\n## Этап 1. Проверить\nСохранить и прочитать оценку.',
        planCreatedAt: { precision: 'dateOnly', on: '2026-11-11', timeZone: 'UTC' },
      });
      const { currentRequirementsDigest: expectedRequirementsDigest } =
        await invoke(c, 'GetTaskAssessment', { planId: PLAN });
      const preview = await invoke(c, 'EstimatePlanTime', {
        planId: PLAN, expectedRequirementsDigest, agentTask,
      });
      assert.equal(preview.status, 'UNAVAILABLE');

      const { assessmentId } = request.payload;
      Object.assign(request.payload, { planId: PLAN, expectedRequirementsDigest });
      request.payload.context.agentTask = agentTask;
      await invoke(c, 'SaveTaskAssessment', request);
      const saved = await invoke(c, 'GetTaskAssessment', { planId: PLAN, assessmentId });
      assert.deepEqual(saved.assessment.context.agentTask, agentTask);
      assert.equal(saved.revision, 1);
      assert.equal(saved.assessmentReadiness.status, 'READY');

      const planned = await invoke(c, 'GetSavedEstimate', { planId: PLAN });
      assert.equal(planned.assessmentReadiness.status, 'READY');
      await ok(c, 'StartPlan', { planId: PLAN }, 0);
      const frozen = await invoke(c, 'GetSavedEstimate', { planId: PLAN });
      assert.equal(frozen.source, 'FROZEN_INPUT');
    } finally {
      c.close();
    }
  });
}
