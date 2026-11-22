// Versioned compatibility: read-only legacy evidence, explicit repair, atomic regeneration.
// All files are isolated under this test's mkdtemp directory; no real Fleet data.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { FleetCore } from '../packages/fleet-shell/src/fleet-core.js';
import { FleetStore } from '../packages/fleet-shell/src/fleet-store.js';
import { FleetService } from '../packages/fleet-shell/src/fleet-service.js';
import { normalizePlan, repairLegacyPlan, projectTicket } from '../packages/fleet-shell/src/fleet-model.js';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const legacyPlan = () => ({ agents: [{ id: 'agent', profile: { instructions: 'old instructions', customMetadata: { keep: true } } }], orchestration: { id: 'flow', definition: { nodes: [{ id: 'work', role: 'worker', dependsOn: [], task: { prompt: 'old task', nested: { retain: 1 } } }], gates: [] } }, binding: { orchestrationId: 'flow', roleAgents: { worker: 'agent' }, local: { resource: 'relative-resource' } }, ticket: { id: 't', goal: 'old request', inputs: { url: 'fixture' }, deliverables: ['report'], criteria: ['multi\nline standard'] } });
const legacyTicket = () => ({ id: 't', workspaceId: 'w', originSessionId: 'origin', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', status: 'draft', revision: 3, goal: 'old request', inputs: { url: 'fixture' }, criteria: ['multi\nline standard'], plan: legacyPlan(), snapshot: null, nodes: [], gates: [], changes: [], events: [{ id: 'created', type: 'ticket-created', time: '2026-01-01T00:00:00Z', actor: { kind: 'system' }, detail: {} }] });
const legacyRoot = () => ({ schemaVersion: 1, agents: [{ id: 'agent', revision: 7, profile: { instructions: 'ROOT CURRENT MUST NOT REBUILD HISTORY' }, sourceId: 'parent-template', history: [{ revision: 6, profile: { instructions: 'root six' }, time: '2026-01-02T00:00:00Z', actor: { kind: 'human' } }] }], flows: [{ id: 'flow', revision: 1, definition: legacyPlan().orchestration.definition, history: [] }] });
async function fixture(t, ticket = legacyTicket(), { manifestLayout = false } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-canonical-legacy-')), rootPath = path.join(temp, 'root'), workspacePaths = { w: path.join(temp, 'w') }, services = [];
  const root = await FleetStore.open({ dir: rootPath, kind: 'templates' }), workspace = await FleetStore.open({ dir: path.join(workspacePaths.w, '.fleet'), kind: 'workspace' });
  let legacySeed = null;
  if (manifestLayout) {
    const generation = randomUUID(), rootGeneration = randomUUID(), base = path.join(workspacePaths.w, '.fleet/state', generation), filename = `${hash(ticket.id)}.json`;
    await fs.mkdir(path.join(base, 'tickets'), { recursive: true });
    await fs.writeFile(path.join(base, 'tickets', filename), JSON.stringify(ticket));
    const binding = { schemaVersion: 1, id: 'w', binding: legacyPlan().binding, tickets: [{ id: ticket.id, hash: hash(ticket) }] };
    await fs.writeFile(path.join(base, 'binding.json'), JSON.stringify(binding));
    const manifest = { ...legacyRoot(), workspacePaths, workspaces: [{ id: 'w', generation, bindingHash: hash(binding) }], drafts: [{ id: 'original-draft', workspaceId: 'w', sessionId: 'origin', status: 'draft', revision: 2, plan: { mode: 'old-planning-mode', ticket: { id: 'other', goal: 'retain unknown mode' } } }] };
    await fs.writeFile(path.join(rootPath, 'generations', `${rootGeneration}.json`), JSON.stringify(manifest));
    const pointer = JSON.stringify({ schemaVersion: 1, revision: rootGeneration, manifestHash: hash(manifest) }); await fs.writeFile(path.join(rootPath, 'current.json'), pointer);
    legacySeed = { pointer, manifest, base, binding: JSON.stringify(binding) };
  } else {
    await root.commit(legacyRoot()); await workspace.commit({ schemaVersion: 1, id: 'w', definitions: { agents: [], flows: [] }, binding: legacyPlan().binding, tickets: [ticket] });
  }
  await root.close(); await workspace.close();
  let fail = false;
  const calls = [], adapter = { async create() { calls.push('create'); return { sessionId: 'new' }; }, async submit() { calls.push('submit'); }, async inspect() { return { status: 'unknown' }; }, async cancel() { return { stopped: true }; }, async message() {} };
  const open = async () => { const service = await FleetService.open({ rootPath, workspacePaths, adapter, autoStart: false, beforePublish() { if (fail) throw new Error('save failed'); } }); services.push(service); return service; };
  const service = await open();
  t.after(async () => { for (const s of services) await s.close(); const target = path.resolve(temp); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert(path.basename(target).startsWith('fleet-canonical-legacy-')); assert(!(await fs.lstat(target)).isSymbolicLink()); await fs.rm(target, { recursive: true, force: true }); });
  return { service, open, rootPath, workspacePaths, calls, legacySeed, fail(v) { fail = v; }, read: () => service.read('w', 't'), human: (action, args) => service.human('w', 'user', action, args) };
}
test('legacy reading preserves original plan/sha and published generations without version stamping', async t => {
  const original = legacyTicket(), f = await fixture(t, original), rootPointer = await fs.readFile(path.join(f.rootPath, 'current.json'), 'utf8'), wsPointer = await fs.readFile(path.join(f.workspacePaths.w, '.fleet/current.json'), 'utf8');
  const read = await f.read(); assert.equal(read.status, 'draft'); assert.deepEqual(read.plan, original.plan); assert.equal(read.plan.contractVersion, undefined); assert.deepEqual(read.legacy.original, original); assert.equal(read.legacy.sha256, hash(original));
  await f.service.catalog(); assert.equal(await fs.readFile(path.join(f.rootPath, 'current.json'), 'utf8'), rootPointer); assert.equal(await fs.readFile(path.join(f.workspacePaths.w, '.fleet/current.json'), 'utf8'), wsPointer);
  await assert.rejects(f.human('start', ['t']), e => e.code === 'legacy-plan'); await assert.rejects(f.service.saveDraftTicket('w', { ticketId: 't', expectedRevision: read.revision, plan: { goal: 'overwrite' } }), e => e.code === 'legacy-plan'); assert.deepEqual(f.calls, []);
});
test('explicit lossless repair preserves all data, archives original, versions same Ticket and publishes only Workspace schema2', async t => {
  const f = await fixture(t), before = await f.read(), pointer = JSON.parse(await fs.readFile(path.join(f.workspacePaths.w, '.fleet/current.json'), 'utf8'));
  const oldFile = path.join(f.workspacePaths.w, '.fleet/generations', pointer.revision, 'state.json'), bytes = await fs.readFile(oldFile, 'utf8');
  const repaired = await f.human('repairTicket', ['t', before.revision]); assert.equal(repaired.id, before.id); assert.equal(repaired.revision, before.revision + 1); assert.equal(repaired.plan.contractVersion, 3); assert.deepEqual(repaired.plan.criteria, ['multi\nline standard']); assert.deepEqual(repaired.plan.inputs, { url: 'fixture', local: { resource: 'relative-resource' } }); assert.equal(repaired.plan.nodes[0].agentId, 'agent'); assert.equal(repaired.plan.agents.agent.profile.instructions, 'old instructions'); assert.equal(repaired.activity.at(-1).type, 'plan-repaired');
  assert.equal(await fs.readFile(oldFile, 'utf8'), bytes); assert.equal((await FleetStore.read({ dir: path.join(f.workspacePaths.w, '.fleet'), kind: 'workspace' })).schemaVersion, 2); assert.equal((await FleetStore.read({ dir: f.rootPath, kind: 'templates' })).schemaVersion, 1);
  await f.human('start', ['t']); assert.equal((await f.read()).status, 'running');
});
test('complex criteria cannot be JSON-split; failed automatic repair retains exact original', async t => {
  const original = legacyTicket(); original.plan.ticket.criteria = { matrix: [{ must: 'retain whole object' }] }; original.criteria = original.plan.ticket.criteria;
  const f = await fixture(t, original), before = await f.read(); await assert.rejects(f.human('repairTicket', ['t', before.revision]), e => e.code === 'invalid-input'); assert.deepEqual(await f.read(), before);
  const replacement = normalizePlan({ goal: 'Human explicitly rewrote criteria', criteria: ['criterion with\ninternal line break'] }); const after = await f.human('repairTicket', ['t', before.revision, replacement]); assert.deepEqual(after.legacy.original.plan.ticket.criteria, original.plan.ticket.criteria); assert.deepEqual(after.plan.criteria, replacement.criteria);
});
test('future contract remains unknown and needs explicit replacement repair', async t => {
  const original = legacyTicket(); original.plan = { contractVersion: 99, goal: 'future', opaque: { never: 'discard silently' } };
  const f = await fixture(t, original), before = await f.read(); await assert.rejects(f.human('repairTicket', ['t', before.revision]), e => e.code === 'unsupported-contract'); assert.deepEqual((await f.read()).plan, original.plan);
});
test('regeneration commits replacement and superseded source atomically, retains origin and rejects stale revision', async t => {
  const f = await fixture(t), old = await f.read(); const fresh = await f.human('regenerateTicket', ['t', old.revision, { goal: 'clean task' }]); const superseded = await f.read(); assert.notEqual(fresh.id, old.id); assert.equal(fresh.originSessionId, 'origin'); assert.equal(fresh.status, 'draft'); assert.equal(superseded.status, 'superseded'); assert.equal(superseded.supersededBy, fresh.id); assert.deepEqual(superseded.plan, old.plan);
  const disk = await FleetStore.read({ dir: path.join(f.workspacePaths.w, '.fleet'), kind: 'workspace' }); assert.equal(disk.tickets.length, 2); assert.equal(disk.tickets.find(t => t.id === 't').supersededBy, fresh.id);
  await assert.rejects(f.human('regenerateTicket', ['t', old.revision, { goal: 'again' }]), e => e.code === 'stale-revision');
});
test('failed regeneration publishes neither new Ticket nor superseded status', async t => {
  const f = await fixture(t), before = await f.read(); f.fail(true); await assert.rejects(f.human('regenerateTicket', ['t', before.revision, { goal: 'new' }]), /save failed/); assert.deepEqual(await f.read(), before); assert.equal((await f.service.read('w')).length, 1);
});
test('executed legacy history comes from true frozen snapshot, retaining Gate cycles, Sessions and node revision meanings', async t => {
  const original = legacyTicket(); original.status = 'stopped'; original.snapshot = { goal: 'frozen old goal', inputs: { frozen: true }, criteria: ['frozen criteria'], orchestration: { id: 'flow', revision: 1, definition: legacyPlan().orchestration.definition }, agents: { worker: { id: 'agent', revision: 2, profile: { instructions: 'ACTUAL HISTORIC PROFILE' } } }, binding: legacyPlan().binding };
  original.nodes = [{ id: 'work', role: 'worker', dependsOn: [], task: { prompt: 'task after old human change' }, status: 'completed', revision: 4, attempts: [{ id: 'old-attempt', status: 'completed', sessionId: 'old-session', nodeRevision: 2, acceptedRevision: 3, outputs: { path: 'historic.md' }, dispatch: { messageId: 'old-request', phase: 'submitted' } }], thread: [{ id: 'thread', text: 'retain', actor: { kind: 'human' } }] }];
  original.gates = [{ id: 'legacy-gate', from: ['work'], to: [], reviewer: { kind: 'human' }, status: 'passed', reviews: [{ id: 'review', decision: 'passed', evidence: 'evidence' }], humanOverride: null, history: [{ status: 'returned', reviews: [], dispatch: { sessionId: 'older-gate-session', messageId: 'older-request', phase: 'finished' } }] }]; original.snapshot.orchestration.definition.gates = [{ id: 'legacy-gate', from: ['work'], to: [], reviewer: { kind: 'human' } }];
  const f = await fixture(t, original), migrated = await f.read(), configuration = migrated.execution.configurations[migrated.execution.currentConfigRevision];
  assert.deepEqual(configuration.legacySnapshot, original.snapshot); assert.equal(configuration.plan.agents.agent.profile.instructions, 'ACTUAL HISTORIC PROFILE'); assert.equal(configuration.plan.nodes[0].task.prompt, 'old task');
  const a = migrated.execution.nodes.work.attempts[0]; assert.equal(a.nodeRevision, 2); assert.equal(a.acceptedRevision, 3); assert.equal(a.configRevision, null); assert.equal(a.sessionId, 'old-session'); assert.deepEqual(a.outputs, { path: 'historic.md' });
  assert.equal(migrated.execution.gates['legacy-gate'].history[0].dispatch.sessionId, 'older-gate-session'); assert.equal(await f.service.ownsSession('old-session'), true); assert.equal(await f.service.ownsSession('older-gate-session'), true);
  await assert.rejects(f.human('resume', ['t']), e => e.code === 'legacy-plan'); await assert.rejects(f.human('regenerateTicket', ['t', migrated.revision, { goal: 'bad replacement' }]), e => e.code === 'control-locked');
  assert.equal(projectTicket(migrated).snapshot.agents.agent.profile.instructions, 'ACTUAL HISTORIC PROFILE');
});
test('Root templates unify kind, retain actual history and unknown copied-source revision', async t => {
  const f = await fixture(t), catalog = await f.service.catalog(); const template = catalog.templates.find(t => t.kind === 'agent'); assert.equal(template.source.templateRevision, null); assert.equal(template.source.templateId, 'parent-template'); assert.equal(template.history[0].content.profile.instructions, 'root six'); assert.deepEqual(catalog.agents[0].profile, template.content.profile);
  await f.human('replaceRootAgent', ['agent', { instructions: 'new root' }]); const root = await FleetStore.read({ dir: f.rootPath, kind: 'templates' }); assert.equal(root.schemaVersion, 2); assert.equal(Object.hasOwn(root, 'agents'), false); assert.equal(root.templates.find(t => t.kind === 'agent').history.at(-1).content.profile.instructions, 'ROOT CURRENT MUST NOT REBUILD HISTORY');
});
test('pre-multichain manifest upgrades under Root lock, preserving pointer, source generations and unknown draft text', async t => {
  const f = await fixture(t, legacyTicket(), { manifestLayout: true });
  assert.equal(await fs.readFile(path.join(f.rootPath, 'legacy-current.json'), 'utf8'), f.legacySeed.pointer);
  assert.equal(await fs.readFile(path.join(f.legacySeed.base, 'binding.json'), 'utf8'), f.legacySeed.binding);
  const all = await f.service.read('w'); assert.deepEqual(all.map(t => t.id).sort(), ['other', 't']);
  const other = all.find(t => t.id === 'other'); assert.equal(other.plan.mode, 'old-planning-mode'); assert.deepEqual(other.legacy.original.legacySourceDraft, f.legacySeed.manifest.drafts[0]);
  const opened = await f.open(); assert.equal((await opened.read('w')).length, 2); assert.deepEqual(f.calls, []);
});

test('unknown historical config does not fall back to a changed current plan', () => {
  const core = new FleetCore(); core.saveDraftTicket('w', { id: 'x', plan: { goal: 'current goal' } });
  const ticket = core.readTicket('w', 'x'); ticket.execution = { currentConfigRevision: 1, configurations: { 1: { plan: normalizePlan({ goal: 'frozen goal' }), frozenAt: null, sourceRefs: [] } }, nodes: {}, gates: {} };
  const projection = projectTicket(ticket, { configRevision: 999 }); assert.equal(projection.unknownConfigRevision, true); assert.equal(projection.snapshot, null); assert.deepEqual(projection.nodes, []);
});

test('unmapped legacy plan data is not silently dropped by automatic repair', () => {
  for (const mutation of [p => p.unknown = 'retain', p => p.binding.extra = 'retain', p => p.ticket.external = { retain: true }]) { const p = legacyPlan(); mutation(p); assert.throws(() => repairLegacyPlan(p), e => e.code === 'repair-required'); }
});
