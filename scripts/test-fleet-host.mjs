import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, inject } from '../index.js';

// Contract seams mirror the inspected Host services; no Profile, filesystem,
// Session service, server, or model is touched by this test suite.
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function harness(shared = { records: {} }, ids = ['a', 'b']) {
  const workspaces = new Map(ids.map(id => [id, { id }]));
  const calls = { open: [], writes: [], loads: 0, close: 0, unregister: 0 };
  let route, cleanup, activeWrites = 0;
  const controls = { loadError: null, openError: null, writeError: null, writeGate: null };
  const unit = {
    async loadAll() {
      calls.loads++;
      if (controls.loadError) throw controls.loadError;
      return { tables: { workspaces: structuredClone(shared.records) }, global: null };
    },
    async putRecord(table, key, value) {
      calls.writes.push({ table, key, value: structuredClone(value) });
      assert.equal(++activeWrites, 1, 'writes must be serialized');
      try {
        if (controls.writeGate) await controls.writeGate.promise;
        if (controls.writeError) throw controls.writeError;
        shared.records[key] = structuredClone(value);
      } finally { activeWrites--; }
    },
    async close() { calls.close++; }
  };
  const backend = { kv: { async open(descriptor) {
    // dsh-storage/lib/index.js:80; JSON validateDescriptor applies this to units and tables.
    assert.match(descriptor.name, /^[a-z][a-z0-9_]*$/);
    for (const table of descriptor.tables) assert.match(table, /^[a-z][a-z0-9_]*$/);
    calls.open.push(structuredClone(descriptor));
    if (controls.openError) throw controls.openError;
    return unit;
  } } };
  const ctx = {
    storage: { backend: {
      names: () => ['json'],
      get(name) { assert.equal(name, 'json'); return backend; }
    } },
    workspaceRegistry: {
      list: () => [...workspaces.values()],
      get: id => workspaces.get(id)
    },
    connection: { fetch: { register(value) {
      assert.equal(value.path, '/api/fleet/modes');
      assert.deepEqual(value.methods, ['GET', 'POST']);
      assert.equal(value.requestBody, 'buffered');
      route = value;
      return async () => { calls.unregister++; };
    } } },
    effect(factory) { cleanup = factory(); }
  };
  apply(ctx);
  async function request(method = 'GET', value, raw = false) {
    const response = await route.fetch(new Request('http://test/api/fleet/modes', {
      method, ...(value !== undefined ? { body: raw ? value : JSON.stringify(value), headers: { 'content-type': 'application/json' } } : {})
    }));
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  return { calls, shared, controls, workspaces, request, dispose: () => cleanup() };
}
const empty = { schemaVersion: 1, enabledWorkspaceIds: [] };

test('exact injected services, authenticated route shape, GET never writes', async () => {
  assert.deepEqual(inject, ['storage', 'connection', 'workspaceRegistry']);
  const app = harness();
  assert.equal(app.calls.open.length, 0, 'opening is lazy');
  assert.deepEqual(await app.request(), { status: 200, body: empty, cache: 'no-store' });
  assert.deepEqual(app.calls.open, [{ name: 'fleet_modes', version: 1, tables: ['workspaces'], hasGlobal: false, layout: 'single' }]);
  await app.request();
  assert.equal(app.calls.writes.length, 0);
  await app.dispose();
  assert.equal(app.calls.unregister, 1);
  assert.equal(app.calls.close, 1);
});

test('enable/disable persists per ID, returns registry order, and survives plugin reapplication', async () => {
  const shared = { records: {} };
  const app = harness(shared);
  assert.equal((await app.request('POST', { workspaceId: 'b', enabled: true })).status, 200);
  assert.deepEqual((await app.request('POST', { workspaceId: 'a', enabled: true })).body.enabledWorkspaceIds, ['a', 'b']);
  assert.deepEqual(app.calls.writes[0], { table: 'workspaces', key: 'b', value: { enabled: true } });
  await app.dispose();
  const restarted = harness(shared);
  assert.deepEqual((await restarted.request()).body.enabledWorkspaceIds, ['a', 'b']);
  assert.deepEqual((await restarted.request('POST', { workspaceId: 'a', enabled: false })).body.enabledWorkspaceIds, ['b']);
  assert.deepEqual(shared.records.a, { enabled: false });
  await restarted.dispose();
});

test('idempotent toggles and GET leave absent/old storage untouched', async () => {
  const app = harness({ records: { a: { enabled: true }, deleted: { enabled: true }, old: { enabled: 'true' } } });
  assert.deepEqual((await app.request()).body.enabledWorkspaceIds, ['a']);
  await app.request('POST', { workspaceId: 'a', enabled: true });
  await app.request('POST', { workspaceId: 'b', enabled: false });
  assert.equal(app.calls.writes.length, 0);
  assert.deepEqual(app.shared.records.old, { enabled: 'true' });
  app.workspaces.delete('a');
  assert.deepEqual((await app.request()).body, empty);
  await app.dispose();
});

test('malformed input returns 400, unknown registered ID returns 404 without storage access', async () => {
  const app = harness();
  for (const input of [null, [], {}, { workspaceId: 'a', enabled: 'true' }, { workspaceId: 1, enabled: true },
    { workspaceId: '', enabled: true }, { workspaceId: 'a', enabled: true, extra: 1 }]) {
    assert.equal((await app.request('POST', input)).status, 400);
  }
  assert.equal((await app.request('POST', '{', true)).status, 400);
  assert.equal((await app.request('POST', { workspaceId: 'unknown', enabled: true })).status, 404);
  assert.equal(app.calls.open.length, 0);
  assert.equal(app.calls.writes.length, 0);
  await app.dispose();
  assert.equal(app.calls.close, 0);
});

test('malformed current records fail closed, never enable or repair themselves', async () => {
  for (const record of [true, 'true', null, [], { enabled: 'true' }, { enabled: 1 }, {}, { enabled: true, legacy: true }]) {
    const app = harness({ records: { a: record } });
    const result = await app.request();
    assert.equal(result.status, 500);
    assert.equal(result.body.error.code, 'fleet/persistence-error');
    assert.match(result.body.error.message, /Malformed Fleet mode record/);
    assert.equal((await app.request('POST', { workspaceId: 'a', enabled: false })).status, 500);
    assert.equal(app.calls.writes.length, 0);
    await app.dispose();
  }
});

test('read and open failures are explicit 500 and do not poison recovery', async () => {
  const app = harness();
  app.controls.openError = new Error('open fixture failure');
  assert.match((await app.request()).body.error.message, /open fixture failure/);
  app.controls.openError = null;
  app.controls.loadError = new Error('read fixture failure');
  const failed = await app.request();
  assert.equal(failed.status, 500);
  assert.match(failed.body.error.message, /read fixture failure/);
  assert.equal((await app.request('POST', { workspaceId: 'a', enabled: true })).status, 500);
  assert.equal(app.calls.writes.length, 0);
  app.controls.loadError = null;
  assert.deepEqual((await app.request()).body, empty);
  await app.dispose();
});

test('write failure publishes no mode and later writes still succeed', async () => {
  const app = harness();
  app.controls.writeError = new Error('durability fixture failure');
  const failed = await app.request('POST', { workspaceId: 'a', enabled: true });
  assert.equal(failed.status, 500);
  assert.match(failed.body.error.message, /durability fixture failure/);
  assert.deepEqual((await app.request()).body, empty);
  app.controls.writeError = null;
  assert.equal((await app.request('POST', { workspaceId: 'b', enabled: true })).status, 200);
  assert.deepEqual((await app.request()).body.enabledWorkspaceIds, ['b']);
  await app.dispose();
});

test('queued writes and reads observe durable order; disposal drains before close', async () => {
  const app = harness();
  const gate = deferred();
  app.controls.writeGate = gate;
  const first = app.request('POST', { workspaceId: 'a', enabled: true });
  while (app.calls.writes.length === 0) await new Promise(resolve => setImmediate(resolve));
  const second = app.request('POST', { workspaceId: 'b', enabled: true });
  const read = app.request();
  // Let JSON bodies parse and the queued calls attach before starting disposal.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.calls.writes.length, 1);
  const closing = app.dispose();
  assert.equal(app.calls.close, 0);
  assert.equal((await app.request()).status, 503);
  gate.resolve();
  const [one, two, observed] = await Promise.all([first, second, read]);
  assert.deepEqual(one.body.enabledWorkspaceIds, ['a']);
  assert.deepEqual(two.body.enabledWorkspaceIds, ['a', 'b']);
  assert.deepEqual(observed.body.enabledWorkspaceIds, ['a', 'b']);
  await closing;
  assert.equal(app.calls.close, 1);
  assert.equal(app.calls.unregister, 1);
});

test('Workspace removal while a read waits rejects mutation instead of writing a stale ID', async () => {
  const app = harness();
  const gate = deferred();
  app.controls.writeGate = gate;
  const first = app.request('POST', { workspaceId: 'a', enabled: true });
  while (!app.calls.writes.length) await new Promise(resolve => setImmediate(resolve));
  const removed = app.request('POST', { workspaceId: 'b', enabled: true });
  await new Promise(resolve => setImmediate(resolve));
  app.workspaces.delete('b');
  gate.resolve();
  await first;
  assert.equal((await removed).status, 404);
  assert.equal(app.calls.writes.length, 1);
  await app.dispose();
});
