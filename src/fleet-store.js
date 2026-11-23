// Chain-scoped persistence boundary: one commit chain per directory — the Root
// template library and each Workspace .fleet. Locks exist only inside millisecond
// commit transactions; provably stale locks are auto-reclaimed on acquire; reads
// are always lock-free via the committed pointer. Immutable generations, including
// failed-save orphans, are intentionally retained.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { assertSeriesShape } from './fleet-core.js';

const REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const chainTransactions = new Map();
const digest = value => createHash('sha256').update(value).digest('hex');
const ticketFilename = id => `${digest(JSON.stringify(id))}.json`;
function fail(message) { throw new Error(`FleetStore: ${message}`); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function id(value, label) { if (typeof value !== 'string' || !value.length) fail(`${label} must be a nonempty string`); }
function keys(value, expected, label) {
  if (!record(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail(`invalid ${label} fields`);
}

// Validate before stringify: no coercion, getters, toJSON, sparse arrays or lost fields.
export function jsonClone(value) {
  const ancestors = new Set();
  function visit(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return;
    if (typeof item !== 'object') fail('snapshot must contain only lossless JSON data');
    if (ancestors.has(item)) fail('cyclic JSON data');
    const array = Array.isArray(item), proto = Object.getPrototypeOf(item);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail('JSON objects must have plain prototypes');
    ancestors.add(item);
    const ownKeys = Reflect.ownKeys(item);
    if (array && ownKeys.length !== item.length + 1) fail('sparse arrays or extra array properties are not JSON data');
    for (const key of ownKeys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || (array && !/^(0|[1-9][0-9]*)$/.test(key))) fail('non-JSON object key');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('non-JSON property descriptor');
      visit(descriptor.value);
    }
    ancestors.delete(item);
  }
  visit(value);
  return JSON.parse(JSON.stringify(value));
}
function uniqueRecords(items, label) {
  if (!Array.isArray(items)) fail(`${label} must be an array`);
  const seen = new Set();
  for (const item of items) {
    if (!record(item)) fail(`${label} must contain records`);
    id(item.id, `${label}.id`);
    if (seen.has(item.id)) fail(`duplicate ${label} id`);
    seen.add(item.id);
  }
}
export function validateTemplates(value) {
  const state = jsonClone(value);
  if (state.schemaVersion === 1) {
    keys(state, ['schemaVersion', 'agents', 'flows'], 'template state');
    uniqueRecords(state.agents, 'agents'); uniqueRecords(state.flows, 'flows');
  } else if (state.schemaVersion === 2) {
    keys(state, ['schemaVersion', 'templates', 'settings'], 'template state');
    uniqueRecords(state.templates, 'templates');
    if (!record(state.settings)) fail('invalid global settings');
    for (const template of state.templates) if (!['agent', 'orchestration'].includes(template.kind) || !record(template.content) || !Array.isArray(template.history)) fail('invalid Template');
  } else fail('unsupported template schemaVersion');
  return state;
}
export function validateWorkspaceState(value) {
  const state = jsonClone(value);
  if (state.schemaVersion === 1) {
    keys(state, ['schemaVersion', 'id', 'definitions', 'binding', 'tickets'], 'workspace state');
    keys(state.definitions, ['agents', 'flows'], 'workspace definitions');
    uniqueRecords(state.definitions.agents, 'definition agents'); uniqueRecords(state.definitions.flows, 'definition flows');
    if (state.binding !== null && !record(state.binding)) fail('binding must be an object or null');
  } else if (state.schemaVersion === 2) {
    keys(state, ['schemaVersion', 'id', 'tickets', ...['legacy','series'].filter(k => Object.hasOwn(state,k))], 'workspace state');
    if (Object.hasOwn(state, 'series')) { uniqueRecords(state.series, 'series'); for (const s of state.series) assertSeriesShape(s, state.id); }
  } else fail('unsupported workspace schemaVersion');
  id(state.id, 'workspace id');
  uniqueRecords(state.tickets, 'tickets');
  for (const ticket of state.tickets) if (ticket.workspaceId !== state.id) fail('Ticket workspaceId does not match its Workspace');
  return state;
}
function absolute(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) fail(`${label} must be an explicit absolute path`);
  if (process.platform === 'win32' && (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value) || value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\') || value.slice(2).includes(':'))) fail(`${label} has an unsafe Windows path`);
  const normalized = path.normalize(value);
  if (process.platform === 'win32') {
    const parts = normalized.slice(path.parse(normalized).root.length).split(/[\\/]/).filter(Boolean);
    if (parts.some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail(`${label} contains an unsafe Windows path alias`);
  }
  if (value.split(/[\\/]/).includes('..')) fail(`${label} contains path traversal`);
  return normalized;
}
// lstat every existing ancestor, including junctions on Windows. These basic
// checks do not claim protection against a hostile concurrent directory swap.
async function checked(target) {
  const absolutePath = absolute(target, 'storage path');
  const parsed = path.parse(absolutePath);
  let cursor = parsed.root;
  const parts = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) cursor = path.join(cursor, parts[i]);
    let stat;
    try { stat = await fs.lstat(cursor); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) fail(`symlink/reparse path rejected: ${cursor}`);
    if (i < parts.length - 1 && !stat.isDirectory()) fail(`non-directory ancestor: ${cursor}`);
    if (i === parts.length - 1 || parts.length === 0) return stat;
  }
}
async function directory(target) {
  await checked(target);
  await fs.mkdir(target, { recursive: true });
  const stat = await checked(target);
  if (!stat?.isDirectory()) fail(`expected directory: ${target}`);
}
async function syncDirectory(target) {
  await checked(target);
  let handle;
  try { handle = await fs.open(target, 'r'); await handle.sync(); }
  catch (error) {
    // Node/Windows cannot open directories for fsync. File fsync is mandatory.
    if (!(process.platform === 'win32' && ['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(error.code))) throw error;
  } finally { await handle?.close(); }
}
async function readBytes(target, optional = false) {
  const stat = await checked(target);
  if (!stat) { if (optional) return null; fail(`missing committed file: ${target}`); }
  if (!stat.isFile() || stat.nlink !== 1) fail(`expected unlinked regular file: ${target}`);
  return fs.readFile(target, 'utf8');
}
function parse(bytes, label) {
  try { return jsonClone(JSON.parse(bytes)); } catch (error) { fail(`corrupt ${label}: ${error.message}`); }
}
async function writeJSON(target, value) {
  await checked(target);
  const bytes = `${JSON.stringify(value)}\n`;
  const handle = await fs.open(target, 'wx', 0o600);
  try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  return digest(bytes);
}
const lockPathOf = dir => path.join(dir, '.writer.lock');
const currentPathOf = dir => path.join(dir, 'current.json');
const generationsPathOf = dir => path.join(dir, 'generations');
function lockIdentity(bytes) {
  const lock = parse(bytes, 'writer lock');
  keys(lock, ['token', 'pid', 'hostname'], 'writer lock');
  if (typeof lock.token !== 'string' || !REVISION.test(lock.token) || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || lock.pid > 0x7fffffff || typeof lock.hostname !== 'string' || !lock.hostname) fail('invalid writer lock identity');
  return lock;
}

export class FleetStore {
  #dir; #kind; #hook; #queue = Promise.resolve(); #closed = false;
  constructor(secret, dir, kind, hook) {
    if (secret !== PRIVATE) fail('use FleetStore.open()');
    this.#dir = dir; this.#kind = kind; this.#hook = hook;
  }
  // Opening never touches the lock: bootstrap directories lazily and read freely.
  static async open({ dir, kind, beforePublish } = {}) {
    if (kind !== 'templates' && kind !== 'workspace') fail('kind must be templates or workspace');
    if (beforePublish !== undefined && typeof beforePublish !== 'function') fail('beforePublish must be a function (test hook only)');
    const location = absolute(dir, 'dir');
    await directory(location);
    await directory(generationsPathOf(location));
    return new FleetStore(PRIVATE, location, kind, beforePublish);
  }
  get paths() { return Object.freeze({ dir: this.#dir, kind: this.#kind, currentPath: currentPathOf(this.#dir), lockPath: lockPathOf(this.#dir), generationsPath: generationsPathOf(this.#dir) }); }
  get kind() { return this.#kind; }

  // ---- lock-free committed read (usable with no writer and any lock state) ----
  static async read({ dir, kind }) {
    if (kind !== 'templates' && kind !== 'workspace') fail('kind must be templates or workspace');
    const location = absolute(dir, 'dir');
    const pointerBytes = await readBytes(currentPathOf(location), true);
    if (pointerBytes === null) return null;
    const pointer = parse(pointerBytes, 'current pointer');
    keys(pointer, ['schemaVersion', 'revision', 'stateHash'], 'current pointer');
    if (pointer.schemaVersion !== 1 || !REVISION.test(pointer.revision) || !HASH.test(pointer.stateHash)) fail('invalid current pointer');
    if (kind === 'templates') {
      const bytes = await readBytes(path.join(generationsPathOf(location), `${pointer.revision}.json`));
      if (digest(bytes) !== pointer.stateHash) fail('corrupt template state hash');
      return validateTemplates(parse(bytes, 'template state'));
    }
    const generation = path.join(generationsPathOf(location), pointer.revision);
    const stateBytes = await readBytes(path.join(generation, 'state.json'));
    if (digest(stateBytes) !== pointer.stateHash) fail('corrupt workspace state hash');
    const disk = parse(stateBytes, 'workspace state');
    validateWorkspaceState({ ...disk, tickets: [] });
    uniqueRecords(disk.tickets, 'ticket references');
    const tickets = [];
    for (const ref of disk.tickets) {
      keys(ref, ['id', 'hash'], 'ticket reference');
      if (!HASH.test(ref.hash)) fail('invalid Ticket hash');
      const ticketBytes = await readBytes(path.join(generation, 'tickets', ticketFilename(ref.id)));
      if (digest(ticketBytes) !== ref.hash) fail('corrupt Ticket hash');
      const ticket = parse(ticketBytes, 'Ticket');
      if (ticket.id !== ref.id || ticket.workspaceId !== disk.id) fail('Ticket identity/Workspace mismatch');
      tickets.push(ticket);
    }
    return { ...disk, tickets };
  }
  #enqueue(action) {
    if (this.#closed) return Promise.reject(new Error('FleetStore: store is closed'));
    const pending = this.#queue.then(action);
    this.#queue = pending.catch(() => {});
    return pending;
  }
  read() { return this.#enqueue(() => FleetStore.read({ dir: this.#dir, kind: this.#kind })); }

  // ---- lock probe / verified stale reclaim ----
  static async probe(dir) {
    const location = absolute(dir, 'dir');
    const bytes = await readBytes(lockPathOf(location), true);
    if (bytes === null) return { state: 'absent', owner: null };
    let lock;
    try { lock = lockIdentity(bytes); } catch { return { state: 'corrupt', owner: null }; }
    if (lock.hostname !== hostname()) return { state: 'remote', owner: lock };
    try { process.kill(lock.pid, 0); return { state: 'live', owner: lock }; }
    catch (error) {
      if (error.code !== 'ESRCH') return { state: 'uncertain', owner: lock };
      const current = await readBytes(lockPathOf(location), true);
      if (current === null) return { state: 'absent', owner: null };
      if (current !== bytes || parse(current, 'writer lock').token !== lock.token) return { state: 'corrupt', owner: null };
      return { state: 'stale', owner: lock };
    }
  }
  static async #removeIfStale(location, probe) {
    if (probe.state !== 'stale') return false;
    const lockPath = lockPathOf(location);
    const bytes = await readBytes(lockPath, true);
    if (bytes === null) return true;
    const lock = lockIdentity(bytes);
    if (lock.hostname !== hostname()) fail('writer lock belongs to another hostname; left intact');
    try { process.kill(lock.pid, 0); fail('writer lock PID is still alive or has been reused; left intact'); }
    catch (error) { if (error.code !== 'ESRCH') fail(`writer lock PID status is uncertain (${error.code ?? error.message}); left intact`); }
    const recheck = await readBytes(lockPath);
    if (recheck !== bytes || parse(recheck, 'writer lock').token !== lock.token) fail('writer lock changed during stale-lock recovery; left intact');
    await fs.unlink(lockPath);
    await syncDirectory(location);
    return true;
  }
  // Explicit maintenance entry (terminal tool and UI button). Never preempts a
  // live, remote, uncertain or corrupt lock.
  static async reclaimStaleLock({ dir, rootPath } = {}) {
    const location = absolute(dir ?? rootPath, 'dir');
    const probe = await FleetStore.probe(location);
    if (probe.state === 'absent') return false;
    if (probe.state === 'stale') return FleetStore.#removeIfStale(location, probe);
    if (probe.state === 'corrupt') fail('corrupt writer lock metadata; left intact');
    if (probe.state === 'remote') fail('writer lock belongs to another hostname; left intact');
    if (probe.state === 'uncertain') fail(`writer lock PID status is uncertain; left intact`);
    fail('writer lock PID is still alive or has been reused; left intact');
  }

  // ---- transaction-scoped lock: acquire → commit → release, milliseconds ----
  static async #acquire(location) {
    const lockPath = lockPathOf(location);
    for (let attempt = 0; attempt < 16; attempt++) {
      let handle;
      try {
        await checked(location);
        handle = await fs.open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (error.code === 'EEXIST') {
          const probe = await FleetStore.probe(location);
          if (probe.state === 'stale') { await FleetStore.#removeIfStale(location, probe); continue; }
          if (probe.state === 'absent') continue;
          // The owner publishes metadata immediately after exclusive creation. A
          // reader may observe its short empty/partial-write window; wait without
          // reclaiming it. Persistently corrupt metadata still fails closed.
          if (['live', 'corrupt'].includes(probe.state) && attempt < 15) { await new Promise(done => setTimeout(done, Math.min(64, 8 * 2 ** attempt))); continue; }
          const reason = probe.state === 'live' ? `another instance is committing (pid ${probe.owner?.pid ?? '?'}); retry later or close that instance`
            : probe.state === 'remote' ? 'writer lock belongs to another hostname; resolve the shared-path setup explicitly'
              : probe.state === 'uncertain' ? 'writer lock PID status is uncertain; verify and reclaim explicitly'
                : 'writer lock metadata is corrupt; reclaim explicitly';
          if (probe.state === 'live') throw Object.assign(new Error(`FleetStore: writer lock held: ${reason}`), { code: 'store-busy' });
          fail(`writer lock held: ${reason}`);
        }
        await handle?.close();
        throw error;
      }
      const token = randomUUID();
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, hostname: hostname() }));
        await handle.sync();
      } finally { await handle.close(); }
      return token;
    }
    fail('writer lock acquisition did not settle after retries');
  }
  static async #assertOwned(location, token) {
    const bytes = await readBytes(lockPathOf(location));
    if (parse(bytes, 'writer lock').token !== token) fail('writer lock ownership lost');
  }
  static async #release(location, token) {
    const bytes = await readBytes(lockPathOf(location), true);
    if (bytes === null) return;
    let lock; try { lock = JSON.parse(bytes); } catch { return; }
    if (lock?.token === token) await fs.unlink(lockPathOf(location));
  }

  async commit(input) {
    const state = this.#kind === 'templates' ? validateTemplates(input) : validateWorkspaceState(input);
    return (await this.transaction(() => state)).revision;
  }
  // The chain lock covers the latest read, domain mutation/CAS and publication.
  transaction(update) {
    return this.#enqueue(() => {
      const key = process.platform === 'win32' ? this.#dir.toLowerCase() : this.#dir;
      const task = (chainTransactions.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.#commit(update));
      chainTransactions.set(key, task);
      return task.finally(() => { if (chainTransactions.get(key) === task) chainTransactions.delete(key); });
    });
  }
  // Conversion of the older manifestHash layout holds this same Root lock. The
  // original pointer remains readable until every referenced Workspace is ready.
  upgradeLegacyRoot(convert) {
    if (this.#kind !== 'templates') fail('legacy Root upgrade requires a templates chain');
    return this.#enqueue(() => this.#commit(convert, true));
  }
  async #commit(update, upgrade = false) {
    const location = this.#dir;
    const token = await FleetStore.#acquire(location);
    try {
      let previous, legacyPointerBytes = null;
      if (upgrade) {
        const pointerBytes = await readBytes(currentPathOf(location), true) ?? await readBytes(path.join(location, 'legacy-current.json'), true);
        const pointer = pointerBytes && parse(pointerBytes, 'legacy pointer');
        if (pointer && Object.hasOwn(pointer, 'manifestHash')) {
          if (!REVISION.test(pointer.revision) || !HASH.test(pointer.manifestHash)) fail('invalid legacy pointer');
          const bytes = await readBytes(path.join(generationsPathOf(location), `${pointer.revision}.json`));
          if (digest(bytes) !== pointer.manifestHash) fail('legacy Root manifest hash mismatch');
          previous = { legacyManifest: parse(bytes, 'legacy Root manifest') }; legacyPointerBytes = pointerBytes;
        }
      }
      previous ??= await FleetStore.read({ dir: location, kind: this.#kind });
      const next = await update(previous === null ? null : jsonClone(previous));
      if (next === null || JSON.stringify(next) === JSON.stringify(previous)) return { revision: null, state: previous };
      const state = this.#kind === 'templates' ? validateTemplates(next) : validateWorkspaceState(next);
      if (legacyPointerBytes !== null) {
        const archivePath = path.join(location, 'legacy-current.json'), archivedBytes = await readBytes(archivePath, true);
        if (archivedBytes !== null && JSON.stringify(parse(archivedBytes, 'legacy archive pointer')) !== JSON.stringify(parse(legacyPointerBytes, 'legacy pointer'))) fail('legacy archive pointer conflicts with the source');
        if (archivedBytes === null) { const archive = await fs.open(archivePath, 'wx', 0o600); try { await archive.writeFile(legacyPointerBytes); await archive.sync(); } finally { await archive.close(); } }
      }
      const revision = randomUUID();
      const generations = generationsPathOf(location);
      await directory(generations);
      let stateFile;
      if (this.#kind === 'workspace') {
        const generation = path.join(generations, revision);
        await checked(generation); await fs.mkdir(generation);
        const ticketDirectory = path.join(generation, 'tickets');
        await directory(ticketDirectory);
        const refs = [];
        for (const ticket of state.tickets) refs.push({ id: ticket.id, hash: await writeJSON(path.join(ticketDirectory, ticketFilename(ticket.id)), ticket) });
        const disk = { ...state, tickets: refs };
        stateFile = path.join(generation, 'state.json');
        await writeJSON(stateFile, disk);
        await syncDirectory(ticketDirectory); await syncDirectory(generation);
      } else {
        stateFile = path.join(generations, `${revision}.json`);
        await writeJSON(stateFile, state);
      }
      const stateHash = digest(await fs.readFile(stateFile, 'utf8'));
      const temporary = path.join(location, `current.${revision}.tmp`);
      await writeJSON(temporary, { schemaVersion: 1, revision, stateHash });
      // Test-only failure seam. No publication has occurred at this point.
      await this.#hook?.(Object.freeze({ revision, dir: location }));
      await FleetStore.#assertOwned(location, token);
      await checked(temporary); await checked(currentPathOf(location));
      await fs.rename(temporary, currentPathOf(location));
      await syncDirectory(location);
      return { revision, state };
    } finally {
      await FleetStore.#release(location, token);
    }
  }
  // ---- P-44/P-46 artifact sealing & delivery export (byte copies live outside the chain lock) ----
  // The artifact area is separate from generations: the chain hash protects business records,
  // the artifact SHA-256 protects delivered content. Staging is copied, hashed, then renamed.
  static async sealArtifact({ workspaceDir, ticketId, artifactId, version, sourceAbsPath }) {
    const ws = absolute(workspaceDir, 'workspaceDir');
    id(ticketId, 'ticketId'); id(artifactId, 'artifactId');
    if (!Number.isSafeInteger(version) || version < 1) fail('artifact version must be a positive safe integer');
    const source = absolute(sourceAbsPath, 'sourceAbsPath');
    const relative = path.relative(ws, source);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) fail('artifact source must stay inside the Workspace');
    const stat = await checked(source);
    if (!stat?.isFile() || stat.nlink !== 1) fail(`artifact source must be a regular unlinked file: ${source}`);
    const area = path.join(ws, '.fleet', 'tickets', digest(JSON.stringify(ticketId)));
    const versionDir = path.join(area, 'artifacts', artifactId, `v${version}`);
    const basename = path.basename(source), finalPath = path.join(versionDir, basename);
    const staging = path.join(area, 'artifacts', `.staging-${randomUUID()}`);
    await directory(staging);
    const stagedFile = path.join(staging, basename);
    try {
      await fs.copyFile(source, stagedFile);
      const bytes = await fs.readFile(stagedFile), sha256 = digest(bytes), size = bytes.length;
      await directory(versionDir);
      const existing = await checked(finalPath);
      if (existing) {
        if (!existing.isFile() || digest(await fs.readFile(finalPath)) !== sha256) fail(`artifact version v${version} is already sealed with different content`);
      } else { await fs.rename(stagedFile, finalPath); }
      await syncDirectory(versionDir);
      await fs.rm(staging, { recursive: true, force: true });
      return { sha256, size, snapshotPath: path.relative(ws, finalPath) };
    } catch (error) {
      // A failed seal leaves no half-published version; staging is removed when possible and
      // otherwise remains identifiable by listOrphanStaging. Business versions are never deleted.
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  static handleFileRelPath(ticketId, nodeId) { return path.join('.fleet', 'tickets', digest(JSON.stringify(ticketId)), 'handles', `${digest(JSON.stringify(nodeId)).slice(0, 16)}.handle.json`); }
  // Default handle file (handoff manifest): one stable file per Node, rewritten on every fleet_submit so the
  // next Agent (and the user) can read the latest sealed versions, hashes and handoff from disk.
  static async writeHandleFile({ workspaceDir, ticketId, nodeId, handle }) {
    const ws = absolute(workspaceDir, 'workspaceDir');
    id(ticketId, 'ticketId'); id(nodeId, 'nodeId');
    if (!record(handle)) fail('handle must be a record');
    const dir = path.join(ws, '.fleet', 'tickets', digest(JSON.stringify(ticketId)), 'handles');
    await directory(dir);
    const file = path.join(dir, `${digest(JSON.stringify(nodeId)).slice(0, 16)}.handle.json`);
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    try { await writeJSON(tmp, handle); await fs.rename(tmp, file); } catch (error) { await fs.rm(tmp, { force: true }).catch(() => {}); throw error; }
    await syncDirectory(dir);
    return path.relative(ws, file);
  }
  static #deliveryDest(ws, ticketId, deliveryId, target) {
    if (target === undefined || target === null) return path.join(ws, '.fleet', 'tickets', digest(JSON.stringify(ticketId)), 'delivery', deliveryId);
    return absolute(target, 'deliveryTarget');
  }
  // Idempotent export: a complete receipt short-circuits re-delivery after a restart. The receipt
  // is written last so it is the durable completion marker; manifest/files may be rebuilt before it.
  static async exportDelivery({ workspaceDir, ticketId, deliveryId, target, items }) {
    const ws = absolute(workspaceDir, 'workspaceDir');
    id(ticketId, 'ticketId'); id(deliveryId, 'deliveryId');
    if (!Array.isArray(items) || !items.length) fail('delivery items must be a nonempty array');
    const dest = FleetStore.#deliveryDest(ws, ticketId, deliveryId, target);
    const manifestPath = path.join(dest, 'manifest.json'), receiptPath = path.join(dest, 'receipt.json');
    const existingReceipt = await readBytes(receiptPath, true);
    if (existingReceipt !== null) { const receipt = parse(existingReceipt, 'delivery receipt'); return { deliveryId, target: dest, manifestPath, receiptPath, items: receipt.items, reused: true }; }
    await directory(dest);
    const exported = [];
    for (const item of items) {
      if (!record(item)) fail('delivery item must be a record');
      const src = path.join(ws, item.snapshotPath);
      const stat = await checked(src);
      if (!stat?.isFile()) fail(`missing sealed artifact version: ${src}`);
      const bytes = await fs.readFile(src);
      if (digest(bytes) !== item.sha256) fail(`sealed artifact hash mismatch for ${item.artifactId} v${item.version}; storage integrity error`);
      const file = `${item.artifactId}-v${item.version}-${path.basename(src)}`;
      await fs.copyFile(src, path.join(dest, file));
      exported.push({ deliverableIndex: item.deliverableIndex, artifactId: item.artifactId, version: item.version, sha256: item.sha256, file, size: bytes.length });
    }
    const createdAt = new Date().toISOString();
    await fs.rm(manifestPath, { force: true });
    await writeJSON(manifestPath, { deliveryId, ticketId, target: dest, items: exported, createdAt });
    await writeJSON(receiptPath, { deliveryId, ticketId, target: dest, items: exported, completedAt: createdAt });
    await syncDirectory(dest);
    return { deliveryId, target: dest, manifestPath, receiptPath, items: exported, reused: false };
  }
  static async reconcileDelivery({ workspaceDir, ticketId, deliveryId, target }) {
    const ws = absolute(workspaceDir, 'workspaceDir');
    id(ticketId, 'ticketId'); id(deliveryId, 'deliveryId');
    const dest = FleetStore.#deliveryDest(ws, ticketId, deliveryId, target);
    const receiptPath = path.join(dest, 'receipt.json'), manifestPath = path.join(dest, 'manifest.json');
    const bytes = await readBytes(receiptPath, true);
    if (bytes === null) return null;
    const receipt = parse(bytes, 'delivery receipt');
    return { deliveryId, target: dest, manifestPath, receiptPath, items: receipt.items, completedAt: receipt.completedAt };
  }
  // Recovery diagnostics only: orphan staging and sealed-but-unreferenced versions are reported,
  // never auto-deleted. Referenced versions are gathered from the committed Workspace chain.
  static async listOrphanStaging(workspaceDir) {
    const ws = absolute(workspaceDir, 'workspaceDir');
    const ticketsDir = path.join(ws, '.fleet', 'tickets'), staging = [], unreferenced = [], referenced = new Set();
    try {
      const state = await FleetStore.read({ dir: path.join(ws, '.fleet'), kind: 'workspace' });
      for (const t of state?.tickets ?? []) {
        for (const [artifactId, a] of Object.entries(t.execution?.artifacts ?? {})) for (const v of a.versions ?? []) referenced.add(`${artifactId}/v${v.version}`);
        for (const h of t.execution?.delivery?.history ?? []) for (const it of h.items ?? []) referenced.add(`${it.artifactId}/v${it.version}`);
      }
    } catch { /* unreadable chain still yields staging diagnostics */ }
    let hashes;
    try { hashes = await fs.readdir(ticketsDir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return { staging, unreferenced }; throw error; }
    for (const hash of hashes) {
      if (!hash.isDirectory()) continue;
      const artifactsDir = path.join(ticketsDir, hash.name, 'artifacts');
      let entries;
      try { entries = await fs.readdir(artifactsDir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.staging-')) { staging.push(path.relative(ws, path.join(artifactsDir, entry.name))); continue; }
        let versions;
        try { versions = await fs.readdir(path.join(artifactsDir, entry.name), { withFileTypes: true }); } catch { continue; }
        for (const v of versions) if (v.isDirectory() && !referenced.has(`${entry.name}/${v.name}`)) unreferenced.push(path.relative(ws, path.join(artifactsDir, entry.name, v.name)));
      }
    }
    return { staging, unreferenced };
  }
  async close() {
    if (this.#closed) return;
    const draining = this.#queue;
    this.#closed = true;
    await draining;
  }
}
const PRIVATE = Symbol('FleetStore');
export { ticketFilename };
