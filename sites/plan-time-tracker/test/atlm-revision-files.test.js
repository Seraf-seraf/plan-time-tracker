import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { configuredDatabase } from '../tracker-db/index.js';
import {
  ATLM_PART_BYTES, ATLM_MAX_UPLOAD_BYTES, ATLM_UPLOAD_TTL_MS,
  prepareAtlmUpload, putAtlmUploadPart, readAtlmUpload, readyAtlmUploadStatement,
  materializeAtlmRevisionFile, readAtlmRevisionFilePart, hashAtlmTextChunks,
} from '../worker/atlm/revision-files.js';
import { context, OWNER } from './fixtures/tracker-db.mjs';

const OTHER_OWNER = 'file-other-owner';
const sha256 = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const errorCode = code => error => error.code === code;
const descriptor = bytes => ({ sha256: sha256(bytes), byteLength: bytes.length });
const selector = (bytes, overrides = {}) => ({
  storageId: crypto.randomUUID(), fileKind: 'BUNDLE', semanticHash: 'semantic-hash', file: descriptor(bytes), ...overrides,
});
const part = (bytes, partIndex, args) => ({
  ...args, partIndex, contentBase64: bytes.subarray(partIndex * ATLM_PART_BYTES, (partIndex + 1) * ATLM_PART_BYTES).toString('base64'),
});
const ownerRows = c => c.db.sqlite.prepare('INSERT INTO owners(owner_id,created_at) VALUES(?,0),(?,0)').run(OWNER, OTHER_OWNER);
const helper = fileURLToPath(new URL('../scripts/atlm-transfer.mjs', import.meta.url));

function persistentContext(databasePath, existing = false) {
  if (!existing) {
    const source = context();
    try { source.db.sqlite.prepare('VACUUM INTO ?').run(databasePath); }
    finally { source.close(); }
  }
  const c = context(0, { databasePath });
  c.db.sqlite.exec('PRAGMA synchronous=OFF');
  return c;
}

function cli(command, args, expected = 0) {
  const options = Object.entries(args).flatMap(([name, value]) => [`--${name}`, String(value)]);
  const result = spawnSync(process.execPath, [helper, command, ...options], { encoding: 'utf8' });
  assert.equal(result.status, expected, result.error?.message ?? result.stderr);
  return expected === 0 ? JSON.parse(result.stdout) : result.stderr;
}

async function validate(db, ownerId, args, nowMs) {
  let result;
  for (let attempts = 0; attempts < 64; attempts++) {
    result = await readAtlmUpload(db, ownerId, args, nowMs);
    if (result.state === 'VALIDATED') return result.text;
    assert.equal(result.state, 'VALIDATING');
    assert.ok(result.retryAfterMs >= 0);
  }
  assert.fail('Upload did not finish validation');
}

function bundleFixture() {
  const prefix = '{"artifact":"';
  const beforeBoundary = prefix + 'a'.repeat(ATLM_PART_BYTES - Buffer.byteLength(prefix) - 1);
  const artifactTail = '🐈' + 'b'.repeat(140_333 - (ATLM_PART_BYTES - 1 - Buffer.byteLength(prefix)) - 4);
  const evaluation = 'ж'.repeat(84_814) + 'x';
  return Buffer.from(`${beforeBoundary}${artifactTail}","evaluation":"${evaluation}"}`);
}

test('the local helper and immutable upload round-trip a multipart UTF-8 model bundle', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atlm-file-helper-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const c = context();
  t.after(c.close);
  ownerRows(c);
  const data = bundleFixture();
  const file = join(dir, 'model.json');
  const partial = join(dir, 'received.json.partial');
  const published = join(dir, 'received.json');
  await writeFile(file, data);
  const manifest = cli('manifest', { file });
  assert.deepEqual({ sha256: manifest.sha256, byteLength: manifest.byteLength }, descriptor(data));
  assert.equal(manifest.partSize, ATLM_PART_BYTES);
  assert.ok(manifest.byteLength > 128 * 1024);
  const args = selector(data);
  assert.deepEqual((await prepareAtlmUpload(c.db, OWNER, args, c.now())).receivedPartRanges, []);
  assert.deepEqual((await prepareAtlmUpload(c.db, OTHER_OWNER, args, c.now())).receivedPartRanges, []);
  const first = cli('read-part', { file, 'part-index': 0 });
  assert.equal(first.byteLength, ATLM_PART_BYTES);
  assert.equal(first.contentBase64.length, 65_536);
  assert.ok(JSON.stringify({ jsonrpc: '2.0', params: { ...args, contentBase64: first.contentBase64 } }).length < 128 * 1024);
  const truncated = first.contentBase64.slice(0, -4);
  await assert.rejects(putAtlmUploadPart(c.db, OWNER, { ...args, partIndex: 0, contentBase64: truncated }, c.now()),
    errorCode('INVALID_UPLOAD'));
  await putAtlmUploadPart(c.db, OWNER, { ...args, ...first }, c.now());
  const exactReplay = await putAtlmUploadPart(c.db, OWNER, { ...args, ...first }, c.now());
  assert.deepEqual(exactReplay, { state: 'UPLOADING', partIndex: 0 });
  await assert.rejects(putAtlmUploadPart(c.db, OWNER, { ...args, ...first, contentBase64: Buffer.alloc(ATLM_PART_BYTES).toString('base64') }, c.now()),
    errorCode('UPLOAD_PART_CONFLICT'));
  const lastIndex = manifest.partCount - 1;
  await putAtlmUploadPart(c.db, OWNER, { ...args, ...cli('read-part', { file, 'part-index': lastIndex }) }, c.now());
  const resumed = await prepareAtlmUpload(c.db, OWNER, args, c.now());
  assert.deepEqual(resumed.receivedPartRanges, [{ start: 0, end: 0 }, { start: lastIndex, end: lastIndex }]);
  await assert.rejects(readAtlmUpload(c.db, OWNER, args, c.now()), error => {
    assert.deepEqual(error.details.receivedPartRanges, resumed.receivedPartRanges);
    return error.code === 'UPLOAD_INCOMPLETE';
  });
  for (let index = 1; index < lastIndex; index++) {
    await putAtlmUploadPart(c.db, OWNER, { ...args, ...cli('read-part', { file, 'part-index': index }) }, c.now());
  }
  await assert.rejects(readAtlmRevisionFilePart(c.db, OWNER, { ...args, partIndex: 0 }), errorCode('FILE_NOT_READY'));
  const text = await validate(c.db, OWNER, args, c.now());
  assert.equal(text, data.toString('utf8'));
  const parsed = JSON.parse(text);
  assert.equal(Buffer.byteLength(parsed.artifact), 140_333);
  assert.equal(Buffer.byteLength(parsed.evaluation), 169_629);
  const unpublished = readyAtlmUploadStatement(c.db, OWNER, args, c.now(), { publishedModelId: args.storageId });
  assert.equal((await unpublished.run()).meta.changes, 0);
  assert.equal((await readyAtlmUploadStatement(c.db, OWNER, args, c.now()).run()).meta.changes, 1);
  await assert.rejects(readAtlmRevisionFilePart(c.db, OTHER_OWNER, { ...args, partIndex: 0 }), errorCode('FILE_NOT_READY'));
  const ready = await materializeAtlmRevisionFile(c.db, OWNER, { ...args, readChunk: () => assert.fail('READY must not reload rows') }, c.now());
  assert.deepEqual(ready, { state: 'READY', file: manifest });

  assert.match(cli('write-part', { file: partial, 'part-index': 0, 'content-base64': 'Zh==' }, 1), /canonical base64/);
  await assert.rejects(stat(partial), { code: 'ENOENT' });
  assert.match(cli('write-part', { file: published, 'part-index': 0, 'content-base64': 'Zg==' }, 1), /\.partial/);
  for (let index = lastIndex; index >= 0; index--) {
    const response = await readAtlmRevisionFilePart(c.db, OWNER, { ...args, partIndex: index });
    assert.equal(response.fileSha256, manifest.sha256);
    assert.equal(response.partIndex, index);
    assert.equal(response.contentBase64, part(data, index, args).contentBase64);
    cli('write-part', { file: partial, 'part-index': index, 'content-base64': response.contentBase64 });
  }
  assert.match(cli('verify', { file: partial, sha256: sha256('wrong'), 'byte-length': data.length }, 1), /SHA-256/);
  assert.deepEqual(cli('verify', { file: partial, sha256: manifest.sha256, 'byte-length': manifest.byteLength }),
    { verified: true, sha256: manifest.sha256, byteLength: manifest.byteLength });
  await rename(partial, published);
  assert.deepEqual(await readFile(published), data);
});

test('upload validation resumes after restart and does not expose corrupt or incomplete files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atlm-upload-resume-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'db.sqlite');
  let c = persistentContext(databasePath);
  t.after(() => c.close());
  ownerRows(c);
  const data = Buffer.from(JSON.stringify({ report: '🐈'.repeat(160_000) }));
  const args = selector(data);
  const prepared = await prepareAtlmUpload(c.db, OWNER, args, c.now());
  for (let index = 0; index < prepared.file.partCount; index++)
    await putAtlmUploadPart(c.db, OWNER, part(data, index, args), c.now());
  assert.equal((await readAtlmUpload(c.db, OWNER, args, c.now())).state, 'VALIDATING');
  const progress = c.db.sqlite.prepare('SELECT checked_parts FROM estimation_revision_files WHERE storage_id=?').get(args.storageId).checked_parts;
  assert.ok(progress > 0 && progress < prepared.file.partCount);
  c.close();
  c = persistentContext(databasePath, true);
  assert.deepEqual((await prepareAtlmUpload(c.db, OWNER, args, c.now())).receivedPartRanges,
    [{ start: 0, end: prepared.file.partCount - 1 }]);
  assert.equal(await validate(c.db, OWNER, args, c.now()), data.toString('utf8'));
  for (const [input, file, expectedError] of [
    [Buffer.from([0xc3, 0x28]), null, 'INVALID_UPLOAD'],
    [Buffer.from('a'), descriptor(Buffer.from('b')), 'UPLOAD_CHECKSUM_MISMATCH'],
  ]) {
    const invalid = selector(input, file ? { file } : {});
    await prepareAtlmUpload(c.db, OWNER, invalid, c.now());
    await putAtlmUploadPart(c.db, OWNER, part(input, 0, invalid), c.now());
    await assert.rejects(validate(c.db, OWNER, invalid, c.now()), errorCode(expectedError));
    assert.equal((await readyAtlmUploadStatement(c.db, OWNER, invalid, c.now()).run()).meta.changes, 0);
    await assert.rejects(readAtlmRevisionFilePart(c.db, OWNER, { ...invalid, partIndex: 0 }), errorCode('FILE_NOT_READY'));
  }
});

test('upload limit and TTL bound staging while preserving draft identity', async () => {
  const c = context();
  try {
    ownerRows(c);
    const data = Buffer.from('x');
    const oversize = selector(data, { file: { ...descriptor(data), byteLength: ATLM_MAX_UPLOAD_BYTES + 1 } });
    await assert.rejects(prepareAtlmUpload(c.db, OWNER, oversize, c.now()), errorCode('UPLOAD_TOO_LARGE'));
    assert.equal(c.db.sqlite.prepare('SELECT count(*) n FROM estimation_revision_files').get().n, 0);
    const max = selector(data, { file: { ...descriptor(data), byteLength: ATLM_MAX_UPLOAD_BYTES } });
    assert.equal((await prepareAtlmUpload(c.db, OWNER, max, c.now())).file.partCount, 342);
    const drafts = Array.from({ length: 12 }, () => selector(data));
    for (const draft of drafts) {
      await prepareAtlmUpload(c.db, OWNER, draft, c.now());
      await putAtlmUploadPart(c.db, OWNER, part(data, 0, draft), c.now());
    }
    await prepareAtlmUpload(c.db, OTHER_OWNER, drafts[0], c.now());
    await putAtlmUploadPart(c.db, OTHER_OWNER, part(data, 0, drafts[0]), c.now());
    c.advance(ATLM_UPLOAD_TTL_MS - 1);
    await putAtlmUploadPart(c.db, OWNER, part(data, 0, drafts[0]), c.now());
    c.advance(1);
    await assert.rejects(readAtlmUpload(c.db, OWNER, drafts[0], c.now()), errorCode('UPLOAD_EXPIRED'));
    const count = ownerId => c.db.sqlite.prepare('SELECT count(*) n FROM estimation_revision_file_parts WHERE owner_id=?').get(ownerId).n;
    assert.equal(count(OWNER), 2);
    assert.equal(count(OTHER_OWNER), 1);
    assert.equal(c.db.sqlite.prepare('SELECT count(*) n FROM estimation_revision_files WHERE owner_id=?').get(OWNER).n, 13);
    await assert.rejects(prepareAtlmUpload(c.db, OWNER, { ...drafts[0], semanticHash: 'other' }, c.now()), errorCode('IDEMPOTENCY_KEY_REUSED'));
    const renewed = await prepareAtlmUpload(c.db, OWNER, drafts[0], c.now());
    assert.deepEqual(renewed.receivedPartRanges, []);
    await putAtlmUploadPart(c.db, OWNER, part(data, 0, drafts[0]), c.now());
    assert.equal(await validate(c.db, OWNER, drafts[0], c.now()), 'x');
  } finally { c.close(); }
});

function rowChunks(byteLength, rowCount) {
  const prefix = '{"rows":[';
  const suffix = ']}';
  const first = `"${'ж'.repeat(131_994)}"`;
  const smallRowBytes = Math.floor((byteLength - prefix.length - suffix.length - Buffer.byteLength(first)) / (rowCount - 1));
  const remainder = byteLength - prefix.length - suffix.length - Buffer.byteLength(first) - smallRowBytes * (rowCount - 1);
  return [prefix, first, ...Array.from({ length: rowCount - 1 }, (_, i) =>
    `,"${'x'.repeat(smallRowBytes - 3 + (i === rowCount - 2 ? remainder : 0))}"`), suffix];
}

for (const [name, byteLength] of [['teacher export', 7_934_191], ['export above the upload limit', ATLM_MAX_UPLOAD_BYTES + 257]]) {
  test(`${name} materializes in bounded passes and resumes after reopening SQLite`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'atlm-export-resume-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const databasePath = join(dir, 'db.sqlite');
    let c = persistentContext(databasePath);
    t.after(() => c.close());
    ownerRows(c);
    const chunks = rowChunks(byteLength, 124);
    assert.equal(Buffer.byteLength(chunks[1]), 263_990);
    const expectedHash = createHash('sha256');
    for (const chunk of chunks) expectedHash.update(chunk);
    const expected = { sha256: 'sha256:' + expectedHash.digest('hex'), byteLength };
    assert.deepEqual(await hashAtlmTextChunks(chunks), expected);
    let reads = 0;
    const args = { storageId: 'teacher-r2', fileKind: 'DATASET', readChunk(index) { reads++; return chunks[index] ?? null; } };
    const materialize = () => materializeAtlmRevisionFile(c.db, OWNER, args, c.now());
    const first = await materialize();
    assert.equal(first.state, 'MATERIALIZING');
    assert.ok(reads > 0 && reads < chunks.length);
    await assert.rejects(readAtlmRevisionFilePart(c.db, OWNER, { ...args, partIndex: 0 }), errorCode('FILE_NOT_READY'));
    const progress = c.db.sqlite.prepare('SELECT checked_parts,checked_bytes FROM estimation_revision_files').get();
    assert.ok(progress.checked_bytes < byteLength);
    c.close();
    c = persistentContext(databasePath, true);
    assert.deepEqual(c.db.sqlite.prepare('SELECT checked_parts,checked_bytes FROM estimation_revision_files').get(), progress);
    let result;
    for (let pass = 0; pass < 128; pass++) {
      result = await materialize();
      if (result.state === 'READY') break;
      assert.equal(result.state, 'MATERIALIZING');
    }
    assert.deepEqual(result, { state: 'READY', file: { ...expected, partSize: ATLM_PART_BYTES,
      partCount: Math.ceil(byteLength / ATLM_PART_BYTES), mediaType: 'application/json', encoding: 'base64' } });
    await assert.rejects(readAtlmRevisionFilePart(c.db, OTHER_OWNER, { ...args, partIndex: 0 }), errorCode('FILE_NOT_READY'));
    const verified = createHash('sha256');
    for (let index = 0; index < result.file.partCount; index++) {
      const response = await readAtlmRevisionFilePart(c.db, OWNER, { ...args, partIndex: index });
      assert.equal(response.fileSha256, expected.sha256);
      assert.equal(response.partIndex, index);
      const bytes = Buffer.from(response.contentBase64, 'base64');
      assert.equal(bytes.length, Math.min(ATLM_PART_BYTES, byteLength - index * ATLM_PART_BYTES));
      verified.update(bytes);
    }
    assert.equal('sha256:' + verified.digest('hex'), expected.sha256);
    assert.throws(() => c.db.sqlite.exec('DELETE FROM estimation_revision_file_parts'), /ATLM_FILE_IMMUTABLE/);
  });
}

test('maximum-size TEXT parts round-trip through the real remote SQLite adapter', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atlm-text-parts-'));
  const databasePath = join(dir, 'db.sqlite');
  const c = persistentContext(databasePath);
  ownerRows(c);
  c.close();
  const token = 'file-protocol-integration-test'.repeat(2);
  const proc = spawn('python3', ['-B', '-u', '-c', [
    'import server, socket',
    'server.PARTS.clock = lambda: 0',
    'class Handler(server.Handler):',
    '    protocol_version = "HTTP/1.1"',
    '    def setup(self):',
    '        super().setup()',
    '        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)',
    '    def log_message(self, *_args):',
    '        pass',
    'httpd = server.Server(("127.0.0.1", 0), Handler)',
    'print(httpd.server_port, flush=True)',
    'httpd.serve_forever()',
  ].join('\n')], {
    cwd: fileURLToPath(new URL('../tracker-db', import.meta.url)),
    env: { ...process.env, DB_TOKEN: token, DB_FILE: databasePath },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exit = once(proc, 'exit');
      proc.kill();
      await exit;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const [port] = await Promise.race([
    once(createInterface({ input: proc.stdout }), 'line'),
    once(proc, 'exit').then(([code]) => { throw new Error('Remote SQLite fixture exited with code ' + code); }),
  ]);
  const fetchHttp = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => fetchHttp('http://127.0.0.1:' + port + new URL(url).pathname, options));
  const db = configuredDatabase({ DB_DRIVER: 'remote-sqlite', DB_URL: 'https://db.test/_tracker-db/', DB_TOKEN: token });
  const budget = ATLM_MAX_UPLOAD_BYTES - Buffer.byteLength(JSON.stringify({ evidence: '' }));
  const evidence = randomBytes(Math.ceil(budget * 3 / 4)).toString('base64').slice(0, budget);
  const data = Buffer.from(JSON.stringify({ evidence }));
  assert.equal(data.byteLength, ATLM_MAX_UPLOAD_BYTES);
  const args = selector(data);
  const now = 1_800_000_000_000;
  const draft = await prepareAtlmUpload(db, OWNER, args, now);
  for (let index = 0; index < draft.file.partCount; index++) {
    await putAtlmUploadPart(db, OWNER, part(data, index, args), now);
  }
  const first = part(data, 0, args);
  await putAtlmUploadPart(db, OWNER, first, now);
  const stored = await db.prepare('SELECT typeof(content_base64) AS storage FROM estimation_revision_file_parts').first();
  assert.equal(stored.storage, 'text');
  assert.equal(sha256(await validate(db, OWNER, args, now)), args.file.sha256);
  assert.equal((await readyAtlmUploadStatement(db, OWNER, args, now).run()).meta.changes, 1);
  const response = await readAtlmRevisionFilePart(db, OWNER, { ...args, partIndex: 0 });
  assert.deepEqual(response, { fileSha256: args.file.sha256, partIndex: 0, contentBase64: first.contentBase64 });
});
