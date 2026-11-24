#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  ATLM_INTERNAL_REPLAY,
  ATLM_MAX_ROWS,
  ATLM_METHOD,
  atlmFitCandidates,
  atlmReconstructResidual,
  atlmReplayPolicyCase,
  fitAtlmResidualQuantiles,
  fitHybridAtlm,
  selectAtlmIntervalEngine,
  selectHybridEngine,
} from '../worker/atlm/model.js';
import {
  ATLM_TEACHER_CODE_PATHS,
  ATLM_TEACHER_PROTOCOL_V2,
  atlmTeacherFitOnlyProtocol,
  atlmTeacherCase,
  atlmTeacherFitReference,
  atlmTeacherHoldoutCase,
  atlmTeacherIssuedCase,
  atlmTeacherPlannedExclusion,
  atlmTeacherProtocolVersion,
  atlmTeacherRollingCase,
  atlmTeacherRollingHistory,
  buildAtlmTeacherSplit,
  parseAtlmTeacherRecipe,
  readAtlmTeacherDataset,
  summarizeAtlmTeacherMode,
} from '../worker/atlm/teacher-dataset.js';
import { appError, canonical, hashCommandInput } from '../worker/shared/index.js';

const REQUIRED_NODE_MAJOR = '24';
const REGISTRATION_MAX_BYTES = 16 * 1024 * 1024;
const BASE_OUTPUT_FILES = ['evaluation.json', 'manifest.json'];
const CANDIDATE_OUTPUT_FILES = ['artifact.json', 'registration.bundle.json'];

function progress(stage, details) {
  process.stderr.write(JSON.stringify({ stage, ...details }) + '\n');
}

function sha256(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

function jsonFile(value) {
  return Buffer.from(JSON.stringify(value) + '\n', 'utf8');
}

function decodeJson(bytes, code) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw appError(code, 'Expected a valid UTF-8 JSON document.');
  }
}

function commandPaths(args) {
  const { values, tokens } = parseArgs({
    args,
    options: {
      dataset: { type: 'string' },
      recipe: { type: 'string' },
      out: { type: 'string' },
    },
    tokens: true,
  });
  if (tokens.length !== 3 || !values.dataset || !values.recipe || !values.out) {
    throw appError('INVALID_ARGUMENTS',
      'Usage: node scripts/train-atlm.mjs --dataset PATH --recipe PATH --out PATH');
  }
  return {
    datasetPath: path.resolve(values.dataset),
    recipePath: path.resolve(values.recipe),
    outputDir: path.resolve(values.out),
  };
}

async function codeReference() {
  const files = await Promise.all(ATLM_TEACHER_CODE_PATHS.map(async (relativePath) => ({
    path: relativePath,
    sha256: sha256(await readFile(new URL('../' + relativePath, import.meta.url))),
  })));
  return { digest: 'sha256:' + (await hashCommandInput(files)), files };
}

async function replayDevelopment(fitRows, historyFor, baseCache, policyCache) {
  const cases = [];
  for (const target of fitRows) {
    const replay = await atlmReplayPolicyCase(target, historyFor, baseCache, policyCache);
    if (replay.status === 'UNAVAILABLE') {
      throw appError(replay.reason, 'Development replay could not construct a valid case.');
    }
    cases.push(replay);
  }
  return { baseCases: fitRows.map((row) => baseCache[row.sampleId]), cases };
}

async function fitDevelopment(fitRows, fitReference, historyFor, replay) {
  const candidates = await atlmFitCandidates(fitRows);
  const selection = selectHybridEngine(candidates, replay.baseCases);
  if (selection.status === 'UNAVAILABLE') {
    return { fit: selection, calibration: null };
  }
  const residuals = [];
  if (selection.selectedEngine !== 'MEDIAN' && candidates.bayesian.status === 'AVAILABLE') {
    for (const [index, target] of fitRows.entries()) {
      if (replay.baseCases[index].bayesian.status !== 'AVAILABLE') continue;
      const residual = await atlmReconstructResidual(target, historyFor(target));
      if (residual) residuals.push(residual);
    }
  }
  const quantiles = await fitAtlmResidualQuantiles(residuals);
  const intervalCases = replay.cases
    .filter((item) => item.prediction.status === 'AVAILABLE')
    .map((item) => ({
      planId: item.planId,
      capturedAt: item.capturedAt,
      actualMs: item.actualMs,
      pointMs: item.prediction.pointMs,
      intervals: item.intervalCandidates,
    }));
  const intervalSelection = selectAtlmIntervalEngine({
    BAYESIAN_PREDICTIVE: candidates.bayesian,
    BAYES_QUANTILE: quantiles,
  }, intervalCases);
  const fit = await fitHybridAtlm(fitRows, {
    candidates,
    selection,
    cutoff: fitReference.trainCutoff,
    intervalSelection,
    residualQuantiles: quantiles.artifact ?? null,
    calibrationHistory: historyFor,
    calibrationProof: Object.fromEntries(residuals.map((item) => [item.planId, item])),
    replayAuthority: ATLM_INTERNAL_REPLAY,
  });
  return {
    fit,
    calibration: { sampleCount: residuals.length, status: quantiles.status, reason: quantiles.reason ?? null },
  };
}

function replayCaseArguments(item) {
  return {
    prediction: item.prediction,
    trainRowCount: item.trainSampleCount,
    trainDigest: item.trainDatasetDigest,
    medianPointMs: item.median.pointMs,
    fallbackReason: item.prediction.pointEngine === 'MEDIAN'
      ? (item.decision.selectedEngine === 'MEDIAN' ? item.decision.reason : item.atlm.reason)
      : item.prediction.hybrid?.fallbackReason ?? null,
  };
}

async function replayPlanned(targets, rowsById, historyFor, replay, baseCache, policyCache) {
  const cases = [];
  for (const [index, target] of targets.entries()) {
    const row = rowsById.get(target.sampleId);
    const features = row.source.plannedFeatures;
    let item = replay.cases[index];
    if (!atlmTeacherPlannedExclusion(row.source) && canonical(features) !== canonical(target.features)) {
      item = await atlmReplayPolicyCase(target, historyFor, baseCache, policyCache, undefined, undefined, features);
      if (item.status === 'UNAVAILABLE') {
        throw appError(item.reason, 'Planned replay could not construct a valid case.');
      }
    }
    cases.push(atlmTeacherRollingCase(row, 'PLANNED', replayCaseArguments(item)));
  }
  return cases;
}

function assertFitRoster(artifact, fitReference, trainCutoff) {
  if (artifact && (artifact.datasetDigest !== fitReference.trainDigest
    || canonical(artifact.manifest) !== canonical(fitReference.manifest)
    || artifact.trainCutoff !== trainCutoff)) {
    throw appError('FIT_ROSTER_MISMATCH', 'The artifact differs from the frozen fit roster.');
  }
}

async function trainFitOnly(fitRows, protocol, recipe, input, codeRef) {
  const { split, rowDecisions, selectedRowIds, fitRowIds, trainCutoff } = protocol;
  const { protocolVersion } = split;
  progress('ROSTER', { selectedCount: selectedRowIds.length, fitCount: fitRows.length });
  const fitReference = await atlmTeacherFitReference(fitRows);
  progress('FIT', { sampleCount: fitRows.length });
  const fit = await fitHybridAtlm(fitRows, { cutoff: trainCutoff });
  assertFitRoster(fit.artifact, fitReference, trainCutoff);
  const evaluation = {
    schemaVersion: 1, protocolVersion,
    metric: 'PLAN_ACTIVE', unit: 'ms', split, modes: {}, rowDecisions,
  };
  const provenance = {
    trainerVersion: protocolVersion,
    codeRef,
    recipeDigest: 'sha256:' + (await hashCommandInput(recipe)),
    configuration: recipe,
    selectedRowIds,
    fitRowIds,
    trainCutoff,
  };
  return trainingOutput(input, fit, evaluation, provenance, null);
}

async function train(dataset, trainingRows, recipe, input, codeRef) {
  const protocol = buildAtlmTeacherSplit(dataset, trainingRows, recipe);
  const protocolVersion = atlmTeacherProtocolVersion(recipe);
  if (atlmTeacherFitOnlyProtocol(protocolVersion)) {
    return trainFitOnly(trainingRows, protocol, recipe, input, codeRef);
  }
  const fullFit = protocolVersion === ATLM_TEACHER_PROTOCOL_V2;
  const {
    split, rowDecisions, selectedRowIds, fitRowIds, holdoutRowIds = [], purgedRowIds = [], trainCutoff,
  } = protocol;
  const rowsById = new Map(dataset.rows.map((row) => [row.rowId, row]));
  const fitIds = new Set(fitRowIds);
  const fitRows = trainingRows.filter((row) => fitIds.has(row.sampleId));
  const fitReference = await atlmTeacherFitReference(fitRows);
  const holdoutRows = holdoutRowIds.map((rowId) => rowsById.get(rowId));
  progress(fullFit ? 'ROSTER' : 'SPLIT', fullFit ? {
    selectedCount: selectedRowIds.length, fitCount: fitRows.length,
  } : {
    selectedCount: selectedRowIds.length, fitCount: fitRows.length,
    holdoutCount: holdoutRows.length, purgedCount: purgedRowIds.length,
    holdoutReason: split.holdoutReason,
  });
  let replay = { baseCases: [], cases: [] };
  let plannedCases = [];
  let fitted = {
    fit: { status: 'UNAVAILABLE', reason: 'DATASET_LIMIT_REACHED', limit: ATLM_MAX_ROWS },
    calibration: null,
  };
  const overFitLimit = fitRows.length > ATLM_MAX_ROWS;
  if (!overFitLimit) {
    const historyFor = atlmTeacherRollingHistory(protocol, fitRows);
    const historyTimes = new Map(rowDecisions.map((row) => [row.rowId, row.historicalAvailableAt]));
    const targets = fullFit ? fitRows.map((row) => ({
      ...row, sourceAvailableAt: historyTimes.get(row.sampleId) ?? row.sourceAvailableAt,
    })) : fitRows;
    const baseCache = Object.create(null);
    const policyCache = Object.create(null);
    progress('REPLAY', { caseCount: fitRows.length });
    replay = await replayDevelopment(targets, historyFor, baseCache, policyCache);
    if (fullFit) plannedCases = await replayPlanned(targets, rowsById, historyFor, replay, baseCache, policyCache);
    progress('FIT', { sampleCount: fitRows.length });
    fitted = await fitDevelopment(fitRows, fitReference, historyFor, replay);
  }
  const { fit, calibration } = fitted;
  const artifact = fit.artifact ?? null;
  assertFitRoster(artifact, fitReference, trainCutoff);
  const holdoutReason = split.holdoutReason ?? (artifact ? null : fit.reason);
  const actualCase = (rowId, args) => {
    const row = rowsById.get(rowId);
    return fullFit
      ? atlmTeacherRollingCase(row, 'ACTUAL', args)
      : atlmTeacherCase(row, { ...args, featureBasis: 'ACTUAL' });
  };
  const rollingCases = overFitLimit
    ? fitRowIds.map((rowId) => actualCase(rowId, { prediction: fit }))
    : replay.cases.map((item) => actualCase(item.sampleId, replayCaseArguments(item)));
  if (fullFit && overFitLimit) {
    plannedCases = fitRowIds.map((rowId) =>
      atlmTeacherRollingCase(rowsById.get(rowId), 'PLANNED', { prediction: fit }));
  }
  const holdoutMode = (basis) => summarizeAtlmTeacherMode(
    holdoutRows.map((row) => atlmTeacherHoldoutCase(row, basis, artifact, fitReference, holdoutReason)),
    { reason: holdoutReason },
  );
  const evaluation = {
    schemaVersion: 1,
    protocolVersion,
    metric: 'PLAN_ACTIVE',
    unit: 'ms',
    split,
    modes: {
      ...(fullFit ? {
        ROLLING_PLAN_ACTUAL: summarizeAtlmTeacherMode(rollingCases, {
          includeGroups: false, reason: overFitLimit ? fit.reason : null,
        }),
        ROLLING_PLAN_PLANNED: summarizeAtlmTeacherMode(plannedCases, {
          includeGroups: false, reason: overFitLimit ? fit.reason : null,
        }),
      } : {
        ROLLING_GROUPED_ACTUAL: summarizeAtlmTeacherMode(rollingCases, {
          reason: overFitLimit ? fit.reason : null,
        }),
        INTERNAL_HOLDOUT_ACTUAL: holdoutMode('ACTUAL'),
        INTERNAL_HOLDOUT_PLANNED: holdoutMode('PLANNED'),
      }),
      ISSUED_FORECASTS: summarizeAtlmTeacherMode(
        selectedRowIds.map((rowId) => atlmTeacherIssuedCase(rowsById.get(rowId), { includeGroups: !fullFit })),
        { includeMedian: false, includeGroups: !fullFit },
      ),
    },
    rowDecisions,
  };
  const provenance = {
    trainerVersion: protocolVersion,
    codeRef,
    recipeDigest: fullFit ? 'sha256:' + (await hashCommandInput(recipe)) : input.recipeDigest,
    configuration: recipe,
    selectedRowIds,
    fitRowIds,
    trainCutoff,
    ...(fullFit
      ? { backtestUse: split.backtestUse, backtestUseNote: split.backtestUseNote }
      : { holdoutRowIds, purgedRowIds, holdoutCutoff: split.holdoutCutoff, groups: split.groups,
        holdoutUse: split.holdoutUse, holdoutUseNote: split.holdoutUseNote }),
  };
  return trainingOutput(input, fit, evaluation, provenance, calibration);
}

function trainingOutput(input, fit, evaluation, provenance, calibration) {
  const artifact = fit.artifact ?? null;
  const files = {
    'evaluation.json': jsonFile(evaluation),
    'manifest.json': jsonFile({
      schemaVersion: 1, datasetRevisionId: input.datasetRevisionId,
      datasetDigest: input.datasetDigest, provenance,
    }),
  };
  let reason = fit.reason ?? null;
  let registrationByteLength = null;
  if (artifact) {
    const registration = jsonFile({
      schemaVersion: 1,
      contract: 'atlm-model-revision',
      datasetRevisionId: input.datasetRevisionId,
      datasetDigest: input.datasetDigest,
      artifact,
      evaluation,
      provenance,
    });
    registrationByteLength = registration.byteLength;
    if (registrationByteLength <= REGISTRATION_MAX_BYTES) {
      files['artifact.json'] = jsonFile(artifact);
      files['registration.bundle.json'] = registration;
    } else {
      reason = 'REGISTRATION_BUNDLE_LIMIT_REACHED';
    }
  }
  const run = {
    schemaVersion: 1,
    input,
    status: reason === null ? 'READY' : 'UNAVAILABLE',
    reason,
    diagnostics: {
      pointSelection: fit.selection ?? null,
      candidates: fit.candidates ?? null,
      intervalSelection: artifact?.intervalSelection ?? null,
      calibration,
      fitLimit: fit.limit ?? null,
      registrationByteLength,
      registrationMaxBytes: REGISTRATION_MAX_BYTES,
    },
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])),
  };
  return { run, files };
}

function outputConflict() {
  return appError('OUTPUT_DIR_CONFLICT',
    'Output directory exists with different input, incomplete files, or invalid checksums.');
}

async function existingRun(outputDir, input) {
  const entry = await lstat(outputDir).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) return null;
  if (!entry.isDirectory()) throw outputConflict();
  const files = await readdir(outputDir, { withFileTypes: true });
  if (!files.some((file) => file.name === 'run.json') || !files.every((file) => file.isFile())) {
    throw outputConflict();
  }
  const run = decodeJson(await readFile(path.join(outputDir, 'run.json')), 'OUTPUT_DIR_CONFLICT');
  if (run?.schemaVersion !== 1 || canonical(run.input) !== canonical(input)
    || !['READY', 'UNAVAILABLE'].includes(run.status)
    || (run.status === 'READY' ? run.reason !== null : typeof run.reason !== 'string')) {
    throw outputConflict();
  }
  const expected = [...BASE_OUTPUT_FILES, ...(run.status === 'READY' ? CANDIDATE_OUTPUT_FILES : [])];
  if (files.length !== expected.length + 1
    || Object.keys(run.files ?? {}).length !== expected.length
    || expected.some((name) => !files.some((file) => file.name === name))) {
    throw outputConflict();
  }
  for (const name of expected) {
    if (sha256(await readFile(path.join(outputDir, name))) !== run.files[name]) throw outputConflict();
  }
  return run;
}

async function publishRun(outputDir, input, result) {
  await mkdir(path.dirname(outputDir), { recursive: true });
  const temporaryDir = await mkdtemp(path.join(path.dirname(outputDir), '.' + path.basename(outputDir) + '-'));
  try {
    for (const [name, bytes] of Object.entries(result.files)) {
      await writeFile(path.join(temporaryDir, name), bytes, { mode: 0o600 });
    }
    await writeFile(path.join(temporaryDir, 'run.json'), jsonFile(result.run), { mode: 0o600 });
    const published = await existingRun(outputDir, input);
    if (published) return published;
    try {
      await rename(temporaryDir, outputDir);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      const concurrent = await existingRun(outputDir, input);
      if (concurrent) return concurrent;
      throw error;
    }
    return result.run;
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function main(args) {
  let outputDir = null;
  try {
    const options = commandPaths(args);
    outputDir = options.outputDir;
    if (process.versions.node.split('.')[0] !== REQUIRED_NODE_MAJOR) {
      throw appError('UNSUPPORTED_NODE_VERSION', 'The local recipe requires Node.js 24.');
    }
    const [datasetBytes, recipeBytes, codeRef] = await Promise.all([
      readFile(options.datasetPath), readFile(options.recipePath), codeReference(),
    ]);
    const datasetDigest = sha256(datasetBytes);
    const value = decodeJson(datasetBytes, 'INVALID_DATASET_JSON');
    const recipe = parseAtlmTeacherRecipe(
      decodeJson(recipeBytes, 'INVALID_RECIPE_JSON'), value?.datasetRevisionId, datasetDigest,
    );
    const { dataset, trainingRows } = readAtlmTeacherDataset(value);
    const input = {
      datasetRevisionId: dataset.datasetRevisionId,
      datasetDigest,
      recipeId: recipe.recipeId,
      recipeDigest: sha256(recipeBytes),
      trainerVersion: atlmTeacherProtocolVersion(recipe),
      codeDigest: codeRef.digest,
      method: ATLM_METHOD,
      runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
    };
    let run = await existingRun(outputDir, input);
    if (run) {
      progress('REUSED', { status: run.status, reason: run.reason });
    } else {
      progress('VALIDATED', { rowCount: dataset.rows.length, eligibleCount: trainingRows.length });
      const result = await train(dataset, trainingRows, recipe, input, codeRef);
      const finalCode = await codeReference();
      if (finalCode.digest !== codeRef.digest) {
        throw appError('CODE_CHANGED_DURING_RUN', 'Numerical source files changed during training.');
      }
      run = await publishRun(outputDir, input, result);
      progress('SAVED', { status: run.status, reason: run.reason });
    }
    process.stdout.write(JSON.stringify({
      status: run.status,
      reason: run.reason,
      outputDir,
      registrationPath: run.status === 'READY' ? path.join(outputDir, 'registration.bundle.json') : null,
    }) + '\n');
    process.exitCode = run.status === 'READY' ? 0 : 2;
  } catch (error) {
    const reason = error.code ?? 'TRAINING_EXECUTION_FAILED';
    progress('ERROR', { code: reason, message: error.message, ...error.details });
    process.stdout.write(JSON.stringify({
      status: 'ERROR', reason, outputDir, registrationPath: null,
    }) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
