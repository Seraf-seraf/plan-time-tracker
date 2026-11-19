import assert from 'node:assert/strict';
import test from 'node:test';
import { SqlTransaction } from '../worker/application/transaction.js';
import { TransactionalEvents } from '../worker/application/events.js';
import { context } from './fixtures/tracker-db.mjs';

test('application transaction commits ordered observer effects as one atomic batch', async () => {
  const c = context();
  try {
    c.db.sqlite.exec('CREATE TABLE effects (position INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    const events = new TransactionalEvents({
      changed: [
        { observe(tx, event) { tx.add('INSERT INTO effects VALUES(1,?)', event.value); } },
        (tx) => tx.add("INSERT INTO effects SELECT 2,value || '-observed' FROM effects WHERE position=1"),
      ],
    });
    const tx = new SqlTransaction(c.db);
    events.emit(tx, { type: 'changed', value: 'saved' });
    assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) AS count FROM effects').get().count, 0);
    const results = await tx.commit();
    assert.equal(results.length, 2);
    assert.deepEqual(c.db.sqlite.prepare('SELECT value FROM effects ORDER BY position').all()
      .map(row => row.value), ['saved', 'saved-observed']);
    await assert.rejects(tx.commit(), /no longer open/);
    assert.throws(() => tx.add("DELETE FROM effects"), /no longer open/);
  } finally {
    c.close();
  }
});

test('a failing observer write rolls back the main write and earlier effects', async () => {
  const c = context();
  try {
    c.db.sqlite.exec('CREATE TABLE effects (id INTEGER PRIMARY KEY, value INTEGER CHECK(value>0))');
    const tx = new SqlTransaction(c.db);
    tx.add('INSERT INTO effects VALUES(1,1)');
    const events = new TransactionalEvents({
      changed: [(transaction) => transaction.add('INSERT INTO effects VALUES(2,-1)')],
    });
    events.emit(tx, { type: 'changed' });
    await assert.rejects(tx.commit(), /CHECK constraint failed/);
    assert.equal(c.db.sqlite.prepare('SELECT COUNT(*) AS count FROM effects').get().count, 0);
    await assert.rejects(tx.commit(), /CHECK constraint failed/);
    const retry = new SqlTransaction(c.db);
    retry.add('INSERT INTO effects VALUES(1,2)');
    await retry.commit();
    assert.equal(c.db.sqlite.prepare('SELECT value FROM effects').get().value, 2);
  } finally {
    c.close();
  }
});

test('observer preparation failure prevents committing a partially prepared transaction', async () => {
  let executions = 0;
  const db = { batch() { executions++; } };
  const tx = new SqlTransaction(db);
  tx.addPrepared({ sql: 'prepared before failure' });
  const failure = new Error('observer preparation failed');
  const events = new TransactionalEvents({ changed: [() => { throw failure; }] });
  assert.throws(() => events.emit(tx, { type: 'changed' }), error => error === failure);
  await assert.rejects(tx.commit(), error => error === failure);
  assert.equal(executions, 0);
});

test('unknown and asynchronous events fail without executing writes', async () => {
  let executions = 0;
  const db = { batch() { executions++; } };
  const events = new TransactionalEvents({ changed: [() => Promise.resolve()] });
  const unknown = new SqlTransaction(db);
  assert.throws(() => events.emit(unknown, { type: 'missing' }), /Unknown transactional event/);
  await assert.rejects(unknown.commit(), /Unknown transactional event/);
  const asynchronous = new SqlTransaction(db);
  assert.throws(() => events.emit(asynchronous, { type: 'changed' }), /must be synchronous/);
  await assert.rejects(asynchronous.commit(), /must be synchronous/);
  assert.equal(executions, 0);
});

test('an unknown commit result is never retried by the transaction', async () => {
  let executions = 0;
  const failure = new Error('response lost after commit');
  const tx = new SqlTransaction({ async batch() { executions++; throw failure; } });
  tx.addPrepared({ sql: 'write' });
  await assert.rejects(tx.commit(), error => error === failure);
  await assert.rejects(tx.commit(), error => error === failure);
  assert.equal(executions, 1);
});
