import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { FleetService } from '../src/fleet-service.js';
import { registerFleetDashboardApi } from '../src/fleet-dashboard-api.js';

const ws = 'cardry';
const userId = 'operator';
const tempPrefix = 'fleet-orchestration-';
const node = (id, dependsOn = [], fields = {}) => ({
  id, agentId: 'worker', dependsOn, task: { prompt: `Run ${id}` }, ...fields
});
const plan = (goal, nodes, fields = {}) => ({
  contractVersion: 3, goal, agents: { worker: { profile: {} } }, nodes, gates: [], ...fields
});
const deliverable = (text, whenNodeRuns) => ({ text, ...(whenNodeRuns ? { whenNodeRuns } : {}) });
const latestAttempt = (ticket, nodeId) => ticket.execution?.nodes[nodeId].attempts.at(-1);
const sha256 = text => createHash('sha256').update(text).digest('hex');

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), tempPrefix));
  const workspace = path.join(temp, ws);
  await fs.mkdir(workspace);
  const services = new Set();
  const calls = { create: [], submit: [] };
  const sessions = new Map();
  const scheduleEdits = [];
  const schedules = new Map();
  const receipts = new Map();
  const adapter = {
    async create(input) {
      calls.create.push(input);
      const sessionId = `session-${sessions.size + 1}`;
      sessions.set(sessionId, { status: 'unknown' });
      return { sessionId };
    },
    async submit(input) {
      calls.submit.push(input);
      sessions.set(input.sessionId, { status: 'running' });
      return { messageId: input.requestId };
    },
    async inspect({ sessionId }) { return structuredClone(sessions.get(sessionId)); },
    async modelCatalog() { return { groups: [] }; },
    async recover() {},
    async cancel() { return { stopped: true }; },
    async message({ requestId }) { return { messageId: requestId }; },
    async scheduleCreate({ timing }) {
      const id = `schedule-${schedules.size + 1}`;
      const entry = { id, timing, status: 'active', target: { sessionId: `${id}-target` } };
      schedules.set(id, entry);
      receipts.set(id, []);
      return structuredClone(entry);
    },
    async scheduleView({ id }) { return structuredClone(schedules.get(id)); },
    async scheduleHistory({ id }) { return { records: structuredClone(receipts.get(id)) }; },
    async scheduleEdit(input) {
      scheduleEdits.push(input);
      const { id, patch } = input;
      const entry = schedules.get(id);
      entry.status = patch.active ? 'active' : 'paused';
      return structuredClone(entry);
    }
  };
  let service;
  async function open() {
    service = await FleetService.open({
      rootPath: path.join(temp, 'root'), workspacePaths: { [ws]: workspace }, adapter,
      autoStart: false, maxParallel: 16
    });
    services.add(service);
  }
  const routes = new Map();
  const dispose = registerFleetDashboardApi({
    workspaceRegistry: { get: id => id === ws ? { id, path: workspace, sessionIds: [] } : undefined },
    connection: { fetch: { register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    } } }
  }, { getService: async () => service });
  t.after(async () => {
    await dispose();
    for (const svc of services) await svc.close();
    const target = path.resolve(temp);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith(tempPrefix));
    assert.ok(!(await fs.lstat(target)).isSymbolicLink());
    await fs.rm(target, { recursive: true, force: true });
  });
  await open();
  const read = id => service.read(ws, id);
  const human = (action, ...args) => service.human(ws, userId, action, args);
  const save = (id, input) => service.saveDraftTicket(ws, { id, sessionId: `origin-${id}`, plan: input });
  async function running(id, nodeId) {
    const ticket = await read(id);
    assert.equal(ticket.execution?.nodes[nodeId].status, 'running', `${id}/${nodeId} should be running`);
    const attempt = latestAttempt(ticket, nodeId);
    assert.ok(attempt.sessionId, `${id}/${nodeId} should have a Session`);
    return attempt;
  }
  async function submitFile(id, nodeId, index, text, expectedVersion = 1) {
    const attempt = await running(id, nodeId);
    const sourcePath = path.join('reports', `${id}-${nodeId}.json`);
    const file = path.join(workspace, sourcePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    const result = await service.submitEvidence({ sessionId: attempt.sessionId, payload: {
      summary: `Evidence from ${id}/${nodeId}`,
      artifacts: [{ path: sourcePath, deliverableIndex: index, mediaType: 'application/json' }]
    } });
    const [artifact] = result.artifacts;
    assert.equal(artifact.sha256, sha256(text));
    assert.equal(artifact.version, expectedVersion);
    const ticket = await read(id);
    const snapshotPath = ticket.execution.artifacts[artifact.artifactId].versions.at(-1).snapshotPath;
    assert.equal(await fs.readFile(path.join(workspace, snapshotPath), 'utf8'), text);
    // A later workspace edit must not replace the sealed bytes handed to the consumer.
    await fs.writeFile(file, 'mutable working copy');
    return { ...artifact, ticketId: id, index, snapshotPath, text };
  }
  async function settle(id, nodeId, result = { status: 'completed', output: 'work completed' }) {
    sessions.set((await running(id, nodeId)).sessionId, result);
  }
  async function prompt(id, nodeId) {
    const { sessionId } = await running(id, nodeId);
    const dispatch = calls.submit.filter(call => call.sessionId === sessionId);
    assert.equal(dispatch.length, 1);
    return dispatch[0].prompt;
  }
  async function request(routePath, { query, body } = {}) {
    const url = new URL(routePath, 'http://fleet.fixture');
    url.search = new URLSearchParams({ workspaceId: ws, ...query });
    if (body) url.search = '';
    const response = await routes.get(routePath).fetch(new Request(url, body ? {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws, ...body })
    } : undefined));
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  return {
    workspace, calls, save, human, read, running, submitFile, settle, prompt,
    health: () => service.health,
    submitHandoff: (sessionId, handoff) => service.submitEvidence({ sessionId, payload: { handoff } }),
    async reopen() { await service.close(); services.delete(service); await open(); },
    async tick(times = 1) { for (let i = 0; i < times; i++) await service.tick(); },
    async dashboard(id) { return (await request('/api/fleet/view', { query: { ticketId: id } })).selectedTicket; },
    dashboardAction: body => request('/api/fleet/action', { body }),
    scheduleCount: () => schedules.size,
    scheduleEdits,
    createSeries: (id, timing) => service.seriesCreate(ws, { sourceTicketId: id, name: id, timing }),
    readSeries: async id => (await service.readSeries(ws)).find(series => series.id === id),
    deliverReceipt(series, scheduledAt, deliveredAt = scheduledAt) {
      const entry = schedules.get(series.scheduleId);
      const receipt = { scheduledAt, deliveredAt, targetSessionId: entry.target.sessionId };
      entry.lastDelivery = receipt;
      receipts.get(entry.id).push(receipt);
    }
  };
}

const daily = time => ({ kind: 'daily', daily: { time, time_zone: 'Asia/Shanghai' } });

async function occurrence(f, series, at) {
  const saved = await f.readSeries(series.id);
  const receipt = saved.occurrences.find(o => o.occurrenceAt === at);
  assert.ok(receipt?.ticketId, `Missing Ticket for ${series.name} at ${at}: ${JSON.stringify(saved.occurrences)}`);
  return receipt.ticketId;
}

async function startCollector(f, id) {
  await f.save(id, plan(`Collect ${id}`, [node('collect')], { deliverables: [deliverable(`${id} data`)] }));
  await f.human('start', id);
}

function noAttempt(ticket, nodeId) {
  assert.equal(latestAttempt(ticket, nodeId), undefined, `${ticket.id}/${nodeId} should have no Attempt`);
}

function upstreamInputs(prompt) {
  const label = 'Upstream Ticket deliverables: ';
  const line = prompt.split('\n').find(line => line.startsWith(label));
  assert.ok(line, 'dispatch should contain upstream Ticket deliverables');
  return JSON.parse(line.slice(label.length));
}

function assertPromptArtifact(prompt, artifact) {
  const upstream = upstreamInputs(prompt).find(entry => entry.ticketId === artifact.ticketId);
  assert.ok(upstream?.deliveryId, `missing delivery receipt for ${artifact.ticketId}`);
  const item = upstream.deliverables.find(item => item.index === artifact.index);
  assert.equal(item?.sha256, artifact.sha256);
  assert.equal(item.artifactId, artifact.artifactId);
  assert.equal(item.version, artifact.version);
  assert.equal(path.normalize(item.snapshotPath), path.normalize(artifact.snapshotPath));
}

test('whole-ticket dependency authorization gates the start and survives late delivery and restart', async t => {
  const f = await fixture(t);
  await startCollector(f, 'index');
  await startCollector(f, 'traffic');
  const analysis = await f.save('analysis', plan('Analyze both reports', [node('analyze')], {
    ticketDependencies: ['index', 'traffic']
  }));
  await f.tick();
  assert.equal((await f.read('analysis')).status, 'draft', 'saving has no automatic start authority');
  await assert.rejects(f.human('start', analysis.id), { code: 'dependency-wait' });
  assert.equal(f.health().ready, true);
  await assert.rejects(f.human('enableDependencies', analysis.id, analysis.revision + 1), { code: 'stale-revision' });
  await f.human('enableDependencies', analysis.id, analysis.revision);
  const detached = await f.save('disabled-analysis', analysis.plan);
  const armed = await f.human('enableDependencies', detached.id, detached.revision);
  await f.human('disableDependencies', armed.id, armed.revision);
  const index = await f.submitFile('index', 'collect', 0, '{"indexed":232}');
  await f.settle('index', 'collect');
  await f.tick(2);
  assert.equal((await f.read('index')).status, 'delivered');
  assert.equal((await f.read('analysis')).status, 'draft');
  assert.equal(f.calls.create.length, 2, 'one of two deliveries cannot release the Ticket');

  const waiting = await f.dashboard('analysis');
  assert.equal(waiting.dependencyReadiness.ready, false);
  assert.deepEqual(waiting.dependencyReadiness.waitingTicketIds, ['traffic']);
  assert.ok(waiting.dependencyAuthorization);
  // Restart before the last delivery. Only the authorized Ticket may start.
  const traffic = await f.submitFile('traffic', 'collect', 0, '{"clicks":364}');
  await f.settle('traffic', 'collect');
  await f.reopen();
  await f.tick(3);
  assert.equal((await f.read('traffic')).status, 'delivered');
  assert.equal((await f.read('disabled-analysis')).status, 'draft');
  const firstAttempt = await f.running('analysis', 'analyze');
  const firstPrompt = await f.prompt('analysis', 'analyze');
  assertPromptArtifact(firstPrompt, index);
  assertPromptArtifact(firstPrompt, traffic);
  await f.reopen();
  await f.tick(2);
  assert.equal((await f.running('analysis', 'analyze')).id, firstAttempt.id);
  assert.equal(f.calls.create.length, 3);
  assert.equal(f.calls.submit.length, 3);
  await f.settle('analysis', 'analyze', { status: 'failed', error: 'transient worker failure' });
  await f.tick();
  assert.equal((await f.read('analysis')).execution.nodes.analyze.status, 'failed');
  await f.human('retryNode', 'index', 'collect', 'Collect updated index figures');
  await f.tick();
  const updated = await f.submitFile('index', 'collect', 0, '{"indexed":999}', 2);
  assert.equal(updated.artifactId, index.artifactId);
  assert.notEqual(updated.sha256, index.sha256);
  await f.human('retryNode', 'analysis', 'analyze', 'Retry against the same delivered inputs');
  await f.tick(2);
  const retry = await f.running('analysis', 'analyze');
  const retryPrompt = await f.prompt('analysis', 'analyze');
  assert.notEqual(retry.id, firstAttempt.id);
  assertPromptArtifact(retryPrompt, index);
  assertPromptArtifact(retryPrompt, traffic);
  assert.deepEqual(upstreamInputs(retryPrompt), upstreamInputs(firstPrompt));
  assert.equal(await fs.readFile(path.join(f.workspace, index.snapshotPath), 'utf8'), index.text);
  assert.equal(await fs.readFile(path.join(f.workspace, traffic.snapshotPath), 'utf8'), traffic.text);
  await f.settle('index', 'collect');
  await f.settle('analysis', 'analyze');
  await f.tick(2);
  assert.equal((await f.read('index')).status, 'delivered');
  const finished = await f.read('analysis');
  assert.equal(finished.status, 'delivered');
  assert.equal(finished.activity.filter(event => event.type === 'ticket-started').length, 1);
  assert.equal(finished.execution.nodes.analyze.attempts.length, 2);
  assert.equal(f.calls.create.length, 5);
});

test('a node dependency waits for delivered while independent work continues', async t => {
  const f = await fixture(t);
  await f.save('index', plan('Collect index data', [node('collect')], {
    deliverables: [deliverable('Index data')],
    gates: [{ id: 'quality', from: ['collect'], to: [], reviewer: { kind: 'human' } }]
  }));
  await f.human('start', 'index');
  await f.save('analysis', plan('Analyze index data', [
    node('prepare'), node('analyze', ['prepare'], { ticketDependencies: ['index'] })
  ]));
  await f.human('start', 'analysis');
  await f.tick(2);
  await f.running('index', 'collect');
  await f.running('analysis', 'prepare');
  noAttempt(await f.read('analysis'), 'analyze');
  const blocked = await f.dashboard('analysis');
  assert.deepEqual(blocked.nodeDependencyReadiness.analyze.waitingTicketIds, ['index']);
  await f.settle('analysis', 'prepare');
  const data = await f.submitFile('index', 'collect', 0, '{"indexed":123}');
  await f.settle('index', 'collect');
  await f.tick(2);
  assert.equal((await f.read('index')).execution.nodes.collect.status, 'completed');
  assert.equal((await f.read('index')).status, 'running', 'review still pending');
  assert.equal((await f.read('analysis')).execution.nodes.prepare.status, 'completed');
  noAttempt(await f.read('analysis'), 'analyze');
  assert.equal(f.calls.create.length, 2);
  await f.human('reviewGate', 'index', 'quality', 'passed', 'Index evidence passed review');
  await f.tick(2);
  assert.equal((await f.read('index')).status, 'delivered');
  assertPromptArtifact(await f.prompt('analysis', 'analyze'), data);
  await f.settle('analysis', 'analyze');
  await f.tick(2);
  assert.equal((await f.read('analysis')).status, 'delivered');
});

function routingPlan() {
  return plan('Optimize declining metrics', [
    node('diagnose'), node('index'), node('traffic'), node('summary', ['index', 'traffic']), node('baseline')
  ], {
    logicGates: [{ id: 'declines', from: 'diagnose', routes: ['index', 'traffic'].map(id => ({
      id, to: [id], condition: { path: [id], operator: 'eq', value: true }
    })) }],
    deliverables: [deliverable('Baseline'), deliverable('Index changes', 'index'), deliverable('Traffic changes', 'traffic')]
  });
}

for (const [index, traffic] of [[true, true], [true, false], [false, true], [false, false]]) {
  test(`routing handoff index=${index}, traffic=${traffic} selects branches, joins and exports`, async t => {
    const f = await fixture(t);
    await f.save('optimize', routingPlan());
    await f.human('start', 'optimize');
    await f.tick();
    const source = await f.running('optimize', 'diagnose');
    const gated = await f.read('optimize');
    for (const id of ['index', 'traffic', 'summary']) noAttempt(gated, id);
    await f.submitHandoff(source.sessionId, { index, traffic });
    await f.settle('optimize', 'diagnose');
    await f.tick(2);
    const decisions = await f.dashboard('optimize');
    const routed = decisions.logicGates.find(gate => gate.id === 'declines');
    assert.equal(routed.attemptId, source.id);
    const selected = [];
    for (const [id, matched, item] of [['index', index, 1], ['traffic', traffic, 2]]) {
      const route = routed.routes.find(route => route.id === id);
      assert.equal(route.matched, matched, id);
      assert.equal(route.status, matched ? 'running' : 'skipped', id);
      const branch = decisions.nodes.find(n => n.id === id);
      assert.equal(branch.status, matched ? 'running' : 'skipped');
      assert.equal(branch.attempts.length, matched ? 1 : 0);
      if (matched) selected.push({ id, item });
    }
    noAttempt(await f.read('optimize'), 'summary');
    for (const [offset, { id, item }] of selected.entries()) {
      await f.submitFile('optimize', id, item, JSON.stringify({ changed: id }));
      await f.settle('optimize', id);
      await f.tick(2);
      if (offset + 1 < selected.length) noAttempt(await f.read('optimize'), 'summary');
    }
    if (selected.length) await f.settle('optimize', 'summary');
    else assert.equal((await f.read('optimize')).execution.nodes.summary.status, 'skipped');
    // Independent work remains live and its unscoped deliverable is still required.
    await f.running('optimize', 'baseline');
    if (!selected.length) {
      await f.settle('optimize', 'baseline');
      await f.tick(2);
      assert.equal((await f.read('optimize')).status, 'running', 'missing baseline evidence prevents delivery');
      await f.human('retryNode', 'optimize', 'baseline', 'Submit the required baseline');
      await f.tick();
    }
    await f.submitFile('optimize', 'baseline', 0, '{"score":53}');
    await f.settle('optimize', 'baseline');
    await f.tick(2);
    const finished = await f.dashboard('optimize');
    assert.equal(finished.status, 'delivered');
    assert.equal(finished.nodes.find(n => n.id === 'summary').attempts.length, Number(selected.length > 0));
    const record = (await f.read('optimize')).execution.delivery.history;
    assert.equal(record.length, 1);
    const expected = [0, ...selected.map(branch => branch.item)];
    assert.deepEqual(record[0].items.map(item => item.deliverableIndex).sort(), expected);
    const manifest = JSON.parse(await fs.readFile(record[0].manifestPath, 'utf8'));
    assert.deepEqual(manifest.items.map(item => item.deliverableIndex).sort(), expected);
    for (const [id, matched, item] of [['index', index, 1], ['traffic', traffic, 2]]) {
      assert.equal(finished.logicGates[0].routes.find(route => route.id === id).status, matched ? 'completed' : 'skipped');
      if (!matched) assert.equal(finished.deliverables[item].reviewStatus, 'skipped');
    }
  });
}

test('failed matched route blocks the join and remains distinguishable from a skipped route', async t => {
  const f = await fixture(t);
  await f.save('optimize', routingPlan());
  await f.human('start', 'optimize');
  await f.tick();
  const source = await f.running('optimize', 'diagnose');
  await f.submitHandoff(source.sessionId, { index: true, traffic: false });
  await f.settle('optimize', 'diagnose');
  await f.tick(2);
  await f.settle('optimize', 'index', { status: 'failed', error: 'Index change failed' });
  await f.settle('optimize', 'baseline');
  await f.tick(2);
  const failed = await f.dashboard('optimize');
  assert.notEqual(failed.status, 'delivered');
  assert.deepEqual(failed.logicGates[0].routes.map(route => [route.id, route.status]), [['index', 'failed'], ['traffic', 'skipped']]);
  noAttempt(await f.read('optimize'), 'summary');
});

for (const scope of ['ticket', 'node']) {
  test(`scheduled ${scope} bindings use local scheduled date when Monday's receipt arrives after Tuesday's delivery`, async t => {
    const f = await fixture(t);
    await f.save('collect-template', plan('Collect daily index', [node('collect')], { deliverables: [deliverable('Daily index')] }));
    const collection = await f.createSeries('collect-template', daily('00:30'));
    const dependency = { ticketDependencySeries: [collection.id] };
    await f.save('analysis-template', plan('Analyze daily index', [
      node('inventory'), node('analyze', [], scope === 'node' ? dependency : {})
    ], scope === 'ticket' ? dependency : {}));
    const analysis = await f.createSeries('analysis-template', daily('09:30'));
    // Local Monday and Tuesday. The two schedules land on different UTC dates for the same local date.
    const monday = { collect: '2026-11-22T16:30:00.000Z', analyze: '2026-11-23T01:30:00.000Z' };
    const tuesday = { collect: '2026-11-23T16:30:00.000Z', analyze: '2026-11-24T01:30:00.000Z' };
    f.deliverReceipt(analysis, monday.analyze);
    await f.tick(2);
    const mondayAnalysis = await occurrence(f, analysis, monday.analyze);
    const waiting = await f.read(mondayAnalysis);
    if (scope === 'ticket') assert.equal(waiting.status, 'draft');
    else await f.running(mondayAnalysis, 'inventory');
    noAttempt(waiting, 'analyze');
    await f.reopen();
    f.deliverReceipt(collection, tuesday.collect);
    f.deliverReceipt(analysis, tuesday.analyze);
    await f.tick(3);
    const tuesdayCollection = await occurrence(f, collection, tuesday.collect);
    const tuesdayAnalysis = await occurrence(f, analysis, tuesday.analyze);
    assert.notEqual(mondayAnalysis, tuesdayAnalysis);
    const tuesdayFile = await f.submitFile(tuesdayCollection, 'collect', 0, '{"day":"Tuesday","indexed":42}');
    await f.settle(tuesdayCollection, 'collect');
    await f.tick(3);
    assertPromptArtifact(await f.prompt(tuesdayAnalysis, 'analyze'), tuesdayFile);
    noAttempt(await f.read(mondayAnalysis), 'analyze');
    const late = '2026-11-24T03:30:00.000Z';
    f.deliverReceipt(collection, monday.collect, late);
    await f.tick(3);
    const mondayCollection = await occurrence(f, collection, monday.collect);
    assert.notEqual(mondayCollection, tuesdayCollection);
    noAttempt(await f.read(mondayAnalysis), 'analyze');
    const mondayFile = await f.submitFile(mondayCollection, 'collect', 0, '{"day":"Monday","indexed":61}');
    await f.settle(mondayCollection, 'collect');
    await f.tick(3);
    for (const [consumer, producer, own, other] of [[mondayAnalysis, mondayCollection, mondayFile, tuesdayFile], [tuesdayAnalysis, tuesdayCollection, tuesdayFile, mondayFile]]) {
      const ticket = await f.read(consumer);
      const prompt = await f.prompt(consumer, 'analyze');
      assertPromptArtifact(prompt, own);
      assert.deepEqual(upstreamInputs(prompt).map(input => input.ticketId), [producer]);
      assert.ok(!prompt.includes(other.sha256));
      assert.equal(ticket.dependencyBindings[collection.id], producer);
      const projected = await f.dashboard(consumer);
      const dependency = scope === 'ticket' ? projected.dependencyReadiness : projected.nodeDependencyReadiness.analyze;
      assert.deepEqual(dependency.ticketIds, [producer]);
      await f.settle(consumer, 'analyze');
      await f.settle(consumer, 'inventory');
    }
    await f.tick(2);
    const count = f.calls.create.length;
    f.deliverReceipt(collection, monday.collect, late);
    await f.reopen();
    await f.tick(2);
    for (const id of [mondayAnalysis, tuesdayAnalysis]) assert.equal((await f.read(id)).status, 'delivered');
    for (const series of [analysis, collection]) assert.equal((await f.readSeries(series.id)).occurrences.length, 2);
    assert.equal(f.calls.create.length, count);
    assert.equal(f.calls.submit.length, count);
  });
}

test('a Dashboard follower uses the prerequisite timer and can pause independently', async t => {
  const f = await fixture(t);
  await f.save('collector-source', plan('Collect daily traffic', [node('collect')], { deliverables: [deliverable('Traffic')] }));
  const primary = await f.createSeries('collector-source', daily('09:30'));
  const source = await f.save('follower-source', plan('Analyze traffic after delivery', [node('analyze')], {
    ticketDependencySeries: [primary.id]
  }));
  await f.dashboardAction({
    action: 'series-follow', sourceTicketId: source.id, triggerSeriesId: primary.id,
    expectedRevision: source.revision, name: 'Analyze after collection'
  });
  const followerId = (await f.dashboard(source.id)).series.seriesId;
  const follower = await f.readSeries(followerId);
  assert.notEqual(follower.id, primary.id);
  assert.equal(f.scheduleCount(), 1);

  const instants = ['2026-11-23T01:30:00.000Z', '2026-11-24T01:30:00.000Z'];
  for (const [index, at] of instants.entries()) {
    if (index > 0) await f.reopen();
    f.deliverReceipt(primary, at);
    await f.tick(3);
    const producer = await occurrence(f, primary, at);
    const consumer = await occurrence(f, follower, at);
    noAttempt(await f.read(consumer), 'analyze');
    const data = await f.submitFile(producer, 'collect', 0, JSON.stringify({ clicks: 100 + index }));
    await f.settle(producer, 'collect');
    await f.tick(3);
    assertPromptArtifact(await f.prompt(consumer, 'analyze'), data);
    await f.settle(consumer, 'analyze');
    await f.tick(2);
    assert.equal((await f.read(consumer)).status, 'delivered');
  }

  await f.dashboardAction({ action: 'series-pause', seriesId: follower.id });
  assert.equal((await f.readSeries(follower.id)).status, 'paused');
  assert.equal((await f.readSeries(primary.id)).status, 'active');
  assert.deepEqual(f.scheduleEdits, [], 'pausing the follower must leave the host timer active');
  const next = '2026-11-25T01:30:00.000Z';
  f.deliverReceipt(primary, next);
  await f.tick(3);
  await f.running(await occurrence(f, primary, next), 'collect');
  assert.equal((await f.readSeries(follower.id)).occurrences.length, instants.length);
  assert.equal(f.scheduleCount(), 1);
});
