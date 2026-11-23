import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fitAtlm, normalizeAgentTask } from '../worker/atlm/model.js';
import { teacherAnnotation } from './fixtures/atlm-revisions.mjs';
import { atlmAssessment, call, context, mcp, OWNER, taskV4 } from './fixtures/tracker-db.mjs';

const site = fileURLToPath(new URL('..', import.meta.url));
const workerPath = process.env.SITE_WORKER_MODULE || join(site, 'dist/server/index.js');
const partBytes = 49_152;
const maxBase64Chars = 65_536;
const maxPasses = 64;
const incumbentId = 'flow-incumbent';
const completedPlanCount = 12;
const snapshotTool = 'CreateTrainingSnapshot';
const revisionsTool = 'ListModelRevisions';
const modelTool = 'RegisterModelRevision';

function cli(script, args) {
  const result = spawnSync(process.execPath, ['scripts/' + script, ...args], { cwd: site, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function transfer(command, args) {
  return cli('atlm-transfer.mjs', [command, ...Object.entries(args).flatMap(([key, value]) => ['--' + key, String(value)])]);
}

async function rpc(c, name, args) {
  const response = await mcp(c, name, args);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  assert.ok(response.value.result?.structuredContent, name);
  return response.value.result;
}

async function tool(c, name, args) {
  const result = await rpc(c, name, args);
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  return result.structuredContent;
}

const revision = (c, name, args) => tool(c, name, { schemaVersion: 1, ...args });
const write = (c, name, payload, expectedVersion) => tool(c, name, {
  schemaVersion: 1, commandId: crypto.randomUUID(), payload,
  ...(expectedVersion === undefined ? {} : { expectedVersion }),
});

async function plan(c, label, task = taskV4(), large = false) {
  const planId = crypto.randomUUID();
  const note = large ? 'Подтверждение реализации. '.repeat(650) : 'Подтверждение реализации.';
  await write(c, 'CreatePlan', {
    planId, title: label, planText: `# ${label}\n\n## Этап 1. Проверка\n${note}`,
    planCreatedAt: { precision: 'dateOnly', on: '2027-01-01', timeZone: 'UTC' },
  });
  const assessment = await atlmAssessment(c, planId, task, { predictionRequest: { method: 'ATLM', methodVersion: 1 } });
  await write(c, 'SaveTaskAssessment', assessment, 0);
  return planId;
}

async function completed(c, label, actualMs, task, large = false) {
  const planId = await plan(c, label, task, large);
  const step = (await tool(c, 'GetPlanProgress', { planId })).steps[0];
  const start = await write(c, 'StartPlan', { planId }, 0);
  c.advance(actualMs);
  await write(c, 'SetStepStatus', { stepId: step.step_id, status: 'DONE' }, step.version);
  await write(c, 'FinishPlan', { planId }, 1);
  const completed = { planId, actualMs, capturedAt: start.result.firstStartedAt, sourceAvailableAt: c.now() };
  c.advance(1);
  return completed;
}

async function seedIncumbent(c, sources) {
  const db = c.db.sqlite;
  const features = normalizeAgentTask(taskV4()).features;
  const examples = sources.map((source, index) => ({ ...source, sampleId: `incumbent-${index}`, features }));
  const fitted = await fitAtlm(examples);
  assert.equal(fitted.status, 'AVAILABLE');
  const artifact = fitted.artifact;
  db.prepare(`INSERT INTO estimation_model_revisions(owner_id,model_revision_id,model_version,origin,
    method_version,feature_version,registered_at,imported_at,artifact_json,manifest_json,dataset_digest,
    provenance_json,fit_count,source_count,train_cutoff,supported)
    VALUES(?,?,1,'IMPORTED',?,?,?,?,?,?,?,'{}',?,?,?,1)`)
    .run(OWNER, incumbentId, artifact.method.version, artifact.featureSchemaVersion, c.now(), c.now(),
      JSON.stringify(artifact), JSON.stringify(artifact.manifest), artifact.datasetDigest, artifact.n, sources.length, artifact.trainCutoff);
  const source = db.prepare(`INSERT INTO estimation_model_revision_sources(owner_id,model_revision_id,plan_id,source_generation,ordinal)
    VALUES(?,?,?,(SELECT generation FROM estimation_jobs WHERE owner_id=? AND job_key='refresh:'||?),?)`);
  for (const [index, { planId }] of sources.entries()) source.run(OWNER, incumbentId, planId, OWNER, planId, index);
  db.prepare(`INSERT INTO estimation_model_activations(owner_id,activation_version,model_revision_id,activated_at,reason,decision)
    VALUES(?,1,?,?,'Independent fixture incumbent','IMPORTED')`).run(OWNER, incumbentId, c.now());
  db.prepare('INSERT INTO estimation_active_revisions VALUES(?,?,1)').run(OWNER, incumbentId);
}

function checkPart(contentBase64, byteLength) {
  assert.equal(typeof contentBase64, 'string');
  assert.ok(contentBase64.length <= maxBase64Chars);
  const bytes = Buffer.from(contentBase64, 'base64');
  assert.equal(bytes.length, byteLength);
  assert.equal(bytes.toString('base64'), contentBase64);
}

async function download(c, name, selector, path, { expectMaterializing = false } = {}) {
  let response;
  for (let pass = 0; pass < maxPasses; pass++) {
    response = await revision(c, name, { ...selector, view: 'download' });
    if (pass === 0 && expectMaterializing) {
      assert.equal(response.state, 'MATERIALIZING');
      const premature = await rpc(c, name, { schemaVersion: 1, ...selector, view: 'filePart', partIndex: 0 });
      assert.equal(premature.isError, true);
      assert.equal(premature.structuredContent.code, 'FILE_NOT_READY');
    }
    if (response.state === 'READY') break;
    assert.equal(response.state, 'MATERIALIZING');
    assert.ok(response.retryAfterMs >= 0);
  }
  assert.equal(response.state, 'READY');
  const { file } = response;
  assert.equal(file.partSize, partBytes);
  assert.equal(file.encoding, 'base64');
  const partial = path + '.partial';
  for (let partIndex = 0; partIndex < file.partCount; partIndex++) {
    const response = await rpc(c, name, { schemaVersion: 1, ...selector, view: 'filePart', partIndex });
    assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
    const data = response.structuredContent;
    assert.equal(data.fileSha256, file.sha256);
    assert.equal(data.partIndex, partIndex);
    assert.ok(response.content[0].text.length < 512);
    assert.equal(response.content[0].text.includes('contentBase64'), false);
    checkPart(data.contentBase64, Math.min(partBytes, file.byteLength - partIndex * partBytes));
    transfer('write-part', { file: partial, 'part-index': partIndex, 'content-base64': data.contentBase64 });
  }
  assert.equal(transfer('verify', { file: partial, sha256: file.sha256, 'byte-length': file.byteLength }).verified, true);
  await rename(partial, path);
  return file;
}

async function upload(c, name, binding, path) {
  const file = transfer('manifest', { file: path });
  const args = { ...binding, commandId: crypto.randomUUID(), file: { sha256: file.sha256, byteLength: file.byteLength } };
  const prepare = () => revision(c, name, { ...args, phase: 'prepare' });
  const prepared = await prepare();
  assert.equal(prepared.state, 'UPLOADING');
  assert.deepEqual(prepared.receivedPartRanges, []);
  for (let partIndex = 0; partIndex < file.partCount; partIndex++) {
    const part = transfer('read-part', { file: path, 'part-index': partIndex });
    assert.equal(part.partIndex, partIndex);
    assert.equal(part.byteLength, Math.min(partBytes, file.byteLength - partIndex * partBytes));
    checkPart(part.contentBase64, part.byteLength);
    await revision(c, name, { ...args, phase: 'putPart', partIndex, contentBase64: part.contentBase64 });
    if (partIndex === 0) assert.deepEqual((await prepare()).receivedPartRanges, [{ start: 0, end: 0 }]);
  }
  return { schemaVersion: 1, ...args, phase: 'commit' };
}

async function commit(c, name, args) {
  for (let attempt = 0; attempt < maxPasses; attempt++) {
    const result = await rpc(c, name, args);
    if (result.structuredContent.state !== 'VALIDATING') return result;
  }
  assert.fail(name + ' did not settle its validation');
}

async function assertFinalUploadReplay(c, name, args, path, result) {
  const expected = { ...result, replayed: true };
  assert.deepEqual(await revision(c, name, { ...args, phase: 'prepare' }), expected);
  const { partIndex, contentBase64 } = transfer('read-part', { file: path, 'part-index': 0 });
  assert.deepEqual(await revision(c, name, { ...args, phase: 'putPart', partIndex, contentBase64 }), expected);
}

const savedForecast = async (c, planId) => (await tool(c, 'GetSavedEstimate', { planId })).serverEstimation;
const modelList = c => revision(c, revisionsTool, { view: 'list' });

async function activate(c, modelRevisionId, expectedActiveModelRevisionId, expectedActivationVersion, reason) {
  return revision(c, 'ActivateModelRevision', {
    commandId: crypto.randomUUID(), modelRevisionId, expectedActiveModelRevisionId, expectedActivationVersion,
    reason, acceptExperimental: true,
  });
}

test('built MCP transfers a frozen dataset through the local CLI, registers, activates, and rolls back a model', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atlm-agent-flow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const c = context();
  t.after(c.close);
  const built = await import(pathToFileURL(resolve(workerPath)).href + '?atlm-agent-flow');
  const worker = built.createWorker(c.now);
  c.worker = { async fetch(request, env) {
    const pending = [];
    const response = await worker.fetch(request, env, { waitUntil(task) { pending.push(task); } });
    await Promise.all(pending);
    return response;
  } };

  const baselineTask = taskV4();
  const incumbentSources = [
    await completed(c, 'Initial source one', 14_000, baselineTask),
    await completed(c, 'Initial source two', 14_200, baselineTask),
  ];
  assert.deepEqual((await modelList(c)).rows, []);
  await seedIncumbent(c, incumbentSources);
  const oldPlanId = await plan(c, 'Estimate before training');
  await write(c, 'StartPlan', { planId: oldPlanId }, 0);
  const original = await savedForecast(c, oldPlanId);
  assert.equal(original.modelRevisionId, incumbentId);
  assert.equal(original.status, 'AVAILABLE');

  const actualByPlan = new Map(incumbentSources.map((recorded, index) => [recorded.planId,
    { recorded, task: baselineTask, group: 'incumbent-source-' + index }]));
  for (let index = 0; index < completedPlanCount; index++) {
    const task = taskV4();
    task.reuseLevel = index % 4;
    const recorded = await completed(c, 'Completed case ' + index, 10_000 + task.reuseLevel * 2000 + index, task, true);
    actualByPlan.set(recorded.planId, { recorded, task, group: 'group-' + index });
  }
  assert.equal((await modelList(c)).rows.length, 1);
  const commandId = crypto.randomUUID();
  const snapshot = await revision(c, snapshotTool, { mode: 'create', commandId });
  assert.equal(snapshot.snapshotId, commandId);
  assert.equal(snapshot.counts.total, completedPlanCount + incumbentSources.length + 1);
  const snapshotPath = join(directory, 'snapshot.json');
  await download(c, snapshotTool, { mode: 'read', snapshotId: snapshot.snapshotId }, snapshotPath, { expectMaterializing: true });
  const source = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const rows = source.rows.map(row => {
    const actual = actualByPlan.get(row.planId);
    if (!actual) return { rowId: row.rowId, groupId: null, eligibility: 'EXCLUDED', reasons: ['OUTSIDE_FIXTURE_COHORT'], annotation: null };
    assert.equal(row.source.actualMs, actual.recorded.actualMs);
    const annotation = teacherAnnotation(row.rowId, actual.group);
    annotation.annotation.agentTask = actual.task;
    return annotation;
  });
  const annotationsPath = join(directory, 'annotations.json');
  await writeFile(annotationsPath, JSON.stringify({ schemaVersion: 1, contract: 'atlm-teacher-annotations',
    snapshotId: snapshot.snapshotId, parentDatasetRevisionId: null, rows }));
  const saveArgs = await upload(c, 'SaveDatasetRevision', { snapshotId: snapshot.snapshotId }, annotationsPath);
  const saved = await commit(c, 'SaveDatasetRevision', saveArgs);
  assert.equal(saved.isError, undefined, JSON.stringify(saved.structuredContent));
  const { datasetRevisionId, datasetDigest } = saved.structuredContent;
  assert.equal(datasetRevisionId, saveArgs.commandId);
  await assertFinalUploadReplay(c, 'SaveDatasetRevision', saveArgs, annotationsPath, saved.structuredContent);
  const datasetPath = join(directory, 'dataset.json');
  const datasetFile = await download(c, 'GetDatasetRevision', { datasetRevisionId }, datasetPath);
  assert.equal(datasetFile.sha256, datasetDigest);

  const recipePath = join(directory, 'recipe.json');
  await writeFile(recipePath, JSON.stringify({ schemaVersion: 1, recipeId: 'atlm-teacher-hybrid-v1',
    datasetRevisionId, datasetDigest, selection: { mode: 'ALL_ELIGIBLE' }, holdoutUse: 'UNKNOWN',
    holdoutUseNote: 'No prior evaluation history was supplied for this synthetic run.' }));
  const result = cli('train-atlm.mjs', ['--dataset', datasetPath, '--recipe', recipePath, '--out', join(directory, 'fit')]);
  assert.equal(result.status, 'READY');
  const bundle = JSON.parse(await readFile(result.registrationPath, 'utf8'));
  const unsupportedPath = join(directory, 'unsupported-bundle.json');
  await writeFile(unsupportedPath, JSON.stringify({ ...bundle, schemaVersion: bundle.schemaVersion + 1 }));
  const unsupportedArgs = await upload(c, modelTool, { datasetRevisionId }, unsupportedPath);
  const unsupported = await commit(c, modelTool, unsupportedArgs);
  assert.equal(unsupported.isError, true);
  assert.equal(unsupported.structuredContent.code, 'INVALID_ARTIFACT');
  assert.equal(unsupported.structuredContent.details.reason, 'INVALID_BUNDLE_ARTIFACT');
  assert.equal((await tool(c, 'GetCommandResult', { commandId: unsupportedArgs.commandId })).status, 'PENDING');
  const modelArgs = await upload(c, modelTool, { datasetRevisionId }, result.registrationPath);

  const interrupted = { ...c, worker: { async fetch(request, env) {
    const response = await c.worker.fetch(request, env);
    const { result: { structuredContent } } = await response.clone().json();
    if (structuredContent.state === 'REGISTERED') {
      assert.equal(structuredContent.replayed, false);
      await response.body.cancel();
      throw new Error('Registration response was lost after commit');
    }
    return response;
  } } };
  await assert.rejects(commit(interrupted, modelTool, modelArgs), /response was lost/);
  const receipt = await tool(c, 'GetCommandResult', { commandId: modelArgs.commandId });
  assert.equal(receipt.status, 'FINAL');
  assert.equal(receipt.result.modelRevisionId, modelArgs.commandId);
  const replay = await commit(c, modelTool, modelArgs);
  assert.deepEqual(replay.structuredContent, { ...receipt.result, replayed: true });
  await assertFinalUploadReplay(c, modelTool, modelArgs, result.registrationPath, receipt.result);
  const modelRevisionId = replay.structuredContent.modelRevisionId;
  const registered = await modelList(c);
  assert.equal(registered.activeModelRevisionId, incumbentId);
  assert.equal(registered.servingModelRevisionId, incumbentId);
  assert.equal(registered.activationVersion, 1);
  assert.equal(registered.rows.filter(row => row.modelRevisionId === modelRevisionId).length, 1);
  const detail = await revision(c, revisionsTool, { view: 'detail', modelRevisionId });
  const issuedReport = detail.evidence.find(row => row.kind === 'ISSUED_FORECASTS' && row.source === 'evaluation');
  const evidenceQuery = new URLSearchParams({ source: 'evaluation', evidenceId: issuedReport.evidenceId });
  const evidencePage = await call(c, `/api/tracker/model-revisions/${modelRevisionId}/evidence/cases?${evidenceQuery}`);
  assert.equal(evidencePage.status, 200);
  assert.equal(evidencePage.value.modelRevisionId, modelRevisionId);
  const issuedCases = new Map(evidencePage.value.cases.map(row => [row.planId, row]));
  assert.equal(issuedCases.size, actualByPlan.size);
  for (const row of source.rows.filter(item => actualByPlan.has(item.planId))) {
    const forecast = row.source.issuedPrediction;
    const issuedCase = issuedCases.get(row.planId);
    assert.equal(issuedCase.modelRevisionId, forecast?.modelRevisionId ?? null);
    assert.equal(issuedCase.method, forecast?.method?.id ?? null);
    assert.equal(issuedCase.pointMs, forecast?.pointMs ?? null);
  }
  assert.equal(issuedCases.get(incumbentSources[0].planId).pointMs, null);
  assert.equal(issuedCases.get(incumbentSources[1].planId).method, 'historical-median');
  assert.equal([...issuedCases.values()].filter(row => row.modelRevisionId === incumbentId).length, completedPlanCount);
  assert.equal(detail.evidence.find(row => row.source === 'issued').summary.rowCount, 0);
  const registeredPath = join(directory, 'registered.json');
  assert.equal((await download(c, revisionsTool, { modelRevisionId, fileKind: 'BUNDLE' }, registeredPath)).sha256, modelArgs.file.sha256);

  const planned = await plan(c, 'New estimate after activation');
  assert.equal((await savedForecast(c, planned)).modelRevisionId, incumbentId);
  c.advance(1);
  const activation = await activate(c, modelRevisionId, incumbentId, 1, 'Accept the synthetic local run');
  assert.equal(activation.activeModelRevisionId, modelRevisionId);
  assert.equal(activation.activationVersion, 2);
  await write(c, 'StartPlan', { planId: planned }, 0);
  const issued = await savedForecast(c, planned);
  assert.equal(issued.status, 'AVAILABLE');
  assert.equal(issued.modelRevisionId, modelRevisionId);
  assert.notEqual(issued.pointMs, original.pointMs);
  assert.deepEqual(await savedForecast(c, oldPlanId), original);

  const archivedPath = join(directory, 'archived-incumbent.json');
  await download(c, revisionsTool, { modelRevisionId: incumbentId, fileKind: 'BUNDLE' }, archivedPath);
  const archived = JSON.parse(await readFile(archivedPath, 'utf8'));
  assert.equal(archived.contract, 'atlm-model-archive-v1');
  assert.equal(archived.datasetRevisionId, null);
  const incompleteImport = await upload(c, modelTool, { datasetRevisionId }, archivedPath);
  const refusal = await commit(c, modelTool, incompleteImport);
  assert.equal(refusal.isError, true);
  assert.equal(refusal.structuredContent.code, 'INVALID_ARTIFACT');
  const afterRefusal = await modelList(c);
  assert.equal(afterRefusal.rows.length, 2);
  assert.equal(afterRefusal.servingModelRevisionId, modelRevisionId);
  assert.equal(afterRefusal.activationVersion, 2);

  c.advance(1);
  const rollback = await activate(c, incumbentId, modelRevisionId, 2, 'Restore the previous revision');
  assert.equal(rollback.activeModelRevisionId, incumbentId);
  assert.equal(rollback.activationVersion, 3);
  const fresh = await plan(c, 'New estimate after rollback');
  assert.equal((await savedForecast(c, fresh)).modelRevisionId, incumbentId);
  assert.deepEqual(await savedForecast(c, planned), issued);
  assert.deepEqual(await savedForecast(c, oldPlanId), original);
  const events = await revision(c, revisionsTool, { view: 'activations' });
  assert.deepEqual(events.rows.map(row => [row.from, row.to, row.activationVersion]), [
    [modelRevisionId, incumbentId, 3], [incumbentId, modelRevisionId, 2], [null, incumbentId, 1],
  ]);
});
