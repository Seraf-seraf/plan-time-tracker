#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateAtlmChronologically } from "../worker/index.js";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

export async function evaluate(input) {
  if (!input || input.formatVersion !== 1 || !["SYNTHETIC", "OWNER_EXPORT"].includes(input.sourceAuthority)
    || !Array.isArray(input.rows)) throw new Error("Ожидается formatVersion=1, sourceAuthority=SYNTHETIC/OWNER_EXPORT и rows.");
  if (input.nextCursor != null) throw new Error("Сначала соберите все страницы одного datasetRevision; неполный экспорт нельзя оценивать.");
  if (input.excluded !== undefined && (!Array.isArray(input.excluded) || input.excluded.length > 5000)) throw new Error("Некорректные исключённые источники.");
  const options = { protocolVersion: 1 };
  if (input.asOf !== undefined) options.cutoff = input.asOf;
  const result = await evaluateAtlmChronologically(input.rows, options);
  if (result.status !== "AVAILABLE") throw new Error(`Оценка недоступна: ${result.reason}`);
  return { ...result, sourceAuthority: input.sourceAuthority, sourceExcludedCount: input.excluded?.length || 0 };
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
