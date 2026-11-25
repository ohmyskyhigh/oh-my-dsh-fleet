// P-77: grantable cross-Workspace Admin — grants, scoped reads, template/plan writes, start/stop, tool surface.
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

const plan = (extra = {}) => normalizePlan({ goal: 'Admin target', deliverables: [], criteria: ['ok'], agents: { writer: { profile: { instructions: 'write' } } }, nodes: [{ id: 'n', agentId: 'writer', dependsOn: [], task: { prompt: 'p' } }], gates: [], ...extra });
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-admin-'));
  const sessions = new Map(), calls = { create: [], submit: [] };
  const adapter = {
    async create(r) { calls.create.push(structuredClone(r)); const id = `s-${sessions.size + 1}`; sessions.set(id, { status: 'unknown' }); return { sessionId: id }; },
    async submit(r) { calls.submit.push(structuredClone(r)); sessions.set(r.sessionId, { status: 'running' }); return { messageId: r.requestId }; },
    async recover() {}, async inspect(r) { return structuredClone(sessions.get(r.sessionId) ?? { status: 'unknown' }); },
    async cancel() { return { stopped: true }; }, async message(r) { return { messageId: r.requestId }; },
    async modelCatalog() { return { default: null, routableProviders: [], groups: [], failures: [] }; }
  };
  const service = await FleetService.open({ rootPath: path.join(temp, 'root'), workspacePaths: { a: path.join(temp, 'a'), b: path.join(temp, 'b') }, adapter, autoStart: false });
  t.after(async () => { await service.close(); const target = path.resolve(temp); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert(path.basename(target).startsWith('fleet-admin-')); await fs.rm(target, { recursive: true, force: true }); });
  return { service, sessions, calls };
}

test('P-77: grants are per Workspace, persist in settings, and revoke immediately', async t => {
  const f = await fixture(t);
  await f.service.saveDraftTicket('b', { id: 't', sessionId: 'origin-b', plan: plan() });
  let status = await f.service.adminStatus('a');
  assert.equal(status.granted, false);
  await assert.rejects(f.service.adminTickets('a'), e => e.code === 'admin-required');
  await f.service.adminGrant('a', 'person', 'all');
  status = await f.service.adminStatus('a');
  assert.equal(status.granted, true);
  assert.deepEqual(status.admin.workspaces.map(e => ({ workspaceId: e.workspaceId, scope: e.scope })), [{ workspaceId: 'a', scope: 'all' }]);
  const tickets = await f.service.adminTickets('a');
  assert.ok(tickets.some(row => row.workspaceId === 'b' && row.tickets.some(x => x.id === 't')));
  await f.service.adminRevoke('a', 'person');
  await assert.rejects(f.service.adminTickets('a'), e => e.code === 'admin-required');
});

test('P-77: a narrowed scope excludes Workspaces outside the list', async t => {
  const f = await fixture(t);
  await f.service.saveDraftTicket('b', { id: 't', sessionId: 'origin-b', plan: plan() });
  await f.service.adminGrant('a', 'person', ['a']);
  const tickets = await f.service.adminTickets('a');
  assert.ok(tickets.every(row => row.workspaceId === 'a'), 'beta is outside the narrowed scope');
  await assert.rejects(f.service.adminTicket('a', 'b', 't'), e => e.code === 'admin-required');
});

test('P-77: Admin agents save templates and another Workspace plan, then start and stop it', async t => {
  const f = await fixture(t);
  await f.service.saveDraftTicket('b', { id: 't', sessionId: 'origin-b', plan: plan() });
  await f.service.adminGrant('a', 'person', 'all');
  // template write through the Admin agent surface (no human template tool involved)
  const saved = await f.service.adminSaveTemplate('a', 'admin-session', { kind: 'agent', id: 'tpl-admin', content: { profile: { instructions: 'admin' } } });
  assert.equal(saved.revision, 1);
  // cross-Workspace plan save with CAS
  const before = await f.service.adminTicket('a', 'b', 't');
  const nextPlan = { ...before.plan, goal: 'Admin edited goal' };
  const updated = await f.service.adminSavePlan('a', 'admin-session', 'b', { ticketId: 't', expectedRevision: before.revision, plan: nextPlan });
  assert.equal(updated.plan.goal, 'Admin edited goal');
  // start and stop the target Ticket from the Admin Workspace
  const started = projectTicket(await f.service.adminStart('a', 'admin-session', 'b', 't'));
  assert.equal(started.status, 'running');
  const stopped = projectTicket(await f.service.adminStop('a', 'admin-session', 'b', 't'));
  assert.ok(['stop-requested', 'stopped'].includes(stopped.status));
});

test('P-78: Admin agents retry a node in another Workspace with adminScope audit; ungranted and out-of-scope are refused', async t => {
  const f = await fixture(t);
  await f.service.saveDraftTicket('b', { id: 't', sessionId: 'origin-b', plan: plan() });
  await assert.rejects(f.service.adminRetryNode('a', 'admin-session', 'b', 't', 'n', 'why'), e => e.code === 'admin-required');
  await f.service.adminGrant('a', 'person', ['a']);
  await assert.rejects(f.service.adminRetryNode('a', 'admin-session', 'b', 't', 'n', 'why'), e => e.code === 'admin-required', 'beta is outside the narrowed scope');
  await f.service.adminGrant('a', 'person', 'all');
  await f.service.adminStart('a', 'admin-session', 'b', 't');
  await f.service.adminStop('a', 'admin-session', 'b', 't');
  const ticket = await f.service.adminRetryNode('a', 'admin-session', 'b', 't', 'n', 'admin requested retry');
  assert.equal(ticket.status, 'running');
  const event = ticket.activity.filter(x => x.type === 'node-retry-requested').at(-1);
  assert.deepEqual(event.actor, { kind: 'agent', userId: 'admin-session', via: 'user-request', adminScope: 'all' });
  const row = ticket.execution.nodes.n.thread.filter(r => r.intent === 'retry').at(-1);
  assert.equal(row.text, 'admin requested retry');
});

test('P-77: fleet_admin tool is registered, delegates, and refuses execution Sessions', async t => {
  const calls = [], tools = new Map();
  const service = {
    registerWorkspace: async () => {}, ownsSession: async () => false,
    adminStatus: async ws => { calls.push(['status', ws]); return { granted: true }; },
    adminTickets: async ws => { calls.push(['tickets', ws]); return []; },
    adminTicket: async (ws, target, id) => { calls.push(['ticket', ws, target, id]); return projectTicket({ id, workspaceId: target, originSessionId: 'x', status: 'draft', revision: 1, plan: normalizePlan({ goal: 'g' }), execution: null, activity: [] }); },
    adminTemplates: async ws => { calls.push(['templates', ws]); return []; },
    adminSaveTemplate: async (ws, sid, input) => { calls.push(['template-save', ws, sid, input]); return { id: input.id, revision: 1 }; },
    adminSavePlan: async (ws, sid, target, input) => { calls.push(['plan-save', ws, sid, target, input]); return projectTicket({ id: input.ticketId, workspaceId: target, originSessionId: 'x', status: 'draft', revision: 2, plan: normalizePlan({ goal: 'g' }), execution: null, activity: [] }); },
    adminStart: async (ws, sid, target, id) => { calls.push(['start', ws, sid, target, id]); return { id, status: 'running', workspaceId: target, originSessionId: 'x', revision: 3, plan: normalizePlan({ goal: 'g' }), execution: null, activity: [] }; },
    adminStop: async (ws, sid, target, id) => { calls.push(['stop', ws, sid, target, id]); return { id, status: 'stopped', workspaceId: target, originSessionId: 'x', revision: 4, plan: normalizePlan({ goal: 'g' }), execution: null, activity: [] }; },
    adminRetryNode: async (ws, sid, target, id, nodeId, reason) => { calls.push(['retry', ws, sid, target, id, nodeId, reason]); return { id, status: 'running', workspaceId: target, originSessionId: 'x', revision: 5, plan: normalizePlan({ goal: 'g' }), execution: null, activity: [] }; },
    catalog: async () => ({ agents: [], orchestrations: [], workspaces: [] })
  };
  const ctx = { tools: { register: d => { tools.set(d.name, d); return () => tools.delete(d.name); } }, commands: { register: () => () => {} } };
  registerFleetChat(ctx, { defineTool: d => d, getService: async () => service, resolveAgentContext: async () => ({ workspaceId: 'a', workspacePath: 'G:/a', sessionId: 's-1' }), createUserMessage: v => v });
  const def = tools.get('fleet_admin');
  assert.ok(def);
  assert.equal(def.parameters.action.required, true);
  assert.ok(def.parameters.action.enum.includes('retry'), 'P-78 adds the cross-Workspace retry action');
  assert.match(def.description, /granted Admin/);
  await def.execute({ action: 'status' }, { agent: { id: 'x' } });
  await def.execute({ action: 'tickets' }, { agent: { id: 'x' } });
  await def.execute({ action: 'start', workspaceId: 'b', ticketId: 't' }, { agent: { id: 'x' } });
  await def.execute({ action: 'retry', workspaceId: 'b', ticketId: 't', nodeId: 'n', reason: 'user asked' }, { agent: { id: 'x' } });
  assert.deepEqual(calls.map(c => c[0]), ['status', 'tickets', 'start', 'retry']);
  assert.deepEqual(calls.at(-1), ['retry', 'a', 's-1', 'b', 't', 'n', 'user asked']);
  // execution Sessions cannot use the Admin surface
  service.ownsSession = async () => true;
  await assert.rejects(def.execute({ action: 'status' }, { agent: { id: 'x' } }), /Execution Sessions/);
});

const views = createFleetViews(React);
test('P-77: Root overview renders granted Admin scope and a cross-workspace feed', () => {
  const project = { workspaceId: 'a', title: 'Alpha', state: 'ok', series: [], tickets: [{ id: 't1', workspaceId: 'a', title: 'Demo Ticket', goal: 'g', status: 'running', revision: 2, updatedAt: '2026-11-25T00:00:00.000Z', nodes: [], gates: [], plan: { goal: 'g' } }] };
  const html = renderToStaticMarkup(views.renderRootOverview({
    admin: { workspaces: [{ workspaceId: 'a', scope: 'all' }] },
    projects: [project], workspaces: [{ workspaceId: 'a', path: 'G:/a' }], series: [],
    mode: { enabledWorkspaceIds: ['a'], ready: true }, ui: { tab: 'admin' }, setUI: () => {},
    t: key => key, language: 'zh', pending: false, refresh: () => {},
    openTicket: () => {}, openWorkspace: () => {}, toggleWorkspace: () => {}, actSeries: () => {}, openSeries: () => {}, returnToConversation: () => {},
    scheduleStatus: { available: true }
  }));
  assert.match(html, /data-fleet-admin-grants/);
  assert.match(html, /data-fleet-admin-grant="a"/);
  assert.match(html, /data-fleet-admin-feed/);
  assert.match(html, /Demo Ticket/);
});