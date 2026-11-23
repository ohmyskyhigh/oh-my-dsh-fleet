import path from 'node:path';
import { stat } from 'node:fs/promises';
import { FleetCoreError } from './fleet-core.js';
import { FleetModelError, isIncompatibleDraft, normalizePlan, projectTicket, seriesRecurrence } from './fleet-model.js';
import { readFileSync } from 'node:fs';
const pluginVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reply = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
class RequestFailure extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = `fleet/${code}`; }
}
const fail = (status, code, message) => { throw new RequestFailure(status, code, message); };
const invalid = message => fail(400, 'invalid-request', message);
const id = (value, label) => {
  if (typeof value !== 'string' || !value.length || /[\s\u0000-\u001f\u007f]/u.test(value)) invalid(`${label} must be a nonempty ID without whitespace or control characters.`);
  return value;
};
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} must be a nonempty string.`);
};
const record = (value, label) => { if (!object(value)) invalid(`${label} must be an object.`); };
const fields = (value, allowed, label) => {
  record(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`Unexpected ${label} field.`);
};
const ids = (value, label) => {
  if (!Array.isArray(value)) invalid(`${label} must be an array of IDs.`);
  for (const entry of value) id(entry, label);
};
function flow(definition) {
  record(definition, 'definition');
  if (!Array.isArray(definition.nodes)) invalid('definition.nodes must be an array.');
  for (const node of definition.nodes) {
    record(node, 'node'); id(node.id, 'node.id');
    if (node.role !== undefined && typeof node.role !== 'string') invalid('node.role must be display text.');
    if (node.agentId !== undefined && node.agentId !== null) id(node.agentId, 'node.agentId');
    if (node.dependsOn !== undefined) ids(node.dependsOn, 'node.dependsOn');
    if (node.task !== undefined) record(node.task, 'node.task');
  }
  if (definition.gates !== undefined) {
    if (!Array.isArray(definition.gates)) invalid('definition.gates must be an array.');
    for (const gate of definition.gates) {
      record(gate, 'gate'); id(gate.id, 'gate.id'); ids(gate.from, 'gate.from'); ids(gate.to, 'gate.to');
      record(gate.reviewer, 'gate.reviewer');
      if (gate.reviewer.kind === 'agent') id(gate.reviewer.nodeId, 'gate.reviewer.nodeId');
    }
  }
  // DAG references and review semantics remain owned by FleetCore.
}
function plan(input) {
  // Shared lossless contract; display projections are never persistence inputs.
  normalizePlan(input);
}
function actionInput(body) {
  record(body, 'request'); id(body.workspaceId, 'workspaceId');
  const common = ['workspaceId', 'action'];
  const specs = {
    'draft-save': ['sessionId', 'ticketId', 'expectedRevision', 'plan', 'sourceRefs', 'scope','seriesId','expectedSeriesRevision'],
    'template-instantiate':['templateId','templateRevision','overrides','assignments','sessionId'],
    'series-create':['name','timing','sourceTicketId','templateId','templateRevision','overrides','assignments'],
    'series-update':['seriesId','fields','expectedRevision'],
    'series-follow':['sourceTicketId','triggerSeriesId','expectedRevision','name'],
    'series-pause':['seriesId'], 'series-resume':['seriesId'], 'series-delete':['seriesId'],
    'draft-delete': ['ticketId', 'expectedRevision'],
    'draft-repair': ['sessionId', 'ticketId', 'expectedRevision', 'plan'],
    'draft-regenerate': ['sessionId', 'ticketId', 'expectedRevision', 'plan'],
    start: ['ticketId'], stop: ['ticketId'], resume: ['ticketId'],
    'dependency-enable': ['ticketId', 'expectedRevision'],
    'dependency-disable': ['ticketId', 'expectedRevision'],
    retry: ['ticketId', 'nodeId', 'reason'], say: ['ticketId', 'nodeId', 'message'],
    change: ['ticketId', 'nodeId', 'task', 'message', 'expectedRevision'], pass: ['ticketId', 'gateId'],
    review: ['ticketId', 'gateId', 'decision', 'evidence', 'artifactRefs'],
    'node-model': ['ticketId', 'nodeId', 'modelSelection', 'expectedRevision'],
    'deliver-override': ['ticketId', 'reason'],
    abandon: ['ticketId', 'expectedRevision', 'reason'],
    unabandon: ['ticketId', 'expectedRevision'],
    'root-agent': ['agentId', 'profile'], 'root-flow': ['orchestrationId', 'definition']
  };
  if (typeof body.action !== 'string' || !Object.hasOwn(specs, body.action)) invalid('Unknown Fleet action.');
  fields(body, [...common, ...specs[body.action]], 'request');
  for (const key of specs[body.action].filter(key => key.endsWith('Id'))) {
    if (key === 'sessionId' && body.action === 'draft-save' && body.ticketId && body[key] == null) continue;
    if (body[key] === undefined && (body.action === 'draft-save' && ['ticketId','seriesId'].includes(key) || body.action === 'template-instantiate' && key === 'sessionId' || body.action === 'series-create' && ['sourceTicketId','templateId'].includes(key))) continue;
    id(body[key], key);
  }
  if (['draft-save', 'draft-repair', 'draft-regenerate'].includes(body.action)) {
    if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1)) invalid('expectedRevision must be a positive integer.');
    if (body.ticketId !== undefined && body.expectedRevision === undefined) invalid('expectedRevision is required to update a Ticket.');
  }
  for (const key of ['templateRevision','expectedSeriesRevision']) if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1)) invalid(`${key} must be a positive integer.`);
  if (body.templateId) {
    fields(body.overrides,['goal','title','inputs','deliverables','criteria','requirements'],'overrides');
    if (body.assignments !== undefined) { record(body.assignments,'assignments'); for (const value of Object.values(body.assignments)) id(value,'assignment'); }
  }
  switch (body.action) {
    case 'series-create':
      text(body.name,'name'); record(body.timing,'timing');
      if (Boolean(body.templateId) === Boolean(body.sourceTicketId)) invalid('Choose one series source.');
      break;
    case 'series-follow':
      text(body.name, 'name');
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) invalid('Expected a positive source Ticket revision.');
      break;
    case 'draft-delete': case 'dependency-enable': case 'dependency-disable':
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) invalid('Expected a positive Ticket revision.');
      break;
    case 'series-update':
      record(body.fields,'fields'); if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) invalid('Expected a positive series revision.');
      break;
    case 'draft-save':
      if (body.scope !== undefined && (!body.ticketId || !['ticket','series'].includes(body.scope))) invalid('Scope requires an existing Ticket and a valid edit scope.');
      plan(body.plan);
      if (body.sourceRefs !== undefined) {
        if (!Array.isArray(body.sourceRefs)) invalid('sourceRefs must be an array.');
        for (const ref of body.sourceRefs) {
          fields(ref, ['kind', 'templateId', 'templateRevision', 'localId', 'nodeIds'], 'source reference');
          if (!['agent', 'orchestration'].includes(ref.kind)) invalid('Unknown source kind.');
          id(ref.templateId, 'source templateId');
          if (!Number.isSafeInteger(ref.templateRevision) || ref.templateRevision < 1) invalid('source templateRevision must be a positive integer.');
          if (ref.localId !== undefined) id(ref.localId, 'source localId');
          if (ref.nodeIds !== undefined) ids(ref.nodeIds, 'source nodeIds');
        }
      }
      break;
    case 'draft-repair': case 'draft-regenerate': if (body.plan !== undefined) plan(body.plan); break;
    case 'retry': text(body.reason, 'reason'); break;
    case 'say': text(body.message, 'message'); break;
    case 'change':
      record(body.task, 'task'); if (body.message !== undefined) text(body.message, 'message');
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) invalid('expectedRevision is required to change Ticket configuration.');
      break;
    case 'node-model':
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) invalid('expectedRevision is required to change Ticket configuration.');
      if (body.modelSelection !== null) {
        fields(body.modelSelection, ['provider', 'model', 'reasoningEffort'], 'modelSelection');
        text(body.modelSelection.provider, 'provider'); text(body.modelSelection.model, 'model');
        if (body.modelSelection.reasoningEffort !== undefined) text(body.modelSelection.reasoningEffort, 'reasoningEffort');
      }
      break;
    case 'review':
      if (!['passed', 'returned'].includes(body.decision)) invalid('decision must be passed or returned.');
      if (!Object.hasOwn(body, 'evidence')) invalid('Review needs evidence.');
      if (body.artifactRefs !== undefined) {
        if (!Array.isArray(body.artifactRefs)) invalid('artifactRefs must be an array.');
        for (const ref of body.artifactRefs) { record(ref, 'artifactRef'); id(ref.artifactId, 'artifactRef.artifactId'); if (!Number.isSafeInteger(ref.version) || ref.version < 1) invalid('artifactRef.version must be a positive integer.'); text(ref.sha256, 'artifactRef.sha256'); }
      }
      break;
    case 'deliver-override': id(body.ticketId, 'ticketId'); text(body.reason, 'reason'); break;
    case 'root-agent': record(body.profile, 'profile'); break;
    case 'root-flow': flow(body.definition); break;
  }
  return body;
}
function validateJSON(value) {
  // JSON.parse accepts overflowing numbers and -0; FleetStore deliberately does not.
  // Reject these at admission so malformed UI input never faults the shared writer.
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))) invalid('JSON numbers must be finite and lossless.');
    if (item !== null && typeof item === 'object') for (const child of Object.values(item)) pending.push(child);
  }
}
function errorResponse(error) {
  let status = 500, code = 'fleet/service-error';
  if (error instanceof RequestFailure) { status = error.status; code = error.code; }
  else if (error instanceof FleetCoreError || error instanceof FleetModelError || error?.code === 'store-busy') {
    code = `fleet/${error.code}`;
    status = ['invalid-input', 'invalid-flow', 'unknown-action'].includes(error.code) ? 400
      : error.code.startsWith('unknown-') ? 404
        : ['closed', 'persistence-fault'].includes(error.code) ? 503 : 409;
  }
  return reply({ schemaVersion: 1, error: { code, message: error instanceof Error ? error.message : String(error), ...(Array.isArray(error.diagnostics) ? { diagnostics: error.diagnostics } : {}), ...(code === 'fleet/ticket-referenced' ? { references: error.references } : {}) } }, status);
}

/** Authenticated owner UI only: the Host connection registry owns authentication.
 * Reads reuse the running service without opening/recovering one or registering a
 * Workspace. Writes delegate to the same service as native Chat, never a second writer.
 */
export function registerFleetDashboardApi(ctx, { getService }) {
  let disposed = false;
  const pending = new Set(), unregister = [];
  const workspace = (workspaceId, expected) => {
    const current = ctx.workspaceRegistry.get(workspaceId);
    if (!current || current.id !== workspaceId) fail(404, 'unknown-workspace', 'Workspace is not registered.');
    if (typeof current.path !== 'string' || current.path.includes('\0') || !path.isAbsolute(current.path)) fail(409, 'workspace-unavailable', 'Registered Workspace has no absolute local path.');
    const result = { id: current.id, path: current.path };
    if (expected && path.relative(expected.path, result.path) !== '') fail(409, 'workspace-changed', 'Workspace path changed; reload the Dashboard.');
    return result;
  };
  const checkMapping = (service, target) => {
    const paths = service.health?.paths?.workspacePaths;
    if (paths && Object.hasOwn(paths, target.id) && path.relative(paths[target.id], target.path) !== '') {
      fail(409, 'workspace-path-mismatch', 'Fleet state belongs to another path for this Workspace ID. Resolve the runtime mapping before continuing.');
    }
  };
  const context = async (workspaceId, readOnly) => {
    const target = workspace(workspaceId);
    try { if (!(await stat(target.path)).isDirectory()) fail(409, 'workspace-unavailable', 'Registered Workspace path is not a directory.'); }
    catch (error) {
      if (error instanceof RequestFailure) throw error;
      fail(error.code === 'ENOENT' ? 404 : 409, 'workspace-unavailable', `Registered Workspace directory is unavailable: ${error.message}`);
    }
    workspace(workspaceId, target);
    let service;
    try { service = await getService({ readOnly }); }
    catch (error) { fail(503, 'service-unavailable', error instanceof Error ? error.message : String(error)); }
    workspace(workspaceId, target); checkMapping(service, target);
    return { service, target };
  };
  const validateTarget = (service, target) => { workspace(target.id, target); checkMapping(service, target); };
  const view = async request => {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['workspaceId', 'ticketId'].includes(key)) || params.getAll('workspaceId').length !== 1 || params.getAll('ticketId').length > 1) invalid('Expected one workspaceId and an optional ticketId.');
    const workspaceId = id(params.get('workspaceId'), 'workspaceId');
    const ticketId = params.has('ticketId') ? id(params.get('ticketId'), 'ticketId') : null;
    const { service, target } = await context(workspaceId, true);
    const catalog = await service.catalog();
    const scoped = catalog.workspaces.find(entry => entry.id === workspaceId);
    const tickets = !scoped ? [] : service.dashboardTickets ? await service.dashboardTickets(workspaceId) : (await service.read(workspaceId)).map(ticket => projectTicket(ticket));
    if (tickets.some(ticket => ticket.workspaceId !== workspaceId)) fail(500, 'workspace-state-mismatch', 'Fleet returned a Ticket from another Workspace.');
    const items = scoped && service.readSeries ? await service.readSeries(workspaceId) : [];
    const series = {...(service.scheduleStatus?.() ?? {available:false,unavailableReason:'Host schedule service is unavailable; scheduling cannot be enabled.'}),items};
    for (const ticket of tickets) {
      const sources = items.filter(s => s.sourceTicketId === ticket.id);
      const member = items.find(s => s.occurrences.some(o => o.ticketId === ticket.id)) ?? sources.find(s => ['active','paused'].includes(s.status) && seriesRecurrence(s) === 'recurring') ?? sources[0];
      if (!member) continue;
      const occurrence = member.occurrences.find(o => o.ticketId === ticket.id);
      ticket.series = {seriesId:member.id,name:member.name,status:member.status,revision:member.revision,recurrence:seriesRecurrence(member),role:occurrence ? 'occurrence' : 'source',...(occurrence ? {occurrenceAt:occurrence.occurrenceAt} : {})};
    }
    const selectedTicket = ticketId ? tickets.find(ticket => ticket.id === ticketId) : null;
    if (ticketId && !selectedTicket) fail(404, 'unknown-ticket', 'Ticket does not belong to this Workspace.');
    const availablePresets = await ctx.agentPresets?.list?.() ?? [];
    // P-50 read-only host model catalog; an absent or failing capability projects failures and never blocks the view.
    const modelCatalog = await (typeof service.modelCatalog === 'function' ? service.modelCatalog() : Promise.reject(new Error('Model catalog capability is unavailable.')))
      .catch(error => ({ default: null, routableProviders: [], groups: [], failures: [{ id: 'host', name: 'Model catalog', message: error instanceof Error ? error.message : String(error) }] }));
    validateTarget(service, target);
    const health = service.health;
    return reply({ schemaVersion: 1, pluginVersion, workspaceId,
      catalog: { templates: catalog.templates, settings: catalog.settings, agents: catalog.agents, orchestrations: catalog.orchestrations, binding: null, availablePresets, modelCatalog },
      tickets, series, selectedTicket: selectedTicket ?? null,
      // The service health also contains every Workspace path and a global last
      // execution error; those are not data for the selected Workspace.
      health: { ready: health.ready, error: health.error }
    });
  };
  const progress = async request => {
    const params = new URL(request.url).searchParams;
    const keys = ['workspaceId', 'ticketId', 'nodeId', 'attemptId'];
    if ([...params.keys()].some(key => !keys.includes(key)) || keys.some(key => params.getAll(key).length !== 1)) invalid('Expected workspaceId, ticketId, nodeId and attemptId.');
    const [workspaceId, ticketId, nodeId, attemptId] = keys.map(key => id(params.get(key), key));
    const { service, target } = await context(workspaceId, true);
    const rows = await service.attemptProgress(workspaceId, ticketId, nodeId, attemptId);
    validateTarget(service, target);
    return reply({ schemaVersion: 1, workspaceId, ticketId, nodeId, attemptId, rows });
  };
  const drafts = async request => {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['workspaceId', 'sessionId', 'draftId'].includes(key)) || params.getAll('workspaceId').length !== 1 || ['sessionId', 'draftId'].some(key => params.getAll(key).length > 1)) invalid('Expected one workspaceId and optional sessionId/draftId.');
    const workspaceId = id(params.get('workspaceId'), 'workspaceId');
    const sessionId = params.has('sessionId') ? id(params.get('sessionId'), 'sessionId') : undefined;
    const draftId = params.has('draftId') ? id(params.get('draftId'), 'draftId') : undefined;
    const { service, target } = await context(workspaceId, true);
    // This legacy route name now carries the same Ticket identity and real status.
    // Historical and running Tickets stay inspectable, without a confirmed pseudo-state.
    const rows = (await service.read(workspaceId)).filter(t => !sessionId || t.originSessionId === sessionId);
    if (rows.some(t => t.workspaceId !== workspaceId)) fail(500, 'workspace-state-mismatch', 'Fleet returned a Ticket from another Workspace.');
    rows.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
    const selectedDraft = draftId ? rows.find(d => d.id === draftId) : null;
    if (draftId && !selectedDraft) fail(404, 'unknown-draft', 'Configuration draft does not belong to this scope.');
    validateTarget(service, target);
    return reply({ schemaVersion: 1, workspaceId, drafts: rows, selectedDraft: selectedDraft ?? null });
  };
  const act = async request => {
    if ([...new URL(request.url).searchParams].length) invalid('Action parameters belong in the JSON body.');
    let body;
    try { body = await request.json(); } catch { invalid('Request body must be valid JSON.'); }
    validateJSON(body); actionInput(body);
    const { service, target } = await context(body.workspaceId, false);
    if (!service.health.ready) fail(503, 'service-unavailable', service.health.error ?? 'Fleet service is not ready.');
    const configurationAction = ['draft-save', 'draft-repair', 'draft-regenerate'].includes(body.action);
    if (body.action === 'template-instantiate' || body.action === 'series-create') {
      await service.registerWorkspace(target.id,target.path); validateTarget(service,target);
    }
    const originlessSave = body.action === 'draft-save' && body.ticketId && body.sessionId == null;
    if (configurationAction) {
      if (!originlessSave && !ctx.workspaceRegistry.get(target.id)?.sessionIds?.includes(body.sessionId)) fail(409, 'session-scope', 'Origin Session does not belong to this Workspace.');
      await service.registerWorkspace(target.id, target.path);
      validateTarget(service, target);
      if (!originlessSave && !ctx.workspaceRegistry.get(target.id)?.sessionIds?.includes(body.sessionId)) fail(409, 'session-scope', 'Origin Session no longer belongs to this Workspace.');
    }
    let ticket;
    if (body.ticketId) {
      ticket = await service.read(target.id, body.ticketId);
      if (ticket.workspaceId !== target.id || ticket.id !== body.ticketId) fail(404, 'unknown-ticket', 'Ticket does not belong to this Workspace.');
      if (configurationAction && ticket.originSessionId && ticket.originSessionId !== body.sessionId) fail(409, 'session-scope', 'This Ticket belongs to another origin Session.');
      if (body.nodeId && !ticket.plan?.nodes?.some(node => node.id === body.nodeId) && !Object.hasOwn(ticket.execution?.nodes ?? {}, body.nodeId)) fail(404, 'unknown-node', 'Unknown Ticket node.');
      if (body.gateId && !ticket.plan?.gates?.some(gate => gate.id === body.gateId) && !Object.hasOwn(ticket.execution?.gates ?? {}, body.gateId)) fail(404, 'unknown-gate', 'Unknown Ticket gate.');
    }
    validateTarget(service, target);
    let result;
    const {workspaceId: _ws,action: _action,...input} = body;
    const actor = {kind:'human',userId:'dsh-dashboard'};
    if (body.action === 'template-instantiate') {
      if (body.sessionId && !ctx.workspaceRegistry.get(target.id)?.sessionIds?.includes(body.sessionId)) fail(409,'session-scope','Origin Session does not belong to this Workspace.');
      result = await service.human(target.id,actor.userId,'instantiateTemplate',[input]);
    } else if (body.action === 'series-create') result = await service.seriesCreate(target.id,{...input,actor});
    else if (body.action === 'series-follow') result = await service.followSeries(target.id, input, actor.userId);
    else if (body.action === 'series-update') result = await service.seriesUpdate(target.id,body.seriesId,{fields:body.fields,expectedRevision:body.expectedRevision});
    else if (body.action === 'series-pause') result = await service.seriesPause(target.id,body.seriesId);
    else if (body.action === 'series-resume') result = await service.seriesResume(target.id,body.seriesId);
    else if (body.action === 'series-delete') result = await service.seriesDelete(target.id,body.seriesId);
    else if (body.action === 'draft-save' && body.scope) result = await service.saveDraftWithScope(target.id,{...input,actor});
    else if (body.action === 'draft-save') {
      result = await service.saveDraftTicket(target.id, { ...(body.ticketId === undefined ? {} : { ticketId: body.ticketId, expectedRevision: body.expectedRevision }), sessionId: body.sessionId ?? null, plan: body.plan, ...(body.sourceRefs === undefined ? {} : { sourceRefs: body.sourceRefs }), actor: { kind: 'human', userId: 'dsh-dashboard' } });
    } else if (body.action === 'draft-repair') {
      result = await service.human(target.id, 'dsh-dashboard', 'repairTicket', [body.ticketId, body.expectedRevision, ...(body.plan === undefined ? [] : [body.plan])]);
    } else if (body.action === 'draft-regenerate') {
      const goal = ticket.plan?.goal ?? ticket.plan?.ticket?.goal ?? ticket.goal;
      if (body.plan === undefined && (typeof goal !== 'string' || !goal.trim())) fail(400, 'missing-goal', 'This legacy Ticket has no recoverable goal. Provide the goal in its original conversation and regenerate with an explicit plan.');
      const replacement = body.plan ?? { goal };
      result = await service.human(target.id, 'dsh-dashboard', 'regenerateTicket', [body.ticketId, body.expectedRevision, replacement, body.sessionId]);
    } else {
      const reviewEvidence = body.artifactRefs === undefined ? body.evidence : { ...(body.evidence !== null && typeof body.evidence === 'object' && !Array.isArray(body.evidence) ? body.evidence : { text: body.evidence }), artifactRefs: body.artifactRefs };
      const actions = {
        start: ['start', [body.ticketId]], stop: ['stop', [body.ticketId]], resume: ['resume', [body.ticketId]],
        'draft-delete': ['deleteDraftTicket', [body.ticketId, body.expectedRevision]],
        'dependency-enable': ['enableDependencies', [body.ticketId, body.expectedRevision]],
        'dependency-disable': ['disableDependencies', [body.ticketId, body.expectedRevision]],
        retry: ['retryNode', [body.ticketId, body.nodeId, body.reason]],
        say: ['commentNode', [body.ticketId, body.nodeId, body.message]],
        change: ['changeNode', [body.ticketId, body.nodeId, body.task, body.message ?? `User Dashboard change: ${JSON.stringify(body.task)}`, body.expectedRevision]],
        'node-model': ['setPendingNodeModel', [body.ticketId, body.nodeId, body.modelSelection, body.expectedRevision]],
        pass: ['forcePassGate', [body.ticketId, body.gateId]],
        review: ['reviewGate', [body.ticketId, body.gateId, body.decision, reviewEvidence]],
        'deliver-override': ['deliverOverride', [body.ticketId, body.reason]],
        abandon: ['abandonTicket', [body.ticketId, body.expectedRevision, ...(body.reason === undefined ? [] : [body.reason])]],
        unabandon: ['unabandonTicket', [body.ticketId, body.expectedRevision]],
        'root-agent': ['replaceRootAgent', [body.agentId, body.profile]],
        'root-flow': ['replaceRootOrchestration', [body.orchestrationId, body.definition]]
      };
      const [method, args] = actions[body.action];
      result = await service.human(target.id, 'dsh-dashboard', method, args);
    }
    return reply({ schemaVersion: 1, workspaceId: target.id, action: body.action, result });
  };
  // P-69 Root overview: read-only, one pass per registered Workspace. A failing project never hides the others.
  const summarizeTicket = ticket => ({
    id: ticket.id, workspaceId: ticket.workspaceId,
    title: ticket.plan?.title ?? null,
    goal: ticket.plan?.goal ?? ticket.plan?.ticket?.goal ?? ticket.goal ?? '',
    status: ticket.status, revision: ticket.revision,
    originSessionId: ticket.originSessionId ?? null,
    createdAt: ticket.createdAt ?? null,
    updatedAt: ticket.updatedAt ?? ticket.createdAt ?? null,
    incompatible: isIncompatibleDraft(ticket),
    abandonedAt: ticket.abandonedAt ?? null,
    nodes: (Array.isArray(ticket.nodes) ? ticket.nodes : []).map(node => ({ id: node.id, status: node.status })),
    gates: (Array.isArray(ticket.gates) ? ticket.gates : []).map(gate => ({ id: gate.id, status: gate.status, from: gate.from ?? [], reviewer: gate.reviewer ?? null, coverage: gate.coverage ?? null, dispatch: gate.dispatch?.phase ?? null }))
  });
  const overview = async request => {
    if ([...new URL(request.url).searchParams].length) invalid('Overview takes no query parameters.');
    let service;
    try { service = await getService({ readOnly: true }); }
    catch (error) { fail(503, 'service-unavailable', error instanceof Error ? error.message : String(error)); }
    const projects = [];
    for (const entry of ctx.workspaceRegistry.list()) {
      if (typeof entry?.id !== 'string') continue;
      const project = { workspaceId: entry.id, title: entry.title ?? null, path: typeof entry.path === 'string' ? entry.path : null, state: 'ok', error: null, tickets: [], series: [] };
      try {
        const target = workspace(entry.id);
        try { if (!(await stat(target.path)).isDirectory()) fail(409, 'workspace-unavailable', 'Registered Workspace path is not a directory.'); }
        catch (error) {
          if (error instanceof RequestFailure) throw error;
          fail(error.code === 'ENOENT' ? 404 : 409, 'workspace-unavailable', `Registered Workspace directory is unavailable: ${error.message}`);
        }
        checkMapping(service, target);
        const { tickets, series } = await service.readOverviewProject(entry.id);
        if (tickets.some(ticket => ticket.workspaceId !== entry.id)) fail(500, 'workspace-state-mismatch', 'Fleet returned a Ticket from another Workspace.');
        project.tickets = tickets.map(ticket => summarizeTicket(projectTicket(ticket)));
        project.series = series;
        validateTarget(service, target);
      } catch (error) {
        project.state = 'error'; project.tickets = []; project.series = [];
        project.error = { code: error instanceof RequestFailure ? error.code : 'fleet/read-failed', message: error instanceof Error ? error.message : String(error) };
      }
      projects.push(project);
    }
    const health = service.health;
    return reply({ schemaVersion: 1, pluginVersion, scheduleStatus: service.scheduleStatus?.() ?? { available: false, unavailableReason: 'Host schedule service is unavailable; scheduling cannot be enabled.' }, projects, health: { ready: health.ready, error: health.error } });
  };
  const handle = (method, operation) => request => {
    if (disposed) return Promise.resolve(errorResponse(new RequestFailure(503, 'unavailable', 'Fleet Dashboard is closing.')));
    if (request.method !== method) return Promise.resolve(errorResponse(new RequestFailure(405, 'method-not-allowed', `Use ${method}.`)));
    const task = Promise.resolve().then(() => operation(request)).catch(errorResponse);
    pending.add(task);
    task.finally(() => pending.delete(task));
    return task;
  };
  try {
    unregister.push(ctx.connection.fetch.register({ path: '/api/fleet/drafts', methods: ['GET'], requestBody: 'buffered', fetch: handle('GET', drafts) }));
    unregister.push(ctx.connection.fetch.register({ path: '/api/fleet/view', methods: ['GET'], requestBody: 'buffered', fetch: handle('GET', view) }));
    unregister.push(ctx.connection.fetch.register({ path: '/api/fleet/action', methods: ['POST'], requestBody: 'buffered', fetch: handle('POST', act) }));
    unregister.push(ctx.connection.fetch.register({ path: '/api/fleet/progress', methods: ['GET'], requestBody: 'buffered', fetch: handle('GET', progress) }));
    unregister.push(ctx.connection.fetch.register({ path: '/api/fleet/overview', methods: ['GET'], requestBody: 'buffered', fetch: handle('GET', overview) }));
  } catch (error) {
    disposed = true;
    for (const dispose of unregister.reverse()) dispose();
    throw error;
  }
  return async () => {
    if (disposed) return;
    disposed = true;
    const results = await Promise.allSettled(unregister.reverse().map(dispose => Promise.resolve().then(dispose)));
    await Promise.allSettled([...pending]);
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Fleet Dashboard route cleanup failed.');
  };
}
