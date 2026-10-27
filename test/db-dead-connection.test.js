// Neon suspends an idle compute and terminates its connections (FATAL 57P01). In production
// this crashed the whole process (~20×/week: "Uncaught Exception: terminating connection due to
// administrator command", exit 129) — on /login and on the bank agent's claim — because the pg
// Pool had no 'error' listener. These tests drive the adapter with a fake pool that behaves the
// way node-postgres does in those moments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { initBackend, getExecutor, tx, isDeadConnection } from '../src/db/adapter.js';

function deadErr() {
  const e = new Error('terminating connection due to administrator command');
  e.code = '57P01';
  return e;
}

function fakeClient(log, { deadOnFirst = false } = {}) {
  const c = new EventEmitter();
  let first = true;
  c.released = [];
  c.query = async (text) => {
    log.push(text);
    if (deadOnFirst && first) { first = false; throw deadErr(); }
    first = false;
    return { rows: [{ id: 7, v: 1 }], rowCount: 1 };
  };
  c.release = (err) => { c.released.push(err || null); };
  return c;
}

class FakePool extends EventEmitter {
  constructor() { super(); this.log = []; this.queryFailures = []; this.clients = []; this.deadClients = 0; }
  async query(text) {
    this.log.push(text);
    const f = this.queryFailures.shift();
    if (f) throw f;
    return { rows: [{ id: 1, v: 42 }], rowCount: 1 };
  }
  async connect() {
    const dead = this.deadClients > 0;
    if (dead) this.deadClients -= 1;
    const c = fakeClient(this.log, { deadOnFirst: dead });
    this.clients.push(c);
    return c;
  }
}

test('an idle connection dying is logged, not an uncaught exception that kills the process', async () => {
  const pool = new FakePool();
  await initBackend({ pgPool: pool });
  assert.ok(pool.listenerCount('error') >= 1, 'the pool has an error listener');
  // EventEmitter throws synchronously on 'error' with no listener — that throw was the crash.
  assert.doesNotThrow(() => pool.emit('error', deadErr(), {}));
});

test('a statement that hit a dead pooled connection is resent once on a fresh one', async () => {
  const pool = new FakePool();
  await initBackend({ pgPool: pool });
  pool.queryFailures.push(deadErr());
  const row = await getExecutor().one('SELECT v FROM t WHERE id = ?', [1]);
  assert.equal(row.v, 42);
  assert.equal(pool.log.length, 2, 'sent twice: the dead try + the retry');
});

test('only a dead connection is retried — other errors surface at once, and a retry happens only once', async () => {
  const pool = new FakePool();
  await initBackend({ pgPool: pool });
  const dup = new Error('duplicate key'); dup.code = '23505';
  pool.queryFailures.push(dup);
  await assert.rejects(getExecutor().run('INSERT INTO t (a) VALUES (?)', [1]), /duplicate key/);
  assert.equal(pool.log.length, 1, 'a real error is not resent');

  pool.log.length = 0;
  pool.queryFailures.push(deadErr(), deadErr());
  await assert.rejects(getExecutor().one('SELECT 1'), (e) => isDeadConnection(e));
  assert.equal(pool.log.length, 2, 'one retry, not a loop');
});

test('tx: a dead connection at BEGIN is swapped for a fresh one; the dead client is discarded', async () => {
  const pool = new FakePool();
  await initBackend({ pgPool: pool });
  pool.deadClients = 1;
  const out = await tx(async (t) => (await t.one('SELECT v FROM t')).v);
  assert.equal(out, 1);
  assert.equal(pool.clients.length, 2);
  assert.ok(isDeadConnection(pool.clients[0].released[0]), 'the dead client is released with its error (pool destroys it)');
  assert.deepEqual(pool.clients[1].released, [null], 'the good client goes back to the pool');
  assert.deepEqual(pool.log, ['BEGIN', 'BEGIN', 'SELECT v FROM t', 'COMMIT']);
});

test('tx: a checked-out client whose connection dies between statements does not crash the process', async () => {
  const pool = new FakePool();
  await initBackend({ pgPool: pool });
  await tx(async (t) => {
    const c = pool.clients[0];
    assert.ok(c.listenerCount('error') >= 1, 'a listener guards the checked-out client');
    assert.doesNotThrow(() => c.emit('error', deadErr()));
    await t.one('SELECT 1');
  });
  assert.equal(pool.clients[0].listenerCount('error'), 0, 'the guard is removed on release');
});

test('tx: a failure inside fn rolls back and is never retried (the work may have half-run)', async () => {
  const pool = new FakePool();
  await initBackend({ pgPool: pool });
  await assert.rejects(tx(async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(pool.log, ['BEGIN', 'ROLLBACK']);
  assert.equal(pool.clients.length, 1);
});
