import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { FleetCore, FleetCoreError, migrateState, defaultSettings, normalizeSettings, nativeProgressRow, assertStart } from './fleet-core.js';
import { projectTicket, projectTemplate, effectiveModelSelection, effectiveGateModelSelection, readableTitle, seriesRecurrence, validatePlan } from './fleet-model.js';
import { FleetStore, jsonClone, ticketFilename } from './fleet-store.js';

const clone = value => structuredClone(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const errorText = error => error instanceof Error ? error.message : String(error);
const guard = (condition, code, message) => { if (!condition) throw new FleetCoreError(code, message); };
function agentScheduleTiming({kind, time, timeZone, date, weekdays}) {
  guard(['at', 'daily', 'weekly'].includes(kind), 'invalid-input', 'Choose at, daily or weekly.');
  guard(typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time), 'invalid-input', 'Expected local time HH:mm.');
  guard(typeof timeZone === 'string' && timeZone.trim() && !/^[+-]/.test(timeZone), 'invalid-input', 'An IANA time zone is required.');
  try { new Intl.DateTimeFormat('en', {timeZone}); }
  catch { throw new FleetCoreError('invalid-input', 'Expected an IANA time zone.'); }
  const selector = {time: `${time}:00`, time_zone: timeZone};
  if (kind === 'at') {
    guard(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().startsWith(date), 'invalid-input', 'A one-off schedule requires a valid YYYY-MM-DD date.');
    selector.date = date;
  } else guard(date === undefined, 'invalid-input', 'Only a one-off schedule accepts a date.');
  if (kind === 'weekly') {
    guard(Array.isArray(weekdays) && weekdays.length && weekdays.every(day => Number.isInteger(day) && day >= 1 && day <= 7), 'invalid-input', 'Select weekly weekdays from 1 (Monday) to 7 (Sunday).');
    selector.weekdays = [...new Set(weekdays)].sort((a, b) => a - b);
  } else guard(weekdays === undefined, 'invalid-input', 'Only a weekly schedule accepts weekdays.');
  return {kind, [kind]: selector};
}
// Match scheduled receipts, never completion times. Different daily clock times can
// describe one business day; more frequent rules require the exact scheduled instant.
function occurrenceBinding(series, downstream, occurrenceAt) {
  const candidates = series.occurrences.filter(entry => entry.ticketId);
  const exact = candidates.find(entry => Date.parse(entry.occurrenceAt) === Date.parse(occurrenceAt));
  if (exact) return exact.ticketId;
  const dayRules = ['at', 'daily', 'weekly'];
  const dayKind = entry => entry.host?.timing?.kind ?? entry.timing.kind;
  if (![series, downstream].every(entry => dayRules.includes(dayKind(entry)))) return null;
  const rule = downstream.timing;
  const timeZone = downstream.host?.timing?.timeZone ?? rule[rule.kind]?.time_zone ?? 'UTC';
  const format = new Intl.DateTimeFormat('en-CA', {timeZone, year:'numeric', month:'2-digit', day:'2-digit'});
  const day = format.format(new Date(occurrenceAt));
  const matches = candidates.filter(entry => format.format(new Date(entry.occurrenceAt)) === day);
  return matches.length === 1 ? matches[0].ticketId : null;
}
const terminal = new Set(['completed', 'failed', 'stopped']);
const liveServices = new Set();
const ownerAlive = owner => {
  if (!owner) return false;
  if (owner.pid === process.pid) return liveServices.has(owner.serviceId);
  try { process.kill(owner.pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};
const outputText = output => typeof output === 'string' ? output : typeof output?.finalText === 'string' ? output.finalText : typeof output?.text === 'string' ? output.text : JSON.stringify(output);
// P-50: effective selection from a claimed node input (node override ?? agent profile ?? null).
const claimSelection = input => input?.modelSelection ?? input?.profile?.profile?.modelSelection ?? null;

/** One Root settings/Templates chain and one independent chain per Workspace.
 * Business mutations read their target's latest state under its Store lock and
 * publish that chain alone. Root settings are read as a complete committed version;
 * no transaction claims atomicity across different directories.
 * Exported so regression tests can assert the load/fromState round-trip directly. */
export class FleetPersistence {
  #templates; #workspaces = new Map(); #paths = {}; #hook; #closed = false;
  constructor(templates, hook) { this.#templates = templates; this.#hook = hook; }
  static async open({ rootPath, workspacePaths = {}, beforePublish } = {}) {
    guard(typeof rootPath === 'string' && rootPath.length, 'invalid-input', 'rootPath must be a nonempty string.');
    const templates = await FleetStore.open({ dir: rootPath, kind: 'templates', beforePublish });
    const persistence = new FleetPersistence(templates, beforePublish);
    try {
      await persistence.#migrateLegacyRoot(rootPath, workspacePaths);
      for (const [id, location] of Object.entries(workspacePaths)) await persistence.#openWorkspace(id, location);
      return persistence;
    } catch (error) { await persistence.close(); throw error; }
  }
  static #nested(a, b) {
    const relative = path.relative(a, b);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }
  async #openWorkspace(id, location) {
    const existing = this.#paths[id];
    guard(!existing || path.relative(existing, location) === '', 'invalid-input', `Workspace ${id} is already mapped to another path; reopen with an explicit relocation override.`);
    if (existing) return;
    guard(typeof location === 'string' && path.isAbsolute(location), 'invalid-input', `Workspace ${id} path must be absolute.`);
    const dir = path.join(location, '.fleet');
    guard(!FleetPersistence.#nested(this.#templates.paths.dir, dir) && !FleetPersistence.#nested(dir, this.#templates.paths.dir), 'invalid-input', `Workspace ${id} Store must not overlap the Root template Store.`);
    for (const [other, otherLocation] of Object.entries(this.#paths)) {
      const otherDir = path.join(otherLocation, '.fleet');
      guard(!FleetPersistence.#nested(otherDir, dir) && !FleetPersistence.#nested(dir, otherDir), 'invalid-input', `Workspace ${id} and ${other} Stores must not overlap.`);
    }
    const store = await FleetStore.open({ dir, kind: 'workspace', beforePublish: this.#hook });
    this.#workspaces.set(id, store);
    this.#paths[id] = location;
  }
  // One-time conversion of the pre-multichain layout (Root manifest pointer with
  // manifestHash, per-Workspace `.fleet/state/<generation>/binding.json`) into the
  // per-directory chains. Legacy drafts become draft Tickets during the move so no
  // draft can be lost when the Root pointer is republished by the templates chain.
  async #migrateLegacyRoot(rootPath, overrides) {
    const optional = file => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const bytes = await optional(path.join(rootPath, 'current.json')) ?? await optional(path.join(rootPath, 'legacy-current.json'));
    if (!bytes || !Object.hasOwn(JSON.parse(bytes), 'manifestHash')) return;
    await this.#templates.upgradeLegacyRoot(async state => {
      if (!state?.legacyManifest) return state;
      return this.#commitLegacy(state.legacyManifest, overrides);
    });
  }
  async #commitLegacy(manifest, overrides) {
    const locations = { ...(manifest.workspacePaths ?? {}), ...overrides };
    const drafts = [...(manifest.drafts ?? [])];
    const states = [];
    for (const ref of manifest.workspaces ?? []) {
      guard(/^[0-9a-f-]{36}$/i.test(ref.generation), 'invalid-state', 'Invalid legacy Workspace generation.');
      guard(typeof locations[ref.id] === 'string', 'invalid-state', 'Legacy Workspace mapping is missing.');
      await this.#openWorkspace(ref.id, locations[ref.id]);
      const base = path.join(locations[ref.id], '.fleet', 'state', ref.generation);
      const bindingBytes = await fs.readFile(path.join(base, 'binding.json'), 'utf8');
      guard(digest(bindingBytes) === ref.bindingHash, 'invalid-input', `Legacy Workspace ${ref.id} binding hash mismatch; refusing to migrate.`);
      const binding = JSON.parse(bindingBytes);
      for (const draft of binding.drafts ?? []) drafts.push(draft);
      const tickets = [];
      for (const ref2 of binding.tickets ?? []) {
        const ticketBytes = await fs.readFile(path.join(base, 'tickets', ticketFilename(ref2.id)), 'utf8');
        if (ref2.hash) guard(digest(ticketBytes) === ref2.hash, 'invalid-state', `Legacy Ticket ${ref2.id} hash mismatch.`);
        const ticket = JSON.parse(ticketBytes); guard(ticket.id === ref2.id && ticket.workspaceId === ref.id, 'invalid-state', 'Legacy Ticket identity mismatch.'); tickets.push(ticket);
      }
      states.push({ id: ref.id, binding: binding.binding ?? null, tickets });
    }
    for (const draft of drafts) {
      let workspace = states.find(w => w.id === draft.workspaceId);
      if (!workspace) { workspace = { id: draft.workspaceId, binding: null, tickets: [] }; states.push(workspace); }
      const plan = structuredClone(draft.plan ?? {});
      const migratedId = plan.ticket?.id ?? draft.ticketId ?? draft.id;
      if (workspace.tickets.some(t => t.id === migratedId)) continue;
      workspace.tickets.push({ legacySourceDraft: clone(draft), id: migratedId, workspaceId: draft.workspaceId, originSessionId: typeof draft.sessionId === 'string' ? draft.sessionId : null, goal: plan.ticket?.goal ?? '', inputs: plan.ticket?.inputs ?? {}, criteria: plan.ticket?.criteria ?? [], plan, status: 'draft', revision: Number.isSafeInteger(draft.revision) && draft.revision > 0 ? draft.revision : 1, snapshot: null, nodes: [], gates: [], changes: [], events: [{ id: randomUUID(), time: draft.updatedAt ?? draft.createdAt ?? new Date().toISOString(), type: 'ticket-created', actor: { kind: 'system' }, detail: { migratedFrom: draft.id } }] });
    }
    const templates = { schemaVersion: 1, agents: manifest.agents ?? [], flows: manifest.flows ?? [] };
    for (const state of states) {
      guard(typeof locations[state.id] === 'string', 'invalid-input', `Legacy Workspace ${state.id} has no physical mapping; pass workspacePaths explicitly to migrate.`);
      await this.#openWorkspace(state.id, locations[state.id]);
      const slice = { schemaVersion: 1, id: state.id, definitions: { agents: [], flows: [] }, binding: state.binding, tickets: state.tickets };
      // Restart after a partially completed legacy move must not overwrite a
      // Workspace that already advanced independently.
      await this.#workspaces.get(state.id).transaction(latest => latest ?? slice);
    }
    // Publish Root last, so an interrupted migration still discovers the retained
    // legacy pointer and finishes the remaining Workspace chains on reopen.
    return templates;
  }
  get paths() {
    return Object.freeze({ rootPath: this.#templates.paths.dir, currentPath: this.#templates.paths.currentPath, lockPath: this.#templates.paths.lockPath, generationsPath: this.#templates.paths.generationsPath, workspacePaths: Object.freeze({ ...this.#paths }) });
  }
  registerWorkspace(id, location) {
    if (typeof location !== 'string' || !location.length) throw new FleetCoreError('invalid-input', 'Workspace path must be a nonempty string.');
    return this.#openWorkspace(id, location);
  }
  async unregisterWorkspace(id) { const store = this.#workspaces.get(id); if (!store) return; await store.close(); this.#workspaces.delete(id); delete this.#paths[id]; }
  async load(overrides = {}, workspaceId) {
    const root = Object.hasOwn(overrides, 'root') ? overrides.root : await this.#templates.read();
    const rootState = root?.schemaVersion === 2 ? root : migrateState({ schemaVersion: 1, agents: root?.agents ?? [], flows: root?.flows ?? [], workspaces: [] });
    const workspaces = [];
    for (const [id, store] of this.#workspaces) {
      if (workspaceId !== undefined && id !== workspaceId) continue;
      const slice = overrides.id === id ? overrides.workspace : await store.read();
      if (!slice) { workspaces.push({ id, tickets: [] }); continue; }
      guard(slice.id === id, 'invalid-state', 'Workspace chain belongs to another registered Workspace.');
      if (slice.schemaVersion === 2) { const { schemaVersion, ...workspace } = slice; workspaces.push(workspace); }
      else workspaces.push(migrateState({ schemaVersion: 1, agents: root?.agents ?? rootState.templates.filter(t => t.kind === 'agent').map(t => ({ ...projectTemplate(t), id: t.legacy?.original?.id ?? t.id })), flows: root?.flows ?? rootState.templates.filter(t => t.kind === 'orchestration').map(t => ({ ...projectTemplate(t), id: t.legacy?.original?.id ?? t.id })), workspaces: [slice] }).workspaces[0]);
    }
    // Symmetric with FleetCore.fromState → exportState: settings read from an older
    // (pre-P-77) Root chain are normalized on load, so the chain-boundary guard does
    // not mistake a purely additive normalization for a cross-chain mutation.
    return { schemaVersion: 2, templates: rootState.templates, settings: normalizeSettings(rootState.settings ?? defaultSettings()), workspaces };
  }
  async transact(scope, action) {
    const store = scope === null ? this.#templates : this.#workspaces.get(scope);
    guard(store, 'unknown-workspace', 'Workspace has no physical mapping.');
    let result;
    await store.transaction(async latest => {
      const state = await this.load(scope === null ? { root: latest } : { id: scope, workspace: latest });
      const core = FleetCore.fromState(state);
      result = action(core);
      const next = core.exportState();
      // A single operation may publish only one chain. Start/repair/regenerate
      // cannot create Root definitions or mutate another Workspace.
      guard(scope === null ? same(next.workspaces, state.workspaces) : same(next.templates, state.templates) && same(next.settings, state.settings) && same(next.workspaces.filter(w => w.id !== scope), state.workspaces.filter(w => w.id !== scope)), 'invalid-transaction', 'Mutation crossed its chain boundary.');
      return scope === null ? { schemaVersion: 2, templates: next.templates, settings: next.settings } : { schemaVersion: 2, ...next.workspaces.find(w => w.id === scope) };
    });
    return { result: clone(result), state: await this.load() };
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const stores = [...this.#workspaces.values(), this.#templates];
    this.#workspaces.clear();
    for (const store of stores) await store.close();
  }
}

/** Serialized domain transactions. Only committed state may cause external execution. */
export class FleetService {
  #reconciled = new Map();
  #owner = { pid: process.pid, serviceId: randomUUID() }; #store; #adapter; #core; #queue = Promise.resolve(); #timer; #closed = false; #fault = null; #parallel; #ticking; #lastError = null;
  static async open({ rootPath, workspacePaths, adapter, maxParallel = 2, pollMs = 1000, autoStart = true, beforePublish }) {
    guard(adapter && ['create', 'submit', 'inspect', 'cancel', 'message'].every(k => typeof adapter[k] === 'function'), 'invalid-adapter', 'Execution adapter is incomplete.');
    guard(Number.isInteger(maxParallel) && maxParallel >= 1 && maxParallel <= 16, 'invalid-input', 'maxParallel must be 1..16.');
    const store = await FleetPersistence.open({ rootPath, workspacePaths, beforePublish });
    try {
      const state = await store.load();
      const service = new FleetService(store, adapter, state ? FleetCore.fromState(state) : new FleetCore(), maxParallel);
      if (autoStart) {
        service.#timer = setInterval(() => { service.tick().catch(() => {}); }, Math.max(100, pollMs));
        service.#timer.unref?.();
      }
      return service;
    } catch (error) { await store.close(); throw error; }
  }
  constructor(store, adapter, core, maxParallel) { this.#store = store; this.#adapter = adapter; this.#core = core; this.#parallel = maxParallel; liveServices.add(this.#owner.serviceId); }
  get health() { return { ready: !this.#closed && !this.#fault, error: this.#fault, lastExecutionError: this.#lastError, paths: this.#store.paths }; }
  #enqueue(fn, allowFault = false) {
    const task = this.#queue.then(async () => {
      guard(!this.#closed, 'closed', 'Fleet service is closed.');
      guard(allowFault || !this.#fault, 'persistence-fault', this.#fault ?? 'Fleet is unavailable.');
      return fn();
    });
    this.#queue = task.catch(() => {}); return task;
  }
  async #refresh() { this.#core = FleetCore.fromState(await this.#store.load()); }
  async #commit(scope, fn) {
    try {
      const { result, state } = await this.#store.transact(scope, fn);
      this.#core = FleetCore.fromState(state); return result;
    } catch (error) {
      if (!error.code || !['store-busy', 'invalid-input', 'unsupported-contract', 'legacy-plan', 'stale-revision', 'control-locked', 'ticket-referenced', 'unknown-ticket', 'unknown-series', 'scope-required', 'dependency-wait', 'unknown-workspace', 'unknown-node', 'unknown-gate', 'unknown-agent', 'unknown-flow', 'state-conflict', 'not-running', 'not-runnable', 'stale-attempt', 'stale-dispatch', 'not-reviewable', 'invalid-flow', 'incomplete-plan', 'unsupported-profile', 'completed-work-conflict', 'repair-required', 'duplicate-id', 'draft-scope', 'session-conflict', 'evidence-required', 'session-scope', 'admin-required', 'unknown-admin'].includes(error.code)) this.#fault = `Fleet persistence failed; dispatch paused: ${errorText(error)}`;
      throw error;
    }
  }
  #ticket(ws, id) { return projectTicket(this.#core.readTicket(ws, id)); }
  #worker(core, ws, ticketId, nodeId, attemptId) { return core.runtime(ws).resumeNode(ticketId, nodeId, attemptId); }
  registerWorkspace(id, absolutePath) { return this.#enqueue(async () => { const existing = this.#store.paths.workspacePaths[id]; try { await this.#store.registerWorkspace(id, absolutePath); await this.#refresh(); } catch (error) { if (!existing) await this.#store.unregisterWorkspace(id); throw error; } }); }
  unregisterWorkspace(id) { return this.#enqueue(async () => { await this.#store.unregisterWorkspace(id); await this.#refresh(); }, true); }
  async attemptProgress(ws, ticketId, nodeId, attemptId) {
    const scope = await this.#enqueue(async () => {
      await this.#refresh();
      const ticket = this.#core.readTicket(ws, ticketId);
      const nodes = ticket.execution?.nodes ?? {};
      guard(Object.hasOwn(nodes, nodeId), 'unknown-node', 'Unknown execution node.');
      const node = nodes[nodeId], attempt = node.attempts.find(row => row.id === attemptId);
      guard(attempt, 'unknown-attempt', 'Unknown node attempt.');
      if (!attempt.sessionId) return null;
      const owner = this.#core.sessionOwner(attempt.sessionId);
      guard(owner?.workspaceId === ws && owner.ticketId === ticketId && owner.nodeId === nodeId && owner.attemptId === attemptId, 'session-scope', 'Session ownership does not match the requested attempt.');
      const frozen = ticket.execution.configurations[attempt.configRevision ?? attempt.legacyConfigRevision];
      const definition = frozen?.plan?.nodes.find(n => n.id === nodeId) ?? node.legacyDefinition;
      return { sessionId: attempt.sessionId, actor: { kind: 'agent', nodeId, attemptId, agentId: definition?.agentId ?? null } };
    }, true);
    if (!scope) return [];
    const requestId = `fleet-${attemptId}`;
    const result = await this.#adapter.inspect({ sessionId: scope.sessionId, requestId, progressAnchor: requestId });
    return (result.progress ?? []).map(item => nativeProgressRow(item, scope.actor)).filter(Boolean);
  }
  ownsSession(sessionId) { return this.#enqueue(async () => { await this.#refresh(); return Boolean(this.#core.sessionOwner(sessionId)); }, true); }
  /** P-44 execution-Session evidence submission. Byte sealing happens outside the chain lock with a
   * pre-allocated artifactId/version; the transaction re-checks ownership, activity and version. */
  submitEvidence({ sessionId, payload }) {
    let data;
    try { data = jsonClone(payload ?? {}); } catch (error) { return Promise.reject(new FleetCoreError('invalid-input', error.message)); }
    return this.#enqueue(async () => {
      await this.#refresh();
      const owner = this.#core.sessionOwner(sessionId);
      guard(owner?.nodeId && owner?.attemptId, 'session-scope', 'fleet_submit is only available inside an execution Node Session.');
      const ws = owner.workspaceId;
      guard(Object.hasOwn(this.#store.paths.workspacePaths, ws), 'unknown-workspace', 'Workspace has no physical mapping.');
      const workspaceDir = this.#store.paths.workspacePaths[ws];
      const ticket = this.#core.readTicket(ws, owner.ticketId), node = ticket.execution.nodes[owner.nodeId], attempt = node?.attempts.find(a => a.id === owner.attemptId);
      guard(attempt && attempt.status === 'running' && node.attempts.at(-1).id === attempt.id, 'stale-attempt', 'Attempt is no longer active.');
      const frozen = ticket.execution.configurations[attempt.configRevision];
      guard(frozen?.plan, 'stale-attempt', 'Attempt configuration is unavailable.');
      const declared = frozen.plan.deliverables ?? [];
      guard(data && typeof data === 'object' && !Array.isArray(data), 'invalid-input', 'Expected an evidence payload.');
      guard(Object.keys(data).every(k => ['artifacts', 'acceptanceResults', 'verification', 'summary', 'handoff'].includes(k)), 'invalid-input', 'Unexpected evidence field.');
      const arts = data.artifacts ?? []; guard(Array.isArray(arts), 'invalid-input', 'evidence.artifacts must be an array.');
      const existing = ticket.execution.artifacts ?? {}, sealed = [];
      for (const item of arts) {
        guard(item && typeof item === 'object' && !Array.isArray(item), 'invalid-input', 'artifact must be an object.');
        guard(Object.keys(item).every(k => ['path', 'deliverableIndex', 'mediaType'].includes(k)), 'invalid-input', 'Unexpected artifact field.');
        guard(typeof item.path === 'string' && item.path.trim(), 'invalid-input', 'artifact.path must be a Workspace-relative path.');
        let deliverableIndex;
        if (item.deliverableIndex !== undefined) { guard(Number.isSafeInteger(item.deliverableIndex) && item.deliverableIndex >= 0 && item.deliverableIndex < declared.length, 'invalid-input', 'artifact.deliverableIndex is out of range.'); deliverableIndex = item.deliverableIndex; }
        const matches = a => a.nodeId === owner.nodeId && (deliverableIndex !== undefined ? a.deliverableIndex === deliverableIndex : a.deliverableIndex === null && a.sourcePath === item.path);
        let artifactId = Object.keys(existing).find(id => matches(existing[id])), version = 1;
        if (artifactId) version = (existing[artifactId].versions.at(-1)?.version ?? 0) + 1;
        else { do { artifactId = `a-${randomUUID().slice(0, 8)}`; } while (existing[artifactId]); }
        const seal = await FleetStore.sealArtifact({ workspaceDir, ticketId: owner.ticketId, artifactId, version, sourceAbsPath: path.join(workspaceDir, item.path) });
        sealed.push({ sourcePath: item.path, ...(deliverableIndex !== undefined ? { deliverableIndex } : {}), ...(item.mediaType !== undefined ? { mediaType: item.mediaType } : {}), sha256: seal.sha256, size: seal.size, snapshotPath: seal.snapshotPath, artifactId, version });
      }
      const latestArtifacts = new Map(Object.entries(existing).filter(([, a]) => a.nodeId === owner.nodeId).map(([artifactId, a]) => { const v = a.versions.at(-1); return [artifactId, { artifactId, version: v?.version, sha256: v?.sha256, snapshotPath: v?.snapshotPath, sourcePath: a.sourcePath, deliverableIndex: a.deliverableIndex ?? null }]; }));
      for (const s of sealed) latestArtifacts.set(s.artifactId, { artifactId: s.artifactId, version: s.version, sha256: s.sha256, snapshotPath: s.snapshotPath, sourcePath: s.sourcePath, deliverableIndex: s.deliverableIndex ?? null });
      // Default handle file: always written on submit so downstream Agents and the user can read the latest handoff from disk.
      await FleetStore.writeHandleFile({ workspaceDir, ticketId: owner.ticketId, nodeId: owner.nodeId, handle: { schema: 1, ticketId: owner.ticketId, nodeId: owner.nodeId, attemptId: owner.attemptId, updatedAt: new Date().toISOString(), summary: data.summary ?? null, handoff: data.handoff ?? null, artifacts: [...latestArtifacts.values()] } });
      const sealedPayload = { artifacts: sealed, ...(data.acceptanceResults !== undefined ? { acceptanceResults: data.acceptanceResults } : {}), ...(data.verification !== undefined ? { verification: data.verification } : {}), ...(data.summary !== undefined ? { summary: data.summary } : {}), ...(data.handoff !== undefined ? { handoff: data.handoff } : {}) };
      return this.#commit(ws, core => {
        const current = core.sessionOwner(sessionId);
        guard(current?.nodeId && current?.attemptId, 'session-scope', 'fleet_submit is only available inside an execution Node Session.');
        return core.runtime(ws).resumeNode(owner.ticketId, current.nodeId, current.attemptId).submitEvidence(sealedPayload);
      });
    });
  }
  scheduleStatus() { return this.#adapter.scheduleStatus?.() ?? (this.#adapter.scheduleCreate ? {available:true} : {available:false,unavailableReason:'Host schedule service is unavailable; scheduling cannot be enabled.'}); }
  readOverviewProject(ws) { return this.#enqueue(async () => {
    const core = FleetCore.fromState(await this.#store.load({}, ws));
    return { tickets: core.listTickets(ws), series: core.listSeries(ws) };
  }, true); }
  readSeries(ws) { return this.#enqueue(async () => { await this.#refresh(); return this.#core.listSeries(ws); }, true); }
  async #schedule(method, input) {
    guard(typeof this.#adapter[method] === 'function','unsupported-profile','Host schedule service is unavailable; scheduling cannot be enabled.');
    try { return await this.#adapter[method](input); } catch (e) { if (['unsupported-profile','invalid-input'].includes(e.code)) throw new FleetCoreError(e.code,e.message); throw e; }
  }
  async agentSchedule(ws, sessionId, args) {
    guard(typeof sessionId === 'string' && sessionId.length, 'session-scope', 'Scheduling requires a planning Session.');
    const {ticketId, expectedRevision, name} = args;
    guard(typeof ticketId === 'string' && ticketId.trim(), 'invalid-input', 'A source Ticket ID is required.');
    guard(Number.isSafeInteger(expectedRevision) && expectedRevision > 0, 'invalid-input', 'Read the Ticket and supply its positive revision.');
    guard(typeof name === 'string' && name.trim() && name.trim().length <= 120, 'invalid-input', 'Use a schedule name of 1 to 120 characters.');
    const timing = agentScheduleTiming(args);
    const actor = {kind: 'agent', userId: sessionId, via: 'user-request'};
    const series = await this.seriesCreate(ws, {name: name.trim(), timing, sourceTicketId: ticketId, actor}, {sessionId, expectedRevision});
    return {seriesId: series.id, scheduleId: series.scheduleId, sourceTicketId: series.sourceTicketId, revision: series.revision, status: series.status, timing: series.timing, scheduledAt: series.host?.scheduledAt ?? null};
  }
  async seriesCreate(ws, input, agentRequest) {
    const {name,timing,sourceTicketId,templateId,templateRevision,overrides,assignments,actor} = jsonClone(input);
    const checkAgentSource = (core, source) => {
      if (!agentRequest) return;
      const {sessionId, expectedRevision} = agentRequest;
      guard(!core.sessionOwner(sessionId) && source.originSessionId === sessionId, 'session-scope', 'Only the planning conversation that owns this Ticket can schedule it.');
      const receipt = source.activity.find(event => event.type === 'series-created' && event.detail.sourceRevision === expectedRevision && event.actor.userId === sessionId);
      if (receipt) {
        const series = core.readSeries(ws, receipt.detail.seriesId);
        if (series.name === name && same(series.timing, timing)) return series;
      }
      guard(source.revision === expectedRevision, 'stale-revision', 'Source Ticket revision changed. Read the Ticket again.');
      guard(['draft', 'stopped'].includes(source.status), 'state-conflict', 'Schedule a draft or stopped Ticket.');
    };
    return this.#enqueue(async () => {
      await this.#refresh();
      guard(Object.hasOwn(this.#store.paths.workspacePaths,ws),'unknown-workspace','Workspace has no physical mapping.');
      guard(typeof name === 'string' && name.trim() && timing?.kind,'invalid-input','Series needs a name and timing.');
      guard(Boolean(sourceTicketId) !== Boolean(templateId),'invalid-input','Choose a source Ticket or an orchestration template.');
      const instantiate = {id:randomUUID(),templateId,templateRevision,overrides,assignments,sessionId:null,actor};
      const source = sourceTicketId ? this.#core.readTicket(ws,sourceTicketId) : FleetCore.fromState(this.#core.exportState()).instantiateTemplate(ws,instantiate);
      const prior = checkAgentSource(this.#core, source);
      if (prior) return prior;
      guard(!source.abandonedAt,'state-conflict','Restore the abandoned Ticket before creating a schedule.');
      assertStart(source.plan); await this.#checkStartSelections(ws,source.plan);
      const entry = await this.#schedule('scheduleCreate',{title:name.trim().slice(0,120),prompt:`这是 Fleet 系列计划「${name}」的到点通知。Fleet 运行时会自动创建并启动当期 Ticket；你只需向用户简要确认本期已排入执行，不要自行执行任务内容。`,timing,target:{kind:'new_once',create:{cwd:this.#store.paths.workspacePaths[ws]}}});
      try {
        const series = await this.#commit(ws,c => {
          const current = sourceTicketId ? c.readTicket(ws,source.id) : c.instantiateTemplate(ws,instantiate);
          const concurrent = checkAgentSource(c, current);
          if (concurrent) return concurrent;
          guard(!current.abandonedAt && current.revision === source.revision && same(current.plan,source.plan) && same(current.activity.map(a => a.detail),source.activity.map(a => a.detail)),'stale-revision','Series source changed while enabling its schedule.');
          return c.createSeries(ws,{name,timing,plan:source.plan,sourceTicketId:source.id,sourceTemplateId:templateId,scheduleId:entry.id,targetSessionId:entry.target?.sessionId,host:this.#hostEcho(entry),requestActor:agentRequest && actor});
        });
        if (series.scheduleId !== entry.id) await this.#schedule('scheduleEdit', {id: entry.id, action: 'delete'});
        return series;
      } catch (error) { if (entry?.id) await this.#schedule('scheduleEdit',{id:entry.id,action:'delete'}).catch(() => {}); throw error; }
    });
  }
  followSeries(ws, {sourceTicketId, triggerSeriesId, name, expectedRevision}, userId) {
    return this.#enqueue(async () => {
      await this.#refresh();
      const source = this.#core.readTicket(ws, sourceTicketId);
      const prior = source.activity.find(e => e.type === 'series-created' && e.detail.sourceRevision === expectedRevision && e.actor?.userId === userId);
      if (prior) {
        const saved = this.#core.readSeries(ws, prior.detail.seriesId);
        if (saved.triggerSeriesId === triggerSeriesId && saved.name === name) return saved;
      }
      guard(typeof name === 'string' && name.trim(), 'invalid-input', 'Name the dependent series.');
      guard(['draft','stopped'].includes(source.status) && !source.abandonedAt, 'state-conflict', 'Choose an editable source Ticket.');
      assertStart(source.plan);
      await this.#checkStartSelections(ws, source.plan);
      return this.#commit(ws, c => {
        const current = c.readTicket(ws, sourceTicketId);
        guard(current.revision === expectedRevision && current.revision === source.revision, 'stale-revision', 'Source Ticket changed while enabling its dependency rule.');
        const trigger = c.readSeries(ws, triggerSeriesId);
        guard(['active','paused'].includes(trigger.status), 'state-conflict', 'Choose an active or paused upstream series.');
        return c.createSeries(ws, {name, sourceTicketId, triggerSeriesId, plan:current.plan, timing:trigger.timing, scheduleId:trigger.scheduleId, targetSessionId:trigger.targetSessionId, requestActor:{kind:'human',userId}});
      });
    });
  }
  #hostEcho(entry) {
    const host = {};
    for (const k of ['status','scheduledAt','title']) if (typeof entry[k] === 'string') host[k] = entry[k];
    if (entry.lastDelivery?.deliveredAt) host.lastDeliveryAt = entry.lastDelivery.deliveredAt;
    if (entry.kind) host.timing = Object.fromEntries(['kind','time','timeZone','weekdays','expression','rrule','afterSeconds','everySeconds'].filter(k => entry[k] !== undefined).map(k => [k,entry[k]]));
    return host;
  }
  #editSeries(ws,id,status) {
    return this.#enqueue(async () => {
      await this.#refresh(); const s = this.#core.readSeries(ws,id);
      if (s.triggerSeriesId) return this.#commit(ws, core => {
        const current = core.readSeries(ws,id);
        guard(current.revision === s.revision && ['active','paused'].includes(current.status), 'state-conflict', 'Dependent series has changed or ended.');
        return core.setSeriesStatus(ws,id,status);
      });
      const deleting = status === 'ended';
      const entry = await this.#schedule('scheduleEdit',{id:s.scheduleId,...(deleting ? {action:'delete'} : {action:'update',patch:{active:status === 'active'}})});
      if (entry.code === 'schedule_not_found' && !deleting) { await this.#commit(ws,c => c.setSeriesStatus(ws,id,'orphaned')); throw new FleetCoreError('unknown-series','Host schedule no longer exists.'); }
      guard(entry.code !== 'schedule_conflict','stale-revision','Host schedule changed.');
      return this.#commit(ws,c => { if (!deleting) c.setSeriesHost(ws,id,this.#hostEcho(entry)); return c.setSeriesStatus(ws,id,status); });
    });
  }
  seriesPause(ws,id) { return this.#editSeries(ws,id,'paused'); }
  seriesResume(ws,id) { return this.#editSeries(ws,id,'active'); }
  seriesDelete(ws,id) { return this.#editSeries(ws,id,'ended'); }
  async seriesUpdate(ws,id,input) { const data = jsonClone(input); return this.#enqueue(() => this.#commit(ws,c => c.updateSeriesPlan(ws,id,data))); }
  saveDraftTicket(workspaceId,input) { return this.saveDraftWithScope(workspaceId,input); }
  saveDraftWithScope(workspaceId, input) {
    // Validate lossless JSON before entering persistence: bad caller data must not
    // fault the shared writer, and caller mutations must not race the queue.
    let data;
    try { data = jsonClone(input); } catch (error) { return Promise.reject(new FleetCoreError('invalid-input', error.message)); }
    return this.#enqueue(() => {
      guard(Object.hasOwn(this.#store.paths.workspacePaths, workspaceId), 'unknown-workspace', 'Workspace has no physical mapping.');
      guard(data && typeof data === 'object' && !Array.isArray(data), 'invalid-input', 'Expected draft input.');
      return this.#commit(workspaceId, core => {
        const {scope,seriesId,expectedSeriesRevision,...draft} = data;
        guard(scope === undefined || ['series','ticket'].includes(scope),'invalid-input','Unknown save scope.');
        const members = draft.ticketId ? core.listSeries(workspaceId).filter(s => s.sourceTicketId === draft.ticketId || s.occurrences.some(o => o.ticketId === draft.ticketId)) : [];
        guard(scope || !members.some(s => ['active','paused'].includes(s.status) && seriesRecurrence(s) === 'recurring'),'scope-required','Ask the user whether to apply this edit to this Ticket or the entire series, then save with that scope.');
        if (scope !== 'series') return core.saveDraftTicket(workspaceId,draft);
        guard(seriesId || members.length <= 1,'invalid-input','Select the series for this Ticket.');
        const series = seriesId ? members.find(s => s.id === seriesId) : members[0];
        guard(series,'unknown-series','Ticket does not belong to this series.');
        const before = core.readTicket(workspaceId,draft.ticketId).plan;
        const ticket = core.saveDraftTicket(workspaceId,draft);
        return {ticket,series:core.applySeriesChanges(workspaceId,series.id,{before,after:ticket.plan,expectedRevision:expectedSeriesRevision ?? series.revision}),seriesUpdated:true};
      });
    });
  }
  listDraftTickets(workspaceId, sessionId) { return this.#enqueue(async () => { await this.#refresh(); return this.#core.listDraftTickets(workspaceId, sessionId); }, true); }
  read(workspaceId, ticketId) { return this.#enqueue(async () => { await this.#refresh(); return ticketId ? this.#core.readTicket(workspaceId, ticketId) : this.#core.listTickets(workspaceId); }, true); }
  dashboardTickets(ws) { return this.#enqueue(async () => {
    await this.#refresh();
    const runtime = this.#core.runtime(ws);
    return this.#core.listTickets(ws).map(raw => {
      const ticket = projectTicket(raw);
      const configured = scope => scope?.ticketDependencies?.length || scope?.ticketDependencySeries?.length;
      const nodes = Array.isArray(ticket.plan?.nodes) ? ticket.plan.nodes.filter(configured) : [];
      const whole = configured(ticket.plan);
      if ((whole || nodes.length) && validatePlan(ticket.plan, {mode:'save'}).valid) {
        if (whole) ticket.dependencyReadiness = runtime.dependencyReadiness(ticket.id);
        if (nodes.length) ticket.nodeDependencyReadiness = Object.fromEntries(nodes.map(n => [n.id, runtime.dependencyReadiness(ticket.id, n.id)]));
      }
      return ticket;
    });
  }, true); }
  list(workspaceId) { return this.read(workspaceId); }
  readDraft(workspaceId, ticketId) { return this.read(workspaceId, ticketId); }
  saveDraft(workspaceId, input) { return this.saveDraftTicket(workspaceId, input); }
  catalog() { return this.#enqueue(async () => {
    await this.#refresh(); const state = this.#core.exportState();
    return { templates: state.templates, settings: state.settings, agents: state.templates.filter(t => t.kind === 'agent').map(projectTemplate), orchestrations: state.templates.filter(t => t.kind === 'orchestration').map(projectTemplate), workspaces: state.workspaces.map(w => ({ id: w.id, tickets: w.tickets.map(t => ({ id: t.id, goal: t.plan?.goal ?? t.plan?.ticket?.goal ?? '', status: t.status })) })) };
  }, true); }
  /** P-50 read-only host model catalog; never initializes Stores or dispatches. */
  modelCatalog() { return this.#enqueue(() => this.#adapter.modelCatalog(), true); }
  /** Caller identity must be obtained from the authenticated user path, not tool arguments. */
  human(workspaceId, userId, action, args = []) {
    const allowed = new Set(['start', 'stop', 'resume', 'retryNode', 'enableDependencies', 'disableDependencies', 'commentNode', 'changeNode', 'setPendingNodeModel', 'forcePassGate', 'reviewGate', 'deliverOverride', 'deleteDraftTicket', 'abandonTicket', 'unabandonTicket', 'replaceRootAgent', 'replaceRootOrchestration', 'replaceGlobalSettings', 'saveTemplate', 'saveTemplateFromTicket', 'instantiateTemplate', 'repairTicket', 'regenerateTicket', 'grantAdmin', 'revokeAdmin']);
    try { args = jsonClone(args); } catch (e) { return Promise.reject(new FleetCoreError('invalid-input', e.message)); }
    return this.#enqueue(async () => {
      guard(allowed.has(action), 'unknown-action', 'Unknown human Fleet action.');
      // P-50: start/resume validate every effective model selection against the live host catalog
      // before freezing; the catalog is read-only and fetched outside the commit transaction.
      if (['start', 'resume', 'retryNode', 'enableDependencies'].includes(action)) await this.#checkStartSelections(workspaceId, args[0]);
      if (action === 'setPendingNodeModel') {
        await this.#refresh();
        const plan = this.#core.readTicket(workspaceId, args[0]).plan;
        const node = plan?.nodes?.find(node => node.id === args[1]);
        const selection = args[2] ?? plan?.agents?.[node?.agentId]?.profile?.modelSelection;
        if (selection) {
          let catalog;
          try { catalog = await this.#adapter.modelCatalog(); }
          catch (error) { throw new FleetCoreError('unsupported-profile', `Model catalog unavailable: ${errorText(error)}`); }
          this.#assertSelectionsAvailable([selection], catalog);
        }
      }
      // P-72／P-73: template saves publish only Root (Agent templates first, orchestration last, one
      // transaction). The source Ticket is not in that write set; afterwards a separate Workspace
      // commit appends one templates-saved activity without changing plan, revision or sourceRefs.
      if (action === 'saveTemplateFromTicket' || (action === 'saveTemplate' && args[0]?.source?.ticketId !== undefined)) {
        const result = await this.#commit(null, core => core.human(workspaceId, userId)[action](...args));
        const fromTicket = action === 'saveTemplateFromTicket';
        const ticketId = fromTicket ? args[0].ticketId : args[0].source.ticketId;
        const ticketRevision = fromTicket ? result.ticketRevision : args[0].source.ticketRevision;
        const templates = fromTicket
          ? [{ kind: 'orchestration', id: result.template.id, revision: result.template.revision }, ...result.agentTemplates.map(t => ({ kind: 'agent', id: t.id, revision: t.revision }))]
          : [{ kind: args[0].kind, id: result.id, revision: result.revision }];
        try {
          await this.#commit(workspaceId, core => core.recordTemplatesSaved(workspaceId, ticketId, { ticketRevision, templates }, { kind: 'human', userId }));
        } catch (error) {
          throw new FleetCoreError(error.code ?? 'state-conflict', `Templates were saved to Root, but the Ticket activity could not be recorded: ${error.message}`);
        }
        return result;
      }
      return this.#commit(['replaceRootAgent', 'replaceRootOrchestration', 'replaceGlobalSettings', 'saveTemplate', 'saveTemplateFromTicket', 'grantAdmin', 'revokeAdmin'].includes(action) ? null : workspaceId, core => core.human(workspaceId, userId)[action](...args));
    });
  }
  /** P-51: the Agent executes a start/resume decision the user explicitly requested in this conversation. */
  agentStart(workspaceId, sessionId, ticketId) {
    return this.#enqueue(async () => {
      await this.#refresh();
      const ticket = this.#core.readTicket(workspaceId, ticketId);
      guard(ticket?.originSessionId === sessionId, 'session-scope', 'fleet_start can only execute the start decision of this conversation’s own Ticket.');
      guard(['draft', 'stopped'].includes(ticket.status), 'state-conflict', `fleet_start supports draft or stopped Tickets only; this Ticket is ${ticket.status}.`);
      await this.#checkStartSelections(workspaceId, ticketId);
      const resume = ticket.status === 'stopped';
      return this.#commit(workspaceId, core => resume ? core.agent(workspaceId, sessionId).resume(ticketId) : core.agent(workspaceId, sessionId).start(ticketId));
    });
  }
  /** P-77: grantable Admin surface — the caller Workspace must be granted and the target in scope. */
  #requireAdmin(callerWs, targetWs) {
    guard(this.#core.adminGranted(callerWs), 'admin-required', 'This Workspace is not an Admin.');
    if (targetWs !== undefined) guard(this.#core.adminCan(callerWs, targetWs), 'admin-required', 'The target Workspace is outside this Admin scope.');
  }
  adminStatus(workspaceId) {
    return this.#enqueue(async () => {
      await this.#refresh();
      return { workspaceId, granted: this.#core.adminGranted(workspaceId), admin: this.#core.adminConfig() };
    }, true);
  }
  adminTickets(callerWs) {
    return this.#enqueue(async () => {
      await this.#refresh();
      this.#requireAdmin(callerWs);
      return this.#core.listWorkspaces().filter(id => this.#core.adminCan(callerWs, id)).map(id => ({ workspaceId: id, tickets: this.#core.listTickets(id).map(t => projectTicket(t)) }));
    }, true);
  }
  adminTicket(callerWs, targetWs, ticketId) {
    return this.#enqueue(async () => {
      await this.#refresh();
      this.#requireAdmin(callerWs, targetWs);
      const ticket = this.#core.readTicket(targetWs, ticketId);
      guard(ticket, 'unknown-ticket', 'No Ticket with this ID belongs to the target Workspace.');
      return projectTicket(ticket);
    }, true);
  }
  adminTemplates(callerWs) {
    return this.#enqueue(async () => {
      await this.#refresh();
      this.#requireAdmin(callerWs);
      return this.#core.listTemplates();
    }, true);
  }
  adminSaveTemplate(callerWs, sessionId, input) {
    return this.#enqueue(async () => {
      await this.#refresh();
      this.#requireAdmin(callerWs);
      const entry = this.#core.adminConfig().workspaces.find(e => e.workspaceId === callerWs);
      return this.#commit(null, core => core.adminAgent(callerWs, sessionId, entry.scope).saveTemplate(input));
    });
  }
  adminSavePlan(callerWs, sessionId, targetWs, input) {
    return this.#enqueue(async () => {
      await this.#refresh();
      this.#requireAdmin(callerWs, targetWs);
      return this.#commit(targetWs, core => core.adminAgent(targetWs, sessionId, targetWs).savePlan(input.ticketId, { expectedRevision: input.expectedRevision, plan: input.plan, sessionId: input.sessionId }));
    });
  }
  adminStart(callerWs, sessionId, targetWs, ticketId) {
    return this.#enqueue(async () => {
      await this.#refresh();
      this.#requireAdmin(callerWs, targetWs);
      await this.#checkStartSelections(targetWs, ticketId);
      return this.#commit(targetWs, core => core.agent(targetWs, sessionId).start(ticketId));
    });
  }
  adminStop(callerWs, sessionId, targetWs, ticketId) {
    return this.#enqueue(async () => {
      await this.#refresh();
      this.#requireAdmin(callerWs, targetWs);
      return this.#commit(targetWs, core => core.agent(targetWs, sessionId).stop(ticketId));
    });
  }
  /** P-78: Admin-granted cross-Workspace node retry, audited with the caller's adminScope. */
  adminRetryNode(callerWs, sessionId, targetWs, ticketId, nodeId, reason) {
    return this.#enqueue(async () => {
      await this.#refresh();
      this.#requireAdmin(callerWs, targetWs);
      await this.#checkStartSelections(targetWs, ticketId);
      const entry = this.#core.adminConfig().workspaces.find(e => e.workspaceId === callerWs);
      return this.#commit(targetWs, core => core.adminAgent(targetWs, sessionId, entry.scope).retryNode(ticketId, nodeId, reason));
    });
  }
  adminGrant(workspaceId, userId, scope) {
    return this.#enqueue(async () => {
      await this.#refresh();
      return this.#commit(null, core => core.human(workspaceId, userId).grantAdmin(scope));
    });
  }
  adminRevoke(workspaceId, userId) {
    return this.#enqueue(async () => {
      await this.#refresh();
      return this.#commit(null, core => core.human(workspaceId, userId).revokeAdmin());
    });
  }
  agentStop(workspaceId, sessionId, ticketId) {
    return this.#enqueue(async () => {
      await this.#refresh();
      const ticket = this.#core.readTicket(workspaceId, ticketId);
      guard(ticket, 'unknown-ticket', 'No Ticket with this ID belongs to this Workspace.');
      return this.#commit(workspaceId, core => core.agent(workspaceId, sessionId).stop(ticketId));
    });
  }
  /** P-78: the Agent retries one node of any Ticket in this Workspace on the user's explicit request,
   * through the same validation and retry closure as the human retryNode action. */
  agentRetryNode(workspaceId, sessionId, ticketId, nodeId, reason) {
    return this.#enqueue(async () => {
      await this.#refresh();
      const ticket = this.#core.readTicket(workspaceId, ticketId);
      guard(ticket, 'unknown-ticket', 'No Ticket with this ID belongs to this Workspace.');
      await this.#checkStartSelections(workspaceId, ticketId);
      return this.#commit(workspaceId, core => core.agent(workspaceId, sessionId).retryNode(ticketId, nodeId, reason));
    });
  }
  async #checkStartSelections(workspaceId, input, retryRead = false) {
    let plan = input;
    if (typeof input === 'string') { await this.#refresh(); plan = this.#core.readTicket(workspaceId, input).plan; }
    const selections = (plan?.nodes ?? []).map(node => effectiveModelSelection(node, plan?.agents?.[node.agentId]).selection).filter(Boolean);
    for (const gate of plan?.gates ?? []) if (gate.reviewer?.kind === 'agent' && gate.modelSelection) selections.push(gate.modelSelection);
    if (!selections.length) return;
    let catalog;
    try { catalog = await this.#adapter.modelCatalog(); }
    catch (error) { if (retryRead) throw new Error(`Model catalog read failed: ${errorText(error)}`); throw new FleetCoreError('unsupported-profile', `Model catalog unavailable; cannot validate modelSelection: ${errorText(error)}`); }
    if (retryRead && catalog?.failures?.some(f => selections.some(s => s.provider === f.id) || f.id === 'host')) throw new Error('Model provider catalog is temporarily unavailable.');
    this.#assertSelectionsAvailable(selections, catalog);
  }
  #assertSelectionsAvailable(selections, catalog) {
    const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
    for (const selection of selections) {
      const model = groups.find(g => g.id === selection.provider)?.models?.find(m => m.id === selection.model);
      if (!model) throw new FleetCoreError('unsupported-profile', `modelSelection ${selection.provider}/${selection.model} is not in the host model catalog; choose an available model or clear the override.`);
      if (selection.reasoningEffort !== undefined) {
        const efforts = model.reasoning?.efforts ?? [];
        if (!efforts.some(e => e.id === selection.reasoningEffort)) throw new FleetCoreError('unsupported-profile', `reasoningEffort "${selection.reasoningEffort}" is not available for ${selection.provider}/${selection.model}; choose one of: ${efforts.map(e => e.id).join(', ') || '(none)'}.`);
      }
    }
  }
  async tick() {
    if (this.#ticking) return this.#ticking;
    this.#ticking = this.#enqueue(async () => {
      await this.#refresh();
      for (const ws of this.#core.listWorkspaces()) {
        for (const original of this.#core.listTickets(ws).map(t => projectTicket(t))) {
          if (!['running', 'stop-requested'].includes(original.status) && !original.gates.some(g => g.dispatch?.sessionId && !['finished', 'failed', 'stopped'].includes(g.dispatch.phase))) continue;
          try { await this.#advanceTicket(ws, original.id); }
          catch (error) { if (!['not-runnable', 'stale-attempt', 'stale-dispatch', 'not-running', 'not-reviewable', 'state-conflict'].includes(error.code)) throw error; await this.#refresh(); }
        }
      }
      for (const ws of this.#core.listWorkspaces()) for (const s of this.#core.listSeries(ws)) {
        if (!['active','paused'].includes(s.status)) continue;
        try {
          if (s.triggerSeriesId) await this.#followOccurrences(ws,s);
          else await this.#pollSeries(ws,s);
        }
        catch (error) { this.#lastError = {at:new Date().toISOString(),seriesId:s.id,message:errorText(error)}; }
      }
      for (const ws of this.#core.listWorkspaces()) await this.#advanceDependencies(ws);
      return this.health;
    }).catch(error => { this.#lastError = { at: new Date().toISOString(), message: errorText(error) }; throw error; }).finally(() => { this.#ticking = undefined; });
    return this.#ticking;
  }
  async #followOccurrences(ws, series) {
    if (series.status !== 'active') return;
    const trigger = this.#core.readSeries(ws, series.triggerSeriesId);
    const seen = new Set(series.occurrences.map(o => Date.parse(o.occurrenceAt)));
    for (const upstream of trigger.occurrences.slice(series.triggerAfterCount)) {
      if (!upstream.ticketId || seen.has(Date.parse(upstream.occurrenceAt))) continue;
      const occurrenceAt = upstream.occurrenceAt;
      const commit = change => this.#commit(ws, c => {
        const current = c.readSeries(ws,series.id);
        guard(current.status === 'active' && current.revision === series.revision, 'stale-revision', 'Dependent series changed.');
        return change(c);
      });
      try { assertStart(series.plan); await this.#checkStartSelections(ws,series.plan,true); }
      catch (error) {
        if (!(error instanceof FleetCoreError)) throw error;
        await commit(c => c.recordOccurrenceFailure(ws,series.id,{occurrenceAt,error:error.message}));
        return;
      }
      await commit(c => {
        const occurrence = c.recordOccurrenceAndStart(ws,series.id,{occurrenceAt});
        if (!occurrence.duplicate) c.runtime(ws).bindOccurrence(occurrence.ticketId,{[trigger.id]:upstream.ticketId});
      });
    }
    if (['ended','orphaned'].includes(trigger.status)) {
      await this.#commit(ws, c => {
        const current = c.readSeries(ws,series.id);
        if (current.revision === series.revision && current.status === 'active') c.setSeriesStatus(ws,series.id,trigger.status);
      });
    }
  }
  async #advanceDependencies(ws) {
    const waiting = this.#core.listTickets(ws).filter(t => !t.abandonedAt && (t.status === 'draft' ? t.dependencyAuthorization : t.status === 'running' && t.plan.nodes?.some(n => n.ticketDependencySeries?.length)));
    if (!waiting.length) return;
    const series = this.#core.listSeries(ws);
    const byId = new Map(series.map(s => [s.id, s]));
    const waitingIds = new Set(waiting.map(t => t.id));
    const occurrences = new Map();
    for (const item of series) for (const receipt of item.occurrences) {
      if (waitingIds.has(receipt.ticketId)) occurrences.set(receipt.ticketId, {series:item, at:receipt.occurrenceAt});
    }
    for (const ticket of waiting) {
      const occurrence = occurrences.get(ticket.id);
      try {
        if (occurrence && (ticket.status === 'running' || ticket.dependencyAuthorization)) {
          const refs = new Set([ticket.plan, ...ticket.plan.nodes].flatMap(scope => scope.ticketDependencySeries ?? []));
          const bindings = [];
          for (const ref of refs) {
            if (Object.hasOwn(ticket.dependencyBindings ?? {}, ref)) continue;
            const upstream = byId.get(ref);
            const concrete = upstream && occurrenceBinding(upstream, occurrence.series, occurrence.at);
            if (concrete) bindings.push([ref, concrete]);
          }
          if (bindings.length) {
            if (ticket.status === 'draft') await this.#checkStartSelections(ws, ticket.plan, true);
            await this.#commit(ws, c => {
              guard(c.readTicket(ws,ticket.id).revision === ticket.revision, 'stale-revision', 'Occurrence changed while resolving its dependencies.');
              return c.runtime(ws).bindOccurrence(ticket.id, Object.fromEntries(bindings));
            });
          }
        }
        if (ticket.status === 'draft' && ticket.dependencyAuthorization && this.#core.runtime(ws).dependencyStartReady(ticket.id)) {
          const current = this.#core.readTicket(ws, ticket.id);
          await this.#checkStartSelections(ws, current.plan, true);
          await this.#commit(ws, c => c.runtime(ws).startWhenReady(ticket.id, current.revision));
        }
      } catch (error) {
        if (this.#fault) throw error;
        this.#lastError = {at:new Date().toISOString(), ticketId:ticket.id, message:errorText(error)};
      }
    }
  }
  async #pollSeries(ws, series) {
    const {id,scheduleId} = series;
    const entry = await this.#schedule('scheduleView',{id:scheduleId});
    const commit = fn => this.#commit(ws,c => {
      const current = c.readSeries(ws,id);
      guard(current.revision === series.revision && ['active','paused'].includes(current.status),'stale-revision','Series changed during host observation.');
      return fn(c);
    });
    if (entry.code === 'schedule_not_found') { await commit(c => c.setSeriesStatus(ws,id,'orphaned')); return; }
    guard(['active','paused','ended'].includes(entry.status),'invalid-input','Unexpected host schedule status.');
    const host = this.#hostEcho(entry), seen = new Set(series.occurrences.map(o => o.occurrenceAt));
    // A failed receipt is durable before the external pause. Retry an interrupted pause
    // until a host response confirms it, including after a Fleet restart.
    if (series.status === 'paused' && series.host?.status === 'active' && entry.status === 'active' && series.occurrences.at(-1)?.status === 'failed') {
      await this.#pauseFailedSeries(ws,series,entry); return;
    }
    const last = entry.lastDelivery?.scheduledAt, pending = new Set();
    const receipt = JSON.stringify([last ?? null, host.lastDeliveryAt ?? null]);
    if (last && !seen.has(last) && entry.status !== 'paused') pending.add(last);
    if (entry.status !== 'paused' && this.#adapter.scheduleHistory && (this.#reconciled.get(id) !== receipt || pending.size)) {
        let before; const cursors = new Set();
        do {
          const page = await this.#schedule('scheduleHistory',{id:scheduleId,limit:100,...(before ? {before} : {})});
          guard(Array.isArray(page.records),'invalid-input','Could not read host schedule history.');
          for (const r of page.records) if (!seen.has(r.scheduledAt)) pending.add(r.scheduledAt);
          before = page.nextBefore;
          guard(!before || !cursors.has(before),'invalid-input','Host repeated a schedule history cursor.'); cursors.add(before);
        } while (before);
    }
    for (const occurrenceAt of [...pending].sort((a,b) => Date.parse(a)-Date.parse(b))) {
      try { assertStart(series.plan); await this.#checkStartSelections(ws,series.plan,true); }
      catch (e) {
        if (!(e instanceof FleetCoreError)) throw e;
        const result = await commit(c => { c.setSeriesHost(ws,id,host); return c.recordOccurrenceFailure(ws,id,{occurrenceAt,error:e.message}); });
        if (!result.duplicate && entry.status !== 'ended') await this.#pauseFailedSeries(ws,this.#core.readSeries(ws,id),entry);
        return;
      }
      await commit(c => c.recordOccurrenceAndStart(ws,id,{occurrenceAt}));
    }
    this.#reconciled.set(id,receipt);
    if (!same(series.host,host) || series.status !== entry.status) await commit(c => { c.setSeriesHost(ws,id,host); return c.setSeriesStatus(ws,id,entry.status); });
  }
  async #pauseFailedSeries(ws,series,entry) {
    const result = await this.#schedule('scheduleEdit',{id:series.scheduleId,action:'update',patch:{active:false},...(entry.updatedAt ? {expectedUpdatedAt:entry.updatedAt} : {})});
    guard(result.code !== 'schedule_conflict','stale-revision','Host schedule changed before pausing.');
    await this.#commit(ws,c => {
      const current = c.readSeries(ws,series.id);
      if (current.revision !== series.revision || current.status !== 'paused') return;
      if (result.code === 'schedule_not_found') c.setSeriesStatus(ws,series.id,'orphaned');
      else c.setSeriesHost(ws,series.id,this.#hostEcho(result));
    });
  }
  async #advanceTicket(ws, ticketId) {
    let ticket = this.#ticket(ws, ticketId);
    if (ticket.execution?.legacy?.readOnly && ticket.status !== 'stop-requested') return;
    for (const node of ticket.nodes.filter(n => n.status === 'running')) {
      const attempt = node.attempts.at(-1);
      if (ticket.status === 'stop-requested') await this.#stopNode(ws, ticketId, node, attempt);
      else await this.#pollNode(ws, ticketId, node, attempt);
      ticket = this.#ticket(ws, ticketId);
    }
    // Review jobs are independent of downstream execution and survive a human override.
    for (const gate of ticket.gates) if (gate.dispatch && !['finished', 'failed', 'stopped'].includes(gate.dispatch.phase)) {
      if (['created', 'submit-intent'].includes(gate.dispatch.phase) && ownerAlive(gate.dispatch.owner)) continue;
      if (!gate.dispatch.sessionId) {
        await this.#commit(ws, c => c.runtime(ws).recordGateDispatch(ticketId, gate.id, { ...gate.dispatch, phase: 'failed', detail: { ...gate.dispatch.detail, uncertain: true }, error: 'Review Session creation outcome is unknown; explicit retry required.' }, gate.dispatch.requestId)); continue;
      }
      if (ticket.status === 'stop-requested' || ticket.status === 'stopped') {
        let settled, observed;
        try {
          const cancelled = await this.#adapter.cancel({ sessionId: gate.dispatch.sessionId });
          observed = await this.#adapter.inspect({ sessionId: gate.dispatch.sessionId, requestId: gate.dispatch.messageId });
          settled = terminal.has(observed.status) || cancelled?.stopped === true;
        } catch { continue; }
        if (gate.humanOverride && ['completed', 'failed'].includes(observed.status)) { await this.#pollGate(ws, ticketId, gate); continue; }
        if (settled) await this.#commit(ws, c => c.runtime(ws).recordGateDispatch(ticketId, gate.id, { ...gate.dispatch, phase: 'stopped' }));
      } else await this.#pollGate(ws, ticketId, gate);
    }
    ticket = this.#ticket(ws, ticketId);
    if (ticket.status !== 'running' || ticket.execution?.legacy?.readOnly) return;
    // P-47 pre-approved rework: a returned Gate opens a new Attempt cycle within its frozen budget;
    // the subsequent runnable dispatch carries the findings. Exhaustion is noted once per cycle.
    for (const due of this.#core.runtime(ws).reworkDue(ticketId)) {
      try { await this.#commit(ws, c => c.runtime(ws).applyRework(ticketId, due.gateId)); }
      catch (error) { if (!['state-conflict', 'not-running', 'legacy-plan'].includes(error.code)) throw error; }
    }
    await this.#commit(ws, c => {
      const runtime = c.runtime(ws);
      runtime.noteReworkExhausted(ticketId);
      if (ticket.plan.logicGates?.length) runtime.advanceLogic(ticketId);
    });
    // P-46 delivery: reconcile an existing intent by receipt, otherwise persist intent → export → record.
    const intent = this.#core.readTicket(ws, ticketId).execution.delivery?.pending;
    if (intent) await this.#finishDelivery(ws, ticketId, intent);
    else {
      const pending = this.#core.runtime(ws).deliveryPending(ticketId);
      if (pending) {
        const gateRefs = this.#ticket(ws, ticketId).gates.filter(g => g.status === 'passed').map(g => { const review = (g.reviews ?? []).find(r => r.decision === 'passed' && r.cycle === g.cycle); return { gateId: g.id, cycle: g.cycle, ...(review ? { reviewId: review.id } : {}), ...(g.humanOverride ? { overrideId: g.humanOverride.id } : {}) }; });
        const recorded = await this.#commit(ws, c => c.runtime(ws).recordDeliveryIntent(ticketId, { deliveryId: randomUUID(), target: pending.target, items: pending.items, gateRefs }));
        await this.#finishDelivery(ws, ticketId, recorded);
      }
    }
    ticket = this.#ticket(ws, ticketId);
    if (ticket.status !== 'running') return;
    const activeCount = () => this.#core.listWorkspaces().flatMap(id => this.#core.listTickets(id).map(t => projectTicket(t))).filter(t => !t.execution?.legacy?.readOnly).reduce((count, t) => count + t.nodes.filter(n => n.status === 'running').length + t.gates.filter(g => g.dispatch && !['finished', 'failed', 'stopped'].includes(g.dispatch.phase)).length, 0);
    for (const gate of ticket.gates) {
      if (activeCount() >= this.#parallel) break;
      if (gate.status === 'pending' && gate.reviewer.kind === 'agent' && !gate.dispatch && this.#core.runtime(ws).gateReady(ticketId, gate.id)) {
        await this.#startGate(ws, ticketId, gate.id);
      }
    }
    let active = activeCount();
    for (const nodeId of this.#core.runtime(ws).runnable(ticketId)) {
      if (active >= this.#parallel) break;
      await this.#startNode(ws, ticketId, nodeId); active++;
    }
  }
  async #finishDelivery(ws, ticketId, intent) {
    const workspaceDir = this.#store.paths.workspacePaths[ws];
    // Idempotent export: a complete receipt from a prior attempt is reused, never re-delivered.
    const exported = await FleetStore.exportDelivery({ workspaceDir, ticketId, deliveryId: intent.id, target: intent.target ?? undefined, items: intent.items });
    try { await this.#commit(ws, c => c.runtime(ws).recordDelivery(ticketId, { target: exported.target, items: intent.items, manifestPath: exported.manifestPath, receiptPath: exported.receiptPath, gateRefs: intent.gateRefs })); }
    catch (error) { if (!['state-conflict', 'not-running'].includes(error.code)) throw error; }
  }
  #prompt(ticket, node) {
    const parentIds = new Set([...node.dependsOn, ...ticket.gates.filter(g => g.to.includes(node.id)).flatMap(g => g.from)]);
    for (const gate of ticket.plan.logicGates ?? []) {
      if (gate.routes.some(route => route.to.includes(node.id))) parentIds.add(gate.from);
    }
    const logicConditions = (ticket.plan.logicGates ?? []).filter(g => g.from === node.id).flatMap(g => g.routes.map(r => ({gateId:g.id, routeId:r.id, condition:r.condition})));
    const upstreamTickets = node.attempts.at(-1)?.upstreamTickets ?? [];
    const upstream = ticket.nodes.filter(n => parentIds.has(n.id) && n.status === 'completed').map(n => ({ nodeId: n.id, result: n.attempts.at(-1)?.outputs, summary: n.attempts.at(-1)?.completion?.summary ?? null, handoff: n.attempts.at(-1)?.completion?.handoff ?? null, artifacts: n.attempts.at(-1)?.completion?.artifactRefs ?? [], handleFile: FleetStore.handleFileRelPath(ticket.id, n.id).replace(/\\/g, '/') }));
    const rework = node.thread.filter(r => r.intent === 'retry').map(r => ({ time: r.time, actor: r.actor, reason: r.text }));
    return [
      'You are executing one Fleet node. Complete the assigned work and report concrete outputs, file paths and verification. Do not change Fleet configuration or approve your own gates.',
      `Ticket: ${ticket.id}\nGoal: ${ticket.goal}\nNode: ${node.id}`,
      `Role instructions: ${JSON.stringify(ticket.snapshot.agents[node.agentId].profile.instructions ?? '')}`,
      `Task: ${JSON.stringify(node.task)}`,
      `Stage plan (goal / tasks / expected outcomes): ${JSON.stringify(node.task.stagePlan ?? {})}`,
      `Planned use (tools, plugins and skills with their purposes): ${JSON.stringify(node.task.plannedCapabilities ?? [])}`,
      'Follow the stage plan and prefer the declared capabilities. Skills are loaded on demand: load each declared skill by name before relying on its instructions. If a declared capability is unavailable, say so in the conversation and continue with an equivalent means; do not silently drop an expected outcome.',
      `Task contract (acceptance / scope / verify): ${JSON.stringify(node.task.contract ?? {})}`,
      `Inputs: ${JSON.stringify(ticket.inputs)}\nAcceptance: ${JSON.stringify(ticket.criteria)}`,
      `Execution rules: ${JSON.stringify(ticket.execution.configurations[ticket.execution.currentConfigRevision].rules ?? {})}`,
      `Expected deliverables: ${JSON.stringify(ticket.snapshot.deliverables ?? [])}`,
      `Requirements: ${ticket.snapshot.requirements ?? ''}`,
      ...(upstreamTickets.length ? [`Upstream Ticket deliverables: ${JSON.stringify(upstreamTickets)}`, 'Read the supplied sealed snapshot paths for the bound upstream Ticket IDs. Each version and hash identifies the input for this attempt.'] : []),
      ...(logicConditions.length ? [`Logic Gate inputs: ${JSON.stringify(logicConditions)}`, 'Submit the observed field values in fleet_submit.handoff at the indicated paths. Fleet evaluates each condition independently after this node completes.'] : []),
      `Upstream handoff: ${JSON.stringify(upstream)}`,
      'Each upstream entry carries a handleFile (Workspace-relative path). Read it first: it lists the latest sealed artifact versions, hashes, snapshot paths, summary and handoff from the previous Agent. Build on those deliverables rather than redoing them.',
      `Rework findings from returned Gates: ${JSON.stringify(rework)}`,
      ...node.thread.filter(r => r.actor.kind === 'human').map(r => `User ${r.intent}: ${r.text}`),
      'When the work is done, call the fleet_submit tool to submit structured completion evidence: artifacts:[{path (Workspace-relative), deliverableIndex? (into the frozen deliverables), mediaType?}], acceptanceResults:[{criterion?, status:"passed"|"failed"|"unknown", evidence?}], verification:[{command, exitCode?, output?, source:"agent-report"}], summary?. Each submission seals a new artifact version; submit again after fixing findings. Evidence is self-reported (agent-report); it does not approve Gates or finish the Ticket.'
    ].join('\n\n');
  }
  /** P-75: a previous Session is reusable only while the Host can still resolve and read it. */
  async #sessionUsable(ws, sessionId, requestId) {
    try {
      await this.#adapter.recover?.({ workspaceId: ws, sessionId });
      const observed = await this.#adapter.inspect({ sessionId, requestId });
      return !(observed.status === 'unknown' && observed.error);
    } catch { return false; }
  }
  async #startNode(ws, ticketId, nodeId) {
    const deliveredIds = this.#ticket(ws, ticketId).nodes.find(n => n.id === nodeId).thread.filter(r => r.actor.kind === 'human').map(r => r.id);
    const priorAttempt = this.#ticket(ws, ticketId).nodes.find(n => n.id === nodeId).attempts.at(-1) ?? null;
    const lastRetry = [...(this.#ticket(ws, ticketId).nodes.find(n => n.id === nodeId).thread ?? [])].reverse().find(r => r.intent === 'retry');
    const isGateRework = Boolean(lastRetry?.text?.includes('pre-approved rework'));
    const claim = await this.#commit(ws, c => {
      const worker = c.runtime(ws).claimNode(ticketId, nodeId);
      // P-50: effective selection = node override ?? agent profile; recorded as a dispatch fact.
      const modelSelection = claimSelection(worker.input());
      const detail = { deliveredIds, modelSelection };
      worker.recordDispatch({ messageId: `fleet-${worker.attemptId}`, phase: 'created', owner: this.#owner, detail }); return { attemptId: worker.attemptId, input: worker.input(), modelSelection };
    });
    const attemptId = claim.attemptId, requestId = `fleet-${attemptId}`, detail = { deliveredIds, modelSelection: claim.modelSelection };
    // Readable session name: group by Ticket (title||goal), identify the role/node and the attempt round,
    // so the workspace sidebar shows which execution Sessions belong to this one Ticket and who is who.
    const t0 = this.#ticket(ws, ticketId), nd0 = t0.nodes.find(n => n.id === nodeId);
    const round = nd0.attempts.length;
    const who = t0.plan.agents?.[nd0.agentId]?.name || nd0.role || nd0.agentId || nodeId;
    const base = String(t0.plan.title || readableTitle(t0.plan.goal) || ticketId).trim().slice(0, 24);
    const sessionTitle = `${base} · ${who}（${nodeId}）· 第${round}轮`;
    // P-75: rework/retry reuses this Node's previous Session by default (same conversation, new round),
    // unless a Gate declares reworkSession:"new" or the old Session is no longer usable.
    const newOnly = (t0.snapshot?.gates ?? []).some(g => (g.from ?? []).includes(nodeId) && g.rework?.reworkSession === 'new');
    if (isGateRework && !newOnly && priorAttempt?.sessionId && priorAttempt.status !== 'running'
      && await this.#sessionUsable(ws, priorAttempt.sessionId, priorAttempt.dispatch?.messageId ?? `fleet-${priorAttempt.id}`)) {
      const sessionId = priorAttempt.sessionId;
      try {
        await this.#commit(ws, c => {
          const worker = this.#worker(c, ws, ticketId, nodeId, attemptId); worker.attachSession(sessionId);
          return worker.recordDispatch({ messageId: requestId, phase: 'submit-intent', owner: this.#owner, detail: { ...detail, reusedSession: true } });
        });
        await this.#refresh();
        const reusedTicket = this.#ticket(ws, ticketId), reusedNode = reusedTicket.nodes.find(n => n.id === nodeId);
        if (reusedTicket.status !== 'running') { if (reusedTicket.status === 'stop-requested') await this.#stopNode(ws, ticketId, reusedNode, reusedNode.attempts.at(-1), true); return; }
        await this.#adapter.submit({ workspaceId: ws, sessionId, requestId, prompt: this.#prompt(reusedTicket, reusedNode) });
        await this.#commit(ws, c => this.#worker(c, ws, ticketId, nodeId, attemptId).recordDispatch({ messageId: requestId, phase: 'submitted', detail: { ...detail, reusedSession: true } }));
        return;
      } catch (error) {
        if (this.#fault) throw error;
        await this.#commit(ws, c => this.#worker(c, ws, ticketId, nodeId, attemptId).recordDispatch({ messageId: requestId, phase: 'uncertain', detail: { ...detail, reusedSession: true, error: errorText(error) } }));
        return;
      }
    }
    let sessionId;
    try {
      ({ sessionId } = await this.#adapter.create({ workspaceId: ws, profile: claim.input.profile.profile, requestId, title: sessionTitle, ...(claim.modelSelection ? { modelSelection: claim.modelSelection } : {}) }));
      await this.#commit(ws, c => {
        const worker = this.#worker(c, ws, ticketId, nodeId, attemptId); worker.attachSession(sessionId);
        return worker.recordDispatch({ messageId: requestId, phase: 'submit-intent', owner: this.#owner, detail });
      });
    } catch (error) {
      if (this.#fault) throw error;
      await this.#commit(ws, c => { const worker = this.#worker(c, ws, ticketId, nodeId, attemptId); worker.recordDispatch({ messageId: requestId, phase: 'uncertain', detail: { ...detail, error: errorText(error) } }); return worker.interrupt(`Session creation outcome is uncertain: ${errorText(error)}`); }); return;
    }
    await this.#refresh();
    const ticket = this.#ticket(ws, ticketId), node = ticket.nodes.find(n => n.id === nodeId);
    if (ticket.status !== 'running') { if (ticket.status === 'stop-requested') await this.#stopNode(ws, ticketId, node, node.attempts.at(-1), true); return; }
    try {
      await this.#adapter.submit({ workspaceId: ws, sessionId, requestId, prompt: this.#prompt(ticket, node) });
      await this.#commit(ws, c => this.#worker(c, ws, ticketId, nodeId, attemptId).recordDispatch({ messageId: requestId, phase: 'submitted', detail }));
    } catch (error) {
      if (this.#fault) throw error;
      await this.#commit(ws, c => this.#worker(c, ws, ticketId, nodeId, attemptId).recordDispatch({ messageId: requestId, phase: 'uncertain', detail: { ...detail, error: errorText(error) } }));
    }
  }
  async #pollNode(ws, ticketId, node, attempt) {
    if (['created', 'submit-intent'].includes(attempt.dispatch?.phase) && ownerAlive(attempt.dispatch?.owner)) return;
    if (!attempt.sessionId) {
      // Crash between claim and association: preserve ambiguity, never create twice.
      await this.#commit(ws, c => { const worker = this.#worker(c, ws, ticketId, node.id, attempt.id); worker.recordDispatch({ messageId: `fleet-${attempt.id}`, ...attempt.dispatch, phase: 'uncertain' }, attempt.dispatch?.requestId); return worker.interrupt('Recovered an execution without a durable Session association; review and retry explicitly.'); }); return;
    }
    const deliveredIds = attempt.dispatch?.detail?.deliveredIds ?? [];
    const pendingMessages = this.#ticket(ws, ticketId).execution?.legacy?.readOnly ? [] : node.thread.filter(r => r.actor.kind === 'human' && !deliveredIds.includes(r.id));
    // A recorded intent is inspected, never blindly resent after a crash/timeout.
    if (pendingMessages.length && !['submit-intent', 'uncertain'].includes(attempt.dispatch?.phase)) {
      const last = pendingMessages.at(-1), requestId = `fleet-thread-${last.id}`;
      const detail = { deliveredIds: [...deliveredIds, ...pendingMessages.map(r => r.id)] };
      await this.#commit(ws, c => this.#worker(c, ws, ticketId, node.id, attempt.id).recordDispatch({ messageId: requestId, phase: 'submit-intent', owner: this.#owner, detail }, attempt.dispatch?.requestId));
      try {
        await this.#adapter.message({ workspaceId: ws, sessionId: attempt.sessionId, requestId, text: `${pendingMessages.map(r => r.text).join('\n\n')}\nCurrent node task: ${JSON.stringify(node.task)}` });
        await this.#commit(ws, c => {
          const worker = this.#worker(c, ws, ticketId, node.id, attempt.id);
          return worker.recordDispatch({ messageId: requestId, phase: 'submitted', detail });
        });
      } catch (error) {
        if (this.#fault) throw error;
        await this.#commit(ws, c => this.#worker(c, ws, ticketId, node.id, attempt.id).recordDispatch({ messageId: requestId, phase: 'uncertain', detail: { ...detail, error: errorText(error) } }));
      }
      return;
    }
    const requestId = attempt.dispatch?.messageId;
    if (!requestId) {
      await this.#commit(ws, c => this.#worker(c, ws, ticketId, node.id, attempt.id).interrupt('Execution has no durable submission ID.')); return;
    }
    let result;
    try {
      await this.#adapter.recover?.({ workspaceId: ws, sessionId: attempt.sessionId });
      result = await this.#adapter.inspect({ sessionId: attempt.sessionId, requestId, includeFollowups: true, progressAnchor: `fleet-${attempt.id}` });
    }
    catch (error) { this.#lastError = { at: new Date().toISOString(), ticketId, nodeId: node.id, message: errorText(error) }; return; } // A read failure does not fabricate terminal state.
    if (result.progress?.length) {
      const known = new Set(node.thread.map(row => row.id));
      const fresh = result.progress.filter(item => !known.has(`native-${attempt.id}-${item.id}`));
      if (fresh.length) await this.#commit(ws, c => this.#worker(c, ws, ticketId, node.id, attempt.id).recordProgress(fresh));
    }
    if (result.status !== 'unknown' && ['submit-intent', 'uncertain'].includes(attempt.dispatch?.phase)) {
      await this.#commit(ws, c => {
        const worker = this.#worker(c, ws, ticketId, node.id, attempt.id);
        return worker.recordDispatch({ ...attempt.dispatch, phase: 'submitted' }, requestId);
      });
      // New messages arrived while the first submission was uncertain. Send them
      // on the next tick before accepting a terminal result from that older request.
      if (pendingMessages.length) return;
    }
    if (!terminal.has(result.status)) return;
    await this.#commit(ws, c => {
      const current = c.readTicket(ws, ticketId).execution.nodes[node.id], latest = current.attempts.at(-1);
      guard((latest.dispatch?.requestId ?? latest.dispatch?.messageId) === requestId, 'stale-dispatch', 'A later request superseded this observation.');
      guard(c.readTicket(ws, ticketId).execution.legacy?.readOnly || current.thread.filter(r => r.actor?.kind === 'human').every(r => (latest.dispatch?.detail?.deliveredIds ?? []).includes(r.id)), 'stale-dispatch', 'New discussion must be delivered before completing.');
      const worker = this.#worker(c, ws, ticketId, node.id, attempt.id);
      if (result.status === 'completed') {
        if (result.output === undefined) return worker.interrupt('Host completion had no output evidence.');
        return worker.complete(result.output);
      }
      if (result.status === 'failed') return worker.fail(result.error ?? 'Host execution failed.');
      return worker.interrupt(result.error ?? 'Session stopped outside Fleet; review and retry.');
    });
  }
  async #stopNode(ws, ticketId, node, attempt, ownerFinished = false) {
    if (!ownerFinished && ['created', 'submit-intent'].includes(attempt.dispatch?.phase) && ownerAlive(attempt.dispatch?.owner)) return;
    if (!attempt.sessionId) { await this.#commit(ws, c => { const worker = this.#worker(c, ws, ticketId, node.id, attempt.id); if (attempt.dispatch) worker.recordDispatch({ ...attempt.dispatch, phase: 'uncertain' }); return worker.confirmStopped(); }); return; }
    let result, cancelled;
    try { cancelled = await this.#adapter.cancel({ sessionId: attempt.sessionId }); result = await this.#adapter.inspect({ sessionId: attempt.sessionId, requestId: attempt.dispatch?.messageId, includeFollowups: true, progressAnchor: `fleet-${attempt.id}` }); }
    catch { return; }
    if (!terminal.has(result.status) && !cancelled?.stopped) return;
    await this.#commit(ws, c => {
      const worker = this.#worker(c, ws, ticketId, node.id, attempt.id);
      if (result.progress?.length) worker.recordProgress(result.progress);
      if (result.status === 'completed' && result.output !== undefined) return worker.complete(result.output);
      if (result.status === 'failed') return worker.fail(result.error ?? 'Host execution failed after stop request.');
      return worker.confirmStopped();
    });
  }
  async #startGate(ws, ticketId, gateId) {
    const requestId = `fleet-review-${randomUUID()}`;
    // Capture the same frozen configuration used to claim this dispatch, before
    // another Service can change the model of a pending reviewer node.
    const { ticket, gate, frozenGate, node, agent, detail } = await this.#commit(ws, c => {
      const ticket = projectTicket(c.readTicket(ws, ticketId));
      const gate = ticket.gates.find(g => g.id === gateId);
      guard(gate?.status === 'pending' && gate.reviewer.kind === 'agent', 'not-reviewable', 'Gate is no longer pending Agent review.');
      const frozenGate = ticket.snapshot.gates.find(g => g.id === gateId);
      const node = ticket.nodes.find(n => n.id === gate.reviewer.nodeId);
      const agent = ticket.snapshot.agents[node.agentId];
      const detail = { modelSelection: effectiveGateModelSelection(frozenGate, node, agent).selection, reviewerNodeId: gate.reviewer.nodeId };
      c.runtime(ws).recordGateDispatch(ticketId, gateId, { requestId, messageId: requestId, phase: 'created', owner: this.#owner, detail }, null);
      return { ticket, gate, frozenGate, node, agent, detail };
    });
    const { modelSelection } = detail;
    const gBase = String(ticket.snapshot.title || readableTitle(ticket.snapshot.goal) || ticketId).trim().slice(0, 24);
    const gWho = agent.name || gate.reviewer.nodeId || 'review';
    const gTitle = `${gBase} · 审核 ${gate.id}（${gWho}）· 第${(gate.cycle ?? 0) + 1}轮`;
    // P-75: re-review reuses the previous review Session when the reviewer Node is unchanged and the
    // Session is still usable, so the reviewer keeps its earlier findings in context.
    const priorCycle = (gate.history ?? []).at(-1) ?? null;
    const priorReview = priorCycle?.dispatch ?? null;
    const reuseReview = priorCycle?.reason?.includes('pre-approved rework') && frozenGate.reviewSession !== 'new' && priorReview?.sessionId
      && priorReview.detail?.reviewerNodeId === gate.reviewer.nodeId
      && await this.#sessionUsable(ws, priorReview.sessionId, priorReview.messageId);
    let sessionId;
    try {
      if (reuseReview) {
        sessionId = priorReview.sessionId;
        await this.#commit(ws, c => c.runtime(ws).recordGateDispatch(ticketId, gate.id, { sessionId, messageId: requestId, phase: 'submit-intent', owner: this.#owner, detail: { ...detail, reusedSession: true } }, requestId));
      } else {
        ({ sessionId } = await this.#adapter.create({ workspaceId: ws, profile: agent.profile, requestId, title: gTitle, ...(modelSelection ? { modelSelection } : {}) }));
        await this.#commit(ws, c => c.runtime(ws).recordGateDispatch(ticketId, gate.id, { sessionId, messageId: requestId, phase: 'submit-intent', owner: this.#owner, detail }, requestId));
      }
      if (this.#ticket(ws, ticketId).status !== 'running') { const cancelled = await this.#adapter.cancel({ sessionId }); await this.#commit(ws, c => c.runtime(ws).recordGateDispatch(ticketId, gate.id, { sessionId, messageId: requestId, phase: cancelled?.stopped ? 'stopped' : 'uncertain', detail }, requestId)); return; }
      const capabilities = frozenGate.plannedCapabilities ?? node.task?.plannedCapabilities ?? [];
      const reviewTask = frozenGate.reviewTask;
      const taskInstructions = reviewTask ? [
        `Review task: ${JSON.stringify(reviewTask.summary ?? '')}`,
        `Review inputs: ${JSON.stringify(reviewTask.inputs ?? [])}`,
        `Review checks: ${JSON.stringify(reviewTask.checks ?? [])}`
      ] : [
        `Review stage plan: ${JSON.stringify(node.task?.stagePlan ?? {})}`,
        ...(frozenGate.rework?.scopeNote ? [`Gate review scope: ${JSON.stringify(frozenGate.rework.scopeNote)}`] : [])
      ];
      const reviewSources = ticket.nodes.filter(n => gate.from.includes(n.id) && n.status === 'completed');
      const reviewIds = new Set(reviewSources.map(n => n.id));
      const versions = Object.entries(ticket.artifacts ?? {}).filter(([, a]) => reviewIds.has(a.nodeId)).map(([artifactId, a]) => { const lv = a.versions.at(-1); return { artifactId, nodeId: a.nodeId, sourcePath: a.sourcePath, version: lv.version, sha256: lv.sha256, snapshotPath: lv.snapshotPath }; });
      const deliveries = reviewSources.map(n => {
        const attempt = n.attempts.at(-1);
        return { node: n.id, output: attempt?.outputs, summary: attempt?.completion?.summary, handoff: attempt?.completion?.handoff };
      });
      const prompt = [
        'Review the upstream Fleet delivery against the acceptance criteria. Do not approve by default. Respond with a JSON object {"decision":"passed"|"returned","evidence":"concrete review findings","findings":[{"id":"f1","severity":"low|medium|high|blocker","description":"..."}],"artifactRefs":[{"artifactId":"...","version":1,"sha256":"..."}]}. findings and artifactRefs are optional; omit artifactRefs to auto-bind the latest versions listed below.',
        `Reviewer instructions: ${JSON.stringify(agent.profile.instructions ?? '')}`,
        ...taskInstructions,
        `Planned use for this review: ${JSON.stringify(capabilities)}`,
        'Load each declared skill by its id on demand before using it. Record any unavailable review input or capability in the review evidence.',
        `Goal: ${ticket.snapshot.goal}`,
        `Criteria: ${JSON.stringify(ticket.snapshot.criteria)}`,
        `Deliverables (each item carries its own criteria): ${JSON.stringify(ticket.snapshot.deliverables ?? [])}`,
        `Execution rules: ${JSON.stringify(ticket.execution.configurations[ticket.execution.currentConfigRevision].rules ?? {})}`,
        `Gate contract: ${JSON.stringify({ id: gate.id, from: gate.from, to: gate.to, requireEvidence: frozenGate.requireEvidence ?? false, rework: frozenGate.rework ?? null })}`,
        `Artifact versions under review (artifactId/version/sha256/snapshotPath): ${JSON.stringify(versions)}`,
        `Deliveries: ${JSON.stringify(deliveries)}`
      ].join('\n\n');
      await this.#adapter.submit({ workspaceId: ws, sessionId, requestId, prompt });
      await this.#commit(ws, c => c.runtime(ws).recordGateDispatch(ticketId, gate.id, { sessionId, messageId: requestId, phase: 'submitted', detail }, requestId));
    } catch (error) {
      if (this.#fault) throw error;
      await this.#commit(ws, c => c.runtime(ws).recordGateDispatch(ticketId, gate.id, { ...(sessionId ? { sessionId } : {}), messageId: requestId, phase: sessionId ? 'uncertain' : 'failed', detail: { ...detail, uncertain: true }, error: errorText(error) }, requestId));
    }
  }
  async #pollGate(ws, ticketId, gate) {
    let result;
    try {
      await this.#adapter.recover?.({ workspaceId: ws, sessionId: gate.dispatch.sessionId });
      result = await this.#adapter.inspect({ sessionId: gate.dispatch.sessionId, requestId: gate.dispatch.messageId });
    }
    catch { return; }
    if (!terminal.has(result.status)) return;
    let decision = 'returned', evidence = result.error ?? `Review execution ${result.status}.`;
    if (result.status === 'completed') {
      const raw = outputText(result.output);
      try {
        const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
        guard(['passed', 'returned'].includes(parsed.decision) && parsed.evidence, 'invalid-review', 'Missing review evidence.'); decision = parsed.decision;
        evidence = (parsed.findings !== undefined || parsed.artifactRefs !== undefined) ? { ...(typeof parsed.evidence === 'string' ? { text: parsed.evidence } : { evidence: parsed.evidence }), ...(parsed.findings !== undefined ? { findings: parsed.findings } : {}), ...(parsed.artifactRefs !== undefined ? { artifactRefs: parsed.artifactRefs } : {}) } : parsed.evidence;
      } catch { evidence = { problem: 'Reviewer did not return a valid decision with evidence.', output: result.output ?? null }; }
    }
    await this.#commit(ws, c => {
      const current = c.readTicket(ws, ticketId).execution.gates[gate.id];
      guard(current.dispatch?.requestId === gate.dispatch.requestId && !['finished', 'failed', 'stopped'].includes(current.dispatch.phase), 'stale-dispatch', 'Review was already reconciled.');
      c.runtime(ws).recordGateDispatch(ticketId, gate.id, { ...gate.dispatch, phase: 'finished' }, gate.dispatch.requestId);
      // Core retains late results as opinions without superseding human override. A requireEvidence
      // rejection of an Agent 'passed' becomes a returned Gate (send back for evidence), never a fault.
      const reviewer = c.runtime(ws).reviewer(ticketId, gate.id);
      try { return reviewer.submit(decision, evidence); }
      catch (error) { if (error.code !== 'evidence-required') throw error; return reviewer.submit('returned', { problem: 'Upstream Nodes did not submit the structured completion evidence this Gate requires.' }); }
    });
  }
  async close() {
    clearInterval(this.#timer); await this.#queue;
    if (this.#closed) return; this.#closed = true; liveServices.delete(this.#owner.serviceId); await this.#store.close();
  }
}
