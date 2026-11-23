// Actual filesystem and FleetService; Host registry/timers/adapters are isolated doubles.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createFleetRuntimeLifecycle, resolveFleetRoot } from '../src/fleet-runtime-lifecycle.js';
import { FleetService } from '../src/fleet-service.js';
import { FleetStore } from '../src/fleet-store.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const plan = () => ({ goal: 'runtime fixture', agents: { writer: { profile: { instructions: 'fixture only' } } }, nodes: [{ id: 'a', agentId: 'writer', task: { prompt: 'fixture task' } }], gates: [] });
function clock() {
  let next = 0; const timers = new Map();
  return { timers, set(cb) { const id = ++next; timers.set(id, cb); return id; }, clear(id) { timers.delete(id); }, async fire() { const entry = timers.entries().next().value; assert(entry); timers.delete(entry[0]); await entry[1](); } };
}
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-runtime-test-')), profileDir = path.join(temp, 'profile'), rootPath = resolveFleetRoot({ profileDir, envRoot: null }), alpha = path.join(temp, 'alpha'), nested = path.join(alpha, 'nested'), missing = path.join(temp, 'missing');
  await fs.mkdir(nested, { recursive: true }); const workspaces = new Map([['a', { id: 'a', path: alpha, sessionIds: [] }], ['child', { id: 'child', path: nested, sessionIds: [] }], ['missing', { id: 'missing', path: missing, sessionIds: [] }]]), timers = clock(), opens = [], warnings = [], calls = [], hooks = {}, sessions = new Map(), instances = [];
  const adapter = {
    async create(input) { calls.push(['create', input]); await hooks.create?.(input); const sessionId = `s-${sessions.size + 1}`; sessions.set(sessionId, { status: 'unknown' }); return { sessionId }; },
    async submit(input) { calls.push(['submit', input]); sessions.set(input.sessionId, { status: 'running' }); return { messageId: input.requestId }; },
    async message(input) { calls.push(['message', input]); },
    async inspect(input) { calls.push(['inspect', input]); return sessions.get(input.sessionId) ?? { status: 'unknown' }; },
    async recover(input) { calls.push(['recover', input]); },
    async cancel(input) { calls.push(['cancel', input]); return { stopped: true }; }
  };
  const base = { profileDir, envRoot: null, adapter, workspaceRegistry: { get: id => workspaces.get(id), list: () => [...workspaces.values()] }, setTimer: timers.set, clearTimer: timers.clear, logger: { warn: message => warnings.push(message) }, openService: async options => { opens.push(options); await hooks.open?.(options); return FleetService.open(options); } };
  const make = (overrides = {}) => { const life = createFleetRuntimeLifecycle({ ...base, ...overrides }); instances.push(life); return life; };
  async function seed(paths = { a: alpha, child: nested }) { return FleetService.open({ rootPath, workspacePaths: paths, adapter, autoStart: false }); }
  t.after(async () => { for (const life of instances) await life.close(); const target = path.resolve(temp); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert(path.basename(target).startsWith('fleet-runtime-test-')); assert(!(await fs.lstat(target)).isSymbolicLink()); await fs.rm(target, { recursive: true, force: true }); });
  return { temp, profileDir, rootPath, alpha, nested, workspaces, timers, opens, warnings, calls, hooks, make, seed };
}

test('Root is Profile-owned and stable across package locations, with explicit config then environment precedence', async t => {
  const f = await fixture(t), expected = path.join(f.profileDir, 'fleet-packages', 'fleet-global');
  assert.equal(resolveFleetRoot({ profileDir: f.profileDir, envRoot: null }), expected);
  assert.equal(resolveFleetRoot({ profileDir: f.profileDir, envRoot: path.join(f.temp, 'env') }), path.join(f.temp, 'env'));
  assert.equal(resolveFleetRoot({ profileDir: f.profileDir, envRoot: path.join(f.temp, 'env'), rootPath: f.rootPath }), f.rootPath);
  assert.throws(() => resolveFleetRoot({ profileDir: f.profileDir, envRoot: null, rootPath: 'relative' }), /absolute/);
  assert.throws(() => resolveFleetRoot({ envRoot: null }), /profileContext/);
  const old = path.join(f.profileDir, 'fleet-root'); await fs.mkdir(old, { recursive: true }); await fs.writeFile(path.join(old, 'preserve.txt'), 'old Root remains untouched');
  const life = f.make(); await life.start(); assert.equal((await life.getService({ readOnly: true })).health.paths.rootPath, expected); assert.equal(await fs.readFile(path.join(old, 'preserve.txt'), 'utf8'), 'old Root remains untouched');
  await assert.rejects(fs.stat(path.join(expected, 'preserve.txt')), { code: 'ENOENT' });
});

test('cold start loads existing Tickets in legitimate nested Host Workspaces and omits missing paths', async t => {
  const f = await fixture(t), seed = await f.seed(); await seed.saveDraftTicket('a', { id: 'parent', plan: { goal: 'parent' } }); await seed.saveDraftTicket('child', { id: 'child', plan: { goal: 'child' } }); await seed.close();
  const life = f.make(); await life.start(); const service = await life.getService({ readOnly: true });
  assert.equal((await service.read('a', 'parent')).plan.goal, 'parent'); assert.equal((await service.read('child', 'child')).plan.goal, 'child'); assert.deepEqual(f.opens[0].workspacePaths, { a: f.alpha, child: f.nested }); assert.equal(f.opens[0].autoStart, false); assert.equal(f.timers.timers.size, 1); assert.equal(f.calls.length, 0);
});

test('readonly access never opens, retries, discovers new Workspaces or writes pointers; lifecycle sync loads new Tickets', async t => {
  const f = await fixture(t), life = f.make(); await assert.rejects(life.getService({ readOnly: true }), /not initialized/); assert.equal(f.opens.length, 0); await life.start();
  const service = await life.getService({ readOnly: true }); await service.saveDraftTicket('a', { id: 'original', plan: { goal: 'original' } }); const pointer = await fs.readFile(path.join(f.alpha, '.fleet/current.json'), 'utf8');
  const newPath = path.join(f.temp, 'new'); await fs.mkdir(newPath); const seed = await f.seed({ fresh: newPath }); await seed.saveDraftTicket('fresh', { id: 'persisted', plan: { goal: 'fresh' } }); await seed.close(); f.workspaces.set('fresh', { id: 'fresh', path: newPath, sessionIds: [] });
  assert.equal(await life.getService({ readOnly: true }), service); assert.deepEqual(await service.read('fresh'), []); assert.equal(service.health.paths.workspacePaths.fresh, undefined); assert.equal(await fs.readFile(path.join(f.alpha, '.fleet/current.json'), 'utf8'), pointer); assert.equal(f.opens.length, 1);
  await f.timers.fire(); assert.equal((await service.read('fresh', 'persisted')).plan.goal, 'fresh'); assert.equal(await fs.readFile(path.join(f.alpha, '.fleet/current.json'), 'utf8'), pointer); assert.equal(f.calls.length, 0);
});

test('failed eager initialization stays visible and readonly getters never retry it', async t => {
  const f = await fixture(t); f.hooks.open = async () => { throw new Error('failed fixture open'); }; const life = f.make(); await life.start();
  await assert.rejects(life.getService({ readOnly: true }), /failed fixture open/); await assert.rejects(life.getService({ readOnly: true }), /failed fixture open/); assert.equal(f.opens.length, 1); assert.equal(f.timers.timers.size, 0); assert.match(f.warnings[0], /failed fixture open/);
});

test('native removal during Session creation blocks submit and next lifecycle sync detaches without deleting history', async t => {
  const f = await fixture(t), seed = await f.seed(); await seed.saveDraftTicket('a', { id: 't', plan: plan() }); await seed.human('a', 'user', 'start', ['t']); await seed.close();
  const life = f.make(); await life.start(); const service = await life.getService({ readOnly: true }), entered = deferred(), release = deferred(); f.hooks.create = async () => { entered.resolve(); await release.promise; };
  const ticking = f.timers.fire(); await entered.promise; f.workspaces.delete('a'); release.resolve(); await ticking; assert.equal(f.calls.filter(([m]) => m === 'create').length, 1); assert.equal(f.calls.filter(([m]) => m === 'submit').length, 0);
  await f.timers.fire(); assert.equal(service.health.paths.workspacePaths.a, undefined); assert.equal((await FleetStore.read({ dir: path.join(f.alpha, '.fleet'), kind: 'workspace' })).tickets[0].id, 't');
});

test('unload drains initialization, clears timers and denies late access without reopening', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); f.hooks.open = async () => { entered.resolve(); await release.promise; }; const life = f.make(); const starting = life.start(); await entered.promise;
  let done = false; const closing = life.close().then(() => { done = true; }); await Promise.resolve(); assert.equal(done, false); release.resolve(); await Promise.all([starting, closing]); assert.equal(f.timers.timers.size, 0); assert.equal(f.opens.length, 1); await assert.rejects(life.getService(), /closing/); assert.equal(f.calls.length, 0);
});

test('unload during external creation drains the in-flight cycle and prevents submit or another timer', async t => {
  const f = await fixture(t), seed = await f.seed(); await seed.saveDraftTicket('a', { id: 't', plan: plan() }); await seed.human('a', 'user', 'start', ['t']); await seed.close();
  const life = f.make(); await life.start(); const entered = deferred(), release = deferred(); f.hooks.create = async () => { entered.resolve(); await release.promise; }; const ticking = f.timers.fire(); await entered.promise;
  let done = false; const closing = life.close().then(() => { done = true; }); await Promise.resolve(); assert.equal(done, false); release.resolve(); await Promise.all([ticking, closing]); assert.equal(f.calls.filter(([name]) => name === 'submit').length, 0); assert.equal(f.timers.timers.size, 0);
});

test('readonly legacy running history is loaded without native dispatch and does not reserve new execution slots', async t => {
  const f = await fixture(t), store = await FleetStore.open({ dir: path.join(f.alpha, '.fleet'), kind: 'workspace' });
  const old = { id: 'old', workspaceId: 'a', status: 'running', revision: 3, goal: 'legacy running', inputs: {}, criteria: [], plan: null, snapshot: { goal: 'old', inputs: {}, criteria: [], agents: { writer: { id: 'writer', revision: 1, profile: { instructions: 'old' } } }, orchestration: { id: 'old-flow', revision: 1, definition: { nodes: [{ id: 'a', role: 'writer', task: { prompt: 'old' } }], gates: [] } }, binding: { orchestrationId: 'old-flow', roleAgents: { writer: 'writer' } } }, nodes: [{ id: 'a', role: 'writer', task: { prompt: 'old' }, status: 'running', thread: [], attempts: [{ id: 'attempt', status: 'running', sessionId: 'old-native-session', nodeRevision: 1 }] }], gates: [], events: [], changes: [] };
  await store.commit({ schemaVersion: 1, id: 'a', definitions: { agents: [], flows: [] }, binding: null, tickets: [old] }); await store.close(); const before = await fs.readFile(path.join(f.alpha, '.fleet/current.json'), 'utf8');
  const life = f.make({ maxParallel: 1 }); await life.start(); await f.timers.fire(); const service = await life.getService({ readOnly: true }), ticket = await service.read('a', 'old'); assert.equal(ticket.execution.legacy.readOnly, true); assert.equal(ticket.execution.nodes.a.attempts[0].sessionId, 'old-native-session'); assert.equal(f.calls.length, 0); assert.equal(await fs.readFile(path.join(f.alpha, '.fleet/current.json'), 'utf8'), before);
  await service.saveDraftTicket('a', { id: 'new', plan: plan() }); await service.human('a', 'user', 'start', ['new']); await f.timers.fire(); assert.equal(f.calls.filter(([name]) => name === 'create').length, 1); assert.equal(f.calls.filter(([name]) => name === 'submit').length, 1); assert.equal(f.calls.some(([, input]) => input.sessionId === 'old-native-session'), false);
});
