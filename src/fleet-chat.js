/** Native DSH Chat entrypoints. Human controls live only in the command registry. */
import { normalizePlan, projectTicket, seriesRecurrence, effectiveSeriesTiming } from './fleet-model.js';
const output = value => JSON.stringify(value, null, 2);
const parse = text => { try { return JSON.parse(text); } catch { throw new Error('Expected valid JSON. Use /fleet help for the plan format.'); } };
const words = (text, count) => {
  const result = []; let rest = text.trim();
  for (let i = 0; i < count; i++) {
    const match = /^(\S+)(?:\s+|$)/.exec(rest);
    if (!match) throw new Error('Missing command argument. Use /fleet help.');
    result.push(match[1]); rest = rest.slice(match[0].length);
  }
  return [...result, rest];
};
// P-50: catalog projection tolerates an absent or failing host model catalog; it never blocks reads.
const modelCatalogProjection = service => (typeof service?.modelCatalog === 'function' ? service.modelCatalog() : Promise.reject(new Error('Model catalog capability is unavailable.')))
  .catch(error => ({ default: null, routableProviders: [], groups: [], failures: [{ id: 'host', name: 'Model catalog', message: error instanceof Error ? error.message : String(error) }] }));
export const fleetHelp = `Fleet — long-running tasks in the current Workspace

Use /fleet new YOUR_REQUEST to create a draft Ticket on the spot and configure it with an Agent, editable in the sidebar, Chat or Dashboard until you start it. There is no separate confirmation step: your edits are your confirmation, and /fleet start freezes the snapshot and executes.

Agents can draft and inspect, and may execute your explicitly requested start/resume through the fleet_start tool; only your decision starts or stops execution or overrides a Gate. Saying "start it" in chat is enough — the Agent will call fleet_start for you. Starting finalizes the draft snapshot.

Execution Agents report completion with the fleet_submit tool (artifacts, acceptanceResults, verification with source "agent-report", summary); each submission seals a new artifact version. /fleet review evidence may be plain text or a JSON object with findings and artifactRefs. /fleet deliverables shows each deliverable's latest version and review status; /fleet deliver-override explicitly releases delivery when bindings or coverage are missing and records the reason.

/fleet new TICKET_REQUEST
/fleet list
/fleet show TICKET
/fleet start TICKET
/fleet stop TICKET
/fleet resume TICKET
/fleet retry TICKET NODE reason
/fleet thread TICKET NODE
/fleet say TICKET NODE message
/fleet change TICKET NODE REVISION {"prompt":"new task","summary":"I will ..., achieving ..."}
/fleet pass TICKET GATE
/fleet review TICKET GATE passed|returned evidence
/fleet deliverables TICKET
/fleet deliver-override TICKET reason
/fleet catalog
/fleet health
/fleet root-agent ID PROFILE_JSON
/fleet root-flow ID FLOW_JSON
/fleet root-settings SETTINGS_JSON
/fleet repair TICKET REVISION [PLAN_JSON]
/fleet regenerate TICKET REVISION [PLAN_JSON]

Plan JSON:
{"contractVersion":3,"goal":"Deliver the requested artifact","inputs":{},"deliverables":[{"title":"Verified artifact","description":"The requested result with checkable evidence","category":"noncode","files":[{"path":"artifact.md","purpose":"result, evidence paths, source dates"}],"text":"artifact.md: result, evidence paths, source dates","criteria":["Artifact exists and is verified"]}],"criteria":[],"agents":{"writer":{"name":"Writer","profile":{"instructions":"Write and verify the requested artifact."}}},"nodes":[{"id":"write","role":"writer","agentId":"writer","dependsOn":[],"task":{"summary":"I will write and verify the artifact so the result is acceptance-ready","prompt":"Create the requested artifact","stagePlan":{"goal":"Produce an acceptance-ready artifact for the requester","tasks":["Draft the artifact","Verify it against the criteria"],"outcomes":[{"kind":"deliverable","deliverableIndex":0}]},"plannedCapabilities":[{"kind":"tool","id":"write","name":"Write","purpose":"Create the artifact file"}]}}],"gates":[]}

Deliverables are dual-layer items {text,title,description,criteria,category?,files?}: title is the human theme (not a file list), description says at a high level what the deliverable contains and achieves, text is the full agent-executable spec (paths, files, commands, source/date requirements), criteria are that deliverable's own acceptance criteria. Set category by what the human receives — "code" (pages, scripts, config: what is implemented or fixed), "noncode" (reports, research, plans: what information is gained or which task completes), or "other". List the files this deliverable owes in files as [{path?,purpose?}] with one-line human purposes; give a path when known, keep a purpose-only entry when the path is undetermined, never guess paths. plan.criteria holds only ticket-wide criteria spanning deliverables. Legacy plain-string deliverables stay valid. Goal is one plain sentence stating what this task accomplishes; long-term ambition belongs in requirements/background, not in the goal sentence. Every node carries task.summary, one human sentence "I will ..., achieving ..."; task.prompt keeps the full spec. Every node also declares task.stagePlan {goal?, tasks?: string[], outcomes?: [{kind:"deliverable"|"event", text?, deliverableIndex?}]} — this stage's goal, the tasks to complete, and the expected deliverable or event outcomes — plus task.plannedCapabilities [{kind:"tool"|"plugin"|"skill", id, name?, purpose, tools?: string[]}] naming the tools, plugins and skills the Agent will use for this stage and what each is for. Skills load on demand by kebab-case name: declare kind:"skill" when a reusable procedure or domain guide helps, with what it is for. The plan always shows a Skills group, so an empty list is an explicit "no skill needed" statement. Use an empty array when no specific capability is needed; never invent plugin or skill ids. Optional modelSelection {provider,model,reasoningEffort?} on profile and on nodes (node overrides agent) must come from the fleet_catalog modelCatalog; omit it to inherit the host default.

A goal-only draft is valid; incomplete configuration is checked when starting. plan describes the task, execution stores actual results and frozen configurations, activity records changes. One Ticket keeps its identity through draft/start/stop/resume. Edit plan in draft or stopped; running and stop-requested lock configuration. Completed work and historical attempts are preserved. Copy Template content from fleet_catalog into this Ticket by value, assign nodes directly by local agentId, and keep roles as display labels. Starting never publishes templates to Root. Templates, global rules, generation rules and execution rules are shared settings; consume the applicable rules from fleet_catalog. Use supported agentPreset/instructions/modelSelection Profiles only. Old/unknown plans require explicit repair or regeneration from the Dashboard, or /fleet repair TICKET REVISION and /fleet regenerate TICKET REVISION [PLAN_JSON]; originals remain traceable. These commands do not start execution. A task runs only after /fleet start succeeds. Native Session IDs open full node conversations.`;

export const fleetPlanningInstructions = `You are configuring a Fleet draft Ticket with the user in this native conversation.
The request already exists (or will exist) as a draft Ticket: the create command usually pre-creates it; saving with fleet_draft action=save and no ticketId creates it instead. Read fleet_catalog first.
Read fleet_draft action=read before every edit; save the FULL updated plan with its ticketId and original expectedRevision. The SAME Ticket is editable in draft or stopped. Preserve every unedited field and resolve revision conflicts by reading again, never blindly retry an old replacement.
Plan shape: {contractVersion:3,goal,inputs:{},deliverables:[],criteria:[],requirements?,agents:{localId:{name?,profile}},nodes:[{id,role?,agentId:null|string,dependsOn:[],task:{prompt,summary?,stagePlan?,plannedCapabilities?},modelSelection?}],gates:[{id,from:[],to:[],reviewer:{kind:"human"}|{kind:"agent",nodeId},reviewTask?:{summary,inputs:string[],checks:string[]},modelSelection?,plannedCapabilities?}]}. For every Agent Gate, describe its specific purpose, source materials and decision criteria in reviewTask. Use the shared reviewer node for identity and shared configuration. Omitted modelSelection/plannedCapabilities inherit. An explicit plannedCapabilities list replaces the inherited list, including []. Keep Gate review checks separate from rework scope. A goal-only draft is valid.
Rewrite goal as one plain sentence saying what this Ticket accomplishes for the user (keep it short and scannable). Put long-term ambitions, budgets, constraints and source references in requirements or inputs — not in the goal sentence. The user's original request stays traceable in this conversation and in Ticket history; do not quote it verbatim into goal when a concise sentence works.
Deliverables are dual-layer items {text,title,description,criteria,category?,files?}: write title as the human theme (not a file list), description as a high-level "what it contains and achieves", text as the full agent-executable spec (paths, files, commands, source/date requirements), and criteria as that deliverable's own acceptance criteria; each multi-line criterion stays one item. Set category by what the human receives: "code" (say what is implemented or fixed), "noncode" (say what information is gained or which task completes), or "other". List the files this deliverable owes in files as [{path?,purpose?}] with one-line purposes; give a path when known, keep a purpose-only entry when the path is undetermined, never guess paths. Legacy plain-string deliverables remain valid; do not rewrite them unless editing that item. plan.criteria holds only ticket-wide criteria spanning deliverables (governance, boundaries).
Every node needs task.summary: one sentence "I will ..., achieving ..." (what it does and what purpose it achieves) for human readers; task.prompt keeps the full agent spec.
Every node also declares its stage plan in task.stagePlan: goal (why this stage exists), tasks (what the Agent will do, one action per item), and outcomes (what must exist at the end — kind "deliverable" for files or results, kind "event" for a status or decision that must happen; link a Ticket deliverable with deliverableIndex when one matches). Write both file outcomes and event outcomes when both apply. Then declare task.plannedCapabilities: one entry per tool, plugin or skill the Agent will use here — {kind:"tool"|"plugin"|"skill", id, name?, purpose, tools?: string[]} — where purpose says concretely what it achieves for this stage, and tools may name specific tools a plugin provides. Skills are loaded on demand by their kebab-case id, so include kind:"skill" whenever a reusable procedure or domain guide helps this stage and say what it is for; the node panel always shows a Skills group, so [] is an explicit "no skill needed" statement. Declare capabilities per node, even for the same Agent. Use [] when the stage truly needs no specific capability, and never invent ids; only name capabilities that plausibly exist for the Agent's preset.
Optional modelSelection {provider,model,reasoningEffort?} on agents[id].profile and on nodes (node overrides agent; omitted inherits the host default). Choose only models and efforts listed in fleet_catalog modelCatalog. Flat profile.model/provider/temperature/maxTokens/reasoningEffort remain unsupported.
Copy chosen Template content by value; node.agentId is direct, role is only a label. Do not create binding, orchestration or nested ticket fields. Read Root settings rules and generation.rules from fleet_catalog and apply them while preparing the plan.
The start decision belongs to the human. When the user explicitly asks in this conversation to start or resume this Ticket, call fleet_start with its ticketId to execute that decision; never call it to advance your own plan, to guess intent, or for another conversation's Ticket. Without an explicit request, do not start. Running/stop-requested configuration is locked. Older or unknown plans must be explicitly repaired or regenerated, preserving their originals; do not silently replace them in the ordinary editor. Never claim execution started without actual evidence. Summarize the plan in the user's language and invite edits.`;

export function registerFleetChat(ctx, { getService, resolveAgentContext, defineTool, createUserMessage }) {
  const disposers = [];
  const context = async agent => {
    if (!agent) throw new Error('Fleet requires a current DSH Session.');
    const resolved = await resolveAgentContext(agent);
    if (!resolved?.workspaceId || !resolved?.workspacePath || !resolved?.sessionId) throw new Error('The current Session is not associated with a registered Workspace.');
    const service = await getService();
    await service.registerWorkspace(resolved.workspaceId, resolved.workspacePath);
    return { ...resolved, service };
  };
  const tool = (name, description, parameters, execute) => {
    const dispose = ctx.tools.register(defineTool({ name, description, parameters,
      output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      execute: async (args, exec) => { exec.signal?.throwIfAborted(); const c = await context(exec.agent); exec.signal?.throwIfAborted(); return { text: output(await execute(args, c)) }; }
    }));
    if (typeof dispose === 'function') disposers.push(dispose);
  };
  tool('fleet_catalog', 'Read shared Root Templates (Agent/Profile and Orchestration), global settings, generation/execution rules, available presets and the host modelCatalog (default selection, models and efforts) before preparing a Ticket. Copy template content into this Ticket; this never starts execution.', {}, async (_args, c) => {
    const catalog = await c.service.catalog();
    const presets = ctx.agentPresets?.list?.();
    const modelCatalog = await modelCatalogProjection(c.service);
    return { ...catalog, ...(presets ? { availablePresets: await presets } : {}), modelCatalog };
  });
  tool('fleet_status', 'Read current Workspace Fleet Tickets, or one Ticket including progress, Node Sessions, delivery, Gate reviews and human changes. Never authorizes starting or bypassing anything.', { ticketId: { type: 'string', description: 'Omit to list Tickets in the current Workspace.' } }, (args, c) => c.service.read(c.workspaceId, args.ticketId));
  tool('fleet_thread', 'Find the native DSH Session and current or historical attempts for a Fleet node. Use this to show the user where to directly talk to that node.', { ticketId: { type: 'string', required: true }, nodeId: { type: 'string', required: true } }, async (args, c) => {
    const ticket = projectTicket(await c.service.read(c.workspaceId, args.ticketId)); const node = ticket.nodes.find(n => n.id === args.nodeId);
    if (!node) throw new Error('Unknown Ticket node.'); return { ticketId: ticket.id, nodeId: node.id, attempts: node.attempts, thread: node.thread };
  });
  tool('fleet_submit', 'Submit structured completion evidence for the current execution Node (P-44). Execution Sessions only: the Host resolves Ticket/Node/Attempt from sessionOwner and rejects planning, review and cross-origin Sessions. artifacts seal a new version and return {artifactId,version,sha256}; the same Attempt may submit again. Shape errors return diagnostics and do not block a corrected resubmission. No finalize, start or Gate decision capability.', {
    artifacts: { type: 'array', description: 'Files to seal as artifact versions.', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', description: 'Workspace-relative file path.', required: true }, deliverableIndex: { type: 'number', description: 'Index into the frozen plan deliverables.' }, mediaType: { type: 'string' } } } },
    acceptanceResults: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { criterion: { type: 'string' }, status: { type: 'string', enum: ['passed', 'failed', 'unknown'], required: true }, evidence: { type: 'string' } } } },
    verification: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { command: { type: 'string', required: true }, exitCode: { type: 'number' }, output: { type: 'string' }, source: { type: 'string', enum: ['agent-report'], required: true } } } },
    summary: { type: 'string' },
    handoff: { type: 'json' }
  }, (args, c) => c.service.submitEvidence({ sessionId: c.sessionId, payload: args }));
  const planningContext = async c => {
    if (await c.service.ownsSession(c.sessionId)) throw new Error('Execution Sessions cannot configure or confirm Fleet drafts.');
  };
  tool('fleet_start', 'Execute a start/resume decision the user explicitly made in this conversation (P-51): starts a draft Ticket or resumes a stopped one. ONLY call when the user clearly asked to start/resume this Ticket — never to advance your own plan, never to guess intent, never for a Ticket owned by another conversation. Runs exactly the same validation as /fleet start (plan, DAG, Profile, model catalog, CAS); the activity records the Agent acting via a user request. No stop, Gate or Root capability.', { ticketId: { type: 'string', required: true, description: 'ID of the draft or stopped Ticket owned by this conversation.' } }, async (args, c) => {
    await planningContext(c);
    return projectTicket(await c.service.agentStart(c.workspaceId, c.sessionId, args.ticketId));
  });
  tool('fleet_draft', 'Read or save this conversation’s Ticket configuration in draft or stopped status. Saving without ticketId creates it; saving with ticketId and original expectedRevision replaces the complete plan under CAS. Preserve unedited fields. Running configuration is locked. Saving never starts execution or publishes templates; starting is a human decision — via the UI buttons, /fleet start, or fleet_start only when the user explicitly asked in this conversation. Read before every edit. For recurring Tickets ask the user whether the edit applies to this Ticket or the entire series, then save with that scope and both revisions; never infer a series-wide change. Execution Sessions cannot use this tool. Legacy plans require explicit repair or regeneration.', {
    action: { type: 'string', enum: ['read', 'save'], required: true },
    ticketId: { type: 'string', description: 'Existing draft Ticket ID. Omit on read to list this conversation drafts, or save to create.' },
    expectedRevision: { type: 'number', description: 'Latest revision from read, required to update.' },
    scope: { type: 'string', enum: ['ticket', 'series'], description: 'For a recurring Ticket ask the user whether this edit applies to this Ticket only or the entire series, then pass their choice. An ordinary Ticket needs no scope.' },
    seriesId: { type: 'string', description: 'For a series edit use the recurring series ID from the Ticket read.' },
    expectedSeriesRevision: { type: 'number', description: 'Series revision from the same read, required when updating that series.' },
    sourceRefs: { type: 'string', description: 'Optional JSON array when applying Templates: [{kind:"agent"|"orchestration",templateId,templateRevision,localId?,nodeIds?}]. Use actual catalog versions; agent.localId is the Ticket Agent ID. Omit to preserve existing provenance.' },
    plan: { type: 'string', description: 'Complete canonical plan JSON: {contractVersion:3,goal,inputs?,deliverables?:string|{text,title?,description?,criteria?,category?:("code"|"noncode"|"other"),files?:[{path?,purpose?}]}[],criteria?:string[] (ticket-wide),requirements?,agents?:{localId:{name?,profile}},nodes?:[{id,role?,agentId,dependsOn,task:{prompt,summary?,stagePlan?,plannedCapabilities?},modelSelection?}],gates?:[{id,from,to,reviewer,reviewTask?:{summary,inputs:string[],checks:string[]},modelSelection?,plannedCapabilities?}]}. Goal-only drafts are valid. Agent Gate reviewTask states what THIS gate checks, separate from shared reviewer-node work; omitted modelSelection/plannedCapabilities inherit from reviewer node, supplied values override only this Gate and are used in review dispatch. Goal is one plain sentence stating what the Ticket accomplishes; long-term ambition goes to requirements/background. Deliverable objects carry the human title/description, the full agent spec text, their own criteria, a category by what the human receives, and the files this deliverable owes with purposes (path only when known). Every node needs a one-sentence task.summary plus task.stagePlan {goal?,tasks?,outcomes?} and task.plannedCapabilities [{kind,id,name?,purpose,tools?}] (skill entries are loaded on demand by id; empty array when nothing specific is needed). modelSelection {provider,model,reasoningEffort?} must come from modelCatalog. Copy Template content by value; no binding or nested ticket object.' }
  }, async (args, c) => {
    await planningContext(c);
    if (args.action === 'read' && !args.ticketId) return c.service.listDraftTickets(c.workspaceId, c.sessionId);
    if (args.action === 'read') {
      const found = await c.service.read(c.workspaceId, args.ticketId);
      if (!found) throw new Error('No Ticket with this ID belongs to this Workspace.');
      if (found.originSessionId && found.originSessionId !== c.sessionId) throw new Error('This draft belongs to another conversation.');
      const members = (await c.service.readSeries(c.workspaceId)).filter(series => seriesRecurrence(series) === 'recurring' && ['active', 'paused'].includes(series.status) && (series.sourceTicketId === found.id || series.occurrences.some(receipt => receipt.ticketId === found.id)));
      return members.length ? { ...found, scheduledSeries: members.map(series => ({ id: series.id, revision: series.revision, name: series.name, status: series.status, timing: effectiveSeriesTiming(series) })) } : found;
    }
    if (args.action === 'save') {
      const input = { sessionId: c.sessionId, plan: normalizePlan(parse(args.plan)), actor: { kind: 'agent' } };
      if (args.ticketId) Object.assign(input, { ticketId: args.ticketId, expectedRevision: args.expectedRevision });
      if (args.sourceRefs !== undefined) input.sourceRefs = parse(args.sourceRefs);
      if (args.scope !== undefined) {
        if (!args.ticketId) throw new Error('A scoped edit requires an existing Ticket.');
        return c.service.saveDraftWithScope(c.workspaceId, { ...input, scope: args.scope, ...(args.seriesId !== undefined ? { seriesId: args.seriesId } : {}), ...(args.expectedSeriesRevision !== undefined ? { expectedSeriesRevision: args.expectedSeriesRevision } : {}) });
      }
      return c.service.saveDraftTicket(c.workspaceId, input);
    }
    throw new Error('Unknown draft action.');
  });
  // Canonical request-to-draft journey for `/fleet new` (2026-11-13 namespace decision;
  // the earlier `/oh-my-agent-fleet create ticket` command was retired the same day).
  const createTicketJourney = async ({ agent, requestText, attachments = [], signal }) => {
    const c = await context(agent); await planningContext(c);
    if (typeof agent.steer !== 'function' || typeof createUserMessage !== 'function') throw new Error('Native planning conversation is unavailable.');
    const hasRequest = typeof requestText === 'string' && requestText.trim().length > 0;
    const request = hasRequest ? requestText.trim() : 'Ask me what I want this Ticket to accomplish.';
    signal?.throwIfAborted();
    // Two-phase lifecycle: an explicit request creates the draft Ticket immediately;
    // the Agent later creates it via fleet_draft only when this pre-creation is unavailable.
    let createdId = '';
    if (hasRequest) {
      createdId = (await c.service.saveDraftTicket(c.workspaceId, { sessionId: c.sessionId, plan: normalizePlan({ goal: request }), actor: { kind: 'human', userId: `dsh-command:${c.sessionId}` } })).id;
    }
    const settings = (await c.service.catalog()).settings;
    const generationRules = [...(settings?.rules ?? []), ...(settings?.generation?.rules ?? [])];
    const ruleText = generationRules.length ? `\n\nRoot generation rules (settings revision ${settings.revision}):\n${generationRules.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}` : '';
    await agent.steer(createUserMessage({ content: [...attachments, { type: 'text', text: `${fleetPlanningInstructions}${ruleText}\n\n${createdId ? `Draft Ticket ${createdId}. ` : ''}User Ticket request:\n${request}` }], source: { kind: 'user' } }));
    return { kind: 'success', text: 'Fleet · Ticket draft / 任务草稿' };
  };
  const disposeCommand = ctx.commands.register({
    name: 'fleet', description: 'Create, run, inspect and control Fleet tasks in this Workspace.', input: { hint: 'new | help | list | show | start | stop | thread | pass | retry' },
    handler: async ({ agent, rawInput, attachments = [], signal }) => {
      try {
        signal?.throwIfAborted(); const text = rawInput.trim();
        if (!text || text === 'help') return { kind: 'success', text: fleetHelp };
        const [action, rest] = words(text, 1);
        if (action === 'new') return await createTicketJourney({ agent, requestText: rest, attachments, signal });
        const c = await context(agent);
        const human = (method, args) => c.service.human(c.workspaceId, `dsh-command:${c.sessionId}`, method, args);
        let result;
        if (action === 'health') result = c.service.health;
        else if (action === 'catalog') result = { ...await c.service.catalog(), availablePresets: await ctx.agentPresets?.list?.(), modelCatalog: await modelCatalogProjection(c.service) };
        else if (action === 'list') result = await c.service.read(c.workspaceId);
        else if (action === 'show') result = await c.service.read(c.workspaceId, rest.trim());
        else if (['start', 'stop', 'resume'].includes(action)) result = await human(action, [rest.trim()]);
        else if (action === 'pass') { const [ticket, gate] = words(rest, 2); result = await human('forcePassGate', [ticket, gate]); }
        else if (action === 'retry') { const [ticket, node, message] = words(rest, 2); result = await human('retryNode', [ticket, node, message]); }
        else if (action === 'review') {
          const [ticket, gate, decision, evidenceText] = words(rest, 3);
          let evidence = evidenceText;
          try { const parsed = JSON.parse(evidenceText); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) evidence = parsed; } catch { /* plain-text evidence */ }
          result = await human('reviewGate', [ticket, gate, decision, evidence]);
        }
        else if (action === 'deliverables') { const [ticketId] = words(rest, 1); result = projectTicket(await c.service.read(c.workspaceId, ticketId)).deliverables; }
        else if (action === 'deliver-override') { const [ticketId, reason] = words(rest, 1); result = await human('deliverOverride', [ticketId, reason]); }
        else if (action === 'say') { const [ticket, node, message] = words(rest, 2); result = await human('commentNode', [ticket, node, message]); }
        else if (action === 'change') {
          const [ticket, node, revisionText, task] = words(rest, 3);
          const revision = Number(revisionText);
          if (!/^\d+$/.test(revisionText) || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Expected a positive Ticket revision from /fleet show.');
          result = await human('changeNode', [ticket, node, parse(task), `User /fleet change: ${task}`, revision]);
        }
        else if (action === 'thread') { const [ticketId, nodeId] = words(rest, 2); const ticket = projectTicket(await c.service.read(c.workspaceId, ticketId)); result = ticket.nodes.find(n => n.id === nodeId); if (!result) throw new Error('Unknown Ticket node.'); }
        else if (action === 'repair' || action === 'regenerate') {
          const [ticketId, revisionText, content] = words(rest, 2);
          const expectedRevision = Number(revisionText);
          if (!/^\d+$/.test(revisionText) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Expected a positive Ticket revision from /fleet show.');
          let plan = content.trim() ? normalizePlan(parse(content)) : undefined;
          if (action === 'regenerate' && plan === undefined) {
            const previous = await c.service.read(c.workspaceId, ticketId);
            plan = normalizePlan({ goal: previous.plan?.goal ?? previous.plan?.ticket?.goal ?? previous.goal });
          }
          result = action === 'repair'
            ? await human('repairTicket', [ticketId, expectedRevision, ...(plan === undefined ? [] : [plan])])
            : await human('regenerateTicket', [ticketId, expectedRevision, plan, c.sessionId]);
        }
        else if (action === 'root-settings') result = await human('replaceGlobalSettings', [parse(rest)]);
        else if (action === 'root-agent' || action === 'root-flow') { const [id, value] = words(rest, 1); result = await human(action === 'root-agent' ? 'replaceRootAgent' : 'replaceRootOrchestration', [id, parse(value)]); }
        else throw new Error('Unknown Fleet command. Use /fleet help.');
        return { kind: 'success', text: output(result) };
      } catch (error) { return { kind: 'error', text: error instanceof Error ? error.message : String(error) }; }
    }
  });
  if (typeof disposeCommand === 'function') disposers.push(disposeCommand);
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
