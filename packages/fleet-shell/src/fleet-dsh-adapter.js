// DSH host services; preset mounting is owned by sessionController.create.
export const adapterInject = ['sessionController', 'sessionQuery', 'agents', 'agentPresets', 'agentDefaultModel'];

const errorText = value => value instanceof Error ? value.message : typeof value === 'string' ? value : JSON.stringify(value);
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw failure('invalid-input', `${name} must be a non-empty string.`);
}
const matches = (message, requestId) => message?.source?.kind === 'user' && message.source.rpcId === requestId;

/** Fold raw Session events, never Agent.status. A claimed user can fail before user/message. */
function observe(log, requestId, sessionId) {
  if (!Array.isArray(log?.events)) throw failure('invalid-session-log', 'Session query returned no event log.');
  const inherited = log.inheritedEventCount ?? 0;
  if (!Number.isSafeInteger(inherited) || inherited < 0 || inherited > log.events.length) throw failure('invalid-session-log', 'Invalid inherited event count.');
  const queues = { 'next-turn': [], 'next-step': [] };
  let turn, step, requestTurn, after = -1, seen = false, canceled = false, ending;
  let answers = [];
  const bind = (index) => {
    seen = true;
    if (turn === undefined) return;
    if (requestTurn !== undefined && requestTurn !== turn) throw failure('ambiguous-request', 'Request ID occurs in multiple turns.');
    requestTurn = turn;
    after = index;
    answers = [];
    ending = undefined;
    canceled = false;
  };
  for (const [index, event] of log.events.entries()) {
    const data = event?.data;
    const own = index >= inherited;
    switch (event?.type) {
      case 'turn/start':
        turn = data?.turn;
        step = undefined;
        break;
      case 'step/start':
        if (data?.turn === turn) step = data.step;
        break;
      case 'step/end':
        if (data?.turn === turn && data.step === step) step = undefined;
        break;
      case 'agent/inbox/spliced': {
        const queue = queues[data?.target];
        const count = data?.removedCount ?? 0;
        if (!queue || !Array.isArray(data.inserted) || !Number.isSafeInteger(data.start) || data.start < 0 || data.start > queue.length || !Number.isSafeInteger(count) || count < 0 || data.start + count > queue.length) {
          throw failure('invalid-session-log', 'Invalid durable inbox splice.');
        }
        const removed = queue.splice(data.start, count, ...data.inserted);
        const ids = new Set();
        for (const item of [...queues['next-turn'], ...queues['next-step']]) {
          if (typeof item?.id !== 'string' || ids.has(item.id)) throw failure('invalid-session-log', 'Invalid or duplicate inbox message identity.');
          ids.add(item.id);
        }
        if (own && removed.some(item => matches(item, requestId))) {
          seen = true;
          if (data.outcome === 'canceled') canceled = true;
          else if (data.outcome === undefined) bind(index);
        }
        if (own && data.inserted.some(item => matches(item, requestId))) seen = true;
        break;
      }
      case 'user/message':
        // Replacement/compaction surface entries are not new admissions.
        if (own && (event.surfaceOp === undefined || event.surfaceOp === 'append') && matches(data, requestId)) bind(index);
        break;
      case 'assistant/message':
        if (own && requestTurn !== undefined && data?.turn === requestTurn && data.turn === turn && step !== undefined && data.step === step && index > after && data.interrupted !== true && (event.surfaceOp === undefined || event.surfaceOp === 'append') && Array.isArray(data.message?.content)) {
          answers.push({ ...data, index });
        }
        break;
      case 'turn/end':
        if (own && requestTurn !== undefined && data?.turn === requestTurn && index > after) ending = data.reason;
        if (data?.turn === turn) { turn = undefined; step = undefined; }
        break;
      default: break;
    }
  }
  const pending = seen && [...queues['next-turn'], ...queues['next-step']].some(item => matches(item, requestId));
  const result = status => ({ seen, inboxPending: queues['next-turn'].length + queues['next-step'].length > 0, result: { status } });
  if (pending) return result('running');
  if (canceled) return result('stopped');
  if (!seen || requestTurn === undefined) return result('unknown');
  const kind = typeof ending === 'string' ? ending : ending?.kind;
  if (['aborted', 'interrupted', 'forked'].includes(kind)) return result('stopped');
  if (['error', 'max-tokens', 'blocked'].includes(kind)) return { seen, result: { status: 'failed', error: errorText(ending?.error ?? `DSH turn ended: ${kind}`) } };
  if (kind === 'completed') {
    if (!answers.length) return result('unknown');
    const textBlocks = answer => answer.message.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text);
    const text = answers.flatMap(textBlocks).join('\n\n');
    // Preserve the final response separately so intermediate tool-step prose cannot corrupt review JSON.
    // An empty final response stays empty; do not substitute an earlier statement.
    const finalText = textBlocks(answers.at(-1)).join('\n\n');
    return { seen, result: { status: 'completed', output: { text, finalText, sessionId, requestId, turn: requestTurn, messageIds: answers.map(answer => answer.message.id).filter(Boolean) } } };
  }
  // An unrecognized ending is evidence of neither success nor ongoing execution.
  return result(ending === undefined && turn === requestTurn ? 'running' : 'unknown');
}

/** Latest distinct user request first received after the anchor, within this Session's own log. */
function latestFollowup(log, requestId) {
  const ids = new Set();
  for (const event of log.events.slice(log.inheritedEventCount ?? 0)) {
    const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted
      : event.type === 'user/message' && (event.surfaceOp === undefined || event.surfaceOp === 'append') ? [event.data] : [];
    for (const message of messages) {
      const source = message?.source;
      if (source?.kind === 'user' && typeof source.rpcId === 'string' && source.rpcId.trim()) ids.add(source.rpcId);
    }
  }
  // Set insertion order preserves first receipt: a later admission of an older queued request
  // must not displace a newer queued/steering request. An absent anchor grants no followup scope.
  return ids.has(requestId) ? [...ids].at(-1) : requestId;
}

function reportPreview(blocks) {
  for (const block of blocks ?? []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    const line = block.text.trim().split(/\r?\n/, 1)[0].trim();
    if (!line || /^(?:```|~~~|[\[{<])/.test(line)) continue;
    return line.length > 240 ? `${line.slice(0, 239)}…` : line;
  }
}

// This Session belongs to one attempt. Its first dispatch anchors subsequent admitted followups.
function progressOf(log, anchor) {
  let turn, step, turnStart, stepStart, admitted = false, anchored = false;
  const items = [], stepTools = new Set();
  const queues = { 'next-step': [], 'next-turn': [] };
  function admit(messages) {
    if (turn === undefined) return;
    const users = messages.filter(message => message?.source?.kind === 'user' && message.source.rpcId);
    if (!users.length) return;
    if (users.some(message => matches(message, anchor))) anchored = true;
    if (!anchored || admitted) return;
    admitted = true;
    add(turnStart, 'status', 'Running', { status: 'running' });
    if (stepStart) add(stepStart, 'step', `Step ${step}`, { step });
  }
  function add(event, intent, text, fields) {
    if (!Number.isSafeInteger(event?.seq) || !Number.isFinite(event.time)) return;
    const date = new Date(event.time);
    if (Number.isFinite(date.getTime())) items.push({ id: String(event.seq), time: date.toISOString(), intent, text, ...fields });
  }
  for (const [index, event] of log.events.entries()) {
    const data = event.data ?? {};
    const own = index >= (log.inheritedEventCount ?? 0);
    // Replay inherited queue state for splice indices, but only this Session's own claims admit work.
    if (event.type === 'agent/inbox/spliced') {
      const removed = queues[data.target].splice(data.start, data.removedCount ?? 0, ...data.inserted);
      if (own && data.outcome === undefined) admit(removed);
      continue;
    }
    if (!own) continue;
    switch (event.type) {
      case 'turn/start':
        turn = data.turn; turnStart = event; step = stepStart = undefined; admitted = false;
        break;
      case 'step/start':
        if (turn === undefined || data.turn !== turn) break;
        step = data.step; stepStart = event; stepTools.clear();
        if (admitted) add(event, 'step', `Step ${step}`, { step });
        break;
      case 'user/message':
        if (!event.surfaceOp || event.surfaceOp === 'append') admit([data]);
        break;
      case 'assistant/message': {
        if (!admitted || data.turn !== turn || step === undefined || data.step !== step || data.interrupted || (event.surfaceOp && event.surfaceOp !== 'append')) break;
        const text = reportPreview(data.message?.content);
        if (text) add(event, 'execution', text, { step });
        break;
      }
      case 'tool/call':
        if (admitted && turn === data.turn && step !== undefined && step === data.step && /^[\w.:-]{1,100}$/.test(data.name ?? '') && !stepTools.has(data.name) && stepTools.size < 3) {
          stepTools.add(data.name);
          add(event, 'step', data.name, { step, tool: data.name });
        }
        break;
      case 'step/end':
        if (data.turn === turn && data.step === step) step = stepStart = undefined;
        break;
      case 'turn/end': {
        if (turn === undefined || data.turn !== turn) break;
        const kind = data.reason?.kind ?? data.reason;
        const status = kind === 'completed' ? 'completed' : ['aborted', 'interrupted', 'forked'].includes(kind) ? 'stopped' : ['blocked', 'max-tokens', 'error'].includes(kind) ? 'failed' : undefined;
        if (admitted && status) add(event, 'status', status, { status });
        admitted = false; turn = step = stepStart = undefined;
        break;
      }
    }
  }
  return items;
}

/** Bridge Fleet's durable dispatch IDs to DSH's source.rpcId. Instructions are supplied by FleetService. */
export function createDshAdapter(ctx) {
  const chains = new Map();
  const requests = new Map();
  // P-50: read-default → selectModel → restore-default must not interleave across dispatches,
  // because host selectModel also saves the selection as the global default in the background.
  let selectionChain = Promise.resolve();
  function serial(sessionId, operation) {
    const task = (chains.get(sessionId) ?? Promise.resolve()).then(operation);
    const settled = task.catch(() => {});
    chains.set(sessionId, settled);
    settled.then(() => { if (chains.get(sessionId) === settled) chains.delete(sessionId); });
    return task;
  }
  async function resolveAgent(sessionId) {
    let agent = ctx.agents.get(sessionId);
    if (!agent && typeof ctx.sessionController.resolveAgent === 'function') {
      // Reattach the persisted Session through DSH; never create a Session or resend input.
      const resolved = await ctx.sessionController.resolveAgent(sessionId);
      if (resolved?.error !== undefined) throw resolved.error;
      agent = resolved?.agent;
    }
    if (!agent) throw failure('agent-unavailable', `Session ${sessionId} has no Agent available.`);
    if (agent.id !== sessionId) throw failure('agent-identity-mismatch', `Resolved Agent does not match Session ${sessionId}.`);
    return agent;
  }
  async function read(sessionId, requestId, includeFollowups = false, progressAnchor) {
    const log = await ctx.sessionQuery.readSession(sessionId);
    const original = observe(log, requestId, sessionId);
    const latest = includeFollowups && original.seen ? latestFollowup(log, requestId) : requestId;
    const observation = latest === requestId ? original : observe(log, latest, sessionId);
    if (progressAnchor) observation.result.progress = progressOf(log, progressAnchor);
    return observation;
  }
  function send({ sessionId, requestId, text }, mode) {
    required(sessionId, 'sessionId'); required(requestId, 'requestId'); required(text, 'prompt');
    const key = JSON.stringify([sessionId, requestId]);
    let record = requests.get(key);
    if (record && (record.text !== text || record.mode !== mode)) return Promise.reject(failure('request-id-conflict', 'Request ID already belongs to different content or delivery mode.'));
    if (record?.inflight) return record.inflight;
    if (!record) { record = { text, mode, attempted: false, accepted: false }; requests.set(key, record); }
    const task = serial(sessionId, async () => {
      // Even cancellation/claim-only logs count as existing submissions.
      const observed = await read(sessionId, requestId);
      if (observed.seen || record.accepted) return { messageId: requestId };
      if (record.attempted) throw failure('submission-uncertain', `Request ${requestId} has an uncertain admission; inspect or explicitly retry with a new request ID.`);
      record.attempted = true;
      const response = await ctx.sessionController.prompt({ sessionId, requestId, content: [{ type: 'text', text }], mode }, new AbortController().signal);
      if (response?.accepted !== true) throw failure('submission-uncertain', 'DSH did not confirm prompt admission.');
      record.accepted = true;
      return { messageId: requestId };
    });
    record.inflight = task;
    task.then(() => { record.inflight = undefined; }, () => { record.inflight = undefined; });
    return task;
  }
  const unavailable = 'Host schedule service is unavailable; scheduling cannot be enabled.';
  async function scheduleCall(method, request) {
    const schedule = ctx.get?.('schedule');
    if (typeof schedule?.[method] !== 'function') throw failure('unsupported-profile', unavailable);
    try { return JSON.parse(JSON.stringify(await schedule[method](request))); }
    catch (error) {
      if (error.name === 'ScheduleInputError' || ['invalid_prompt','invalid_selector','invalid_rule','invalid_time_zone','not_future','frequency_too_high','time_out_of_range','subagent_session'].includes(error.code)) throw failure('invalid-input', error.message);
      throw error;
    }
  }
  return {
    scheduleStatus() { return ctx.get?.('schedule') ? {available:true} : {available:false, unavailableReason:unavailable}; },
    scheduleCreate: request => scheduleCall('create', request),
    scheduleEdit: request => scheduleCall('edit', request),
    scheduleView: request => scheduleCall('view', request),
    scheduleHistory: request => ctx.get?.('schedule')?.history ? scheduleCall('history', request) : Promise.resolve({records:[]}),
    async create({ workspaceId, profile = {}, title, modelSelection }) {
      required(workspaceId, 'workspaceId');
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw failure('invalid-profile', 'profile must be an object.');
      for (const key of ['model', 'provider', 'parameters', 'temperature', 'maxTokens', 'reasoningEffort']) {
        if (profile[key] !== undefined) throw failure('unsupported-profile', `Custom profile.${key} is not supported by this adapter; use profile.modelSelection or an agentPreset instead.`);
      }
      if (modelSelection !== undefined) {
        if (!modelSelection || typeof modelSelection !== 'object' || Array.isArray(modelSelection)) throw failure('unsupported-profile', 'modelSelection must be an object.');
        for (const key of ['provider', 'model']) if (typeof modelSelection[key] !== 'string' || !modelSelection[key].trim()) throw failure('unsupported-profile', `modelSelection.${key} must be nonempty text.`);
        if (modelSelection.reasoningEffort !== undefined && (typeof modelSelection.reasoningEffort !== 'string' || !modelSelection.reasoningEffort.trim())) throw failure('unsupported-profile', 'modelSelection.reasoningEffort must be nonempty text.');
        if (typeof ctx.sessionController.selectModel !== 'function' || typeof ctx.agentDefaultModel?.currentSelection !== 'function' || typeof ctx.agentDefaultModel?.saveSelection !== 'function') {
          throw failure('unsupported-profile', 'Host model selection services are unavailable; cannot apply modelSelection.');
        }
      }
      const request = { workspaceId };
      if (profile.agentPreset !== undefined) {
        required(profile.agentPreset, 'profile.agentPreset');
        if (!ctx.agentPresets?.resolve) throw failure('preset-unavailable', 'The DSH agent preset registry is unavailable.');
        const preset = await ctx.agentPresets.resolve(profile.agentPreset);
        if (!preset || preset.id !== profile.agentPreset) throw failure('unknown-preset', `Unknown agent preset: ${profile.agentPreset}`);
        if (preset.broken !== undefined) throw failure('invalid-preset', `Agent preset ${preset.id}: ${errorText(preset.broken)}`);
        // Controller mounts via agentPresets.mount(agentCtx, id) before publishing.
        request.agentPreset = preset.id;
      }
      const created = await ctx.sessionController.create(request);
      required(created?.sessionId, 'created sessionId');
      if (title && typeof ctx.sessionController.rename === 'function') await ctx.sessionController.rename({ sessionId: created.sessionId, title });
      let defaultRestoreError;
      if (modelSelection !== undefined) {
        const operation = selectionChain.catch(() => {}).then(async () => {
          const previous = ctx.agentDefaultModel.currentSelection();
          try {
            await ctx.sessionController.selectModel({ sessionId: created.sessionId, provider: modelSelection.provider, model: modelSelection.model, ...(modelSelection.reasoningEffort !== undefined ? { reasoningEffort: modelSelection.reasoningEffort } : {}) });
          } catch (error) { throw failure('model-selection-failed', `Applying modelSelection to ${created.sessionId} failed: ${errorText(error)}`); }
          // Fleet never keeps the user's global default changed; restoration is best-effort after the session selection landed.
          try { await ctx.agentDefaultModel.saveSelection(previous); }
          catch (error) { defaultRestoreError = errorText(error); }
        });
        selectionChain = operation.catch(() => {});
        await operation;
      }
      return { sessionId: created.sessionId, ...(defaultRestoreError !== undefined ? { defaultRestoreError } : {}) };
    },
    /** P-50 read-only host model catalog: default selection, provider groups, efforts and failures. */
    async modelCatalog() {
      if (typeof ctx.sessionController.modelCatalog !== 'function') throw failure('model-catalog-unavailable', 'The DSH session controller exposes no model catalog.');
      return ctx.sessionController.modelCatalog();
    },
    recover({ sessionId }) {
      required(sessionId, 'sessionId');
      return serial(sessionId, async () => {
        const agent = await resolveAgent(sessionId);
        const observed = await read(sessionId, Symbol('recovery-verification'));
        let woke = false;
        if (agent.status === 'idle' && observed.inboxPending === true) {
          // Pinned DSH 0.2.1-rc.5 loop seam: run existing inbox entries with their original IDs.
          // wakeDriver opens a turn even for an empty inbox, so validate durable pending first.
          if (typeof agent.wakeDriver !== 'function') throw failure('recovery-wakeup-unavailable', `Session ${sessionId} has pending input but its Agent exposes no wakeDriver.`);
          await agent.wakeDriver();
          woke = true;
        }
        return { sessionId: agent.id, woke };
      });
    },
    submit({ sessionId, requestId, prompt }) { return send({ sessionId, requestId, text: prompt }, 'queue'); },
    message({ sessionId, requestId, text }) { return send({ sessionId, requestId, text }, 'steer'); },
    // Cold durable pending work is reported as running evidence, never resumed or re-submitted here.
    async inspect({ sessionId, requestId, includeFollowups = false, progressAnchor }) {
      required(sessionId, 'sessionId');
      if (typeof requestId !== 'string' || !requestId.trim()) return { status: 'unknown' };
      try { return (await read(sessionId, requestId, includeFollowups === true, progressAnchor)).result; }
      catch (error) { return { status: 'unknown', error: errorText(error) }; }
    },
    cancel({ sessionId }) {
      required(sessionId, 'sessionId');
      return serial(sessionId, async () => {
        const agent = await resolveAgent(sessionId);
        if (typeof agent.cancel !== 'function') throw failure('agent-unavailable', `Session ${sessionId} has no Agent available to stop.`);
        // A lazy Agent may return a Promise here. No keepInbox option: clear both queues.
        await agent.cancel({ kind: 'user' });
        if (typeof agent.whenIdle === 'function') await agent.whenIdle();
        const observed = await read(sessionId, Symbol('stop-verification'));
        return { stopped: agent.status === 'idle' && observed.inboxPending === false };
      });
    }
  };
}
