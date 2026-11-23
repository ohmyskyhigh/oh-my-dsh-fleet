import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createDshAdapter, adapterInject } from './src/fleet-dsh-adapter.js';
import { registerFleetChat } from './src/fleet-chat.js';
import { registerFleetDashboardApi } from './src/fleet-dashboard-api.js';
import { createFleetRuntimeLifecycle } from './src/fleet-runtime-lifecycle.js';

export const name = 'fleet-runtime';
export const inject = [...new Set(['tools', 'commands', 'connection', 'workspaceRegistry', 'profileContext', ...adapterInject])];

/** Shared native Chat/Dashboard lifecycle; Profile-owned Root survives package upgrades. */
export function apply(ctx, config = {}) {
  const lifecycle = createFleetRuntimeLifecycle({ workspaceRegistry: ctx.workspaceRegistry, profileDir: ctx.profileContext?.dir, rootPath: config.rootPath, adapter: createDshAdapter(ctx), maxParallel: config.maxParallel ?? 2, pollMs: config.pollMs ?? 1000, logger: ctx.logger });
  const resolveAgentContext = agent => {
    const sessionId = agent.id ?? agent.session?.id ?? agent.session?.header?.id;
    const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(sessionId));
    return workspace ? { sessionId, workspaceId: workspace.id, workspacePath: workspace.path } : null;
  };
  ctx.effect(() => {
    const disposeChat = registerFleetChat(ctx, { getService: lifecycle.getService, resolveAgentContext, defineTool, createUserMessage });
    let disposeDashboard;
    try { disposeDashboard = registerFleetDashboardApi(ctx, { getService: lifecycle.getService }); }
    catch (error) { disposeChat(); lifecycle.stop(); throw error; }
    // Discovery and cold reopening belong to this lifecycle, never GET handlers.
    lifecycle.start();
    return async () => {
      lifecycle.stop();
      try {
        const results = await Promise.allSettled([Promise.resolve().then(disposeChat), Promise.resolve().then(disposeDashboard)]);
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Fleet runtime registration cleanup failed.');
      } finally { await lifecycle.close(); }
    };
  }, 'fleet: durable runtime, native Chat and authenticated Dashboard');
}
