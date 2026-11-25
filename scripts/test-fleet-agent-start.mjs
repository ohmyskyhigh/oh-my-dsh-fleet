// 0.9.0 P-51/P-52: fleet_start Agent tool, Service.agentStart ownership/audit, editor start buttons.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FleetService } from '../src/fleet-service.js';
import { normalizePlan, projectTicket } from '../src/fleet-model.js';
import { registerFleetChat } from '../src/fleet-chat.js';
import { createFleetViews } from '../src/fleet-ui.js';

const plan = (extra = {}) => normalizePlan({ goal: 'Build and verify', deliverables: [], criteria: ['verify'], agents: { writer: { profile: { instructions: 'write' } } }, nodes: [{ id: 'a', agentId: 'writer', dependsOn: [], task: { prompt: 'a', summary: 'I will build, achieving a verified result' } }], gates: [], ...extra });
function host() {
  const calls = { create: [], submit: [] }, sessions = new Map();
  const adapter = {
    async create(r) { calls.create.push(structuredClone(r)); const sessionId = `s-${sessions.size + 1}`; sessions.set(sessionId, { status: 'unknown' }); return { sessionId }; },
    async submit(r) { calls.submit.push(structuredClone(r)); sessions.set(r.sessionId, { status: 'running' }); return { messageId: r.requestId }; },
    async recover() {}, async inspect(r) { return structuredClone(sessions.get(r.sessionId) ?? { status: 'unknown' }); },
    async cancel() { return { stopped: true }; }, async message(r) { return { messageId: r.requestId }; },
    async modelCatalog() { return { default: { provider: 'host', model: 'default-model' }, routableProviders: ['host', 'p'], groups: [{ id: 'host', name: 'Host', models: [{ id: 'default-model', name: 'Default' }] }, { id: 'p', name: 'P', models: [{ id: 'm', name: 'M', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } }] }], failures: [] }; }
  };
  return { calls, sessions, adapter };
}
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-agent-start-'));
  const h = host();
  const service = await FleetService.open({ rootPath: path.join(temp, 'root'), workspacePaths: { a: path.join(temp, 'a') }, adapter: h.adapter, autoStart: false });
  t.after(async () => { await service.close(); const target = path.resolve(temp); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert(path.basename(target).startsWith('fleet-agent-start-')); await fs.rm(target, { recursive: true, force: true }); });
  return { service, h, temp };
}

test('agentStart executes the user-requested start: running, frozen, actor audited as agent via user-request', async t => {
  const f = await serviceFixtureWith(t);
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: plan() });
  const ticket = await f.service.agentStart('a', 'origin', 't');
  assert.equal(ticket.status, 'running');
  assert.ok(ticket.execution.configurations[ticket.execution.currentConfigRevision]);
  const event = ticket.activity.at(-1);
  assert.equal(event.type, 'ticket-started');
  assert.deepEqual(event.actor, { kind: 'agent', userId: 'origin', via: 'user-request' });
});
async function serviceFixtureWith(t) { return fixture(t); }
test('agentStart refuses Tickets owned by another conversation', async t => {
  const f = await fixture(t);
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: plan() });
  await assert.rejects(f.service.agentStart('a', 'someone-else', 't'), e => e.code === 'session-scope');
  assert.equal((await f.service.read('a', 't')).status, 'draft');
});
test('agentStart refuses running/delivered states with a next-step message', async t => {
  const f = await fixture(t);
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: plan() });
  await f.service.human('a', 'u', 'start', ['t']);
  await assert.rejects(f.service.agentStart('a', 'origin', 't'), e => e.code === 'state-conflict' && /draft or stopped/.test(e.message));
});
test('agentStart resumes a stopped Ticket through the same freeze path', async t => {
  const f = await fixture(t);
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: plan() });
  await f.service.human('a', 'u', 'start', ['t']);
  await f.service.human('a', 'u', 'stop', ['t']);
  await f.service.tick();
  let ticket = await f.service.read('a', 't');
  assert.equal(ticket.status, 'stopped');
  ticket = await f.service.agentStart('a', 'origin', 't');
  assert.equal(ticket.status, 'running');
  const event = ticket.activity.filter(a => a.type === 'ticket-resumed').at(-1);
  assert.equal(event.actor.kind, 'agent'); assert.equal(event.actor.via, 'user-request');
});
test('agentStart runs the same modelCatalog validation before freezing', async t => {
  const f = await fixture(t);
  const p = plan(); p.nodes[0].modelSelection = { provider: 'p', model: 'missing' };
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: p });
  await assert.rejects(f.service.agentStart('a', 'origin', 't'), e => e.code === 'unsupported-profile' && /model catalog/.test(e.message));
  assert.equal((await f.service.read('a', 't')).status, 'draft');
});

// ---- Chat tool surface ----
function chatHarness({ owned = false } = {}) {
  const tools = new Map(), calls = [];
  const service = {
    registerWorkspace: async () => {},
    ownsSession: async () => owned,
    agentStart: async (workspaceId, sessionId, ticketId) => { calls.push(['agentStart', workspaceId, sessionId, ticketId]); return projectTicket({ id: ticketId, workspaceId, originSessionId: sessionId, status: 'running', revision: 3, plan: normalizePlan({ goal: 'g' }), execution: null, activity: [] }); },
    agentStop: async (workspaceId, sessionId, ticketId) => { calls.push(['agentStop', workspaceId, sessionId, ticketId]); return projectTicket({ id: ticketId, workspaceId, originSessionId: sessionId, status: 'running', revision: 3, plan: normalizePlan({ goal: 'g' }), execution: null, activity: [] }); },
    agentRetryNode: async (workspaceId, sessionId, ticketId, nodeId, reason) => { calls.push(['agentRetryNode', workspaceId, sessionId, ticketId, nodeId, reason]); return projectTicket({ id: ticketId, workspaceId, originSessionId: sessionId, status: 'running', revision: 4, plan: normalizePlan({ goal: 'g' }), execution: null, activity: [] }); },
    catalog: async () => ({ agents: [], orchestrations: [], workspaces: [] })
  };
  const ctx = { tools: { register: d => { tools.set(d.name, d); return () => tools.delete(d.name); } }, commands: { register: () => () => {} } };
  registerFleetChat(ctx, { defineTool: d => d, getService: async () => service, resolveAgentContext: async () => ({ workspaceId: 'w', workspacePath: 'G:/w', sessionId: 's-1' }), createUserMessage: v => v });
  return { tools, calls, service };
}
test('fleet_start tool is registered with an explicit-request contract and session-scoped execution', async () => {
  const h = chatHarness();
  const definition = h.tools.get('fleet_start');
  assert.ok(definition);
  assert.equal(definition.parameters.ticketId.required, true);
  assert.match(definition.description, /ONLY call when the user clearly asked/);
  assert.match(definition.description, /never for a Ticket owned by another conversation/);
  const result = await definition.execute({ ticketId: 't' }, { agent: { id: 'any' } });
  assert.deepEqual(h.calls, [['agentStart', 'w', 's-1', 't']]);
  assert.equal(JSON.parse(result.text).status, 'running');
});
test('fleet_start refuses execution Sessions through the planning-context guard', async () => {
  const h = chatHarness({ owned: true });
  const definition = h.tools.get('fleet_start');
  await assert.rejects(definition.execute({ ticketId: 't' }, { agent: { id: 'exec' } }), /Execution Sessions/);
  assert.deepEqual(h.calls, []);
});

test('agentStop stops a running Ticket as the Agent acting via user-request and cancels pending nodes', async t => {
  const f = await fixture(t);
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: plan() });
  await f.service.human('a', 'u', 'start', ['t']);
  const stopped = await f.service.agentStop('a', 'origin', 't');
  assert.ok(['stop-requested', 'stopped'].includes(stopped.status), 'stop takes effect immediately when nothing is in flight');
  const event = stopped.activity.filter(a => a.type === 'stop-requested').at(-1);
  assert.deepEqual(event.actor, { kind: 'agent', userId: 'origin', via: 'user-request' });
  const again = await f.service.agentStop('a', 'origin', 't');
  assert.ok(['stop-requested', 'stopped'].includes(again.status), 'repeated stop is idempotent');
});
test('agentStop refuses non-running Tickets and unknown IDs with a next-step message', async t => {
  const f = await fixture(t);
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: plan() });
  await assert.rejects(f.service.agentStop('a', 'origin', 't'), e => e.code === 'not-running');
  await assert.rejects(f.service.agentStop('a', 'origin', 'missing'), e => e.code === 'unknown-ticket');
});
test('fleet_stop tool is registered, delegates to agentStop and refuses execution Sessions', async t => {
  const h = chatHarness();
  const definition = h.tools.get('fleet_stop');
  assert.ok(definition);
  assert.equal(definition.parameters.ticketId.required, true);
  assert.match(definition.description, /ONLY call when the user explicitly asked to stop/);
  const result = await definition.execute({ ticketId: 't' }, { agent: { id: 'any' } });
  assert.deepEqual(h.calls, [['agentStop', 'w', 's-1', 't']]);
  assert.equal(JSON.parse(result.text).status, 'running');
  const owned = chatHarness({ owned: true });
  await assert.rejects(owned.tools.get('fleet_stop').execute({ ticketId: 't' }, { agent: { id: 'exec' } }), /Execution Sessions/);
  assert.deepEqual(owned.calls, []);
});

// ---- P-78: Agent node retry (any Ticket in this Workspace, explicit user request) ----
test('agentRetryNode retries a node of any Workspace Ticket via user-request through the same closure as human retry', async t => {
  const f = await fixture(t);
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: plan() });
  await f.service.human('a', 'u', 'start', ['t']);
  await f.service.tick();
  const first = (await f.service.read('a', 't')).execution.nodes.a.attempts.at(-1);
  f.h.sessions.set(first.sessionId, { status: 'completed', output: 'v1' });
  await f.service.tick();
  assert.equal((await f.service.read('a', 't')).status, 'delivered');
  // a different conversation in the same Workspace executes the user's retry decision (no originSessionId requirement)
  const ticket = await f.service.agentRetryNode('a', 'another-session', 't', 'a', 'user asked to redo the verification');
  assert.equal(ticket.status, 'running');
  const event = ticket.activity.filter(x => x.type === 'node-retry-requested').at(-1);
  assert.deepEqual(event.actor, { kind: 'agent', userId: 'another-session', via: 'user-request' });
  const row = ticket.execution.nodes.a.thread.filter(r => r.intent === 'retry').at(-1);
  assert.equal(row.text, 'user asked to redo the verification');
  assert.deepEqual(row.actor, { kind: 'agent', userId: 'another-session', via: 'user-request' });
  const createsBefore = f.h.calls.create.length;
  await f.service.tick();
  const after = await f.service.read('a', 't');
  assert.equal(after.execution.nodes.a.attempts.length, 2, 'retry opens a new Attempt cycle');
  // parity with the human retry path: a manual retry dispatches a fresh Session (P-75 reuse is Gate-rework only)
  assert.equal(f.h.calls.create.length, createsBefore + 1, 'retry dispatches a new Session in the same tick');
  assert.notEqual(after.execution.nodes.a.attempts.at(-1).sessionId, first.sessionId);
});
test('agentRetryNode refuses invalid states, unknown nodes/Tickets and empty reasons', async t => {
  const f = await fixture(t);
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: plan() });
  // parity with human retryNode: the node pre-check runs before the Ticket-state guard, and a draft has no execution nodes
  await assert.rejects(f.service.agentRetryNode('a', 'origin', 't', 'a', 'why'), e => e.code === 'unknown-node', 'draft Ticket has no retryable execution node');
  await assert.rejects(f.service.agentRetryNode('a', 'origin', 'missing', 'a', 'why'), e => e.code === 'unknown-ticket');
  await f.service.human('a', 'u', 'start', ['t']);
  await f.service.tick();
  await assert.rejects(f.service.agentRetryNode('a', 'origin', 't', 'a', 'why'), e => e.code === 'state-conflict', 'a running node is not retryable');
  await assert.rejects(f.service.agentRetryNode('a', 'origin', 't', 'nope', 'why'), e => e.code === 'unknown-node');
  await f.service.human('a', 'u', 'stop', ['t']);
  await f.service.tick();
  await assert.rejects(f.service.agentRetryNode('a', 'origin', 't', 'a', '   '), e => e.code === 'invalid-input', 'a retry requires a nonempty reason');
});
test('agentRetryNode validates modelSelection against the host catalog like the human retry path', async t => {
  const f = await fixture(t);
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: plan() });
  await f.service.human('a', 'u', 'start', ['t']);
  await f.service.human('a', 'u', 'stop', ['t']);
  await f.service.tick();
  const current = await f.service.read('a', 't');
  const bad = plan(); bad.nodes[0].modelSelection = { provider: 'p', model: 'missing' };
  await f.service.saveDraftTicket('a', { ticketId: 't', expectedRevision: current.revision, plan: bad });
  await assert.rejects(f.service.agentRetryNode('a', 'origin', 't', 'a', 'why'), e => e.code === 'unsupported-profile' && /model catalog/.test(e.message));
});
test('fleet_retry tool is registered, delegates to agentRetryNode and refuses execution Sessions', async () => {
  const h = chatHarness();
  const definition = h.tools.get('fleet_retry');
  assert.ok(definition);
  assert.equal(definition.parameters.ticketId.required, true);
  assert.equal(definition.parameters.nodeId.required, true);
  assert.equal(definition.parameters.reason.required, true);
  assert.match(definition.description, /ONLY call when the user clearly asked to retry/);
  assert.match(definition.description, /ask the user first and proceed only on their direct consent/);
  const result = await definition.execute({ ticketId: 't', nodeId: 'a', reason: 'redo' }, { agent: { id: 'any' } });
  assert.deepEqual(h.calls, [['agentRetryNode', 'w', 's-1', 't', 'a', 'redo']]);
  assert.equal(JSON.parse(result.text).status, 'running');
  const owned = chatHarness({ owned: true });
  await assert.rejects(owned.tools.get('fleet_retry').execute({ ticketId: 't', nodeId: 'a', reason: 'redo' }, { agent: { id: 'exec' } }), /Execution Sessions/);
  assert.deepEqual(owned.calls, []);
});

// ---- Editor start button rendering (static markup) ----
const views = createFleetViews(React);
const noop = () => {};
const editorOptions = (draft, extra = {}) => ({ draft, language: 'zh', t: key => key, workspace: { workspaceId: 'w', path: 'G:/w' }, catalog: { modelCatalog: { default: null, groups: [], failures: [] } }, data: { tickets: [draft] }, onSave: async () => draft, onReload: noop, onDirtyChange: noop, ...extra });
test('draft editor exposes the start button for valid drafts and resume for stopped', () => {
  const draft = { id: 'start-ui-valid', workspaceId: 'w', originSessionId: 's-ui', status: 'draft', revision: 1, plan: normalizePlan({ goal: 'g', agents: { w: { profile: { instructions: 'i' } } }, nodes: [{ id: 'n', agentId: 'w', dependsOn: [], task: { prompt: 'p' } }] }), execution: null, activity: [] };
  const html = renderToStaticMarkup(views.renderDraftEditor(editorOptions(draft, { onStart: noop })));
  assert.match(html, /data-fleet-draft-start/); assert.match(html, /启动/);
  const stopped = { ...draft, id: 'start-ui-stopped', status: 'stopped' };
  assert.match(renderToStaticMarkup(views.renderDraftEditor(editorOptions(stopped, { onStart: noop }))), /恢复运行/);
});
test('start button is disabled with diagnostics when start validation fails, and absent without onStart', () => {
  const incomplete = { id: 'start-ui-incomplete', workspaceId: 'w', originSessionId: 's-ui2', status: 'draft', revision: 1, plan: normalizePlan({ goal: 'g', nodes: [{ id: 'n', agentId: null, dependsOn: [], task: { prompt: '' } }] }), execution: null, activity: [] };
  const html = renderToStaticMarkup(views.renderDraftEditor(editorOptions(incomplete, { onStart: noop })));
  assert.match(html, /data-fleet-draft-start/);
  assert.match(html, /disabled[^>]*data-fleet-draft-start|data-fleet-draft-start[^>]*disabled/);
  assert.match(html, /data-fleet-start-diagnostics/); assert.match(html, /启动校验未通过/);
  const valid = { id: 'start-ui-noaction', workspaceId: 'w', originSessionId: 's-ui3', status: 'draft', revision: 1, plan: normalizePlan({ goal: 'g', agents: { w: { profile: { instructions: 'i' } } }, nodes: [{ id: 'n', agentId: 'w', dependsOn: [], task: { prompt: 'p' } }] }), execution: null, activity: [] };
  assert.equal(renderToStaticMarkup(views.renderDraftEditor(editorOptions(valid))).includes('data-fleet-draft-start'), false, 'no onStart callback means no start surface');
});
