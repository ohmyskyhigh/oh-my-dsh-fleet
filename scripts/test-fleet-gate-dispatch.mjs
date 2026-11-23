import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { effectiveGateModelSelection, normalizePlan, projectTicket } from '../src/fleet-model.js';
import { FleetService } from '../src/fleet-service.js';

const titleModel = { provider: 'p', model: 'title-model', reasoningEffort: 'high' };
const outlineModel = { provider: 'p', model: 'outline-model', reasoningEffort: 'low' };
const sharedModel = { provider: 'p', model: 'shared-model' };
const titleCapabilities = [{ kind: 'skill', id: 'title-review', purpose: 'Check the title against the brief.' }];
const sharedCapabilities = [{ kind: 'tool', id: 'read', purpose: 'Read the shared QA checklist.' }];
const reviewTask = { summary: 'Check title claims', inputs: ['Approved brief'], checks: ['Claims have evidence'] };
const gate = (id, overrides = {}) => ({ id, from: ['write'], to: ['qa'], reviewer: { kind: 'agent', nodeId: 'qa' }, ...overrides });
const planWith = gates => normalizePlan({
  goal: 'Review editorial drafts',
  agents: { writer: { profile: {} }, reviewer: { profile: { instructions: 'Review with care.' } } },
  nodes: [
    { id: 'write', agentId: 'writer', task: { prompt: 'Write the draft.' } },
    { id: 'qa', agentId: 'reviewer', modelSelection: sharedModel, task: { prompt: 'Run shared QA.', stagePlan: { goal: 'General QA' }, plannedCapabilities: sharedCapabilities } }
  ],
  gates
});

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-gate-dispatch-'));
  const workspace = path.join(temp, 'workspace');
  await fs.mkdir(workspace);
  const creates = new Map(), prompts = new Map(), results = new Map();
  const catalog = { groups: [{ id: 'p', models: [
    { id: 'title-model', reasoning: { efforts: [{ id: 'high' }] } },
    { id: 'outline-model', reasoning: { efforts: [{ id: 'low' }] } },
    { id: 'shared-model' }
  ] }] };
  const occurrenceAt = '2026-11-01T00:00:00.000Z';
  const schedule = { id: 'schedule', status: 'active', scheduledAt: occurrenceAt, target: { sessionId: 'scheduled' } };
  const service = await FleetService.open({
    rootPath: path.join(temp, 'root'), workspacePaths: { w: workspace }, autoStart: false, maxParallel: 3,
    adapter: {
      async create(request) { const id = `session-${creates.size + 1}`; creates.set(id, request); return { sessionId: id }; },
      async submit({ sessionId, prompt }) { prompts.set(sessionId, prompt); results.set(sessionId, { status: 'running' }); },
      async inspect({ sessionId }) { return results.get(sessionId); },
      async cancel() { return { stopped: true }; },
      async message() {},
      async modelCatalog() { return catalog; },
      async scheduleCreate() { return schedule; },
      async scheduleView() { return schedule; },
      async scheduleEdit({ patch }) { schedule.status = patch.active ? 'active' : 'paused'; return schedule; }
    }
  });
  t.after(async () => {
    await service.close();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.match(path.basename(temp), /^fleet-gate-dispatch-/);
    assert.equal((await fs.lstat(temp)).isSymbolicLink(), false);
    await fs.rm(temp, { recursive: true, force: true });
  });
  return { service, workspace, creates, prompts, results, catalog, schedule, occurrenceAt };
}

test('Gate plan fields validate at save and the model uses the Gate, node, Agent, or host selection', () => {
  for (const invalid of [
    { reviewTask: { summary: '  ' } },
    { reviewTask: { inputs: [2] } },
    { reviewTask: { checks: [''] } },
    { reviewTask: { prompt: 'unexpected' } },
    { modelSelection: { ...titleModel, reasoningEffort: 1 } },
    { plannedCapabilities: [{ kind: 'skill', id: 'missing-purpose' }] },
    { reviewer: { kind: 'human' }, reviewTask }
  ]) assert.throws(() => planWith([gate('invalid', invalid)]));
  const node = { modelSelection: sharedModel };
  const agent = { profile: { modelSelection: outlineModel } };
  assert.deepEqual(effectiveGateModelSelection({ modelSelection: titleModel }, node, agent), { selection: titleModel, source: 'gate' });
  assert.deepEqual(effectiveGateModelSelection({}, node, agent), { selection: sharedModel, source: 'node' });
  assert.deepEqual(effectiveGateModelSelection({}, {}, agent), { selection: outlineModel, source: 'agent' });
  assert.deepEqual(effectiveGateModelSelection({}, {}, {}), { selection: null, source: 'default' });
});

test('shared reviewers run each frozen Gate with its own task, artifact input, model effort, and capabilities', async t => {
  const f = await fixture(t);
  const gates = [
    gate('title', { reviewTask, modelSelection: titleModel, plannedCapabilities: titleCapabilities }),
    gate('outline', { reviewTask: { checks: ['One argument per section'] }, modelSelection: outlineModel, plannedCapabilities: [] }),
    gate('inherited', { rework: { maxRounds: 1, scopeNote: 'Verify the approved format.' } })
  ];
  const plan = planWith(gates);
  await f.service.saveDraftTicket('w', { id: 't', sessionId: 'origin', plan });
  const saved = await f.service.read('w', 't');
  assert.deepEqual(saved.plan.gates, gates);
  await f.service.human('w', 'human', 'start', ['t']);
  await f.service.tick();
  const started = await f.service.read('w', 't');
  assert.deepEqual(started.execution.configurations[started.execution.currentConfigRevision].plan.gates, gates);
  assert.deepEqual(projectTicket(started).gates[0].reviewTask, reviewTask);
  const writeSession = started.execution.nodes.write.attempts.at(-1).sessionId;
  const updated = await f.service.human('w', 'human', 'setPendingNodeModel', ['t', 'qa', outlineModel, started.revision]);
  await fs.writeFile(path.join(f.workspace, 'draft.md'), 'Editorial draft');
  const submitted = await f.service.submitEvidence({ sessionId: writeSession, payload: { artifacts: [{ path: 'draft.md' }], handoff: { brief: 'Approved brief revision 1' } } });
  f.results.set(writeSession, { status: 'completed', output: 'draft submitted' });
  await f.service.tick();
  const running = await f.service.read('w', 't');
  const inspect = (id, model) => {
    const state = running.execution.gates[id];
    const dispatch = state.dispatch;
    assert.equal(state.configRevision, updated.execution.currentConfigRevision);
    assert.deepEqual(f.creates.get(dispatch.sessionId).modelSelection, model);
    assert.deepEqual(dispatch.detail.modelSelection, model);
    return f.prompts.get(dispatch.sessionId);
  };
  const titlePrompt = inspect('title', titleModel);
  assert.match(titlePrompt, /Review task: "Check title claims"/);
  assert.match(titlePrompt, /Review inputs: \["Approved brief"\]/);
  assert.match(titlePrompt, /Review checks: \["Claims have evidence"\]/);
  assert.match(titlePrompt, /"id":"title-review"/);
  assert.match(titlePrompt, /Load each declared skill by its id/);
  assert.ok(titlePrompt.includes(submitted.artifacts[0].sha256));
  assert.match(titlePrompt, /draft\.md/);
  assert.match(titlePrompt, /Approved brief revision 1/);
  assert.doesNotMatch(titlePrompt, /General QA|shared QA checklist|One argument per section/);
  const outlinePrompt = inspect('outline', outlineModel);
  assert.match(outlinePrompt, /Review checks: \["One argument per section"\]/);
  assert.match(outlinePrompt, /Planned use for this review: \[\]/);
  assert.doesNotMatch(outlinePrompt, /title-review|shared QA checklist/);
  const inheritedPrompt = inspect('inherited', outlineModel);
  assert.match(inheritedPrompt, /Review stage plan: \{"goal":"General QA"\}/);
  assert.match(inheritedPrompt, /Gate review scope: "Verify the approved format\."/);
  assert.match(inheritedPrompt, /shared QA checklist/);
  const later = await f.service.human('w', 'human', 'setPendingNodeModel', ['t', 'qa', sharedModel, running.revision]);
  assert.notEqual(later.execution.currentConfigRevision, running.execution.currentConfigRevision);
  const reviewSession = running.execution.gates.inherited.dispatch.sessionId;
  f.results.set(reviewSession, { status: 'completed', output: '{"decision":"passed","evidence":"Matches the approved format"}' });
  await f.service.tick();
  const historical = (await f.service.read('w', 't')).execution.gates.inherited;
  assert.equal(historical.reviews[0].configRevision, updated.execution.currentConfigRevision);
  assert.deepEqual(historical.dispatch.detail.modelSelection, outlineModel);
});

test('Gate override effort must exist in the catalog before a human, Agent, or scheduled start', async t => {
  const f = await fixture(t);
  const modelSelection = { ...titleModel, reasoningEffort: 'low' };
  const badPlan = planWith([gate('title', { modelSelection })]);
  const save = plan => f.service.saveDraftTicket('w', { id: 't', sessionId: 'origin', plan });
  await save(badPlan);
  const unsupported = { code: 'unsupported-profile', message: /reasoningEffort "low"/ };
  await assert.rejects(f.service.human('w', 'human', 'start', ['t']), unsupported);
  await assert.rejects(f.service.agentStart('w', 'origin', 't'), unsupported);
  const enable = () => f.service.seriesCreate('w', {
    name: 'Daily review', sourceTicketId: 't', timing: { kind: 'daily', daily: { time: '09:00', time_zone: 'Asia/Shanghai' } }
  });
  await assert.rejects(enable(), unsupported);
  assert.equal((await f.service.read('w', 't')).status, 'draft');

  const draft = await f.service.read('w', 't');
  await f.service.saveDraftTicket('w', { ticketId: 't', expectedRevision: draft.revision, sessionId: 'origin', plan: planWith([gate('title', { modelSelection: titleModel })]) });
  await enable();
  f.catalog.groups[0].models = f.catalog.groups[0].models.filter(model => model.id !== titleModel.model);
  f.schedule.lastDelivery = { scheduledAt: f.occurrenceAt, deliveredAt: f.occurrenceAt, targetSessionId: 'scheduled' };
  await f.service.tick();
  const [series] = await f.service.readSeries('w');
  assert.equal(series.status, 'paused');
  assert.equal(series.occurrences[0].status, 'failed');
  assert.match(series.occurrences[0].error, /p\/title-model/);
  assert.equal(f.creates.size, 0);
});
