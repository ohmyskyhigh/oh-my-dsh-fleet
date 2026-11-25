// Native Chat contract tests: fake registries and a real persisted FleetService slice.
// No live DSH Sessions, model calls or production configuration are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerFleetChat, fleetHelp } from '../src/fleet-chat.js';
import { FleetService } from '../src/fleet-service.js';
import { normalizePlan, projectTicket } from '../src/fleet-model.js';

const agent = Object.freeze({ identity: 'actual-dsh-agent' });
const actualContext = { workspaceId: 'actual-workspace', workspacePath: path.resolve('chat-fixture-workspace'), sessionId: 'actual-session' };
const scheduleArgs = { ticketId: 'ticket', expectedRevision: 2, name: 'Weekly build', kind: 'weekly', time: '09:30', timeZone: 'Asia/Shanghai', weekdays: [1, 5] };
const scheduleResult = { seriesId: 'series', scheduleId: 'schedule', sourceTicketId: 'ticket', revision: 1, status: 'active', timing: { kind: 'weekly', weekly: { time: '09:30:00', time_zone: 'Asia/Shanghai', weekdays: [1, 5] } }, scheduledAt: '2030-01-04T01:30:00.000Z' };
const exampleTicket = () => {
  const plan = normalizePlan({goal:'Test Ticket',agents:{builder:{profile:{instructions:'Build'}}},nodes:[{id:'build',agentId:'builder',dependsOn:[],task:{prompt:'Build'}}]});
  return {id:'ticket',status:'running',plan,activity:[],execution:{currentConfigRevision:1,configurations:{1:{plan,configRevision:1}},nodes:{build:{id:'build',status:'running',attempts:[{id:'attempt',sessionId:'execution-session',status:'running',configRevision:1}],thread:[{id:'message',text:'working'}]}},gates:{}}};
};
function harness(options = {}) {
  const tools = new Map(), commands = new Map(), calls = [], disposals = [], definitions = [];
  const invoke = (method, value) => async (...args) => { calls.push({ method, args }); return typeof value === 'function' ? value(...args) : structuredClone(value); };
  const service = options.service ?? {
    registerWorkspace: invoke('registerWorkspace', undefined),
    ownsSession: invoke('ownsSession', options.owned ?? false),
    catalog: invoke('catalog', { agents: [{ id: 'shared-agent' }], orchestrations: [{ id: 'shared-flow' }], workspaces: [] }),
    saveDraftTicket: invoke('saveDraftTicket', { id: 'draft', status: 'draft', revision: 1, workspaceId: actualContext.workspaceId }),
    listDraftTickets: invoke('listDraftTickets', []),
    readSeries: invoke('readSeries', []),
    saveDraftWithScope: invoke('saveDraftWithScope', { id: 'draft', revision: 2 }),
    read: invoke('read', (_ws, id) => id ? exampleTicket() : [exampleTicket()]),
    human: invoke('human', (_ws, _user, action, args) => ({ action, args })),
    submitEvidence: invoke('submitEvidence', { artifacts: [], completion: { evidenceKind: 'agent-report' } }),
    agentStart: invoke('agentStart', (_ws, _sid, id) => projectTicket({ id, workspaceId: actualContext.workspaceId, originSessionId: actualContext.sessionId, status: 'draft', revision: 2, plan: normalizePlan({ goal: 'Test Ticket' }), execution: null, activity: [] })),
    agentStop: invoke('agentStop', (_ws, _sid, id) => projectTicket({ id, workspaceId: actualContext.workspaceId, originSessionId: actualContext.sessionId, status: 'stop-requested', revision: 3, plan: normalizePlan({ goal: 'Test Ticket' }), execution: null, activity: [] })),
    agentSchedule: invoke('agentSchedule', scheduleResult),
    health: { ready: true, error: null },
  };
  const register = (registry, type) => definition => {
    assert.equal(registry.has(definition.name), false);
    registry.set(definition.name, definition);
    return () => { disposals.push(`${type}:${definition.name}`); registry.delete(definition.name); };
  };
  const ctx = { tools: { register: register(tools, 'tool') }, commands: { register: register(commands, 'command') } };
  if (options.presets !== undefined) ctx.agentPresets = options.presets;
  const dispose = registerFleetChat(ctx, {
    defineTool: definition => { definitions.push(definition); return definition; },
    getService: options.getService ?? (async () => { calls.push({ method: 'getService', args: [] }); return service; }),
    resolveAgentContext: options.resolveAgentContext ?? (async value => { calls.push({ method: 'resolveAgentContext', args: [value] }); return structuredClone(actualContext); }),
    createUserMessage: value => value,
  });
  return {
    tools, commands, calls, disposals, definitions, service, dispose,
    tool(name, args = {}, exec = {}) { return tools.get(name).execute(args, { agent, ...exec }); },
    command(rawInput, extra = {}) { return commands.get('fleet').handler({ agent, rawInput, ...extra }); },
  };
}
const callsOf = (h, method) => h.calls.filter(c => c.method === method);
const parsed = result => { assert.deepEqual(Object.keys(result), ['text']); assert.equal(typeof result.text, 'string'); return JSON.parse(result.text); };

const controls = [
  ['start ticket', 'start', ['ticket']],
  ['stop ticket', 'stop', ['ticket']],
  ['resume ticket', 'resume', ['ticket']],
  ['pass ticket quality', 'forcePassGate', ['ticket', 'quality']],
  ['retry ticket build Human retry reason', 'retryNode', ['ticket', 'build', 'Human retry reason']],
  ['say ticket build Human discussion', 'commentNode', ['ticket', 'build', 'Human discussion']],
  ['review ticket quality passed Artifact verified', 'reviewGate', ['ticket', 'quality', 'passed', 'Artifact verified']],
  ['review ticket quality returned Missing tests', 'reviewGate', ['ticket', 'quality', 'returned', 'Missing tests']],
  ['change ticket build 2 {"prompt":"new task","nested":{"version":2}}', 'changeNode', ['ticket', 'build', { prompt: 'new task', nested: { version: 2 } }, 'User /fleet change: {"prompt":"new task","nested":{"version":2}}', 2]],
  ['root-agent shared-agent {"instructions":"new root"}', 'replaceRootAgent', ['shared-agent', { instructions: 'new root' }]],
  ['root-flow shared-flow {"nodes":[{"id":"build","role":"builder"}]}', 'replaceRootOrchestration', ['shared-flow', { nodes: [{ id: 'build', role: 'builder' }] }]],
];

for (const [command, method, args] of controls) test(`native /fleet ${method} is attributed to the actual Session user path`, async () => {
  const h = harness({ owned: true });
  const result = await h.command(` \t${command}\n `);
  assert.equal(result.kind, 'success');
  assert.deepEqual(callsOf(h, 'human'), [{ method: 'human', args: [actualContext.workspaceId, `dsh-command:${actualContext.sessionId}`, method, args] }]);
  assert.deepEqual(callsOf(h, 'registerWorkspace')[0].args, [actualContext.workspaceId, actualContext.workspacePath]);
  assert.equal(callsOf(h, 'ownsSession').length, 0, 'actual user commands retain human controls even inside execution Sessions');
  assert.deepEqual(JSON.parse(result.text), { action: method, args });
});

test('Agent registry exposes the eight Fleet tools with canonical text schema/render', async () => {
  const h = harness({ presets: { list: async () => [{ id: 'preset' }] } });
  assert.deepEqual(new Set(h.tools.keys()), new Set(['fleet_catalog', 'fleet_status', 'fleet_thread', 'fleet_submit', 'fleet_start', 'fleet_stop', 'fleet_admin', 'fleet_draft', 'fleet_schedule']));
  assert.equal(h.tools.has('fleet_prepare'), false, 'the prepare bypass is removed');
  assert.deepEqual([...h.commands.keys()], ['fleet']);
  for (const forbidden of ['fleet_resume', 'fleet_retry', 'fleet_pass', 'fleet_review', 'fleet_change', 'fleet_root_agent', 'fleet_root_flow']) assert.equal(h.tools.has(forbidden), false);
  assert.equal(h.definitions.length, h.tools.size, 'all tools pass through defineTool');
  for (const [name, args] of [['fleet_catalog', {}], ['fleet_status', {}], ['fleet_thread', { ticketId: 'ticket', nodeId: 'build' }], ['fleet_submit', {}], ['fleet_start', { ticketId: 'ticket' }], ['fleet_stop', { ticketId: 'ticket' }], ['fleet_draft', { action: 'read' }], ['fleet_schedule', scheduleArgs]]) {
    const definition = h.tools.get(name), result = await h.tool(name, args);
    parsed(result);
    assert.deepEqual(definition.output.schema, { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, `${name} canonical schema`);
    assert.deepEqual(definition.output.render(args, result), [{ type: 'text', text: result.text }]);
    assert.equal(typeof definition.description, 'string'); assert.ok(definition.parameters && typeof definition.parameters === 'object');
  }
  const draftParameters = h.tools.get('fleet_draft').parameters;
  assert.equal(draftParameters.action.required, true); assert.equal(Object.hasOwn(draftParameters, 'confirmation'), false, 'there is no confirmation step');
  assert.equal(h.tools.get('fleet_thread').parameters.ticketId.required, true);
  assert.equal(h.tools.get('fleet_thread').parameters.nodeId.required, true);
  // Regression guard: the Host defineTool compiles parameters with the author schema DSL, which rejects
  // raw JSON-Schema forms (required arrays; objects without an explicit additionalProperties). A mock
  // defineTool passes these through silently, so assert the DSL subset here to catch Host activation failures.
  const dslTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null', 'json']);
  const checkDsl = (node, path) => {
    assert.ok(node && typeof node === 'object' && !Array.isArray(node), `${path} must be a schema object`);
    if (Object.hasOwn(node, 'required')) assert.equal(node.required, true, `${path}.required must be boolean true (author DSL), not an array`);
    if (Object.hasOwn(node, 'oneOf')) { assert.ok(Array.isArray(node.oneOf) && node.oneOf.length >= 2, `${path}.oneOf needs >=2 branches`); node.oneOf.forEach((b, i) => checkDsl(b, `${path}.oneOf[${i}]`)); return; }
    assert.ok(dslTypes.has(node.type), `${path}.type must be a supported DSL type, got ${node.type}`);
    if (node.type === 'object') {
      assert.equal(typeof node.additionalProperties, 'boolean', `${path}.additionalProperties must be explicitly true or false`);
      if (node.properties) for (const [k, v] of Object.entries(node.properties)) checkDsl(v, `${path}.properties.${k}`);
    }
    if (node.type === 'array' && node.items) checkDsl(node.items, `${path}.items`);
  };
  for (const definition of h.definitions) for (const [k, v] of Object.entries(definition.parameters)) checkDsl(v, `${definition.name}.parameters.${k}`);
  assert.equal(callsOf(h, 'human').length, 0, 'Agent calls never route through human capability');
});

test('tool Workspace and Session identity come from resolved agent context, never supplied arguments or plan fields', async () => {
  const h = harness();
  const plan = normalizePlan({ goal:'draft', inputs:{userContent:'kept'} });
  await assert.rejects(h.tool('fleet_draft',{action:'save',plan:JSON.stringify({...plan,workspaceId:'forged-workspace',sessionId:'forged-session',userId:'forged-user'})}), /Unexpected plan field/);
  const extra = { workspaceId: 'forged-workspace', workspacePath: '/forged', sessionId: 'forged-session', userId: 'forged-user', action: 'save' };
  await h.tool('fleet_draft', { ...extra, plan: JSON.stringify(plan) });
  await h.tool('fleet_status', { ...extra, ticketId: 'ticket' });
  await h.tool('fleet_thread', { ...extra, ticketId: 'ticket', nodeId: 'build' });
  assert.deepEqual(callsOf(h, 'saveDraftTicket')[0].args, [actualContext.workspaceId, { sessionId: actualContext.sessionId, plan, actor: { kind: 'agent' } }]);
  assert.deepEqual(callsOf(h, 'ownsSession')[0].args, [actualContext.sessionId]);
  assert.ok(callsOf(h, 'registerWorkspace').every(c => c.args[0] === actualContext.workspaceId && c.args[1] === actualContext.workspacePath));
  assert.ok(callsOf(h, 'read').every(c => c.args[0] === actualContext.workspaceId));
  assert.ok(callsOf(h, 'resolveAgentContext').every(c => c.args[0] === agent));
  assert.equal(callsOf(h, 'human').length, 0);
});

test('fleet_schedule documents explicit authorization and binds a create to the resolved planning Session', async () => {
  const h = harness();
  const definition = h.tools.get('fleet_schedule');
  assert.match(definition.description, /explicit/i);
  const { parameters } = definition;
  assert.deepEqual(Object.keys(parameters).sort(), ['date', 'expectedRevision', 'kind', 'name', 'ticketId', 'time', 'timeZone', 'weekdays']);
  for (const name of ['expectedRevision', 'kind', 'name', 'ticketId', 'time', 'timeZone']) assert.equal(parameters[name].required, true);
  assert.deepEqual(parameters.kind.enum, ['at', 'daily', 'weekly']);
  assert.deepEqual(parsed(await h.tool('fleet_schedule', scheduleArgs)), scheduleResult);
  assert.deepEqual(callsOf(h, 'agentSchedule'), [{ method: 'agentSchedule', args: [actualContext.workspaceId, actualContext.sessionId, scheduleArgs] }]);
  assert.equal(callsOf(h, 'human').length, 0);
  assert.equal(callsOf(h, 'agentStart').length, 0);

  const execution = harness({ owned: true });
  await assert.rejects(execution.tool('fleet_schedule', scheduleArgs), /Execution Sessions/);
  assert.equal(callsOf(execution, 'agentSchedule').length, 0);
  assert.equal(callsOf(execution, 'human').length, 0);
});

test('execution Sessions may inspect but fleet_draft rejects before parsing or mutating', async () => {
  const h = harness({ owned: true });
  await assert.rejects(h.tool('fleet_draft', { action: 'save', plan: '{invalid' }), /Execution Sessions/);
  assert.equal(callsOf(h, 'saveDraftTicket').length, 0);
  assert.equal(callsOf(h, 'human').length, 0);
  assert.equal(parsed(await h.tool('fleet_status', { ticketId: 'ticket' })).id, 'ticket');
  assert.equal(parsed(await h.tool('fleet_thread', { ticketId: 'ticket', nodeId: 'build' })).attempts[0].sessionId, 'execution-session');
  assert.ok(parsed(await h.tool('fleet_catalog')).agents);
});

test('/fleet help and empty raw input do not require agent, configuration or service', async () => {
  const h = harness({ getService: () => { throw new Error('must not load configuration'); }, resolveAgentContext: () => { throw new Error('must not resolve context'); } });
  for (const rawInput of ['', '   \n\t ', 'help', '\n help \t']) {
    const result = await h.command(rawInput, { agent: undefined });
    assert.deepEqual(result, { kind: 'success', text: fleetHelp });
    assert.match(result.text, /\/fleet start TICKET/);
  }
  assert.deepEqual(h.calls, []);
});

test('native rawInput whitespace routes list/show/thread/health without using a slash prefix', async () => {
  const h = harness();
  assert.equal((await h.command(' \t list \n ')).kind, 'success');
  assert.deepEqual(callsOf(h, 'read').at(-1).args, [actualContext.workspaceId]);
  assert.equal((await h.command('show\t ticket \n ')).kind, 'success');
  assert.deepEqual(callsOf(h, 'read').at(-1).args, [actualContext.workspaceId, 'ticket']);
  const thread = await h.command(' thread \t ticket \n build ');
  assert.equal(JSON.parse(thread.text).id, 'build');
  assert.deepEqual(JSON.parse((await h.command('health')).text), { ready: true, error: null });
  assert.equal(callsOf(h, 'human').length, 0);
});

test('command errors display invalid JSON, missing arguments, unknown nodes/actions and service failures', async () => {
  const h = harness();
  for (const [input, pattern] of [['change ticket build 2 {invalid', /valid JSON/], ['change ticket build old {"prompt":"x"}', /positive Ticket revision/], ['root-agent root {invalid', /valid JSON/], ['root-flow flow {invalid', /valid JSON/], ['pass ticket', /Missing command argument/], ['review ticket quality', /Missing command argument/], ['thread ticket missing', /Unknown Ticket node/], ['unknown', /Unknown Fleet command/], ['prepare {"ticket":{"goal":"gone"}}', /Unknown Fleet command/]]) {
    const result = await h.command(input);
    assert.equal(result.kind, 'error'); assert.match(result.text, pattern);
  }
  assert.equal(callsOf(h, 'human').length, 0);
  h.service.human = async () => { throw new Error('persist failed'); };
  assert.deepEqual(await h.command('start ticket'), { kind: 'error', text: 'persist failed' });
  h.service.human = async () => { throw 'non-Error failure'; };
  assert.deepEqual(await h.command('stop ticket'), { kind: 'error', text: 'non-Error failure' });
  await assert.rejects(h.tool('fleet_draft', { action: 'save', plan: '{invalid' }), /valid JSON/);
  await assert.rejects(h.tool('fleet_thread', { ticketId: 'ticket', nodeId: 'missing' }), /Unknown Ticket node/);
});

test('missing or unresolved execution context fails before obtaining service or registering mappings', async () => {
  const missing = harness();
  await assert.rejects(missing.tool('fleet_status', {}, { agent: undefined }), /current DSH Session/);
  assert.equal((await missing.command('list', { agent: undefined })).kind, 'error');
  assert.equal(callsOf(missing, 'getService').length, 0);
  for (const resolved of [null, {}, { ...actualContext, workspaceId: '' }, { ...actualContext, workspacePath: '' }, { ...actualContext, sessionId: '' }]) {
    const h = harness({ resolveAgentContext: async () => resolved });
    await assert.rejects(h.tool('fleet_status'), /registered Workspace/);
    const result = await h.command('list'); assert.equal(result.kind, 'error'); assert.match(result.text, /registered Workspace/);
    assert.equal(callsOf(h, 'getService').length, 0); assert.equal(callsOf(h, 'registerWorkspace').length, 0);
  }
});

test('aborted command/tool execution does not resolve context or start service work', async () => {
  const h = harness(), controller = new AbortController(); controller.abort(new Error('cancelled by user'));
  await assert.rejects(h.tool('fleet_draft', { action: 'save', plan: '{}' }, { signal: controller.signal }), /cancelled by user/);
  assert.deepEqual(await h.command('start ticket', { signal: controller.signal }), { kind: 'error', text: 'cancelled by user' });
  assert.deepEqual(h.calls, []);
});

test('catalog tolerates absent presets and includes synchronous or asynchronous available presets', async () => {
  for (const presets of [undefined, {}, { list: () => [{ id: 'sync' }] }, { list: async () => [{ id: 'async' }] }]) {
    const h = harness({ presets });
    const toolResult = parsed(await h.tool('fleet_catalog'));
    const commandResult = await h.command('catalog'); assert.equal(commandResult.kind, 'success');
    const commandValue = JSON.parse(commandResult.text);
    assert.deepEqual(commandValue, toolResult);
    assert.equal(toolResult.agents[0].id, 'shared-agent');
    if (presets?.list) assert.deepEqual(toolResult.availablePresets, await presets.list());
    else assert.equal(Object.hasOwn(toolResult, 'availablePresets'), false);
  }
});

test('catalog preset failures propagate as awaited tool errors and displayed command errors', async () => {
  for (const list of [() => { throw new Error('preset sync error'); }, async () => { throw new Error('preset async error'); }]) {
    const h = harness({ presets: { list } });
    await assert.rejects(h.tool('fleet_catalog'), /preset (sync|async) error/);
    const result = await h.command('catalog'); assert.equal(result.kind, 'error'); assert.match(result.text, /preset (sync|async) error/);
    assert.equal(callsOf(h, 'saveDraftTicket').length, 0); assert.equal(callsOf(h, 'human').length, 0);
  }
});

test('returned disposer unregisters the command and every registered tool', () => {
  const h = harness(); h.dispose();
  assert.equal(h.tools.size, 0); assert.equal(h.commands.size, 0);
  assert.deepEqual(h.disposals, ['command:fleet', ...h.definitions.toReversed().map(({ name }) => `tool:${name}`)]);
});

test('/fleet new creates the draft Ticket on the spot and steers the native Agent with two-phase instructions', async () => {
  const h=harness(),messages=[];
  const attachment={type:'text',text:'Reference attachment'};
  const result=await h.command(' new build a bilingual blog',{agent:{steer:async message=>messages.push(message)},attachments:[attachment]});
  assert.equal(result.kind,'success'); assert.equal(messages.length,1);
  assert.deepEqual(messages[0].source,{kind:'user'}); assert.deepEqual(messages[0].content[0],attachment);
  const prompt=messages[0].content.at(-1).text;
  assert.match(prompt,/build a bilingual blog/); assert.match(prompt,/Draft Ticket draft\./,'the request pre-created its draft Ticket');
  assert.match(prompt,/SAME Ticket is editable in draft or stopped/); assert.match(prompt,/start decision belongs to the human/); assert.match(prompt,/explicitly asks in this conversation to start or resume/); assert.match(prompt,/call fleet_stop/); assert.match(prompt,/Never claim execution started or stopped without actual evidence/);
  assert.equal(callsOf(h,'saveDraftTicket').length,1);
  assert.deepEqual(callsOf(h,'saveDraftTicket')[0].args,[actualContext.workspaceId,{sessionId:actualContext.sessionId,plan:normalizePlan({goal:'build a bilingual blog'}),actor:{kind:'human',userId:`dsh-command:${actualContext.sessionId}`}}]);
  const bare=await h.command(' new',{agent:{steer:async message=>messages.push(message)}});
  assert.equal(bare.kind,'success'); assert.equal(messages.length,2);
  assert.equal(callsOf(h,'saveDraftTicket').length,1,'an empty new request must not pre-create a placeholder Ticket');
  assert.match(messages.at(-1).content.at(-1).text,/Ask me what I want/);
  assert.match((await h.command('help')).text,/\/fleet new YOUR_REQUEST/);
  assert.equal(h.commands.has('oh-my-agent-fleet'),false,'the long command name is retired');
  assert.match((await h.command('newx ticket')).text,/Unknown Fleet command/);
  const execution=harness({owned:true});
  assert.equal((await execution.command(' new test',{agent:{steer:()=>assert.fail('execution Sessions must not steer the planner')}})).kind,'error');
});

test('planning command cancellation during context resolution never steers an Agent', async () => {
  let release;const h=harness({resolveAgentContext:()=>new Promise(resolve=>{release=resolve;})});
  const abort=new AbortController();
  const result=h.commands.get('fleet').handler({agent:{steer:()=>assert.fail('cancelled planner must not start')},rawInput:' new cancelled',signal:abort.signal});
  abort.abort();release(actualContext);
  assert.equal((await result).kind,'error');
});

test('draft tool binds plan saves to the actual conversation with revisions', async () => {
  const h=harness(),draft={id:'ticket-id',originSessionId:actualContext.sessionId,revision:2,status:'draft'};
  h.service.listDraftTickets=async(ws,session)=>{assert.equal(ws,actualContext.workspaceId);return[draft];};
   h.service.read=async()=>draft;
  h.service.saveDraftTicket=async(ws,args)=>{assert.equal(ws,actualContext.workspaceId);assert.equal(args.sessionId,actualContext.sessionId);assert.equal(args.actor.kind,'agent');if(args.ticketId)assert.equal(args.expectedRevision,2);return{...draft,revision:(args.expectedRevision??1)+1,plan:args.plan};};
  assert.equal(parsed(await h.tool('fleet_draft',{action:'read'})).length,1);
  assert.equal(parsed(await h.tool('fleet_draft',{action:'read',ticketId:'ticket-id'})).id,'ticket-id');
  const weekly={id:'weekly',revision:4,name:'Weekly',status:'paused',sourceTicketId:null,occurrences:[{ticketId:draft.id}],timing:{kind:'at',at:'2030-01-01T12:00:00Z'},host:{timing:{kind:'weekly',time:'11:30:00',timeZone:'Asia/Tokyo',weekdays:[1,4]}}};
  h.service.readSeries=async()=>[weekly,{...weekly,id:'new-once',timing:{kind:'daily'},host:{timing:{kind:'at'}}}];
  assert.deepEqual(parsed(await h.tool('fleet_draft',{action:'read',ticketId:draft.id})).scheduledSeries,[{
    id:'weekly',revision:4,name:'Weekly',status:'paused',timing:{kind:'weekly',weekly:{time:'11:30:00',time_zone:'Asia/Tokyo',weekdays:[1,4]}}
  }]);
  assert.equal(parsed(await h.tool('fleet_draft',{action:'save',ticketId:'ticket-id',expectedRevision:2,plan:'{"goal":"edited"}',sessionId:'forged'})).revision,3);
  await h.tool('fleet_draft',{action:'save',ticketId:'ticket-id',expectedRevision:2,scope:'series',seriesId:'weekly',expectedSeriesRevision:4,plan:'{"goal":"shared edit"}'});
  assert.equal(callsOf(h,'saveDraftWithScope').at(-1).args[1].scope,'series');
  assert.equal(callsOf(h,'saveDraftWithScope').at(-1).args[1].expectedSeriesRevision,4);
  await assert.rejects(h.tool('fleet_draft',{action:'confirm',ticketId:'ticket-id'}),/Unknown draft action/);
  draft.originSessionId='other-session';
  await assert.rejects(h.tool('fleet_draft',{action:'read',ticketId:'ticket-id'}),/another conversation/);
  const execution=harness({owned:true});
  await assert.rejects(execution.tool('fleet_draft',{action:'read'}),/Execution Sessions/);
});

test('planning consumes global and generation rules without injecting execution-only rules', async () => {
  const h=harness(), messages=[];
  h.service.catalog=async()=>({settings:{revision:7,rules:['GLOBAL_RULE'],generation:{rules:['GENERATION_RULE']},execution:{rules:['EXECUTION_ONLY_RULE']}}});
  const result=await h.command('new Create artifact',{agent:{steer:async message=>messages.push(message)}});
  assert.equal(result.kind,'success'); const text=messages[0].content.at(-1).text;
  assert.match(text,/settings revision 7/);assert.match(text,/GLOBAL_RULE/);assert.match(text,/GENERATION_RULE/);assert.doesNotMatch(text,/EXECUTION_ONLY_RULE/);
});

test('failed initial persistence never steers a planner or claims a draft exists', async () => {
  const h=harness();h.service.saveDraftTicket=async()=>{throw Error('disk unavailable');};
  const result=await h.command('new Create artifact',{agent:{steer:()=>assert.fail('must persist the request before planning')}});
  assert.deepEqual(result,{kind:'error',text:'disk unavailable'});
});

test('repair, regeneration and global settings remain explicit human commands with CAS and native origin', async () => {
  const h=harness();
  assert.equal((await h.command('repair ticket 3')).kind,'success');
  assert.deepEqual(callsOf(h,'human').at(-1).args.slice(2),['repairTicket',['ticket',3]]);
  assert.equal((await h.command('regenerate ticket 3 {"goal":"Replacement"}')).kind,'success');
  assert.deepEqual(callsOf(h,'human').at(-1).args.slice(2),['regenerateTicket',['ticket',3,normalizePlan({goal:'Replacement'}),actualContext.sessionId]]);
  assert.equal((await h.command('root-settings {"revision":2,"rules":["Keep history"],"generation":{"rules":[]},"execution":{"rules":[]}}')).kind,'success');
  assert.equal(callsOf(h,'human').at(-1).args[2],'replaceGlobalSettings');
  for(const input of ['repair ticket 0','regenerate ticket -1'])assert.equal((await h.command(input)).kind,'error');
  assert.equal(h.tools.has('fleet_repair'),false);assert.equal(h.tools.has('fleet_regenerate'),false);
});

test('Template provenance is optional metadata beside the canonical plan', async()=>{
  const h=harness(), refs=[{kind:'agent',templateId:'shared-agent',templateRevision:2,localId:'worker'}];
  await h.tool('fleet_draft',{action:'save',plan:'{"goal":"Copied template"}',sourceRefs:JSON.stringify(refs)});
  const saved=callsOf(h,'saveDraftTicket').at(-1).args[1];
  assert.deepEqual(saved.sourceRefs,refs);assert.equal(Object.hasOwn(saved.plan,'sourceRefs'),false);
});

test('Chat draft save -> user start -> tick persists real service state and resumes delivery after reopen', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-chat-test-'));
  const ownedTemp = path.resolve(temp), services = [], disposers = [];
  t.after(async () => {
    for (const dispose of disposers) dispose();
    try { for (const service of services) await service.close(); }
    finally {
      // Check the exact test-created absolute directory before recursive cleanup.
      assert.equal(path.resolve(temp), ownedTemp); assert.equal(path.dirname(ownedTemp), path.resolve(os.tmpdir()));
      assert.ok(path.basename(ownedTemp).startsWith('fleet-chat-test-'));
      const stat = await fs.lstat(ownedTemp); assert.ok(stat.isDirectory()); assert.equal(stat.isSymbolicLink(), false);
      await fs.readdir(ownedTemp); await fs.rm(ownedTemp, { recursive: true, force: true });
    }
  });
  const workspaceId = 'actual-workspace', workspacePath = path.join(temp, 'workspace'), rootPath = path.join(temp, 'root');
  const host = { create: [], submit: [], status: { status: 'running' } };
  const adapter = {
    async create(input) { host.create.push(structuredClone(input)); return { sessionId: 'real-test-session' }; },
    async submit(input) { host.submit.push(structuredClone(input)); return { messageId: input.requestId }; },
    async inspect() { return structuredClone(host.status); },
    async cancel() { return { stopped: false }; },
    async message(input) { return { messageId: input.requestId }; },
  };
  const open = async () => { const s = await FleetService.open({ rootPath, workspacePaths: { [workspaceId]: workspacePath }, adapter, autoStart: false }); services.push(s); return s; };
  let service = await open();
  const h = harness({ getService: async () => service, resolveAgentContext: async current => ({ workspaceId, workspacePath, sessionId: current.execution ? 'real-test-session' : 'planning-session' }) });
  disposers.push(h.dispose);
  const plan = normalizePlan({
    goal:'Deliver verified output', deliverables:[], criteria:['Artifact verified'],
    agents:{writer:{profile:{agentPreset:'test-preset',instructions:'Write the requested artifact'}}},
    nodes:[{id:'write',role:'writer',agentId:'writer',dependsOn:[],task:{prompt:'Produce a verified result'}}],gates:[]
  });
  const created = parsed(await h.tool('fleet_draft', { action: 'save', plan: JSON.stringify(plan) }));
  assert.equal(created.status, 'draft'); assert.equal(created.workspaceId, workspaceId);
  assert.equal(created.plan.goal, 'Deliver verified output');
  assert.equal(host.create.length, 0); assert.equal(host.submit.length, 0);
  assert.equal((await h.command(`start ${created.id}`)).kind, 'success');
  assert.equal(host.create.length, 0, 'human start commits intent; tick owns actual dispatch');
  await service.tick(); assert.equal(host.create.length, 1); assert.equal(host.submit.length, 1);
  const running = parsed(await h.tool('fleet_status', { ticketId: created.id }));
  assert.equal(running.status, 'running'); assert.equal(running.execution.nodes.write.attempts[0].sessionId, 'real-test-session');
  assert.equal(running.activity.find(e => e.type === 'ticket-started').actor.userId, 'dsh-command:planning-session');
  await assert.rejects(h.tool('fleet_draft', { action: 'save', plan: JSON.stringify(plan) }, { agent: { execution: true } }), /Execution Sessions/);
  await service.close(); service = await open();
  const restored = JSON.parse((await h.command(`show ${created.id}`)).text);
  assert.deepEqual(restored, running); assert.equal(restored.execution.nodes.write.attempts.length, 1);
  host.status = { status: 'completed', output: { artifact: 'result.txt', verified: true } };
  await service.tick();
  const delivered = parsed(await h.tool('fleet_status', { ticketId: created.id }));
  assert.equal(delivered.status, 'delivered'); assert.equal(host.create.length, 1); assert.equal(host.submit.length, 1);
  assert.deepEqual(delivered.execution.nodes.write.attempts[0].outputs, { artifact: 'result.txt', verified: true });
  await service.close(); service = await open();
  assert.deepEqual(JSON.parse((await h.command(`show ${created.id}`)).text), delivered);
});
