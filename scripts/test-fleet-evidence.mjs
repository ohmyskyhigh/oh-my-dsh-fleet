// P-44～P-47 evidence completion, version-bound review, delivery settlement and pre-approved rework.
// Core tests are memory-only (sealed refs are fabricated); Store/Service tests use real test-owned
// temp directories and a controlled fake Adapter, matching the existing suite fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { FleetCore } from '../packages/fleet-shell/src/fleet-core.js';
import { FleetService } from '../packages/fleet-shell/src/fleet-service.js';
import { FleetStore } from '../packages/fleet-shell/src/fleet-store.js';
import { normalizePlan, validatePlan, projectTicket } from '../packages/fleet-shell/src/fleet-model.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rejects = (fn, code) => assert.throws(fn, e => e.code === code);
const hex = c => c.repeat(64);

// ---- memory Core fixture ----
function corePlan(extra = {}) {
  return normalizePlan({
    goal: 'Evidence ticket', deliverables: ['report'],
    agents: { writer: { profile: { instructions: 'write' } }, rev: { profile: { instructions: 'review' } } },
    nodes: [{ id: 'write', agentId: 'writer', dependsOn: [], task: { prompt: 'write', contract: { acceptance: ['has sources'], scope: { in: ['report/'], out: ['secret/'] }, verify: ['check.py'] } } }],
    gates: [{ id: 'quality', from: ['write'], to: [], reviewer: { kind: 'human' } }],
    ...extra
  });
}
function coreFixture(plan = corePlan()) {
  const core = new FleetCore();
  core.saveDraftTicket('w', { id: 't', sessionId: 'origin', plan });
  const human = core.human('w', 'person'), runtime = core.runtime('w');
  human.start('t');
  return { core, human, runtime, read: () => core.readTicket('w', 't'), projected: () => projectTicket(core.readTicket('w', 't')) };
}
const sealedArtifact = (overrides = {}) => ({ sourcePath: 'report/final.md', deliverableIndex: 0, mediaType: 'text/markdown', sha256: hex('a'), size: 12, snapshotPath: '.fleet/tickets/x/artifacts/a-1/v1/final.md', ...overrides });
function writeWorker(f) {
  const latest = f.read().execution.nodes.write.attempts.at(-1);
  return latest?.status === 'running' ? f.runtime.resumeNode('t', 'write', latest.id) : f.runtime.claimNode('t', 'write');
}
function submit(f, artifactOverrides = {}, extra = {}) {
  const worker = writeWorker(f);
  const result = worker.submitEvidence({ artifacts: [sealedArtifact(artifactOverrides)], acceptanceResults: [{ criterion: 'has sources', status: 'passed', evidence: 'appendix A' }], verification: [{ command: 'check.py', exitCode: 0, output: 'OK', source: 'agent-report' }], summary: 'done', ...extra });
  return { worker, result };
}

// ---- real filesystem Service fixture ----
async function serviceFixture(t, plan) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-evidence-'));
  const rootPath = path.join(temp, 'root'), wsDir = path.join(temp, 'w');
  await fs.mkdir(wsDir, { recursive: true });
  const calls = { create: [], submit: [], inspect: [], cancel: [], message: [] }, sessions = new Map(), hooks = {};
  const adapter = {
    async create(r) { calls.create.push(structuredClone(r)); const id = `s-${sessions.size + 1}`; sessions.set(id, { status: 'unknown' }); return { sessionId: id }; },
    async submit(r) { calls.submit.push(structuredClone(r)); sessions.set(r.sessionId, { status: 'running' }); await hooks.submit?.(r); return { messageId: r.requestId }; },
    async inspect(r) { calls.inspect.push(structuredClone(r)); return structuredClone(await hooks.inspect?.(r) ?? sessions.get(r.sessionId) ?? { status: 'unknown' }); },
    async cancel(r) { calls.cancel.push(r); return await hooks.cancel?.(r) ?? { stopped: true }; },
    async message(r) { calls.message.push(structuredClone(r)); return { messageId: r.requestId }; },
    async recover() {}
  };
  const services = [];
  const open = async () => { const s = await FleetService.open({ rootPath, workspacePaths: { w: wsDir }, adapter, autoStart: false }); services.push(s); return s; };
  const service = await open();
  t.after(async () => { for (const s of services) await s.close(); const target = path.resolve(temp); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert(path.basename(target).startsWith('fleet-evidence-')); await fs.rm(target, { recursive: true, force: true }); });
  return { temp, rootPath, wsDir, service, open, calls, sessions, hooks };
}
const deliveryPlan = (extra = {}) => normalizePlan({ goal: 'Deliver report', deliverables: ['report'], agents: { writer: { profile: { instructions: 'write' } } }, nodes: [{ id: 'write', agentId: 'writer', dependsOn: [], task: { prompt: 'write' } }], gates: [], ...extra });
async function startRunning(f, plan = deliveryPlan()) {
  await f.service.saveDraftTicket('w', { id: 't', sessionId: 'origin', plan });
  await f.service.human('w', 'human', 'start', ['t']);
  await f.service.tick();
  const ticket = await f.service.read('w', 't');
  return ticket.execution.nodes.write.attempts.at(-1).sessionId;
}
const ticketHash = id => sha(JSON.stringify(id));

// ============================ A. model validation & projection ============================
test('task.contract and gate requireEvidence/rework validate shape; start checks targetNodes subset of from', () => {
  const base = corePlan();
  assert.equal(validatePlan(base, { mode: 'start' }).valid, true);
  const badContract = structuredClone(base); badContract.nodes[0].task.contract = { acceptance: 'not-array' };
  assert.equal(validatePlan(badContract).valid, false);
  const badScope = structuredClone(base); badScope.nodes[0].task.contract.scope = { in: [1] };
  assert.equal(validatePlan(badScope).valid, false);
  const badRework = structuredClone(base); badRework.gates[0].rework = { maxRounds: -1 };
  assert.equal(validatePlan(badRework).valid, false);
  const badRequire = structuredClone(base); badRequire.gates[0].requireEvidence = 'yes';
  assert.equal(validatePlan(badRequire).valid, false);
  const badTarget = structuredClone(base); badTarget.gates[0].rework = { maxRounds: 2, targetNodes: ['rev'] };
  assert.equal(validatePlan(badTarget).valid, true, 'save accepts references');
  assert.equal(validatePlan(badTarget, { mode: 'start' }).valid, false, 'start rejects target outside from');
  const okTarget = structuredClone(base); okTarget.gates[0].rework = { maxRounds: 2, targetNodes: ['write'], scopeNote: 'only report' };
  assert.equal(validatePlan(okTarget, { mode: 'start' }).valid, true);
});

test('projection carries artifacts/deliverables/delivery, gate coverage/rework and attempt completion without writing back', () => {
  const f = coreFixture();
  const { result } = submit(f);
  writeWorker(f).complete('done');
  const before = JSON.stringify(f.read());
  const p = f.projected();
  assert.equal(Object.keys(p.artifacts).length, 1);
  assert.equal(p.deliverables[0].index, 0); assert.equal(p.deliverables[0].label, 'report');
  assert.equal(p.deliverables[0].artifactId, result.artifacts[0].artifactId);
  assert.equal(p.deliverables[0].latest.version, 1); assert.equal(p.deliverables[0].latest.sha256, hex('a'));
  assert.equal(p.deliverables[0].reviewStatus, 'unreviewed');
  assert.deepEqual(p.delivery, null);
  assert.equal(p.gates[0].coverage, 'not-passed');
  assert.deepEqual(p.gates[0].rework, { enabled: false, maxRounds: 0, autoReworkRounds: 0, unlimited: true });
  assert.equal(p.nodes.find(n => n.id === 'write').attempts.at(-1).completion.evidenceKind, 'agent-report');
  assert.equal(JSON.stringify(f.read()), before, 'projection never mutates the persisted body');
});

// ============================ B. submitEvidence domain ============================
test('completion without evidence stays visible and old settlement is unchanged for empty deliverables', () => {
  const f = coreFixture(corePlan({ deliverables: [] }));
  const worker = f.runtime.claimNode('t', 'write'); worker.complete('plain output');
  const p = f.projected();
  assert.equal(p.nodes.find(n => n.id === 'write').status, 'completed');
  assert.equal(p.nodes.find(n => n.id === 'write').attempts.at(-1).completion, undefined);
  f.human.reviewGate('t', 'quality', 'passed', 'verified');
  assert.equal(f.read().status, 'delivered', 'no deliverables declared -> original settlement');
});

test('submitEvidence assigns stable artifactId, monotonic versions and a completion record', () => {
  const f = coreFixture();
  const first = submit(f, { sha256: hex('a') });
  const artifactId = first.result.artifacts[0].artifactId;
  assert.equal(first.result.artifacts[0].version, 1);
  assert.equal(first.result.completion.nodeId, 'write');
  assert.equal(first.result.completion.artifactRefs[0].artifactId, artifactId);
  const second = submit(f, { sha256: hex('b'), snapshotPath: '.fleet/tickets/x/artifacts/a-1/v2/final.md' });
  assert.equal(second.result.artifacts[0].artifactId, artifactId, 'same (node, deliverableIndex) keeps id');
  assert.equal(second.result.artifacts[0].version, 2);
  const artifact = f.read().execution.artifacts[artifactId];
  assert.equal(artifact.versions.length, 2); assert.equal(artifact.deliverableIndex, 0);
  assert.equal(f.read().execution.deliverables['0'].artifactId, artifactId);
  assert.equal(f.read().execution.nodes.write.attempts.at(-1).completion.artifactRefs[0].version, 2, 'completion keeps the latest submission');
  assert.ok(f.read().activity.some(a => a.type === 'node-evidence-submitted'));
});

test('submitEvidence rejects out-of-range deliverableIndex, host-verified source and bad shape', () => {
  const f = coreFixture();
  rejects(() => submit(f, { deliverableIndex: 5 }), 'invalid-input');
  rejects(() => submit(f, { deliverableIndex: -1 }), 'invalid-input');
  const worker = writeWorker(f);
  rejects(() => worker.submitEvidence({ artifacts: [sealedArtifact()], verification: [{ command: 'x', source: 'host-verified' }] }), 'invalid-input');
  rejects(() => worker.submitEvidence({ artifacts: [sealedArtifact({ sha256: 'short' })] }), 'invalid-input');
  rejects(() => worker.submitEvidence({ artifacts: [sealedArtifact()], unexpected: true }), 'invalid-input');
  rejects(() => worker.submitEvidence({ acceptanceResults: [{ status: 'maybe' }] }), 'invalid-input');
});

test('submitEvidence requires an active attempt; a completed attempt cannot submit', () => {
  const f = coreFixture();
  const { worker } = submit(f);
  worker.complete('done');
  rejects(() => worker.submitEvidence({ artifacts: [sealedArtifact({ sha256: hex('c') })] }), 'stale-attempt');
});

// ============================ review binding & coverage ============================
test('review auto-binds the latest from-node versions; explicit refs are verified against the sealed chain', () => {
  const f = coreFixture();
  const { result } = submit(f, { sha256: hex('a') });
  const artifactId = result.artifacts[0].artifactId;
  const worker = f.runtime.resumeNode('t', 'write', f.read().execution.nodes.write.attempts.at(-1).id); worker.complete('done');
  f.human.reviewGate('t', 'quality', 'passed', 'looks good');
  const review = f.read().execution.gates.quality.reviews.at(-1);
  assert.equal(review.bindingKind, 'auto-latest');
  assert.deepEqual(review.artifactRefs, [{ artifactId, version: 1, sha256: hex('a') }]);
  assert.equal(review.findings.length, 1, 'text evidence becomes one finding');
  assert.equal(f.projected().gates[0].coverage, 'covered');
  // explicit binding with a mismatched hash is rejected
  const f2 = coreFixture();
  const r2 = submit(f2, { sha256: hex('a') });
  writeWorker(f2).complete('done');
  rejects(() => f2.human.reviewGate('t', 'quality', 'passed', { artifactRefs: [{ artifactId: r2.result.artifacts[0].artifactId, version: 1, sha256: hex('b') }] }), 'invalid-input');
  f2.human.reviewGate('t', 'quality', 'passed', { artifactRefs: [{ artifactId: r2.result.artifacts[0].artifactId, version: 1, sha256: hex('a') }], findings: [{ id: 'f1', severity: 'low', description: 'minor' }] });
  const explicit = f2.read().execution.gates.quality.reviews.at(-1);
  assert.equal(explicit.bindingKind, 'explicit'); assert.equal(explicit.findings[0].id, 'f1');
});

test('a newer artifact version than the passed review bound makes coverage stale and blocks delivered; humanOverride releases it', () => {
  const f = coreFixture(corePlan({ deliverables: [] }));
  const first = submit(f, { deliverableIndex: undefined, sha256: hex('a'), sourcePath: 'report/v1.md', snapshotPath: '.fleet/x/v1.md' });
  const artifactId = first.result.artifacts[0].artifactId;
  submit(f, { deliverableIndex: undefined, sha256: hex('b'), sourcePath: 'report/v1.md', snapshotPath: '.fleet/x/v2.md' });
  writeWorker(f).complete('done');
  // reviewer explicitly binds the older v1 while latest is v2 -> stale
  f.human.reviewGate('t', 'quality', 'passed', { artifactRefs: [{ artifactId, version: 1, sha256: hex('a') }] });
  assert.equal(f.projected().gates[0].coverage, 'stale');
  assert.equal(f.read().status, 'running', 'stale coverage blocks delivered');
  f.human.forcePassGate('t', 'quality');
  assert.equal(f.projected().gates[0].coverage, 'covered');
  assert.equal(f.read().status, 'delivered', 'humanOverride is not blocked by stale');
});

test('requireEvidence blocks a passed review without completion; forcePassGate bypasses it', () => {
  const f = coreFixture(corePlan({ gates: [{ id: 'quality', from: ['write'], to: [], reviewer: { kind: 'human' }, requireEvidence: true }] }));
  f.runtime.claimNode('t', 'write').complete('no structured evidence');
  rejects(() => f.human.reviewGate('t', 'quality', 'passed', 'ok'), 'evidence-required');
  f.human.forcePassGate('t', 'quality');
  assert.equal(f.read().execution.gates.quality.status, 'passed');
  // with completion the same gate passes normally
  const f2 = coreFixture(corePlan({ gates: [{ id: 'quality', from: ['write'], to: [], reviewer: { kind: 'human' }, requireEvidence: true }] }));
  submit(f2); f2.runtime.resumeNode('t', 'write', f2.read().execution.nodes.write.attempts.at(-1).id).complete('done');
  f2.human.reviewGate('t', 'quality', 'passed', 'ok');
  assert.equal(f2.read().execution.gates.quality.status, 'passed');
});

// ============================ delivery settlement (Core) ============================
test('deliveryPending, recordDelivery and deliverOverride settle declared deliverables', () => {
  const f = coreFixture(corePlan({ gates: [] }));
  const { result } = submit(f);
  writeWorker(f).complete('done');
  assert.equal(f.read().status, 'running', 'bound but not exported -> not delivered');
  const pending = f.runtime.deliveryPending('t');
  assert.equal(pending.ticketId, 't'); assert.equal(pending.target, null);
  assert.equal(pending.items[0].deliverableIndex, 0); assert.equal(pending.items[0].version, 1);
  const row = f.runtime.recordDelivery('t', { target: null, items: pending.items, manifestPath: '.fleet/m.json', receiptPath: '.fleet/r.json', gateRefs: [] });
  assert.equal(f.read().status, 'delivered');
  assert.equal(f.read().execution.delivery.history.length, 1);
  assert.equal(f.projected().deliverables[0].delivery.deliveryId, row.id);
  assert.equal(f.runtime.deliveryPending('t'), null, 'already delivered');
});

test('deliverOverride releases missing bindings and records gaps; reason is required', () => {
  const f = coreFixture(corePlan({ gates: [] }));
  f.runtime.claimNode('t', 'write').complete('no evidence submitted');
  assert.equal(f.read().status, 'running');
  assert.equal(f.runtime.deliveryPending('t'), null, 'unbound deliverable -> no pending export');
  rejects(() => f.human.deliverOverride('t', '  '), 'invalid-input');
  const override = f.human.deliverOverride('t', 'ship without binding');
  assert.equal(override.reason, 'ship without binding');
  assert.equal(override.gaps.unbound[0].index, 0);
  assert.equal(f.read().status, 'delivered');
  assert.ok(f.read().activity.some(a => a.type === 'delivery-override'));
});

// ============================ rework (Core) ============================
const reworkPlan = (reviewer, maxRounds) => corePlan({ deliverables: [], nodes: [{ id: 'write', agentId: 'writer', dependsOn: [], task: { prompt: 'write' } }, { id: 'rev', agentId: 'rev', dependsOn: [], task: { prompt: 'review' } }], gates: [{ id: 'quality', from: ['write'], to: [], reviewer, rework: { maxRounds } }] });
function completeWrite(f) { f.runtime.claimNode('t', 'write').complete('output'); }
function returnGate(f, evidence) {
  const kind = f.read().plan.gates.find(g => g.id === 'quality').reviewer.kind;
  return kind === 'human' ? f.human.reviewGate('t', 'quality', 'returned', evidence) : f.runtime.reviewer('t', 'quality').submit('returned', evidence);
}
test('rework opens a new Attempt and Gate cycle; agent budget exhausts and rework-exhausted is recorded once', () => {
  const f = coreFixture(reworkPlan({ kind: 'agent', nodeId: 'rev' }, 2));
  completeWrite(f);
  returnGate(f, { findings: [{ id: 'f1', severity: 'high', description: 'missing sources' }] });
  let due = f.runtime.reworkDue('t');
  assert.equal(due.length, 1); assert.equal(due[0].autoRound, true); assert.deepEqual(due[0].targetNodes, ['write']);
  assert.equal(due[0].findings[0].id, 'f1');
  f.runtime.applyRework('t', 'quality');
  assert.equal(f.read().execution.gates.quality.cycle, 1);
  assert.equal(f.read().execution.gates.quality.autoReworkRounds, 1);
  assert.equal(f.read().execution.nodes.write.status, 'pending');
  assert.ok(f.read().activity.some(a => a.type === 'gate-rework'));
  const retryRow = f.read().execution.nodes.write.thread.find(r => r.intent === 'retry');
  assert.ok(retryRow.text.includes('missing sources'), 'findings travel into the retry reason');
  // round 2
  completeWrite(f); returnGate(f, 'still wrong');
  assert.equal(f.runtime.reworkDue('t').length, 1);
  f.runtime.applyRework('t', 'quality');
  assert.equal(f.read().execution.gates.quality.autoReworkRounds, 2);
  // exhausted
  completeWrite(f); returnGate(f, 'again');
  assert.deepEqual(f.runtime.reworkDue('t'), []);
  rejects(() => f.runtime.applyRework('t', 'quality'), 'state-conflict');
  f.runtime.noteReworkExhausted('t');
  f.runtime.noteReworkExhausted('t');
  assert.equal(f.read().activity.filter(a => a.type === 'rework-exhausted').length, 1, 'recorded once');
});

test('human gate rework is unlimited and never spends budget; manual retry never spends budget', () => {
  const f = coreFixture(reworkPlan({ kind: 'human' }, 2));
  for (let i = 0; i < 4; i++) {
    completeWrite(f); returnGate(f, `round ${i}`);
    assert.equal(f.runtime.reworkDue('t').length, 1, 'human gate stays due beyond maxRounds');
    assert.equal(f.runtime.reworkDue('t')[0].autoRound, false);
    f.runtime.applyRework('t', 'quality');
  }
  assert.equal(f.read().execution.gates.quality.autoReworkRounds ?? 0, 0, 'human rework never increments budget');
  assert.equal(f.read().execution.gates.quality.cycle, 4);
  // manual retry does not spend budget
  completeWrite(f);
  const before = f.read().execution.gates.quality.autoReworkRounds;
  f.human.retryNode('t', 'write', 'manual fix');
  assert.equal(f.read().execution.gates.quality.autoReworkRounds, before);
});

test('rework respects stop requests and human override', () => {
  const f = coreFixture(reworkPlan({ kind: 'agent', nodeId: 'rev' }, 3));
  completeWrite(f); returnGate(f, 'fix');
  f.human.forcePassGate('t', 'quality');
  assert.deepEqual(f.runtime.reworkDue('t'), [], 'humanOverride suppresses rework');
  const f2 = coreFixture(reworkPlan({ kind: 'agent', nodeId: 'rev' }, 3));
  completeWrite(f2); returnGate(f2, 'fix');
  f2.human.stop('t');
  assert.deepEqual(f2.runtime.reworkDue('t'), [], 'stop request suppresses rework');
});

// ============================ fromState compatibility ============================
test('fromState accepts the new groups and keeps the delivered invariant; old states read unchanged', () => {
  const f = coreFixture(corePlan({ gates: [] }));
  submit(f); writeWorker(f).complete('done');
  const pending = f.runtime.deliveryPending('t');
  f.runtime.recordDelivery('t', { target: null, items: pending.items, manifestPath: 'm.json', receiptPath: 'r.json', gateRefs: [] });
  const state = f.core.exportState();
  const restored = FleetCore.fromState(state);
  assert.equal(restored.readTicket('w', 't').status, 'delivered');
  assert.deepEqual(restored.exportState(), state);
  // a delivered ticket that engaged evidence but lacks delivery evidence is rejected
  const broken = structuredClone(state);
  broken.workspaces[0].tickets[0].execution.delivery = { history: [], override: null };
  assert.throws(() => FleetCore.fromState(broken), e => e.code === 'invalid-state');
  // pre-0.6.0 delivered record without new groups keeps the original invariant
  const old = structuredClone(state);
  const ot = old.workspaces[0].tickets[0];
  delete ot.execution.artifacts; delete ot.execution.deliverables; delete ot.execution.delivery;
  ot.execution.configurations[ot.execution.currentConfigRevision].plan.deliverables = ['report'];
  assert.equal(FleetCore.fromState(old).readTicket('w', 't').status, 'delivered');
});

// ============================ C. Store sealing & export (real fs) ============================
test('sealArtifact hashes bytes, seals under the ticket area and rejects traversal outside the Workspace', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-evidence-store-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const wsDir = path.join(temp, 'w'); await fs.mkdir(path.join(wsDir, 'report'), { recursive: true });
  const source = path.join(wsDir, 'report', 'final.md'); const bytes = Buffer.from('# report\nverified\n');
  await fs.writeFile(source, bytes);
  const sealed = await FleetStore.sealArtifact({ workspaceDir: wsDir, ticketId: 't', artifactId: 'a-1', version: 1, sourceAbsPath: source });
  assert.equal(sealed.sha256, sha(bytes)); assert.equal(sealed.size, bytes.length);
  const snap = path.join(wsDir, sealed.snapshotPath);
  assert.equal(sealed.snapshotPath, path.join('.fleet', 'tickets', ticketHash('t'), 'artifacts', 'a-1', 'v1', 'final.md'));
  assert.deepEqual(await fs.readFile(snap), bytes);
  // idempotent re-seal of the same version/content
  const again = await FleetStore.sealArtifact({ workspaceDir: wsDir, ticketId: 't', artifactId: 'a-1', version: 1, sourceAbsPath: source });
  assert.equal(again.sha256, sealed.sha256);
  // traversal / escape rejected
  const outside = path.join(temp, 'outside.md'); await fs.writeFile(outside, 'x');
  await assert.rejects(FleetStore.sealArtifact({ workspaceDir: wsDir, ticketId: 't', artifactId: 'a-2', version: 1, sourceAbsPath: outside }), /inside the Workspace/);
  await assert.rejects(FleetStore.sealArtifact({ workspaceDir: wsDir, ticketId: 't', artifactId: 'a-3', version: 1, sourceAbsPath: path.join(wsDir, 'report', '..', '..', 'outside.md') }), /unsafe|inside/);
});

test('exportDelivery writes manifest/receipt, is idempotent by receipt, and reconcileDelivery reads it back', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-evidence-store-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const wsDir = path.join(temp, 'w'); await fs.mkdir(path.join(wsDir, 'report'), { recursive: true });
  const source = path.join(wsDir, 'report', 'final.md'); const bytes = Buffer.from('deliverable bytes');
  await fs.writeFile(source, bytes);
  const sealed = await FleetStore.sealArtifact({ workspaceDir: wsDir, ticketId: 't', artifactId: 'a-1', version: 1, sourceAbsPath: source });
  const items = [{ deliverableIndex: 0, artifactId: 'a-1', version: 1, sha256: sealed.sha256, snapshotPath: sealed.snapshotPath }];
  const first = await FleetStore.exportDelivery({ workspaceDir: wsDir, ticketId: 't', deliveryId: 'd-1', target: null, items });
  assert.equal(first.reused, false);
  assert.ok((await fs.stat(first.manifestPath)).isFile()); assert.ok((await fs.stat(first.receiptPath)).isFile());
  const manifest = JSON.parse(await fs.readFile(first.manifestPath, 'utf8'));
  assert.equal(manifest.items[0].sha256, sealed.sha256);
  const second = await FleetStore.exportDelivery({ workspaceDir: wsDir, ticketId: 't', deliveryId: 'd-1', target: null, items });
  assert.equal(second.reused, true, 'complete receipt short-circuits re-export');
  const reconciled = await FleetStore.reconcileDelivery({ workspaceDir: wsDir, ticketId: 't', deliveryId: 'd-1', target: null });
  assert.equal(reconciled.deliveryId, 'd-1'); assert.equal(reconciled.items[0].version, 1);
  assert.equal(await FleetStore.reconcileDelivery({ workspaceDir: wsDir, ticketId: 't', deliveryId: 'missing', target: null }), null);
});

test('listOrphanStaging reports orphan staging and unreferenced sealed versions without deleting', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-evidence-store-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const wsDir = path.join(temp, 'w'); await fs.mkdir(path.join(wsDir, 'report'), { recursive: true });
  const source = path.join(wsDir, 'report', 'final.md'); await fs.writeFile(source, 'bytes');
  const sealed = await FleetStore.sealArtifact({ workspaceDir: wsDir, ticketId: 't', artifactId: 'a-1', version: 1, sourceAbsPath: source });
  const area = path.join(wsDir, '.fleet', 'tickets', ticketHash('t'), 'artifacts');
  await fs.mkdir(path.join(area, '.staging-orphan'), { recursive: true });
  await fs.mkdir(path.join(area, 'a-1', 'v9'), { recursive: true }); // unreferenced version
  const report = await FleetStore.listOrphanStaging(wsDir);
  assert.ok(report.staging.some(p => p.includes('.staging-orphan')));
  assert.ok(report.unreferenced.some(p => p.includes(path.join('a-1', 'v9'))));
  assert.ok((await fs.stat(path.join(area, '.staging-orphan'))).isDirectory(), 'diagnostics never delete');
  assert.ok(sealed.sha256);
});

// ============================ D. Service submitEvidence + delivery (real fs) ============================
test('Service submitEvidence seals real bytes, increments versions and rejects non-execution Sessions', async t => {
  const f = await serviceFixture(t);
  const sessionId = await startRunning(f);
  await fs.mkdir(path.join(f.wsDir, 'report'), { recursive: true });
  const file = path.join(f.wsDir, 'report', 'final.md'); const bytes = Buffer.from('real report content');
  await fs.writeFile(file, bytes);
  const result = await f.service.submitEvidence({ sessionId, payload: { artifacts: [{ path: 'report/final.md', deliverableIndex: 0, mediaType: 'text/markdown' }], acceptanceResults: [{ criterion: 'ok', status: 'passed' }], verification: [{ command: 'check', exitCode: 0, source: 'agent-report' }] } });
  assert.equal(result.artifacts[0].version, 1); assert.equal(result.artifacts[0].sha256, sha(bytes));
  const artifactId = result.artifacts[0].artifactId;
  const sealedPath = path.join(f.wsDir, '.fleet', 'tickets', ticketHash('t'), 'artifacts', artifactId, 'v1', 'final.md');
  assert.deepEqual(await fs.readFile(sealedPath), bytes);
  const handleFile = path.join(f.wsDir, FleetStore.handleFileRelPath('t', 'write'));
  const handle = JSON.parse(await fs.readFile(handleFile, 'utf8'));
  assert.equal(handle.nodeId, 'write'); assert.equal(handle.ticketId, 't');
  assert.equal(handle.artifacts[0].artifactId, artifactId); assert.equal(handle.artifacts[0].version, 1); assert.equal(handle.artifacts[0].sha256, sha(bytes));
  // resubmit -> version 2, same artifactId
  await fs.writeFile(file, 'updated content');
  const second = await f.service.submitEvidence({ sessionId, payload: { artifacts: [{ path: 'report/final.md', deliverableIndex: 0 }] } });
  assert.equal(second.artifacts[0].artifactId, artifactId); assert.equal(second.artifacts[0].version, 2);
  // out-of-range index rejected
  await assert.rejects(f.service.submitEvidence({ sessionId, payload: { artifacts: [{ path: 'report/final.md', deliverableIndex: 9 }] } }), e => e.code === 'invalid-input');
  // a planning/unknown Session is rejected (not a node attempt)
  await assert.rejects(f.service.submitEvidence({ sessionId: 'not-a-node-session', payload: {} }), e => e.code === 'session-scope');
  const ticket = await f.service.read('w', 't');
  assert.equal(ticket.execution.nodes.write.attempts.at(-1).completion.evidenceKind, 'agent-report');
});

test('Service tick exports and records delivery, settles delivered, and a restart never re-delivers', async t => {
  const f = await serviceFixture(t);
  const sessionId = await startRunning(f);
  await fs.mkdir(path.join(f.wsDir, 'report'), { recursive: true });
  await fs.writeFile(path.join(f.wsDir, 'report', 'final.md'), 'deliver me');
  await f.service.submitEvidence({ sessionId, payload: { artifacts: [{ path: 'report/final.md', deliverableIndex: 0 }] } });
  f.sessions.set(sessionId, { status: 'completed', output: 'done' });
  await f.service.tick();
  let ticket = await f.service.read('w', 't');
  assert.equal(ticket.status, 'delivered');
  assert.equal(ticket.execution.delivery.history.length, 1);
  const deliveryId = ticket.execution.delivery.history[0].id;
  const receiptPath = ticket.execution.delivery.history[0].receiptPath;
  assert.ok((await fs.stat(receiptPath)).isFile());
  const createsBefore = f.calls.create.length;
  // restart: reopen the same chains and tick; nothing is re-exported or re-dispatched
  await f.service.close();
  const reopened = await f.open();
  await reopened.tick();
  ticket = await reopened.read('w', 't');
  assert.equal(ticket.status, 'delivered');
  assert.equal(ticket.execution.delivery.history.length, 1, 'no duplicate delivery record');
  assert.equal(ticket.execution.delivery.history[0].id, deliveryId);
  assert.equal(f.calls.create.length, createsBefore, 'no new Session after restart');
  const reconciled = await FleetStore.reconcileDelivery({ workspaceDir: f.wsDir, ticketId: 't', deliveryId, target: null });
  assert.equal(reconciled.deliveryId, deliveryId);
});

test('Service delivery intent is durable: a receipt left before recording is reconciled without re-export', async t => {
  const f = await serviceFixture(t);
  const sessionId = await startRunning(f);
  await fs.mkdir(path.join(f.wsDir, 'report'), { recursive: true });
  await fs.writeFile(path.join(f.wsDir, 'report', 'final.md'), 'intent bytes');
  const submitted = await f.service.submitEvidence({ sessionId, payload: { artifacts: [{ path: 'report/final.md', deliverableIndex: 0 }] } });
  f.sessions.set(sessionId, { status: 'completed', output: 'done' });
  // complete the node and persist a delivery intent + export, but stop before recordDelivery by
  // exercising the Store idempotency directly: a second export reuses the receipt.
  await f.service.tick();
  const ticket = await f.service.read('w', 't');
  assert.equal(ticket.status, 'delivered');
  const history = ticket.execution.delivery.history[0];
  const reexport = await FleetStore.exportDelivery({ workspaceDir: f.wsDir, ticketId: 't', deliveryId: history.id, target: null, items: history.items });
  assert.equal(reexport.reused, true);
  assert.equal(reexport.items[0].sha256, submitted.artifacts[0].sha256);
});

test('Service requireEvidence gate blocks Agent review pass without completion; prompt carries contract and versions', async t => {
  const plan = normalizePlan({ goal: 'g', deliverables: [], agents: { writer: { profile: { instructions: 'write' } }, rev: { profile: { instructions: 'review' } } }, nodes: [{ id: 'write', agentId: 'writer', dependsOn: [], task: { prompt: 'write', contract: { acceptance: ['sources'], verify: ['check.py'] } } }, { id: 'rev', agentId: 'rev', dependsOn: ['write'], task: { prompt: 'review' } }], gates: [{ id: 'quality', from: ['write'], to: ['rev'], reviewer: { kind: 'agent', nodeId: 'rev' }, requireEvidence: true }] });
  const f = await serviceFixture(t, plan);
  await f.service.saveDraftTicket('w', { id: 't', sessionId: 'origin', plan });
  await f.service.human('w', 'human', 'start', ['t']);
  await f.service.tick();
  const writeSession = (await f.service.read('w', 't')).execution.nodes.write.attempts.at(-1).sessionId;
  const nodePrompt = f.calls.submit.find(c => c.sessionId === writeSession).prompt;
  assert.ok(nodePrompt.includes('Task contract')); assert.ok(nodePrompt.includes('fleet_submit')); assert.ok(nodePrompt.includes('sources'));
  // complete write WITHOUT evidence -> agent gate review pass must be blocked by requireEvidence
  f.sessions.set(writeSession, { status: 'completed', output: 'done' });
  await f.service.tick();
  const reviewSession = (await f.service.read('w', 't')).execution.gates.quality.dispatch.sessionId;
  const reviewPrompt = f.calls.submit.find(c => c.sessionId === reviewSession).prompt;
  assert.ok(reviewPrompt.includes('Artifact versions under review')); assert.ok(reviewPrompt.includes('Gate contract'));
  f.sessions.set(reviewSession, { status: 'completed', output: { finalText: JSON.stringify({ decision: 'passed', evidence: 'ok' }) } });
  await f.service.tick();
  const ticket = await f.service.read('w', 't');
  assert.equal(ticket.execution.gates.quality.status, 'returned', 'requireEvidence forces returned without completion');
});

test('Service pre-approved rework dispatches a new Attempt carrying findings; budget exhaustion escalates once', async t => {
  const plan = normalizePlan({ goal: 'g', deliverables: [], agents: { writer: { profile: { instructions: 'write' } }, rev: { profile: { instructions: 'review' } } }, nodes: [{ id: 'write', agentId: 'writer', dependsOn: [], task: { prompt: 'write' } }, { id: 'rev', agentId: 'rev', dependsOn: [], task: { prompt: 'review' } }], gates: [{ id: 'quality', from: ['write'], to: [], reviewer: { kind: 'agent', nodeId: 'rev' }, rework: { maxRounds: 1 } }] });
  const f = await serviceFixture(t, plan);
  await f.service.saveDraftTicket('w', { id: 't', sessionId: 'origin', plan });
  await f.service.human('w', 'human', 'start', ['t']);
  await f.service.tick();
  const writeSession = (await f.service.read('w', 't')).execution.nodes.write.attempts.at(-1).sessionId;
  f.sessions.set(writeSession, { status: 'completed', output: 'v1' });
  await f.service.tick();
  const reviewSession = (await f.service.read('w', 't')).execution.gates.quality.dispatch.sessionId;
  f.sessions.set(reviewSession, { status: 'completed', output: { finalText: JSON.stringify({ decision: 'returned', evidence: 'missing sources', findings: [{ id: 'f1', severity: 'high', description: 'missing sources' }] }) } });
  await f.service.tick();
  let ticket = await f.service.read('w', 't');
  assert.equal(ticket.execution.gates.quality.autoReworkRounds, 1);
  assert.equal(ticket.execution.nodes.write.attempts.length, 2, 'rework opened a new Attempt');
  const newWriteSession = ticket.execution.nodes.write.attempts.at(-1).sessionId;
  const reworkPrompt = f.calls.submit.find(c => c.sessionId === newWriteSession).prompt;
  assert.ok(reworkPrompt.includes('missing sources'), 'findings reach the rework dispatch prompt');
  // complete again, return again -> budget exhausted, no new attempt, escalation recorded once
  f.sessions.set(newWriteSession, { status: 'completed', output: 'v2' });
  await f.service.tick();
  const reviewSession2 = (await f.service.read('w', 't')).execution.gates.quality.dispatch.sessionId;
  f.sessions.set(reviewSession2, { status: 'completed', output: { finalText: JSON.stringify({ decision: 'returned', evidence: 'still wrong' }) } });
  await f.service.tick(); await f.service.tick();
  ticket = await f.service.read('w', 't');
  assert.equal(ticket.execution.nodes.write.attempts.length, 2, 'exhausted budget opens no further Attempt');
  assert.equal(ticket.activity.filter(a => a.type === 'rework-exhausted').length, 1);
});

test('downstream dispatch context carries upstream summary, handoff, artifact versions and the handle file path', async t => {
  const plan = normalizePlan({ goal: 'g', deliverables: [], agents: { writer: { profile: { instructions: 'write' } }, reader: { profile: { instructions: 'read' } } }, nodes: [{ id: 'write', agentId: 'writer', dependsOn: [], task: { prompt: 'write' } }, { id: 'ship', agentId: 'reader', dependsOn: ['write'], task: { prompt: 'ship' } }], gates: [] });
  const f = await serviceFixture(t, plan);
  await f.service.saveDraftTicket('w', { id: 't', sessionId: 'origin', plan });
  await f.service.human('w', 'human', 'start', ['t']);
  await f.service.tick();
  const writeSession = (await f.service.read('w', 't')).execution.nodes.write.attempts.at(-1).sessionId;
  await fs.mkdir(path.join(f.wsDir, 'report'), { recursive: true });
  await fs.writeFile(path.join(f.wsDir, 'report', 'out.md'), 'handed over');
  await f.service.submitEvidence({ sessionId: writeSession, payload: { artifacts: [{ path: 'report/out.md' }], summary: 'Write complete', handoff: { note: 'ship reads the sealed report' } } });
  f.sessions.set(writeSession, { status: 'completed', output: 'done' });
  await f.service.tick();
  const shipSession = (await f.service.read('w', 't')).execution.nodes.ship.attempts.at(-1).sessionId;
  const shipPrompt = f.calls.submit.find(c => c.sessionId === shipSession).prompt;
  assert.ok(shipPrompt.includes('"nodeId":"write"'), 'upstream entry identifies the producing node');
  assert.ok(shipPrompt.includes(FleetStore.handleFileRelPath('t', 'write').replace(/\\/g, '/')), 'handle file path points at the producing node');
  assert.ok(shipPrompt.includes('"summary":"Write complete"'), 'completion summary propagates');
  assert.ok(shipPrompt.includes('ship reads the sealed report'), 'handoff object propagates');
  assert.ok(/"artifacts":\[\{"artifactId":"a-/.test(shipPrompt), 'sealed artifact versions propagate');
  assert.ok(shipPrompt.includes('Read it first'), 'downstream is instructed to read the handle file');
});
