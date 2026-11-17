#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateHybridAtlmChronologically } from "../worker/index.js";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

export async function evaluate(input) {
  if (!input || input.formatVersion !== 3 || !["SYNTHETIC", "OWNER_EXPORT"].includes(input.sourceAuthority)
    || !Array.isArray(input.rows) || input.nextCursor !== null
    || !Number.isSafeInteger(input.datasetRevision) || input.datasetRevision < 0
    || !Number.isSafeInteger(input.asOf) || input.asOf < 0
    || !Number.isSafeInteger(input.throughSequence) || input.throughSequence < 0
    || input.rows.some((row, i) => Number(row.sampleId) > input.throughSequence || row.observedAt > input.asOf
      || (i > 0 && Number(row.sampleId) <= Number(input.rows[i - 1].sampleId)))
    || Number(input.rows.at(-1)?.sampleId ?? 0) !== input.throughSequence) {
    throw new Error("Нужен полный упорядоченный журнал версии 3 с одним datasetRevision/asOf и nextCursor=null.");
  }
  const report = await evaluateHybridAtlmChronologically(input.rows, { cutoff: input.asOf });
  if (report.status !== "AVAILABLE") throw new Error(`Оценка недоступна: ${report.reason}`);
  return { ...report, sourceAuthority: input.sourceAuthority, datasetRevision: input.datasetRevision, throughSequence: input.throughSequence };
}

async function main(args) {
  if (args.length !== 1 || !args[0]) throw new Error("Использование: node scripts/evaluate-atlm.mjs <dataset.json>.");
  const inputPath = path.resolve(args[0]);
  if (statSync(inputPath).size > MAX_INPUT_BYTES) throw new Error("JSON превышает 8 МиБ.");
  const bytes = readFileSync(inputPath);
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error("JSON превышает 8 МиБ.");
  let input;
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Файл должен содержать корректный UTF-8 JSON."); }
  process.stdout.write(`${JSON.stringify(await evaluate(input))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`Ошибка оценки ATLM: ${error.message}\n`); process.exitCode = 1; }
}
