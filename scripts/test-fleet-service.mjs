// Isolated real filesystem + controlled async host, with two-Service contention.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FleetService } from '../packages/fleet-shell/src/fleet-service.js';
import { FleetStore } from '../packages/fleet-shell/src/fleet-store.js';
import { normalizePlan } from '../packages/fleet-shell/src/fleet-model.js';
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const plan = () => normalizePlan({ goal: 'Build and verify', inputs: { url: 'fixture', nested: ['keep'] }, deliverables: [], criteria: ['verify'], agents: { writer: { profile: { instructions: 'write' } }, checker: { profile: { instructions: 'check' } } }, nodes: [{ id: 'a', role: 'same', agentId: 'writer', dependsOn: [], task: { prompt: 'a' } }, { id: 'b', role: 'same', agentId: 'checker', dependsOn: ['a'], task: { prompt: 'b' } }], gates: [] });
function host() {
  const calls = { create: [], submit: [], inspect: [], cancel: [], message: [], recover: [] }, sessions = new Map(), hooks = {};
  const adapter = {
    async create(r) { calls.create.push(structuredClone(r)); await hooks.create?.(r); const sessionId = `s-${sessions.size + 1}`; sessions.set(sessionId, { status: 'unknown' }); return { sessionId }; },
    async submit(r) { calls.submit.push(structuredClone(r)); sessions.set(r.sessionId, { status: 'running' }); await hooks.submit?.(r); return { messageId: r.requestId }; },
    async recover(r) { calls.recover.push(r); },
    async inspect(r) { calls.inspect.push(structuredClone(r)); return structuredClone(await hooks.inspect?.(r) ?? sessions.get(r.sessionId) ?? { status: 'unknown' }); },
    async cancel(r) { calls.cancel.push(r); return await hooks.cancel?.(r) ?? { stopped: false }; },
    async message(r) { calls.message.push(structuredClone(r)); await hooks.message?.(r); return { messageId: r.requestId }; }
  };
  return { calls, sessions, hooks, adapter };
}
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-canonical-service-')), rootPath = path.join(temp, 'root'), workspacePaths = { a: path.join(temp, 'a'), b: path.join(temp, 'b') }, services = [], h = host();
  let failPublish = false;
  const open = async (paths = workspacePaths) => { const s = await FleetService.open({ rootPath, workspacePaths: paths, adapter: h.adapter, autoStart: false, beforePublish() { if (failPublish) throw new Error('publication failed'); } }); services.push(s); return s; };
  const service = await open();
  t.after(async () => { for (const s of services) await s.close(); const target = path.resolve(temp); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert(path.basename(target).startsWith('fleet-canonical-service-')); assert(!(await fs.lstat(target)).isSymbolicLink()); await fs.rm(target, { recursive: true, force: true }); });
  return { service, open, rootPath, workspacePaths, h, fail(value) { failPublish = value; }, save: (id = 't', p = plan()) => service.saveDraftTicket('a', { id, sessionId: 'origin', plan: p }), read: (id = 't') => service.read('a', id), human: (action, args = ['t']) => service.human('a', 'human', action, args) };
}
const attempt = (t, id = 'a') => t.execution.nodes[id].attempts.at(-1);
test('goal-only persists canonical Workspace body without Root publication; start still rejects incomplete plan', async t => {
  const f = await fixture(t); const draft = await f.save('t', { goal: 'request only' }); assert.equal(draft.plan.contractVersion, 3);
  await assert.rejects(f.human('start'), e => e.code === 'incomplete-plan');
  const disk = await FleetStore.read({ dir: path.join(f.workspacePaths.a, '.fleet'), kind: 'workspace' }); assert.equal(disk.schemaVersion, 2); assert.equal(Object.hasOwn(disk, 'definitions'), false); assert.equal(Object.hasOwn(disk, 'binding'), false); assert.deepEqual(disk.tickets[0], draft);
  await assert.rejects(fs.stat(path.join(f.rootPath, 'current.json')), { code: 'ENOENT' }); assert.equal(f.h.calls.create.length, 0);
});
test('read and list do not publish; Root is unchanged across save/start/stop/resume', async t => {
  const f = await fixture(t); await f.human('saveTemplate', [{ id: 'agent', kind: 'agent', content: { profile: { instructions: 'Root' } } }]);
  const before = await fs.readFile(path.join(f.rootPath, 'current.json'), 'utf8'); await f.save(); await f.human('start'); await f.human('stop'); await f.human('resume');
  const pointer = await fs.readFile(path.join(f.workspacePaths.a, '.fleet/current.json'), 'utf8'); await f.read(); await f.service.list('a'); await f.service.catalog(); assert.equal(await fs.readFile(path.join(f.workspacePaths.a, '.fleet/current.json'), 'utf8'), pointer); assert.equal(await fs.readFile(path.join(f.rootPath, 'current.json'), 'utf8'), before);
});
test('same-role Nodes dispatch different direct Profiles and frozen execution rules enter prompts', async t => {
  const f = await fixture(t); await f.human('replaceGlobalSettings', [{ rules: ['global rule'], generation: { rules: ['generation only'] }, execution: { rules: ['execute rule'] } }]); await f.save(); await f.human('start'); await f.service.tick();
  assert.equal(f.h.calls.create[0].profile.instructions, 'write'); assert.match(f.h.calls.submit[0].prompt, /global rule/); assert.match(f.h.calls.submit[0].prompt, /execute rule/); assert.doesNotMatch(f.h.calls.submit[0].prompt, /generation only/);
  f.h.sessions.set(attempt(await f.read()).sessionId, { status: 'completed', output: { file: 'a.md' } }); await f.service.tick(); assert.equal(f.h.calls.create[1].profile.instructions, 'check'); assert.match(f.h.calls.submit[1].prompt, /a.md/);
  f.h.sessions.set(attempt(await f.read(), 'b').sessionId, { status: 'completed', output: 'done' }); await f.service.tick(); assert.equal((await f.read()).status, 'delivered');
});
test('two Services merge independent writes and stale same-Ticket CAS cannot overwrite winner', async t => {
  const f = await fixture(t), other = await f.open();
  await Promise.all([f.save('first'), other.saveDraftTicket('a', { id: 'second', plan: { goal: 'second' } })]); assert.deepEqual((await f.service.read('a')).map(t => t.id).sort(), ['first', 'second']);
  const old = await f.read('first'), next = { ...old.plan, goal: 'winner' };
  const results = await Promise.allSettled([f.service.saveDraftTicket('a', { ticketId: 'first', expectedRevision: old.revision, plan: next }), other.saveDraftTicket('a', { ticketId: 'first', expectedRevision: old.revision, plan: { ...next, goal: 'rival' } })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.code, 'stale-revision'); assert.equal(f.service.health.ready, true); assert.equal(other.health.ready, true);
  assert.equal((await f.service.read('a')).length, 2);
});
test('dynamic Workspace registration loads existing Tickets before another save', async t => {
  const f = await fixture(t); await f.save('existing'); const late = await f.open({ b: f.workspacePaths.b }); await late.registerWorkspace('a', f.workspacePaths.a);
  assert.equal((await late.read('a', 'existing')).plan.goal, 'Build and verify'); await late.saveDraftTicket('a', { id: 'new', plan: { goal: 'new' } }); assert.equal((await f.service.read('a')).length, 2);
});
test('legitimate nested Host Workspaces cold-load separate .fleet chains while actual Store overlap is refused', async t => {
  const f = await fixture(t); await f.save('parent-ticket'); const nestedPath = path.join(f.workspacePaths.a, 'nested');
  const nested = await f.open({ a: f.workspacePaths.a, child: nestedPath }); assert.equal((await nested.read('a')).length, 1); await nested.saveDraftTicket('child', { id: 'child-ticket', plan: { goal: 'nested work' } });
  const reopened = await f.open({ a: f.workspacePaths.a, child: nestedPath }); assert.deepEqual((await reopened.read('a')).map(t => t.id), ['parent-ticket']); assert.deepEqual((await reopened.read('child')).map(t => t.id), ['child-ticket']);
  await assert.rejects(reopened.registerWorkspace('alias', f.workspacePaths.a), e => e.code === 'invalid-input');
  await assert.rejects(reopened.registerWorkspace('overlap', path.join(f.workspacePaths.a, '.fleet/inside')), e => e.code === 'invalid-input');
  await assert.rejects(reopened.registerWorkspace('root-overlap', f.rootPath), e => e.code === 'invalid-input');
});

test('two Services contend over Node intent: only its durable claimant creates/submits', async t => {
  const f = await fixture(t), other = await f.open(); await f.save(); await f.human('start');
  const entered = deferred(), release = deferred(); f.h.hooks.create = async () => { entered.resolve(); await release.promise; };
  const advancing = f.service.tick(); await entered.promise; await other.tick(); assert.equal(f.h.calls.create.length, 1); const during = await other.read('a', 't'); assert.equal(attempt(during).dispatch.phase, 'created'); assert.equal(attempt(during).status, 'running');
  release.resolve(); await advancing; await other.tick(); assert.equal(f.h.calls.submit.length, 1); assert.equal(attempt(await f.read()).dispatch.phase, 'submitted');
});
test('two Services contend over Gate intent before creating review Session', async t => {
  const f = await fixture(t), other = await f.open(); const p = plan(); p.gates = [{ id: 'q', from: ['a'], to: ['b'], reviewer: { kind: 'agent', nodeId: 'b' } }]; await f.save('t', p); await f.human('start'); await f.service.tick();
  f.h.sessions.set(attempt(await f.read()).sessionId, { status: 'completed', output: 'a' });
  const entered = deferred(), release = deferred(); f.h.hooks.create = async r => { if (r.title.includes('审核')) { entered.resolve(); await release.promise; } };
  const advancing = f.service.tick(); await entered.promise; await other.tick(); assert.equal(f.h.calls.create.length, 2); const gate = (await other.read('a', 't')).execution.gates.q; assert.equal(gate.dispatch.phase, 'created');
  release.resolve(); await advancing; assert.equal(f.h.calls.submit.length, 2);
  f.h.sessions.set((await f.read()).execution.gates.q.dispatch.sessionId, { status: 'completed', output: JSON.stringify({ decision: 'passed', evidence: 'reviewed' }) }); await Promise.all([f.service.tick(), other.tick()]); assert.equal((await f.read()).execution.gates.q.reviews.length, 1);
});
test('uncertain submission is reconciled by requestId and never automatically resent after reopening', async t => {
  const f = await fixture(t); await f.save(); await f.human('start'); f.h.hooks.submit = async () => { throw new Error('transport outcome uncertain'); }; await f.service.tick();
  const a = attempt(await f.read()); assert.equal(a.dispatch.phase, 'uncertain'); await f.service.close(); const reopened = await f.open();
  f.h.sessions.set(a.sessionId, { status: 'unknown' }); await reopened.tick(); assert.equal(f.h.calls.submit.length, 1); assert.equal(attempt(await reopened.read('a', 't')).dispatch.phase, 'uncertain');
  f.h.sessions.set(a.sessionId, { status: 'completed', output: 'recovered' }); delete f.h.hooks.submit; await reopened.tick(); assert.equal((await reopened.read('a', 't')).execution.nodes.a.status, 'completed'); assert.equal(f.h.calls.submit.filter(r => r.sessionId === a.sessionId).length, 1);
});
test('creating Session with uncertain result retains intent and requires explicit retry', async t => {
  const f = await fixture(t); await f.save(); await f.human('start'); f.h.hooks.create = async () => { throw new Error('create timeout'); }; await f.service.tick(); const a = attempt(await f.read()); assert.equal(a.status, 'interrupted'); assert.equal(a.dispatch.phase, 'uncertain'); await f.service.tick(); assert.equal(f.h.calls.create.length, 1);
});
test('two Services deliver each new human message at most once through a durable intent', async t => {
  const f = await fixture(t), other = await f.open(); await f.save(); await f.human('start'); await f.service.tick(); await f.human('commentNode', ['t', 'a', 'clarification']);
  await Promise.all([f.service.tick(), other.tick()]); assert.equal(f.h.calls.message.length, 1); assert.match(f.h.calls.message[0].text, /clarification/);
});
test('stop remains locked until Host confirms termination; resume preserves old Attempt and new config', async t => {
  const f = await fixture(t); await f.save(); await f.human('start'); await f.service.tick(); await f.human('stop'); await f.service.tick(); assert.equal((await f.read()).status, 'stop-requested');
  const current = await f.read(); await assert.rejects(f.service.saveDraftTicket('a', { ticketId: 't', expectedRevision: current.revision, plan: current.plan }), e => e.code === 'control-locked');
  f.h.hooks.cancel = async () => ({ stopped: true }); await f.service.tick(); const stopped = await f.read(), old = structuredClone(attempt(stopped)); const p = structuredClone(stopped.plan); p.nodes[0].task.prompt = 'new task';
  await f.service.saveDraftTicket('a', { ticketId: 't', expectedRevision: stopped.revision, plan: p }); await f.human('resume'); await f.service.tick(); const after = await f.read(); assert.deepEqual(after.execution.nodes.a.attempts[0], old); assert.notEqual(attempt(after).configRevision, old.configRevision); assert.notEqual(attempt(after).sessionId, old.sessionId);
});
test('publication failure keeps last committed Ticket and pauses further dispatch', async t => {
  const f = await fixture(t); await f.save(); const before = await f.read(); f.fail(true);
  await assert.rejects(f.service.saveDraftTicket('a', { ticketId: 't', expectedRevision: before.revision, plan: { ...before.plan, goal: 'should fail' } }), /publication failed/); assert.equal(f.service.health.ready, false); assert.deepEqual(await f.read(), before); await assert.rejects(f.service.tick(), e => e.code === 'persistence-fault'); assert.equal(f.h.calls.create.length, 0);
});
test('stop racing Gate creation waits for actual cancellation before unlocking', async t => {
  const f = await fixture(t), other = await f.open(); const p = plan(); p.gates = [{ id: 'q', from: ['a'], to: ['b'], reviewer: { kind: 'agent', nodeId: 'b' } }]; await f.save('t', p); await f.human('start'); await f.service.tick();
  f.h.sessions.set(attempt(await f.read()).sessionId, { status: 'completed', output: 'a' }); const entered = deferred(), release = deferred(); f.h.hooks.create = async r => { if (r.title.includes('审核')) { entered.resolve(); await release.promise; } };
  const advancing = f.service.tick(); await entered.promise; await other.human('a', 'human', 'stop', ['t']); release.resolve(); await advancing;
  assert.equal((await f.read()).status, 'stop-requested'); assert.equal(f.h.calls.submit.length, 1); f.h.hooks.cancel = async () => ({ stopped: true }); await f.service.tick(); assert.equal((await f.read()).status, 'stopped');
});

test('retrying a failed node twice keeps the passed incoming Gate and redispatches it directly without upstream re-approval', async t => {
  const f = await fixture(t); const p = plan(); p.gates = [{ id: 'q', from: ['a'], to: ['b'], reviewer: { kind: 'human' } }]; await f.save('t', p); await f.human('start'); await f.service.tick();
  f.h.sessions.set(attempt(await f.read()).sessionId, { status: 'completed', output: 'a' }); await f.service.tick(); await f.human('reviewGate', ['t', 'q', 'passed', 'verified']); await f.service.tick();
  for (let round = 1; round <= 2; round++) {
    f.h.sessions.set(attempt(await f.read(), 'b').sessionId, { status: 'failed', error: 'fixture failure' }); await f.service.tick(); assert.equal((await f.read()).execution.nodes.b.status, 'failed');
    const before = f.h.calls.create.length; const retried = await f.human('retryNode', ['t', 'b', `retry ${round}`]);
    assert.equal(retried.execution.gates.q.status, 'passed'); assert.equal(retried.execution.gates.q.history.length, 0); assert.equal(retried.execution.nodes.a.status, 'completed'); assert.equal(retried.execution.nodes.b.status, 'pending');
    await f.service.tick(); const after = await f.read(); assert.equal(f.h.calls.create.length, before + 1, 'retry dispatches a new Session in the same tick'); assert.equal(after.execution.nodes.b.status, 'running'); assert.equal(after.execution.nodes.b.attempts.length, round + 1); assert.equal(after.execution.nodes.a.attempts.length, 1);
  }
});
test('stopped review resumes in a new Gate cycle and retains its original Session', async t => {
  const f = await fixture(t); const p = plan(); p.gates = [{ id: 'q', from: ['a'], to: ['b'], reviewer: { kind: 'agent', nodeId: 'b' } }]; await f.save('t', p); await f.human('start'); await f.service.tick();
  f.h.sessions.set(attempt(await f.read()).sessionId, { status: 'completed', output: 'a' }); await f.service.tick(); const original = (await f.read()).execution.gates.q.dispatch.sessionId;
  await f.human('stop'); f.h.hooks.cancel = async () => ({ stopped: true }); await f.service.tick(); assert.equal((await f.read()).status, 'stopped'); await f.human('resume'); await f.service.tick();
  const gate = (await f.read()).execution.gates.q; assert.equal(gate.cycle, 1); assert.equal(gate.history[0].dispatch.sessionId, original); assert.notEqual(gate.dispatch.sessionId, original); assert.equal(await f.service.ownsSession(original), true);
});

test('a human message arriving during observation is delivered before old completion can settle', async t => {
  const f = await fixture(t), other = await f.open(); await f.save(); await f.human('start'); await f.service.tick(); const a = attempt(await f.read());
  const entered = deferred(), release = deferred(); f.h.hooks.inspect = async () => { entered.resolve(); await release.promise; return { status: 'completed', output: 'old output' }; };
  const polling = f.service.tick(); await entered.promise; await other.human('a', 'user', 'commentNode', ['t', 'a', 'new request']); release.resolve(); await polling;
  assert.equal((await f.read()).execution.nodes.a.status, 'running'); delete f.h.hooks.inspect; await f.service.tick(); assert.equal(f.h.calls.message.length, 1); assert.equal((await f.read()).execution.nodes.a.status, 'running');
});

test('direct invalid JSON is rejected without poisoning persistence health', async t => {
  const f = await fixture(t); await assert.rejects(f.save('t', { goal: 'g', inputs: { value: undefined } }), e => e.code === 'invalid-input'); assert.equal(f.service.health.ready, true);
});

test('native steps, status and reports persist once during polling and terminal inspection', async t => {
  const f = await fixture(t); await f.save(); await f.human('start'); await f.service.tick();
  const first = attempt(await f.read());
  const time = '2026-11-19T04:21:18.000Z';
  const progress = [{ id: '11', intent: 'step', text: 'Step 1', step: 1, time }];
  f.h.sessions.set(first.sessionId, { status: 'running', progress });
  await f.service.tick(); const revision = (await f.read()).revision;
  await f.service.tick(); assert.equal((await f.read()).revision, revision);
  progress.push({ id: '12', intent: 'execution', text: 'Report', time }, { id: '14', intent: 'status', status: 'completed', text: 'completed', time });
  f.h.sessions.set(first.sessionId, { status: 'completed', output: 'Original output', progress });
  await f.service.tick();
  const ticket = await f.read(), rows = ticket.execution.nodes.a.thread;
  assert.deepEqual(rows.map(r => r.intent), ['step', 'execution', 'status']);
  assert.ok(rows.every(r => r.actor.kind === 'agent' && r.attemptId === first.id && r.time === time));
  assert.equal(f.h.calls.message.length, 0);
  assert.ok(f.h.calls.inspect.every(r => r.progressAnchor === `fleet-${first.id}`));
  assert.equal(attempt(ticket).outputs, 'Original output');
});
