// Targeted suite for the FlowRegion pan gesture (drag-to-pan on the Ticket workflow canvas).
// Mounts the real FlowRegion component with a deterministic hook runtime and drives raw
// pointer sequences through its handlers: selection prevention, capture, and every exit
// path (pointerup / pointercancel / lostpointercapture / window blur / released-button
// self-heal). No DOM, no build step, no generated client artifacts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const tick = () => delay(20); // outlast the component's setTimeout(0) suppression reset
import {createFleetViews} from '../src/fleet-ui.js';
import {fleetStyles} from '../src/fleet-theme.js';

// --- deterministic React hook runtime -------------------------------------------------
function makeRuntime() {
  const rt = {states: [], refs: [], effects: [], si: 0, ri: 0, ei: 0,
    reset() {this.si = 0; this.ri = 0; this.ei = 0;},
    fresh() {this.states.length = 0; this.refs.length = 0; this.effects.length = 0; this.reset();}};
  rt.React = {
    createElement: (type, props, ...children) => ({type, props: {...(props ?? {}), children}, children}),
    Fragment: 'fragment',
    useState(init) {const i = rt.si++; if (!(i in rt.states)) rt.states[i] = typeof init === 'function' ? init() : init; return [rt.states[i], v => {rt.states[i] = typeof v === 'function' ? v(rt.states[i]) : v;}];},
    useRef(init) {const i = rt.ri++; if (!(i in rt.refs)) rt.refs[i] = {current: init}; return rt.refs[i];},
    useEffect(fn) {rt.effects[rt.ei++] = fn;},
    useCallback(fn) {return fn;},
  };
  return rt;
}
const walk = (n, out = []) => {
  if (Array.isArray(n)) {for (const c of n) walk(c, out); return out;}
  if (n && typeof n === 'object' && n.type !== undefined) {out.push(n); walk(n.props?.children, out);}
  return out;
};

// --- minimal Ticket fixture (same shape as test-fleet-dashboard-redesign) --------------
const noop = () => {};
const node = (id, deps = []) => ({id, role: 'r', agentId: 'a', dependsOn: deps, status: 'completed', task: {summary: 's'}});
const gates = [{id: 'g1', from: ['n2'], to: [], reviewer: {kind: 'human'}, status: 'pending', reviews: []}];
const ticket = {id: 't1', workspaceId: 'w', originSessionId: 's', status: 'running', revision: 1,
  plan: {contractVersion: 3, goal: 'g', inputs: {}, deliverables: [], criteria: [], agents: {}, nodes: [node('n1'), node('n2', ['n1'])], gates},
  execution: null, activity: [], nodes: [node('n1'), node('n2', ['n1'])], gates};
const options = () => ({language: 'zh', t: k => k, workspace: {workspaceId: 'w', title: 'W', path: 'G:/fx'}, enabled: true, mode: {},
  data: {ready: true, health: {ready: true}, tickets: [ticket], catalog: {agents: [], orchestrations: []}},
  ui: {page: 'ticket', ticketId: 't1'}, members: [], sessionMap: {}, drafts: {}, creatingTicket: false, busy: false,
  navigate: noop, setUI: noop, openDialog: noop, act: noop, openChat: noop, recreateDraft: noop, refresh: noop, toControl: noop, returnToConversation: noop, setLanguagePreference: noop});

// --- mount the real FlowRegion with a fake canvas element ------------------------------
function mount(t) {
  const rt = makeRuntime();
  const views = createFleetViews(rt.React);
  const flowEl = walk(views.renderDashboard(options())).find(n => typeof n.type === 'function' && n.type.name === 'FlowRegion');
  assert.ok(flowEl, 'FlowRegion element found in the Ticket page tree');
  rt.fresh(); // isolate FlowRegion's own hooks from dashboard construction
  const render = () => {rt.reset(); return flowEl.type(flowEl.props);};
  const canvasEl = walk(render()).find(n => n.props?.className === 'fl-flow');
  const innerEl = walk(render()).find(n => n.props?.className === 'fl-flow-inner');
  const captured = new Set();
  const canvas = {dataset: {}, clientWidth: 800, clientHeight: 560, focused: 0,
    setPointerCapture: id => captured.add(id),
    releasePointerCapture: id => captured.delete(id),
    hasPointerCapture: id => captured.has(id),
    focus() {this.focused++;}, addEventListener() {}, removeEventListener() {}};
  canvasEl.props.ref.current = canvas;
  innerEl.props.ref.current = {scrollWidth: 1000, scrollHeight: 400};
  const win = {listeners: {}, addEventListener(n, f) {(this.listeners[n] ??= []).push(f);}, removeEventListener(n, f) {this.listeners[n] = (this.listeners[n] ?? []).filter(x => x !== f);}};
  const prevWindow = globalThis.window; globalThis.window = win;
  const cleanups = rt.effects.map(fn => fn());
  t.after(() => {for (const c of cleanups.reverse()) c?.(); if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;});
  const fire = (name, over = {}) => {
    const handler = walk(render()).find(n => n.props?.className === 'fl-flow').props[name];
    assert.equal(typeof handler, 'function', `canvas exposes ${name}`);
    const e = {pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 100, clientY: 100,
      target: {closest: () => null}, currentTarget: canvas, prevented: 0, stopped: 0,
      preventDefault() {this.prevented++;}, stopPropagation() {this.stopped++;}, ...over};
    handler(e); return e;
  };
  return {fire, canvas, captured, win, pan: () => rt.states[1], blur: () => win.listeners.blur?.forEach(f => f())};
}

test('pointerdown blocks native text selection, keeps focus, captures the pointer', t => {
  const f = mount(t);
  const e = f.fire('onPointerDown');
  assert.equal(e.prevented, 1, 'preventDefault at gesture start stops the browser selection');
  assert.equal(f.canvas.dataset.drag, 'true');
  assert.equal(f.canvas.focused, 1, 'keyboard focus preserved despite preventDefault');
  assert.ok(f.captured.has(1), 'pointer captured');
});

test('toolbar buttons and non-primary buttons never start a pan', t => {
  const f = mount(t);
  const onButton = f.fire('onPointerDown', {target: {closest: sel => sel === 'button' ? {} : null}});
  assert.equal(onButton.prevented, 0); assert.equal(f.canvas.dataset.drag, undefined); assert.equal(f.captured.size, 0);
  const rightClick = f.fire('onPointerDown', {button: 2});
  assert.equal(rightClick.prevented, 0); assert.equal(f.canvas.dataset.drag, undefined);
});

test('drag pans; pointerup ends it, releases capture, and later moves do not pan', t => {
  const f = mount(t);
  f.fire('onPointerDown');
  f.fire('onPointerMove', {clientX: 140, clientY: 110});
  assert.deepEqual(f.pan(), {x: 48, y: 18}, 'pan follows the pointer');
  f.fire('onPointerUp');
  assert.equal(f.canvas.dataset.drag, 'false');
  assert.equal(f.captured.size, 0, 'capture released on release');
  const settled = f.pan();
  f.fire('onPointerMove', {clientX: 400, clientY: 400});
  assert.deepEqual(f.pan(), settled, 'no ghost pan after release');
});

test('the click trailing a real drag is suppressed once; the next click passes', async t => {
  const f = mount(t);
  f.fire('onPointerDown'); f.fire('onPointerMove', {clientX: 160}); f.fire('onPointerUp');
  const trailing = f.fire('onClickCapture');
  assert.equal(trailing.stopped, 1); assert.equal(trailing.prevented, 1);
  await tick();
  const next = f.fire('onClickCapture');
  assert.equal(next.stopped, 0, 'node clicks work again after the drag');
});

test('a plain click without movement is never suppressed', t => {
  const f = mount(t);
  f.fire('onPointerDown'); f.fire('onPointerUp');
  const click = f.fire('onClickCapture');
  assert.equal(click.stopped, 0); assert.equal(click.prevented, 0);
});

test('pointercancel ends the drag; later moves do not pan and clicks recover', async t => {
  const f = mount(t);
  f.fire('onPointerDown'); f.fire('onPointerMove', {clientX: 160});
  f.fire('onPointerCancel');
  assert.equal(f.canvas.dataset.drag, 'false'); assert.equal(f.captured.size, 0);
  const settled = f.pan();
  f.fire('onPointerMove', {clientX: 400});
  assert.deepEqual(f.pan(), settled);
  await tick();
  assert.equal(f.fire('onClickCapture').stopped, 0, 'cancel has no trailing click; suppression clears');
});

test('lostpointercapture ends the drag', t => {
  const f = mount(t);
  f.fire('onPointerDown'); f.fire('onPointerMove', {clientX: 160});
  f.fire('onLostPointerCapture');
  assert.equal(f.canvas.dataset.drag, 'false');
  const settled = f.pan();
  f.fire('onPointerMove', {clientX: 400});
  assert.deepEqual(f.pan(), settled);
});

test('window blur mid-drag ends the drag; listener is cleaned up on unmount', t => {
  const f = mount(t);
  f.fire('onPointerDown'); f.fire('onPointerMove', {clientX: 160});
  assert.equal(f.win.listeners.blur.length, 1);
  f.blur();
  assert.equal(f.canvas.dataset.drag, 'false'); assert.equal(f.captured.size, 0);
  const settled = f.pan();
  f.fire('onPointerMove', {clientX: 400});
  assert.deepEqual(f.pan(), settled);
});

test('a move with the primary button already released self-heals without panning', t => {
  const f = mount(t);
  f.fire('onPointerDown'); f.fire('onPointerMove', {clientX: 160});
  const settled = f.pan();
  f.fire('onPointerMove', {clientX: 300, buttons: 0}); // missed pointerup
  assert.equal(f.canvas.dataset.drag, 'false', 'stale drag exits immediately');
  assert.deepEqual(f.pan(), settled, 'the healing move itself must not pan');
  f.fire('onPointerMove', {clientX: 500, buttons: 1});
  assert.deepEqual(f.pan(), settled, 'no ghost pan afterwards');
});

test('events from another pointer never move or end the active drag', t => {
  const f = mount(t);
  f.fire('onPointerDown', {pointerId: 1});
  const before = f.pan();
  f.fire('onPointerMove', {pointerId: 2, clientX: 400});
  assert.deepEqual(f.pan(), before);
  f.fire('onPointerUp', {pointerId: 2});
  assert.equal(f.canvas.dataset.drag, 'true', 'foreign pointerup does not end the drag');
  f.fire('onPointerMove', {pointerId: 1, clientX: 140});
  assert.equal(f.pan().x, before.x + 40);
  f.fire('onPointerUp', {pointerId: 1});
  assert.equal(f.canvas.dataset.drag, 'false');
});

test('a second finger while panning is ignored, not restarted', t => {
  const f = mount(t);
  f.fire('onPointerDown', {pointerId: 1});
  const second = f.fire('onPointerDown', {pointerId: 2, clientX: 300});
  assert.equal(second.prevented, 0);
  f.fire('onPointerMove', {pointerId: 1, clientX: 140});
  assert.equal(f.pan().x, 48, 'original drag anchor preserved');
});

test('canvas CSS opts out of selection and native touch gestures, scoped to the shell', () => {
  const rule = fleetStyles.match(/\.dsh-fleet-shell \.fl-flow \{[^}]*\}/g)?.find(r => r.includes('height:560px'));
  assert.ok(rule, 'canvas rule present');
  assert.match(rule, /user-select:none/);
  assert.match(rule, /-webkit-user-select:none/);
  assert.match(rule, /touch-action:none/);
  assert.ok(!/\.dsh-fleet-shell \.fl-card-pad \{[^}]*user-select:none/.test(fleetStyles), 'ticket prose stays selectable');
});