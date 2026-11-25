import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { FleetService } from '../src/fleet-service.js';
import { FleetStore, ticketFilename } from '../src/fleet-store.js';
import { normalizePlan, projectTicket } from '../src/fleet-model.js';
import { registerFleetDashboardApi } from '../src/fleet-dashboard-api.js';

// All filesystem state is test-owned; no Profile, server, Desktop or real Agent.
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const plan = (prefix = 'alpha', ticketId = 'ticket', reviewer = 'human') => normalizePlan({
  goal: `Deliver ${prefix}`, inputs: { source: prefix, local: { label: prefix } }, criteria: ['verified\nwith evidence'], deliverables: ['report'],
  agents: { [`${prefix}-writer`]: { profile: { instructions: `Write ${prefix}`, agentPreset: 'fixture-preset' } } },
  nodes: [{ id: 'build', role: 'writer', agentId: `${prefix}-writer`, task: { prompt: `Build ${prefix}`, preserve: { structured: true } } }, { id: 'ship', role: 'writer', agentId: `${prefix}-writer`, task: { prompt: `Ship ${prefix}` } }],
  gates: [{ id: 'quality', from: ['build'], to: ['ship'], reviewer: reviewer === 'human' ? { kind: 'human' } : { kind: 'agent', nodeId: 'ship' } }]
});
function adapterFixture() {
  const calls = [], sessions = new Map();
  return { calls, sessions, adapter: {
    async create(input) { calls.push(['create', input]); const sessionId = `fixture-${sessions.size + 1}`; sessions.set(sessionId, { status: 'unknown' }); return { sessionId }; },
    async submit(input) { calls.push(['submit', input]); sessions.set(input.sessionId, { status: 'running' }); return { messageId: input.requestId }; },
    async inspect(input) { calls.push(['inspect', input]); return structuredClone(sessions.get(input.sessionId) ?? { status: 'unknown' }); },
    async cancel(input) { calls.push(['cancel', input]); sessions.set(input.sessionId, { status: 'stopped' }); return { stopped: true }; },
    async message(input) { calls.push(['message', input]); return { messageId: input.requestId }; },
    async modelCatalog() { return structuredClone(modelCatalogFixture); }
  } };
}
const modelCatalogFixture = { default: { provider: 'fixture', model: 'fixture-model' }, routableProviders: ['fixture'], groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'fixture-model', name: 'Fixture model', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }] }], failures: [] };
function registryFixture(locations) {
  const workspaces = new Map(Object.entries(locations).map(([id, location]) => [id, { id, path: location, sessionIds: [] }]));
  const routes = new Map(), registered = [], removed = [];
  const ctx = {
    workspaceRegistry: { get: id => workspaces.get(id), list: () => [...workspaces.values()] },
    agentPresets: { list: async () => [{ id: 'fixture-preset', title: 'Fixture preset' }] },
    connection: { fetch: { register(route) {
      assert(!routes.has(route.path)); registered.push(route); routes.set(route.path, route);
      return () => { removed.push(route.path); routes.delete(route.path); };
    } } }
  };
  return { ctx, workspaces, routes, registered, removed };
}
const ownedTemps = new Set();
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-dashboard-test-'));
  ownedTemps.add(temp);
  const rootPath = path.join(temp, 'root');
  const locations = Object.fromEntries(['alpha', 'beta', 'empty', 'missing'].map(id => [id, path.join(temp, id)]));
  await Promise.all(['alpha', 'beta', 'empty'].map(id => fs.mkdir(locations[id])));
  const host = adapterFixture(), h = registryFixture(locations), disposers = [];
  const service = await FleetService.open({ rootPath, workspacePaths: {}, adapter: host.adapter, autoStart: false });
  const calls = { getService: [], register: [], saveDraftTicket: [], human: [], read: [], catalog: 0 };
  const wrapped = {
    get health() { return service.health; },
    async registerWorkspace(...args) { calls.register.push(args); return service.registerWorkspace(...args); },
    async saveDraftTicket(...args) { calls.saveDraftTicket.push(args); return service.saveDraftTicket(...args); },
    async listDraftTickets(...args) { return service.listDraftTickets(...args); },
    readSeries: (...args) => service.readSeries(...args),
    readOverviewProject: (...args) => service.readOverviewProject(...args),
    scheduleStatus: () => service.scheduleStatus(),
    saveDraftWithScope: (...args) => service.saveDraftWithScope(...args),
    seriesCreate: (...args) => service.seriesCreate(...args),
    seriesPause: (...args) => service.seriesPause(...args),
    seriesResume: (...args) => service.seriesResume(...args),
    seriesDelete: (...args) => service.seriesDelete(...args),
    seriesUpdate: (...args) => service.seriesUpdate(...args),
    async human(...args) { calls.human.push(args); return service.human(...args); },
    async read(...args) { calls.read.push(args); return service.read(...args); },
    attemptProgress: (...args) => service.attemptProgress(...args),
    async catalog() { calls.catalog++; return service.catalog(); },
    async modelCatalog() { return service.modelCatalog(); }
  };
  const hooks = {};
  const getService = async options => { calls.getService.push(options); if (hooks.getService) return hooks.getService(options); return wrapped; };
  const dispose = registerFleetDashboardApi(h.ctx, { getService });
  disposers.push(dispose);
  t.after(async () => {
    for (const cleanup of disposers) await cleanup();
    await service.close();
    // Check the exact existing test-owned target before recursive removal.
    const resolved = path.resolve(temp);
    assert.equal(temp, resolved); assert(ownedTemps.has(resolved));
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('fleet-dashboard-test-'));
    const info = await fs.lstat(resolved); assert(info.isDirectory()); assert(!info.isSymbolicLink());
    await fs.readdir(resolved); await fs.rm(resolved, { recursive: true, force: true });
    ownedTemps.delete(resolved);
  });
  async function request(url = '/api/fleet/view?workspaceId=alpha', { method = 'GET', body, raw = false, owner = true } = {}) {
    const request = new Request(`http://fleet.fixture${url}`, { method,
      ...(body !== undefined ? { body: raw ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
    // The actual connection registry admits authenticated owners before dispatch.
    const route = h.routes.get(new URL(request.url).pathname);
    const response = !owner ? Response.json({ error: 'owner required' }, { status: 401 })
      : route ? await route.fetch(request) : Response.json({ error: 'not found' }, { status: 404 });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  const action = (action, args = {}, workspaceId = 'alpha') => request('/api/fleet/action', { method: 'POST', body: { workspaceId, action, ...args } });
  async function seed(ws = 'alpha', ticketId = 'ticket', reviewer) {
    await service.registerWorkspace(ws, locations[ws]);
    return service.saveDraftTicket(ws, { id: ticketId, sessionId: `seed-${ticketId}`, plan: plan(ws, ticketId, reviewer), actor: { kind: 'system', via: 'test-seed' } });
  }
  async function templates(prefix = 'alpha') {
    const p = plan(prefix);
    await service.human(prefix, 'seed', 'saveTemplate', [{ id: `${prefix}-writer`, kind: 'agent', content: p.agents[`${prefix}-writer`] }]);
    await service.human(prefix, 'seed', 'saveTemplate', [{ id: `${prefix}-flow`, kind: 'orchestration', content: { nodes: p.nodes, gates: p.gates } }]);
  }
  const projected = async (ws, id) => projectTicket(await service.read(ws, id));
  return { ...h, temp, rootPath, locations, service, host, calls, hooks, wrapped, request, action, seed, templates, projected, dispose, disposers };
}
test('draft-delete validates scope and revision and commits removal across dashboard reads and reopen', async t => {
  const f = await fixture(t), target = await f.seed(), other = await f.seed('beta');
  const args = { ticketId: target.id, expectedRevision: target.revision };
  const remove = (fields = args, ws = 'alpha') => f.action('draft-delete', fields, ws);
  error(await remove({ticketId: target.id}), 400, 'invalid-request');
  error(await remove({...args, expectedRevision: 0}), 400, 'invalid-request');
  error(await remove({...args, sessionId: 'injected'}), 400, 'invalid-request');
  const foreign = await f.seed('alpha', 'foreign-only');
  error(await remove({ticketId: foreign.id, expectedRevision: 1}, 'beta'), 404, 'unknown-ticket');
  const dependent = await f.service.saveDraftTicket('alpha', {plan: {goal:'Dependent', ticketDependencies:[target.id]}});
  const another = await f.service.saveDraftTicket('alpha', {plan: {goal:'A different goal', title:'Named Ticket', ticketDependencies:[target.id]}});
  const blocked = await remove();
  error(blocked, 409, 'ticket-referenced');
  assert.deepEqual(blocked.body.error.references, [
    {kind:'ticket', id:dependent.id, title:'Dependent'}, {kind:'ticket', id:another.id, title:'Named Ticket'}
  ]);
  assert(f.service.health.ready);
  for (const ticket of [dependent, another]) ok(await remove({ticketId:ticket.id, expectedRevision:ticket.revision}));
  const abandoned = ok(await f.action('abandon', args)).result;
  error(await remove(), 409, 'stale-revision');
  const dir = path.join(f.locations.alpha, '.fleet');
  const pointer = async () => JSON.parse(await fs.readFile(path.join(dir, 'current.json'), 'utf8')).revision;
  const priorGeneration = await pointer();
  assert.deepEqual(ok(await remove({...args, expectedRevision: abandoned.revision})), {
    schemaVersion: 1, workspaceId: 'alpha', action: 'draft-delete', result: {deletedTicketId: target.id}
  });
  error(await remove(), 404, 'unknown-ticket');
  const legacy = await f.service.saveDraftTicket('alpha', {plan: {goal:'Replaced draft'}});
  const replaced = await f.service.human('alpha', 'test', 'regenerateTicket', [legacy.id, legacy.revision, {goal:'Replacement draft'}]);
  const predecessor = await f.projected('alpha', legacy.id);
  assert.equal(predecessor.supersededBy, replaced.id);
  assert.deepEqual(ok(await remove({ticketId:replaced.id, expectedRevision:replaced.revision})).result, {deletedTicketId: replaced.id});
  error(await f.request(`/api/fleet/view?workspaceId=alpha&ticketId=${replaced.id}`), 404, 'unknown-ticket');
  const released = await f.projected('alpha', legacy.id);
  assert.equal(released.supersededBy, undefined);
  assert.equal(released.replacementDeleted.ticketId, replaced.id);
  assert.equal(released.activity.at(-1).type, 'replacement-deleted');
  assert.equal(released.status, 'superseded');
  error(await remove({ticketId:legacy.id, expectedRevision:released.revision}), 409, 'control-locked');
  error(await f.request('/api/fleet/view?workspaceId=alpha&ticketId=ticket'), 404, 'unknown-ticket');
  error(await f.request('/api/fleet/drafts?workspaceId=alpha&draftId=ticket'), 404, 'unknown-draft');
  assert.deepEqual(ok(await f.request('/api/fleet/view?workspaceId=alpha')).tickets.map(x => x.id), [foreign.id, legacy.id]);
  const project = ok(await f.request('/api/fleet/overview')).projects.find(p => p.workspaceId === 'alpha');
  assert.deepEqual(project.tickets.map(row => row.id), [foreign.id, legacy.id]);
  assert.deepEqual(await f.service.read('beta', other.id), other);
  const persisted = await FleetStore.read({dir, kind: 'workspace'});
  const ticketBody = generation => path.join(dir, 'generations', generation, 'tickets', ticketFilename(target.id));
  await assert.rejects(fs.stat(ticketBody(await pointer())), {code:'ENOENT'});
  assert.deepEqual(JSON.parse(await fs.readFile(ticketBody(priorGeneration), 'utf8')), abandoned);
  assert.deepEqual(persisted.tickets.map(t => t.id), [foreign.id, legacy.id]);
  assert.equal(persisted.tickets.at(-1).supersededBy, undefined);
  assert.equal(persisted.tickets.at(-1).replacementDeleted.ticketId, replaced.id);
  const reopened = await FleetService.open({rootPath:f.rootPath, workspacePaths:{alpha:f.locations.alpha}, adapter:f.host.adapter, autoStart:false});
  try {
    assert.deepEqual((await reopened.listDraftTickets('alpha')).map(t => t.id), [foreign.id]);
    assert.equal((await reopened.read('alpha', legacy.id)).replacementDeleted.ticketId, replaced.id);
  } finally { await reopened.close(); }
  assert.deepEqual(f.host.calls, []);
});
test('dashboard instantiates an originless draft, saves it, manages a series and shows its source', async t => {
  const f = await fixture(t);
  await f.templates(); await f.service.registerWorkspace('alpha', f.locations.alpha);
  const inputs = {templateId:'alpha-flow',assignments:{},overrides:{goal:'Dashboard schedule'}};
  const draft = ok(await f.action('template-instantiate', inputs)).result;
  assert.equal(draft.originSessionId, null);
  const saved = ok(await f.action('draft-save', {ticketId:draft.id,expectedRevision:1,sessionId:null,plan:{...draft.plan,title:'handmade'}})).result;
  assert.equal(saved.plan.title,'handmade');
  const p = {name:'Weekly',timing:{kind:'weekly',weekly:{time:'09:00',time_zone:'Asia/Shanghai',weekdays:[1]}}};
  error(await f.action('series-create',{...p,sourceTicketId:draft.id}),409,'unsupported-profile');
  const host = {id:'weekly-host',target:{sessionId:'reserved'},status:'active',scheduledAt:'2026-11-23T01:00:00.000Z'};
  f.host.adapter.scheduleCreate = async request => {assert.deepEqual(request.timing,p.timing);return host;};
  f.host.adapter.scheduleEdit = async request => request.action === 'delete' ? {deleted:true} : {...host,status:request.patch.active?'active':'paused'};
  const series = ok(await f.action('series-create',{...p,...inputs})).result;
  assert.equal(series.sourceTemplateId,'alpha-flow');
  const view = ok(await f.request());
  assert.equal(view.series.available,true); assert.equal(view.series.items[0].id,series.id);
  const member = view.tickets.find(row => row.id === series.sourceTicketId);
  assert.equal(member.series.role,'source');
  f.host.adapter.scheduleView=async()=>host;
  host.kind='after'; host.afterSeconds=600;
  await f.service.tick();
  assert.equal(ok(await f.request()).tickets.find(ticket=>ticket.id===member.id).series.recurrence,'once');
  Object.assign(host,{kind:'daily',time:'10:00:00',timeZone:'UTC'});
  await f.service.tick();
  assert.equal(ok(await f.request()).tickets.find(ticket=>ticket.id===member.id).series.recurrence,'recurring');
  const edit = {ticketId:member.id,expectedRevision:1,plan:{...member.plan,title:'shared'}};
  error(await f.action('draft-save',edit),409,'scope-required');
  const scoped = ok(await f.action('draft-save',{...edit,scope:'series',seriesId:series.id,expectedSeriesRevision:series.revision})).result;
  assert.equal(scoped.series.plan.title,'shared');
  assert.equal(ok(await f.action('series-update',{seriesId:series.id,expectedRevision:scoped.series.revision,fields:{goal:'changed'}})).result.plan.goal,'changed');
  for(const [action,status] of [['series-pause','paused'],['series-resume','active'],['series-delete','ended']]) assert.equal(ok(await f.action(action,{seriesId:series.id})).result.status,status);
});
test('Dashboard arms a saved dependency revision, shows the waiting ID, and withdraws authorization', async t => {
  const f = await fixture(t);
  const source = await f.seed('alpha', 'collect-index');
  const consumer = await f.service.saveDraftTicket('alpha', {
    id: 'analyze-index', plan: {...plan(), ticketDependencies: [source.id]}
  });
  f.wrapped.dashboardTickets = ws => f.service.dashboardTickets(ws);
  const command = {ticketId: consumer.id, expectedRevision: consumer.revision};
  error(await f.action('dependency-enable', {ticketId: consumer.id}), 400, 'invalid-request');
  const enable = await f.action('dependency-enable', command);
  ok(enable);
  const selected = ok(await f.request(`/api/fleet/view?workspaceId=alpha&ticketId=${consumer.id}`)).selectedTicket;
  assert.equal(selected.status, 'draft');
  assert.deepEqual(selected.dependencyReadiness.waitingTicketIds, [source.id]);
  assert.ok(selected.dependencyAuthorization);
  ok(await f.action('dependency-disable', {...command, expectedRevision:selected.revision}));
  assert.ok(!(await f.service.read('alpha', consumer.id)).dependencyAuthorization);
  assert.equal(f.host.calls.length, 0);
});
async function files(directory) {
  const result = {};
  async function visit(location, relative = '') {
    for (const entry of (await fs.readdir(location, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = path.join(location, entry.name), name = `${relative}${entry.name}`;
      if (entry.isDirectory()) { result[`${name}/`] = null; await visit(next, `${name}/`); }
      else result[name] = await fs.readFile(next, 'utf8');
    }
  }
  await visit(directory); return result;
}
function ok(response) { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; }
function error(response, status, code) { assert.equal(response.status, status, JSON.stringify(response.body)); assert.equal(response.body.schemaVersion, 1); assert.equal(response.body.error.code, `fleet/${code}`); assert(response.body.error.message); }

// A pure read should not even add a Store mapping for the Host's empty Workspace.
test('authenticated exact routes project an empty registered Workspace and Root definitions without any mutation', async t => {
  const f = await fixture(t); await f.seed();
  const before = await files(f.temp), catalog = await f.service.catalog(), health = f.service.health;
  assert.deepEqual(f.registered.map(({ path, methods, requestBody }) => ({ path, methods, requestBody })), [
    { path: '/api/fleet/drafts', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/fleet/view', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/fleet/action', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/fleet/progress', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/fleet/overview', methods: ['GET'], requestBody: 'buffered' }
  ]);
  assert(f.registered.every(route => !Object.hasOwn(route, 'public')));
  assert.equal((await f.request(undefined, { owner: false })).status, 401);
  assert.equal(f.calls.getService.length, 0);
  const view = ok(await f.request('/api/fleet/view?workspaceId=empty'));
  assert.match(view.pluginVersion, /^\d+\.\d+\.\d+/);
  assert.deepEqual(view, { schemaVersion: 1, pluginVersion: view.pluginVersion, workspaceId: 'empty', catalog: {
    templates: catalog.templates, settings: catalog.settings, agents: catalog.agents, orchestrations: catalog.orchestrations, binding: null,
    availablePresets: [{ id: 'fixture-preset', title: 'Fixture preset' }], modelCatalog: modelCatalogFixture
  }, tickets: [], series: {available:false,unavailableReason:'Host schedule service is unavailable; scheduling cannot be enabled.',items:[]}, selectedTicket: null, health: { ready: true, error: null } });
  assert.equal((await f.request('/api/fleet/view?workspaceId=empty')).cache, 'no-store');
  assert.deepEqual(f.calls.getService, [{ readOnly: true }, { readOnly: true }]);
  assert.equal(f.calls.read.length, 0); assert.equal(f.calls.register.length, 0);
  assert.equal(f.calls.saveDraftTicket.length, 0); assert.equal(f.calls.human.length, 0); assert.equal(f.host.calls.length, 0);
  assert.deepEqual(await files(f.temp), before); assert.deepEqual(f.service.health, health);
  assert.deepEqual(await f.service.catalog(), catalog);
});

test('actual snapshots, attempts, native Session IDs, Gate opinions and Root history stay scoped to one Workspace', async t => {
  const f = await fixture(t); await f.templates(); await f.seed('alpha', 'shared'); await f.seed('beta', 'shared');
  await f.service.human('alpha', 'seed-user', 'start', ['shared']); await f.service.tick();
  const a = await f.projected('alpha', 'shared');
  const sessionId = a.nodes[0].attempts[0].sessionId;
  f.host.sessions.set(sessionId, { status: 'completed', output: { text: 'actual output' } });
  await f.service.tick();
  await f.service.human('alpha', 'seed-user', 'reviewGate', ['shared', 'quality', 'returned', { reason: 'fix evidence' }]);
  await f.service.human('alpha', 'seed-user', 'forcePassGate', ['shared', 'quality']);
  await f.service.human('alpha', 'seed-user', 'replaceRootAgent', ['alpha-writer', { instructions: 'new Root version' }]);
  const before = await files(f.temp), hostBefore = structuredClone(f.host.calls);
  const result = ok(await f.request('/api/fleet/view?workspaceId=alpha&ticketId=shared'));
  assert.deepEqual(result.tickets, (await f.service.read('alpha')).map(ticket => projectTicket(ticket)));
  assert.deepEqual(result.selectedTicket, await f.projected('alpha', 'shared'));
  assert.equal(result.selectedTicket.nodes[0].attempts[0].sessionId, sessionId);
  assert.equal(result.selectedTicket.gates[0].reviews[0].decision, 'returned');
  assert.equal(result.selectedTicket.gates[0].humanOverride.actor.kind, 'human');
  assert.equal(result.selectedTicket.snapshot.agents['alpha-writer'].profile.instructions, 'Write alpha');
  assert.equal(result.selectedTicket.snapshot.configRevision, result.selectedTicket.execution.currentConfigRevision);
  assert.equal(result.catalog.agents.find(agent => agent.id === 'alpha-writer').revision, 2);
  assert.equal(result.catalog.binding, null); assert.equal(result.selectedTicket.plan.inputs.local.label, 'alpha');
  assert(!Object.hasOwn(result.catalog, 'workspaces')); assert(!Object.hasOwn(result.health, 'paths'));
  assert.equal(ok(await f.request('/api/fleet/view?workspaceId=beta&ticketId=shared')).selectedTicket.status, 'draft');
  assert.equal(ok(await f.request()).selectedTicket, null);
  assert.equal(f.calls.register.length, 0); assert.equal(f.calls.human.length, 0);
  assert.deepEqual(await files(f.temp), before); assert.deepEqual(f.host.calls, hostBefore);
});

test('unknown, removed, missing and relocated Workspaces fail explicitly without reads or writes to another mapping', async t => {
  const f = await fixture(t); await f.seed();
  error(await f.request('/api/fleet/view?workspaceId=unknown'), 404, 'unknown-workspace');
  error(await f.request('/api/fleet/view?workspaceId=missing'), 404, 'workspace-unavailable');
  assert.equal(f.calls.getService.length, 0);
  error(await f.request('/api/fleet/view?workspaceId=empty&ticketId=ticket'), 404, 'unknown-ticket');
  error(await f.action('start', { ticketId: 'ticket' }, 'empty'), 404, 'unknown-workspace');
  f.workspaces.set('alpha', { ...f.workspaces.get('alpha'), path: f.locations.beta });
  error(await f.request(), 409, 'workspace-path-mismatch');
  error(await f.action('start', { ticketId: 'ticket' }), 409, 'workspace-path-mismatch');
  f.workspaces.delete('alpha');
  error(await f.request(), 404, 'unknown-workspace');
  assert.equal(f.calls.human.length, 0); assert.equal(f.calls.register.length, 0); assert.equal(f.host.calls.length, 0);
});

test('bad JSON, invalid IDs, spoofed context and wrong HTTP methods are rejected before service access', async t => {
  const f = await fixture(t);
  for (const suffix of ['', '?workspaceId=', '?workspaceId=alpha&workspaceId=beta', '?workspaceId=alpha&ticketId=', '?workspaceId=alpha&ticketId=a&ticketId=b', '?workspaceId=%20alpha', '?workspaceId=alpha%00', '?workspaceId=alpha&action=start']) {
    error(await f.request(`/api/fleet/view${suffix}`), 400, 'invalid-request');
  }
  for (const body of [null, [], {}, { workspaceId: 'alpha', action: 'tick' }, { workspaceId: 'alpha', action: 'start', ticketId: 1 },
    { workspaceId: 'alpha', action: 'start', ticketId: 'bad id' }, { workspaceId: 'alpha', action: 'start', ticketId: 'x', userId: 'pretend-human' },
    { workspaceId: 'alpha', action: 'change', ticketId: 'x', nodeId: 'build', task: [] },
    { workspaceId: 'alpha', action: 'review', ticketId: 'x', gateId: 'quality', decision: 'yes', evidence: 'no' },
    { workspaceId: 'alpha', action: 'review', ticketId: 'x', gateId: 'quality', decision: 'passed' }]) {
    error(await f.request('/api/fleet/action', { method: 'POST', body }), 400, 'invalid-request');
  }
  for (const [input, status, code] of [[{ ...plan(), workspacePath: 'C:/other' }, 400, 'invalid-input'], [{ ...plan(), ticket: { workspaceId: 'beta' } }, 409, 'legacy-plan'], [{ ...plan(), agents: [{ id: 'bad id', profile: {} }] }, 409, 'legacy-plan'], [{ ...plan(), contractVersion: 99 }, 409, 'unsupported-contract']]) {
    error(await f.action('draft-save', { sessionId: 's', plan: input }), status, code);
  }
  for (const body of ['{', '{"workspaceId":"alpha","action":"change","ticketId":"x","nodeId":"build","task":{"value":1e999}}',
    '{"workspaceId":"alpha","action":"change","ticketId":"x","nodeId":"build","task":{"value":-0}}']) {
    error(await f.request('/api/fleet/action', { method: 'POST', body, raw: true }), 400, 'invalid-request');
  }
  error(await f.request('/api/fleet/view?workspaceId=alpha', { method: 'POST', body: {} }), 405, 'method-not-allowed');
  error(await f.request('/api/fleet/action'), 405, 'method-not-allowed');
  error(await f.request('/api/fleet/action?workspaceId=beta', { method: 'POST', body: {} }), 400, 'invalid-request');
  assert.equal(f.calls.getService.length, 0); assert.equal(f.calls.register.length, 0); assert.equal(f.host.calls.length, 0);
  assert.equal(f.service.health.ready, true);
});

test('draft-save preserves all untouched fields, uses CAS and exposes real started status through legacy route', async t => {
  const f = await fixture(t); f.workspaces.get('alpha').sessionIds.push('conversation');
  const initial = ok(await f.action('draft-save', { sessionId: 'conversation', plan: plan() }));
  assert.equal(initial.schemaVersion, 1); assert.equal(initial.action, 'draft-save'); assert.equal(initial.workspaceId, 'alpha');
  assert.equal(initial.result.status, 'draft'); assert.deepEqual(f.calls.register, [['alpha', f.locations.alpha]]);
  const ticketId = initial.result.id; assert(ticketId); assert.equal(initial.result.revision, 1); assert.equal(initial.result.originSessionId, 'conversation');
  assert.deepEqual(initial.result.plan, (await f.service.read('alpha', ticketId)).plan);
  const drafts = ok(await f.request('/api/fleet/drafts?workspaceId=alpha&sessionId=conversation'));
  assert.deepEqual(drafts.drafts.map(d => [d.id, d.status, d.revision]), [[ticketId, 'draft', 1]]);
  const next = { ...initial.result.plan, goal: 'revised goal' };
  const revised = ok(await f.action('draft-save', { sessionId: 'conversation', ticketId, expectedRevision: 1, plan: next }));
  assert.equal(revised.result.plan.goal, 'revised goal'); assert.deepEqual({ ...revised.result.plan, goal: initial.result.plan.goal }, initial.result.plan);
  error(await f.action('draft-save', { sessionId: 'conversation', ticketId, expectedRevision: 1, plan: { ...next, goal: 'stale' } }), 409, 'stale-revision');
  assert.equal(f.host.calls.length, 0); assert.equal((await f.service.read('alpha')).length, 1);
  ok(await f.action('start', { ticketId })); assert.equal((await f.service.catalog()).templates.length, 0);
  error(await f.action('draft-save', { sessionId: 'conversation', ticketId, expectedRevision: revised.result.revision + 1, plan: { ...next, goal: 'discard' } }), 409, 'control-locked');
  assert.equal((await f.service.read('alpha', ticketId)).plan.goal, 'revised goal');
  const running = ok(await f.request('/api/fleet/drafts?workspaceId=alpha&sessionId=conversation')); assert.equal(running.drafts[0].status, 'running'); assert.equal(running.drafts[0].id, ticketId); assert.equal(Object.hasOwn(running.drafts[0], 'draftId'), false);
  assert.equal(f.host.calls.length, 0, 'the HTTP bridge never invokes tick or starts a Session itself');
  assert(f.calls.getService.some(input => input.readOnly === false));
});

test('human actions enforce running locks, stopped change CAS and immutable prior configuration with fixed provenance', async t => {
  const f = await fixture(t); await f.seed(); ok(await f.action('start', { ticketId: 'ticket' }));
  const original = await f.service.read('alpha', 'ticket'); assert.equal(original.activity.at(-1).actor.userId, 'dsh-dashboard');
  ok(await f.action('say', { ticketId: 'ticket', nodeId: 'build', message: '<script>external text is data</script>' }));
  const current = await f.service.read('alpha', 'ticket');
  error(await f.action('change', { ticketId: 'ticket', nodeId: 'build', expectedRevision: current.revision, task: { prompt: 'new task' } }), 409, 'control-locked');
  const stopped = ok(await f.action('stop', { ticketId: 'ticket' })).result; assert.equal(stopped.status, 'stopped');
  error(await f.action('change', { ticketId: 'ticket', nodeId: 'build', expectedRevision: original.revision, task: { prompt: 'stale' } }), 409, 'stale-revision');
  ok(await f.action('change', { ticketId: 'ticket', nodeId: 'build', expectedRevision: stopped.revision, task: { prompt: 'new task' } }));
  const changed = await f.service.read('alpha', 'ticket'); assert.equal(changed.execution.nodes.build.thread[0].intent, 'discussion'); assert.equal(changed.execution.nodes.build.thread[0].text, '<script>external text is data</script>');
  assert.equal(projectTicket(changed).changes.length, 1); assert.equal(changed.plan.nodes[0].task.prompt, 'new task'); assert.deepEqual(changed.execution.configurations, original.execution.configurations);
  assert.equal(ok(await f.action('resume', { ticketId: 'ticket' })).result.status, 'running'); await f.service.tick(); assert.equal(f.host.calls.filter(([method]) => method === 'create').length, 1);
  const running = await f.service.read('alpha', 'ticket'); f.host.sessions.set(running.execution.nodes.build.attempts[0].sessionId, { status: 'failed', error: 'fixture task failure' }); await f.service.tick();
  const retried = ok(await f.action('retry', { ticketId: 'ticket', nodeId: 'build', reason: 'fix evidence' })).result; assert.equal(retried.execution.nodes.build.status, 'pending'); assert.equal(retried.execution.nodes.build.attempts.length, 1); assert.equal(retried.execution.gates.quality.history.length, running.execution.gates.quality.history.length + 1);
  assert(f.calls.human.every(([ws, actor]) => ws === 'alpha' && actor === 'dsh-dashboard')); assert.equal(f.calls.register.length, 0);
});

test('human Gate review and override retain earlier opinions; Root replacements leave started snapshots intact', async t => {
  const f = await fixture(t); await f.templates(); await f.seed();
  ok(await f.action('start', { ticketId: 'ticket' }));
  error(await f.action('review', { ticketId: 'ticket', gateId: 'quality', decision: 'passed', evidence: 'too early' }), 409, 'not-reviewable');
  await f.service.tick();
  const started = await f.projected('alpha', 'ticket');
  f.host.sessions.set(started.nodes[0].attempts[0].sessionId, { status: 'completed', output: { artifact: 'real.txt' } });
  await f.service.tick();
  const reviewed = ok(await f.action('review', { ticketId: 'ticket', gateId: 'quality', decision: 'returned', evidence: { checks: ['missing check'] } })).result;
  assert.equal(reviewed.status, 'returned');
  const passed = ok(await f.action('pass', { ticketId: 'ticket', gateId: 'quality' })).result;
  assert.equal(passed.humanOverride.actor.userId, 'dsh-dashboard'); assert.equal(passed.reviews[0].decision, 'returned');
  const agent = ok(await f.action('root-agent', { agentId: 'alpha-writer', profile: { instructions: 'Root replacement' } })).result;
  const flow = ok(await f.action('root-flow', { orchestrationId: 'alpha-flow', definition: { nodes: [{ id: 'new-node', role: 'writer' }] } })).result;
  assert.equal(agent.revision, 2); assert.equal(flow.revision, 2);
  assert.equal(agent.history[0].actor.userId, 'dsh-dashboard');
  assert.deepEqual((await f.projected('alpha', 'ticket')).snapshot, started.snapshot);
  error(await f.action('root-agent', { agentId: 'missing', profile: {} }), 404, 'unknown-agent');
  error(await f.action('root-flow', { orchestrationId: 'alpha-flow', definition: { nodes: [{ id: 'x', role: 'writer', dependsOn: ['x'] }] } }), 400, 'invalid-flow');
  assert.equal(f.service.health.ready, true);
});

test('Ticket, Node and Gate association is checked before human mutations and cross-Workspace IDs do not resolve', async t => {
  const f = await fixture(t); await f.seed('alpha'); await f.seed('beta', 'beta-only');
  const before = await files(f.temp);
  error(await f.request('/api/fleet/view?workspaceId=alpha&ticketId=beta-only'), 404, 'unknown-ticket');
  error(await f.action('start', { ticketId: 'beta-only' }), 404, 'unknown-ticket');
  error(await f.action('say', { ticketId: 'ticket', nodeId: 'foreign-node', message: 'hello' }), 404, 'unknown-node');
  error(await f.action('pass', { ticketId: 'ticket', gateId: 'foreign-gate' }), 404, 'unknown-gate');
  assert.equal(f.calls.human.length, 0); assert.equal(f.calls.register.length, 0);
  assert.deepEqual(await files(f.temp), before);
});

test('service, catalog and preset failures are visible and a faulty service remains readable but rejects actions', async t => {
  const f = await fixture(t);
  f.hooks.getService = () => { throw new Error('Set an absolute FLEET_ROOT before using Fleet.'); };
  error(await f.request(), 503, 'service-unavailable');
  error(await f.action('draft-save', { sessionId: 's', plan: plan() }), 503, 'service-unavailable');
  delete f.hooks.getService;
  const original = f.wrapped.catalog;
  f.wrapped.catalog = () => { throw new Error('catalog read failed'); };
  error(await f.request(), 500, 'service-error');
  f.wrapped.catalog = original;
  f.ctx.agentPresets.list = () => { throw new Error('preset registry failed'); };
  error(await f.request(), 500, 'service-error');
  delete f.ctx.agentPresets.list;
  assert.deepEqual(ok(await f.request()).catalog.availablePresets, []);
  f.hooks.getService = () => ({ ...f.wrapped, health: { ...f.service.health, ready: false, error: 'fixture persistence fault' } });
  assert.deepEqual(ok(await f.request()).health, { ready: false, error: 'fixture persistence fault' });
  error(await f.action('draft-save', { sessionId: 's', plan: plan() }), 503, 'service-unavailable');
  assert.equal(f.calls.register.length, 0); assert.equal(f.calls.saveDraftTicket.length, 0);
});

test('registry removal or path change during an awaited request is rechecked before returning data or accepting an action', async t => {
  const f = await fixture(t); await f.seed();
  for (const mutation of ['remove', 'move']) {
    const entered = deferred(), release = deferred();
    const saved = f.workspaces.get('alpha');
    f.hooks.getService = async () => { entered.resolve(); await release.promise; return f.wrapped; };
    const response = f.action('start', { ticketId: 'ticket' });
    await entered.promise;
    if (mutation === 'remove') f.workspaces.delete('alpha');
    else f.workspaces.set('alpha', { ...saved, path: f.locations.beta });
    release.resolve();
    error(await response, mutation === 'remove' ? 404 : 409, mutation === 'remove' ? 'unknown-workspace' : 'workspace-changed');
    f.workspaces.set('alpha', saved);
  }
  delete f.hooks.getService;
  const original = f.ctx.agentPresets.list;
  f.ctx.agentPresets.list = async () => { f.workspaces.delete('alpha'); return original(); };
  error(await f.request(), 404, 'unknown-workspace');
  assert.equal(f.calls.human.length, 0); assert.equal(f.calls.register.length, 0);
});

test('unload revokes both routes, rejects stale handlers and waits for admitted reads without closing the shared service', async t => {
  const f = await fixture(t); await f.seed();
  const entered = deferred(), release = deferred(), original = f.wrapped.catalog;
  f.wrapped.catalog = async () => { entered.resolve(); await release.promise; return original(); };
  const response = f.request(); await entered.promise;
  const stale = f.routes.get('/api/fleet/view').fetch;
  let finished = false;
  const closing = f.dispose().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false); assert.equal(f.routes.size, 0);
  const staleResponse = await stale(new Request('http://fleet.fixture/api/fleet/view?workspaceId=alpha'));
  assert.equal(staleResponse.status, 503);
  release.resolve(); ok(await response); await closing;
  assert.equal(finished, true); assert.deepEqual(f.removed.sort(), ['/api/fleet/action', '/api/fleet/drafts', '/api/fleet/overview', '/api/fleet/progress', '/api/fleet/view']);
  assert.equal(f.service.health.ready, true, 'only the Runtime owns service.close');
  assert.equal((await f.request()).status, 404);
  await f.dispose(); assert.equal(f.removed.length, 5);
});

test('live Store lock preserves read access and returns a retryable HTTP conflict without faulting the shared service', async t => {
  const f = await fixture(t); await f.seed(); const lockPath = path.resolve(f.locations.alpha, '.fleet/.writer.lock'); assert.equal(path.dirname(lockPath), path.join(f.locations.alpha, '.fleet'));
  const lock = JSON.stringify({ token: randomUUID(), pid: process.pid, hostname: os.hostname() }); const handle = await fs.open(lockPath, 'wx'); await handle.writeFile(lock); await handle.close();
  assert.equal(ok(await f.request('/api/fleet/view?workspaceId=alpha&ticketId=ticket')).selectedTicket.status, 'draft');
  error(await f.action('start', { ticketId: 'ticket' }), 409, 'store-busy'); assert.equal(f.service.health.ready, true); assert.equal(await fs.readFile(lockPath, 'utf8'), lock);
  assert.equal(path.dirname(lockPath), path.resolve(f.temp, 'alpha/.fleet')); assert((await fs.lstat(lockPath)).isFile()); await fs.unlink(lockPath);
  assert.equal(ok(await f.action('start', { ticketId: 'ticket' })).result.status, 'running');
});

test('partial route registration failure revokes every earlier handler', () => {
  const h = registryFixture({}), register = h.ctx.connection.fetch.register; let count = 0;
  h.ctx.connection.fetch.register = route => { if (++count === 3) throw new Error('third route failed'); return register(route); };
  assert.throws(() => registerFleetDashboardApi(h.ctx, { getService() { throw new Error('must not open'); } }), /third route failed/); assert.equal(h.routes.size, 0); assert.deepEqual(h.removed, ['/api/fleet/view', '/api/fleet/drafts']);
});

test('overview aggregates every registered Workspace read-only and isolates a failing project', async t => {
  const f = await fixture(t); await f.seed('alpha', 'a-1'); await f.seed('beta', 'b-1');
  const before = await files(f.temp), registers = f.calls.register.length, saves = f.calls.saveDraftTicket.length, humans = f.calls.human.length;
  const body = ok(await f.request('/api/fleet/overview'));
  assert.equal(body.schemaVersion, 1);
  assert.deepEqual(body.projects.map(p => p.workspaceId), ['alpha', 'beta', 'empty', 'missing']);
  const by = Object.fromEntries(body.projects.map(p => [p.workspaceId, p]));
  for (const id of ['alpha', 'beta']) { assert.equal(by[id].state, 'ok'); assert.equal(by[id].tickets.length, 1); assert(by[id].tickets.every(x => x.workspaceId === id)); assert.equal(by[id].tickets[0].status, 'draft'); assert.equal(by[id].error, null); }
  assert.equal(by.empty.state, 'ok'); assert.deepEqual(by.empty.tickets, []);
  assert.equal(by.missing.state, 'error'); assert.equal(by.missing.error.code, 'fleet/workspace-unavailable'); assert.deepEqual(by.missing.tickets, []); assert.deepEqual(by.missing.series, []);
  assert.equal((await f.request('/api/fleet/overview')).cache, 'no-store');
  error(await f.request('/api/fleet/overview?workspaceId=alpha'), 400, 'invalid-request');
  error(await f.request('/api/fleet/overview', { method: 'POST', body: {} }), 405, 'method-not-allowed');
  assert(f.calls.getService.every(options => options.readOnly === true));
  assert.equal(f.calls.register.length, registers); assert.equal(f.calls.saveDraftTicket.length, saves); assert.equal(f.calls.human.length, humans);
  assert.deepEqual(await files(f.temp), before);
});

test('abandon and unabandon flow through the dashboard action path, overview and Ticket view', async t => {
  const f = await fixture(t); const seeded = await f.seed();
  const revision = seeded.revision;
  error(await f.action('abandon', { ticketId: 'ticket', expectedRevision: revision + 3 }), 409, 'stale-revision');
  const abandoned = ok(await f.action('abandon', { ticketId: 'ticket', expectedRevision: revision, reason: 'deprioritized' })).result;
  assert.equal(abandoned.status, 'draft'); assert(abandoned.abandonedAt);
  const overview = ok(await f.request('/api/fleet/overview'));
  const row = overview.projects.find(p => p.workspaceId === 'alpha').tickets.find(x => x.id === 'ticket');
  assert.equal(row.abandonedAt, abandoned.abandonedAt);
  const view = ok(await f.request('/api/fleet/view?workspaceId=alpha&ticketId=ticket'));
  assert.equal(view.selectedTicket.abandonedAt, abandoned.abandonedAt);
  assert(view.selectedTicket.events.some(e => e.type === 'ticket-abandoned' && e.detail.reason === 'deprioritized'));
  error(await f.action('start', { ticketId: 'ticket' }), 409, 'state-conflict');
  const restored = ok(await f.action('unabandon', { ticketId: 'ticket', expectedRevision: abandoned.revision })).result;
  assert.equal(restored.abandonedAt, undefined);
  assert.equal(ok(await f.action('start', { ticketId: 'ticket' })).result.status, 'running');
  error(await f.action('abandon', { ticketId: 'ticket', expectedRevision: ok(await f.request('/api/fleet/view?workspaceId=alpha&ticketId=ticket')).selectedTicket.revision }), 409, 'control-locked');
  error(await f.action('abandon', { ticketId: 'ticket', expectedRevision: 1, unexpected: true }), 400, 'invalid-request');
});

test('goal-only creation and source references use the shared contract without Root materialization', async t => {
  const f = await fixture(t); f.workspaces.get('alpha').sessionIds.push('planning');
  const goalOnly = ok(await f.action('draft-save', { sessionId: 'planning', plan: { goal: 'Plan this task' } })).result;
  assert.equal(goalOnly.plan.contractVersion, 3); assert.deepEqual(goalOnly.plan.nodes, []); error(await f.action('start', { ticketId: goalOnly.id }), 409, 'incomplete-plan');
  await f.templates(); const p = plan(), rootBefore = await fs.readFile(path.join(f.rootPath, 'current.json'), 'utf8');
  const applied = ok(await f.action('draft-save', { sessionId: 'planning', plan: p, sourceRefs: [{ kind: 'agent', templateId: 'alpha-writer', templateRevision: 1, localId: 'alpha-writer' }] })).result;
  assert.equal(applied.activity.find(a => a.type === 'template-applied').detail.content.profile.instructions, 'Write alpha');
  ok(await f.action('start', { ticketId: applied.id })); assert.equal(await fs.readFile(path.join(f.rootPath, 'current.json'), 'utf8'), rootBefore); assert.equal(f.host.calls.length, 0);
});

test('legacy plans remain read-only until explicit repair or atomic regeneration with Session and CAS checks', async t => {
  const f = await fixture(t); f.workspaces.get('alpha').sessionIds.push('conversation', 'different'); await f.service.registerWorkspace('alpha', f.locations.alpha);
  const old = id => ({ id, workspaceId: 'alpha', originSessionId: 'conversation', status: 'draft', revision: 1, goal: 'legacy request', plan: { ticket: { goal: 'legacy request', criteria: ['one\\nstandard'] } }, snapshot: null, nodes: [], gates: [], events: [], changes: [] });
  const first = old('old'), second = old('complex'); second.plan.ticket.criteria = { preserve: ['complex criteria'] };
  const store = await FleetStore.open({ dir: path.join(f.locations.alpha, '.fleet'), kind: 'workspace' }); await store.commit({ schemaVersion: 1, id: 'alpha', definitions: { agents: [], flows: [] }, binding: null, tickets: [first, second] }); await store.close();
  const pointer = await fs.readFile(path.join(f.locations.alpha, '.fleet/current.json'), 'utf8');
  const read = ok(await f.request('/api/fleet/drafts?workspaceId=alpha&sessionId=conversation&draftId=old')).selectedDraft; assert.equal(read.plan.contractVersion, undefined); assert.deepEqual(read.legacy.original, first); assert.equal(await fs.readFile(path.join(f.locations.alpha, '.fleet/current.json'), 'utf8'), pointer);
  error(await f.action('start', { ticketId: 'old' }), 409, 'legacy-plan'); error(await f.action('draft-repair', { sessionId: 'different', ticketId: 'old', expectedRevision: 1 }), 409, 'session-scope');
  const repaired = ok(await f.action('draft-repair', { sessionId: 'conversation', ticketId: 'old', expectedRevision: 1 })).result; assert.equal(repaired.id, 'old'); assert.equal(repaired.plan.contractVersion, 3); assert.deepEqual(repaired.plan.criteria, first.plan.ticket.criteria); assert.equal(repaired.activity.at(-1).type, 'plan-repaired');
  error(await f.action('draft-repair', { sessionId: 'conversation', ticketId: 'complex', expectedRevision: 1 }), 400, 'invalid-input'); assert.deepEqual((await f.service.read('alpha', 'complex')).plan, second.plan);
  const regenerated = ok(await f.action('draft-regenerate', { sessionId: 'conversation', ticketId: 'complex', expectedRevision: 1, plan: { goal: 'replacement' } })).result; assert.notEqual(regenerated.id, 'complex'); assert.equal(regenerated.originSessionId, 'conversation'); assert.equal((await f.service.read('alpha', 'complex')).supersededBy, regenerated.id); assert.equal((await f.service.read('alpha', 'complex')).status, 'superseded');
  error(await f.action('draft-regenerate', { sessionId: 'conversation', ticketId: 'complex', expectedRevision: 1, plan: { goal: 'stale replacement' } }), 409, 'stale-revision'); assert.equal(f.host.calls.length, 0);
});

test('executed legacy HTTP view retains true frozen Profile and unknown old Attempt revision without dispatch', async t => {
  const f = await fixture(t); await f.templates(); await f.service.registerWorkspace('alpha', f.locations.alpha);
  const snapshot = { goal: 'original execution goal', inputs: {}, criteria: ['original criteria'], agents: { writer: { id: 'old-agent', revision: 2, profile: { instructions: 'TRUE HISTORICAL PROFILE' } } }, orchestration: { id: 'old-flow', revision: 1, definition: { nodes: [{ id: 'build', role: 'writer', dependsOn: [], task: { prompt: 'original task' } }], gates: [] } }, binding: { orchestrationId: 'old-flow', roleAgents: { writer: 'old-agent' }, local: {} } };
  const old = { id: 'historic', workspaceId: 'alpha', originSessionId: null, status: 'stopped', revision: 4, goal: 'latest old title', inputs: {}, criteria: [], plan: null, snapshot, nodes: [{ id: 'build', role: 'writer', dependsOn: [], task: { prompt: 'later old task' }, status: 'completed', thread: [], attempts: [{ id: 'old-attempt', status: 'completed', nodeRevision: 2, sessionId: 'native-old-session', outputs: { file: 'original.md' } }] }], gates: [], events: [], changes: [] };
  const store = await FleetStore.open({ dir: path.join(f.locations.alpha, '.fleet'), kind: 'workspace' }); await store.commit({ schemaVersion: 1, id: 'alpha', definitions: { agents: [], flows: [] }, binding: null, tickets: [old] }); await store.close();
  const pointer = await fs.readFile(path.join(f.locations.alpha, '.fleet/current.json'), 'utf8'); const view = ok(await f.request('/api/fleet/view?workspaceId=alpha&ticketId=historic')).selectedTicket;
  assert.equal(view.snapshot.agents['old-agent'].profile.instructions, 'TRUE HISTORICAL PROFILE'); assert.deepEqual(view.snapshot.legacySnapshot, snapshot); assert.equal(view.nodes[0].attempts[0].configRevision, null); assert.equal(view.nodes[0].attempts[0].nodeRevision, 2); assert.equal(view.nodes[0].attempts[0].sessionId, 'native-old-session');
  const historical = projectTicket(view, { configRevision: null }); assert.equal(historical.unknownConfigRevision, true); assert.deepEqual(historical.snapshot.legacySnapshot, snapshot);
  error(await f.action('resume', { ticketId: 'historic' }), 409, 'legacy-plan'); assert.equal(await fs.readFile(path.join(f.locations.alpha, '.fleet/current.json'), 'utf8'), pointer); assert.equal(f.host.calls.length, 0);
});

// Host tool/message factories are substituted; Runtime imports the actual service and API module.
// This repository deliberately does not install Host internals as dependencies.
let runtime;
async function runtimeModule() {
  if (runtime) return runtime;
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: 'data:text/javascript,export const defineTool = value => value;', shortCircuit: true };
    if (specifier === '@deepseek-ai/dsh-llm') return { url: 'data:text/javascript,export const createUserMessage = text => ({ role: "user", content: [{ type: "text", text }] });', shortCircuit: true };
    return nextResolve(specifier, context);
  } });
  try { runtime = await import('../runtime.js'); return runtime; }
  finally { hooks.deregister(); }
}
function runtimeContext(locations) {
  const h = registryFixture(locations), tools = new Map(), commands = new Map(), cleanups = [], warnings = [];
  Object.assign(h.ctx, {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    commands: { register(command) { commands.set(command.name, command); return () => commands.delete(command.name); } },
    logger: { warn(message) { warnings.push(message); } },
    effect(factory) { cleanups.push(factory()); }
  });
  return { ...h, tools, commands, warnings, dispose: async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); } };
}

test('Runtime injects connection, shares one service with native Chat, and closes it after API disposal', async t => {
  const f = await fixture(t), mod = await runtimeModule();
  assert(mod.inject.includes('connection')); assert.equal(new Set(mod.inject).size, mod.inject.length);
  const h = runtimeContext(f.locations), originalOpen = FleetService.open;
  const opens = [];
  FleetService.open = async options => { opens.push(options); return f.service; };
  t.after(() => { FleetService.open = originalOpen; });
  f.disposers.push(h.dispose);
  mod.apply(h.ctx, { rootPath: f.rootPath });
  await f.seed();
  const view = await h.routes.get('/api/fleet/view').fetch(new Request('http://fleet.fixture/api/fleet/view?workspaceId=empty'));
  assert.equal(view.status, 200); assert.equal(opens.length, 1);
  h.workspaces.get('alpha').sessionIds.push('planning-session');
  const listed = await h.commands.get('fleet').handler({ agent: { id: 'planning-session' }, rawInput: 'list' });
  assert.equal(listed.kind, 'success');
  const fetched = await h.routes.get('/api/fleet/view').fetch(new Request('http://fleet.fixture/api/fleet/view?workspaceId=alpha&ticketId=ticket'));
  assert.equal((await fetched.json()).selectedTicket.goal, 'Deliver alpha'); assert.equal(opens.length, 1);
  assert.equal(h.tools.size, 10); assert.ok(h.tools.has('fleet_schedule')); assert.ok(h.tools.has('fleet_stop')); assert.ok(h.tools.has('fleet_retry')); assert.ok(h.tools.has('fleet_admin'));
  assert.equal(h.commands.size, 1, 'only the canonical /fleet command remains after alias retirement');
  await h.dispose();
  assert.equal(h.routes.size, 0); assert.equal(h.tools.size, 0); assert.equal(h.commands.size, 0);
  assert.equal(f.service.health.ready, false); assert.equal(f.host.calls.length, 0);
});

test('Runtime unload drains an admitted HTTP mutation before closing the shared writer', async t => {
  const f = await fixture(t), mod = await runtimeModule(), h = runtimeContext(f.locations);
  await f.seed();
  const originalOpen = FleetService.open, originalHuman = f.service.human.bind(f.service);
  const entered = deferred(), release = deferred();
  FleetService.open = async () => f.service;
  f.service.human = async (...args) => { entered.resolve(); await release.promise; return originalHuman(...args); };
  t.after(() => { FleetService.open = originalOpen; });
  f.disposers.push(h.dispose);
  mod.apply(h.ctx, { rootPath: f.rootPath });
  const response = h.routes.get('/api/fleet/action').fetch(new Request('http://fleet.fixture/api/fleet/action', {
    method: 'POST', body: JSON.stringify({ workspaceId: 'alpha', action: 'start', ticketId: 'ticket' }), headers: { 'content-type': 'application/json' }
  }));
  await entered.promise;
  let closed = false;
  const closing = h.dispose().then(() => { closed = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.routes.size, 0); assert.equal(closed, false); assert.equal(f.service.health.ready, true);
  release.resolve();
  const result = await response;
  assert.equal(result.status, 200); assert.equal((await result.json()).result.status, 'running');
  await closing;
  assert.equal(f.service.health.ready, false); assert.equal(f.host.calls.length, 0);
});

test('Runtime GET never opens an unconfigured service or retries failed eager initialization', async t => {
  const f = await fixture(t), mod = await runtimeModule(), originalOpen = FleetService.open;
  let opens = 0;
  FleetService.open = async () => { opens++; throw new Error('fixture initialization failed'); };
  t.after(() => { FleetService.open = originalOpen; });
  for (const rootPath of ['', f.rootPath]) {
    const h = runtimeContext(f.locations); f.disposers.push(h.dispose);
    mod.apply(h.ctx, { rootPath });
    for (let i = 0; i < 2; i++) {
      const response = await h.routes.get('/api/fleet/view').fetch(new Request('http://fleet.fixture/api/fleet/view?workspaceId=alpha'));
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, 'fleet/service-unavailable');
    }
    assert.equal(opens, rootPath ? 1 : 0);
    assert.equal(f.host.calls.length, 0);
    await h.dispose();
  }
});

test('selected attempt progress reads one owned native Session for live and historical selections without writing', async t => {
  const f = await fixture(t); await f.seed(); await f.seed('beta');
  ok(await f.action('start', {ticketId: 'ticket'})); await f.service.tick();
  const read = () => f.service.read('alpha', 'ticket');
  const attempt = (await read()).execution.nodes.build.attempts[0];
  const url = `/api/fleet/progress?workspaceId=alpha&ticketId=ticket&nodeId=build&attemptId=${attempt.id}`;
  const progress = [{ id: '12', time: '2026-11-19T05:02:03.000Z', intent: 'step', step: 1, tool: 'read', text: 'read' }];
  f.host.sessions.set(attempt.sessionId, { status: 'running', progress });
  const verifySelection = async () => {
    const snapshot = await files(f.temp), before = f.host.calls.length;
    const { rows } = ok(await f.request(url));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { ...progress[0], id: `native-${attempt.id}-12`, actor: { kind: 'agent', nodeId: 'build', attemptId: attempt.id, agentId: 'alpha-writer' }, attemptId: attempt.id });
    assert.deepEqual(f.host.calls.slice(before), [['inspect', { sessionId: attempt.sessionId, requestId: `fleet-${attempt.id}`, progressAnchor: `fleet-${attempt.id}` }]]);
    assert.deepEqual(await files(f.temp), snapshot);
  };
  await verifySelection();
  f.host.sessions.set(attempt.sessionId, { status: 'completed', output: 'historic output' }); await f.service.tick();
  assert.deepEqual((await read()).execution.nodes.build.thread, []);
  f.host.sessions.set(attempt.sessionId, { status: 'completed', progress }); await verifySelection();
  const before = f.host.calls.length;
  error(await f.request(url.replace('build', 'ship')), 404, 'unknown-attempt');
  error(await f.request(url.replace('alpha', 'beta')), 404, 'unknown-node');
  error(await f.request(url + '&sessionId=other'), 400, 'invalid-request');
  assert.equal(f.host.calls.length, before);
});
