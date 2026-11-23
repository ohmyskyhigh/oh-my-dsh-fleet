// Browser host contract fixture only. All Fleet elements come from production client.js.
const React = window.__realRequire('react');
const ReactDOM = window.__realRequire('react-dom/client');
const h = React.createElement;
const bootstrap = await (await fetch('/fixture/bootstrap')).json();
const disposers = [], registrations = [], calls = [], dictionaries = new Map();
function store(initial) {
  let value = initial;
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    listenerCount: () => listeners.size,
    set(next) { value = next; for (const listener of listeners) listener(); } };
}
const workspaceStore = store({ items: bootstrap.workspaces });
const sessionStore = store({ byId: bootstrap.sessions });
const panelStore = store({ activePanelId: null });
const localeStore = store({ active: 'zh' });
const nativeStore = store({ sessionId: 'native-original', revision: 0 });
const nativeDrafts = { 'native-original': '保留这段原生 Session 未发送草稿' };
let nativeMounts = 0, nativeUnmounts = 0;
const mountedSession = store('native-original'), rightTabs = store([]), tabDefinitions = new Map();
const viewDefinitions = store([]);
const conversationViews = {
  register(definition) { viewDefinitions.set([...viewDefinitions.getSnapshot(), definition]); return () => viewDefinitions.set(viewDefinitions.getSnapshot().filter(row => row !== definition)); },
  entries: () => viewDefinitions.getSnapshot(),
  subscribe: viewDefinitions.subscribe, getSnapshot: viewDefinitions.getSnapshot
};
const activeView = store('chat');
function selectPanel(id) { calls.push({ kind: 'panel', id }); panelStore.set({ activePanelId: id }); mountedSession.set(id === null ? nativeStore.getSnapshot().sessionId : undefined); }
function openResource(address) {
  const sessionId = mountedSession.getSnapshot();
  if (!sessionId) throw Error('No mounted native Session');
  const url = new URL(address), parts = url.pathname.slice(1).split('/').map(decodeURIComponent);
  if (url.host !== 'fleet-ticket-draft' || parts[1] !== sessionId) throw Error('Invalid native draft resource scope');
  const definition = [...tabDefinitions.values()].find(row => row.kind === 'fleet-ticket-draft');
  if (!definition) throw Error('Missing native tab definition');
  const tab = { id: address, sessionId, type: definition.id, navigation: { address, params: undefined }, visible: true };
  calls.push({kind:'resource',address,sessionId});
  rightTabs.set([...rightTabs.getSnapshot().filter(row => row.id !== address), tab]);
}
const ctx = {
  effect(factory) { disposers.push(factory()); },
  locale: {
    getSnapshot: localeStore.getSnapshot, subscribe: localeStore.subscribe,
    register(namespace, values) { dictionaries.set(namespace, values); return () => dictionaries.delete(namespace); },
    bind(namespace) { return (key, parameters = {}) => { const language = /^zh(?:[-_]|$)/i.test(localeStore.getSnapshot().active) ? 'zh' : 'en'; return (dictionaries.get(namespace)?.[language]?.[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(parameters, name) ? String(parameters[name]) : match); }; }
  },
  workspaces: { list: workspaceStore }, sessions: { list: sessionStore,
    async create({workspaceId}) {
      calls.push({kind:'create-session',workspaceId});
      const sessionId=`fixture-new-${calls.length}`;
      const response=await fetch('/fixture/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspaceId,sessionId})});
      if(!response.ok)throw Error('Fixture Session registration failed');
      sessionStore.set({byId:{...sessionStore.getSnapshot().byId,[sessionId]:{title:'Fixture blank conversation',workspaceId}}});
      workspaceStore.set({items:workspaceStore.getSnapshot().items.map(item=>item.workspaceId===workspaceId?{...item,sessionIds:[...item.sessionIds,sessionId]}:item)});
      return sessionId;
    },binding:sessionId=>({sessionId})
  },
  conversation:{input:{requestDraftInitialization(binding,options){
    calls.push({kind:'initialize-draft',sessionId:binding.sessionId,options});
    if(nativeDrafts[binding.sessionId])return 'preserved';
    nativeDrafts[binding.sessionId]=options.prompt;return 'applied';
  }}},
  layout: { panelInfo: panelStore, selectPanel },
  uiConversation: { views: conversationViews, binding: () => ({ target: () => null }) },
  sidebarRight: { mounted: mountedSession, openResource },
  sidebarRightTabs: { register(definition) { tabDefinitions.set(definition.id, definition); return () => tabDefinitions.delete(definition.id); } },
  uiWorkspace: {
    startSession(workspaceId, options) {
      calls.push({kind:'start-session',workspaceId,options});
      const sessionId=`fixture-new-${calls.length}`;
      void fetch('/fixture/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspaceId,sessionId})}).then(response=>{if(!response.ok)throw Error('Fixture Session registration failed');
        sessionStore.set({byId:{...sessionStore.getSnapshot().byId,[sessionId]:{title:'Fixture blank conversation',workspaceId}}});
        workspaceStore.set({items:workspaceStore.getSnapshot().items.map(item=>item.workspaceId===workspaceId?{...item,sessionIds:[...item.sessionIds,sessionId]}:item)});
        nativeDrafts[sessionId]=options.prompt;
        nativeStore.set({sessionId,revision:nativeStore.getSnapshot().revision+1});selectPanel(null);
      });
    },
    openSession(id) { calls.push({ kind: 'session', id }); nativeStore.set({ sessionId: id, revision: nativeStore.getSnapshot().revision + 1 }); selectPanel(null); },
    async openWorkspace(id) { calls.push({ kind: 'new-session', workspaceId: id }); const sessionId = `fixture-new-${calls.length}`; sessionStore.set({ byId: { ...sessionStore.getSnapshot().byId, [sessionId]: { title: 'Fixture blank conversation', workspaceId: id } } }); workspaceStore.set({items:workspaceStore.getSnapshot().items.map(item=>item.workspaceId===id?{...item,sessionIds:[...item.sessionIds,sessionId]}:item)}); nativeStore.set({ sessionId, revision: nativeStore.getSnapshot().revision + 1 }); selectPanel(null); }
  },
  slots: {
    inject(name, factory) { const result = factory(); if (result?.[Symbol.iterator]) for (const dispose of result) disposers.push(dispose); else disposers.push(result); },
    register(options, component) { const entry = { options, component }; registrations.push(entry); return () => { const index = registrations.indexOf(entry); if (index !== -1) registrations.splice(index, 1); }; },
    provideRoot() { throw new Error('Fixture rejects replacement of native root hooks'); }
  }
};
if (!window.__fleetProductionPlugin?.apply) throw new Error('Production Client did not register a plugin');
window.__fleetProductionPlugin.apply(ctx);

const styles = document.createElement('style');
styles.textContent = `
:root {font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px;color-scheme:light;--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#0a0a0a;--dsw-alias-label-secondary:#737373}
:root[data-theme=dark] {color-scheme:dark;--dsw-alias-bg-base:#0a0a0a;--dsw-alias-label-primary:#fafafa;--dsw-alias-label-secondary:#a3a3a3}
html,body {margin:0;min-width:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
#fixture-root {min-width:0;height:100dvh;display:flex;flex-direction:column}
.fixture-bar {flex:none;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid #8883;font-size:11px}
.fixture-bar span {flex:1;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.fixture-bar button {font:inherit;padding:5px 9px;background:var(--dsw-alias-bg-base);color:inherit;border:1px solid #8884;border-radius:6px;cursor:pointer}
.fixture-main {display:flex;flex:1;min-width:0;min-height:0}
.fixture-native {box-sizing:border-box;padding:32px;max-width:900px;width:100%;margin:auto}
.fixture-native textarea {box-sizing:border-box;width:100%;min-height:160px;padding:12px;font:inherit;background:var(--dsw-alias-bg-base);color:inherit;border:1px solid #8886;border-radius:8px}
.fixture-native p {line-height:1.7;overflow-wrap:anywhere}
`;
document.head.append(styles);
const useStore = source => React.useSyncExternalStore(source.subscribe, source.getSnapshot);
function Slot({ entry, sessionId, tab }) {
  const injected = entry.options.inject?.(sessionId) ?? {};
  const props = { ...injected, t: ctx.locale.bind(entry.options.locale), ...(tab ? {useTabInfo:()=>({tab})} : {}) };
  const hooks = injected.hooks ?? {};
  for (const [name, source] of Object.entries(hooks)) props['use' + name[0].toUpperCase() + name.slice(1)] = selector => selector(useStore(source));
  return h(entry.component, props);
}
function NativeConversation() {
  const { sessionId } = useStore(nativeStore);
  const [draft, setDraft] = React.useState(nativeDrafts[sessionId] ?? '');
  React.useEffect(() => { nativeMounts++; return () => { nativeUnmounts++; }; }, []);
  React.useEffect(() => setDraft(nativeDrafts[sessionId] ?? ''), [sessionId]);
  return h('section', { className: 'fixture-native', 'data-native-conversation': '', 'data-native-session': sessionId },
    h('h1', null, 'Native Conversation fixture'),
    ...registrations.filter(row=>row.options.name==='conversation.session.header.actions').map(entry=>h(Slot,{key:entry.options.id,entry,sessionId})),
    h('p', null, '此处仅模拟宿主 Session、Conversation 重挂与草稿存储。Fleet 使用生产 Client 和真实 React；这不是 Desktop 验收。'),
    h('p', null, sessionId),
    h('textarea', { 'aria-label': 'Native draft', value: draft, onChange: event => { nativeDrafts[sessionId] = event.target.value; setDraft(event.target.value); } }));
}
function RightSidebar() {
  const sessionId=useStore(mountedSession),tabs=useStore(rightTabs).filter(tab=>tab.sessionId===sessionId);
  return tabs.length?h('aside',{'data-native-right-sidebar':'',style:{width:560,maxWidth:'60vw',flexShrink:0,overflow:'auto',borderLeft:'1px solid #8884'}},tabs.map((tab,index)=>{
    const entry=registrations.find(row=>row.options.name==='sidebar.right.pane.tab'&&row.options.key===tab.type);
    return h('div',{key:tab.id,style:{display:index===tabs.length-1?'block':'none'}},h('button',{'data-fixture-close-draft':'',onClick:()=>rightTabs.set(rightTabs.getSnapshot().filter(row=>row.id!==tab.id))},'Close artifact'),entry?h(Slot,{entry,sessionId,tab}):null);
  })):null;
}
function SessionViewTabs() {
  const current = useStore(activeView);
  useStore(viewDefinitions);
  const entries = registrations.filter(row => row.options.name === 'conversation.view');
  const open = id => { selectPanel(null); activeView.set(id); };
  return h('div', { className: 'fixture-bar', 'data-fixture-view-tabs': '' },
    h('button', { type: 'button', 'data-fixture-view-tab': 'chat', 'aria-pressed': current === 'chat', onClick: () => open('chat') }, 'Chat'),
    ...entries.map(entry => {
      const label = entry.options.label ? entry.options.label() : entry.options.id;
      return h('button', { key: entry.options.id, type: 'button', 'data-fixture-view-tab': entry.options.id, 'aria-pressed': current === entry.options.id, onClick: () => open(entry.options.id) }, label);
    }));
}
function App() {
  const panel = useStore(panelStore).activePanelId;
  const current = useStore(activeView);
  const sessionId = useStore(nativeStore).sessionId;
  const entry = registrations.find(item => item.options.name === 'main' && (item.options.key === panel || item.options.id === panel));
  const viewEntry = current !== 'chat' ? registrations.find(row => row.options.name === 'conversation.view' && row.options.id === current) : null;
  return h(React.Fragment, null,
    h('div', { className: 'fixture-bar' }, h('span', null, `ISOLATED FIXTURE · React ${React.version} · production Fleet Client · fake execution adapter`),
      h('button', { type: 'button', 'data-fixture-control': '', onClick: () => selectPanel('dsh-fleet-control') }, 'Fleet 中控台'),
      h('button', { type: 'button', 'data-fixture-native': '', onClick: () => selectPanel(null) }, '原生会话 fixture')),
    h(SessionViewTabs),
    h('main', { className: 'fixture-main' }, entry ? h(Slot, { key: panel, entry }) : viewEntry ? h(Slot, { key: current, entry: viewEntry, sessionId }) : h(NativeConversation), h(RightSidebar)));
}
const root = ReactDOM.createRoot(document.getElementById('fixture-root'));
root.render(h(App));
window.__fleetFixture = {
  ready: true, reactVersion: React.version,
  snapshot() { return JSON.parse(JSON.stringify({ calls, panel: panelStore.getSnapshot(), native: nativeStore.getSnapshot(), nativeDrafts, nativeMounts, nativeUnmounts, locale: localeStore.getSnapshot(), localeSubscribers: localeStore.listenerCount(), conversationViews: registrations.filter(row => row.options.name === 'conversation.view').map(row => row.options.id), activeView: activeView.getSnapshot(), registeredSlots: registrations.map(row => ({ name: row.options.name, key: row.options.key ?? row.options.id })) })); },
  language(active) { if (!['zh', 'en'].includes(active)) throw new Error('Fixture Host language must be zh or en'); localeStore.set({ active }); },
  openResource, openSession: id => ctx.uiWorkspace.openSession(id),
  theme(value) { document.documentElement.dataset.theme = value; },
  async unload() { root.unmount(); for (const dispose of disposers.reverse()) if (typeof dispose === 'function') await dispose(); styles.remove(); }
};
