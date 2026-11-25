import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  mergeAtlmTeacherAnnotations, parseAtlmTeacherRecipe,
} from '../../../sites/plan-time-tracker/worker/atlm/teacher-dataset.js';
import { call, context, mcp, ok, PLAN, taskV4 } from '../../../sites/plan-time-tracker/test/fixtures/tracker-db.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const features = read('../skills/assess-task/references/features.md');
const assess = read('../skills/assess-task/SKILL.md');
const track = read('../skills/track-plan/SKILL.md');
const train = read('../skills/train-model/SKILL.md');
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

test('the tracker skill pauses when its confirmed BLOCKED command stops the whole plan', () => {
  const section = track.match(/^### Пауза после BLOCKED\n\n([\s\S]*?)(?=^## )/m)?.[1];
  assert.ok(section, 'the BLOCKED workflow must have explicit instructions');
  assert.match(section, /SetStepStatus[^\n]+BLOCKED[^\n]+верси[а-я]+ этапа/u);
  assert.match(section, /`GetCommandResult` с тем же `commandId` или повторите исходный запрос без изменений/u);
  assert.match(section, /`result` квитанции со статусом `FINAL`[^\n]+`planId`, `stepId` и `status:'BLOCKED'`/u);
  assert.match(section, /После подтверждения вызовите `GetPlanProgress` для того же плана/u);
  assert.match(section, /есть работа, которую можно продолжить, оставьте `RUNNING`/u);
  assert.match(section, /ваша блокировка остановила весь план[^\n]+BLOCKED[^\n]+на подтверждённой версии[^\n]+RUNNING[^\n]+PausePlan[^\n]+новым UUID[^\n]+payload:\{planId,reason\}/u);
  assert.match(section, /VERSION_CONFLICT[^\n]+заново проверьте условия шага 3[^\n]+новым UUID/u);
  assert.match(section, /При отказе сообщите фактические статусы и причину/u);
  assert.deepEqual([...track.matchAll(/^- ([A-Z_]+) —/gmu)].map((match) => match[1]),
    ['PENDING', 'RUNNING', 'BLOCKED', 'DONE']);
});

test('the MCP reference matches the public tool inventory and the advertised task schema', async () => {
  const c = context();
  try {
    const tracker = await invoke(c, 'GetTrackerInfo');
    const capability = tracker.assessments.atlm;
    assert.deepEqual(tracker.planDocuments.statuses, ['PENDING', 'RUNNING', 'BLOCKED', 'DONE']);
    const response = await call(c, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const listing = response.value.result.tools;
    const statusSchema = listing.find((tool) => tool.name === 'SetStepStatus').inputSchema.properties.payload.properties.status;
    assert.deepEqual(statusSchema.enum, tracker.planDocuments.statuses);
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

test('training skill uses the discovered revision tools and keeps assessment independent', async () => {
  const c = context();
  try {
    const info = await invoke(c, 'GetTrackerInfo');
    const plugin = JSON.parse(read('../plugin.json'));
    assert.equal(info.version, plugin.version);
    const { registry } = info.assessments.atlm;
    assert.equal(registry.schemaVersion, 1);
    assert.equal(registry.trainingExecution, 'LOCAL');
    assert.equal(registry.activation, 'EXPLICIT');
    const { featureSchemaPath, featureSource } = registry.teacherDataset;
    assert.equal(featureSchemaPath.split('.').reduce((value, key) => value[key], info), info.assessments.atlm.agentTaskSchema);
    for (const key of ['featureSchemaPath', 'featureSource', 'featurePolicies', 'whenUnconfirmed.value',
      'whenUnconfirmed.evidencePath', featureSource + '.unknownReasons']) {
      assert.ok(train.includes(key), key);
    }
    assert.ok(features.includes('registry.teacherDataset.featurePolicies'));
    assert.match(train, /registry\.teacherRecipeIds/u);
    const recipeSection = train.split('## Локальный рецепт и проверка\n')[1];
    const recipe = JSON.parse(recipeSection.match(/```json\n([\s\S]*?)```/u)[1]);
    assert.equal(recipe.recipeId, 'atlm-teacher-hybrid-v4');
    assert.equal(registry.defaultTeacherRecipeId, recipe.recipeId);
    assert.ok(registry.teacherRecipeIds.includes(recipe.recipeId));
    assert.deepEqual(recipe.selection, { mode: 'ALL_ELIGIBLE' });
    assert.deepEqual(parseAtlmTeacherRecipe(recipe, recipe.datasetRevisionId, recipe.datasetDigest), recipe);
    const listing = (await call(c, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }))
      .value.result.tools;
    const entries = [...train.matchAll(/^\| `([^`]+)` \|/gm)].map(([, name]) => name);
    assert.equal(entries.length, 6);
    assert.deepEqual(entries.sort(), Object.keys(registry.tools).sort());
    for (const name of entries) {
      assert.deepEqual(listing.find((tool) => tool.name === name)?.inputSchema, registry.tools[name]);
    }
    const repair = registry.tools.CreateTrainingSnapshot.oneOf.find((branch) => branch.properties.mode.enum.includes('repair'));
    assert.deepEqual([...repair.required].sort(), ['commandId', 'mode', 'planIds', 'schemaVersion']);
    assert.equal(repair.properties.planIds.maxItems, 25);
    assert.match(train, /\{schemaVersion:1,mode:'create',commandId\}[^\n]+новым UUID/u);
    assert.match(train, /mode:'repair'` выполняется по отдельному поручению/u);
    assert.match(train, /contract:'atlm-teacher-annotations-v2'/u);
    assert.match(train, /atlm-teacher-dataset-v2/u);
    assert.match(train, /Перепроверьте \*\*каждый признак\*\*/u);
    assert.match(train, /Ноль подходит, когда источник подтверждает/u);
    const annotationsSection = train.split('## Снимок и преподавательская разметка\n')[1];
    const annotations = annotationsSection.match(/```js\n([\s\S]*?)```/u)[1];
    const readExample = new Function('agentTask', 'fieldEvidence', annotations + '\nreturn rows;');
    const [eligible, excluded] = readExample(taskV4(), { verificationKinds: 'Проверки записаны в отчёте.' });
    assert.equal(eligible.eligibility, 'ELIGIBLE');
    assert.equal(eligible.annotation.actualTime.actualMs, 180000);
    assert.ok(eligible.annotation.actualTime.evidence);
    assert.equal(excluded.eligibility, 'EXCLUDED');
    assert.deepEqual(excluded.reasons, ['USER_REQUESTED_SKIP']);
    assert.ok(excluded.exclusionEvidence.userDecision);
    const frozen = [eligible, excluded].map(({ rowId }, index) => ({
      rowId, planId: rowId, rawReasons: ['SOURCE_REFRESH_FAILED'],
      source: {
        planId: rowId, planStatus: 'COMPLETED', deletedAt: null, sourceGeneration: 1,
        ...(index === 0 ? { status: 'UNAVAILABLE', actualMs: null } : {
          status: 'AVAILABLE', actualMs: 30_000, firstStartedAt: 0, finishedAt: 60_000, sourceAvailableAt: 60_000,
        }),
      },
    }));
    const reviewed = mergeAtlmTeacherAnnotations(frozen, [eligible, excluded], { teacherReviewed: true });
    assert.equal(reviewed[0].annotation.actualTime.actualMs, 180000);
    assert.equal(reviewed[0].source.actualMs, null);
    assert.equal(reviewed[1].eligibility, 'EXCLUDED');
    const silentSkip = { ...excluded, reasons: ['ACTUAL_FEATURES_UNVERIFIED'], exclusionEvidence: undefined };
    assert.throws(() => mergeAtlmTeacherAnnotations(frozen, [eligible, silentSkip], { teacherReviewed: true }),
      (error) => error.details?.reason === 'USER_DECISION_REQUIRED' && error.details.rowId === excluded.rowId);
    assert.doesNotMatch(train, /backtestUse|holdoutUse|historicalAvailability/u);
    const saveDescription = listing.find((tool) => tool.name === 'SaveDatasetRevision').description;
    for (const term of ['ELIGIBLE', 'ACTUAL', 'EXCLUDED', 'snapshotId', 'parentDatasetRevisionId']) {
      assert.ok(saveDescription.includes(term), 'SaveDatasetRevision must describe ' + term);
    }
    const retired = ['StartTraining', 'ContinueTraining', 'GetTrainingStatus', 'GetTrainingData', 'GetTrainingHistory'];
    for (const name of retired) {
      assert.equal(listing.some((tool) => tool.name === name), false);
      assert.equal(assess.includes(name), false);
      assert.equal(train.includes(name), false);
    }
    assert(assess.includes('../train-model/SKILL.md'));
  } finally {
    c.close();
  }
});

test('the documented transfer code forwards complete parts, rejects truncation and accepts final replays', async () => {
  const example = train.split('## Передача файлов\n')[1]?.match(/```js\n([\s\S]*?)```/u)?.[1];
  assert(example);
  const init = new Function('tools', 'callTool', 'site', example + '\nreturn { receivePart, sendPart };');
  const partSize = 49_152;
  const content = Buffer.alloc(partSize, 8);
  const contentBase64 = content.toString('base64');
  const file = {
    sha256: 'sha256:' + 'a'.repeat(64), byteLength: partSize, partSize, partCount: 1,
  };
  const upload = { datasetRevisionId: 'revision', commandId: 'command',
    file: { sha256: file.sha256, byteLength: file.byteLength } };
  const calls = [];
  let complete = true;
  let uploadReceipt;
  const tools = { async exec_command(input) {
    calls.push(input);
    const part = input.cmd.includes("'read-part'")
      ? { partIndex: 0, byteLength: partSize, contentBase64: complete ? contentBase64 : contentBase64.slice(0, -4) }
      : { partIndex: 0, byteLength: partSize };
    return { exit_code: 0, output: JSON.stringify(part) };
  } };
  const callTool = async (name, args) => {
    calls.push({ name, args });
    return { structuredContent: args.view === 'filePart'
      ? { fileSha256: file.sha256, partIndex: 0, contentBase64 }
      : uploadReceipt ?? { state: 'UPLOADING', partIndex: args.partIndex } };
  };
  const { receivePart, sendPart } = init(tools, callTool, '/checkout/sites/plan-time-tracker');
  assert.deepEqual(await sendPart('RegisterModelRevision', upload, '/private/bundle.json', file, 0),
    { partIndex: 0, byteLength: partSize });
  assert.equal(calls[0].max_output_tokens, 80000);
  assert.deepEqual(calls[1], {
    name: 'RegisterModelRevision', args: { schemaVersion: 1, ...upload, phase: 'putPart', partIndex: 0, contentBase64 },
  });
  complete = false;
  await assert.rejects(sendPart('RegisterModelRevision', upload, '/private/bundle.json', file, 0), /INVALID_FILE_PART/u);
  assert.equal(calls.length, 3);
  assert.deepEqual(await receivePart('GetDatasetRevision', { datasetRevisionId: 'revision' }, file, 0, '/private/data.partial'),
    { partIndex: 0, byteLength: partSize });
  assert.equal(calls[3].args.view, 'filePart');
  assert(calls[4].cmd.startsWith("'node' 'scripts/atlm-transfer.mjs' 'write-part'"));

  complete = true;
  uploadReceipt = { state: 'REGISTERED', modelRevisionId: upload.commandId, replayed: true };
  assert.deepEqual(await sendPart('RegisterModelRevision', upload, '/private/bundle.json', file, 0), uploadReceipt);
  const save = { snapshotId: 'snapshot', commandId: 'save-command', file: upload.file };
  uploadReceipt = { state: 'SAVED', datasetRevisionId: save.commandId, replayed: true };
  assert.deepEqual(await sendPart('SaveDatasetRevision', save, '/private/annotations.json', file, 0), uploadReceipt);
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
