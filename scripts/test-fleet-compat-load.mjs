// 0.7.1 P-39 read-only compatibility load: incompatible drafts load untouched (no mutation, no auto-archive),
// are derived as incompatible, and never break the workspace; executed tickets stay strict; chain guards hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FleetCore } from '../src/fleet-core.js';
import { FleetPersistence, FleetService } from '../src/fleet-service.js';
import { FleetStore } from '../src/fleet-store.js';
import { normalizePlan, validatePlan, isIncompatibleDraft } from '../src/fleet-model.js';

const settings = { revision: 1, rules: [], generation: { rules: [] }, execution: { rules: [] } };
const stateWith = (tickets, id = 'w') => ({ schemaVersion: 2, templates: [], settings, workspaces: [{ id, tickets }] });
const draft = (id, plan, extra = {}) => ({ id, workspaceId: 'w', originSessionId: 's', status: 'draft', revision: 1, createdAt: null, updatedAt: null, plan, execution: null, activity: [], ...extra });
const incompatiblePlan = { contractVersion: 2, goal: 'retired draft version', inputs: {}, deliverables: [], criteria: [], agents: {}, nodes: [], gates: [] };
const legacyShapePlan = { ticket: { goal: 'legacy shape', inputs: {}, criteria: [] } };

test('incompatible draft (retired contractVersion, no archive) loads untouched and is derived incompatible', () => {
  const inc = draft('inc', structuredClone(incompatiblePlan));
  const core = FleetCore.fromState(stateWith([inc]));
  const t = core.readTicket('w', 'inc');
  assert.equal(t.plan.contractVersion, incompatiblePlan.contractVersion, 'plan must not be rewritten');
  assert.equal(t.legacy, undefined, 'no auto-archive may be added');
  assert.equal(isIncompatibleDraft(t), true);
  assert.equal(validatePlan(t.plan, { mode: 'save' }).valid, false);
});
test('incompatible draft (legacy shape, no contractVersion, no archive) loads and is derived incompatible', () => {
  const core = FleetCore.fromState(stateWith([draft('legacy', structuredClone(legacyShapePlan))]));
  const t = core.readTicket('w', 'legacy');
  assert.equal(t.legacy, undefined);
  assert.equal(isIncompatibleDraft(t), true);
  assert.equal(t.plan.ticket.goal, 'legacy shape', 'original content preserved');
});
test('a single incompatible draft does not break loading the rest of the workspace', () => {
  const valid = draft('valid', normalizePlan({ goal: 'ok', nodes: [{ id: 'n', task: { prompt: 'p' } }] }));
  const core = FleetCore.fromState(stateWith([draft('inc', structuredClone(incompatiblePlan)), valid]));
  assert.equal(core.readTicket('w', 'inc').plan.contractVersion, incompatiblePlan.contractVersion);
  const v = core.readTicket('w', 'valid');
  assert.equal(v.plan.contractVersion, 3);
  assert.equal(v.plan.nodes[0].agentId, null, 'valid drafts still normalize defaults');
  assert.equal(isIncompatibleDraft(v), false);
});
test('load is read-only: the input state is not mutated (no archive injected)', () => {
  const input = stateWith([draft('inc', structuredClone(incompatiblePlan))]);
  const before = JSON.stringify(input);
  FleetCore.fromState(input);
  assert.equal(JSON.stringify(input), before, 'fromState must not mutate the loaded state');
});
test('executed ticket with a version-mismatched plan loads untouched (historical preserved)', () => {
  const running = { id: 'run', workspaceId: 'w', originSessionId: 's', status: 'running', revision: 1, createdAt: null, updatedAt: null, plan: structuredClone(incompatiblePlan), execution: { currentConfigRevision: 1, configurations: { 1: { plan: {} } }, nodes: {}, gates: {} }, activity: [] };
  const core = FleetCore.fromState(stateWith([running]));
  const t = core.readTicket('w', 'run');
  assert.equal(t.plan.contractVersion, incompatiblePlan.contractVersion, 'a support-version bump must not break historical executed records');
  assert.equal(t.legacy, undefined);
});
test('draft deletion supports incompatible plans without disturbing historical neighbors', () => {
  const execution = {currentConfigRevision:1, configurations:{1:{plan:incompatiblePlan}}, nodes:{}, gates:{}};
  const historical = draft('historical', {contractVersion:1, nodes:{legacyNode:{}}}, {status:'delivered', execution});
  const executedDraft = draft('executed-draft', incompatiblePlan, {execution});
  const sibling = draft('sibling', legacyShapePlan);
  const core = FleetCore.fromState(stateWith([draft('legacy', legacyShapePlan), historical, executedDraft, sibling]));
  const human = core.human('w', 'person');
  assert.deepEqual(human.deleteDraftTicket('legacy', 1), {deletedTicketId:'legacy'});
  for (const id of ['historical', 'executed-draft']) assert.throws(() => human.deleteDraftTicket(id, 1), e => e.code === 'control-locked');
  assert.throws(() => human.repairTicket('sibling', 1, {goal:'Repair', ticketDependencies:['legacy']}), e => e.code === 'unknown-ticket');
  assert.deepEqual(core.listTickets('w'), [historical, executedDraft, sibling]);
});
test('executed ticket with corrupt execution structure still fails strictly', () => {
  const bad = { id: 'run', workspaceId: 'w', originSessionId: 's', status: 'running', revision: 1, createdAt: null, updatedAt: null, plan: normalizePlan({ goal: 'ok' }), execution: { currentConfigRevision: 9, configurations: { 1: { plan: {} } }, nodes: {}, gates: {} }, activity: [] };
  assert.throws(() => FleetCore.fromState(stateWith([bad])), e => e.code === 'invalid-state');
});
test('superseded incompatible draft loads untouched like a draft', () => {
  const core = FleetCore.fromState(stateWith([draft('sup', structuredClone(incompatiblePlan), { status: 'superseded' })]));
  const t = core.readTicket('w', 'sup');
  assert.equal(t.legacy, undefined);
  assert.equal(t.plan.contractVersion, incompatiblePlan.contractVersion);
});

// ---- Service level: read tolerance, chain-boundary guard, regenerate path ----
function host() {
  const sessions = new Map();
  return { sessions, adapter: {
    async create() { const sessionId = `s-${sessions.size + 1}`; sessions.set(sessionId, { status: 'unknown' }); return { sessionId }; },
    async submit(r) { sessions.set(r.sessionId, { status: 'running' }); return { messageId: r.requestId }; },
    async recover() {}, async inspect(r) { return structuredClone(sessions.get(r.sessionId) ?? { status: 'unknown' }); },
    async cancel(r) { sessions.set(r.sessionId, { status: 'stopped' }); return { stopped: true }; },
    async message(r) { return { messageId: r.requestId }; }, async modelCatalog() { return { default: null, groups: [], routableProviders: [], failures: [] }; }
  } };
}
async function serviceFixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-compat-load-'));
  const h = host();
  const service = await FleetService.open({ rootPath: path.join(temp, 'root'), workspacePaths: { a: path.join(temp, 'a'), b: path.join(temp, 'b') }, adapter: h.adapter, autoStart: false });
  t.after(async () => { await service.close(); const target = path.resolve(temp); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert(path.basename(target).startsWith('fleet-compat-load-')); await fs.rm(target, { recursive: true, force: true }); });
  return { service, temp, h };
}
const writeWorkspace = async (dir, id, tickets) => { const store = await FleetStore.open({ dir, kind: 'workspace' }); await store.commit({ schemaVersion: 2, id, tickets }); await store.close(); };
test('service reads a workspace containing an incompatible draft without faulting', async t => {
  const f = await serviceFixture(t);
  const incA = { ...draft('inc', structuredClone(incompatiblePlan)), workspaceId: 'a' };
  await writeWorkspace(path.join(f.temp, 'a', '.fleet'), 'a', [incA]);
  const tickets = await f.service.read('a');
  assert.equal(tickets.length, 1);
  assert.equal(isIncompatibleDraft(tickets[0]), true);
  assert.equal(f.service.health.ready, true);
});
test('deleting a legacy draft publishes the remaining workspace history without rewriting it', async t => {
  const f = await serviceFixture(t), dir = path.join(f.temp, 'a', '.fleet');
  const store = await FleetStore.open({dir, kind:'workspace'});
  const historical = {...draft('old-replacement', incompatiblePlan), workspaceId:'a', status:'superseded'};
  try {
    await store.commit({schemaVersion:1, id:'a', definitions:{agents:[], flows:[]}, binding:null, tickets:[
      {id:'legacy', workspaceId:'a', status:'confirmed', sessionId:'retired-session', revision:4, plan:legacyShapePlan}, historical
    ]});
  } finally { await store.close(); }
  assert(isIncompatibleDraft(await f.service.read('a', 'legacy')));
  assert.deepEqual(await f.service.human('a', 'u', 'deleteDraftTicket', ['legacy', 4]), {deletedTicketId:'legacy'});
  const reopened = await FleetService.open({rootPath:path.join(f.temp, 'root'), workspacePaths:{a:path.join(f.temp,'a')}, adapter:f.h.adapter, autoStart:false});
  try { assert.deepEqual(await reopened.read('a'), [historical]); } finally { await reopened.close(); }
});
test('incompatible draft with unrecognized routing fields remains visible and cannot break the Dashboard', async t => {
  const f = await serviceFixture(t);
  const oldPlan = {...incompatiblePlan, logicGates: {draft: true}, ticketDependencySeries: 'unrecognized', nodes: [{id: 'old-node', ticketDependencySeries: 4}]};
  const malformedPlan = {...normalizePlan({goal:'Invalid routing draft'}), logicGates: [{id:'incomplete', routes: [null]}], ticketDependencies: 'unrecognized'};
  const legacy = {...draft('old', oldPlan), workspaceId:'a'};
  const malformed = {...draft('malformed', malformedPlan), workspaceId:'a'};
  const valid = {...draft('valid', normalizePlan({goal:'Readable'})), workspaceId:'a'};
  await writeWorkspace(path.join(f.temp, 'a', '.fleet'), 'a', [legacy, malformed, valid]);
  const [oldRow, malformedRow, validRow] = await f.service.dashboardTickets('a');
  assert.equal(isIncompatibleDraft(oldRow), true);
  assert.equal(isIncompatibleDraft(malformedRow), true);
  assert.equal(isIncompatibleDraft(validRow), false);
  assert.deepEqual(oldRow.plan, oldPlan);
  assert.deepEqual(malformedRow.plan, malformedPlan);
  assert.equal(oldRow.dependencyReadiness, undefined);
  assert.equal(malformedRow.dependencyReadiness, undefined);
  assert.equal(f.service.health.ready, true);
});
test('a write transaction on one workspace is not broken by another workspace incompatible draft (chain guard)', async t => {
  const f = await serviceFixture(t);
  const incA = { ...draft('inc', structuredClone(incompatiblePlan)), workspaceId: 'a' };
  const validB = { ...draft('valid', normalizePlan({ goal: 'b ok' })), workspaceId: 'b' };
  await writeWorkspace(path.join(f.temp, 'a', '.fleet'), 'a', [incA]);
  await writeWorkspace(path.join(f.temp, 'b', '.fleet'), 'b', [validB]);
  // Root-scoped transaction (replaceGlobalSettings) must succeed even though workspace 'a' holds an incompatible draft.
  await f.service.human('b', 'u', 'replaceGlobalSettings', [{ rules: ['r'], generation: { rules: [] }, execution: { rules: [] } }]);
  assert.equal(f.service.health.ready, true);
  // Workspace-scoped save on 'b' also succeeds; 'a' remains untouched and incompatible.
  await f.service.saveDraftTicket('b', { id: 'another', sessionId: 's', plan: normalizePlan({ goal: 'another' }) });
  const a = await f.service.read('a');
  assert.equal(isIncompatibleDraft(a[0]), true);
  assert.equal(a[0].legacy, undefined, 'no archive injected into the other workspace');
});
test('regenerate builds a new compatible Ticket from an incompatible draft and supersedes the original', async t => {
  const f = await serviceFixture(t);
  const incA = { ...draft('inc', structuredClone(incompatiblePlan)), workspaceId: 'a' };
  await writeWorkspace(path.join(f.temp, 'a', '.fleet'), 'a', [incA]);
  const fresh = await f.service.human('a', 'u', 'regenerateTicket', ['inc', 1, normalizePlan({ goal: 'rebuilt in current format' }), 's']);
  assert.equal(fresh.plan.contractVersion, 3);
  assert.equal(fresh.status, 'draft');
  const old = (await f.service.read('a')).find(x => x.id === 'inc');
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, fresh.id);
  assert.equal(old.plan.contractVersion, incompatiblePlan.contractVersion, 'original incompatible draft preserved as reference');
});

// ---- P-77 upgrade round-trip: a pre-P-77 Root chain (no `admin`) must not fault the first write ----
// Fixture is a real committed Root chain carrying exactly the ≤0.14.x settings payload plus a real
// schemaVersion-2 Workspace chain, so the test exercises FleetPersistence.load, the chain-boundary
// guard and the first Workspace transaction instead of an in-memory state literal.
const preP77Settings = { revision: 1, rules: [], generation: { rules: [] }, execution: { rules: [] } };
async function upgradeFixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-upgrade-roundtrip-'));
  const rootPath = path.join(temp, 'root'), wsPath = path.join(temp, 'w');
  const root = await FleetStore.open({ dir: rootPath, kind: 'templates' });
  await root.commit({ schemaVersion: 2, templates: [], settings: preP77Settings });
  await root.close();
  const store = await FleetStore.open({ dir: path.join(wsPath, '.fleet'), kind: 'workspace' });
  await store.commit({ schemaVersion: 2, id: 'w', tickets: [] });
  await store.close();
  t.after(async () => { const target = path.resolve(temp); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert(path.basename(target).startsWith('fleet-upgrade-roundtrip-')); await fs.rm(target, { recursive: true, force: true }); });
  return { rootPath, wsPath };
}
test('pre-P-77 Root settings load→fromState→exportState stay equal and the first Workspace draft save succeeds', async t => {
  const f = await upgradeFixture(t);
  const persistence = await FleetPersistence.open({ rootPath: f.rootPath, workspacePaths: { w: f.wsPath } });
  let loaded;
  try { loaded = await persistence.load(); } finally { await persistence.close(); }
  assert.deepEqual(Object.keys(loaded.settings).sort(), ['admin', 'execution', 'generation', 'revision', 'rules'].sort(), 'load normalizes pre-P-77 settings');
  assert.deepEqual(loaded.settings.admin, { workspaces: [] });
  const exported = FleetCore.fromState(loaded).exportState();
  assert.deepEqual(exported.settings, loaded.settings, 'load and fromState→exportState must agree on settings');

  const h = host();
  const service = await FleetService.open({ rootPath: f.rootPath, workspacePaths: { w: f.wsPath }, adapter: h.adapter, autoStart: false });
  try {
    assert.equal(service.health.ready, true);
    const saved = await service.saveDraftTicket('w', { id: 'upgrade-draft', sessionId: 's', plan: normalizePlan({ goal: 'upgrade round-trip draft' }) });
    assert.equal(saved.id, 'upgrade-draft');
    assert.equal(service.health.ready, true, 'the first upgrade write must not fault the service');
    assert.equal(service.health.error, null);
    assert.deepEqual((await service.read('w')).map(ticket => ticket.id), ['upgrade-draft']);
  } finally { await service.close(); }
  // Normalization happens on load; the committed Root chain is not rewritten implicitly.
  const rootDisk = await FleetStore.read({ dir: f.rootPath, kind: 'templates' });
  assert.equal(Object.hasOwn(rootDisk.settings, 'admin'), false, 'load must not publish an unrequested Root mutation');
});
