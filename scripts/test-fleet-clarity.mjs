// 0.7.0 P-48~P-50: dual-layer deliverables + per-item criteria, node summary, model/effort selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizePlan, validatePlan, projectTicket, deliverableView, effectiveModelSelection } from '../src/fleet-model.js';
import { FleetCore } from '../src/fleet-core.js';
import { FleetService } from '../src/fleet-service.js';
import { createDshAdapter } from '../src/fleet-dsh-adapter.js';

const item = { title: 'Audit pack', description: 'What the audit contains and achieves', text: 'qa/audit/: report.md, ledger.json (validate.py passes)', criteria: ['c1: pack complete\nvalidate.py passes'] };
const basePlan = (extra = {}) => normalizePlan({ goal: 'Deliver', deliverables: [item, 'legacy string'], criteria: ['ticket-wide governance'], agents: { w: { name: 'Writer', profile: { instructions: 'write' } } }, nodes: [{ id: 'n1', agentId: 'w', dependsOn: [], task: { prompt: 'full spec', summary: 'I will write the report, achieving an acceptance-ready result' } }], gates: [], ...extra });

test('deliverable items accept string and {text,title?,description?,criteria?}; unknown keys and empty text rejected', () => {
  const plan = basePlan();
  assert.deepEqual(plan.deliverables[0], item); assert.equal(plan.deliverables[1], 'legacy string');
  assert.equal(validatePlan(plan, { mode: 'start' }).valid, true);
  const bad = (mutate, code) => { const p = basePlan(); mutate(p); const r = validatePlan(p, { mode: 'save' }); assert.equal(r.valid, false); if (code) assert(r.errors.some(e => e.code === code || e.path.startsWith('deliverables'))); };
  bad(p => { p.deliverables[0] = { title: 'no text' }; });
  bad(p => { p.deliverables[0] = { text: '  ' }; });
  bad(p => { p.deliverables[0] = { text: 'x', extra: 1 }; });
  bad(p => { p.deliverables[0] = { text: 'x', title: '' }; });
  bad(p => { p.deliverables[0] = { text: 'x', criteria: 'not array' }; });
  bad(p => { p.deliverables[0] = { text: 'x', criteria: [1] }; });
  bad(p => { p.deliverables = [42]; });
  // minimal object stays valid; criteria optional
  assert.equal(validatePlan(basePlan({ deliverables: [{ text: 'spec only' }] }), { mode: 'start' }).valid, true);
});
test('normalizePlan never rewrites legacy string items or reorders object fields', () => {
  const plan = basePlan();
  assert.equal(plan.deliverables[1], 'legacy string');
  const again = normalizePlan(JSON.parse(JSON.stringify(plan)));
  assert.deepEqual(again.deliverables, plan.deliverables);
});
test('task.summary is optional text; modelSelection shape validated as start diagnostics, save stays allowed', () => {
  const p = basePlan();
  p.nodes[0].task.summary = 42;
  assert.equal(validatePlan(p, { mode: 'save' }).valid, false);
  const q = basePlan(); q.nodes[0].modelSelection = { provider: 'prov', model: 'm', reasoningEffort: 'high' };
  assert.equal(validatePlan(q, { mode: 'start' }).valid, true);
  const r = basePlan(); r.nodes[0].modelSelection = { model: 'm' };
  assert.equal(validatePlan(r, { mode: 'save' }).valid, true);
  const start = validatePlan(r, { mode: 'start' });
  assert.equal(start.valid, false); assert(start.errors.some(e => e.code === 'unsupported-profile'));
  const s = basePlan(); s.agents.w.profile.modelSelection = { provider: 'prov', model: 'm', extra: true };
  assert.equal(validatePlan(s, { mode: 'start' }).valid, false);
  const flat = basePlan(); flat.agents.w.profile.model = 'm';
  assert.equal(validatePlan(flat, { mode: 'save' }).valid, true);
  assert.equal(validatePlan(flat, { mode: 'start' }).valid, false);
});
test('deliverableView and effectiveModelSelection resolve display title and override precedence', () => {
  assert.deepEqual(deliverableView('legacy'), { label: 'legacy', spec: 'legacy', criteria: [], files: [] });
  assert.equal(deliverableView(item).label, 'Audit pack');
  assert.equal(deliverableView({ text: 'spec' }).label, 'spec');
  assert.deepEqual(deliverableView(item).criteria, item.criteria);
  const node = { modelSelection: { provider: 'p', model: 'node' } }, agent = { profile: { modelSelection: { provider: 'p', model: 'agent' } } };
  assert.deepEqual(effectiveModelSelection(node, agent), { selection: node.modelSelection, source: 'node' });
  assert.deepEqual(effectiveModelSelection({}, agent), { selection: agent.profile.modelSelection, source: 'agent' });
  assert.deepEqual(effectiveModelSelection({}, { profile: {} }), { selection: null, source: 'default' });
});
test('projectTicket labels deliverables from the requested plan item, passing through title/description/spec/criteria', () => {
  const ticket = { id: 't', workspaceId: 'w', status: 'draft', revision: 1, plan: basePlan(), execution: null, activity: [] };
  const rows = projectTicket(ticket).deliverables;
  assert.equal(rows[0].label, 'Audit pack'); assert.equal(rows[0].spec, item.text);
  assert.equal(rows[0].title, 'Audit pack'); assert.equal(rows[0].description, item.description);
  assert.deepEqual(rows[0].criteria, item.criteria);
  assert.equal(rows[1].label, 'legacy string'); assert.equal(rows[1].spec, 'legacy string');
  // bound.label history never displaces the current plan title
  const executed = { ...ticket, status: 'running', execution: { currentConfigRevision: 1, configurations: { 1: { plan: ticket.plan, rules: [], sourceRefs: [] } }, nodes: {}, gates: {}, artifacts: { a1: { nodeId: 'n1', deliverableIndex: 0, label: 'old long spec', versions: [{ version: 1, sha256: 'x', snapshotPath: 's', submittedAt: 'now' }] } }, deliverables: { 0: { label: 'old long spec', artifactId: 'a1' } } } };
  const projected = projectTicket(executed).deliverables;
  assert.equal(projected[0].label, 'Audit pack'); assert.equal(projected[0].artifactId, 'a1');
});

// ---- Core display-title labels ----
test('core artifact/registry labels and override gaps use the deliverable display title', () => {
  const core = new FleetCore();
  core.saveDraftTicket('w', { id: 't', sessionId: 'origin', plan: basePlan() });
  core.human('w', 'u').start('t');
  const runtime = core.runtime('w');
  const worker = runtime.claimNode('t', 'n1');
  worker.attachSession('session-x');
  worker.submitEvidence({ artifacts: [{ sourcePath: 'qa/audit/report.md', deliverableIndex: 0, sha256: 'a'.repeat(64), size: 1, snapshotPath: 'sealed/v1' }], acceptanceResults: [], verification: [] });
  const state = core.readTicket('w', 't');
  const artifact = Object.values(state.execution.artifacts)[0];
  assert.equal(artifact.label, 'Audit pack');
  assert.equal(state.execution.deliverables['0'].label, 'Audit pack');
  // override gap labels also use the display title for the unbound legacy item
  const override = core.human('w', 'u').deliverOverride('t', 'manual release');
  assert.deepEqual(override.gaps.unbound, [{ index: 1, label: 'legacy string' }]);
});

// ---- Adapter selection application ----
function adapterFixture({ selectError, catalog } = {}) {
  const calls = { creates: [], selects: [], saves: [], catalogs: [] };
  let current = { provider: 'host', model: 'default-model', reasoningEffort: 'low' };
  const ctx = {
    sessionController: {
      async create(request) { calls.creates.push(request); return { sessionId: `session-${calls.creates.length}` }; },
      async selectModel(request) { calls.selects.push(request); if (selectError) throw selectError; current = { provider: request.provider, model: request.model, ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) }; return { selected: current }; },
      async modelCatalog() { calls.catalogs.push(true); return catalog ?? { default: current, groups: [], routableProviders: [], failures: [] }; }
    },
    agentDefaultModel: { currentSelection: () => ({ ...current }), async saveSelection(next) { calls.saves.push({ ...next }); current = { ...next }; } },
    sessionQuery: {}, agents: {}
  };
  return { calls, ctx, adapter: createDshAdapter(ctx), current: () => current };
}
test('adapter applies modelSelection after create and restores the previous global default', async () => {
  const f = adapterFixture();
  const result = await f.adapter.create({ workspaceId: 'w', profile: { instructions: 'x' }, modelSelection: { provider: 'p', model: 'm', reasoningEffort: 'high' } });
  assert.equal(result.sessionId, 'session-1');
  assert.deepEqual(f.calls.selects, [{ sessionId: 'session-1', provider: 'p', model: 'm', reasoningEffort: 'high' }]);
  assert.deepEqual(f.calls.saves, [{ provider: 'host', model: 'default-model', reasoningEffort: 'low' }]);
  assert.deepEqual(f.current(), { provider: 'host', model: 'default-model', reasoningEffort: 'low' });
});
test('adapter without modelSelection never touches selectModel or the default', async () => {
  const f = adapterFixture();
  await f.adapter.create({ workspaceId: 'w', profile: {} });
  assert.equal(f.calls.selects.length, 0); assert.equal(f.calls.saves.length, 0);
});
test('adapter serializes concurrent selections so defaults never cross-contaminate', async () => {
  const f = adapterFixture();
  let release; const gate = new Promise(r => release = r);
  const original = f.ctx.sessionController.selectModel;
  f.ctx.sessionController.selectModel = async request => { await gate; return original(request); };
  const a = f.adapter.create({ workspaceId: 'w', modelSelection: { provider: 'p', model: 'a' } });
  const b = f.adapter.create({ workspaceId: 'w', modelSelection: { provider: 'p', model: 'b' } });
  release();
  await Promise.all([a, b]);
  assert.deepEqual(f.calls.saves, [{ provider: 'host', model: 'default-model', reasoningEffort: 'low' }, { provider: 'host', model: 'default-model', reasoningEffort: 'low' }]);
  assert.deepEqual(f.current(), { provider: 'host', model: 'default-model', reasoningEffort: 'low' });
});
test('adapter selection failure is explicit; missing host capability refuses before create', async () => {
  const f = adapterFixture({ selectError: new Error('model unavailable') });
  await assert.rejects(f.adapter.create({ workspaceId: 'w', modelSelection: { provider: 'p', model: 'm' } }), e => e.code === 'model-selection-failed');
  const g = adapterFixture(); delete g.ctx.agentDefaultModel;
  await assert.rejects(g.adapter.create({ workspaceId: 'w', modelSelection: { provider: 'p', model: 'm' } }), e => e.code === 'unsupported-profile');
  assert.equal(g.calls.creates.length, 0);
  const h = adapterFixture();
  await assert.rejects(h.adapter.create({ workspaceId: 'w', modelSelection: { provider: 'p' } }), e => e.code === 'unsupported-profile');
});
test('adapter modelCatalog passes through the host catalog', async () => {
  const catalog = { default: { provider: 'host', model: 'd' }, groups: [{ id: 'host', name: 'Host', models: [{ id: 'd', name: 'D' }] }], routableProviders: ['host'], failures: [] };
  const f = adapterFixture({ catalog });
  assert.deepEqual(await f.adapter.modelCatalog(), catalog);
});

// ---- Service start validation and dispatch facts ----
const catalogFixture = { default: { provider: 'host', model: 'default-model' }, routableProviders: ['host', 'p'], groups: [{ id: 'host', name: 'Host', models: [{ id: 'default-model', name: 'Default' }] }, { id: 'p', name: 'P', models: [{ id: 'm', name: 'M', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }] }], failures: [] };
function serviceHost() {
  const calls = { create: [], submit: [] }, sessions = new Map();
  const adapter = {
    async create(r) { calls.create.push(structuredClone(r)); const sessionId = `s-${sessions.size + 1}`; sessions.set(sessionId, { status: 'unknown' }); return { sessionId }; },
    async submit(r) { calls.submit.push(structuredClone(r)); sessions.set(r.sessionId, { status: 'running' }); return { messageId: r.requestId }; },
    async recover() {}, async inspect(r) { return structuredClone(sessions.get(r.sessionId) ?? { status: 'unknown' }); },
    async cancel(r) { sessions.set(r.sessionId, { status: 'stopped' }); return { stopped: true }; },
    async message(r) { return { messageId: r.requestId }; },
    async modelCatalog() { return structuredClone(catalogFixture); }
  };
  return { calls, sessions, adapter };
}
async function serviceFixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-clarity-service-'));
  const h = serviceHost();
  const service = await FleetService.open({ rootPath: path.join(temp, 'root'), workspacePaths: { a: path.join(temp, 'a') }, adapter: h.adapter, autoStart: false });
  t.after(async () => { await service.close(); const target = path.resolve(temp); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert(path.basename(target).startsWith('fleet-clarity-service-')); await fs.rm(target, { recursive: true, force: true }); });
  return { service, h, temp };
}
test('start rejects selections absent from the host catalog with a next-step diagnostic', async t => {
  const f = await serviceFixture(t);
  const p = basePlan(); p.nodes[0].modelSelection = { provider: 'p', model: 'missing' };
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: p });
  await assert.rejects(f.service.human('a', 'u', 'start', ['t']), e => e.code === 'unsupported-profile' && /not in the host model catalog/.test(e.message));
  const q = basePlan(); q.nodes[0].modelSelection = { provider: 'p', model: 'm', reasoningEffort: 'ultra' };
  await f.service.saveDraftTicket('a', { id: 't2', sessionId: 'origin', plan: q });
  await assert.rejects(f.service.human('a', 'u', 'start', ['t2']), e => e.code === 'unsupported-profile' && /reasoningEffort/.test(e.message));
  assert.equal(f.h.calls.create.length, 0);
});
test('node override beats agent selection; dispatch detail records it and prompts carry bound criteria', async t => {
  const f = await serviceFixture(t);
  const p = basePlan();
  p.agents.w.profile.modelSelection = { provider: 'p', model: 'm', reasoningEffort: 'low' };
  p.nodes[0].modelSelection = { provider: 'p', model: 'm', reasoningEffort: 'high' };
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: p });
  await f.service.human('a', 'u', 'start', ['t']); await f.service.tick();
  assert.deepEqual(f.h.calls.create[0].modelSelection, { provider: 'p', model: 'm', reasoningEffort: 'high' });
  const ticket = await f.service.read('a', 't');
  const attempt = ticket.execution.nodes.n1.attempts.at(-1);
  assert.deepEqual(attempt.dispatch.detail.modelSelection, { provider: 'p', model: 'm', reasoningEffort: 'high' });
  assert.match(f.h.calls.submit[0].prompt, /Audit pack/); assert.match(f.h.calls.submit[0].prompt, /c1: pack complete/);
  assert.match(f.h.calls.submit[0].prompt, /I will write the report/);
});
test('agent-level selection applies when the node has no override; default nodes send no selection', async t => {
  const f = await serviceFixture(t);
  const p = basePlan(); p.agents.w.profile.modelSelection = { provider: 'p', model: 'm' };
  p.nodes.push({ id: 'n2', agentId: 'w', dependsOn: ['n1'], task: { prompt: 'second' } });
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: p });
  await f.service.human('a', 'u', 'start', ['t']); await f.service.tick();
  assert.deepEqual(f.h.calls.create[0].modelSelection, { provider: 'p', model: 'm' });
  f.h.sessions.set('s-1', { status: 'completed', output: 'done' }); await f.service.tick();
  assert.deepEqual(f.h.calls.create[1].modelSelection, { provider: 'p', model: 'm' });
  const plain = basePlan();
  await f.service.saveDraftTicket('a', { id: 't2', sessionId: 'origin', plan: plain });
  await f.service.human('a', 'u', 'start', ['t2']); await f.service.tick();
  assert.equal(Object.hasOwn(f.h.calls.create[2], 'modelSelection'), false);
});
test('agent gate review session uses the reviewer node effective selection', async t => {
  const f = await serviceFixture(t);
  const p = basePlan();
  p.agents.w.profile.modelSelection = { provider: 'p', model: 'm', reasoningEffort: 'low' };
  p.nodes[0].modelSelection = { provider: 'p', model: 'm', reasoningEffort: 'high' };
  p.gates = [{ id: 'q', from: ['n1'], to: [], reviewer: { kind: 'agent', nodeId: 'n1' } }];
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: p });
  await f.service.human('a', 'u', 'start', ['t']); await f.service.tick();
  f.h.sessions.set('s-1', { status: 'completed', output: 'done' }); await f.service.tick();
  const review = f.h.calls.create.find(c => c.title.includes('审核'));
  assert.deepEqual(review.modelSelection, { provider: 'p', model: 'm', reasoningEffort: 'high' });
});
test('start without selections never reads the model catalog', async t => {
  const f = await serviceFixture(t);
  let reads = 0; const original = f.h.adapter.modelCatalog; f.h.adapter.modelCatalog = async () => { reads++; return original(); };
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: basePlan() });
  await f.service.human('a', 'u', 'start', ['t']);
  assert.equal(reads, 0);
});
