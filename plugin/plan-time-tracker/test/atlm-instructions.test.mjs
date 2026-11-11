import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { context, call, mcp, ok, PLAN } from '../../../sites/plan-time-tracker/test/fixtures/tracker-db.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const assess = read('../skills/assess-task/SKILL.md');
const primary = assess.split('## Совместимость с исторической медианой')[0];
const track = read('../skills/track-plan/SKILL.md');
const embedded = read('../../../sites/plan-time-tracker/skill/plan-time-tracker/SKILL.md');
const tools = ['EstimatePlanTime', 'GetSavedEstimate', 'GetTrainingStatus', 'ContinueTraining', 'GetTrainingData'];
const invoke = async (c, name, args = {}) => {
  const response = await mcp(c, name, args);assert.equal(response.status, 200);
  assert.notEqual(response.value.result?.isError, true, JSON.stringify(response.value));
  return response.value.result.structuredContent;
};

test('delivered skills give one pre-start ATLM workflow with current-state steps', () => {
  for (const text of [primary, track, embedded]) {
    assert.match(text, /assessments\.atlm/);assert.match(text, /StartPlan/);
    assert.match(text, /ContinueTraining/);assert.match(text, /serverEstimation/);
  }
  for (const field of ['schemaVersion', 'agent-task-v1', 'profileEvidence', 'runtimeContext', 'plannedParallelAgents', 'CLIENT_REPORTED', 'changedContracts', 'verificationKinds', 'predictionRequest', 'expectedRequirementsDigest', 'GetCommandResult']) assert(primary.includes(field), field);
  assert.match(primary, /UNKNOWN\/null/);assert.match(primary, /не передавай эти счётчики самостоятельно/);
  assert.match(primary, /Не угадывай модель агента или reasoning effort/);
  assert.match(primary, /lowerMs\/upperMs=null/);assert.match(primary, /не называй точку P50\/P80/);
  assert.match(primary, /Поздняя оценка не становится исходным/);
  assert.match(primary, /не вычитай затраченное время/);
  assert.doesNotMatch(primary, /candidates/);
  assert.doesNotMatch(assess, /CalculateEstimate/);
  assert.match(assess, /Для получения прогноза используй только ATLM/);
});

test('instruction names and immutable input fields are available through real MCP discovery', async () => {
  const c = context();
  try {
    const capability = (await invoke(c, 'GetTrackerInfo')).assessments.atlm;
    assert(capability);assert.equal(capability.retrainEveryNewPlans, 5);
    const declared = JSON.stringify(capability);assert.match(declared, /agent-task-v1/);assert.match(declared, /PLAN_ACTIVE/);assert.match(declared, /FULL_FROM_FIRST_START/);
    const listing = (await call(c, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).value.result.tools;
    for (const name of tools) {
      assert(declared.includes(name), 'capability must name ' + name);
      const tool = listing.find(item => item.name === name);assert(tool, name);
      assert.equal(tool.annotations.readOnlyHint, name !== 'ContinueTraining', name);
      assert.equal(tool.inputSchema.additionalProperties, false, name);
    }
    const calculate = listing.find(item => item.name === 'EstimatePlanTime').inputSchema;
    assert.deepEqual([...calculate.required].sort(), ['agentTask', 'expectedRequirementsDigest', 'planId']);
    assert.equal(calculate.properties.candidates, undefined);
    assert.equal(calculate.properties.weights, undefined);
    assert.equal(calculate.properties.durationMs, undefined);
    const record = listing.find(item => item.name === 'SaveTaskAssessment').inputSchema;
    assert(record.required.includes('expectedVersion'));
    assert(record.properties.payload.properties.predictionRequest);
    assert.equal(record.properties.payload.properties.serverEstimation, undefined, 'server forecast is not agent input');
  } finally { c.close(); }
});

test('an instruction-shaped assessment records unknown cold-start forecast, freezes it on start and exports it', async () => {
  const c = context();
  try {
    await ok(c, 'CreatePlan', { planId: PLAN, title: 'Make the existing button accessible on mobile', planText:'# Button\n\n## Этап 1. Button layout\nButton is accessible on mobile', planCreatedAt: { precision: 'dateOnly', on: '2026-11-11', timeZone: 'UTC' } });
    const current = await invoke(c, 'GetTaskAssessment', { planId: PLAN });
    const agentTask = {
      schemaVersion: 'agent-task-v1',
      profile: { workKind: 'MODIFY_MECHANISM', reuseState: 'PARTIAL', doneBoundary: 'LOCAL_VERIFIED' },
      outcomes: [{ id: 'mobile-button-accessible', description: 'Button is accessible on mobile', evidence: 'The requested change is the existing button layout.' }],
      changedContracts: [], verificationKinds: ['BUILD_STATIC', 'UI_E2E'],
      profileEvidence: { workKind: 'Existing button behavior must be changed.', reuseState: 'An existing button needs layout corrections.', doneBoundary: 'Only locally checked delivery was requested.' },
      runtimeContext: { modelId: null, reasoningEffort: null, environmentId: null, plannedParallelAgents: 1, provenance: 'CLIENT_REPORTED' },
    };
    const preview = await invoke(c, 'EstimatePlanTime', { planId: PLAN, expectedRequirementsDigest: current.currentRequirementsDigest, agentTask });
    assert.equal(preview.status, 'UNAVAILABLE');assert.equal(preview.pointMs, null);
    const assessmentId = crypto.randomUUID(), commandId = crypto.randomUUID();
    const payload = {
      assessmentId, planId: PLAN, expectedRequirementsDigest: current.currentRequirementsDigest,
      phase: 'planning', context: { agentTask }, method: { id: 'qualitative', version: '1', scale: ['UNKNOWN'] },
      complexity: { status: 'UNKNOWN', value: null, rationale: 'No calibrated complexity scale is required for the forecast.' },
      unknowns: ['Runtime model and effort are not disclosed.'], assumptions: [], dependencies: [],
      forecast: { status: 'UNKNOWN', metric: 'PLAN_ACTIVE', lowerMs: null, upperMs: null, confidence: 'UNKNOWN', basis: 'Server ATLM point is stored separately when available.', sampleCount: 0 },
      sources: [], approach: { description: 'Adjust the existing layout and verify build and browser behavior.', rationale: 'The existing mechanism covers the required scope.' },
      predictionRequest: { method: 'ATLM', methodVersion: 1 },
    };
    await invoke(c, 'SaveTaskAssessment', { schemaVersion: 1, commandId, expectedVersion: 0, payload });
    const saved = await invoke(c, 'GetTaskAssessment', { planId: PLAN, assessmentId });
    assert.deepEqual(saved.assessment.context.agentTask, agentTask);
    assert.equal(saved.assessment.forecast.status, 'UNKNOWN');assert.equal(saved.assessment.forecast.lowerMs, null);
    const serverEstimation = saved.assessment.serverEstimation;
    assert.equal(serverEstimation.status, 'UNAVAILABLE');assert.equal(serverEstimation.unavailableReason, 'COLLECTING_DATA');assert.equal(serverEstimation.pointMs, null);
    const beforeStart = await invoke(c, 'GetSavedEstimate', { planId: PLAN });assert.deepEqual(beforeStart.serverEstimation, serverEstimation);
    assert.equal((await invoke(c, 'GetPlanExecutionSnapshot', { planId: PLAN })).plan.status, 'PLANNED');
    await ok(c, 'StartPlan', { planId: PLAN }, 0);
    assert.deepEqual((await invoke(c, 'GetSavedEstimate', { planId: PLAN })).serverEstimation, serverEstimation);
    const report = await call(c, '/api/export');assert.equal(report.status, 200);
    const exported = report.value.plans.find(plan => plan.planId === PLAN).assessments.find(row => row.assessmentId === assessmentId);
    assert.deepEqual(exported.assessment.context.agentTask, agentTask);
    assert.deepEqual(exported.assessment.serverEstimation, serverEstimation);
  } finally { c.close(); }
});
