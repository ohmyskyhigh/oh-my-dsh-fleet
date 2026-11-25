// P-72／P-73 reusable templates: Core value-copy rules, Root-only writes, the templates-saved
// activity, defaults/logicGates carriage, the root-new Chat command and the Dashboard actions.
// All filesystem state is test-owned; no Profile, server, Desktop or real Agent is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FleetCore, FleetCoreError } from '../src/fleet-core.js';
import { FleetService } from '../src/fleet-service.js';
import { normalizePlan, projectTicket, orchestrationContentFromPlan } from '../src/fleet-model.js';
import { registerFleetChat, fleetHelp } from '../src/fleet-chat.js';
import { registerFleetDashboardApi } from '../src/fleet-dashboard-api.js';

const basePlan = () => normalizePlan({
  goal: 'Deliver the reusable flow',
  inputs: { source: 'demo' },
  deliverables: [{ title: 'Report', text: 'report.md: the result', category: 'noncode', criteria: ['exists'] }],
  criteria: ['verified'],
  requirements: 'keep evidence',
  agents: {
    writer: { name: 'Writer', profile: { instructions: 'Write' } },
    reviewer: { name: 'Reviewer', profile: { instructions: 'Review', agentPreset: 'fixture-preset' } }
  },
  nodes: [
    { id: 'build', role: 'writer', agentId: 'writer', dependsOn: [], task: { prompt: 'Build', summary: 'I will build the artifact' } },
    { id: 'check', role: 'reviewer', agentId: 'reviewer', dependsOn: ['build'], task: { prompt: 'Check' } }
  ],
  gates: [{ id: 'quality', from: ['build'], to: ['check'], reviewer: { kind: 'agent', nodeId: 'check' } }],
  logicGates: [{ id: 'route', from: 'build', routes: [{ id: 'r1', to: ['check'], condition: { path: ['ok'], operator: 'eq', value: true } }] }]
});
const coreFixture = () => { const c = new FleetCore(); return { c, h: c.human('w', 'user') }; };
const seedCoreTicket = (c, plan = basePlan()) => c.saveDraftTicket('w', { id: 'ticket', plan, actor: { kind: 'human', userId: 'user' } });
const templatesOf = c => c.exportState().templates;
const findTemplate = (c, id) => templatesOf(c).find(t => t.id === id);

// ---- Core: template content carries defaults and logicGates; concrete references are rejected ----
test('orchestration template stores defaults and logicGates by value', () => {
  const { c, h } = coreFixture();
  const content = orchestrationContentFromPlan(basePlan(), { writer: { mode: 'leave' }, reviewer: { mode: 'leave' } });
  const t = h.saveTemplate({ id: 'flow', kind: 'orchestration', content });
  assert.deepEqual(t.content.logicGates, basePlan().logicGates);
  assert.equal(t.content.defaults.goal, 'Deliver the reusable flow');
  assert.deepEqual(t.content.defaults.inputs, { source: 'demo' });
  assert.deepEqual(t.content.defaults.criteria, ['verified']);
  assert.equal(t.content.defaults.requirements, 'keep evidence');
  assert.equal(t.content.nodes[0].ticketDependencies, undefined);
  assert.equal(t.content.nodes[0].ticketDependencySeries, undefined);
  assert.equal(t.content.nodes[0].agentId, null);
});
test('template content rejects unknown keys, bad defaults and concrete references', () => {
  const { h } = coreFixture();
  assert.throws(() => h.saveTemplate({ id: 'x', kind: 'orchestration', content: { nodes: [], gates: [], extra: 1 } }), e => e.code === 'invalid-input');
  assert.throws(() => h.saveTemplate({ id: 'x', kind: 'orchestration', content: { nodes: [], gates: [], defaults: { goal: '' } } }), e => e.code === 'invalid-input');
  assert.throws(() => h.saveTemplate({ id: 'x', kind: 'orchestration', content: { nodes: [], gates: [], defaults: { unknown: 1 } } }), e => e.code === 'invalid-input');
  assert.throws(() => h.saveTemplate({ id: 'x', kind: 'orchestration', content: { nodes: [{ id: 'a', task: { prompt: 'a' }, ticketDependencies: ['t'] }], gates: [] } }), e => e.code === 'invalid-input');
  assert.throws(() => h.saveTemplate({ id: 'x', kind: 'orchestration', content: { nodes: [{ id: 'a', task: { prompt: 'a' } }], gates: [], logicGates: [{ id: 'g', from: 'a', routes: [{ id: 'r', to: ['missing'], condition: { path: ['x'], operator: 'eq', value: 1 } }] }] } }), e => e.code === 'invalid-flow');
});
test('orchestrationContentFromPlan strips concrete Ticket and series references and remaps agents', () => {
  const plan = basePlan();
  plan.ticketDependencies = ['whole-ticket'];
  plan.ticketDependencySeries = ['whole-series'];
  plan.nodes[0].ticketDependencies = ['upstream-ticket'];
  plan.nodes[0].ticketDependencySeries = ['upstream-series'];
  const content = orchestrationContentFromPlan(plan, { writer: { mode: 'link', templateId: 'root-writer' }, reviewer: { mode: 'save', id: 'root-reviewer' } });
  assert.equal(content.ticketDependencies, undefined);
  assert.equal(content.ticketDependencySeries, undefined);
  const build = content.nodes.find(n => n.id === 'build');
  assert.equal(build.ticketDependencies, undefined);
  assert.equal(build.ticketDependencySeries, undefined);
  assert.equal(build.agentId, 'root-writer');
  assert.equal(content.nodes.find(n => n.id === 'check').agentId, 'root-reviewer');
  assert.deepEqual(content.logicGates, plan.logicGates);
  assert.equal(content.defaults.goal, plan.goal);
});
test('instantiation copies logicGates but defaults only prefill via overrides', () => {
  const { c, h } = coreFixture();
  h.saveTemplate({ id: 'writer', kind: 'agent', content: { profile: { instructions: 'Write' } } });
  h.saveTemplate({ id: 'flow', kind: 'orchestration', content: { nodes: [{ id: 'a', agentId: 'writer', task: { prompt: 'a' } }, { id: 'b', agentId: 'writer', task: { prompt: 'b' } }], gates: [], logicGates: [{ id: 'g', from: 'a', routes: [{ id: 'r', to: ['b'], condition: { path: ['x'], operator: 'exists' } }] }], defaults: { goal: 'default goal', criteria: ['default'] } } });
  const t = h.instantiateTemplate({ templateId: 'flow', overrides: { goal: 'explicit goal' } });
  assert.deepEqual(t.plan.logicGates, [{ id: 'g', from: 'a', routes: [{ id: 'r', to: ['b'], condition: { path: ['x'], operator: 'exists' } }] }]);
  assert.equal(t.plan.goal, 'explicit goal');
  assert.deepEqual(t.plan.criteria, []); // defaults are NOT applied implicitly
});

// ---- Core: saveTemplate update mode and ticket-shaped source ----
test('saveTemplate update increments revision, keeps history and refreshes name/source', () => {
  const { c, h } = coreFixture();
  h.saveTemplate({ id: 'writer', kind: 'agent', name: 'Old', content: { profile: { instructions: 'v1' } } });
  const updated = h.saveTemplate({ id: 'writer', kind: 'agent', name: 'New', content: { profile: { instructions: 'v2' } }, update: true });
  assert.equal(updated.revision, 2);
  assert.equal(updated.name, 'New');
  assert.equal(updated.content.profile.instructions, 'v2');
  assert.equal(updated.history.length, 1);
  assert.equal(updated.history[0].content.profile.instructions, 'v1');
  assert.throws(() => h.saveTemplate({ id: 'missing', kind: 'agent', content: { profile: {} }, update: true }), e => e.code === 'unknown-agent');
  assert.throws(() => h.saveTemplate({ id: 'writer', kind: 'orchestration', content: { nodes: [], gates: [] }, update: true }), e => e.code === 'unknown-flow');
  assert.throws(() => h.saveTemplate({ id: 'writer', kind: 'agent', content: { profile: {} } }), e => e.code === 'duplicate-id');
});
test('saveTemplate accepts a ticket-shaped source only for the current revision in this Workspace', () => {
  const { c, h } = coreFixture();
  const t = seedCoreTicket(c);
  const source = { ticketId: t.id, ticketRevision: t.revision, workspaceId: 'w', nodeId: 'build' };
  const saved = h.saveTemplate({ id: 'writer', kind: 'agent', content: { profile: { instructions: 'Write' } }, source });
  assert.deepEqual(saved.source, source);
  assert.throws(() => h.saveTemplate({ id: 'w2', kind: 'agent', content: { profile: {} }, source: { ...source, ticketRevision: t.revision + 1 } }), e => e.code === 'stale-revision');
  assert.throws(() => h.saveTemplate({ id: 'w3', kind: 'agent', content: { profile: {} }, source: { ...source, workspaceId: 'other' } }), e => e.code === 'invalid-input');
  assert.throws(() => h.saveTemplate({ id: 'w4', kind: 'agent', content: { profile: {} }, source: { ...source, nodeId: 'missing' } }), e => e.code === 'invalid-input');
});

// ---- Core: saveTemplateFromTicket value-copy, mapping and atomicity ----
test('saveTemplateFromTicket copies the saved plan, strips references and writes agents first', () => {
  const { c, h } = coreFixture();
  c.saveDraftTicket('w', { id: 'upstream-ticket', plan: normalizePlan({ goal: 'Upstream' }), actor: { kind: 'human', userId: 'user' } });
  const plan = basePlan();
  plan.nodes[0].ticketDependencies = ['upstream-ticket'];
  const t = seedCoreTicket(c, plan);
  const result = h.saveTemplateFromTicket({
    ticketId: t.id, id: 'reusable-flow', name: 'Reusable flow',
    agentMapping: { writer: { mode: 'save', id: 'root-writer', name: 'Root Writer' }, reviewer: { mode: 'leave' } }
  });
  assert.equal(result.template.id, 'reusable-flow');
  assert.equal(result.template.kind, 'orchestration');
  assert.deepEqual(result.template.source, { ticketId: t.id, ticketRevision: t.revision, workspaceId: 'w' });
  assert.equal(result.agentTemplates.length, 1);
  assert.equal(result.agentTemplates[0].id, 'root-writer');
  assert.deepEqual(result.agentTemplates[0].content, { name: 'Writer', profile: { instructions: 'Write' } });
  assert.deepEqual(result.agentTemplates[0].source, { ticketId: t.id, ticketRevision: t.revision, workspaceId: 'w', nodeId: 'build' });
  const content = result.template.content;
  assert.equal(content.nodes.find(n => n.id === 'build').agentId, 'root-writer');
  assert.equal(content.nodes.find(n => n.id === 'check').agentId, null);
  assert.equal(content.nodes.find(n => n.id === 'build').ticketDependencies, undefined);
  assert.equal(content.nodes.find(n => n.id === 'build').ticketDependencySeries, undefined);
  assert.deepEqual(content.logicGates, basePlan().logicGates);
  assert.equal(content.defaults.goal, 'Deliver the reusable flow');
  // agents published before orchestration, all in one Root state
  const ids = templatesOf(c).map(x => x.id);
  assert.ok(ids.includes('root-writer') && ids.includes('reusable-flow'));
});
test('saveTemplateFromTicket link mode references an existing Root agent template', () => {
  const { c, h } = coreFixture();
  h.saveTemplate({ id: 'root-reviewer', kind: 'agent', content: { profile: { instructions: 'Review' } } });
  const t = seedCoreTicket(c);
  const result = h.saveTemplateFromTicket({ ticketId: t.id, id: 'flow', agentMapping: { writer: { mode: 'leave' }, reviewer: { mode: 'link', templateId: 'root-reviewer' } } });
  assert.equal(result.template.content.nodes.find(n => n.id === 'check').agentId, 'root-reviewer');
  assert.equal(result.agentTemplates.length, 0);
});
test('saveTemplateFromTicket validates mapping completeness, ids and legacy plans', () => {
  const { c, h } = coreFixture();
  const t = seedCoreTicket(c);
  assert.throws(() => h.saveTemplateFromTicket({ ticketId: t.id, id: 'flow', agentMapping: { writer: { mode: 'leave' } } }), e => e.code === 'invalid-input'); // reviewer missing
  assert.throws(() => h.saveTemplateFromTicket({ ticketId: t.id, id: 'flow', agentMapping: { writer: { mode: 'leave' }, reviewer: { mode: 'leave' }, ghost: { mode: 'leave' } } }), e => e.code === 'invalid-input');
  assert.throws(() => h.saveTemplateFromTicket({ ticketId: t.id, id: 'flow', agentMapping: { writer: { mode: 'link', templateId: 'missing' }, reviewer: { mode: 'leave' } } }), e => e.code === 'unknown-agent');
  assert.throws(() => h.saveTemplateFromTicket({ ticketId: t.id, id: 'flow', agentMapping: { writer: { mode: 'save', id: 'same' }, reviewer: { mode: 'save', id: 'same' } } }), e => e.code === 'duplicate-id');
  assert.throws(() => h.saveTemplateFromTicket({ ticketId: t.id, id: 'flow', agentMapping: { writer: { mode: 'save', id: 'flow' }, reviewer: { mode: 'leave' } } }), e => e.code === 'duplicate-id'); // collides with orchestration id
});
test('a rejected saveTemplateFromTicket publishes nothing (agents-first atomicity)', () => {
  const { c, h } = coreFixture();
  h.saveTemplate({ id: 'existing', kind: 'orchestration', content: { nodes: [], gates: [] } });
  const t = seedCoreTicket(c);
  const before = templatesOf(c).map(x => x.id).sort();
  assert.throws(() => h.saveTemplateFromTicket({ ticketId: t.id, id: 'existing', agentMapping: { writer: { mode: 'save', id: 'new-writer' }, reviewer: { mode: 'save', id: 'new-reviewer' } } }), e => e.code === 'duplicate-id');
  assert.deepEqual(templatesOf(c).map(x => x.id).sort(), before); // no partial agent writes
});
test('saveTemplateFromTicket reads the saved plan for running and delivered Tickets', () => {
  const { c, h } = coreFixture();
  const t = seedCoreTicket(c);
  h.start(t.id);
  const running = c.readTicket('w', t.id);
  assert.equal(running.status, 'running');
  const result = h.saveTemplateFromTicket({ ticketId: t.id, id: 'flow', agentMapping: { writer: { mode: 'leave' }, reviewer: { mode: 'leave' } } });
  assert.equal(result.ticketRevision, running.revision);
  assert.equal(result.template.content.defaults.goal, 'Deliver the reusable flow');
});

// ---- Core: recordTemplatesSaved appends activity without touching the Ticket ----
test('recordTemplatesSaved appends one activity and leaves plan, revision and sourceRefs unchanged', () => {
  const { c, h } = coreFixture();
  const t = seedCoreTicket(c);
  const before = c.readTicket('w', t.id);
  const after = c.recordTemplatesSaved('w', t.id, { ticketRevision: t.revision, templates: [{ kind: 'orchestration', id: 'flow', revision: 1 }] }, { kind: 'human', userId: 'user' });
  assert.equal(after.revision, before.revision);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.deepEqual(after.plan, before.plan);
  assert.deepEqual(after.sourceRefs, before.sourceRefs);
  const added = after.activity.filter(a => a.type === 'templates-saved');
  assert.equal(added.length, 1);
  assert.equal(added[0].ticketRevision, before.revision);
  assert.deepEqual(added[0].detail.templates, [{ kind: 'orchestration', id: 'flow', revision: 1 }]);
});

// ---- Service: real persisted Root + Workspace chains ----
const adapterFixture = () => ({
  async create() { return { sessionId: 'fixture-session' }; },
  async submit() { return { messageId: 'fixture-message' }; },
  async inspect() { return { status: 'unknown' }; },
  async cancel() { return { stopped: true }; },
  async message() { return { messageId: 'fixture-message' }; },
  async modelCatalog() { return { default: { provider: 'fixture', model: 'fixture-model' }, routableProviders: ['fixture'], groups: [], failures: [] }; }
});
const ownedTemps = new Set();
async function serviceFixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-templates-test-'));
  ownedTemps.add(temp);
  const rootPath = path.join(temp, 'root'), wsPath = path.join(temp, 'alpha');
  await fs.mkdir(wsPath);
  const service = await FleetService.open({ rootPath, workspacePaths: {}, adapter: adapterFixture(), autoStart: false });
  await service.registerWorkspace('alpha', wsPath);
  t.after(async () => {
    await service.close();
    const resolved = path.resolve(temp);
    assert.equal(temp, resolved); assert(ownedTemps.has(resolved));
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('fleet-templates-test-'));
    const info = await fs.lstat(resolved); assert(info.isDirectory()); assert(!info.isSymbolicLink());
    await fs.rm(resolved, { recursive: true, force: true });
    ownedTemps.delete(resolved);
  });
  const seed = async (ticketId = 'ticket') => service.saveDraftTicket('alpha', { id: ticketId, sessionId: `seed-${ticketId}`, plan: basePlan(), actor: { kind: 'system', via: 'test-seed' } });
  return { service, temp, rootPath, wsPath, seed };
}
test('Service saveTemplateFromTicket persists Root templates and appends one Ticket activity', async t => {
  const f = await serviceFixture(t);
  const ticket = await f.seed();
  const result = await f.service.human('alpha', 'user', 'saveTemplateFromTicket', [{ ticketId: ticket.id, id: 'flow', name: 'Flow', agentMapping: { writer: { mode: 'save', id: 'root-writer' }, reviewer: { mode: 'leave' } } }]);
  assert.equal(result.template.id, 'flow');
  const catalog = await f.service.catalog();
  assert.ok(catalog.agents.some(a => a.id === 'root-writer'));
  assert.ok(catalog.orchestrations.some(o => o.id === 'flow'));
  const after = await f.service.read('alpha', ticket.id);
  assert.equal(after.revision, ticket.revision);
  assert.deepEqual(after.plan, ticket.plan);
  const events = after.activity.filter(a => a.type === 'templates-saved');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].detail.templates, [{ kind: 'orchestration', id: 'flow', revision: 1 }, { kind: 'agent', id: 'root-writer', revision: 1 }]);
  // survives reopen (persisted, not in-memory only)
  await f.service.close();
  const reopened = await FleetService.open({ rootPath: f.rootPath, workspacePaths: { alpha: f.wsPath }, adapter: adapterFixture(), autoStart: false });
  try {
    const catalog2 = await reopened.catalog();
    assert.ok(catalog2.orchestrations.some(o => o.id === 'flow'));
    const ticket2 = await reopened.read('alpha', ticket.id);
    assert.equal(ticket2.activity.filter(a => a.type === 'templates-saved').length, 1);
  } finally { await reopened.close(); }
});
test('Service saveTemplate with a ticket source appends the activity too', async t => {
  const f = await serviceFixture(t);
  const ticket = await f.seed();
  await f.service.human('alpha', 'user', 'saveTemplate', [{ kind: 'agent', id: 'root-writer', content: { profile: { instructions: 'Write' } }, source: { ticketId: ticket.id, ticketRevision: ticket.revision, workspaceId: 'alpha', nodeId: 'build' } }]);
  const after = await f.service.read('alpha', ticket.id);
  const events = after.activity.filter(a => a.type === 'templates-saved');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].detail.templates, [{ kind: 'agent', id: 'root-writer', revision: 1 }]);
  assert.equal(after.revision, ticket.revision);
});
test('Service rejected saveTemplateFromTicket leaves Root and Ticket untouched', async t => {
  const f = await serviceFixture(t);
  const ticket = await f.seed();
  await f.service.human('alpha', 'user', 'saveTemplate', [{ kind: 'orchestration', id: 'existing', content: { nodes: [], gates: [] } }]);
  await assert.rejects(f.service.human('alpha', 'user', 'saveTemplateFromTicket', [{ ticketId: ticket.id, id: 'existing', agentMapping: { writer: { mode: 'save', id: 'new-writer' }, reviewer: { mode: 'leave' } } }]), e => e.code === 'duplicate-id');
  const catalog = await f.service.catalog();
  assert.ok(!catalog.agents.some(a => a.id === 'new-writer'));
  const after = await f.service.read('alpha', ticket.id);
  assert.equal(after.activity.filter(a => a.type === 'templates-saved').length, 0);
});

// ---- Chat: /fleet root-new creates a new Root template ----
function chatHarness() {
  const commands = new Map(), calls = [];
  const service = { registerWorkspace: async () => {}, human: async (ws, user, action, args) => { calls.push({ action, args }); return { id: args[0]?.id, kind: args[0]?.kind, revision: 1 }; }, catalog: async () => ({ agents: [], orchestrations: [] }), health: { ready: true } };
  const ctx = { tools: { register: () => () => {} }, commands: { register: d => { commands.set(d.name, d); return () => {}; } } };
  registerFleetChat(ctx, { defineTool: d => d, getService: async () => service, resolveAgentContext: async () => ({ workspaceId: 'w', workspacePath: path.resolve('chat-fixture'), sessionId: 's' }), createUserMessage: v => v });
  return { calls, command: rawInput => commands.get('fleet').handler({ agent: { identity: 'a' }, rawInput }) };
}
test('root-new dispatches saveTemplate with kind, id and parsed content', async () => {
  const h = chatHarness();
  const result = await h.command('root-new agent my-agent {"name":"My Agent","profile":{"instructions":"Do"}}');
  assert.equal(result.kind, 'success');
  assert.deepEqual(h.calls[0], { action: 'saveTemplate', args: [{ kind: 'agent', id: 'my-agent', content: { name: 'My Agent', profile: { instructions: 'Do' } } }] });
  await h.command('root-new orchestration my-flow {"nodes":[],"gates":[]}');
  assert.equal(h.calls[1].args[0].kind, 'orchestration');
  const bad = await h.command('root-new widget x {}');
  assert.equal(bad.kind, 'error');
  assert.ok(fleetHelp.includes('/fleet root-new agent|orchestration ID JSON'));
});

// ---- Dashboard API: template-save and template-save-from-ticket ----
async function apiFixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-templates-api-'));
  ownedTemps.add(temp);
  const wsPath = path.join(temp, 'alpha');
  await fs.mkdir(wsPath);
  const routes = new Map();
  const workspaces = new Map([['alpha', { id: 'alpha', path: wsPath, sessionIds: [] }]]);
  const calls = { human: [] };
  const service = {
    health: { ready: true, paths: { workspacePaths: { alpha: wsPath } } },
    registerWorkspace: async () => {},
    read: async (ws, id) => id === 'ticket' ? { id: 'ticket', workspaceId: 'alpha', revision: 3, plan: basePlan(), activity: [] } : (() => { throw new FleetCoreError('unknown-ticket', 'Unknown Ticket'); })(),
    catalog: async () => ({ agents: [], orchestrations: [], templates: [], settings: {}, workspaces: [] }),
    human: async (ws, user, action, args) => { calls.human.push({ action, args }); return { id: args[0]?.id, revision: 1 }; }
  };
  const ctx = {
    workspaceRegistry: { get: id => workspaces.get(id), list: () => [...workspaces.values()] },
    agentPresets: { list: async () => [] },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } }
  };
  const dispose = registerFleetDashboardApi(ctx, { getService: async () => service });
  t.after(async () => {
    await dispose();
    const resolved = path.resolve(temp);
    assert.equal(temp, resolved); assert(ownedTemps.has(resolved));
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('fleet-templates-api-'));
    const info = await fs.lstat(resolved); assert(info.isDirectory()); assert(!info.isSymbolicLink());
    await fs.rm(resolved, { recursive: true, force: true });
    ownedTemps.delete(resolved);
  });
  const action = (action, args = {}) => {
    const route = routes.get('/api/fleet/action');
    const request = new Request('http://fleet.fixture/api/fleet/action', { method: 'POST', body: JSON.stringify({ workspaceId: 'alpha', action, ...args }), headers: { 'content-type': 'application/json' } });
    return route.fetch(request).then(async r => ({ status: r.status, body: await r.json() }));
  };
  return { action, calls };
}
test('API template-save validates and dispatches agent and orchestration content', async t => {
  const f = await apiFixture(t);
  const ok = await f.action('template-save', { kind: 'agent', id: 'a', content: { profile: { instructions: 'x' } } });
  assert.equal(ok.status, 200);
  assert.equal(f.calls.human[0].action, 'saveTemplate');
  const flow = await f.action('template-save', { kind: 'orchestration', id: 'f', content: { nodes: [{ id: 'n', task: { prompt: 'p' } }], gates: [], logicGates: [{ id: 'g', from: 'n', routes: [] }], defaults: { goal: 'g' } } });
  assert.equal(flow.status, 200);
  assert.equal((await f.action('template-save', { kind: 'widget', id: 'x', content: {} })).status, 400);
  assert.equal((await f.action('template-save', { kind: 'agent', id: 'x', content: { profile: {} }, update: 'yes' })).status, 400);
  assert.equal((await f.action('template-save', { kind: 'orchestration', id: 'x', content: { nodes: [], gates: [], defaults: { bad: 1 } } })).status, 400);
});
test('API template-save-from-ticket validates agentMapping and source, dispatches once', async t => {
  const f = await apiFixture(t);
  const ok = await f.action('template-save-from-ticket', { ticketId: 'ticket', id: 'flow', agentMapping: { writer: { mode: 'save', id: 'root-writer' }, reviewer: { mode: 'leave' } }, source: { ticketId: 'ticket', ticketRevision: 3, workspaceId: 'alpha' } });
  assert.equal(ok.status, 200);
  assert.equal(f.calls.human[0].action, 'saveTemplateFromTicket');
  assert.equal((await f.action('template-save-from-ticket', { ticketId: 'ticket', id: 'flow', agentMapping: { writer: { mode: 'bogus' } } })).status, 400);
  assert.equal((await f.action('template-save-from-ticket', { ticketId: 'ticket', id: 'flow', agentMapping: { writer: { mode: 'link' } } })).status, 400);
  assert.equal((await f.action('template-save-from-ticket', { ticketId: 'ticket', id: 'flow', agentMapping: {}, source: { ticketId: 'ticket', ticketRevision: 0, workspaceId: 'alpha' } })).status, 400);
  assert.equal((await f.action('template-save-from-ticket', { ticketId: 'missing', id: 'flow', agentMapping: {} })).status, 404);
});