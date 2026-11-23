import { appError, dbAll, dbFirst } from '../shared/index.js';

export const ATLM_PART_BYTES = 49_152;
export const ATLM_MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
export const ATLM_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const ATLM_MAX_EXPIRED_DRAFTS = 10;
const ATLM_PARTS_PER_PASS = 8;
const ATLM_UPLOAD_READ_PARTS_PER_PAGE = 32;
const ATLM_EXPORT_CHUNKS_PER_PASS = 64;
const ATLM_RETRY_AFTER_MS = 50;
const ATLM_PART_BASE64_CHARS = Math.ceil(ATLM_PART_BYTES / 3) * 4;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const JSON_MEDIA_TYPE = 'application/json';
const UPLOAD_KINDS = new Set(['ANNOTATIONS', 'BUNDLE']);
const EXPORT_KINDS = new Set(['SNAPSHOT', 'DATASET', 'BUNDLE', 'ARTIFACT']);
const encodeUtf8 = new TextEncoder();

// Full protocol parts align with SHA-256 blocks. Resumption stores only the
// chaining words and hashes the incomplete final block when the file ends.
const SHA_BLOCK_BYTES = 64;
const SHA_INITIAL_WORDS = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const SHA_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotateRight = (value, bits) => (value >>> bits) | (value << (32 - bits));

class ResumableSha256 {
  constructor(words = SHA_INITIAL_WORDS) {
    this.words = new Uint32Array(words);
    this.schedule = new Uint32Array(SHA_ROUND_CONSTANTS.length);
  }

  blocks(bytes) {
    const end = bytes.length - bytes.length % SHA_BLOCK_BYTES;
    const view = new DataView(bytes.buffer, bytes.byteOffset, end);
    for (let offset = 0; offset < end; offset += SHA_BLOCK_BYTES) {
      const w = this.schedule;
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < SHA_ROUND_CONSTANTS.length; i++) {
        const x = w[i - 15], y = w[i - 2];
        const first = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
        const second = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
        w[i] = w[i - 16] + first + w[i - 7] + second;
      }
      let [a, b, c, d, e, f, g, h] = this.words;
      for (let i = 0; i < SHA_ROUND_CONSTANTS.length; i++) {
        const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choose = (e & f) ^ (~e & g);
        const temp1 = (h + sigma1 + choose + SHA_ROUND_CONSTANTS[i] + w[i]) | 0;
        const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (sigma0 + majority) | 0;
        h = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }
      this.words[0] += a; this.words[1] += b; this.words[2] += c; this.words[3] += d;
      this.words[4] += e; this.words[5] += f; this.words[6] += g; this.words[7] += h;
    }
    return bytes.subarray(end);
  }

  complete(lastBytes, byteLength) {
    const tail = this.blocks(lastBytes);
    const paddedLength = Math.ceil((tail.length + 9) / SHA_BLOCK_BYTES) * SHA_BLOCK_BYTES;
    const padding = new Uint8Array(paddedLength);
    padding.set(tail);
    padding[tail.length] = 0x80;
    new DataView(padding.buffer).setBigUint64(paddedLength - 8, BigInt(byteLength) * 8n);
    this.blocks(padding);
    return 'sha256:' + Array.from(this.words, word => word.toString(16).padStart(8, '0')).join('');
  }
}

export async function hashAtlmTextChunks(chunks) {
  const hash = new ResumableSha256();
  const pending = new Uint8Array(SHA_BLOCK_BYTES);
  let byteLength = 0;
  let fill = 0;
  for await (const chunk of chunks) {
    const bytes = encodeUtf8.encode(chunk);
    byteLength += bytes.length;
    let offset = 0;
    if (fill) {
      offset = Math.min(SHA_BLOCK_BYTES - fill, bytes.length);
      pending.set(bytes.subarray(0, offset), fill);
      fill += offset;
      if (fill < SHA_BLOCK_BYTES) continue;
      hash.blocks(pending);
    }
    const tail = hash.blocks(bytes.subarray(offset));
    pending.set(tail);
    fill = tail.length;
  }
  return { sha256: hash.complete(pending.subarray(0, fill), byteLength), byteLength };
}

function encodePart(bytes) {
  return btoa(String.fromCharCode(...bytes.subarray(0, 32_768)) + String.fromCharCode(...bytes.subarray(32_768)));
}

function decodePart(contentBase64, expectedBytes, code = 'INVALID_UPLOAD') {
  if (typeof contentBase64 !== 'string' || contentBase64.length > ATLM_PART_BASE64_CHARS
      || contentBase64.length !== Math.ceil(expectedBytes / 3) * 4) {
    throw appError(code, 'Некорректный размер части файла.', 422);
  }
  let value;
  try { value = atob(contentBase64); } catch { /* Validate the canonical encoding below. */ }
  if (value?.length !== expectedBytes || btoa(value) !== contentBase64) {
    throw appError(code, 'Часть файла должна быть в канонической кодировке base64.', 422);
  }
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i);
  return bytes;
}

export function normalizeAtlmFileDescriptor(file) {
  if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).length !== 2
      || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)
      || !Number.isSafeInteger(file.byteLength) || file.byteLength <= 0) {
    throw appError('VALIDATION_ERROR', 'Требуются SHA-256 и размер UTF-8 файла в байтах.');
  }
  if (file.byteLength > ATLM_MAX_UPLOAD_BYTES) {
    throw appError('UPLOAD_TOO_LARGE', 'Размер загрузки превышает 16 МиБ.', 413, { limit: ATLM_MAX_UPLOAD_BYTES });
  }
  return { sha256: file.sha256, byteLength: file.byteLength };
}

function checkPartIndex(partIndex, partCount = Infinity) {
  if (!Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= partCount) {
    throw appError('VALIDATION_ERROR', 'Индекс части находится вне диапазона файла.');
  }
}

function makeManifest(sha256, byteLength) {
  return {
    sha256, byteLength, partSize: ATLM_PART_BYTES, partCount: Math.ceil(byteLength / ATLM_PART_BYTES),
    mediaType: JSON_MEDIA_TYPE, encoding: 'base64',
  };
}

const initialUpload = JSON.stringify({ words: SHA_INITIAL_WORDS });
const initialExport = JSON.stringify({ chunkIndex: 0, chunkOffset: 0, tail: '', words: SHA_INITIAL_WORDS });
const uploadStates = "state IN ('UPLOADING','VALIDATING')";
const fileKeyWhere = 'owner_id=? AND storage_id=? AND file_kind=?';

function uploadKey(ownerId, selector) {
  const { storageId, fileKind, semanticHash } = selector;
  if (!UPLOAD_KINDS.has(fileKind) || typeof semanticHash !== 'string' || !semanticHash) {
    throw appError('VALIDATION_ERROR', 'Некорректный дескриптор загрузки.');
  }
  return [ownerId, storageId, fileKind];
}

function expireUploads(db, key, nowMs) {
  const [ownerId, storageId, fileKind] = key;
  return db.prepare(`DELETE FROM estimation_revision_file_parts WHERE owner_id=? AND (storage_id,file_kind) IN (
    SELECT f.storage_id,f.file_kind FROM estimation_revision_files f WHERE f.owner_id=?
      AND f.${uploadStates} AND f.updated_at<=? AND EXISTS(SELECT 1 FROM estimation_revision_file_parts p
        WHERE p.owner_id=f.owner_id AND p.storage_id=f.storage_id AND p.file_kind=f.file_kind)
      ORDER BY (f.storage_id=? AND f.file_kind=?) DESC,f.updated_at,f.storage_id,f.file_kind LIMIT ?)`)
    .bind(ownerId, ownerId, nowMs - ATLM_UPLOAD_TTL_MS, storageId, fileKind, ATLM_MAX_EXPIRED_DRAFTS);
}

function checkDraft(row, semanticHash, file, nowMs) {
  if (row && (row.semantic_hash !== semanticHash || row.sha256 !== file.sha256 || row.byte_length !== file.byteLength)) {
    throw appError('IDEMPOTENCY_KEY_REUSED', 'Идентификатор команды связан с другим дескриптором.', 409);
  }
  if (!row || row.updated_at <= nowMs - ATLM_UPLOAD_TTL_MS && row.state !== 'READY') {
    throw appError('UPLOAD_EXPIRED', 'Выполните prepare с тем же идентификатором команды.', 409);
  }
}

function receivedPartRanges(parts) {
  const ranges = [];
  for (const part of parts) {
    const last = ranges.at(-1);
    if (last && last.end + 1 === part.part_index) last.end = part.part_index;
    else ranges.push({ start: part.part_index, end: part.part_index });
  }
  return ranges;
}

function readDraftStatement(db, key) {
  return db.prepare(`SELECT * FROM estimation_revision_files WHERE ${fileKeyWhere}`).bind(...key);
}

function indicesStatement(db, key) {
  return db.prepare(`SELECT part_index FROM estimation_revision_file_parts WHERE ${fileKeyWhere}
    ORDER BY part_index`).bind(...key);
}

export async function prepareAtlmUpload(db, ownerId, selector, nowMs) {
  const { semanticHash } = selector;
  const file = normalizeAtlmFileDescriptor(selector.file);
  const manifest = makeManifest(file.sha256, file.byteLength);
  const key = uploadKey(ownerId, selector);
  const [, , , draft, parts] = await db.batch([
    expireUploads(db, key, nowMs),
    db.prepare(`INSERT OR IGNORE INTO estimation_revision_files(owner_id,storage_id,file_kind,state,semantic_hash,
      descriptor_json,sha256,byte_length,part_count,updated_at) VALUES(?,?,?,'UPLOADING',?,?,?,?,?,?)`)
      .bind(...key, semanticHash, initialUpload, file.sha256, file.byteLength, manifest.partCount, nowMs),
    db.prepare(`UPDATE estimation_revision_files SET state='UPLOADING',descriptor_json=?,checked_parts=0,checked_bytes=0,updated_at=?
      WHERE ${fileKeyWhere} AND ${uploadStates} AND semantic_hash=? AND sha256=? AND byte_length=? AND updated_at<=?`)
      .bind(initialUpload, nowMs, ...key, semanticHash, file.sha256, file.byteLength, nowMs - ATLM_UPLOAD_TTL_MS),
    readDraftStatement(db, key), indicesStatement(db, key),
  ]);
  checkDraft(draft.results[0], semanticHash, file, nowMs);
  return { state: 'UPLOADING', file: manifest, receivedPartRanges: receivedPartRanges(parts.results) };
}

export async function putAtlmUploadPart(db, ownerId, selector, nowMs) {
  const { semanticHash, partIndex, contentBase64 } = selector;
  const file = normalizeAtlmFileDescriptor(selector.file);
  const { partCount } = makeManifest(file.sha256, file.byteLength);
  const key = uploadKey(ownerId, selector);
  checkPartIndex(partIndex, partCount);
  const byteLength = Math.min(ATLM_PART_BYTES, file.byteLength - partIndex * ATLM_PART_BYTES);
  decodePart(contentBase64, byteLength);
  const [, , , draft, savedPart] = await db.batch([
    expireUploads(db, key, nowMs),
    db.prepare(`INSERT OR IGNORE INTO estimation_revision_file_parts(owner_id,storage_id,file_kind,
      part_index,byte_length,content_base64) SELECT ?,?,?,?,?,? FROM estimation_revision_files
      WHERE ${fileKeyWhere} AND state='UPLOADING' AND semantic_hash=? AND sha256=? AND byte_length=? AND updated_at>?`)
      .bind(...key, partIndex, byteLength, contentBase64, ...key, semanticHash, file.sha256, file.byteLength, nowMs - ATLM_UPLOAD_TTL_MS),
    db.prepare(`UPDATE estimation_revision_files SET updated_at=max(updated_at,?) WHERE changes()=1
      AND ${fileKeyWhere} AND state='UPLOADING'`)
      .bind(nowMs, ...key),
    readDraftStatement(db, key),
    db.prepare(`SELECT content_base64=? AS matches_bytes FROM estimation_revision_file_parts
      WHERE ${fileKeyWhere} AND part_index=?`).bind(contentBase64, ...key, partIndex),
  ]);
  checkDraft(draft.results[0], semanticHash, file, nowMs);
  if (savedPart.results[0]?.matches_bytes !== 1) {
    throw appError('UPLOAD_PART_CONFLICT', 'По этой позиции сохранена другая часть файла.', 409, { partIndex });
  }
  return { state: 'UPLOADING', partIndex };
}

function uploadInProgress() {
  return { state: 'VALIDATING', retryAfterMs: ATLM_RETRY_AFTER_MS };
}

function readParts(db, key, first, limit) {
  return dbAll(db, `SELECT part_index,byte_length,content_base64 FROM estimation_revision_file_parts
    WHERE ${fileKeyWhere} AND part_index>=? AND part_index<? ORDER BY part_index`, ...key, first, first + limit);
}

function uploadPartBytes(part, index, file) {
  const length = Math.min(ATLM_PART_BYTES, file.byteLength - index * ATLM_PART_BYTES);
  if (part?.part_index !== index || part.byte_length !== length) {
    throw appError('UPLOAD_INCOMPLETE', 'Загрузите все части файла перед commit.', 409);
  }
  return decodePart(part.content_base64, length);
}

async function uploadText(db, key, file, partCount) {
  const bytes = new Uint8Array(file.byteLength);
  for (let first = 0; first < partCount; first += ATLM_UPLOAD_READ_PARTS_PER_PAGE) {
    const count = Math.min(ATLM_UPLOAD_READ_PARTS_PER_PAGE, partCount - first);
    const page = await readParts(db, key, first, count);
    for (let i = 0; i < count; i++) bytes.set(uploadPartBytes(page[i], first + i, file), (first + i) * ATLM_PART_BYTES);
  }
  // Recheck the assembled bytes against the declared checksum before returning them
  // to the semantic commit. A concurrent TTL restart cannot substitute its parts.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if ('sha256:' + Array.from(digest, value => value.toString(16).padStart(2, '0')).join('') !== file.sha256) {
    throw appError('UPLOAD_CHECKSUM_MISMATCH', 'SHA-256 файла не совпадает с дескриптором.', 422);
  }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw appError('INVALID_UPLOAD', 'Файл содержит некорректную последовательность UTF-8.', 422); }
}

export async function readAtlmUpload(db, ownerId, selector, nowMs) {
  const { semanticHash } = selector;
  const file = normalizeAtlmFileDescriptor(selector.file);
  const { partCount } = makeManifest(file.sha256, file.byteLength);
  const key = uploadKey(ownerId, selector);
  const [, draft, parts] = await db.batch([
    expireUploads(db, key, nowMs), readDraftStatement(db, key), indicesStatement(db, key),
  ]);
  const row = draft.results[0];
  checkDraft(row, semanticHash, file, nowMs);
  if (parts.results.length !== partCount || parts.results.some((part, index) => part.part_index !== index)) {
    throw appError('UPLOAD_INCOMPLETE', 'Загрузите все части файла перед commit.', 409,
      { receivedPartRanges: receivedPartRanges(parts.results) });
  }
  if (row.checked_parts === partCount) {
    return { state: 'VALIDATED', text: await uploadText(db, key, file, partCount) };
  }
  const first = row.checked_parts;
  const count = Math.min(ATLM_PARTS_PER_PASS, partCount - first);
  const page = await readParts(db, key, first, count);
  const hash = new ResumableSha256(JSON.parse(row.descriptor_json).words);
  let checkedBytes = row.checked_bytes;
  for (let i = 0; i < count; i++) {
    const index = first + i;
    const bytes = uploadPartBytes(page[i], index, file);
    checkedBytes += bytes.length;
    if (index + 1 === partCount) {
      if (hash.complete(bytes, checkedBytes) !== file.sha256) {
        throw appError('UPLOAD_CHECKSUM_MISMATCH', 'SHA-256 файла не совпадает с дескриптором.', 422);
      }
    } else hash.blocks(bytes);
  }
  const done = first + count === partCount;
  // The ready guard only matches after both the checksum and UTF-8 validation.
  const validatedText = done ? await uploadText(db, key, file, partCount) : null;
  const write = await db.prepare(`UPDATE estimation_revision_files SET state='VALIDATING',descriptor_json=?,
    checked_parts=?,checked_bytes=? WHERE ${fileKeyWhere} AND ${uploadStates} AND semantic_hash=?
    AND checked_parts=? AND updated_at=?`)
    .bind(JSON.stringify({ words: Array.from(hash.words) }), first + count, checkedBytes, ...key,
      semanticHash, first, row.updated_at).run();
  if (write.meta.changes !== 1 || !done) return uploadInProgress();
  return { state: 'VALIDATED', text: validatedText };
}

const completePartsSql = `(SELECT count(*)=f.part_count AND coalesce(sum(p.byte_length),0)=f.byte_length
  FROM estimation_revision_file_parts p WHERE p.owner_id=f.owner_id AND p.storage_id=f.storage_id
    AND p.file_kind=f.file_kind)`;
export const ATLM_UPLOAD_READY_SQL = `EXISTS(SELECT 1 FROM estimation_revision_files f WHERE ${fileKeyWhere}
  AND state='VALIDATING' AND semantic_hash=? AND sha256=? AND byte_length=?
  AND checked_parts=part_count AND checked_bytes=byte_length AND updated_at>? AND ${completePartsSql})`;

export function atlmUploadReadyArgs(ownerId, selector, nowMs) {
  const key = uploadKey(ownerId, selector);
  const file = normalizeAtlmFileDescriptor(selector.file);
  return [...key, selector.semanticHash, file.sha256, file.byteLength, nowMs - ATLM_UPLOAD_TTL_MS];
}

export function readyAtlmUploadStatement(db, ownerId, selector, nowMs, { publishedModelId } = {}) {
  const args = atlmUploadReadyArgs(ownerId, selector, nowMs);
  const published = publishedModelId === undefined ? '' : `AND EXISTS(SELECT 1 FROM estimation_model_revisions
    WHERE owner_id=? AND model_revision_id=?)`;
  return db.prepare(`UPDATE estimation_revision_files SET state='READY',descriptor_json='{}',updated_at=? WHERE ${fileKeyWhere}
    AND ${ATLM_UPLOAD_READY_SQL} ${published}`)
    .bind(nowMs, ...args.slice(0, 3), ...args, ...(published ? [ownerId, publishedModelId] : []));
}

function exportPending() {
  return { state: 'MATERIALIZING', retryAfterMs: ATLM_RETRY_AFTER_MS };
}

function readyView(row) {
  return { state: 'READY', file: makeManifest(row.sha256, row.byte_length) };
}

function readExportDraft(db, key, publishedStorageId) {
  if (publishedStorageId === undefined) return readDraftStatement(db, key).first();
  const [ownerId, storageId, fileKind] = key;
  return dbFirst(db, `SELECT * FROM estimation_revision_files
    WHERE owner_id=? AND file_kind=? AND (storage_id=? OR (storage_id=? AND state='READY'))
    ORDER BY (storage_id=?) DESC LIMIT 1`, ownerId, fileKind, storageId, publishedStorageId, publishedStorageId);
}

export function sliceAtlmExportText(text, offset, limit) {
  if (text === null) return null;
  const bytes = encodeUtf8.encode(text);
  return { bytes: bytes.subarray(offset, offset + limit), done: offset + limit >= bytes.length };
}

async function exportPass(checkpoint, byteLength, readSlice) {
  let { chunkIndex, chunkOffset } = checkpoint;
  const { tail, words } = checkpoint;
  const hash = new ResumableSha256(words);
  const buffer = new Uint8Array(ATLM_PART_BYTES);
  const tailBytes = tail ? Uint8Array.from(atob(tail), character => character.charCodeAt(0)) : new Uint8Array(0);
  buffer.set(tailBytes);
  let fill = tailBytes.length;
  const parts = [];
  let sha256 = null;
  for (let reads = 0; reads < ATLM_EXPORT_CHUNKS_PER_PASS && parts.length < ATLM_PARTS_PER_PASS; reads++) {
    const available = (ATLM_PARTS_PER_PASS - parts.length) * ATLM_PART_BYTES - fill;
    const chunk = await readSlice(chunkIndex, chunkOffset, available);
    if (chunk === null) {
      const end = buffer.subarray(0, fill);
      if (fill) parts.push({ byteLength: fill, contentBase64: encodePart(end) });
      byteLength += fill;
      sha256 = hash.complete(end, byteLength);
      fill = 0;
      break;
    }
    const { bytes, done, nextOffset = chunkOffset + bytes.length } = chunk;
    if (!done && bytes.length === 0) break;
    for (let offset = 0; offset < bytes.length;) {
      const length = Math.min(ATLM_PART_BYTES - fill, bytes.length - offset);
      buffer.set(bytes.subarray(offset, offset + length), fill);
      offset += length;
      fill += length;
      if (fill === ATLM_PART_BYTES) {
        hash.blocks(buffer);
        parts.push({ byteLength: fill, contentBase64: encodePart(buffer) });
        byteLength += fill;
        fill = 0;
      }
    }
    if (done) {
      chunkIndex++;
      chunkOffset = 0;
    } else chunkOffset = nextOffset;
  }
  const state = JSON.stringify({
    chunkIndex, chunkOffset, tail: encodePart(buffer.subarray(0, fill)), words: Array.from(hash.words),
  });
  return { parts, byteLength, sha256, state };
}

function publishStagedExport(db, key, publishedKey, next, checkedParts, nowMs) {
  const staged = `EXISTS(SELECT 1 FROM estimation_revision_files WHERE ${fileKeyWhere}
    AND state='MATERIALIZING' AND sha256=? AND part_count=?)`;
  const stagedArgs = [...key, next.sha256, checkedParts];
  const mutable = `EXISTS(SELECT 1 FROM estimation_revision_files WHERE ${fileKeyWhere} AND state='MATERIALIZING')`;
  // The earlier Worker only knows the public key. Publish there in one
  // transaction so either writer's first complete manifest stays authoritative.
  return [
    db.prepare(`INSERT OR IGNORE INTO estimation_revision_files(owner_id,storage_id,file_kind,state,descriptor_json,updated_at)
      SELECT ?,?,?,'MATERIALIZING',?,? WHERE ${staged}`)
      .bind(...publishedKey, initialExport, nowMs, ...stagedArgs),
    db.prepare(`DELETE FROM estimation_revision_file_parts WHERE ${fileKeyWhere} AND ${mutable} AND ${staged}`)
      .bind(...publishedKey, ...publishedKey, ...stagedArgs),
    db.prepare(`INSERT INTO estimation_revision_file_parts(owner_id,storage_id,file_kind,part_index,byte_length,content_base64)
      SELECT ?,?,?,part_index,byte_length,content_base64 FROM estimation_revision_file_parts
      WHERE ${fileKeyWhere} AND ${mutable} AND ${staged}`)
      .bind(...publishedKey, ...key, ...publishedKey, ...stagedArgs),
    db.prepare(`UPDATE estimation_revision_files SET state='READY',descriptor_json='{}',checked_parts=?,checked_bytes=?,
      sha256=?,byte_length=?,part_count=?,updated_at=? WHERE ${fileKeyWhere} AND state='MATERIALIZING' AND ${staged}`)
      .bind(checkedParts, next.byteLength, next.sha256, next.byteLength, checkedParts, nowMs, ...publishedKey, ...stagedArgs),
    discardPublishedDraft(db, key, publishedKey),
  ];
}

function discardPublishedDraft(db, key, publishedKey) {
  return db.prepare(`DELETE FROM estimation_revision_files WHERE ${fileKeyWhere} AND state='MATERIALIZING'
    AND EXISTS(SELECT 1 FROM estimation_revision_files WHERE ${fileKeyWhere} AND state='READY')`)
    .bind(...key, ...publishedKey);
}

export async function materializeAtlmRevisionFile(db, ownerId, { storageId, publishedStorageId, fileKind, readChunk, readSlice }, nowMs) {
  if (!EXPORT_KINDS.has(fileKind)) throw appError('VALIDATION_ERROR', 'Неизвестный вид файла ревизии.');
  const key = [ownerId, storageId, fileKind];
  const staged = publishedStorageId !== undefined;
  const publishedKey = [ownerId, publishedStorageId ?? storageId, fileKind];
  const publishedGuard = staged ? `WHERE NOT EXISTS(
    SELECT 1 FROM estimation_revision_files WHERE ${fileKeyWhere} AND state='READY')` : '';
  await db.prepare(`INSERT OR IGNORE INTO estimation_revision_files(owner_id,storage_id,file_kind,state,descriptor_json,
    updated_at) SELECT ?,?,?,'MATERIALIZING',?,? ${publishedGuard}`)
    .bind(...key, initialExport, nowMs, ...(staged ? publishedKey : [])).run();
  const row = await readExportDraft(db, key, publishedStorageId);
  if (row.state === 'READY') {
    if (staged) await discardPublishedDraft(db, key, publishedKey).run();
    return readyView(row);
  }
  if (row.state !== 'MATERIALIZING') return exportPending();
  const checkpoint = JSON.parse(row.descriptor_json);
  const next = await exportPass(checkpoint, row.checked_bytes,
    readSlice ?? (async (index, offset, limit) => sliceAtlmExportText(await readChunk(index), offset, limit)));
  const checkedParts = row.checked_parts + next.parts.length;
  const guard = `${fileKeyWhere} AND state='MATERIALIZING' AND checked_parts=? AND descriptor_json=?`;
  const expected = [...key, row.checked_parts, row.descriptor_json];
  const writes = next.parts.map((part, index) => db.prepare(`INSERT INTO estimation_revision_file_parts(owner_id,
    storage_id,file_kind,part_index,byte_length,content_base64)
    SELECT ?,?,?,?,?,? FROM estimation_revision_files WHERE ${guard}`)
    .bind(...key, row.checked_parts + index, part.byteLength, part.contentBase64, ...expected));
  const checkParts = next.sha256 ? `AND (SELECT count(*)=? AND coalesce(sum(byte_length),0)=?
    FROM estimation_revision_file_parts WHERE ${fileKeyWhere})` : '';
  writes.push(db.prepare(`UPDATE estimation_revision_files SET state=?,descriptor_json=?,checked_parts=?,checked_bytes=?,
    sha256=?,byte_length=?,part_count=?,updated_at=? WHERE ${guard} ${checkParts}`)
    .bind(next.sha256 && !staged ? 'READY' : 'MATERIALIZING', next.sha256 ? '{}' : next.state, checkedParts, next.byteLength,
      next.sha256, next.sha256 ? next.byteLength : null, next.sha256 ? checkedParts : null, nowMs, ...expected,
      ...(next.sha256 ? [checkedParts, next.byteLength, ...key] : [])));
  if (next.sha256 && staged) writes.push(...publishStagedExport(db, key, publishedKey, next, checkedParts, nowMs));
  await db.batch(writes);
  const saved = await dbFirst(db, `SELECT state,sha256,byte_length FROM estimation_revision_files WHERE ${fileKeyWhere}`, ...publishedKey);
  if (saved?.state !== 'READY') return exportPending();
  if (staged && !next.sha256) await discardPublishedDraft(db, key, publishedKey).run();
  return readyView(saved);
}

export async function readAtlmRevisionFilePart(db, ownerId, { storageId, fileKind, partIndex }) {
  if (!EXPORT_KINDS.has(fileKind)) throw appError('VALIDATION_ERROR', 'Неизвестный вид файла ревизии.');
  checkPartIndex(partIndex);
  const row = await dbFirst(db, `SELECT f.sha256,f.part_count,p.content_base64 FROM estimation_revision_files f
    LEFT JOIN estimation_revision_file_parts p ON p.owner_id=f.owner_id AND p.storage_id=f.storage_id
      AND p.file_kind=f.file_kind AND p.part_index=?
    WHERE f.owner_id=? AND f.storage_id=? AND f.file_kind=? AND f.state='READY'`, partIndex, ownerId, storageId, fileKind);
  if (!row) throw appError('FILE_NOT_READY', 'Сначала получите готовый дескриптор через download.', 409);
  checkPartIndex(partIndex, row.part_count);
  if (!row.content_base64) throw appError('SOURCE_UNAVAILABLE', 'Часть сохранённого файла недоступна.', 503);
  return { fileSha256: row.sha256, partIndex, contentBase64: row.content_base64 };
}
