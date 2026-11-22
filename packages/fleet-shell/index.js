/** Durable, Workspace-owned Fleet UI mode. No Agent or Session execution. */
export const inject = ['storage', 'connection', 'workspaceRegistry'];

const descriptor = Object.freeze({
  name: 'fleet_modes', version: 1, tables: ['workspaces'], hasGlobal: false, layout: 'single'
});
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reply = (value, status = 200) => Response.json(value, {
  status, headers: { 'cache-control': 'no-store' }
});
class RequestFailure extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function apply(ctx) {
  let opening;
  let queue = Promise.resolve();
  let disposed = false;

  // The built-in JSON backend owns its configured root and atomic publication.
  // Its single layout produces <storage-json.root>/fleet_modes.json on first write.
  const open = () => {
    if (!opening) {
      opening = Promise.resolve().then(() => {
        if (!ctx.storage.backend.names().includes('json')) throw new Error('Fleet requires the configured json storage backend.');
        const backend = ctx.storage.backend.get('json');
        if (!backend.kv) throw new Error('The json storage backend has no KV facility.');
        return backend.kv.open(descriptor);
      }).catch(error => { opening = undefined; throw error; });
    }
    return opening;
  };
  const serialize = operation => {
    if (disposed) throw new RequestFailure(503, 'fleet/unavailable', 'Fleet mode storage is closing.');
    const result = queue.then(operation);
    // A failed durable write must not poison subsequent requests.
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const read = async unit => {
    const state = await unit.loadAll();
    if (!isObject(state) || !isObject(state.tables) || !isObject(state.tables.workspaces)) {
      throw new Error('Malformed Fleet mode table.');
    }
    const records = state.tables.workspaces;
    // Validate only currently registered IDs. Stale IDs never become active.
    for (const workspace of ctx.workspaceRegistry.list()) {
      if (!Object.hasOwn(records, workspace.id)) continue;
      const record = records[workspace.id];
      if (!isObject(record) || Object.keys(record).length !== 1 || typeof record.enabled !== 'boolean') {
        throw new Error(`Malformed Fleet mode record for Workspace ${workspace.id}.`);
      }
    }
    return records;
  };
  const project = records => ({
    schemaVersion: 1,
    enabledWorkspaceIds: ctx.workspaceRegistry.list()
      .filter(workspace => Object.hasOwn(records, workspace.id) && records[workspace.id]?.enabled === true)
      .map(workspace => workspace.id)
  });
  const fetch = async request => {
    try {
      return await serialize(async () => {
        let change;
        if (request.method === 'POST') {
          try { change = await request.json(); }
          catch { throw new RequestFailure(400, 'fleet/invalid-request', 'Request body must be JSON.'); }
          if (!isObject(change) || Object.keys(change).length !== 2 ||
              typeof change.workspaceId !== 'string' || change.workspaceId.length === 0 ||
              typeof change.enabled !== 'boolean') {
            throw new RequestFailure(400, 'fleet/invalid-request', 'Expected {workspaceId: string, enabled: boolean}.');
          }
          if (!ctx.workspaceRegistry.get(change.workspaceId)) {
            throw new RequestFailure(404, 'fleet/unknown-workspace', 'Workspace is not registered.');
          }
        } else if (request.method !== 'GET') {
          return reply({ error: { code: 'fleet/method-not-allowed', message: 'Use GET or POST.' } }, 405);
        }
        const unit = await open();
        const records = await read(unit);
        if (change) {
          // Registration can disappear while an earlier request drains or a read awaits.
          if (!ctx.workspaceRegistry.get(change.workspaceId)) {
            throw new RequestFailure(404, 'fleet/unknown-workspace', 'Workspace is not registered.');
          }
          const current = Object.hasOwn(records, change.workspaceId) && records[change.workspaceId].enabled === true;
          if (current !== change.enabled) {
            await unit.putRecord('workspaces', change.workspaceId, { enabled: change.enabled });
            // Publish only after the durable write resolves; failed writes never alter the response projection.
            records[change.workspaceId] = { enabled: change.enabled };
          }
        }
        return reply(project(records));
      });
    } catch (error) {
      return reply({ error: {
        code: error instanceof RequestFailure ? error.code : 'fleet/persistence-error',
        message: error instanceof Error ? error.message : String(error)
      } }, error instanceof RequestFailure ? error.status : 500);
    }
  };

  ctx.effect(() => {
    // Connection owns authentication, owner-principal admission, and exact-route dispatch.
    const unregister = ctx.connection.fetch.register({
      path: '/api/fleet/modes', methods: ['GET', 'POST'], requestBody: 'buffered', fetch
    });
    return async () => {
      disposed = true;
      try { await unregister(); }
      finally {
        await queue;
        const unit = await opening?.catch(() => undefined);
        if (unit) await unit.close();
      }
    };
  }, 'fleet: authenticated mode endpoint and KV lifetime');
}
