// Focused Session-entry integration checks: real plugin/draft client, mocked DSH and React hooks.
// No native Sessions, real Workspace storage, or model requests are used.
// Entry contract: no conversation-header button and no auto-opened editor; the side-pane
// resource mounts the shared Dashboard Ticket detail pinned to its draftId, and legacy
// recreation runs from that pane (same handler as the Session tab / fullscreen panel).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createFleetPlugin } from '../src/fleet-client.js';

const scope={workspaceId:'w1',sessionId:'s1'};
const PANE_KEY='oh-my-agent-fleet/ticket-draft';
const PANE_ADDRESS='dsh-resource://fleet-ticket-draft/w1/s1/old-draft';
const plan={contractVersion:3,goal:'Preserve original needs',inputs:{},deliverables:[],criteria:[],agents:{},nodes:[],gates:[]};
const legacy=()=>({id:'old-draft',workspaceId:'w1',originSessionId:'s1',revision:2,status:'draft',plan:{ticket:{goal:'Preserve original needs',criteria:[{text:'Structured criterion'}]}},execution:null,activity:[]});
const response=body=>({ok:true,json:async()=>structuredClone(body)});
const noop=()=>{};
function observable(value){const listeners=new Set();return {getSnapshot:()=>value,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},set:next=>{value=next;for(const listener of listeners)listener();}};}
const all=tree=>tree&&typeof tree==='object'?[tree,...(tree.children??[]).flat(Infinity).flatMap(all)]:[];
const button=(tree,key,value)=>all(tree).find(node=>node.type==='button'&&node.props[key]===value);

async function harness(t,{creationError=null}={}) {
  const rows=[],disposers=[],calls=[],requests=[];
  let sessionTicket=legacy();const workspaceTicket=legacy();
  const workspaces=observable({items:[{workspaceId:'w1',path:'G:/fixture',sessionIds:['s1']}]}),mounted=observable('s1'),panelInfo=observable({activePanelId:null}),localeState=observable({active:'zh'}),dictionaries=new Map();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{
    requests.push({url,method:options.method??'GET'});assert.equal(options.method??'GET','GET','These actions must not write a Ticket');
    if(url==='/api/fleet/modes')return response({schemaVersion:1,enabledWorkspaceIds:['w1']});
    if(url.startsWith('/api/fleet/view?'))return response({schemaVersion:1,workspaceId:'w1',tickets:[workspaceTicket],catalog:{agents:[],orchestrations:[]},health:{ready:true}});
    if(url.startsWith('/api/fleet/drafts?'))return response({schemaVersion:1,workspaceId:'w1',drafts:[sessionTicket],selectedDraft:sessionTicket});
    throw Error('Unexpected request: '+url);
  };
  t.after(()=>{for(const dispose of disposers.reverse())dispose?.();globalThis.fetch=originalFetch;});
  const ctx={
    effect:fn=>{disposers.push(fn());},
    locale:{getSnapshot:localeState.getSnapshot,subscribe:localeState.subscribe,register:(name,value)=>{dictionaries.set(name,value);return()=>dictionaries.delete(name);},bind:name=>key=>dictionaries.get(name)?.[localeState.getSnapshot().active]?.[key]??key},
    workspaces:{list:workspaces},
    sessions:{list:observable({byId:{s1:{title:'Original conversation'}}}),create:async args=>{calls.push(['create',args]);if(creationError)throw Error(creationError);return 'fresh-session';},binding:sessionId=>({sessionId})},
    uiWorkspace:{openSession:sessionId=>{calls.push(['open',sessionId]);mounted.set(sessionId);},openWorkspace:noop},
    conversation:{input:{requestDraftInitialization:(binding,args)=>{calls.push(['prefill',binding,args]);return 'applied';}}},
    layout:{panelInfo,selectPanel:activePanelId=>panelInfo.set({activePanelId})},
    sidebarRight:{mounted,openResource:address=>calls.push(['resource',address])},sidebarRightTabs:{register:()=>noop},
    slots:{inject:(_name,fn)=>{const result=fn();if(result?.[Symbol.iterator])for(const dispose of result)disposers.push(dispose);else disposers.push(result);},register:(options,component)=>{rows.push({options,component});return noop;}}
  };
  const React={createElement:(type,props,...children)=>({type,props:props??{},children}),Fragment:'fragment',useRef:()=>({current:null}),useEffect:noop};
  createFleetPlugin(()=>React).apply(ctx);await setImmediate();
  function render(id){const row=rows.find(item=>item.options.id===id||item.options.key===id);assert.ok(row,`Missing slot ${id}`);const injected=row.options.inject?.('s1')??{},props={sessionId:'s1',useTabInfo:()=>({tab:{navigation:{address:PANE_ADDRESS}}})};for(const [name,store] of Object.entries(injected.hooks??{}))props['use'+name[0].toUpperCase()+name.slice(1)]=select=>select(store.getSnapshot());return row.component(props);}
  const paneRow=rows.find(row=>row.options.key===PANE_KEY),draftClient=paneRow.options.inject('s1').hooks.fleetDrafts;
  const pane=()=>render(PANE_KEY);
  return {calls,requests,rows,pane,render,draftClient,workspaceTicket,
    updateSession:async next=>{sessionTicket=next;await draftClient.load({...scope,draftId:next.id},{force:true});},
    loadWorkspace:async()=>{
      const settings=button(render('dsh-fleet-control'),'data-fleet-root-tab','settings');
      assert.ok(settings,'Workspace settings is available from Fleet overview');
      settings.props.onClick();
      const open=button(render('dsh-fleet-control'),'data-fleet-open','w1');
      assert.ok(open,'Workspace settings shows the enabled workspace entry');
      open.props.onClick();
      await setImmediate();
      ctx.layout.selectPanel(null);
    },
    language:value=>localeState.set({active:value})};
}

test('the header entry is gone and draft polling never opens a resource on its own',async t=>{
  const h=await harness(t);await h.loadWorkspace();
  assert.equal(h.rows.some(row=>row.options.name==='conversation.session.header.actions'),false,'no conversation-header draft button may be registered');
  assert.ok(h.rows.some(row=>row.options.name==='sidebar.right.pane.tab'&&row.options.key===PANE_KEY),'the explicit draft resource pane stays registered');
  await h.draftClient.poll();await h.updateSession({...legacy(),revision:3});
  assert.equal(h.calls.some(([kind])=>kind==='resource'),false,'new drafts and revisions must not auto-open the side pane');
});

test('the side pane mounts the shared Dashboard Ticket detail pinned to its resource draft',async t=>{
  const h=await harness(t);await h.loadWorkspace();
  const pane=h.pane();
  assert.equal(pane.props['data-fleet-surface'],'side-pane');
  assert.equal(pane.props['data-fleet-draft-artifact'],'');
  assert.ok(all(pane).some(node=>node.props['data-fleet-recreate-draft']==='old-draft'),'incompatible legacy draft keeps its recreation exit inside the shared detail');
  assert.equal(all(pane).some(node=>node.type==='button'&&node.props['data-fleet-open-dashboard']),false,'the side pane offers no Dashboard jump');
});

test('a stale pane recreation handler uses a newer compatible Session record instead of an older incompatible Workspace cache',async t=>{
  const h=await harness(t);await h.loadWorkspace();
  const stale=button(h.pane(),'data-fleet-recreate-draft','old-draft').props.onClick;
  assert.equal(h.workspaceTicket.revision,2);
  await h.updateSession({...legacy(),revision:3,plan:structuredClone(plan)});
  assert.equal(h.draftClient.record({...scope,draftId:'old-draft'}).draft.revision,3);
  assert.ok(button(h.pane(),'data-fleet-recreate-draft','old-draft'),'Workspace cache intentionally remains incompatible');
  await stale();
  assert.equal(h.calls.filter(([kind])=>['create','open','prefill'].includes(kind)).length,0,'A newer compatible source must reject the stale recreation action');
  assert.equal(h.requests.some(request=>request.method==='POST'),false);
});

test('pane recreation failure stays visible as a localized alert without writing a Ticket',async t=>{
  const h=await harness(t,{creationError:'Native Session creation failed'});await h.loadWorkspace();
  const before=structuredClone(h.draftClient.latest(scope));
  await button(h.pane(),'data-fleet-recreate-draft','old-draft').props.onClick();
  for(const language of ['zh','en']){
    h.language(language);const pane=h.pane(),action=button(pane,'data-fleet-recreate-draft','old-draft'),alert=all(pane).find(node=>node.props.role==='alert'&&node.children.some(text=>typeof text==='string'&&text.includes('Native Session creation failed')));
    assert.ok(alert,'The pane itself must expose the failure');assert.match(alert.children.join(''),language==='zh'?/操作未完成。详细信息：/:/The operation could not be completed\. Details:/);
    assert.equal(action.props.disabled,false);
  }
  assert.deepEqual(h.calls.filter(([kind])=>kind!=='resource'),[['create',{workspaceId:'w1'}]]);
  assert.deepEqual(h.draftClient.latest(scope),before);
  assert.equal(h.requests.some(request=>request.method==='POST'),false,'The pane must report the error without a Ticket write');
});