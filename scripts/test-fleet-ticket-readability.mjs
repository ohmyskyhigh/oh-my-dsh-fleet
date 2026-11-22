// Ticket readability v0.1 (P-55/P-56) adversarial suite: goal/title header, blocker line, collapsed criteria,
// deliverable file manifest (planned/submitted/undetermined), category fallback, incompatible preview rows.
// Negative invariants: never fake artifact links, never mutate input plans, never leak raw HTML, legacy items intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizePlan, validatePlan, projectTicket, deliverableView, isIncompatibleDraft } from '../packages/fleet-shell/src/fleet-model.js';
import { createFleetViews } from '../packages/fleet-shell/src/fleet-ui.js';

const views = createFleetViews(React);
const html = node => renderToStaticMarkup(node);
const fleetStyles = readFileSync(new URL('../packages/fleet-shell/src/fleet-theme.js', import.meta.url), 'utf8');

const node = (id, deps = [], status = 'pending', extra = {}) => ({ id, role: 'worker', agentId: 'w1', dependsOn: deps, task: { prompt: `do ${id}`, summary: `我会完成 ${id}` }, ...extra });
const plan = (deliverables = [], nodes = [node('a')], gates = []) => ({ contractVersion: 3, goal: 'g', title: 'T', inputs: {}, deliverables, criteria: [], requirements: undefined, agents: { w1: { name: 'W', profile: {} } }, nodes, gates });
const ticket = (id, overrides = {}, p = plan()) => ({ id, workspaceId: 'w1', originSessionId: 's1', revision: 1, status: 'running', plan: p, execution: null, activity: [], updatedAt: '2026-11-18T00:00:00.000Z', ...overrides });
const options = (tickets, ui = {}) => ({
  workspace: { workspaceId: 'w1', path: 'G:/fixture' }, enabled: true, language: 'zh', mode: { error: null }, busy: false,
  data: { ready: true, tickets, health: { ready: true }, pluginVersion: '0.9.1', catalog: null },
  ui: { page: 'overview', ...ui }, navigate() {}, openDialog() {}, setUI() {}, refresh() {}, toControl() {}, returnToConversation() {},
  t: k => k, members: [], sessionMap: {}, openChat() {}, creatingTicket: false, recreateDraft: async () => {},
  drafts: {}, writeDraft() {}, sendMessage: async () => {}, act: async () => ({}),
});

const withExec = (t, { nodes = {}, gates = {}, artifacts = {}, deliverables = {} } = {}) => {
  t.execution = { currentConfigRevision: 1, configurations: { 1: { plan: t.plan, sourceRefs: [] } }, nodes, gates, artifacts, deliverables, delivery: { history: [], override: null } };
  return t;
};

// ---------- model: category + files validation ----------
test('normalizePlan accepts optional category/files on deliverable objects; legacy items stay valid', () => {
  const p = plan([
    'legacy string',
    { text: 'spec', title: 'T2', description: 'D', category: 'code', files: ['report.md', { path: 'a\\b\\c.png', purpose: '截图' }, { purpose: '后续笔记（路径待定）' }] },
  ]);
  const r = normalizePlan(p);
  assert.equal(r.valid !== false, true);
  assert.ok(validatePlan(r).valid);
  const v = deliverableView(r.deliverables[1]);
  assert.equal(v.category, 'code');
  assert.deepEqual(v.files.map(f => f.path ?? null), ['report.md', 'a\\b\\c.png', null]);
  assert.deepEqual(deliverableView('legacy').files, []);
  assert.equal(deliverableView('legacy').category, undefined);
});

test('validatePlan rejects hostile deliverable file shapes without guessing', () => {
  const bad = file => validatePlan(plan([{ text: 'x', files: file }])).valid;
  for (const f of [[{}], ['  '], [{ path: '' }], [{ nope: 1 }], 'notarray', [{ path: 'ok', purpose: 42 }], [{ path: 'a' }, null], Array.from({ length: 201 }, (_, i) => `f${i}.md`)]) assert.equal(bad(f), false, JSON.stringify(f));
  assert.equal(validatePlan(plan([{ text: 'x', category: 'code-dragon' }])).valid, false);
  assert.equal(validatePlan(plan([{ text: 'x', surprise: 1 }])).valid, false);
});

test('projectTicket matches expected files to submitted artifacts by path or basename only', () => {
  const p = plan([{ text: 'spec', title: '审计', category: 'noncode', files: [{ path: 'qa/report.md', purpose: '主报告' }, { path: 'ledger.json', purpose: '证据台账' }, { purpose: '待定附件' }] }]);
  const t = ticket('m1', { execution: { currentConfigRevision: 1, configurations: { 1: { plan: p, sourceRefs: [] } }, nodes: {}, gates: {}, artifacts: { 'a-1': { nodeId: 'a', deliverableIndex: 0, label: '审计', sourcePath: 'report.md', versions: [{ version: 2, sha256: 'b'.repeat(64), snapshotPath: '.fleet/x/v2/report.md', submittedAt: '2026-11-18T01:00:00.000Z' }] } }, deliverables: { 0: { artifactId: 'a-1', label: '审计' } }, delivery: { history: [], override: null } } });
  const rows = projectTicket(t).deliverables;
  assert.equal(rows[0].files.length, 3);
  assert.equal(rows[0].files[0].submitted?.version, 2, 'basename match counts as submitted');
  assert.equal(rows[0].files[1].submitted, undefined);
  assert.ok(!('submitted' in rows[0].files[2]) || rows[0].files[2].submitted === undefined, 'purpose-only entry is never matched');
});

test('file manifest round-trip mutates nothing: projections are detached clones', () => {
  const p = plan([{ text: 's', files: [{ path: 'x.md', purpose: 'p' }], category: 'other' }]);
  const before = structuredClone(p);
  const t = ticket('m2', {}, p);
  projectTicket(t);
  assert.deepEqual(p, before);
});

// ---------- UI: header, blocker, collapsed criteria ----------
test('ticket header shows title, goal sentence and one blocker line per state; never blank for known states', async () => {
  const failed = withExec(ticket('f1', {}, plan([], [node('build'), node('ship', ['build'])])), { nodes: { build: { status: 'failed', attempts: [], thread: [] }, ship: { status: 'pending', attempts: [], thread: [] } } });
  const run = withExec(ticket('r1', {}, plan([], [node('build')])), { nodes: { build: { status: 'running', attempts: [], thread: [] } } });
  const waitPlan = plan([], [node('a')], [{ id: 'q', from: ['a'], to: [], reviewer: { kind: 'human' } }]);
  const waitg = withExec(ticket('w1', {}, waitPlan), { nodes: { a: { status: 'completed', attempts: [], thread: [] } }, gates: { q: { status: 'pending', reviews: [], history: [] } } });
  for (const [t, want] of [[failed, '执行失败 · build'], [run, '进行中 · build']]) {
    const m = html(views.renderDashboard(options([t], { page: 'ticket', ticketId: t.id })));
    assert.match(m, new RegExp(`data-fleet-blocker="${t.id}"`));
    assert.ok(m.includes(want), want);
    assert.ok(m.includes('data-fleet-blocker-action'), 'actionable blocker links to its node');
  }
  const mw = html(views.renderDashboard(options([waitg], { page: 'ticket', ticketId: waitg.id })));
  assert.ok(mw.includes('等待审批 · q'), 'waiting gate blocker');
  assert.ok(!mw.includes('data-fleet-blocker-action'), 'waiting line points at the gate section below, no fake node jump');
  assert.match(mw, /data-fleet-ticket-title="w1"/);
});

test('blocker row offers Retry node for failed/interrupted nodes on running and stopped tickets only', () => {
  const mk = (id, status, nodeStatus) => withExec(ticket(id, { status }, plan([], [node('build')])), { nodes: { build: { status: nodeStatus, attempts: [], thread: [] } } });
  const has = t => html(views.renderDashboard(options([t], { page: 'ticket', ticketId: t.id }))).includes('data-fleet-blocker-retry="build"');
  assert.ok(has(mk('rt1', 'running', 'failed')), 'failed node on running ticket');
  assert.ok(has(mk('rt2', 'running', 'interrupted')), 'interrupted node on running ticket');
  assert.ok(has(mk('rt3', 'stopped', 'failed')), 'failed node on stopped ticket');
  assert.ok(!has(mk('rt4', 'delivered', 'failed')), 'no retry on delivered ticket');
  assert.ok(!has(mk('rt5', 'running', 'running')), 'no retry while node is only running');
  assert.ok(!has(mk('rt6', 'running', 'completed')), 'no retry for completed node');
});

test('delivered, draft, stopped and stale states render their blocker label', () => {
  const delivered = withExec(ticket('d1', { status: 'delivered' }, plan([], [node('a')])), { nodes: { a: { status: 'completed', attempts: [], thread: [] } } });
  const cases = [
    [delivered, '结果已交付'],
    [ticket('dr1', { status: 'draft' }, plan()), '草稿待启动'],
    [withExec(ticket('st1', { status: 'stopped' }, plan([], [node('a')])), { nodes: { a: { status: 'cancelled', attempts: [], thread: [] } } }), '已停止'],
  ];
  for (const [t, want] of cases) {
    const m = html(views.renderDashboard(options([t], { page: 'ticket', ticketId: t.id })));
    assert.ok(m.includes(want), `${t.id}: ${want}`);
  }
  const stalePlan = plan([], [node('a')], [{ id: 'q', from: ['a'], to: [], reviewer: { kind: 'human' } }]);
  const stale = withExec(ticket('sl1', {}, stalePlan), {
    nodes: { a: { status: 'completed', attempts: [], thread: [] } },
    gates: { q: { status: 'passed', cycle: 1, reviews: [{ id: 'r1', decision: 'passed', time: '2026-11-18T00:30:00Z', cycle: 1, artifactRefs: [{ artifactId: 'a-9', version: 1, sha256: 'a' }] }], history: [] } },
    artifacts: { 'a-9': { nodeId: 'a', deliverableIndex: null, sourcePath: 'x.md', label: 'x', versions: [{ version: 2, sha256: 'b', snapshotPath: '.fleet/v2/x.md', submittedAt: '2026-11-18T01:00:00Z' }] } },
  });
  const m = html(views.renderDashboard(options([stale], { page: 'ticket', ticketId: 'sl1' })));
  assert.ok(m.includes('产物已更新，待复核 · q'));
});

test('ticket-wide criteria collapse by default with a counted summary; content survives', () => {
  const t = ticket('c1', {}, { ...plan([], [node('a')]), criteria: ['保留执行证据', '守住边界'] });
  const m = html(views.renderDashboard(options([t], { page: 'ticket', ticketId: 'c1' })));
  assert.match(m, /data-fleet-ticket-criteria="c1"[\s\S]*?<details>[\s\S]*?整单验收标准 · 2/);
  assert.ok(m.includes('保留执行证据'));
});

test('node thread promotes the one-sentence summary and collapses the full prompt', () => {
  const long = '这是一段特别长的完整任务指令'.repeat(40);
  const t = ticket('n1', {}, plan([], [{ id: 'a', role: 'worker', agentId: 'w1', dependsOn: [], task: { prompt: long, summary: '我会做 A，达成可验收结果' } }]));
  const m = html(views.renderDashboard(options([t], { page: 'ticket', ticketId: 'n1' })));
  const summaryAt = m.indexOf('我会做 A');
  const promptAt = m.indexOf(long.slice(0, 24));
  assert.ok(summaryAt >= 0 && promptAt > summaryAt, 'summary precedes prompt');
  assert.match(m, /data-fleet-thread-summary="a"/);
  assert.match(m, /data-fleet-thread-prompt="a"/);
  assert.ok(m.indexOf('完整任务指令与节点配置') < promptAt, 'prompt lives behind the details summary');
});

test('legacy node without a summary still shows its prompt inline (P-49 fallback)', () => {
  const t = ticket('n2', {}, plan([], [{ id: 'a', role: 'worker', agentId: 'w1', dependsOn: [], task: { prompt: '旧任务指令原文' } }]));
  const m = html(views.renderDashboard(options([t], { page: 'ticket', ticketId: 'n2' })));
  assert.ok(m.includes('旧任务指令原文'));
});

// ---------- UI: deliverable cards ----------
test('deliverable rows are collapsed one-line disclosures: label, counted summary, no article cards', () => {
  const p = plan([{ text: 'spec', title: '审计包', description: '获得问题清单', category: 'noncode', criteria: ['c1', 'c2'], files: [{ path: 'report.md', purpose: '主报告' }] }, '旧交付字符串']);
  const m = html(views.renderDashboard(options([ticket('v9', {}, p)], { page: 'ticket', ticketId: 'v9' })));
  assert.ok(m.includes('class="fl-dlist"'), 'deliverables render inside a compact row list');
  assert.ok(m.includes('data-fleet-deliverable-toggle="0"') && m.includes('data-fleet-deliverable-toggle="1"'), 'each row exposes a counted one-line summary');
  assert.ok(!/<article[^>]*data-fleet-deliverable-row/.test(m), 'no full-size article cards remain in the deliverable area');
  assert.ok(m.includes('title="非代码交付"'), 'short row label keeps the full category name as title');
  assert.ok(m.includes('标准\u20092'), 'criteria count renders on the summary line');
});

test('deliverable card shows category badge, file manifest and submitted version link; unbound never fakes a link', () => {
  const p = plan([{ text: 'spec', title: '审计包', description: '获得问题清单', category: 'noncode', files: [{ path: 'report.md', purpose: '主报告' }, { path: 'missing.md', purpose: '未交' }, { purpose: '待定' }] }]);
  const t = ticket('v1', { execution: { currentConfigRevision: 1, configurations: { 1: { plan: p, sourceRefs: [] } }, nodes: { a: { status: 'completed', attempts: [], thread: [] } }, gates: {}, artifacts: { 'a-1': { nodeId: 'a', deliverableIndex: 0, label: '审计包', sourcePath: 'report.md', versions: [{ version: 1, sha256: 'a'.repeat(64), snapshotPath: '.fleet/v1/report.md', submittedAt: '2026-11-18T00:00:00Z' }] } }, deliverables: { 0: { artifactId: 'a-1', label: '审计包' } }, delivery: { history: [], override: null } } }, p);
  const m = html(views.renderDashboard(options([t], { page: 'ticket', ticketId: 'v1' })));
  assert.ok(m.includes('非代码交付'), 'category badge');
  assert.ok(m.includes('data-fleet-deliverable-files="0"'), 'files block');
  assert.match(m, /data-fleet-file-status="submitted"[\s\S]*?data-fleet-file-link="0"/);
  assert.ok(m.includes('data-fleet-file-status="planned"'), 'planned file without fake link');
  assert.ok(m.includes('data-fleet-file-status="undetermined"') && m.includes('路径待定'));
  assert.ok(!/data-fleet-file-status="planned"[\s\S]*?api\/file/.test(m.split('data-fleet-file-status="planned"')[1].split('data-fleet-file-status')[0]), 'planned row carries no artifact anchor');
});

test('legacy string deliverable renders uncategorized with no files block; >4 files collapse', () => {
  const p = plan(['旧交付字符串', { text: 's', files: Array.from({ length: 7 }, (_, i) => `f${i}.md`) }]);
  const m = html(views.renderDashboard(options([ticket('v2', {}, p)], { page: 'ticket', ticketId: 'v2' })));
  assert.ok(m.includes('旧交付字符串') && !m.includes('data-fleet-deliverable-files="0"'), 'legacy string: no fake manifest');
  assert.ok(m.includes('data-fleet-deliverable-files="1"') && m.includes('其余 3 项'));
});

test('file paths and purposes are escaped; hostile unicode and RTL never inject markup', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const p = plan([{ text: 's', files: [{ path: evil, purpose: '‮' + evil }, { path: '中文文档·報告 — 🎯.md', purpose: '测试' }] }]);
  const m = html(views.renderDashboard(options([ticket('x1', {}, p)], { page: 'ticket', ticketId: 'x1' })));
  assert.ok(!m.includes('<img'), 'escaped');
  assert.ok(m.includes('&lt;img'), 'visible as text');
});

// ---------- UI: dashboard attention + incompatible rows ----------
test('empty attention collapses to one dashed line; grouped incompatible rows carry preview entry and no open-ticket marker', () => {
  const bad = ticket('ib1', { status: 'draft', plan: { ticket: { goal: '旧草稿原始需求：把审计做完' } } });
  assert.ok(isIncompatibleDraft(bad));
  const m = html(views.renderDashboard(options([bad])));
  assert.ok(m.includes('fl-attention-empty'), 'one-line empty attention');
  assert.ok(m.includes('fl-grow-notice'), 'adaptive incompatible row');
  assert.ok(m.includes('data-fleet-incompatible-preview="ib1"'), 'preview entry');
  assert.ok(!m.includes('data-open-ticket="ib1"'), 'incompatible rows never claim a normal open path');
});

test('incompatible preview dialog shows original request and reason; compatible tickets unaffected', () => {
  const bad = { ...ticket('ib2', { status: 'draft', plan: { ticket: { goal: '原始需求文本很长'.repeat(30) } } }) };
  const opened = [];
  const m = html(views.renderDashboard({ ...options([bad], { page: 'ticket', ticketId: 'ib2' }), openDialog: d => opened.push(d) }));
  assert.match(m, /data-fleet-incompatible-ticket="ib2"/);
  assert.match(m, /data-fleet-incompatible-goal="ib2"/);
  assert.match(m, /data-fleet-incompatible-reasons="ib2"/);
  assert.ok(m.includes('contractVersion — '), 'validation reason rendered as text');
  assert.ok(m.includes('原始需求文本很长'), 'full original request preserved for reading');
  const good = ticket('ok1', { status: 'draft' });
  assert.ok(!html(views.renderDashboard(options([good], { page: 'ticket', ticketId: 'ok1' }))).includes('data-fleet-incompatible-ticket'));
});

// ---------- UI: thread text clamping ----------
test('long agent free text in the thread clamps to a one-line preview; short text stays plain', () => {
  const blob = '审计节点完成：对生产站与本地预览分别取证，产出审计包 qa/site-audits/2026-11-15-seo-geo/（report.md、product-brief.md、keyword-lab-brief.json、evidence/audit-ledger.json 与 83 个带 SHA-256 的证据源、README 复现说明、6 个采集器脚本）。核心实测结论如下所述。'.repeat(3);
  const longEvidence = `${blob}（完整证据到此结束）`;
  const short = '我会完成源码变更并记录可复现验证';
  assert.ok(blob.length > 260, 'fixture blob is long');
  const p = plan(['d1']);
  const t = withExec(ticket('cl1', {}, p), { nodes: { a: { status: 'completed', attempts: [{ id: 'a-1', status: 'completed', configRevision: 1, outputs: longEvidence, completion: { summary: longEvidence, submittedAt: '2026-11-18T00:00:00Z', acceptanceResults: [], verification: [], artifactRefs: [] } }], thread: [{ id: 'm1', actor: { kind: 'agent' }, time: '2026-11-18T00:10:00Z', text: short }, { id: 'm2', actor: { kind: 'agent' }, time: '2026-11-18T00:11:00Z', text: blob }] } } });
  const m = html(views.renderDashboard(options([t], { page: 'ticket', ticketId: 'cl1' })));
  const clamps = (m.match(/class="fl-clamp"/g) ?? []).length;
  assert.equal(clamps, 2, 'only the two raw-zone disclosures remain clamped');
  assert.ok(m.includes('data-fleet-thread-evidence="a"'), 'evidence clamp carries its marker');
  assert.ok(m.includes(blob.slice(0, 110) + '…'), 'preview is the first 110 characters');
  assert.equal((m.match(/完整证据到此结束/g) ?? []).length, 2, 'full text appears once per expanded raw-zone body, never in previews');
  assert.ok(!m.includes(short), 'thread messages are no longer rendered on the Dashboard');
});

// ---------- UI: thread-first redesign (2026-11-19) ----------
test('thread-first: one status line, time-ordered merged feed, zero dropdowns in the card, details sunk to raw zone', () => {
  const p = plan(['d1'], [node('a')], [{ id: 'q', from: ['a'], reviewer: { kind: 'human' }, requireEvidence: true, maxAutoRework: 0 }]);
  const t = withExec(ticket('tf1', {}, p), {
    nodes: { a: { status: 'completed', attempts: [{ id: 'a-9', status: 'completed', configRevision: 1, startedAt: '2026-11-17T23:00:00Z', outputs: 'ok', completion: { summary: 'done', submittedAt: '2026-11-18T00:05:00Z', acceptanceResults: [{ status: 'passed', criterion: 'c1' }], verification: [{ command: 'pnpm test', exitCode: 0, source: 'agent-report' }], artifactRefs: [] } }], thread: [{ id: 'm1', actor: { kind: 'agent' }, time: '2026-11-18T00:01:00Z', text: '已完成改动' }, { id: 'm2', actor: { kind: 'human' }, time: '2026-11-18T00:03:00Z', text: '补一个链接' }] } },
    gates: { q: { id: 'q', status: 'passed', coverage: 'covered', cycle: 1, from: ['a'], reviews: [{ cycle: 1, decision: 'passed', time: '2026-11-18T00:10:00Z', findings: [] }] } },
  });
  const m = html(views.renderDashboard(options([t], { page: 'ticket', ticketId: 'tf1' })));
  assert.match(m, /class="fl-statusline" data-fleet-completion="a-9"/);
  assert.ok(!m.includes('完成三态'), 'no completion facts kv table on the page');
  assert.ok(m.includes('已结束') && m.includes('已提交 · 自报') && m.includes('已通过'), 'three facts on one status line');
  assert.ok(!m.includes('提交完成证据 · 验收'), 'no evidence timeline row on the Dashboard');
  assert.ok(m.includes('data-fleet-thread-evidence="a"'), 'the verbatim completion summary keeps its clamp marker in the raw zone');
  // Thread block removed (2026-11-19): progress lives in the native chat, the Dashboard keeps configuration and control.
  assert.ok(!m.includes('data-fleet-thread-feed'), 'no activity feed region');
  assert.ok(!/class="fl-message fl-(step|comment)"/.test(m), 'no step rows or comment cards');
  assert.ok(!m.includes('fl-composer') && !m.includes('添加讨论…') && !m.includes('发送评论'), 'no comment composer');
  assert.ok(!m.includes('已派发 · 配置') && !m.includes('Gate q 审批通过'), 'no merged dispatch or gate timeline');
  const rawAt = m.indexOf('data-fleet-rawdata');
  assert.ok(rawAt > 0 && m.indexOf('data-fleet-thread-config="a"') > rawAt && m.indexOf('data-fleet-evidence-details="a-9"') > rawAt, 'config and evidence details live in the raw zone');
  const threadHtml = m.slice(m.indexOf('data-fleet-thread="a"'), rawAt);
  assert.ok(!threadHtml.includes('<details'), 'no dropdowns between the thread card and the raw zone');
});

test('selected attempt shows native step/status rows, or saved report text from a historical run', () => {
  const attempts=[{id:'old',configRevision:1,status:'completed',sessionId:'old-session',outputs:{text:'Historical update\n\nFinal report',finalText:'Final report'}},{id:'new',configRevision:1,status:'running',sessionId:'new-session'}];
  const actor={kind:'agent'};
  const thread=[{id:'s',attemptId:'new',actor,intent:'step',step:2,tool:'read',text:'read'}, {id:'t',attemptId:'new',actor,intent:'status',status:'running',text:'Running'}, {id:'r',attemptId:'new',actor,intent:'execution',text:'Current report'}];
  const t=withExec(ticket('rounds'),{nodes:{a:{status:'running',attempts,thread}}});
  const page=id=>html(views.renderDashboard(options([t],{page:'ticket',ticketId:t.id,attemptId:id})));
  assert.ok(page('new').includes('data-fleet-node-session="new-session"') && !page('new').includes('data-fleet-node-session="old-session"'), 'selected attempt links its own full conversation');
  assert.ok(page('old').includes('data-fleet-node-session="old-session"') && !page('old').includes('data-fleet-node-session="new-session"'), 'historical attempt links its own full conversation');
  assert.doesNotMatch(page('new'),/data-fleet-thread-feed|步骤 2 · read|fl-step|fl-comment/);
});

// ---------- theme invariants ----------
test('theme keeps monochrome scope and readability additions are scoped, unrooted, purple-free', () => {
  assert.ok(!/purple|#6255CC|#7465DC|#B8ADFF/i.test(fleetStyles));
  assert.ok(!/:root\s*\{/.test(fleetStyles));
  for (const cls of ['fl-blocker', 'fl-filelist', 'fl-file ', 'fl-attention-empty', 'fl-grow-notice', 'fl-goal', 'fl-ditem', 'fl-clamp', 'fl-statusline']) {
    assert.ok(fleetStyles.includes(`.dsh-fleet-shell .${cls}`), cls);
  }
  assert.ok(/\.fl-grow \{[^}]*height:44px/.test(fleetStyles), 'normal data rows stay 44px');
  assert.ok(/\.fl-grow-notice \{height:auto;min-height:44px/.test(fleetStyles), 'notice rows adapt');
});
