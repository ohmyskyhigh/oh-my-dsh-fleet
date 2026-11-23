import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshAdapter, adapterInject } from '../src/fleet-dsh-adapter.js';

// Shapes copied from runtime-evidence dsh-agent-loop and dsh-api-session-controller.
// user/message data is the message itself, never {turn, message}.
const text = value => [{ type: 'text', text: value }];
const user = (rpcId, id = `msg-${rpcId}`) => ({ id, role: 'user', content: text(`input ${rpcId}`), source: { kind: 'user', rpcId } });
const event = (type, data) => ({ type, data, ...(['user/message', 'assistant/message'].includes(type) ? { surfaceOp: 'append' } : {}) });
const start = turn => event('turn/start', { turn });
const step = (turn, n = 1) => event('step/start', { turn, step: n });
const end = (turn, kind = 'completed', extra = {}) => event('turn/end', { turn, reason: { kind, ...extra } });
const admitted = requestId => event('user/message', user(requestId));
const answer = (turn, value, n = 1, extra = {}) => event('assistant/message', { turn, step: n, message: { id: `assistant-${turn}-${n}`, role: 'assistant', content: text(value), source: { provider: 'fixture', model: 'fixture' } }, stream: [], ...extra });
const splice = (target, start, inserted, extra = {}) => event('agent/inbox/spliced', { target, start, inserted, ...extra });
const queued = (rpcId, target = 'next-turn') => splice(target, 0, [user(rpcId)]);
const claim = (target = 'next-turn') => splice(target, 0, [], { removedCount: 1 });
const done = (requestId, turn = 1, value = 'done') => [queued(requestId), start(turn), claim(), step(turn), admitted(requestId), answer(turn, value), end(turn)];
function fixture(initial = []) {
  const events = [...initial];
  const calls = { prompts: [], creates: [], reads: [], cancels: [], resolves: [], agentResolves: [], wakes: [] };
  let readError, promptHook, cancelHook, inheritedEventCount = 0;
  const agent = {
    id: 'session-1',
    status: 'idle',
    async cancel(...args) { calls.cancels.push(args); if (cancelHook) await cancelHook(); },
    async whenIdle() { agent.status = 'idle'; },
    wakeDriver() { calls.wakes.push(agent.id); agent.status = 'running'; }
  };
  const ctx = {
    sessionQuery: { async readSession(sessionId) {
      calls.reads.push(sessionId);
      if (readError) throw readError;
      return { session: { id: sessionId }, inheritedEventCount, events: events.map((row, index) => ({ seq: index, time: index, ...row })) };
    } },
    sessionController: {
      async create(request) { calls.creates.push(request); return { sessionId: 'session-1', agentPreset: request.agentPreset }; },
      async resolveAgent(sessionId) {
        calls.agentResolves.push(sessionId);
        return sessionId === 'session-1' ? { agent } : { error: Object.assign(new Error('Session not found'), { code: 'session/not-found' }) };
      },
      async prompt(request, signal) {
        assert.ok(signal instanceof AbortSignal, 'a fresh AbortSignal is mandatory');
        assert.equal(signal.aborted, false);
        calls.prompts.push({ request, signal });
        if (promptHook) return promptHook(request, signal);
        events.push(queued(request.requestId, request.mode === 'steer' ? 'next-step' : 'next-turn'));
        return { accepted: true };
      },
      cancel() { throw new Error('Controller cancel retains inbox and must not be called'); }
    },
    agents: { get(id) { return id === 'session-1' ? agent : undefined; } },
    agentPresets: { async resolve(id) {
      calls.resolves.push(id);
      if (id === 'missing') throw Object.assign(new Error('Unknown agent preset: missing'), { code: 'agent-preset/not-found' });
      return { id, ...(id === 'broken' ? { broken: 'provider missing' } : {}) };
    }, mount() { throw new Error('Controller owns mounting'); } }
  };
  return { ctx, events, calls, agent, adapter: createDshAdapter(ctx),
    set readError(value) { readError = value; }, set promptHook(value) { promptHook = value; },
    set cancelHook(value) { cancelHook = value; }, set inherited(value) { inheritedEventCount = value; } };
}
const inspect = (f, requestId = 'request-1', includeFollowups = false) => f.adapter.inspect({ sessionId: 'session-1', requestId, includeFollowups });
const submit = (f, requestId = 'request-1', prompt = 'work') => f.adapter.submit({ sessionId: 'session-1', requestId, prompt });

test('service injection and controller preset creation preserve business fields', async () => {
  assert.deepEqual(adapterInject, ['sessionController', 'sessionQuery', 'agents', 'agentPresets', 'agentDefaultModel']);
  const f = fixture();
  assert.deepEqual(await f.adapter.create({ workspaceId: 'workspace', requestId: 'create-1', profile: { agentPreset: 'worker', instructions: 'supplied by service', role: 'reviewer', description: 'metadata' } }), { sessionId: 'session-1' });
  assert.deepEqual(f.calls.creates, [{ workspaceId: 'workspace', agentPreset: 'worker' }]);
  assert.deepEqual(f.calls.resolves, ['worker']);
  await f.adapter.create({ workspaceId: 'workspace' });
  assert.deepEqual(f.calls.creates[1], { workspaceId: 'workspace' });
});

test('unknown, broken and unavailable presets fail before creating', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.create({ workspaceId: 'workspace', profile: { agentPreset: 'missing' } }), /Unknown agent preset/);
  await assert.rejects(f.adapter.create({ workspaceId: 'workspace', profile: { agentPreset: 'broken' } }), /provider missing/);
  delete f.ctx.agentPresets;
  await assert.rejects(f.adapter.create({ workspaceId: 'workspace', profile: { agentPreset: 'worker' } }), /registry is unavailable/);
  assert.equal(f.calls.creates.length, 0);
});

test('custom model and parameter overrides fail explicitly, including empty parameters', async () => {
  const f = fixture();
  for (const profile of [{ model: 'custom' }, { parameters: {} }, { provider: 'p' }, { temperature: 0 }, { maxTokens: 100 }, { reasoningEffort: 'high' }]) {
    await assert.rejects(f.adapter.create({ workspaceId: 'workspace', profile }), { code: 'unsupported-profile' });
  }
  assert.equal(f.calls.creates.length, 0);
});

test('idle before submit is unknown; missing request and missing log stay unknown', async () => {
  const f = fixture();
  assert.deepEqual(await inspect(f), { status: 'unknown' });
  assert.deepEqual(await inspect(f, ''), { status: 'unknown' });
  f.readError = new Error('missing durable log');
  assert.deepEqual(await inspect(f), { status: 'unknown', error: 'missing durable log' });
});

test('pending next-turn and next-step are running even while Agent is idle', async () => {
  for (const target of ['next-turn', 'next-step']) {
    assert.deepEqual(await inspect(fixture([queued('request-1', target)])), { status: 'running' });
  }
});

test('completed requires same request, matching completed turn, and assistant output', async () => {
  const f = fixture(done('request-1', 3, 'result'));
  assert.deepEqual(await inspect(f), { status: 'completed', output: { text: 'result', finalText: 'result', sessionId: 'session-1', requestId: 'request-1', turn: 3, messageIds: ['assistant-3-1'] } });
  assert.deepEqual(await inspect(f, 'other-request'), { status: 'unknown' });
  assert.deepEqual(await inspect(fixture([start(1), step(1), admitted('request-1'), end(1)])), { status: 'unknown' });
  assert.deepEqual(await inspect(fixture([start(1), step(1), admitted('request-1'), answer(1, 'partial', 1, { interrupted: true }), end(1)])), { status: 'unknown' });
});

test('finalText contains only the last assistant response while text retains intermediate prose', async () => {
  const finalJson = '{"decision":"passed","evidence":"checks complete"}';
  const f = fixture([
    start(1), step(1), admitted('request-1'), answer(1, '正在检查'),
    event('step/end', { turn: 1, step: 1 }), step(1, 2), answer(1, finalJson, 2), end(1)
  ]);
  const result = await inspect(f);
  assert.equal(result.status, 'completed');
  assert.equal(result.output.text, `正在检查\n\n${finalJson}`);
  assert.equal(result.output.finalText, finalJson);
  assert.deepEqual(JSON.parse(result.output.finalText), { decision: 'passed', evidence: 'checks complete' });
});

test('a textless final assistant preserves empty finalText rather than falling back to earlier prose', async () => {
  const final = answer(1, 'discard fixture text', 2);
  final.data.message.content = [{ type: 'tool-call', id: 'tool-1', name: 'fixture_finish', arguments: {} }];
  const f = fixture([
    start(1), step(1), admitted('request-1'), answer(1, '{"decision":"passed"}'),
    event('step/end', { turn: 1, step: 1 }), step(1, 2), final, end(1)
  ]);
  const result = await inspect(f);
  assert.equal(result.status, 'completed');
  assert.equal(result.output.text, '{"decision":"passed"}');
  assert.equal(result.output.finalText, '');
});

test('later turns and other requests never replace the target output or termination', async () => {
  const f = fixture([...done('request-1', 1, 'target output'), ...done('other', 2, 'wrong output')]);
  assert.equal((await inspect(f)).output.text, 'target output');
  const missing = fixture([start(1), step(1), admitted('request-1'), end(1), ...done('other', 2, 'wrong output')]);
  assert.deepEqual(await inspect(missing), { status: 'unknown' });
  const wrongTurn = fixture([start(1), step(1), admitted('request-1'), answer(2, 'unrelated'), end(1)]);
  assert.deepEqual(await inspect(wrongTurn), { status: 'unknown' });
});

test('followup inspection holds completion while a native user request is queued or running', async () => {
  const f = fixture([...done('request-1', 1, 'original result'), queued('native-followup')]);
  assert.equal((await inspect(f)).output.finalText, 'original result');
  assert.deepEqual(await inspect(f, 'request-1', true), { status: 'running' });
  f.events.push(start(2), claim(), step(2), admitted('native-followup'));
  assert.deepEqual(await inspect(f, 'request-1', true), { status: 'running' });
  assert.equal(f.calls.prompts.length, 0);
  assert.equal(f.calls.agentResolves.length, 0);
});

test('followup completion returns the native request output without changing strict queries', async () => {
  const f = fixture([...done('request-1', 1, 'original result'), ...done('native-followup', 2, 'updated result')]);
  const result = await inspect(f, 'request-1', true);
  assert.equal(result.status, 'completed');
  assert.equal(result.output.requestId, 'native-followup');
  assert.equal(result.output.text, 'updated result');
  assert.equal(result.output.finalText, 'updated result');
  assert.equal((await inspect(f)).output.requestId, 'request-1');
  assert.equal((await inspect(f)).output.finalText, 'original result');
});

test('followups never substitute for missing or inherited-only original request receipts', async () => {
  const f = fixture(done('native-followup', 1, 'unrelated output'));
  assert.deepEqual(await inspect(f, 'request-1', true), { status: 'unknown' });
  const inherited = fixture([...done('request-1', 1, 'inherited'), ...done('native-followup', 2, 'own output')]);
  inherited.inherited = done('request-1').length;
  assert.deepEqual(await inspect(inherited, 'request-1', true), { status: 'unknown' });
});

test('followup failure and inbox cancellation supersede an earlier successful delivery', async () => {
  const failed = fixture([...done('request-1', 1, 'old success'), queued('native-followup'), start(2), claim(), step(2), end(2, 'error', { error: { message: 'followup preparation failed' } })]);
  const result = await inspect(failed, 'request-1', true);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /followup preparation failed/);
  assert.equal(result.output, undefined);
  const canceled = fixture([...done('request-1', 1, 'old success'), queued('native-followup'), splice('next-turn', 0, [], { removedCount: 1, outcome: 'canceled' })]);
  assert.deepEqual(await inspect(canceled, 'request-1', true), { status: 'stopped' });
  assert.equal((await inspect(canceled)).status, 'completed');
});

test('followup selection uses unique first receipts, not delayed admission of older queued inputs', async () => {
  const f = fixture([
    queued('older-request'), splice('next-turn', 1, [user('request-1')]), splice('next-turn', 2, [user('native-followup')]),
    start(1), claim(), step(1), admitted('older-request'), answer(1, 'old work'), end(1),
    start(2), claim(), step(2), admitted('request-1'), answer(2, 'original result'), end(2)
  ]);
  assert.equal((await inspect(f)).output.finalText, 'original result');
  assert.deepEqual(await inspect(f, 'request-1', true), { status: 'running' });
  f.events.push(start(3), claim(), step(3), admitted('native-followup'), answer(3, 'latest result'), end(3));
  assert.equal((await inspect(f, 'request-1', true)).output.requestId, 'native-followup');
});

test('followup receipts require user sources with nonempty RPC IDs and ignore surface replacements', async () => {
  const f = fixture(done('request-1', 1, 'original result'));
  f.events.push(splice('next-step', 0, [
    { ...user('injected'), source: { kind: 'runtime-context', rpcId: 'injected' } },
    { ...user('blank'), source: { kind: 'user', rpcId: ' ' } },
    { ...user('no-id'), source: { kind: 'user' } }
  ]), { ...admitted('replacement-only'), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } });
  const result = await inspect(f, 'request-1', true);
  assert.equal(result.status, 'completed');
  assert.equal(result.output.requestId, 'request-1');
});

test('missing step boundaries, wrong steps, and late assistant settlements stay unknown', async () => {
  for (const rows of [
    [start(1), admitted('request-1'), answer(1, 'missing step'), end(1)],
    [start(1), step(1, 2), admitted('request-1'), answer(1, 'old step', 1), end(1)],
    [start(1), step(1), admitted('request-1'), end(1), answer(1, 'late answer')]
  ]) assert.deepEqual(await inspect(fixture(rows)), { status: 'unknown' });
});

test('steering binds to its later step and excludes all earlier output', async () => {
  const f = fixture([
    start(1), step(1), admitted('original'), answer(1, 'old pass'),
    event('step/end', { turn: 1, step: 1 }), queued('request-1', 'next-step'), claim('next-step'),
    step(1, 2), admitted('request-1'), answer(1, 'new review', 2), end(1)
  ]);
  assert.equal((await inspect(f)).output.text, 'new review');
});

test('claim before user/message records failed prepareCall and blocked pre-step', async () => {
  for (const kind of ['error', 'blocked', 'max-tokens']) {
    const f = fixture([queued('request-1'), start(1), claim(), step(1), end(1, kind, kind === 'error' ? { error: { message: 'prepareCall failed', code: 'MODEL_MISSING' } } : {})]);
    const result = await inspect(f);
    assert.equal(result.status, 'failed');
    assert.match(result.error, kind === 'error' ? /prepareCall failed/ : new RegExp(kind));
    await submit(f);
    assert.equal(f.calls.prompts.length, 0, 'claim-only history must deduplicate');
  }
});

test('steering claim before user fails on current turn and never inherits previous pass', async () => {
  const f = fixture([start(1), step(1), admitted('original'), answer(1, '{"decision":"passed"}'), queued('request-1', 'next-step'), claim('next-step'), step(1, 2), end(1, 'error', { error: { message: 'review model unavailable' } })]);
  const result = await inspect(f);
  assert.equal(result.status, 'failed');
  assert.equal(result.output, undefined);
});

test('error, token limit and blocked beat partial assistant output; aborts are stopped', async () => {
  for (const [kind, expected] of [['error', 'failed'], ['max-tokens', 'failed'], ['blocked', 'failed'], ['aborted', 'stopped'], ['interrupted', 'stopped'], ['forked', 'stopped']]) {
    const f = fixture([start(1), step(1), admitted('request-1'), answer(1, '{"decision":"passed"}'), end(1, kind)]);
    assert.equal((await inspect(f)).status, expected);
    assert.equal((await inspect(f)).output, undefined);
  }
});

test('inbox cancellation uses removed item identity in both queues, preserving unrelated work', async () => {
  const f = fixture([
    splice('next-turn', 0, [user('other'), user('request-1')]), queued('steer', 'next-step'),
    splice('next-turn', 1, [], { removedCount: 1, outcome: 'canceled' }),
    splice('next-step', 0, [], { removedCount: 1, outcome: 'canceled' })
  ]);
  assert.deepEqual(await inspect(f), { status: 'stopped' });
  assert.deepEqual(await inspect(f, 'steer'), { status: 'stopped' });
  assert.deepEqual(await inspect(f, 'other'), { status: 'running' });
  await submit(f);
  assert.equal(f.calls.prompts.length, 0);
});

test('malformed splice, inherited completion, and unrecognized endings never pass', async () => {
  const malformed = fixture([splice('next-turn', 2, [user('request-1')])]);
  assert.equal((await inspect(malformed)).status, 'unknown');
  await assert.rejects(submit(malformed), /Invalid durable inbox/);
  assert.equal(malformed.calls.prompts.length, 0);
  const inherited = fixture(done('request-1'));
  inherited.inherited = inherited.events.length;
  assert.deepEqual(await inspect(inherited), { status: 'unknown' });
  assert.deepEqual(await inspect(fixture([start(1), step(1), admitted('request-1'), answer(1, 'pass'), end(1, 'future-reason')])), { status: 'unknown' });
});

test('submit and message send queue/steer with distinct mandatory signals', async () => {
  const f = fixture();
  assert.deepEqual(await submit(f), { messageId: 'request-1' });
  assert.deepEqual(await f.adapter.message({ sessionId: 'session-1', requestId: 'change-1', text: 'change direction' }), { messageId: 'change-1' });
  assert.deepEqual(f.calls.prompts.map(call => call.request), [
    { sessionId: 'session-1', requestId: 'request-1', content: text('work'), mode: 'queue' },
    { sessionId: 'session-1', requestId: 'change-1', content: text('change direction'), mode: 'steer' }
  ]);
  assert.notEqual(f.calls.prompts[0].signal, f.calls.prompts[1].signal);
});

test('deduplicate concurrent calls, subsequent calls, and adapter restart from durable log', async () => {
  const f = fixture();
  assert.deepEqual(await Promise.all([submit(f), submit(f), submit(f)]), Array(3).fill({ messageId: 'request-1' }));
  await submit(f);
  await createDshAdapter(f.ctx).submit({ sessionId: 'session-1', requestId: 'request-1', prompt: 'work' });
  assert.equal(f.calls.prompts.length, 1);
  await assert.rejects(submit(f, 'request-1', 'different task'), { code: 'request-id-conflict' });
});

test('same-session requests serialize before admission and always read logs first', async () => {
  const f = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.promptHook = async request => {
    if (request.requestId === 'first') { entered(); await gate; }
    return { accepted: true };
  };
  const first = submit(f, 'first');
  const second = submit(f, 'second');
  await started;
  assert.equal(f.calls.prompts.length, 1);
  assert.equal(f.calls.reads.length, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(f.calls.prompts.length, 2);
  assert.equal(f.calls.reads.length, 2);
});

test('uncertain transport failure is not blindly resubmitted, but durable receipt recovers', async () => {
  const f = fixture();
  f.promptHook = async () => { throw new Error('transport broke'); };
  await assert.rejects(submit(f), /transport broke/);
  await assert.rejects(submit(f), { code: 'submission-uncertain' });
  assert.equal(f.calls.prompts.length, 1);
  assert.deepEqual(await inspect(f), { status: 'unknown' });
  f.events.push(queued('request-1'));
  assert.deepEqual(await submit(f), { messageId: 'request-1' });
  assert.equal(f.calls.prompts.length, 1);
});

test('read failures prevent admission; a later successful preflight may submit', async () => {
  const f = fixture();
  f.readError = new Error('storage unavailable');
  await assert.rejects(submit(f), /storage unavailable/);
  assert.equal(f.calls.prompts.length, 0);
  f.readError = undefined;
  await submit(f);
  assert.equal(f.calls.prompts.length, 1);
});

test('await real asynchronous cancellation and verify both inbox queues empty', async () => {
  const f = fixture([queued('request-1'), queued('steer', 'next-step')]);
  f.agent.status = 'running';
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.cancelHook = async () => {
    entered(); await gate;
    f.events.push(splice('next-step', 0, [], { removedCount: 1, outcome: 'canceled' }), splice('next-turn', 0, [], { removedCount: 1, outcome: 'canceled' }));
  };
  let finished = false;
  const stopping = f.adapter.cancel({ sessionId: 'session-1' }).then(value => { finished = true; return value; });
  await started;
  assert.equal(finished, false);
  release();
  assert.deepEqual(await stopping, { stopped: true });
  assert.deepEqual(f.calls.cancels, [[{ kind: 'user' }]]);
  assert.deepEqual(await inspect(f), { status: 'stopped' });
  assert.deepEqual(await inspect(f, 'steer'), { status: 'stopped' });
});

test('empty never-submitted session can stop; retained inbox is not acknowledged stopped', async () => {
  const empty = fixture();
  assert.deepEqual(await empty.adapter.cancel({ sessionId: 'session-1' }), { stopped: true });
  const pending = fixture([queued('request-1')]);
  assert.deepEqual(await pending.adapter.cancel({ sessionId: 'session-1' }), { stopped: false });
  await assert.rejects(empty.adapter.cancel({ sessionId: 'missing' }), { code: 'session/not-found' });
  assert.deepEqual(empty.calls.agentResolves, ['missing'], 'attached sessions do not need resolution');
});

test('cold restart stop resolves the real Agent without sending a prompt, then clears retained inbox', async () => {
  const f = fixture([queued('request-1'), queued('steer', 'next-step')]);
  f.ctx.agents.get = () => undefined;
  f.cancelHook = async () => {
    await Promise.resolve();
    f.events.push(splice('next-step', 0, [], { removedCount: 1, outcome: 'canceled' }), splice('next-turn', 0, [], { removedCount: 1, outcome: 'canceled' }));
  };
  assert.deepEqual(await inspect(f), { status: 'running' });
  assert.deepEqual(f.calls.agentResolves, [], 'inspect never resumes durable pending work');
  assert.deepEqual(await f.adapter.cancel({ sessionId: 'session-1' }), { stopped: true });
  assert.deepEqual(f.calls.agentResolves, ['session-1']);
  assert.deepEqual(f.calls.cancels, [[{ kind: 'user' }]]);
  assert.deepEqual(f.calls.prompts, []);
  assert.deepEqual(await inspect(f), { status: 'stopped' });
});

test('recover wakes an attached pending Agent once without dispatching new input', async () => {
  const f = fixture([queued('request-1')]);
  assert.deepEqual(await f.adapter.recover({ sessionId: 'session-1' }), { sessionId: 'session-1', woke: true });
  assert.deepEqual(await f.adapter.recover({ sessionId: 'session-1' }), { sessionId: 'session-1', woke: false });
  assert.deepEqual(f.calls.wakes, ['session-1']);
  assert.deepEqual(f.calls.agentResolves, []);
  assert.deepEqual(f.calls.creates, []);
  assert.deepEqual(f.calls.prompts, []);
  assert.deepEqual(f.calls.cancels, []);
  assert.deepEqual(f.calls.reads, ['session-1', 'session-1']);
});

test('recover serializes cold reattachment once and leaves durable pending input intact', async () => {
  const f = fixture([queued('request-1')]);
  let attached;
  f.ctx.agents.get = () => attached;
  const resolver = f.ctx.sessionController.resolveAgent;
  f.ctx.sessionController.resolveAgent = async sessionId => {
    const result = await resolver(sessionId);
    attached = result.agent;
    return result;
  };
  const initialEvents = structuredClone(f.events);
  assert.deepEqual(await Promise.all([
    f.adapter.recover({ sessionId: 'session-1' }), f.adapter.recover({ sessionId: 'session-1' })
  ]), [{ sessionId: 'session-1', woke: true }, { sessionId: 'session-1', woke: false }]);
  assert.deepEqual(f.calls.wakes, ['session-1']);
  assert.deepEqual(f.calls.agentResolves, ['session-1']);
  assert.deepEqual(f.calls.creates, []);
  assert.deepEqual(f.calls.prompts, []);
  assert.deepEqual(f.calls.cancels, []);
  assert.deepEqual(f.events, initialEvents);
});

test('recover never wakes empty or canceled inboxes, or a driver already running', async () => {
  for (const f of [fixture(), fixture([queued('request-1'), splice('next-turn', 0, [], { removedCount: 1, outcome: 'canceled' })])]) {
    delete f.agent.wakeDriver;
    assert.deepEqual(await f.adapter.recover({ sessionId: 'session-1' }), { sessionId: 'session-1', woke: false });
    assert.deepEqual(f.calls.wakes, []);
  }
  const running = fixture([queued('request-1')]);
  running.agent.status = 'running';
  delete running.agent.wakeDriver;
  assert.deepEqual(await running.adapter.recover({ sessionId: 'session-1' }), { sessionId: 'session-1', woke: false });
  assert.deepEqual(running.calls.wakes, []);
});

test('recover wakes next-step pending input and fails explicitly when the pinned wake seam is absent', async () => {
  const f = fixture([queued('request-1', 'next-step')]);
  assert.deepEqual(await f.adapter.recover({ sessionId: 'session-1' }), { sessionId: 'session-1', woke: true });
  assert.deepEqual(f.calls.wakes, ['session-1']);
  const unavailable = fixture([queued('request-1')]);
  delete unavailable.agent.wakeDriver;
  await assert.rejects(unavailable.adapter.recover({ sessionId: 'session-1' }), { code: 'recovery-wakeup-unavailable' });
  assert.deepEqual(unavailable.calls.prompts, []);
  assert.deepEqual(unavailable.calls.creates, []);
});

test('recover fails closed when pending inbox evidence is unreadable or malformed', async () => {
  const unreadable = fixture([queued('request-1')]);
  unreadable.readError = new Error('log unavailable');
  await assert.rejects(unreadable.adapter.recover({ sessionId: 'session-1' }), /log unavailable/);
  assert.deepEqual(unreadable.calls.wakes, []);
  const malformed = fixture([splice('next-turn', 9, [user('request-1')])]);
  await assert.rejects(malformed.adapter.recover({ sessionId: 'session-1' }), { code: 'invalid-session-log' });
  assert.deepEqual(malformed.calls.wakes, []);
});

test('recover propagates host errors and validates resolved Agent identity', async () => {
  const f = fixture();
  f.ctx.agents.get = () => undefined;
  const hostError = Object.assign(new Error('session writer is held'), { code: 'session/writer-held' });
  f.ctx.sessionController.resolveAgent = async () => ({ error: hostError });
  await assert.rejects(f.adapter.recover({ sessionId: 'session-1' }), error => error === hostError);
  f.ctx.sessionController.resolveAgent = async () => ({ agent: { ...f.agent, id: 'wrong-session' } });
  await assert.rejects(f.adapter.recover({ sessionId: 'session-1' }), { code: 'agent-identity-mismatch' });
  await assert.rejects(f.adapter.cancel({ sessionId: 'session-1' }), { code: 'agent-identity-mismatch' });
  assert.deepEqual(f.calls.prompts, []);
  assert.deepEqual(f.calls.creates, []);
  assert.deepEqual(f.calls.cancels, []);
});

test('cold resolution preserves stable host errors and reports a missing resolver', async () => {
  const f = fixture();
  f.ctx.agents.get = () => undefined;
  const hostError = Object.assign(new Error('writer held by another process'), { code: 'session/writer-held' });
  f.ctx.sessionController.resolveAgent = async () => ({ error: hostError });
  await assert.rejects(f.adapter.cancel({ sessionId: 'session-1' }), error => error === hostError);
  delete f.ctx.sessionController.resolveAgent;
  await assert.rejects(f.adapter.cancel({ sessionId: 'session-1' }), { code: 'agent-unavailable' });
  assert.equal(f.calls.cancels.length, 0);
  assert.equal(f.calls.prompts.length, 0);
});

test('projects only owned attempt turns, textless steps, safe tool names and concise public reports', async () => {
  const f = fixture([...done('inherited', 0, 'inherited report'), ...done('before', 1, 'unrelated'),
    queued('anchor'), start(2), claim(), step(2), admitted('anchor'),
    event('tool/call', { turn: 2, step: 1, name: 'read', arguments: 'PRIVATE' }),
    event('tool/result', { turn: 2, step: 1, message: { content: text('PRIVATE') } }),
    step(2, 2), answer(2, 'First result\nPRIVATE', 2), end(2),
    ...done('next', 3, 'Final result')]);
  f.inherited = done('inherited', 0).length;
  const inspectProgress = progressAnchor => f.adapter.inspect({ sessionId: 'session-1', requestId: 'anchor', includeFollowups: true, progressAnchor });
  const result = await inspectProgress('anchor');
  assert.equal(result.output.finalText, 'Final result');
  assert.deepEqual(result.progress.map(row => row.text), ['Running', 'Step 1', 'read', 'Step 2', 'First result', 'completed', 'Running', 'Step 1', 'Final result', 'completed']);
  assert.deepEqual(result.progress, (await inspectProgress('anchor')).progress);
  for (const row of result.progress) assert.equal(row.time, new Date(Number(row.id)).toISOString());
  assert.deepEqual((await inspectProgress('inherited')).progress, []);
  assert.deepEqual((await inspectProgress('missing')).progress, []);
});

test('a claimed request that fails before model admission still projects its own terminal status', async () => {
  const f = fixture([queued('anchor'), start(2), claim(), step(2), end(2, 'error', { error: 'private details' })]);
  const result = await f.adapter.inspect({ sessionId: 'session-1', requestId: 'anchor', progressAnchor: 'anchor' });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.progress.map(r => r.text), ['Running', 'Step 1', 'failed']);
});
