#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ATLM_PART_BYTES } from '../worker/atlm/revision-files.js';

const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const maxEncodedPart = Math.ceil(ATLM_PART_BYTES / 3) * 4;
const usage = `Usage:
  manifest --file PATH
  read-part --file PATH --part-index N
  write-part --file PATH.partial --part-index N --content-base64 VALUE
  verify --file PATH --sha256 VALUE --byte-length N`;

async function manifest(file) {
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const bytes of createReadStream(file, { highWaterMark: ATLM_PART_BYTES })) {
    byteLength += bytes.length;
    hash.update(bytes);
  }
  return {
    sha256: 'sha256:' + hash.digest('hex'), byteLength, partSize: ATLM_PART_BYTES,
    partCount: Math.ceil(byteLength / ATLM_PART_BYTES), mediaType: 'application/json', encoding: 'base64',
  };
}

function nonnegativeInteger(text) {
  const number = Number(text);
  if (!/^(0|[1-9]\d*)$/.test(text ?? '') || !Number.isSafeInteger(number)) {
    throw new Error('Expected a nonnegative integer.');
  }
  return number;
}

function partLocation(text) {
  const partIndex = nonnegativeInteger(text);
  const offset = partIndex * ATLM_PART_BYTES;
  if (!Number.isSafeInteger(offset + ATLM_PART_BYTES)) throw new Error('Part position is too large.');
  return { partIndex, offset };
}

async function readPart(file, indexText) {
  const { partIndex, offset } = partLocation(indexText);
  const fd = await open(file, 'r');
  try {
    const { size } = await fd.stat();
    if (offset >= size) throw new Error('Part position is outside the file.');
    const byteLength = Math.min(ATLM_PART_BYTES, size - offset);
    const bytes = Buffer.alloc(byteLength);
    for (let read = 0; read < byteLength;) {
      const { bytesRead } = await fd.read(bytes, read, byteLength - read, offset + read);
      if (!bytesRead) throw new Error('File length changed while reading a part.');
      read += bytesRead;
    }
    return { partIndex, byteLength, contentBase64: bytes.toString('base64') };
  } finally { await fd.close(); }
}

function decodePart(contentBase64) {
  if (!contentBase64 || contentBase64.length > maxEncodedPart) throw new Error('Base64 part has invalid length.');
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.length < 1 || bytes.length > ATLM_PART_BYTES || bytes.toString('base64') !== contentBase64) {
    throw new Error('Part must be complete canonical base64.');
  }
  return bytes;
}

async function openPartial(file) {
  try { return await open(file, 'wx+', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return open(file, 'r+');
  }
}

async function writePart(file, indexText, contentBase64) {
  if (!file.endsWith('.partial')) throw new Error('Write to a .partial file until checksum verification succeeds.');
  const { partIndex, offset } = partLocation(indexText);
  const bytes = decodePart(contentBase64);
  const fd = await openPartial(file);
  try {
    for (let written = 0; written < bytes.length;) {
      const { bytesWritten } = await fd.write(bytes, written, bytes.length - written, offset + written);
      if (!bytesWritten) throw new Error('Could not write the complete part.');
      written += bytesWritten;
    }
    return { partIndex, byteLength: bytes.length };
  } finally { await fd.close(); }
}

async function verify(file, sha256, lengthText) {
  if (!sha256Pattern.test(sha256 ?? '')) throw new Error('Expected a SHA-256 digest with the sha256: prefix.');
  const byteLength = nonnegativeInteger(lengthText);
  const actual = await manifest(file);
  if (actual.byteLength !== byteLength) throw new Error('File byte length does not match the manifest.');
  if (actual.sha256 !== sha256) throw new Error('File SHA-256 does not match the manifest.');
  return { verified: true, sha256, byteLength };
}

async function main([command, ...argv]) {
  const optionsByCommand = {
    manifest: ['file'], 'read-part': ['file', 'part-index'],
    'write-part': ['file', 'part-index', 'content-base64'], verify: ['file', 'sha256', 'byte-length'],
  };
  if (!Object.hasOwn(optionsByCommand, command)) throw new Error(usage);
  const options = Object.fromEntries(optionsByCommand[command].map(name => [name, { type: 'string' }]));
  const { values } = parseArgs({ args: argv, options });
  if (optionsByCommand[command].some(name => !values[name])) throw new Error(usage);
  const { file } = values;
  if (command === 'manifest') return manifest(file);
  if (command === 'read-part') return readPart(file, values['part-index']);
  if (command === 'write-part') return writePart(file, values['part-index'], values['content-base64']);
  return verify(file, values.sha256, values['byte-length']);
}

try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
catch (error) {
  console.error(error.code?.startsWith('ERR_PARSE_ARGS') ? usage : error.message);
  process.exitCode = 1;
}
