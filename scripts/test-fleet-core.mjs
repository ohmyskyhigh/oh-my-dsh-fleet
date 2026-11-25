// Canonical Ticket domain acceptance. Memory only; no real Sessions or business data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetCore, FleetCoreError } from '../src/fleet-core.js';
import { normalizePlan, validatePlan, projectTicket, graphLevels } from '../src/fleet-model.js';
const plan = () => normalizePlan({ goal: 'Ship verified work', inputs: { nested: { paths: ['one', 'two'] } }, deliverables: [], criteria: ['line one\nline two'], requirements: 'scope', agents: { writer: { name: 'Writer', profile: { instructions: 'write', nested: { supportedMetadata: true } } }, reviewer: { profile: { instructions: 'review' } } }, nodes: [{ id: 'a', role: 'same', agentId: 'writer', task: { prompt: 'first', extra: { keep: true } }, dependsOn: [] }, { id: 'b', role: 'same', agentId: 'reviewer', dependsOn: ['a'], task: { prompt: 'second' } }], gates: [] });
function fixture(p = plan()) {
  const core = new FleetCore();
  core.saveDraftTicket('w', { id: 't', sessionId: 'origin', plan: p });
  const human = core.human('w', 'person'), runtime = core.runtime('w');
  return { core, human, runtime, read: () => core.readTicket('w', 't'), start: () => human.start('t'), save: p => core.saveDraftTicket('w', { ticketId: 't', expectedRevision: core.readTicket('w', 't').revision, plan: p }) };
}
const rejects = (fn, code) => assert.throws(fn, e => e.code === code);
test('goal-only draft normalizes; save accepts incomplete references and start alone validates execution', () => {
  const f = fixture({ goal: 'need something' });
  assert.equal(f.read().plan.contractVersion, 3); assert.equal(f.read().execution, null);
  assert.deepEqual(f.read().plan.deliverables, []); rejects(f.start, 'incomplete-plan');
  const incomplete = normalizePlan({ goal: 'g', nodes: [{ id: 'x', agentId: null, dependsOn: ['not-yet'], task: {} }] });
  assert.equal(validatePlan(incomplete).valid, true); assert.equal(validatePlan(incomplete, { mode: 'start' }).valid, false);
  f.save(incomplete); assert.equal(f.read().status, 'draft');
});
test('only goal changes: all other plan fields survive and activity is the sole change source', () => {
  const f = fixture(), before = f.read(); f.save({ ...before.plan, goal: 'new goal' });
  const after = f.read(); assert.deepEqual({ ...after.plan, goal: before.plan.goal }, before.plan);
  assert.equal(after.revision, before.revision + 1); assert.equal(after.createdAt, before.createdAt);
  assert.deepEqual(after.activity.at(-1).detail.before, before.plan); assert.deepEqual(after.activity.at(-1).detail.paths, ['plan.goal']);
  for (const key of ['goal', 'nodes', 'snapshot', 'events', 'changes', 'criteria']) assert.equal(Object.hasOwn(after, key), false);
  assert.equal(projectTicket(after).changes.length, 1);
});
test('P-69 manual abandonment: CAS, draft/stopped only, start blocked until reversed, event trail and compat validation', () => {
  const f = fixture(), before = f.read();
  rejects(() => f.human.abandonTicket('t', before.revision + 5), 'stale-revision');
  const abandoned = f.human.abandonTicket('t', before.revision, 'not needed anymore');
  assert.equal(abandoned.status, 'draft'); assert.match(abandoned.abandonedAt, /Z$/);
  assert.equal(abandoned.activity.at(-1).type, 'ticket-abandoned'); assert.equal(abandoned.activity.at(-1).detail.reason, 'not needed anymore');
  assert.equal(projectTicket(abandoned).abandonedAt, abandoned.abandonedAt);
  rejects(f.start, 'state-conflict');
  const again = f.human.abandonTicket('t', abandoned.revision); assert.equal(again.revision, abandoned.revision, 'repeat abandon is idempotent');
  const restored = f.human.unabandonTicket('t', again.revision);
  assert.equal(Object.hasOwn(restored, 'abandonedAt'), false); assert.equal(restored.activity.at(-1).type, 'ticket-abandon-reversed');
  f.start(); assert.equal(f.read().status, 'running');
  rejects(() => f.human.abandonTicket('t', f.read().revision), 'control-locked');
  f.human.stop('t'); assert.equal(f.read().status, 'stopped');
  const stoppedAbandon = f.human.abandonTicket('t', f.read().revision);
  assert.equal(stoppedAbandon.status, 'stopped');
  rejects(() => f.human.resume('t'), 'state-conflict');
  rejects(() => f.human.unabandonTicket('t', 1), 'stale-revision');
  f.human.unabandonTicket('t', stoppedAbandon.revision); f.human.resume('t'); assert.equal(f.read().status, 'running');
  // Persistence gate: optional field, strict shape; pre-existing records without it stay valid.
  const state = f.core.exportState(); assert.doesNotThrow(() => FleetCore.fromState(state));
  const bad = structuredClone(state); bad.workspaces[0].tickets[0].abandonedAt = 'yesterday';
  assert.throws(() => FleetCore.fromState(bad), e => e.code === 'invalid-state');
  const wrongStatus = structuredClone(state); wrongStatus.workspaces[0].tickets[0].abandonedAt = new Date().toISOString();
  assert.throws(() => FleetCore.fromState(wrongStatus), e => e.code === 'invalid-state', 'running Ticket cannot carry abandonment');
});
test('draft deletion protects current and frozen dependencies, series receipts and replacement links', () => {
  const f = fixture();
  const saved = p => f.core.saveDraftTicket('w', { id: 'other', plan: p });
  const remove = () => f.human.deleteDraftTicket('t', 1);
  const p = plan(); p.nodes[1].ticketDependencies = ['t'];
  saved(p); rejects(remove, 'ticket-referenced');
  f.human.start('other'); f.human.stop('other');
  f.core.saveDraftTicket('w', { ticketId: 'other', expectedRevision: f.core.readTicket('w', 'other').revision, plan: plan() });
  rejects(remove, 'ticket-referenced'); // The original execution still has its Node dependency.
  for (const role of ['source', 'dependency', 'occurrence']) {
    const {core, human} = fixture(), seriesPlan = plan();
    if (role !== 'source') seriesPlan.ticketDependencies = ['t'];
    core.createSeries('w', { id: 'series', name: 'Example', sourceTicketId: role === 'source' ? 't' : null,
      plan: seriesPlan, scheduleId: 'clock', targetSessionId: 'origin', timing: {kind: 'daily'} });
    const target = role === 'occurrence' ? core.recordOccurrenceAndStart('w', 'series', {occurrenceAt: '2026-11-22T09:00:00Z'}).ticketId : 't';
    core.setSeriesStatus('w', 'series', 'ended');
    rejects(() => human.deleteDraftTicket(target, core.readTicket('w', target).revision), 'ticket-referenced');
  }
  const g = fixture(), fresh = g.human.regenerateTicket('t', 1, plan());
  // Only the predecessor's replacement link is released; the predecessor record itself stays.
  assert.deepEqual(g.human.deleteDraftTicket(fresh.id, fresh.revision), {deletedTicketId: fresh.id});
  const predecessor = g.read();
  assert.equal(predecessor.id, 't'); assert.equal(predecessor.supersededBy, undefined); assert.equal(predecessor.replacementDeleted.ticketId, fresh.id);
  assert.equal(predecessor.activity.at(-1).type, 'replacement-deleted');
  assert.doesNotThrow(() => FleetCore.fromState(g.core.exportState()));
  rejects(() => g.human.deleteDraftTicket('t', g.read().revision), 'control-locked');
  // A real dependency still blocks deletion even when the same Ticket also replaced the draft.
  const h = fixture(), replaced = h.human.regenerateTicket('t', 1, plan());
  h.core.saveDraftTicket('w', { id: 'consumer', plan: (() => { const p = plan(); p.nodes[1].ticketDependencies = [replaced.id]; return p; })() });
  rejects(() => h.human.deleteDraftTicket(replaced.id, replaced.revision), 'ticket-referenced');
});
test('CAS uses original revision and rejects replacement without mutation', () => {
  const f = fixture(), old = f.read(); f.save({ ...old.plan, goal: 'winner' });
  rejects(() => f.core.saveDraftTicket('w', { ticketId: 't', expectedRevision: old.revision, plan: old.plan }), 'stale-revision'); assert.equal(f.read().plan.goal, 'winner');
});
test('unknown/legacy versions and old commands never receive automatic current stamps', () => {
  for (const p of [{ goal: 'g', contractVersion: 7 }, { ticket: { goal: 'g' } }, { goal: 'g', agents: [] }]) assert.throws(() => normalizePlan(p));
  const f = fixture(); rejects(() => f.save({ goal: 'missing stored version' }), 'unsupported-contract');
  const p = plan(); p.criteria = { evidence: true }; rejects(() => f.save(p), 'invalid-input');
});
test('startup freezes direct local Agents and never materializes Root or Workspace definitions', () => {
  const f = fixture(); f.start(); const t = f.read(), state = f.core.exportState();
  assert.deepEqual(state.templates, []); assert.equal(Object.hasOwn(state.workspaces[0], 'binding'), false); assert.equal(Object.hasOwn(state.workspaces[0], 'definitions'), false);
  const config = t.execution.configurations[t.execution.currentConfigRevision]; assert.deepEqual(config.plan, t.plan);
  const a = f.runtime.claimNode('t', 'a'); assert.equal(a.input().profile.id, 'writer'); a.complete({ file: 'report.md' });
  const b = f.runtime.claimNode('t', 'b'); assert.equal(b.input().profile.id, 'reviewer'); b.complete({ verified: true }); assert.equal(f.read().status, 'delivered');
});
test('DAG and Gate edges control runnable; same role is display-only', () => {
  const p = plan(); p.nodes[1].dependsOn = []; p.gates = [{ id: 'q', from: ['a'], to: ['b'], reviewer: { kind: 'human' } }];
  assert.deepEqual(graphLevels(p.nodes, p.gates).map(l => l.map(n => n.id)), [['a'], ['b']]);
  const chained = plan(); chained.nodes[1].dependsOn = ['a']; chained.gates = [{ id: 'q', from: ['a'], to: ['b'], reviewer: { kind: 'human' } }];
  assert.deepEqual(graphLevels(chained.nodes, chained.gates).map(l => l.map(n => n.id)), [['a'], ['b']], 'gate-guarded successor renders after its source even with a direct dependsOn');
  const terminal = plan(); terminal.nodes[1].dependsOn = ['a']; terminal.gates = [{ id: 'end', from: ['b'], to: [], reviewer: { kind: 'human' } }];
  assert.deepEqual(graphLevels(terminal.nodes, terminal.gates).map(l => l.map(n => n.id)), [['a'], ['b']], 'terminal gate never pulls nodes earlier');
  const f = fixture(p); f.start(); assert.deepEqual(f.runtime.runnable('t'), ['a']); f.runtime.claimNode('t', 'a').complete('first');
  assert.deepEqual(f.runtime.runnable('t'), []); f.human.reviewGate('t', 'q', 'returned', 'fix'); assert.deepEqual(f.runtime.runnable('t'), []);
  f.human.forcePassGate('t', 'q'); assert.deepEqual(f.runtime.runnable('t'), ['b']);
});
test('graph cycle diagnostics terminate and incomplete draft remains savable', () => {
  const p = plan(); p.nodes[0].dependsOn = ['b']; assert.equal(validatePlan(p).valid, true); assert.equal(validatePlan(p, { mode: 'start' }).valid, false);
  assert.equal(graphLevels(p.nodes, p.gates).flat().length, 2); rejects(() => fixture(p).start(), 'invalid-flow');
});
test('final review waits for delivery evidence even with no destination nodes', () => {
  const p = plan(); p.gates = [{ id: 'end', from: ['b'], to: [], reviewer: { kind: 'human' } }];
  const f = fixture(p); f.start(); f.runtime.claimNode('t', 'a').complete('a'); f.runtime.claimNode('t', 'b').complete('b');
  assert.equal(f.read().status, 'running'); f.human.reviewGate('t', 'end', 'passed', 'verified'); assert.equal(f.read().status, 'delivered');
});
test('running and stop-requested configuration locks cover full saves and node changes', () => {
  const f = fixture(); f.start(); const worker = f.runtime.claimNode('t', 'a');
  rejects(() => f.save(f.read().plan), 'control-locked'); rejects(() => f.human.changeNode('t', 'a', { prompt: 'change' }), 'control-locked');
  f.human.stop('t'); assert.equal(f.read().status, 'stop-requested'); rejects(() => f.save(f.read().plan), 'control-locked');
  worker.confirmStopped(); assert.equal(f.read().status, 'stopped');
});
test('stop-edit-resume keeps completed evidence, frozen old Attempt and Session identities', () => {
  const f = fixture(); f.start(); const first = f.runtime.claimNode('t', 'a'); first.attachSession('s-a'); first.complete({ file: 'old.md' });
  const second = f.runtime.claimNode('t', 'b'); second.attachSession('s-b'); f.human.stop('t'); second.confirmStopped();
  const old = f.read(), oldA = structuredClone(old.execution.nodes.a), oldB = structuredClone(old.execution.nodes.b.attempts[0]);
  const changed = structuredClone(old.plan); changed.goal = 'more work'; changed.nodes[1].task.prompt = 'new second'; changed.agents.reviewer.profile.instructions = 'new review'; f.save(changed);
  assert.equal(f.read().status, 'stopped'); assert.equal(f.read().execution.currentConfigRevision, old.execution.currentConfigRevision);
  f.human.resume('t'); const current = f.read(); assert.notEqual(current.execution.currentConfigRevision, old.execution.currentConfigRevision);
  assert.deepEqual(current.execution.nodes.a, oldA); assert.deepEqual(current.execution.nodes.b.attempts[0], oldB);
  assert.deepEqual(current.execution.configurations[old.execution.currentConfigRevision], old.execution.configurations[old.execution.currentConfigRevision]);
  const next = f.runtime.claimNode('t', 'b'); assert.equal(next.input().task.prompt, 'new second'); next.attachSession('s-b-next'); next.complete('new output');
  const historical = projectTicket(f.read(), { configRevision: old.execution.currentConfigRevision }); assert.equal(historical.nodes[1].task.prompt, 'second'); assert.equal(historical.snapshot.agents.reviewer.profile.instructions, 'review');
  assert.equal(f.read().execution.nodes.b.attempts[0].sessionId, 's-b'); assert.equal(f.read().execution.nodes.b.attempts[1].sessionId, 's-b-next');
});
test('completed Node changes and reviewed Gate restructuring are explicitly rejected', () => {
  const p = plan(); p.gates = [{ id: 'q', from: ['a'], to: ['b'], reviewer: { kind: 'human' } }]; const f = fixture(p); f.start(); f.runtime.claimNode('t', 'a').complete('evidence'); f.human.reviewGate('t', 'q', 'passed', 'review'); f.human.stop('t');
  for (const mutate of [p => p.nodes[0].task.prompt = 'rewrite', p => p.agents.writer.profile.instructions = 'different', p => p.nodes.splice(0, 1), p => p.gates[0].from = ['b']]) { const next = structuredClone(f.read().plan); mutate(next); rejects(() => f.save(next), 'completed-work-conflict'); }
  const next = structuredClone(f.read().plan); next.nodes[0].role = 'display rename'; f.save(next); assert.equal(f.read().plan.nodes[0].role, 'display rename');
});
test('unchanged stop/resume reuses configuration; global execution rules create a new frozen revision', () => {
  const f = fixture(); f.start(); const config = f.read().execution.currentConfigRevision; f.human.stop('t'); f.human.resume('t'); assert.equal(f.read().execution.currentConfigRevision, config);
  f.human.stop('t'); f.human.replaceGlobalSettings({ rules: ['be precise'], generation: { rules: ['keep goal'] }, execution: { rules: ['show evidence'] } }); f.human.resume('t');
  const t = f.read(); assert.notEqual(t.execution.currentConfigRevision, config); assert.deepEqual(t.execution.configurations[config].rules.rules, []); assert.deepEqual(t.execution.configurations[t.execution.currentConfigRevision].rules.rules, ['be precise']);
});
test('generation-only settings revisions do not create another execution configuration', () => {
  const f = fixture(); f.start(); const revision = f.read().execution.currentConfigRevision; f.human.stop('t'); f.human.replaceGlobalSettings({ rules: [], generation: { rules: ['new planning instruction'] }, execution: { rules: [] } }); f.human.resume('t'); assert.equal(f.read().execution.currentConfigRevision, revision);
});

test('removed and reused local identity does not inherit old Template provenance', () => {
  const f = fixture(); f.human.saveTemplate({ id: 'source', kind: 'agent', content: { profile: { instructions: 'source' } } });
  f.core.saveDraftTicket('w', { ticketId: 't', expectedRevision: f.read().revision, plan: f.read().plan, sourceRefs: [{ kind: 'agent', templateId: 'source', templateRevision: 1, localId: 'writer' }] });
  const without = structuredClone(f.read().plan); delete without.agents.writer; f.save(without); f.save(plan()); f.start(); assert.deepEqual(f.read().execution.configurations[f.read().execution.currentConfigRevision].sourceRefs, []);
});

test('colliding legacy Agent and Orchestration IDs migrate without dropping either template', () => {
  const core = FleetCore.fromState({ schemaVersion: 1, agents: [{ id: 'same', revision: 1, profile: { instructions: 'a' }, history: [] }], flows: [{ id: 'same', revision: 1, definition: { nodes: [], gates: [] }, history: [] }], workspaces: [] });
  const templates = core.exportState().templates; assert.equal(templates.length, 2); assert.equal(new Set(templates.map(t => t.id)).size, 2); assert.equal(templates[1].legacy.original.id, 'same');
});

test('retry preserves Gate review, override, Session, dispatch and old Attempt history', () => {
  const p = plan(); p.nodes[1].dependsOn = []; p.gates = [{ id: 'q', from: ['a'], to: ['b'], reviewer: { kind: 'agent', nodeId: 'b' } }]; const f = fixture(p); f.start(); f.runtime.claimNode('t', 'a').complete('a');
  f.runtime.recordGateDispatch('t', 'q', { phase: 'submitted', messageId: 'req', sessionId: 'gate-session' }, null);
  f.human.forcePassGate('t', 'q'); f.runtime.claimNode('t', 'b').complete('b'); assert.equal(f.read().status, 'delivered');
  f.runtime.recordGateDispatch('t', 'q', { phase: 'finished', messageId: 'req', sessionId: 'gate-session' }, 'req'); f.runtime.reviewer('t', 'q').submit('returned', { late: true });
  const gate = structuredClone(f.read().execution.gates.q); assert.equal(gate.reviews[0].supersededByHuman, true);
  f.human.retryNode('t', 'a', 'recheck'); const t = f.read(); assert.equal(t.execution.gates.q.history[0].dispatch.sessionId, 'gate-session'); assert.deepEqual(t.execution.gates.q.history[0].reviews, gate.reviews); assert.equal(t.execution.gates.q.cycle, 1);
  assert.equal(f.core.sessionOwner('gate-session').gateId, 'q'); assert.equal(t.execution.nodes.a.attempts.length, 1);
  assert.deepEqual(FleetCore.fromState(f.core.exportState()).exportState(), f.core.exportState());
});
test('retrying a failed node keeps its already-passed incoming Gate so no second human approval is needed', () => {
  const p = plan(); p.nodes[1].dependsOn = []; p.gates = [{ id: 'q', from: ['a'], to: ['b'], reviewer: { kind: 'human' } }]; const f = fixture(p); f.start();
  f.runtime.claimNode('t', 'a').complete('a'); f.human.forcePassGate('t', 'q');
  const w = f.runtime.claimNode('t', 'b'); w.fail('boom');
  f.human.retryNode('t', 'b', 'try again'); const t = f.read();
  assert.equal(t.execution.gates.q.status, 'passed', 'incoming Gate verdict survives the retry');
  assert.equal((t.execution.gates.q.history ?? []).length, 0, 'incoming Gate is not archived');
  assert.equal(t.execution.nodes.a.status, 'completed', 'upstream node stays completed');
  assert.equal(t.execution.nodes.b.status, 'pending');
  assert.doesNotThrow(() => f.runtime.claimNode('t', 'b'), 'retried node is runnable without re-approval');
});
test('late stale workers cannot complete a later retry; a Node may reuse its own terminal Session (P-75)', () => {
  const f = fixture(); f.start(); const w = f.runtime.claimNode('t', 'a'); w.attachSession('s'); w.fail('failed'); f.human.retryNode('t', 'a', 'retry'); const next = f.runtime.claimNode('t', 'a');
  rejects(() => w.complete('late'), 'stale-attempt');
  assert.doesNotThrow(() => next.attachSession('s'), 'sequential reuse of the same Node Session is allowed');
  assert.equal(f.core.sessionOwner('s').attemptId, next.attemptId, 'ownership follows the current Attempt');
  assert.equal(f.read().execution.nodes.a.attempts[0].sessionId, 's');
});
test('source refs use explicit known template history; edits preserve provenance and Root changes do not rewrite execution', () => {
  const f = fixture(); f.human.saveTemplate({ id: 'tpl', kind: 'agent', name: 'Template', content: { profile: { instructions: 'v1' } } }); f.human.replaceRootAgent('tpl', { instructions: 'v2' });
  const t = f.read(); f.core.saveDraftTicket('w', { ticketId: 't', expectedRevision: t.revision, plan: t.plan, sourceRefs: [{ kind: 'agent', templateId: 'tpl', templateRevision: 1, localId: 'writer' }] });
  f.save({ ...f.read().plan, goal: 'another' }); f.start(); const frozen = f.read().execution.configurations[f.read().execution.currentConfigRevision]; assert.equal(frozen.sourceRefs[0].content.profile.instructions, 'v1');
  f.human.replaceRootAgent('tpl', { instructions: 'v3' }); assert.deepEqual(f.read().execution.configurations[f.read().execution.currentConfigRevision], frozen);
  assert.equal(f.core.exportState().templates[0].history[0].content.profile.instructions, 'v1');
});
test('plan and Template content reject execution mirrors and fabricated source revisions', () => {
  const p = plan(); p.nodes[0].attempts = []; assert.throws(() => normalizePlan(p), e => e.code === 'invalid-input');
  const f = fixture(); rejects(() => f.human.saveTemplate({ id: 'invalid', kind: 'agent', content: { profile: {}, sessionId: 'not-template-data' } }), 'invalid-input');
  f.human.saveTemplate({ id: 'source', kind: 'agent', content: { profile: {} } }); rejects(() => f.human.saveTemplate({ id: 'copy', kind: 'agent', content: { profile: {} }, source: { templateId: 'source', templateRevision: 99 } }), 'invalid-input');
  rejects(() => f.human.replaceRootAgent('source', { instructions: 123 }), 'invalid-input');
});

test('export/read are detached and canonical round trip retains records without aliases', () => {
  const f = fixture(); f.start(); const t = f.read(); t.plan.inputs.nested.paths.push('mutated'); const state = f.core.exportState(); state.workspaces[0].tickets[0].plan.goal = 'bad';
  assert.equal(f.read().plan.goal, 'Ship verified work'); assert.equal(f.read().plan.inputs.nested.paths.length, 2); assert.deepEqual(FleetCore.fromState(f.core.exportState()).exportState(), f.core.exportState());
});

test('native events survive replay and retry with independent identities and times', () => {
  const f = fixture(); f.start();
  const event = { id: '15', intent: 'step', text: 'read', tool: 'read', time: '2026-11-19T04:21:18.000Z', step: 2 };
  const first = f.runtime.claimNode('t', 'a'); first.recordProgress([event, event]);
  const revision = f.read().revision; first.recordProgress([event]); assert.equal(f.read().revision, revision);
  first.fail('failed'); f.human.retryNode('t', 'a', 'retry'); const next = f.runtime.claimNode('t', 'a');
  rejects(() => first.recordProgress([event]), 'stale-attempt'); next.recordProgress([event]);
  const rows = f.read().execution.nodes.a.thread.filter(r => r.intent === 'step');
  assert.deepEqual(rows.map(r => r.attemptId), [first.attemptId, next.attemptId]);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.ok(rows.every(r => r.time === event.time && r.tool === 'read' && r.step === 2));
});
