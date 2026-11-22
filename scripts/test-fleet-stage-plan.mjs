// P-62 orchestration stage plan: each node declares its stage goal/tasks/expected outcomes and the
// tools, plugins and skills it will use, each with a purpose. Covers model validation, projection,
// node-panel and gate-panel rendering, dispatch prompts and draft round-trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizePlan, validatePlan, projectTicket, stagePlanView } from '../packages/fleet-shell/src/fleet-model.js';
import { createFleetViews } from '../packages/fleet-shell/src/fleet-ui.js';
import { FleetService } from '../packages/fleet-shell/src/fleet-service.js';

const views = createFleetViews(React);
const html = node => renderToStaticMarkup(node);

const stagePlan = {
  goal: '让接收者能按说明阅读演示，并找到对应的提案小节。',
  tasks: ['整理演示的阅读顺序', '为关键段落标注提案小节并核对引用'],
  outcomes: [{ kind: 'deliverable', deliverableIndex: 0 }, { kind: 'event', text: '引用核对结论已记录' }]
};
const capabilities = [
  { kind: 'tool', id: 'read', purpose: '阅读演示材料和提案，核对小节对应关系。' },
  { kind: 'plugin', id: 'tabro', name: 'Tabro', purpose: '打开页面并核对交付结果。', tools: ['tabro.navigate'] },
  { kind: 'skill', id: 'office-docx', name: 'Office DOCX', purpose: '生成和检查 Word 文件。' }
];
const planDoc = (nodeTask = {}) => normalizePlan({
  goal: 'Deliver the demo reading guide',
  deliverables: [{ text: 'docs/demo-reading.md: reading order and proposal index', title: '演示阅读说明', category: 'noncode' }],
  agents: { writer: { name: '说明撰写员', profile: { instructions: 'write' } }, rev: { name: '审阅员', profile: { instructions: 'review' } } },
  nodes: [{ id: 'notes', agentId: 'writer', dependsOn: [], task: { prompt: 'Write the demo reading guide', summary: '我会写出演示阅读说明', stagePlan, plannedCapabilities: capabilities, ...nodeTask } }],
  gates: []
});
const ticket = (id, plan, overrides = {}) => ({ id, workspaceId: 'w1', originSessionId: 's1', revision: 1, status: 'running', plan, execution: null, activity: [], updatedAt: '2026-11-20T00:00:00.000Z', ...overrides });
const options = (tickets, ui = {}) => ({
  workspace: { workspaceId: 'w1', path: 'G:/fixture' }, enabled: true, language: 'zh', mode: { error: null }, busy: false,
  data: { ready: true, tickets, health: { ready: true }, pluginVersion: '0.9.3', catalog: null },
  ui: { page: 'overview', ...ui }, navigate() {}, openDialog() {}, setUI() {}, refresh() {}, toControl() {}, returnToConversation() {},
  t: k => k, members: [], sessionMap: {}, openChat() {}, creatingTicket: false, recreateDraft: async () => {},
  drafts: {}, writeDraft() {}, sendMessage: async () => {}, act: async () => ({}),
});

// ---------- model: shape, validation, view ----------
test('stagePlan and plannedCapabilities accept the declared shape and stay optional for legacy plans', () => {
  const plan = planDoc();
  assert.deepEqual(plan.nodes[0].task.stagePlan, stagePlan);
  assert.deepEqual(plan.nodes[0].task.plannedCapabilities, capabilities);
  assert.equal(validatePlan(plan, { mode: 'start' }).valid, true);
  const legacy = normalizePlan({ goal: 'g', agents: { w: { profile: {} } }, nodes: [{ id: 'n', agentId: 'w', dependsOn: [], task: { prompt: 'p' } }], gates: [] });
  assert.equal(validatePlan(legacy, { mode: 'start' }).valid, true, 'legacy nodes need no stage plan');
  const empty = planDoc({ stagePlan: { goal: '审核已记录', outcomes: [] }, plannedCapabilities: [] });
  assert.equal(validatePlan(empty, { mode: 'start' }).valid, true, 'an explicit empty capability list is valid');
});

test('hostile or incomplete stage-plan shapes are rejected without guessing', () => {
  const bad = mutate => { const plan = planDoc(); mutate(plan.nodes[0].task); return validatePlan(plan, { mode: 'save' }).valid; };
  for (const mutate of [
    task => { task.stagePlan = 'text'; },
    task => { task.stagePlan = { goal: '  ' }; },
    task => { task.stagePlan = { goal: 'g', surprise: 1 }; },
    task => { task.stagePlan = { tasks: ['ok', 2] }; },
    task => { task.stagePlan = { tasks: ['  '] }; },
    task => { task.stagePlan = { outcomes: [{ kind: 'note', text: 'x' }] }; },
    task => { task.stagePlan = { outcomes: [{ kind: 'event' }] }; },
    task => { task.stagePlan = { outcomes: [{ kind: 'deliverable' }] }; },
    task => { task.stagePlan = { outcomes: [{ kind: 'deliverable', deliverableIndex: -1 }] }; },
    task => { task.stagePlan = { outcomes: [{ kind: 'deliverable', deliverableIndex: 1.5, text: 'x' }] }; },
    task => { task.stagePlan = { outcomes: [{ kind: 'deliverable', text: 'x', extra: true }] }; },
    task => { task.plannedCapabilities = 'read'; },
    task => { task.plannedCapabilities = [{ kind: 'mcp', id: 'x', purpose: 'y' }]; },
    task => { task.plannedCapabilities = [{ kind: 'tool', id: 'read' }]; },
    task => { task.plannedCapabilities = [{ kind: 'tool', purpose: 'y' }]; },
    task => { task.plannedCapabilities = [{ kind: 'tool', id: 'read', purpose: 'y', extra: 1 }]; },
    task => { task.plannedCapabilities = [{ kind: 'tool', id: 'read', purpose: 'y', tools: [2] }]; },
    task => { task.plannedCapabilities = [{ kind: 'tool', id: 'read', purpose: 'y', name: '' }]; },
  ]) assert.equal(bad(mutate), false, mutate.toString());
});

test('stagePlanView keeps missing declarations distinct from explicit empty ones', () => {
  assert.deepEqual(stagePlanView(undefined), { stage: null, capabilities: null, declared: false });
  assert.deepEqual(stagePlanView({}), { stage: null, capabilities: null, declared: false });
  const empty = stagePlanView({ stagePlan: {}, plannedCapabilities: [] });
  assert.equal(empty.declared, true);
  assert.deepEqual(empty.stage, { goal: '', tasks: [], outcomes: [] });
  assert.deepEqual(empty.capabilities, []);
  const view = stagePlanView({ stagePlan, plannedCapabilities: capabilities });
  assert.equal(view.stage.outcomes[0].kind, 'deliverable');
  assert.equal(view.stage.outcomes[1].kind, 'event');
  assert.equal(view.capabilities[1].name, 'Tabro');
  assert.deepEqual(view.capabilities[1].tools, ['tabro.navigate']);
});

test('projections and frozen revisions carry the stage plan without mutating the source plan', () => {
  const plan = planDoc();
  const before = structuredClone(plan);
  const t = ticket('p1', plan, { execution: { currentConfigRevision: 1, configurations: { 1: { plan, sourceRefs: [] } }, nodes: {}, gates: {}, artifacts: {}, deliverables: {}, delivery: { history: [], override: null } } });
  const projected = projectTicket(t);
  assert.deepEqual(projected.nodes[0].task.stagePlan, stagePlan);
  assert.deepEqual(projected.nodes[0].task.plannedCapabilities, capabilities);
  assert.deepEqual(plan, before, 'projection is a detached read model');
});

// ---------- UI: node panel, gate panel, compact chips ----------
test('node panel shows stage plan then planned use, with outcomes bound to deliverables', () => {
  const t = ticket('u1', planDoc());
  const m = html(views.renderDashboard(options([t], { page: 'ticket', ticketId: 'u1', nodeId: 'notes' })));
  const panel = m.slice(m.indexOf('data-fleet-node-plan="notes"'));
  const goalAt = panel.indexOf(stagePlan.goal), tasksAt = panel.indexOf('整理演示的阅读顺序'), outcomeAt = panel.indexOf('演示阅读说明'), capsAt = panel.indexOf('计划使用');
  assert.match(m, /data-fleet-thread="notes"[\s\S]*data-fleet-stage-plan="notes"/);
  assert.ok(goalAt > 0 && tasksAt > goalAt && outcomeAt > tasksAt && capsAt > outcomeAt, 'goal → tasks → outcomes → planned use');
  assert.match(m, /data-fleet-outcome-kind="deliverable"/);
  assert.match(m, /data-fleet-outcome-kind="event"/);
  assert.ok(m.includes('引用核对结论已记录'));
  for (const value of ['read', '阅读演示材料和提案，核对小节对应关系。', 'Tabro', 'tabro.navigate', 'Office DOCX', '工具', '插件', '技能']) assert.ok(m.includes(value), value);
  assert.match(m, /data-fleet-capability-kind="plugin"/);
  assert.match(m, /data-fleet-node-capabilities=""/, 'flow card carries compact chips');
  assert.match(m, /data-fleet-capability-group="skill"[\s\S]*Office DOCX/, 'skills have their own group');
  assert.match(panel, /<h4 class="fl-plan-group-title">技能<span class="fl-muted"> 1<\/span><\/h4><ul[^>]*><li data-fleet-capability-kind="skill">Office DOCX<\/li>/);
  assert.match(panel, /<h4 class="fl-plan-group-title">工具<span class="fl-muted"> 1<\/span><\/h4><ul[^>]*><li data-fleet-capability-kind="tool">read<\/li>/);
  const disclosure = panel.indexOf('data-fleet-capability-details="notes"');
  assert.ok(disclosure > 0);
  assert.match(panel, /<details class="fl-plan-use-details" data-fleet-capability-details="notes">/);
  assert.doesNotMatch(panel.slice(0, disclosure), /fl-plan-cap-head|生成和检查 Word 文件|按需加载/);
  assert.match(panel.slice(disclosure), /按需加载[\s\S]*生成和检查 Word 文件/);
  assert.match(m, /data-fleet-chip-kind="skill"/, 'skill chips are distinguishable');
});

test('the Skills group is always visible, even when no skill is planned', () => {
  const toolsOnly = ticket('u6', planDoc({
    stagePlan: { goal: '只读核对', tasks: ['核对'], outcomes: [{ kind: 'event', text: '核对完成' }] },
    plannedCapabilities: [{ kind: 'tool', id: 'read', purpose: '读取材料' }]
  }));
  const m = html(views.renderDashboard(options([toolsOnly], { page: 'ticket', ticketId: 'u6', nodeId: 'notes' })));
  assert.match(m, /data-fleet-capability-group="skill"[\s\S]*data-fleet-capability-empty="skill">无/);
  assert.match(m, /data-fleet-capability-group="skill"><h4 class="fl-plan-group-title">技能<span class="fl-muted"> 0<\/span><\/h4>/);
  assert.ok(!m.includes('按需加载'), 'no on-demand badge without a planned skill');
});

test('explicit empty declarations read as "no specific capability"; missing ones invite completion', () => {
  const empty = ticket('u2', planDoc({ stagePlan: { goal: '只做审核结论', outcomes: [{ kind: 'event', text: '审核结论已记录' }] }, plannedCapabilities: [] }));
  const m1 = html(views.renderDashboard(options([empty], { page: 'ticket', ticketId: 'u2', nodeId: 'notes' })));
  assert.doesNotMatch(m1, /data-fleet-capability-details/);
  assert.ok(!m1.includes('尚未填写阶段计划'));
  for (const kind of ['tool', 'plugin', 'skill']) assert.match(m1, new RegExp(`data-fleet-capability-group="${kind}"[\\s\\S]*data-fleet-capability-empty="${kind}">无`));
  const missing = ticket('u3', planDoc({ stagePlan: undefined, plannedCapabilities: undefined }));
  const m2 = html(views.renderDashboard(options([missing], { page: 'ticket', ticketId: 'u3', nodeId: 'notes' })));
  assert.ok(m2.includes('尚未填写阶段计划'));
  assert.ok(m2.includes('尚未声明将要使用的 Tool／Plugin／Skill'));
});

test('a historical attempt without recorded fields says so instead of showing the current plan', () => {
  const oldPlan = planDoc({ stagePlan: undefined, plannedCapabilities: undefined });
  const t = ticket('u4', oldPlan, {
    status: 'stopped',
    execution: {
      currentConfigRevision: 1, configurations: { 1: { plan: oldPlan, sourceRefs: [] } },
      nodes: { notes: { status: 'completed', attempts: [{ id: 'at1', configRevision: 1, status: 'completed', thread: [] }], thread: [] } },
      gates: {}, artifacts: {}, deliverables: {}, delivery: { history: [], override: null }
    }
  });
  const m = html(views.renderDashboard(options([t], { page: 'ticket', ticketId: 'u4', nodeId: 'notes' })));
  assert.ok(m.includes('此轮冻结配置未记录阶段计划。'));
  assert.ok(m.includes('此轮冻结配置未记录 Tool／Plugin／Skill 声明。'));
});

test('Agent Gate shows its review model in the node header and review details in the body', () => {
  const plan = normalizePlan({
    goal: 'g', deliverables: [], agents: { writer: { profile: { instructions: 'write' } }, rev: { profile: { instructions: 'review' } } },
    nodes: [
      { id: 'write', agentId: 'writer', dependsOn: [], task: { prompt: 'write', stagePlan: { goal: '产出草稿', tasks: ['写'], outcomes: [{ kind: 'event', text: '草稿完成' }] }, plannedCapabilities: [] } },
      { id: 'rev', agentId: 'rev', dependsOn: ['write'], task: { prompt: 'review', stagePlan: { goal: '核对验收标准并给出结论', outcomes: [{ kind: 'event', text: '审核结论已记录' }] }, plannedCapabilities: [{ kind: 'tool', id: 'read', purpose: '阅读上游产物' }] } }
    ],
    gates: [
      { id: 'quality', from: ['write'], to: [], reviewer: { kind: 'agent', nodeId: 'rev' }, reviewTask: { summary: '审核报告引用', inputs: ['报告草稿'], checks: ['逐项复核引用'] }, modelSelection: { provider: 'fixture', model: 'quality-model' }, plannedCapabilities: [{ kind: 'skill', id: 'citation', purpose: '核对引用页码' }] },
      { id: 'scope', from: ['write'], to: [], reviewer: { kind: 'agent', nodeId: 'rev' }, rework: { maxRounds: 2, scopeNote: '核对报告范围' } },
      { id: 'confirm', from: ['write'], to: [], reviewer: { kind: 'human' } }
    ]
  });
  const t = ticket('u5', plan, { execution: { currentConfigRevision: 1, configurations: { 1: { plan, sourceRefs: [] } }, nodes: { write: { status: 'completed', attempts: [], thread: [] } }, gates: { quality: { status: 'pending', reviews: [], history: [] } }, artifacts: {}, deliverables: {}, delivery: { history: [], override: null } } });
  const m = html(views.renderDashboard(options([t], { page: 'ticket', ticketId: 'u5', gateTicketId: 'u5', gateId: 'quality' })));
  assert.match(m, /data-fleet-gate-inspector="quality"[\s\S]*data-fleet-gate-plan="quality"/);
  const panel=m.slice(m.indexOf('data-fleet-gate-inspector="quality"'));
  assert.deepEqual([...panel.matchAll(/data-fleet-review-section="([^"]+)"/g)].map(match=>match[1]),['inputs','checks','dependencies']);
  for(const content of ['审核报告引用','报告草稿','逐项复核引用','quality-model','核对引用页码'])assert.ok(panel.includes(content),content);
  assert.doesNotMatch(panel,/核对报告范围|审核结论已记录|阅读上游产物/);
  const inspectGate=gateId=>html(views.renderDashboard(options([t],{page:'ticket',ticketId:'u5',gateTicketId:'u5',gateId})));
  const scope=inspectGate('scope');
  assert.match(scope,/继承审核节点 rev/);
  assert.match(scope,/核对报告范围/);
  assert.match(scope,/阅读上游产物/);
  assert.doesNotMatch(scope,/逐项复核引用/);
  const human=inspectGate('confirm');
  assert.match(human,/data-fleet-gate-inspector="confirm"/);
  assert.doesNotMatch(human,/data-fleet-review-section/);
  const legacy=ticket('u5-old',{...plan,contractVersion:2},{status:'draft'});
  const old=html(views.renderDashboard(options([legacy],{page:'ticket',ticketId:legacy.id})));
  assert.match(old,/此草稿不兼容[\s\S]+核对报告范围/);
  assert.doesNotMatch(old,/data-fleet-edit-review/);
});

// ---------- Service: dispatch prompts + draft round-trip ----------
async function serviceFixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-stage-plan-'));
  const rootPath = path.join(temp, 'root'), wsDir = path.join(temp, 'w');
  await fs.mkdir(wsDir, { recursive: true });
  const calls = { create: [], submit: [] }, sessions = new Map();
  const adapter = {
    async create(r) { calls.create.push(structuredClone(r)); const id = `s-${sessions.size + 1}`; sessions.set(id, { status: 'unknown' }); return { sessionId: id }; },
    async submit(r) { calls.submit.push(structuredClone(r)); sessions.set(r.sessionId, { status: 'running' }); return { messageId: r.requestId }; },
    async inspect(r) { return structuredClone(sessions.get(r.sessionId) ?? { status: 'unknown' }); },
    async cancel() { return { stopped: true }; },
    async message(r) { return { messageId: r.requestId }; },
    async recover() {}
  };
  const service = await FleetService.open({ rootPath, workspacePaths: { w: wsDir }, adapter, autoStart: false });
  t.after(async () => { await service.close(); const target = path.resolve(temp); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('fleet-stage-plan-')); await fs.rm(target, { recursive: true, force: true }); });
  return { service, calls, sessions };
}

test('draft save round-trips stagePlan and plannedCapabilities unchanged', async t => {
  const f = await serviceFixture(t);
  const plan = planDoc();
  await f.service.saveDraftTicket('w', { id: 'd1', sessionId: 'origin', plan });
  const saved = await f.service.read('w', 'd1');
  assert.deepEqual(saved.plan.nodes[0].task.stagePlan, stagePlan);
  assert.deepEqual(saved.plan.nodes[0].task.plannedCapabilities, capabilities);
});

test('node dispatch and agent review prompts carry the stage plan and planned use', async t => {
  const plan = normalizePlan({
    goal: 'g', deliverables: [], agents: { writer: { profile: { instructions: 'write' } }, rev: { profile: { instructions: 'review' } } },
    nodes: [
      { id: 'write', agentId: 'writer', dependsOn: [], task: { prompt: 'write', stagePlan: { goal: '产出草稿并自检', tasks: ['写草稿'], outcomes: [{ kind: 'event', text: '草稿自检通过' }] }, plannedCapabilities: [{ kind: 'skill', id: 'humanizer-zh', purpose: '润色中文草稿' }] } },
      { id: 'rev', agentId: 'rev', dependsOn: ['write'], task: { prompt: 'review', stagePlan: { goal: '按标准核对交付', outcomes: [{ kind: 'event', text: '审核结论已记录' }] }, plannedCapabilities: [{ kind: 'tool', id: 'read', purpose: '阅读上游产物' }] } }
    ],
    gates: [{ id: 'quality', from: ['write'], to: ['rev'], reviewer: { kind: 'agent', nodeId: 'rev' } }]
  });
  const f = await serviceFixture(t);
  await f.service.saveDraftTicket('w', { id: 't', sessionId: 'origin', plan });
  await f.service.human('w', 'human', 'start', ['t']);
  await f.service.tick();
  const writeSession = (await f.service.read('w', 't')).execution.nodes.write.attempts.at(-1).sessionId;
  const nodePrompt = f.calls.submit.find(c => c.sessionId === writeSession).prompt;
  assert.ok(nodePrompt.includes('Stage plan (goal / tasks / expected outcomes)'), 'node prompt names the stage plan');
  assert.ok(nodePrompt.includes('产出草稿并自检'));
  assert.ok(nodePrompt.includes('humanizer-zh') && nodePrompt.includes('润色中文草稿'), 'declared capability and purpose reach the Agent');
  assert.ok(nodePrompt.includes('Follow the stage plan'), 'Agent is told to follow the plan and report unavailable capabilities');
  assert.ok(nodePrompt.includes('Skills are loaded on demand') && nodePrompt.includes('load each declared skill by name'), 'Agent is told how skills load');
  f.sessions.set(writeSession, { status: 'completed', output: 'draft' });
  await f.service.tick();
  const reviewSession = (await f.service.read('w', 't')).execution.gates.quality.dispatch.sessionId;
  const reviewPrompt = f.calls.submit.find(c => c.sessionId === reviewSession).prompt;
  assert.ok(reviewPrompt.includes('Review stage plan'));
  assert.ok(reviewPrompt.includes('按标准核对交付') && reviewPrompt.includes('阅读上游产物'), 'reviewer receives its own declared plan');
});