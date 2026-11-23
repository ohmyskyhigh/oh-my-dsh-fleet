/** Synchronous canonical Ticket domain. Trusted capabilities never escape to Agent tools. */
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PLAN_CONTRACT_VERSION, TICKET_STATUSES, normalizePlan, validatePlan, isCurrentPlan, repairLegacyPlan, projectTemplate, deliverableView, readableTitle, isUtcInstant as utc } from './fleet-model.js';

export class FleetCoreError extends Error {
  constructor(code, message) { super(message); this.name = 'FleetCoreError'; this.code = code; }
}
const fail = (code, message) => { throw new FleetCoreError(code, message); };
const requireThat = (value, code, message) => { if (!value) fail(code, message); };
const object = (v, label) => { requireThat(v && typeof v === 'object' && !Array.isArray(v), 'invalid-input', `${label} must be an object.`); return v; };
const text = (v, label) => { requireThat(typeof v === 'string' && v.trim(), 'invalid-input', `${label} must be nonempty text.`); return v; };
const copy = value => structuredClone(value);
const now = () => new Date().toISOString();
const inflight = d => ['created', 'submit-intent', 'submitted', 'uncertain'].includes(d?.phase);
const finishedNode = status => status === 'completed' || status === 'skipped';
const finishedGate = status => status === 'passed' || status === 'skipped';
const skippedItem = (execution, item) => Boolean(item?.whenNodeRuns && execution.nodes[item.whenNodeRuns]?.status === 'skipped');
const ownValue = (map, key) => map && Object.hasOwn(map, key) ? map[key] : undefined;
const allRefs = (plan, key) => [...new Set([plan, ...(plan.nodes ?? [])].flatMap(part => part[key] ?? []))];
function matchesCondition(handoff, { path, operator, value }) {
  let actual = handoff;
  for (const key of path) {
    if (actual === null || typeof actual !== 'object' || !Object.hasOwn(actual, key)) return false;
    actual = actual[key];
  }
  if (operator === 'exists') return true;
  if (operator === 'eq') return actual === value;
  if (operator === 'ne') return actual !== value;
  if (typeof actual !== typeof value || !['string', 'number'].includes(typeof actual)) return false;
  switch (operator) {
    case 'gt': return actual > value;
    case 'gte': return actual >= value;
    case 'lt': return actual < value;
    case 'lte': return actual <= value;
    default: return false;
  }
}
const archived = (original, format) => ({ format, sha256: createHash('sha256').update(JSON.stringify(original)).digest('hex'), original: copy(original) });
export function nativeProgressRow(item, actor) {
  const { time, intent, text, step, status, tool } = item;
  if (!['execution', 'status', 'step'].includes(intent) || typeof text !== 'string' || !text.trim() || !Number.isFinite(Date.parse(time))) return null;
  const row = { id: `native-${actor.attemptId}-${item.id}`, time, intent, text, actor, attemptId: actor.attemptId };
  if (step !== undefined) row.step = step;
  if (status !== undefined) row.status = status;
  if (tool !== undefined) row.tool = tool;
  return row;
}
export const defaultSettings = () => ({ revision: 1, rules: [], generation: { rules: [] }, execution: { rules: [] } });
// P-65 scheduled series: the host owns calendar rules; Fleet freezes the plan and records occurrences.
const SERIES_STATUSES = ['active', 'paused', 'orphaned', 'ended'];
const TIMING_KINDS = ['after', 'at', 'every', 'daily', 'weekly', 'cron', 'rrule'];
const SERIES_HOST_KEYS = ['status', 'scheduledAt', 'lastDeliveryAt', 'title', 'timing'];
const SERIES_KEYS = ['id', 'workspaceId', 'revision', 'name', 'plan', 'sourceTicketId', 'sourceRefs', 'scheduleId', 'targetSessionId', 'timing', 'status', 'occurrences', 'createdAt', 'updatedAt'];
const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function assertSeriesShape(s, workspaceId) {
  object(s, 'series');
  requireThat(Object.keys(s).every(k => [...SERIES_KEYS, 'host', 'sourceTemplateId', 'triggerSeriesId', 'triggerAfterCount'].includes(k)) && SERIES_KEYS.every(k => Object.hasOwn(s, k)), 'invalid-state', 'Invalid series fields.');
  text(s.id, 'series id'); requireThat(s.workspaceId === workspaceId, 'invalid-state', 'Series workspaceId does not match its Workspace.');
  requireThat(Number.isSafeInteger(s.revision) && s.revision > 0, 'invalid-state', 'Invalid series revision.');
  text(s.name, 'series name'); text(s.scheduleId, 'series scheduleId'); text(s.targetSessionId, 'series targetSessionId');
  requireThat(s.sourceTicketId === null || typeof s.sourceTicketId === 'string' && s.sourceTicketId.length > 0, 'invalid-state', 'series sourceTicketId must be a Ticket ID or null.');
  requireThat(Array.isArray(s.sourceRefs), 'invalid-state', 'series sourceRefs must be an array.');
  if (s.triggerSeriesId !== undefined || s.triggerAfterCount !== undefined) {
    requireThat(typeof s.triggerSeriesId === 'string' && s.triggerSeriesId !== s.id && Number.isSafeInteger(s.triggerAfterCount) && s.triggerAfterCount >= 0, 'invalid-state', 'Invalid upstream series trigger.');
    requireThat(allRefs(s.plan, 'ticketDependencySeries').includes(s.triggerSeriesId), 'invalid-state', 'Trigger must be a configured upstream series.');
  }
  if (s.sourceTemplateId !== undefined) text(s.sourceTemplateId,'series source template');
  for (const ref of s.sourceRefs) {
    requireThat(isRecord(ref) && typeof ref.templateId === 'string' && ref.templateId.trim() && Number.isSafeInteger(ref.templateRevision) && ref.templateRevision >= 1,'invalid-state','Invalid series template reference.');
    requireThat(ref.kind === 'agent' ? typeof ref.localId === 'string' && ref.localId.trim() : ref.kind === 'orchestration' && Array.isArray(ref.nodeIds) && ref.nodeIds.every(id => typeof id === 'string' && id.trim()),'invalid-state','Invalid series template reference scope.');
  }
  requireThat(isRecord(s.timing) && TIMING_KINDS.includes(s.timing.kind), 'invalid-state', 'Invalid series timing.');
  requireThat(SERIES_STATUSES.includes(s.status), 'invalid-state', 'Invalid series status.');
  requireThat(utc(s.createdAt) && utc(s.updatedAt), 'invalid-state', 'Invalid series timestamps.');
  object(s.plan, 'series plan');
  // Check a retired series snapshot without changing the version used by the start guard.
  const planForValidation = s.plan.contractVersion === 2 ? { ...s.plan, contractVersion: PLAN_CONTRACT_VERSION } : s.plan;
  requireThat(validatePlan(planForValidation, { mode: 'save' }).valid, 'invalid-state', 'Invalid series plan.');
  planInput(planForValidation, { allowMissingVersion: false });
  requireThat(Array.isArray(s.occurrences), 'invalid-state', 'series occurrences must be an array.');
  const seen = new Set();
  for (const o of s.occurrences) {
    object(o, 'occurrence');
    requireThat(Object.keys(o).every(k => ['occurrenceAt', 'ticketId', 'status', 'error', 'createdAt'].includes(k)) && ['occurrenceAt', 'ticketId', 'status', 'createdAt'].every(k => Object.hasOwn(o, k)), 'invalid-state', 'Invalid occurrence fields.');
    requireThat(utc(o.occurrenceAt) && !seen.has(Date.parse(o.occurrenceAt)), 'invalid-state', 'Invalid or duplicate occurrenceAt.');
    seen.add(Date.parse(o.occurrenceAt));
    requireThat(utc(o.createdAt), 'invalid-state', 'Invalid occurrence createdAt.');
    if (['started','waiting'].includes(o.status)) requireThat(typeof o.ticketId === 'string' && o.ticketId.length > 0, 'invalid-state', 'A started occurrence needs its Ticket ID.');
    else requireThat(o.status === 'failed' && o.ticketId === null && typeof o.error === 'string' && o.error.trim(), 'invalid-state', 'A failed occurrence needs null ticketId and an error.');
  }
  if (s.host !== undefined) {
    object(s.host, 'series host');
    requireThat(Object.keys(s.host).every(k => SERIES_HOST_KEYS.includes(k)), 'invalid-state', 'Unexpected series host field.');
    for (const k of ['status', 'scheduledAt', 'lastDeliveryAt', 'title']) if (s.host[k] !== undefined && s.host[k] !== null) requireThat(typeof s.host[k] === 'string', 'invalid-state', `series host.${k} must be text or null.`);
    if (s.host.timing !== undefined && s.host.timing !== null) object(s.host.timing, 'series host.timing');
  }
}
/** P-67 nested scope merge: only what THIS save changed propagates into the series plan.
 * Objects merge per key; plan.nodes/plan.gates merge per stable id (a ticket-only exception on
 * another node, or on another field of the same node, never leaks). Other arrays replace atomically. */
function mergeSeriesChange(base, before, after, key) {
  if (isDeepStrictEqual(before, after)) return copy(base);
  if (isDeepStrictEqual(base, before)) return copy(after);
  if (['nodes', 'gates'].includes(key) && Array.isArray(base) && Array.isArray(before) && Array.isArray(after)
    && [...base, ...before, ...after].every(item => typeof item?.id === 'string')) {
    const baseById = new Map(base.map(item => [item.id, item])), beforeById = new Map(before.map(item => [item.id, item]));
    const afterIds = new Set(after.map(item => item.id));
    const merged = new Map();
    for (const item of after) {
      const prior = beforeById.get(item.id), target = baseById.get(item.id);
      if (!target && prior && isDeepStrictEqual(prior,item)) continue;
      requireThat(target || !prior, 'state-conflict', `Cannot apply a partial change to ${item.id}, which is absent from the series.`);
      requireThat(prior || !target || isDeepStrictEqual(target, item), 'state-conflict', `The series already has a different ${key} entry named ${item.id}.`);
      merged.set(item.id, prior ? mergeSeriesChange(target,prior,item) : copy(item));
    }
    const retained = base.filter(item => afterIds.has(item.id) || !beforeById.has(item.id));
    const reordered = !isDeepStrictEqual(before.filter(item => afterIds.has(item.id)).map(item => item.id), after.filter(item => beforeById.has(item.id)).map(item => item.id));
    if (reordered) return [...merged.values(), ...retained.filter(item => !merged.has(item.id))];
    const result = retained.map(item => merged.get(item.id) ?? copy(item));
    // Place new entries next to their following shared neighbour, while keeping series-only entries in order.
    let insertAt = result.length;
    for (const item of after.toReversed()) {
      if (baseById.has(item.id)) insertAt = result.findIndex(entry => entry.id === item.id);
      else if (merged.has(item.id)) result.splice(insertAt, 0, merged.get(item.id));
    }
    return result;
  }
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(base)) {
    // Positional lists (e.g. deliverables) have no durable identity. Merge edits in place;
    // a simultaneous change in membership cannot safely be aligned across the two plans.
    if (base.length !== before.length || before.length !== after.length) {
      if (isDeepStrictEqual(base, after)) return copy(base);
      fail('state-conflict', `The series and this Ticket have different ${key || 'list'} entries. Edit the series configuration to change this list.`);
    }
    return after.map((item, i) => mergeSeriesChange(base[i], before[i], item));
  }
  if ((base === undefined || isRecord(base)) && isRecord(before) && isRecord(after)) {
    const out = base === undefined ? {} : copy(base);
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const had = Object.hasOwn(before, k), has = Object.hasOwn(after, k);
      if (had && has && isDeepStrictEqual(before[k], after[k])) continue;
      if (!has) { delete out[k]; continue; }
      const value = had ? mergeSeriesChange(Object.hasOwn(out,k) ? out[k] : undefined, before[k], after[k]) : copy(after[k]);
      Object.defineProperty(out,k,{value,writable:true,enumerable:true,configurable:true});
    }
    return out;
  }
  return copy(after);
}
export function normalizeSettings(input) {
  const settings = copy(object(input, 'settings'));
  requireThat(Object.keys(settings).every(k => ['revision', 'rules', 'generation', 'execution'].includes(k)), 'invalid-input', 'Unexpected global settings field.');
  settings.revision ??= 1; settings.rules ??= []; settings.generation ??= { rules: [] }; settings.execution ??= { rules: [] };
  requireThat(Number.isSafeInteger(settings.revision) && settings.revision > 0, 'invalid-input', 'Invalid settings revision.');
  for (const rules of [settings.rules, settings.generation.rules, settings.execution.rules]) requireThat(Array.isArray(rules) && rules.every(r => typeof r === 'string'), 'invalid-input', 'Global rules must be text arrays.');
  for (const part of [settings.generation, settings.execution]) requireThat(Object.keys(part).every(k => k === 'rules'), 'invalid-input', 'Unsupported rules setting.');
  return settings;
}
const planInput = (input, options) => { try { return normalizePlan(input, options); } catch (e) { throw Object.assign(new FleetCoreError(e.code ?? 'invalid-input', e.message), { diagnostics: e.diagnostics }); } };
export const assertStart = plan => { const result = validatePlan(plan, { mode: 'start' }); if (!result.valid) throw Object.assign(new FleetCoreError(result.errors[0].code, result.errors.map(e => `${e.path}: ${e.message}`).join(' ')), { diagnostics: result.errors }); };

function migrateTemplate(row, kind) {
  const content = kind === 'agent' ? { ...(row.name !== undefined ? { name: row.name } : {}), profile: copy(row.profile) } : copy(row.definition);
  if (kind === 'orchestration') for (const n of content.nodes ?? []) n.agentId ??= null;
  return { id: row.id, kind, name: row.name ?? row.id, revision: row.revision, content,
    source: row.sourceId ? { templateId: row.sourceId, templateRevision: null } : null,
    history: (row.history ?? []).map(h => ({ revision: h.revision, content: kind === 'agent' ? { profile: copy(h.profile) } : copy(h.definition), ...(h.source !== undefined ? { source: h.source } : {}), actor: h.actor ?? { kind: 'system' }, time: h.time ?? null })),
    createdAt: row.createdAt ?? null, updatedAt: row.updatedAt ?? row.history?.at(-1)?.time ?? null, legacy: archived(row, 'root-definition-v1') };
}
function migrateTicket(t, workspace, state) {
  if (Object.hasOwn(t, 'execution') && Array.isArray(t.activity)) return copy(t);
  const createdAt = t.createdAt ?? t.events?.[0]?.time ?? null, updatedAt = t.updatedAt ?? t.events?.at(-1)?.time ?? createdAt;
  const activity = (t.events ?? []).map(e => ({ ...copy(e), ticketRevision: e.ticketRevision ?? null }));
  for (const c of t.changes ?? []) activity.push({ id: `legacy-change-${c.id}`, time: c.time ?? null, type: 'plan-edited', actor: c.actor ?? { kind: 'system' }, ticketRevision: c.revision ?? null, detail: copy(c) });
  const originalPlan = t.plan ?? { ticket: { ...(t.goal === undefined ? {} : { goal: t.goal }), inputs: t.inputs ?? {}, criteria: t.criteria ?? [] } };
  let execution = null, plan = copy(originalPlan);
  if (t.snapshot) {
    const snapshot = t.snapshot;
    const originalFlow = snapshot.orchestration?.definition;
    const frozenAgents = Object.values(snapshot.agents ?? {});
    const legacyPlan = { ticket: { goal: snapshot.goal ?? t.goal, inputs: snapshot.inputs ?? {}, criteria: snapshot.criteria ?? [] }, agents: frozenAgents.map(a => ({ id: a.id, profile: a.profile })), orchestration: { definition: originalFlow }, binding: snapshot.binding };
    let frozenPlan = null;
    try { frozenPlan = repairLegacyPlan(legacyPlan); } catch { /* Exact snapshot remains available; unsupported execution cannot silently resume. */ }
    // Old node revisions are not configuration revisions. Retain their meanings and
    // leave historical attempt references unknown rather than manufacture a snapshot.
    const configRevision = Math.max(1, t.revision ?? 1);
    execution = { currentConfigRevision: configRevision, configurations: { [configRevision]: { frozenAt: t.events?.find(e => e.type === 'ticket-started')?.time ?? null, plan: frozenPlan, sourceRefs: [], legacySnapshot: copy(snapshot) } }, nodes: {}, gates: {}, legacy: { readOnly: !frozenPlan } };
    for (const node of t.nodes ?? []) {
      const { id, role, dependsOn, task, ...facts } = node;
      execution.nodes[id] = { ...copy(facts), attempts: (node.attempts ?? []).map(a => ({ ...copy(a), configRevision: null, legacyConfigRevision: configRevision })), legacyDefinition: { id, ...(role === undefined ? {} : { role }), ...(dependsOn === undefined ? {} : { dependsOn: copy(dependsOn) }), ...(task === undefined ? {} : { task: copy(task) }) } };
    }
    for (const gate of t.gates ?? []) {
      const { id, from, to, reviewer, ...facts } = gate;
      execution.gates[id] = { ...copy(facts), configRevision: null, reviews: (gate.reviews ?? []).map(r => ({ ...copy(r), configRevision: null })), legacyDefinition: { id, ...(from === undefined ? {} : { from: copy(from) }), ...(to === undefined ? {} : { to: copy(to) }), ...(reviewer === undefined ? {} : { reviewer: copy(reviewer) }) } };
    }
    // Current executable plan comes only from the old frozen snapshot plus actual
    // persisted node changes; never from today's Root definitions.
    if (frozenPlan) {
      plan = copy(frozenPlan);
      for (const node of t.nodes ?? []) { const current = plan.nodes.find(n => n.id === node.id); if (current && node.task !== undefined) current.task = copy(node.task); }
      execution.legacy.readOnly = true; // Explicit repair is required before new execution.
    }
  }
  return { id: t.id, workspaceId: t.workspaceId ?? workspace.id, originSessionId: t.originSessionId ?? t.sessionId ?? null, status: t.status === 'confirmed' ? 'draft' : t.status, revision: Math.max(1, t.revision ?? 1), createdAt, updatedAt, plan, execution, activity,
    legacy: { ...archived(t, 'ticket-v1'), context: { agents: copy(workspace.definitions?.agents?.length ? workspace.definitions.agents : state.agents ?? []), flows: copy(workspace.definitions?.flows?.length ? workspace.definitions.flows : state.flows ?? []), binding: copy(workspace.binding ?? null) } } };
}
export function migrateState(input) {
  const state = copy(input);
  if (state.schemaVersion === 2) return state;
  requireThat(state.schemaVersion === 1, 'invalid-state', 'Unsupported Fleet schemaVersion.');
  const workspaces = copy(state.workspaces ?? []);
  for (const d of state.drafts ?? []) {
    let w = workspaces.find(w => w.id === d.workspaceId);
    if (!w) { w = { id: d.workspaceId, tickets: [], binding: null }; workspaces.push(w); }
    const id = d.plan?.ticket?.id ?? d.ticketId ?? d.id;
    if (!w.tickets.some(t => t.id === id)) w.tickets.push({ ...d, id, originSessionId: d.sessionId ?? null, status: 'draft' });
  }
  const templates = [...(state.agents ?? []).map(a => migrateTemplate(a, 'agent')), ...(state.flows ?? []).map(f => migrateTemplate(f, 'orchestration'))];
  const used = new Set(), reserved = new Set(templates.map(t => t.id));
  for (const template of templates) {
    if (used.has(template.id)) { const originalId = template.id; let suffix = 0, id; do { id = `legacy-${template.kind}:${originalId}${suffix ? `:${suffix}` : ''}`; suffix++; } while (reserved.has(id)); template.id = id; reserved.add(id); }
    used.add(template.id);
  }
  return { schemaVersion: 2, templates, settings: defaultSettings(), workspaces: workspaces.map(w => ({ id: w.id, tickets: w.tickets.map(t => migrateTicket(t, w, state)), legacy: archived({ binding: w.binding ?? null, definitions: w.definitions ?? { agents: [], flows: [] } }, 'workspace-v1') })) };
}

export class FleetCore {
  #state = { schemaVersion: 2, templates: [], settings: defaultSettings(), workspaces: [] };
  exportState() { return copy(this.#state); }
  static fromState(input) {
    const core = new FleetCore();
    try {
      const state = migrateState(object(input, 'state'));
      requireThat(Array.isArray(state.templates) && Array.isArray(state.workspaces), 'invalid-state', 'Invalid state collections.');
      state.settings = normalizeSettings(state.settings);
      const unique = (rows, label) => requireThat(new Set(rows.map(r => text(r.id, label))).size === rows.length, 'invalid-state', `Duplicate ${label}.`);
      unique(state.templates, 'Template'); unique(state.workspaces, 'Workspace');
      const sessions = new Set(), attempts = new Set();
      for (const template of state.templates) { requireThat(['agent', 'orchestration'].includes(template.kind) && Number.isSafeInteger(template.revision) && template.revision > 0, 'invalid-state', 'Invalid Template.'); object(template.content, 'Template content'); requireThat(Array.isArray(template.history), 'invalid-state', 'Invalid Template history.'); }
      for (const w of state.workspaces) {
        requireThat(Array.isArray(w.tickets) && !('binding' in w || 'definitions' in w), 'invalid-state', 'Workspace stores Tickets only.'); unique(w.tickets, 'Ticket');
        if (Object.hasOwn(w, 'series')) {
          requireThat(Array.isArray(w.series), 'invalid-state', 'Workspace series must be an array.'); unique(w.series, 'Series');
          for (const s of w.series) {
            assertSeriesShape(s, w.id);
            for (const o of s.occurrences) if (o.status === 'waiting') requireThat(w.tickets.some(t => t.id === o.ticketId), 'invalid-state', 'Waiting occurrence has no Ticket.');
          }
        }
        for (const t of w.tickets) {
          requireThat(t.workspaceId === w.id && Number.isSafeInteger(t.revision) && t.revision > 0 && TICKET_STATUSES.includes(t.status), 'invalid-state', 'Invalid Ticket identity, revision or status.');
          // P-69 manual abandonment: optional; absent on every pre-existing record (compat).
          if (t.abandonedAt !== undefined) requireThat(utc(t.abandonedAt) && ['draft', 'stopped'].includes(t.status), 'invalid-state', 'Invalid Ticket abandonment record.');
          // Deleting a replacement draft leaves its predecessor readable without a dangling link.
          if (t.replacementDeleted !== undefined) requireThat(isRecord(t.replacementDeleted) && typeof t.replacementDeleted.ticketId === 'string' && !!t.replacementDeleted.ticketId && utc(t.replacementDeleted.time) && t.supersededBy === undefined, 'invalid-state', 'Invalid deleted-replacement record.');
          requireThat(Array.isArray(t.activity) && Object.hasOwn(t, 'execution'), 'invalid-state', 'Invalid canonical Ticket.');
          requireThat(!['snapshot', 'nodes', 'gates', 'events', 'changes', 'goal', 'inputs', 'criteria'].some(k => Object.hasOwn(t, k)), 'invalid-state', 'Ticket contains persisted display aliases.');
          if (!t.legacy) {
            // Read-only compatibility gate against the plugin-built-in support-version (PLAN_CONTRACT_VERSION,
            // admin-set per release, not user-modifiable). Valid plans normalize idempotently. A version-mismatched
            // plan loads untouched for ANY status (no mutation, no auto-archive): drafts/superseded are derived as
            // incompatible by the UI (recreate path); executed tickets keep their historical frozen configuration.
            // Version mismatch is not corruption — a support-version bump must not break historical executed records.
            // Execution structure is still validated strictly below. The gate never mutates state, so chain guards hold.
            if (validatePlan(t.plan, { mode: 'save' }).valid) planInput(t.plan, { allowMissingVersion: false });
          }
          if (t.dependencyAuthorization !== undefined) {
            const auth = t.dependencyAuthorization;
            requireThat(t.status === 'draft' && !t.abandonedAt && isRecord(auth) && Number.isSafeInteger(auth.revision) && auth.revision > 0 && auth.revision <= t.revision && utc(auth.time) && isRecord(auth.actor), 'invalid-state', 'Invalid dependency authorization.');
          }
          if (t.dependencyBindings !== undefined) requireThat(isRecord(t.dependencyBindings) && Object.entries(t.dependencyBindings).every(([sid, tid]) => w.series?.some(s => s.id === sid && s.occurrences.some(o => o.ticketId === tid && tid))), 'invalid-state', 'Invalid dependency bindings.');
          if (t.execution) {
            const e = t.execution; object(e.nodes, 'execution nodes'); object(e.gates, 'execution gates'); object(e.configurations, 'configurations');
            requireThat(Object.hasOwn(e.configurations, e.currentConfigRevision), 'invalid-state', 'Missing frozen configuration.');
            // P-44～P-46 optional groups: coarse shape checks only; old records read as absent.
            if (e.artifacts !== undefined) { object(e.artifacts, 'execution artifacts'); for (const a of Object.values(e.artifacts)) { requireThat(typeof a.nodeId === 'string' && Array.isArray(a.versions), 'invalid-state', 'Invalid artifact.'); for (const v of a.versions) requireThat(Number.isSafeInteger(v.version) && v.version > 0 && typeof v.sha256 === 'string', 'invalid-state', 'Invalid artifact version.'); } }
            if (e.deliverables !== undefined) object(e.deliverables, 'execution deliverables');
            if (e.delivery !== undefined) { object(e.delivery, 'delivery'); requireThat(Array.isArray(e.delivery.history), 'invalid-state', 'Invalid delivery history.'); }
            if (e.logicDecisions !== undefined) {
              object(e.logicDecisions, 'Logic Gate decisions');
              for (const [id, decision] of Object.entries(e.logicDecisions)) {
                const gate = e.configurations[decision?.configRevision]?.plan?.logicGates?.find(g => g.id === id);
                requireThat(gate && decision.gateId === id && decision.from === gate.from && e.nodes[gate.from]?.attempts.at(-1)?.id === decision.attemptId && e.nodes[gate.from]?.status === 'completed' && Array.isArray(decision.routes) && decision.routes.length === gate.routes.length && decision.routes.every((r, i) => r.id === gate.routes[i].id && typeof r.matched === 'boolean'), 'invalid-state', 'Invalid persisted Logic Gate decision.');
              }
            }
            for (const n of Object.values(e.nodes)) {
              requireThat(['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'skipped'].includes(n.status) && Array.isArray(n.attempts) && Array.isArray(n.thread), 'invalid-state', 'Invalid Node execution.');
              for (const a of n.attempts) {
                requireThat(!attempts.has(a.id), 'invalid-state', 'Duplicate Attempt.'); attempts.add(a.id);
                requireThat(a.configRevision === null && t.legacy || Object.hasOwn(e.configurations, a.configRevision), 'invalid-state', 'Unknown Attempt configuration.');
                if (a.sessionId) { requireThat(!sessions.has(a.sessionId), 'invalid-state', 'Duplicate Session ownership.'); sessions.add(a.sessionId); }
                if (a.dispatch?.sessionId) requireThat(a.sessionId === a.dispatch.sessionId, 'invalid-state', 'Attempt and dispatch Session mismatch.');
                if (a.completion !== undefined) { object(a.completion, 'completion'); requireThat(Array.isArray(a.completion.artifactRefs) && a.completion.evidenceKind === 'agent-report', 'invalid-state', 'Invalid Attempt completion.'); }
              }
              if (n.status === 'running') requireThat(n.attempts.at(-1)?.status === 'running', 'invalid-state', 'Running Node lacks active Attempt.');
            }
            const gateSessions = g => { if (g.dispatch?.sessionId) { requireThat(!sessions.has(g.dispatch.sessionId), 'invalid-state', 'Duplicate Session ownership.'); sessions.add(g.dispatch.sessionId); } };
            const gateShape = g => { requireThat(['pending', 'passed', 'returned', 'skipped'].includes(g.status) && Array.isArray(g.reviews), 'invalid-state', 'Invalid Gate.'); if (g.autoReworkRounds !== undefined) requireThat(Number.isSafeInteger(g.autoReworkRounds) && g.autoReworkRounds >= 0, 'invalid-state', 'Invalid Gate rework budget.'); for (const r of g.reviews) if (r.artifactRefs !== undefined) requireThat(Array.isArray(r.artifactRefs), 'invalid-state', 'Invalid review artifactRefs.'); gateSessions(g); };
            for (const g of Object.values(e.gates)) { gateShape(g); for (const h of g.history ?? []) gateSessions(h); }
            if (t.status === 'stopped') requireThat(!Object.values(e.nodes).some(n => ['running', 'pending'].includes(n.status)) && !Object.values(e.gates).some(g => inflight(g.dispatch)), 'invalid-state', 'Stopped Ticket has active work.');
            if (t.status === 'delivered') {
              requireThat(Object.values(e.nodes).every(n => finishedNode(n.status)) && Object.values(e.gates).every(g => finishedGate(g.status)), 'invalid-state', 'Delivered Ticket is incomplete.');
              const declared = e.configurations[e.currentConfigRevision]?.plan?.deliverables ?? [];
              // Tickets that engaged the evidence protocol must carry delivery evidence; pre-0.6.0
              // delivered records without the new groups keep their original invariant (compat).
              if (declared.length && (e.artifacts || e.deliverables || e.delivery)) requireThat(e.delivery?.override || declared.every((item, i) => skippedItem(e, item) || (e.deliverables?.[String(i)]?.artifactId && e.delivery?.history?.some(h => (h.items ?? []).some(it => it.deliverableIndex === i)))), 'invalid-state', 'Delivered Ticket lacks delivery evidence.');
            }
          } else requireThat(['draft', 'superseded'].includes(t.status), 'invalid-state', 'Started Ticket needs execution.');
        }
      }
      core.#state = state; return core;
    } catch (e) { if (e.code === 'invalid-state') throw e; fail('invalid-state', `Invalid Fleet state: ${e.message}`); }
  }
  #workspace(id, create = false) { let w = this.#state.workspaces.find(w => w.id === id); if (!w && create) { w = { id: text(id, 'Workspace ID'), tickets: [] }; this.#state.workspaces.push(w); } requireThat(w, 'unknown-workspace', 'Workspace is not mapped.'); return w; }
  #ticket(ws, id) { const t = this.#workspace(ws).tickets.find(t => t.id === id); requireThat(t, 'unknown-ticket', 'Ticket does not belong to this Workspace.'); return t; }
  #validateDependencies(w, id, plan, seriesId = null, bindings = {}) {
    const visit = (key, edges, seen, active) => {
      if (active.has(key)) fail('invalid-flow', `Dependency cycle at ${key}.`);
      if (seen.has(key)) return;
      active.add(key);
      for (const upstream of edges(key)) visit(upstream, edges, seen, active);
      active.delete(key); seen.add(key);
    };
    const ticketEdges = key => {
      const row = w.tickets.find(t => t.id === key);
      const spec = key === id ? plan : row?.plan;
      requireThat(spec, 'unknown-ticket', `Unknown upstream Ticket ${key}.`);
      const map = key === id ? bindings : row.dependencyBindings;
      return [...allRefs(spec, 'ticketDependencies'), ...allRefs(spec, 'ticketDependencySeries').map(s => ownValue(map, s)).filter(Boolean)];
    };
    if (id !== null) visit(id, ticketEdges, new Set(), new Set());
    else for (const key of allRefs(plan, 'ticketDependencies')) visit(key, ticketEdges, new Set(), new Set());
    const seriesEdges = key => {
      const spec = key === seriesId ? plan : w.series?.find(s => s.id === key)?.plan;
      requireThat(spec, 'unknown-series', `Unknown upstream series ${key}.`);
      return allRefs(spec, 'ticketDependencySeries');
    };
    for (const key of allRefs(plan, 'ticketDependencySeries')) visit(key, seriesEdges, new Set(), new Set());
  }
  #dependencyReadiness(t, nodeId) {
    const plan = t.execution && !['draft','stopped'].includes(t.status) ? this.#config(t).plan : t.plan;
    const spec = nodeId === undefined ? plan : plan.nodes.find(n => n.id === nodeId);
    requireThat(spec, 'unknown-node', 'Unknown dependency scope.');
    const series = spec.ticketDependencySeries ?? [];
    const waitingSeriesIds = series.filter(id => !ownValue(t.dependencyBindings, id));
    const ticketIds = [...new Set([...(spec.ticketDependencies ?? []), ...series.map(id => ownValue(t.dependencyBindings, id)).filter(Boolean)])];
    const pinned = nodeId !== undefined ? t.execution?.nodes[nodeId]?.dependencyInputs : t.execution?.dependencyInputs;
    const waitingTicketIds = ticketIds.filter(id => !pinned?.some(input => input.ticketId === id) && !t.execution?.dependencyInputs?.some(input => input.ticketId === id) && this.#workspace(t.workspaceId).tickets.find(up => up.id === id)?.status !== 'delivered');
    return { ready: !waitingSeriesIds.length && !waitingTicketIds.length, ticketIds, waitingTicketIds, waitingSeriesIds };
  }
  #upstreamInputs(t, ids) {
    return ids.map(ticketId => {
      const upstream = this.#ticket(t.workspaceId, ticketId), e = upstream.execution;
      const frozen = this.#config(upstream).plan, receipt = e.delivery?.history?.slice(e.delivery.cycleStart ?? 0).at(-1);
      const deliverables = (frozen?.deliverables ?? []).flatMap((item, index) => {
        if (skippedItem(e, item)) return [];
        const bound = receipt?.items?.find(it => it.deliverableIndex === index);
        return [{ index, label: deliverableView(item).label, ...(bound ? { artifactId: bound.artifactId, version: bound.version, sha256: bound.sha256, snapshotPath: e.artifacts[bound.artifactId].versions.find(v => v.version === bound.version).snapshotPath } : { evidenceStatus: 'unbound' }) }];
      });
      return { ticketId, goal: frozen?.goal ?? upstream.plan.goal ?? '', deliverables, ...(receipt ? { deliveryId: receipt.id } : {}), ...(e.delivery?.override ? { overrideReason:e.delivery.override.reason } : {}) };
    });
  }
  #dependencyStartReady(t) {
    return t.status === 'draft' && !t.abandonedAt && t.dependencyAuthorization?.revision === t.revision && this.#dependencyReadiness(t).ready;
  }
  #startWhenReady(t, expectedRevision) {
    if ((expectedRevision !== undefined && expectedRevision !== t.revision) || !this.#dependencyStartReady(t)) return copy(t);
    return this.#start(t.workspaceId, t.id, { kind: 'system', via: 'dependencies', authorizedBy: t.dependencyAuthorization.actor });
  }
  #authorize(t, actor) {
    if (t.dependencyAuthorization?.revision !== t.revision) {
      this.#touch(t); t.dependencyAuthorization = { revision: t.revision, actor: copy(actor), time: now() };
      this.#event(t, 'dependencies-enabled', actor);
    }
  }
  #config(t) { return t.execution.configurations[t.execution.currentConfigRevision]; }
  #definition(t, id, kind = 'nodes') { return this.#config(t).plan?.[kind]?.find(n => n.id === id) ?? t.execution[kind][id]?.legacyDefinition; }
  #node(t, id) { const n = t.execution?.nodes?.[id]; requireThat(n, 'unknown-node', 'Unknown Ticket Node.'); return n; }
  #gate(t, id) { const g = t.execution?.gates?.[id]; requireThat(g, 'unknown-gate', 'Unknown Ticket Gate.'); return g; }
  #touch(t) { t.revision++; t.updatedAt = now(); }
  #event(t, type, actor, detail = {}) { t.activity.push({ id: randomUUID(), time: t.updatedAt ?? now(), type, actor: copy(actor), ticketRevision: t.revision, detail: copy(detail) }); }
  #editable(t) { requireThat(['draft', 'stopped'].includes(t.status), 'control-locked', 'Stop execution completely before editing configuration.'); requireThat(isCurrentPlan(t.plan) && !t.execution?.legacy?.readOnly, 'legacy-plan', 'Legacy Ticket requires explicit repair before editing.'); }
  #cas(t, revision) { requireThat(Number.isSafeInteger(revision) && t.revision === revision, 'stale-revision', 'Ticket revision changed; reload without discarding unsaved edits.'); }
  #preserveCompleted(t, next) {
    if (!t.execution) return;
    const prior = this.#config(t).plan;
    for (const [id, state] of Object.entries(t.execution.nodes)) {
      const before = prior.nodes.find(n => n.id === id), after = next.nodes.find(n => n.id === id);
      if ((state.attempts.length || state.thread.length) && !after) fail('completed-work-conflict', `Node ${id} has execution or discussion history and must remain in this Ticket.`);
      if (state.status !== 'completed') continue;
      requireThat(['ticketDependencies','ticketDependencySeries'].every(k => isDeepStrictEqual(prior[k], next[k])), 'completed-work-conflict', 'Whole-Ticket dependencies for completed work are frozen.');
      requireThat(after && ['agentId', 'dependsOn', 'task', 'ticketDependencies', 'ticketDependencySeries'].every(k => isDeepStrictEqual(before[k], after[k])) && isDeepStrictEqual(prior.agents[before.agentId]?.profile, next.agents[after.agentId]?.profile), 'completed-work-conflict', `Editing Node ${id} would rewrite completed work.`);
      const incoming = plan => (plan.logicGates ?? []).filter(g => g.routes.some(r => r.to.includes(id)));
      requireThat(isDeepStrictEqual(incoming(prior), incoming(next)), 'completed-work-conflict', 'Editing incoming Logic Gates would rewrite completed work.');
      const beforeGates = prior.gates.filter(g => g.to.includes(id)), afterGates = next.gates.filter(g => g.to.includes(id));
      requireThat(isDeepStrictEqual(beforeGates, afterGates), 'completed-work-conflict', `Editing incoming Gates of completed Node ${id} requires explicit rework.`);
    }
    for (const [gateId] of Object.entries(t.execution.logicDecisions ?? {})) {
      const before = prior.logicGates.find(g => g.id === gateId), after = next.logicGates?.find(g => g.id === gateId);
      requireThat(isDeepStrictEqual(before, after), 'completed-work-conflict', 'An evaluated Logic Gate is frozen until its source is retried.');
    }
    for (const [id, g] of Object.entries(t.execution.gates)) {
      const before = prior.gates.find(g => g.id === id), after = next.gates.find(g => g.id === id);
      if (g.reviews.length || g.humanOverride || g.dispatch || g.history?.length) requireThat(after && isDeepStrictEqual(before, after), 'completed-work-conflict', `Gate ${id} has review history; its identity and structure must remain stable.`);
    }
  }
  saveDraftTicket(ws, { ticketId = null, id: newId, sessionId = null, plan, sourceRefs, expectedRevision, actor = { kind: 'preparation' } } = {}) {
    const w = this.#workspace(ws, true);
    const prior = ticketId === null ? null : this.#ticket(ws, ticketId);
    if (prior) { this.#editable(prior); this.#cas(prior, expectedRevision); if (sessionId && prior.originSessionId) requireThat(sessionId === prior.originSessionId, 'draft-scope', 'Ticket belongs to another planning conversation.'); }
    const data = planInput(plan, { allowMissingVersion: !prior });
    const sources = sourceRefs === undefined ? [] : this.#sources(data, sourceRefs);
    if (!prior) {
      requireThat(expectedRevision === undefined, 'stale-revision', 'New Ticket must not specify expectedRevision.');
      const id = newId ?? randomUUID(); text(id, 'Ticket ID'); requireThat(!w.tickets.some(t => t.id === id), 'duplicate-id', 'Ticket ID already exists.');
      this.#validateDependencies(w, id, data);
      const time = now(), t = { id, workspaceId: ws, originSessionId: sessionId, status: 'draft', revision: 1, createdAt: time, updatedAt: time, plan: data, execution: null, activity: [] };
      this.#event(t, 'ticket-created', actor); for (const source of sources) this.#event(t, 'template-applied', actor, source); w.tickets.push(t); return copy(t);
    }
    this.#validateDependencies(w, prior.id, data, null, prior.dependencyBindings);
    this.#preserveCompleted(prior, data);
    if (isDeepStrictEqual(prior.plan, data) && !sources.length) return copy(prior);
    const before = copy(prior.plan), baseRevision = prior.revision;
    delete prior.dependencyAuthorization;
    prior.plan = data; this.#touch(prior); this.#event(prior, 'plan-edited', actor, { paths: Object.keys(data).filter(k => !isDeepStrictEqual(before[k], data[k])).map(k => `plan.${k}`), before, after: copy(data), baseRevision }); for (const source of sources) this.#event(prior, 'template-applied', actor, source); return copy(prior);
  }
  instantiateTemplate(ws, { templateId, templateRevision, overrides, assignments = {}, sessionId = null, id, actor }) {
    const flow = this.#template(templateId, 'orchestration');
    const version = templateRevision === undefined || templateRevision === flow.revision ? flow : flow.history.find(h => h.revision === templateRevision);
    requireThat(version?.content, 'invalid-input', 'Unknown orchestration template revision.');
    object(assignments, 'assignments'); object(overrides, 'overrides');
    requireThat(Object.keys(overrides).every(k => ['goal','title','inputs','deliverables','criteria','requirements'].includes(k)), 'invalid-input', 'Unexpected template override.');
    const { nodes, gates } = copy(version.content);
    const agents = new Map(), missing = [];
    const sourceRefs = [{ kind: 'orchestration', templateId, templateRevision: version.revision, nodeIds: nodes.map(n => n.id) }];
    for (const node of nodes) {
      const agentId = Object.hasOwn(assignments, node.id) ? assignments[node.id] : node.agentId;
      const template = this.#state.templates.find(t => t.kind === 'agent' && t.id === agentId);
      if (!template) { missing.push(node.id); continue; }
      node.agentId = agentId;
      if (agents.has(agentId)) continue;
      agents.set(agentId, { name: template.name, profile: copy(template.content.profile) });
      sourceRefs.push({ kind: 'agent', templateId: agentId, templateRevision: template.revision, localId: agentId });
    }
    if (missing.length) throw Object.assign(new FleetCoreError('incomplete-plan', `Assign an Agent to Nodes: ${missing.join(', ')}.`), {diagnostics:missing.map(nodeId => ({nodeId,path:`nodes.${nodeId}.agentId`,code:'incomplete-plan',message:'Assign a Root Agent template.'}))});
    return this.saveDraftTicket(ws, { id, sessionId, plan: { contractVersion: PLAN_CONTRACT_VERSION, ...overrides, agents: Object.fromEntries(agents), nodes, gates }, sourceRefs, actor });
  }
  #series(ws, id) { const s = this.#workspace(ws).series?.find(s => s.id === id); requireThat(s, 'unknown-series', 'Unknown Fleet series in this Workspace.'); return s; }
  listSeries(ws) { return copy(this.#state.workspaces.find(w => w.id === ws)?.series ?? []); }
  readSeries(ws, id) { return copy(this.#series(ws, id)); }
  findSeriesForTicket(ws, id) { return this.listSeries(ws).find(s => s.sourceTicketId === id || s.occurrences.some(o => o.ticketId === id)) ?? null; }
  createSeries(ws, { id = randomUUID(), name, plan, sourceTicketId = null, sourceTemplateId, sourceRefs, scheduleId, targetSessionId, timing, host, requestActor, triggerSeriesId }) {
    const w = this.#workspace(ws, true), frozen = planInput(plan, { allowMissingVersion: false }); assertStart(frozen);
    text(id,'series id'); text(name,'series name'); text(scheduleId,'scheduleId'); text(targetSessionId,'targetSessionId');
    requireThat(!w.series?.some(s => s.id === id || (!triggerSeriesId && !s.triggerSeriesId && s.scheduleId === scheduleId)), 'duplicate-id', 'Series or host schedule ID already exists.');
    const trigger = triggerSeriesId !== undefined ? this.#series(ws, triggerSeriesId) : null;
    if (trigger) requireThat(trigger.scheduleId === scheduleId && allRefs(frozen,'ticketDependencySeries').includes(trigger.id), 'invalid-input', 'Follower must reference its trigger series and share its clock.');
    this.#validateDependencies(w, null, frozen, id);
    if (sourceTicketId !== null) {
      const source = this.#ticket(ws, sourceTicketId);
      sourceRefs ??= this.#effectiveSources(source).map(({activityId,content,...ref}) => ref);
    }
    sourceRefs = this.#sources(frozen, sourceRefs ?? []);
    requireThat(isRecord(timing) && TIMING_KINDS.includes(timing.kind), 'invalid-input', 'Series needs the host schedule timing.');
    const time = now(), s = {id,workspaceId:ws,revision:1,name,plan:frozen,sourceTicketId,...(sourceTemplateId ? {sourceTemplateId} : {}),sourceRefs:copy(sourceRefs),scheduleId,targetSessionId,timing:copy(timing),status:'active',occurrences:[],createdAt:time,updatedAt:time,...(host ? {host:copy(host)} : {})};
    if (trigger) { s.triggerSeriesId = trigger.id; s.triggerAfterCount = trigger.occurrences.length; }
    if (requestActor) {
      const source = this.#ticket(ws, sourceTicketId), sourceRevision = source.revision;
      this.#touch(source);
      if (source.dependencyAuthorization?.revision === sourceRevision) source.dependencyAuthorization.revision = source.revision;
      this.#event(source, 'series-created', requestActor, {seriesId: id, scheduleId, sourceRevision});
    }
    (w.series ??= []).push(s); return copy(s);
  }
  updateSeriesPlan(ws, id, { fields, expectedRevision }) {
    const s = this.#series(ws,id); requireThat(s.revision === expectedRevision, 'stale-revision', 'Series revision changed; reload before applying the edit.');
    requireThat(s.status !== 'ended', 'state-conflict', 'An ended series keeps its history; create a new series instead.');
    const plan = {...s.plan,...object(fields,'series plan fields')};
    for (const k of Object.keys(fields)) if (fields[k] === undefined) delete plan[k];
    const next = planInput(plan, {allowMissingVersion:false});
    if (s.triggerSeriesId) requireThat(allRefs(next,'ticketDependencySeries').includes(s.triggerSeriesId), 'invalid-input', 'A follower must retain its trigger series reference.');
    this.#validateDependencies(this.#workspace(ws), null, next, id);
    s.plan = next; this.#touch(s); return copy(s);
  }
  applySeriesChanges(ws,id,{before,after,expectedRevision}) {
    const s = this.#series(ws,id), fields = {};
    for (const k of new Set([...Object.keys(before),...Object.keys(after)])) if (!isDeepStrictEqual(before[k],after[k])) fields[k] = mergeSeriesChange(s.plan[k],before[k],after[k],k);
    return this.updateSeriesPlan(ws,id,{fields,expectedRevision});
  }
  setSeriesStatus(ws,id,status) {
    requireThat(SERIES_STATUSES.includes(status),'invalid-input','Invalid series status.'); const s = this.#series(ws,id);
    if (s.triggerSeriesId && s.status === 'paused' && status === 'active') s.triggerAfterCount = this.#series(ws,s.triggerSeriesId).occurrences.length;
    if (s.status !== status) { s.status = status; this.#touch(s); } return copy(s);
  }
  setSeriesHost(ws,id,host) { const s = this.#series(ws,id); s.host = copy(host); return copy(s); }
  recordOccurrenceAndStart(ws,id,{occurrenceAt}) {
    const s = this.#series(ws,id), prior = s.occurrences.find(o => Date.parse(o.occurrenceAt) === Date.parse(occurrenceAt));
    if (prior) return {duplicate:true,ticketId:prior.ticketId};
    requireThat(utc(occurrenceAt), 'invalid-input', 'Invalid occurrenceAt.'); assertStart(s.plan);
    requireThat(['active','paused'].includes(s.status),'state-conflict','Series has ended.');
    const actor = {kind:'system',via:'schedule',scheduleId:s.scheduleId,occurrenceAt};
    // Provenance survives series plan edits: refs are narrowed to what the frozen plan still contains.
    const refs = s.sourceRefs.map(ref => ref.kind === 'orchestration' ? {...ref, nodeIds:(ref.nodeIds ?? []).filter(nid => s.plan.nodes.some(n => n.id === nid))} : ref)
      .filter(ref => ref.kind === 'agent' ? Object.hasOwn(s.plan.agents, ref.localId) : ref.nodeIds.length > 0);
    const draft = this.saveDraftTicket(ws,{plan:s.plan,sessionId:s.targetSessionId,actor});
    const t = this.#ticket(ws,draft.id);
    for (const ref of refs) this.#event(t,'template-applied',actor,ref);
    t.activity[0].detail = {seriesId:id,seriesRevision:s.revision,scheduleId:s.scheduleId,occurrenceAt,via:'schedule'};
    s.occurrences.push({occurrenceAt,ticketId:t.id,status:'waiting',createdAt:now()});
    if (this.#dependencyReadiness(t).ready) this.#start(ws,t.id,actor);
    else this.#authorize(t,actor);
    s.updatedAt = now(); return {duplicate:false,ticketId:t.id};
  }
  #bindOccurrence(t, bindings) {
    const w = this.#workspace(t.workspaceId), series = w.series?.find(s => s.occurrences.some(o => o.ticketId === t.id));
    requireThat(series, 'unknown-series', 'Binding requires a scheduled occurrence.');
    if (!['draft','running'].includes(t.status) || t.abandonedAt) return copy(t);
    const wanted = allRefs(t.plan, 'ticketDependencySeries');
    const next = { ...t.dependencyBindings };
    for (const [seriesId, upstreamId] of Object.entries(object(bindings, 'series bindings'))) {
      requireThat(wanted.includes(seriesId) && this.#series(w.id, seriesId).occurrences.some(o => o.ticketId === upstreamId && upstreamId), 'invalid-input', 'Binding must refer to an occurrence of the configured series.');
      requireThat(!Object.hasOwn(next,seriesId) || next[seriesId] === upstreamId, 'state-conflict', 'Occurrence binding is immutable.');
      Object.defineProperty(next,seriesId,{value:upstreamId, enumerable:true, configurable:true, writable:true});
    }
    if (!isDeepStrictEqual(next, t.dependencyBindings ?? {})) {
      this.#validateDependencies(w, t.id, t.plan, null, next);
      t.dependencyBindings = next;
      const authorized = t.dependencyAuthorization?.revision === t.revision;
      this.#touch(t);
      if (authorized) t.dependencyAuthorization.revision = t.revision;
      this.#event(t, 'occurrence-bound', {kind:'system'}, {bindings: next});
    }
    return this.#startWhenReady(t);
  }
  recordOccurrenceFailure(ws,id,{occurrenceAt,error}) {
    const s = this.#series(ws,id), prior = s.occurrences.find(o => Date.parse(o.occurrenceAt) === Date.parse(occurrenceAt));
    if (prior) return {duplicate:true,ticketId:prior.ticketId};
    text(error,'occurrence error'); requireThat(utc(occurrenceAt), 'invalid-input', 'Invalid occurrenceAt.');
    s.occurrences.push({occurrenceAt,ticketId:null,status:'failed',error,createdAt:now()}); this.setSeriesStatus(ws,id,'paused'); return {duplicate:false,ticketId:null};
  }
  listWorkspaces() { return this.#state.workspaces.map(w => w.id); }
  listTickets(ws) { return copy(this.#state.workspaces.find(w => w.id === ws)?.tickets ?? []); }
  listDraftTickets(ws, sessionId) { return this.listTickets(ws).filter(t => t.status === 'draft' && (sessionId === undefined || t.originSessionId === sessionId)); }
  readTicket(ws, id) { return copy(this.#ticket(ws, id)); }
  #sources(plan, refs) {
    requireThat(Array.isArray(refs), 'invalid-input', 'sourceRefs must be an array.');
    return refs.map(ref => {
      object(ref, 'source reference'); requireThat(Object.keys(ref).every(k => ['kind', 'templateId', 'templateRevision', 'localId', 'nodeIds'].includes(k)), 'invalid-input', 'Unexpected source reference field.');
      requireThat(['agent', 'orchestration'].includes(ref.kind) && Number.isSafeInteger(ref.templateRevision), 'invalid-input', 'Source needs an actual template kind and revision.');
      const template = this.#template(ref.templateId, ref.kind);
      const version = template.revision === ref.templateRevision ? template : template.history.find(h => h.revision === ref.templateRevision);
      requireThat(version, 'invalid-input', 'Unknown template source revision.');
      if (ref.kind === 'agent') requireThat(typeof ref.localId === 'string' && Object.hasOwn(plan.agents, ref.localId) && ref.nodeIds === undefined, 'invalid-input', 'Agent source needs its local Agent ID.');
      else requireThat(Array.isArray(ref.nodeIds) && ref.nodeIds.every(id => plan.nodes.some(n => n.id === id)) && ref.localId === undefined, 'invalid-input', 'Orchestration source needs local Node IDs.');
      return { ...copy(ref), content: copy(version.content) };
    });
  }
  #effectiveSources(t) {
    const agents = new Map(), nodes = new Map();
    for (const event of t.activity) {
      const after = ['plan-edited', 'plan-repaired'].includes(event.type) && event.detail?.after;
      if (after) {
        for (const id of agents.keys()) if (!Object.hasOwn(after.agents ?? {}, id)) agents.delete(id);
        for (const id of nodes.keys()) if (!after.nodes?.some(n => n.id === id)) nodes.delete(id);
      }
      if (event.type !== 'template-applied') continue;
      const ref = { activityId: event.id, ...copy(event.detail) };
      if (ref.kind === 'agent') agents.set(ref.localId, ref);
      else for (const id of ref.nodeIds) nodes.set(id, ref);
    }
    const flows = new Map();
    for (const [id, ref] of nodes) if (t.plan.nodes.some(n => n.id === id)) { if (!flows.has(ref.activityId)) flows.set(ref.activityId, { ...copy(ref), nodeIds: [] }); flows.get(ref.activityId).nodeIds.push(id); }
    return [...agents.values()].filter(ref => Object.hasOwn(t.plan.agents, ref.localId)).concat([...flows.values()]);
  }
  #freeze(t) {
    assertStart(t.plan);
    const rules = { revision: this.#state.settings.revision, rules: copy(this.#state.settings.rules), execution: copy(this.#state.settings.execution) };
    const old = t.execution && this.#config(t);
    if (old && isDeepStrictEqual(old.plan, t.plan) && isDeepStrictEqual(old.rules?.rules, rules.rules) && isDeepStrictEqual(old.rules?.execution, rules.execution)) return;
    const revision = t.revision;
    t.execution ??= { currentConfigRevision: revision, configurations: {}, nodes: {}, gates: {} };
    t.execution.currentConfigRevision = revision;
    t.execution.configurations[revision] = { frozenAt: now(), plan: copy(t.plan), rules, sourceRefs: this.#effectiveSources(t) };
    for (const n of t.plan.nodes) {
      const state = t.execution.nodes[n.id] ??= { status: 'pending', attempts: [], thread: [] };
      if (state.status === 'skipped') state.status = 'pending';
    }
    for (const id of Object.keys(t.execution.nodes)) if (!t.plan.nodes.some(n => n.id === id) && !t.execution.nodes[id].attempts.length) delete t.execution.nodes[id];
    for (const g of t.plan.gates) {
      const existing = t.execution.gates[g.id];
      if (!existing) t.execution.gates[g.id] = { status: 'pending', configRevision: revision, cycle: 0, reviews: [], humanOverride: null, history: [] };
      else if (existing.status !== 'passed' && existing.configRevision !== revision) this.#archiveGate(existing, revision, { kind: 'system' }, 'configuration changed');
    }
    for (const id of Object.keys(t.execution.gates)) if (!t.plan.gates.some(g => g.id === id)) delete t.execution.gates[id];
  }
  #archiveGate(g, revision, actor, reason) { const { history = [], ...prior } = g; g.history = [...history, { ...copy(prior), archivedAt: now(), actor: copy(actor), reason }]; g.cycle = (g.cycle ?? 0) + 1; g.configRevision = revision; g.status = 'pending'; g.reviews = []; g.humanOverride = null; delete g.dispatch; }
  // Shared retry/rework closure (P-47): archive affected Gates, reset the downstream closure and
  // open a new Attempt cycle. Manual retry and pre-approved rework both route through here.
  #retry(t, nodeIds, reason, actor) {
    requireThat(nodeIds.length, 'state-conflict', 'Rework requires an executed source.');
    text(reason, 'retry reason'); requireThat(['running', 'stopped', 'delivered'].includes(t.status), 'state-conflict', 'Ticket is not ready for retry.');
    requireThat(!t.abandonedAt, 'state-conflict', 'Ticket is abandoned; reverse the abandonment before retrying.');
    requireThat(!t.execution.legacy?.readOnly, 'legacy-plan', 'Legacy execution needs explicit repair.');
    for (const nodeId of nodeIds) requireThat(['failed', 'cancelled', 'interrupted', 'completed'].includes(this.#node(t, nodeId).status), 'state-conflict', 'Node is not ready for retry.');
    assertStart(t.plan); this.#preserveCompleted(t, t.plan);
    const { inputs } = this.#checkRunDependencies(t);
    const plan = t.plan, affected = new Set(nodeIds); let size;
    do {
      size = affected.size;
      for (const node of plan.nodes) if (node.dependsOn.some(id => affected.has(id))) affected.add(node.id);
      for (const gate of plan.gates) if (gate.from.some(id => affected.has(id))) for (const id of gate.to) affected.add(id);
      for (const gate of plan.logicGates ?? []) if (affected.has(gate.from)) for (const route of gate.routes) for (const id of route.to) affected.add(id);
    } while (affected.size !== size);
    // An already-passed incoming Gate (upstream unaffected, only its target is retried) keeps its verdict:
    // the upstream delivery and review are unchanged, so retrying must not force a second human approval.
    const gates = plan.gates.filter(g => {
      const touched = [...g.from, ...g.to].some(id => affected.has(id)) || affected.has(g.reviewer.nodeId);
      const keptIncoming = !g.from.some(id => affected.has(id)) && !affected.has(g.reviewer.nodeId) && this.#gate(t, g.id).status === 'passed';
      return touched && !keptIncoming;
    });
    requireThat([...affected].every(id => this.#node(t, id).status !== 'running') && gates.every(g => !inflight(this.#gate(t, g.id).dispatch)), 'state-conflict', 'Affected execution is still in flight.');
    requireThat(!plan.logicGates?.length || !t.execution.delivery?.pending, 'state-conflict', 'Delivery is in progress.');
    this.#freeze(t);
    if (inputs.length || t.execution.dependencyInputs) t.execution.dependencyInputs = inputs;
    for (const id of affected) this.#node(t, id).status = 'pending';
    for (const g of plan.logicGates ?? []) if (affected.has(g.from) && t.execution.logicDecisions) delete t.execution.logicDecisions[g.id];
    if (plan.logicGates?.length) {
      const delivery = t.execution.delivery;
      if (delivery) { delivery.cycleStart = delivery.history.length; delivery.override = null; }
      for (const [index, item] of Object.entries(t.execution.deliverables ?? {})) if (affected.has(t.execution.artifacts?.[item.artifactId]?.nodeId)) delete t.execution.deliverables[index];
    }
    for (const g of gates) this.#archiveGate(this.#gate(t, g.id), t.execution.currentConfigRevision, actor, reason);
    for (const nodeId of nodeIds) this.#node(t, nodeId).thread.push({ id: randomUUID(), time: now(), actor: copy(actor), intent: 'retry', text: reason });
    t.status = 'running'; this.#advanceLogic(t); this.#touch(t); this.#event(t, 'node-retry-requested', actor, { nodeId: nodeIds[0], nodeIds: copy(nodeIds), reason, affectedNodes: [...affected] }); return copy(t);
  }
  #checkRunDependencies(t) {
    const ws = t.workspaceId, id = t.id;
    const occurrence = this.#workspace(ws).series?.flatMap(s => s.occurrences).find(o => o.ticketId === id);
    requireThat(!allRefs(t.plan, 'ticketDependencySeries').length || occurrence, 'dependency-wait', 'Series references require a scheduled occurrence.');
    this.#validateDependencies(this.#workspace(ws), id, t.plan, null, t.dependencyBindings);
    const deps = this.#dependencyReadiness(t);
    requireThat(deps.ready, 'dependency-wait', 'Upstream Tickets must be delivered before starting.');
    const inputs = deps.ticketIds.map(id => t.execution?.dependencyInputs?.find(item => item.ticketId === id) ?? this.#upstreamInputs(t,[id])[0]);
    return { inputs, occurrence };
  }
  #start(ws, id, actor, resume = false) {
    const t = this.#ticket(ws, id); requireThat(t.status === (resume ? 'stopped' : 'draft'), 'state-conflict', `Only a ${resume ? 'stopped' : 'draft'} Ticket can ${resume ? 'resume' : 'start'}.`);
    requireThat(!t.abandonedAt, 'state-conflict', 'Ticket is abandoned; reverse the abandonment before starting.');
    const { inputs, occurrence } = this.#checkRunDependencies(t);
    this.#editable(t); this.#preserveCompleted(t, t.plan); this.#freeze(t);
    if (inputs.length || t.execution.dependencyInputs) t.execution.dependencyInputs = inputs;
    delete t.dependencyAuthorization;
    if (occurrence) occurrence.status = 'started';
    for (const n of Object.values(t.execution.nodes)) if (n.status === 'cancelled') n.status = 'pending';
    if (resume) for (const g of Object.values(t.execution.gates)) if (g.status === 'pending' && g.dispatch?.phase === 'stopped') this.#archiveGate(g, t.execution.currentConfigRevision, actor, 'review resumed after stop');
    t.status = 'running'; this.#touch(t); this.#event(t, resume ? 'ticket-resumed' : 'ticket-started', actor, { configRevision: t.execution.currentConfigRevision }); this.#settle(t); return copy(t);
  }
  #sourcesComplete(t, id) {
    const states = this.#definition(t, id, 'gates').from.map(n => this.#node(t, n).status);
    return states.includes('completed') && states.every(finishedNode) && this.#gate(t, id).status !== 'skipped';
  }
  #incomingRoutes(t, id) {
    const matches = [];
    for (const gate of this.#config(t).plan.logicGates ?? []) {
      const decision = ownValue(t.execution.logicDecisions, gate.id);
      for (const route of gate.routes) if (route.to.includes(id)) {
        matches.push(this.#node(t, gate.from).status === 'skipped' ? false : decision?.routes.find(r => r.id === route.id)?.matched);
      }
    }
    return matches;
  }
  #advanceLogic(t) {
    if (t.status !== 'running' || !this.#config(t).plan?.logicGates?.length) return false;
    const plan = this.#config(t).plan;
    let changed = false, progress;
    do {
      progress = false;
      for (const gate of plan.logicGates) {
        const source = this.#node(t, gate.from), attempt = source.attempts.at(-1);
        if (source.status !== 'completed' || ownValue(t.execution.logicDecisions, gate.id)) continue;
        const decision = { gateId: gate.id, from: gate.from, attemptId: attempt.id, configRevision: t.execution.currentConfigRevision,
          routes: gate.routes.map(route => ({ id: route.id, matched: matchesCondition(attempt.completion?.handoff, route.condition) })) };
        (t.execution.logicDecisions ??= {})[gate.id] = decision;
        this.#touch(t); this.#event(t, 'logic-gate-decided', { kind: 'system' }, decision); progress = true;
      }
      for (const d of plan.nodes) {
        const n = this.#node(t, d.id);
        if (n.status !== 'pending') continue;
        const routes = this.#incomingRoutes(t, d.id);
        if (routes.includes(undefined)) continue;
        const parents = [...d.dependsOn, ...plan.gates.filter(g => g.to.includes(d.id)).flatMap(g => g.from)];
        const skip = routes.length ? !routes.includes(true) : parents.length && parents.every(id => this.#node(t, id).status === 'skipped');
        if (skip) {
          n.status = 'skipped'; this.#touch(t); this.#event(t, 'node-skipped', { kind: 'system' }, { nodeId: d.id }); progress = true;
        }
      }
      for (const d of plan.gates) {
        const gate = this.#gate(t, d.id);
        if (gate.status !== 'pending' || gate.dispatch) continue;
        if (d.from.every(id => this.#node(t, id).status === 'skipped') || (d.to.length && d.to.every(id => this.#node(t, id).status === 'skipped'))) {
          gate.status = 'skipped'; this.#touch(t); this.#event(t, 'gate-skipped', { kind: 'system' }, { gateId: d.id }); progress = true;
        }
      }
      changed ||= progress;
    } while (progress);
    return changed;
  }
  #runnable(t, id) {
    const n = this.#node(t, id), d = this.#definition(t, id);
    if (t.status !== 'running' || t.execution.legacy?.readOnly || n.status !== 'pending') return false;
    const routes = this.#incomingRoutes(t, id);
    return (!routes.length || (!routes.includes(undefined) && routes.includes(true))) && d.dependsOn.every(id => finishedNode(this.#node(t, id).status))
      && this.#config(t).plan.gates.filter(g => g.to.includes(id)).every(g => this.#gate(t, g.id).status === 'skipped' || (this.#gate(t, g.id).status === 'passed' && this.#sourcesComplete(t, g.id)))
      && this.#dependencyReadiness(t, id).ready;
  }
  // Derived Gate coverage (P-45); mirrors the model projection. Only 'stale' blocks delivery.
  #coverage(t, gateId, g) {
    if (g.status !== 'passed') return 'not-passed';
    if (g.humanOverride) return 'covered';
    const from = this.#definition(t, gateId, 'gates').from.filter(id => this.#node(t,id).status !== 'skipped');
    const arts = Object.entries(t.execution.artifacts ?? {}).filter(([, a]) => from.includes(a.nodeId));
    if (!arts.length) return 'covered'; // legacy passed Gate without bindings stays compatible
    const refs = (g.reviews ?? []).filter(r => r.decision === 'passed' && r.cycle === g.cycle).flatMap(r => r.artifactRefs ?? []);
    const uncovered = arts.some(([id, a]) => { const lv = a.versions.at(-1); return lv && !refs.some(r => r.artifactId === id && r.version === lv.version); });
    if (!uncovered) return 'covered';
    return refs.length ? 'stale' : 'unreviewed';
  }
  #deliveryReady(t) {
    const declared = this.#config(t).plan.deliverables ?? [];
    if (!declared.length) return true;
    if (t.execution.delivery?.override) return true;
    const registry = t.execution.deliverables ?? {}, history = t.execution.delivery?.history ?? [];
    return declared.every((item, i) => skippedItem(t.execution, item) || (registry[String(i)]?.artifactId && history.slice(t.execution.delivery?.cycleStart ?? 0).some(h => (h.items ?? []).some(it => it.deliverableIndex === i))));
  }
  #settle(t) {
    this.#advanceLogic(t);
    if (t.status === 'stop-requested') {
      if (!Object.values(t.execution.nodes).some(n => n.status === 'running') && !Object.values(t.execution.gates).some(g => inflight(g.dispatch))) { t.status = 'stopped'; this.#event(t, 'ticket-stopped', { kind: 'system' }); }
    } else if (t.status === 'running' && Object.values(t.execution.nodes).every(n => finishedNode(n.status)) && Object.values(t.execution.gates).every(g => finishedGate(g.status))) {
      const override = t.execution.delivery?.override;
      if (!override && Object.entries(t.execution.gates).some(([id, g]) => this.#coverage(t, id, g) === 'stale')) return;
      if (!this.#deliveryReady(t)) return;
      t.status = 'delivered'; this.#event(t, 'ticket-delivered', { kind: 'system' });
    }
  }
  #worker(ws, t, nodeId, attempt) {
    const n = this.#node(t, nodeId), frozen = t.execution.configurations[attempt.configRevision ?? attempt.legacyConfigRevision], definition = frozen?.plan?.nodes.find(n => n.id === nodeId) ?? n.legacyDefinition;
    const agentId = definition?.agentId;
    const actor = { kind: 'agent', nodeId, attemptId: attempt.id, agentId: agentId ?? null };
    const active = () => requireThat(n.status === 'running' && attempt.status === 'running' && n.attempts.at(-1) === attempt, 'stale-attempt', 'Attempt is no longer active.');
    const finish = (status, detail = {}) => { active(); Object.assign(attempt, detail, { status, finishedAt: now() }); n.status = status === 'stopped' ? 'cancelled' : status; this.#touch(t); this.#event(t, `node-${status}`, actor, { nodeId, attemptId: attempt.id }); this.#settle(t); return copy(attempt); };
    return Object.freeze({ attemptId: attempt.id,
      input: () => { active(); return copy({ task: definition.task, configRevision: attempt.configRevision, profile: { id: agentId, ...frozen.plan.agents[agentId] }, modelSelection: definition.modelSelection ?? null, inputs: frozen.plan.inputs, rules: frozen.rules, ...(attempt.upstreamTickets ? {upstreamTickets:attempt.upstreamTickets} : {}) }); },
      attachSession: sessionId => { active(); text(sessionId, 'Session ID'); requireThat(!attempt.sessionId || attempt.sessionId === sessionId, 'state-conflict', 'Attempt already has another Session.');
        const owner = this.sessionOwner(sessionId); requireThat(!owner || owner.attemptId === attempt.id, 'session-conflict', 'Session already belongs to another execution context.');
        if (attempt.sessionId === sessionId) return sessionId; attempt.sessionId = sessionId; if (attempt.dispatch) attempt.dispatch.sessionId = sessionId; this.#touch(t); return sessionId; },
      recordDispatch: (data, expectedRequestId) => { active(); if (expectedRequestId !== undefined) requireThat(attempt.dispatch?.requestId === expectedRequestId, 'stale-dispatch', 'Dispatch changed.'); const d = this.#dispatch(data); if (attempt.sessionId) d.sessionId = attempt.sessionId; attempt.dispatch = d; this.#touch(t); return copy(d); },
      postMessage: message => { active(); text(message, 'message'); const row = { id: randomUUID(), time: now(), actor, attemptId: attempt.id, intent: 'execution', text: message }; n.thread.push(row); this.#touch(t); return copy(row); },
      recordProgress: items => {
        active();
        const known = new Set(n.thread.map(row => row.id));
        let changed = false;
        for (const item of items) {
          const row = nativeProgressRow(item, actor);
          if (!row || known.has(row.id)) continue;
          n.thread.push(row);
          known.add(row.id);
          changed = true;
        }
        if (changed) this.#touch(t);
      },
      acknowledgeChange: () => fail('control-locked', 'Execution configuration is frozen; stop before editing.'),
      submitEvidence: sealed => {
        active(); const data = object(sealed, 'evidence');
        requireThat(Object.keys(data).every(k => ['artifacts', 'acceptanceResults', 'verification', 'summary', 'handoff'].includes(k)), 'invalid-input', 'Unexpected evidence field.');
        const arts = data.artifacts ?? []; requireThat(Array.isArray(arts), 'invalid-input', 'evidence.artifacts must be an array.');
        const frozenPlan = frozen.plan, declared = frozenPlan.deliverables ?? [];
        t.execution.artifacts ??= {}; t.execution.deliverables ??= {};
        const refs = [];
        for (const item of arts) {
          object(item, 'artifact'); requireThat(Object.keys(item).every(k => ['sourcePath', 'deliverableIndex', 'mediaType', 'sha256', 'size', 'snapshotPath', 'artifactId', 'version'].includes(k)), 'invalid-input', 'Unexpected artifact field.');
          const sourcePath = text(item.sourcePath, 'artifact.sourcePath'), sha256 = text(item.sha256, 'artifact.sha256'), snapshotPath = text(item.snapshotPath, 'artifact.snapshotPath');
          requireThat(/^[0-9a-f]{64}$/.test(sha256), 'invalid-input', 'artifact.sha256 must be a hex SHA-256.');
          requireThat(Number.isSafeInteger(item.size) && item.size >= 0, 'invalid-input', 'artifact.size must be a nonnegative safe integer.');
          if (item.mediaType !== undefined) text(item.mediaType, 'artifact.mediaType');
          let deliverableIndex = null;
          if (item.deliverableIndex !== undefined) { requireThat(Number.isSafeInteger(item.deliverableIndex) && item.deliverableIndex >= 0 && item.deliverableIndex < declared.length, 'invalid-input', 'artifact.deliverableIndex is out of range.'); deliverableIndex = item.deliverableIndex; }
          // artifactId is stable for the same (nodeId, deliverableIndex ?? sourcePath). The Service
          // may pre-allocate an id/version to seal bytes outside the lock; both are re-checked here.
          const matchesKey = a => a.nodeId === nodeId && (deliverableIndex !== null ? a.deliverableIndex === deliverableIndex : a.deliverableIndex === null && a.sourcePath === sourcePath);
          let artifactId = item.artifactId !== undefined ? text(item.artifactId, 'artifact.artifactId') : Object.keys(t.execution.artifacts).find(id => matchesKey(t.execution.artifacts[id]));
          if (item.artifactId !== undefined && t.execution.artifacts[artifactId]) requireThat(matchesKey(t.execution.artifacts[artifactId]), 'invalid-input', 'artifactId does not match its (nodeId, deliverableIndex/sourcePath) key.');
          let artifact;
          if (artifactId && t.execution.artifacts[artifactId]) artifact = t.execution.artifacts[artifactId];
          else { if (!artifactId) { do { artifactId = `a-${randomUUID().slice(0, 8)}`; } while (t.execution.artifacts[artifactId]); } artifact = { nodeId, deliverableIndex, label: deliverableIndex !== null ? deliverableView(declared[deliverableIndex]).label : sourcePath, sourcePath, versions: [] }; t.execution.artifacts[artifactId] = artifact; }
          const version = (artifact.versions.at(-1)?.version ?? 0) + 1;
          if (item.version !== undefined) requireThat(item.version === version, 'state-conflict', 'Artifact version was pre-allocated against a stale chain; retry the submission.');
          artifact.versions.push({ version, sha256, size: item.size, mediaType: item.mediaType ?? null, snapshotPath, attemptId: attempt.id, configRevision: attempt.configRevision, submittedAt: now() });
          if (deliverableIndex !== null) t.execution.deliverables[String(deliverableIndex)] = { label: deliverableView(declared[deliverableIndex]).label, artifactId };
          refs.push({ artifactId, version, sha256 });
        }
        const acceptanceResults = data.acceptanceResults ?? []; requireThat(Array.isArray(acceptanceResults), 'invalid-input', 'acceptanceResults must be an array.');
        for (const r of acceptanceResults) { object(r, 'acceptanceResult'); requireThat(['passed', 'failed', 'unknown'].includes(r.status), 'invalid-input', 'acceptanceResult.status must be passed, failed or unknown.'); if (r.criterion !== undefined) text(r.criterion, 'acceptanceResult.criterion'); if (r.evidence !== undefined) requireThat(typeof r.evidence === 'string', 'invalid-input', 'acceptanceResult.evidence must be text.'); }
        const verification = data.verification ?? []; requireThat(Array.isArray(verification), 'invalid-input', 'verification must be an array.');
        for (const v of verification) { object(v, 'verification'); text(v.command, 'verification.command'); requireThat(v.source === 'agent-report', 'invalid-input', "verification.source must be 'agent-report'; host-verified is reserved."); if (v.exitCode !== undefined) requireThat(Number.isSafeInteger(v.exitCode), 'invalid-input', 'verification.exitCode must be a safe integer.'); if (v.output !== undefined) requireThat(typeof v.output === 'string', 'invalid-input', 'verification.output must be text.'); }
        if (data.summary !== undefined) text(data.summary, 'summary');
        if (data.handoff !== undefined) object(data.handoff, 'handoff');
        const completion = { submittedAt: now(), configRevision: attempt.configRevision, nodeId, acceptanceResults: copy(acceptanceResults), artifactRefs: copy(refs), verification: copy(verification), ...(data.summary !== undefined ? { summary: data.summary } : {}), ...(data.handoff !== undefined ? { handoff: copy(data.handoff) } : {}), evidenceKind: 'agent-report' };
        attempt.completion = completion; this.#touch(t); this.#event(t, 'node-evidence-submitted', actor, { nodeId, attemptId: attempt.id, artifactRefs: copy(refs) });
        return { artifacts: copy(refs), completion: copy(completion) };
      },
      complete: outputs => { requireThat(outputs !== undefined, 'invalid-input', 'Completion needs output evidence.'); return finish('completed', { outputs: copy(outputs) }); },
      fail: error => finish('failed', { error: text(error, 'error') }), interrupt: reason => finish('interrupted', { error: text(reason, 'reason') }),
      confirmStopped: () => { requireThat(t.status === 'stop-requested', 'state-conflict', 'No stop was requested.'); return finish('stopped'); }
    });
  }
  #dispatch(input) { const d = copy(object(input, 'dispatch')); requireThat(Object.keys(d).every(k => ['sessionId', 'requestId', 'messageId', 'phase', 'detail', 'error', 'owner', 'claimedAt'].includes(k)), 'invalid-input', 'Unexpected dispatch field.'); requireThat(['created', 'submit-intent', 'submitted', 'uncertain', 'finished', 'failed', 'stopped'].includes(d.phase), 'invalid-input', 'Invalid dispatch phase.'); d.requestId ??= d.messageId; text(d.requestId, 'dispatch requestId'); d.messageId ??= d.requestId; return d; }
  sessionOwner(sessionId) {
    for (const w of this.#state.workspaces) for (const t of w.tickets) {
      for (const [nodeId, n] of Object.entries(t.execution?.nodes ?? {})) for (const a of n.attempts) if (a.sessionId === sessionId) return { workspaceId: w.id, ticketId: t.id, nodeId, attemptId: a.id };
      for (const [gateId, g] of Object.entries(t.execution?.gates ?? {})) for (const cycle of [g, ...(g.history ?? [])]) if (cycle.dispatch?.sessionId === sessionId) return { workspaceId: w.id, ticketId: t.id, gateId, cycle: cycle.cycle };
    } return null;
  }
  /** P-51: the Agent executes a start/resume decision the user explicitly made in the conversation.
   * Only start/resume exist here; auditable as an Agent acting via a user request, never on its own. */
  agent(ws, sessionId) {
    const actor = { kind: 'agent', userId: text(sessionId, 'session ID'), via: 'user-request' };
    return Object.freeze({ start: id => this.#start(ws, id, actor), resume: id => this.#start(ws, id, actor, true) });
  }
  human(ws, userId) {
    const actor = { kind: 'human', userId: text(userId, 'user ID') };
    return Object.freeze({
      start: id => this.#start(ws, id, actor), resume: id => this.#start(ws, id, actor, true),
      enableDependencies: (id, expectedRevision) => {
        const t = this.#ticket(ws, id); this.#cas(t, expectedRevision);
        requireThat(t.status === 'draft' && !t.abandonedAt, 'control-locked', 'Only an active draft can enable automatic start.');
        requireThat(t.plan.ticketDependencies?.length || t.plan.ticketDependencySeries?.length, 'invalid-input', 'Automatic start requires whole-Ticket dependencies.');
        requireThat(!allRefs(t.plan, 'ticketDependencySeries').length || this.#workspace(ws).series?.some(s => s.occurrences.some(o => o.ticketId === id)), 'dependency-wait', 'Series references require a scheduled occurrence.');
        assertStart(t.plan); this.#validateDependencies(this.#workspace(ws), id, t.plan, null, t.dependencyBindings);
        this.#authorize(t, actor); return this.#startWhenReady(t);
      },
      disableDependencies: (id, expectedRevision) => {
        const t = this.#ticket(ws, id); this.#cas(t, expectedRevision);
        if (t.dependencyAuthorization) { delete t.dependencyAuthorization; this.#touch(t); this.#event(t, 'dependencies-disabled', actor); }
        return copy(t);
      },
      deleteDraftTicket: (id, expectedRevision) => {
        const workspace = this.#workspace(ws), ticket = this.#ticket(ws, id);
        this.#cas(ticket, expectedRevision);
        requireThat(ticket.status === 'draft' && ticket.execution === null, 'control-locked', 'Only a draft without execution history can be deleted.');
        // Historical plans can have an incompatible shape. Inspect the known reference
        // fields directly without normalizing, repairing or rewriting those plans.
        const dependsOnDraft = part => Array.isArray(part?.ticketDependencies) && part.ticketDependencies.includes(id);
        const referencesDraft = plan => dependsOnDraft(plan) || (Array.isArray(plan?.nodes) && plan.nodes.some(dependsOnDraft));
        const references = [], superseded = [];
        for (const other of workspace.tickets) {
          if (other === ticket) continue;
          const replacementOnly = other.supersededBy === id;
          if (Object.values(other.dependencyBindings ?? {}).includes(id) || referencesDraft(other.plan)
            || Object.values(other.execution?.configurations ?? {}).some(config => referencesDraft(config?.plan))) {
            const goal = other.plan?.goal ?? other.plan?.ticket?.goal;
            const title = typeof other.plan?.title === 'string' && other.plan.title.trim() || (typeof goal === 'string' && readableTitle(goal)) || other.id;
            references.push({kind: 'ticket', id: other.id, title});
          } else if (replacementOnly) superseded.push(other);
        }
        for (const series of workspace.series ?? []) {
          if (series.sourceTicketId === id || series.occurrences.some(o => o.ticketId === id) || referencesDraft(series.plan)) {
            references.push({kind: 'series', id: series.id, title: series.name});
          }
        }
        if (references.length) throw Object.assign(new FleetCoreError('ticket-referenced', 'Other Tickets or series reference this draft.'), {references});
        for (const old of superseded) {
          delete old.supersededBy;
          old.replacementDeleted = {ticketId: id, time: now()};
          this.#touch(old);
          this.#event(old, 'replacement-deleted', actor, {ticketId: id});
        }
        workspace.tickets.splice(workspace.tickets.indexOf(ticket), 1);
        return { deletedTicketId: id };
      },
      // P-69: the user explicitly abandons this one Ticket. Series schedules are untouched;
      // future occurrences keep creating their own Tickets from the frozen series plan.
      abandonTicket: (id, expectedRevision, reason) => {
        const t = this.#ticket(ws, id); this.#cas(t, expectedRevision);
        requireThat(['draft', 'stopped'].includes(t.status), 'control-locked', 'Only a draft or stopped Ticket can be abandoned; stop a running Ticket first.');
        if (reason !== undefined && reason !== null) text(reason, 'reason');
        if (t.abandonedAt) return copy(t);
        delete t.dependencyAuthorization; t.abandonedAt = now(); this.#touch(t); this.#event(t, 'ticket-abandoned', actor, reason ? { reason } : {}); return copy(t);
      },
      unabandonTicket: (id, expectedRevision) => {
        const t = this.#ticket(ws, id); this.#cas(t, expectedRevision);
        requireThat(t.abandonedAt, 'state-conflict', 'Ticket is not abandoned.');
        delete t.abandonedAt; this.#touch(t); this.#event(t, 'ticket-abandon-reversed', actor); return copy(t);
      },
      instantiateTemplate: input => this.instantiateTemplate(ws, { ...object(input, 'instantiate input'), actor }),
      stop: id => { const t = this.#ticket(ws, id); if (['stopped', 'stop-requested'].includes(t.status)) return copy(t); requireThat(t.status === 'running' || t.status === 'delivered' && Object.values(t.execution.gates).some(g => inflight(g.dispatch)), 'not-running', 'No execution to stop.'); t.status = 'stop-requested'; for (const n of Object.values(t.execution.nodes)) if (n.status === 'pending') n.status = 'cancelled'; this.#touch(t); this.#event(t, 'stop-requested', actor); this.#settle(t); return copy(t); },
      commentNode: (id, nodeId, message) => { const t = this.#ticket(ws, id), n = this.#node(t, nodeId); text(message, 'message'); const row = { id: randomUUID(), time: now(), actor: copy(actor), intent: 'discussion', text: message }; n.thread.push(row); this.#touch(t); this.#event(t, 'node-comment', actor, { nodeId, messageId: row.id }); return copy(row); },
      setPendingNodeModel: (id, nodeId, selection, expectedRevision) => {
        const t = this.#ticket(ws, id);
        this.#cas(t, expectedRevision);
        requireThat(t.status === 'running' && !t.execution?.legacy?.readOnly && ['pending', 'failed', 'interrupted', 'cancelled'].includes(this.#node(t, nodeId).status), 'control-locked', 'Only a node that is not running or completed can change model in a running Ticket.');
        const config = this.#config(t), plan = copy(config.plan);
        const node = plan.nodes.find(n => n.id === nodeId);
        if (selection === null) delete node.modelSelection;
        else node.modelSelection = copy(object(selection, 'model selection'));
        assertStart(plan);
        if (isDeepStrictEqual(plan, config.plan)) return copy(t);
        this.#touch(t);
        t.plan = plan;
        t.execution.currentConfigRevision = t.revision;
        t.execution.configurations[t.revision] = { ...copy(config), frozenAt: now(), plan: copy(plan) };
        this.#event(t, 'node-model-changed', actor, { nodeId, configRevision: t.revision, modelSelection: selection });
        return copy(t);
      },
      changeNode: (id, nodeId, task, message, expectedRevision) => { const t = this.#ticket(ws, id); this.#editable(t); this.#cas(t, expectedRevision); const plan = copy(t.plan), n = plan.nodes.find(n => n.id === nodeId); requireThat(n, 'unknown-node', 'Unknown plan Node.'); n.task = copy(object(task, 'task')); return this.saveDraftTicket(ws, { ticketId: id, expectedRevision, plan, actor }); },
      retryNode: (id, nodeId, reason) => { const t = this.#ticket(ws, id); this.#node(t, nodeId); return this.#retry(t, [nodeId], reason, actor); },
      deliverOverride: (id, reason) => {
        const t = this.#ticket(ws, id); text(reason, 'reason'); requireThat(t.status === 'running', 'state-conflict', 'Ticket is not running.');
        const declared = this.#config(t).plan.deliverables ?? [], registry = t.execution.deliverables ?? {};
        const gaps = { unbound: declared.map((item, i) => registry[String(i)]?.artifactId || skippedItem(t.execution,item) ? null : { index: i, label: deliverableView(item).label }).filter(Boolean), staleGates: Object.entries(t.execution.gates).filter(([gid, g]) => this.#coverage(t, gid, g) === 'stale').map(([gid]) => gid) };
        t.execution.delivery ??= { history: [], override: null };
        t.execution.delivery.override = { id: randomUUID(), time: now(), actor: copy(actor), reason, gaps };
        this.#touch(t); this.#event(t, 'delivery-override', actor, { overrideId: t.execution.delivery.override.id, reason, gaps }); this.#settle(t); return copy(t.execution.delivery.override);
      },
      reviewGate: (id, gateId, decision, evidence) => { const t = this.#ticket(ws, id); requireThat(this.#definition(t, gateId, 'gates').reviewer.kind === 'human', 'not-reviewable', 'Gate requires its configured reviewer.'); return this.#review(t, gateId, actor, decision, evidence); },
      forcePassGate: (id, gateId) => { const t = this.#ticket(ws, id), g = this.#gate(t, gateId); requireThat(t.status === 'running' && g.status !== 'skipped', 'not-running', 'Gate is not active.'); if (g.humanOverride) return copy(g); this.#touch(t); g.humanOverride = { id: randomUUID(), time: now(), actor: copy(actor), priorStatus: g.status, decision: 'passed', configRevision: g.configRevision, cycle: g.cycle }; g.status = 'passed'; this.#event(t, 'gate-human-override', actor, { gateId, overrideId: g.humanOverride.id }); this.#settle(t); return copy(g); },
      repairTicket: (id, expectedRevision, replacement) => {
        const t = this.#ticket(ws, id); this.#cas(t, expectedRevision); requireThat(['draft', 'stopped'].includes(t.status), 'control-locked', 'Stop completely before repairing.');
        requireThat(!isCurrentPlan(t.plan) || t.legacy, 'state-conflict', 'Ticket already uses the current plan contract.');
        let plan;
        try { plan = replacement === undefined ? repairLegacyPlan(t.plan, t.legacy?.context) : planInput(replacement); } catch (e) { throw new FleetCoreError(e.code ?? 'repair-required', e.message); }
        this.#validateDependencies(this.#workspace(ws), id, plan, null, t.dependencyBindings);
        if (t.execution) {
          requireThat(this.#config(t).plan, 'repair-required', 'Historical execution has no unambiguous plan; preserve it read-only.'); this.#preserveCompleted(t, plan);
        }
        const before = archived(t.plan, 'pre-repair-plan'); t.plan = plan; if (t.execution?.legacy) t.execution.legacy.readOnly = false;
        this.#touch(t); this.#event(t, 'plan-repaired', actor, { before, after: copy(plan), paths: ['plan'] }); return copy(t);
      },
      regenerateTicket: (id, expectedRevision, replacement, originSessionId) => {
        const old = this.#ticket(ws, id); this.#cas(old, expectedRevision); requireThat(old.status === 'draft' && !old.execution && !old.abandonedAt, 'control-locked', 'Only an active unstarted Ticket can be regenerated.');
        const nextPlan = planInput(replacement); const fresh = this.saveDraftTicket(ws, { sessionId: old.originSessionId ?? (originSessionId === undefined ? null : text(originSessionId, 'origin Session ID')), plan: nextPlan, actor });
        delete old.dependencyAuthorization; old.status = 'superseded'; old.supersededBy = fresh.id; this.#touch(old); this.#event(old, 'ticket-superseded', actor, { supersededBy: fresh.id, original: archived(old.plan, 'pre-regeneration-plan') }); return fresh;
      },
      replaceRootAgent: (id, profile) => this.#replaceTemplate(id, this.#templateContent('agent', { ...this.#template(id, 'agent').content, profile: copy(object(profile, 'profile')) }), actor),
      replaceRootOrchestration: (id, definition) => this.#replaceTemplate(this.#template(id, 'orchestration').id, this.#templateContent('orchestration', definition), actor),
      saveTemplate: input => { const data = copy(object(input, 'Template')); text(data.id, 'Template ID'); requireThat(['agent', 'orchestration'].includes(data.kind), 'invalid-input', 'Unknown Template kind.'); requireThat(!this.#state.templates.some(t => t.id === data.id), 'duplicate-id', 'Template exists.'); const content = this.#templateContent(data.kind, data.content); if (data.name !== undefined) text(data.name, 'Template name'); if (data.source !== undefined && data.source !== null) { object(data.source, 'Template source'); requireThat(Object.keys(data.source).every(k => ['templateId', 'templateRevision'].includes(k)) && Number.isSafeInteger(data.source.templateRevision), 'invalid-input', 'Template source needs an actual version.'); const source = this.#template(data.source.templateId, data.kind); requireThat(source.revision === data.source.templateRevision || source.history.some(h => h.revision === data.source.templateRevision), 'invalid-input', 'Unknown Template source revision.'); } const time = now(), t = { id: data.id, kind: data.kind, name: data.name ?? data.id, revision: 1, content, source: data.source ?? null, history: [], createdAt: time, updatedAt: time }; this.#state.templates.push(t); return copy(t); },
      replaceGlobalSettings: input => { const next = normalizeSettings(input); next.revision = this.#state.settings.revision + 1; this.#state.settings = next; return copy(next); }
    });
  }
  #templateContent(kind, input) {
    const content = copy(object(input, 'Template content'));
    requireThat(Object.keys(content).every(key => (kind === 'agent' ? ['name', 'profile'] : ['nodes', 'gates']).includes(key)), 'invalid-input', 'Template content cannot include execution or identity fields.');
    if (kind === 'agent') return planInput({ goal: 'template validation', agents: { local: content } }).agents.local;
    const plan = planInput({ goal: 'template validation', nodes: content.nodes, gates: content.gates ?? [] });
    requireThat(!validatePlan(plan, { mode: 'start' }).errors.some(e => e.code === 'invalid-flow'), 'invalid-flow', 'Invalid Template graph.');
    return { nodes: plan.nodes, gates: plan.gates };
  }
  #template(id, kind) { const t = this.#state.templates.find(t => t.id === id && (!kind || t.kind === kind)); requireThat(t, kind === 'agent' ? 'unknown-agent' : 'unknown-flow', 'Unknown Root Template.'); return t; }
  #replaceTemplate(id, content, actor) { const t = this.#template(id); t.history.push({ revision: t.revision, content: copy(t.content), source: copy(t.source), actor: copy(actor), time: now() }); t.content = content; t.revision++; t.updatedAt = now(); return projectTemplate(t); }
  // Resolve review artifact bindings (P-45): explicit refs are verified against the sealed chain;
  // omitted refs auto-bind the latest version of every from-node artifact. Text evidence becomes one finding.
  #reviewBindings(t, gateId, evidence) {
    const definition = this.#definition(t, gateId, 'gates'), artifacts = t.execution.artifacts ?? {};
    const isObj = evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence);
    let artifactRefs, bindingKind;
    if (isObj && Array.isArray(evidence.artifactRefs)) {
      bindingKind = 'explicit'; artifactRefs = evidence.artifactRefs.map(ref => {
        object(ref, 'artifactRef'); requireThat(Object.keys(ref).every(k => ['artifactId', 'version', 'sha256'].includes(k)), 'invalid-input', 'Unexpected artifactRef field.');
        const a = artifacts[ref.artifactId]; requireThat(a && this.#node(t,a.nodeId).status !== 'skipped', 'invalid-input', 'Unknown or skipped review artifactRef.');
        const v = a.versions.find(v => v.version === ref.version); requireThat(v, 'invalid-input', 'Unknown review artifact version.');
        requireThat(v.sha256 === ref.sha256, 'invalid-input', 'Review artifactRef sha256 mismatch.');
        return { artifactId: ref.artifactId, version: ref.version, sha256: ref.sha256 };
      });
    } else {
      bindingKind = 'auto-latest';
      artifactRefs = Object.entries(artifacts).filter(([, a]) => definition.from.includes(a.nodeId) && this.#node(t,a.nodeId).status !== 'skipped').map(([artifactId, a]) => { const lv = a.versions.at(-1); return lv ? { artifactId, version: lv.version, sha256: lv.sha256 } : null; }).filter(Boolean);
    }
    let findings = [];
    if (typeof evidence === 'string') findings = [{ id: randomUUID(), severity: 'medium', description: evidence }];
    else if (isObj && Array.isArray(evidence.findings)) findings = evidence.findings.map(f => {
      object(f, 'finding'); requireThat(typeof f.id === 'string' && f.id && ['low', 'medium', 'high', 'blocker'].includes(f.severity) && typeof f.description === 'string' && f.description.trim(), 'invalid-input', 'finding needs id, severity and description.');
      if (f.nodeId !== undefined) requireThat(typeof f.nodeId === 'string' && f.nodeId, 'invalid-input', 'finding.nodeId must be text.');
      if (f.artifactRef !== undefined) object(f.artifactRef, 'finding.artifactRef');
      return copy(f);
    });
    return { findings, artifactRefs, bindingKind };
  }
  #review(t, gateId, actor, decision, evidence) {
    const g = this.#gate(t, gateId), definition = this.#definition(t, gateId, 'gates');
    requireThat((t.status === 'running' || g.humanOverride) && this.#sourcesComplete(t, gateId), 'not-reviewable', 'Gate is not ready for review.');
    requireThat(['passed', 'returned'].includes(decision) && evidence !== undefined, 'invalid-input', 'Review needs a decision and evidence.');
    if (decision === 'passed' && !g.humanOverride && definition.requireEvidence) requireThat(definition.from.every(id => this.#node(t, id).status === 'skipped' || this.#node(t, id).attempts.at(-1)?.completion), 'evidence-required', 'Gate requires structured completion evidence from every upstream Node.');
    const { findings, artifactRefs, bindingKind } = this.#reviewBindings(t, gateId, evidence);
    const row = { id: randomUUID(), time: now(), actor: copy(actor), decision, evidence: copy(evidence), findings, artifactRefs, bindingKind, configRevision: g.configRevision, cycle: g.cycle, supersededByHuman: Boolean(g.humanOverride) };
    g.reviews.push(row); if (!g.humanOverride) g.status = decision; this.#touch(t); this.#event(t, 'gate-review', actor, { gateId, reviewId: row.id }); this.#settle(t); return copy(g);
  }
  runtime(ws) {
    return Object.freeze({
      dependencyReadiness: (id, nodeId) => this.#dependencyReadiness(this.#ticket(ws, id), nodeId),
      dependencyStartReady: id => this.#dependencyStartReady(this.#ticket(ws,id)),
      startWhenReady: (id, expectedRevision) => this.#startWhenReady(this.#ticket(ws,id), expectedRevision),
      bindOccurrence: (id, bindings) => this.#bindOccurrence(this.#ticket(ws,id), bindings),
      gateReady: (id, gateId) => this.#sourcesComplete(this.#ticket(ws,id), gateId),
      advanceLogic: id => { const t = this.#ticket(ws,id); const changed = this.#advanceLogic(t); if (changed) this.#settle(t); return changed; },
      runnable: id => { const t = this.#ticket(ws, id); return Object.keys(t.execution?.nodes ?? {}).filter(n => this.#runnable(t, n)); },
      claimNode: (id, nodeId) => { const t = this.#ticket(ws, id), n = this.#node(t, nodeId); requireThat(this.#runnable(t, nodeId), 'not-runnable', 'Node is not ready for dispatch.'); const attempt = { id: randomUUID(), configRevision: t.execution.currentConfigRevision, startedAt: now(), sessionId: null, status: 'running' }; const scoped = this.#dependencyReadiness(t, nodeId).ticketIds;
        if (scoped.length || n.dependencyInputs) n.dependencyInputs = scoped.map(id => n.dependencyInputs?.find(input => input.ticketId === id) ?? t.execution.dependencyInputs?.find(input => input.ticketId === id) ?? this.#upstreamInputs(t,[id])[0]);
        const inputs = new Map([...(t.execution.dependencyInputs ?? []), ...(n.dependencyInputs ?? [])].map(input => [input.ticketId, input]));
        if (inputs.size) attempt.upstreamTickets = copy([...inputs.values()]);
        n.attempts.push(attempt); n.status = 'running'; this.#touch(t); this.#event(t, 'node-claimed', { kind: 'system' }, { nodeId, attemptId: attempt.id }); return this.#worker(ws, t, nodeId, attempt); },
      resumeNode: (id, nodeId, attemptId) => { const t = this.#ticket(ws, id), n = this.#node(t, nodeId), a = n.attempts.at(-1); requireThat(['running', 'stop-requested'].includes(t.status) && n.status === 'running' && a?.status === 'running' && a.id === attemptId, 'stale-attempt', 'Attempt is no longer active.'); return this.#worker(ws, t, nodeId, a); },
      recordGateDispatch: (id, gateId, data, expectedRequestId) => { const t = this.#ticket(ws, id), g = this.#gate(t, gateId), d = this.#dispatch(data); requireThat(t.status === 'running' || g.dispatch || g.humanOverride, 'not-running', 'Gate is no longer active.'); requireThat(t.status !== 'stopped' || !inflight(d), 'not-running', 'Stopped Ticket cannot dispatch.'); requireThat(this.#definition(t, gateId, 'gates').reviewer.kind === 'agent' && this.#sourcesComplete(t, gateId), 'not-reviewable', 'Gate is not ready.'); if (expectedRequestId === null) requireThat(!g.dispatch, 'stale-dispatch', 'Gate is already claimed.'); else if (expectedRequestId !== undefined) requireThat(g.dispatch?.requestId === expectedRequestId, 'stale-dispatch', 'Gate dispatch changed.'); if (d.sessionId && d.sessionId !== g.dispatch?.sessionId) requireThat(!this.sessionOwner(d.sessionId), 'session-conflict', 'Review Session is already owned.'); if (!g.dispatch && d.phase === 'created') g.configRevision = t.execution.currentConfigRevision; g.dispatch = d; this.#touch(t); this.#settle(t); return copy(d); },
      reviewer: (id, gateId) => { const t = this.#ticket(ws, id), g = this.#gate(t, gateId), definition = this.#definition(t, gateId, 'gates'); requireThat(definition.reviewer.kind === 'agent' && this.#sourcesComplete(t, gateId), 'not-reviewable', 'Gate is not ready for Agent review.'); const node = this.#definition(t, definition.reviewer.nodeId), cycle = g.cycle; let submitted = false; return Object.freeze({ submit: (decision, evidence) => { requireThat(cycle === g.cycle, 'stale-review', 'Review belongs to another cycle.'); requireThat(!submitted, 'duplicate-review', 'Review already submitted.'); const result = this.#review(t, gateId, { kind: 'agent-reviewer', nodeId: node.id, agentId: node.agentId }, decision, evidence); submitted = true; return result; } }); },
      // P-46 delivery settlement: pending export, recorded delivery and the human override exit.
      deliveryPending: id => {
        const t = this.#ticket(ws, id);
        if (t.status !== 'running' || !Object.values(t.execution.nodes).every(n => finishedNode(n.status)) || !Object.values(t.execution.gates).every(g => finishedGate(g.status))) return null;
        if (Object.entries(t.execution.gates).some(([gid, g]) => this.#coverage(t, gid, g) === 'stale')) return null;
        const declared = this.#config(t).plan.deliverables ?? [];
        if (!declared.length || t.execution.delivery?.override || t.execution.delivery?.history?.slice(t.execution.delivery?.cycleStart ?? 0).length || t.execution.delivery?.pending) return null;
        const registry = t.execution.deliverables ?? {};
        if (!declared.every((item, i) => skippedItem(t.execution,item) || registry[String(i)]?.artifactId)) return null;
        const items = declared.flatMap((item, i) => { if (skippedItem(t.execution,item)) return []; const artifactId = registry[String(i)].artifactId, lv = t.execution.artifacts[artifactId].versions.at(-1); return { deliverableIndex: i, artifactId, version: lv.version, sha256: lv.sha256, snapshotPath: lv.snapshotPath }; });
        return { ticketId: id, target: this.#config(t).plan.inputs?.deliveryTarget ?? null, items };
      },
      // Durable delivery intent (P-46): persisted before any byte export so a restart can reconcile
      // by receipt without re-delivering. Optional; old Tickets never carry it.
      recordDeliveryIntent: (id, data) => {
        const t = this.#ticket(ws, id); object(data, 'delivery intent'); requireThat(t.status === 'running', 'state-conflict', 'Ticket is not running.');
        requireThat(!t.execution.delivery?.pending && !t.execution.delivery?.history?.slice(t.execution.delivery?.cycleStart ?? 0).length && !t.execution.delivery?.override, 'state-conflict', 'Delivery is already in progress or recorded.');
        const deliveryId = text(data.deliveryId, 'deliveryId');
        t.execution.delivery ??= { history: [], override: null };
        t.execution.delivery.pending = { id: deliveryId, time: now(), target: data.target ?? null, items: copy(data.items ?? []), gateRefs: copy(data.gateRefs ?? []) };
        this.#touch(t); this.#event(t, 'delivery-intent', { kind: 'system' }, { deliveryId, target: data.target ?? null }); return copy(t.execution.delivery.pending);
      },
      recordDelivery: (id, data) => {
        const t = this.#ticket(ws, id); object(data, 'delivery'); requireThat(t.status === 'running', 'state-conflict', 'Ticket is not running.');
        requireThat(Object.keys(data).every(k => ['target', 'items', 'manifestPath', 'receiptPath', 'gateRefs'].includes(k)), 'invalid-input', 'Unexpected delivery field.');
        requireThat(Array.isArray(data.items) && data.items.length, 'invalid-input', 'delivery.items must be a nonempty array.');
        for (const it of data.items) { object(it, 'delivery item'); const a = t.execution.artifacts?.[it.artifactId]; requireThat(a && a.versions.some(v => v.version === it.version && v.sha256 === it.sha256), 'invalid-input', 'Delivery item references an unknown artifact version.'); }
        const manifestPath = text(data.manifestPath, 'delivery.manifestPath'), receiptPath = text(data.receiptPath, 'delivery.receiptPath');
        t.execution.delivery ??= { history: [], override: null };
        const row = { id: t.execution.delivery.pending?.id ?? randomUUID(), time: now(), target: data.target ?? null, items: copy(data.items), manifestPath, receiptPath, gateRefs: copy(data.gateRefs ?? []) };
        t.execution.delivery.history.push(row); delete t.execution.delivery.pending; this.#touch(t); this.#event(t, 'ticket-delivery-recorded', { kind: 'system' }, { deliveryId: row.id, target: row.target }); this.#settle(t); return copy(row);
      },
      // P-47 pre-approved rework: budget only constrains Agent reviewer loops; human gates are unlimited.
      reworkDue: id => {
        const t = this.#ticket(ws, id); if (t.status !== 'running') return [];
        const due = [];
        for (const [gateId, g] of Object.entries(t.execution.gates)) {
          if (g.status !== 'returned' || g.humanOverride) continue;
          const definition = this.#definition(t, gateId, 'gates'), rework = definition.rework;
          if (!rework || !(rework.maxRounds > 0)) continue;
          const isAgent = definition.reviewer.kind === 'agent';
          if (isAgent && (g.autoReworkRounds ?? 0) >= rework.maxRounds) continue;
          const findings = (g.reviews ?? []).filter(r => r.decision === 'returned' && r.cycle === g.cycle).flatMap(r => r.findings ?? []);
          const targetNodes = (rework.targetNodes ?? definition.from).filter(id => this.#node(t,id).status !== 'skipped');
          if (targetNodes.length) due.push({ gateId, targetNodes, findings, autoRound: isAgent });
        }
        return due;
      },
      applyRework: (id, gateId) => {
        const t = this.#ticket(ws, id), g = this.#gate(t, gateId), definition = this.#definition(t, gateId, 'gates');
        requireThat(t.status === 'running' && g.status === 'returned' && !g.humanOverride, 'state-conflict', 'Gate is not ready for rework.');
        const rework = definition.rework; requireThat(rework && rework.maxRounds > 0, 'state-conflict', 'Gate has no enabled rework policy.');
        const isAgent = definition.reviewer.kind === 'agent';
        if (isAgent) requireThat((g.autoReworkRounds ?? 0) < rework.maxRounds, 'state-conflict', 'Rework budget is exhausted.');
        const targetNodes = (rework.targetNodes ?? definition.from).filter(id => this.#node(t,id).status !== 'skipped');
        const findings = (g.reviews ?? []).filter(r => r.decision === 'returned' && r.cycle === g.cycle).flatMap(r => r.findings ?? []);
        const actor = { kind: 'system' }, reason = `Gate ${gateId} returned; pre-approved rework. Findings: ${JSON.stringify(findings)}`;
        this.#retry(t, targetNodes, reason, actor);
        if (isAgent) g.autoReworkRounds = (g.autoReworkRounds ?? 0) + 1;
        this.#event(t, 'gate-rework', actor, { gateId, targetNodes: copy(targetNodes), autoRound: isAgent, autoReworkRounds: g.autoReworkRounds ?? 0 });
        return copy(t);
      },
      noteReworkExhausted: id => {
        const t = this.#ticket(ws, id); if (t.status !== 'running') return;
        for (const [gateId, g] of Object.entries(t.execution.gates)) {
          const d = this.#definition(t, gateId, 'gates');
          if (g.status !== 'returned' || g.humanOverride || d.reviewer.kind !== 'agent' || !d.rework || !(d.rework.maxRounds > 0) || (g.autoReworkRounds ?? 0) < d.rework.maxRounds) continue;
          if (t.activity.some(a => a.type === 'rework-exhausted' && a.detail?.gateId === gateId && a.detail?.cycle === g.cycle)) continue;
          this.#touch(t); this.#event(t, 'rework-exhausted', { kind: 'system' }, { gateId, cycle: g.cycle, autoReworkRounds: g.autoReworkRounds, maxRounds: d.rework.maxRounds });
        }
      }
    });
  }
  readRootAgent(id) { return projectTemplate(this.#template(id, 'agent')); }
  readRootOrchestration(id) { return projectTemplate(this.#template(id, 'orchestration')); }
  readBinding() { return null; }
}
