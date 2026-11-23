import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetCore } from '../src/fleet-core.js';
import { normalizePlan, projectTicket, validatePlan } from '../src/fleet-model.js';
import { validateWorkspaceState } from '../src/fleet-store.js';

const ws = 'work';
const task = (id, dependsOn = [], extra = {}) => ({ id, dependsOn, agentId: 'agent', task: { prompt: id }, ...extra });
const plan = (fields = {}) => normalizePlan({ goal: 'Run the workflow', agents: { agent: { profile: {} } }, nodes: [task('work')], ...fields });
const eq = (key, value) => ({ path: [key], operator: 'eq', value });
const route = (id, to, condition) => ({ id, to: [to], condition });
const save = (core, id, fields) => core.saveDraftTicket(ws, { id, plan: plan(fields) });
const human = core => core.human(ws, 'person');
const runtime = core => core.runtime(ws);
const read = (core, id) => core.readTicket(ws, id);
const start = (core, id) => human(core).start(id);
const finish = (core, id, node, handoff, artifacts) => {
  const worker = runtime(core).claimNode(id, node);
  if (handoff || artifacts) worker.submitEvidence({ ...(handoff ? { handoff } : {}), ...(artifacts ? { artifacts } : {}) });
  worker.complete({});
};
const artifact = index => ({ deliverableIndex: index, sourcePath: `${index}.txt`, snapshotPath: `snapshot/${index}.txt`, sha256: 'a'.repeat(64), size: 1 });
const recordDelivery = (core, id, items) => runtime(core).recordDelivery(id, { items, manifestPath: 'manifest.json', receiptPath: 'receipt.json' });
const branching = (extra = {}) => ({
  nodes: [task('source'), task('a'), task('b'), task('join', ['a', 'b']), task('independent')],
  logicGates: [{ id: 'switch', from: 'source', routes: [route('a', 'a', eq('a', true)), route('b', 'b', eq('b', true))] }],
  ...extra
});

for (const [a, b] of [[true, true], [true, false], [false, true], [false, false]]) test(`routes a=${a} b=${b} settle correctly after reload`, () => {
  let core = new FleetCore();
  save(core, 'down', branching()); start(core, 'down');
  assert.deepEqual(runtime(core).runnable('down'), ['source', 'independent']);
  finish(core, 'down', 'source', { a, b });
  core = FleetCore.fromState(JSON.parse(JSON.stringify(core.exportState())));
  assert.equal(runtime(core).advanceLogic('down'), false);
  assert.deepEqual(runtime(core).runnable('down'), [...(a ? ['a'] : []), ...(b ? ['b'] : []), 'independent']);
  if (a) finish(core, 'down', 'a');
  if (b) finish(core, 'down', 'b');
  if (a || b) finish(core, 'down', 'join');
  finish(core, 'down', 'independent');
  const projected = projectTicket(read(core, 'down'));
  assert.equal(projected.status, 'delivered');
  assert.deepEqual(projected.logicGates[0].routes.map(r => r.status), [a ? 'completed' : 'skipped', b ? 'completed' : 'skipped']);
  assert.equal(projected.nodes.find(n => n.id === 'join').status, a || b ? 'completed' : 'skipped');
  assert.equal(projected.activity.filter(e => e.type === 'logic-gate-decided').length, 1);
});

test('retry reevaluates the latest handoff and requires a fresh receipt for newly active outputs', () => {
  let core = new FleetCore();
  save(core, 'down', branching({ deliverables: [{ text: 'a output', whenNodeRuns: 'a' }, 'Always required'] }));
  start(core, 'down'); finish(core, 'down', 'independent', null, [artifact(1)]);
  finish(core, 'down', 'source', { a: false, b: false });
  assert.equal(projectTicket(read(core, 'down')).deliverables[0].reviewStatus, 'skipped');
  const first = runtime(core).deliveryPending('down');
  assert.deepEqual(first.items.map(i => i.deliverableIndex), [1]);
  recordDelivery(core, 'down', first.items);
  const firstDecision = read(core, 'down').execution.logicDecisions.switch;
  human(core).retryNode('down', 'source', 'Refresh the input data');
  finish(core, 'down', 'source', { a: true, b: false });
  finish(core, 'down', 'a', null, [artifact(0)]); finish(core, 'down', 'join');
  assert.equal(read(core, 'down').status, 'running');
  assert.notEqual(read(core, 'down').execution.logicDecisions.switch.attemptId, firstDecision.attemptId);
  const second = runtime(core).deliveryPending('down');
  assert.deepEqual(second.items.map(i => i.deliverableIndex), [0, 1]);
  recordDelivery(core, 'down', second.items);
  core = FleetCore.fromState(core.exportState());
  assert.equal(read(core, 'down').status, 'delivered');
  assert.equal(read(core, 'down').execution.delivery.history.length, 2);
  assert.equal(read(core, 'down').activity.filter(e => e.type === 'logic-gate-decided').length, 2);
});

test('a review with mixed sources reviews only when its required executed source is complete', () => {
  const core = new FleetCore();
  const gates = [{ id: 'review', from: ['a', 'b'], to: ['join'], reviewer: { kind: 'agent', nodeId: 'b' }, requireEvidence: true }];
  save(core, 'down', branching({ gates })); start(core, 'down'); finish(core, 'down', 'source', { a: true });
  assert.equal(runtime(core).gateReady('down', 'review'), false);
  assert.throws(() => runtime(core).reviewer('down', 'review'), { code: 'not-reviewable' });
  finish(core, 'down', 'a', {});
  assert.equal(read(core, 'down').execution.nodes.b.status, 'skipped');
  assert.equal(runtime(core).gateReady('down', 'review'), true);
  runtime(core).reviewer('down', 'review').submit('passed', 'reviewed remaining evidence');
  assert.ok(runtime(core).runnable('down').includes('join'));
});

test('missing and inherited fields do not match; ordering compares values without coercion', () => {
  const core = new FleetCore();
  const cases = [
    ['missing', { path: ['absent'], operator: 'ne', value: null }, false],
    ['inherited', { path: ['toString'], operator: 'exists' }, false],
    ['nested', { path: ['nested', 'value'], operator: 'exists' }, true],
    ['numeric', { path: ['amount'], operator: 'gte', value: 3 }, true],
    ['mixed', { path: ['amount'], operator: 'gt', value: '2' }, false]
  ];
  save(core, 'down', { nodes: [task('source'), ...cases.map(([id]) => task(id))], logicGates: [{ id: 'logic', from: 'source', routes: cases.map(([id, condition]) => route(id, id, condition)) }] });
  start(core, 'down'); finish(core, 'down', 'source', { nested: { value: null }, amount: 3 });
  assert.deepEqual(read(core, 'down').execution.logicDecisions.logic.routes.map(r => r.matched), cases.map(([, , matches]) => matches));
});

test('authorization is revision bound, survives reload, starts once, and pins sealed inputs', () => {
  let core = new FleetCore();
  save(core, 'a', { deliverables: ['Evidence'] }); save(core, 'b');
  const draft = save(core, 'down', { ticketDependencies: ['a', 'b'] });
  assert.throws(() => start(core, 'down'), { code: 'dependency-wait' });
  const authorized = human(core).enableDependencies('down', draft.revision);
  const edit = core.saveDraftTicket(ws, { ticketId: 'down', expectedRevision: authorized.revision, plan: { ...authorized.plan, goal: 'Edited' } });
  assert.equal(edit.dependencyAuthorization, undefined);
  human(core).enableDependencies('down', edit.revision);
  start(core, 'a'); finish(core, 'a', 'work', null, [artifact(0)]); recordDelivery(core, 'a', runtime(core).deliveryPending('a').items);
  core = FleetCore.fromState(core.exportState());
  assert.deepEqual(runtime(core).dependencyReadiness('down').waitingTicketIds, ['b']);
  start(core, 'b'); finish(core, 'b', 'work');
  const running = runtime(core).startWhenReady('down');
  assert.equal(running.status, 'running');
  assert.deepEqual(runtime(core).startWhenReady('down'), running);
  human(core).retryNode('a', 'work', 'Produce a later version');
  const upstream = runtime(core).claimNode('down', 'work').input().upstreamTickets;
  assert.deepEqual(upstream.map(t => t.ticketId), ['a', 'b']);
  assert.equal(upstream[0].deliverables[0].snapshotPath, 'snapshot/0.txt');
  assert.equal(upstream[0].deliverables[0].version, 1);
});

test('validates workspace Ticket cycles, series cycles, and combined Logic Gate DAG edges', () => {
  const core = new FleetCore();
  core.saveDraftTicket('elsewhere', { id: 'a', plan: plan() });
  assert.throws(() => save(core, 'down', { ticketDependencies: ['a'] }), { code: 'unknown-ticket' });
  const a = save(core, 'a'); save(core, 'b', { nodes: [task('b', [], { ticketDependencies: ['a'] })] });
  assert.throws(() => core.saveDraftTicket(ws, { ticketId: 'a', expectedRevision: a.revision, plan: { ...a.plan, ticketDependencies: ['b'] } }), { code: 'invalid-flow' });
  const cyclic = plan(branching({ nodes: [task('source', ['a']), task('a'), task('b')] }));
  assert.ok(validatePlan(cyclic, { mode: 'start' }).errors.some(e => e.code === 'invalid-flow'));
  const invalid = plan({ deliverables: [{ text: 'conditional', whenNodeRuns: 'missing' }] });
  assert.ok(validatePlan(invalid, { mode: 'start' }).errors.some(e => e.code === 'invalid-flow'));
  const create = (id, refs) => core.createSeries(ws, { id, name: id, plan: plan({ ticketDependencySeries: refs }), scheduleId: id, targetSessionId: id, timing: { kind: 'daily' } });
  const s = create('series-a', []); create('series-b', [s.id]);
  assert.throws(() => core.updateSeriesPlan(ws, s.id, { expectedRevision: s.revision, fields: { ticketDependencySeries: ['series-b'] } }), { code: 'invalid-flow' });
});

test('step-only occurrence runs independent work and binds the concrete instance across reload', () => {
  let core = new FleetCore();
  const create = (id, fields, extra = {}) => core.createSeries(ws, { id, name: id, plan: plan(fields), scheduleId: 'clock', targetSessionId: 'session', timing: { kind: 'daily' }, ...extra });
  create('up', {});
  const first = '2026-11-24T00:00:00.000Z', second = '2026-11-25T00:00:00.000Z';
  const up = core.recordOccurrenceAndStart(ws, 'up', { occurrenceAt: first }).ticketId;
  const down = create('down', { nodes: [task('free'), task('wait', [], { ticketDependencySeries: ['up'] })] }, { triggerSeriesId: 'up' });
  assert.equal(down.triggerAfterCount, 1);
  const id = core.recordOccurrenceAndStart(ws, 'down', { occurrenceAt: second }).ticketId;
  assert.deepEqual(runtime(core).runnable(id), ['free']); finish(core, id, 'free');
  const up2 = core.recordOccurrenceAndStart(ws, 'up', { occurrenceAt: second }).ticketId;
  runtime(core).bindOccurrence(id, { up: up2 });
  assert.throws(() => runtime(core).bindOccurrence(id, { up }), { code: 'state-conflict' });
  const state = core.exportState();
  validateWorkspaceState({ schemaVersion: 2, ...state.workspaces[0] });
  core = FleetCore.fromState(state);
  assert.deepEqual(projectTicket(read(core, id)).nodes.find(n => n.id === 'wait').ticketDependencies, [up2]);
  finish(core, up, 'work'); assert.deepEqual(runtime(core).runnable(id), []);
  finish(core, up2, 'work'); assert.deepEqual(runtime(core).runnable(id), ['wait']);
  assert.equal(core.recordOccurrenceAndStart(ws, 'down', { occurrenceAt: second }).ticketId, id);
});

test('completed runs retain their original dependency and conditional configuration', () => {
  const core = new FleetCore();
  save(core, 'down', branching()); start(core, 'down'); finish(core, 'down', 'source', { a: true });
  human(core).stop('down');
  const before = read(core, 'down');
  assert.throws(() => core.saveDraftTicket(ws, { ticketId: 'down', expectedRevision: before.revision, plan: { ...before.plan, logicGates: [] } }), { code: 'completed-work-conflict' });
  assert.deepEqual(read(core, 'down'), before);
  const legacy = save(core, 'old');
  assert.deepEqual(FleetCore.fromState(core.exportState()).readTicket(ws, 'old'), legacy);
});
