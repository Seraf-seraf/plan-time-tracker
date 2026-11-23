import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { configuredDatabase } from '../tracker-db/index.js';

test('remote SQLite reads immutable parts after a lost response and executes a write once', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tracker-parts-'));
  const token = 'integration-test-only'.repeat(2);
  const proc = spawn('python3', ['-B', '-u', '-c', [
    'import server, sqlite3',
    'db = sqlite3.connect(server.DATABASE)',
    'db.execute("CREATE TABLE data(body TEXT)")',
    'db.close()',
    'httpd = server.Server(("127.0.0.1", 0), server.Handler)',
    'print(httpd.server_port, flush=True)',
    'httpd.serve_forever()',
  ].join('\n')], {
    cwd: fileURLToPath(new URL('../tracker-db', import.meta.url)),
    env: { ...process.env, DB_TOKEN: token, DB_FILE: join(dir, 'data.sqlite3') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(async () => {
    const exit = once(proc, 'exit');
    proc.kill();
    await exit;
    await rm(dir, { recursive: true, force: true });
  });
  const [port] = await once(createInterface({ input: proc.stdout }), 'line');
  const realFetch = globalThis.fetch;
  const attempts = new Map();
  let statements = 0;
  let corrupt = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname;
    const local = 'http://127.0.0.1:' + port + path;
    if (!path.endsWith('/parts')) {
      statements++;
      return realFetch(local, options);
    }
    const {index} = JSON.parse(options.body);
    attempts.set(index, (attempts.get(index) ?? 0) + 1);
    const response = await realFetch(local, options);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length <= 16384);
    if (index === 2 && attempts.get(index) === 1) throw new TypeError('dropped response');
    if (corrupt && index === 0) bytes[0] ^= 1;
    return new Response(bytes, { headers: response.headers, status: response.status });
  });
  const db = configuredDatabase({ DB_DRIVER: 'remote-sqlite', DB_URL: 'https://db.test/_tracker-db/', DB_TOKEN: token });
  const written = await db.prepare('INSERT INTO data VALUES (hex(randomblob(131072))) RETURNING body').first();
  assert.equal(written.body.length, 262144);
  assert.equal(statements, 1);
  assert.equal(attempts.get(2), 2);
  const row = await db.prepare('SELECT count(*) AS n, body FROM data').first();
  assert.equal(row.n, 1);
  assert.equal(row.body, written.body);
  const parts = [...attempts];
  assert.equal((await db.prepare('SELECT 1 AS n').first()).n, 1);
  assert.deepEqual([...attempts], parts);
  assert.equal((await db.firstInline('SELECT body FROM data')).body, written.body);
  assert.deepEqual([...attempts], parts);
  corrupt = true;
  await assert.rejects(db.prepare('SELECT body FROM data').first(), /checksum/);
  assert.equal((await realFetch('http://127.0.0.1:' + port + '/_tracker-db/parts', {method:'POST'})).status, 403);
});
