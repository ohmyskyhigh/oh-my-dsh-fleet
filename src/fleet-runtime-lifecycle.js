import path from 'node:path';
import { stat } from 'node:fs/promises';
import { FleetService } from './fleet-service.js';

/** Root lives beside versioned Fleet packages, beneath the actual Host Profile. */
export function resolveFleetRoot({ rootPath, envRoot = process.env.FLEET_ROOT, profileDir } = {}) {
  const selected = rootPath ?? envRoot ?? (typeof profileDir === 'string' ? path.join(profileDir, 'fleet-packages', 'fleet-global') : undefined);
  if (typeof selected !== 'string' || !path.isAbsolute(selected)) throw new Error('Fleet requires an absolute rootPath/FLEET_ROOT or the Host profileContext.dir.');
  return path.normalize(selected);
}
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.relative(a, b) === '';

/** Owns discovery and execution scheduling. Read requests never initialize or sync. */
export function createFleetRuntimeLifecycle({ workspaceRegistry, profileDir, rootPath, envRoot = process.env.FLEET_ROOT, adapter, maxParallel = 2, pollMs = 1000, logger, openService = options => FleetService.open(options), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let opening, openingError, service, timer, cycle, closing, stopped = false;
  const warn = error => logger?.warn?.(`Fleet lifecycle: ${error.message ?? error}`);
  async function mappings() {
    const result = {};
    for (const workspace of workspaceRegistry.list()) {
      if (typeof workspace?.id !== 'string' || typeof workspace.path !== 'string' || !path.isAbsolute(workspace.path)) continue;
      try {
        if ((await stat(workspace.path)).isDirectory() && samePath(workspaceRegistry.get(workspace.id)?.path, workspace.path)) result[workspace.id] = workspace.path;
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) warn(error); }
    }
    return result;
  }
  async function admitDispatch(input) {
    if (stopped) throw new Error('Fleet runtime is closing; dispatch is suspended.');
    const expected = service?.health.paths.workspacePaths[input.workspaceId];
    const current = workspaceRegistry.get(input.workspaceId);
    if (!expected || !samePath(current?.path, expected)) throw new Error('Host Workspace was removed or relocated; dispatch is suspended.');
    if (!(await stat(expected)).isDirectory() || !samePath(workspaceRegistry.get(input.workspaceId)?.path, expected)) throw new Error('Host Workspace is no longer available; dispatch is suspended.');
  }
  const guardedAdapter = { ...adapter };
  for (const name of ['create', 'submit', 'message', 'recover']) if (typeof adapter[name] === 'function') guardedAdapter[name] = async input => { await admitDispatch(input); return adapter[name](input); };
  async function synchronize(active) {
    const current = await mappings();
    if (stopped) return;
    for (const [id, location] of Object.entries(active.health.paths.workspacePaths)) {
      if (!samePath(current[id], location)) await active.unregisterWorkspace(id);
    }
    for (const [id, location] of Object.entries(current)) {
      if (stopped) return;
      if (!samePath(active.health.paths.workspacePaths[id], location)) {
        try { await active.registerWorkspace(id, location); } catch (error) { warn(error); }
      }
    }
  }
  function schedule() {
    if (stopped || timer || cycle || !service) return;
    timer = setTimer(() => {
      timer = undefined;
      cycle = (async () => { await synchronize(service); if (!stopped) await service.tick(); })().catch(warn).finally(() => { cycle = undefined; schedule(); });
      return cycle;
    }, Math.max(10, pollMs));
    timer?.unref?.();
  }
  async function getService({ readOnly = false } = {}) {
    if (stopped) throw new Error('Fleet runtime is closing.');
    if (readOnly) {
      if (!opening) throw openingError ?? new Error('Fleet runtime has not initialized.');
      return opening;
    }
    if (!opening) {
      openingError = undefined;
      opening = (async () => {
        const selectedRoot = resolveFleetRoot({ rootPath, envRoot, profileDir });
        const workspacePaths = await mappings();
        if (stopped) throw new Error('Fleet runtime is closing.');
        const opened = await openService({ rootPath: selectedRoot, workspacePaths, adapter: guardedAdapter, maxParallel, autoStart: false });
        if (stopped) { await opened.close(); throw new Error('Fleet runtime is closing.'); }
        service = opened; schedule(); return opened;
      })().catch(error => { openingError = error; opening = undefined; throw error; });
    }
    return opening;
  }
  function stop() { stopped = true; if (timer) { clearTimer(timer); timer = undefined; } }
  return Object.freeze({
    getService,
    start() { return getService().catch(error => { warn(error); }); },
    // A public cycle seam supports deterministic lifecycle tests; HTTP never calls it.
    async synchronize() { if (stopped) return; const active = await getService({ readOnly: true }); await synchronize(active); },
    stop,
    close() {
      if (!closing) { stop(); closing = (async () => { await cycle?.catch(() => {}); const active = service ?? await opening?.catch(() => undefined); await active?.close(); })(); }
      return closing;
    }
  });
}
