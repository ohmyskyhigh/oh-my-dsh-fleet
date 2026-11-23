// Chain-scoped store: transaction locks, auto stale reclaim, lock-free reads.
// Real filesystem tests; only test-owned mkdtemp trees are removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { FleetStore, jsonClone, validateTemplates, validateWorkspaceState, ticketFilename } from '../src/fleet-store.js';

const owned = new Set();
async function temp(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-chain-test-')));
  owned.add(dir);
  t.after(async () => {
    for (const target of owned) {
      assert.equal(path.dirname(target), await fs.realpath(os.tmpdir()));
      await fs.rm(target, { recursive: true, force: true });
    }
    owned.clear();
  });
  return dir;
}
const templates = () => ({ schemaVersion: 1, agents: [{ id: 'writer', revision: 1, profile: { instructions: 'w' }, sourceId: null, history: [] }], flows: [{ id: 'flow', revision: 1, definition: { nodes: [{ id: 'n', role: 'writer', dependsOn: [], task: { prompt: 'p' } }], gates: [] }, history: [] }] });
const workspace = (tickets = []) => ({ schemaVersion: 1, id: 'alpha', definitions: { agents: [{ id: 'writer', revision: 1, profile: { instructions: 'w' }, sourceId: null, history: [] }], flows: [] }, binding: null, tickets });
const ticket = (id, goal = 'g') => ({ id, workspaceId: 'alpha', goal, inputs: {}, criteria: [], plan: null, status: 'draft', revision: 1, snapshot: null, nodes: [], gates: [], changes: [], events: [] });
async function writeLock(dir, owner) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.writer.lock'), JSON.stringify({ token: randomUUID(), pid: owner.pid, hostname: owner.hostname ?? hostname() }));
}
async function lockExists(dir) { try { await fs.stat(path.join(dir, '.writer.lock')); return true; } catch { return false; } }
function deadPid() { const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'inherit' }); assert.ok(!child.error); assert.equal(child.status, 0); return child.pid; }

test('templates chain bootstraps empty, commits and reads back identical', async t => {
  const dir = path.join(await temp(t), 'root');
  const store = await FleetStore.open({ dir, kind: 'templates' });
  assert.equal(await store.read(), null);
  const state = templates();
  const revision = await store.commit(state);
  assert.match(revision, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await store.read(), state);
  assert.equal(await lockExists(dir), false, 'lock is released after the commit transaction');
  assert.ok((await fs.stat(path.join(dir, 'generations', `${revision}.json`))).isFile());
});

test('workspace chain stores ticket bodies as hash-verified side files', async t => {
  const dir = path.join(await temp(t), 'alpha', '.fleet');
  const store = await FleetStore.open({ dir, kind: 'workspace' });
  const tickets = [ticket('one'), ticket('two')];
  const revision = await store.commit(workspace(tickets));
  const generation = path.join(dir, 'generations', revision);
  const disk = JSON.parse(await fs.readFile(path.join(generation, 'state.json'), 'utf8'));
  assert.deepEqual(disk.tickets.map(ref => ref.id), ['one', 'two']);
  assert.ok(disk.tickets.every(ref => /^[0-9a-f]{64}$/.test(ref.hash)));
  assert.equal(JSON.parse(await fs.readFile(path.join(generation, 'tickets', ticketFilename('one')), 'utf8')).id, 'one');
  assert.deepEqual((await store.read()).tickets, tickets);
});

test('tampered bodies are rejected by chain hashes, never repaired', async t => {
  const dir = path.join(await temp(t), 'w');
  const store = await FleetStore.open({ dir, kind: 'workspace' });
  const revision = await store.commit(workspace([ticket('one')]));
  const ticketFile = path.join(dir, 'generations', revision, 'tickets', ticketFilename('one'));
  await fs.writeFile(ticketFile, (await fs.readFile(ticketFile, 'utf8')).replace('"g"', '"tampered"'));
  await assert.rejects(store.read(), /corrupt Ticket hash/);
  const dir2 = path.join(await temp(t), 't');
  const templates2 = await FleetStore.open({ dir: dir2, kind: 'templates' });
  const rev2 = await templates2.commit(templates());
  const genFile = path.join(dir2, 'generations', `${rev2}.json`);
  await fs.writeFile(genFile, (await fs.readFile(genFile, 'utf8')).replace('"w"', '"tampered"'));
  await assert.rejects(templates2.read(), /corrupt template state hash/);
});

test('failed publication leaves the previous pointer intact and keeps the orphan generation', async t => {
  const dir = path.join(await temp(t), 'root');
  let failNext = false;
  const store = await FleetStore.open({ dir, kind: 'templates', beforePublish() { if (failNext) throw new Error('injected write failure'); } });
  const first = await store.commit(templates());
  failNext = true;
  await assert.rejects(store.commit({ ...templates(), agents: [] }), /injected/);
  assert.deepEqual((await store.read()).agents.length, 1, 'old committed state still readable');
  const pointer = JSON.parse(await fs.readFile(path.join(dir, 'current.json'), 'utf8'));
  assert.equal(pointer.revision, first);
  const generations = await fs.readdir(path.join(dir, 'generations'));
  assert.ok(generations.includes(`${first}.json`), 'committed generation retained');
  assert.ok((await fs.readdir(dir)).some(name => name.startsWith('current.') && name.endsWith('.tmp')), 'unpublished temp pointer is a harmless orphan');
  assert.deepEqual((await FleetStore.read({ dir, kind: 'templates' })).agents.length, 1, 'reads still follow the committed pointer');
  assert.equal(await lockExists(dir), false, 'failed transaction still released its lock');
});

test('provably stale locks are auto-reclaimed inside commit; live and remote locks are honored', async t => {
  const dir = path.join(await temp(t), 'root');
  await writeLock(dir, { pid: deadPid() });
  const store = await FleetStore.open({ dir, kind: 'templates' });
  await store.commit(templates());
  assert.equal(await lockExists(dir), false);
  assert.ok(await store.read());
  await writeLock(dir, { pid: process.pid });
  await assert.rejects(store.commit({ ...templates(), agents: [] }), /another instance is committing/);
  assert.equal(await lockExists(dir), true, 'live lock left intact');
  await fs.rm(path.join(dir, '.writer.lock'));
  await writeLock(dir, { pid: deadPid(), hostname: 'another-host' });
  await assert.rejects(store.commit({ ...templates(), agents: [] }), /another hostname/);
  await assert.rejects(FleetStore.reclaimStaleLock({ dir }), /another hostname/);
  assert.equal(await lockExists(dir), true);
});

test('reads never need the lock and work while a live holder exists', async t => {
  const dir = path.join(await temp(t), 'root');
  const store = await FleetStore.open({ dir, kind: 'templates' });
  await store.commit(templates());
  await writeLock(dir, { pid: process.pid });
  assert.ok(await FleetStore.read({ dir, kind: 'templates' }), 'lock-free read while locked');
  await fs.rm(path.join(dir, '.writer.lock'));
});

test('corrupt lock metadata fails closed and explicit reclaim refuses it', async t => {
  const dir = path.join(await temp(t), 'root');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.writer.lock'), 'not json');
  const store = await FleetStore.open({ dir, kind: 'templates' });
  await assert.rejects(store.commit(templates()), /writer lock held/);
  await assert.rejects(FleetStore.reclaimStaleLock({ dir }), /corrupt writer lock/);
});

test('reclaimStaleLock returns false when absent and true only for verified stale locks', async t => {
  const dir = path.join(await temp(t), 'root');
  assert.equal(await FleetStore.reclaimStaleLock({ dir }), false);
  await writeLock(dir, { pid: deadPid() });
  assert.equal(await FleetStore.reclaimStaleLock({ dir }), true);
  assert.equal(await lockExists(dir), false);
});

test('in-process commits serialize through the queue and the last pointer wins cleanly', async t => {
  const dir = await temp(t);
  const store = await FleetStore.open({ dir, kind: 'workspace' });
  const [a, b] = await Promise.all([store.commit(workspace([ticket('one')])), store.commit(workspace([ticket('two')]))]);
  assert.notEqual(a, b);
  const read = await store.read();
  assert.deepEqual(read.tickets.map(item => item.id), ['two'], 'second commit serialized after the first');
});

test('invalid JSON values and identity mismatches are rejected before any write', async t => {
  const dir = await temp(t);
  const store = await FleetStore.open({ dir, kind: 'workspace' });
  await assert.rejects(store.commit(workspace([ticket('one', Number.NaN)])), /lossless/);
  await assert.rejects(store.commit(workspace([{ ...ticket('one'), workspaceId: 'beta' }])), /does not match/);
  assert.equal(await lockExists(dir), false);
  assert.equal(await store.read(), null);
  assert.throws(() => validateTemplates(jsonClone({ schemaVersion: 3, agents: [], flows: [] })), /schemaVersion/);
  assert.throws(() => validateWorkspaceState(jsonClone({ ...workspace(), id: '' })), /nonempty/);
});

test('transaction callback reads the latest committed state under the chain lock', async t => {
  const dir = path.join(await temp(t), 'workspace'), first = await FleetStore.open({ dir, kind: 'workspace' }), second = await FleetStore.open({ dir, kind: 'workspace' });
  await first.commit({ schemaVersion: 2, id: 'alpha', tickets: [] });
  await Promise.all([first.transaction(state => ({ ...state, tickets: [...state.tickets, ticket('one')] })), second.transaction(state => ({ ...state, tickets: [...state.tickets, ticket('two')] }))]);
  assert.deepEqual((await first.read()).tickets.map(t => t.id), ['one', 'two']);
  const before = await first.read(); await assert.rejects(first.transaction(() => { throw new Error('domain rejected'); }), /domain rejected/); assert.deepEqual(await first.read(), before);
});

test('independent Node processes use file-lock read-modify-write without lost Tickets', async t => {
  const base = await temp(t), rootPath = path.join(base, 'root'), workspacePaths = { shared: path.join(base, 'shared') };
  const serviceUrl = new URL('../src/fleet-service.js', import.meta.url).href;
  const run = label => new Promise((resolve, reject) => {
    const script = `import { FleetService } from ${JSON.stringify(serviceUrl)}; const adapter = {async create(){throw Error('no execution');},async submit(){},async inspect(){},async cancel(){},async message(){}}; const service = await FleetService.open({rootPath:${JSON.stringify(rootPath)},workspacePaths:${JSON.stringify(workspacePaths)},adapter,autoStart:false}); try { for(let i=0;i<4;i++) await service.saveDraftTicket('shared',{id:${JSON.stringify(label)}+i,plan:{goal:${JSON.stringify(label)}+i}}); } finally { await service.close(); }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' }); child.once('error', reject); child.once('exit', code => resolve(code));
  });
  const results = await Promise.allSettled([run('left-'), run('right-')]); for (const result of results) { assert.equal(result.status, 'fulfilled'); assert.equal(result.value, 0); }
  const state = await FleetStore.read({ dir: path.join(workspacePaths.shared, '.fleet'), kind: 'workspace' }); assert.equal(state.schemaVersion, 2); assert.equal(state.tickets.length, 8); assert.equal(new Set(state.tickets.map(t => t.id)).size, 8);
});
