// Adversarial ("break-it") suite for the Dashboard redesign v0.1.
// Feeds hostile data/state to the new overview/tickets/workflow surfaces and asserts
// negative invariants (no purple, no priority, scoped styles, equal-height, gate parity,
// XSS escaping, cycle-safe layout). Real React SSR; no native Sessions or persisted Tickets.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFleetViews } from '../src/fleet-ui.js';
import { graphLevels, TICKET_STATUSES } from '../src/fleet-model.js';
import { fleetStyles } from '../src/fleet-theme.js';

const views = createFleetViews(React);
const noop = () => {};
const plan = (nodes = [], gates = []) => ({ contractVersion: 3, goal: 'g', inputs: {}, deliverables: [], criteria: [], agents: {}, nodes, gates });
const node = (id, deps = [], status = 'completed', extra = {}) => ({ id, role: 'r', agentId: 'a', dependsOn: deps, status, task: { summary: 's' }, ...extra });
const ticket = (id, extra = {}) => ({ id, workspaceId: 'w', originSessionId: 's', status: 'running', revision: 1, plan: plan([node('n1'), node('n2', ['n1'])], [{ id: 'g1', from: ['n2'], to: [], reviewer: { kind: 'human' }, status: 'pending', reviews: [] }]), execution: null, activity: [], nodes: [node('n1'), node('n2', ['n1'])], gates: [{ id: 'g1', from: ['n2'], to: [], reviewer: { kind: 'human' }, status: 'pending', reviews: [] }], ...extra });
function options(tickets, ui = {}, language = 'zh') {
  return { language, t: k => k, workspace: { workspaceId: 'w', title: 'W', path: 'G:/fx' }, enabled: true, mode: {}, data: { ready: true, health: { ready: true }, tickets, catalog: { agents: [], orchestrations: [] } }, ui: { page: 'overview', ...ui }, members: [], sessionMap: {}, drafts: {}, creatingTicket: false, busy: false, navigate: noop, setUI: noop, openDialog: noop, act: noop, openChat: noop, recreateDraft: noop, refresh: noop, toControl: noop, returnToConversation: noop, setLanguagePreference: noop };
}
const html = el => renderToStaticMarkup(el);
const all = (el, out = []) => { if (React.isValidElement(el)) { out.push(el); React.Children.forEach(el.props.children, c => all(c, out)); } return out; };

test('theme: no purple, no :root, scoped to .dsh-fleet-shell, equal-height canvas/thread', () => {
  assert.ok(!/#6255CC|#7465DC|#5547BC|#6B5CD1|#B8ADFF|purple/i.test(fleetStyles), 'purple must not appear');
  assert.ok(!/:root\s*\{/.test(fleetStyles), 'must not write :root');
  assert.ok(!/^\s*(button|body)\s*\{/m.test(fleetStyles), 'must not override global button/body');
  assert.ok(fleetStyles.includes('.dsh-fleet-shell'), 'styles scoped');
  assert.ok(/\.fl-flow \{height:560px/.test(fleetStyles) && !/\.fl-thread \{/.test(fleetStyles), 'canvas and thread equal height');
  assert.ok(/\.fl-grow \{[^}]*height:44px/.test(fleetStyles), 'data row 44px');
});

test('Root attention prioritizes failed nodes and ready human gates and hides abandoned tickets', () => {
  const projects=[{workspaceId:'w',title:'Workspace',state:'ok',tickets:[
    {id:'failed-node',status:'running',nodes:[{id:'a',status:'failed'}],gates:[]},
    {id:'needs-review',status:'running',nodes:[{id:'a',status:'completed'}],gates:[{status:'pending',from:['a'],reviewer:{kind:'human'}}]},
    {id:'abandoned-ticket',status:'draft',abandonedAt:'2026-11-21T00:00:00.000Z',nodes:[],gates:[]}
  ]}];
  const markup=html(views.renderRootOverview({language:'zh',projects,series:[],mode:{ready:true,enabledWorkspaceIds:[]},ui:{tab:'attention'},setUI:noop,refresh:noop,returnToConversation:noop,setLanguagePreference:noop}));
  assert.match(markup,/执行失败/); assert.match(markup,/待人工审核/);
  assert.match(markup,/data-fleet-root-ticket="failed-node"/); assert.doesNotMatch(markup,/data-fleet-root-ticket="abandoned-ticket"/);
  assert.match(markup,/已放弃执行/);
});

test('Ticket list filters include every canonical status in order', () => {
  const page = views.renderDashboard(options([], { page: 'tickets' }, 'en'));
  const filter = all(page).find(element => element.type === 'select' && element.props['aria-label'] === 'Ticket status');
  assert.ok(filter);
  const values = React.Children.toArray(filter.props.children).map(option => option.props.value);
  assert.deepEqual(values, ['all', ...TICKET_STATUSES]);
});

test('Workspace review queue follows the Ticket lifecycle even with a completed source and pending gate', () => {
  const execution = {
    currentConfigRevision: 1, configurations: { 1: { plan: ticket('review-ticket').plan } },
    nodes: { n2: { status: 'completed' } }, gates: { g1: { status: 'pending' } }
  };
  for (const extra of [{ status: 'stop-requested' }, { status: 'stopped' }, { status: 'stopped', abandonedAt: '2026-11-23T07:53:51Z' }]) {
    const markup = html(views.renderDashboard(options([ticket('review-ticket', { execution, ...extra })])));
    assert.match(markup, /data-fleet-attention-empty/);
  }
  const running = html(views.renderDashboard(options([ticket('review-ticket', { execution })])));
  assert.doesNotMatch(running, /data-fleet-attention-empty/);
});

test('overview: compact strip, grouped list, no sessions panel, no priority', () => {
  const m = html(views.renderDashboard(options([ticket('t1'), ticket('t2', { status: 'delivered' }), ticket('t3', { status: 'draft' })])));
  assert.ok(m.includes('fl-metrics fl-strip'), 'metrics rendered as strip');
  assert.ok(m.includes('fl-glist'), 'grouped dense list');
  assert.ok(!m.includes('data-fleet-session'), 'sessions panel removed from overview');
  assert.ok(!m.includes('优先级') && !m.includes('Priority'), 'no priority field');
});

test('hostile data: empty / null nodes / unknown status / missing fields never throw', () => {
  const hostile = [
    ticket('e1', { nodes: null, gates: null, plan: plan([], []), activity: null }),
    ticket('e2', { nodes: [null, undefined, node('x', ['missing-dep'], 'weird-status')], gates: [null], updatedAt: undefined }),
    ticket('e3', { status: 'unknown-state', nodes: [], gates: [], events: [{ id: 'v', type: 't', time: 'not-a-date' }] }),
    { id: 'e4' }, // almost everything missing
  ];
  for (const page of ['overview', 'tickets']) {
    const m = html(views.renderDashboard(options(hostile, { page })));
    assert.ok(m.length > 0);
  }
  const single = html(views.renderDashboard(options([ticket('solo')], { page: 'ticket', ticketId: 'solo' })));
  assert.ok(single.includes('fl-flow'), 'workflow region present');
});

test('XSS: goal/node/event text is escaped, no raw injection', () => {
  const evil = '<img src=x onerror=alert(1)>&"\'';
  const t = ticket('x1', { goal: evil, nodes: [node(evil, [], 'completed', { task: { summary: evil } })], activity: [{ id: 'a', type: evil, time: '2026-01-01T00:00:00Z' }] });
  const m = html(views.renderDashboard(options([t])));
  assert.ok(!m.includes('<img src=x'), 'raw img must not appear');
  assert.ok(m.includes('&lt;img'), 'escaped');
});

test('long names / unicode / RTL do not break markup and stay escaped', () => {
  const long = '名'.repeat(300) + '‮' + '🚀'.repeat(50);
  const m = html(views.renderDashboard(options([ticket('L1', { goal: long })])));
  assert.ok(m.includes('fl-ttl'), 'title cell present');
  assert.ok(!m.includes('<script'), 'no injection');
});

test('search with no match shows query-specific empty state', () => {
  const m = html(views.renderDashboard(options([ticket('t1')], { page: 'tickets', query: 'zzz-no-match' })));
  assert.ok(m.includes('没有匹配的任务'), 'query empty copy');
});

test('tickets: list/board toggle present; board renders kanban', () => {
  const list = html(views.renderDashboard(options([ticket('t1')], { page: 'tickets' })));
  assert.ok(list.includes('fl-segment') && list.includes('fl-glist'));
  const board = html(views.renderDashboard(options([ticket('t1')], { page: 'tickets', ticketsLayout: 'board' })));
  assert.ok(board.includes('fl-kanban'), 'kanban board');
});

test('workflow: gate rendered as full-size node card inside DAG (connected), pan/zoom controls present', () => {
  const m = html(views.renderDashboard(options([ticket('t1')], { page: 'ticket', ticketId: 't1' })));
  assert.ok(m.includes('fl-node-gate'), 'gate full-size card');
  assert.ok(m.includes('data-fleet-gate-node="g1"'), 'gate in DAG');
  assert.ok(m.includes('fl-flow-inner'), 'pan/zoom inner transform layer');
  assert.ok(m.includes('放大查看') || m.includes('Fullscreen'), 'fullscreen entry');
  assert.ok(m.includes('fl-workbench'), 'workbench region retained');
});

test('workflow: gate-guarded successor sits in a later column than its source (left-right, not stacked)', () => {
  const gates = [{ id: 'read-check', from: ['audit'], to: ['notes'], reviewer: { kind: 'human' }, status: 'pending', reviews: [] }];
  const t = ticket('chain', { plan: plan([node('audit'), node('notes', ['audit'])], gates), nodes: [node('audit'), node('notes', ['audit'])], gates });
  const m = html(views.renderDashboard(options([t], { page: 'ticket', ticketId: 'chain' })));
  assert.match(m, /data-fleet-flow-level="0"[\s\S]*data-fleet-node="audit"[\s\S]*fl-ntype-gate[\s\S]*<strong>read-check<\/strong>[\s\S]*data-fleet-flow-level="1"[\s\S]*data-fleet-node="notes"/, 'audit → gate → notes across columns');
});

test('graphLevels fuzz: cycles / self-dep / dangling / dup / deep / wide terminate and cover nodes', () => {
  const mk = (ids, depFn) => ids.map(id => node(id, depFn(id)));
  const cases = [
    mk(['a', 'b'], id => (id === 'a' ? ['b'] : ['a'])),            // cycle
    mk(['a'], () => ['a']),                                          // self dep
    mk(['a', 'b'], () => ['ghost']),                                 // dangling
    mk(['a', 'a', 'b'], id => (id === 'b' ? ['a'] : [])),            // dup id
    mk(Array.from({ length: 60 }, (_, i) => 'n' + i), id => (id === 'n0' ? [] : ['n' + (parseInt(id.slice(1)) - 1)])), // deep
    mk(Array.from({ length: 60 }, (_, i) => 'w' + i), () => []),     // wide
    [],                                                              // empty
  ];
  for (const nodes of cases) {
    const levels = graphLevels(nodes, []);
    const flat = levels.flat();
    assert.ok(Array.isArray(levels) && levels.length > 0 || nodes.length === 0);
    assert.ok(flat.every(n => n && typeof n.id === 'string'), 'no undefined nodes');
    assert.equal(new Set(flat.map(n => n.id)).size, new Set(nodes.map(n => n.id)).size, 'covers unique ids');
  }
  // random DAG fuzz
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let iter = 0; iter < 200; iter++) {
    const n = 1 + Math.floor(rnd() * 12);
    const ids = Array.from({ length: n }, (_, i) => 'n' + i);
    const nodes = ids.map((id, i) => node(id, ids.slice(0, i).filter(() => rnd() < 0.4)));
    if (rnd() < 0.2) nodes[0].dependsOn = [ids[n - 1]]; // inject cycle sometimes
    const levels = graphLevels(nodes, []);
    assert.ok(levels.flat().length >= 1);
  }
});

test('rendering does not mutate input tickets', () => {
  const ts = [ticket('m1'), ticket('m2', { status: 'stopped' })];
  const before = structuredClone(ts);
  html(views.renderDashboard(options(ts)));
  html(views.renderDashboard(options(ts, { page: 'ticket', ticketId: 'm1' })));
  assert.deepEqual(ts, before);
});
