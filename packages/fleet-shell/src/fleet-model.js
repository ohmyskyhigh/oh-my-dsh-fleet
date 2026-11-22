/** Shared, browser-safe Ticket contract. Projections are detached read models, never persistence inputs. */
// Plugin-built-in support-version (P-39): not user-modifiable; admin bumps it per release. Drafts whose
// plan.contractVersion differs are read-only judged incompatible on load (recreate path), never modified.
// 0.8.0 bumps 1 -> 2 to force legacy v1 drafts through recreation; plan shape is unchanged.
export const PLAN_CONTRACT_VERSION = 3;
export const STORE_SCHEMA_VERSION = 2;
export const TICKET_STATUSES = Object.freeze(['draft', 'running', 'stop-requested', 'stopped', 'delivered', 'superseded']);
export class FleetModelError extends Error {
  constructor(code, message, diagnostics = []) { super(message); this.name = 'FleetModelError'; this.code = code; this.diagnostics = diagnostics; }
}
const fail = (code, message) => { throw new FleetModelError(code, message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);

export function seriesKind(series) {
  return series?.host?.timing?.kind || series?.timing?.kind;
}
export function seriesRecurrence(series) {
  return ['at', 'after'].includes(seriesKind(series)) ? 'once' : 'recurring';
}

/** Host scheduledAt is a UTC instant. Reject malformed dates that Date.parse would normalize. */
export function isUtcInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}
export function seriesScheduledAt(series) {
  const value = series?.host?.scheduledAt;
  return isUtcInstant(value) ? value : null;
}

/** Project the current host rule into the ScheduleTiming shape used at creation. */
export function effectiveSeriesTiming(series) {
  const kind = seriesKind(series);
  const host = series?.host?.timing ?? {};
  const saved = series?.timing?.kind === kind ? series?.timing ?? {} : {};
  switch (kind) {
    case 'at': return { kind, at: seriesScheduledAt(series) ?? clone(saved.at) };
    case 'after': return { kind, after_seconds: host.afterSeconds ?? saved.after_seconds };
    case 'every': return { kind, every_seconds: host.everySeconds ?? saved.every_seconds };
    case 'rrule': return { kind, rrule: host.rrule ?? saved.rrule };
    case 'daily':
    case 'weekly':
    case 'cron': {
      const selector = saved[kind];
      const field = kind === 'cron' ? 'expression' : 'time';
      return { kind, [kind]: {
        [field]: host[field] ?? selector?.[field],
        time_zone: host.timeZone ?? selector?.time_zone,
        ...(kind === 'weekly' ? { weekdays: clone(host.weekdays ?? selector?.weekdays) } : {})
      } };
    }
    default: return clone(series?.timing);
  }
}

const identity = value => typeof value === 'string' && value.length > 0 && !/[\s\x00-\x1f\x7f]/u.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
export function isCurrentPlan(plan) { return record(plan) && plan.contractVersion === PLAN_CONTRACT_VERSION && !('ticket' in plan || 'binding' in plan || 'orchestration' in plan); }
export function canEditTicket(ticket) { return ['draft', 'stopped'].includes(ticket?.status) && isCurrentPlan(ticket?.plan) && !ticket?.execution?.legacy?.readOnly; }
/** Compatibility is a read-model property, never a new persisted Ticket status. */
export function isIncompatibleDraft(ticket) { return ticket?.status === 'draft' && !validatePlan(ticket.plan, { mode: 'save' }).valid; }

/** P-53: a readable *default* display name derived from the goal when no explicit title is set.
 * Strips request/polite frames and leading prepositions, prefers the first sentence (or first clause
 * when the sentence is long), and caps length so labels stay scannable. Explicit plan.title always wins. */
export function readableTitle(goal) {
  const MAX = 24;
  let s = String(goal ?? '').trim();
  if (!s) return '';
  s = s.replace(/^(请|麻烦|帮我|帮忙|我要|我想|我需要|我希望|需要|希望)+/, '').trim();
  s = s.split(/[。．!！?？;；\n]/)[0].trim();
  if (s.length > MAX) { const clause = s.split(/[，,、：:]/)[0].trim(); if (clause && clause.length <= MAX) s = clause; }
  s = s.replace(/^(对|对于|给|为|关于)/, '').trim();
  if (s.length > MAX) s = s.slice(0, MAX).trimEnd() + '…';
  return s;
}

/** P-48 dual-layer deliverable item: legacy string equals {text}. Never rewrite legacy items on save.
 * P-56 additive: category ('code'|'noncode'|'other') marks what the human receives; files is the expected
 * file manifest (text path or {path?,purpose?}); entries missing a path render as undetermined, never guessed. */
export function deliverableView(item) {
  if (typeof item === 'string') return { label: item, spec: item, criteria: [], files: [] };
  if (!record(item)) return { label: '', spec: '', criteria: [], files: [] };
  const text = typeof item.text === 'string' ? item.text : '';
  const files = Array.isArray(item.files) ? item.files
    .map(f => typeof f === 'string' ? { path: f.trim() }
      : record(f) ? { ...(typeof f.path === 'string' && f.path.trim() ? { path: f.path.trim() } : {}), ...(typeof f.purpose === 'string' && f.purpose.trim() ? { purpose: f.purpose.trim() } : {}) } : null)
    .filter(f => f && (f.path !== undefined || f.purpose !== undefined)) : [];
  return { label: (typeof item.title === 'string' && item.title) || text, spec: text, files,
    ...(typeof item.title === 'string' ? { title: item.title } : {}),
    ...(typeof item.description === 'string' ? { description: item.description } : {}),
    ...(['code', 'noncode', 'other'].includes(item.category) ? { category: item.category } : {}),
    criteria: Array.isArray(item.criteria) ? item.criteria.filter(c => typeof c === 'string') : [] };
}
/** P-62 orchestration plan for one node task: the stage goal, the tasks to complete, the expected
 * outcomes (deliverable or event) and the tools/plugins/skills the Agent plans to use, each with a
 * purpose. Read-only view; missing declarations stay distinguishable from an explicit empty list. */
export function stagePlanView(task) {
  const stage = record(task?.stagePlan) ? task.stagePlan : null;
  const capabilities = Array.isArray(task?.plannedCapabilities) ? task.plannedCapabilities.filter(record) : null;
  return {
    stage: stage ? {
      goal: typeof stage.goal === 'string' ? stage.goal : '',
      tasks: Array.isArray(stage.tasks) ? stage.tasks.filter(v => typeof v === 'string' && v.trim()) : [],
      outcomes: Array.isArray(stage.outcomes) ? stage.outcomes.filter(record).map(outcome => ({
        kind: outcome.kind === 'event' ? 'event' : 'deliverable',
        ...(typeof outcome.text === 'string' && outcome.text.trim() ? { text: outcome.text } : {}),
        ...(Number.isSafeInteger(outcome.deliverableIndex) ? { deliverableIndex: outcome.deliverableIndex } : {})
      })) : []
    } : null,
    capabilities: capabilities ? capabilities.map(capability => ({
      kind: ['tool', 'plugin', 'skill'].includes(capability.kind) ? capability.kind : 'tool',
      id: typeof capability.id === 'string' ? capability.id : '',
      ...(typeof capability.name === 'string' && capability.name.trim() ? { name: capability.name } : {}),
      purpose: typeof capability.purpose === 'string' ? capability.purpose : '',
      tools: Array.isArray(capability.tools) ? capability.tools.filter(v => typeof v === 'string' && v.trim()) : []
    })) : null,
    declared: Boolean(stage || Array.isArray(task?.plannedCapabilities))
  };
}
/** P-50 effective selection: node override ?? agent profile ?? host default (null). */
export function effectiveModelSelection(node, agent) {
  if (record(node?.modelSelection)) return { selection: node.modelSelection, source: 'node' };
  if (record(agent?.profile?.modelSelection)) return { selection: agent.profile.modelSelection, source: 'agent' };
  return { selection: null, source: 'default' };
}
export function effectiveGateModelSelection(gate, node, agent) {
  if (record(gate?.modelSelection)) return { selection: gate.modelSelection, source: 'gate' };
  return effectiveModelSelection(node, agent);
}
function validateModelSelection(value, path, add) {
  if (!record(value)) { add(path, 'modelSelection must be an object.', 'unsupported-profile'); return; }
  if (Object.keys(value).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) add(path, 'Unexpected modelSelection field.', 'unsupported-profile');
  for (const key of ['provider', 'model']) if (typeof value[key] !== 'string' || !value[key].trim()) add(`${path}.${key}`, `modelSelection.${key} must be nonempty text.`, 'unsupported-profile');
  if (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== 'string' || !value.reasoningEffort.trim())) add(`${path}.reasoningEffort`, 'modelSelection.reasoningEffort must be nonempty text.', 'unsupported-profile');
}

function validateCapabilities(capabilities, path, add) {
  if (!Array.isArray(capabilities) || capabilities.length > 50) { add(path, 'plannedCapabilities must hold at most 50 entries.'); return; }
  for (const [index, capability] of capabilities.entries()) {
    const p = `${path}[${index}]`;
    if (!record(capability)) { add(p, 'Planned capability must be an object.'); continue; }
    if (Object.keys(capability).some(key => !['kind', 'id', 'name', 'purpose', 'tools'].includes(key))) add(p, 'Unexpected planned capability field.');
    if (!['tool', 'plugin', 'skill'].includes(capability.kind)) add(`${p}.kind`, 'kind must be tool, plugin or skill.');
    for (const key of ['id', 'purpose']) if (typeof capability[key] !== 'string' || !capability[key].trim()) add(`${p}.${key}`, `${key} must be nonempty text.`);
    if (capability.name !== undefined && (typeof capability.name !== 'string' || !capability.name.trim())) add(`${p}.name`, 'name must be nonempty text.');
    if (capability.tools !== undefined && (!Array.isArray(capability.tools) || capability.tools.length > 50 || !capability.tools.every(v => typeof v === 'string' && v.trim()))) add(`${p}.tools`, 'tools must hold up to 50 nonempty strings.');
  }
}
function validateReviewTask(task, path, add) {
  if (!record(task)) { add(path, 'reviewTask must be an object.'); return; }
  if (Object.keys(task).some(key => !['summary', 'inputs', 'checks'].includes(key))) add(path, 'Unexpected reviewTask field.');
  if (task.summary !== undefined && (typeof task.summary !== 'string' || !task.summary.trim())) add(`${path}.summary`, 'summary must be nonempty text.');
  for (const key of ['inputs', 'checks']) {
    const list = task[key];
    if (list !== undefined && (!Array.isArray(list) || list.length > 50 || !list.every(v => typeof v === 'string' && v.trim()))) add(`${path}.${key}`, `${key} must hold up to 50 nonempty strings.`);
  }
}

/** Missing versions are accepted only for fresh canonical-shaped input, never a stored legacy plan. */
export function normalizePlan(input, { allowMissingVersion = true } = {}) {
  if (!record(input)) fail('invalid-input', 'plan must be an object.');
  if ('ticket' in input || 'binding' in input || 'orchestration' in input || Array.isArray(input.agents)) fail('legacy-plan', 'Legacy plans require explicit repair or regeneration.');
  if (input.contractVersion !== PLAN_CONTRACT_VERSION && !(allowMissingVersion && input.contractVersion === undefined)) fail('unsupported-contract', 'Unknown plan contractVersion; repair or regenerate explicitly.');
  const plan = clone(input);
  const allowed = ['contractVersion', 'goal', 'title', 'inputs', 'deliverables', 'criteria', 'requirements', 'agents', 'nodes', 'gates'];
  if (Object.keys(plan).some(key => !allowed.includes(key))) fail('invalid-input', 'Unexpected plan field.');
  plan.contractVersion = PLAN_CONTRACT_VERSION;
  // Title is a cosmetic display name, distinct from goal; empty/invalid means "unset" (fall back to goal).
  if (plan.title !== undefined && (typeof plan.title !== 'string' || !plan.title.trim())) delete plan.title;
  for (const [key, value] of Object.entries({ inputs: {}, deliverables: [], criteria: [], agents: {}, nodes: [], gates: [] })) if (plan[key] === undefined) plan[key] = clone(value);
  if (Array.isArray(plan.nodes)) for (const node of plan.nodes) if (record(node)) {
    if (node.agentId === undefined) node.agentId = null;
    if (node.dependsOn === undefined) node.dependsOn = [];
    if (node.task === undefined) node.task = {};
  }
  const result = validatePlan(plan);
  if (!result.valid) throw new FleetModelError(result.errors[0].code, result.errors[0].message, result.errors);
  return plan;
}

/** Save checks shape/identities only. Start also checks references, profiles, tasks and the complete DAG. */
export function validatePlan(plan, { mode = 'save' } = {}) {
  const errors = [], diagnostics = [];
  const add = (path, message, code = 'invalid-input', execution = false) => (execution ? diagnostics : errors).push({ path, message, code });
  if (!isCurrentPlan(plan)) return { valid: false, errors: [{ path: 'contractVersion', code: 'unsupported-contract', message: 'Plan needs explicit repair to contractVersion 1.' }], diagnostics: [] };
  if (typeof plan.goal !== 'string' || !plan.goal.trim()) add('goal', 'Goal must be nonempty text.');
  for (const key of ['inputs', 'agents']) if (!record(plan[key])) add(key, `${key} must be an object.`);
  if (!Array.isArray(plan.criteria) || !plan.criteria.every(v => typeof v === 'string')) add('criteria', 'criteria must be a string array; complex legacy criteria require explicit repair.');
  if (!Array.isArray(plan.deliverables)) add('deliverables', 'deliverables must be an array.');
  else for (const [index, item] of plan.deliverables.entries()) {
    const p = `deliverables[${index}]`;
    if (typeof item === 'string') continue;
    if (!record(item)) { add(p, 'Deliverable must be text or a {text,title?,description?,criteria?,category?,files?} object.'); continue; }
    if (Object.keys(item).some(key => !['text', 'title', 'description', 'criteria', 'category', 'files'].includes(key))) add(p, 'Unexpected deliverable field.');
    if (typeof item.text !== 'string' || !item.text.trim()) add(`${p}.text`, 'Deliverable object needs nonempty text (the full agent spec).');
    for (const key of ['title', 'description']) if (item[key] !== undefined && (typeof item[key] !== 'string' || !item[key].trim())) add(`${p}.${key}`, `${key} must be nonempty text.`);
    if (item.criteria !== undefined && (!Array.isArray(item.criteria) || !item.criteria.every(v => typeof v === 'string'))) add(`${p}.criteria`, 'criteria must be a string array.');
    if (item.category !== undefined && !['code', 'noncode', 'other'].includes(item.category)) add(`${p}.category`, 'category must be code, noncode or other.');
    if (item.files !== undefined) {
      if (!Array.isArray(item.files) || item.files.length > 200) add(`${p}.files`, 'files must be an array of at most 200 entries.');
      else for (const [fi, f] of item.files.entries()) {
        const fp = `${p}.files[${fi}]`;
        if (typeof f === 'string') { if (!f.trim()) add(fp, 'File entry must be nonempty text.'); continue; }
        if (!record(f)) { add(fp, 'Deliverable file must be text or a {path?,purpose?} object.'); continue; }
        if (Object.keys(f).some(key => !['path', 'purpose'].includes(key))) add(fp, 'Unexpected deliverable file field.');
        for (const key of ['path', 'purpose']) if (f[key] !== undefined && (typeof f[key] !== 'string' || !f[key].trim())) add(`${fp}.${key}`, `${key} must be nonempty text.`);
        if (f.path === undefined && f.purpose === undefined) add(fp, 'Deliverable file needs a path or a purpose.');
      }
    }
  }
  if (plan.requirements !== undefined && typeof plan.requirements !== 'string') add('requirements', 'requirements must be text.');
  for (const key of ['nodes', 'gates']) if (!Array.isArray(plan[key])) add(key, `${key} must be an array.`);
  if (errors.length) return { valid: false, errors, diagnostics };
  for (const [id, agent] of Object.entries(plan.agents)) {
    if (!identity(id)) add(`agents.${id}`, 'Invalid local Agent ID.');
    if (!record(agent) || !record(agent.profile) || (agent.name !== undefined && typeof agent.name !== 'string')) { add(`agents.${id}`, 'Agent needs a profile object and optional name.'); continue; }
    if (Object.keys(agent).some(key => !['name', 'profile'].includes(key))) add(`agents.${id}`, 'Local Agent only holds its name and profile.');
    for (const key of ['instructions', 'agentPreset']) if (agent.profile[key] !== undefined && typeof agent.profile[key] !== 'string') add(`agents.${id}.profile.${key}`, `${key} must be text.`);
    for (const key of ['model', 'provider', 'parameters', 'temperature', 'maxTokens', 'reasoningEffort']) if (agent.profile[key] !== undefined) add(`agents.${id}.profile.${key}`, `Custom profile.${key} is not supported; use profile.modelSelection or agentPreset.`, 'unsupported-profile', true);
    if (agent.profile.modelSelection !== undefined) validateModelSelection(agent.profile.modelSelection, `agents.${id}.profile.modelSelection`, (path, message, code) => add(path, message, code, true));
  }
  const ids = new Set(), gateIds = new Set();
  for (const [index, node] of plan.nodes.entries()) {
    const p = `nodes[${index}]`;
    if (!record(node) || !identity(node.id)) { add(p, 'Invalid Node identity.'); continue; }
    if (Object.keys(node).some(key => !['id', 'agentId', 'role', 'dependsOn', 'task', 'modelSelection'].includes(key))) add(p, 'Unexpected plan Node field; execution facts do not belong in plan.');
    if (ids.has(node.id)) add(p, 'Duplicate Node identity.'); ids.add(node.id);
    if (node.agentId !== null && !identity(node.agentId)) add(`${p}.agentId`, 'agentId must be a local ID or null.');
    if (node.role !== undefined && typeof node.role !== 'string') add(`${p}.role`, 'role must be display text.');
    if (!Array.isArray(node.dependsOn) || !node.dependsOn.every(identity) || new Set(node.dependsOn).size !== node.dependsOn.length) add(`${p}.dependsOn`, 'Dependencies must be unique Node IDs.');
    if (node.modelSelection !== undefined) validateModelSelection(node.modelSelection, `${p}.modelSelection`, (path, message, code) => add(path, message, code, true));
    if (!record(node.task)) add(`${p}.task`, 'task must be an object.');
    else if (node.task.prompt !== undefined && typeof node.task.prompt !== 'string') add(`${p}.task.prompt`, 'task.prompt must be text.');
    else if (!node.task.prompt?.trim()) add(`${p}.task.prompt`, 'Node needs a task prompt before starting.', 'incomplete-plan', true);
    if (record(node.task) && node.task.summary !== undefined && typeof node.task.summary !== 'string') add(`${p}.task.summary`, 'task.summary must be text.');
    if (record(node.task) && node.task.stagePlan !== undefined) {
      const stage = node.task.stagePlan, sp = `${p}.task.stagePlan`;
      if (!record(stage)) add(sp, 'stagePlan must be an object.');
      else {
        if (Object.keys(stage).some(key => !['goal', 'tasks', 'outcomes'].includes(key))) add(sp, 'Unexpected stagePlan field.');
        if (stage.goal !== undefined && (typeof stage.goal !== 'string' || !stage.goal.trim())) add(`${sp}.goal`, 'stagePlan.goal must be nonempty text.');
        if (stage.tasks !== undefined && (!Array.isArray(stage.tasks) || stage.tasks.length > 50 || !stage.tasks.every(v => typeof v === 'string' && v.trim()))) add(`${sp}.tasks`, 'stagePlan.tasks must be up to 50 nonempty strings.');
        if (stage.outcomes !== undefined) {
          if (!Array.isArray(stage.outcomes) || stage.outcomes.length > 50) add(`${sp}.outcomes`, 'stagePlan.outcomes must hold at most 50 entries.');
          else for (const [oi, outcome] of stage.outcomes.entries()) {
            const op = `${sp}.outcomes[${oi}]`;
            if (!record(outcome)) { add(op, 'Outcome must be an object.'); continue; }
            if (Object.keys(outcome).some(key => !['kind', 'text', 'deliverableIndex'].includes(key))) add(op, 'Unexpected outcome field.');
            if (!['deliverable', 'event'].includes(outcome.kind)) add(`${op}.kind`, 'Outcome kind must be deliverable or event.');
            if (outcome.text !== undefined && (typeof outcome.text !== 'string' || !outcome.text.trim())) add(`${op}.text`, 'Outcome text must be nonempty.');
            if (outcome.deliverableIndex !== undefined && (!Number.isSafeInteger(outcome.deliverableIndex) || outcome.deliverableIndex < 0)) add(`${op}.deliverableIndex`, 'deliverableIndex must be a non-negative integer.');
            if (outcome.kind === 'event' && !(typeof outcome.text === 'string' && outcome.text.trim())) add(op, 'An event outcome needs text.');
            if (outcome.kind === 'deliverable' && !(typeof outcome.text === 'string' && outcome.text.trim()) && outcome.deliverableIndex === undefined) add(op, 'A deliverable outcome needs text or deliverableIndex.');
          }
        }
      }
    }
    if (record(node.task) && node.task.plannedCapabilities !== undefined) validateCapabilities(node.task.plannedCapabilities, `${p}.task.plannedCapabilities`, add);
    if (record(node.task) && node.task.contract !== undefined) {
      const c = node.task.contract, cp = `${p}.task.contract`;
      const strArray = (v, path, label) => { if (v !== undefined && (!Array.isArray(v) || !v.every(x => typeof x === 'string'))) add(path, `${label} must be a string array.`); };
      if (!record(c)) add(cp, 'contract must be an object.');
      else {
        if (Object.keys(c).some(key => !['acceptance', 'scope', 'verify'].includes(key))) add(cp, 'Unexpected task contract field.');
        strArray(c.acceptance, `${cp}.acceptance`, 'acceptance'); strArray(c.verify, `${cp}.verify`, 'verify');
        if (c.scope !== undefined) {
          if (!record(c.scope)) add(`${cp}.scope`, 'scope must be an object.');
          else {
            if (Object.keys(c.scope).some(key => !['in', 'out'].includes(key))) add(`${cp}.scope`, 'Unexpected contract scope field.');
            strArray(c.scope.in, `${cp}.scope.in`, 'scope.in'); strArray(c.scope.out, `${cp}.scope.out`, 'scope.out');
          }
        }
      }
    }
    if (!node.agentId || !Object.hasOwn(plan.agents, node.agentId)) add(`${p}.agentId`, 'Node needs an assigned local Agent before starting.', 'incomplete-plan', true);
  }
  for (const [index, gate] of plan.gates.entries()) {
    const p = `gates[${index}]`;
    if (!record(gate) || !identity(gate.id)) { add(p, 'Invalid Gate identity.'); continue; }
    const gateFields = ['id', 'from', 'to', 'reviewer', 'requireEvidence', 'rework'];
    if (gate.reviewer?.kind === 'agent') gateFields.push('reviewTask', 'modelSelection', 'plannedCapabilities');
    if (Object.keys(gate).some(key => !gateFields.includes(key))) add(p, 'Unexpected field for this Gate reviewer.');
    if (gate.reviewTask !== undefined) validateReviewTask(gate.reviewTask, `${p}.reviewTask`, add);
    if (gate.modelSelection !== undefined) validateModelSelection(gate.modelSelection, `${p}.modelSelection`, add);
    if (gate.plannedCapabilities !== undefined) validateCapabilities(gate.plannedCapabilities, `${p}.plannedCapabilities`, add);
    if (gateIds.has(gate.id)) add(p, 'Duplicate Gate identity.'); gateIds.add(gate.id);
    for (const edge of ['from', 'to']) if (!Array.isArray(gate[edge]) || !gate[edge].every(identity) || new Set(gate[edge]).size !== gate[edge].length) add(`${p}.${edge}`, 'Gate edges must be unique Node IDs.');
    if (!record(gate.reviewer) || !['human', 'agent'].includes(gate.reviewer.kind) || (gate.reviewer.kind === 'agent' && !identity(gate.reviewer.nodeId))) add(`${p}.reviewer`, 'Gate needs a human or Node reviewer.');
    else if (Object.keys(gate.reviewer).some(key => !(gate.reviewer.kind === 'human' ? ['kind'] : ['kind', 'nodeId']).includes(key))) add(`${p}.reviewer`, 'Unexpected Gate reviewer field.');
    if (gate.requireEvidence !== undefined && typeof gate.requireEvidence !== 'boolean') add(`${p}.requireEvidence`, 'requireEvidence must be a boolean.');
    if (gate.rework !== undefined) {
      const r = gate.rework, rp = `${p}.rework`;
      if (!record(r)) add(rp, 'rework must be an object.');
      else {
        if (Object.keys(r).some(key => !['maxRounds', 'targetNodes', 'scopeNote'].includes(key))) add(rp, 'Unexpected Gate rework field.');
        if (!Number.isSafeInteger(r.maxRounds) || r.maxRounds < 0) add(`${rp}.maxRounds`, 'rework.maxRounds must be a safe integer >= 0.');
        if (r.targetNodes !== undefined && (!Array.isArray(r.targetNodes) || !r.targetNodes.every(identity) || new Set(r.targetNodes).size !== r.targetNodes.length)) add(`${rp}.targetNodes`, 'rework.targetNodes must be unique Node IDs.');
        if (r.scopeNote !== undefined && typeof r.scopeNote !== 'string') add(`${rp}.scopeNote`, 'rework.scopeNote must be text.');
      }
    }
  }
  if (errors.length) return { valid: false, errors, diagnostics };
  if (!plan.nodes.length) add('nodes', 'Plan needs at least one Node before starting.', 'incomplete-plan', true);
  const parents = new Map(plan.nodes.map(n => [n.id, [...n.dependsOn]]));
  for (const node of plan.nodes) for (const id of node.dependsOn) if (!ids.has(id)) add(`nodes.${node.id}.dependsOn`, `Unknown dependency ${id}.`, 'invalid-flow', true);
  for (const gate of plan.gates) {
    if (!gate.from.length) add(`gates.${gate.id}`, 'Gate needs source Nodes before starting.', 'incomplete-plan', true);
    for (const id of [...gate.from, ...gate.to]) if (!ids.has(id)) add(`gates.${gate.id}`, `Unknown Gate Node ${id}.`, 'invalid-flow', true);
    if (gate.reviewer.kind === 'agent' && !ids.has(gate.reviewer.nodeId)) add(`gates.${gate.id}.reviewer`, 'Unknown reviewer Node.', 'invalid-flow', true);
    if (gate.rework?.targetNodes) for (const id of gate.rework.targetNodes) if (!gate.from.includes(id)) add(`gates.${gate.id}.rework.targetNodes`, `Rework target ${id} must be one of the Gate's from Nodes.`, 'invalid-flow', true);
    for (const id of gate.to) parents.get(id)?.push(...gate.from);
  }
  const visiting = new Set(), done = new Set();
  const visit = id => {
    if (!parents.has(id) || done.has(id)) return;
    if (visiting.has(id)) { add('nodes', 'Plan contains a dependency cycle.', 'invalid-flow', true); return; }
    visiting.add(id); for (const parent of parents.get(id)) visit(parent); visiting.delete(id); done.add(id);
  };
  for (const id of ids) visit(id);
  if (mode === 'start') errors.push(...diagnostics);
  return { valid: errors.length === 0, errors, diagnostics };
}

/** Display levels mirror runtime readiness (#runnable): a Node waits for its dependsOn AND every
 * Gate targeting it, so Gate-guarded successors render in a later column, never beside their source. */
export function graphLevels(nodes = [], gates = []) {
  const remaining = new Map(nodes.map(n => [n.id, clone(n)])), done = new Set(), passed = new Set(), levels = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter(n => (n.dependsOn ?? []).every(id => done.has(id) || !remaining.has(id))
      && gates.filter(g => g.to?.includes(n.id)).every(g => passed.has(g.id) || (g.from ?? []).every(id => !remaining.has(id))));
    if (!ready.length) { levels.push([...remaining.values()]); break; }
    levels.push(ready); for (const node of ready) { remaining.delete(node.id); done.add(node.id); }
    for (const gate of gates) if (!passed.has(gate.id) && (gate.from ?? []).length && (gate.from ?? []).every(id => done.has(id))) passed.add(gate.id);
  }
  return levels;
}

export function projectTemplate(template) {
  const t = clone(template);
  return t.kind === 'agent' ? { ...t, profile: clone(t.content.profile), sourceId: t.source?.templateId ?? null, history: t.history.map(h => ({ ...h, profile: h.content?.profile ?? h.profile })) }
    : { ...t, definition: clone(t.content), history: t.history.map(h => ({ ...h, definition: h.content ?? h.definition })) };
}

/** Derived Gate coverage (P-45): never a persisted state. A passed Gate is stale when a from-node
 * artifact has a newer version than the current cycle's passed review bound; humanOverride always covers. */
function gateCoverage(g, artifacts) {
  if (g.status !== 'passed') return 'not-passed';
  if (g.humanOverride) return 'covered';
  const from = Object.entries(artifacts ?? {}).filter(([, a]) => (g.from ?? []).includes(a.nodeId));
  if (!from.length) return 'covered'; // legacy passed Gate without artifact bindings stays compatible
  const refs = (g.reviews ?? []).filter(r => r.decision === 'passed' && r.cycle === g.cycle).flatMap(r => r.artifactRefs ?? []);
  const uncovered = from.some(([id, a]) => { const lv = a.versions?.at(-1); return lv && !refs.some(r => r.artifactId === id && r.version === lv.version); });
  if (!uncovered) return 'covered';
  return refs.length ? 'stale' : 'unreviewed';
}
function deliverableReviewStatus(artifact, gates) {
  const relevant = gates.filter(g => (g.from ?? []).includes(artifact.nodeId));
  if (!relevant.length) return 'unreviewed';
  if (relevant.some(g => g.coverage === 'stale')) return 'stale';
  return relevant.every(g => g.coverage === 'covered') ? 'covered' : 'unreviewed';
}

/** Execution projections use the requested frozen plan (current by default), never Root lookups. */
export function projectTicket(ticket, { configRevision = ticket?.execution?.currentConfigRevision } = {}) {
  const t = clone(ticket);
  const unknownConfigRevision = Boolean(t.execution && !Object.hasOwn(t.execution.configurations ?? {}, configRevision));
  let configuration = t.execution?.configurations?.[configRevision];
  if (configRevision === null && t.legacy) configuration = Object.values(t.execution?.configurations ?? {}).find(c => c.legacySnapshot);
  let plan = t.execution ? configuration?.plan : t.plan;
  if (!plan && configuration?.legacySnapshot) {
    const legacy = configuration.legacySnapshot;
    const agents = {};
    for (const [role, agent] of Object.entries(legacy.agents ?? {})) agents[agent.id ?? role] = { ...(agent.name !== undefined ? { name: agent.name } : {}), profile: clone(agent.profile ?? {}) };
    plan = { goal: legacy.goal, inputs: clone(legacy.inputs ?? {}), criteria: clone(legacy.criteria ?? []), deliverables: clone(legacy.deliverables ?? []), agents,
      nodes: (legacy.orchestration?.definition?.nodes ?? []).map(n => ({ ...clone(n), agentId: legacy.binding?.roleAgents?.[n.role] ?? legacy.agents?.[n.role]?.id ?? null })), gates: clone(legacy.orchestration?.definition?.gates ?? []) };
  }
  const validPlan = record(plan) ? plan : {};
  const definitions = validPlan.nodes ?? [];
  const nodes = Array.isArray(definitions) ? definitions.map(n => ({ ...clone(n), ...(t.execution?.nodes?.[n.id] ?? { status: 'pending', attempts: [], thread: [] }), id: n.id })) : [];
  const artifacts = clone(t.execution?.artifacts ?? {});
  const gates = (Array.isArray(validPlan.gates) ? validPlan.gates : []).map(g => {
    const merged = { ...clone(g), ...(t.execution?.gates?.[g.id] ?? { status: 'pending', reviews: [], humanOverride: null, history: [] }), id: g.id };
    merged.coverage = gateCoverage(merged, artifacts);
    merged.rework = { enabled: Boolean(g.rework && g.rework.maxRounds > 0), maxRounds: g.rework?.maxRounds ?? 0, autoReworkRounds: merged.autoReworkRounds ?? 0, unlimited: g.reviewer?.kind === 'human', ...(g.rework?.scopeNote !== undefined ? { scopeNote: g.rework.scopeNote } : {}) };
    return merged;
  });
  const current = isCurrentPlan(t.plan) ? t.plan : t.plan?.ticket ?? t.plan ?? {};
  const registry = t.execution?.deliverables ?? {}, deliveryHistory = t.execution?.delivery?.history ?? [];
  const deliverables = (validPlan.deliverables ?? current.deliverables ?? []).map((item, index) => {
    // P-48: display title comes from the requested plan item (title || text); bound.label is history only.
    const view = deliverableView(item);
    const bound = registry[String(index)], artifactId = bound?.artifactId, artifact = artifactId ? artifacts[artifactId] : undefined, lv = artifact?.versions?.at(-1);
    const latest = lv ? { version: lv.version, sha256: lv.sha256, snapshotPath: lv.snapshotPath, submittedAt: lv.submittedAt } : undefined;
    // P-56: match each expected file to submitted artifacts bound to this deliverable index (exact path, else basename).
    const indexArts = Object.entries(artifacts).filter(([, a]) => a && a.deliverableIndex === index && typeof a.sourcePath === 'string');
    const files = view.files.map(f => {
      if (f.path === undefined) return { ...f };
      const want = String(f.path).replace(/\\/g, '/');
      const base = want.split('/').pop();
      const hit = indexArts.find(([, a]) => { const src = String(a.sourcePath).replace(/\\/g, '/'); return src === want || (base && (src === base || src.endsWith(`/${base}`))); });
      if (!hit) return { ...f };
      const [hitId, art] = hit, av = art.versions?.at(-1);
      return { ...f, submitted: av ? { artifactId: hitId, version: av.version, sha256: av.sha256, snapshotPath: av.snapshotPath, submittedAt: av.submittedAt } : undefined };
    });
    const row = deliveryHistory.find(h => (h.items ?? []).some(it => it.deliverableIndex === index));
    const delivery = row ? { deliveryId: row.id, location: row.target, deliveredAt: row.time, manifestPath: row.manifestPath, receiptPath: row.receiptPath } : undefined;
    return { index, label: view.label, spec: view.spec, ...(view.title !== undefined ? { title: view.title } : {}), ...(view.description !== undefined ? { description: view.description } : {}), criteria: clone(view.criteria), files, ...(view.category !== undefined ? { category: view.category } : {}), ...(artifactId ? { artifactId } : {}), ...(latest ? { latest } : {}), reviewStatus: artifactId ? deliverableReviewStatus(artifact, gates) : 'unbound', ...(delivery ? { delivery } : {}) };
  });
  const delivery = clone(t.execution?.delivery ?? null);
  const agents = Object.fromEntries(Object.entries(validPlan.agents ?? {}).map(([id, a]) => [id, { ...clone(a), id }]));
  const snapshot = configuration ? { ...clone(validPlan), configRevision, ...(unknownConfigRevision ? { unknownConfigRevision: true } : {}), ...(configuration.legacySnapshot ? { legacySnapshot: clone(configuration.legacySnapshot) } : {}), sourceRefs: clone(configuration.sourceRefs ?? []), agents, orchestration: { id: null, revision: configRevision, definition: { nodes: clone(validPlan.nodes ?? []), gates: clone(validPlan.gates ?? []) } }, binding: { orchestrationId: null, nodeAgents: Object.fromEntries(nodes.map(n => [n.id, n.agentId])), local: clone(validPlan.inputs ?? {}) } } : null;
  return { ...t, ...(unknownConfigRevision ? { unknownConfigRevision: true } : {}), goal: current.goal ?? '', ...(typeof current.title === 'string' && current.title.trim() ? { title: current.title } : {}), inputs: clone(current.inputs ?? {}), deliverables, artifacts, delivery, criteria: clone(current.criteria ?? []), ...(current.requirements === undefined ? {} : { requirements: current.requirements }),
    nodes, gates, snapshot, events: clone(t.activity ?? []), changes: (t.activity ?? []).filter(a => ['plan-edited', 'plan-repaired', 'node-changed'].includes(a.type)).map(a => ({ id: a.id, time: a.time, actor: a.actor, revision: a.ticketRevision, ...clone(a.detail) })) };
}

/** Lossless known legacy mapping. Unknown fields and complex criteria remain archived, never guessed. */
export function repairLegacyPlan(raw, { agents = [], flows = [], binding = null } = {}) {
  if (!record(raw)) fail('repair-required', 'Legacy plan has no recoverable object.');
  if (raw.contractVersion !== undefined && raw.contractVersion !== 1) fail('unsupported-contract', 'Unknown plan contractVersion cannot be repaired automatically.');
  if (!raw.ticket && !raw.orchestration && !raw.binding && !Array.isArray(raw.agents)) return normalizePlan(raw);
  const allowed = ['ticket', 'agents', 'orchestration', 'binding'];
  if (Object.keys(raw).some(k => !allowed.includes(k))) fail('repair-required', 'Unmapped legacy plan fields need an explicit repair plan.');
  const task = raw.ticket;
  if (!record(task) || Object.keys(task).some(k => !['id', 'goal', 'inputs', 'deliverables', 'criteria', 'requirements'].includes(k))) fail('repair-required', 'Legacy task fields need explicit repair.');
  const mapping = raw.binding ?? binding;
  if (mapping && Object.keys(mapping).some(k => !['orchestrationId', 'roleAgents', 'local'].includes(k))) fail('repair-required', 'Unmapped binding resources require explicit repair.');
  const flow = raw.orchestration?.definition ?? flows.find(f => f.id === mapping?.orchestrationId)?.definition;
  const local = {}, sourceAgents = new Map(agents.map(a => [a.id, a]));
  for (const a of raw.agents ?? []) {
    if (!record(a) || Object.keys(a).some(k => !['id', 'name', 'profile', 'copyFrom'].includes(k))) fail('repair-required', 'Unmapped Agent data requires explicit repair.');
    const profile = a.profile ?? sourceAgents.get(a.copyFrom)?.profile;
    if (!profile) fail('repair-required', `Cannot resolve legacy Agent ${a.id}.`);
    sourceAgents.set(a.id, { ...a, profile }); local[a.id] = { ...(a.name !== undefined ? { name: a.name } : {}), profile: clone(profile) };
  }
  const nodes = (flow?.nodes ?? []).map(n => {
    const agentId = n.agentId ?? mapping?.roleAgents?.[n.role] ?? null;
    if (agentId && !local[agentId]) {
      const a = sourceAgents.get(agentId); if (!a) fail('repair-required', `Cannot resolve legacy Agent ${agentId}.`);
      local[agentId] = { ...(a.name !== undefined ? { name: a.name } : {}), profile: clone(a.profile) };
    }
    return { ...clone(n), agentId };
  });
  const inputs = clone(task.inputs ?? {});
  if (mapping?.local && Object.keys(mapping.local).length) {
    if (Object.hasOwn(inputs, 'local') && JSON.stringify(inputs.local) !== JSON.stringify(mapping.local)) fail('repair-required', 'Legacy local resources conflict with inputs.local.');
    inputs.local = clone(mapping.local);
  }
  return normalizePlan({ goal: task.goal, inputs, deliverables: task.deliverables ?? [], criteria: task.criteria ?? [], ...(task.requirements !== undefined ? { requirements: task.requirements } : {}), agents: local, nodes, gates: clone(flow?.gates ?? []) });
}
