// 0.9.1 minimum UX: readable execution-session names grouped by Ticket, and Title distinct from Goal.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FleetService } from '../packages/fleet-shell/src/fleet-service.js';
import { normalizePlan, projectTicket, readableTitle } from '../packages/fleet-shell/src/fleet-model.js';

const plan = (extra = {}) => normalizePlan({ goal: 'Build and verify the report', deliverables: [], criteria: [], agents: { writer: { name: '撰写员', profile: { instructions: 'write' } } }, nodes: [{ id: 'draft', agentId: 'writer', dependsOn: [], task: { prompt: 'write', summary: 'I will write' } }], gates: [], ...extra });
function host() {
  const calls = { create: [], submit: [], cancel: [] }, sessions = new Map();
  const adapter = {
    async create(r) { calls.create.push(structuredClone(r)); const sessionId = `s-${sessions.size + 1}`; sessions.set(sessionId, { status: 'unknown' }); return { sessionId }; },
    async submit(r) { calls.submit.push(structuredClone(r)); sessions.set(r.sessionId, { status: 'running' }); return { messageId: r.requestId }; },
    async recover() {}, async inspect(r) { return structuredClone(sessions.get(r.sessionId) ?? { status: 'unknown' }); },
    async cancel(r) { calls.cancel.push(structuredClone(r)); sessions.set(r.sessionId, { status: 'stopped' }); return { stopped: true }; },
    async message(r) { return { messageId: r.requestId }; },
    async modelCatalog() { return { default: null, groups: [], failures: [] }; }
  };
  return { calls, sessions, adapter };
}
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-naming-'));
  const h = host();
  const service = await FleetService.open({ rootPath: path.join(temp, 'root'), workspacePaths: { a: path.join(temp, 'a') }, adapter: h.adapter, autoStart: false });
  t.after(async () => { await service.close(); const target = path.resolve(temp); assert(path.basename(target).startsWith('fleet-naming-')); await fs.rm(target, { recursive: true, force: true }); });
  return { service, h };
}

test('readableTitle derives a scannable default label from a long goal', () => {
  assert.equal(readableTitle('请帮我对 CarDry 网页做 SEO 审计，产出关键词与改进清单'), 'CarDry 网页做 SEO 审计');
  assert.equal(readableTitle('我需要完成季度洞察报告。覆盖全部访谈'), '完成季度洞察报告');
  assert.equal(readableTitle('短目标'), '短目标');
  assert.equal(readableTitle(''), '');
  const long = readableTitle('这是一个没有任何标点而且特别特别特别特别特别特别特别长的任务目标描述文字');
  assert.ok(long.length <= 25 && long.endsWith('…'), 'long goals are capped with an ellipsis');
});

test('plan.title is an optional display name preserved by normalize and exposed by projection; empty means unset', () => {
  const withTitle = normalizePlan({ goal: 'g', title: '  我的标题  ', nodes: [] });
  assert.equal(withTitle.title, '  我的标题  ');
  assert.equal(projectTicket({ id: 't', status: 'draft', plan: withTitle, activity: [] }).title, '  我的标题  ');
  const empty = normalizePlan({ goal: 'g', title: '   ', nodes: [] });
  assert.equal(empty.title, undefined);
  assert.equal(projectTicket({ id: 't', status: 'draft', plan: empty, activity: [] }).title, undefined);
  const none = normalizePlan({ goal: 'g', nodes: [] });
  assert.equal(none.title, undefined);
});

test('execution session name groups by Ticket and identifies role, node and attempt round', async t => {
  const f = await fixture(t);
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: plan() });
  await f.service.human('a', 'u', 'start', ['t']);
  await f.service.tick();
  const first = f.h.calls.create[0];
  assert.match(first.title, /Build and verify/);
  assert.match(first.title, /撰写员/);
  assert.match(first.title, /draft/);
  assert.match(first.title, /第1轮/);
  // stop -> retry produces a second attempt whose session name carries round 2 (still same Ticket prefix).
  await f.service.human('a', 'u', 'stop', ['t']);
  await f.service.tick();
  await f.service.human('a', 'u', 'retryNode', ['t', 'draft', 'redo']);
  await f.service.tick();
  const second = f.h.calls.create.at(-1);
  assert.match(second.title, /第2轮/);
  assert.match(second.title, /Build and verify/);
  assert.notEqual(second.title, first.title);
});

test('session name prefers the Ticket title over the goal when a title is set', async t => {
  const f = await fixture(t);
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: plan({ title: '季度洞察报告' }) });
  await f.service.human('a', 'u', 'start', ['t']);
  await f.service.tick();
  const title = f.h.calls.create[0].title;
  assert.match(title, /季度洞察报告/);
  assert.equal(/Build and verify/.test(title), false, 'goal must not leak into the name when a title exists');
});

test('gate review session name marks review, gate id and cycle', async t => {
  const f = await fixture(t);
  const p = plan({ gates: [{ id: 'qa', from: ['draft'], to: [], reviewer: { kind: 'agent', nodeId: 'draft' } }] });
  await f.service.saveDraftTicket('a', { id: 't', sessionId: 'origin', plan: p });
  await f.service.human('a', 'u', 'start', ['t']);
  await f.service.tick();
  const nodeSession = f.h.calls.create[0].title;
  assert.match(nodeSession, /第1轮/);
  // finish the source node so the gate dispatches its own review session
  const sid = f.h.calls.create[0] && [...f.h.sessions.keys()][0];
  f.h.sessions.set(sid, { status: 'completed', output: { text: 'done' } });
  await f.service.tick();
  const review = f.h.calls.create.at(-1);
  assert.match(review.title, /审核 qa/);
  assert.match(review.title, /第1轮/);
  assert.match(review.title, /Build and verify/);
});
