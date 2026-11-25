// Isolated browser fixture. Imports production domain/API code; never starts DSH.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createDshAdapter } from '../../src/fleet-dsh-adapter.js';
import { FleetService } from '../../src/fleet-service.js';
import { registerFleetDashboardApi } from '../../src/fleet-dashboard-api.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const clone = value => structuredClone(value);
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const text = (value, type = 'text/javascript; charset=utf-8') => new Response(value, { headers: { 'content-type': type, 'cache-control': 'no-store' } });

export async function removeOwnedTemp(directory, prefix) {
  const resolved = path.resolve(directory);
  assert.equal(resolved, directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith(prefix));
  const info = await fs.lstat(resolved);
  assert(info.isDirectory() && !info.isSymbolicLink());
  await fs.readdir(resolved);
  await fs.rm(resolved, { recursive: true, force: true });
}

async function reactRuntime() {
  const reactDir = path.dirname(require.resolve('react/package.json'));
  const domDir = path.dirname(require.resolve('react-dom/package.json'));
  const domRequire = createRequire(path.join(domDir, 'package.json'));
  const schedulerDir = path.dirname(domRequire.resolve('scheduler/package.json'));
  const sources = [
    ['react', path.join(reactDir, 'cjs/react.production.js')],
    ['react-dom', path.join(domDir, 'cjs/react-dom.production.js')],
    ['scheduler', path.join(schedulerDir, 'cjs/scheduler.production.js')],
    ['react-dom/client', path.join(domDir, 'cjs/react-dom-client.production.js')]
  ];
  const factories = await Promise.all(sources.map(async ([id, file]) => `${JSON.stringify(id)}: function(module,exports,require){\n${await fs.readFile(file, 'utf8')}\n}`));
  return `// Unmodified installed production CJS modules, wrapped only for browser require.\n(()=>{const factories={${factories.join(',\n')}};const cache={};window.__realRequire=id=>{if(cache[id])return cache[id].exports;if(!factories[id])throw Error('Unknown fixture CJS module '+id);const module={exports:{}};cache[id]=module;factories[id](module,module.exports,window.__realRequire);return module.exports;};window.__ModuleLoader__={load:entry=>{if(entry.id!=='@dsh-fleet/shell')throw Error('Unexpected Client module');window.__fleetProductionPlugin=entry.factory(window.__realRequire);}};})();`;
}

function adapterFixture() {
  const calls = [], sessions = new Map(), definitions = new Map();
  return { calls, sessions, definitions, adapter: {
    async create(input) {
      calls.push({ method: 'create', input: clone(input) });
      const sessionId = `fixture-session-${sessions.size + 1}`;
      sessions.set(sessionId, { status: 'unknown' }); definitions.set(sessionId, clone(input));
      return { sessionId };
    },
    async submit(input) { calls.push({ method: 'submit', input: clone(input) }); sessions.set(input.sessionId, { status: 'running' }); return { messageId: input.requestId }; },
    async inspect(input) { calls.push({ method: 'inspect', input: clone(input) }); return clone(sessions.get(input.sessionId) ?? { status: 'unknown' }); },
    async cancel(input) { calls.push({ method: 'cancel', input: clone(input) }); sessions.set(input.sessionId, { status: 'stopped' }); return { stopped: true }; },
    async message(input) { calls.push({ method: 'message', input: clone(input) }); return { messageId: input.requestId }; },
    async modelCatalog() { return clone(fixtureModelCatalog); }
  } };
}
const fixtureModelCatalog = { default: { provider: 'fixture', model: 'fixture-default', reasoningEffort: 'low' }, routableProviders: ['fixture'], groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'fixture-default', name: 'Fixture Default', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }, { id: 'fixture-fast', name: 'Fixture Fast' }] }], failures: [] };

export async function createFleetUIFixture({scheduleAdapter={}}={}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-ui-model-'));
  const rootPath = path.join(temp, 'root');
  const workspacePaths = Object.fromEntries(['alpha', 'beta', 'empty'].map(id => [id, path.join(temp, id)]));
  await Promise.all(Object.values(workspacePaths).map(value => fs.mkdir(value)));
  const host = adapterFixture();
  Object.assign(host.adapter,scheduleAdapter);
  const service = await FleetService.open({ rootPath, workspacePaths: {}, adapter: host.adapter, autoStart: false, maxParallel: 16 });
  const registry = new Map(Object.entries(workspacePaths).map(([id, location]) => [id, { id, path: location, sessionIds: id === 'alpha' ? ['native-original', 'seed'] : [] }]));
  const routes = new Map(), requests = [], failures = new Map();
  const enabled = new Set(['alpha', 'beta', 'empty']);
  const ctx = {
    workspaceRegistry: { get: id => registry.get(id), list: () => [...registry.values()] },
    agentPresets: { list: async () => [{ id: 'fixture-preset', name: 'Fixture execution adapter' }] },
    connection: { fetch: { register(route) { assert(!routes.has(route.path)); routes.set(route.path, route); return () => routes.delete(route.path); } } }
  };
  const disposeApi = registerFleetDashboardApi(ctx, { getService: async () => service });
  const definition = {
    nodes: [
      { id: 'build', role: 'writer', agentId:'writer',dependsOn:[],task: { prompt: '完成源码变更，记录接口与可复现验证。', contract: { acceptance: ['The artifact contains a verifiable result.'], scope: { in: ['report/'], out: ['fleet configuration'] }, verify: ['fixture-check --report'] } } },
      { id: 'ship', role: 'reviewer',agentId:'reviewer',dependsOn:[],task: { prompt: '核对验收证据，整理交付文件和剩余限制。' } }
    ],
    gates: [{ id: 'quality', from: ['build'], to: ['ship'], reviewer: { kind: 'human' } }]
  };
  const evidenceGates = [{ id: 'quality', from: ['build'], to: ['ship'], reviewer: { kind: 'human' }, requireEvidence: true, rework: { maxRounds: 2, scopeNote: 'Only revise the delivered artifact.' } }];
  const agents={writer:{profile:{instructions:'负责实现与验证。提供文件、结果和证据。',agentPreset:'fixture-preset'}},reviewer:{profile:{instructions:'独立检查交付内容和验收标准，保留评审意见。',agentPreset:'fixture-preset'}}};
  const human = (ws, method, args) => service.human(ws, 'fixture-seed', method, args);
  await service.registerWorkspace('alpha', workspacePaths.alpha);
  // Root templates are explicitly authored first; each Ticket then receives its own
  // detached value copy and explicit provenance. No binding or start-time materialization.
  for(const [id,content] of Object.entries(agents))await human('alpha','saveTemplate',[{id,kind:'agent',name:id,content}]);
  await human('alpha','saveTemplate',[{id:'delivery-flow',kind:'orchestration',name:'Delivery flow',content:definition}]);
  const sourceRefs=[...Object.keys(agents).map(id=>({kind:'agent',templateId:id,templateRevision:1,localId:id})),{kind:'orchestration',templateId:'delivery-flow',templateRevision:1,nodeIds:['build','ship']}];
  const planFor=(goal,extra={})=>({contractVersion:3,goal,inputs:{fixture:true,outputDirectory:'deliverables',note:'Fixture Ticket resources'},deliverables:['独立交付文件'],criteria:['可复现验证'],requirements:'保留原始需求与验收依据',agents:clone(agents),nodes:clone(definition.nodes),gates:clone(definition.gates),...extra});
  const saveSeed=(ws,id,goal,extra={})=>service.saveDraftTicket(ws,{id,sessionId:'seed',actor:{kind:'system',via:'fixture-seed'},plan:planFor(goal,extra),sourceRefs});
  await saveSeed('alpha','running','更新 Fleet 工作区界面',{inputs:{source:'fixture specification'},criteria:['保留执行证据','原生 Session 独立']});
  for (const [id, goal] of [
    ['waiting', '核对发布清单与测试证据'], ['failed', '处理上游接口连接失败'],
    ['draft', '准备下一轮文档和源码审查'], ['delivered', '交付工作区数据报告'], ['returned', '补充缺失的验收依据'],
    ['stale', '复核过期审核结论'], ['evidence', '凭证据完成人工审核']
  ]) await saveSeed('alpha',id,goal,id==='evidence'?{gates:clone(evidenceGates)}:id==='returned'?{gates:clone(definition.gates).map(g=>({...g,rework:{maxRounds:0}}))}:{});
  // 0.7.0 clarity seed: dual-layer deliverables, node summaries and model selections (kept draft until the browser check starts it).
  const clarityAgents = clone(agents);
  clarityAgents.writer.profile.modelSelection = { provider: 'fixture', model: 'fixture-default', reasoningEffort: 'low' };
  const clarityNodes = clone(definition.nodes);
  clarityNodes[0].task.summary = '我会完成源码变更并记录可复现验证，交付可审核的实现结果';
  clarityNodes[0].modelSelection = { provider: 'fixture', model: 'fixture-fast' };
  clarityNodes[1].task.summary = '我会核对验收证据并整理交付文件，达成可交付状态';
  await saveSeed('alpha', 'clarity', '双层交付物与节点模型配置', {
    deliverables: [
      { title: '实现报告', description: '源码变更的结论与可复现验证证据', text: 'report.md：变更说明、验证命令与退出码', criteria: ['报告含可复现验证\n命令与退出码齐全'] },
      '遗留字符串交付物'
    ],
    criteria: ['整单：保留执行证据与原生 Session 边界'],
    agents: clarityAgents, nodes: clarityNodes,
    gates: [...clone(definition.gates), {id:'agent-quality',from:['build'],to:['ship'],reviewer:{kind:'agent',nodeId:'ship'},reviewTask:{summary:'核对报告的证据',inputs:['报告草稿'],checks:['核对每条引用']},plannedCapabilities:[{kind:'skill',id:'citation-check',purpose:'复核引用位置'}]}]
  });
  for (const id of ['running', 'waiting', 'failed', 'delivered', 'returned', 'stale', 'evidence']) await human('alpha', 'start', [id]);
  await service.registerWorkspace('beta', workspacePaths.beta);
  await saveSeed('beta','running','Beta 独立工作区任务',{inputs:{},criteria:['工作区互相隔离']});
  await human('beta', 'start', ['running']);
  await service.tick();
  async function settle(ws, ticketId, nodeId, result) {
    const ticket = await service.read(ws, ticketId);
    const sessionId = ticket.execution.nodes[nodeId].attempts.at(-1).sessionId;
    host.sessions.set(sessionId, clone(result));
    await service.tick();
  }
  const evidencePayload = { acceptanceResults: [{ criterion: 'The artifact contains a verifiable result.', status: 'passed', evidence: 'Fixture verification output attached.' }], verification: [{ command: 'fixture-check --report', exitCode: 0, output: 'OK', source: 'agent-report' }], summary: 'Fixture completion evidence.' };
  // P-44/P-46: seal real workspace files through the production submitEvidence path while the Attempt runs.
  async function submitNodeEvidence(ticketId, nodeId, file) {
    await fs.writeFile(path.join(workspacePaths.alpha, file.name), file.content);
    const ticket = await service.read('alpha', ticketId);
    const sessionId = ticket.execution.nodes[nodeId].attempts.at(-1).sessionId;
    return service.submitEvidence({ sessionId, payload: { artifacts: [{ path: file.name, deliverableIndex: 0, mediaType: 'text/markdown' }], ...evidencePayload } });
  }
  await submitNodeEvidence('delivered', 'build', { name: 'delivered-report.md', content: '# Delivered report v1\n' });
  const staleV1 = await submitNodeEvidence('stale', 'build', { name: 'stale-report-v1.md', content: '# Stale report v1\n' });
  await submitNodeEvidence('stale', 'build', { name: 'stale-report-v2.md', content: '# Stale report v2\n' });
  await submitNodeEvidence('evidence', 'build', { name: 'evidence-report.md', content: '# Evidence report v1\n' });
  for (const id of ['waiting', 'delivered', 'returned', 'stale', 'evidence']) await settle('alpha', id, 'build', { status: 'completed', output: { artifact: `${id}-result.txt`, checks: ['fixture verification passed'] } });
  // Simulate an older completed Ticket whose native log predates Fleet thread mirroring.
  const historical=(await service.read('alpha','waiting')).execution.nodes.build.attempts.at(-1);
  const started=Date.parse(historical.startedAt);
  const events=[['turn/start',{turn:1}],['user/message',{source:{kind:'user',rpcId:`fleet-${historical.id}`}}],['step/start',{turn:1,step:1}],['tool/call',{turn:1,step:1,name:'read'}],['assistant/message',{turn:1,step:1,message:{content:[{type:'text',text:'发布清单和测试结果已核对。'}]}}],['turn/end',{turn:1,reason:{kind:'completed'}}]].map(([type,data],seq)=>({seq,type,data,time:started+seq}));
  const native=createDshAdapter({sessionQuery:{async readSession(){return {events};}}});
  const inspect=host.adapter.inspect;
  host.adapter.inspect=input=>input.sessionId===historical.sessionId?native.inspect(input):inspect(input);
  await settle('alpha', 'failed', 'build', { status: 'failed', error: 'Fixture upstream connection failure; retry after recovery.' });
  await human('alpha', 'reviewGate', ['returned', 'quality', 'returned', '缺少校验结果，保留此意见供人工决定时核对。']);
  await human('alpha', 'reviewGate', ['delivered', 'quality', 'passed', '交付证据齐全。']);
  // P-45: an explicit older binding stays stale against the newer sealed version and blocks delivery.
  await human('alpha', 'reviewGate', ['stale', 'quality', 'passed', { text: 'Reviewed the older version.', artifactRefs: [{ artifactId: staleV1.artifacts[0].artifactId, version: 1, sha256: staleV1.artifacts[0].sha256 }] }]);
  await service.tick();
  await settle('alpha', 'delivered', 'ship', { status: 'completed', output: { files: ['report.md', 'results.json'], verification: 'deterministic adapter output' } });
  await settle('alpha', 'stale', 'ship', { status: 'completed', output: { files: ['stale-report.md'], verification: 'deterministic adapter output' } });
  await human('alpha', 'commentNode', ['running', 'build', '请保留旧 Ticket snapshot，验证不同 Workspace 的草稿隔离。']);
  await service.tick();
  const seed = { alpha: await service.read('alpha'), beta: await service.read('beta') };
  assert.equal(seed.alpha.find(t => t.id === 'delivered').status, 'delivered', 'declared deliverables need bound evidence and a real export before delivered');
  assert.ok(seed.alpha.find(t => t.id === 'delivered').execution.delivery.history.length > 0, 'delivery history records the export');
  assert.equal(seed.alpha.find(t => t.id === 'stale').status, 'running', 'stale coverage blocks delivered');
  assert.equal(seed.alpha.find(t => t.id === 'evidence').status, 'running');
  assert.ok(seed.alpha.find(t => t.id === 'evidence').execution.nodes.build.attempts.at(-1).completion, 'evidence seed carries a completion record');
  const runtime = await reactRuntime();
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><title>Fleet production Client · isolated React fixture</title></head><body><div id="fixture-root"></div><script src="/fixture/react-runtime.js"></script><script src="/production/client.js"></script><script type="module" src="/fixture/host.mjs"></script></body></html>`;
  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, 'http://127.0.0.1');
      const buffers = []; for await (const chunk of incoming) buffers.push(chunk);
      const body = Buffer.concat(buffers);
      let response;
      if (routes.has(url.pathname)) {
        const request = new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers: incoming.headers, ...(body.length ? { body } : {}) });
        const parsed = incoming.method === 'POST' ? JSON.parse(body.toString()) : null;
        const faultKey = parsed?.action ?? (url.pathname.endsWith('/view') ? 'view' : url.pathname);
        const fail = failures.get(faultKey);
        const evidence = { method: incoming.method, path: incoming.url, ...(parsed ? { body: parsed } : {}), fixtureFailure: !!fail };
        requests.push(evidence);
        if (fail) { failures.delete(faultKey); response = json({ schemaVersion: 1, error: { code: 'fixture/injected', message: fail } }, 503); }
        else {
          response = await routes.get(url.pathname).fetch(request);
          // A deterministic fixture scheduler tick follows an accepted action.
          // The production API handler itself is unchanged and shares this service.
          if (incoming.method === 'POST' && response.ok) await service.tick();
        }
        evidence.status = response.status;
      } else if (url.pathname === '/api/fleet/modes') {
        if (incoming.method === 'POST') { const change = JSON.parse(body.toString()); if (change.enabled) enabled.add(change.workspaceId); else enabled.delete(change.workspaceId); }
        response = json({ schemaVersion: 1, enabledWorkspaceIds: [...enabled] });
      } else if (url.pathname === '/fixture/session' && incoming.method === 'POST') {
        const {workspaceId,sessionId}=JSON.parse(body.toString());
        const workspace=registry.get(workspaceId);
        if(!workspace||typeof sessionId!=='string'||!sessionId.startsWith('fixture-new-'))response=json({error:'Invalid fixture Session'},400);
        else {if(!workspace.sessionIds.includes(sessionId))workspace.sessionIds.push(sessionId);response=json({workspaceId,sessionId});}
      } else if (url.pathname === '/fixture/bootstrap') {
        const workspaces = [...registry.values()].map(item => ({ workspaceId: item.id, path: item.path, title: ({ alpha: 'Fleet UI · Alpha', beta: 'Fleet UI · Beta', empty: 'Empty Workspace' })[item.id], sessionIds: [...item.sessionIds] }));
        const byId = { 'native-original': { title: '原生 Conversation fixture', workspaceId: 'alpha' } };
        for (const [id, input] of host.definitions) { byId[id] = { title: input.title, workspaceId: input.workspaceId }; workspaces.find(w => w.workspaceId === input.workspaceId).sessionIds.push(id); }
        response = json({ workspaces, sessions: byId });
      } else if (url.pathname === '/api/file') {
        // Mirrors the host media-references route: absolute path required, workspace-confined reads,
        // extension Content-Type and no-store/nosniff/sandbox headers. Lets checks verify real sealed bytes.
        const target = url.searchParams.get('path');
        if (!target || !path.isAbsolute(target)) response = json({ error: 'absolute path required' }, 400);
        else {
          const resolved = path.resolve(target);
          const allowed = Object.values(workspacePaths).some(wsRoot => resolved === wsRoot || resolved.startsWith(wsRoot + path.sep));
          if (!allowed) response = json({ error: 'forbidden' }, 403);
          else {
            try {
              const data = await fs.readFile(resolved);
              const type = ({ '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8' })[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
              response = new Response(data, { status: 200, headers: { 'content-type': type, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'" } });
            } catch { response = json({ error: 'not found' }, 404); }
          }
        }
      } else if (url.pathname === '/fixture/react-runtime.js') response = text(runtime);
      else if (url.pathname === '/production/client.js') response = text(await fs.readFile(path.join(root, 'client.js'), 'utf8'));
      else if (url.pathname === '/fixture/host.mjs') response = text(await fs.readFile(new URL('./fleet-ui-host.mjs', import.meta.url), 'utf8'));
      else if (url.pathname === '/') response = text(html, 'text/html; charset=utf-8');
      else response = json({ error: 'Unknown fixture route' }, 404);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { outgoing.writeHead(500, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ error: String(error.stack ?? error) })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.notEqual(server.address().port, 2399);
  return { origin, temp, rootPath, workspacePaths, service, host, requests, seed,
    failNext(key, message = `Fixture ${key} temporarily unavailable; retry this action.`) { failures.set(key, message); },
    async close() {
      await disposeApi();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await service.close();
      await removeOwnedTemp(temp, 'fleet-ui-model-');
    }
  };
}
